/*
 * dirty-tree.js — the git reads two callers make of the same working tree, and
 * the shell-quoting of the paths they name back (mantahostels#2196), and the cap on how
 * many of them a refusal names (mantahostels#2231).
 *
 * `scripts/guard-uncommitted-work.js` refuses a turn that ends with this
 * session's tracked edits uncommitted; `scripts/run-vitest.js --isolated`
 * refuses to spin a worktree at HEAD past them. Both messages tell a session to
 * commit a set of paths, so the two sets must agree.
 *
 * THREE READS. `readTrackedStatus` answers the tracked half both of those callers
 * share, `readDirtyTracked` being its flat path set; the two untracked readers
 * differ on how a DIRECTORY is rendered, and each says which below.
 *
 * WHAT IS DELIBERATELY NOT HERE: the ATTRIBUTION policy. `attributeDirty` in
 * lib/own-selection.js and `judge`'s ledger intersection in guard-uncommitted-work.js
 * make genuinely different judgements — one warns on a neighbour's dirt and
 * refuses on its own, the other is silent on both — and sharing them would fuse
 * two policies that were separately ruled. `scripts/lib/doc-map.js`'s own
 * `readUntrackedFiles` stays separate too: it answers `[]` where git cannot, on
 * purpose (mantahostels#1403), which is the opposite of the null this module returns.
 */

const { execFileSync } = require("node:child_process");
const { gitBinary, gitSpawnOptions, GIT_TIMEOUT_MS } = require("./git.js");

/** @typedef {(file: string, args: string[], options: object) => string | Buffer} ExecFn */

/*
 * How many paths a refusal names before it hands over `git status` instead.
 * Above it neither message prints a commit command at all: a TRUNCATED
 * pathspec is worse than none, the session running it and committing only
 * some of its files.
 *
 * ONE NUMBER FOR BOTH CALLERS (mantahostels#2231), though the two messages are shaped
 * differently above the list: the cap turns on how long a pathspec stays
 * useful, which neither shape touches. Never measured on either side.
 */
const REFUSAL_NAMED_MAX = 10;

/**
 * One git read, as a string, or null where git would not answer. Exported so no
 * caller keeps a second, unbounded copy.
 * @param {string[]} args
 * @param {string} root
 * @param {ExecFn} [execFn]
 * @param {string|null} [input] git's stdin, where it reads one
 * @returns {string|null}
 */
function gitRead(args, root, execFn = execFileSync, input = null) {
	try {
		return String(
			execFn(
				gitBinary(),
				args,
				gitSpawnOptions({
					cwd: root,
					encoding: "utf8",
					input: input ?? undefined,
					stdio: [input === null ? "ignore" : "pipe", "pipe", "ignore"],
					timeout: GIT_TIMEOUT_MS,
				}),
			) ?? "",
		);
	} catch {
		return null;
	}
}

/**
 * The `--porcelain -z` records, walked once: `XY <path>`, two status letters
 * and a space in front of the path.
 *
 * A rename or copy spends the NEXT NUL-separated field on its SOURCE, which
 * carries no status letters of its own. Yielding it here is what stops a caller
 * reading it as a record — a source path beginning `?? ` would otherwise look
 * like an untracked entry (mantahostels#2211).
 *
 * @param {string} out raw `git status --porcelain -z` stdout
 * @returns {Generator<{xy: string, path: string, source: string|null, renamed: boolean}>}
 */
function* porcelainEntries(out) {
	const fields = out.split("\0").values();
	for (const entry of fields) {
		if (entry.length < 4) continue;
		const xy = entry.slice(0, 2);
		/* An empty source field is the trailing one, which the next turn would
		 * skip as too short anyway. */
		const renamed = xy.includes("R");
		const source =
			renamed || xy.includes("C") ? fields.next().value || null : null;
		yield { xy, path: entry.slice(3), source, renamed };
	}
}

/**
 * `readTrackedStatus`'s path set alone.
 *
 * @param {string} root
 * @param {ExecFn} [execFn]
 * @returns {string[]|null} null where git could not answer
 */
function readDirtyTracked(root, execFn = execFileSync) {
	return readTrackedStatus(root, execFn)?.dirty ?? null;
}

/**
 * Tracked paths with staged or unstaged modifications, de-duplicated and
 * sorted, as `dirty`; and each staged rename as its destination and source, as
 * `renames` — the pairing `dirty` flattens away, which an overlay needs to tell
 * whose a deleted source is (#1791).
 *
 * `-uno` drops untracked entries deliberately (mantahostels#1555): this tree routinely
 * carries untracked scratch, so an untracked check would fire on essentially
 * every turn. `-z` rather than the default because porcelain v1 C-quotes any
 * path holding a space or a non-ASCII byte, and a quoted path matches no ledger
 * entry. `-z` is the whole of that guarantee, so no `core.quotePath=false` rides
 * beside it (mantahostels#2196).
 *
 * A rename or copy yields the new path AND the old one — both are the session's
 * change, and either alone under-reports what a commit must carry. Porcelain
 * emits the destination first, so the sort is load-bearing; the de-duplication
 * beside it is defensive only, and no test pins it — no porcelain shape is
 * known that repeats a path (mantahostels#2196).
 *
 * @param {string} root
 * @param {ExecFn} [execFn]
 * @returns {{ dirty: string[], renames: { path: string, source: string }[] }|null}
 *   null where git could not answer
 */
function readTrackedStatus(root, execFn = execFileSync) {
	const out = gitRead(["status", "--porcelain", "-z", "-uno"], root, execFn);
	if (out === null) return null;
	/** @type {string[]} */
	const paths = [];
	/** @type {{ path: string, source: string }[]} */
	const renames = [];
	for (const { path: p, source, renamed } of porcelainEntries(out)) {
		paths.push(p);
		if (source === null) continue;
		paths.push(source);
		if (renamed) renames.push({ path: p, source });
	}
	return { dirty: [...new Set(paths)].sort(), renames };
}

/**
 * Untracked, non-ignored paths, sorted.
 *
 * READ SEPARATELY BECAUSE `-uno` DROPS THEM (mantahostels#2169). A brand-new source or test
 * file is the commonest way work exists mid-ticket, and it is exactly the shape
 * a worktree at HEAD cannot carry — so dropping it before attribution runs
 * would let `--isolated` go silently past the session's own new file.
 *
 * NEVER WARNED ABOUT IN BULK, only ever intersected with the write ledger.
 *
 * @param {string} root
 * @param {ExecFn} [execFn]
 * @returns {string[]|null} null where git could not answer
 */
function readUntrackedFiles(root, execFn = execFileSync) {
	const out = gitRead(
		["ls-files", "--others", "--exclude-standard", "-z"],
		root,
		execFn,
	);
	if (out === null) return null;
	return out.split("\0").filter(Boolean).sort();
}

/**
 * Untracked, non-ignored entries as `git status --porcelain` reports them: a
 * directory collapsed to one entry rather than walked into.
 *
 * NO CALLER TODAY, AND KEPT ANYWAY (mantahostels#2340, mantahostels#2338).
 * mantahostels#2349 is the caller it is being kept for: it moves the same detection to a
 * `SessionStart` report, which needs exactly this reading of the tree and is
 * blocked on mantahostels#2340. Delete this if mantahostels#2349 closes without taking it.
 *
 * SEPARATE FROM `readUntrackedFiles` ABOVE, DELIBERATELY (mantahostels#2211). That one walks a
 * directory out into its files, which is what `--isolated` needs to intersect
 * against a write ledger; this one gives a whole-tree count in one line.
 *
 * `.claude/tmp/` NEVER APPEARS HERE, and nothing below excludes it: the
 * sanctioned scratch directory is gitignored (`.gitignore`, mantahostels#2103) and
 * `--porcelain` without `--ignored` drops an ignored path.
 *
 * @param {string} root
 * @returns {string[]|null} null where git could not answer
 */
function readUntrackedEntries(root) {
	const out = gitRead(["status", "--porcelain", "-z"], root);
	if (out === null) return null;
	/** @type {string[]} */
	const paths = [];
	for (const { xy, path: p } of porcelainEntries(out))
		if (xy === "??") paths.push(p);
	return paths.sort();
}

/**
 * A string as a single shell word, quoted only where it needs it, so a
 * pasted command survives a space, a quote, `$` or a backtick. A `~` goes
 * unquoted only where bash never expands it: not first, nor after `=` or `:`.
 * @param {string} p
 */
function shellWord(p) {
	return /^(?!~)(?!.*[=:]~)[\w./:=@%+,~-]+$/.test(p)
		? p
		: `'${p.replaceAll("'", `'\\''`)}'`;
}

module.exports = {
	REFUSAL_NAMED_MAX,
	readDirtyTracked,
	gitRead,
	shellWord,
	readTrackedStatus,
	readUntrackedEntries,
	readUntrackedFiles,
};
