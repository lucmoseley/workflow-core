const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnGitSync } = require("./git.js");

const EXCLUDING_ATTRS = ["linguist-vendored", "linguist-generated"];

/**
 * @typedef {"worktree" | "index" | { rev: string }} AttributeSource
 * @typedef {{ from?: AttributeSource, timeout?: number, cwd?: string, env?: NodeJS.ProcessEnv }} AttributeRead
 */

/**
 * @param {string[]} paths
 * @param {AttributeRead} [read]
 * @returns {Set<string>}
 */
function readAttributeExcluded(
	paths,
	{ from = "worktree", timeout, cwd, env } = {},
) {
	if (paths.length === 0) return new Set();
	const opts = {
		encoding: /** @type {const} */ ("utf8"),
		...(timeout === undefined ? {} : { timeout }),
		...(cwd === undefined ? {} : { cwd }),
		...(env === undefined ? {} : { env }),
	};
	if (typeof from !== "object") return checkAttr(paths, from === "index", opts);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-attributes-"));
	try {
		const scratch = {
			...opts,
			env: { ...(env ?? process.env), GIT_INDEX_FILE: path.join(dir, "index") },
		};
		throwUnlessRan(
			spawnGitSync(["read-tree", from.rev], scratch),
			`read-tree ${from.rev}`,
		);
		return checkAttr(paths, true, scratch);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * @param {import("node:child_process").SpawnSyncReturns<string>} r
 * @param {string} what
 */
function throwUnlessRan(r, what) {
	if (r.error) throw new Error(`git ${what} failed: ${r.error.message}`);
	if (r.status !== 0) throw new Error(`git ${what} failed: ${r.stderr.trim()}`);
}

/**
 * @param {string[]} paths
 * @param {boolean} cached
 * @param {{ encoding: "utf8", timeout?: number, cwd?: string, env?: NodeJS.ProcessEnv }} opts
 * @returns {Set<string>}
 */
function checkAttr(paths, cached, opts) {
	const r = spawnGitSync(
		[
			"check-attr",
			"-z",
			"--stdin",
			...(cached ? ["--cached"] : []),
			...EXCLUDING_ATTRS,
		],
		{ ...opts, input: paths.map((p) => `${p}\0`).join("") },
	);
	throwUnlessRan(r, "check-attr");
	const fields = r.stdout.split("\0");
	const excluded = new Set();
	for (let i = 0; i + 2 < fields.length; i += 3) {
		const value = fields[i + 2];
		if (value === "set" || value === "true") excluded.add(fields[i]);
	}
	return excluded;
}

module.exports = { readAttributeExcluded };
