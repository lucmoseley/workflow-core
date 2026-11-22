#!/usr/bin/env node
/*
 * report-red-suite.js — mantahostels#2030 (the ticket that stopped a red scheduled suite
 * run filing nothing).
 *
 * A scheduled sweep re-tests `main` four times a day, so a red that only the
 * still tree shows — a flaky or date-dependent test — waits for the next
 * delivered slot; GitHub delivers them late, and the gap is not this repo's to
 * set (mantahostels#2204).
 *
 * ONE TRACKING ISSUE, MANY REDS. mantahostels#389's pattern (lib/tracking-issue.js) files
 * one issue per standing condition. A red suite is not quite that shape — each
 * red is its own event, with its own run URL and its own commit range — so the
 * ISSUE is deduplicated and the EVENTS are comments on it.
 *
 * A RED IS NOT ASSUMED TO BE A REGRESSION. Over the 10 days before mantahostels#2030 the
 * sweep passed 64.5% of the time (20/11, n=31), and the reds were dominated by
 * CI-environment flakiness rather than product breakage (mantahostels#2025 is a live
 * instance), and the body says so.
 *
 * IT RUNS FROM A SESSION, NOT FROM THE SWEEP (workflow-core#1963). The sweep runs on the
 * public code repo, whose token cannot reach the private tracker, so the daily
 * repo-checks run (lib/repo-checks-registry.js) launches this instead. It reads
 * the newest judged run of each workflow in WORKFLOWS the host tracks from
 * `codeRepo` — this repo's `scheduled-checks.yml`, an adopter's shipped
 * `workflow-core-ci.yml` (lib/adopter-ci.js, workflow-core#5383) — and files for the newest
 * red among them once: a red run already named on the open issue, or older
 * than the newest closed one, files nothing. Only the newest red is reported,
 * so two reds between readings are one comment.
 *
 * NOTHING FILES ON GREEN, and a green run does NOT close an open tracking
 * issue: `scripts/check-cleared-trackers.js` reports it as clearable instead,
 * and a human closes it. It never auto-closes — a flaky red that
 * self-heals would close its own issue before anyone read it.
 *
 * Exit code is 0 whether or not anything was filed. It exits non-zero only when
 * it cannot do its job (gh missing, the API refusing) or lib/cli-args.js
 * refuses its command line.
 */

const { writeFd } = require("./lib/write-fd.js");
const { scriptPath } = require("./lib/script-path.js");
const { parseOrExit } = require("./lib/cli-args");
const { gh, ghJson } = require("./lib/gh");
const { readRange, renderRange } = require("./lib/commit-range");
const { createIssue, findTrackingIssue } = require("./lib/tracking-issue");
const { codeRepoArgs, hostRoot } = require("./lib/workflow-core-config.js");
const { gitOrNull } = require("./lib/git.js");
const { takesLabel } = require("./lib/takes-label");
const { URGENT_LABEL } = require("./lib/urgent-label.js");

const TITLE = "The scheduled full-suite run is red on main";
/* The label the dedupe matches on, and the reason it is not `urgent`: a human
 * may strip `urgent` at any time (`rule:urgent-label`), and a tracking
 * issue whose match label can be removed by hand deduplicates until the day
 * somebody tidies it and then files a second issue. `ci-red` is carried by
 * nothing else and nobody has a reason to take it off. */
const LABEL = "ci-red";
/* `triage` and not `implement`: two thirds of the reds in mantahostels#2030's census were
 * the runner rather than the code, so the first act is deciding which this is,
 * not opening a fix. */
const TAKES = takesLabel("triage");

/**
 * A workflow whose red runs on `main` this files. `file` is the name `gh run
 * list --workflow` takes, never the display name; `job` the job that carries
 * the verdict, matched as a PREFIX (a reusable-workflow call shows up as
 * `<job name> / <inner job>`); `about` what one of its runs is, for the body.
 * @typedef {{ file: string, job: string, about: string }} Workflow
 */

/** @type {Workflow} */
const SWEEP = {
	file: "scheduled-checks.yml",
	job: "Full suite",
	about:
		"a `scheduled-checks` sweep — the full suite, run four times a day, which had no way to report a red one before mantahostels#2030",
};

/* The sweep by its display name, which is what `gh run list`'s `workflowName`
 * carries — the `name:` on that file's first line. */
const SWEEP_NAME = "scheduled-checks";

/** @type {Workflow[]} */
const WORKFLOWS = [
	SWEEP,
	{
		file: "workflow-core-ci.yml",
		job: "Tests and guards",
		about:
			"a `workflow-core CI` run — the repo's declared commands and the shipped checks, run on every push to `main`",
	},
];

/**
 * The WORKFLOWS the host tracks under `.github/workflows/`; none where git
 * cannot say.
 * @returns {Workflow[]}
 */
function trackedWorkflows() {
	const at = (/** @type {Workflow} */ w) => `.github/workflows/${w.file}`;
	const out = gitOrNull(["ls-files", "--", ...WORKFLOWS.map(at)], {
		cwd: hostRoot(),
	});
	const tracked = new Set((out ?? "").split("\n").filter(Boolean));
	return WORKFLOWS.filter((w) => tracked.has(at(w)));
}

/* THE GOOD CONCLUSIONS ARE LISTED, NEVER THE BAD ONES — `check-ci-status.js`'s
 * convention, and the reason for it: a conclusion GitHub adds later then reads
 * as red and surfaces, rather than passing as green unnoticed. */
const GOOD = new Set(["success", "neutral"]);

/* Conclusions that say nothing about the tree: a cancelled job never finished
 * judging it, and a skipped one never started. */
const NO_VERDICT = new Set(["cancelled", "skipped", "stale"]);

/* The sweep's job that runs the suite. */
const SUITE_JOB = SWEEP.job;

/** @typedef {{headSha?: string, url?: string, createdAt?: string,
 *   workflow: Workflow}} Run */

/**
 * `workflow`'s runs on `main`, newest first, each carrying its verdict job's
 * own verdict.
 *
 * THE RUN'S CONCLUSION IS THE WRONG QUESTION. A sweep is three jobs, so its run
 * conclusion is red when the `documents` job fails over a green suite. The
 * filing side is gated on `needs.suite.result` for exactly that reason, and a
 * clearing or range query reading the run instead would disagree with it — the
 * tracker would stand on a red nobody filed, and the commit range would be
 * measured back to the wrong end.
 *
 * @param {Workflow} workflow
 * @param {number} limit
 * @returns {(Run & {verdict: string|null})[]}
 */
function readRuns(workflow, limit) {
	/** @type {{databaseId?: number, headSha?: string, url?: string, createdAt?: string}[]} */
	const rows = ghJson([
		"run",
		"list",
		"--workflow",
		workflow.file,
		"--branch",
		"main",
		"--limit",
		String(limit),
		"--json",
		"databaseId,headSha,url,createdAt",
	]);
	return rows.map((r) => ({
		...r,
		workflow,
		verdict: jobVerdict(r.databaseId, workflow.job),
	}));
}

/**
 * The verdict job's conclusion inside one run, or null where it carries none.
 *
 * A reusable-workflow call fans a job out into `<prefix> / <inner job>`,
 * one row per inner job, and more than one can share the prefix — so every
 * matching row is read, never just the first the API happens to list. Red as
 * soon as any matching row is bad. Green only once every matching row other
 * than cancelled/skipped/stale has concluded and all are good. A row with no
 * conclusion yet (still running) holds the verdict at null.
 *
 * @param {number|undefined} runId
 * @param {string} job
 * @returns {string|null}
 */
function jobVerdict(runId, job) {
	if (!runId) return null;
	return jobsVerdict(
		ghJson(["run", "view", String(runId), "--json", "jobs", "--jq", ".jobs"]),
		job,
	);
}

/**
 * jobVerdict() over a jobs list already in hand.
 *
 * @param {{name?: string, conclusion?: string|null}[]} jobs
 * @param {string} job
 * @returns {string|null}
 */
function jobsVerdict(jobs, job) {
	const matching = jobs.filter((j) => String(j.name || "").startsWith(job));
	const relevant = matching.filter(
		(j) => !NO_VERDICT.has(String(j.conclusion)),
	);
	const [first] = relevant;
	if (first === undefined) return null;
	const bad = relevant.find(
		(j) => j.conclusion && !GOOD.has(String(j.conclusion)),
	);
	if (bad) return String(bad.conclusion);
	if (relevant.some((j) => !j.conclusion)) return null;
	return String(first.conclusion);
}

/**
 * Whether this script files for a sweep with these jobs — its suite job red.
 *
 * @param {{name?: string, conclusion?: string|null}[]} jobs
 */
function filesFor(jobs) {
	const verdict = jobsVerdict(jobs, SUITE_JOB);
	return verdict !== null && !GOOD.has(verdict);
}

/* How many runs back either query looks. At mantahostels#3490's four sweeps a
 * day, 30 is 7.5 days — enough that a red surviving a long weekend still finds
 * its green end. IT IS NOT FREE: readRuns() resolves every row eagerly, one
 * `gh run view` apiece, so an invocation costs ~31 gh calls a workflow where
 * it cost ~21. */
const RUN_WINDOW = 30;

/**
 * Each tracked workflow's runs over RUN_WINDOW, and the index of its newest
 * judged one, -1 where none is judged.
 */
function readWindows() {
	return trackedWorkflows().map((workflow) => {
		const rows = readRuns(workflow, RUN_WINDOW);
		return { workflow, rows, at: rows.findIndex((r) => r.verdict) };
	});
}

/** @param {string} [at] */
const timeOf = (at) => (at ? Date.parse(at) || 0 : 0);

/**
 * Whether the newest FINISHED run of any tracked workflow is still red — the
 * condition this tracking issue stands for, and the one
 * `scripts/check-cleared-trackers.js` asks about.
 *
 * IT LIVES HERE SO THE TWO CANNOT DISAGREE about which job's verdict counts.
 * The checker's own header requires
 * each entry to call the function its filer measures with; a second reading of
 * "is the sweep red" in that file could call the issue cleared while this
 * script is still filing against it.
 *
 * A run carrying no verdict is stepped over — the same alphabet
 * `scripts/check-ci-status.js` uses. A window holding no finished run at all
 * THROWS, because the checker treats a throw as unreadable, which is the honest
 * answer.
 *
 * @returns {{held: boolean, detail: string}}
 */
function ciStillRed() {
	const judged = readWindows().flatMap(({ rows }) => {
		const run = rows.find((r) => r.verdict);
		return run ? [run] : [];
	});
	if (judged.length === 0)
		throw new Error(
			`no run of ${namesOf(trackedWorkflows())} in the last ${RUN_WINDOW} carries a verdict`,
		);
	return heldBy(judged, "newest judged", "job");
}

/**
 * Held where any judged run is red, with one detail clause a run.
 * @param {Array<Run & {verdict: string|null}>} judged
 * @param {string} which
 * @param {string} what
 * @returns {{held: boolean, detail: string}}
 */
const heldBy = (judged, which, what) => ({
	held: judged.some((r) => !GOOD.has(String(r.verdict))),
	detail: judged
		.map(
			(r) =>
				`${which} ${r.workflow.file} ${what} is ${r.verdict} (${r.createdAt || "date unknown"}) — ${r.url || "no url"}`,
		)
		.join("; "),
});

/** @param {Workflow[]} workflows */
const namesOf = (workflows) =>
	workflows.length === 0
		? "no tracked workflow"
		: workflows.map((w) => w.file).join(" or ");

/**
 * Whether the single newest run of a tracked workflow is red — cheap, unlike
 * ciStillRed() above. That one is priced for a caller with an open issue to amortise the
 * ~31-call RUN_WINDOW walk against; this one is for the OPPOSITE caller,
 * `scripts/check-cleared-trackers.js`'s `unfiledCondition` probe, paid on every
 * session start with NO issue open (mantahostels#2297). One `gh run list --limit 1` plus
 * at most one `gh run view` a tracked workflow, never more.
 *
 * A newest run carrying no verdict (still running, or its job cancelled)
 * reads as UNKNOWN rather than searching backward for one that does.
 *
 * @returns {{held: boolean, detail: string} | null} null where no tracked
 *   workflow's newest run carries a verdict to read.
 */
function newestCiRed() {
	const workflows = trackedWorkflows();
	const newest = workflows.flatMap((w) => readRuns(w, 1));
	if (newest.length === 0)
		throw new Error(`no run of ${namesOf(workflows)} exists on this branch`);
	const judged = newest.filter((r) => r.verdict);
	if (judged.length === 0) return null;
	return heldBy(judged, "newest", "run");
}

/**
 * The commit range back to the workflow's last green run, as body lines.
 *
 * `readRange` walks `good..bad` in this clone. Where either end is missing from
 * it — a clone not yet fetched past the red sha — the range renders its own
 * "unavailable" line rather than throwing: a range nobody can read is worth
 * less than the run URL, not worth losing it for.
 *
 * @param {Workflow} workflow
 * @param {Run|null} green
 * @param {string} sha
 * @returns {string[]}
 */
function buildRangeLines(workflow, green, sha) {
	const good = green?.headSha || "";
	if (!good)
		return [
			`No green \`${workflow.file}\` run is in the API's window, so there is no`,
			"range to read. The last green end has to be found by hand:",
			"",
			`    gh run list --workflow ${workflow.file} --status success --limit 1 --json headSha ${codeRepoArgs().join(" ")}`.trimEnd(),
		];
	return renderRange(readRange({ good, bad: sha, cwd: process.cwd() }), {
		good,
		bad: sha,
	});
}

/**
 * @param {Run} red
 * @param {Run|null} green
 */
function buildEventLines(red, green) {
	return [
		`- **Workflow:** \`${red.workflow.file}\``,
		`- **Run:** ${red.url || "(the API gave no run URL)"}`,
		`- **Head sha:** \`${red.headSha || "(unknown)"}\``,
		`- **Last green run:** ${green?.url ? `${green.url} (\`${(green.headSha || "").slice(0, 7)}\`, ${green.createdAt || "date unknown"})` : "none in the API's window"}`,
		"",
		"```",
		...buildRangeLines(red.workflow, green, red.headSha || ""),
		"```",
	];
}

/**
 * @param {Run} red
 * @param {Run|null} green
 */
function body(red, green) {
	return [
		"Filed automatically by `scripts/report-red-suite.js`, from the daily",
		`repo-checks run, for a red run on \`main\`: ${red.workflow.about}.`,
		"",
		"## The red run",
		"",
		...buildEventLines(red, green),
		"",
		"## Read this before hunting a commit",
		"",
		"**A red run is not evidence of a regression.** Over the ten days before mantahostels#2030",
		"its scheduled sweep passed 64.5% of the time (20 success / 11 failure, n=31),",
		"and the failures were dominated by CI-environment flakiness rather than",
		"product breakage. Reproduce locally on the head sha before reading the commit",
		"range above as a suspect list.",
		"",
		"## What happens next",
		"",
		"A further red run adds a **comment** here rather than filing again, so one",
		"unfixed red costs one issue however many runs go over it.",
		"",
		"A green run files nothing and **does not close this issue** — a flaky red that",
		"self-heals would otherwise close its own issue before anyone read it.",
		"`scripts/check-cleared-trackers.js` reports this issue as clearable once the",
		"newest judged run is green; a human closes it.",
	].join("\n");
}

/**
 * @param {Run} red
 * @param {Run|null} green
 */
function comment(red, green) {
	return [
		"**Another red run** — the same tracking issue, so nothing new was filed.",
		"",
		...buildEventLines(red, green),
	].join("\n");
}

/**
 * Whether the open issue already names this run, in its body or a comment.
 *
 * @param {number} number
 * @param {string} url
 */
function isRunNamedOn(number, url) {
	/** @type {{body?: string, comments?: {body?: string}[]}} */
	const issue = ghJson([
		"issue",
		"view",
		String(number),
		"--json",
		"body,comments",
	]);
	return [issue.body, ...(issue.comments || []).map((c) => c.body)].some(
		(text) => String(text || "").includes(url),
	);
}

/**
 * Whether a closed issue already answered this run: one closed after the run
 * was created, so whoever closed it could have seen it.
 *
 * @param {Run} red
 */
function isClosedSince(red) {
	const closed = findTrackingIssue({ title: TITLE, label: LABEL }, "closed");
	return Boolean(
		closed?.closedAt &&
			red.createdAt &&
			Date.parse(closed.closedAt) > Date.parse(red.createdAt),
	);
}

function main() {
	parseOrExit(process.argv.slice(2), {
		usage: `usage: node ${scriptPath("report-red-suite.js")}`,
	});
	const windows = readWindows();
	if (windows.length === 0) {
		writeFd(
			1,
			`This repo tracks none of ${WORKFLOWS.map((w) => w.file).join(", ")}; nothing to read.\n`,
		);
		return;
	}
	const judged = windows.filter((w) => w.at !== -1);
	if (judged.length === 0) {
		writeFd(
			1,
			`No run of ${namesOf(windows.map((w) => w.workflow))} in the last ${RUN_WINDOW} carries a verdict; nothing to file.\n`,
		);
		return;
	}
	/* The newest red among the workflows' newest judged runs. */
	const redWindow = judged
		.filter((w) => !GOOD.has(String(w.rows[w.at]?.verdict)))
		.sort(
			(a, b) =>
				timeOf(b.rows[b.at]?.createdAt) - timeOf(a.rows[a.at]?.createdAt),
		)[0];
	if (redWindow === undefined) {
		writeFd(
			1,
			`The newest judged run of ${namesOf(judged.map((w) => w.workflow))} is green; nothing to file.\n`,
		);
		return;
	}
	const { rows, at } = redWindow;
	const red = rows[at];
	if (red === undefined)
		throw new Error(
			`${redWindow.workflow.file}: judged run ${at} is missing from its window`,
		);
	const url = red.url || "";
	const green =
		rows.slice(at + 1).find((r) => r.verdict && GOOD.has(r.verdict)) || null;
	const existing = findTrackingIssue({ title: TITLE, label: LABEL }, "open");

	if (existing) {
		if (url && isRunNamedOn(existing.number, url)) {
			writeFd(
				1,
				`#${existing.number} already names the newest red run, ${url}.\n`,
			);
			return;
		}
		gh([
			"issue",
			"comment",
			String(existing.number),
			"--body",
			comment(red, green),
		]);
		writeFd(
			1,
			`Commented on #${existing.number} — already open for a red run.\n`,
		);
		return;
	}
	if (isClosedSince(red)) {
		writeFd(
			1,
			`A ${LABEL} issue was closed after the newest red run, ${url}; not refiling it.\n`,
		);
		return;
	}

	/* Labelled at creation because a create from a script is invisible to
	 * the guard-issue-create-label core, which sees Bash tool calls only —
	 * mantahostels#464 is the live instance of an issue reaching the tracker bare (mantahostels#470).
	 * `urgent` as well as `LABEL`, never instead of it: mantahostels#2030 asks for it. */
	const filed = createIssue({
		title: TITLE,
		labels: [LABEL, URGENT_LABEL, TAKES],
		body: body(red, green),
	});
	writeFd(1, `Filed ${filed}\n`);
}

if (require.main === module) main();

/* TITLE, LABEL and ciStillRed are what check-cleared-trackers.js consumes:
 * it must look for the issue THIS script files, and ask THIS function whether
 * the condition still holds, rather than keeping a second spelling of either.
 * newestCiRed is the same checker's unfiledCondition probe (mantahostels#2297).
 * SWEEP_NAME, SUITE_JOB and filesFor tell check-ci-status.js which red this
 * script files for (workflow-core#532). */
module.exports = {
	TITLE,
	LABEL,
	SWEEP_NAME,
	SUITE_JOB,
	filesFor,
	ciStillRed,
	newestCiRed,
};
