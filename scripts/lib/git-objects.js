/*
 * git-objects.js — `git ls-tree` and `git cat-file --batch`, read into entries
 * and bodies, and one file's text at a revision, a failure thrown BROKEN. No load-time side effects, so a program
 * on a suite launch's path can require it (workflow-core#2493).
 */

const { spawnGitSync } = require("./git.js");
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

module.exports = { readObjectBatch, listTree, readFileAt, readCommittedFile };
