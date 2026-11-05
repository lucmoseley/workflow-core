#!/usr/bin/env node
/*
 * landing-registry-gate.js — the pre-push limb that judges a push to `landing`
 * on `landing`'s bytes (#3074, spec #2261), and a push to a queue ref on
 * `main`'s (#4458): with the `landing` module on, refuse a push whose pushed
 * sha's tree holds a gating guard-registry fault, an expired anchor among
 * them, that the tip it is judged against does not.
 *
 * A push to `landing` only fast-forwards it, so the pushed sha's tree is
 * `landing`'s next tree and the remote sha is its tip now:
 * `check-guard-registry.js --against <tip> --head <sha>` judges the one
 * against the other. A deletion passes unjudged, and a push creating
 * `landing` passes, printed.
 *
 * A LANDER REVERT passes with the rows it leaves stale: with WFC_LANDER_REVERT
 * naming a culprit, the checker stands staleness down where the pushed sha is
 * one commit on the tip, carries git's revert line for that culprit and holds
 * its clean revert, so the lander can reopen a held queue (#3127); naming the
 * culprit's dependents first, where the push is one line of such reverts, one
 * per commit named, in that order (#4453). The same revert is judged against
 * the culprit's parent as well as the tip, a fault refusing only where it is
 * in neither (#4451).
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
 * cannot answer — a tip this clone has not fetched, a BROKEN reading — passes
 * the push, printed, since a refusal there would refuse every push for a fault
 * that is not the push's.
 */

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { buildRevertBaseEnv } = require("./lib/clean-revert.js");
const { gitOrNull } = require("./lib/git.js");
const { LANDING_BRANCH, VERIFIED_REF } = require("./lib/landing-refs.js");
const { isZeroSha, parseRefLines } = require("./lib/push-refs.js");
const {
	buildUnchecked,
	isModuleOnAtHead,
	runPrePushGate,
} = require("./lib/pre-push-gate.js");
const { writeFd } = require("./lib/write-fd.js");

const REFUSE = 2;
const LANDING = `refs/heads/${LANDING_BRANCH}`;
/* A session's queue ref, `queue/<worktree name>`, as lib/branch-publish.js
 * reads one. */
const QUEUE = "refs/heads/queue/";
const CHECK = path.join(__dirname, "check-guard-registry.js");

const unchecked = buildUnchecked(
	"landing-registry-gate",
	`guard-registry rows on ${LANDING_BRANCH} or main`,
);

/**
 * @typedef {{ sha: string, ref: string, tip: string | null }} JudgedPush
 *   `ref` the pushed branch; `tip` the remote sha it is judged against, null
 *   for `origin/main`'s
 */

/**
 * Each push the gate judges: one to `landing`, against its remote tip, and
 * one to a queue ref, against `main`'s, `tip` then null.
 * @param {string} stdin
 * @returns {JudgedPush[]}
 */
function parseJudgedPushes(stdin) {
	return parseRefLines(stdin).flatMap(({ sha, remoteRef, remoteSha }) => {
		/** @type {JudgedPush[]} */
		const none = [];
		if (isZeroSha(sha)) return none;
		if (remoteRef === LANDING && remoteSha)
			return [{ sha, ref: LANDING_BRANCH, tip: remoteSha }];
		if (remoteRef?.startsWith(QUEUE) && remoteRef.length > QUEUE.length)
			return [{ sha, ref: remoteRef.slice("refs/heads/".length), tip: null }];
		return none;
	});
}

/**
 * `origin/main`'s sha in `tree`, or null where the clone holds none.
 * @param {string} tree
 * @returns {string | null}
 */
function readMainTip(tree) {
	return (
		gitOrNull(["rev-parse", "--verify", "-q", `${VERIFIED_REF}^{commit}`], {
			cwd: tree,
		})?.trim() || null
	);
}

/**
 * The tip `push` is judged against, or null, printed, where there is none.
 * @param {JudgedPush} push
 * @param {string} tree the pushing tree
 * @returns {string | null}
 */
function judgedTip({ ref, tip }, tree) {
	if (tip === null) {
		const main = readMainTip(tree);
		if (main === null)
			unchecked(`this clone holds no ${VERIFIED_REF} to judge ${ref} against`);
		return main;
	}
	if (!isZeroSha(tip)) return tip;
	unchecked(
		`this push creates ${LANDING_BRANCH}, so it has no tip to compare against`,
	);
	return null;
}

/**
 * One push's verdict: REFUSE where its tree adds a fault the tip lacks.
 * @param {JudgedPush} push
 * @param {string} tree the pushing tree
 * @returns {number}
 */
function judgeOne(push, tree) {
	const { sha } = push;
	const tip = judgedTip(push, tree);
	if (tip === null) return 0;
	const queued = push.tip === null;
	const r = spawnSync(
		process.execPath,
		[CHECK, "--against", tip, "--head", sha],
		{
			stdio: ["ignore", 2, 2],
			env: queued
				? process.env
				: buildRevertBaseEnv(tree, { onto: tip, head: sha }),
		},
	);
	if (r.status === 1) {
		writeFd(
			2,
			`pre-push: refused — ${sha} expires guard-registry row(s) on ${queued ? "main" : LANDING_BRANCH}'s tree at ${tip}, named above.\n`,
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
