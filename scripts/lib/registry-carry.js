/*
 * registry-carry.js — a guard-registry row carried across a merge (#4514).
 *
 * A row the merge leaves stale, fresh on both parents, where no file of its
 * merged-tree closure changed on both sides since the merge base, is
 * re-anchored to the merged tree's digest in the merge commit: each side's
 * author re-read the row's prose against their own change, and no file holds
 * two changes that one reader never saw together. Both-sides-changed is judged
 * per file, by blob id at the base and at each parent. A clean textual merge of
 * one file is two changes all the same. Every other stale row is refused.
 *
 * Every git failure carries nothing.
 */

const fs = require("node:fs");
const path = require("node:path");

const { GIT_TIMEOUT_MS, spawnGitSync } = require("./git.js");
const { buildAnchorsText, parseRows } = require("./registry-anchors-file.js");

const CARRIED_KINDS = new Set(["UNANCHORED", "STALE-PROSE"]);

/* git exports one per merged head to the hooks a `git merge` runs (its
 * conflict-marker labels), before MERGE_HEAD exists. */
const GITHEAD_ENV = /^GITHEAD_([0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * @typedef {{ theirs: string[], lands: boolean }} Merge `lands`: an index edit
 *   reaches the merge commit, as under pre-commit. `git merge` writes its tree
 *   before pre-merge-commit runs, and `git commit` reads its index before
 *   prepare-commit-msg does (git 2.43): both hooks set
 *   WFC_INDEX_FROZEN.
 * @typedef {{ guard: string, digest: string }} Carried
 * @typedef {{ guard: string, why: string }} Kept
 * @typedef {{ kind: string, guard: string, digest?: string, hashes?: string[] }} Row
 * @typedef {Row & { digest: string, hashes: string[] }} Candidate a row of a
 *   kind a merge carries, its digest and closure read
 */

/** @param {Row} w @returns {w is Candidate} */
const isCandidate = (w) =>
	CARRIED_KINDS.has(w.kind) && Boolean(w.digest) && Array.isArray(w.hashes);

/**
 * @param {string} root
 * @param {string[]} args
 * @param {string | Buffer} [input]
 * @returns {{ out: string, error: string | null }}
 */
function git(root, args, input) {
	const r = spawnGitSync(["-C", root, ...args], {
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		input,
		stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
	});
	if (r.error) return { out: "", error: r.error.message };
	if (r.status !== 0)
		return {
			out: "",
			error: String(r.stderr).trim() || `git ${args[0]} exited ${r.status}`,
		};
	return { out: String(r.stdout), error: null };
}

/**
 * The merge this commit makes, or null where it makes none.
 *
 * @param {string} root
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Merge | null}
 */
function readMerge(root, env = process.env) {
	const at = git(root, ["rev-parse", "--git-path", "MERGE_HEAD"]);
	if (at.error === null) {
		const file = path.resolve(root, at.out.trim());
		if (fs.existsSync(file)) {
			const theirs = fs
				.readFileSync(file, "utf8")
				.split("\n")
				.map((l) => l.trim())
				.filter(Boolean);
			return { theirs, lands: env.WFC_INDEX_FROZEN !== "1" };
		}
	}
	const theirs = Object.keys(env).flatMap((k) => {
		const m = GITHEAD_ENV.exec(k);
		return m?.[1] ? [m[1]] : [];
	});
	return theirs.length > 0 ? { theirs, lands: false } : null;
}

/**
 * The paths among `inputs` whose blob differs between the two sides `git diff`
 * takes: two revs, or `--cached` and a rev for the index against it.
 *
 * @param {string} root
 * @param {[string, string]} sides
 * @param {string[]} inputs
 */
function changedSince(root, sides, inputs) {
	const r = git(root, [
		"--literal-pathspecs",
		"diff",
		"--no-renames",
		"--name-only",
		"-z",
		...sides,
		"--",
		...inputs,
	]);
	return {
		paths: new Set(r.out.split("\0").filter(Boolean)),
		error: r.error,
	};
}

/**
 * `rows` less each one a file of whose closure both sides changed since
 * `base`, which goes to `kept`. A string where git could not answer.
 *
 * @param {string} root
 * @param {{ base: string, theirs: string }} revs
 * @param {Candidate[]} rows
 * @param {Kept[]} kept accumulator: each row dropped, with why
 * @returns {Candidate[] | string}
 */
function dropBothChanged(root, { base, theirs }, rows, kept) {
	const inputs = [...new Set(rows.flatMap((w) => w.hashes))];
	const ours = changedSince(root, [base, "HEAD"], inputs);
	const them = changedSince(root, [base, theirs], inputs);
	/* An index matching neither parent is the merge commit's own change, which nobody read. */
	const notOurs = changedSince(root, ["--cached", "HEAD"], inputs);
	const notTheirs = changedSince(root, ["--cached", theirs], inputs);
	const failed = ours.error ?? them.error ?? notOurs.error ?? notTheirs.error;
	if (failed) return `git diff failed (${failed})`;
	return rows.filter((w) => {
		const both = w.hashes.filter((p) => ours.paths.has(p) && them.paths.has(p));
		const own = w.hashes.filter(
			(p) => notOurs.paths.has(p) && notTheirs.paths.has(p),
		);
		if (both.length === 0 && own.length === 0) return true;
		kept.push({
			guard: w.guard,
			why:
				both.length > 0
					? `both sides changed ${both.join(", ")}`
					: `the merge itself changed ${own.join(", ")}`,
		});
		return false;
	});
}

/**
 * Which of a merge's stale rows carry, and why each other one does not.
 *
 * @param {string} root
 * @param {Merge} merge
 * @param {Row[]} stale the rows the merged index adds stale
 * @param {{ oursFresh: Set<string> | null, readTheirsFresh: (rev: string) => Set<string> | null }} parents
 *   the rows fresh on HEAD, and a read of those fresh on theirs; null where unread
 * @returns {{ carried: Carried[], kept: Kept[], none: string | null }} `none`:
 *   why no row could carry, where none could
 */
function judgeCarry(root, merge, stale, { oursFresh, readTheirsFresh }) {
	const nothing = (/** @type {string} */ why) => ({
		carried: [],
		kept: [],
		none: why,
	});
	const [theirs] = merge.theirs;
	if (merge.theirs.length !== 1 || theirs === undefined)
		return nothing(
			`a merge of ${merge.theirs.length} heads carries none (#4514)`,
		);
	const bases = git(root, ["merge-base", "--all", "HEAD", theirs]);
	if (bases.error) return nothing(`git merge-base failed (${bases.error})`);
	const baseList = bases.out.split("\n").filter(Boolean);
	const [base] = baseList;
	if (baseList.length !== 1 || base === undefined)
		return nothing(`the merge has ${baseList.length} merge bases`);
	if (oursFresh === null) return nothing("HEAD's rows went unread");

	/** @type {Kept[]} */
	const kept = [];
	const rows = stale.filter(isCandidate).filter((w) => {
		if (oursFresh.has(w.guard)) return true;
		kept.push({ guard: w.guard, why: "it is not fresh on HEAD" });
		return false;
	});
	if (rows.length === 0) return { carried: [], kept, none: null };

	const survivors = dropBothChanged(root, { base, theirs }, rows, kept);
	if (typeof survivors === "string") return nothing(survivors);
	if (survivors.length === 0) return { carried: [], kept, none: null };

	const theirsFresh = readTheirsFresh(theirs);
	if (theirsFresh === null) return nothing(`${theirs}'s rows went unread`);
	/** @type {Carried[]} */
	const carried = [];
	for (const w of survivors)
		if (theirsFresh.has(w.guard))
			carried.push({ guard: w.guard, digest: w.digest });
		else kept.push({ guard: w.guard, why: `it is not fresh on ${theirs}` });
	return { carried, kept, none: null };
}

/**
 * Write the carried rows into the anchors file, in the index and in the
 * working tree. The working copy is patched row by row where it differs from
 * the index, so an unstaged edit to it survives.
 *
 * @param {string} root
 * @param {string} rel the anchors file
 * @param {Carried[]} carried
 * @returns {string | null} why the write failed, else null
 */
function writeCarried(root, rel, carried) {
	const listed = git(root, [
		"--literal-pathspecs",
		"ls-files",
		"-s",
		"--",
		rel,
	]);
	if (listed.error) return `git ls-files failed (${listed.error})`;
	const entries = listed.out.split("\n").filter(Boolean);
	const m = /^(\d+) ([0-9a-f]+) 0\t/.exec(entries[0] ?? "");
	if (entries.length !== 1 || !m?.[1] || !m[2])
		return `${rel} is not one merged entry in the index`;
	const [, mode, blob] = m;
	const staged = git(root, ["cat-file", "blob", blob]);
	if (staged.error) return `git cat-file failed (${staged.error})`;
	const patch = (/** @type {string} */ text) => {
		const rows = parseRows(text);
		if (rows === null) return null;
		for (const c of carried) rows[c.guard] = c.digest;
		return buildAnchorsText(rows);
	};
	const next = patch(staged.out);
	if (next === null) return `the staged ${rel} does not parse`;
	const written = git(root, ["hash-object", "-w", "--stdin"], next);
	if (written.error) return `git hash-object failed (${written.error})`;
	const updated = git(root, [
		"update-index",
		"--cacheinfo",
		`${mode},${written.out.trim()},${rel}`,
	]);
	if (updated.error) return `git update-index failed (${updated.error})`;

	const abs = path.join(root, rel);
	const disk = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
	const onDisk = disk === null || disk === staged.out ? next : patch(disk);
	if (onDisk === null)
		return `the working ${rel} does not parse, so only the index carries the rows`;
	fs.writeFileSync(abs, onDisk);
	return null;
}

module.exports = { judgeCarry, readMerge, writeCarried };
