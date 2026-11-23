#!/usr/bin/env node

const fs = require("node:fs");
const { writeFd } = require("../../../../scripts/lib/write-fd.js");
const path = require("node:path");
const { hostRoot } = require("../../../../scripts/lib/host-root.js");
const { requiredGroup } = require("../../../../scripts/lib/regex-group.js");
const { caught } = require("../../../../scripts/lib/caught.js");

/**
 * @typedef {{id?: string, t?: string, p?: number, kind?: string, state?: string, a?: string[], b?: string, mn?: string, log?: string, needs?: string[], m?: unknown, c?: {k?: string, x?: string}, why?: string, dw?: string, capOk?: Record<string, unknown>, _idx?: number}} Card
 * @typedef {{major: number, minor: number, date: string, raw: string}} Version
 */

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
// guess, lucmoseley/mantahostels#3519
const DROPPED_FIELD_MIN_CARDS = 25;
const EXPECTED_MAJOR = 1;

/**
 * @param {string[]} warnings
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

// measured on the live distribution, lucmoseley/mantahostels#2979
const BODY_WORD_CEILING = 250;

// guess, lucmoseley/mantahostels#3186
const WHY_WORD_CEILING = 40;

// guess, lucmoseley/mantahostels#3190
const DW_WORD_CEILING = 60;

// measured near each field's p85, lucmoseley/mantahostels#3187
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

/** @param {unknown} v */
function isCapOkIssue(v) {
	return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/**
 * @param {Card} c
 * @param {string} key
 */
function readCappedField(c, key) {
	if (key === "b") return c.b;
	return CEILING_BY_FIELD[key]?.read(c);
}

/**
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
 * @param {string} html
 * @returns {{ITEMS: Card[], AREAS: Record<string, unknown>, version: Version|null}}
 */
function parseRoadmap(html) {
	const itemsBlock = extractBlock(html, "const ITEMS = [", "\n];");
	const areasBlock = extractBlock(html, "const AREAS = {", "};");
	const items = new Function(`${itemsBlock}\nreturn ITEMS;`)();
	const areas = new Function(`${areasBlock}\nreturn AREAS;`)();
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
/** @type {Set<unknown>} */
const VALID_STATES = new Set(["active", "open", "parked", "done"]);
/** @type {Set<unknown>} */
const VALID_KINDS = new Set(["action", "decision", "reference", "watchout"]);

const VALID_M_CODES = new Set(["max", "—"]);
const M_CODE_REMEDY =
	"closed set: max, —, no m at all, or a leg-scoped [step,max] pair — docs/effort-guide.md";

/**
 * @param {Card[]} items
 * @param {string[]} errors
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
 * @param {string[]} errors
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
 * @param {string[]} errors
 */
function checkCardWhy(it, errors) {
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
 * @param {string[]} errors
 */
function checkCardFields(it, areas, errors) {
	if (it.p === undefined || it.p < 0 || it.p > 4)
		errors.push(`"${it.id}" has bad phase p=${it.p}`);
	if (!VALID_KINDS.has(it.kind))
		errors.push(`"${it.id}" has bad kind "${it.kind}"`);
	if (!VALID_STATES.has(it.state))
		errors.push(`"${it.id}" has bad state "${it.state}"`);
	checkCardAreas(it, areas, errors);
	if (it.state === "done" && !it.log)
		errors.push(`done card "${it.id}" has no log`);
	if (it.state !== "done" && !it.dw)
		errors.push(
			`"${it.id}" is non-done and has no dw (done-when/start-when) — every non-done card must carry one.`,
		);
	checkCardWhy(it, errors);
}

/**
 * @param {Card} it
 * @param {number} idx
 * @param {Record<string, Card & {_idx: number}>} byId
 * @param {string[]} errors
 */
function checkNeeds(it, idx, byId, errors) {
	for (const n of it.needs || []) {
		const dep = byId[n];
		if (!dep) {
			errors.push(`"${it.id}" needs missing id "${n}"`);
			continue;
		}
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
 * @param {string[]} warnings
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
 * @param {string[]} warnings
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
 * @param {string[]} warnings
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
 * @param {string[]} warnings
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
 * @param {string[]} errors
 * @param {string[]} warnings
 * @param {boolean} judgeDay
 */
function checkStamp(version, errors, warnings, judgeDay) {
	const witaOffsetMs = 8 * 3_600_000;
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
 * @param {Card} it
 * @param {string} key
 * @param {{ was: unknown, now: unknown, ceiling: number }} field
 * @returns {string | null}
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
 * @param {Card} it
 * @param {Record<string, Card>} origById
 * @param {string[]} warnings
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
 * @param {string} html
 * @param {string | Error | null} [original]
 * @param {{ originalLabel?: string|null, expectedMajor?: number, root?: string, judgeStampDay?: boolean }} [options]
 */
function validateRoadmap(html, original = null, options = {}) {
	const originalLabel = options.originalLabel || "(baseline passed in)";
	/** @type {string[]} */
	const errors = [];
	/** @type {string[]} */
	const warnings = [];

	const { ITEMS, AREAS, version } = parseRoadmap(html);

	const byId = indexById(ITEMS, errors);

	for (const it of ITEMS) checkCardFields(it, AREAS, errors);

	ITEMS.forEach((it, idx) => {
		checkNeeds(it, idx, byId, errors);
	});

	for (const it of ITEMS) checkModelField(it, warnings);

	for (const it of ITEMS) {
		if (it.c && typeof it.c.k === "string" && it.c.k.length > 20) {
			errors.push(
				`"${it.id}" callout label is ${it.c.k.length} chars (max 20): "${it.c.k}"`,
			);
		}
	}

	for (const it of ITEMS) checkCapOk(it, warnings);

	checkSchemaDrift(ITEMS, warnings);

	checkVersionTripwire(version, options, warnings);

	if (version)
		checkStamp(version, errors, warnings, options.judgeStampDay !== false);

	let scope = null;
	if (original !== null && original !== undefined)
		scope = diffScope({ ITEMS, version }, original, originalLabel, {
			errors,
			warnings,
		});

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

module.exports = {
	validateRoadmap,
	parseRoadmap,
	resolveExpectedMajor,
	EXPECTED_MAJOR,
	BODY_WORD_CEILING,
	FIELD_WORD_CEILINGS,
	bodyWords,
};

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
