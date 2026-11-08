/*
 * pinned-code.js — code run from a detached worktree per sha of the verified
 * ref (lib/landing-refs.js's VERIFIED_REF), never from a working copy a
 * session can edit (workflow-core#2361, workflow-core#4203). Two instances: the refill loop's
 * (lib/refill-code.js) and the guard hooks' (lib/guard-code.js).
 *
 * AN INSTANCE is a code directory holding one worktree per sha, and links
 * beside it — `<codeDir>.current`, and the guards' `<codeDir>.previous` — each
 * moved in one rename.
 *
 * Every git call runs from `repo`, any worktree of the checkout: they share
 * refs, so a fetch from one is read from all.
 */

const { execGit, GIT_TIMEOUT_MS } = require("./git.js");
const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { commitSha } = require("./commit-sha.js");
const {
	REMOTE,
	trackingRefspec,
	VERIFIED_BRANCH,
	VERIFIED_REF,
} = require("./landing-refs.js");

/* Untraced: git log --oneline's width in this repo, unique across its
 * history, so a logged sha can be pasted into git as it is. */
const SHA_SHOWN = 9;
/* Untraced: a fetch over a slow link, and a cold node start requiring a
 * program's libs at the machine's worst load. */
const FETCH_TIMEOUT_MS = 120 * 1000;
const LOAD_TIMEOUT_MS = 60 * 1000;

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {number} [timeout]
 */
const git = (cwd, args, timeout = GIT_TIMEOUT_MS) =>
	execGit(args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout,
	}).trim();

/** @param {string} sha */
const short = (sha) => sha.slice(0, SHA_SHOWN);

/**
 * A failure's one telling line: an Error line in its stderr, else its last.
 * @param {unknown} err
 */
function whyOf(err) {
	const e = caught(err);
	const text = (e.stderr ?? "").trim() || e.message;
	const lines = text.split("\n").filter((l) => l.trim());
	return (lines.find((l) => /^\S*Error\b/.test(l)) ?? lines.pop() ?? "").trim();
}

/**
 * `dir` where it sits in a git checkout; else null, a plugin install. Not
 * hostRoot(): the checkout asked about is the code's, never the host's.
 * @param {string} dir
 * @throws where git itself fails, which is no answer either way
 */
function checkoutOf(dir) {
	try {
		return git(dir, ["rev-parse", "--is-inside-work-tree"]) === "true"
			? dir
			: null;
	} catch (err) {
		if (/not a git repository/.test(caught(err).stderr ?? "")) return null;
		throw err;
	}
}

/**
 * Fetch the verified ref into `repo`: null, or why it failed. FETCH_HEAD is
 * left alone, being shared with every session in the checkout.
 * @param {string} repo
 */
function fetchVerified(repo) {
	try {
		git(
			repo,
			[
				"fetch",
				"--quiet",
				"--no-tags",
				"--no-write-fetch-head",
				REMOTE,
				trackingRefspec(VERIFIED_BRANCH),
			],
			FETCH_TIMEOUT_MS,
		);
		return null;
	} catch (err) {
		return whyOf(err);
	}
}

/**
 * The verified ref's sha as `repo` last fetched it, or null.
 * @param {string} repo
 */
const readVerifiedSha = (repo) => commitSha(repo, VERIFIED_REF);

/**
 * Whether `git worktree add` finished at `dir`: it writes the index only after
 * every file, so a kill mid-checkout leaves none.
 * @param {string} dir
 * @param {string} program the instance's program, relative to a worktree
 */
function isWholeWorktree(dir, program) {
	if (!fs.existsSync(path.join(dir, program))) return false;
	try {
		return fs.existsSync(
			path.resolve(dir, git(dir, ["rev-parse", "--git-path", "index"])),
		);
	} catch {
		// A directory git no longer reads as a worktree: not whole.
		return false;
	}
}

/**
 * The worktree at `sha` in `codeDir`, checked out where it is not yet.
 * @param {{repo: string, codeDir: string, program: string}} instance
 * @param {string} sha
 */
function worktreeAt({ repo, codeDir, program }, sha) {
	const dir = path.join(codeDir, sha);
	if (isWholeWorktree(dir, program)) return dir;
	/* A checkout a kill cut short: --force takes over its registration. */
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(codeDir, { recursive: true });
	git(repo, ["worktree", "add", "--force", "--detach", dir, sha]);
	return dir;
}

/**
 * @param {string} repo
 * @param {string} dir
 */
function removeWorktree(repo, dir) {
	try {
		git(repo, ["worktree", "remove", "--force", dir]);
	} catch {
		/* A directory git no longer registers, or a half-made one: removed by
		 * hand, the registration left to the next `git worktree prune`. */
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * @param {string} codeDir
 * @param {string} name
 */
const linkOf = (codeDir, name) => `${codeDir}.${name}`;

/**
 * The worktree `link` names, or null where there is no link.
 * @param {string} link
 */
function readLink(link) {
	try {
		return fs.readlinkSync(link);
	} catch {
		return null;
	}
}

/**
 * Point `link` at `worktree`, in one rename, so nothing sees it absent.
 * @param {string} link
 * @param {string} worktree
 */
function pointLink(link, worktree) {
	const tmp = `${link}.${process.pid}`;
	fs.rmSync(tmp, { force: true });
	fs.symlinkSync(worktree, tmp);
	fs.renameSync(tmp, link);
}

module.exports = {
	FETCH_TIMEOUT_MS,
	LOAD_TIMEOUT_MS,
	SHA_SHOWN,
	checkoutOf,
	fetchVerified,
	git,
	linkOf,
	pointLink,
	readLink,
	readVerifiedSha,
	removeWorktree,
	short,
	whyOf,
	worktreeAt,
};
