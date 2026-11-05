/*
 * landed-edit.js — whether a worktree's uncommitted change to a file is
 * already on a landed ref, for check-orphaned-edits.js (#4439).
 *
 * The landed versions of a file are its copy at the ref and its copy as each
 * commit since `HEAD`'s merge base with the ref left it. LANDED BY BLOB where
 * the working copy is byte for byte one of them. LANDED BY LINES where one of
 * them made the change: each line the change adds is at least as frequent
 * there as in the working copy, each it removes at most as frequent. A
 * reordering, which moves no line's count, is never landed.
 */

const fs = require("node:fs");
const path = require("node:path");
const { gitRead } = require("./dirty-tree.js");

/** @param {string} text */
function countLines(text) {
	/** @type {Map<string, number>} */
	const counts = new Map();
	for (const line of text.split("\n"))
		counts.set(line, (counts.get(line) ?? 0) + 1);
	return counts;
}

/**
 * The blob id of every landed version of `rel`: at `ref`, then as each commit
 * in `base..ref` left it.
 * @param {string} tree
 * @param {string} rel
 * @param {string} ref
 * @returns {string[]}
 */
function readLandedBlobs(tree, rel, ref) {
	const atRef = gitRead(
		["rev-parse", "--verify", "-q", `${ref}:${rel}`],
		tree,
	)?.trim();
	const base = gitRead(["merge-base", "HEAD", ref], tree)?.trim();
	const raw = base
		? gitRead(
				[
					"log",
					"--format=",
					"--raw",
					"--no-abbrev",
					`${base}..${ref}`,
					"--",
					rel,
				],
				tree,
			)
		: null;
	/** @type {string[]} */
	const blobs = atRef ? [atRef] : [];
	for (const line of (raw ?? "").split("\n")) {
		const [, , , blob] = line.startsWith(":") ? line.split(" ") : [];
		if (blob && !blobs.includes(blob)) blobs.push(blob);
	}
	return blobs;
}

/**
 * Whether `there` made every line change `now` makes off `head`, at least as
 * far, and at least one line changed.
 * @param {Map<string, number>} head
 * @param {Map<string, number>} now
 * @param {Map<string, number>} there
 */
function isChangeMade(head, now, there) {
	let moved = 0;
	for (const line of new Set([...head.keys(), ...now.keys()])) {
		const before = head.get(line) ?? 0;
		const after = now.get(line) ?? 0;
		if (after === before) continue;
		moved++;
		const landed = there.get(line) ?? 0;
		if (after > before ? landed < after : landed > after) return false;
	}
	return moved > 0;
}

/**
 * @param {string} tree
 * @param {string} rel
 * @param {string[]} blobs
 */
function hasLandedLines(tree, rel, blobs) {
	let work;
	try {
		work = fs.readFileSync(path.join(tree, rel), "utf8");
	} catch {
		return false;
	}
	const head = countLines(gitRead(["show", `HEAD:${rel}`], tree) ?? "");
	const now = countLines(work);
	return blobs.some((b) => {
		const landed = gitRead(["cat-file", "blob", b], tree);
		return landed !== null && isChangeMade(head, now, countLines(landed));
	});
}

/**
 * How the working copy of `rel` in `tree` reached `ref`: by its blob, by its
 * lines, or not at all (null).
 * @param {string} tree
 * @param {string} rel
 * @param {string} blob the working copy's blob id
 * @param {string} ref
 * @returns {"blob"|"lines"|null}
 */
function landedAs(tree, rel, blob, ref) {
	const blobs = readLandedBlobs(tree, rel, ref);
	if (blobs.includes(blob)) return "blob";
	return hasLandedLines(tree, rel, blobs) ? "lines" : null;
}

/**
 * The count of `HEAD`'s commits not on `ref`, or null where git will not say.
 * @param {string} tree
 * @param {string} ref
 */
function readUnlandedCommits(tree, ref) {
	const n = gitRead(["rev-list", "--count", "HEAD", "--not", ref], tree);
	return n === null ? null : Number(n.trim());
}

module.exports = { landedAs, readUnlandedCommits };
