/*
 * arbiter-snapshots.js — tier snapshots — a baseline for the write no hook ever sees (mantahostels#419).
 *
 * A claim mints a baseline only on a Write/Edit/NotebookEdit call, so a session
 * reaching a watched file through `sed -i`, a heredoc, `cp` or `git restore`
 * mints nothing, and so is never told of a clobber (mantahostels#364). This family
 * scans the tier after every Bash call instead.
 *
 * One of arbiter-store.js's family modules — its header holds THE SPLIT RULE
 * (mantahostels#1795), which binds a require added here.
 */

const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const core = require("./arbiter-core.js");
const { caught } = require("./caught.js");

// ---------------------------------------------------------------------------
// Tier snapshots — a baseline for the write no hook ever sees (mantahostels#419)
// ---------------------------------------------------------------------------
//
// IT READS BYTES, NEVER THE COMMAND. Parsing a shell command for its write
// targets is the arms race mantahostels#287 declined. So: hash the watched tiers on every
// Bash call, diff against THIS session's own previous hashes, and baseline
// whatever moved. Only a file whose stat moved is re-hashed; the rest keep the
// blob id their unchanged stat vouches for (#833).
//
// BASELINE ONLY, ON BOTH TIERS. A scan sees that bytes changed, not who changed
// them, so a lock minted from one would block a neighbour on an inference —
// mantahostels#288's report-only posture, unchanged.
//
// THE ACCEPTED RESIDUAL (mantahostels#364). A scan cannot tell this session's write
// from a neighbour's landing in the same gap, so a baseline can record another
// session's bytes as this session's. The contention it runs at is measured in
// mantahostels#287.

/** As long as a write ledger, and swept on the same terms: a cache, not a record. */
const SNAPSHOT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many paths one scan will baseline.
 *
 * Each mint costs two git processes, and a `git pull` or a branch switch moves
 * the whole tier at once — uncapped, that overruns the hook's `timeout 5` and
 * the tick is lost entirely. It is a ceiling on the worst tick, not a tuned
 * figure; the timings are in mantahostels#287.
 */
const SCAN_MINT_MAX = 20;

/**
 * The tiers as git pathspecs — what git is ASKED for, which is wider than the
 * watched union: `.claude/tmp/` sits inside a tier and outside the union
 * (mantahostels#2103). git has no way to spell that subtraction, so `readTierFiles` filters the
 * listing through `core.isWatched` afterwards; these prefixes only keep the
 * question cheap.
 */
const WATCHED_PATHSPECS = [...core.REFUSING, ...core.DETECT_ONLY];

/**
 * How far before the previous scan's start a file's ctime must lie for that
 * scan's blob id to be kept unhashed — git's racy-stat rule (#833).
 *
 * A file rewritten in the same clock tick as the scan read it keeps its size,
 * mtime and ctime, so its stat matches a blob id that is no longer its content.
 * Any change landing after the scan started has a ctime at or past that start,
 * so a file whose ctime is older by more than the clock's granularity cannot
 * share a tick with one. The margin is that granularity, rounded up: the
 * kernel's coarse clock lags `Date.now()` by a tick, and a one-second filesystem
 * floors a write a whole second back.
 *
 * ctime, not git's mtime: userland can set mtime back (`cp -p`, `touch -r`) and
 * cannot set ctime.
 */
const RACY_MARGIN_MS = 1000;

/**
 * The stat fields a snapshot keys a blob id on; any of them moving means re-hash.
 *
 * The racy rule already re-hashes anything touched since the last scan, its
 * ctime being current. This is the backstop for a wall clock stepped back past
 * the margin, where a fresh ctime can read as old.
 */
const statKey = (/** @type {fs.BigIntStats} */ st) =>
	`${st.size} ${st.mtimeNs} ${st.ctimeNs}`;

/** How many space-separated fields statKey writes; the line parser counts on it. */
const STAT_FIELDS = 3;

/** Never equal to a real statKey, so the entry is hashed next scan whatever its stat. */
const NO_STAT = new Array(STAT_FIELDS).fill("-").join(" ");

/**
 * Every watched file git can name, with its stat, or null where git could not answer.
 *
 * Untracked-but-not-ignored files are in: a file this session created by Bash
 * is exactly what has no other baseline. Symlinks and directories are out —
 * `hash-object` fails on them, and one failure aborts the whole batch.
 * @returns {Map<string, fs.BigIntStats> | null}
 */
function readTierFiles() {
	const listed = core.git([
		"ls-files",
		"-z",
		"--cached",
		"--others",
		"--exclude-standard",
		"--",
		...WATCHED_PATHSPECS,
	]);
	if (listed === null) return null;
	const root = core.repoRoot();
	const files = new Map();
	for (const rel of listed.split("\0")) {
		if (!rel) continue;
		// A newline in a path would desynchronise --stdin-paths, which is
		// line-oriented, and mis-attribute every hash after it.
		if (rel.includes("\n")) continue;
		// The pathspecs above are the raw tiers; this is the union itself. An
		// EXEMPT path is baselined by nothing, so a clobber there is reported
		// by nothing — which is the point, scratch having no version worth
		// recovering. Today `.gitignore` would hide the only member from the
		// `--others` half anyway, but not from `--cached`, and the next member
		// need not be ignored at all.
		if (!core.isWatched(rel)) continue;
		let st;
		try {
			st = fs.lstatSync(path.join(root, rel), { bigint: true });
		} catch {
			continue; // deleted under us, or unreadable
		}
		if (st.isFile()) files.set(rel, st);
	}
	return files;
}

/**
 * `rel -> blob id` for every path given, or null where the batch did not answer
 * for all of them.
 *
 * One `git hash-object --stdin-paths` for the whole batch rather than one call
 * per file.
 *
 * A short answer is discarded rather than aligned. hash-object aborts on the
 * first path it cannot read, and its output is positional, so a partial read is
 * indistinguishable from a correct one shifted by a file.
 * @param {string[]} rels
 */
function hashPaths(rels) {
	if (rels.length === 0) return new Map();
	const out = core.gitIn(
		["hash-object", "--stdin-paths"],
		`${rels.join("\n")}\n`,
	);
	if (out === null) return null;
	const shas = out.split("\n").filter(Boolean);
	if (shas.length !== rels.length) return null;
	return new Map(rels.map((rel, i) => [rel, shas[i]]));
}

/**
 * @typedef {{ sha: string, stat: string }} Entry
 * @typedef {{ trustBefore: bigint | null, entries: Map<string, Entry> }} Snapshot
 */

/** The header line, carrying the racy-stat threshold. */
const HEADER = "#trust-ctime-before ";

/**
 * This session's previous scan, or null where it has none.
 *
 * Null is UNKNOWN, and both an absent snapshot and an unreadable one give it:
 * every session's first Bash call has no previous scan.
 * @param {string} sessionId
 * @returns {Snapshot | null}
 */
function readSnapshot(sessionId) {
	let text;
	try {
		text = fs.readFileSync(core.paths.snapshot(sessionId), "utf8");
	} catch (e) {
		if (caught(e).code !== "ENOENT")
			core.logError(`snapshot read ${sessionId}`, e);
		return null;
	}
	const lines = text.split("\n");
	const head = lines.shift() ?? "";
	let trustBefore = null;
	try {
		trustBefore = BigInt(head.slice(HEADER.length));
	} catch {
		// Unparseable: trust no stat, so the scan hashes everything and
		// compares blob ids (#833).
	}
	const fields = 1 + STAT_FIELDS;
	const entries = new Map();
	for (const line of lines) {
		const parts = line.split(" ");
		const rel = parts.slice(fields).join(" ");
		// A torn last line is simply not carried: the path it would have named
		// reads as new next call, which baselines it.
		if (!rel) continue;
		entries.set(rel, {
			sha: parts[0],
			stat: parts.slice(1, fields).join(" "),
		});
	}
	return { trustBefore, entries };
}

/**
 * Replace this session's snapshot. Best-effort: a scan that cannot save is a scan skipped.
 * @param {string} sessionId
 * @param {Snapshot} snapshot
 */
function writeSnapshot(sessionId, { trustBefore, entries }) {
	const file = core.paths.snapshot(sessionId);
	const lines = [`${HEADER}${trustBefore}`];
	for (const [rel, { sha, stat }] of entries)
		lines.push(`${sha} ${stat} ${rel}`);
	try {
		// Atomic: the reader is this same session on its next Bash call, and a
		// half-written snapshot would read as a tier of new files.
		writeFileAtomic(file, `${lines.join("\n")}\n`, { mkdir: true });
	} catch (e) {
		core.logError(`snapshot write ${sessionId}`, e);
	}
}

/**
 * The tier as `rel -> Entry`, hashing only the files whose stat moved since
 * `before` or which `before` cannot vouch for; null where the hash failed.
 * @param {Map<string, fs.BigIntStats>} files
 * @param {Snapshot | null} before
 */
function currentTier(files, before) {
	const toHash = [];
	for (const [rel, st] of files) {
		const was = before?.entries.get(rel);
		const trusted =
			was !== undefined &&
			before?.trustBefore != null &&
			st.ctimeNs < before.trustBefore &&
			was.stat === statKey(st);
		if (!trusted) toHash.push(rel);
	}
	const hashed = hashPaths(toHash);
	if (hashed === null) return null;
	const now = new Map();
	for (const [rel, st] of files) {
		const sha = hashed.get(rel) ?? before?.entries.get(rel)?.sha;
		if (sha) now.set(rel, { sha, stat: statKey(st) });
	}
	return now;
}

/**
 * The watched paths whose bytes changed since this session's own last scan,
 * capped at SCAN_MINT_MAX — and the snapshot advanced over the ones returned.
 *
 * A path missing from the previous snapshot but present now IS a change: the
 * snapshot covers the whole tier, so absence from one means the file did not
 * exist then. Absence of the snapshot ITSELF is the unknown case, and returns
 * nothing at all.
 *
 * A deletion is not returned. There is nothing left to hash and so nothing to
 * pin, which makes a baseline for it a recovery command that cannot work.
 * @param {string} sessionId
 */
function scanChanged(sessionId) {
	if (!sessionId) return [];
	// Taken before the first lstat: a change this scan misses has a later ctime,
	// so the next scan re-hashes it.
	const trustBefore = BigInt(Date.now() - RACY_MARGIN_MS) * BigInt(1e6);
	const files = readTierFiles();
	if (files === null) return [];
	const before = readSnapshot(sessionId);
	const now = currentTier(files, before);
	if (now === null) return [];
	if (before === null) {
		writeSnapshot(sessionId, { trustBefore, entries: now }); // first call: the tier is unknown, not changed
		return [];
	}
	const changed = [];
	const next = new Map(now);
	for (const [rel, { sha }] of now) {
		const was = before.entries.get(rel);
		if (was?.sha === sha) continue;
		if (changed.length < SCAN_MINT_MAX) changed.push(rel);
		// Over the cap: hold the old hash, unvouched, so the next call re-hashes
		// it and still sees it move.
		else if (was) next.set(rel, { sha: was.sha, stat: NO_STAT });
		else next.delete(rel);
	}
	writeSnapshot(sessionId, { trustBefore, entries: next });
	return changed;
}

module.exports = {
	scanChanged,
	SNAPSHOT_AGE_MS,
};
