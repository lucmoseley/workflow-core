#!/usr/bin/env node
/*
 * public-push-gate.js — the pre-push limb that keeps the tracker's history off
 * the public code repo (#1954). Where `codeRepo` differs from `tracker`, the
 * code repo was published as a fresh squashed root, and a push to it of any
 * commit that shares an ancestor with the tracker's history would publish all
 * of that history. So every push not bound for the tracker itself is refused
 * when a pushed sha has a common ancestor with any ref of a remote naming the
 * tracker. The destination is judged by what it is not: an exact match on the
 * code repo's url would let a case variant, a host alias or an ssh-over-443
 * url through.
 *
 * Replace objects are off for the test: the clones graft the squashed root
 * onto the tracker's old tip (`git replace --graft`) so `git log` reads past
 * the split, but git pushes the real parents, and only those can leak.
 *
 * `codeRepo` and `tracker` are read from the config at the pushing tree's
 * HEAD, as landing-push-gate.js reads the module config (#3128, #3132).
 *
 * cli-args-exempt: its one argument is the url git hands .husky/pre-push.
 *
 * LIMIT: `git push --no-verify` skips it, and nothing on the public repo can
 * refuse a push that carries the history.
 *
 * IN NO `scripts/` FAMILY (code-standards §N3), as landing-push-gate.js: 2
 * refuses and every other path exits 0. A fault that stops the gate learning
 * whether the code repo is apart from the tracker (no root, unreadable refs or
 * config) lets the push through, printed. Once it is apart, every fault
 * refuses, a clone with no fetched remote naming the tracker included: the
 * leak is one-way.
 */

const { resolveKey } = require("./lib/workflow-core-config.js");
const {
	names,
	readTrackerRemotes,
	fetchTrackerCommand,
} = require("./lib/tracker-remotes.js");
const { isZeroSha, parseRefLines } = require("./lib/push-refs.js");
const { buildUnchecked, runPrePushGate } = require("./lib/pre-push-gate.js");
const { caught } = require("./lib/caught.js");
const { writeFd } = require("./lib/write-fd.js");
const { execGit, spawnGitSync } = require("./lib/git.js");

const REFUSE = 2;

/**
 * Printed where a fault stops the judgement before the gate knows the code
 * repo is apart, and the push goes through (#1954).
 */
const unchecked = buildUnchecked(
	"public-push-gate",
	"tracker history in the push",
);

/**
 * The local shas the ref list pushes, deletions left out.
 * @param {string} stdin
 */
const parsePushedShas = (stdin) =>
	parseRefLines(stdin)
		.map(({ sha }) => sha)
		.filter((sha) => !isZeroSha(sha));

/**
 * Every remote-tracking ref of `remotes`. Throws where git cannot list them.
 * @param {string[]} remotes
 */
const readRefsOf = (remotes) =>
	execGit(
		[
			"for-each-ref",
			"--format=%(refname)",
			...remotes.map((r) => `refs/remotes/${r}/`),
		],
		{ encoding: "utf8" },
	)
		.split("\n")
		.filter(Boolean);

/**
 * Whether `sha` shares an ancestor with any of `refs`. merge-base exits 1
 * where there is none; any other failure (a bad object, no git) throws.
 * @param {string} sha
 * @param {string[]} refs
 */
function hasSharedHistory(sha, refs) {
	const { status } = spawnGitSync(
		["--no-replace-objects", "merge-base", sha, ...refs],
		{ stdio: "ignore" },
	);
	if (status === 0) return true;
	if (status === 1) return false;
	throw new Error(`git merge-base ${sha} exited ${status}`);
}

/**
 * Refuse, naming why and the way out.
 * @param {string[]} lines
 */
function refuse(lines) {
	writeFd(2, [...lines, ""].join("\n"));
	return REFUSE;
}

/**
 * The refusal where no tracker history is on hand to compare against.
 * @param {string[]} remotes the remotes naming the tracker, none fetched
 * @param {string} tracker
 * @param {string} url
 */
function refuseUnfetched(remotes, tracker, url) {
	return refuse([
		`pre-push: refused — this pushes to ${url}, not the tracker ${tracker}, and no fetched remote here holds the tracker's history to tell it apart (#1954).`,
		`Fetch it and push again: ${fetchTrackerCommand(remotes, tracker)}`,
	]);
}

/**
 * @param {string} stdin
 * @param {string} url the remote's url, as git hands it to the hook
 * @param {string} tree the pushing tree
 * @returns {number}
 */
function judge(stdin, url, tree) {
	let codeRepo;
	let tracker;
	try {
		codeRepo = resolveKey("codeRepo", { root: tree, rev: "HEAD" });
		tracker = resolveKey("tracker", { root: tree, rev: "HEAD" });
	} catch (e) {
		unchecked(
			`could not read the code repo and tracker (${caught(e).message})`,
		);
		return 0;
	}
	if (typeof codeRepo !== "string" || codeRepo === tracker) return 0;
	if (typeof tracker !== "string") {
		unchecked(`no tracker names the history to keep off ${codeRepo}`);
		return 0;
	}
	if (names(url, tracker)) return 0;
	const shas = parsePushedShas(stdin);
	if (shas.length === 0) return 0;
	let leaking;
	try {
		const remotes = readTrackerRemotes(tracker);
		// for-each-ref given no pattern lists every ref, not none.
		const refs = remotes.length === 0 ? [] : readRefsOf(remotes);
		if (refs.length === 0) return refuseUnfetched(remotes, tracker, url);
		leaking = shas.filter((sha) => hasSharedHistory(sha, refs));
	} catch (e) {
		return refuse([
			`pre-push: refused — this pushes to ${url}, not the tracker ${tracker}, and git could not say whether it carries the tracker's history (${caught(e).message}).`,
			"Fix the git fault and push again; a push off the tracker is never let through unjudged (#1954).",
		]);
	}
	if (leaking.length === 0) return 0;
	return refuse([
		`pre-push: refused — ${leaking.join(", ")} shares history with the private tracker ${tracker}, and pushing it to ${url} would publish that history (#1954).`,
		"Rebuild the work on the public repo's main: git fetch origin && git rebase --onto origin/main <base> <branch>, where <base> is the tracker commit the work started from.",
	]);
}

process.exitCode = runPrePushGate(unchecked, (stdin, tree) =>
	judge(stdin, process.argv[2] ?? "", tree),
);
