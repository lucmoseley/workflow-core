/*
 * always-loaded-pool.js — the pool's membership, its staged delta, and the
 * trigger verdict a tranche that grows it owes docs/doc-map.md §Capture and
 * placement §5.
 *
 * Two checkers read the same pool: check-context-budget.js gates its byte cap,
 * check-doc-map.js's assertion 16 gates the ledger entry those bytes owe.
 *
 * Nothing here requires ./doc-map.js: check-context-budget.js runs on the
 * SessionStart hook and must not pull the map parser in behind a list of
 * paths. check-doc-map.js passes `shedLedgerEntries`' output in instead.
 *
 * RUN AS A SCRIPT it prints the pool's files one per line — .husky/pre-commit's
 * trigger for a declared path its context-budget grep does not already cover.
 */

const { execFileSync } = require("node:child_process");
const { importedFiles } = require("./pool-imports.js");
const { readConfig } = require("./workflow-core-config.js");
const { cutAt } = require("./cut-at.js");
const { caught } = require("./caught.js");
const { isCommit } = require("./commit-sha.js");

/*
 * The pool's whole-file members where the host's config declares no
 * `alwaysLoaded` (#33): the two the harness loads into every session unbidden.
 * This repo declares docs/doc-map.md §Capture and placement §4's members there,
 * in the order it names them; an adopter's own files, an output style above
 * all, differ from them.
 *
 * The pool also carries own skill/command/agent `description` values, and they
 * are deliberately NOT here: assertion 16 gates the surface a RULE can land on,
 * and a description is a listing line rather than a place to put one, so a
 * commit that only lengthens one owes no ledger entry. §4 counts those bytes
 * against the cap regardless, and check-context-budget.js still charges them.
 */
const DEFAULT_POOL_FILES = ["CLAUDE.md", "AGENTS.md"];

/** @type {string[] | undefined} */
let poolFiles;

/**
 * The declared pool, else the default — read off the HOST root's config, never
 * a checker's --root, as every config read is. Read on first use rather than at
 * require, so lib/doc-map.js's readers of this module never touch the config.
 * A config that will not read throws; a malformed `alwaysLoaded` falls back to
 * the default and WARNs on stderr, which is why this read is not quiet.
 * @returns {string[]}
 */
function getPoolFiles() {
	poolFiles ??= readConfig().alwaysLoaded ?? DEFAULT_POOL_FILES;
	return poolFiles;
}

/** The adopter's declared output style (`overrides.output_style`), or null. */
const declaredStyle = () => readConfig().overrides.output_style || null;

/**
 * The pool member(s) a top-level session pays TWICE: the adopter's declared
 * output style, which loads once as the active style and again where another
 * always-loaded file `@`-imports it, directly or within the harness's five
 * hops (mantahostels#1503). Read off `root`'s
 * copies, so an `--against` side that dropped the import counts the style
 * once. Empty where the adopter declares no style (#45).
 *
 * `overrides.output_style` IS A REPO-RELATIVE PATH matched against
 * `getPoolFiles()`'s `alwaysLoaded` — never a style NAME — by
 * `check-context-budget.js`'s `STYLE-NOT-POOLED` warn (#45, #66).
 *
 * @param {string} root
 * @returns {Set<string>}
 */
function getDoubleLoadedFiles(root) {
	const style = declaredStyle();
	if (!style) return new Set();
	const others = getPoolFiles().filter((f) => f !== style);
	const imported = importedFiles(root, others).some((f) => f.path === style);
	return new Set(imported ? [style] : []);
}

/**
 * The marker a §5 ledger entry's trigger verdict opens with.
 *
 * Assertion 16 asserts that the placement test's step 2 was ANSWERED, never
 * that the answer is right.
 */
const TRIGGER_VERDICT_MARKER = "**Trigger:**";

/**
 * The fewest words the verdict may carry after that marker.
 *
 * A bare `**Trigger:** none` is indistinguishable from a marker pasted to
 * clear the gate. Three words is the least that forces the shape §3 step 2
 * asks for — a named trigger, or "none nameable" plus the clause saying why.
 */
const TRIGGER_VERDICT_MIN_WORDS = 3;

/**
 * The `git cat-file` failures that mean 0 bytes rather than a broken
 * apparatus. Git 2.43 spells absence four ways, two per limb:
 *
 * - absent from both sides — `does not exist in '<rev>'`, and its index
 *   spelling `does not exist (neither on disk nor in the index)`;
 * - present on disk but not in what was asked for — `exists on disk, but not
 *   in '<rev>'`, and `... but not in the index`. This limb is the one a
 *   commit that CREATES a pool file hits (mantahostels#3526).
 *
 * Read off stderr rather than the exit code, which is 128 for a missing path,
 * an unresolvable rev and a broken repository alike.
 *
 * Residual: the four are git 2.43's, read off it. A later git wording a fifth
 * nulls the delta again and assertion 16 silently skips — the failure mantahostels#3526
 * fixed, returning by the same route.
 */
const PATH_ABSENT = /path .* (does not exist|exists on disk, but not in)/;

/**
 * Bytes of `rev`'s copy of `rel`; 0 where that rev holds no such file, null
 * where git could not be asked at all.
 *
 * `git cat-file -s` rather than reading the blob: the pool is ~50 KB across
 * four files and only its size is wanted. `rev` is `""` for the INDEX, which
 * `:<path>` addresses — what .husky/pre-commit's doc-map gate hands the
 * checker, since a pathspec commit gives the hook its own GIT_INDEX_FILE.
 *
 * @param {string} rev
 * @param {string} rel
 * @returns {number | null}
 */
function blobBytesAt(rev, rel) {
	try {
		const out = execFileSync("git", ["cat-file", "-s", `${rev}:${rel}`], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
		const n = Number(out);
		return Number.isFinite(n) ? n : null;
	} catch (e) {
		return PATH_ABSENT.test(String(caught(e).stderr ?? "")) ? 0 : null;
	}
}

/**
 * The pool's whole-file bytes at `rev`, or null where `rev` does not resolve.
 *
 * @param {string} rev
 * @returns {number | null}
 */
function poolBytesAt(rev) {
	if (rev && !isCommit(process.cwd(), rev)) return null;
	let total = 0;
	for (const rel of getPoolFiles()) {
		const n = blobBytesAt(rev, rel);
		if (n === null) return null;
		total += n;
	}
	return total;
}

/**
 * How many pool bytes this commit ADDS: the index against the largest of the
 * already-committed revs.
 *
 * The largest, not HEAD's, because a merge's index carries both sides' work
 * and the other parent's additions are already paid for.
 *
 * Returns null where no committed rev resolves — a first commit on a fresh
 * checkout. A caller reads that as "cannot tell whether this commit adds pool
 * bytes" and asserts nothing.
 *
 * @param {string[]} revs the already-committed revs, `committedRevs()`
 * @returns {number | null}
 */
function stagedPoolDelta(revs) {
	const staged = poolBytesAt("");
	if (staged === null) return null;
	let base = null;
	for (const rev of revs) {
		const n = poolBytesAt(rev);
		if (n !== null) base = base === null ? n : Math.max(base, n);
	}
	return base === null ? null : staged - base;
}

/**
 * The `#<n>` a ledger entry's first line leads with.
 * @param {string[]} entry
 * @returns {string}
 */
const entryIssue = (entry) => {
	const [head] = entry;
	if (head === undefined) throw new Error("a shed-ledger entry with no lines");
	return (head.match(/#\d+/) || ["(unnumbered)"])[0];
};

/**
 * The label a ledger entry is known by: its `#<n>` and one lowercase word
 * directly after it, so `#1739 review` and `#1739` are two tranches under one
 * issue (#1739).
 * @param {string[]} entry
 * @returns {string}
 */
const entryLabel = (entry) => {
	const [head] = entry;
	if (head === undefined) throw new Error("a shed-ledger entry with no lines");
	return (head.match(/#\d+(?: [a-z]+(?=[\s,.*]|$))?/) || ["(unnumbered)"])[0];
};

/**
 * Assertion 16's worklist (mantahostels#1788): the fault, if any, in the trigger verdict a
 * pool-byte-adding commit owes §5's ledger.
 *
 * A commit that adds pool bytes and writes NO entry leaves the ledger's newest
 * entry as it found it — so a check reading only the newest entry's text would
 * pass as soon as any one entry carried a marker, and every later tranche
 * would ride on it.
 *
 * NEW, never edited: the entry's label is absent from every
 * already-committed copy of the ledger.
 *
 * Structured per docs/code-standards-base.md §G4.
 *
 * @param {string[][]} entries `shedLedgerEntries(text)`, newest first
 * @param {string[][][]} committedEntries the same, one array per committed rev
 * @returns {{ label: string, fault: string }[]} zero or one fault
 */
function triggerVerdictFaults(entries, committedEntries) {
	const newest = entries[0];
	if (newest === undefined)
		return [
			{
				label: "(no entry)",
				fault:
					"the ledger holds no entry at all, so this commit's pool bytes " +
					"name no shed and carry no trigger verdict",
			},
		];
	const label = entryLabel(newest);
	const known = new Set();
	for (const list of committedEntries)
		for (const entry of list) known.add(entryLabel(entry));
	if (known.has(label))
		return [
			{
				label,
				fault:
					"the ledger's newest entry is the one HEAD already held, so this " +
					"commit adds pool bytes and writes no tranche entry of its own",
			},
		];

	const text = newest.join("\n");
	const at = text.indexOf(TRIGGER_VERDICT_MARKER);
	if (at === -1)
		return [
			{
				label,
				fault: `the newest ledger entry carries no \`${TRIGGER_VERDICT_MARKER}\` verdict`,
			},
		];
	// The verdict runs to the end of its own line.
	const [rest] = cutAt(text.slice(at + TRIGGER_VERDICT_MARKER.length), "\n");
	const n = rest.split(/\s+/).filter(Boolean).length;
	if (n < TRIGGER_VERDICT_MIN_WORDS)
		return [
			{
				label,
				fault:
					`its \`${TRIGGER_VERDICT_MARKER}\` verdict is ${n} word(s); ` +
					`${TRIGGER_VERDICT_MIN_WORDS} is the floor`,
			},
		];
	return [];
}

if (require.main === module) {
	process.stdout.write(`${getPoolFiles().join("\n")}\n`);
}

module.exports = {
	getPoolFiles,
	declaredStyle,
	getDoubleLoadedFiles,
	TRIGGER_VERDICT_MARKER,
	// Consumed by lib/doc-map.js's `compactionVerdictFaults` (mantahostels#1968): a
	// compacted entry's verdict answers to the same floor, for the same reason.
	TRIGGER_VERDICT_MIN_WORDS,
	entryIssue,
	entryLabel,
	stagedPoolDelta,
	triggerVerdictFaults,
};
