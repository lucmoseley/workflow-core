#!/usr/bin/env node

const fs = require("node:fs");

const { runCheck } = require("./lib/check.js");
const { hostRoot } = require("./lib/host-root.js");
const { isJudged, isUnexamined, keysOf } = require("./lib/key-delta.js");
const {
	buildHandCommand,
	resultFile,
} = require("./lib/repo-checks-reading.js");
const { gitCommonDirOrThrow } = require("./lib/git.js");
const { REPO_CHECKS } = require("./lib/repo-checks-registry.js");
const { caught } = require("./lib/caught.js");

/**
 * @typedef {{ job?: unknown, outcome?: unknown, keys?: unknown,
 *   summary?: unknown }} SweepJob
 * @typedef {{ collectedAt?: string, jobs: SweepJob[] }} SweepResult
 */

/**
 * @typedef {{ standingLines: string[], unexaminedLines: string[],
 *   unexamined: number, standing: number }} JobTally
 */

/**
 * @param {import("./lib/check.js").Ctx} ctx
 * @returns {string}
 */
function resultPath(ctx) {
	let dir = "";
	let gitError = null;
	try {
		dir = gitCommonDirOrThrow(hostRoot());
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
 * @param {import("./lib/check.js").Ctx} ctx
 * @param {string} file
 * @returns {SweepResult}
 */
function readResult(ctx, file) {
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

/**
 * @param {string} name
 * @returns {string}
 */
function buildHandLine(name) {
	const entry = REPO_CHECKS.find((e) => e.id === name);
	return entry ? `    list them: ${buildHandCommand(entry)}` : "";
}

/**
 * @param {import("./lib/check.js").Ctx} ctx
 * @param {SweepJob} job
 * @param {JobTally} tally
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
			...[buildHandLine(name)].filter(Boolean),
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
		...[buildHandLine(name)].filter(Boolean),
	);
}

/**
 * @param {import("./lib/check.js").Ctx} ctx
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
