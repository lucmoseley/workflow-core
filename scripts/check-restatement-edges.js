#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { runCheck } = require("./lib/check");
const {
	DATA_FILES,
	FIGURE_ID,
	assertDataIdsKnown,
	citationMatcher,
	compileAllowlist,
	dataFileSelfExemption,
	loadRestatements,
	needlePattern,
	parseEntries,
	readMap,
	readTextLines,
	repoRelative,
	reportAnchors,
	reportPins,
	reportWholeFile,
	resolveAllowlist,
	scanScope,
	validateAllowlist,
	valueLiterals,
	headingWords,
} = require("./lib/doc-map");
const { requiredGroup } = require("./lib/regex-group");
const { caught } = require("./lib/caught.js");
const { reportGroupedHits } = require("./lib/grouped-hits");

/**
 * @typedef {import("./lib/check").Ctx} Ctx
 * @typedef {{kind: "value"|"count", needle: string}
 *   | {kind: "span", spans: string[]}
 *   | {kind: "claim"}} Derived
 * @typedef {{
 *   entry: string,
 *   needle: string,
 *   kind: string,
 *   pattern: RegExp,
 *   context: string[],
 *   named: ReturnType<typeof citationMatcher>[],
 *   allowlist: ReturnType<typeof compileAllowlist>,
 * }} Scan
 */

const BARE_COUNT = /(?<![\w.,$#])\d{3,4}(?![\d.,%])/g;
const YEAR = /^(?:19|20)\d\d$/;
const PATH_TOKEN = /\.(?:md|html?|json|js|jsx|ts|tsx|py|csv|txt|sh|yml|yaml)$/i;
const INLINE_CODE = /`([^`]+)`/g;

/**
 * @param {string} text
 */
function* pathTokens(text) {
	for (const m of text.matchAll(INLINE_CODE)) {
		const token = requiredGroup(m, 1, INLINE_CODE).trim();
		if (PATH_TOKEN.test(token)) yield token;
	}
}

/**
 * @param {string} heading
 * @returns {Derived}
 */
function currentNeedle(heading) {
	const stated = heading.replace(/`[^`]*`/g, "");
	const values = valueLiterals(stated);
	if (values.length > 1) return { kind: "span", spans: values };
	const [value] = values;
	if (value !== undefined) return { kind: "value", needle: value };
	const counts = [
		...new Set((stated.match(BARE_COUNT) || []).filter((n) => !YEAR.test(n))),
	];
	if (counts.length > 1) return { kind: "span", spans: counts };
	const [count] = counts;
	if (count !== undefined) return { kind: "count", needle: count };
	return { kind: "claim" };
}

/**
 * @typedef {{
 *   hits: {entry: string, needle: string, file: string, line: number, text: string}[],
 *   anchorNotes: import("./lib/doc-map").AnchorNote[],
 *   pinNotes: import("./lib/doc-map").PinNote[],
 *   wholeFileNotes: import("./lib/doc-map").WholeFileNote[],
 *   allowed: number,
 * }} Tally
 */

/**
 * @param {Ctx} ctx
 * @param {string} restatementFile
 * @param {boolean} allowEmpty
 */
function loadRestatementData(ctx, restatementFile, allowEmpty) {
	try {
		return loadRestatements(restatementFile, { allowEmpty });
	} catch (e) {
		const { code, message } = caught(e);
		return ctx.broken(
			code === "ENOENT"
				? `restatement data file ${restatementFile} is missing — the edges ` +
						"this checker diffs against live there, so without it every " +
						"file carrying a figure reads as a missing edge."
				: `restatement data file unreadable — ${message}`,
		);
	}
}

/**
 * @param {Ctx} ctx
 * @param {string} allowFile
 * @param {import("./lib/doc-map").Entry[]} figures
 */
function loadAllowData(ctx, allowFile, figures) {
	/** @type {Record<string, any>} */
	let allowData = {};
	try {
		allowData = JSON.parse(fs.readFileSync(allowFile, "utf8"));
	} catch (e) {
		const { code, message } = caught(e);
		if (code !== "ENOENT")
			ctx.broken(`restatement allowlist unreadable — ${message}`);
	}
	assertDataIdsKnown(ctx, allowData, figures, allowFile);
	try {
		for (const [id, allowlist] of Object.entries(allowData))
			validateAllowlist(allowFile, id, allowlist, null);
	} catch (e) {
		ctx.broken(`restatement allowlist malformed — ${caught(e).message}`);
	}
	return allowData;
}

/**
 * @param {import("./lib/doc-map").Entry} fig
 * @param {import("./lib/doc-map").RestatementPath[]} paths
 */
function namedMatchers(fig, paths) {
	const named = new Set(paths.map((item) => item.path));
	for (const prose of [[fig.heading, ...fig.lines].join("\n")].concat(
		paths.map((item) => item.gloss ?? ""),
	))
		for (const token of pathTokens(prose)) named.add(token);
	return [...named].map(citationMatcher);
}

/**
 * @param {{
 *   figures: import("./lib/doc-map").Entry[],
 *   restatements: Record<string, import("./lib/doc-map").RestatementEntry>,
 *   allowData: Record<string, import("./lib/doc-map").AllowlistRow[]>,
 * }} at
 */
function deriveScans({ figures, restatements, allowData }) {
	/** @type {Scan[]} */
	const scanned = [];
	/** @type {{entry: string, spans: string[]}[]} */
	const spans = [];
	let claims = 0;
	for (const fig of figures) {
		const derived = currentNeedle(fig.heading);
		if (derived.kind === "claim") {
			claims++;
			continue;
		}
		if (derived.kind === "span") {
			spans.push({ entry: fig.id, spans: derived.spans });
			continue;
		}
		const paths = restatements[fig.id]?.paths ?? [];
		const named = namedMatchers(fig, paths);
		scanned.push({
			entry: fig.id,
			needle: derived.needle,
			kind: derived.kind,
			pattern: needlePattern(derived.needle),
			context: derived.kind === "count" ? headingWords(fig.heading) : [],
			named,
			allowlist: compileAllowlist(allowData[fig.id]),
		});
	}
	return { scanned, spans, claims };
}

/**
 * @param {Scan} needle
 * @param {string} line
 */
function hitsLine(needle, line) {
	if (line.search(needle.pattern) === -1) return false;
	if (needle.context.length === 0) return true;
	const lower = line.toLowerCase();
	return needle.context.some((w) => lower.includes(w));
}

/**
 * @param {string} file
 * @param {string[]} lines
 * @param {Scan} s
 * @param {Tally} tally
 */
function scanNeedle(file, lines, s, tally) {
	const resolved = resolveAllowlist(s.allowlist, file, lines, (line) =>
		hitsLine(s, line),
	);
	for (const note of resolved.notes)
		tally.anchorNotes.push({ entry: s.entry, ...note });
	for (const note of resolved.pins)
		tally.pinNotes.push({ entry: s.entry, ...note });
	for (const note of resolved.wholeFileNotes)
		tally.wholeFileNotes.push({ entry: s.entry, ...note });
	let reported = false;
	for (const [i, line] of lines.entries()) {
		if (!hitsLine(s, line)) continue;
		if (resolved.allows(i + 1)) {
			tally.allowed++;
			continue;
		}
		if (reported) continue;
		reported = true;
		tally.hits.push({
			entry: s.entry,
			needle: s.needle,
			file,
			line: i + 1,
			text: line.trim().slice(0, 120),
		});
	}
}

/**
 * @param {{files: string[], mapRel: string, scanned: Scan[]}} at
 * @returns {Tally}
 */
function scanFiles({ files, mapRel, scanned }) {
	/** @type {Tally} */
	const tally = {
		hits: [],
		anchorNotes: [],
		pinNotes: [],
		wholeFileNotes: [],
		allowed: 0,
	};
	for (const file of files) {
		if (file === mapRel) continue;
		const lines = readTextLines(file);
		if (!lines) continue;
		for (const s of scanned) {
			if (s.named.some((m) => m(file))) continue;
			scanNeedle(file, lines, s, tally);
		}
	}
	return tally;
}

/**
 * @param {Ctx} ctx
 * @param {{hits: Tally["hits"], fileCount: number, exemptCount: number, allowed: number}} at
 */
function reportHits(ctx, { hits, fileCount, exemptCount, allowed }) {
	reportGroupedHits(ctx, hits, {
		keyOf: (h) => [h.entry],
		summary: () =>
			`${hits.length} file(s) carry a §B current value their entry does not ` +
			`name, over ${fileCount} tracked files (${exemptCount} ` +
			`exempt by class, ${allowed} allowlisted line(s)):\n`,
		groupFinding: ({ entry, needle }, count) => ({
			tag: "MISSING-EDGE",
			message: `§${entry}: "${needle}" carried by ${count} file(s) absent from its Restated-in list`,
			data: { entry, needle, count },
			heading: `§${entry} · ${needle}`,
		}),
		footer:
			"Each file is a candidate edge, not a verdict: read the passage before " +
			"adding it to `docs/doc-map-restatements.json`. A fixture or a " +
			"coincidence of digits belongs on the allowlist instead, anchored by " +
			"content.",
	});
}

/**
 * @param {Ctx} ctx
 * @param {{entry: string, spans: string[]}[]} spans
 */
function sayUnscannedSpans(ctx, spans) {
	if (spans.length === 0) return;
	ctx.say(
		"Not scanned — the heading states several values at once, and each part " +
			"is a live figure in its own right. Check these by hand:",
	);
	for (const s of spans)
		ctx.say(`  §${s.entry}: ${s.spans.slice(0, 6).join(" · ")}`);
}

runCheck({
	name: "restatement-edges",
	usage: "node check-restatement-edges.js [<doc-map.md>] [--data-dir <dir>]",
	valueFlags: ["--data-dir"],
	run(/** @type {Ctx} */ ctx) {
		const mapPath = ctx.args[0] || "docs/doc-map.md";
		const mapRel = repoRelative(mapPath);

		const text = readMap(ctx, mapPath);

		const dataDir = ctx.value("--data-dir", path.dirname(mapPath));
		const figures = parseEntries(text, FIGURE_ID);

		const restatementFile = path.join(dataDir, DATA_FILES.restatements);
		const restatements = loadRestatementData(
			ctx,
			restatementFile,
			figures.length === 0,
		);
		assertDataIdsKnown(ctx, restatements, figures, restatementFile);

		const allowFile = path.join(dataDir, DATA_FILES.restatementAllowlist);
		const allowData = loadAllowData(ctx, allowFile, figures);

		const { scanned, spans, claims } = deriveScans({
			figures,
			restatements,
			allowData,
		});

		if (figures.length === 0)
			ctx.skip(`${mapRel} has no §B entry yet — nothing to scan for.`);
		const scope = scanScope(ctx, {
			text,
			mapPath,
			checker: "check-restatement-edges",
		});
		const dataExempt = dataFileSelfExemption(dataDir);
		const files = scope.files.filter((f) => !dataExempt.has(f));

		const { hits, anchorNotes, pinNotes, wholeFileNotes, allowed } = scanFiles({
			files,
			mapRel,
			scanned,
		});

		const coverage =
			`${scanned.length} of ${figures.length} §B entr(ies) carry a scannable ` +
			`current value (${claims} state no scannable literal, ${spans.length} state ` +
			"several at once)";

		reportHits(ctx, {
			hits,
			fileCount: files.length,
			exemptCount: scope.exemptCount,
			allowed,
		});

		reportAnchors(ctx, anchorNotes);
		reportPins(ctx, pinNotes);
		reportWholeFile(ctx, wholeFileNotes);

		ctx.say(`\nCoverage: ${coverage}.`);
		sayUnscannedSpans(ctx, spans);

		return {
			okLine: `no file carries a §B current value its entry fails to name — ${coverage}, scanned over ${files.length} tracked files (${scope.exemptCount} exempt by class, ${allowed} allowlisted line(s))`,
			noun: "candidate missing restated-in edge(s)",
			count: hits.length,
			data: {
				hits,
				anchorNotes,
				pinNotes,
				wholeFileNotes,
				spans,
				claims,
				needles: scanned.map(({ entry, needle, kind }) => ({
					entry,
					needle,
					kind,
				})),
				files: files.length,
				exempt: scope.exemptCount,
				allowed,
			},
		};
	},
});
