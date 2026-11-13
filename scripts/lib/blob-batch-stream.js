/*
 * blob-batch-stream.js — groups of blobs tested through one streaming
 * `git cat-file --batch`, for lib/landed-edit.js (workflow-core#4542). Kept apart because
 * its spawn bypasses lib/git.js's memo, which every module the hook
 * dispatcher loads must go through (guard-dispatch-git-reads.test.ts).
 */

const { spawn } = require("node:child_process");
const { gitBinary, gitSpawnOptions } = require("./git.js");

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
	/* A copy, not a view, so the body ahead of the tail is freed (workflow-core#4542). */
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
 * readObjectBatch it holds one body at a time, so no buffer caps the total
 * (workflow-core#4542). A group stops testing at its first match, and the batch is killed
 * once every group has one. A missing blob is skipped. Rejects where the batch
 * fails or stops short.
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
			/* A kill once every group matched leaves ids unwritten: EPIPE (workflow-core#4542). */
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

module.exports = { matchBlobGroups };
