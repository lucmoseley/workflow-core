/*
 * doc-map-regions.js — what a claim on docs/doc-map.md is actually taken over.
 *
 * mantahostels#848 ruled, and mantahostels#970 built: the claim gets FINER THAN THE FILE rather than
 * §B being split into more files. One document, many independent regions, so
 * two sessions writing two different `### B<n>` entries never contend.
 *
 * SCOPE IS docs/doc-map.md AND docs/doc-map-classes.json, NOTHING ELSE (mantahostels#848,
 * widened at mantahostels#1848). Every other guarded path stays on the whole-file claim.
 * The sidecar is regioned by JSON key rather than by markdown heading — see
 * `parseJsonKeyRegions`.
 *
 * `A:<path>` IS A SIDECAR ID, AND ONLY A SIDECAR ID (mantahostels#2422). §A of
 * docs/doc-map.md is `derived` and regenerate-only (docs/doc-map.md:26), so a
 * row lock there excludes a hand-editor who cannot exist. The rows are no
 * longer split off on the map, and §A's own `section-a` id is generator-only
 * there — see `isGeneratorOnlyRegion`. On the sidecar, which is authored,
 * `A:<key>` stays exactly as it was.
 *
 * THE REGION VOCABULARY (mantahostels#970):
 *
 *   stamp               the `vN.N · <date>` line, alone. Every editing session
 *                       rewrites it, so inside the head region it would hand
 *                       every session one shared region and return the
 *                       universal contention mantahostels#848 set out to end. It is still
 *                       shared, but for one edit rather than a whole session.
 *   head                everything before the first heading, minus the stamp.
 *   B<n>                one region per `### B<n>` entry, heading to the next
 *                       heading of any depth.
 *   section-b-preamble  §B's own text before B1 — the preamble two live debts
 *                       (mantahostels#894, mantahostels#959) both want, so it is not merged into §B.
 *   A:<path>            ON THE SIDECAR ONLY (mantahostels#2422): one region per JSON key.
 *   capture-and-placement-shed-ledger
 *                       §Capture and placement's `### 5. ` ledger, heading to
 *                       the end of the section (mantahostels#1845).
 *   <slug>              one region per remaining top-level `## ` section.
 *
 * §A IS ONE REGION ON THE MAP (mantahostels#2422). Its rows, its sub-headings, its
 * `| Path | Role | …` headers, its `|---|` separators and its prose all sit in
 * `section-a` together.
 *
 * §CAPTURE AND PLACEMENT SPLITS AT §5 AND NOWHERE ELSE (mantahostels#1845). §5 is an
 * append-only ledger taking an entry from every session that sheds
 * always-loaded bytes. It never splits per `### ` generally: that
 * mints ids for prose sub-parts nobody writes.
 *
 * A REGION ID ALSO KEYS WHAT A CLAIM PINS. `arbiter-store.js` records the
 * region's bytes on claim and reads them back to report a clobber and to test
 * whether a release is dirty, so narrowing an id narrows all three at once.
 *
 * AN ANCHOR ANYWHERE IN §A OF THE MAP RESOLVES TO `section-a`, rows included —
 * so two writes to two different rows contend. Deliberate (mantahostels#2422): §A is
 * regenerated whole from the sidecar, and two hand-editors of two rows is not a
 * case that arises. On the sidecar, where it does, `A:<key>` still separates
 * them.
 *
 * A REGION IS A BYTE RANGE, NOT A NAME. Every offset here indexes the text the
 * caller passed, so a region resolved against one revision of the file must not
 * be reused against another.
 */

/*
 * The `### B<n>` heading. It IS lib/doc-map.js's FIGURE_ID, imported rather than
 * respelled: check-doc-map.js's duplicate-id assertion and this module's
 * allocator have to agree on what an entry heading is, or a malformed `### B190x`
 * counts as B190 for the checker while being invisible to the allocator — which
 * then hands out B190 and manufactures the duplicate the checker fails on.
 */
const { FIGURE_ID: ENTRY_HEADING, jsonStringEnd } = require("./doc-map.js");
const { requiredGroup } = require("./regex-group.js");

/** A `Section <letter>` heading's letter. */
const SECTION_LETTER = /^Section ([A-Za-z])\b/;

/** The version stamp, as check-doc-map.js's parse canary matches it. */
const STAMP_LINE = /^v\d+\.\d+ · /;

/**
 * What marks a region id as a sidecar key. A prefix rather than a bare path, so
 * no path can collide with a `## ` heading's slug.
 */
const ROW_PREFIX = "A:";

/** §A's own id on the map — the whole section (mantahostels#2422). */
const REGISTER_SECTION = "section-a";

/**
 * The `## ` section whose ledger gets a region of its own, the sub-heading that
 * opens that ledger, and the id it takes (mantahostels#1845).
 *
 * The section is named by the id `sectionId` derives for it — its heading
 * truncated at the cap, so only the first 40 characters of that heading are
 * load-bearing, and a rewording inside them stops the split. LEDGER_ID is
 * hand-spelled rather than derived, so it is under that same 40-character cap
 * by convention alone.
 */
const LEDGER_SECTION = "capture-and-placement-where-a-settled";
const LEDGER_HEADING = /^### 5\. /;
const LEDGER_ID = "capture-and-placement-shed-ledger";

/**
 * The class sidecar §1848 built: one JSON key per §A path/wildcard, one region
 * per key — so a session registering one document and a session registering a
 * different one never collide (mantahostels#1848).
 */
const SIDECAR_PATH = "docs/doc-map-classes.json";

/** The map §A is rendered into — the other regioned path. */
const MAP_PATH = "docs/doc-map.md";

/** The paths a claim is taken per-region on (mantahostels#848, mantahostels#1848). */
const REGIONED = new Set([MAP_PATH, SIDECAR_PATH]);

/** @param {string} rel */
function isRegioned(rel) {
	return REGIONED.has(rel);
}

/**
 * Whether `rel#region` is a subject only the §A generator may ask for by name.
 *
 * TRUE FOR §A OF THE MAP AND NOTHING ELSE (mantahostels#2422). Those bytes are rendered
 * from the sidecar by generate-doc-map-section-a.js and hand-edited by nobody,
 * so a claim on them taken deliberately is a session about to do the one thing
 * docs/doc-map.md:26 forbids. `A:<path>` is here as well as `section-a` because
 * the id survives in old claim records: asking for one now earns the same
 * routing message rather than unknownRegionReason's row-slot pass.
 *
 * IT DOES NOT GATE THE WRITE HOOK, which mints a subject from an Edit's anchor
 * rather than from a spelling somebody chose. A write that really does land in
 * §A still takes `section-a` and still pins the bytes it replaces. It is also
 * what keeps §A's own PROSE editable — the preamble and each subsection's
 * paragraphs are hand-written and share this id with the derived rows, so a bar
 * on both routes would bar them.
 * @param {string} rel
 * @param {string} region
 */
function isGeneratorOnlyRegion(rel, region) {
	return (
		rel === MAP_PATH &&
		(region === REGISTER_SECTION || region.startsWith(ROW_PREFIX))
	);
}

/**
 * A `## ` heading spelled as a region id: `Section A — document register`
 * becomes `section-a`, so the id stays short enough to read in a denial and in
 * a lock filename. Anything else is slugged and capped.
 * @param {string} heading
 */
function sectionId(heading) {
	const title = heading.replace(/^#+\s+/, "").trim();
	const section = title.match(SECTION_LETTER);
	if (section)
		return `section-${requiredGroup(section, 1, SECTION_LETTER).toLowerCase()}`;
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (slug.length <= 40) return slug || "section";
	// Over the cap: cut at a word boundary where there is one, so an id truncated
	// mid-word does not read as a typo in the denial that prints it — but cap it
	// either way.
	return (
		slug
			.slice(0, 40)
			.replace(/-[^-]*$/, "")
			.replace(/-+$/, "") || slug.slice(0, 40)
	);
}

/**
 * The sidecar's top-level JSON keys as regions, id'd `A:<key>` — the same id
 * §A's own row-splitting gives that path today, so a claim taken on either the
 * markdown row or the sidecar key resolves to one region (mantahostels#1848).
 *
 * NOT CONTIGUOUS: unlike the markdown parser, the bytes between two entries —
 * the outer braces, the commas, the whitespace — belong to no region. An
 * anchor landing there is honestly unplaceable (`resolveRegion` falls back to
 * the whole file, announced), rather than being handed a region id that would
 * let two sessions editing different keys silently collide over the gap.
 *
 * A small hand-rolled scan rather than `JSON.parse` plus a reviver: neither
 * gives back byte offsets, and offsets are the whole point.
 * @param {string} text
 * @returns {{id: string, start: number, end: number}[]}
 */
function parseJsonKeyRegions(text) {
	/** @type {JsonKeyScan} */
	const scan = {
		found: [],
		depth: 0,
		// True while scanning depth-1 bytes still looking for the NEXT key's
		// opening quote — cleared the instant a key's closing quote is seen, and
		// set again on the `,` or `}` that ends that key's value. Without this a
		// scalar-valued key (its value never opens `{`/`[`) leaves the old
		// `keyStart`/`keyEnd` sitting there, and the following key's own closing
		// quote is then read as a VALUE of the stale key rather than a new key —
		// so the entry after a scalar-valued one silently vanishes, its bytes
		// folded into its predecessor's region (review finding on mantahostels#1848).
		awaitingKey: true,
		keyStart: -1,
		key: null,
		entryStart: -1,
	};

	let i = 0;
	while (i < text.length) i = scanJsonToken(scan, text, i);
	return scan.found;
}

/**
 * @typedef {object} JsonKeyScan
 * @property {{id: string, start: number, end: number}[]} found
 * @property {number} depth
 * @property {boolean} awaitingKey
 * @property {number} keyStart
 * @property {string|null} key
 * @property {number} entryStart
 */

/**
 * Scans the byte at `i`, or the whole string opening there, and returns the
 * offset after it.
 * @param {JsonKeyScan} scan accumulator: the key walk's state, advanced in place
 * @param {string} text
 * @param {number} i
 */
function scanJsonToken(scan, text, i) {
	const ch = text[i];
	if (ch === '"') {
		const end = jsonStringEnd(text, i);
		if (scan.depth === 1 && scan.awaitingKey && scan.key === null) {
			scan.keyStart = i + 1;
			scan.key = text.slice(i + 1, end);
			scan.awaitingKey = false;
		}
		return end + 1;
	}
	if (ch === "{" || ch === "[") {
		if (scan.depth === 1 && scan.key !== null && scan.entryStart === -1)
			scan.entryStart = scan.keyStart - 1;
		scan.depth++;
		return i + 1;
	}
	if (ch === "}" || ch === "]") {
		closeJsonContainer(scan, i);
		return i + 1;
	}
	if (ch === "," && scan.depth === 1) {
		// A scalar-valued entry (its value never opened `{`/`[`) ends here
		// with no region of its own — only an object/array value is a §A
		// row today. Also the reset a value string's own closing quote
		// cannot supply, `awaitingKey` already false by then.
		awaitNextKey(scan);
	}
	return i + 1;
}

/**
 * @param {JsonKeyScan} scan accumulator: depth drops, and a closed entry is pushed onto `found`
 * @param {number} i
 */
function closeJsonContainer(scan, i) {
	scan.depth--;
	if (scan.depth === 1 && scan.key !== null && scan.entryStart !== -1) {
		scan.found.push({
			id: ROW_PREFIX + scan.key,
			start: scan.entryStart,
			end: i + 1,
		});
		awaitNextKey(scan);
	}
}

/** @param {JsonKeyScan} scan accumulator: reset to wait for the next key */
function awaitNextKey(scan) {
	scan.key = null;
	scan.entryStart = -1;
	scan.awaitingKey = true;
}

/**
 * Every region of `text`, in document order, as `{ id, start, end }` character
 * offsets. CONTIGUOUS AND EXHAUSTIVE for `docs/doc-map.md`: the ranges tile the
 * whole document, so every byte of it belongs to exactly one region and an
 * anchor can always be placed. NOT exhaustive for the sidecar — see
 * `parseJsonKeyRegions`.
 * @param {string} text
 * @param {string} [rel] which regioned path `text` was read from. Selects the
 *   JSON-key parser for the sidecar; every other value, including omitted,
 *   keeps today's markdown parsing — so an existing caller that never passes
 *   it is unaffected.
 * @returns {{id: string, start: number, end: number}[]}
 */
function parseRegions(text, rel) {
	if (rel === SIDECAR_PATH) return parseJsonKeyRegions(text);
	const regions = [];
	const end = text.length;
	let offset = 0;
	let current = { id: "head", start: 0, end: 0 };
	// Inside a fenced block nothing is a heading. This document's whole subject
	// is these formats, so it quotes them: an entry quoting a stamp-shaped line
	// would otherwise be split in two, and two sessions editing the halves would
	// hold different regions and never contend — the exact failure the mechanism
	// exists to prevent.
	let fenced = false;
	// Toggled by `## ` headings alone: nothing shallower exists, and a `### `
	// sub-heading is still inside its section. For the one section whose
	// `### 5. ` ledger splits off (mantahostels#1845) — §A does not split at all (mantahostels#2422).
	let awaitingLedger = false;

	/** @param {number} at */
	const close = (at) => {
		current.end = Math.min(at, end);
		if (current.end > current.start) regions.push(current);
	};

	for (const line of text.split("\n")) {
		const lineStart = offset;
		offset += line.length + 1;

		if (/^\s*(```|~~~)/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;

		if (STAMP_LINE.test(line)) {
			close(lineStart);
			regions.push({
				id: "stamp",
				start: lineStart,
				end: Math.min(offset, end),
			});
			current = { id: "head", start: Math.min(offset, end), end: 0 };
			continue;
		}

		const entry = line.match(ENTRY_HEADING);
		if (entry) {
			close(lineStart);
			current = {
				id: requiredGroup(entry, 1, ENTRY_HEADING),
				start: lineStart,
				end: offset,
			};
			continue;
		}

		if (awaitingLedger && LEDGER_HEADING.test(line)) {
			close(lineStart);
			// Cleared, so the ledger runs to the section's end: a second `### 5. `
			// below it would otherwise cut the region in two and hand its halves
			// one id across a gap, which is the shape `resolveRegion`'s
			// endpoint-vs-touched comment refuses.
			awaitingLedger = false;
			current = { id: LEDGER_ID, start: lineStart, end: offset };
			continue;
		}

		if (/^## /.test(line)) {
			close(lineStart);
			const id = sectionId(line);
			awaitingLedger = id === LEDGER_SECTION;
			current = { id: sectionRegionId(id), start: lineStart, end: offset };
		}
	}
	close(end);
	return regions;
}

/**
 * §B's own text before B1 is its own region: two live debts (mantahostels#894,
 * mantahostels#959) both want the preamble, and merging it into §B would put
 * them back in contention with every entry.
 * @param {string} id
 */
function sectionRegionId(id) {
	return id === "section-b" ? "section-b-preamble" : id;
}

/**
 * Every offset `needle` occurs at in `haystack`.
 * @param {string} haystack
 * @param {string} needle
 * @returns {number[]}
 */
function occurrences(haystack, needle) {
	const found = [];
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) return found;
		found.push(at);
		from = at + 1;
		// A pathological anchor (a single space) would otherwise walk the whole
		// file collecting offsets nobody can use.
		if (found.length > 8) return found;
	}
}

/**
 * Which region an edit anchored on `anchor` lands in: `{ region, why }`.
 *
 * `region` is null wherever the answer is not certain, and `why` then says what
 * stopped it — the caller falls back to claiming the file entire and SAYS SO
 * (mantahostels#970: never silently).
 *
 *   no anchor        a Write or a NotebookEdit carries none, so a whole-file
 *                    claim is the honest reading of a whole-file write.
 *   truncated        the guard capped it, so its end — the thing the span test
 *                    reads — is gone.
 *   not found        the anchor is stale, or points at text that has changed.
 *   spans regions    one edit rewriting two regions holds both — `regions`
 *                    names them, and a single anchor spanning a distinct pair
 *                    is claimed as that pair rather than as the whole file
 *                    (mantahostels#1685). It is absent wherever the set is not exact.
 *   ambiguous        several occurrences in different regions (a replace_all,
 *                    or a short anchor).
 * @param {string} text
 * @param {unknown} anchor
 * @param {number} [anchorLength]
 * @param {string} [rel] threaded to `parseRegions` — see its own doc
 * @returns {{region: string|null, why: string|null, regions?: string[]}}
 */
function resolveRegion(text, anchor, anchorLength, rel) {
	if (typeof anchor !== "string" || anchor === "")
		return { region: null, why: "no anchor" };
	// TRUNCATED, so its END is unknown — and the end is the whole of what the
	// spans-regions refusal below reads. A prefix sitting inside B42 says nothing
	// about a tail that rewrites B43, so the honest answer is the whole file.
	if (
		typeof anchorLength === "number" &&
		Number.isFinite(anchorLength) &&
		anchorLength > anchor.length
	)
		return {
			region: null,
			why: `anchor was truncated at ${anchor.length} of ${anchorLength} characters, so where it ends is unknown`,
		};
	const found = parseRegions(text, rel);
	const at = occurrences(text, anchor);
	if (at.length === 0)
		return { region: null, why: "anchor not found in the file" };
	if (at.length > 8)
		return { region: null, why: "anchor occurs too many times to place" };

	const hit = [];
	for (const start of at) {
		const last = Math.max(start + anchor.length - 1, start);
		// Every region the span TOUCHES, not just the two it ends in. `head` is
		// deliberately two ranges, one either side of the stamp, so an anchor
		// running from the title through the stamp line into the preamble has the
		// same id at both ends — and an endpoint test would call it placeable,
		// leaving the write free to rewrite the stamp under a claim that never
		// contends with the stamp's own holder.
		const touched = found.filter((r) => start < r.end && last >= r.start);
		const [first] = touched;
		if (first === undefined)
			return { region: null, why: "anchor could not be placed" };
		if (touched.length > 1) return spansRegions(touched, at.length === 1);
		hit.push(first.id);
	}
	const distinct = [...new Set(hit)];
	if (distinct.length > 1)
		return {
			region: null,
			why: `anchor occurs in ${distinct.length} regions (${distinct.join(", ")})`,
		};
	// Every occurrence either returned above or placed one region.
	const [region] = distinct;
	if (region === undefined)
		throw new Error(`anchor's ${at.length} occurrences placed no region`);
	return { region, why: null };
}

/**
 * `resolveRegion`'s spans-regions refusal for one occurrence touching several
 * regions.
 * @param {{id: string}[]} touched
 * @param {boolean} single whether the anchor occurs exactly once
 * @returns {{region: null, why: string, regions?: string[]}}
 */
function spansRegions(touched, single) {
	const ids = [...new Set(touched.map((r) => r.id))];
	return {
		region: null,
		why: `anchor spans ${touched.map((r) => r.id).join(", ")}`,
		// The one unplaceable arm whose EXTENT is known exactly (mantahostels#1685), so
		// the caller claims these regions rather than the file entire. Held
		// back on a repeated anchor, where which occurrence the edit rewrites
		// is unknown, and on a set of one — an id repeated across two ranges
		// with the stamp between them, where a single-region claim is exactly
		// the endpoint reading the comment in `resolveRegion` refuses.
		...(single && ids.length > 1 ? { regions: ids } : {}),
	};
}

/**
 * A named region's own bytes, or null where the document has no such region.
 *
 * Every range carrying the id, concatenated — `head` is two of them, the title
 * above the stamp and the preamble below it, and a reader of one is entitled to
 * both.
 * @param {string} text
 * @param {string} region
 * @param {string} [rel] threaded to `parseRegions` — see its own doc
 * @returns {string|null}
 */
function regionText(text, region, rel) {
	const found = parseRegions(text, rel).filter((r) => r.id === region);
	if (found.length === 0) return null;
	return found.map((r) => text.slice(r.start, r.end)).join("");
}

/**
 * The next `B<n>` nobody has used, as a number.
 *
 * Above the highest live id and above `mark`, the highest id ever removed
 * (docs/doc-map-high-water.json), never the lowest gap: mantahostels#892 made
 * ids permanent and forbade reusing or renumbering them, and three sidecars key
 * off them (doc-map-restatements.json, -retired-vocabulary.json,
 * -superseded.json), so a gap or a removed top id is not a free slot.
 * @param {string} text
 * @param {number} mark
 */
function nextEntryNumber(text, mark) {
	return (
		entryIds(text).reduce(
			(max, id) => Math.max(max, Number(id.slice(1))),
			mark,
		) + 1
	);
}

/**
 * Every `### B<n>` id in document order, duplicates included.
 *
 * Read off the PARSED regions rather than by scanning lines, so it inherits the
 * parser's fence awareness: a heading quoted inside a code block is an example,
 * not an entry, and counting it would have the allocator hand out an id the
 * document already uses further down.
 * @param {string} text
 */
function entryIds(text) {
	return parseRegions(text)
		.map((r) => r.id)
		.filter((id) => /^B\d+$/.test(id));
}

module.exports = {
	REGISTER_SECTION,
	ROW_PREFIX,
	SIDECAR_PATH,
	entryIds,
	isGeneratorOnlyRegion,
	isRegioned,
	nextEntryNumber,
	parseRegions,
	regionText,
	resolveRegion,
};
