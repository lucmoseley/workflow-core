/*
 * pick-next-band-read.js — what scripts/pick-next.js lays out for the
 * skill's §4 band read, and whether the run needs one at all: a grep
 * prediction stored for each write-set cache miss (mantahostels#1001), every open
 * issue's body on disk with its cache key (mantahostels#409, mantahostels#385), and the
 * band-read-required verdict (mantahostels#1485).
 *
 * The store root and the dump directory are parameters; the cache lookup
 * and the conflict graph are read in pick-next.js and handed in.
 */

const fs = require("node:fs");
const nodePath = require("node:path");
const { parseErrLine } = require("./gh.js");
const writeSetCache = require("./write-set-cache.js");
const writeSetPredict = require("./write-set-predict.js");

/** @typedef {import("./pick-next-collisions.js").TrackedFiles} TrackedFiles */
/** @typedef {import("./pick-next-verdict.js").Issue} Issue */

/**
 * The STORED half of a cache row: what `writeEntry` builds and `readEntry` hands
 * back, in `scripts/lib/write-set-cache.js`.
 *
 * `writeSet` is the one field guaranteed — `readEntry` returns null rather than
 * a row where `isPathList(e.writeSet)` fails. The rest are optional because it
 * validates neither their presence nor their type, so an entry written before a
 * field existed reads as undefined (mantahostels#1460).
 * @typedef {object} StoredEntry
 * @property {string[]} writeSet
 * @property {string|null} [sizeBand]
 * @property {string|null} [gist]
 * @property {string} [derivedAt]
 * @property {string|null} [predictedSize]
 */

/**
 * One cache row as a caller reads it: the stored entry, plus the fields
 * `lookupAll` and `prewarm` hang on it. `number`, `provisional` and
 * `unrevalidated` are set on every row by both; `replaced` is `prewarm`'s alone,
 * written on a provisional row and on nothing else.
 * @typedef {StoredEntry & {number: number, provisional: boolean, unrevalidated: boolean, replaced?: string|null}} CacheEntry
 */

/**
 * A cache miss: the issue, why it missed, and the key to store the band read's
 * answer back under.
 * @typedef {object} CacheMiss
 * @property {number} number
 * @property {string} state
 * @property {string} bodyHash
 * @property {string[]|null} gonePaths
 */

/** @typedef {{warm: CacheEntry[], cold: CacheMiss[]}} CacheSplit */

/**
 * Fills every cache miss with a grep prediction and returns the run's THREE-WAY
 * split — band-read warm, provisional, and the misses no prediction could cover
 * (mantahostels#1001).
 *
 * WHY THIS RUN AND NOT THE NEXT. The prediction is stored AND folded into this
 * run's own split, so the run that discovers a miss is already the run that
 * stops paying for it (mantahostels#1001).
 *
 * `provisional` IS NEVER MERGED INTO `warm`. A band read is an agent's judgement
 * of one issue; this is a regex over its backticks.
 * @param {string} root
 * @param {Issue[]} frontier
 * @param {{ tracked: TrackedFiles, split: CacheSplit, enabled: boolean }} opts
 */
function prewarm(root, frontier, { tracked, split, enabled }) {
	const warm = split.warm.filter((w) => !w.provisional);
	const provisional = split.warm.filter((w) => w.provisional);
	if (!enabled)
		return { warm, provisional, cold: split.cold, skipped: [], enabled };

	const byNumber = new Map(frontier.map((i) => [i.number, i]));
	const cold = [];
	const skipped = [];
	for (const miss of split.cold) {
		const issue = byNumber.get(miss.number);
		const r = issue
			? writeSetPredict.storeProvisional(root, issue, tracked)
			: { ok: false, why: "not on the frontier this run read" };
		if (!r.ok) {
			// Unpredictable or unstorable: it stays cold, and the band read still
			// owns it.
			cold.push(miss);
			skipped.push({ number: miss.number, why: r.why });
			continue;
		}
		/* Cast on `r.entry` alone, so the four fields written here stay checked,
		 * and to `StoredEntry`, which is the half the store returns. Needed
		 * because `storeProvisional`'s `{ok, entry}` union does not narrow on
		 * `r.ok`; true because `writeEntry` builds `writeSet ?? []` on every
		 * entry and hands that same object back (mantahostels#1460).
		 */
		provisional.push({
			number: miss.number,
			.../** @type {StoredEntry} */ (r.entry),
			provisional: true,
			// Freshly derived against the tree this run listed, so the rename check
			// cannot be stale.
			unrevalidated: false,
			// What the prediction was written over: `cold` is a first sighting,
			// anything else a band read this body or this tree has outrun.
			replaced: miss.state,
		});
	}
	return { warm, provisional, cold, skipped, enabled };
}

/**
 * The bodies are already on the list payload, so dumping them costs no request —
 * never add one here (mantahostels#409). A failed dump is reported, never fatal.
 * @param {string} dir
 * @param {{number: number, title: string, body: string}[]} list
 */
function dumpBodies(dir, list) {
	try {
		fs.mkdirSync(dir, { recursive: true });
		for (const i of list)
			fs.writeFileSync(
				nodePath.join(dir, `${i.number}.md`),
				// The cache key rides along so a band read working only from this
				// directory can store its result back without recomputing it (mantahostels#385).
				`# #${i.number} — ${i.title}\n\n<!-- body-hash: ${writeSetCache.bodyHash(i.body)} -->\n\n${i.body}\n`,
			);
		return { ok: true, dir, count: list.length };
	} catch (e) {
		return { ok: false, dir, count: 0, error: parseErrLine(e) };
	}
}

/**
 * §4 of `.claude/skills/pick-next/SKILL.md` band-reads two things: the
 * nominated candidates (sizes that could still change the merge test) and
 * the cold entries (no gist yet). Where neither exists, the whole band-read
 * stage buys nothing, and mantahostels#1485 has the session skip it outright rather than
 * spin up subagents to confirm an empty list. Residual: `graph.mergeable`'s
 * existing pairs (both sides already sized `small`) still merge — this only
 * forecloses a *further* candidate acquiring a size, so a pair beyond that
 * set can never qualify this run
 * (`.claude/skills/pick-next/references/measured-figures.md`: 2 of 5
 * recorded runs hit this empty case — not rare, though 5 runs cannot tell
 * 40% from 10%, mantahostels#1485).
 * @param {{nominated: unknown[]}} graph
 * @param {{cold: unknown[]}} cacheState
 * @returns {boolean}
 */
function bandReadRequiredOf(graph, cacheState) {
	return graph.nominated.length > 0 || cacheState.cold.length > 0;
}

module.exports = { bandReadRequiredOf, dumpBodies, prewarm };
