/*
 * landed-edit.js — whether a worktree's uncommitted change to a file is
 * already on a landed ref, for check-orphaned-edits.js (#4439).
 *
 * The landed versions of a file are its copy at the ref and its copy as each
 * commit since `HEAD`'s merge base with the ref left it. LANDED BY BLOB where
 * the working copy is byte for byte one of them. LANDED BY LINES where one of
 * them made the change in place: each run of lines the change replaces is
 * gone from it, the lines either side of the run are kept, and the run's new
 * lines stand there against one of them (#4903).
 */

const fs = require("node:fs");
const path = require("node:path");
const { gitRead } = require("./dirty-tree.js");
const { matchBlobGroups } = require("./blob-batch-stream.js");
const { GIT_TIMEOUT_MS } = require("./git.js");
const { logError } = require("./arbiter-core");
const { matchLines } = require("./line-match.js");

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
 * @typedef {{from: number, to: number, lines: string[]}} Hunk
 *   a run of lines a change replaces: `head[from..to)` gone, `lines` in its
 *   place
 */

/**
 * The hunks `now` makes off `head`.
 * @param {string[]} head
 * @param {string[]} now
 * @returns {Hunk[]}
 */
function buildHunks(head, now) {
	const at = matchLines(head, now);
	/** @type {Hunk[]} */
	const hunks = [];
	let i = 0;
	let j = 0;
	while (i < head.length || j < now.length) {
		if (i < head.length && at[i] === j) {
			i++;
			j++;
			continue;
		}
		const from = i;
		while (i < head.length && at[i] === -1) i++;
		/* Past `head`'s end `at[i]` is undefined; before it, a kept line. */
		const next = at[i] ?? now.length;
		hunks.push({ from, to: i, lines: now.slice(j, next) });
		j = next;
	}
	return hunks;
}

/**
 * Whether `there` made each of `hunks` off `head` in place.
 *
 * Residual: `matchLines` keeps one longest common subsequence of several, so
 * where a line repeats beside a hunk the verdict can rest on which copy it
 * kept, and a wrong pick can read an unlanded change as landed.
 * @param {string[]} head
 * @param {Hunk[]} hunks
 * @param {string[]} there
 */
function isChangeMade(head, hunks, there) {
	const at = matchLines(head, there);
	return hunks.length > 0 && hunks.every((h) => isHunkMade(at, h, there));
}

/**
 * Whether `there` made `hunk`: the head lines either side of it kept, the
 * lines it replaces gone, and its new lines standing against one of those
 * neighbours. The other side may hold lines landed since (#4439). A
 * deletion leaves its neighbours adjacent.
 * @param {Int32Array} at each line of `head`'s index in `there`, or -1
 * @param {Hunk} hunk
 * @param {string[]} there
 */
function isHunkMade(at, { from, to, lines }, there) {
	if (at.subarray(from, to).some((j) => j !== -1)) return false;
	const before = placeOf(at, from - 1, there.length);
	const after = placeOf(at, to, there.length);
	if (before === null || after === null) return false;
	const lo = before + 1;
	if (lines.length === 0) return after === lo;
	const standsAt = (/** @type {number} */ s) =>
		s >= lo &&
		s + lines.length <= after &&
		lines.every((line, k) => there[s + k] === line);
	return standsAt(lo) || standsAt(after - lines.length);
}

/**
 * Where `head[i]` stands in `there`: -1 before `there`'s first line, `end`
 * past its last, null where `there` dropped it.
 * @param {Int32Array} at each line of `head`'s index in `there`, or -1
 * @param {number} i
 * @param {number} end `there`'s length
 */
function placeOf(at, i, end) {
	if (i < 0) return -1;
	const j = at[i];
	if (j === undefined) return end;
	return j === -1 ? null : j;
}

/**
 * The lines of a file at `HEAD` and the runs its working copy replaces there,
 * or null where the working copy will not read.
 * @param {string} tree
 * @param {string} rel
 */
function readChange(tree, rel) {
	let work;
	try {
		work = fs.readFileSync(path.join(tree, rel), "utf8");
	} catch {
		return null;
	}
	const head = (gitRead(["show", `HEAD:${rel}`], tree) ?? "").split("\n");
	return { head, hunks: buildHunks(head, work.split("\n")) };
}

/**
 * How the working copy of each file in `tree` reached `ref`: by its blob, by
 * its lines, or not at all (null). Every file's landed versions are read
 * through one `git cat-file --batch` (#4542); a batch that fails reads as
 * not landed, which keeps the land route.
 * @param {string} tree
 * @param {{rel: string, blob: string}[]} files each blob the working copy's id
 * @param {string} ref
 * @returns {Promise<("blob"|"lines"|null)[]>}
 */
async function readLanded(tree, files, ref) {
	/** @type {("blob"|"lines"|null)[]} */
	const out = files.map(() => null);
	/** @type {{blobs: string[], test: (body: Buffer) => boolean}[]} */
	const groups = [];
	/** @type {number[]} each group's index in `files` */
	const fileAt = [];
	files.forEach(({ rel, blob }, i) => {
		const blobs = readLandedBlobs(tree, rel, ref);
		if (blobs.includes(blob)) {
			out[i] = "blob";
			return;
		}
		const change = readChange(tree, rel);
		if (change === null) return;
		groups.push({
			blobs,
			test: (body) =>
				isChangeMade(
					change.head,
					change.hunks,
					body.toString("utf8").split("\n"),
				),
		});
		fileAt.push(i);
	});
	const found = await matchBlobGroups(groups, {
		cwd: tree,
		timeout: GIT_TIMEOUT_MS,
	}).catch((e) => {
		logError("landed-edit", e);
		return groups.map(() => false);
	});
	found.forEach((hit, g) => {
		if (hit) out[/** @type {number} */ (fileAt[g])] = "lines";
	});
	return out;
}

/**
 * The count of `HEAD`'s commits not on `ref`, or null where git will not say.
 * @param {string} tree
 * @param {string} ref
 */
function countUnlandedCommits(tree, ref) {
	const n = gitRead(["rev-list", "--count", "HEAD", "--not", ref], tree);
	return n === null ? null : Number(n.trim());
}

module.exports = { readLanded, countUnlandedCommits };
