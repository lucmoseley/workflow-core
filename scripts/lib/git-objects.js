/*
 * git-objects.js — `git ls-tree` and `git cat-file --batch`, read into entries
 * and bodies, and one file's text at a revision, a failure thrown BROKEN. No load-time side effects, so a program
 * on a suite launch's path can require it (#2493).
 */

const { spawn } = require("node:child_process");
const { gitBinary, gitSpawnOptions, spawnGitSync } = require("./git.js");
const { CHILD_MAX_BUFFER: MAX_BUFFER } = require("./child-buffer.js");
const { brokenError } = require("./outcome-error.js");
const { GIT_MODE } = require("./git-mode.js");

/**
 * Each object out of one `git cat-file --batch`, in the order asked: its type
 * and body, null for one git reports missing.
 *
 * With `followSymlinks`, a `<rev>:<path>` through a link inside the tree
 * answers its target's object, and one git will not follow answers git's own
 * `symlink`, `dangling`, `loop` or `notdir` type, its body the link target or
 * the name asked (git-cat-file(1)).
 *
 * FAILS CLOSED: a failed or truncated batch throws BROKEN rather than handing
 * back fewer bodies, which a cap gate would read as bytes shed (mantahostels#1834).
 *
 * @param {string[]} objects shas, or `<rev>:<path>` names
 * @param {string} what what is being fetched, for the refusal
 * @param {{ cwd?: string, followSymlinks?: boolean, timeout?: number, maxBuffer?: number }} [opts]
 * @returns {({ type: string, body: Buffer } | null)[]}
 */
function readObjectBatch(
	objects,
	what,
	{ cwd, followSymlinks = false, timeout, maxBuffer = MAX_BUFFER } = {},
) {
	if (objects.length === 0) return [];
	const batch = spawnGitSync(
		["cat-file", "--batch", ...(followSymlinks ? ["--follow-symlinks"] : [])],
		{
			cwd,
			/* A Buffer, not a string: `encoding: "buffer"` governs stdin too, and
			 * node refuses it as an input encoding. */
			input: Buffer.from(`${objects.join("\n")}\n`, "utf8"),
			encoding: "buffer",
			maxBuffer,
			timeout,
		},
	);
	if (batch.error || batch.status !== 0)
		throw brokenError(
			`git cat-file failed while fetching ${what}: ` +
				`${String(batch.stderr ?? "").trim() || batch.error?.message}`,
		);

	const buf = batch.stdout;
	let at = 0;
	return objects.map((object) => {
		const nl = buf.indexOf(0x0a, at);
		if (nl === -1)
			throw brokenError(
				`git cat-file stopped short while fetching ${what}, ` +
					"answering fewer objects than it was asked for.",
			);
		const header = buf.slice(at, nl).toString("utf8");
		/* `<name> missing` carries no body; skipping it keeps the cursor on a
		 * header boundary rather than desyncing every entry after it. */
		if (header.endsWith(" missing")) {
			at = nl + 1;
			return null;
		}
		/* `<oid> <type> <size>`, or a followed link's `<type> <size>`. */
		const fields = header.split(" ");
		const type = fields.at(-2);
		const bytes = Number(fields.at(-1));
		if (
			type === undefined ||
			!Number.isInteger(bytes) ||
			nl + 1 + bytes > buf.length
		)
			throw brokenError(
				`git cat-file answered ${object} with "${header}" while fetching ${what}.`,
			);
		const body = buf.slice(nl + 1, nl + 1 + bytes);
		at = nl + 1 + bytes + 1; // the batch appends a newline after each body
		return { type, body };
	});
}

/**
 * A `git cat-file --batch` stdout parser fed chunk by chunk, holding only the
 * object in hand. `onObject` gets each body, null for a missing object, and
 * returns true to stop the parse.
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
		/* `<oid> <type> <size>`; anything else would put every later body on
		 * the wrong object. */
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
 * through one streaming `git cat-file --batch`. Unlike readObjectBatch it
 * holds one body at a time, so no buffer caps the total: a large file's every
 * landed version can run to hundreds of megabytes (#4542). A group stops
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
 * `git ls-tree` of `pathspecs` at `rev`, run in `cwd`, so each path is
 * relative to it. Recursive, it lists every blob, symlink and gitlink; not, a
 * directory's own entries, trees included.
 *
 * @param {string} rev
 * @param {string[]} pathspecs
 * @param {{ cwd?: string, recursive?: boolean, timeout?: number }} [opts]
 * @returns {{ mode: string, sha: string, path: string }[]}
 */
function listTree(rev, pathspecs, { cwd, recursive = true, timeout } = {}) {
	const listing = spawnGitSync(
		["ls-tree", ...(recursive ? ["-r"] : []), "-z", rev, "--", ...pathspecs],
		{ cwd, encoding: "buffer", timeout },
	);
	if (listing.error || listing.status !== 0)
		throw brokenError(
			`git ls-tree failed while listing ${rev}: ` +
				`${String(listing.stderr ?? "").trim() || listing.error?.message}`,
		);

	/** @type {{ mode: string, sha: string, path: string }[]} */
	const entries = [];
	for (const record of listing.stdout.toString("utf8").split("\0")) {
		const tab = record.indexOf("\t");
		if (tab === -1) continue;
		const [mode, , sha] = record.slice(0, tab).split(/\s+/);
		if (mode === undefined || sha === undefined)
			throw brokenError(
				`git ls-tree printed a record short of its mode, type and sha: ${record}`,
			);
		entries.push({ mode, sha, path: record.slice(tab + 1) });
	}
	return entries;
}

/**
 * Whether `rev`, an empty `rev` the index, holds a submodule at `file`: its
 * commit is another repository's, which cat-file reports missing.
 *
 * @param {string} rev
 * @param {string} file
 * @param {string} [cwd]
 * @param {number} [timeout]
 */
function isGitlink(rev, file, cwd, timeout) {
	if (rev !== "")
		return listTree(rev, [file], { cwd, recursive: false, timeout }).some(
			(e) => e.mode === GIT_MODE.gitlink,
		);
	const staged = spawnGitSync(["ls-files", "-s", "-z", "--", file], {
		cwd,
		encoding: "utf8",
		timeout,
	});
	if (staged.error || staged.status !== 0)
		throw brokenError(
			`git ls-files failed while reading ${file} in the index: ` +
				`${String(staged.stderr ?? "").trim() || staged.error?.message}`,
		);
	return staged.stdout.startsWith(`${GIT_MODE.gitlink} `);
}

/**
 * The text of repo-relative `file` as `rev` holds it, an empty `rev` the
 * index: null where it holds no such path, undefined where `rev` names no
 * commit (an unborn HEAD included). Throws BROKEN where the path holds no
 * file or git will not answer.
 *
 * @param {string} rev
 * @param {string} file
 * @param {{ cwd?: string, timeout?: number }} [opts]
 * @returns {string|null|undefined}
 */
function readFileAt(rev, file, { cwd, timeout } = {}) {
	const at = rev === "" ? "the index" : rev;
	const commit = rev === "" ? [] : [`${rev}^{commit}`];
	const objects = readObjectBatch(
		[...commit, `${rev}:${file}`],
		`${file} at ${at}`,
		{ cwd, timeout },
	);
	if (objects[0] === null && commit.length > 0) return;
	const blob = objects.at(-1);
	if (blob ? blob.type !== "blob" : isGitlink(rev, file, cwd, timeout))
		throw brokenError(`${file} at ${at} is not a file`);
	if (!blob) return null;
	return blob.body.toString("utf8");
}

/**
 * readFileAt, where `rev` must name a commit: throws BROKEN where it names
 * none, an unborn HEAD included.
 *
 * @param {string} rev
 * @param {string} file
 * @param {{ cwd?: string, timeout?: number }} [opts]
 * @returns {string|null}
 */
function readCommittedFile(rev, file, opts) {
	const text = readFileAt(rev, file, opts);
	if (text === undefined) throw brokenError(`${rev} names no commit`);
	return text;
}

module.exports = {
	readObjectBatch,
	matchBlobGroups,
	listTree,
	readFileAt,
	readCommittedFile,
};
