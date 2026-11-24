const { execGit, GIT_TIMEOUT_MS } = require("./git.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { commitSha } = require("./commit-sha.js");
const { readGitFileCommonDir } = require("./git-file.js");
const {
	REMOTE,
	trackingRefspec,
	VERIFIED_BRANCH,
	VERIFIED_REF,
} = require("./landing-refs.js");

// guess, workflow-core#2361
const SHA_SHOWN = 9;
// guess, workflow-core#2361
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

/** @param {unknown} err */
function whyOf(err) {
	const e = caught(err);
	const text = (e.stderr ?? "").trim() || e.message;
	const lines = text.split("\n").filter((l) => l.trim());
	return (lines.find((l) => /^\S*Error\b/.test(l)) ?? lines.pop() ?? "").trim();
}

/** @param {string} dir */
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

/** @param {string} repo */
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

/** @param {string} repo */
const readVerifiedSha = (repo) => commitSha(repo, VERIFIED_REF);

/**
 * @param {string} dir
 * @param {string} program
 */
function isWholeWorktree(dir, program) {
	if (!fs.existsSync(path.join(dir, program))) return false;
	try {
		return fs.existsSync(
			path.resolve(dir, git(dir, ["rev-parse", "--git-path", "index"])),
		);
	} catch {
		return false;
	}
}

const SHA_NAME = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** @param {Array<string|null>} keep */
const keptNames = (keep) =>
	new Set(keep.filter((k) => k !== null).map((k) => path.basename(k)));

/**
 * @param {{codeDir: string, program: string}} instance
 * @param {Array<string|null>|null} keep
 */
function readSpare({ codeDir, program }, keep) {
	if (keep === null) return null;
	const kept = keptNames(keep);
	let names;
	try {
		names = fs.readdirSync(codeDir).sort();
	} catch {
		return null;
	}
	const name = names.find(
		(n) =>
			SHA_NAME.test(n) &&
			!kept.has(n) &&
			isWholeWorktree(path.join(codeDir, n), program),
	);
	return name === undefined ? null : path.join(codeDir, name);
}

/**
 * @param {string} repo
 * @param {string} spare
 * @param {string} dir
 * @param {string} sha
 * @returns {string|null}
 */
function checkoutInPlace(repo, spare, dir, sha) {
	const staging = `${dir}.${process.pid}`;
	try {
		git(repo, ["worktree", "move", spare, staging]);
	} catch (err) {
		return `the spare would not move: ${whyOf(err)}`;
	}
	try {
		git(staging, ["checkout", "--quiet", "--force", "--detach", sha]);
		git(staging, ["clean", "--quiet", "-ffdx"]);
		git(repo, ["worktree", "move", staging, dir]);
		return null;
	} catch (err) {
		removeWorktree(repo, staging);
		return `checking out in the spare failed: ${whyOf(err)}`;
	}
}

/**
 * @param {{repo: string, codeDir: string, program: string, log: (line: string) => void}} instance
 * @param {string} sha
 * @param {Array<string|null>|null} keep
 */
function worktreeAt(instance, sha, keep) {
	const { repo, codeDir, program, log } = instance;
	const dir = path.join(codeDir, sha);
	if (isWholeWorktree(dir, program)) return dir;
	fs.rmSync(dir, { recursive: true, force: true });
	const spare = readSpare(instance, keep);
	if (spare !== null) {
		const why = checkoutInPlace(repo, spare, dir, sha);
		if (why === null) return dir;
		log(`${short(sha)} checked out fresh, ${why}`);
	}
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
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * @param {string} dir
 * @param {string} sha
 */
function reregister(dir, sha) {
	const common = readGitFileCommonDir(dir);
	if (common === null) throw new Error(`${dir}/.git names no common dir`);
	const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reregister-"));
	const standIn = path.join(scratch, path.basename(dir));
	try {
		git(common, ["worktree", "add", "--no-checkout", "--detach", standIn, sha]);
		try {
			const text = fs.readFileSync(path.join(standIn, ".git"), "utf8");
			writeFileAtomic(path.join(dir, ".git"), text);
			git(common, ["worktree", "repair", dir]);
		} catch (err) {
			removeWorktree(common, standIn);
			throw err;
		}
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
	git(dir, ["reset", "--quiet"]);
}

/**
 * @param {string} codeDir
 * @param {string} name
 */
const linkOf = (codeDir, name) => `${codeDir}.${name}`;

/** @param {string} link */
function readLink(link) {
	try {
		return fs.readlinkSync(link);
	} catch {
		return null;
	}
}

/**
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
	keptNames,
	linkOf,
	pointLink,
	readLink,
	readVerifiedSha,
	removeWorktree,
	reregister,
	readSpare,
	short,
	whyOf,
	worktreeAt,
};
