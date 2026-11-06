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

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { gitRead } = require("./dirty-tree.js");
const { GIT_TIMEOUT_MS, gitBinary, gitSpawnOptions } = require("./git.js");
const { logError } = require("./arbiter-core");

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
 * A `git cat-file --batch` stdout parser fed chunk by chunk. `onObject` gets
 * each body, null for a missing object, and returns true to stop the parse.
 * @param {(body: Buffer|null) => boolean} onObject
 * @returns {(chunk: Buffer) => void} throws on a header it cannot read
 */
function batchParser(onObject) {
	/** @type {Buffer[]} */
	let chunks = [];
	let held = 0;
	/** @type {number|null} the body size the header in hand announced */
	let size = null;
	let stopped = false;
	const take = () => {
		const buf = Buffer.concat(chunks, held);
		chunks = [buf];
		return buf;
	};
	/* A copy, not a view, so the body ahead of the tail is freed (#4542). */
	const cut = (/** @type {Buffer} */ buf, /** @type {number} */ n) => {
		chunks = [Buffer.from(buf.subarray(n))];
		held -= n;
	};
	/** The next header's body size, null for a missing object, or undefined
	 * where the header is not all in hand. */
	const readHeader = () => {
		const buf = take();
		const nl = buf.indexOf(0x0a);
		if (nl === -1) return;
		const header = buf.subarray(0, nl).toString("utf8");
		cut(buf, nl + 1);
		if (header.endsWith(" missing")) return null;
		/* `<oid> <type> <size>`. */
		const bytes = /^[0-9a-f]+ \S+ (\d+)$/.exec(header)?.[1];
		if (bytes === undefined)
			throw new Error(`git cat-file answered "${header}"`);
		return Number(bytes);
	};
	/** The next object's body, null for a missing one, or undefined where it
	 * is not all in hand. */
	const next = () => {
		if (size === null) {
			const n = readHeader();
			if (n === undefined || n === null) return n;
			size = n;
		}
		/* The batch appends a newline after each body. */
		if (held < size + 1) return;
		const buf = take();
		const body = buf.subarray(0, size);
		cut(buf, size + 1);
		size = null;
		return body;
	};
	return (chunk) => {
		if (stopped) return;
		chunks.push(chunk);
		held += chunk.length;
		while (held > 0 && !stopped) {
			const body = next();
			if (body === undefined) return;
			stopped = onObject(body);
		}
	};
}

/**
 * For each group, whether its `test` holds for any of its blobs, all read
 * through one streaming `git cat-file --batch`. Unlike lib/git-objects.js's
 * readObjectBatch it
 * holds one body at a time, so no buffer caps the total (#4542). A group stops
 * testing at its first match, and the batch is killed once every group has
 * one. A missing blob is skipped. Rejects where the batch fails or stops short.
 *
 * @param {{ blobs: string[], test: (body: Buffer) => boolean }[]} groups
 * @param {{ cwd?: string, timeout?: number }} [opts]
 * @returns {Promise<boolean[]>}
 */
function matchBlobGroups(groups, { cwd, timeout } = {}) {
	/* A group with no blobs is settled unmatched, so it never holds off the
	 * kill. */
	const found = groups.map(() => false);
	const settledAll = () =>
		found.every((hit, i) => hit || !groups[i]?.blobs.length);
	/* Which group each blob of the batch, in order, belongs to. */
	const owner = groups.flatMap((g, i) => g.blobs.map(() => i));
	if (owner.length === 0) return Promise.resolve(found);
	return new Promise((resolve, reject) => {
		const child = spawn(
			gitBinary(),
			["cat-file", "--batch"],
			/** @type {import("node:child_process").SpawnOptionsWithStdioTuple<"pipe", "pipe", "ignore">} */ (
				gitSpawnOptions({ cwd, timeout, stdio: ["pipe", "pipe", "ignore"] })
			),
		);
		let settled = false;
		const settle = (/** @type {() => void} */ done) => {
			if (settled) return;
			settled = true;
			child.kill();
			done();
		};
		let answered = 0;
		const push = batchParser((body) => {
			const i = /** @type {number} */ (owner[answered++]);
			if (body !== null && !found[i] && groups[i]?.test(body)) found[i] = true;
			return settledAll();
		});
		child.stdout.on("data", (/** @type {Buffer} */ chunk) => {
			try {
				push(chunk);
			} catch (e) {
				settle(() => reject(e));
			}
			if (settledAll()) settle(() => resolve(found));
		});
		child.stdin.on("error", () => {
			/* A kill once every group matched leaves ids unwritten: EPIPE (#4542). */
		});
		child.on("error", (e) => settle(() => reject(e)));
		child.on("close", (code) =>
			settle(() =>
				answered === owner.length
					? resolve(found)
					: reject(
							new Error(
								`git cat-file exited ${String(code)}, answering ${String(answered)} of ${String(owner.length)} blobs`,
							),
						),
			),
		);
		child.stdin.end(`${groups.flatMap((g) => g.blobs).join("\n")}\n`);
	});
}

/**
 * The line counts a file's change runs between: at `HEAD`, and in its
 * working copy — or null where the working copy will not read.
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
	const head = countLines(gitRead(["show", `HEAD:${rel}`], tree) ?? "");
	return { head, now: countLines(work) };
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
					change.now,
					countLines(body.toString("utf8")),
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
function readUnlandedCommits(tree, ref) {
	const n = gitRead(["rev-list", "--count", "HEAD", "--not", ref], tree);
	return n === null ? null : Number(n.trim());
}

module.exports = { matchBlobGroups, readLanded, readUnlandedCommits };
