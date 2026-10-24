#!/usr/bin/env node
/*
 * check-restatement-edges.js — reports files carrying a §B figure's CURRENT
 * value that the entry's `Restated in:` list does not name.
 *
 * Usage:
 *   node check-restatement-edges.js [<doc-map.md>] [--data-dir <dir>]
 *   (default: docs/doc-map.md; data dir defaults to the map's own directory)
 *
 * The twin of check-superseded-values.js, pointed at the value in force rather
 * than the one it replaced (mantahostels#1104).
 *
 * A CANDIDATE, NEVER A VERDICT, so it is WARN and exit 0 however many hits there
 * are: a file can carry the literal and be no restatement at all — a checker's
 * fixture, a coincidence of digits, a different quantity that is the same
 * number.
 *
 * The needle is the figure in the entry's own HEADING — "### B1 · Blended
 * average order value ≈ $45" — the one place §B states the current value in a
 * fixed position. Money and percentages are taken as they stand; a bare integer
 * of 3-4 digits is taken only with a heading-word context filter on the matching
 * line, since a bare number matches everything. Inline code is stripped from the
 * heading first: a path or an identifier is not a value.
 *
 * WHAT IS OUT OF REACH, and so is NOT covered rather than clean:
 *   1. A CLAIM ENTRY — most of §B. "An unjudgeable F&B flag is excluded from
 *      both counts" is restated as wording, and wording has no literal to grep.
 *   2. A FIGURE RESTATED IN PROSE — a file saying "about forty-five dollars" or
 *      re-deriving the figure rather than quoting it is unreachable by any
 *      string match.
 *   3. A MULTI-VALUE HEADING — B7's "310 → 205 → 140 → 64 → 41 → 27-29" is a
 *      chain, not a value; its parts are live figures in their own right.
 *   4. AN ISSUE NUMBER OR A YEAR in a heading (`mantahostels#631`, `mid-2029`), dropped
 *      before it becomes a needle.
 *   5. A PROPER-NOUN VALUE — a pilot-node entry's "Pilot node — Brennick". The
 *      superseded generator reaches those off the bolded span in a `Supersedes`
 *      bullet; a heading has no bold and is full of capitalised words, so
 *      nothing here can tell the value from the sentence. Such entries are
 *      counted as claim entries, which is why the claim count is an upper bound
 *      on what is genuinely unreachable.
 * Run it and read the coverage line; never write the fraction down (mantahostels#590, mantahostels#755,
 * mantahostels#764).
 *
 * NOT REPORTED: a file already on the entry's list whose `locator` has gone
 * stale. The edge itself is what this checker is about; a locator's quoted
 * phrase is check-doc-map.js's assertion 28 (mantahostels#3151), its `§` section nobody's.
 *
 * A FILE THE ENTRY ALREADY NAMES ANYWHERE is not a candidate — not just its
 * restatement list, but any path-shaped inline-code token in the entry body, so
 * the Owner file and an Inputs source stay out of the report. ANYWHERE reaches
 * one field of `doc-map-restatements.json` too — each path's `gloss`, which is
 * where §B's glosses live (mantahostels#1469). ⚠ NOT the sidecar's other two prose
 * fields: a `note` or a `locator` names a file as often to DENY the edge as to
 * cite it, and reading those would silence the exceptions they were written to
 * flag (mantahostels#1472). Residual: a `note` that does cite a file leaves it a candidate.
 * Inline code only, in the sidecar as in the body.
 * Matching is by suffix on a segment boundary (`citationMatcher`). ⚠ This BEATS
 * the allowlist: a file the entry spells out is skipped before its anchors are
 * resolved, so allowlisting a fixture the entry also names suppresses nothing
 * and hides its anchor rotting. §B records a legitimate hit as a count, never
 * a path (mantahostels#1104).
 *
 * Class-aware, off Section A, through the same `scanScope` as its twin:
 * `binary-asset` files are exempt. The five §B data files are skipped too, and
 * so is the map itself.
 *
 * ALLOWLIST. A permanently-correct hit — a checker's own fixture quoting a live
 * figure — is suppressed from `doc-map-restatement-allowlist.json` beside the
 * map, keyed by entry id, in the shape the superseded file uses: `[{ path,
 * lines?, anchors? }]`, `lines: []` for the whole file. An anchor survives an
 * insertion above it where a line pin does not (mantahostels#744), so prefer one. The file
 * is OPTIONAL — absent means nothing is suppressed — but the moment it exists it
 * needs a Section A row like its four siblings.
 *
 * It runs in the daily repo-checks run beside its twin, and not in
 * `.husky/pre-commit`: a repo-wide scan is not a commit gate.
 *
 * Scope is read from git, so untracked scratch files are ignored by design.
 */

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
 * @typedef {import("./lib/check").CheckContext} Ctx
 *
 * What one entry's heading yields: a single literal to grep, several at once,
 * or nothing greppable at all.
 *
 * @typedef {{kind: "value"|"count", needle: string}
 *   | {kind: "span", spans: string[]}
 *   | {kind: "claim"}} Derived
 *
 * One needle admitted to the scan. `pattern` is global, so it is read with
 * `search`, which leaves its `lastIndex` as it found it.
 *
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

/* A bare count worth grepping: three or four digits, not an issue number
 * (`mantahostels#631`), not a money amount, and not a year (mantahostels#1104 measured both as noise). */
const BARE_COUNT = /(?<![\w.,$#])\d{3,4}(?![\d.,%])/g;
const YEAR = /^(?:19|20)\d\d$/;
/* A path-shaped inline-code token, as opposed to an identifier or a card id. */
const PATH_TOKEN = /\.(?:md|html?|json|js|jsx|ts|tsx|py|csv|txt|sh|yml|yaml)$/i;
const INLINE_CODE = /`([^`]+)`/g;

/**
 * The path-shaped inline-code tokens in a stretch of prose.
 * @param {string} text
 */
function* pathTokens(text) {
	for (const m of text.matchAll(INLINE_CODE)) {
		const token = requiredGroup(m, 1, INLINE_CODE).trim();
		if (PATH_TOKEN.test(token)) yield token;
	}
}

/**
 * One entry's current-value needle, or the reason there is none. `kind` is
 * `value` for money and percentages, `count` for a bare integer, `span` where the
 * heading states several values at once, and `claim` where it states no literal.
 *
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
 * What the file scan gathers: the reported hits, the allowlist diagnostics,
 * and the count of hit lines an allowlist suppressed.
 *
 * @typedef {{
 *   hits: {entry: string, needle: string, file: string, line: number, text: string}[],
 *   anchorNotes: import("./lib/doc-map").AnchorNote[],
 *   pinNotes: import("./lib/doc-map").PinNote[],
 *   wholeFileNotes: import("./lib/doc-map").WholeFileNote[],
 *   allowed: number,
 * }} Tally
 */

/**
 * The restatement sidecar, or BROKEN where it is missing or unreadable.
 *
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
 * The optional allowlist, its ids checked against §B and each entry
 * validated; BROKEN where it is present but unparseable or malformed.
 *
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
		// Absent is the normal state; present and unparseable is not.
		if (code !== "ENOENT")
			ctx.broken(`restatement allowlist unreadable — ${message}`);
	}
	assertDataIdsKnown(ctx, allowData, figures, allowFile);
	/* Validated with `null`, so a scoped anchor is refused here: this scan
	 * resolves its allowlist with no needle in hand, so one written anyway
	 * would suppress nothing (mantahostels#2431). */
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
 * }} at loadAllowData()'s result, each entry already validated
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
		/* The restatement list, the body, and each path's `gloss` — see the
		 * ⚠ paragraph in the header for why the sidecar's other two prose fields
		 * are deliberately not read. */
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

/* One needle's whole test on one line, so the line-pin diagnostic below
 * can never judge a pin by a test the scan itself does not run. */
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
 * One needle over one file the entry does not already name.
 *
 * @param {string} file
 * @param {string[]} lines
 * @param {Scan} s
 * @param {Tally} tally accumulator: notes, allowed lines and hits are added
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
	/* One line per file: the question is whether the FILE belongs on the
	 * entry's list, and a file quoting the figure ten times answers it
	 * once. The loop still runs to the end, so an allowlisted line below
	 * the reported one is still counted as suppressed. */
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
		/* The map itself is never a restatement of its own figure: §B states it,
		 * and §A and §C describe the documents that carry it. */
		if (file === mapRel) continue;
		const lines = readTextLines(file);
		if (!lines) continue;
		for (const s of scanned) {
			/* The allowlist is resolved in scanNeedle(), after the skip below,
			 * not before: an anchor or pin note about a file the entry already
			 * names could never suppress a hit, so reporting it is noise in a
			 * report read by eye. */
			if (s.named.some((m) => m(file))) continue;
			scanNeedle(file, lines, s, tally);
		}
	}
	return tally;
}

/**
 * The candidate edges, grouped by entry, with a MISSING-EDGE warning each.
 *
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

		/* An empty sidecar beside a §B with no `### B<n>` entries is a day-one
		 * state, not data gone missing — mirrors check-doc-map.js's own
		 * `allowEmpty: figures.length === 0` (#52). */
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

		/* A §B with no entry carries no value to scan for, and a day-one §A has
		 * no historical row for scanScope to find (#395 Q1). */
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
