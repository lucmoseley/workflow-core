#!/usr/bin/env node
/*
 * landing-registry-gate.js — the pre-push limb that judges a push to a queue
 * ref on `main`'s bytes: with the `landing` module on, refuse a push whose
 * pushed sha's tree holds a gating guard-registry fault, an expired anchor
 * among them, that `origin/main`'s tip does not.
 * `check-guard-registry.js --against <tip> --head <sha>` judges the one
 * against the other. A deletion passes unjudged.
 *
 * LIMIT: `git push --no-verify` skips every pre-push hook, this one included;
 * branch protection on the remote is the gate that binds (#2414).
 *
 * The module config is read at the pushing tree's HEAD, as
 * landing-push-gate.js reads it (#3128, #3132).
 *
 * IN NO `scripts/` FAMILY (code-standards §N3), as landing-push-gate.js.
 *
 * FAILS OPEN: 2 refuses on the checker's own FAIL alone, and a checker that
 * cannot answer — a BROKEN reading — passes the push, printed, as does a push
 * in a clone holding no `origin/main` or whose git will not resolve it, since
 * a refusal there would refuse every push for a fault that is not the push's.
 */

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { readCommit } = require("./lib/commit-sha.js");
const { gitReader } = require("./lib/git.js");
const { VERIFIED_REF } = require("./lib/landing-refs.js");
const { isZeroSha, parseRefLines } = require("./lib/push-refs.js");
const {
	buildUnchecked,
	isModuleOnAtHead,
	runPrePushGate,
} = require("./lib/pre-push-gate.js");
const { writeFd } = require("./lib/write-fd.js");

const REFUSE = 2;
/* A session's queue ref, `queue/<worktree name>`. */
const QUEUE = "refs/heads/queue/";
const CHECK = path.join(__dirname, "check-guard-registry.js");

const unchecked = buildUnchecked(
	"landing-registry-gate",
	"guard-registry rows on main",
);

/**
 * @typedef {{ sha: string, ref: string }} JudgedPush `ref` the pushed queue
 *   ref
 */

/**
 * Each push to a queue ref.
 * @param {string} stdin
 * @returns {JudgedPush[]}
 */
function parseJudgedPushes(stdin) {
	return parseRefLines(stdin).flatMap(({ sha, remoteRef }) =>
		!isZeroSha(sha) &&
		remoteRef?.startsWith(QUEUE) &&
		remoteRef.length > QUEUE.length
			? [{ sha, ref: remoteRef.slice("refs/heads/".length) }]
			: [],
	);
}

/**
 * @param {JudgedPush} push
 * @param {string} tree the pushing tree
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
 * @param {string} tree the pushing tree
 * @returns {number}
 */
function judge(stdin, tree) {
	const pushes = parseJudgedPushes(stdin);
	if (pushes.length === 0) return 0;
	if (!isModuleOnAtHead("landing", tree, unchecked)) return 0;
	return pushes.reduce(
		(verdict, push) => Math.max(verdict, judgeOne(push, tree)),
		0,
	);
}

process.exitCode = runPrePushGate(unchecked, judge);
