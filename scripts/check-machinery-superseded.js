#!/usr/bin/env node
/*
 * check-machinery-superseded.js — reports retired REPO-MACHINERY figures still
 * live in the repo.
 *
 * Usage:
 *   node check-machinery-superseded.js [<doc-map.md>] [--data-file <path>]
 *   (default map: docs/doc-map.md; default data: docs/machinery-superseded.json)
 *
 * The sibling of check-superseded-values.js, pointed at what that instrument has
 * no jurisdiction over: §B registers facts about the adopter's world, and CLAUDE.md
 * rules that "a ruling about the repo's own machinery earns none", so burn
 * shares, per-turn re-read multipliers and dispatch floors sat outside every
 * supersession guard until mantahostels#1440 — two breaches in five weeks (mantahostels#1407, mantahostels#1437).
 *
 * OWNER IS docs/machinery-superseded.json ITSELF, documented by this header. A
 * key (`fanout-share`) is documentation for a human reader, never a join key, so
 * nothing cross-validates it against a heading and there is no
 * `assertDataIdsKnown` equivalent.
 *
 * EVERY SHARE CARRIES BOTH SPELLINGS. `needlePattern` compiles `28.1%` to
 * `(?<![\w.,])~?28\.1%(?![\d]|\.\d)`, which does not match `FANOUT_SHARE =
 * 0.281` — the exact breach that opened the ticket. So a share needs the percent
 * form AND the decimal fraction as separate needles.
 *
 * THE DISCRIMINATOR FOR THE DECIMAL FORM: scan a THREE-significant-decimal
 * fraction (`0.281`, `0.165`), whose collision rate is near zero; never a
 * TWO-decimal one (`0.13`, `0.20`), which matches a coefficient, a p-value and a
 * rate in every statistics script in the tree. List the two-decimal spelling
 * `scanned: false` rather than leaving it out — a reader checking by hand still
 * needs to know what to look for. Same judgement the sibling makes for a bare
 * number: "a bare 61 matches everything".
 *
 * A HIT IS A CANDIDATE, NEVER A VERDICT: a retired figure survives legitimately
 * wherever the sentence around it quotes the past. So findings are WARN and the
 * exit code is 0 however many there are, it runs in the daily repo-checks run,
 * and it is deliberately NOT a `.husky/pre-commit` gate.
 *
 * Class-aware through §A exactly as the sibling is, which is what keeps the
 * correction note recording the retirement out of the report; a §A parsing no
 * exempt class is BROKEN. The data file drops out separately, by path — every
 * needle is live there by construction — and this checker and its test through
 * `scanScope`'s `selfFilter`. The dependency lockfiles drop out there too, by
 * basename, through `scanScope`'s `LOCKFILES` (mantahostels#2458), and the recorded
 * session transcripts by path, through its `isRecordedTranscript` (#2415).
 *
 * An allowlist entry names a path and the places in it the scan suppresses —
 * `L<n>` line pins or content anchors — in doc-map-superseded.json's shape. A
 * LINE PIN ROTS; AN ANCHOR DOES NOT (mantahostels#743): anchor by content wherever a
 * distinctive substring exists. An anchor written `{ anchor, needle }` covers
 * that needle alone on its line, leaving the line scanned for the figure's
 * others; a bare string covers the whole line (mantahostels#2431).
 *
 * Baseline, so a later run can tell drift from breakage: 4 live hits on 3
 * needles over 607 tracked files, 25 August 2026 — the capacity ladder's window
 * total (mantahostels#1437 owns it), the per-turn re-read in one §A row and in
 * scan_advisor.py's docstring, and §C35's cache-write floor (arbiter debt mantahostels#1420
 * owns that one). 16 further hits are allowlisted, all of them §A register rows
 * that state the correction beside the retired figure. THE DENOMINATOR MOVED at
 * mantahostels#2458, which dropped the lockfiles: compare a later count against the tracked
 * tree minus those, never against 607.
 *
 * Scope is read from git, so untracked scratch files are ignored by design.
 */

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
 * The data file's needles, split into the ones scanned for and the spans left
 * to a hand check, with each figure's compiled allowlist.
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
 * @param {import("./lib/check").CheckContext} ctx
 * @param {{figure: string, needle: string, file: string, line: number,
 *   text: string}[]} hits
 * @param {string} over the "N tracked files (…)" tail of the summary line
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
			/* Absent and malformed are both BROKEN: every needle lives here and
			 * nowhere else, so a scan without the file finds nothing and reads
			 * exactly like a repo carrying no stale copies (mantahostels#707's ruling, applied). */
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
			/* §B stays scanned here, unlike the two §B checkers: a retired
			 * machinery figure is not §B's subject, so a hit there is a real one
			 * (mantahostels#2399). */
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
