/*
 * write-set-cache.js — remembers what each open issue would write, so a
 * re-pick does not pay for the answer twice (mantahostels#385).
 *
 * THE ENTRY IS A PURE FUNCTION OF THE BODY, which is what makes one file per
 * issue safe: last-writer-wins loses nothing. Not a single shared JSON, which is
 * the lost-update shape of mantahostels#128 (two sessions appending to one issue body,
 * the second silently erasing the first).
 *
 * NOTHING HERE IS EVER AN ADMISSION GATE. A write-set is a prediction read off
 * prose, and `scripts/guard-file-claim.sh` stays the enforcement tier.
 *
 * AN ENTRY IS EITHER BAND-READ OR PROVISIONAL (mantahostels#1001). A band-read entry is an
 * agent's judgement of one issue: write-set, size and gist. A provisional one is
 * `lib/write-set-predict.js`'s grep off the same body, written by the selection
 * run itself so that a freshly filed issue is not cold at the next one — it
 * carries `provisional: true`, no size, and a gist that is only the title. The
 * flag is not decoration: `countDerivedSince` refuses to count a provisional
 * entry as a band read, and a later real `put` clears it, because `writeEntry`
 * defaults it false.
 *
 * NOTHING HERE THROWS ON A MALFORMED STORE — a corrupt, absent or unwritable
 * entry is a miss, and a miss costs a band read the run would have paid for
 * anyway. A caller passing a `tracked` of the wrong shape degrades to cold too.
 */

const crypto = require("node:crypto");
const { MARKERS_REL } = require("./marker-root.js");
const fs = require("node:fs");
const nodePath = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { requiredGroup } = require("./regex-group.js");
const { caught } = require("./caught.js");

/**
 * One stored record, and what `lookup` says about it. Each `Lookup` arm spells
 * out the fields the other arms do not carry, so a caller that switches on
 * `state` gets them and one that does not is refused.
 *
 * @typedef {{issue: number, bodyHash: string, derivedAt: string,
 *   writeSet: string[], trackedAtDerive: string[], sizeBand: string|null,
 *   predictedSize: string|null, gist: string|null,
 *   provisional: boolean}} Entry
 * @typedef {{number: number, body?: string|null}} IssueRef
 * @typedef {{ok: true, files: string[]} | {ok: false, files?: undefined}} Tracked
 * @typedef {{state: "cold", entry: null, unrevalidated?: undefined,
 *     promotable?: undefined, gonePaths?: undefined}
 *   | {state: "body-changed", entry: Entry, unrevalidated?: undefined,
 *     promotable?: undefined, gonePaths?: undefined}
 *   | {state: "hit", entry: Entry, unrevalidated?: boolean,
 *     promotable?: string[], gonePaths?: undefined}
 *   | {state: "path-gone", entry: Entry, gonePaths: string[],
 *     unrevalidated?: undefined, promotable?: undefined}} Lookup
 */

/** Gitignored (mantahostels#385). */
const CACHE_SUBDIR = nodePath.join(MARKERS_REL, ".pick-next", "write-sets");

/** @param {string} root */
const cacheDir = (root) => nodePath.join(root, CACHE_SUBDIR);
// `n` is coerced, so a caller passing `"../../etc/passwd"` reads nothing outside
// the store.
/**
 * @param {string} root
 * @param {number|string} n
 */
const entryPath = (root, n) =>
	nodePath.join(cacheDir(root), `${Number(n)}.json`);

/*
 * `updated_at` is unusable as the key — it moves on comments, labels and
 * sub-issue links, over-invalidating by 4.7x (mantahostels#385). The body is the key
 * instead, with ticks flattened first, because `scripts/issue-body.js tick`
 * moves the bytes without changing any file the issue would write.
 */
// Anchored to a list item, because an unanchored `\[[xX]\]` also rewrites the
// markdown link `[x](url)`, making two bodies that differ only there collide.
/** @param {string|null|undefined} body */
const normaliseBody = (body) =>
	String(body ?? "").replace(/^(\s*[-*]\s*)\[[xX]\]/gm, "$1[ ]");

/** @param {string|null|undefined} body */
const bodyHash = (body) =>
	crypto.createHash("sha256").update(normaliseBody(body)).digest("hex");

/**
 * @param {unknown} v
 * @returns {v is string[]}
 */
const isPathList = (v) =>
	Array.isArray(v) && v.every((p) => typeof p === "string");

/*
 * `predictedSize` (mantahostels#1289): `lib/write-set-predict.js`'s coarse small/medium/large
 * guess, carried on a provisional entry ALONGSIDE `sizeBand`, never inside it — see
 * that file for why the two must never merge.
 *
 * READ REJECTS THE WHOLE ENTRY ON A BAD VALUE; WRITE COERCES IT TO NULL. Read
 * follows every other field's rule here: a store entry that disagrees with its
 * own shape is a file someone put there by hand, not one this store wrote, so
 * the safe answer is "cold", not "guess at what they meant" (`readEntry`'s own
 * comment). Write is different on purpose: `predictedSize` is a hint on an
 * otherwise-good entry, never the reason the whole write-set prediction it
 * rides on should be discarded, so an unrecognised value there degrades to
 * "no hint" rather than failing the write.
 */
const PREDICTED_SIZES = ["small", "medium", "large"];

/*
 * Entries written before workflow-core#1494 hold the band under `size`. Reading them as
 * sizeless would drop a paid-for band read out of the merge test. RESIDUAL: an
 * old-key entry no run rewrites keeps `size` on disk, so this stays until the
 * store holds none (`grep -l '"size"'` over `CACHE_SUBDIR`).
 */
/**
 * @param {Entry & {size?: string|null}} e
 * @returns {Entry}
 */
function withSizeBandKey(e) {
	if (e.sizeBand !== undefined || !("size" in e)) return e;
	const { size, ...rest } = e;
	return { ...rest, sizeBand: size ?? null };
}

/**
 * The stored entry for `n`, or null if it is absent, unreadable or malformed.
 *
 * @param {string} root
 * @param {number|string} n
 * @returns {Entry|null}
 */
function readEntry(root, n) {
	let raw;
	try {
		raw = fs.readFileSync(entryPath(root, n), "utf8");
	} catch {
		return null;
	}
	try {
		const e = JSON.parse(raw);
		// The filename is the index, so an entry disagreeing with it is a file
		// someone put there by hand — not a record this store wrote.
		if (!e || e.issue !== Number(n)) return null;
		if (typeof e.bodyHash !== "string" || !e.bodyHash) return null;
		if (!isPathList(e.writeSet)) return null;
		if (e.trackedAtDerive !== undefined && !isPathList(e.trackedAtDerive))
			return null;
		if (e.provisional !== undefined && typeof e.provisional !== "boolean")
			return null;
		if (
			e.predictedSize !== undefined &&
			e.predictedSize !== null &&
			!PREDICTED_SIZES.includes(e.predictedSize)
		)
			return null;
		return withSizeBandKey(e);
	} catch {
		return null;
	}
}

/**
 * Stores one issue's derived write-set. `trackedAtDerive` is the subset of
 * `writeSet` that git tracked at derive time — see `lookup` for what it buys.
 *
 * `derivedAt` is for `promoteTracked` alone, which re-records an entry without
 * re-deriving it. Any other caller passing one backdates a real derive, which
 * is what `countDerivedSince` counts.
 *
 * `provisional` DEFAULTS FALSE, so a band read storing over a prediction clears
 * the flag without knowing the flag exists.
 *
 * @param {string} root
 * @param {{
 *   issue: number,
 *   bodyHash: string,
 *   writeSet?: string[],
 *   trackedAtDerive?: string[],
 *   sizeBand?: string | null,
 *   predictedSize?: string | null,
 *   gist?: string | null,
 *   derivedAt?: string,
 *   provisional?: boolean,
 * }} options
 * @returns {{ok: true, path: string, entry: Entry}
 *   | {ok: false, error: string}}
 */
function writeEntry(
	root,
	{
		issue,
		bodyHash: hash,
		writeSet,
		trackedAtDerive,
		sizeBand,
		predictedSize,
		gist,
		derivedAt,
		provisional,
	},
) {
	const entry = {
		issue: Number(issue),
		bodyHash: String(hash),
		derivedAt: derivedAt ?? new Date().toISOString(),
		writeSet: writeSet ?? [],
		trackedAtDerive: trackedAtDerive ?? [],
		sizeBand: sizeBand ?? null,
		predictedSize:
			predictedSize != null && PREDICTED_SIZES.includes(predictedSize)
				? predictedSize
				: null,
		gist: gist ?? null,
		provisional: provisional === true,
	};
	try {
		// Atomic, because a concurrent picker may be reading this very file.
		const target = entryPath(root, entry.issue);
		writeFileAtomic(target, JSON.stringify(entry), { mkdir: true });
		return { ok: true, path: target, entry };
	} catch (e) {
		return { ok: false, error: String(caught(e).message || e) };
	}
}

/**
 * Is the stored write-set for `issue` still usable? States: `hit`, `cold` (no
 * entry), `body-changed`, `path-gone` (a rename). A hit also carries
 * `unrevalidated` where git could not list the tree, so the rename check never
 * ran — served, but the caller must say so.
 *
 * `tracked` is `pick-next.js`'s `trackedFiles()` result: `{ok, files}`.
 *
 * @param {string} root
 * @param {IssueRef} issue
 * @param {Tracked|null|undefined} tracked
 * @returns {Lookup}
 */
function lookup(root, issue, tracked) {
	const entry = readEntry(root, issue.number);
	if (!entry) return { state: "cold", entry: null };
	if (entry.bodyHash !== bodyHash(issue.body))
		return { state: "body-changed", entry };

	/*
	 * A rename silently invalidates a cached path, so a path git tracked when
	 * the write-set was derived and does not track now means the file moved and
	 * the prediction points at nothing.
	 *
	 * Only that subset is revalidated, plus whatever later promotion has added
	 * to it. A write-set naming a file the issue has yet to create is the normal
	 * shape of feature work, and testing the whole write-set against
	 * `git ls-files` would re-derive every such entry forever.
	 */
	const wasTracked = entry.trackedAtDerive ?? [];
	/*
	 * git could not list the tree, so the rename check has no anchor. The entry
	 * is served anyway, flagged: a prediction is advisory, so the worst a stale
	 * path costs is a wrong hint, while re-deriving costs the band read minutes.
	 */
	if (!tracked?.ok)
		return wasTracked.length > 0
			? { state: "hit", entry, unrevalidated: true }
			: { state: "hit", entry };
	const gonePaths = wasTracked.filter((p) => !tracked.files.includes(p));
	if (gonePaths.length > 0) return { state: "path-gone", entry, gonePaths };
	/*
	 * A predicted path git tracks now is one somebody has since created, so from
	 * here on a rename of it is detectable. Promoting it narrows the derive-time
	 * subset's blind spot without ever re-deriving (mantahostels#385). RESIDUAL: a path
	 * created and renamed between two runs is never seen tracked, so it is
	 * missed exactly as before.
	 */
	const promotable = (entry.writeSet ?? []).filter(
		(p) => !wasTracked.includes(p) && tracked.files.includes(p),
	);
	return promotable.length > 0
		? { state: "hit", entry, promotable }
		: { state: "hit", entry };
}

/**
 * Re-records `entry` with `promotable` added to the paths git tracked, keeping
 * `derivedAt`.
 *
 * Returns what the store now holds, so a caller never reports a promotion that
 * did not land. Two ways it does not: an unwritable store, and a neighbour
 * having re-derived this issue meanwhile — the entry on disk is then keyed on a
 * newer body, and writing this snapshot over it would throw away a band read.
 *
 * @param {string} root
 * @param {Entry} entry
 * @param {string[]} promotable
 * @returns {Entry}
 */
function promoteTracked(root, entry, promotable) {
	if (readEntry(root, entry.issue)?.bodyHash !== entry.bodyHash) return entry;
	const trackedAtDerive = [...(entry.trackedAtDerive ?? []), ...promotable];
	return writeEntry(root, { ...entry, trackedAtDerive }).ok
		? { ...entry, trackedAtDerive }
		: entry;
}

/**
 * Splits `issues` into the warm ones and the ones a band read must still cover.
 * Each cold issue carries the `bodyHash` to store its result back under, so the
 * deriver never recomputes the key.
 *
 * @param {string} root
 * @param {IssueRef[]} issues
 * @param {Tracked|null|undefined} tracked
 */
function lookupAll(root, issues, tracked) {
	/** @type {(Entry & {number: number, unrevalidated: boolean})[]} */
	const warm = [];
	/** @type {{number: number, state: string, bodyHash: string,
	 *   gonePaths: string[]|null}[]} */
	const cold = [];
	for (const i of issues) {
		/** @type {Lookup} */
		let r;
		try {
			r = lookup(root, i, tracked);
		} catch {
			r = { state: "cold", entry: null };
		}
		if (r.state === "hit") {
			const entry = r.promotable
				? promoteTracked(root, r.entry, r.promotable)
				: r.entry;
			warm.push({
				number: i.number,
				...entry,
				// Normalised, so a caller splitting band-read from provisional never
				// has to read an entry written before the flag existed as undefined.
				provisional: entry?.provisional === true,
				unrevalidated: r.unrevalidated === true,
			});
		} else
			cold.push({
				number: i.number,
				state: r.state,
				bodyHash: bodyHash(i.body),
				gonePaths: r.gonePaths ?? null,
			});
	}
	return { warm, cold };
}

/**
 * Drops entries for issues absent from `openNumbers`, and sweeps the scratch
 * files a crash mid-write leaves behind. An empty list prunes nothing: that is
 * the shape of a failed or degraded query, and emptying the store on one would
 * discard every warm entry exactly when the run is worst.
 *
 * Known race, and cheap: an issue opened after this run read the list is pruned
 * here even if a neighbour derived it meanwhile. It costs one re-derive.
 *
 * @param {string} root
 * @param {number[]|null|undefined} openNumbers
 */
function prune(root, openNumbers) {
	if (!openNumbers || openNumbers.length === 0)
		return { ok: true, removed: [] };
	const open = new Set(openNumbers.map(Number));
	let names;
	try {
		names = fs.readdirSync(cacheDir(root));
	} catch {
		// No store yet is the normal first run, not a fault worth reporting.
		return { ok: true, removed: [] };
	}
	/** @type {number[]} */
	const removed = [];
	for (const name of names) {
		if (name.endsWith(".tmp")) {
			try {
				fs.rmSync(nodePath.join(cacheDir(root), name));
			} catch {
				/* already gone, or not ours to remove: the next sweep retries it */
			}
			continue;
		}
		const m = /^(\d+)\.json$/.exec(name);
		if (!m || open.has(Number(m[1]))) continue;
		try {
			fs.rmSync(nodePath.join(cacheDir(root), name));
			removed.push(Number(m[1]));
		} catch {
			// A neighbour pruning the same entry got there first; nothing to report.
		}
	}
	return { ok: true, removed: removed.sort((a, b) => a - b) };
}

const ENTRY_FILE = /^(\d+)\.json$/;

/**
 * How many entries were derived after `since` — the puts the warm-fraction log
 * needs to tell a genuine re-pick from a second record of one run (mantahostels#667).
 *
 * BAND READS ONLY. A provisional entry is written by the selection run itself,
 * every run, for every miss — counting one would make `putsSinceLastRun`
 * non-zero on every line (mantahostels#1001, mantahostels#667).
 *
 * A LOWER BOUND. `prune` deletes the entry of an issue that has since closed,
 * and an entry too corrupt to date is skipped, so a put can go uncounted.
 *
 * `{ok: false}` where there is no instant to count from: calling that zero would
 * assert the store sat still.
 *
 * @param {string} root
 * @param {string|null|undefined} since
 */
function countDerivedSince(root, since) {
	const from = Date.parse(since ?? "");
	if (!Number.isFinite(from)) return { ok: false, count: null };
	let names;
	try {
		names = fs.readdirSync(cacheDir(root));
	} catch {
		// Nothing has been put into a store that does not exist yet.
		return { ok: true, count: 0 };
	}
	let count = 0;
	for (const name of names) {
		const m = ENTRY_FILE.exec(name);
		if (!m) continue;
		const entry = readEntry(root, requiredGroup(m, 1, ENTRY_FILE));
		if (entry?.provisional) continue;
		const at = Date.parse(entry?.derivedAt ?? "");
		if (Number.isFinite(at) && at > from) count += 1;
	}
	return { ok: true, count };
}

module.exports = {
	CACHE_SUBDIR,
	bodyHash,
	cacheDir,
	readEntry,
	writeEntry,
	lookup,
	lookupAll,
	prune,
	countDerivedSince,
};
