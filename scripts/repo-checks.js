#!/usr/bin/env node
/*
 * repo-checks.js — the daily run of a repo's own state checks (#1548, spec
 * #1510): every check and reporter lib/repo-checks-registry.js lists.
 *
 * AT MOST ONE READING A DAY, through lib/periodic-reading.js: a stamp and a
 * lock in the git common directory, so worktrees of one repo share them, the
 * stamp written before the run, so a run that dies is retried the next day
 * and never at the next session start. The lock goes stale at 45 minutes,
 * above the run's own 30-minute ceiling, so a long run is never taken for a
 * dead one.
 *
 * AN ENTRY WHOSE GATE FAILS IS SKIP, its reason recorded, and is never
 * launched. The rest run ONE PROCESS AT A TIME, in the registry's order, each
 * killed at 300 s (an entry's `ceilingScale` multiplies it) and recorded
 * BROKEN; whatever the 30-minute run ceiling
 * leaves unreached is MISSING, as is a check reached that printed no
 * envelope. A reporter files or refreshes its own issue, as on CI.
 *
 * A `since` ENTRY IS WINDOWED (#1551): the start of each one's last
 * completed reading is kept in `.repo-checks-since.json` beside the stamp.
 * Residual: a since file that will not read or is not a JSON object
 * restarts every window at 30 days, so a gap longer than that behind it
 * loses findings; the error log names it.
 *
 * A `rescan` ENTRY RE-SCANS ITS LAST FINDINGS' ISSUES (#1600): the `#N` of
 * each key in its last completed reading, kept in `.repo-checks-rescan.json`
 * and moved with the window's start. Residual: one that will not read
 * re-scans nothing, so a finding the window has passed drops out; the error
 * log names it.
 *
 * THE RESULT is `.repo-checks.json` beside the stamp, one job per registry
 * entry, which `npm run status`'s tracker-sweep line reads
 * (scripts/check-tracker-sweep.js, #1557). A launch that exits BROKEN or
 * MISSING keeps its child's stderr in the job's `stderr` (#2480).
 *
 * THE NOTIFY REPORT (#1553) is `repo-checks.<repo>` in lib/notify-report.js's
 * store: a line per check that gained a key since its last delivery or is
 * BROKEN or MISSING, nothing for a standing or shrinking set. It carries a
 * 7-day maximum age and the launching session as its owner, so the delivery
 * mod hands it to that session while it lives; otherwise `npm run status`
 * shows it, a session start holding it back (#2038, re-ruling #1553's replay
 * there).
 *
 * FROM A LINKED WORKTREE IT READS THE MAIN CHECKOUT (#1555): it points
 * CLAUDE_PROJECT_DIR there for itself and every check it launches, so the
 * day's shared reading checks the shared tree, not a worktree's branch. Its
 * notify report and error log land in the main checkout's store too: the
 * launching worktree session is never handed the report live, and its own
 * `npm run check:guard-errors` never shows the run's faults.
 *
 * THE STANDING ISSUE (#1554), `Repo checks: standing findings`, holds what
 * the notify report goes silent on: each check with findings, its outcome,
 * count and hand command. It is filed the first time a check holds a key,
 * labelled `takes:triage` at filing, and found again by its exact title
 * alone: triage moves the label, and a find by label would then file a
 * second. It is written only on a reading where some key set differs from
 * the sets it was last written with, kept in
 * `.repo-checks-issue.json` beside the stamp; a BROKEN or MISSING check
 * carries its recorded keys forward, so a broken day never reads as a clear
 * one. An all-clear reading refreshes an open issue and never files one.
 *
 * SETTLED KEYS ARE FILTERED (#1700): a key whose tag the registry entry lists
 * as `settled` is left out of the standing set and of the notify line's gain,
 * so a check holding only settled keys reads as clear. The merged result
 * keeps every key, so the hand route still lists them and the clobbers
 * re-scan still reaches their issues; the delivery stamp keeps them too.
 *
 * IT NEVER FIRES A WORKFLOW, PUSHES, COMMITS OR CLOSES AN ISSUE, and never
 * reads or writes `.sweep-autofire`: the 3-a-day `gh workflow run` budget is
 * not its to spend. It always exits 0: a fault — an unreadable config, a
 * stamp, lock or result it cannot write, a reporter that could not file, a
 * `gh` call that failed filing the standing issue — is
 * one line in the arbiter's error log, which `npm run check:guard-errors`
 * reports.
 *
 * IN NO SCRIPT FAMILY (§N3): it launches the families' members and keeps
 * their envelopes, so no one family's contract fits.
 *
 * WFC_REPO_CHECKS_CHECK_MS and WFC_REPO_CHECKS_RUN_MS stand in for the two
 * ceilings, and WFC_SCRIPT_ROOT for the core the scripts are launched from,
 * for tests only.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const { writeFileAtomic } = require("./lib/atomic-write.js");
const path = require("node:path");
const { logError } = require("./lib/arbiter-core");
const { errMessage, now } = require("./lib/check");
const { parseEnvelope } = require("./lib/check-envelope");
/* Aliased: lib/check.js exports a smaller MAX_BUFFER of its own. */
const { parseErrLine, MAX_BUFFER: GH_MAX_BUFFER } = require("./lib/gh");
const { hostRoot } = require("./lib/host-root");
const {
	readDeliveredKeys,
	isCompleted,
	isJudged,
	judgeKeys,
	keysOf,
} = require("./lib/key-delta");
const { checkoutOfCommonDir } = require("./lib/main-checkout");
const notify = require("./lib/notify-report");
const { isCoreHost } = require("./lib/plugin-state");
const { periodicReading, buildSkipLine } = require("./lib/periodic-reading");
const { projectSlug } = require("./lib/project-slug");
const { REPO_CHECKS } = require("./lib/repo-checks-registry");
const { coreRoot, scriptPath } = require("./lib/script-path");
const { fromEnv: sessionFromEnv } = require("./lib/session-id");
const {
	fileOrRefresh,
	openTrackingIssue,
	refresh,
} = require("./lib/tracking-issue");
const { readConfig, resolveKey } = require("./lib/workflow-core-config");
const {
	WHERE,
	buildHandCommand,
	reportName,
	resultFile,
} = require("./lib/repo-checks-reading");
const { gitCommonDirOrThrow } = require("./lib/git.js");
const { caught } = require("./lib/caught.js");
const { takesLabel } = require("./lib/takes-label");

const STAMP = ".repo-checks-read";
const LOCK = ".repo-checks-read.lock";
const SINCE = ".repo-checks-since.json";
const RESCAN = ".repo-checks-rescan.json";
const ISSUE_SETS = ".repo-checks-issue.json";
const ISSUE_TITLE = "Repo checks: standing findings";
const ISSUE_LABEL = takesLabel("triage");
/* Spec #1510's first window, the check's own default. */
const FIRST_SINCE_DAYS = 30;
const DAY_MS = 24 * 3_600_000;
const LOCK_STALE_MS = 45 * 60_000;
/* Spec #1510's chosen ceilings, §Cost and limits. */
const CHECK_MS = 300_000;
const RUN_MS = 30 * 60_000;
const UNEXAMINED = "unexamined, not clean.";
/* A guess, unmeasured: room for one error line, short of flooding a summary. */
const STDERR_LINE_MAX_CHARS = 300;
/* Spec #1510 §Staleness: long enough that a daily reading reaches a session
 * starting days after it. */
const REPORT_MAX_AGE_MS = 7 * DAY_MS;

/**
 * @typedef {import("./lib/repo-checks-registry").RepoCheck} RepoCheck
 * @typedef {import("./lib/check").Outcome | "MISSING"} JobOutcome
 * @typedef {{ job: string, outcome: JobOutcome, count: number, keys: string[],
 *   summary: string, [k: string]: unknown }} Job
 * @typedef {{ root: string, file: string, core: boolean, modules: Set<string>,
 *   config: Record<string, unknown>, tracker: () => string | null }} Host
 */

/**
 * The registry entry a job was built from. Every job is, so a miss is a bug.
 *
 * @param {string} id
 * @returns {RepoCheck}
 */
function entryOf(id) {
	const entry = REPO_CHECKS.find((e) => e.id === id);
	if (!entry) throw new Error(`no registry entry "${id}"`);
	return entry;
}

/**
 * A key's first field, the finding tag `settled` names.
 *
 * @param {string} key
 */
const tagOf = (key) => {
	const tab = key.indexOf("\t");
	return tab === -1 ? key : key.slice(0, tab);
};

/**
 * A job's keys less those its entry's `settled` tags name.
 *
 * @param {string} id
 * @param {{ keys?: unknown } | null | undefined} job
 * @returns {string[]}
 */
function unsettledKeys(id, job) {
	const settled = new Set(entryOf(id).settled ?? []);
	return keysOf(job).filter((k) => !settled.has(tagOf(k)));
}

/**
 * A check its gate let run. A reporter files its own issue, so neither the
 * notify line nor the standing issue judges it.
 *
 * @param {Job} j
 */
const isJudgedCheck = (j) =>
	entryOf(j.job).kind === "check" && isJudged(j.outcome);

/** @param {string} name @param {number} fallback */
function parseCeiling(name, fallback) {
	const n = Number(process.env[name]);
	return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * @param {Pick<Job, "job" | "outcome" | "summary">} job
 * @returns {Job}
 */
const buildJob = ({ job, outcome, summary }) => ({
	job,
	outcome,
	count: 0,
	keys: [],
	summary,
});

/**
 * Why `entry` may not run here, or null where every limb of its gate holds.
 *
 * @param {RepoCheck} entry
 * @param {Host} host
 * @returns {string | null}
 */
function gateFault({ gate }, host) {
	for (const m of gate.modules ?? [])
		if (!host.modules.has(m)) return `module "${m}" is off in ${host.file}`;
	// The core runs a check with its input missing, so it reports BROKEN (#1722).
	if (
		gate.input &&
		!host.core &&
		!fs.existsSync(path.join(host.root, gate.input))
	)
		return `this repo keeps no ${gate.input}`;
	if (gate.config && host.config[gate.config] === undefined)
		return `${host.file} carries no "${gate.config}" key`;
	if (gate.tracker && !host.tracker())
		return `no tracker resolves from ${host.file} or the origin remote`;
	if (gate.core && !host.core) return "this repo is not workflow-core itself";
	return null;
}

/* A stack frame, which names where a throw passed through and never what
 * failed (#2480). */
const STACK_FRAME = /^at\s/;
/* The line Node prints a throw's message on: `Error: …`, `TypeError: …`,
 * `Error [ERR_X]: …`. */
const ERROR_LINE = /^(?:Uncaught\s+)?[A-Z]?\w*Error(?:\s\[[A-Z_]+\])?:/;
/* A guess, unmeasured: a module-load stack in full, short of bloating the
 * reading. */
const STDERR_KEPT_MAX_CHARS = 8000;

/**
 * The child's error line, as a summary's tail: `: <line>`, or "" where it
 * wrote nothing. The first line a throw's message is on, else the last line
 * that is no stack frame, so a module that fails to load is named (#2480).
 *
 * @param {string | undefined} stderr
 */
function because(stderr) {
	const lines = (stderr ?? "")
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const line =
		lines.find((l) => ERROR_LINE.test(l)) ??
		lines.findLast((l) => !STACK_FRAME.test(l)) ??
		lines.at(-1);
	return line ? `: ${clip(line, STDERR_LINE_MAX_CHARS)}` : "";
}

/**
 * @param {string} text
 * @param {number} max
 */
const clip = (text, max) =>
	text.length > max ? `${text.slice(0, max)}…` : text;

/**
 * A failed job with the child's whole stderr kept beside its summary, so the
 * reading holds the stack the summary's one line was taken from (#2480).
 *
 * @param {Job} job
 * @param {string | undefined} stderr
 * @returns {Job}
 */
function withStderr(job, stderr) {
	const text = (stderr ?? "").trim();
	if (!text) return job;
	return {
		...job,
		stderr: clip(text, STDERR_KEPT_MAX_CHARS),
	};
}

/**
 * Run one entry and read what it left.
 *
 * @param {RepoCheck} entry
 * @param {string} root
 * @param {{ ms: number, by: string }} limit the ceiling that kills it, and
 *   which ceiling that is, for the summary
 * @param {string[]} extra arguments after the registry's own
 * @returns {Job}
 */
function launch(entry, root, limit, extra) {
	const json = entry.kind === "check";
	const r = spawnSync(
		process.execPath,
		[
			path.join(coreRoot(), "scripts", entry.script),
			...(entry.args ?? []),
			...extra,
			...(json ? ["--json"] : []),
		],
		{
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: limit.ms,
			killSignal: "SIGKILL",
			maxBuffer: GH_MAX_BUFFER,
		},
	);
	const job = entry.id;
	if (caught(r.error).code === "ETIMEDOUT")
		return buildJob({
			job,
			outcome: "BROKEN",
			summary: `BROKEN: ${job} was killed at ${limit.by} — ${UNEXAMINED}`,
		});
	if (r.error || r.status === null)
		return buildJob({
			job,
			outcome: "BROKEN",
			summary: `BROKEN: ${job} did not run to an exit (${r.error?.message ?? `signal ${r.signal}`}).`,
		});
	const why = because(r.stderr);
	if (json) {
		const envelope = parseEnvelope(r.stdout);
		if (envelope) return { job, ...envelope };
		return withStderr(
			buildJob({
				job,
				outcome: "MISSING",
				summary: `MISSING: ${job} printed no readable --json envelope (exit ${r.status}${why}) — ${UNEXAMINED}`,
			}),
			r.stderr,
		);
	}
	if (r.status === 0)
		return buildJob({ job, outcome: "OK", summary: `OK: ${job} exited 0.` });
	return withStderr(
		buildJob({
			job,
			outcome: "BROKEN",
			summary: `BROKEN: ${job} exited ${r.status}${why || "."}`,
		}),
		r.stderr,
	);
}

/** @param {string} root @returns {Host} */
function readHost(root) {
	const c = readConfig({ root, quiet: true });
	/** @type {string | null | undefined} */
	let tracker;
	return {
		root,
		file: path.relative(root, c.file),
		core: isCoreHost(root),
		modules: new Set(c.modules),
		config: /** @type {Record<string, unknown>} */ (c),
		tracker: () => {
			if (tracker === undefined) {
				const t = resolveKey("tracker", { root });
				tracker = typeof t === "string" ? t : null;
			}
			return tracker;
		},
	};
}

/**
 * A JSON object kept beside the stamp, or null where none is. One that will
 * not read or is not an object is logged, naming `consequence`, and read as
 * null.
 *
 * @param {string} file
 * @param {string} consequence what the caller does instead, for the log line
 * @returns {Record<string, unknown> | null}
 */
function readJsonObject(file, consequence) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (caught(e).code !== "ENOENT") logError(WHERE, e);
		return null;
	}
	try {
		const value = JSON.parse(text);
		if (value && typeof value === "object" && !Array.isArray(value))
			return value;
	} catch {
		/* Unparseable and a non-object are one fault: the line below. */
	}
	logError(WHERE, `${file} is not a JSON object; ${consequence}`);
	return null;
}

/**
 * Each `since` entry's last completed reading's start, by id. Fails open
 * (#1551) rather than skipping the check: the header's residual.
 *
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
const readLastStarts = (file) =>
	readJsonObject(file, `windows restart at ${FIRST_SINCE_DAYS} days`) ?? {};

/**
 * What one reading carries from the last: each `since` entry's last start and
 * each `rescan` entry's issue numbers, by id, and this reading's own start.
 *
 * @typedef {{ lastStarts: Record<string, unknown>,
 *   rescans: Record<string, unknown>, startMs: number }} Kept
 */

/**
 * Each `rescan` entry's issue numbers from its last completed reading, by id.
 *
 * @param {string} file
 * @returns {Record<string, unknown>}
 */
const readRescans = (file) =>
	readJsonObject(file, "nothing is re-scanned") ?? {};

/**
 * The issue numbers a job's keys name: the `#N` field of each.
 *
 * @param {Job} job
 * @returns {number[]}
 */
const issuesOf = (job) =>
	[
		...new Set(
			keysOf(job).flatMap((k) => {
				const m = /(?:^|\t)#(\d+)(?:\t|$)/.exec(k);
				return m ? [Number(m[1])] : [];
			}),
		),
	].sort((a, b) => a - b);

/**
 * The window and re-scan arguments an entry takes at this reading.
 *
 * @param {RepoCheck} entry
 * @param {Kept} kept
 * @returns {string[]}
 */
function carriedArgs(entry, { lastStarts, rescans, startMs }) {
	const out = entry.since
		? ["--since", String(sinceDays(lastStarts[entry.id], startMs))]
		: [];
	/* Issue numbers only: the check refuses anything else, and a BROKEN
	 * reading never rewrites the list that broke it. */
	const kept = entry.rescan ? rescans[entry.id] : undefined;
	const issues = Array.isArray(kept)
		? kept.filter((n) => Number.isInteger(n) && Number(n) > 0)
		: [];
	if (issues.length > 0) out.push("--rescan", issues.join(","));
	return out;
}

/**
 * The `--since` days for a reading starting at `startMs`: whole days since
 * `last`, rounded up, plus spec #1510's one of overlap. Rounding up alone
 * would not do: the check takes its cutoff from its own clock, up to the
 * run's 30-minute ceiling after `startMs`.
 *
 * @param {unknown} last
 * @param {number} startMs
 */
function sinceDays(last, startMs) {
	const t = typeof last === "string" ? Date.parse(last) : Number.NaN;
	if (Number.isNaN(t)) return FIRST_SINCE_DAYS;
	return Math.max(0, Math.ceil((startMs - t) / DAY_MS)) + 1;
}

/**
 * Every entry in order, gated, launched or left MISSING.
 *
 * @param {Host} host
 * @param {Kept} kept
 * @returns {Job[]}
 */
function runAll(host, kept) {
	const checkMs = parseCeiling("WFC_REPO_CHECKS_CHECK_MS", CHECK_MS);
	const deadline = Date.now() + parseCeiling("WFC_REPO_CHECKS_RUN_MS", RUN_MS);
	return REPO_CHECKS.map((entry) => {
		const fault = gateFault(entry, host);
		if (fault)
			return buildJob({
				job: entry.id,
				outcome: "SKIP",
				summary: `SKIP: ${fault}`,
			});
		const left = deadline - Date.now();
		if (left <= 0)
			return buildJob({
				job: entry.id,
				outcome: "MISSING",
				summary: `MISSING: ${entry.id} was not reached inside the run's ceiling — ${UNEXAMINED}`,
			});
		const ms = checkMs * (entry.ceilingScale ?? 1);
		const job = launch(
			entry,
			host.root,
			left < ms
				? { ms: left, by: "the run's ceiling" }
				: { ms, by: `its ${Math.round(ms / 1000)} s ceiling` },
			carriedArgs(entry, kept),
		);
		if (entry.kind === "reporter" && job.outcome === "BROKEN")
			logError(WHERE, job.summary);
		return job;
	});
}

/**
 * Move each `since` entry that completed to this reading's start, and each
 * `rescan` entry that completed to this reading's issues.
 *
 * @param {{ starts: string, rescans: string }} files
 * @param {Kept} kept
 * @param {Job[]} jobs
 */
function writeCarried(files, { lastStarts, rescans, startMs }, jobs) {
	/**
	 * @param {"since" | "rescan"} field
	 * @param {string} file
	 * @param {Record<string, unknown>} last
	 * @param {(j: Job) => unknown} carried
	 */
	const carry = (field, file, last, carried) => {
		const completed = jobs.filter(
			(j) => isCompleted(j.outcome) && entryOf(j.job)[field] === true,
		);
		if (completed.length === 0) return;
		const next = { ...last };
		for (const j of completed) next[j.job] = carried(j);
		writeJson(file, next);
	};
	const start = new Date(startMs).toISOString();
	carry("since", files.starts, lastStarts, () => start);
	carry("rescan", files.rescans, rescans, issuesOf);
}

/**
 * @param {string} file
 * @param {unknown} value
 */
function writeJson(file, value) {
	writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * @param {string} file
 * @param {Job[]} jobs
 * @param {string} repo repoKey()
 */
function writeResult(file, jobs, repo) {
	const result = {
		workflow: WHERE,
		repo,
		collectedAt: new Date(now()).toISOString(),
		jobs,
	};
	writeJson(file, result);
}

/** @param {Job[]} jobs */
function tally(jobs) {
	/** @type {Record<string, number>} */
	const by = {};
	for (const j of jobs) by[j.outcome] = (by[j.outcome] ?? 0) + 1;
	return Object.entries(by)
		.map(([outcome, n]) => `${n} ${outcome}`)
		.join(", ");
}

/**
 * The host repo as a filename-safe key: its tracker slug, `owner.repo`, or
 * its project slug where no tracker resolves. It qualifies the notify report
 * and every delivery stamp (spec #1510 §Delivery records are per repo), so
 * two repos running a check of one id keep two delivery records.
 *
 * @param {Host} host
 */
function repoKey(host) {
	const tracker = host.tracker();
	return (tracker ? tracker.replace("/", ".") : projectSlug(host.root)).replace(
		/[^A-Za-z0-9_.-]/g,
		"-",
	);
}

/** @param {string} repo repoKey() @param {string} job */
const stampName = (repo, job) => `${reportName(repo)}.${job}`;

/**
 * Each judged check through lib/key-delta.js's gate, for the header's notify
 * report.
 *
 * Every judged check carries a stamp, which the replay records once it has
 * shown the report (lib/delivery-stamp.js): a check left out of a shown
 * report would keep its older stamp, and re-show keys already seen.
 *
 * @param {Job[]} jobs
 * @param {string} repo
 * @param {number} startMs
 */
function judgeGains(jobs, repo, startMs) {
	/** @type {string[]} */
	const lines = [];
	/** @type {Record<string, string>} */
	const stamps = {};
	for (const j of jobs) {
		if (!isJudgedCheck(j)) continue;
		const name = stampName(repo, j.job);
		const countedKeys = unsettledKeys(j.job, j);
		const { stamp, added } = judgeKeys(j, {
			countedKeys,
			/* Logged, then read as nothing delivered: a repeat, never a silence
			 * (#1553). */
			delivered: readDeliveredKeys(name, (s) =>
				logError(
					WHERE,
					`delivery stamp ${s} will not parse; its keys read as new`,
				),
			),
			tag: startMs,
		});
		stamps[name] = stamp;
		if (added === null) lines.push(`  ${j.job} — ${j.summary}`);
		else if (added.length > 0)
			lines.push(
				`  ${j.job} — ${added.length} new finding(s), ${countedKeys.length} standing`,
			);
	}
	return { lines, stamps };
}

/**
 * Write this reading's notify report: empty where the gate is silent, so the
 * replay can tell a quiet reading from none.
 *
 * @param {Host} host
 * @param {Job[]} jobs
 * @param {{ startMs: number, result: string }} reading
 */
function writeNotifyReport(host, jobs, { startMs, result }) {
	const repo = repoKey(host);
	const { lines, stamps } = judgeGains(jobs, repo, startMs);
	const text =
		lines.length === 0
			? ""
			: [
					`REPO-CHECKS (${lines.length}) — ${repo}'s daily checks of ${new Date(startMs).toISOString()}, each gained a finding since the last report or drew no conclusion:`,
					...lines,
					`  Every check's result: ${result}`,
				].join("\n");
	const landed = notify.writeReport(reportName(repo), {
		outcome: lines.length === 0 ? "OK" : "WARN",
		text,
		stamps,
		owner: sessionFromEnv(),
		maxAgeMs: REPORT_MAX_AGE_MS,
	});
	if (!landed)
		logError(
			WHERE,
			`the notify report for ${repo} did not land in ${notify.base()}`,
		);
}

/**
 * The key sets the standing issue was last written with, by check id, or
 * null where none is kept: an unreadable record rewrites the issue rather
 * than leaving it behind.
 *
 * @param {string} file
 * @returns {Record<string, unknown> | null}
 */
const readIssueSets = (file) =>
	readJsonObject(file, "the standing issue is rewritten");

/**
 * Each judged check's standing keys, settled ones left out: this reading's
 * where it completed, its recorded ones where it drew no conclusion.
 *
 * @param {Job[]} jobs
 * @param {Record<string, unknown> | null} recorded
 */
function standingSets(jobs, recorded) {
	/** @type {Record<string, string[]>} */
	const sets = {};
	for (const j of jobs) {
		if (!isJudgedCheck(j)) continue;
		sets[j.job] = unsettledKeys(
			j.job,
			isCompleted(j.outcome) ? j : { keys: recorded?.[j.job] },
		);
	}
	return sets;
}

/** @param {Record<string, unknown>} a @param {Record<string, string[]>} b */
/* A check with no keys and one not judged at all read alike, so a gate
 * switching a clear check off is no change. */
const isSameSets = (a, b) => {
	const held = (/** @type {Record<string, unknown>} */ sets) =>
		JSON.stringify(
			Object.entries(sets)
				.filter(([, keys]) => Array.isArray(keys) && keys.length > 0)
				.sort(),
		);
	return held(a) === held(b);
};

/**
 * @param {Job[]} jobs
 * @param {Record<string, string[]>} sets
 * @param {number} startMs
 */
function buildStandingBody(jobs, sets, startMs) {
	const date = new Date(startMs).toISOString().slice(0, 10);
	const lines = [
		`Filed automatically by \`${scriptPath("repo-checks.js")}\`, which runs this repo's own checks once a day at session start and rewrites this body whenever a check's findings change. **Edit it by hand and the next change silently overwrites it** — put anything you want kept in a comment.`,
		"",
	];
	const held = jobs.flatMap((j) => {
		const n = sets[j.job]?.length ?? 0;
		if (n === 0) return [];
		/* The check's own count where it completed with nothing settled, which
		 * may count other than keys (lib/check.js); otherwise the keys left. */
		const nothingSettled = isCompleted(j.outcome) && keysOf(j).length === n;
		return [{ ...j, n: nothingSettled ? j.count : n }];
	});
	const unexamined = jobs
		.filter((j) => j.job in sets && !isCompleted(j.outcome))
		.map((j) => `\`${j.job}\``);
	if (held.length === 0) {
		lines.push(
			`As of ${date}, every check is clear: none holds a finding. This issue can be closed; the daily run files it again when a check gains one.`,
		);
		if (unexamined.length > 0)
			lines.push(
				"",
				`Drew no conclusion at that reading, so clear only as of its last one that did: ${unexamined.join(", ")}.`,
			);
		return lines.join("\n");
	}
	lines.push(`As of ${date}, ${held.length} check(s) hold findings:`, "");
	for (const { n, ...j } of held) {
		const state = isCompleted(j.outcome)
			? `${j.outcome}, ${n} finding(s)`
			: `${j.outcome} at this reading; ${n} finding(s) standing from its last that completed`;
		lines.push(
			`- \`${j.job}\` — ${state}. List them: \`${buildHandCommand(entryOf(j.job))}\``,
		);
	}
	return lines.join("\n");
}

/**
 * A tracker-less repo has nowhere to file the standing issue.
 *
 * @param {Host} host
 * @param {Job[]} jobs
 * @param {{ file: string, startMs: number }} reading
 */
function writeStandingIssue(host, jobs, { file, startMs }) {
	if (!host.tracker()) return;
	const recorded = readIssueSets(file);
	const sets = standingSets(jobs, recorded);
	if (recorded && isSameSets(recorded, sets)) return;
	const body = buildStandingBody(jobs, sets, startMs);
	try {
		if (Object.values(sets).some((keys) => keys.length > 0))
			fileOrRefresh({ title: ISSUE_TITLE, labels: [ISSUE_LABEL], body });
		else {
			const open = openTrackingIssue({ title: ISSUE_TITLE });
			if (open) refresh(open.number, body);
		}
		writeJson(file, sets);
	} catch (e) {
		logError(
			WHERE,
			`could not file or refresh "${ISSUE_TITLE}": ${parseErrLine(e)}; the next reading retries`,
		);
	}
}

/**
 * The checkout a reading belongs to: the main one where `launched` is a
 * linked worktree of it (#1555). A bare repo or a submodule, whose common
 * directory is not a `.git` beside a checkout, keeps `launched`.
 * @param {string} launched
 * @param {string} gitCommonDir
 * @returns {string}
 */
function readingRoot(launched, gitCommonDir) {
	const checkout = checkoutOfCommonDir(gitCommonDir);
	if (checkout === null) return launched;
	try {
		return fs.realpathSync(checkout);
	} catch (e) {
		/* Fails open to the launching checkout (#1555): a reading of it beats
		 * none, and the next day's reading retries the redirect. */
		logError(WHERE, `could not resolve the main checkout: ${errMessage(e)}`);
		return launched;
	}
}

function main() {
	try {
		const launched = hostRoot();
		const dir = gitCommonDirOrThrow(launched);
		const root = readingRoot(launched, dir);
		if (root !== launched) process.env.CLAUDE_PROJECT_DIR = root;
		/* The standing issue's gh calls find the tracker from here, as the
		 * reporters' do from the cwd they are launched in (#1554):
		 * lib/tracking-issue.js's fileOrRefresh and refresh take no cwd. */
		process.chdir(root);
		const result = resultFile(dir);
		const startMs = now();
		const gate = periodicReading(
			{
				stamp: path.join(dir, STAMP),
				lock: path.join(dir, LOCK),
				nowMs: startMs,
				everyMs: DAY_MS,
				lockStaleMs: LOCK_STALE_MS,
			},
			() => {
				const files = {
					starts: path.join(dir, SINCE),
					rescans: path.join(dir, RESCAN),
				};
				const kept = {
					lastStarts: readLastStarts(files.starts),
					rescans: readRescans(files.rescans),
					startMs,
				};
				const host = readHost(root);
				const jobs = runAll(host, kept);
				writeResult(result, jobs, repoKey(host));
				writeCarried(files, kept, jobs);
				writeNotifyReport(host, jobs, { startMs, result });
				writeStandingIssue(host, jobs, {
					file: path.join(dir, ISSUE_SETS),
					startMs,
				});
				return `${jobs.length} checks: ${tally(jobs)}. Result in ${result}.`;
			},
		);
		writeFd(2, `${gate.ran ? gate.value : buildSkipLine(gate, "a day")}\n`);
	} catch (e) {
		/* Fails open (#1548): a detached run nobody waits on never fails a
		 * session start; the next day's reading retries. */
		logError(WHERE, e);
		writeFd(
			2,
			`FAILED OPEN: ${errMessage(e)} — recorded in the guard-error log; the next day's reading retries.\n`,
		);
	}
}

if (require.main === module) main();
