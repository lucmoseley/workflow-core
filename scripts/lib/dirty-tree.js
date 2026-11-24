const {
	execProgram,
	gitBinary,
	gitSpawnOptions,
	GIT_TIMEOUT_MS,
	BOTH_DIRS_ARGS,
	parseGitDirs,
} = require("./git.js");

/** @typedef {(file: string, args: string[], options: object) => string | Buffer} ExecFn */

// guess, lucmoseley/mantahostels#2231
const REFUSAL_NAMED_MAX = 10;

/**
 * @param {string[]} args
 * @param {string} root
 * @param {ExecFn} [execFn]
 * @param {string|null} [input]
 * @returns {string|null}
 */
function gitRead(args, root, execFn = execProgram, input = null) {
	try {
		return String(
			execFn(
				gitBinary(),
				args,
				gitSpawnOptions({
					cwd: root,
					encoding: "utf8",
					input: input ?? undefined,
					stdio: [input === null ? "ignore" : "pipe", "pipe", "ignore"],
					timeout: GIT_TIMEOUT_MS,
				}),
			) ?? "",
		);
	} catch {
		return null;
	}
}

/**
 * @param {string} out
 * @returns {Generator<{xy: string, path: string, source: string|null, renamed: boolean}>}
 */
function* porcelainEntries(out) {
	const fields = out.split("\0").values();
	for (const entry of fields) {
		if (entry.length < 4) continue;
		const xy = entry.slice(0, 2);
		const renamed = xy.includes("R");
		const source =
			renamed || xy.includes("C") ? fields.next().value || null : null;
		yield { xy, path: entry.slice(3), source, renamed };
	}
}

/**
 * @param {string} root
 * @param {ExecFn} [execFn]
 * @returns {string[]|null}
 */
function readDirtyTracked(root, execFn = execProgram) {
	return readTrackedStatus(root, execFn)?.dirty ?? null;
}

/**
 * @param {string} root
 * @param {ExecFn} [execFn]
 * @returns {{ dirty: string[], renames: { path: string, source: string }[] }|null}
 */
function readTrackedStatus(root, execFn = execProgram) {
	const out = gitRead(TRACKED_STATUS, root, execFn);
	return out === null ? null : parseTrackedStatus(out);
}

const TRACKED_STATUS = ["status", "--porcelain", "-z", "-uno"];

/**
 * @param {string} out
 * @returns {{ dirty: string[], renames: { path: string, source: string }[] }}
 */
function parseTrackedStatus(out) {
	/** @type {string[]} */
	const paths = [];
	/** @type {{ path: string, source: string }[]} */
	const renames = [];
	for (const { path: p, source, renamed } of porcelainEntries(out)) {
		paths.push(p);
		if (source === null) continue;
		paths.push(source);
		if (renamed) renames.push({ path: p, source });
	}
	return { dirty: [...new Set(paths)].sort(), renames };
}

/**
 * @param {string} root
 * @param {ExecFn} [execFn]
 * @returns {string[]|null}
 */
function readUntrackedFiles(root, execFn = execProgram) {
	const out = gitRead(
		["ls-files", "--others", "--exclude-standard", "-z"],
		root,
		execFn,
	);
	if (out === null) return null;
	return out.split("\0").filter(Boolean).sort();
}

/**
 * @param {string} root
 * @returns {string[]|null}
 */
function readUntrackedEntries(root) {
	const out = gitRead(["status", "--porcelain", "-z"], root);
	if (out === null) return null;
	/** @type {string[]} */
	const paths = [];
	for (const { xy, path: p } of porcelainEntries(out))
		if (xy === "??") paths.push(p);
	return paths.sort();
}

/**
 * @param {string} root
 * @param {ExecFn} [execFn]
 * @returns {boolean}
 */
function isLinkedWorktree(root, execFn = execProgram) {
	const dirs = parseGitDirs(gitRead(BOTH_DIRS_ARGS, root, execFn));
	return Boolean(dirs && dirs.gitDir !== dirs.common);
}

module.exports = {
	isLinkedWorktree,
	porcelainEntries,
	REFUSAL_NAMED_MAX,
	readDirtyTracked,
	parseTrackedStatus,
	TRACKED_STATUS,
	gitRead,
	readTrackedStatus,
	readUntrackedEntries,
	readUntrackedFiles,
};
