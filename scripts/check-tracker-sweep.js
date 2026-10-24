#!/usr/bin/env node
/*
 * check-tracker-sweep.js — list, on `npm run status`, every standing finding
 * in this repo's daily repo-checks reading (mantahostels#2490), the hand route
 * for what the runner's notify line goes silent on.
 *
 * WHAT IT READS (#1557). `.repo-checks.json` in the git common directory, the
 * merged result scripts/repo-checks.js writes once a day from the session-start
 * launcher. It asks GitHub nothing, and keeps no delivery stamps: what changed
 * since the last delivery is the runner's to say, through lib/key-delta.js's
 * gate.
 *
 * TWO STATES READ DIFFERENTLY FROM FAIL:
 *
 *   BROKEN   the check could not run, so the repo is UNEXAMINED on it, in as
 *            many words, because "we looked and found 19" and "we did not
 *            look" are opposite facts that a shared red would merge.
 *   MISSING  the check produced no envelope, the run's ceiling cut it off
 *            before it was reached, or the reading has no job for a registry
 *            entry at all — so an empty or truncated reading is never an
 *            all-clear.
 *
 * Unlike the runner, it lists a reporter that drew no conclusion: the runner
 * logs a BROKEN reporter to its error log and a MISSING one nowhere.
 *
 * FAILS OPEN, ALWAYS. No result yet is a SKIP, an unreadable one BROKEN, and
 * neither is ever printed as an all-clear.
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), reads the daily repo-checks run's merged result from the git common directory.
 * JUSTIFIED: fail-safe — the runner's notice goes silent on a standing backlog, so this is where a hand run lists every standing key.
 * DEFEAT:    none
 */

const fs = require("node:fs");

const { runCheck } = require("./lib/check.js");
const { hostRoot } = require("./lib/host-root.js");
const { isJudged, isUnexamined, keysOf } = require("./lib/key-delta.js");
const {
	buildHandCommand,
	commonDir,
	resultFile,
} = require("./lib/repo-checks-reading.js");
const { REPO_CHECKS } = require("./lib/repo-checks-registry.js");
const { caught } = require("./lib/caught.js");

/**
 * The merged result, parsed JSON from another process. `jobs` is the one
 * field verified at runtime, because a missing one has nothing to iterate;
 * its members are read through String().
 *
 * @typedef {{ job?: unknown, outcome?: unknown, keys?: unknown,
 *   summary?: unknown }} SweepJob
 * @typedef {{ collectedAt?: string, jobs: SweepJob[] }} SweepResult
 */

/**
 * What the per-job loop accumulates: each block's lines, and the two counts
 * the report leads with.
 * @typedef {{ standingLines: string[], unexaminedLines: string[],
 *   unexamined: number, standing: number }} JobTally
 */

/**
 * The result file, through the git common directory so a worktree reads the
 * reading its main checkout's run wrote. Only a directory that is no
 * checkout is a SKIP; git failing any other way is the apparatus broken.
 *
 * @param {import("./lib/check.js").CheckContext} ctx
 * @returns {string}
 */
function resultPath(ctx) {
	let dir = "";
	let gitError = null;
	try {
		dir = commonDir(hostRoot());
	} catch (e) {
		const failed = caught(e);
		gitError = failed.stderr || failed.message;
	}
	if (gitError !== null && /not a git repository/i.test(gitError))
		ctx.skip(`${hostRoot()} is not a git checkout, so no daily reading exists`);
	if (gitError !== null)
		ctx.broken(`could not find the git common directory: ${gitError.trim()}`);
	return resultFile(dir);
}

/**
 * @param {import("./lib/check.js").CheckContext} ctx
 * @param {string} file
 * @returns {SweepResult}
 */
function readResult(ctx, file) {
	/* The try wraps the READ alone: ctx.skip() and ctx.broken() raise, so a call
	 * inside it would be caught and re-reported under the wrong reason. */
	let parsed;
	let readError = null;
	let absent = false;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		const { code, message } = caught(e);
		if (code === "ENOENT") absent = true;
		else readError = message || String(e);
	}
	if (absent)
		ctx.skip(
			`no daily reading in ${file} yet — the session-start launcher writes it at most once a day`,
		);
	if (readError !== null)
		ctx.broken(
			`could not read ${file}: ${readError} — delete it, and the next session start's daily reading rewrites it`,
		);
	if (!Array.isArray(parsed?.jobs))
		ctx.broken(
			`${file} carries no jobs array — delete it, and the next session start's daily reading rewrites it`,
		);
	return parsed;
}

/**
 * The reading's jobs, plus a MISSING one for every registry entry it lacks.
 *
 * @param {SweepJob[]} jobs
 * @returns {SweepJob[]}
 */
function withAbsent(jobs) {
	const present = new Set(jobs.map((j) => String(j?.job)));
	return [
		...jobs,
		...REPO_CHECKS.filter((e) => !present.has(e.id)).map((e) => ({
			job: e.id,
			outcome: "MISSING",
			summary: `MISSING: the reading has no job for ${e.id}`,
		})),
	];
}

/** @param {string} name @returns {string} the line naming a job's hand command, or "" */
function handLine(name) {
	const entry = REPO_CHECKS.find((e) => e.id === name);
	return entry ? `    list them: ${buildHandCommand(entry)}` : "";
}

/**
 * Raise every standing key a job holds, or that it drew no conclusion.
 *
 * @param {import("./lib/check.js").CheckContext} ctx
 * @param {SweepJob} job
 * @param {JobTally} tally accumulator: the job's block lines and its count
 *   are added
 */
function judgeJob(ctx, job, tally) {
	const name = String(job?.job || "(unnamed job)");
	const outcome = String(job?.outcome || "MISSING");
	if (!isJudged(outcome)) return;

	if (isUnexamined(outcome)) {
		const line = `${name} — ${job?.summary || outcome}`;
		tally.unexamined++;
		tally.unexaminedLines.push(
			`  ${line}`,
			...[handLine(name)].filter(Boolean),
		);
		ctx.fail(
			outcome === "BROKEN" ? "SWEEP-BROKEN" : "SWEEP-MISSING",
			line,
			{ job: name, outcome },
			`${outcome}\t${name}`,
		);
		return;
	}

	const keys = keysOf(job);
	if (keys.length === 0) return;

	tally.standing += keys.length;
	ctx.warn(
		"SWEEP-STANDING",
		`${name} — ${keys.length} standing finding(s) (${outcome})`,
		{ job: name, outcome, keys, standing: keys.length },
		`SWEEP-STANDING\t${name}\t${JSON.stringify(keys)}`,
	);
	tally.standingLines.push(
		`  ${name} — ${keys.length} standing:`,
		...keys.map((key) => `    ${key.replace(/\t/g, "  ")}`),
		...[handLine(name)].filter(Boolean),
	);
}

/**
 * Both blocks lead with a bracketed-count header.
 * @param {import("./lib/check.js").CheckContext} ctx
 * @param {JobTally} tally
 * @param {{ jobs: number, when: string, file: string }} reading
 */
function sayJobBlocks(ctx, tally, { jobs, when, file }) {
	if (tally.standing)
		ctx.say(
			`TRACKER-SWEEP-STANDING (${tally.standing}) — every standing finding\n` +
				`  in the daily repo-checks reading of ${when}:`,
		);
	for (const line of tally.standingLines) ctx.say(line);
	if (tally.unexamined) {
		ctx.say(
			`\nTRACKER-SWEEP-UNEXAMINED (${tally.unexamined}) — of ${jobs} check(s), ` +
				"that many drew NO CONCLUSION.\n" +
				"  The repo is unexamined on those, not clean:",
		);
		for (const line of tally.unexaminedLines) ctx.say(line);
	}
	if (tally.standing || tally.unexamined)
		ctx.say(
			"\n  Nothing here was changed, and this reader has no way to change anything.\n" +
				`  Every check's result: ${file}\n`,
		);
}

runCheck({
	name: "tracker-sweep",
	usage: "usage: check-tracker-sweep.js [--json] [--warn]",
	run(ctx) {
		const file = resultPath(ctx);
		const result = readResult(ctx, file);
		const when = result.collectedAt || "an unrecorded time";
		const jobs = withAbsent(result.jobs);

		/* The standing lines are held rather than said as they are found, so the
		 * whole block can lead with its count header — see sayJobBlocks. */
		/** @type {JobTally} */
		const tally = {
			standingLines: [],
			unexaminedLines: [],
			unexamined: 0,
			standing: 0,
		};
		for (const job of jobs) judgeJob(ctx, job, tally);
		const { unexamined, standing } = tally;

		sayJobBlocks(ctx, tally, { jobs: jobs.length, when, file });

		return {
			count: standing + unexamined,
			noun: "standing finding(s) or check(s) that drew no conclusion",
			okLine:
				`all ${jobs.length} check(s) in the daily reading of ${when} ` +
				"drew a conclusion or were gated off, and none holds a finding.",
			data: {
				result: file,
				collectedAt: result.collectedAt,
				jobs: jobs.map((j) => ({
					job: j?.job,
					outcome: j?.outcome,
					standing: keysOf(j).length,
				})),
			},
		};
	},
});
