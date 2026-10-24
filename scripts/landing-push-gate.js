#!/usr/bin/env node
/*
 * landing-push-gate.js — the pre-push limb of the landing queue (workflow-core#2409, spec
 * workflow-core#2261): with the `landing` module on, refuse a push whose destination is
 * `main` unless the pushed sha is in the lander's green ledger. The lander ledgers a sha before it pushes it, so its own
 * push passes.
 *
 * git feeds `<local ref> <local sha> <remote ref> <remote sha>` per ref on
 * stdin. A deletion of `main` pushes the all-zero sha, which no ledger holds,
 * so it is refused too.
 *
 * LIMIT: `git push --no-verify` skips every pre-push hook, this one included,
 * and nothing local can refuse it; branch protection on the remote is the gate
 * that binds (workflow-core#2414).
 *
 * IN NO `scripts/` FAMILY (code-standards §N3), as run-mod-tests.js: 2
 * refuses and every other path exits 0. A fault it cannot judge through lets
 * the push through, printed, since a refusal there would refuse every push for
 * a fault that is not the push's. The same config fault opens the publish
 * guard's landing limb, logged there, so branch protection (workflow-core#2414) is then the
 * one gate left.
 */

const fs = require("node:fs");
const { moduleOn } = require("./lib/workflow-core-config.js");
const {
	LANDING_BRANCH,
	REMOTE,
	VERIFIED_BRANCH,
} = require("./lib/landing-refs.js");
const { fileLedger, landerFiles } = require("./lib/lander.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const { caught } = require("./lib/caught.js");
const { writeFd } = require("./lib/write-fd.js");

const REFUSE = 2;
const MAIN = `refs/heads/${VERIFIED_BRANCH}`;

/**
 * Printed where a fault stops the judgement, and the push goes through (workflow-core#2409).
 * @param {string} why
 */
const unchecked = (why) =>
	writeFd(2, `landing-push-gate: ${why} — push to main not checked.\n`);

/**
 * The local shas the ref list pushes to `main`, a deletion's zeros included.
 * @param {string} stdin
 */
function mainPushes(stdin) {
	return stdin.split("\n").flatMap((line) => {
		const [, sha, remoteRef] = line.trim().split(/\s+/);
		return remoteRef === MAIN && sha !== undefined ? [sha] : [];
	});
}

/**
 * @param {string} stdin
 * @param {string} root the canonical checkout
 * @returns {number}
 */
function judge(stdin, root) {
	const pushes = mainPushes(stdin);
	if (pushes.length === 0) return 0;
	let on;
	try {
		on = moduleOn("landing", { root });
	} catch (e) {
		unchecked(
			`could not read the landing module's state (${caught(e).message})`,
		);
		return 0;
	}
	if (!on) return 0;
	const ledger = fileLedger(landerFiles(root).ledger);
	const unledgered = pushes.filter((sha) => !ledger.has(sha));
	if (unledgered.length === 0) return 0;
	writeFd(
		2,
		[
			`pre-push: refused — this pushes ${unledgered.join(", ")} to ${VERIFIED_BRANCH}, which the lander's green ledger does not hold.`,
			`With the landing module on, only the lander moves ${VERIFIED_BRANCH}, to a sha the full suite passed (workflow-core#2261).`,
			`Push to ${LANDING_BRANCH} instead: git push ${REMOTE} ${VERIFIED_BRANCH}:${LANDING_BRANCH} from the shared tree, or HEAD:${LANDING_BRANCH} from a worktree.`,
			"",
		].join("\n"),
	);
	return REFUSE;
}

function main() {
	const root = repoRoot();
	if (root === null) {
		unchecked("could not find the repository root");
		return 0;
	}
	let stdin = "";
	try {
		stdin = fs.readFileSync(0, "utf8");
	} catch (e) {
		unchecked(`could not read the pushed refs (${caught(e).message})`);
		return 0;
	}
	return judge(stdin, root);
}

process.exitCode = main();
