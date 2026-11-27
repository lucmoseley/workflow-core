#!/usr/bin/env node
// cli-args-exempt: workflow-core#5540
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

const unchecked = buildUnchecked(
	"public-push-gate",
	"tracker history in the push",
);

/** @param {string} stdin */
const parsePushedShas = (stdin) =>
	parseRefLines(stdin)
		.map(({ sha }) => sha)
		.filter((sha) => !isZeroSha(sha));

/** @param {string[]} remotes */
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

/** @param {string[]} lines */
function refuse(lines) {
	writeFd(2, [...lines, ""].join("\n"));
	return REFUSE;
}

/**
 * @param {string[]} remotes
 * @param {string} tracker
 * @param {string} url
 */
function refuseUnfetched(remotes, tracker, url) {
	return refuse([
		`pre-push: refused — this pushes to ${url}, not the tracker ${tracker}, and no fetched remote here holds the tracker's history to tell it apart (workflow-core#1954).`,
		`Fetch it and push again: ${fetchTrackerCommand(remotes, tracker)}`,
	]);
}

/**
 * @param {string} stdin
 * @param {string} url
 * @param {string} tree
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
		// `git for-each-ref` with no pattern lists every ref:
		// https://git-scm.com/docs/git-for-each-ref
		const refs = remotes.length === 0 ? [] : readRefsOf(remotes);
		if (refs.length === 0) return refuseUnfetched(remotes, tracker, url);
		leaking = shas.filter((sha) => hasSharedHistory(sha, refs));
	} catch (e) {
		return refuse([
			`pre-push: refused — this pushes to ${url}, not the tracker ${tracker}, and git could not say whether it carries the tracker's history (${caught(e).message}).`,
			"Fix the git fault and push again; a push off the tracker is never let through unjudged (workflow-core#1954).",
		]);
	}
	if (leaking.length === 0) return 0;
	return refuse([
		`pre-push: refused — ${leaking.join(", ")} shares history with the private tracker ${tracker}, and pushing it to ${url} would publish that history (workflow-core#1954).`,
		"Rebuild the work on the public repo's main: git fetch origin && git rebase --onto origin/main <base> <branch>, where <base> is the tracker commit the work started from.",
	]);
}

process.exitCode = runPrePushGate(unchecked, (stdin, tree) =>
	judge(stdin, process.argv[2] ?? "", tree),
);
