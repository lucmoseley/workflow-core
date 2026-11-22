const { spawn } = require("node:child_process");
const { gitBinary, gitSpawnOptions } = require("./git.js");
const { noop } = require("./noop.js");

/**
 * @param {(body: Buffer|null) => boolean} onObject
 * @returns {(chunk: Buffer) => void}
 */
function batchParser(onObject) {
	/** @type {Buffer[]} */
	let chunks = [];
	let held = 0;
	/** @type {number|null} */
	let size = null;
	let stopped = false;
	const take = () => {
		const buf = Buffer.concat(chunks, held);
		chunks = [buf];
		return buf;
	};
	const cut = (/** @type {Buffer} */ buf, /** @type {number} */ n) => {
		chunks = [Buffer.from(buf.subarray(n))];
		held -= n;
	};
	const readHeader = () => {
		const buf = take();
		const nl = buf.indexOf(0x0a);
		if (nl === -1) return;
		const header = buf.subarray(0, nl).toString("utf8");
		cut(buf, nl + 1);
		if (header.endsWith(" missing")) return null;
		const bytes = /^[0-9a-f]+ \S+ (\d+)$/.exec(header)?.[1];
		if (bytes === undefined)
			throw new Error(`git cat-file answered "${header}"`);
		return Number(bytes);
	};
	const next = () => {
		if (size === null) {
			const n = readHeader();
			if (n === undefined || n === null) return n;
			size = n;
		}
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
 * @param {{ blobs: string[], test: (body: Buffer) => boolean }[]} groups
 * @param {{ cwd?: string, timeout?: number }} [opts]
 * @returns {Promise<boolean[]>}
 */
function matchBlobGroups(groups, { cwd, timeout } = {}) {
	const found = groups.map(() => false);
	const settledAll = () =>
		found.every((hit, i) => hit || !groups[i]?.blobs.length);
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
		child.stdin.on("error", noop);
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
