#!/usr/bin/env node
/*
 * landing-registry-gate.js — the pre-push limb that judges a push to `landing`
 * on `landing`'s bytes (#3074, spec #2261): with the `landing` module on,
 * refuse a push whose pushed sha's tree holds a gating guard-registry fault,
 * an expired anchor among them, that `landing`'s current tip does not.
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
 * its clean revert, so the lander can reopen a held queue (#3127). Any other
 * fault still refuses.
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
const { LANDING_BRANCH } = require("./lib/landing-refs.js");
const { isZeroSha, parseRefLines } = require("./lib/push-refs.js");
const {
	buildUnchecked,
	isModuleOnAtHead,
	runPrePushGate,
} = require("./lib/pre-push-gate.js");
const { writeFd } = require("./lib/write-fd.js");

const REFUSE = 2;
const LANDING = `refs/heads/${LANDING_BRANCH}`;
const CHECK = path.join(__dirname, "check-guard-registry.js");

const unchecked = buildUnchecked(
	"landing-registry-gate",
	`guard-registry rows on ${LANDING_BRANCH}`,
);

/**
 * @param {string} stdin
 * @returns {{ sha: string, tip: string }[]}
 */
function parseLandingPushes(stdin) {
	return parseRefLines(stdin).flatMap(({ sha, remoteRef, remoteSha }) =>
		remoteRef === LANDING && remoteSha && !isZeroSha(sha)
			? [{ sha, tip: remoteSha }]
			: [],
	);
}

/**
 * @param {string} stdin
 * @param {string} tree the pushing tree
 * @returns {number}
 */
function judge(stdin, tree) {
	const pushes = parseLandingPushes(stdin);
	if (pushes.length === 0) return 0;
	if (!isModuleOnAtHead("landing", tree, unchecked)) return 0;
	let verdict = 0;
	for (const { sha, tip } of pushes) {
		if (isZeroSha(tip)) {
			unchecked(
				`this push creates ${LANDING_BRANCH}, so it has no tip to compare against`,
			);
			continue;
		}
		const r = spawnSync(
			process.execPath,
			[CHECK, "--against", tip, "--head", sha],
			{ stdio: ["ignore", 2, 2] },
		);
		if (r.status === 1) {
			writeFd(
				2,
				`pre-push: refused — ${sha} expires guard-registry row(s) on ${LANDING_BRANCH}'s tree at ${tip}, named above.\n`,
			);
			verdict = REFUSE;
		} else if (r.status !== 0)
			unchecked(
				`the checker could not judge ${sha} against ${tip} (${r.error?.message ?? `exit ${r.status}`})`,
			);
	}
	return verdict;
}

process.exitCode = runPrePushGate(unchecked, judge);
