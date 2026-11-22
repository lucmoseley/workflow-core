const { spawnGitSync } = require("./git.js");
const { CHILD_MAX_BUFFER: MAX_BUFFER } = require("./child-buffer.js");
const { brokenError } = require("./outcome-error.js");
const { GIT_MODE } = require("./git-mode.js");

/**
 * @param {string[]} objects
 * @param {string} what
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
		if (header.endsWith(" missing")) {
			at = nl + 1;
			return null;
		}
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
		at = nl + 1 + bytes + 1;
		return { type, body };
	});
}

/**
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
	listTree,
	readFileAt,
	readCommittedFile,
};
