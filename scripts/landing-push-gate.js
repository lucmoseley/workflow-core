#!/usr/bin/env node
/*
 * landing-push-gate.js — the pre-push limb of the landing queue (#2409, spec
 * #2261, #4458): refuse a push whose destination is `main` unless the pushed sha is in the lander's green
 * ledger. The queue lander ledgers a sha before it pushes it, so its own push
 * passes.
 *
 * git feeds `<local ref> <local sha> <remote ref> <remote sha>` per ref on
 * stdin. A deletion of `main` pushes the all-zero sha, which no ledger holds,
 * so it is refused too. A push creating `main` on a remote that has none, its
 * remote sha all zeros, passes: it is a new repo's first push (#2412).
 *
 * A sha whose tree is a ledgered sha's tree passes: the suite tested that
 * tree (#1954).
 *
 * LIMIT: `git push --no-verify` skips every pre-push hook, this one included;
 * branch protection on the remote is the gate that binds (#2414).
 *
 * The ledger is read from the canonical checkout.
 *
 * IN NO `scripts/` FAMILY (code-standards §N3), as run-mod-tests.js: 2
 * refuses and every other path exits 0. A fault it cannot judge through lets
 * the push through, printed, since a refusal there would refuse every push for
 * a fault that is not the push's. One exception: a green ledger that exists
 * and will not read refuses, since only the lander pushes `main` and it
 * cannot land on a ledger it cannot read either (#4856).
 */

const { readText } = require("./lib/file-read.js");
const { VERIFIED_BRANCH } = require("./lib/landing-refs.js");
const { parseLedgerShas, queueLanderFiles } = require("./lib/lander-files.js");
const { scriptPath } = require("./lib/script-path.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const { isZeroSha, parseRefLines } = require("./lib/push-refs.js");
const { buildUnchecked, runPrePushGate } = require("./lib/pre-push-gate.js");
const { writeFd } = require("./lib/write-fd.js");
const { spawnGitSync } = require("./lib/git.js");

const REFUSE = 2;
const MAIN = `refs/heads/${VERIFIED_BRANCH}`;

const unchecked = buildUnchecked("landing-push-gate", "push to main");

/**
 * Whether the line creates `main` on a remote that has none.
 * @param {import("./lib/push-refs.js").RefLine} line
 */
const createsMain = ({ sha, remoteSha }) =>
	remoteSha !== undefined && isZeroSha(remoteSha) && !isZeroSha(sha);

/**
 * The local shas the ref list pushes to an existing `main`, a deletion's
 * zeros included.
 * @param {string} stdin
 */
const parseMainPushes = (stdin) =>
	parseRefLines(stdin)
		.filter((line) => line.remoteRef === MAIN && !createsMain(line))
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
 * @param {string} root the canonical checkout, which holds the ledger
 * @returns {number}
 */
function judge(stdin, root) {
	const pushes = parseMainPushes(stdin);
	if (pushes.length === 0) return 0;
	const file = queueLanderFiles(root).ledger;
	const ledger = readText(file);
	if (ledger.state === "unreadable") {
		/* Refused, not passed, as the header's exception (#4856). */
		writeFd(
			2,
			`pre-push: refused — the lander's green ledger ${file} will not read (${ledger.message}), so no push to ${VERIFIED_BRANCH} can be shown tested. Fix the file, then push again.\n`,
		);
		return REFUSE;
	}
	const ledgered = parseLedgerShas(ledger.state === "read" ? ledger.data : "");
	const held = new Set(ledgered);
	const green = new Set(readTreesOf(ledgered).filter((t) => t !== null));
	const pushed = readTreesOf(pushes);
	const untested = pushes.filter((sha, i) => {
		const pushedTree = pushed[i] ?? null;
		return !held.has(sha) && (pushedTree === null || !green.has(pushedTree));
	});
	if (untested.length === 0) return 0;
	writeFd(
		2,
		[
			`pre-push: refused — this pushes ${untested.join(", ")} to ${VERIFIED_BRANCH}, and the lander's green ledger holds neither it nor its tree.`,
			`Only the queue lander moves ${VERIFIED_BRANCH}, to a sha the full suite passed (#4458).`,
			`Push your session's queue ref instead, from its worktree: node ${scriptPath("session-checkout.js")} land`,
			"",
		].join("\n"),
	);
	return REFUSE;
}

process.exitCode = runPrePushGate(unchecked, (stdin) => {
	const root = repoRoot();
	if (root === null) {
		unchecked("could not find the repository root");
		return 0;
	}
	return judge(stdin, root);
});
