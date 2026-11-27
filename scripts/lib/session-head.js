const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { realKey } = require("./deref.js");
const { streamRecords } = require("./encoding-use");
const { isUnder } = require("./is-under.js");

/** @typedef {{firstTimestamp: string|null, cwd: string|null, entrypoint: string|null}} SessionHead */

/**
 * @param {string} file
 * @returns {SessionHead}
 */
function readSessionHead(file) {
	/** @type {SessionHead} */
	const out = { firstTimestamp: null, cwd: null, entrypoint: null };
	for (const r of streamRecords(file, "main")) {
		if (!out.firstTimestamp && typeof r.timestamp === "string")
			out.firstTimestamp = r.timestamp;
		if (!out.cwd && typeof r.cwd === "string") out.cwd = r.cwd;
		if (!out.entrypoint && typeof r.entrypoint === "string")
			out.entrypoint = r.entrypoint;
		if (out.firstTimestamp && out.cwd && out.entrypoint) break;
	}
	return out;
}

/** @param {string} cwd */
function repoRootOf(cwd) {
	const p = path.resolve(cwd);
	if (/\/\.claude[^/]*\/jobs\//.test(p)) return null;
	const tmp = os.tmpdir();
	if (isUnder(p, [tmp, realKey(tmp)], path.sep)) return null;
	if (/\/\.claude\/tmp(\/|$)/.test(p)) return null;
	const worktree = p.match(/^(.*)\/\.claude\/worktrees\/[^/]+/);
	if (worktree) return worktree[1];
	for (let at = p; ; at = path.dirname(at)) {
		if (fs.existsSync(path.join(at, ".git"))) return at;
		if (path.dirname(at) === at) return p;
	}
}

module.exports = { readSessionHead, repoRootOf };
