#!/usr/bin/env node
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readCommit } = require("./lib/commit-sha.js");
const { gitReader } = require("./lib/git.js");
const {
	parseQueuePushes,
	queueBranch,
	queueNameOf,
	VERIFIED_REF,
} = require("./lib/landing-refs.js");
const { buildUnchecked, runPrePushGate } = require("./lib/pre-push-gate.js");
const { writeFd } = require("./lib/write-fd.js");

const REFUSE = 2;
const CHECK = path.join(__dirname, "check-guard-registry.js");

const unchecked = buildUnchecked(
	"landing-registry-gate",
	"guard-registry rows on main",
);

/**
 * @typedef {{ sha: string, ref: string }} JudgedPush
 */

/**
 * @param {string} stdin
 * @returns {JudgedPush[]}
 */
function parseJudgedPushes(stdin) {
	return parseQueuePushes(stdin).map(({ sha, remoteRef }) => ({
		sha,
		ref: queueBranch(queueNameOf(remoteRef)),
	}));
}

/**
 * @param {JudgedPush} push
 * @param {string} tree
 * @returns {number}
 */
function judgeOne(push, tree) {
	const { sha } = push;
	const read = readCommit(gitReader(tree), VERIFIED_REF);
	if (!read.ok) {
		unchecked(`git would not resolve ${VERIFIED_REF}: ${read.why}`);
		return 0;
	}
	const tip = read.sha;
	if (tip === null) {
		unchecked(
			`this clone holds no ${VERIFIED_REF} to judge ${push.ref} against`,
		);
		return 0;
	}
	const r = spawnSync(
		process.execPath,
		[CHECK, "--against", tip, "--head", sha],
		{ stdio: ["ignore", 2, 2] },
	);
	if (r.status === 1) {
		writeFd(
			2,
			`pre-push: refused — ${sha} expires guard-registry row(s) on main's tree at ${tip}, named above.\n`,
		);
		return REFUSE;
	}
	if (r.status !== 0)
		unchecked(
			`the checker could not judge ${sha} against ${tip} (${r.error?.message ?? `exit ${r.status}`})`,
		);
	return 0;
}

/**
 * @param {string} stdin
 * @param {string} tree
 * @returns {number}
 */
function judge(stdin, tree) {
	const pushes = parseJudgedPushes(stdin);
	if (pushes.length === 0) return 0;
	return pushes.reduce(
		(verdict, push) => Math.max(verdict, judgeOne(push, tree)),
		0,
	);
}

process.exitCode = runPrePushGate(unchecked, judge);
