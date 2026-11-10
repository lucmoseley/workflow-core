/*
 * orphan-filings.js — where check-orphaned-edits.js records each triage
 * filing, and how the reaper (lib/worktree-reaper.js) finds a worktree's.
 *
 * A marker per filing in `orphaned-edits-filed/` under the git common dir,
 * which every worktree shares. A linked worktree's marker is named
 * `wt-<worktree key>-<state key>.json`, so its filings are found by the
 * worktree alone (workflow-core#4439), and records the worktree's dirt as
 * `readWorktreeEdits` read it: the reaper names the issue rather than flagging
 * the worktree a second time only while that dirt is unchanged.
 */

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { gitRead } = require("./dirty-tree.js");
const { scriptPath } = require("./script-path.js");
const { shellQuote } = require("./sh-quote.js");

const FILED_DIR = "orphaned-edits-filed";

/* Hex digits of sha256 kept per key. A main-checkout key keeps the 32 its
 * markers were first named with, so none refiles. A worktree's two halves
 * keep 16 each, 64 bits. A title's tag keeps 10, as the main-checkout
 * title's blob does: the marker, not the title, prevents a refile. */
const FILE_KEY_HEX = 32;
const WORKTREE_KEY_HEX = 16;
const TITLE_TAG_HEX = 10;

/** @param {string} s */
const hashOf = (s) => createHash("sha256").update(s).digest("hex");

/** @param {string} label the worktree as `worktreeLabel` names it */
const worktreePrefix = (label) =>
	`wt-${hashOf(label).slice(0, WORKTREE_KEY_HEX)}-`;

/**
 * @param {{worktree: string|null, state: string}} unit `state` the text the
 *   filing is keyed by: the path and blob of a main-checkout file, or every
 *   orphaned file's of a worktree
 */
function markerName({ worktree, state }) {
	if (worktree === null) return `${hashOf(state).slice(0, FILE_KEY_HEX)}.json`;
	return `${worktreePrefix(worktree)}${hashOf(state).slice(0, WORKTREE_KEY_HEX)}.json`;
}

/**
 * @param {{state: string}} unit
 */
const stateTag = ({ state }) => hashOf(state).slice(0, TITLE_TAG_HEX);

/**
 * Every path `git status` lists in worktree `dir`, tracked or not, each with
 * its working copy's blob id ("gone" where it has none), sorted; the store
 * link left out, as the reaper leaves it out. Null where git will not
 * answer. The status takes no optional lock, so it never rewrites the index
 * whose age the reaper reads.
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
 * The issue last filed for worktree `label` — where `dirt` is given, only
 * one filed while the worktree's dirt was exactly that. Null where none was
 * recorded.
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
		try {
			const m = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"));
			if (want !== undefined && (m.dirt ?? []).join("\n") !== want) continue;
			if (m.ref && Number(m.at) > best.at)
				best = { at: Number(m.at), ref: m.ref };
		} catch {
			// Empty or torn: a filing running or killed, which names no issue.
		}
	}
	return best.ref;
}

/**
 * @param {string} dir
 */
function buildWaysOut(dir) {
	const q = shellQuote(dir);
	return {
		land: `cd ${q} && node ${scriptPath("session-checkout.js")} land`,
		remove: `git worktree remove --force ${q}`,
	};
}

module.exports = {
	FILED_DIR,
	buildWaysOut,
	markerName,
	readWorktreeEdits,
	readWorktreeFiling,
	stateTag,
};
