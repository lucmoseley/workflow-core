/*
 * landed-edit.js — whether a worktree's uncommitted change to a file is
 * already on a landed ref, for check-orphaned-edits.js (#4439).
 *
 * The landed versions of a file are its copy at the ref and its copy as each
 * commit since `HEAD`'s merge base with the ref left it. LANDED BY BLOB where
 * the working copy is byte for byte one of them. LANDED BY LINES where one of
 * them made the change in place: each run of lines the change replaces is
 * gone from it, and the run's new lines stand there whole, in order, between
 * the same unchanged lines (#4903). Lines it adds elsewhere, however alike,
 * never stand in for the change.
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
 * The runs of lines `now` replaces in `head`: each `head[from..to)` gone, and
 * `lines` in its place.
 * @param {string[]} head
 * @param {string[]} now
 * @returns {{from: number, to: number, lines: string[]}[]}
 */
function readHunks(head, now) {
	const at = matchLines(head, now);
	/** @type {{from: number, to: number, lines: string[]}[]} */
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
		const next = i < head.length ? /** @type {number} */ (at[i]) : now.length;
		hunks.push({ from, to: i, lines: now.slice(j, next) });
		j = next;
	}
	return hunks;
}

/**
 * Whether `there` made each of `hunks` off `head` in place, in order.
 * @param {string[]} head
 * @param {{from: number, to: number, lines: string[]}[]} hunks
 * @param {string[]} there
 */
function isChangeMade(head, hunks, there) {
	const at = matchLines(head, there);
	let cursor = 0;
	for (const { from, to, lines } of hunks) {
		if (at.subarray(from, to).some((j) => j !== -1)) return false;
		const [lo, hi] = gapAt(at, from, to, there.length);
		const start = findRun(there, lines, Math.max(cursor, lo), hi);
		if (start === -1) return false;
		cursor = start + lines.length;
	}
	return hunks.length > 0;
}

/**
 * The lines of `there` between where the nearest line kept around
 * `head[from..to)` stands: `[lo, hi)`.
 * @param {Int32Array} at each line of `head`'s index in `there`, or -1
 * @param {number} from
 * @param {number} to
 * @param {number} end `there`'s length
 * @returns {[number, number]}
 */
function gapAt(at, from, to, end) {
	let before = from - 1;
	while (before >= 0 && at[before] === -1) before--;
	let after = to;
	while (after < at.length && at[after] === -1) after++;
	return [
		before < 0 ? 0 : /** @type {number} */ (at[before]) + 1,
		after < at.length ? /** @type {number} */ (at[after]) : end,
	];
}

/**
 * The first index in `[lo, hi)` where `run` stands whole in `lines`, or -1.
 * @param {string[]} lines
 * @param {string[]} run
 * @param {number} lo
 * @param {number} hi
 */
function findRun(lines, run, lo, hi) {
	for (let s = lo; s + run.length <= hi; s++)
		if (run.every((line, k) => lines[s + k] === line)) return s;
	return -1;
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
	return { head, hunks: readHunks(head, work.split("\n")) };
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
