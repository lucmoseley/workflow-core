#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

/**
 * @typedef {import("./lib/check").Ctx} Ctx
 * @typedef {{databaseId: number, headSha?: string, conclusion?: string|null,
 *   createdAt?: string, event?: string, workflowName?: string,
 *   url?: string, displayTitle?: string}} Run
 * @typedef {{name?: string, path?: string, state?: string}} Workflow
 * @typedef {{head: string, ahead: number|null, line: string|null}} Coverage
 */

const { now, runCheck } = require("./lib/check");
const {
	buildBisectAdvice,
	countRange,
	readRange,
	renderRange,
} = require("./lib/commit-range");
const { gh, parseErrLine, parseGhFailureReason } = require("./lib/gh");
const { openTrackingIssue } = require("./lib/tracking-issue");
const { scriptPath } = require("./lib/script-path");
const VERDICT_JOB = "Suite passed";
const FILE_TIMES_JOB = "Test file CI times";
const SUITE_BUDGET_JOB = "Suite growth budget";
/** @type {Map<string, string>} */
const MEDIAN_JOB_ROUTES = new Map([
	[
		FILE_TIMES_JOB,
		`each file over the limit is cut under its own profiled ticket (a sub-issue of #2729) — \`node ${scriptPath("check-file-ci-time.js")}\` names the files`,
	],
	[
		SUITE_BUDGET_JOB,
		`the slowest files are cut by measured cost (a sub-issue of #2729) — \`node ${scriptPath("check-suite-budget.js")}\` names them`,
	],
]);

const redSuite = require("./report-red-suite");
const { fileWhereUnfiled } = require("./lib/red-suite-fallback");

const {
	AUTOFIRE_DAILY_CAP,
	markerPath: autofireMarkerPath,
	readState: readAutofireState,
	recordFiring,
	spentToday,
} = require("./lib/sweep-budget");

const deliveryStamp = require("./lib/delivery-stamp");
const { hostRoot } = require("./lib/host-root.js");
const { shellQuote } = require("./lib/sh-quote.js");
const { codeRepoArgs } = require("./lib/workflow-core-config.js");

const repoFlag = () =>
	codeRepoArgs()
		.map((a) => ` ${a}`)
		.join("");
const { NOT_A_TREE_VERDICT, hasVerdict } = require("./lib/ci-verdict.js");
const { execGit } = require("./lib/git.js");
const { orFallback } = require("./lib/caught.js");

const GOOD = new Set(["success", "skipped", "neutral"]);

/** @param {Run} r */
const carriesNoVerdict = (r) => r.conclusion === "cancelled";

// guess: ~12 days of four daily sweeps, back to the last green, lucmoseley/mantahostels#3490
const RUN_WINDOW = 50;

const BISECT_WORKFLOW = "bisect.yml";

const {
	SWEEP_GH_TIMEOUT_MS,
	SWEEP_WORKFLOW,
	readLedgerRuns,
	slotsFrom,
	sweepLedger,
} = require("./lib/sweep-ledger.js");

// guess, lucmoseley/mantahostels#949
const HATCH_MIN_WAIT_MS = 2 * 60 * 60 * 1000;

// measured 16-83 min sweep lag, lucmoseley/mantahostels#1816
const SWEEP_STALE_MS = 8 * 60 * 60 * 1000;

// measured 4.3-5.1 s dispatch-to-listing lag, lucmoseley/mantahostels#1832
const AUTOFIRE_COOLDOWN_MS = 2 * 60 * 1000;

// guess: 8s under the hook's 40s timeout, #2471
const NOTIFY_BUDGET_MS = Number(process.env.WFC_NOTIFY_BUDGET_MS) || 32_000;

// guess: less is a near-certain ETIMEDOUT, lucmoseley/mantahostels#2134
const NOTIFY_BUDGET_FLOOR_MS = 1000;

const WHO_CAN_RUN_IT =
	"any session — a 403 here means the PAT lost Actions: write";

const REPO = process.env.WFC_REPO_DIR || hostRoot();

const hasSweepWorkflow = () =>
	fs.existsSync(path.join(REPO, ".github", "workflows", SWEEP_WORKFLOW));

/** @param {string|null|undefined} sha */
const short = (sha) => (sha || "").slice(0, 7);

/**
 * @param {boolean} notify
 * @returns {number|null}
 */
const notifyDeadline = (notify) =>
	notify ? Date.now() + NOTIFY_BUDGET_MS : null;

/**
 * @param {number|null} deadline
 * @returns {number|null}
 */
function ghTimeout(deadline) {
	if (deadline === null) return SWEEP_GH_TIMEOUT_MS;
	const remaining = deadline - Date.now();
	return remaining < NOTIFY_BUDGET_FLOOR_MS
		? null
		: Math.min(SWEEP_GH_TIMEOUT_MS, remaining);
}

/**
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
	const mins = Math.max(0, Math.round(ms / 60_000));
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ${mins % 60}m`;
	return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * @param {Run} run
 * @returns {string|null}
 */
function ageOf(run) {
	const started = Date.parse(run.createdAt || "");
	return Number.isNaN(started) ? null : formatDuration(now() - started);
}

/** @param {number} t */
const nextSweepAfter = (t) => slotsFrom(t).find((at) => at > t) ?? null;

/**
 * @param {string} sha
 * @returns {Coverage}
 */
function headCoverage(sha) {
	const head = orFallback(
		() =>
			execGit(["rev-parse", "HEAD"], {
				encoding: "utf8",
				cwd: REPO,
				stdio: ["ignore", "pipe", "ignore"],
			}).trim(),
		"",
	);
	if (!head) return { head: "", ahead: null, line: null };
	if (head === sha) return { head, ahead: 0, line: null };

	const ahead = countRange({ good: sha, bad: head, cwd: REPO });
	const behind = countRange({ good: head, bad: sha, cwd: REPO });
	/** @type {string} */
	let line;
	if (ahead)
		line = `Your HEAD is ${short(head)} — ${ahead} commit(s) after this run, which it never tested.`;
	else if (behind)
		line = `Your HEAD is ${short(head)} — ${behind} commit(s) behind this run. Fetch before chasing it.`;
	else
		line = `Your HEAD is ${short(head)}, which is not the sha this run tested.`;
	return { head, ahead, line };
}

/**
 * @param {Coverage} coverage
 * @param {string} sha
 */
const coverageGist = (coverage, sha) => {
	if (coverage.ahead) return `${coverage.ahead} commit(s) behind your HEAD`;
	if (coverage.ahead === 0) return "on your HEAD";
	return `at ${short(sha)}`;
};

/**
 * @param {Coverage} coverage
 * @returns {string[]}
 */
function buildSweepAdvice(coverage) {
	if (coverage.ahead === null || coverage.ahead <= 0) return [];
	const t = now();
	const next = nextSweepAfter(t);
	if (next === null || next - t <= HATCH_MIN_WAIT_MS) return [];
	return [
		"",
		`Nothing has tested HEAD, and the next sweep is ${formatDuration(next - t)} away ` +
			`(${new Date(next).toISOString().slice(11, 16)} UTC).`,
	];
}

/**
 * @param {number} t
 * @param {number} ref
 */
const slotStamp = (t, ref) => {
	const d = new Date(t);
	/** @param {number} x */
	const day = (x) => new Date(x).toISOString().slice(0, 10);
	const date = day(t) === day(ref) ? "" : d.toUTCString().slice(5, 12);
	return `${date}${d.toISOString().slice(11, 16)} UTC`;
};

/**
 * @param {Run[]} runs
 * @returns {Run|null}
 */
const newestRun = (runs) =>
	runs.reduce(
		(/** @type {Run|null} */ best, r) =>
			Number.isNaN(Date.parse(r.createdAt || "")) ||
			(best &&
				Date.parse(best.createdAt || "") >= Date.parse(r.createdAt || ""))
				? best
				: r,
		null,
	);

/** @param {Workflow} w */
const workflowFile = (w) => (w.path || "").split("/").pop() || w.name;

/** @param {number|null} deadline */
function readSweepRuns(deadline) {
	const timeout = ghTimeout(deadline);
	if (timeout === null) return null;
	try {
		const rows = JSON.parse(
			gh(
				[
					"run",
					"list",
					"--workflow",
					SWEEP_WORKFLOW,
					"--limit",
					"50",
					"--json",
					"databaseId,headSha,createdAt,event,conclusion,url,displayTitle",
				],
				{ timeout },
			),
		);
		return Array.isArray(rows) ? rows : null;
	} catch {
		return null;
	}
}

/** @param {number|null} deadline */
function readSlotRuns(deadline) {
	const timeout = ghTimeout(deadline);
	if (timeout === null) return null;
	try {
		return readLedgerRuns(timeout);
	} catch {
		return null;
	}
}

/** @param {number|null} deadline */
function readInactiveWorkflows(deadline) {
	const timeout = ghTimeout(deadline);
	if (timeout === null) return null;
	try {
		const rows = JSON.parse(
			gh(["workflow", "list", "--all", "--json", "name,state,path"], {
				timeout,
			}),
		);
		if (!Array.isArray(rows)) return null;
		return rows.filter(
			(w) =>
				typeof w?.name === "string" &&
				typeof w?.state === "string" &&
				w.state !== "active",
		);
	} catch {
		return null;
	}
}

/**
 * @param {number} t
 * @param {number|null} deadline
 * @returns {string|null}
 */
function fireSweepOnStale(t, deadline) {
	const marker = autofireMarkerPath(REPO);
	if (!marker) return null;

	const { state, error } = readAutofireState(marker);
	if (error)
		return `  Could not read the sweep autofire cooldown, so fired nothing: ${parseErrLine(error)}`;

	const last = Number(state.last);
	if (Number.isFinite(last) && Math.abs(t - last) < AUTOFIRE_COOLDOWN_MS)
		return null;

	const spent = spentToday(state, t);
	if (spent >= AUTOFIRE_DAILY_CAP)
		return `  Not firing one: ${AUTOFIRE_DAILY_CAP} sweeps already fired today (automatic and hand-fired share one budget, mantahostels#2202).`;

	const timeout = ghTimeout(deadline);
	if (timeout === null)
		return "  Not firing one: --notify's gh-call budget was already spent (mantahostels#2177).";

	try {
		recordFiring(marker, t, spent);
	} catch (e) {
		return `  Could not write the sweep autofire cooldown, so fired nothing: ${parseErrLine(e)}`;
	}

	try {
		gh(["workflow", "run", SWEEP_WORKFLOW], { timeout });
		return "  Fired one automatically (verdict was stale).";
	} catch (e) {
		return `  Could not fire one automatically: ${parseErrLine(e)}`;
	}
}

/**
 * @param {string[]|null} steps
 * @param {string} indent
 * @returns {string[]}
 */
const buildStepLines = (steps, indent) => {
	if (steps === null)
		return [`${indent}(could not read which step failed — see the run)`];
	if (steps.length > 0) return steps.map((step) => `${indent}${step}`);
	return [`${indent}(the run reports no failing step — see the run)`];
};

/** @typedef {() => {number: number}|null|false} TrackingLookup */

/**
 * @param {TrackingLookup} lookupIssue
 * @param {boolean} write
 */
function suiteTicket(lookupIssue, write) {
	const found = lookupIssue();
	if (found) return `covered by #${found.number}`;
	if (found === false)
		return "could not ask the tracker whether an open issue covers this";
	if (!write)
		return "no open issue covers this — `--write` launches the filer where the daily run did not file";
	const fallback = fileWhereUnfiled(REPO, now());
	if (fallback) return `no open issue covers this: ${fallback}`;
	return "no open issue covers this — the daily repo-checks run files the newest red, unless an issue was closed after it (#1963)";
}

/**
 * @typedef {() => string} SuiteTicket
 * @param {TrackingLookup} lookupIssue
 * @param {boolean} write
 * @returns {SuiteTicket}
 */
function suiteTicketOrFileOnce(lookupIssue, write) {
	/** @type {string|undefined} */
	let clause;
	return () => {
		clause ??= suiteTicket(lookupIssue, write);
		return clause;
	};
}

/**
 * @param {boolean} isSweep
 * @param {RunFailures|null} failures
 * @param {SuiteTicket} ticket
 * @param {string} indent
 * @returns {string[]}
 */
function buildTicketLines(isSweep, failures, ticket, indent) {
	if (!failures)
		return [
			`${indent}Ticket: could not read which job failed, so cannot say whether an issue covers it`,
		];
	/** @param {string} name */
	const filerOwns = (name) => isSweep && name.startsWith(redSuite.SUITE_JOB);
	const lines = failures.jobs
		.filter((name) => !filerOwns(name) && !(isSweep && name === VERDICT_JOB))
		.map(
			(name) =>
				`${indent}Ticket for ${name}: ${(isSweep && MEDIAN_JOB_ROUTES.get(name)) || "no filer covers this job"}`,
		);
	if (!isSweep) return lines;
	if (redSuite.filesFor(failures.rows))
		lines.unshift(`${indent}Ticket for ${redSuite.SUITE_JOB}: ${ticket()}`);
	else if (failures.jobs.some((name) => name.startsWith(redSuite.SUITE_JOB)))
		lines.unshift(
			`${indent}Ticket for ${redSuite.SUITE_JOB}: none will be filed — the filer reads this job as carrying no verdict`,
		);
	return lines;
}

/**
 * @param {Run|null} newest
 * @param {number|null} deadline
 * @param {SuiteTicket} ticket
 * @returns {string[]}
 */
function buildRedSweepLines(newest, deadline, ticket) {
	if (
		!newest?.conclusion ||
		GOOD.has(newest.conclusion) ||
		carriesNoVerdict(newest)
	)
		return [];
	const failures = runFailures(newest.databaseId, deadline);
	const lines = [
		`⚠ The newest sweep concluded ${newest.conclusion} — firing another tests the same tree.`,
		...buildStepLines(failures?.steps ?? null, "  "),
		...buildTicketLines(true, failures, ticket, "  "),
	];
	if (newest.url) lines.push(`  ${newest.url}`);
	return lines;
}

/**
 * @param {Run[]|null} runs
 * @param {import("./lib/sweep-ledger.js").LedgerRun[]|null} slotRuns
 * @param {Workflow[]|null} inactive
 * @param {{ t: number, deadline: number|null, hasSweep: boolean, ticket: SuiteTicket }} opts
 */
function buildLivenessReport(
	runs,
	slotRuns,
	inactive,
	{ t, deadline, hasSweep, ticket },
) {
	/** @type {LivenessOut} */
	const out = { lines: [], findings: [] };
	const { lines, findings } = out;

	reportDisabledWorkflows(out, inactive);

	if (!hasSweep)
		return {
			lines,
			findings,
			ledgerLine: `Sweep ledger: no .github/workflows/${SWEEP_WORKFLOW} in this tree, so no sweep is judged.`,
			staleMs: null,
			sweepRed: () => [],
		};

	const stopped = (inactive || []).find(
		(w) => workflowFile(w) === SWEEP_WORKFLOW,
	);
	const ledger =
		slotRuns && slotRuns.length > 0 ? sweepLedger(slotRuns, t) : null;
	const newest = runs && runs.length > 0 ? newestRun(runs) : null;

	const coverage = newest
		? headCoverage(newest.headSha ?? "")
		: { head: "", ahead: null, line: null };

	/** @returns {string[]} */
	const sweepRed = () => buildRedSweepLines(newest, deadline, ticket);

	const newestLine = buildNewestSweepLine(runs, newest, coverage, t);

	const staleMs = stopped ? null : staleMsOf(newest, coverage, t);

	if (stopped) {
		reportStoppedSweep(out, stopped, newestLine);
		return { lines, findings, ledgerLine: null, staleMs, sweepRed };
	}

	if (ledger && ledger.missed.length > 0) {
		reportMissedSlots(out, { ledger, inactive, newestLine, t });
		lines.push(...sweepRed());
		return { lines, findings, ledgerLine: null, staleMs, sweepRed: () => [] };
	}

	const blind = inactive
		? ""
		: " Workflow states unreadable, so a disabled workflow would not be seen.";
	const ledgerLine = buildLedgerStateLine(slotRuns, ledger, newestLine) + blind;
	return { lines, findings, ledgerLine, staleMs, sweepRed };
}

/**
 * @typedef {{lines: string[], findings: {tag: string, message: string}[]}} LivenessOut
 */

/**
 * @param {LivenessOut} out
 * @param {Workflow[]|null} inactive
 */
function reportDisabledWorkflows(out, inactive) {
	for (const w of inactive || [])
		if (workflowFile(w) !== SWEEP_WORKFLOW) {
			out.findings.push({
				tag: "WORKFLOW-DISABLED",
				message: `${workflowFile(w)} is ${w.state}, so it will not run`,
			});
			out.lines.push(
				`⚠ ${workflowFile(w)} is ${w.state} — it will not run until re-enabled.`,
				`  Re-enable (${WHO_CAN_RUN_IT}): gh workflow enable ${workflowFile(w)}${repoFlag()}`,
			);
		}
}

/**
 * @param {Run[]|null} runs
 * @param {Run|null} newest
 * @param {Coverage} coverage
 * @param {number} t
 * @returns {string}
 */
function buildNewestSweepLine(runs, newest, coverage, t) {
	if (newest)
		return (
			`newest sweep ${slotStamp(Date.parse(newest.createdAt || ""), t)}, ${ageOf(newest)} ago, ` +
			`${coverageGist(coverage, newest.headSha ?? "")}`
		);
	if (runs) return "no sweep has ever run";
	return "and GitHub would not say when the last sweep was";
}

/**
 * @param {Run|null} newest
 * @param {Coverage} coverage
 * @param {number} t
 * @returns {number|null}
 */
function staleMsOf(newest, coverage, t) {
	const newestAt = newest ? Date.parse(newest.createdAt || "") : Number.NaN;
	return Number.isFinite(newestAt) &&
		coverage.ahead !== null &&
		coverage.ahead > 0 &&
		t - newestAt > SWEEP_STALE_MS
		? t - newestAt
		: null;
}

/**
 * @param {LivenessOut} out
 * @param {Workflow} stopped
 * @param {string} newestLine
 */
function reportStoppedSweep(out, stopped, newestLine) {
	const [initial] = newestLine;
	if (initial === undefined) throw new Error("the newest-sweep line is empty");
	out.findings.push({
		tag: "SWEEP-STOPPED",
		message: `${SWEEP_WORKFLOW} is ${stopped.state} — no sweep will fire again until it is re-enabled`,
	});
	out.lines.push(
		`⚠ ${SWEEP_WORKFLOW} is ${stopped.state} — no sweep will fire again until re-enabled.`,
		`  ${initial.toUpperCase()}${newestLine.slice(1)}.`,
		`  Re-enable (${WHO_CAN_RUN_IT}): gh workflow enable ${SWEEP_WORKFLOW}${repoFlag()}`,
	);
}

/**
 * @param {LivenessOut} out
 * @param {{ledger: ReturnType<typeof sweepLedger>, inactive: Workflow[]|null, newestLine: string, t: number}} opts
 */
function reportMissedSlots(out, { ledger, inactive, newestLine, t }) {
	const n = `${ledger.missed.length} of ${ledger.judgeable.length}`;
	out.findings.push({
		tag: "SWEEP-MISSED",
		message: `${n} sweep slot(s) in the last 24h produced no run`,
	});
	out.lines.push(
		`⚠ Scheduled sweeps missing: ${n} slots in the last 24h produced no run`,
		`  (missed ${ledger.missed.map((s) => slotStamp(s.at, t)).join(", ")}; ${newestLine}).`,
		inactive
			? `  ${SWEEP_WORKFLOW} reads \`active\` — GitHub dropped queued runs.`
			: `  Could not read whether ${SWEEP_WORKFLOW} is still enabled.`,
	);
}

/**
 * @param {unknown[]|null} runs
 * @param {ReturnType<typeof sweepLedger>|null} ledger
 * @param {string} newestLine
 * @returns {string}
 */
function buildLedgerStateLine(runs, ledger, newestLine) {
	if (!runs)
		return `Sweep ledger unreadable — could not ask GitHub for ${SWEEP_WORKFLOW} runs.`;
	if (ledger)
		return (
			`Sweep ledger: ${ledger.fired.length} of ${ledger.judgeable.length} judgeable slots fired in the last 24h` +
			`${ledger.repaired ? ` (${ledger.repaired} by slot repair)` : ""}` +
			`${ledger.pending ? ` (${ledger.pending} still inside its grace)` : ""} — ${newestLine}.`
		);
	return `Sweep ledger: no ${SWEEP_WORKFLOW} run on record yet, so no slot can be judged.`;
}

/**
 * @typedef {{name: string, conclusion?: string|null,
 *   steps?: {name: string, conclusion?: string|null}[]}} Job
 * @typedef {{steps: string[], jobs: string[], rows: Job[]}} RunFailures
 */

/**
 * @param {number|string} runId
 * @param {number|null} deadline
 * @returns {RunFailures|null}
 */
function runFailures(runId, deadline) {
	const timeout = ghTimeout(deadline);
	if (timeout === null) return null;
	let jobs;
	try {
		jobs = JSON.parse(
			gh(["run", "view", String(runId), "--json", "jobs"], {
				timeout,
			}),
		).jobs;
	} catch {
		return null;
	}
	if (!Array.isArray(jobs)) return null;

	const failed = failedSteps(jobs);

	const failedJobs = jobs
		.filter((j) => badNotCancelled(j.conclusion))
		.map((j) => String(j.name));

	return { steps: failed, jobs: failedJobs, rows: jobs };
}

/** @param {string|null|undefined} c */
const bad = (c) => Boolean(c) && !GOOD.has(c ?? "");
/** @param {string|null|undefined} c */
const badNotCancelled = (c) => bad(c) && c !== "cancelled";

/**
 * @param {Job[]} jobs
 * @returns {string[]}
 */
function failedSteps(jobs) {
	/** @type {string[]} */
	const failed = [];
	for (const j of jobs)
		for (const s of j.steps || [])
			if (badNotCancelled(s.conclusion)) failed.push(`${j.name} › ${s.name}`);

	if (failed.length === 0)
		for (const j of jobs) if (bad(j.conclusion)) failed.push(j.name);
	return failed;
}

/**
 * @param {Run} run
 * @param {Run[]} judged
 * @returns {Run|null}
 */
const lastGreenBefore = (run, judged) =>
	judged.find(
		(r) =>
			r.workflowName === run.workflowName &&
			r.databaseId < run.databaseId &&
			GOOD.has(r.conclusion ?? ""),
	) || null;

const UNNAMED_WORKFLOW = "unnamed workflow";

/** @param {Run} run */
const workflowLabel = (run) => run.workflowName || UNNAMED_WORKFLOW;

const CHECKER = "ci-status";

/**
 * @typedef {ReturnType<typeof buildLivenessReport>} Liveness
 */

/**
 * @param {Ctx} ctx
 * @param {string} branch
 * @param {number|null} deadline
 * @returns {Run[]}
 */
function readBranchRuns(ctx, branch, deadline) {
	const branchTimeout = ghTimeout(deadline);
	if (branchTimeout === null)
		ctx.skip(
			`--notify's gh-call budget was already spent before asking GitHub for runs on ${branch} (mantahostels#2177).`,
		);

	try {
		const out = gh(
			[
				"run",
				"list",
				"--branch",
				branch,
				"--limit",
				String(RUN_WINDOW),
				"--json",
				"databaseId,headSha,status,conclusion,workflowName,event,url,createdAt",
			],
			{ timeout: branchTimeout },
		);
		const runs = JSON.parse(out);
		if (!Array.isArray(runs))
			throw new Error("gh returned JSON that is not a list of runs");
		return runs;
	} catch (e) {
		if (parseGhFailureReason(e) === "unreachable")
			ctx.skip(
				`could not ask GitHub for runs on ${branch} (GitHub unreachable: ${parseErrLine(e)}).`,
			);
		return ctx.broken(
			`could not ask GitHub for runs on ${branch}, and GitHub was reachable —\n` +
				`        this check is broken, not idle: ${parseErrLine(e)}`,
		);
	}
}

/**
 * @param {number|null} deadline
 * @returns {TrackingLookup}
 */
function trackingLookupOnce(deadline) {
	/** @type {ReturnType<TrackingLookup>|undefined} */
	let tracking;
	return () => {
		if (tracking !== undefined) return tracking;
		const timeout = ghTimeout(deadline);
		try {
			tracking =
				timeout !== null &&
				openTrackingIssue(
					{ title: redSuite.TITLE, label: redSuite.LABEL },
					{ timeout },
				);
		} catch {
			tracking = false;
		}
		return tracking;
	};
}

/**
 * @param {Liveness} live
 * @param {{notify: boolean, isRecheck: boolean, write: boolean, deadline: number|null}} opts
 * @returns {Liveness}
 */
function noteStaleSweep(live, { notify, isRecheck, write, deadline }) {
	if (!notify || live.staleMs === null) return live;
	const stale = `⚠ Newest sweep is ${formatDuration(live.staleMs)} old — past the ${formatDuration(SWEEP_STALE_MS)} a session should start on.`;
	let fired = null;
	if (!isRecheck)
		fired = write
			? fireSweepOnStale(now(), deadline)
			: "  Not firing one: `--write` fires it.";
	return { ...live, lines: [...live.lines, stale, ...(fired ? [fired] : [])] };
}

/**
 * @param {Ctx} ctx
 * @param {Liveness} live
 */
const livenessEmitter = (ctx, live) => () => {
	for (const f of live.findings) ctx.fail(f.tag, f.message);
	for (const line of live.lines) ctx.say(line);
	if (!ctx.notify && live.ledgerLine) ctx.say(live.ledgerLine);
	return live.findings.length > 0;
};

/**
 * @param {Ctx} ctx
 * @param {Run[]} runs
 * @param {Run[]} completed
 * @param {string} branch
 * @returns {Run[]}
 */
function judgedRuns(ctx, runs, completed, branch) {
	/** @type {Map<string|undefined, number>} */
	const newestId = new Map();
	for (const r of runs)
		newestId.set(
			r.workflowName,
			Math.max(r.databaseId, newestId.get(r.workflowName) ?? -1),
		);
	/** @param {Run} r */
	const replaced = (r) =>
		carriesNoVerdict(r) && (newestId.get(r.workflowName) ?? -1) > r.databaseId;

	const judged = completed.filter((r) => !replaced(r));
	if (judged.length === 0)
		ctx.skip(
			`every finished run in the window on ${branch} was superseded before it\n` +
				"        finished, so none of them carries a verdict — and a run that does may\n" +
				`        sit outside the ${RUN_WINDOW}-run window this reads.`,
		);

	judged.sort(
		(a, b) =>
			Date.parse(b.createdAt || "") - Date.parse(a.createdAt || "") ||
			b.databaseId - a.databaseId,
	);
	return judged;
}

/**
 * @param {Ctx} ctx
 * @param {{branch: string, sha: string, run: Run, hasSweep: boolean, live: Liveness, emitLiveness: () => boolean}} opts
 */
function reportGreen(ctx, { branch, sha, run, hasSweep, live, emitLiveness }) {
	if (ctx.notify) {
		emitLiveness();
		return {
			okLine: `CI is green on ${branch} (${short(sha)}).`,
			noun: SWEEP_NOUN,
		};
	}

	const age = ageOf(run);
	const coverage = headCoverage(sha);
	ctx.say(
		`Newest verdict on ${branch}: ${workflowLabel(run)} ${run.conclusion}` +
			`${run.event ? ` (${run.event})` : ""} at ${short(sha)}, ` +
			`${age ? `${age} ago` : "age unreadable"}.`,
	);
	if (coverage.line) ctx.say(coverage.line);
	if (hasSweep) for (const line of buildSweepAdvice(coverage)) ctx.say(line);
	for (const line of live.sweepRed()) ctx.say(line);
	emitLiveness();

	return {
		okLine:
			`CI is green on ${branch} — ${age ? `${age}-old` : "undated"} verdict ` +
			`${coverageGist(coverage, sha)}.`,
		noun: SWEEP_NOUN,
		data: { branch, sha, age, ahead: coverage.ahead },
	};
}

const SWEEP_NOUN = "CI liveness fault(s)";

/**
 * @typedef {{
 *   branch: string,
 *   sha: string,
 *   failed: Run[],
 *   keyed: Run[],
 *   deadline: number|null,
 *   ticket: SuiteTicket,
 *   stampCtx: Ctx | {notify: boolean, persisting: boolean},
 *   live: Liveness,
 *   emitLiveness: () => boolean,
 * }} RedState
 */

/**
 * @param {Ctx} ctx
 * @param {RedState} st
 */
function reportRed(ctx, st) {
	const {
		branch,
		sha,
		failed,
		deadline,
		ticket,
		live,
		emitLiveness,
		stampCtx,
	} = st;
	const unfinished = failed.filter(carriesNoVerdict);
	const broken = failed.filter((r) => !carriesNoVerdict(r));

	const newestRunId = Math.max(...failed.map((r) => r.databaseId));
	const signature = deliveryStamp.highWater(newestRunId);

	if (deliveryStamp.alreadyDelivered(stampCtx, CHECKER, signature)) {
		emitLiveness();
		return {
			okLine: buildAlreadyReportedLine(branch, broken),
			noun: SWEEP_NOUN,
		};
	}

	failRuns(ctx, failed);
	sayVerdict(ctx, { branch, sha, broken, unfinished });
	const failuresOf = new Map(
		failed.map((r) => [r, sayFailedRun(ctx, r, { deadline, ticket })]),
	);

	sayBisectRange(ctx, branch, broken, { keyed: st.keyed, failuresOf });

	const coverage = headCoverage(sha);
	if (coverage.line) ctx.say(`\n${coverage.line}`);
	ctx.say(`\nLogs: gh run view ${newestRunId} --log-failed${repoFlag()}`);

	if (live.lines.length > 0 || (!ctx.notify && live.ledgerLine)) ctx.say("");
	emitLiveness();

	deliveryStamp.markDelivered(stampCtx, CHECKER, signature);

	return {
		stamp: signature,
		count: failed.length,
		noun: redNoun(branch, broken, live),
		data: { branch, sha, failed },
	};
}

/**
 * @param {string} branch
 * @param {Run[]} broken
 */
const buildAlreadyReportedLine = (branch, broken) =>
	broken.length > 0
		? `CI is red on ${branch}, already reported.`
		: `CI never finished on ${branch}, already reported.`;

/**
 * @param {string} branch
 * @param {Run[]} broken
 * @param {Liveness} live
 */
const redNoun = (branch, broken, live) =>
	(broken.length > 0
		? `failing CI run(s) on ${branch}`
		: `unverified CI run(s) on ${branch}`) +
	(live.findings.length > 0
		? `, plus ${live.findings.length} ${SWEEP_NOUN}`
		: "");

/**
 * @param {Ctx} ctx
 * @param {Run[]} failed
 */
function failRuns(ctx, failed) {
	for (const r of failed)
		ctx.fail(
			carriesNoVerdict(r) ? "UNVERIFIED-RUN" : "RED-RUN",
			`${workflowLabel(r)}: ${r.conclusion} — ${r.url}`,
			r,
		);
}

/**
 * @param {Ctx} ctx
 * @param {{branch: string, sha: string|undefined, broken: Run[], unfinished: Run[]}} opts
 */
function sayVerdict(ctx, { branch, sha, broken, unfinished }) {
	const at = `on ${branch} at ${short(sha)}`;
	const redPart = `${broken.length} failing run(s)`;
	const unrunPart = `${unfinished.length} cancelled run(s) nothing superseded, so this commit is unverified`;

	/** @type {string} */
	let verdict;
	if (broken.length > 0 && unfinished.length > 0)
		verdict = `CI is red ${at} — ${redPart}, and ${unrunPart}.\n`;
	else if (broken.length > 0) verdict = `CI is red ${at} — ${redPart}.\n`;
	else verdict = `CI never finished ${at} — ${unrunPart}.\n`;
	ctx.say(verdict);
}

/**
 * @param {Ctx} ctx
 * @param {Run} r
 * @param {{deadline: number|null, ticket: SuiteTicket}} opts
 * @returns {RunFailures|null}
 */
function sayFailedRun(ctx, r, { deadline, ticket }) {
	ctx.say(
		`  ${workflowLabel(r)}: ${r.conclusion}${r.event ? ` (${r.event})` : ""}`,
	);
	if (carriesNoVerdict(r)) {
		ctx.say(`    ${r.url}`);
		return null;
	}
	const failures = runFailures(r.databaseId, deadline);
	for (const line of buildStepLines(failures?.steps ?? null, "    "))
		ctx.say(line);
	for (const line of buildTicketLines(
		r.workflowName === redSuite.SWEEP_NAME,
		failures,
		ticket,
		"    ",
	))
		ctx.say(line);
	ctx.say(`    ${r.url}`);
	return failures;
}

/**
 * @param {Run} r
 * @param {RunFailures|null|undefined} failures
 */
function isMedianRedAlone(r, failures) {
	if (r.workflowName !== redSuite.SWEEP_NAME || !failures) return false;
	const jobs = failures.jobs.filter((name) => name !== VERDICT_JOB);
	return jobs.length > 0 && jobs.every((name) => MEDIAN_JOB_ROUTES.has(name));
}

/**
 * @param {string} branch
 * @param {string} [name]
 */
function buildNoGreenAdvice(branch, name) {
	const lastGreen = (/** @type {string} */ subject) =>
		`\nNo green ${subject} inside the last ${RUN_WINDOW}, so the range back to\none cannot be read from here. `;
	const query = (/** @type {string} */ filter) =>
		`  gh run list --branch ${shellQuote(branch)}${filter} --status success --limit 1 --json headSha${repoFlag()}`;
	if (!name)
		return (
			`${lastGreen(`run of this ${UNNAMED_WORKFLOW}`)}The newest green of any workflow, ` +
			`which says nothing about this one, is found with:\n${query("")}`
		);
	return `${lastGreen(`${name} run`)}Find its sha with:\n${query(` --workflow ${shellQuote(name)}`)}`;
}

/**
 * @param {Ctx} ctx
 * @param {string} branch
 * @param {Run[]} broken
 * @param {{keyed: Run[], failuresOf: Map<Run, RunFailures|null>}} opts
 */
function sayBisectRange(ctx, branch, broken, { keyed, failuresOf }) {
	const bisectable = broken.filter(
		(r) => !isMedianRedAlone(r, failuresOf.get(r)),
	);
	const culprit = bisectable[0];
	if (!culprit && broken.length > 0) {
		ctx.say(
			"\nNo bisect: each red job judges medians over three sweeps, which no single commit caused.",
		);
		return;
	}
	const green = culprit ? lastGreenBefore(culprit, keyed) : null;
	if (culprit && !green) {
		ctx.say(buildNoGreenAdvice(branch, culprit.workflowName));
	} else if (culprit && green) {
		const ends = {
			good: green.headSha ?? "",
			bad: culprit.headSha ?? "",
		};
		const range = readRange({ ...ends, cwd: REPO });
		ctx.say("");
		for (const line of renderRange(range, ends)) ctx.say(line);
		for (const line of buildBisectAdvice(range, {
			...ends,
			workflow: BISECT_WORKFLOW,
			repoFlag: repoFlag(),
		}))
			ctx.say(line);
	}
}

runCheck({
	name: CHECKER,
	usage:
		"node check-ci-status.js [--branch <name>] [--notify [--recheck]] [--write]",
	valueFlags: ["--branch"],
	flags: ["--recheck", "--write"],
	run(/** @type {Ctx} */ ctx) {
		const branch = ctx.value("--branch", "main");
		const deadline = notifyDeadline(ctx.notify);
		const isRecheck = ctx.has("--recheck");
		const stampCtx = isRecheck ? { notify: ctx.notify, persisting: true } : ctx;

		const runs = readBranchRuns(ctx, branch, deadline);

		const hasSweep = hasSweepWorkflow();

		const write = ctx.has("--write");
		const ticket = suiteTicketOrFileOnce(trackingLookupOnce(deadline), write);

		const live = noteStaleSweep(
			buildLivenessReport(
				hasSweep ? readSweepRuns(deadline) : [],
				hasSweep ? readSlotRuns(deadline) : [],
				readInactiveWorkflows(deadline),
				{ t: now(), deadline, hasSweep, ticket },
			),
			{ notify: ctx.notify, isRecheck, write, deadline },
		);

		const emitLiveness = livenessEmitter(ctx, live);

		const completed = runs.filter((r) => hasVerdict(r) && r.headSha);
		if (completed.length === 0) {
			emitLiveness();
			return {
				okLine: `no finished CI runs on ${branch} yet.`,
				noun: SWEEP_NOUN,
			};
		}

		const judged = judgedRuns(ctx, runs, completed, branch);
		const verdicts = judged.filter(
			(r) => !NOT_A_TREE_VERDICT.has(r.workflowName ?? ""),
		);
		const keyed = verdicts.length > 0 ? verdicts : judged;

		const newest = /** @type {Run} */ (keyed[0]);
		const sha = /** @type {string} */ (newest.headSha);
		const failed = keyed.filter(
			(r) => r.headSha === sha && !GOOD.has(r.conclusion ?? ""),
		);

		if (failed.length === 0)
			return reportGreen(ctx, {
				branch,
				sha,
				run: newest,
				hasSweep,
				live,
				emitLiveness,
			});

		return reportRed(ctx, {
			branch,
			sha,
			failed,
			keyed,
			deadline,
			ticket,
			stampCtx,
			live,
			emitLiveness,
		});
	},
});
