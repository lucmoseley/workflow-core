#!/usr/bin/env node
/*
 * report-red-suite.js — mantahostels#2030 (the ticket that stopped a red scheduled suite
 * run filing nothing).
 *
 * The full suite runs on cron only (mantahostels#904 moved it off the push trigger to cut
 * Actions spend), so a breakage sits on `main` for up to ~12 hours — the cron
 * asks for 4, GitHub delivers the slots late, and the gap is not this repo's to
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
 * IT RUNS FROM A SESSION, NOT FROM THE SWEEP (#1963). The sweep runs on the
 * public code repo, whose token cannot reach the private tracker, so the daily
 * repo-checks run (lib/repo-checks-registry.js) launches this instead. It reads
 * the newest judged sweep from `codeRepo` and files for it once: a red run
 * already named on the open issue, or older than the newest closed one, files
 * nothing. Only the newest red is reported, so two reds between readings are
 * one comment.
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

const { parseOrExit } = require("./lib/cli-args");
const { gh, ghJson } = require("./lib/gh");
const { readRange, renderRange } = require("./lib/commit-range");
const { findTrackingIssue } = require("./lib/tracking-issue");
const { codeRepoArgs } = require("./lib/workflow-core-config.js");
const { takesLabel } = require("./lib/takes-label");

const TITLE = "The scheduled full-suite run is red on main";
/* The label the dedupe matches on, and the reason it is not `urgent`: a human
 * may strip `urgent` at any time (`rule:urgent-label`), and a tracking
 * issue whose match label can be removed by hand deduplicates until the day
 * somebody tidies it and then files a second issue. `ci-red` is carried by
 * nothing else and nobody has a reason to take it off. */
const LABEL = "ci-red";
/* Applied as well as `LABEL`, never instead of it — mantahostels#2030 asks for it. */
const URGENT = "urgent";
/* `triage` and not `implement`: two thirds of the reds in mantahostels#2030's census were
 * the runner rather than the code, so the first act is deciding which this is,
 * not opening a fix. */
const TAKES = takesLabel("triage");

/* The workflow whose green runs bound the commit range. Spelled as the file
 * name `gh run list --workflow` takes, not the display name. */
const SWEEP_WORKFLOW = "scheduled-checks.yml";

/* The same workflow by its display name, which is what `gh run list`'s
 * `workflowName` carries — the `name:` on that file's first line. */
const SWEEP_NAME = "scheduled-checks";

/* THE GOOD CONCLUSIONS ARE LISTED, NEVER THE BAD ONES — `check-ci-status.js`'s
 * convention, and the reason for it: a conclusion GitHub adds later then reads
 * as red and surfaces, rather than passing as green unnoticed. */
const GOOD = new Set(["success", "neutral"]);

/* Conclusions that say nothing about the tree: a cancelled job never finished
 * judging it, and a skipped one never started. */
const NO_VERDICT = new Set(["cancelled", "skipped", "stale"]);

/* The job in this workflow that runs the suite. A reusable-workflow call shows
 * up as `<job name> / <inner job>`, so this is matched as a PREFIX. */
const SUITE_JOB = "Full suite";

/** @typedef {{headSha?: string, url?: string, createdAt?: string}} Run */

/**
 * The sweeps on `main`, newest first, each carrying the SUITE JOB's own verdict.
 *
 * THE RUN'S CONCLUSION IS THE WRONG QUESTION. A sweep is three jobs, so its run
 * conclusion is red when the `documents` job fails over a green suite. The
 * filing side is gated on `needs.suite.result` for exactly that reason, and a
 * clearing or range query reading the run instead would disagree with it — the
 * tracker would stand on a red nobody filed, and the commit range would be
 * measured back to the wrong end.
 *
 * @param {number} limit
 * @returns {(Run & {verdict: string|null})[]}
 */
function readSweeps(limit) {
	/** @type {(Run & {databaseId?: number})[]} */
	const rows = ghJson([
		"run",
		"list",
		"--workflow",
		SWEEP_WORKFLOW,
		"--branch",
		"main",
		"--limit",
		String(limit),
		"--json",
		"databaseId,headSha,url,createdAt",
	]);
	return rows.map((r) => ({ ...r, verdict: suiteVerdict(r.databaseId) }));
}

/**
 * The suite job's conclusion inside one sweep, or null where it carries none.
 *
 * A reusable-workflow call fans SUITE_JOB out into `<prefix> / <inner job>`,
 * one row per inner job, and more than one can share the prefix — so every
 * matching row is read, never just the first the API happens to list. Red as
 * soon as any matching row is bad. Green only once every matching row other
 * than cancelled/skipped/stale has concluded and all are good. A row with no
 * conclusion yet (still running) holds the verdict at null.
 *
 * @param {number|undefined} runId
 * @returns {string|null}
 */
function suiteVerdict(runId) {
	if (!runId) return null;
	return suiteJobsVerdict(
		ghJson(["run", "view", String(runId), "--json", "jobs", "--jq", ".jobs"]),
	);
}

/**
 * suiteVerdict() over a jobs list already in hand.
 *
 * @param {{name?: string, conclusion?: string|null}[]} jobs
 * @returns {string|null}
 */
function suiteJobsVerdict(jobs) {
	const matching = jobs.filter((j) =>
		String(j.name || "").startsWith(SUITE_JOB),
	);
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
 * Whether this script files for a run with these jobs — its suite job red.
 *
 * @param {{name?: string, conclusion?: string|null}[]} jobs
 */
function filesFor(jobs) {
	const verdict = suiteJobsVerdict(jobs);
	return verdict !== null && !GOOD.has(verdict);
}

/* How many sweeps back either query looks. At mantahostels#3490's four a day, 30 is 7.5
 * days — enough that a red surviving a long weekend still finds its green end.
 * IT IS NOT FREE: readSweeps() resolves every row eagerly, one `gh run view`
 * apiece, so an invocation costs ~31 gh calls where it cost ~21. */
const RUN_WINDOW = 30;

/**
 * Whether the newest FINISHED sweep is still red — the condition this tracking
 * issue stands for, and the one `scripts/check-cleared-trackers.js` asks about.
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
function sweepStillRed() {
	const rows = readSweeps(RUN_WINDOW);
	const judged = rows.find((r) => r.verdict);
	if (!judged)
		throw new Error(
			`no ${SWEEP_WORKFLOW} run in the last ${rows.length} carries a suite verdict`,
		);
	return {
		held: !GOOD.has(String(judged.verdict)),
		detail: `newest judged suite job is ${judged.verdict} (${judged.createdAt || "date unknown"}) — ${judged.url || "no url"}`,
	};
}

/**
 * Whether the single newest sweep is red — cheap, unlike sweepStillRed()
 * above. That one is priced for a caller with an open issue to amortise the
 * ~31-call RUN_WINDOW walk against; this one is for the OPPOSITE caller,
 * `scripts/check-cleared-trackers.js`'s `unfiledCondition` probe, paid on every
 * session start with NO issue open (mantahostels#2297). One `gh run list --limit 1` plus
 * at most one `gh run view`, never more.
 *
 * A newest run carrying no verdict (still running, or its suite job
 * cancelled) reads as UNKNOWN rather than searching backward for one that
 * does.
 *
 * @returns {{held: boolean, detail: string} | null} null where the newest
 *   sweep carries no verdict to read.
 */
function newestSweepRed() {
	const [newest] = readSweeps(1);
	if (newest === undefined)
		throw new Error(`no ${SWEEP_WORKFLOW} run exists on this branch`);
	if (!newest.verdict) return null;
	return {
		held: !GOOD.has(String(newest.verdict)),
		detail: `newest sweep is ${newest.verdict} (${newest.createdAt || "date unknown"}) — ${newest.url || "no url"}`,
	};
}

/**
 * The commit range back to the last green sweep, as body lines.
 *
 * `readRange` walks `good..bad` in this clone. Where either end is missing from
 * it — a clone not yet fetched past the red sha — the range renders its own
 * "unavailable" line rather than throwing: a range nobody can read is worth
 * less than the run URL, not worth losing it for.
 *
 * @param {Run|null} green
 * @param {string} sha
 * @returns {string[]}
 */
function buildRangeLines(green, sha) {
	const good = green?.headSha || "";
	if (!good)
		return [
			`No green \`${SWEEP_WORKFLOW}\` run is in the API's window, so there is no`,
			"range to read. The last green end has to be found by hand:",
			"",
			`    gh run list --workflow ${SWEEP_WORKFLOW} --status success --limit 1 --json headSha ${codeRepoArgs().join(" ")}`.trimEnd(),
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
		`- **Workflow:** \`${SWEEP_WORKFLOW}\``,
		`- **Run:** ${red.url || "(the API gave no run URL)"}`,
		`- **Head sha:** \`${red.headSha || "(unknown)"}\``,
		`- **Last green sweep:** ${green?.url ? `${green.url} (\`${(green.headSha || "").slice(0, 7)}\`, ${green.createdAt || "date unknown"})` : "none in the API's window"}`,
		"",
		"```",
		...buildRangeLines(green, red.headSha || ""),
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
		"repo-checks run, for a red `scheduled-checks` sweep — the full suite, run",
		"four times a day, which had no way to report a red one before mantahostels#2030.",
		"",
		"## The red run",
		"",
		...buildEventLines(red, green),
		"",
		"## Read this before hunting a commit",
		"",
		"**A red sweep is not evidence of a regression.** Over the ten days before mantahostels#2030",
		"the sweep passed 64.5% of the time (20 success / 11 failure, n=31), and the",
		"failures were dominated by CI-environment flakiness rather than product",
		"breakage. Reproduce locally on the head sha before reading the commit range",
		"above as a suspect list.",
		"",
		"## What happens next",
		"",
		"A further red sweep adds a **comment** here rather than filing again, so one",
		"unfixed red costs one issue however many sweeps run over it.",
		"",
		"A green sweep files nothing and **does not close this issue** — a flaky red that",
		"self-heals would otherwise close its own issue before anyone read it.",
		"`scripts/check-cleared-trackers.js` reports this issue as clearable once the",
		"newest sweep is green; a human closes it.",
	].join("\n");
}

/**
 * @param {Run} red
 * @param {Run|null} green
 */
function comment(red, green) {
	return [
		"**Another red sweep** — the same tracking issue, so nothing new was filed.",
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
		usage: "usage: node scripts/report-red-suite.js",
	});
	const rows = readSweeps(RUN_WINDOW);
	const at = rows.findIndex((r) => r.verdict);
	const red = rows[at];
	if (red === undefined) {
		console.log(
			`No ${SWEEP_WORKFLOW} run in the last ${rows.length} carries a suite verdict; nothing to file.`,
		);
		return;
	}
	if (GOOD.has(String(red.verdict))) {
		console.log(`The newest judged sweep is ${red.verdict}; nothing to file.`);
		return;
	}
	const url = red.url || "";
	const green =
		rows.slice(at + 1).find((r) => r.verdict && GOOD.has(r.verdict)) || null;
	const existing = findTrackingIssue({ title: TITLE, label: LABEL }, "open");

	if (existing) {
		if (url && isRunNamedOn(existing.number, url)) {
			console.log(
				`#${existing.number} already names the newest red sweep, ${url}.`,
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
		console.log(
			`Commented on #${existing.number} — already open for a red sweep.`,
		);
		return;
	}
	if (isClosedSince(red)) {
		console.log(
			`A ${LABEL} issue was closed after the newest red sweep, ${url}; not refiling it.`,
		);
		return;
	}

	/* Labelled at creation because a create from a script is invisible to
	 * scripts/guard-issue-create-label.js, which sees Bash tool calls only —
	 * mantahostels#464 is the live instance of an issue reaching the tracker bare (mantahostels#470). */
	const filed = gh([
		"issue",
		"create",
		"--title",
		TITLE,
		"--label",
		LABEL,
		"--label",
		URGENT,
		"--label",
		TAKES,
		"--body",
		body(red, green),
	]).trim();
	console.log(`Filed ${filed}`);
}

if (require.main === module) main();

/* TITLE, LABEL and sweepStillRed are what check-cleared-trackers.js consumes:
 * it must look for the issue THIS script files, and ask THIS function whether
 * the condition still holds, rather than keeping a second spelling of either.
 * newestSweepRed is the same checker's unfiledCondition probe (mantahostels#2297).
 * SWEEP_NAME, SUITE_JOB and filesFor tell check-ci-status.js which red this
 * script files for (#532). */
module.exports = {
	TITLE,
	LABEL,
	SWEEP_NAME,
	SUITE_JOB,
	filesFor,
	sweepStillRed,
	newestSweepRed,
};
