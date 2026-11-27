const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { orFallback } = require("./caught.js");
const { gitRead } = require("./dirty-tree.js");
const { scriptPath } = require("./script-path.js");
const { shellQuote } = require("./sh-quote.js");

const FILED_DIR = "orphaned-edits-filed";

// guess, #4439
const FILE_KEY_HEX = 32;
const WORKTREE_KEY_HEX = 16;
const TITLE_TAG_HEX = 10;

/** @param {string} s */
const hashOf = (s) => createHash("sha256").update(s).digest("hex");

/** @param {string} label */
const worktreePrefix = (label) =>
	`wt-${hashOf(label).slice(0, WORKTREE_KEY_HEX)}-`;

/** @param {{worktree: string|null, state: string}} unit */
function markerName({ worktree, state }) {
	if (worktree === null) return `${hashOf(state).slice(0, FILE_KEY_HEX)}.json`;
	return `${worktreePrefix(worktree)}${hashOf(state).slice(0, WORKTREE_KEY_HEX)}.json`;
}

/**
 * @param {{state: string}} unit
 */
const stateTag = ({ state }) => hashOf(state).slice(0, TITLE_TAG_HEX);

/**
 * @param {string} dir
 * @returns {string[]|null}
 */
function readWorktreeEdits(dir) {
	const out = gitRead(
		[
			"--no-optional-locks",
			"status",
			"--porcelain",
			"--untracked-files=all",
			"--",
			".",
			":(top,exclude)node_modules",
		],
		dir,
	);
	if (out === null) return null;
	const paths = out
		.split("\n")
		.filter(Boolean)
		.map((l) => l.slice(3));
	const present = paths.filter((p) =>
		fs.statSync(path.join(dir, p), { throwIfNoEntry: false })?.isFile(),
	);
	const ids =
		present.length > 0
			? gitRead(
					["hash-object", "--stdin-paths"],
					dir,
					undefined,
					`${present.join("\n")}\n`,
				)
			: "";
	if (ids === null) return null;
	const blobs = new Map(present.map((p, i) => [p, ids.split("\n")[i]]));
	return paths.map((p) => `${p}\0${blobs.get(p) ?? "gone"}`).sort();
}

/**
 * @param {string} commonDir
 * @param {string} label
 * @param {string[]} [dirt]
 * @returns {string|null}
 */
function readWorktreeFiling(commonDir, label, dirt) {
	const dir = path.join(commonDir, FILED_DIR);
	const prefix = worktreePrefix(label);
	let names;
	try {
		names = fs.readdirSync(dir).filter((n) => n.startsWith(prefix));
	} catch {
		return null;
	}
	const want = dirt?.join("\n");
	let best = { at: -1, ref: /** @type {string|null} */ (null) };
	for (const n of names) {
		const floor = best.at;
		const better = orFallback(() => {
			const m = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
			if (want !== undefined && (m.dirt ?? []).join("\n") !== want) return null;
			return m.ref && Number(m.at) > floor
				? { at: Number(m.at), ref: m.ref }
				: null;
		}, null);
		if (better) best = better;
	}
	return best.ref;
}

/**
 * @param {string} commonDir
 * @param {string} label
 */
function dropWorktreeFilings(commonDir, label) {
	const dir = path.join(commonDir, FILED_DIR);
	const prefix = worktreePrefix(label);
	const names = orFallback(
		() => fs.readdirSync(dir),
		/** @type {string[]} */ ([]),
	);
	for (const n of names)
		if (n.startsWith(prefix)) fs.rmSync(path.join(dir, n), { force: true });
}

/**
 * @param {string} dir
 */
function buildWaysOut(dir) {
	const q = shellQuote(dir);
	return {
		land: `cd ${q} && node ${scriptPath("session-checkout.js")} land`,
		removeLanded: `node ${scriptPath("remove-orphaned-worktree.js")} ${q}`,
		remove: `git worktree remove --force ${q}`,
	};
}

module.exports = {
	FILED_DIR,
	buildWaysOut,
	dropWorktreeFilings,
	markerName,
	readWorktreeEdits,
	readWorktreeFiling,
	stateTag,
};
