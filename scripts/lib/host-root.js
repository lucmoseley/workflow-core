const fs = require("node:fs");
const path = require("node:path");
const {
	execGit,
	gitCommonDir,
	gitCommonDirOrThrow,
	revParseWithCommonDirOrThrow,
} = require("./git.js");
const { caught, ignoreFailure, orFallback } = require("./caught.js");
const { deref } = require("./deref.js");
const { checkoutOfCommonDir } = require("./main-checkout.js");
const { writeFd } = require("./write-fd.js");

/**
 * @param {string} dir
 * @returns {string}
 */
function stripSlash(dir) {
	return dir.length > 1 && dir.endsWith("/") ? dir.slice(0, -1) : dir;
}

// lucmoseley/mantahostels#1775
let memo = { key: "", value: "" };
let declaredMemo = { key: "", value: "" };
let worktreeMemo = { key: "", value: "" };

/**
 * @param {string} cwd
 * @param {number} [timeoutMs]
 * @returns {string}
 */
function gitTopLevel(cwd, timeoutMs) {
	return deref(
		execGit(["rev-parse", "--show-toplevel"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: timeoutMs,
		}).trim(),
	);
}

/**
 * @param {string} cwd
 * @param {number} [timeoutMs]
 * @returns {string}
 */
function owningCheckout(cwd, timeoutMs) {
	const [top = "", common = ""] = revParseWithCommonDirOrThrow(
		cwd,
		["--show-toplevel"],
		{ timeout: timeoutMs },
	);
	return deref(checkoutOfCommonDir(common) ?? top);
}

/**
 * @param {string} [cwd]
 * @param {{ timeoutMs?: number, onTimeout?: () => void, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {string}
 */
function hostRoot(
	cwd = process.cwd(),
	{ timeoutMs, onTimeout, env = process.env } = {},
) {
	const declared = env.CLAUDE_PROJECT_DIR;
	if (declared)
		return declaredHost(deref(stripSlash(declared)), timeoutMs, onTimeout);
	if (memo.key === cwd) return memo.value;
	let value;
	try {
		value = owningCheckout(cwd, timeoutMs);
	} catch (e) {
		if (caught(e).code === "ETIMEDOUT") onTimeout?.();
		return deref(cwd);
	}
	memo = { key: cwd, value };
	return value;
}

/** @returns {string} */
function adoptHostRoot() {
	const root = hostRoot();
	if (process.env.CLAUDE_PROJECT_DIR || memo.key === process.cwd())
		process.env.CLAUDE_PROJECT_DIR = root;
	return root;
}

/**
 * @param {string} dir
 * @param {number} [timeoutMs]
 * @param {() => void} [onTimeout]
 * @returns {string}
 */
function declaredHost(dir, timeoutMs, onTimeout) {
	if (declaredMemo.key === dir) return declaredMemo.value;
	const linked = orFallback(
		() => fs.statSync(path.join(dir, ".git")).isFile(),
		false,
	);
	let value = dir;
	if (linked) {
		try {
			value = owningCheckout(dir, timeoutMs);
		} catch (e) {
			if (caught(e).code === "ETIMEDOUT") onTimeout?.();
			return dir;
		}
	}
	declaredMemo = { key: dir, value };
	return value;
}

/**
 * @param {{ cwd?: unknown }} input
 * @param {string} [fallback]
 * @returns {string}
 */
function sessionDir({ cwd }, fallback = process.cwd()) {
	return typeof cwd === "string" && cwd.startsWith("/") ? cwd : fallback;
}

/**
 * @param {{ cwd?: unknown }} input
 * @returns {string | null}
 */
function sessionTree(input) {
	try {
		return gitTopLevel(sessionDir(input));
	} catch {
		// workflow-core#4234
		return null;
	}
}

/**
 * @param {string} [cwd]
 * @param {{ host?: string, timeoutMs?: number, onTimeout?: () => void }} [opts]
 * @returns {string}
 */
function worktreeRoot(
	cwd = process.cwd(),
	{ host: given, timeoutMs, onTimeout } = {},
) {
	const key = JSON.stringify([cwd, given, process.env.CLAUDE_PROJECT_DIR]);
	if (worktreeMemo.key === key) return worktreeMemo.value;
	/** @param {string} value */
	const keep = (value) => {
		worktreeMemo = { key, value };
		return value;
	};
	if (!given && !process.env.CLAUDE_PROJECT_DIR) {
		try {
			return keep(gitTopLevel(cwd, timeoutMs));
		} catch (e) {
			if (caught(e).code === "ETIMEDOUT") onTimeout?.();
			return hostRoot(cwd, { timeoutMs });
		}
	}
	const host = given ? deref(stripSlash(given)) : hostRoot(cwd);
	try {
		const bound = { timeout: timeoutMs };
		const [rawTop = "", common = ""] = revParseWithCommonDirOrThrow(
			cwd,
			["--show-toplevel"],
			bound,
		);
		const top = deref(rawTop);
		if (top === host) return keep(host);
		return keep(common === gitCommonDirOrThrow(host, bound) ? top : host);
	} catch (e) {
		if (caught(e).code === "ETIMEDOUT") onTimeout?.();
		return host;
	}
}

/**
 * @param {string} [cwd]
 * @returns {string}
 */
function resolveCommitHost(cwd = process.cwd()) {
	const common = gitCommonDir(cwd);
	if (common === null) return hostRoot(cwd);
	const declared = process.env.CLAUDE_PROJECT_DIR;
	if (declared && gitCommonDir(declared) === common) return hostRoot(cwd);
	try {
		const gitDir = execGit(["rev-parse", "--absolute-git-dir"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		const owner = checkoutOfCommonDir(common);
		if (gitDir !== common && owner !== null) return deref(owner);
		return gitTopLevel(cwd);
	} catch (e) {
		const answer = deref(cwd);
		ignoreFailure(() =>
			writeFd(
				2,
				`host-root: git named no top level for ${answer}, so the commit host falls back to it, and a marker stored under it may be one the commit's hook never reads (${caught(e).message.split("\n")[0]}).\n`,
			),
		);
		return answer;
	}
}

module.exports = {
	adoptHostRoot,
	gitTopLevel,
	hostRoot,
	resolveCommitHost,
	sessionDir,
	sessionTree,
	worktreeRoot,
};
