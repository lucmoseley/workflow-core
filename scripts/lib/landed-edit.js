/*
 * landed-edit.js — whether a worktree's uncommitted change to a file is
 * already on a landed ref, for check-orphaned-edits.js (#4439): a dead
 * worktree whose every change has landed holds nothing to decide but its
 * removal.
 *
 * LANDED BY BLOB where the working copy is byte for byte the file at the ref,
 * or the file as some commit since `HEAD`'s merge base with the ref left it.
 * LANDED BY LINES where it is neither, but the ref's copy moved every line the
 * change moves, the same way: each line the change adds is more frequent
 * there than at `HEAD`, each it removes rarer. That reads a change landed and
 * since superseded as landed; a reordering, which moves no line's count, is
 * never read landed.
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
 * Every blob `rel` took on a commit in `base..ref`.
 * @param {string} tree
 * @param {string} rel
 * @param {string} ref
 */
function landedBlobs(tree, rel, ref) {
	const base = gitRead(["merge-base", "HEAD", ref], tree)?.trim();
	if (!base) return [];
	const raw = gitRead(
		["log", "--format=", "--raw", "--no-abbrev", `${base}..${ref}`, "--", rel],
		tree,
	);
	return (raw ?? "")
		.split("\n")
		.filter((l) => l.startsWith(":"))
		.map((l) => l.split(" ")[3]);
}

/**
 * Whether `there` moved every line `now` moved off `head`, the same way, and
 * at least one moved.
 * @param {Map<string, number>} head
 * @param {Map<string, number>} now
 * @param {Map<string, number>} there
 */
function movesAgree(head, now, there) {
	let moved = 0;
	for (const line of new Set([...head.keys(), ...now.keys()])) {
		const before = head.get(line) ?? 0;
		const step = Math.sign((now.get(line) ?? 0) - before);
		if (step === 0) continue;
		moved++;
		if (Math.sign((there.get(line) ?? 0) - before) !== step) return false;
	}
	return moved > 0;
}

/**
 * @param {string} tree
 * @param {string} rel
 * @param {string} ref
 */
function linesLanded(tree, rel, ref) {
	const landed = gitRead(["show", `${ref}:${rel}`], tree);
	if (landed === null) return false;
	let work;
	try {
		work = fs.readFileSync(path.join(tree, rel), "utf8");
	} catch {
		return false;
	}
	return movesAgree(
		countLines(gitRead(["show", `HEAD:${rel}`], tree) ?? ""),
		countLines(work),
		countLines(landed),
	);
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
	const atRef = gitRead(["rev-parse", "--verify", "-q", `${ref}:${rel}`], tree);
	if (atRef?.trim() === blob || landedBlobs(tree, rel, ref).includes(blob))
		return "blob";
	return linesLanded(tree, rel, ref) ? "lines" : null;
}

/**
 * The count of `HEAD`'s commits not on `ref`, or null where git will not say.
 * @param {string} tree
 * @param {string} ref
 */
function unlandedCommits(tree, ref) {
	const n = gitRead(["rev-list", "--count", "HEAD", "--not", ref], tree);
	return n === null ? null : Number(n.trim());
}

module.exports = { landedAs, unlandedCommits };
