#!/usr/bin/env node
/*
 * check-superseded-values.js — reports superseded figures still live in the repo.
 *
 * Usage:
 *   node check-superseded-values.js [<doc-map.md>] [--data-dir <dir>] [--broken-only]
 *   (default: docs/doc-map.md; data dir defaults to the map's own directory)
 *
 * Needles and allowlists come from doc-map-superseded.json, beside the map, and
 * from nowhere else (mantahostels#707): an unloadable data file is BROKEN rather than a scan
 * that finds nothing. The three §B data files are exempt from the scan itself.
 *
 * The map keeps its `Supersedes` bullets, so it still says which entries are
 * owed a needle list. Both file-level failures run off that: a *missing* file is
 * BROKEN only where some entry carries a bullet, and an entry carrying a bullet
 * with no key in the file is BROKEN.
 *
 * A Section B entry may carry a `Supersedes` line naming the value the
 * current one replaced; the rest are claim entries, whose stale
 * copies are findable as wording, not figures.
 *
 * An allowlist entry names a path and the places in it the scan suppresses —
 * `L<n>` line numbers, or content anchors, a substring of the line itself, which
 * survives an insertion above it where a line number does not (mantahostels#744). An entry
 * carrying `lines: []` and no anchors suppresses the whole file (mantahostels#707).
 *
 * An anchor written `{ anchor, needle }` suppresses that needle alone on the
 * line it matches, leaving the line scanned for the entry's other needles; a
 * bare string suppresses every one of them there (mantahostels#2431). Prefer the scoped
 * form: a `reference-roadmap.html` card body and a long-form note's
 * single-paragraph line are each one
 * physical line, so a whole-line anchor on either blinds the scan across that
 * whole card or paragraph (mantahostels#2503). A scoped anchor naming a needle its entry
 * does not scan is BROKEN, not silent.
 *
 * A place that has stopped covering anything is named at WARN and suppresses as before:
 * an anchor matching no line or several, a line pin whose line carries none of
 * the entry's needles, and a whole-file row whose file carries none of them at
 * all (`resolveAllowlist` in lib/doc-map.js).
 *
 * Report only, never gates: findings are WARN, so the exit code is 0 however many
 * hits there are. What counts as a stale copy is a judgement about the sentence
 * around it.
 *
 * --broken-only stops after the data-file assertions.
 *
 * Class-aware. Section A gives every tracked document an authority class;
 * `binary-asset` files carry no prose and are exempt. The exemption is driven
 * off the Section A class, never a path list, so a file changing class changes
 * what the scan says about it. A Section A that parses no row at all is BROKEN
 * rather than a scan run without the exemption.
 *
 * Only distinctive literals are scanned — money, percentages, capitalised
 * proper nouns, and a bare number carried by its own lowercase noun phrase
 * ("call list 23–25", added at mantahostels#2415). That split is carried by each
 * needle's `scanned` flag in the data file.
 *
 * A needle can be the live value of a different figure — as in the case
 * where the superseded ~93% (a set of ten) and `partner-pipeline`'s live 93%
 * (hypergeometric over a 14-property node) are the same number. No scan can
 * separate them, so such a needle is marked `also live` and its hits are reported
 * as ambiguous rather than dropped.
 *
 * A LINE PIN ROTS; AN ANCHOR DOES NOT (mantahostels#743, which measured the rate). A pin
 * drifts as lines are inserted above it, each move silently putting the hit
 * back in the report. So anchor a permanently-correct hit by content, and keep
 * a line pin only where no distinctive substring exists.
 *
 * An anchor matching two lines is a claim about one of them, so the fix is a
 * longer anchor, never a wider suppression. Prefer whole-file (`lines: []`)
 * only where every occurrence in that path is legitimate by construction, as in
 * a checker's own test fixtures — a row over a file the entry never hits at all
 * is named at WARN rather than left silent (mantahostels#2403). A pin that has drifted
 * onto a DIFFERENT line still matching the entry's phrases is deliberately
 * not named: a pin records
 * no content, so a drifted one is indistinguishable from a correct one, and
 * naming it would name every healthy pin.
 *
 * THREE PLACES A PIN IS NEVER CHECKED AT ALL — one written into any of them is
 * dead the day it is written, and nothing will tell you (mantahostels#860):
 *   1. a file whose Section A class is `binary-asset`;
 *   2. a line inside doc-map.md's own Section B range;
 *   3. an entry whose phrases are all uncompilable spans.
 *
 * THE ROADMAP DONE-LOG CLASS IS ALLOWLISTED (mantahostels#743, pinned by content at mantahostels#744).
 * A `log:` field in reference-roadmap.html quoting a superseded figure records
 * the decision that replaced it, so it is permanently correct. A hit in a
 * card body (`b:`) or a callout (`c:`) is a real defect — which is why
 * that file takes no wholesale `lines: []` exemption: it would
 * silence live hits along with the done-logs.
 *
 * NOT FIXED — needle noisiness itself, by far the largest class, dominated by
 * a `95%` needle matching every `95% CI` in docs/data/evidence-audit.md and the
 * statistics scripts. A substring-boundary question, out of scope at mantahostels#707.
 *
 * A HIT IS A CANDIDATE, NEVER A VERDICT: a superseded figure survives
 * legitimately wherever the sentence around it is quoting the past.
 *
 * A bare number, a multi-value span and a phrase that is not all lowercase
 * before its number are listed unscanned rather than grepped — a bare 61
 * matches everything, and a span like "~4-6% direct
 * all-in vs 12% vendor" contains a 12% that is the live base. What
 * separates a bare number from a qualified one is the noun phrase carrying
 * it: "call list 23–25" is distinctive enough to grep, a lone "61" is not. A
 * superseded *wording* belongs on retired vocabulary instead, not here.
 *
 * State coverage as a fraction of the Section B entries, never as all of them
 * (mantahostels#590, mantahostels#755, mantahostels#764). A hand count needs
 * `grep -cE '^### B[0-9]+ '` — a bare `^### B` also catches Section C's
 * `Brand & discovery` and `Book notes` headings and reads two high.
 *
 * Baseline, so a later run can tell drift from breakage: 93 live hits on 11
 * needles, 20 August 2026.
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
 * @typedef {import("./lib/check").CheckContext} Ctx
 *
 * One needle admitted to the scan. `pattern` is stateful (`lastIndex`), which is
 * why every reader resets it either side of a test, or reads it with `search`,
 * which leaves it as it found it.
 *
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

/* The bullets that evidence a needle also being live: the ones stating the
 * current figure, plus a collision-hazard bullet, which exists to name an
 * unrelated correct use of the same number (a still-correct 37%). Judged
 * against these only — a "⚠ Known stale copy" bullet quotes the superseded value
 * on purpose, and counting it would mark every needle as also-live. */
const LIVE_LABEL =
	/^\s*[-*]\s+\*\*(?:⚠\s*)?(?:Owner|Inputs|Restated in|Collision hazard)/i;
/* A collision-hazard bullet names which of two identical literals is superseded
 * — "Only the concentration one is superseded" — so the word is its subject, not
 * a sign it is describing a dead value. */
const HAZARD_LABEL = /^\s*[-*]\s+\*\*(?:⚠\s*)?Collision hazard/i;
const TOP_BULLET = /^[-*]\s/;
/* Where a name counts as a claim rather than a key. */
const PROSE = /\.(?:md|html?|txt)$/i;

/**
 * The superseded-needle data file, or `{}` where it is missing and nothing is
 * owed.
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

/* One needle's admission to the scan. A name is a
 * word before it is a value: a place name is often also a street address
 * or an app route. So a non-numeric needle is only a hit where the
 * line also carries a word from the entry's own heading — the difference
 * between a pilot-node sentence and an address — and only in prose, since
 * in data and fixtures a name is a key. What falls out is a span. */
/**
 * @param {Needle[]} scanned the needles admitted so far
 * @param {{id: string, heading: string, needle: string}} item
 * @returns {{admitted: Needle, span?: undefined} | {span: string, admitted?: undefined} | null}
 *   the needle admitted, or the span it falls out as — or null where it
 *   repeats one already admitted
 */
function admit(scanned, { id, heading, needle }) {
	const needsContext = !/\d/.test(needle);
	const words = needsContext
		? headingWords(heading).filter((w) => !needle.toLowerCase().includes(w))
		: [];
	if (needsContext && words.length === 0) return { span: needle };
	/* "~93%" and "93%" are one value stated twice in the same bullet, and
	 * scanning both prints every hit twice. */
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
 * Every data-file needle, admitted to the scan or listed unscanned, and each
 * entry's compiled allowlist.
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
			/* `headings.get(id)` is asserted, not defaulted: assertDataIdsKnown
			 * BROKENs on any data-file key the map has no `### B<n>` heading for, so
			 * every id reaching here has one. A default would turn that loud stop into
			 * a silently context-free needle. */
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

/**
 * One entry's heading and the lines of its live bullets.
 * @param {{heading: string, lines: string[]}} fig
 */
function liveLinesOf(fig) {
	const kept = [fig.heading];
	let live = false;
	let hazard = false;
	for (const line of fig.lines) {
		// Only a top-level bullet opens or closes the window: B16 states its
		// live 93% in a sub-bullet under "Restated in", and treating that as
		// a new bullet lost the one ambiguity the registry documents.
		if (TOP_BULLET.test(line)) {
			live = LIVE_LABEL.test(line);
			hazard = live && HAZARD_LABEL.test(line);
		} else if (!/^\s+\S/.test(line)) {
			live = false;
			hazard = false;
		}
		/* A live bullet that names the old value to rule it out — B9's
		 * "Inputs — on B1's $45 blended AOV, never the superseded $18" — is
		 * saying the opposite of live. A hazard bullet is exempt: naming the
		 * superseded twin is the whole content of the bullet. */
		if (live && (hazard || !/supersede/i.test(line))) kept.push(line);
	}
	return kept;
}

/**
 * Every entry's live text, joined.
 * @param {{heading: string, lines: string[]}[]} figures
 */
function liveTextOf(figures) {
	return figures.flatMap(liveLinesOf).join("\n");
}

/* One needle's whole test on one line: prose-only scope, the pattern, and
 * the heading-word context filter. The scan and the line-pin diagnostic
 * (mantahostels#847) both ask through here, so a pin can never be judged by a test the
 * scan itself does not run. */
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
 * The SUPERSEDED findings, grouped by needle.
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
 * The needles no scan covers, for checking by hand.
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
		/* Demanding a data file where there is nothing to put in it would make a
		 * repo with no superseded values read as a broken checker. */
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

		/* `.husky/pre-commit` gates on the half above alone (mantahostels#861), so the return
		 * sits here — above `scanScope`, whose own BROKEN cases are about the scan
		 * and would otherwise refuse a commit for a failure the fix this hook
		 * advertises does not touch.
		 *
		 * Skipped, not filtered: the hook feeds staged blobs through a temp path, and
		 * a scan pointed there reads every §B needle and every data-file line as a
		 * live hit, burying the BROKEN line. */
		if (ctx.has("--broken-only"))
			return {
				okLine:
					`every §B entry carrying a Supersedes bullet has needles in ${dataFile} ` +
					`— ${owed.length} entr(ies) checked, scan not run`,
				noun: "off-allowlist superseded value hit(s)",
				count: 0,
				data: { brokenOnly: true, owed },
			};

		/* A §B with no entry carries no value to scan for, and a day-one §A has
		 * no historical row for scanScope to find (workflow-core#395 Q1). */
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

		/* The file's `scanned` flag carries the scanned/listed-unscanned split; the
		 * heading a non-numeric needle qualifies against still comes from the map,
		 * which keeps the entries themselves. */
		const headings = new Map(figures.map((f) => [f.id, f.heading]));
		const { scanned, unscanned, allowlists } = buildNeedles(
			needleData,
			headings,
		);

		/* A needle is ambiguous where the same literal is a live figure somewhere in
		 * the registry, like the ~93% above. Judged against the entries' own live bullets. */
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
