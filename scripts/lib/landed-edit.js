const fs = require("node:fs");
const path = require("node:path");
const { gitRead } = require("./dirty-tree.js");
const { matchBlobGroups } = require("./blob-batch-stream.js");
const { GIT_TIMEOUT_MS } = require("./git.js");
const { logError } = require("./arbiter-core");
const { matchLines } = require("./line-match.js");

/**
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

/** @typedef {{from: number, to: number, lines: string[]}} Hunk */

/**
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
		const next = at[i] ?? now.length;
		hunks.push({ from, to: i, lines: now.slice(j, next) });
		j = next;
	}
	return hunks;
}

/**
 * @param {string[]} head
 * @param {Hunk[]} hunks
 * @param {string[]} there
 */
function isChangeMade(head, hunks, there) {
	const at = matchLines(head, there);
	return hunks.length > 0 && hunks.every((h) => isHunkMade(at, h, there));
}

/**
 * @param {Int32Array} at
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
 * @param {Int32Array} at
 * @param {number} i
 * @param {number} end
 */
function placeOf(at, i, end) {
	if (i < 0) return -1;
	const j = at[i];
	if (j === undefined) return end;
	return j === -1 ? null : j;
}

/**
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
 * @param {string} tree
 * @param {{rel: string, blob: string}[]} files
 * @param {string} ref
 * @returns {Promise<("blob"|"lines"|null)[]>}
 */
async function readLanded(tree, files, ref) {
	/** @type {("blob"|"lines"|null)[]} */
	const out = files.map(() => null);
	/** @type {{blobs: string[], test: (body: Buffer) => boolean}[]} */
	const groups = [];
	/** @type {number[]} */
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
 * @param {string} tree
 * @param {string} ref
 */
function countUnlandedCommits(tree, ref) {
	const n = gitRead(["rev-list", "--count", "HEAD", "--not", ref], tree);
	return n === null ? null : Number(n.trim());
}

module.exports = { readLanded, countUnlandedCommits };
