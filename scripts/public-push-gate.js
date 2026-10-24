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

const fs = require("node:fs");
const { execFileSync, spawnSync } = require("node:child_process");
const {
	parseGithubRemote,
	resolveKey,
} = require("./lib/workflow-core-config.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const { caught } = require("./lib/caught.js");
const { writeFd } = require("./lib/write-fd.js");

const REFUSE = 2;
const ZERO = /^0+$/;

/**
 * Printed where a fault stops the judgement before the gate knows the code
 * repo is apart, and the push goes through (#1954).
 * @param {string} why
 */
const unchecked = (why) =>
	writeFd(
		2,
		`public-push-gate: ${why} — push not checked for tracker history.\n`,
	);

/**
 * Whether a url names `repo`, owner/name compared as GitHub does, ignoring
 * case.
 * @param {string} url
 * @param {string} repo owner/name
 */
const names = (url, repo) =>
	parseGithubRemote(url)?.toLowerCase() === repo.toLowerCase();

/**
 * The local shas the ref list pushes, deletions left out.
 * @param {string} stdin
 */
function pushedShas(stdin) {
	return stdin.split("\n").flatMap((line) => {
		const [, sha] = line.trim().split(/\s+/);
		return sha !== undefined && !ZERO.test(sha) ? [sha] : [];
	});
}

/**
 * The remotes whose url names the tracker.
 * @param {string} tracker owner/name
 */
function trackerRemotes(tracker) {
	// Exit 1 where no remote has a url at all: no tracker remote either.
	const out = spawnSync(
		"git",
		["config", "--get-regexp", "^remote\\..*\\.url$"],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
	).stdout;
	return out.split("\n").flatMap((line) => {
		const [key, url] = line.split(/\s+/);
		return key !== undefined && url !== undefined && names(url, tracker)
			? [key.slice("remote.".length, -".url".length)]
			: [];
	});
}

/**
 * Every remote-tracking ref of `remotes`. Throws where git cannot list them.
 * @param {string[]} remotes
 */
const refsOf = (remotes) =>
	execFileSync(
		"git",
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
	const { status } = spawnSync(
		"git",
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
	const remedy =
		remotes.length === 0
			? `git remote add archive https://github.com/${tracker}.git && git fetch archive`
			: `git fetch ${remotes[0]}`;
	return refuse([
		`pre-push: refused — this pushes to ${url}, not the tracker ${tracker}, and no fetched remote here holds the tracker's history to tell it apart (#1954).`,
		`Fetch it and push again: ${remedy}`,
	]);
}

/**
 * @param {string} stdin
 * @param {string} url the remote's url, as git hands it to the hook
 * @param {string} root the canonical checkout
 * @returns {number}
 */
function judge(stdin, url, root) {
	let codeRepo;
	let tracker;
	try {
		codeRepo = resolveKey("codeRepo", { root });
		tracker = resolveKey("tracker", { root });
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
	const shas = pushedShas(stdin);
	if (shas.length === 0) return 0;
	let leaking;
	try {
		const remotes = trackerRemotes(tracker);
		// for-each-ref given no pattern lists every ref, not none.
		const refs = remotes.length === 0 ? [] : refsOf(remotes);
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
	return judge(stdin, process.argv[2] ?? "", root);
}

process.exitCode = main();
