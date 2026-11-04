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

const { readImportedFiles } = require("./pool-imports.js");
const { readConfig } = require("./workflow-core-config.js");
const { cutAt } = require("./cut-at.js");
const { caught } = require("./caught.js");
const { readCommitOrBroken } = require("./commit-sha.js");
const { execGit } = require("./git.js");
const { brokenError } = require("./outcome-error.js");

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
const readDeclaredStyle = () => readConfig().overrides.output_style || null;

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
	const style = readDeclaredStyle();
	if (!style) return new Set();
	const others = getPoolFiles().filter((f) => f !== style);
	const imported = readImportedFiles(root, others).some(
		(f) => f.path === style,
	);
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
 * The pool's whole-file bytes in each of `treeishes`, `""` for the INDEX, which
 * `:<path>` addresses — what .husky/pre-commit's doc-map gate hands the
 * checker, since a pathspec commit gives the hook its own GIT_INDEX_FILE. A
 * file a treeish does not hold is 0 bytes, the creating commit's case
 * (mantahostels#3526). A git that will not answer is BROKEN, never an absent
 * file (#3152).
 *
 * One `git cat-file --batch-check` for every file in every treeish rather than
 * the blobs: the pool is ~50 KB across four files and only its size is wanted.
 * It prints `<spec> missing` for an object it cannot find, whatever the reason
 * and in any locale, an unresolvable rev included, so each treeish must
 * already resolve; a corrupt index or no repository at all exits 128.
 *
 * Residual: a resolvable rev whose blob is gone from the object store is also
 * `missing`, so 0 bytes, where `cat-file -s` was BROKEN; a store that corrupt
 * is fsck's to find.
 *
 * @param {string[]} treeishes
 * @returns {number[]}
 */
function readPoolBytesIn(treeishes) {
	const files = getPoolFiles();
	const specs = treeishes.flatMap((t) => files.map((rel) => `${t}:${rel}`));
	let out;
	try {
		out = execGit(["cat-file", "--batch-check=%(objectsize)"], {
			encoding: "utf8",
			input: specs.map((spec) => `${spec}\n`).join(""),
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (e) {
		const { stderr, message } = caught(e);
		throw brokenError(
			`git would not read the pool's sizes in ${treeishes.map((t) => t || "the index").join(", ")}: ${String(stderr ?? "").trim() || message}`,
		);
	}
	const lines = out.split("\n");
	const sizes = specs.map((spec, i) => {
		const line = lines[i] ?? "";
		if (line === `${spec} missing`) return 0;
		if (/^\d+$/.test(line)) return Number(line);
		throw brokenError(
			`git cat-file --batch-check ${spec} printed ${line.slice(0, 80)}`,
		);
	});
	return treeishes.map((_, t) =>
		sizes
			.slice(t * files.length, (t + 1) * files.length)
			.reduce((a, b) => a + b, 0),
	);
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
 * bytes" and asserts nothing. A git that will not answer is BROKEN (#3152).
 *
 * @param {string[]} revs the already-committed revs, `readParentRevs()`
 * @returns {number | null}
 */
function stagedPoolDelta(revs) {
	const committed = revs.filter((rev) => readCommitOrBroken(rev) !== null);
	const [staged, ...bases] = readPoolBytesIn(["", ...committed]);
	return bases.length === 0 ? null : staged - Math.max(...bases);
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
	readDeclaredStyle,
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
