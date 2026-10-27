#!/usr/bin/env node
/*
 * check-retired-vocabulary.js — reports retired wording from §B still live.
 *
 * Usage:
 *   node check-retired-vocabulary.js [<doc-map.md>] [--data-dir <dir>]
 *   (default: docs/doc-map.md; data dir defaults to the map's own directory)
 *
 * A Section B *claim* entry carries no number, so a stale copy of it cannot be
 * found by grepping a figure. The entry lists the **retired vocabulary** a stale
 * copy will be using instead, plus the **legitimate hits** where those phrases
 * correctly survive. This scans the first and subtracts the second.
 *
 * Phrases and allowlists come from doc-map-retired-vocabulary.json, beside the
 * map, and from nowhere else (mantahostels#591): a missing or unloadable data file is
 * BROKEN rather than a scan that finds nothing. The three §B data files are
 * exempt from the scan itself.
 *
 * Stems, not literals (mantahostels#204, docs/doc-map.md §B's preamble). A phrase
 * carries a `literal`, a `stem` or both; the scan takes the stem where one is
 * given and the literal otherwise, and matches it as a regular expression.
 *
 * Report only, never gates: findings are WARN, so the exit code is 0 however
 * many hits there are. Accepted at mantahostels#26, on the ground that a hard fail pressures
 * a session into blunting its own phrase list to get green, which destroys the
 * instrument.
 *
 * An allowlist entry names a path and the places in it the scan suppresses —
 * `L<n>` line numbers, or content anchors, a substring of the line itself, which
 * survives an insertion above it where a line number does not (mantahostels#744). An entry
 * carrying `lines: []` and no anchors suppresses the whole file. An anchor here
 * is a plain string only: the needle-scoped `{ anchor, needle }` form the
 * superseded sidecars take is REFUSED, because this scan resolves its allowlist
 * with no needle in hand and a scoped anchor would suppress nothing (mantahostels#2431).
 *
 * A place that has stopped covering anything is named at WARN and suppresses as
 * before: an anchor matching no line or several, a line pin whose line carries
 * none of the entry's phrases, and a whole-file row whose file carries none of
 * them at all (`resolveAllowlist` in lib/doc-map.js).
 *
 * Class-aware, like check-superseded-values.js. Section A gives every tracked
 * document an authority class; `binary-asset` files carry no prose and are
 * exempt. A Section A that parses no row at all is BROKEN rather than a scan
 * run without the exemption.
 *
 * Each line is tested TWICE — raw, and with `*` and `_` stripped — so a phrase
 * broken across bold markup is still found. The scan is strictly per line, so
 * NEITHER a literal NOR a stem survives a phrase broken across a wrapped
 * line; elastic whitespace (`fromLiteral`) only reaches within one, and a
 * stem is compiled raw with no such transform (mantahostels#2293). A stem that will not
 * compile, or that backtracks exponentially, FAILS THE LOAD and names its
 * entry (mantahostels#590).
 *
 * Section B's own text is out of scope along with the data files.
 *
 * NOISE IS EXPECTED AND IS NOT TUNED AWAY. Baseline: 171 off-allowlist hits on
 * 50 phrases, 19 August 2026 (mantahostels#590 carries the before/after table). Do not
 * allowlist a phrase in the same breath as first grepping it — that defeats the
 * repair. A later run differing by more than a little is drift to read, not a
 * threshold to restore.
 *
 * Scope is read from git, so untracked scratch files are ignored by design.
 */

const path = require("node:path");
const { runCheck } = require("./lib/check");
const {
	DATA_FILES,
	FIGURE_ID,
	assertDataIdsKnown,
	compileAllowlist,
	dataFileSelfExemption,
	loadRetiredVocabulary,
	parseEntries,
	readMap,
	readTextLines,
	parseRetiredVocabularyText,
	repoRelative,
	reportAnchors,
	reportPins,
	reportWholeFile,
	resolveAllowlist,
	scanScope,
	mapSkipLine,
} = require("./lib/doc-map");
const { caught } = require("./lib/caught.js");
const { reportGroupedHits } = require("./lib/grouped-hits");

/**
 * A literal as a pattern: whitespace is elastic, and backticks are invisible.
 * @param {string} literal
 */
function fromLiteral(literal) {
	const body = literal
		.replace(/`/g, "")
		.trim()
		.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		.replace(/\s+/g, "[\\s`]+");
	return body ? new RegExp(body, "i") : null;
}

/**
 * Every phrase of one entry matching one line. Two passes: raw, and with
 * emphasis stripped, which asterisks written inside a phrase would otherwise
 * defeat.
 *
 * The scan and the line-pin diagnostic (mantahostels#847) both ask through here, so a pin
 * can never be judged by a test the scan itself does not run.
 * @param {{patterns: {source: string, pattern: RegExp}[]}} list
 * @param {string} text
 */
function phrasesOn(list, text) {
	/** @type {string|null} */
	let plain = null;
	const buildPlainLine = () => {
		if (plain === null) plain = text.replace(/[*_]+/g, "");
		return plain;
	};
	return list.patterns.filter(
		(p) => p.pattern.test(text) || p.pattern.test(buildPlainLine()),
	);
}

/** @typedef {import("./lib/check").CheckContext} Ctx */

/**
 * @typedef {{
 *   entry: string,
 *   patterns: {source: string, pattern: RegExp}[],
 *   allow: import("./lib/doc-map").CompiledAllowRow[],
 * }} PhraseList
 */

/**
 * What the file scan gathers: the hits, the allowlist diagnostics, and the
 * count of hits an allowlist suppressed.
 *
 * @typedef {{
 *   hits: {entry: string, phrase: string, file: string, line: number, text: string}[],
 *   anchorNotes: import("./lib/doc-map").AnchorNote[],
 *   pinNotes: import("./lib/doc-map").PinNote[],
 *   wholeFileNotes: import("./lib/doc-map").WholeFileNote[],
 *   allowed: number,
 * }} Tally
 */

/**
 * The retired-vocabulary data file, or BROKEN where it is missing or
 * unreadable.
 *
 * @param {Ctx} ctx
 * @param {string} dataFile
 * @param {boolean} allowEmpty
 * @returns {Record<string, import("./lib/doc-map").RetiredVocabularyEntry>}
 */
function loadVocab(ctx, dataFile, allowEmpty) {
	try {
		return loadRetiredVocabulary(dataFile, { allowEmpty });
	} catch (e) {
		return ctx.broken(
			e instanceof Error && caught(e).code === "ENOENT"
				? `retired-vocabulary data file ${dataFile} is missing — every ` +
						"phrase lives there, so a scan without it finds nothing and " +
						"reads exactly like a repo carrying no retired wording."
				: `retired-vocabulary data file unreadable — ${e instanceof Error ? e.message : e}`,
		);
	}
}

/* The scan iterates the data file, so an entry advertising retired wording
 * with no key there is scanned by nothing and still reads green. mantahostels#591
 * ruled that direction for the file; same argument at the entry (mantahostels#1247). */
/**
 * @param {Ctx} ctx
 * @param {{
 *   figures: import("./lib/doc-map").Entry[],
 *   vocabData: Record<string, import("./lib/doc-map").RetiredVocabularyEntry>,
 *   mapRel: string,
 *   dataFile: string,
 * }} at
 */
function assertEntriesCovered(ctx, { figures, vocabData, mapRel, dataFile }) {
	const owed = figures
		.filter((fig) => parseRetiredVocabularyText(fig.lines) !== null)
		.map((fig) => fig.id);
	const uncovered = owed.filter((id) => !vocabData[id]);
	if (uncovered.length > 0)
		ctx.broken(
			`${uncovered.join(", ")} carr(y) a Retired vocabulary bullet in ` +
				`${mapRel} but no key in ${dataFile}, so their retired wording is ` +
				"scanned by nothing. Add each entry's phrases to the data file — " +
				"the literal, with a stem where the literal would under-match. An " +
				"entry that retires no wording carries no bullet at all: the label " +
				"is the declaration, so it cannot be used to say there is none.",
		);
}

/**
 * One entry's phrases as patterns, and the literals that yield none.
 *
 * @param {import("./lib/doc-map").RetiredVocabularyEntry["phrases"]} phrases
 */
function phrasePatterns(phrases) {
	/** @type {PhraseList["patterns"]} */
	const patterns = [];
	/** @type {string[]} */
	const spans = [];
	for (const phrase of phrases) {
		/* The stem wins where both are stated. The loader already compiled
		 * every stem, so only a degenerate literal (nothing left once the
		 * backticks go) can still fall out unscanned. */
		if (phrase.stem)
			patterns.push({
				source: phrase.stem,
				pattern: new RegExp(phrase.stem, "i"),
			});
		// lib/doc-map.js's loader already refuses a phrase carrying neither
		// `stem` nor `literal`, so this always matches — kept explicit rather
		// than a bare `else` so the checker need not trust that invariant.
		else if (phrase.literal) {
			const pattern = fromLiteral(phrase.literal);
			if (pattern) patterns.push({ source: phrase.literal.trim(), pattern });
			else spans.push(phrase.literal);
		}
	}
	return { patterns, spans };
}

/**
 * Every data-file entry as a phrase list to scan, and the entries with
 * phrases no pattern could be read from.
 *
 * @param {Record<string, import("./lib/doc-map").RetiredVocabularyEntry>} vocabData
 */
function buildLists(vocabData) {
	/** @type {PhraseList[]} */
	const lists = [];
	/** @type {{entry: string, spans: string[]}[]} */
	const unscanned = [];
	for (const [id, entry] of Object.entries(vocabData)) {
		const { patterns, spans } = phrasePatterns(entry.phrases);
		if (patterns.length > 0)
			lists.push({
				entry: id,
				patterns,
				allow: compileAllowlist(entry.allowlist),
			});
		if (spans.length > 0) unscanned.push({ entry: id, spans });
	}
	return { lists, unscanned };
}

/**
 * @param {{file: string, lines: string[], skip: ReturnType<typeof mapSkipLine>}} at
 * @param {PhraseList} list
 * @param {Tally} tally accumulator: notes, allowed lines and hits are added
 */
function scanList({ file, lines, skip }, list, tally) {
	/* A content anchor is looked for in the file's current text, so it
	 * resolves here rather than at load, and its misses are findings. */
	const {
		allows,
		notes,
		pins,
		wholeFileNotes: wf,
	} = resolveAllowlist(
		list.allow,
		file,
		lines,
		(text) => phrasesOn(list, text).length > 0,
	);
	for (const note of notes)
		tally.anchorNotes.push({ entry: list.entry, ...note });
	for (const note of pins) tally.pinNotes.push({ entry: list.entry, ...note });
	for (const note of wf)
		tally.wholeFileNotes.push({ entry: list.entry, ...note });
	for (const [i, line] of lines.entries()) {
		if (skip?.(i)) continue;
		const matched = phrasesOn(list, line);
		if (matched.length === 0) continue;
		const no = i + 1;
		if (allows(no)) {
			tally.allowed += matched.length;
			continue;
		}
		/* Every phrase matching the line is reported, not the first: two
		 * retired phrases can sit in one sentence. */
		for (const hit of matched)
			tally.hits.push({
				entry: list.entry,
				phrase: hit.source,
				file,
				line: no,
				text: line.trim().slice(0, 120),
			});
	}
}

/**
 * @param {{files: string[], mapRel: string, lists: PhraseList[]}} at
 * @returns {Tally}
 */
function scanFiles({ files, mapRel, lists }) {
	/** @type {Tally} */
	const tally = {
		hits: [],
		anchorNotes: [],
		pinNotes: [],
		wholeFileNotes: [],
		allowed: 0,
	};
	for (const file of files) {
		const lines = readTextLines(file);
		if (!lines) continue;
		const skip = mapSkipLine(file, lines, mapRel, { sectionB: true });
		for (const list of lists) scanList({ file, lines, skip }, list, tally);
	}
	return tally;
}

/**
 * The off-allowlist hits, grouped by phrase, with a RETIRED warning each.
 *
 * @param {Ctx} ctx
 * @param {{hits: Tally["hits"], fileCount: number, allowed: number}} at
 */
function reportHits(ctx, { hits, fileCount, allowed }) {
	reportGroupedHits(ctx, hits, {
		keyOf: (h) => [h.entry, h.phrase],
		summary: (groups) =>
			`${hits.length} off-allowlist hit(s) on ${groups} retired ` +
			`phrase(s), over ${fileCount} tracked files (${allowed} hit(s) ` +
			"suppressed by an allowlist):\n",
		groupFinding: ({ entry, phrase }, count) => ({
			tag: "RETIRED",
			message: `§${entry}: "${phrase}" live in ${count} place(s)`,
			data: { entry, phrase, count },
			heading: `§${entry} · ${phrase}`,
		}),
		footer:
			"Each hit is a candidate, not a verdict: this list is noisy by design " +
			"(mantahostels#26), and an allowlist marked incomplete may be missing a " +
			"legitimate site; one saying it is complete was shown so by an " +
			"unblinded sweep (mantahostels#2373). Read the §B entry, " +
			"then either fix the line or add it to that entry's legitimate hits.",
	});
}

/**
 * @param {Ctx} ctx
 * @param {{entry: string, spans: string[]}[]} unscanned
 */
function sayUnscanned(ctx, unscanned) {
	if (unscanned.length === 0) return;
	ctx.say(
		"\nNot scanned — a literal left empty once its backticks go. Give each " +
			"a readable literal or a stem in doc-map-retired-vocabulary.json:",
	);
	for (const u of unscanned) {
		const shown = u.spans.slice(0, 4).join(" · ");
		const more = u.spans.length > 4 ? ` (+${u.spans.length - 4} more)` : "";
		ctx.say(`  §${u.entry}: ${shown}${more}`);
	}
}

runCheck({
	name: "retired-vocabulary",
	usage: "node check-retired-vocabulary.js [<doc-map.md>] [--data-dir <dir>]",
	valueFlags: ["--data-dir"],
	run(ctx) {
		const mapPath = ctx.args[0] || "docs/doc-map.md";
		const mapRel = repoRelative(mapPath);

		const text = readMap(ctx, mapPath);

		const scope = scanScope(ctx, {
			text,
			mapPath,
			checker: "check-retired-vocabulary",
		});

		const dataDir = ctx.value("--data-dir", path.dirname(mapPath));
		const dataExempt = dataFileSelfExemption(dataDir);
		const files = scope.files.filter((f) => !dataExempt.has(f));
		const exemptCount = scope.exemptCount;

		const dataFile = path.join(dataDir, DATA_FILES.retiredVocabulary);
		const figures = parseEntries(text, FIGURE_ID);
		const vocabData = loadVocab(ctx, dataFile, figures.length === 0);

		assertDataIdsKnown(ctx, vocabData, figures, dataFile);

		assertEntriesCovered(ctx, { figures, vocabData, mapRel, dataFile });

		const { lists, unscanned } = buildLists(vocabData);

		const { hits, anchorNotes, pinNotes, wholeFileNotes, allowed } = scanFiles({
			files,
			mapRel,
			lists,
		});

		const phraseCount = lists.reduce((n, l) => n + l.patterns.length, 0);

		reportHits(ctx, { hits, fileCount: files.length, allowed });

		reportAnchors(ctx, anchorNotes);
		reportPins(ctx, pinNotes);
		reportWholeFile(ctx, wholeFileNotes);

		sayUnscanned(ctx, unscanned);

		return {
			okLine:
				"no retired phrase from §B is live off-allowlist — " +
				`${phraseCount} phrase(s) over ${lists.length} entries, scanned over ` +
				`${files.length} tracked files (${exemptCount} ` +
				`exempt by class, ${allowed} hit(s) allowlisted)`,
			noun: "off-allowlist retired-phrase hit(s)",
			count: hits.length,
			data: {
				hits,
				anchorNotes,
				pinNotes,
				wholeFileNotes,
				unscanned,
				allowed,
				lists: lists.map((l) => ({
					entry: l.entry,
					phrases: l.patterns.map((p) => p.source),
					allow: l.allow.map((a) => ({
						path: a.path,
						lines: a.lines,
						/* Back to the authored spelling: a compiled anchor is an object,
						 * and this field has always been the data file's own strings. */
						anchors: a.anchors.map((x) => x.text),
					})),
				})),
				files: files.length,
				exempt: exemptCount,
			},
		};
	},
});
