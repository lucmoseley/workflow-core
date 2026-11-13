/*
 * write-set-predict.js — the grep-derived write-set prediction (mantahostels#1001).
 *
 * WHY IT EXISTS. A newly filed issue is cold at the next `/pick-next`, and a
 * cold issue costs that run a band-read subagent on the critical path of a
 * recommendation meant to land in under two minutes (mantahostels#1001).
 *
 * WHAT IT IS NOT. The band read answers three questions — write-set, size,
 * gist — and this answers one and a half: the write-set off the body's own
 * backticks, and the issue title standing in for a gist. THERE IS NO SIZE, and
 * a caller must never invent one.
 *
 * NOTHING DERIVED HERE MAY REFUSE A CANDIDATE (mantahostels#588), which is what makes its
 * imprecision affordable. It is exact on `docs/doc-map.md` (11/11), whose `§B`
 * hint is itself a write phrase — but NOT on `docs/reference-roadmap.html`:
 * 13 of 22 on the full open population of 22 August 2026, ~59% (mantahostels#1072), the
 * earlier 3/3 having been n=3. A bare path token carries no direction, and this
 * repo's most-discussed file is backticked to say where something was searched
 * or what a gate validates as often as to say what a ticket writes. `docs/doc-map.md`
 * and `CLAUDE.md` (mantahostels#1281) are STAMPs, so a false positive on either
 * disqualifies nobody — 12% writer precision on `CLAUDE.md` is affordable for
 * exactly that reason (mantahostels#1279); the roadmap is not a stamp (mantahostels#1074 ruled it
 * reader-tested per ticket, not path-classified) — its false positives are
 * discounted by the §5 reader test instead.
 *
 * The rules below are §4 of `.claude/skills/pick-next/SKILL.md` in code.
 */

const cache = require("./write-set-cache");
const { requiredGroup } = require("./regex-group.js");

/**
 * @typedef {{ok: true, files: string[]} | {ok: false, error: any}} Tracked
 * @typedef {{body?: string|null, labels?: string[], number?: number, title?: string|null}} Issue
 */

const DOC_MAP = "docs/doc-map.md";
const ROADMAP = "docs/reference-roadmap.html";
const DIGEST = "docs/roadmap-digest.md";

/*
 * A body naming a `§B` entry writes `docs/doc-map.md` at the end of its run,
 * and says so by the entry rather than by a backticked path. `pick-next.js`'s
 * doc-map queue reads this same constant, so the queue it prints and the
 * write-set stored here can never name different issues.
 *
 * `.claude/skills/pick-next/SKILL.md` owns the scoring. Not `§B[0-9]`, whose
 * digit costs recall for no precision, nor
 * `\bB[0-9]{1,2}\b|doc-map`, which flags any body merely naming the file.
 */
const DOC_MAP_HINT = /§B/;

/*
 * A `wayfinder:map` issue's substrate is its own body, not a repo file, so
 * whatever its prose happens to name is not what it would write.
 */
const SKIP_LABEL = "wayfinder:map";

/*
 * PREDICTED SIZE (mantahostels#1289). A provisional entry carries no `sizeBand` — mantahostels#1001's
 * comment above `storeProvisional` explains why that field must stay null:
 * the merge test admits a candidate on `sizeBand === "small"` alone, never on its
 * source, so a grep-derived size there would silently pass as an agent's
 * judgement. `predictedSize` is a SEPARATE field for a narrower question: not
 * "is this small", but "does a band read even need to answer that" — a
 * provisional entry the grep already reads as clearly not-small saves the
 * read `.claude/skills/pick-next/SKILL.md` §4 would otherwise spend finding
 * the same answer. It may only gate whether a band read is dispatched (mantahostels#588's
 * bar on refusing or reordering a candidate is unchanged) and must never be
 * read where `sizeBand` is: `lib/conflict-graph.js`'s merge test reads `sizeBand`
 * alone, and nothing in this file writes that field.
 *
 * CRUDE BY DESIGN. `pathCount` is the predicted write-set's own length;
 * `sectionCount` is markdown headers, a proxy for a ticket describing several
 * sub-changes rather than one; `bodyLength` is the crudest proxy of all,
 * included because a one-paragraph body naming two files is a different
 * ticket from a five-section one naming two.
 *
 * THE THRESHOLDS ARE CALIBRATED AGAINST THIS REPO'S OWN CORPUS: docs/working-contract.md's
 * self-containment rule makes every body here long by convention, so an
 * untuned bodyLength cut can sit below the corpus's whole range — measured
 * 24 August 2026 over 168 open issues (`gh issue list`): bodyLength {p10 1590,
 * p25 2065, p50 2743, p75 4523, p90 14111, min 970}; pathCount {p10 1, p25 2,
 * p50 3, p75 7, p90 13}; sectionCount {p10 0, p25 1, p50 3, p75 5, p90 6}.
 * Large/small floors below sit near the 75th/25th percentile of each signal,
 * not the median, since the merge test only needs a `small` verdict to be
 * occasionally right, not typically right.
 */
const SECTION_ANCHOR = /^#{1,6}\s/gm;
const SMALL_MAX_PATHS = 2;
const SMALL_MAX_BODY_LENGTH = 2000;
const LARGE_MIN_PATHS = 7;
const LARGE_MIN_BODY_LENGTH = 12_000;
const LARGE_MIN_SECTIONS = 5;

/**
 * `small` | `medium` | `large` off the three signals above. Never `null`.
 * @param {{bodyLength: number, pathCount: number, sectionCount: number}} signals
 */
function predictedSizeOf({ bodyLength, pathCount, sectionCount }) {
	if (
		pathCount >= LARGE_MIN_PATHS ||
		bodyLength >= LARGE_MIN_BODY_LENGTH ||
		sectionCount >= LARGE_MIN_SECTIONS
	)
		return "large";
	if (
		pathCount <= SMALL_MAX_PATHS &&
		bodyLength < SMALL_MAX_BODY_LENGTH &&
		sectionCount === 0
	)
		return "small";
	return "medium";
}

/*
 * A token resolves to an exact tracked path, or failing that to the one tracked
 * file ending with it on a path boundary — which is what lets a body write
 * `session-arbiter.js`, as the real ones do, rather than the full path. Exact
 * wins first, or a root `README.md` would lose to the nested ones. A directory
 * never resolves either: git lists files only.
 */
/** @param {string} token @param {string[]} files */
const resolveToken = (token, files) => {
	if (files.includes(token)) return token;
	const hits = files.filter((f) => f.endsWith(`/${token}`));
	return hits.length === 1 ? hits[0] : null;
};

const BACKTICK_SPAN = /`([^`\n]+)`/g;

/**
 * Repo paths named in inline backticks in `body`, sorted, deduped.
 * @param {string|null|undefined} body
 * @param {string[]} files
 */
function pathsNamedIn(body, files) {
	const found = new Set();
	// A backticked span may be a whole command line, so every word is a candidate.
	for (const span of String(body || "").matchAll(BACKTICK_SPAN))
		for (const token of requiredGroup(span, 1, BACKTICK_SPAN)
			.trim()
			.split(/\s+/)) {
			const hit = token && resolveToken(token, files);
			if (hit) found.add(hit);
		}
	return [...found].sort();
}

/**
 * The write-set an issue is predicted to touch, or `{ok: false}` with the reason
 * no prediction may be made for it.
 *
 * `tracked` is `pick-next.js`'s `readTrackedFiles()` result: `{ok, files}`.
 * @param {Issue} issue
 * @param {Tracked} tracked
 */
function predict(issue, tracked) {
	if (!tracked?.ok)
		return { ok: false, why: "git could not list the tree", writeSet: [] };
	if ((issue?.labels ?? []).includes(SKIP_LABEL))
		return {
			ok: false,
			why: `${SKIP_LABEL} — its substrate is its own issue body`,
			writeSet: [],
		};

	const set = new Set(pathsNamedIn(issue?.body, tracked.files));
	if (DOC_MAP_HINT.test(String(issue?.body ?? ""))) set.add(DOC_MAP);
	/*
	 * The roadmap pair is one unit, named in either direction (mantahostels#1075: 172 of 172
	 * commits touching the digest also touch the roadmap, none solo). Naming the
	 * roadmap writes the digest because `roadmap-edit` regenerates it; naming the
	 * digest alone means the roadmap edit that regenerates it: this digest is
	 * nobody's deliverable. Not a rule about the `derived` class — mantahostels#1075 refused
	 * that, `docs/operating-manual.md` being a `manual-sync` session's whole
	 * deliverable one class over.
	 */
	if (set.has(ROADMAP) || set.has(DIGEST)) {
		set.add(ROADMAP);
		set.add(DIGEST);
	}

	const writeSet = [...set].sort();
	return {
		ok: true,
		why: null,
		writeSet,
		predictedSize: predictedSizeOf({
			bodyLength: String(issue?.body ?? "").length,
			pathCount: writeSet.length,
			sectionCount: (String(issue?.body ?? "").match(SECTION_ANCHOR) || [])
				.length,
		}),
	};
}

/**
 * Derives a provisional entry for one issue the cache missed and stores it.
 *
 * Returns `{ok: true, entry}`, or `{ok: false, why}` where no prediction may be
 * made or the store refused the write. Never throws: a selection run must not
 * fail because a prediction could not be filed.
 *
 * IT CARRIES NOTHING FORWARD FROM THE ENTRY IT REPLACES, a superseded band
 * read's size and gist included. Keeping the size was tried and reverted: the
 * merge test admits a candidate on `sizeBand === "small"` alone, never on its
 * source, so one carried size silently puts a grep-derived write-set into a test
 * that assumes an agent judged it. `provisional` therefore means `sizeBand: null`
 * without exception, which is what every surface reporting one may assert.
 * @param {string} root
 * @param {Issue} issue
 * @param {Tracked} tracked
 */
function storeProvisional(root, issue, tracked) {
	// Unconfirmed whether a real caller can reach this: nothing here guarantees
	// `issue.number`, only `Issue`'s own optional typedef (mantahostels#1464).
	if (typeof issue?.number !== "number")
		return { ok: false, why: "issue carries no number" };
	const p = predict(issue, tracked);
	if (!p.ok) return { ok: false, why: p.why };
	// predict() only succeeds where tracked.ok, but that guard lives in its own
	// scope — repeated here so `tracked.files` below is narrowed rather than
	// defended with a fallback that can never fire.
	if (!tracked.ok) return { ok: false, why: "git could not list the tree" };

	let hash;
	try {
		hash = cache.bodyHash(issue?.body);
	} catch (e) {
		return { ok: false, why: e instanceof Error ? e.message : String(e) };
	}

	const r = cache.writeEntry(root, {
		issue: issue?.number,
		bodyHash: hash,
		writeSet: p.writeSet,
		// Same rule as a band read's: only the predicted paths git tracks now,
		// which is what lets a later lookup tell a rename from a file the issue
		// has yet to create.
		trackedAtDerive: p.writeSet.filter((f) => tracked.files.includes(f)),
		sizeBand: null,
		predictedSize: p.predictedSize,
		// The one gist available without reading the body.
		gist: issue?.title ? String(issue.title) : null,
		provisional: true,
	});
	return r.ok ? { ok: true, entry: r.entry } : { ok: false, why: r.error };
}

module.exports = {
	DIGEST,
	DOC_MAP_HINT,
	pathsNamedIn,
	predict,
	storeProvisional,
};
