#!/usr/bin/env node

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
const LABEL = "ci-red";
const TAKES = takesLabel("triage");

/** @typedef {{ file: string, job: string, about: string }} Workflow */

/** @type {Workflow} */
const SWEEP = {
	file: "scheduled-checks.yml",
	job: "Full suite",
	about:
		"a `scheduled-checks` sweep — the full suite, run four times a day, which had no way to report a red one before mantahostels#2030",
};

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

/** @returns {Workflow[]} */
function trackedWorkflows() {
	const at = (/** @type {Workflow} */ w) => `.github/workflows/${w.file}`;
	const out = gitOrNull(["ls-files", "--", ...WORKFLOWS.map(at)], {
		cwd: hostRoot(),
	});
	const tracked = new Set((out ?? "").split("\n").filter(Boolean));
	return WORKFLOWS.filter((w) => tracked.has(at(w)));
}

const GOOD = new Set(["success", "neutral"]);

const NO_VERDICT = new Set(["cancelled", "skipped", "stale"]);

const SUITE_JOB = SWEEP.job;

/** @typedef {{headSha?: string, url?: string, createdAt?: string,
 *   workflow: Workflow}} Run */

/**
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

/** @param {{name?: string, conclusion?: string|null}[]} jobs */
function filesFor(jobs) {
	const verdict = jobsVerdict(jobs, SUITE_JOB);
	return verdict !== null && !GOOD.has(verdict);
}

// guess: 7.5 days at four sweeps a day, lucmoseley/mantahostels#3490
const RUN_WINDOW = 30;

function readWindows() {
	return trackedWorkflows().map((workflow) => {
		const rows = readRuns(workflow, RUN_WINDOW);
		return { workflow, rows, at: rows.findIndex((r) => r.verdict) };
	});
}

/** @param {string} [at] */
const timeOf = (at) => (at ? Date.parse(at) || 0 : 0);

/** @returns {{held: boolean, detail: string}} */
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

/** @returns {{held: boolean, detail: string} | null} */
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

/** @param {Run} red */
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

	const filed = createIssue({
		title: TITLE,
		labels: [LABEL, URGENT_LABEL, TAKES],
		body: body(red, green),
	});
	writeFd(1, `Filed ${filed}\n`);
}

if (require.main === module) main();

module.exports = {
	TITLE,
	LABEL,
	SWEEP_NAME,
	SUITE_JOB,
	filesFor,
	ciStillRed,
	newestCiRed,
};
