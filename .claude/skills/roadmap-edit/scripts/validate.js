#!/usr/bin/env node
/*
 * validate.js — integrity check for reference-roadmap.html
 *
 * Two layers, deliberately separated (mantahostels#696): `validateRoadmap(html, original)`
 * holds every check and returns a structured result; the command line below it
 * only reads files, formats that result and picks an exit code. An in-process
 * caller — a commit-time gate — gets the verdict as data, so it never has to
 * parse this report's prose and the two callers cannot disagree about what
 * "valid" means.
 *
 * Usage:  node validate.js <path-to-roadmap.html> [--original <path>]
 *
 * Extracts the ITEMS and AREAS arrays WITHOUT executing the page's render
 * code (which would call the DOM and throw under Node), then runs every
 * structural check the document depends on. Exit code 0 = clean, 1 = errors.
 * Also reads `.claude/workflow-core.json` at the host root, if present, for
 * the VERSION TRIPWIRE's pin (`resolveExpectedMajor()`, #54).
 *
 * If --original is supplied, also prints a scope summary: which card ids were
 * added or removed vs the original, so you can confirm the edit touched only
 * what you intended, and the CARD SHAPE warning on any `b`, `mn`, `c.x`, `log`
 * or `dw` this edit touched while over that field's word ceiling (mantahostels#2979, mantahostels#3187,
 * mantahostels#3190, mantahostels#3335).
 * Two further checks run unconditionally, `--original` or not, since both
 * read only the current file: STALE EXEMPTION and MALFORMED EXEMPTION on
 * `capOk` (mantahostels#3189).
 *
 * --original has NO default path, deliberately: guessing a snapshot location
 * would mean silently diffing against a stale file. The two cases are therefore
 * kept sharply apart, and this script refuses to guess between them:
 *   - omitted            -> the scope diff is skipped, and that is fine
 *   - supplied, unreadable -> FATAL, non-zero exit. It used to be a warning,
 *     which meant a typo'd or vanished baseline silently removed the only
 *     safeguard against a mis-targeted card edit while still exiting 0.
 */

const fs = require("node:fs");
const { writeFd } = require("../../../../scripts/lib/write-fd.js");
const path = require("node:path");
const { hostRoot } = require("../../../../scripts/lib/host-root.js");
const { requiredGroup } = require("../../../../scripts/lib/regex-group.js");
const { caught } = require("../../../../scripts/lib/caught.js");

/**
 * One roadmap card, as the HTML's own `ITEMS` literal spells it. Every field
 * is optional because the checks below are what establish they are there.
 *
 * @typedef {{id?: string, t?: string, p?: number, kind?: string, state?: string,
 *   a?: string[], b?: string, mn?: string, log?: string, needs?: string[],
 *   m?: unknown, c?: {k?: string, x?: string}, why?: string, dw?: string,
 *   capOk?: Record<string, unknown>, _idx?: number}} Card
 * @typedef {{major: number, minor: number, date: string, raw: string}} Version
 */

// --- SCHEMA PIN ---------------------------------------------------------
// The exact set of fields this validator knows how to check, as of the last
// time this script was reviewed against the roadmap. Update BOTH of these
// deliberately whenever you add/remove/rename a field or bump the roadmap's
// MAJOR version.
const KNOWN_ITEM_FIELDS = new Set([
	"id",
	"p",
	"a",
	"kind",
	"state",
	"t",
	"m",
	"mn",
	"b",
	"c",
	"log",
	"needs",
	"span",
	"focus",
	"why",
	"dw",
	"capOk",
]);
const KNOWN_CALLOUT_FIELDS = new Set(["type", "k", "x"]);
// Below this many cards a known field no card uses is the roadmap being small,
// not the field being retired — a day-one adopter's empty or two-card roadmap
// would warn on nearly every field (mantahostels#3519). 25 is a first guess, not
// a measurement: under it a single card can be a field's only user.
const DROPPED_FIELD_MIN_CARDS = 25;
// The roadmap MAJOR version this validator was last confirmed correct against.
// A MAJOR bump signals a structural change (schema/field/render-logic) per
// the roadmap's own MODEL/EFFORT-adjacent versioning rule — bump this the
// same time you re-review the checks below against the new structure.
// Prior MAJOR bumps' changes: git log on this constant, not inlined here.
// Each host numbers its own roadmap, so this is the core's own roadmap's
// major; an adopter's comes from its config (resolveExpectedMajor below).
// v1: the core's roadmap, reviewed at #1602 — the ITEMS/AREAS shape
// mantahostels v7 left, so every check below carries over unchanged.
const EXPECTED_MAJOR = 1;

/**
 * The pin the VERSION TRIPWIRE checks against: the core's own EXPECTED_MAJOR
 * above, unless the repo running this script carries an adopter config with
 * its own `roadmapMajorPin` — set at `init-adopter.js` time to that repo's
 * own day-one roadmap major (#54).
 *
 * `root` defaults to `hostRoot()` — reading `.claude/workflow-core.json` there
 * rather than at `process.cwd()`, so a caller isolating this in a test injects
 * `root` directly instead of `process.chdir`-ing around `hostRoot()`'s own
 * `CLAUDE_PROJECT_DIR` precedence.
 *
 * `isAdopterOwned` is carried on the return rather than inferred from the
 * major's VALUE at the call site — an adopter's own pin can coincidentally
 * equal `EXPECTED_MAJOR`, and a value comparison would then misreport it as
 * the core's own unset pin.
 * @param {string[]} warnings accumulator: a pin that cannot be read is warned here
 * @param {string} [root]
 * @returns {{ major: number, isAdopterOwned: boolean }}
 */
function resolveExpectedMajor(warnings, root = hostRoot()) {
	const configPath = path.join(root, ".claude", "workflow-core.json");
	const fallback = { major: EXPECTED_MAJOR, isAdopterOwned: false };
	let raw;
	try {
		raw = fs.readFileSync(configPath, "utf8");
	} catch (err) {
		if (caught(err).code !== "ENOENT") {
			warnings.push(
				"VERSION TRIPWIRE PIN: .claude/workflow-core.json could not be read " +
					`(${caught(err).message}) — falling back to the core's ` +
					`own EXPECTED_MAJOR (${EXPECTED_MAJOR}).`,
			);
		}
		return fallback;
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		warnings.push(
			"VERSION TRIPWIRE PIN: .claude/workflow-core.json does not parse " +
				`(${caught(err).message}) — falling back to the core's ` +
				`own EXPECTED_MAJOR (${EXPECTED_MAJOR}).`,
		);
		return fallback;
	}
	if (parsed === null || typeof parsed !== "object") {
		warnings.push(
			"VERSION TRIPWIRE PIN: .claude/workflow-core.json does not hold an " +
				`object — falling back to the core's own EXPECTED_MAJOR (${EXPECTED_MAJOR}).`,
		);
		return fallback;
	}
	if (!("roadmapMajorPin" in parsed)) return fallback;
	if (typeof parsed.roadmapMajorPin === "number")
		return { major: parsed.roadmapMajorPin, isAdopterOwned: true };
	warnings.push(
		`VERSION TRIPWIRE PIN: .claude/workflow-core.json's roadmapMajorPin is ` +
			`not a number — falling back to the core's own EXPECTED_MAJOR (${EXPECTED_MAJOR}).`,
	);
	return fallback;
}

/* Word ceiling for a card body, over which an edited body warns. Set above the
 * ordinary card and below the essay on the live distribution (mantahostels#2979). */
const BODY_WORD_CEILING = 250;

/* `why`'s hard cap (mantahostels#3186, mantahostels#3193) — an ERROR on presence, unlike every
 * ceiling below, which warns only on an edit to its field: there is no
 * "original" a first-time `why` can be compared against. */
const WHY_WORD_CEILING = 40;

/* `dw`'s touch-gated WARN ceiling (mantahostels#3190), an entry in FIELD_WORD_CEILINGS
 * below and named here because dw's absence is also checked (ERROR, per-card,
 * not touch-gated) in the per-card loop, which the other three fields never
 * are. */
const DW_WORD_CEILING = 60;

/* The same proxy on the other fields SKILL.md §What a card holds governs,
 * each set near its field's p85; the distribution is on mantahostels#3187.
 * `read` guards its own field — many cards carry no `c` and most no `log`, and
 * this check runs inside the pre-commit gate, so a throw here refuses every
 * roadmap commit. The body's ceiling above stays a branch of its own rather
 * than a fourth entry here because its `note` sends the reader to SKILL.md,
 * which rules ADMISSIBILITY, where these three send them to FIELDS.md, which
 * rules PLACEMENT. */
const FIELD_WORD_CEILINGS = [
	{
		field: "mn",
		ceiling: 30,
		/** @param {Card} c */
		read: (c) => c.mn,
		note:
			"`mn`'s subject is the `m` choice and the execution surface — a builder " +
			"guardrail belongs in `b`.",
	},
	{
		field: "c.x",
		ceiling: 80,
		/** @param {Card} c */
		read: (c) => c.c?.x,
		note:
			"A callout states one situation and what to do about it — not the argument " +
			"for the card's existence, which goes to the card's issue.",
	},
	{
		field: "log",
		ceiling: 80,
		/** @param {Card} c */
		read: (c) => c.log,
		note:
			"A log is one to two sentences: the outcome plus what it means for what to " +
			"do next.",
	},
	{
		field: "dw",
		ceiling: DW_WORD_CEILING,
		/** @param {Card} c */
		read: (c) => c.dw,
		note:
			"A done-when/start-when is the completion condition, not a second body — a " +
			"builder guardrail belongs in `b`.",
	},
];

/* The four fields a `capOk` exemption may name — exactly the ceilinged fields
 * this validator enforces (dw excluded: mantahostels#3498 ruled an over-ceiling dw is
 * always cut, its surplus relocated into `b`), derived from
 * FIELD_WORD_CEILINGS/BODY_WORD_CEILING rather than re-typed, so STALE
 * EXEMPTION and CARD SHAPE can never judge a field against two different
 * numbers. */
const CEILING_BY_FIELD = Object.fromEntries(
	FIELD_WORD_CEILINGS.map((f) => [f.field, f]),
);
/** @param {string} field */
function ceilingOf(field) {
	const entry = CEILING_BY_FIELD[field];
	if (entry === undefined)
		throw new Error(`FIELD_WORD_CEILINGS has no "${field}" entry`);
	return entry.ceiling;
}
/** @type {Record<string, number>} */
const CAPPED_FIELD_CEILINGS = {
	b: BODY_WORD_CEILING,
	mn: ceilingOf("mn"),
	"c.x": ceilingOf("c.x"),
	log: ceilingOf("log"),
};

/**
 * A `capOk` value that names an issue: a positive integer. MALFORMED EXEMPTION
 * and the CARD SHAPE silence both read it, so a malformed entry never silences.
 * @param {unknown} v
 */
function isCapOkIssue(v) {
	return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * Read a `capOk`-ceilinged field off a card by its capOk key ("b", "mn",
 * "c.x" or "log") — the same four labels CAPPED_FIELD_CEILINGS carries.
 * @param {Card} c
 * @param {string} key
 */
function readCappedField(c, key) {
	if (key === "b") return c.b;
	return CEILING_BY_FIELD[key]?.read(c);
}

/**
 * Words in a card body, HTML tags and entities stripped so markup is not counted
 * as prose.
 * @param {unknown} b
 * @returns {number}
 */
function bodyWords(b) {
	if (typeof b !== "string") return 0;
	return b
		.replace(/<[^>]*>/g, " ")
		.replace(/&[a-zA-Z]+;|&#\d+;/g, " ")
		.split(/\s+/)
		.filter(Boolean).length;
}
// -------------------------------------------------------------------------

// --- reliable extraction of a top-level `const NAME = [...]` or `{...}` block ---
/**
 * @param {string} html
 * @param {string} decl
 * @param {string} closeSeq
 * @returns {string}
 */
function extractBlock(html, decl, closeSeq) {
	const start = html.indexOf(decl);
	if (start === -1) throw new Error(`could not find "${decl}"`);
	const end = html.indexOf(closeSeq, start);
	if (end === -1)
		throw new Error(`could not find closing "${closeSeq}" after "${decl}"`);
	return html.slice(start, end + closeSeq.length);
}

/**
 * `{ ITEMS, AREAS, version }` out of a roadmap blob, by slicing the two literals
 * and evaluating only those through `new Function` — running the whole page in
 * Node calls the DOM and throws.
 *
 * **THROWS on anything that is not a roadmap**, rather than returning an empty
 * ITEMS: callers diff two blobs' card states, and an empty side reads as every
 * card having just changed.
 *
 * @param {string} html
 * @returns {{ITEMS: Card[], AREAS: Record<string, unknown>,
 *   version: Version|null}}
 */
function parseRoadmap(html) {
	// ITEMS: `const ITEMS = [ ... \n];`
	const itemsBlock = extractBlock(html, "const ITEMS = [", "\n];");
	// AREAS: `const AREAS = { ... };`  (single-line-ish object literal)
	const areasBlock = extractBlock(html, "const AREAS = {", "};");
	const items = new Function(`${itemsBlock}\nreturn ITEMS;`)();
	const areas = new Function(`${areasBlock}\nreturn AREAS;`)();
	// version marker — since v5.0 the docmeta line carries date AND time
	// (D Month YYYY, HH:MM, founder's local time zone, Lombok/WITA UTC+8).
	// The capture group below is deliberately unbounded ([^<]+) so it swallows
	// whatever's in there — no regex change was needed when time was added,
	// and none should be needed for similar cosmetic changes to this string.
	const versionLine = /class="docmeta">v(\d+)\.(\d+)\s*·\s*updated ([^<]+)</;
	const verMatch = html.match(versionLine);
	let version = null;
	if (verMatch) {
		const major = requiredGroup(verMatch, 1, versionLine);
		const minor = requiredGroup(verMatch, 2, versionLine);
		version = {
			major: +major,
			minor: +minor,
			date: requiredGroup(verMatch, 3, versionLine).trim(),
			raw: `v${major}.${minor}`,
		};
	}
	return { ITEMS: items, AREAS: areas, version };
}
/* Typed over `unknown`: the question each asks is whether a card's field —
 * which may be missing — is one of these, not whether a string is. */
/** @type {Set<unknown>} */
const VALID_STATES = new Set(["active", "open", "parked", "done"]);
/** @type {Set<unknown>} */
const VALID_KINDS = new Set(["action", "decision", "reference", "watchout"]);

const VALID_M_CODES = new Set(["max", "—"]);
const M_CODE_REMEDY =
	"closed set: max, —, no m at all, or a leg-scoped [step,max] pair — docs/effort-guide.md";

/**
 * Check 1: each card by id, the first holder of a repeated id kept.
 * @param {Card[]} items
 * @param {string[]} errors accumulator: a missing or repeated id is pushed here
 * @returns {Record<string, Card & {_idx: number}>}
 */
function indexById(items, errors) {
	/** @type {Record<string, Card & {_idx: number}>} */
	const byId = {};
	items.forEach((it, i) => {
		if (!it.id) {
			errors.push(`card #${i} ("${it.t || "?"}") has no id`);
			return;
		}
		if (byId[it.id]) errors.push(`duplicate id "${it.id}"`);
		else byId[it.id] = { ...it, _idx: i };
	});
	return byId;
}

/**
 * @param {Card} it
 * @param {Record<string, unknown>} areas
 * @param {string[]} errors accumulator: a missing or undefined area is pushed here
 */
function checkCardAreas(it, areas, errors) {
	if (!Array.isArray(it.a) || it.a.length === 0)
		errors.push(`"${it.id}" has no area array`);
	else
		for (const a of it.a)
			if (!areas[a]) errors.push(`"${it.id}" uses undefined area "${a}"`);
}

/**
 * @param {Card} it
 * @param {string[]} errors accumulator: an over-long `why` is pushed here
 */
function checkCardWhy(it, errors) {
	// why is optional, but a present one is hard-capped (mantahostels#3186, mantahostels#3193)
	if (it.why !== undefined) {
		const whyWords = bodyWords(it.why);
		if (whyWords > WHY_WORD_CEILING)
			errors.push(
				`"${it.id}" why is ${whyWords} words, over the ${WHY_WORD_CEILING}-word cap — trim to one or two sentences of direction-under-consideration plus what the card unlocks.`,
			);
	}
}

/**
 * @param {Card} it
 * @param {Record<string, unknown>} areas
 * @param {string[]} errors accumulator: a bad phase, kind, state or log is pushed here
 */
function checkCardFields(it, areas, errors) {
	if (it.p === undefined || it.p < 0 || it.p > 4)
		errors.push(`"${it.id}" has bad phase p=${it.p}`);
	if (!VALID_KINDS.has(it.kind))
		errors.push(`"${it.id}" has bad kind "${it.kind}"`);
	if (!VALID_STATES.has(it.state))
		errors.push(`"${it.id}" has bad state "${it.state}"`);
	checkCardAreas(it, areas, errors);
	// done cards must carry a log (action guide -> the forward pointer lives there)
	if (it.state === "done" && !it.log)
		errors.push(`done card "${it.id}" has no log`);
	// non-done cards must carry dw (mantahostels#3190)
	if (it.state !== "done" && !it.dw)
		errors.push(
			`"${it.id}" is non-done and has no dw (done-when/start-when) — every non-done card must carry one.`,
		);
	checkCardWhy(it, errors);
}

/**
 * @param {Card} it
 * @param {number} idx the card's index in ITEMS
 * @param {Record<string, Card & {_idx: number}>} byId
 * @param {string[]} errors accumulator: a missing or later-phase need is pushed here
 */
function checkNeeds(it, idx, byId, errors) {
	for (const n of it.needs || []) {
		const dep = byId[n];
		if (!dep) {
			errors.push(`"${it.id}" needs missing id "${n}"`);
			continue;
		}
		/* Read into locals and tested for absence: a card missing its phase
		 * compared false on every `>` before, and still does. */
		const depP = dep.p;
		const itP = it.p;
		if (depP !== undefined && itP !== undefined && depP > itP)
			errors.push(`"${it.id}" (P${it.p}) needs "${n}" in later P${dep.p}`);
		else if (depP === itP && dep._idx > idx)
			errors.push(
				`"${it.id}" appears before its same-phase prerequisite "${n}" (breaks execution order)`,
			);
	}
}

/**
 * @param {Card} it
 * @param {string[]} warnings accumulator: a bad model field is warned here
 */
function checkModelField(it, warnings) {
	if (!("m" in it)) return;
	const m = it.m;
	if (typeof m === "string") {
		if (!VALID_M_CODES.has(m))
			warnings.push(
				`"${it.id}" has unrecognised m code "${m}" — ${M_CODE_REMEDY}`,
			);
	} else if (Array.isArray(m)) {
		for (const pair of m)
			if (!Array.isArray(pair) || pair[1] !== "max")
				warnings.push(
					`"${it.id}" has bad leg-scoped m entry ${JSON.stringify(pair)} — a leg-scoped pair's tier must be "max"`,
				);
	} else {
		warnings.push(
			`"${it.id}" has malformed m field: ${JSON.stringify(m)} — ${M_CODE_REMEDY}`,
		);
	}
}

/**
 * @param {Card} it
 * @param {string[]} warnings accumulator: a malformed or stale capOk exemption is warned here
 */
function checkCapOk(it, warnings) {
	if (!it.capOk) return;
	for (const [key, issueNum] of Object.entries(it.capOk)) {
		const ceiling = CAPPED_FIELD_CEILINGS[key];
		if (ceiling === undefined) {
			warnings.push(
				`MALFORMED EXEMPTION: "${it.id}" capOk key "${key}" is not one of the ceilinged fields (${Object.keys(CAPPED_FIELD_CEILINGS).join(", ")}).`,
			);
			continue;
		}
		if (!isCapOkIssue(issueNum)) {
			warnings.push(
				`MALFORMED EXEMPTION: "${it.id}" capOk.${key} value ${JSON.stringify(issueNum)} is not a positive integer issue number.`,
			);
			continue;
		}
		const words = bodyWords(readCappedField(it, key));
		if (words <= ceiling) {
			warnings.push(
				`STALE EXEMPTION: "${it.id}" capOk.${key} (#${issueNum}) names a field now at ${words} words, at or under its ${ceiling}-word ceiling — drop the exemption or re-confirm it still applies.`,
			);
		}
	}
}

/**
 * @param {Card[]} items
 * @param {string[]} warnings accumulator: schema drift is warned here
 */
function checkSchemaDrift(items, warnings) {
	const seenItemFields = new Set();
	const seenCalloutFields = new Set();
	for (const it of items) {
		for (const k of Object.keys(it)) seenItemFields.add(k);
		if (it.c) for (const k of Object.keys(it.c)) seenCalloutFields.add(k);
	}
	const newItemFields = [...seenItemFields].filter(
		(k) => !KNOWN_ITEM_FIELDS.has(k),
	);
	const droppedItemFields = [...KNOWN_ITEM_FIELDS].filter(
		(k) => !seenItemFields.has(k),
	);
	const newCalloutFields = [...seenCalloutFields].filter(
		(k) => !KNOWN_CALLOUT_FIELDS.has(k),
	);
	if (newItemFields.length > 0) {
		warnings.push(
			`SCHEMA DRIFT: card field(s) not in KNOWN_ITEM_FIELDS: ${newItemFields.join(", ")}. ` +
				`This isn't necessarily wrong — it may be a legitimate new field — but it means ` +
				`validate.js hasn't been reviewed against it yet. Re-check whether it needs a rule ` +
				"(sanity check, ordering, required-on-state), then add it to KNOWN_ITEM_FIELDS.",
		);
	}
	if (droppedItemFields.length > 0 && items.length >= DROPPED_FIELD_MIN_CARDS) {
		warnings.push(
			`SCHEMA DRIFT: known field(s) no longer used anywhere: ${droppedItemFields.join(", ")}. ` +
				"Confirm this is intentional (a field was retired) rather than a one-off card that " +
				"happened to be the only user, then remove it from KNOWN_ITEM_FIELDS.",
		);
	}
	if (newCalloutFields.length > 0) {
		warnings.push(
			`SCHEMA DRIFT: callout (c) field(s) not in KNOWN_CALLOUT_FIELDS: ${newCalloutFields.join(", ")}.`,
		);
	}
}

/**
 * @param {Version | null} version
 * @param {{ expectedMajor?: number, root?: string }} options
 * @param {string[]} warnings accumulator: an unreadable pin or a major other than it is warned here
 */
function checkVersionTripwire(version, options, warnings) {
	const { major: expectedMajor, isAdopterOwned: pinIsAdopterOwned } =
		typeof options.expectedMajor === "number"
			? { major: options.expectedMajor, isAdopterOwned: true }
			: resolveExpectedMajor(warnings, options.root);
	if (version && version.major !== expectedMajor) {
		warnings.push(
			`VERSION TRIPWIRE: roadmap is v${version.major}.x, validator was last reviewed against ` +
				`v${expectedMajor}.x. A MAJOR bump means a structural change happened — re-read ` +
				"validate.js against the current ITEMS/AREAS shape, update the roadmap-edit skill if " +
				`needed, then set ${
					pinIsAdopterOwned
						? "this repo's `roadmapMajorPin` in .claude/workflow-core.json"
						: "EXPECTED_MAJOR at the top of validate.js"
				} to ${version.major} once you've confirmed it's still correct.`,
		);
	}
}

/**
 * @param {Version} version
 * @param {string[]} errors accumulator: a stamp in the future is pushed here
 * @param {string[]} warnings accumulator: an unreadable or misdated stamp is warned here
 * @param {boolean} judgeDay whether a stamp from an earlier day warns
 */
function checkStamp(version, errors, warnings, judgeDay) {
	const witaOffsetMs = 8 * 3_600_000; // Lombok, UTC+8, no DST
	const restampHint = "restamp with: TZ=Asia/Makassar date '+%-d %B %Y, %H:%M'";
	const months = [
		"January",
		"February",
		"March",
		"April",
		"May",
		"June",
		"July",
		"August",
		"September",
		"October",
		"November",
		"December",
	];
	const stampPattern = /^(\d{1,2}) (\w+) (\d{4}), (\d{1,2}):(\d{2})$/;
	const m = version.date.match(stampPattern);
	const mi = m ? months.indexOf(requiredGroup(m, 2, stampPattern)) : -1;
	/** @param {number} ms */
	const witaDay = (ms) =>
		new Date(ms + witaOffsetMs).toISOString().slice(0, 16).replace("T", " ");
	/* `mi` is -1 whenever the match failed, so naming `m` here is what says
	 * the branch below has one. */
	if (!m || mi === -1) {
		warnings.push(
			`STAMP UNREADABLE: "${version.date}" is not "D Month YYYY, HH:MM" — ${restampHint}`,
		);
	} else {
		/** @param {number} n */
		const field = (n) => +requiredGroup(m, n, stampPattern);
		const stampUtc =
			Date.UTC(field(3), mi, field(1), field(4), field(5)) - witaOffsetMs;
		const now = witaDay(Date.now());
		const driftMin = Math.round((stampUtc - Date.now()) / 60_000);
		if (driftMin > 10)
			errors.push(
				`STAMP IN THE FUTURE: "${version.date}" is ${driftMin} min ahead of now (${now} WITA) — ${restampHint}`,
			);
		else if (judgeDay && witaDay(stampUtc).slice(0, 10) !== now.slice(0, 10))
			warnings.push(
				`STAMP MISDATED: "${version.date}" but today is ${now.slice(0, 10)} WITA — ${restampHint}`,
			);
	}
}

/**
 * The CARD SHAPE finding on one field, or null where none is owed.
 * @param {Card} it
 * @param {string} key the ceiling's field label
 * @param {{ was: unknown, now: unknown, ceiling: number }} field
 *   the raw baseline and current values, and the field's ceiling
 * @returns {string | null} e.g. "grew to 300 words (was 10)"
 */
function shapeFinding(it, key, { was, now, ceiling }) {
	const wasWords = bodyWords(was);
	const nowWords = bodyWords(now);
	if (nowWords <= ceiling || (was ?? "") === (now ?? "")) return null;
	const grew = nowWords > wasWords;
	if (!grew && key in CAPPED_FIELD_CEILINGS && isCapOkIssue(it.capOk?.[key]))
		return null;
	return `${grew ? "grew to" : "is now"} ${nowWords} words (was ${wasWords})`;
}

/**
 * CARD SHAPE on one card, against its baseline card where it had one — a
 * length proxy for SKILL.md §What a card holds. Gated on TOUCH
 * (mantahostels#3335): any edit to an over-ceiling field warns, a trim that
 * stays over included; an untouched field says nothing. A `capOk` entry
 * silences a touch of its field that does not grow it — growth still warns. A
 * new card baselines at 0 words and so is judged on its size alone.
 * @param {Card} it
 * @param {Record<string, Card>} origById
 * @param {string[]} warnings accumulator: each warning above is pushed here
 */
function checkCardShape(it, origById, warnings) {
	if (!it.id) return;
	const prev = origById[it.id];
	const bodyFinding = shapeFinding(it, "b", {
		was: prev?.b,
		now: it.b,
		ceiling: BODY_WORD_CEILING,
	});
	if (bodyFinding) {
		warnings.push(
			`CARD SHAPE: "${it.id}" body ${bodyFinding}, over the ` +
				`${BODY_WORD_CEILING}-word ceiling. Re-read it against roadmap-edit SKILL.md ` +
				"§What a card holds — action, guardrails, done-when, and nothing else. Length is " +
				"a proxy for shape, so an earned long body is a fine answer; history, the " +
				`argument for the card's existence, and a cross-card essay are not.`,
		);
	}
	for (const { field, ceiling, read, note } of FIELD_WORD_CEILINGS) {
		const finding = shapeFinding(it, field, {
			was: prev ? read(prev) : undefined,
			now: read(it),
			ceiling,
		});
		if (finding) {
			warnings.push(
				`CARD SHAPE: "${it.id}" ${field} ${finding}, over the ` +
					`${ceiling}-word ceiling. ${note} Length is a ` +
					"proxy for shape, so an earned long field is a fine answer; a subject " +
					"another field owns is not — FIELDS.md assigns it.",
			);
		}
	}
}

/**
 * The scope diff of `current` against the baseline `original`, or null where
 * the baseline could not be read as a roadmap — reported in `errors` then.
 * @param {{ ITEMS: Card[], version: Version | null }} current
 * @param {string | Error} original
 * @param {string} originalLabel
 * @param {{ errors: string[], warnings: string[] }} findings
 */
function diffScope(current, original, originalLabel, findings) {
	const { ITEMS, version } = current;
	const { errors, warnings } = findings;
	let scope = null;
	try {
		if (original instanceof Error) throw original;
		const orig = parseRoadmap(original);
		const origIds = new Set(orig.ITEMS.map((i) => i.id));
		const curIds = new Set(ITEMS.map((i) => i.id));
		const added = [...curIds].filter((x) => !origIds.has(x));
		const removed = [...origIds].filter((x) => !curIds.has(x));
		/** @type {Record<string, Card>} */
		const origById = {};
		for (const it of orig.ITEMS) if (it.id) origById[it.id] = it;
		for (const it of ITEMS) checkCardShape(it, origById, warnings);
		scope = {
			added,
			removed,
			countBefore: orig.ITEMS.length,
			countAfter: ITEMS.length,
			versionBefore: orig.version ? orig.version.raw : "?",
			versionAfter: version ? version.raw : "?",
		};
		// version must have moved if content changed
		if (orig.version && version && orig.version.raw === version.raw) {
			warnings.push(
				`version unchanged (${version.raw}) — bump it if any content changed`,
			);
		}
	} catch (e) {
		errors.push(
			`--original was supplied ("${originalLabel}") but could not be read as a roadmap: ${caught(e).message}. ` +
				"The scope diff therefore did not run, so a mis-targeted edit would go unnoticed. " +
				"Fix the baseline path, or omit --original deliberately to skip the diff.",
		);
	}
	return scope;
}

/**
 * Run every roadmap check against `html`.
 *
 * `original` is the baseline to scope-diff against: the baseline's HTML, or
 * null/undefined to skip the diff, or an Error where the caller tried to load a
 * baseline and could not — which is a validation ERROR, not a skip, because a
 * caller that asked for the scope diff must not be told the file is fine when
 * the diff never ran. `options.originalLabel` names the baseline in that error.
 *
 * `options.expectedMajor` overrides the VERSION TRIPWIRE's pin (check #7)
 * directly, injected rather than read off `.claude/workflow-core.json` at
 * `hostRoot()` — the seam a test uses to exercise the pin without touching
 * `resolveExpectedMajor()`'s own file read. Omitted, it falls back to that
 * read; `options.root` then stands in for `resolveExpectedMajor()`'s own
 * `hostRoot()` default, so a test can exercise the file-read fallback path
 * itself against an empty directory instead of this repo's own config.
 *
 * `options.judgeStampDay: false` drops STAMP MISDATED (check #8) for a caller
 * judging a roadmap with no edit in flight, whose stamp is rightly the day it
 * was last edited (#1602). A future or unreadable stamp is still judged.
 *
 * Throws where `html` itself cannot be parsed as a roadmap: there is nothing to
 * report on, so that is the caller's fatal, not a finding.
 *
 * Returns { errors, warnings, version, cardCount, phaseCounts, added, removed,
 * scope }, where `scope` is null when no diff ran, and `added`/`removed` are
 * empty arrays then.
 *
 * @param {string} html
 * @param {string | Error | null} [original]  the blob to diff against, an Error
 *   where the caller could not load one, or null for none
 * @param {{ originalLabel?: string|null, expectedMajor?: number, root?: string,
 *   judgeStampDay?: boolean }} [options]
 */
function validateRoadmap(html, original = null, options = {}) {
	const originalLabel = options.originalLabel || "(baseline passed in)";
	/** @type {string[]} */
	const errors = [];
	/** @type {string[]} */
	const warnings = [];

	const { ITEMS, AREAS, version } = parseRoadmap(html);

	// 1. ids present + unique
	const byId = indexById(ITEMS, errors);

	// 2. per-card field sanity
	for (const it of ITEMS) checkCardFields(it, AREAS, errors);

	// 3. dependency integrity + ordering
	//    - every needs id must exist
	//    - a card may not need a card in a LATER phase
	//    - a same-phase need must appear EARLIER in array order (execution order)
	//    NB: compare against the loop index, not `it._idx` — only the `byId` copies
	//    carry _idx, so the original `dep._idx > it._idx` compared a number against
	//    undefined, which is always false.
	ITEMS.forEach((it, idx) => {
		checkNeeds(it, idx, byId, errors);
	});

	// 4. model-field discipline (warn only — judgement calls, not hard rules).
	//    m is optional (mantahostels#831): absent, it means the Opus 5.5 · medium default
	//    and is not warned on. When m IS present it must be one of the closed
	//    exception codes — "max", "—", or a leg-scoped array of ["step","max"]
	//    pairs — never a retired tier spelling like "S/H" (mantahostels#833).
	for (const it of ITEMS) checkModelField(it, warnings);

	// 5. callout-label length — HARD RULE: c.k is <= 20 chars including spaces.
	//    Longer labels wrap and break the card layout.
	for (const it of ITEMS) {
		if (it.c && typeof it.c.k === "string" && it.c.k.length > 20) {
			errors.push(
				`"${it.id}" callout label is ${it.c.k.length} chars (max 20): "${it.c.k}"`,
			);
		}
	}

	// 5b. CAPOK EXEMPTION DISCIPLINE (mantahostels#3189) — two WARN checks. MALFORMED
	//     EXEMPTION: a key outside the four ceilinged fields, or a value that
	//     isn't a positive integer issue number. STALE EXEMPTION: a recorded
	//     exemption naming a field now at or under its own ceiling. CARD SHAPE
	//     (below, scope-diff only) is silenced by an exemption on a touch that
	//     does not grow the field, and nowhere else (mantahostels#3335, amending mantahostels#3189).
	for (const it of ITEMS) checkCapOk(it, warnings);

	// 6. SCHEMA DRIFT — direct check, not proxied through the version number.
	//    Collects every field actually used across ITEMS and every c sub-field,
	//    then diffs against the pinned KNOWN_* sets above.
	checkSchemaDrift(ITEMS, warnings);

	// 7. VERSION TRIPWIRE — secondary/cheap check. A MAJOR bump is supposed to
	//    mean a structural change; if it moved since the pin was last set,
	//    that's a prompt to re-read this script against the current schema even
	//    if check #6 found nothing (e.g. a render-logic change with no new field).
	checkVersionTripwire(version, options, warnings);

	// 8. STAMP SANITY — the docmeta time is the only field written from reckoning
	//    rather than copied, and nothing above compares it to a clock. Future is
	//    never legitimate (ERROR); a wrong date warns unless judgeStampDay is off. Age is not the test — the
	//    two live failures behind it are on mantahostels#3499, replayed by validate.test.ts's
	//    "docmeta stamp sanity" cases.
	if (version)
		checkStamp(version, errors, warnings, options.judgeStampDay !== false);

	// --- scope diff vs original ---
	let scope = null;
	if (original !== null && original !== undefined)
		scope = diffScope({ ITEMS, version }, original, originalLabel, {
			errors,
			warnings,
		});

	/* Keyed by the phase as a string, which is what a JS object key already is —
	 * a card with no phase counts under "undefined", and check 2 above has
	 * already reported it. */
	/** @type {Record<string, number>} */
	const phaseCounts = {};
	for (const it of ITEMS) {
		const k = String(it.p);
		phaseCounts[k] = (phaseCounts[k] || 0) + 1;
	}

	return {
		errors,
		warnings,
		version,
		cardCount: ITEMS.length,
		phaseCounts,
		added: scope ? scope.added : [],
		removed: scope ? scope.removed : [],
		scope,
	};
}

// parseRoadmap is exported for callers that need the cards themselves rather
// than a verdict on them — check-roadmap-valid.js reads each card's state out
// of two blobs to spot a phase boundary being crossed (mantahostels#1130).
//
// The three ceiling exports below are for scripts/report-roadmap-ceilings.js
// (mantahostels#3334), which reads ceilings off this file rather than re-declaring them,
// so a ceiling change here cannot drift that census.
module.exports = {
	validateRoadmap,
	parseRoadmap,
	resolveExpectedMajor,
	EXPECTED_MAJOR,
	BODY_WORD_CEILING,
	FIELD_WORD_CEILINGS,
	bodyWords,
};

// --- command line -------------------------------------------------------
// Everything below only reads files, formats the result above and picks an
// exit code. No check lives here.
//
// WRITTEN WITH writeFd, NEVER console: a session runs this through Bash,
// so stdout is a pipe, and node drops what is still buffered on one at
// process.exit: a long FAIL report could lose its tail (#1444).

/** @param {string} line */
const printOut = (line) => writeFd(1, `${line}\n`);
/** @param {string} line */
const printErr = (line) => writeFd(2, `${line}\n`);

/**
 * @param {string} [problem]
 * @returns {never}
 */
function usage(problem) {
	if (problem) printErr(`ERROR: ${problem}`);
	printErr(
		"usage: node validate.js <roadmap.html> [--original <snapshot.html>]",
	);
	printErr(
		"  <roadmap.html>  required, positional, must come first — not a flag.",
	);
	printErr(
		"  --original      no default. Omitted => scope diff skipped (fine);",
	);
	printErr(
		"                  supplied but unreadable => fatal, not a warning.",
	);
	process.exit(1);
}

/**
 * The path after `--original`, or null where the flag is absent.
 * @param {string[]} argv
 * @returns {string | null}
 */
function originalPathArg(argv) {
	const origIdx = argv.indexOf("--original");
	let originalPath = null;
	if (origIdx > -1) {
		originalPath = argv[origIdx + 1];
		if (!originalPath || originalPath.startsWith("--")) {
			usage("--original was given without a path argument");
		}
	}
	return originalPath;
}

/**
 * @param {string | null} originalPath
 * @returns {string | Error | null}
 */
function readBaseline(originalPath) {
	// An unreadable baseline is passed on as the Error itself, so the failure is
	// reported as the scope-diff error above rather than killing the whole run:
	// every other check still has something to say about the current file.
	/** @type {string|Error|null} */
	let original = null;
	if (originalPath) {
		try {
			original = fs.readFileSync(originalPath, "utf8");
		} catch (e) {
			original = e instanceof Error ? e : new Error(caught(e).message);
		}
	}
	return original;
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
	const file = argv[2];
	if (!file) usage("no roadmap file given");
	// A flag in the positional slot used to sail past the !file guard above and die
	// at readFileSync with a raw ENOENT naming the flag, which reads as a missing
	// file rather than as the argument-order mistake it actually is.
	if (file.startsWith("--")) {
		usage(
			`first argument must be the roadmap file path, got the flag "${file}"`,
		);
	}

	const originalPath = originalPathArg(argv);

	const original = readBaseline(originalPath);

	let result;
	try {
		result = validateRoadmap(fs.readFileSync(file, "utf8"), original, {
			originalLabel: originalPath,
		});
	} catch (e) {
		printErr(`FATAL: ${caught(e).message}`);
		process.exit(1);
	}

	const { errors, warnings, version, cardCount, phaseCounts, scope } = result;

	printOut("── roadmap validation ──────────────────────────────");
	printOut(`file:      ${file}`);
	printOut(
		`version:   ${version ? `${version.raw} · ${version.date}` : "NOT FOUND"}`,
	);
	printOut(
		`cards:     ${cardCount}  (` +
			Object.keys(phaseCounts)
				.sort()
				.map((p) => `P${p}:${phaseCounts[p]}`)
				.join(" ") +
			")",
	);
	if (scope) {
		printOut(
			`scope:     ${scope.countBefore} → ${scope.countAfter} cards, ${scope.versionBefore} → ${scope.versionAfter}`,
		);
		printOut(
			`  added:   ${scope.added.length > 0 ? scope.added.join(", ") : "(none)"}`,
		);
		printOut(
			`  removed: ${scope.removed.length > 0 ? scope.removed.join(", ") : "(none)"}`,
		);
	}
	printOut("────────────────────────────────────────────────────");

	if (warnings.length > 0) {
		printOut(`WARNINGS (${warnings.length}):`);
		for (const w of warnings) printOut(`  ⚠ ${w}`);
	}
	if (errors.length > 0) {
		printOut(`ERRORS (${errors.length}):`);
		for (const e of errors) printOut(`  ✗ ${e}`);
		printOut("\nFAIL — do not ship until errors are resolved.");
		process.exit(1);
	}
	printOut(
		`OK — ${cardCount} cards, no broken prerequisites, no ordering or log errors.`,
	);
	process.exit(0);
}

if (require.main === module) main(process.argv);
