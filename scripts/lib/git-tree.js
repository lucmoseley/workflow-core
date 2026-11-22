const fs = require("node:fs");
const path = require("node:path");

const { caught } = require("./caught.js");
const { trimEndRun } = require("./trim-run.js");
const {
	execGit,
	gitCommonDirOrThrow,
	HOOK_GIT_TIMEOUT_MS,
} = require("./git.js");

/**
 * @typedef {object} GitOutcome
 * @property {string | null} out
 * @property {string} stdout
 * @property {boolean} timedOut
 */

/** @type {Map<string, GitOutcome>} */
const memo = new Map();

/**
 * @param {string} key
 * @param {() => string} read
 * @returns {GitOutcome}
 */
function remembered(key, read) {
	const hit = memo.get(key);
	if (hit) return hit;
	/** @type {GitOutcome} */
	let outcome;
	try {
		const stdout = read();
		outcome = { out: trimEndRun(stdout, "\n"), stdout, timedOut: false };
	} catch (e) {
		const err = caught(e);
		outcome = {
			out: null,
			stdout: err.stdout ?? "",
			timedOut: err.code === "ETIMEDOUT",
		};
	}
	memo.set(key, outcome);
	return outcome;
}

/**
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {GitOutcome}
 */
const git = (args, timeoutMs) =>
	remembered(args.join("\0"), () =>
		execGit(args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: timeoutMs,
		}),
	);

/**
 * @param {string} p
 * @returns {string}
 */
function canon(p) {
	if (!p) return "";
	try {
		return fs.realpathSync(path.resolve(p));
	} catch {
		return "";
	}
}

/** @param {string} dir */
function isInsideAnyRepo(dir) {
	let p = canon(dir);
	if (!p) return true;
	while (p.length > 1) {
		if (fs.existsSync(`${p}/.git`)) return true;
		p = p.slice(0, p.lastIndexOf("/"));
	}
	return fs.existsSync("/.git");
}

/** @typedef {"shared" | "linked" | "other" | "unknown"} TreeClass */

/**
 * @param {string} root
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {(dir: string) => TreeClass}
 */
function treeClassifier(root, { timeoutMs = HOOK_GIT_TIMEOUT_MS } = {}) {
	if (!root)
		throw new Error(
			"the repo root did not resolve — command allowed unchecked",
		);
	const found = commonDir(root, timeoutMs).out;
	if (found === null)
		throw new Error(
			`git could not resolve a git dir for ${root} — command allowed unchecked`,
		);
	const project = canon(found);
	if (!project)
		throw new Error(`empty git dir for ${root} — command allowed unchecked`);
	return (dir) => classify(dir, project, timeoutMs);
}

/**
 * @param {string} dir
 * @param {number} timeoutMs
 */
const commonDir = (dir, timeoutMs) =>
	remembered(`common-dir\0${dir}`, () =>
		gitCommonDirOrThrow(dir, {
			stdio: ["ignore", "pipe", "ignore"],
			timeout: timeoutMs,
		}),
	);

/**
 * @param {string} dir
 * @param {string} project
 * @param {number} timeoutMs
 * @returns {TreeClass}
 */
function classify(dir, project, timeoutMs) {
	if (!dir) return "unknown";
	if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory())
		return "other";
	const common = commonDir(dir, timeoutMs);
	if (common.out === null) {
		if (common.timedOut) return "unknown";
		return isInsideAnyRepo(dir) ? "unknown" : "other";
	}
	const gitdir = readGitDir(dir, { timeoutMs });
	if (gitdir === null) return "unknown";
	const c = canon(common.out);
	const g = canon(gitdir);
	if (!c || !g) return "unknown";
	if (c !== project) return "other";
	return g === c ? "shared" : "linked";
}

/**
 * @param {string} tree
 * @param {string} src
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {string}
 */
const readSymbolicName = (
	tree,
	src,
	{ timeoutMs = HOOK_GIT_TIMEOUT_MS } = {},
) =>
	git(["-C", tree, "rev-parse", "--symbolic-full-name", src], timeoutMs).out ??
	"";

/**
 * @param {string} dir
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {string | null}
 */
const readTopLevel = (dir, { timeoutMs = HOOK_GIT_TIMEOUT_MS } = {}) =>
	git(["-C", dir, "rev-parse", "--show-toplevel"], timeoutMs).out;

/**
 * @param {string} dir
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {string | null}
 */
const readGitDir = (dir, { timeoutMs = HOOK_GIT_TIMEOUT_MS } = {}) =>
	git(
		["-C", dir, "rev-parse", "--path-format=absolute", "--git-dir"],
		timeoutMs,
	).out;

/**
 * @param {string} dir
 * @param {string} file
 * @param {{ timeoutMs?: number }} [opts]
 * @returns {string[] | null}
 */
function patchFiles(dir, file, { timeoutMs = HOOK_GIT_TIMEOUT_MS } = {}) {
	const abs = file.startsWith("/") ? file : `${dir}/${file}`;
	const top = readTopLevel(dir, { timeoutMs });
	if (top === null || !isReadable(abs)) return null;
	const applied = git(
		["-C", top, "apply", "--numstat", "-z", "--unidiff-zero", abs],
		timeoutMs,
	);
	if (applied.timedOut) return null;
	const fields = applied.stdout.split("\0");
	if (fields.at(-1) === "") fields.pop();
	if (fields.length === 0) return null;
	return fields.map((f) => `${top}/${f.replace(/^[^\t]*\t[^\t]*\t/, "")}`);
}

/** @param {string} p */
function isReadable(p) {
	try {
		fs.accessSync(p, fs.constants.R_OK);
		return true;
	} catch {
		return false;
	}
}

module.exports = {
	isInsideAnyRepo,
	treeClassifier,
	readSymbolicName,
	readTopLevel,
	readGitDir,
	patchFiles,
};
