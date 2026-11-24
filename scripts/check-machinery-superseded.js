#!/usr/bin/env node

const { runCheck } = require("./lib/check");
const {
	compileAllowlist,
	loadMachineryNeedles,
	needlePattern,
	readMap,
	repoRelative,
	reportAnchors,
	reportPins,
	reportWholeFile,
	mapSkipLine,
	scanNeedles,
	scanScope,
} = require("./lib/doc-map");
const { caught } = require("./lib/caught.js");
const { reportGroupedHits } = require("./lib/grouped-hits");

const DEFAULT_DATA = "docs/machinery-superseded.json";

/**
 * @param {Record<string, any>} data
 */
function splitNeedles(data) {
	/** @type {any[]} */ const scanned = [];
	/** @type {any[]} */ const unscanned = [];
	/** @type {Map<string, any[]>} */ const allowlists = new Map();
	for (const [id, entry] of Object.entries(data)) {
		/** @type {string[]} */ const spans = [];
		for (const item of entry.needles) {
			if (!item.scanned) {
				spans.push(item.needle);
				continue;
			}
			scanned.push({
				entry: id,
				needle: item.needle,
				pattern: needlePattern(item.needle),
			});
		}
		if (spans.length > 0) unscanned.push({ figure: id, spans });
		allowlists.set(id, compileAllowlist(entry.allowlist));
	}
	return { scanned, unscanned, allowlists };
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {{figure: string, needle: string, file: string, line: number,
 *   text: string}[]} hits
 * @param {string} over
 */
function reportHits(ctx, hits, over) {
	reportGroupedHits(ctx, hits, {
		keyOf: (h) => [h.figure, h.needle],
		summary: (groups) =>
			`${hits.length} off-allowlist hit(s) on ${groups} retired ` +
			`machinery figure(s), over ${over}:\n`,
		groupFinding: ({ figure, needle }, count) => ({
			tag: "MACHINERY",
			message: `${figure}: "${needle}" live in ${count} place(s)`,
			data: { figure, needle, count },
			heading: `${figure} · ${needle}`,
		}),
		footer:
			"Each hit is a candidate, not a verdict: a retired figure survives " +
			"legitimately inside a passage that is explicitly about the old value. " +
			"Read the figure's current value where it is set, then re-derive " +
			"rather than string-substitute.",
	});
}

/** @param {any} ctx @param {any[]} unscanned */
function reportUnscanned(ctx, unscanned) {
	if (unscanned.length === 0) return;
	ctx.say(
		"\nNot scanned — no distinctive literal (a two-decimal fraction, or a " +
			"span naming several values at once, hits hundreds of correct lines). " +
			"Check these by hand:",
	);
	for (const u of unscanned) ctx.say(`  ${u.figure}: ${u.spans.join(" · ")}`);
}

runCheck({
	name: "machinery-superseded",
	usage:
		"node check-machinery-superseded.js [<doc-map.md>] [--data-file <path>]",
	valueFlags: ["--data-file"],
	/** @param {any} ctx */
	run(ctx) {
		const mapPath = ctx.args[0] || "docs/doc-map.md";

		const text = readMap(ctx, mapPath);

		const dataFile = String(ctx.value("--data-file", DEFAULT_DATA));
		/** @type {Record<string, any>} */
		let data = {};
		try {
			data = loadMachineryNeedles(dataFile);
		} catch (e) {
			const { code, message } = caught(e);
			ctx.broken(
				code === "ENOENT"
					? `machinery-needle data file ${dataFile} is missing — every needle ` +
							"lives there, so a scan without it finds nothing and reads like a " +
							"repo carrying no retired figures."
					: `machinery-needle data file unreadable — ${message}`,
			);
		}

		const { scanned, unscanned, allowlists } = splitNeedles(data);

		const scope = scanScope(ctx, {
			text,
			mapPath,
			checker: "check-machinery-superseded",
		});
		const selfPath = repoRelative(dataFile);
		const files = scope.files.filter((f) => f !== selfPath);
		const mapRel = repoRelative(mapPath);

		const raw = scanNeedles({
			files,
			needles: scanned,
			allowlists,
			hitsLine: (needle, _file, lineText) =>
				lineText.search(needle.pattern) !== -1,
			skipLine: (file, lines) => mapSkipLine(file, lines, mapRel),
		});
		const { anchorNotes, pinNotes, wholeFileNotes, allowed } = raw;
		const hits = raw.hits.map((h) => ({
			figure: h.needle.entry,
			needle: h.needle.needle,
			file: h.file,
			line: h.line,
			text: h.text,
		}));

		reportHits(
			ctx,
			hits,
			`${files.length} tracked files ` +
				`(${scope.exemptCount} exempt by class, ${allowed} hit(s) allowlisted)`,
		);

		reportAnchors(ctx, anchorNotes);
		reportPins(ctx, pinNotes);
		reportWholeFile(ctx, wholeFileNotes);

		reportUnscanned(ctx, unscanned);

		return {
			okLine:
				"no retired machinery figure is live off-allowlist — " +
				`${scanned.length} needle(s) scanned over ${files.length} tracked files ` +
				`(${scope.exemptCount} exempt by class, ${allowed} hit(s) allowlisted)`,
			noun: "off-allowlist retired machinery figure hit(s)",
			count: hits.length,
			data: {
				hits,
				anchorNotes,
				pinNotes,
				wholeFileNotes,
				unscanned,
				needles: scanned.map(({ entry, needle }) => ({
					figure: entry,
					needle,
				})),
				files: files.length,
				exempt: scope.exemptCount,
				allowed,
			},
		};
	},
});
