#!/usr/bin/env node

const path = require("node:path");
const { runCheck } = require("./lib/check");
const {
	DATA_FILES,
	FIGURE_ID,
	assertDataIdsKnown,
	compileAllowlist,
	dataFileSelfExemption,
	headingWords,
	loadSupersededNeedles,
	needlePattern,
	parseEntries,
	readMap,
	repoRelative,
	reportAnchors,
	reportPins,
	reportWholeFile,
	scanNeedles,
	scanScope,
	mapSkipLine,
	parseSupersedesText,
} = require("./lib/doc-map");
const { caught } = require("./lib/caught.js");
const { reportGroupedHits } = require("./lib/grouped-hits");

/**
 * @typedef {import("./lib/check").Ctx} Ctx
 * @typedef {{
 *   key: string,
 *   entry: string,
 *   needle: string,
 *   pattern: RegExp,
 *   context: string[],
 *   proseOnly: boolean,
 *   ambiguous?: boolean,
 * }} Needle
 */

const LIVE_LABEL =
	/^\s*[-*]\s+\*\*(?:⚠\s*)?(?:Owner|Inputs|Restated in|Collision hazard)/i;
const HAZARD_LABEL = /^\s*[-*]\s+\*\*(?:⚠\s*)?Collision hazard/i;
const TOP_BULLET = /^[-*]\s/;
const PROSE = /\.(?:md|html?|txt)$/i;

/**
 * @param {Ctx} ctx
 * @param {{dataFile: string, owed: string[]}} opts
 */
function loadNeedleData(ctx, { dataFile, owed }) {
	/** @type {ReturnType<typeof loadSupersededNeedles>} */
	let needleData = {};
	try {
		needleData = loadSupersededNeedles(dataFile);
	} catch (e) {
		const { code, message } = caught(e);
		if (code !== "ENOENT")
			ctx.broken(`superseded-needle data file unreadable — ${message}`);
		if (owed.length > 0)
			ctx.broken(
				`superseded-needle data file ${dataFile} is missing, while ` +
					`${owed.length} §B entr(ies) carry a Supersedes bullet — every ` +
					"needle lives there, so a scan without it finds nothing and reads " +
					"exactly like a repo carrying no stale copies.",
			);
	}
	return needleData;
}

/**
 * @param {Needle[]} scanned
 * @param {{id: string, heading: string, needle: string}} item
 * @returns {{admitted: Needle, span?: undefined} | {span: string, admitted?: undefined} | null}
 */
function admit(scanned, { id, heading, needle }) {
	const needsContext = !/\d/.test(needle);
	const words = needsContext
		? headingWords(heading).filter((w) => !needle.toLowerCase().includes(w))
		: [];
	if (needsContext && words.length === 0) return { span: needle };
	const key = `${id} ${needle.replace(/^~/, "")}`;
	if (scanned.some((s) => s.key === key)) return null;
	return {
		admitted: {
			key,
			entry: id,
			needle,
			pattern: needlePattern(needle),
			context: words,
			proseOnly: needsContext,
		},
	};
}

/**
 * @param {ReturnType<typeof loadSupersededNeedles>} needleData
 * @param {Map<string, string>} headings
 */
function buildNeedles(needleData, headings) {
	/** @type {Needle[]} */
	const scanned = [];
	/** @type {{ entry: string, spans: string[] }[]} */
	const unscanned = [];
	const allowlists = new Map();
	for (const [id, entry] of Object.entries(needleData)) {
		/** @type {string[]} */
		const spans = [];
		for (const item of entry.needles) {
			if (!item.scanned) {
				spans.push(item.needle);
				continue;
			}
			const verdict = admit(scanned, {
				id,
				heading: /** @type {string} */ (headings.get(id)),
				needle: item.needle,
			});
			if (verdict?.admitted) scanned.push(verdict.admitted);
			else if (verdict) spans.push(verdict.span);
		}
		if (spans.length > 0) unscanned.push({ entry: id, spans });
		allowlists.set(id, compileAllowlist(entry.allowlist));
	}
	return { scanned, unscanned, allowlists };
}

/** @param {{heading: string, lines: string[]}} fig */
function liveLinesOf(fig) {
	const kept = [fig.heading];
	let live = false;
	let hazard = false;
	for (const line of fig.lines) {
		if (TOP_BULLET.test(line)) {
			live = LIVE_LABEL.test(line);
			hazard = live && HAZARD_LABEL.test(line);
		} else if (!/^\s+\S/.test(line)) {
			live = false;
			hazard = false;
		}
		if (live && (hazard || !/supersede/i.test(line))) kept.push(line);
	}
	return kept;
}

/** @param {{heading: string, lines: string[]}[]} figures */
function liveTextOf(figures) {
	return figures.flatMap(liveLinesOf).join("\n");
}

/**
 * @param {Needle} needle
 * @param {string} file
 * @param {string} text
 */
function hitsLine(needle, file, text) {
	if (needle.proseOnly && !PROSE.test(file)) return false;
	if (text.search(needle.pattern) === -1) return false;
	if (needle.context.length === 0) return true;
	const lower = text.toLowerCase();
	return needle.context.some((/** @type {string} */ w) => lower.includes(w));
}

const AMBIGUOUS_FLAG =
	" — ⚠ also live elsewhere in §B; read the entry before touching a hit";

/**
 * @param {Ctx} ctx
 * @param {{entry: string, needle: string, ambiguous?: boolean, file: string,
 *   line: number, text: string}[]} hits
 * @param {{files: number, exemptCount: number, allowed: number}} counts
 */
function reportHits(ctx, hits, { files, exemptCount, allowed }) {
	reportGroupedHits(ctx, hits, {
		keyOf: (h) => [h.entry, h.needle],
		summary: (groups) =>
			`${hits.length} off-allowlist hit(s) on ${groups} superseded ` +
			`value(s), over ${files} tracked files (${exemptCount} ` +
			`exempt by class, ${allowed} hit(s) allowlisted):\n`,
		groupFinding: ({ entry, needle, ambiguous }, count) => ({
			tag: "SUPERSEDED",
			message: `§${entry}: "${needle}" live in ${count} place(s)`,
			data: { entry, needle, ambiguous, count },
			heading: `§${entry} · ${needle}${ambiguous ? AMBIGUOUS_FLAG : ""}`,
		}),
		footer:
			"Each hit is a candidate, not a verdict: a superseded value can survive " +
			"legitimately inside a passage that is explicitly about the old figure. " +
			"Read the §B entry, then re-derive rather than string-substitute.",
	});
}

/**
 * @param {Ctx} ctx
 * @param {{ entry: string, spans: string[] }[]} unscanned
 */
function reportUnscanned(ctx, unscanned) {
	if (unscanned.length === 0) return;
	ctx.say(
		"\nNot scanned — no distinctive literal (a bare number, a span naming " +
			"several values at once, or a phrase not all lowercase before its " +
			"number). A superseded " +
			"*wording* belongs on the entry's retired-vocabulary list instead, which " +
			"mantahostels#214 and mantahostels#215 own; a value worth grepping as written takes " +
			"`scanned: true`. Check these by hand:",
	);
	for (const u of unscanned) {
		const more = u.spans.length > 4 ? ` (+${u.spans.length - 4} more)` : "";
		ctx.say(`  §${u.entry}: ${u.spans.slice(0, 4).join(" · ")}${more}`);
	}
}

runCheck({
	name: "superseded-values",
	module: "governance",
	usage:
		"node check-superseded-values.js [<doc-map.md>] [--data-dir <dir>] [--broken-only]",
	valueFlags: ["--data-dir"],
	flags: ["--broken-only"],
	run(/** @type {Ctx} */ ctx) {
		const mapPath = ctx.args[0] || "docs/doc-map.md";
		const mapRel = repoRelative(mapPath);

		const text = readMap(ctx, mapPath);

		const dataDir = ctx.value("--data-dir", path.dirname(mapPath));

		const figures = parseEntries(text, FIGURE_ID);
		const owed = figures
			.filter((fig) => parseSupersedesText(fig.lines).trim())
			.map((fig) => fig.id);

		const dataFile = path.join(dataDir, DATA_FILES.supersededNeedles);
		const needleData = loadNeedleData(ctx, { dataFile, owed });

		assertDataIdsKnown(ctx, needleData, figures, dataFile);

		const uncovered = owed.filter((id) => !needleData[id]);
		if (uncovered.length > 0)
			ctx.broken(
				`${uncovered.join(", ")} carr(y) a Supersedes bullet in ${mapRel} but ` +
					`no key in ${dataFile}, so their superseded values are scanned by ` +
					"nothing. Give each a key there whose needles are the values it supersedes.",
			);

		// lucmoseley/mantahostels#861
		if (ctx.has("--broken-only"))
			return {
				okLine:
					`every §B entry carrying a Supersedes bullet has needles in ${dataFile} ` +
					`— ${owed.length} entr(ies) checked, scan not run`,
				noun: "off-allowlist superseded value hit(s)",
				count: 0,
				data: { brokenOnly: true, owed },
			};

		// #395
		if (figures.length === 0)
			ctx.skip(`${mapRel} has no §B entry yet — nothing to scan for.`);
		const scope = scanScope(ctx, {
			text,
			mapPath,
			checker: "check-superseded-values",
		});
		const dataExempt = dataFileSelfExemption(dataDir);
		const files = scope.files.filter((f) => !dataExempt.has(f));
		const exemptCount = scope.exemptCount;

		const headings = new Map(figures.map((f) => [f.id, f.heading]));
		const { scanned, unscanned, allowlists } = buildNeedles(
			needleData,
			headings,
		);

		const liveText = liveTextOf(figures);
		for (const s of scanned) {
			s.pattern.lastIndex = 0;
			s.ambiguous = s.pattern.test(liveText);
			s.pattern.lastIndex = 0;
		}

		const raw = scanNeedles({
			files,
			needles: scanned,
			allowlists,
			hitsLine,
			skipLine: (file, lines) =>
				mapSkipLine(file, lines, mapRel, { sectionB: true }),
		});
		const { anchorNotes, pinNotes, wholeFileNotes, allowed } = raw;
		const hits = raw.hits.map((h) => ({
			entry: h.needle.entry,
			needle: h.needle.needle,
			ambiguous: h.needle.ambiguous,
			file: h.file,
			line: h.line,
			text: h.text,
		}));

		reportHits(ctx, hits, { files: files.length, exemptCount, allowed });

		reportAnchors(ctx, anchorNotes);
		reportPins(ctx, pinNotes);
		reportWholeFile(ctx, wholeFileNotes);

		reportUnscanned(ctx, unscanned);

		return {
			okLine:
				"no superseded value from §B is live off-allowlist — " +
				`${scanned.length} value(s) scanned over ${files.length} tracked files ` +
				`(${exemptCount} exempt by class, ${allowed} hit(s) allowlisted)`,
			noun: "off-allowlist superseded value hit(s)",
			count: hits.length,
			data: {
				hits,
				anchorNotes,
				pinNotes,
				wholeFileNotes,
				unscanned,
				needles: scanned.map(({ entry, needle, ambiguous }) => ({
					entry,
					needle,
					ambiguous,
				})),
				files: files.length,
				exempt: exemptCount,
				allowed,
			},
		};
	},
});
