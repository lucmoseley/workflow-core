#!/usr/bin/env node
/*
 * landing-push-gate.js — the pre-push limb of the landing queue (#2409, spec
 * #2261): with the `landing` module on, refuse a push whose destination is
 * `main` unless the pushed sha is in the lander's green ledger. The lander
 * ledgers a sha before it pushes it, so its own push passes.
 *
 * git feeds `<local ref> <local sha> <remote ref> <remote sha>` per ref on
 * stdin. A deletion of `main` pushes the all-zero sha, which no ledger holds,
 * so it is refused too.
 *
 * A sha whose tree is a ledgered sha's tree passes: the suite tested that
 * tree (#1954).
 *
 * LIMIT: `git push --no-verify` skips every pre-push hook, this one included;
 * branch protection on the remote is the gate that binds (#2414).
 *
 * The module config is read as committed at the pushing tree's HEAD, and the
 * ledger from the canonical checkout: the shared checkout's working copy of
 * the config holds neighbours' half-written edits, one of which could turn the
 * module off for every push (#3128, #3132). LIMIT: a push of a sha other than
 * HEAD (`git push origin other:main`) is judged on HEAD's config, not that
 * sha's.
 *
 * IN NO `scripts/` FAMILY (code-standards §N3), as run-mod-tests.js: 2
 * refuses and every other path exits 0. A fault it cannot judge through lets
 * the push through, printed, since a refusal there would refuse every push for
 * a fault that is not the push's. The same config fault opens the publish
 * guard's landing limb, logged there.
 */

const {
	LANDING_BRANCH,
	REMOTE,
	VERIFIED_BRANCH,
} = require("./lib/landing-refs.js");
const { fileLedger, landerFiles } = require("./lib/lander.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const { parseRefLines } = require("./lib/push-refs.js");
const {
	buildUnchecked,
	isModuleOnAtHead,
	runPrePushGate,
} = require("./lib/pre-push-gate.js");
const { writeFd } = require("./lib/write-fd.js");
const { spawnGitSync } = require("./lib/git.js");

const REFUSE = 2;
const MAIN = `refs/heads/${VERIFIED_BRANCH}`;

const unchecked = buildUnchecked("landing-push-gate", "push to main");

/**
 * The local shas the ref list pushes to `main`, a deletion's zeros included.
 * @param {string} stdin
 */
const parseMainPushes = (stdin) =>
	parseRefLines(stdin)
		.filter(({ remoteRef }) => remoteRef === MAIN)
		.map(({ sha }) => sha);

/**
 * Each sha's tree, in order; `null` for one git cannot resolve.
 * @param {string[]} shas
 * @returns {(string|null)[]}
 */
function readTreesOf(shas) {
	if (shas.length === 0) return [];
	const out = spawnGitSync(["cat-file", "--batch-check=%(objectname)"], {
		input: shas.map((sha) => `${sha}^{tree}\n`).join(""),
		encoding: "utf8",
	});
	const lines = out.status === 0 ? out.stdout.split("\n") : [];
	return shas.map((_, i) => {
		const line = lines[i] ?? "";
		return /^[0-9a-f]{40,64}$/.test(line) ? line : null;
	});
}

/**
 * @param {string} stdin
 * @param {{ tree: string, root: string }} at the pushing tree, whose HEAD
 *   holds the config, and the canonical checkout, which holds the ledger
 * @returns {number}
 */
function judge(stdin, { tree, root }) {
	const pushes = parseMainPushes(stdin);
	if (pushes.length === 0) return 0;
	if (!isModuleOnAtHead("landing", tree, unchecked)) return 0;
	const ledger = fileLedger(landerFiles(root).ledger);
	const green = new Set(
		readTreesOf(ledger.readShas()).filter((t) => t !== null),
	);
	const pushed = readTreesOf(pushes);
	const untested = pushes.filter((sha, i) => {
		const pushedTree = pushed[i] ?? null;
		return !ledger.has(sha) && (pushedTree === null || !green.has(pushedTree));
	});
	if (untested.length === 0) return 0;
	writeFd(
		2,
		[
			`pre-push: refused — this pushes ${untested.join(", ")} to ${VERIFIED_BRANCH}, and the lander's green ledger holds neither it nor its tree.`,
			`With the landing module on, only the lander moves ${VERIFIED_BRANCH}, to a sha the full suite passed (#2261).`,
			`Push to ${LANDING_BRANCH} instead: git push ${REMOTE} ${VERIFIED_BRANCH}:${LANDING_BRANCH} from the shared tree, or HEAD:${LANDING_BRANCH} from a worktree.`,
			"",
		].join("\n"),
	);
	return REFUSE;
}

process.exitCode = runPrePushGate(unchecked, (stdin, tree) => {
	const root = repoRoot();
	if (root === null) {
		unchecked("could not find the repository root");
		return 0;
	}
	return judge(stdin, { tree, root });
});
