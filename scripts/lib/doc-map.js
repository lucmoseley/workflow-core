/*
 * doc-map.js — the parsers the doc-map checkers read docs/doc-map.md with.
 *
 * `check-doc-map.js` (the hard CI gate on coverage), `check-retired-vocabulary.js`,
 * `check-superseded-values.js` and `check-doc-map-markers.js` read the same
 * document through them: Section
 * A's register table, Section B's `### B<n>` entries, and the tracked-file set
 * the scan runs over. Held as per-checker copies until mantahostels#239.
 */

const fs = require("node:fs");
const path = require("node:path");
/* One-way: always-loaded-pool.js requires nothing from here, so
 * check-context-budget.js still loads it on SessionStart without pulling this
 * parser in behind it. */
const {
	TRIGGER_VERDICT_MIN_WORDS,
	entryIssue: ledgerEntryIssue,
	entryLabel: ledgerEntryLabel,
} = require("./always-loaded-pool.js");
const { requiredGroup } = require("./regex-group.js");
const { trimEndRun } = require("./trim-run.js");
const { cutAt } = require("./cut-at.js");
const { byCodeUnit } = require("./by-code-unit.js");
const { caught } = require("./caught.js");
const { isUnder } = require("./is-under.js");
const { execGit, gitOrNull } = require("./git.js");
const { readCommitOrBroken } = require("./commit-sha.js");
const { siblingTests } = require("./test-kind.js");

/** One inline-code span, capturing its text. */
const BACKTICKED = /`([^`]+)`/g;

/**
 * lib/check.js's reporting context, imported because a local copy drifts from
 * it silently (mantahostels#1315). `broken` throws, so nothing after a call to it runs.
 * @typedef {InstanceType<typeof import("./check.js").CheckContext>} CheckContext
 */

/**
 * A Section A register row, and a `### B<n>`/`### C<n>` registry entry.
 * @typedef {{paths: string[], cls: string}} RegisterRow
 * @typedef {{id: string, heading: string, lines: string[]}} Entry
 */

/* A Section A row is `| path(s) | role | class | update route | consumes |`, so
 * the class is the third cell. Read by position rather than by scanning the row
 * for a class name: update-route cells describe classes in prose ("Regenerate
 * only"), and the Consumes cell cites other entries. */
const CLASS_CELL = 3;
const PATH_CELL = 1;
const BINARY_CLASS = "binary-asset";

/**
 * A Section A path, matched **exactly** — or as a prefix where the entry ends in
 * a wildcard. The register states full paths, and both readers of this decide
 * what a scan *skips* or counts as covered, so a loose match here silently
 * shrinks scope: a suffix match would exempt `vendor/x/CLAUDE.md` on the row for
 * `CLAUDE.md`.
 *
 * The map writes only two wildcard spellings — `docs/x/*` for everything under a
 * directory and `docs/adr-*` for a filename prefix. A full glob engine would make
 * the register harder to read than the tree it registers.
 */
/** A wildcard entry's literal run stripped of its trailing `*`(s) — the one
 * definition of "prefix" every wildcard reader shares, so a third spelling
 * added to the map needs one edit, not one per reader (mantahostels#239, mantahostels#268).
 * @param {string} entry
 */
function wildcardPrefix(entry) {
	return trimEndRun(entry, "*");
}

/**
 * @param {string} entry
 */
function sectionAMatcher(entry) {
	if (entry.endsWith("*")) {
		const prefix = wildcardPrefix(entry);
		return (/** @type {string} */ f) => f.startsWith(prefix);
	}
	return (/** @type {string} */ f) => f === entry;
}

/**
 * A path cited in prose, matched by **suffix** on a segment boundary. Section B
 * and Section C name a document the way a reader would say it —
 * `brand-sheet.md`, `notes/momtest.md` — not by full path. A trailing `/` or `*`
 * points at a directory and matches anything beneath it.
 *
 * Over-matching only marks a route live or suppresses a report the entry's
 * author asked to suppress. Never use it on a Section A row.
 *
 * Residual: the `*` form loosens check-doc-map.js's dead-path gate, which never
 * reads a route or restatement path written `docs/research/*` as dead.
 *
 * A leading `./` PINS the token to an exact path, suppressing the suffix
 * match: `./vitest.config.ts` matches the root-level file only, never
 * `scripts/census/vitest.config.ts` (mantahostels#2699). Without the pin, a root-level
 * filename is ambiguous with any namesake in a subdirectory — there is no
 * way to name "this path and no other" otherwise. The pin is checked first
 * and takes the token literally: `./docs/research/*` or `./docs/adr/`
 * compiles against that literal string, never against a tracked path, so a
 * pin never combines with the trailing `*`/`/` directory form.
 * @param {string} token
 */
function citationMatcher(token) {
	if (token.startsWith("./")) {
		const exact = token.slice(2);
		return (/** @type {string} */ f) => f === exact;
	}
	if (token.endsWith("*") || token.endsWith("/")) {
		const prefix = trimEndRun(token, "*");
		return (/** @type {string} */ f) =>
			f.startsWith(prefix) || f.includes(`/${prefix}`);
	}
	return (/** @type {string} */ f) => f === token || f.endsWith(`/${token}`);
}

/**
 * The paths one line registers, read from its first cell — empty on any line
 * that is not a register row.
 *
 * A first cell holding inline code that is not path-shaped is a class name or a
 * phrase, not a registered document, so the header row (`| Path | Role | …`),
 * the `|---|` separator and the Version-stamps table (`| Brand sheet version |
 * …`) all yield nothing.
 *
 * IT DOES NOT KNOW WHICH SECTION IT IS IN — the Authority-classes table above
 * Section A quotes the same paths, so every caller gates on the section itself.
 * Exported because lib/doc-map-regions.js keys a Section A row's arbiter region
 * on the first path this returns (mantahostels#1402).
 * @param {string} line
 */
function registerRowPaths(line) {
	if (!line.startsWith("|")) return [];
	return [...(line.split("|")[PATH_CELL] || "").matchAll(BACKTICKED)]
		.map((m) => requiredGroup(m, 1, BACKTICKED).trim())
		.filter((p) => p.includes("/") || p.endsWith(".md"));
}

/*
 * A register LIST — the second shape a §A subsection registers its documents
 * in (mantahostels#2743). A subsection whose every row carries the same class renders
 * as one path per line between the two markers below, the class stated once on
 * the opening marker, and Role, Update route and Consumes left in the sidecar
 * rather than rendered.
 *
 * The class rides on the marker so that §A stays self-describing in markdown:
 * `parseRegister` answers the class question for a listed path without the
 * sidecar, exactly as it does for a table row's Class cell, and so
 * `classExemptMatchers`, `scanScope` and `pairingHalfAgeMs` need no change.
 */
const LIST_BEGIN_RE = /^<!-- register-list: (.+?) -->$/;
const LIST_END = "<!-- /register-list -->";

/** @param {string} cls */
function listBegin(cls) {
	return `<!-- register-list: ${cls} -->`;
}

const LIST_PATH_RE = /^- `([^`]+)`$/;

/**
 * The path one register-list line names, or null on any other line.
 * @param {string} line
 */
function registerListPath(line) {
	const m = line.match(LIST_PATH_RE);
	if (!m) return null;
	const p = requiredGroup(m, 1, LIST_PATH_RE).trim();
	return p.includes("/") || p.endsWith(".md") ? p : null;
}

/**
 * Section A rows as `{ paths, cls }`, read from the region between the Section A
 * and Section B headings. The Authority-classes table above Section A is a table
 * too, and Section B quotes paths in prose, so both would yield phantom entries.
 *
 * `sidecar` moves the CLASS off the markdown (mantahostels#1849): given
 * docs/doc-map-classes.json's parsed contents, a row's `cls` is the class its
 * first path is keyed with there, and the row's own Class cell is not read at
 * all. A row the sidecar does not key keeps its cell — §A and the sidecar
 * agreeing is assertion 17's job, not this parser's, and a row silently
 * classless would exempt a file from every class-aware scan. Omitted, every
 * `cls` comes from the markdown exactly as before.
 * @param {string} text
 * @param {Record<string, {class?: string, classQualifier?: string|null}>|null} [sidecar]
 * @returns {RegisterRow[]}
 */
function parseRegister(text, sidecar = null) {
	const region = sectionARegion(text);
	if (!region) return [];
	const rows = [];
	// Fenced blocks are skipped, as lib/doc-map-regions.js skips them: §A's prose
	// quotes register rows to explain their shape, and reading a quoted one as a
	// row would register a document the arbiter has no region for, whose writer
	// then silently falls back to claiming the whole file.
	let fenced = false;
	/** The class the open register-list marker states, null outside one. */
	let listClass = null;
	for (const line of region.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
		/* A heading ends an open list as surely as the closing marker does. An
		 * unclosed marker would otherwise swallow every LATER subsection's table
		 * rows — they are not list lines, so nothing would push them. */
		if (/^#+ /.test(line)) listClass = null;
		const marker = registerListMarker(line);
		if (marker !== undefined) {
			listClass = marker;
			continue;
		}
		const row =
			listClass === null
				? registerTableRow(line, sidecar)
				: registerListRow(line, listClass, sidecar);
		if (row) rows.push(row);
	}
	return rows;
}

/**
 * The text between the Section A and Section B headings, or undefined where
 * there is no Section A.
 * @param {string} text
 */
function sectionARegion(text) {
	const sectionB = text.search(/^## Section B/m);
	return (sectionB === -1 ? text : text.slice(0, sectionB)).split(
		/^## Section A/m,
	)[1];
}

/**
 * The class a register-list opening marker states, null on the closing marker,
 * undefined on any other line.
 * @param {string} line
 * @returns {string|null|undefined}
 */
function registerListMarker(line) {
	const open = line.match(LIST_BEGIN_RE);
	if (open) return requiredGroup(open, 1, LIST_BEGIN_RE).trim();
	return line === LIST_END ? null : undefined;
}

/**
 * @param {string} line
 * @param {string} listClass
 * @param {Record<string, {class?: string, classQualifier?: string|null}>|null} sidecar
 * @returns {RegisterRow|null}
 */
function registerListRow(line, listClass, sidecar) {
	const p = registerListPath(line);
	if (!p) return null;
	const keyed = sidecar ? sidecar[p] : null;
	return {
		paths: [p],
		cls: keyed ? buildSidecarClassText(keyed) : listClass,
	};
}

/**
 * @param {string} line
 * @param {Record<string, {class?: string, classQualifier?: string|null}>|null} sidecar
 * @returns {RegisterRow|null}
 */
function registerTableRow(line, sidecar) {
	const paths = registerRowPaths(line);
	const [first] = paths;
	if (first === undefined) return null;
	const keyed = sidecar ? sidecar[first] : null;
	return {
		paths,
		cls: keyed
			? buildSidecarClassText(keyed)
			: (line.split("|")[CLASS_CELL] || "").trim(),
	};
}

/**
 * A sidecar entry's class as §A renders it — the token, plus the qualifier
 * where the entry carries one. `classExemptMatchers` tests this with
 * `includes`, so a qualified `source-of-truth · consumer` still answers the
 * same question a §A Class cell answered.
 * @param {{class?: string, classQualifier?: string|null}} entry
 */
function buildSidecarClassText(entry) {
	const cls = (entry.class || "").trim();
	const qualifier = (entry.classQualifier || "").trim();
	return qualifier ? `${cls} ${qualifier}` : cls;
}

/**
 * The path a table row registers, read from its first cell and matched against
 * `registered` — the register's own path set. Null on any line that is not a
 * table row, and on a row whose first cell names nothing registered.
 *
 * Does not know which section it is in — a caller wanting Section A rows only
 * must gate on that itself.
 * @param {string} line
 * @param {Set<string>} registered
 */
function registerRowPath(line, registered) {
	if (!line.startsWith("|")) return null;
	const cell = line.split("|")[PATH_CELL] || "";
	for (const m of cell.matchAll(BACKTICKED)) {
		const token = requiredGroup(m, 1, BACKTICKED).trim();
		if (registered.has(token)) return token;
	}
	return null;
}

/**
 * Every distinct path the register covers, in document order.
 * @param {string} text
 */
function registerPaths(text) {
	return [...new Set(parseRegister(text).flatMap((r) => r.paths))];
}

/** The class sidecar's basename, beside the map in its own data directory.
 * `SIDECAR_PATH` in lib/doc-map-regions.js is the same file's repo-relative
 * spelling; that module requires this one, so the constant cannot be shared the
 * other way round and lib/doc-map.test.ts pins the two together. */
const CLASSES_FILE = "doc-map-classes.json";

/**
 * The class sidecar for `mapPath`, parsed — beside the map first, then the
 * tracked `docs/doc-map-classes.json`, which is the pair check-doc-map.js
 * resolves too, so a run handed an out-of-repo copy of the map reads one
 * sidecar and not two.
 *
 * Null where there is none, it will not parse, or it is not an object. Null is
 * the caller's cue to read classes out of the markdown as before, and it is
 * deliberately softer than check-doc-map.js's BROKEN on the same condition: a
 * class-aware SCAN degrades to the route it used before mantahostels#1849, where the
 * coverage GATE must refuse rather than report a tree covered off a register it
 * could not read. `scanScope` still BROKENs where no Section A row reaches it
 * by either route.
 * @param {string} mapPath
 * @returns {Record<string, {class?: string, classQualifier?: string|null}>|null}
 */
function readSidecarBeside(mapPath) {
	/** @type {[string, string]} */
	const candidates = [
		path.join(path.dirname(mapPath), CLASSES_FILE),
		`docs/${CLASSES_FILE}`,
	];
	try {
		const file = candidates.find((f) => fs.existsSync(f)) || candidates[0];
		const data = JSON.parse(fs.readFileSync(file, "utf8"));
		return isPlainObject(data)
			? /** @type {Record<string, {class?: string, classQualifier?: string|null}>} */ (
					data
				)
			: null;
	} catch {
		return null;
	}
}

/**
 * Matchers for the class a wording or figure scan must skip: a `binary-asset`
 * carries no prose at all. Driven off the Section A class, never a path list,
 * so a file changing class changes what the scan says about it.
 * @param {RegisterRow[]} register
 */
function classExemptMatchers(register) {
	return register
		.filter((r) => r.cls.includes(BINARY_CLASS))
		.flatMap((r) => r.paths.map(sectionAMatcher));
}

/**
 * Classes the core holds for paths it names but may write only after `init`, in
 * force in every adopter with no sidecar key: `init` cannot mint the key, which
 * would sit DEAD-ENTRY until the first file lands, so the first file is covered
 * here instead — `manual-sync`'s archives (#428), the context-cost table an
 * upgrade may seed (#679), the two host registries it seeds (#1456), the
 * session cost table it builds from the host's dispatch ledger (#1734), and
 * the rules file's never-imported sibling (#2035).
 * @type {Readonly<Record<string, string>>}
 */
const CORE_CLASSES = Object.freeze({
	".claude/workflow-core.reference.md": "generated-only",
	"docs/archive/sync-proposals/*": "free-edit",
	"docs/archive/sync-reports/*": "free-edit",
	".claude/plugin-context-cost.json": "source-of-truth",
	"docs/data/session-cost-table.json": "generated-only",
	".claude/registrations.json": "source-of-truth",
	".claude/guard-fire-needles.json": "source-of-truth",
});

/**
 * Matchers for every path a document counts as registered by: each class
 * sidecar key, literal or `docs/x/*` glob, and each CORE_CLASSES path.
 * @param {string[]} sidecarKeys
 * @returns {((f: string) => boolean)[]}
 */
function coverageMatchers(sidecarKeys) {
	return [...sidecarKeys, ...Object.keys(CORE_CLASSES)].map((k) =>
		sectionAMatcher(k),
	);
}

/*
 * Dependency lockfiles, dropped by basename rather than by §A class: a lockfile
 * is not a document, is registered in neither §A nor the sidecar, and is written
 * only by its package manager, so a hit in one is noise by construction.
 *
 * Since mantahostels#2443 made every digit-bearing needle case-insensitive, a short
 * alphanumeric needle lands inside base64 integrity hashes (mantahostels#2458). Suppressing
 * such a hit by allowlist would pin an anchor to a hash string that changes on
 * the next `npm install`, so the whole file goes instead.
 *
 * TWO RESIDUALS. Matching is by basename, deliberately — a lockfile is a
 * lockfile wherever it sits, so a nested `vendor/package-lock.json` is dropped
 * too, and only a file NAMED like one but written by hand would be wrongly
 * skipped. And the collision is a property of the NEEDLE, not the file, so any
 * future tracked hash-soup file that is not a lockfile reproduces mantahostels#2458 and is
 * not covered here.
 *
 * Another package manager's spelling joins the set when one arrives, not before.
 */
const LOCKFILES = new Set(["package-lock.json", "skills-lock.json"]);

/** @param {string} file */
function isLockfile(file) {
	return LOCKFILES.has(path.basename(file));
}

/*
 * Recorded session transcripts, dropped by path: a recording is frozen at the
 * day it was made, so every figure or term it quotes is legitimate by
 * construction, and allowlisting them would cost a row per retired figure per
 * recording (#2415).
 *
 * Residual: a hand-written fixture named like a recording is dropped from every
 * scan unchecked, and a recording kept outside `scripts/fixtures/` stays in
 * scope.
 */
const RECORDED_TRANSCRIPT =
	/^scripts\/fixtures\/(?:[^/]+\/)*recorded-[^/]+\.jsonl$/;

/** @param {string} file */
function isRecordedTranscript(file) {
	return RECORDED_TRANSCRIPT.test(file);
}

/**
 * The files a class-aware Section B scan runs over, and how many of them Section
 * A exempted. BROKEN on either way it can fail, never a quiet empty scan.
 * @param {CheckContext} ctx
 * @param {{text: string, mapPath: string, checker: string}} spec
 */
function scanScope(ctx, { text, mapPath, checker }) {
	const register = parseRegister(text, readSidecarBeside(mapPath));
	/* A §A that parsed to nothing would scan every binary asset as prose (#428). */
	if (register.length === 0)
		ctx.broken(
			`no Section A row parsed from ${mapPath}. ` +
				"Without the register the scan cannot tell a binary asset from prose.",
		);
	const exempt = classExemptMatchers(register);

	let tracked;
	try {
		tracked = readTrackedFiles();
	} catch (e) {
		return ctx.broken(
			`git ls-files failed — ${caught(e).message}. No scan run.`,
		);
	}

	const isSelf = selfFilter(checker);
	return {
		files: tracked.filter(
			(f) =>
				!isSelf(f) &&
				!isLockfile(f) &&
				!isRecordedTranscript(f) &&
				!exempt.some((m) => m(f)),
		),
		/* Counted against Section A, not as the scan's shortfall: the checker, its
		 * test, the lockfiles and the recorded transcripts are dropped too, and
		 * none of them is class-exempt. */
		exemptCount: tracked.filter((f) => exempt.some((m) => m(f))).length,
	};
}

/* The two registries' heading patterns. The letter prefix makes each
 * unambiguous document-wide, so entries are found without splitting the file at
 * their section heading. */
const FIGURE_ID = /^### (B\d+)/;
const ROUTE_ID = /^### (C\d+)/;
/** A `### B<n>` heading a diff adds, capturing its id. */
const ADDED_FIGURE = /^\+### (B\d+)\b/gm;

/**
 * Registry entries as `{ id, heading, lines }`, in document order. Both
 * registries are written as `### <id> · <title>` running to the next heading of
 * any depth.
 * @param {string} text
 * @param {RegExp} idPattern
 * @returns {Entry[]}
 */
function parseEntries(text, idPattern) {
	/** @type {Entry[]} */
	const found = [];
	/** @type {Entry|null} */
	let current = null;
	for (const line of text.split("\n")) {
		const heading = line.match(idPattern);
		if (heading) {
			current = {
				id: requiredGroup(heading, 1, idPattern),
				heading: line,
				lines: [],
			};
			found.push(current);
			continue;
		}
		if (/^#+ /.test(line)) current = null;
		else if (current) current.lines.push(line);
	}
	return found;
}

// Everything whose consistency the update routine is responsible for. The app/
// tree is deliberately out — it builds a placeholder site due for a full rebuild
// against these docs, so registering it now would map fiction.
// PRODUCT.md and DESIGN.md joined at mantahostels#928: both are derived from docs/brand-sheet.md
// and restate figures §B owns, so an unregistered one rots silently on the next bump.
// hooks/ joined at #4: the plugin's generated hook manifest.
// self-plugin/ joined at #2584: the core's own hook registration, which hooks/
// renders from, and its marketplace manifest.
// GLOSSARY.md joined at #2720: the domain glossary, which restates rules its
// owner documents carry, so an unregistered one is never re-read when they change.
//
// .husky/pre-commit greps the same set to decide whether to run the gate at all;
// precommit-doc-map-gate.test.ts asserts the two stay in step.
const SCOPE = [
	"docs",
	".claude",
	"hooks",
	"self-plugin",
	"AGENTS.md",
	"CLAUDE.md",
	"PRODUCT.md",
	"DESIGN.md",
	"GLOSSARY.md",
];

// SCOPE entries are either a directory or an exact root file.
/**
 * @param {string[]} allTracked
 */
function inScope(allTracked) {
	return allTracked.filter((f) => isUnder(f, SCOPE));
}

/*
 * Routes cite documents as inline code, but so do slash-commands (`/pick-next`),
 * skill names (`concision-pass`), authority classes and shell one-liners. A span
 * counts as a path only if it holds no whitespace and either contains a "/" or
 * ends in a file extension; a leading "/" marks a command, not a root path.
 *
 * The extension must be alphabetic. Accepting digits read a version — `v1.89`,
 * or a contract clause like `6.1` — as a path.
 *
 * Section B's restatement paths do not come through here — they are read from
 * the data file (mantahostels#591).
 */
/** @param {string} body */
function pathTokens(body) {
	const paths = new Set();
	for (const m of body.matchAll(BACKTICKED)) {
		const token = requiredGroup(m, 1, BACKTICKED).trim();
		if (!token || /\s/.test(token) || token.startsWith("/")) continue;
		if (token.includes("/") || /\.[a-z]{1,5}$/i.test(token)) paths.add(token);
	}
	return [...paths];
}

/*
 * A route is written as labelled bullets — "**Read:**" names where to go,
 * "**Not:**" names the document that looks right and isn't. Both are checked
 * for existence: a route warning you off a renamed file is as broken as one
 * sending you to it. Only the Read bullet counts as *reaching* a file, or C7's
 * "**Not:** `docs/` alone" would mark all 56 docs as covered.
 *
 * Prose before the first bullet counts as a destination, so a route written
 * without labels degrades to reaching what it names rather than nothing.
 */
/** A route bullet's bold label, capturing its word. */
const ROUTE_LABEL = /^\s*[-*]\s+\*\*([^*]+?):?\*\*/;

/** @param {string[]} lines */
function routeCitations(lines) {
	const cites = [];
	let destination = true;
	for (const line of lines) {
		const bullet = line.match(ROUTE_LABEL);
		if (bullet)
			destination = /^read\b/i.test(
				requiredGroup(bullet, 1, ROUTE_LABEL).trim(),
			);
		for (const cited of pathTokens(line))
			cites.push({ path: cited, destination });
	}
	return cites;
}

/**
 * @param {string} text
 */
function parseRoutes(text) {
	return parseEntries(text, ROUTE_ID).map((r) => ({
		id: r.id,
		paths: routeCitations(r.lines),
	}));
}

/**
 * Words in Section B, whitespace-delimited, counting the `## Section B` heading
 * line and everything under it up to the next `## `. Markdown syntax is counted
 * as written — a budget on a registry nobody reads end to end is a proxy for
 * how much prose sits between a reader and the entry they want.
 * @param {string} text
 */
function sectionBWords(text) {
	const lines = text.split("\n");
	const range = sectionBRange(lines);
	if (!range) return 0;
	return lines
		.slice(range.start, range.end)
		.join("\n")
		.split(/\s+/)
		.filter(Boolean).length;
}

/**
 * §B's entry count right now — every non-stray `### B<n>` heading (mantahostels#1347, the
 * ticket that put the first factor of `entries × words-per-entry` next to the
 * word budget the second factor already has).
 * @param {string} text
 */
function sectionBEntryCount(text) {
	return figureHeadings(text.split("\n")).filter((h) => !h.stray).length;
}

/** The window mantahostels#1347 specifies — not a measured figure, the ticket's own choice. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
/** Below this, a single commit reads as a spike rather than a rate (mantahostels#1347). */
const MIN_SPAN_DAYS = 1;

/**
 * §B's entries-added-per-day rate, from `mapPath`'s git history — the level
 * signal mantahostels#1316 adopted in place of a scheduled or heterogeneity trigger,
 * neither of which fired on a metric.
 *
 * Walks the file's commit history to the newest commit at or before the
 * 7-day cutoff — the state §B was in at the start of the window — and
 * divides the entry-count delta by the actual elapsed span to that commit,
 * uncapped: capping the divisor at 7 while the delta spans longer would read
 * a slow map as a fast one whenever a gap in history pushes the baseline
 * past the cutoff. Where the file's whole history is younger than 7 days,
 * the oldest commit there stands in for the cutoff — `days` is always the
 * actual span measured, never a fixed 7.
 *
 * Returns null where no rate can be read: not a git repo, the file untracked,
 * `git show` failing on the baseline blob, or under a day of history.
 *
 * @param {string} mapPath
 * @param {number} currentEntries
 * @returns {{ rate: number, days: number } | null}
 */
function sectionBEntryRate(mapPath, currentEntries) {
	// git wants a path relative to the CWD it runs in, whatever form the
	// caller passed — as readTrackedFiles()/repoRelative() already assume.
	const relPath = repoRelative(mapPath);

	// Fails open (mantahostels#1347): a git-log failure means no rate line rather than a
	// broken build — mantahostels#1079's body is a report, never a gate (§N3's report-*
	// contract), so an unreadable history degrades to "unavailable".
	const log = gitOrNull([
		"log",
		"--format=%H %cI",
		"--follow",
		"--",
		relPath,
	])?.trim();
	if (!log) return null;

	const commits = log.split("\n").map((line) => {
		const [sha, date] = line.split(" ");
		if (sha === undefined || date === undefined)
			throw new Error(`git log printed a record with no date: ${line}`);
		return { sha, date: new Date(date) };
	});

	const now = Date.now();
	const cutoff = now - SEVEN_DAYS_MS;
	// Newest-first: the first commit at or before the cutoff is the state §B
	// was in at the start of the window. None found means the whole history
	// is younger than 7 days — fall back to the oldest commit there is.
	const baseline =
		commits.find((c) => c.date.getTime() <= cutoff) ?? commits.at(-1);
	if (baseline === undefined)
		throw new Error(`git log of ${relPath} printed text but no commit`);

	const days = (now - baseline.date.getTime()) / (24 * 60 * 60 * 1000);
	if (days < MIN_SPAN_DAYS) return null;

	// Fails open (mantahostels#1347) like the `git log` read above: a corrupt object,
	// or a shallow clone missing the baseline blob.
	const oldText = gitOrNull(["show", `${baseline.sha}:${relPath}`]);
	if (oldText === null) return null;

	const oldEntries = sectionBEntryCount(oldText);
	return { rate: (currentEntries - oldEntries) / days, days };
}

/**
 * §B's skeleton fields (`docs/doc-map.md` §B's preamble) — excluded, and
 * uncapped, from the 300-word prose cap (mantahostels#891).
 */
const SKELETON_FIELDS = [
	"Owner",
	"Inputs",
	"Restated in",
	"Supersedes",
	"Settled at",
];

/**
 * A bullet leader naming a skeleton field, bold or plain — `- **Owner:**`,
 * `- Settled at mantahostels#55`, `- Restated in: ...`. Matched on the leader only.
 *
 * **Top-level only** (no leading whitespace): a sub-bullet *nested under a
 * prose bullet* that opens on one of those words ("- Owner of the fee ...")
 * is prose, and matching it would drop it and everything indented under it
 * (mantahostels#1317).
 */
const SKELETON_LABEL = new RegExp(
	`^[-*]\\s+\\*{0,2}(?:${SKELETON_FIELDS.map((f) =>
		f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
	).join("|")})\\b`,
);

/**
 * A **top-level** bullet — no leading whitespace. `BULLET` (used by
 * `parseSupersedesText`) matches an indented one too, which is the wrong line to
 * end a skeleton bullet's continuation on: several live entries nest nuance
 * under `Restated in`/`Inputs`/`Supersedes` as indented sub-bullets (e.g.
 * a `Restated in` list), and those are still skeleton, not prose. Only a
 * dedent or a genuine new top-level bullet closes the run (mantahostels#1317).
 */
const TOP_LEVEL_BULLET = /^[-*]\s/;

/**
 * An entry's prose word count — its body (`parseEntries`'s `lines`, which
 * excludes the `### B<n>` heading) minus its skeleton. A skeleton bullet, and
 * every line indented under it (including its own nested sub-bullets), is
 * dropped whole; every other line is counted exactly as `sectionBWords`
 * counts §B as a whole, markdown syntax included (mantahostels#1317, building mantahostels#1311 Q4).
 * @param {string[]} lines
 */
function entryProseWords(lines) {
	let count = 0;
	let inSkeleton = false;
	for (const line of lines) {
		if (SKELETON_LABEL.test(line)) {
			inSkeleton = true;
			continue;
		}
		if (inSkeleton) {
			// A blank line does not close a list item: CommonMark keeps the
			// continuation open across one, so `- **Restated in:**` followed by a
			// blank and then an indented line is still that bullet's own value
			// (mantahostels#1317).
			if (!line.trim()) continue;
			if (TOP_LEVEL_BULLET.test(line) || !/^\s+\S/.test(line))
				inSkeleton = false;
			else continue;
		}
		count += (line.match(/\S+/g) || []).length;
	}
	return count;
}

/**
 * Every §B entry's prose word count, keyed by `B<n>` — the drain-queue
 * report's own reader (mantahostels#1317). `overCapEntries()` and `staleExemptionMarkers()`
 * run the same `parseEntries`/`entryProseWords` pair directly rather than
 * through this map, since both need the entry's lines too (mantahostels#2058).
 * @param {string} text
 */
function sectionBEntryProseWords(text) {
	/** @type {Record<string, number>} */
	const out = {};
	for (const entry of parseEntries(text, FIGURE_ID))
		out[entry.id] = entryProseWords(entry.lines);
	return out;
}

/** The 300-word-per-entry prose cap (mantahostels#891). */
const PROSE_CAP_WORDS = 300;

/**
 * The over-cap exemption marker's shape (`docs/doc-map.md` §B preamble,
 * mantahostels#2057): a top-level bullet, bold leader, the ruling ticket in parentheses.
 * No date, no count — the count is read from `overCapEntries()`, never
 * written into the marker.
 */
const EXEMPTION_MARKER = /^[-*]\s+\*\*Over cap by ruling \(#(\d+)\):\*\*/;

/**
 * The ticket an entry's own exemption marker cites, or null where it carries
 * none. Only a top-level bullet counts — an indented sub-bullet echoing the
 * text is not a marker (mantahostels#2058). Where an entry carries two, the first wins.
 * @param {string[]} lines
 * @returns {number | null}
 */
function entryExemptedAt(lines) {
	for (const line of lines) {
		const m = EXEMPTION_MARKER.exec(line);
		if (m) return Number(m[1]);
	}
	return null;
}

/**
 * A line that reaches for the exemption marker and misses — the bullet, the
 * emphasis, the case, the hyphen or the `(#n)` spelled some other way.
 * Anchored at the line's start, after an optional bullet and optional emphasis
 * leader, so a mid-sentence mention inside an entry's prose is not one.
 *
 * Deliberately loose where `EXEMPTION_MARKER` is exact: every shape here is
 * already invalid as a marker, so a wider probe costs a WARN and never an
 * exemption. `over-cap` is admitted because the repo spells the adjective that
 * way everywhere.
 *
 * **Residual, unrefused:** the probe is punctuation-shaped, so a misspelling of
 * the WORDS — `Over cap by rule`, `Over cap per ruling`, a translated or
 * abbreviated leader — reads as ordinary prose and is silent, which is the same
 * fail-open mantahostels#2124 exists to close, one class narrower. Widening it further
 * needs a similarity measure rather than a regex, and would start warning on
 * prose that merely discusses the cap.
 */
const EXEMPTION_MARKER_NEAR_MISS =
	/^\s*(?:[-*+]\s*)?(?:[*_]{1,3}\s*)?over[- ]cap by ruling\b/i;

/**
 * Entries carrying a near-miss marker and no valid one (mantahostels#2124). Such an entry
 * reads as unexempted
 * everywhere: it sits in the drain queue as a candidate its author believed
 * exempt, and it escapes assertion 22's no-growth gate, which only ever runs on
 * a marked entry.
 *
 * Scoped to entries with no valid marker deliberately. An entry that already
 * carries one is correctly exempt, so a second line echoing the words — the
 * indented sub-bullet mantahostels#2058 ruled is not a marker among them — changes nothing
 * and is not reported.
 * @param {string} text
 * @returns {{ id: string, line: string }[]}
 */
function malformedExemptionMarkers(text) {
	const out = [];
	for (const entry of parseEntries(text, FIGURE_ID)) {
		if (entryExemptedAt(entry.lines) !== null) continue;
		for (const line of entry.lines)
			if (EXEMPTION_MARKER_NEAR_MISS.test(line))
				out.push({ id: entry.id, line: line.trim() });
	}
	return out;
}

/**
 * Over-cap entries, largest excess first — the drain queue's own worklist
 * (mantahostels#1311 Q3). Report-only: nothing here refuses a commit. `exemptedAt` is
 * the ruling that marks the entry exempt, or null where it carries no marker
 * (mantahostels#2058).
 * @param {string} text
 * @returns {{ id: string, words: number, excess: number, exemptedAt: number | null }[]}
 */
function overCapEntries(text) {
	const out = [];
	for (const entry of parseEntries(text, FIGURE_ID)) {
		const words = entryProseWords(entry.lines);
		if (words > PROSE_CAP_WORDS)
			out.push({
				id: entry.id,
				words,
				excess: words - PROSE_CAP_WORDS,
				exemptedAt: entryExemptedAt(entry.lines),
			});
	}
	return out.sort((a, b) => b.excess - a.excess);
}

/**
 * Marked entries that are no longer over cap — a stale exemption, invisible
 * to `overCapEntries()` because a fallen entry drops out of it entirely.
 * Runs over every §B entry, not just the over-cap ones (mantahostels#2058).
 * @param {string} text
 * @returns {{ id: string, words: number, exemptedAt: number }[]}
 */
function staleExemptionMarkers(text) {
	const out = [];
	for (const entry of parseEntries(text, FIGURE_ID)) {
		const exemptedAt = entryExemptedAt(entry.lines);
		if (exemptedAt === null) continue;
		const words = entryProseWords(entry.lines);
		if (words <= PROSE_CAP_WORDS) out.push({ id: entry.id, words, exemptedAt });
	}
	return out;
}

/**
 * The line that opens §Capture and placement §5's shed ledger. Located by this
 * stem rather than by its heading text: the heading has been respelled and a
 * heading match would silently find nothing. Respelling the stem breaks
 * scripts/measure-shed-ledger/scan_ledger.py, which locates the list the same way.
 */
const LEDGER_STEM = "Sheds paid, most recent first";

/**
 * The per-entry byte cap on that ledger. A judgement, not a measurement
 * (mantahostels#1640, re-derived at mantahostels#1889 and mantahostels#2236, which holds the working): worst live
 * five-element base (325 B) plus widest live one-subject verdict (107 B) is
 * 432 B, covered by 440 B with 8 B to spare.
 *
 * The evidence that would move it again: a post-mantahostels#1719 base above ~333 B, or a
 * seventh element. Do NOT re-derive off the whole ledger's median (339 B) — it
 * is dominated by pre-mantahostels#1719 entries that can never present a six-element entry.
 */
const LEDGER_ENTRY_CAP_BYTES = 440;

/**
 * §5's tranche entries, newest first — everything nested under LEDGER_STEM,
 * grouped so one entry is one bullet PLUS its continuation and sub-bullet
 * lines. Grouping rather than one-line-per-entry is what stops the cap being
 * evaded by splitting a long tranche across sub-bullets, and what stops
 * `.slice(1)` charging the newest entry's second line to the entry below it.
 *
 * The sibling `Rejected, with the residual reason:` list is out of scope
 * (mantahostels#1640): it sits at the stem's own indent, not nested under it, and is
 * already in the compact shape this cap enforces.
 *
 * Returns null where the stem is absent, which is "this is not the doc map",
 * not "the ledger is empty".
 *
 * @param {string} text
 * @returns {string[][] | null} one array of lines per entry
 */
function shedLedgerEntries(text) {
	const lines = text.split("\n");
	const stem = lines.findIndex((l) => l.includes(LEDGER_STEM));
	const stemLine = lines[stem];
	if (stemLine === undefined) return null;
	const stemIndent = (stemLine.match(/^\s*/) || [""])[0].length;
	/** @type {string[][]} */
	const out = [];
	let entryIndent = Number.POSITIVE_INFINITY;
	for (const line of lines.slice(stem + 1)) {
		const indent = (line.match(/^\s*/) || [""])[0].length;
		// A blank line, or any line at or left of the stem's own indent, ends the
		// list: the next sibling bullet, §5's closing prose, the next heading.
		if (!line.trim() || indent <= stemIndent) break;
		const bullet = /^\s*- /.test(line);
		// The shallowest bullet depth seen is the entry depth; anything deeper,
		// and any non-bullet line, continues the entry above it.
		const entry = out.at(-1);
		if (bullet && indent <= entryIndent) {
			entryIndent = indent;
			out.push([line]);
		} else if (entry) entry.push(line);
		else break;
	}
	return out;
}

/**
 * Ledger entries over the cap, excluding the newest. Bytes are the entry's
 * lines as written, indents included and newlines excluded — what a `grep` hit
 * on it delivers into a session's context, which is the cost being capped.
 *
 * @param {string} text
 * @returns {{ label: string, bytes: number, excess: number }[] | null}
 */
function overCapLedgerEntries(text) {
	const entries = shedLedgerEntries(text);
	if (entries === null) return null;
	return entries
		.slice(1)
		.map((entry) => ({
			label: ledgerEntryLabel(entry),
			bytes: entry.reduce((n, l) => n + Buffer.byteLength(l, "utf8"), 0),
		}))
		.filter((e) => e.bytes > LEDGER_ENTRY_CAP_BYTES)
		.map((e) => ({ ...e, excess: e.bytes - LEDGER_ENTRY_CAP_BYTES }))
		.sort((a, b) => b.excess - a.excess);
}

/**
 * The marker a §5 ledger entry's prediction opens with. Prefix-matched without
 * its colon, because an entry spells it `**Prediction:**` and a carried copy
 * spells its own state instead (`**Carried, 3 of 3 and LAPSED (mantahostels#1965):**`),
 * which must NOT read as the carrier's own prediction (mantahostels#1888).
 */
const PREDICTION_MARKER = "**Prediction";

/**
 * The marker its verdict opens with, prefix-matched for the same reason: the
 * shape §5 fixes is `**Verdict: held** — …`, so the colon sits inside the
 * emphasis rather than after it.
 */
const VERDICT_MARKER = "**Verdict";
/** A verdict marker naming the entry it judges, capturing its `#<n>`. */
const VERDICT_ON = /^\s+on\s+(#\d+)/;

/**
 * Words in the verdict THIS entry carries, or null where it carries none.
 *
 * Two things narrow the search, both from the shape §5 fixes.
 *
 * A marker reading `**Verdict on #<other>:**` is a verdict written onto the
 * wrong entry — the mantahostels#1647/mantahostels#1648 breach mantahostels#1966 repaired — so it is skipped rather
 * than counted, and the scan goes on to the next marker.
 *
 * The count runs to the end of the line or to the next bold element, whichever
 * comes first: an entry is one bullet, so an empty `**Verdict:**` followed by
 * `**Residual:** …` would otherwise borrow the residual's words.
 *
 * Only tokens carrying an alphanumeric count — `:`, `**` and `—` are punctuation
 * of the marker's own shape. Assertion 16 needs no such filter: its
 * `**Trigger:**` closes its emphasis before the text begins.
 *
 * @param {string} text the entry's lines, joined
 * @param {string} issue the entry's own `#<n>`
 * @returns {number | null}
 */
function verdictWordCount(text, issue) {
	for (let at = text.indexOf(VERDICT_MARKER); at !== -1; ) {
		let [rest] = cutAt(text.slice(at + VERDICT_MARKER.length), "\n");
		const named = rest.match(VERDICT_ON);
		if (named && requiredGroup(named, 1, VERDICT_ON) !== issue) {
			at = text.indexOf(VERDICT_MARKER, at + VERDICT_MARKER.length);
			continue;
		}
		const nextElement = rest.search(/\*\*[A-Z]/);
		if (nextElement !== -1) rest = rest.slice(0, nextElement);
		return rest.split(/\s+/).filter((w) => /[0-9a-z]/i.test(w)).length;
	}
	return null;
}

/**
 * Assertion 20's worklist (mantahostels#1968, on mantahostels#1890's ruling): the fault, if any, in the
 * verdict a COMPACTION owes §5's ledger.
 *
 * The discriminator is exact rather than proxied. A prediction's text is
 * dropped at compaction, so a checker reading only the staged entry cannot tell
 * whether one was owed — but HEAD's copy of that same entry still carries it.
 * So: where HEAD's newest entry is no longer the staged newest and still
 * appears in the staged ledger, it has been compacted; read HEAD's copy for a
 * prediction, and require a `**Verdict` marker with at least
 * `TRIGGER_VERDICT_MIN_WORDS` words after it in the staged copy.
 *
 * Reading the marker's PRESENCE also covers the folding limb mantahostels#1864 ruled
 * against: a verdict folded into the named residual carries no marker at all.
 *
 * Rejected (mantahostels#1890), the discriminator being exact: a date proxy for
 * "postdates mantahostels#1719", and a provenance opt-out, which mantahostels#1885 forbids.
 *
 * HEAD ALONE, never `readCommittedRevs()`. An in-flight second parent widens
 * assertions 14 and 16 — a merge's other side has already paid for what it
 * added — but it would NARROW this one, refusing a merge for a compaction the
 * other branch committed (mantahostels#1968's review).
 *
 * Entries are matched by label (`entryLabel`), falling back, for one relabelled
 * as it was compacted, to the one entry new to this commit under the same issue
 * (#1739). An entry gone from the staged ledger entirely is silent here rather
 * than a fault: that is a deletion, which is not what this gates.
 *
 * Three residuals are deliberately outside it (mantahostels#1890) — a missing PREDICTION,
 * a verdict whose content is STALE rather than absent, and a sixth element that
 * is not a verdict, the last of which Q2 declined a marker whitelist for.
 *
 * @param {string[][]} entries the STAGED `shedLedgerEntries(text)`, newest first
 * @param {string[][] | null} committed HEAD's, or null where HEAD has none
 * @returns {{ label: string, fault: string }[]}
 */
function compactionVerdictFaults(entries, committed) {
	const newest = entries[0];
	if (committed === null) return [];
	const displaced = committed[0];
	if (newest === undefined || displaced === undefined) return [];
	const label = ledgerEntryLabel(displaced);
	// Still the newest: this commit compacted nothing.
	if (label === ledgerEntryLabel(newest)) return [];
	const issue = ledgerEntryIssue(displaced);
	const held = new Set(committed.map(ledgerEntryLabel));
	const older = entries.slice(1);
	const compacted =
		older.find((e) => ledgerEntryLabel(e) === label) ??
		// Relabelled as it was compacted: the one entry new to this commit under
		// the displaced entry's issue.
		older.find(
			(e) => ledgerEntryIssue(e) === issue && !held.has(ledgerEntryLabel(e)),
		);
	if (!compacted) return [];
	if (!displaced.join("\n").includes(PREDICTION_MARKER)) return [];
	const n = verdictWordCount(compacted.join("\n"), issue);
	if (n === null)
		return [
			{
				label,
				fault:
					"it carried a prediction and its compacted form carries no " +
					`\`${VERDICT_MARKER}\` verdict of its own`,
			},
		];
	if (n < TRIGGER_VERDICT_MIN_WORDS)
		return [
			{
				label,
				fault:
					`its \`${VERDICT_MARKER}\` verdict is ${n} word(s); ` +
					`${TRIGGER_VERDICT_MIN_WORDS} is the floor`,
			},
		];
	return [];
}

/** The map's own tracked path, the fallback `readHeadMapText` reads (mantahostels#1384). */
const DEFAULT_MAP_PATH = "docs/doc-map.md";

/**
 * `rev`'s copy of `file` as text, trying `file`'s repo-relative path and then
 * `fallback`, or null where neither resolves. Never throws.
 * @param {string} rev
 * @param {string} file
 * @param {string} fallback
 * @returns {string | null}
 */
function readCommittedTextAt(rev, file, fallback) {
	for (const p of new Set([repoRelative(file), fallback])) {
		try {
			return execGit(["show", `${rev}:${p}`], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			// Try the next candidate path; the `return null` below answers for
			// every failure alike.
		}
	}
	return null;
}

/**
 * `rev`'s copy of the doc map as text, or null where there is none to read.
 *
 * Two candidate paths, in order, because the map handed to a checker is not
 * always the tracked file: `.husky/pre-commit` feeds it (mantahostels#1191) a
 * `$(mktemp -d)` copy of the INDEX, a path with no git identity at all, so
 * `<rev>:<that>` resolves to nothing, and the tracked path answers instead
 * (mantahostels#1384).
 *
 * Null on every failure and never a throw: no HEAD yet (a first commit on a
 * fresh checkout), the map untracked, outside a repo, git broken.
 * @param {string} rev
 * @param {string} mapPath
 * @returns {string | null}
 */
function readMapTextAt(rev, mapPath) {
	return readCommittedTextAt(rev, mapPath, DEFAULT_MAP_PATH);
}

/**
 * `HEAD`'s copy of the doc map, or null. A caller reads null as "cannot tell
 * which entries are new" and asserts nothing — never as "none are new", which
 * would pass a commit silently.
 * @param {string} mapPath
 * @returns {string | null}
 */
function readHeadMapText(mapPath) {
	return readMapTextAt("HEAD", mapPath);
}

/**
 * The pseudo-refs naming a second parent while an operation is mid-flight. A
 * resolved merge is committed with the index holding both sides' work, and
 * every entry arriving from the OTHER parent is absent from `HEAD` — so
 * without these an assertion comparing against HEAD alone refuses a merge for
 * entries somebody else already committed (mantahostels#1384). Rebase, cherry-pick and
 * revert have the same shape.
 */
const IN_FLIGHT_REFS = [
	"MERGE_HEAD",
	"REBASE_HEAD",
	"CHERRY_PICK_HEAD",
	"REVERT_HEAD",
];

/**
 * `HEAD`, plus the sha of each of `refs` that resolves. An absent ref is the
 * ordinary case, nothing mid-flight; a git that will not answer is BROKEN,
 * never a quiet HEAD alone (#3184).
 * @param {readonly string[]} refs
 * @returns {string[]}
 */
function readHeadAnd(refs) {
	const revs = ["HEAD"];
	for (const ref of refs) {
		const sha = readCommitOrBroken(ref);
		if (sha !== null) revs.push(sha);
	}
	return revs;
}

/**
 * Every rev whose copy of the map counts as "already committed" right now:
 * `HEAD`, plus any in-flight second parent that resolves.
 * @returns {string[]}
 */
const readCommittedRevs = () => readHeadAnd(IN_FLIGHT_REFS);

/**
 * The §B ids ALREADY COMMITTED — HEAD's, widened by whatever is mid-flight
 * (`readCommittedRevs`), read through `sectionBEntryProseWords` rather than a
 * heading scan so both callers measure by the one canonical parser (mantahostels#1311).
 *
 * The baseline behind every added-vs-edited discriminator here: an id in this
 * set was written by an earlier commit, so nothing this commit does to it is
 * that commit's to answer for. Returns null where HEAD holds no copy to
 * compare against — see `readHeadMapText`, whose "cannot tell which are new" is
 * not "none are". A git that will not answer is BROKEN.
 * @param {string} mapPath
 * @returns {Set<string> | null}
 */
function readCommittedEntryIds(mapPath) {
	const head = readHeadMapText(mapPath);
	if (head === null) return null;
	const ids = new Set();
	for (const rev of readCommittedRevs()) {
		const t = rev === "HEAD" ? head : readMapTextAt(rev, mapPath);
		if (t === null) continue;
		for (const id of Object.keys(sectionBEntryProseWords(t))) ids.add(id);
	}
	return ids;
}

/**
 * The §B entries `text` ADDS relative to HEAD's copy of the map, that are over
 * the 300-word prose cap — the worklist behind check-doc-map.js's assertion 14
 * (mantahostels#1384, on mantahostels#1350's ruling).
 *
 * Added, never edited, on `readCommittedEntryIds`'s baseline: a one-word
 * correction to a fat entry costs nothing — the on-touch scope mantahostels#1311 refused.
 * Returns null where that baseline is unreadable.
 * @param {string} text
 * @param {string} mapPath
 * @returns {{ id: string, words: number, excess: number }[] | null}
 */
function newOverCapEntries(text, mapPath) {
	const headIds = readCommittedEntryIds(mapPath);
	if (headIds === null) return null;
	return Object.entries(sectionBEntryProseWords(text))
		.filter(([id, words]) => !headIds.has(id) && words > PROSE_CAP_WORDS)
		.map(([id, words]) => ({ id, words, excess: words - PROSE_CAP_WORDS }))
		.sort((a, b) => b.excess - a.excess);
}

/**
 * The high-water mark a data file's text holds — the number of the highest
 * `### B<n>` id ever removed from the map — or null where the text is not a
 * JSON object whose `highWaterMark` is a non-negative integer.
 * @param {string} raw
 * @returns {number | null}
 */
function parseHighWaterMark(raw) {
	try {
		const parsed = JSON.parse(raw);
		const mark = isPlainObject(parsed) ? parsed.highWaterMark : undefined;
		return typeof mark === "number" && Number.isInteger(mark) && mark >= 0
			? mark
			: null;
	} catch {
		return null;
	}
}

/** How to write a missing high-water mark file, for every reader that finds none. */
const HIGH_WATER_MARK_REMEDY =
	'Write it as { "highWaterMark": <n> }, n being the number of the highest ' +
	"§B id ever removed from the map (0 where none has been).";

/**
 * HEAD's high-water mark, read from `file`'s committed copy (the tracked
 * default path standing in for a pre-commit temp copy, as `readMapTextAt` does), or
 * null where HEAD holds no readable copy.
 * @param {string} file
 * @returns {number | null}
 */
function readHeadHighWaterMark(file) {
	const raw = readCommittedTextAt(
		"HEAD",
		file,
		path.posix.join(path.posix.dirname(DEFAULT_MAP_PATH), DATA_FILES.highWater),
	);
	return raw === null ? null : parseHighWaterMark(raw);
}

/** The number a one-letter-prefixed id carries: `B12` → 12, `R3` → 3.
 * @param {string} id */
const idNumber = (id) => Number(id.slice(1));

/** @param {string[]} ids */
const sortedByIdNumber = (ids) =>
	[...ids].sort((a, b) => idNumber(a) - idNumber(b));

/**
 * The §B ids `text` ADDS relative to the committed map (`readCommittedEntryIds`)
 * whose number is at or below `mark` — an id a removed entry may have held, so
 * reusing it would make a stale reference resolve to the wrong entry
 * (mantahostels#892). check-doc-map.js's assertion 12. Null where the committed
 * map is unreadable.
 * @param {string} text
 * @param {string} mapPath
 * @param {number} mark
 * @returns {string[] | null}
 */
function newIdsAtOrBelowMark(text, mapPath, mark) {
	const headIds = readCommittedEntryIds(mapPath);
	if (headIds === null) return null;
	return sortedByIdNumber(
		Object.keys(sectionBEntryProseWords(text)).filter(
			(id) => !headIds.has(id) && idNumber(id) <= mark,
		),
	);
}

/**
 * The §B ids HEAD's copy of the map holds that `text` does not — the entries
 * this commit removes. check-doc-map.js's assertion 13. Null where HEAD holds
 * no copy.
 * @param {string} text
 * @param {string} mapPath
 * @returns {string[] | null}
 */
function idsRemovedSinceHead(text, mapPath) {
	const head = readHeadMapText(mapPath);
	if (head === null) return null;
	const live = sectionBEntryProseWords(text);
	return sortedByIdNumber(
		Object.keys(sectionBEntryProseWords(head)).filter((id) => !(id in live)),
	);
}

/** `https://github.com/<owner>/<repo>/issues/<n>#issuecomment-<n>` and nothing
 * else. Strict on purpose: the URL is the field that carries the ordering, and
 * a shape this checker cannot resolve to an issue number is one it cannot
 * cross-check against `settledAt`. */
const ADMISSION_COMMENT_URL =
	/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)#issuecomment-\d+$/;

/**
 * The §B ids `text` ADDS relative to HEAD's copy of the map that carry no
 * conforming row in the admissions sidecar — check-doc-map.js's assertion 29
 * (mantahostels#3225, building mantahostels#2888's design on mantahostels#2884's deferral).
 *
 * Added, never edited, on `readCommittedEntryIds`'s baseline and for the reason
 * stated there.
 *
 * The sidecar is read for PRESENCE and FIELD SHAPE only, never fetched. What
 * the shape buys is stated at the sidecar's own `_schema`: `commentUrl` cannot
 * be obtained before the comment exists, so filling it honestly forces the
 * confirmation comment to precede the writing commit.
 *
 * A CAP SPLIT is not an admission (mantahostels#2920): mantahostels#1350's 300-word cap can force an
 * entry's substance into a fresh id nobody confirmed, so such a row says
 * `capSplit` and the id it came from and carries no confirmation at all.
 *
 * `settledIssues` maps an id to the issue numbers its own `Settled at` bullet
 * names, so the row's `settledAt` can be cross-checked against the entry.
 * An entry naming none is not
 * cross-checked; assertion 10 is what refuses a missing bullet.
 *
 * Returns null where `readCommittedEntryIds` cannot read its baseline.
 * @param {string} text
 * @param {string} mapPath
 * @param {Record<string, unknown> | null} admissions
 * @param {Record<string, number[]>} [settledIssues]
 * @returns {{ id: string, why: string }[] | null}
 */
function unrecordedAdmissions(text, mapPath, admissions, settledIssues = {}) {
	const headIds = readCommittedEntryIds(mapPath);
	if (headIds === null) return null;
	/** @type {{ id: string, why: string }[]} */
	const faults = [];
	for (const id of Object.keys(sectionBEntryProseWords(text))) {
		if (headIds.has(id)) continue;
		const why = admissionRowFault(admissions?.[id], settledIssues[id] || []);
		if (why !== null) faults.push({ id, why });
	}
	return faults.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Why one admissions-sidecar row fails `unrecordedAdmissions`, or null where it
 * conforms. `named` is the issue numbers the entry's own `Settled at` bullet
 * names.
 * @param {unknown} row
 * @param {number[]} named
 * @returns {string|null}
 */
function admissionRowFault(row, named) {
	if (row === undefined) return "no row in the admissions sidecar";
	if (!isPlainObject(row)) return "its row is not an object";
	const { settledAt, confirmed, commentUrl, capSplit, from } = row;
	if (!Number.isInteger(settledAt) || Number(settledAt) <= 0)
		return "`settledAt` is not a positive integer issue number";
	if (named.length > 0 && !named.includes(Number(settledAt)))
		return (
			`\`settledAt\` names #${settledAt}, but the entry's own \`Settled at\` ` +
			`bullet names ${named.map((n) => `#${n}`).join(", ")}`
		);
	if (capSplit === true) {
		if (typeof from !== "string" || !/^B\d+$/.test(from))
			return "`capSplit` is set but `from` names no `B<n>` the split came from";
		return null;
	}
	if (typeof confirmed !== "string" || confirmed.trim() === "")
		return "`confirmed` is empty or not a string";
	const m =
		typeof commentUrl === "string" && commentUrl.match(ADMISSION_COMMENT_URL);
	if (!m) return "`commentUrl` is not a GitHub issue-comment permalink";
	if (Number(m[1]) !== settledAt)
		return `\`commentUrl\` points at issue #${m[1]}, but \`settledAt\` names #${settledAt}`;
	return null;
}

/**
 * The revs whose map counts as this commit's BASELINE: `HEAD`, plus a merge's
 * other parent. Narrower than `readCommittedRevs()` on purpose (mantahostels#2050's review):
 * this one takes a MAXIMUM word count, and `REVERT_HEAD` and `CHERRY_PICK_HEAD`
 * name the SOURCE commit rather than a parent, so a fat source would raise the
 * baseline and mask real growth.
 * @returns {string[]}
 */
const readParentRevs = () => readHeadAnd(["MERGE_HEAD"]);

/**
 * Over-cap §B entries carrying an `Over cap by ruling (#n)` marker whose prose
 * has GROWN since the baseline — the worklist behind check-doc-map.js's
 * assertion 22 (mantahostels#2050, on option (A)).
 *
 * The marker disapplies the §B preamble's on-touch reduction, which is the only
 * thing bounding every OTHER over-cap entry, so a marked entry had nothing at
 * all standing against an addition (mantahostels#2050).
 *
 * BASELINE IS THE LARGEST COUNT ACROSS `readParentRevs()` — HEAD, plus a merge's
 * other parent, whose growth this commit did not make. It is a per-commit
 * comparison and not a high-water mark: growth that lands becomes the next
 * commit's baseline.
 *
 * THE ENTRY MUST BE MARKED ON BOTH SIDES. An entry the baseline did not mark is
 * skipped, because the marker's own bullet counts as prose: the commit that
 * FIRST marks an undrainable entry — the act the §B preamble prescribes —
 * would otherwise be warned for the marker it was told to write.
 *
 * An id no baseline rev holds is a BIRTH, and assertion 14's business. An entry
 * at or under the cap is skipped too: it is either ordinary or assertion 21's
 * stale marker.
 *
 * DROPPING THE MARKER takes the entry out of this list entirely — assertion 21
 * sees a missing marker only on an entry that has fallen UNDER the cap. That is
 * `droppedExemptionMarkers`'s business.
 *
 * Returns null where HEAD holds no copy to compare against — see `readHeadMapText`.
 * @param {string} text
 * @param {string} mapPath
 * @returns {{ id: string, words: number, was: number, growth: number, exemptedAt: number }[] | null}
 */
function grownExemptEntries(text, mapPath) {
	const head = readHeadMapText(mapPath);
	if (head === null) return null;
	const baseline = exemptBaseline(head, mapPath);
	const out = [];
	for (const entry of parseEntries(text, FIGURE_ID)) {
		const exemptedAt = entryExemptedAt(entry.lines);
		if (exemptedAt === null) continue;
		const words = entryProseWords(entry.lines);
		if (words <= PROSE_CAP_WORDS) continue;
		const was = baseline[entry.id];
		if (was === undefined || !was.marked || words <= was.words) continue;
		out.push({
			id: entry.id,
			words,
			was: was.words,
			growth: words - was.words,
			exemptedAt,
		});
	}
	return out.sort((a, b) => b.growth - a.growth);
}

/**
 * `grownExemptEntries`'s baseline: each entry's largest prose count across
 * `readParentRevs()`, and whether the rev holding that count marked it.
 * @param {string} head
 * @param {string} mapPath
 */
function exemptBaseline(head, mapPath) {
	/** @type {Record<string, { words: number, marked: boolean }>} */
	const baseline = {};
	for (const rev of readParentRevs()) {
		const t = rev === "HEAD" ? head : readMapTextAt(rev, mapPath);
		if (t === null) continue;
		for (const entry of parseEntries(t, FIGURE_ID)) {
			const words = entryProseWords(entry.lines);
			const prior = baseline[entry.id];
			if (prior !== undefined && words <= prior.words) continue;
			baseline[entry.id] = {
				words,
				marked: entryExemptedAt(entry.lines) !== null,
			};
		}
	}
	return baseline;
}

/**
 * §B entries the baseline marked over cap by ruling that carry no valid marker
 * now and are still over the cap — the worklist behind check-doc-map.js's
 * assertion 24 (mantahostels#2227, on option (A)).
 *
 * THE DROP IS CAUGHT AND NOT THE GROWTH: the growth can be spread into a commit
 * where the entry is unmarked on both sides, which nothing reaches. The
 * three-commit sequence is in mantahostels#2227.
 *
 * BASELINE IS HEAD ALONE, and NOT assertion 22's `readParentRevs()` — this one takes
 * a PRESENCE where 22 takes a maximum word count. Any parent counting as marked
 * would charge a merge for a drop that happened, and was warned, on `main` weeks
 * earlier and that the merge did nothing to cause.
 *
 * THREE SKIPS. An entry at or under the cap is the sanctioned drain — the §B
 * preamble asks for exactly that, and assertion 21 governs the marker left
 * behind. An entry HEAD did not mark never had one to drop. And an entry absent
 * from `text` is a deletion, which the §B preamble's permanent-id
 * rule governs and this cannot tell apart from a rename.
 *
 * OVERLAPS ASSERTION 23 DELIBERATELY where the marker was downgraded rather
 * than deleted — an indented or mis-spelled bullet reads as null here too, so
 * both warn. They say different things: 23 that the line does not parse, this
 * one that the ratchet's baseline went with it.
 *
 * TWO RESIDUALS, both unrefused. A merge resolution that drops a marker only
 * MERGE_HEAD carried is invisible, which is HEAD-alone's price. And the
 * downgraded-marker case escapes in a narrow band: indenting the bullet takes
 * its own ~22 words out of `entryProseWords` too, so an entry reading 301..~322
 * WITH the marker reads at or under the cap without it and hits the first skip.
 * Assertion 23 still warns there, but on spelling — its advice says nothing
 * about the ratchet.
 *
 * Returns null where HEAD holds no copy to compare against — see `readHeadMapText`.
 * @param {string} text
 * @param {string} mapPath
 * @returns {{ id: string, words: number, exemptedAt: number }[] | null}
 */
function droppedExemptionMarkers(text, mapPath) {
	const head = readHeadMapText(mapPath);
	if (head === null) return null;
	/** @type {Record<string, number>} */
	const markedAt = {};
	for (const entry of parseEntries(head, FIGURE_ID)) {
		const at = entryExemptedAt(entry.lines);
		if (at !== null) markedAt[entry.id] = at;
	}
	const out = [];
	for (const entry of parseEntries(text, FIGURE_ID)) {
		if (entryExemptedAt(entry.lines) !== null) continue;
		const exemptedAt = markedAt[entry.id];
		if (exemptedAt === undefined) continue;
		const words = entryProseWords(entry.lines);
		if (words <= PROSE_CAP_WORDS) continue;
		out.push({ id: entry.id, words, exemptedAt });
	}
	return out.sort((a, b) => b.words - a.words);
}

/** Splits `git log`'s per-commit records below; \x1e cannot occur in the map. */
const LOG_RECORD_SEP = "\x1e";

/**
 * Every §B entry born in `mapPath`'s last `windowMs` of history, with the prose
 * word count it was born at — the observable half of mantahostels#1384.
 *
 * BIRTH PROSE, NOT HEAD PROSE: the count comes from the birth commit's own
 * blob, so an entry drained since still reports what it was born at (mantahostels#1384).
 *
 * Two git passes, because the cheap one alone is wrong. The first is a single
 * `git log -p --unified=0`, whose added `+### B<n>` lines name every commit
 * that could have given birth — one call, no blob per commit, over a file 373
 * commits touched in a week. But an entry MOVED into place adds that same line
 * (move-stray-doc-map-entries.js does exactly that), so the second pass reads
 * the candidate commit and its parent and keeps the id only where the parent
 * did not already hold it. Blobs are fetched once each and cached, so the cost
 * is ~2 blobs per birth commit rather than per commit in the window.
 *
 * `--follow` is deliberately absent: it does not compose with `-p` across a
 * rename, and the map has never been renamed. A rename inside the window would
 * read every entry as born there — visible as an absurd total, not a silent
 * miscount.
 *
 * Fails open, like `sectionBEntryRate`: null on any git failure.
 *
 * @param {string} mapPath
 * @param {number} [windowMs]
 * @returns {{ born: {id: string, words: number, sha: string}[], days: number } | null}
 */
function readSectionBBirths(mapPath, windowMs = SEVEN_DAYS_MS) {
	const relPath = repoRelative(mapPath);
	const since = new Date(Date.now() - windowMs).toISOString();

	const log = gitOrNull(
		[
			"log",
			`--format=${LOG_RECORD_SEP}%H`,
			"-p",
			"--unified=0",
			`--since=${since}`,
			"--",
			relPath,
		],
		{
			// Not a blob but a week of PATCH text over the map, which measured
			// 4.3 MB. The headroom is for a week that rewrites §B wholesale.
			maxBuffer: 256 * 1024 * 1024,
		},
	);
	if (log === null) return null;

	const show = cachedGitShow();
	// A root commit has no `sha^`, and a shallow clone may be missing the blob.
	// Both read as "held nothing".
	/** @param {string} rev */
	const blob = (rev) => show(`${rev}:${relPath}`);

	/** @type {{id: string, words: number, sha: string}[]} */
	const born = [];
	const seen = new Set();
	// Newest-first, so reversing makes the OLDEST commit that added an id the
	// one credited with it — the birth, where a later commit re-adds the same id.
	for (const record of log.split(LOG_RECORD_SEP).filter(Boolean).reverse()) {
		const sha = cutAt(record, "\n")[0].trim();
		if (!/^[0-9a-f]{7,40}$/.test(sha)) continue;
		const added = [
			...new Set(
				[...record.matchAll(ADDED_FIGURE)].map((m) =>
					requiredGroup(m, 1, ADDED_FIGURE),
				),
			),
		].filter((id) => !seen.has(id));
		if (added.length === 0) continue;

		for (const birth of commitBirths(sha, added, blob)) {
			seen.add(birth.id);
			born.push(birth);
		}
	}

	return { born, days: windowMs / (24 * 60 * 60 * 1000) };
}

/**
 * Which of `added` commit `sha` genuinely births: held in its own blob, absent
 * from its parent's. None where its own blob is unreadable.
 * @param {string} sha
 * @param {string[]} added
 * @param {(rev: string) => string | null} blob
 * @returns {{id: string, words: number, sha: string}[]}
 */
function commitBirths(sha, added, blob) {
	const text = blob(sha);
	if (text === null) return [];
	const prose = sectionBEntryProseWords(text);
	const parent = blob(`${sha}^`);
	const parentIds = new Set(
		parent === null ? [] : Object.keys(sectionBEntryProseWords(parent)),
	);
	const births = [];
	for (const id of added) {
		const words = prose[id];
		if (parentIds.has(id) || words === undefined) continue;
		births.push({ id, words, sha });
	}
	return births;
}

/**
 * The grace window a split doc-map commit pair gets before check-doc-map.js's
 * UNCOVERED and DEAD-ENTRY assertions FAIL it (mantahostels#1785). Founder-set 28 August
 * 2026 against a 24 h alternative: the sweeps run at 01/06/11/16 UTC
 * (`.github/workflows/scheduled-checks.yml`), so 6 h always exceeds the 5 h
 * daytime gap between them — a split pair WARNs at least once before it can
 * FAIL — while still forcing a pair to finish inside the working session that
 * started it rather than surviving to the next day. mantahostels#1703.
 */
const PAIRING_GRACE_MS = 6 * 60 * 60 * 1000;

/**
 * A commit's own committer timestamp (seconds since epoch), or null on
 * failure. Committer date, not author date: a rebase or cherry-pick keeps the
 * author date but rewrites the committer date to when the commit actually
 * landed on THIS history, which is what a pairing fault's age must track —
 * `readHeadMapText` above reads the map by the same convention (`%cI`).
 * @param {string} sha
 */
function readCommitterDateSec(sha) {
	const out = gitOrNull(["show", "-s", "--format=%ct", sha]);
	if (out === null) return null;
	const sec = Number(out.trim());
	return Number.isFinite(sec) ? sec : null;
}

/**
 * `nowMs - sec*1000`, floored at null: a commit dated in the future — clock
 * skew, or a backdated `GIT_AUTHOR_DATE` — must never read as permanently
 * young. `pairingHalfAgeMs`'s own contract is that unavailable history is
 * out of grace, and a negative age is the same hazard by another route.
 * @param {number | null} sec
 * @param {number} nowMs
 */
function ageFromSec(sec, nowMs) {
	if (sec === null) return null;
	const ageMs = nowMs - sec * 1000;
	return ageMs < 0 ? null : ageMs;
}

/**
 * How old a doc-map pairing fault's half is — the one seam UNCOVERED and
 * DEAD-ENTRY both date through, so the two assertions cannot drift apart in
 * how they read git history (mantahostels#1785).
 *
 * Two datings, chosen by whether `mapPath` is given:
 *  - omitted: `target` is a tracked path, dated by the oldest commit that
 *    touches it — UNCOVERED's file half.
 *  - given: `target` is a Section A path string, dated by the oldest commit
 *    whose Section A register genuinely BIRTHS it — present in the commit's
 *    own register, absent from its parent's — the same present-not-in-parent
 *    test `readSectionBBirths` above runs for a `### B<n>` heading. A bare
 *    pickaxe (`-S`) hit is not enough: docs/doc-map.md is ~79,000 words, and
 *    the same path string routinely appears in Section B prose, a Consumes
 *    cell or a route, any of which would misdate a brand-new row as ancient
 *    and silently defeat the grace window. Pickaxe still narrows the commit
 *    set cheaply; each candidate, oldest first, is then verified against the
 *    real register before being trusted. `mapPath` is tried first and
 *    `DEFAULT_MAP_PATH` second, as `readMapTextAt` does above: a pre-commit
 *    invocation hands this a `$(mktemp -d)` copy with no git identity of its
 *    own, and only the tracked path answers (mantahostels#1191, mantahostels#1384).
 *
 * Returns the half's age in ms as of `now` (injectable for tests, defaulting
 * to the live clock). `null` on unavailable history — no commit touches the
 * path, no candidate's register genuinely births it, or git itself fails —
 * and null MUST read as out of grace at every call site: it is never a
 * silent pass.
 *
 * @param {string} target
 * @param {string | null} [mapPath]
 * @param {number} [now]
 * @returns {number | null}
 */
function pairingHalfAgeMs(target, mapPath = null, now = Date.now()) {
	if (mapPath === null) return oldestTouchAgeMs(target, now);

	const show = cachedGitShow();

	for (const p of [...new Set([repoRelative(mapPath), DEFAULT_MAP_PATH])]) {
		let shaOut;
		try {
			shaOut = execGit(["log", `-S${target}`, "--format=%H", "--", p], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
		} catch {
			continue;
		}
		// Newest-first by default; oldest-first is the birth order we want to
		// return on the FIRST genuine hit.
		const shas = shaOut.split("\n").filter(Boolean).reverse();
		const sha = shas.find((s) => isRegisterBirth(show, s, p, target));
		if (sha !== undefined) return ageFromSec(readCommitterDateSec(sha), now);
	}
	return null;
}

/**
 * `pairingHalfAgeMs`'s file dating: the age of the oldest commit touching
 * `target`, null where none does or git fails.
 * @param {string} target
 * @param {number} now
 */
function oldestTouchAgeMs(target, now) {
	const out = gitOrNull(["log", "--format=%ct", "--", target]);
	if (out === null) return null;
	// Newest-first by default; the oldest commit is the last line.
	const lines = out.split("\n").filter(Boolean);
	if (lines.length === 0) return null;
	const sec = Number(lines.at(-1));
	return ageFromSec(Number.isFinite(sec) ? sec : null, now);
}

/**
 * Whether commit `sha`'s register at `p` genuinely births `target` — present
 * in its own register, absent from its parent's.
 * @param {(spec: string) => string | null} show
 * @param {string} sha
 * @param {string} p
 * @param {string} target
 */
function isRegisterBirth(show, sha, p, target) {
	const childText = show(`${sha}:${p}`);
	if (childText === null || !registerPaths(childText).includes(target))
		return false;
	const parentText = show(`${sha}^:${p}`);
	const parentHadIt =
		parentText !== null && registerPaths(parentText).includes(target);
	return !parentHadIt;
}

/**
 * A `git show <spec>` reader that fetches each spec once, null wherever git
 * cannot produce it.
 * @returns {(spec: string) => string | null}
 */
function cachedGitShow() {
	/** @type {Map<string, string | null>} */
	const blobs = new Map();
	return (spec) => {
		if (!blobs.has(spec)) {
			try {
				blobs.set(
					spec,
					execGit(["show", spec], {
						encoding: "utf8",
						stdio: ["ignore", "pipe", "ignore"],
					}),
				);
			} catch {
				blobs.set(spec, null);
			}
		}
		return blobs.get(spec) ?? null;
	};
}

/**
 * §B's word count, to the nearest 1,000, which check-doc-map.js prints in its
 * OK line and nothing gates on.
 *
 * An exact figure would change on essentially every doc-map commit — the
 * growth rate is on mantahostels#894. 1,000 words is 1.25% of the 80,000-word budget.
 * Not the nearest 5,000, which is 6.25% of the budget (mantahostels#894).
 * @param {string} text
 */
function roundedSectionBWords(text) {
	return Math.round(sectionBWords(text) / 1000) * 1000;
}

/**
 * Line range of one `## `-headed section of the map, from its heading to the
 * next `## ` or the end of the file. Null where the heading is absent.
 * @param {string[]} lines
 * @param {RegExp} heading
 */
function sectionRange(lines, heading) {
	const start = lines.findIndex((l) => heading.test(l));
	if (start === -1) return null;
	const rest = lines.slice(start + 1).findIndex((l) => /^## /.test(l));
	return { start, end: rest === -1 ? lines.length : start + 1 + rest };
}

/**
 * Line range of the map's own Section B, which quotes every needle by design.
 * @param {string[]} lines
 */
function sectionBRange(lines) {
	return sectionRange(lines, /^## Section B/);
}

/**
 * Line range of the map's own Section A, the document register.
 * @param {string[]} lines
 */
function sectionARange(lines) {
	return sectionRange(lines, /^## Section A/);
}

/**
 * The map's own lines a needle scan never reads, as a predicate over line index
 * — null for any other file, which is scanned whole.
 *
 * §A's REGISTER rows always: every `role` and `consumes` cell is copied verbatim
 * out of `docs/doc-map-classes.json` by generate-doc-map-section-a.js, so
 * scanning both copies makes one sentence need two allowlist rows. The
 * suppression is written against the JSON source, which stays scanned (mantahostels#2399,
 * ruled at mantahostels#2376).
 *
 * A register row, not any `|`-prefixed line: §A's preamble, its subsections'
 * prose and its hand-written Version-stamps table have no source to carry a
 * suppression instead, so skipping them would strand a stale figure with nowhere
 * to be reported.
 *
 * §B only where the caller asks, since it is §B's own subject that decides —
 * check-machinery-superseded.js retires repo-machinery figures, which §B does
 * not own, so its scan keeps reading §B.
 * @param {string} file
 * @param {string[]} lines
 * @param {string} mapRel
 * @param {{sectionB?: boolean}} [opts]
 * @returns {((index: number) => boolean)|null}
 */
function mapSkipLine(file, lines, mapRel, { sectionB = false } = {}) {
	if (file !== mapRel) return null;
	const a = sectionARange(lines);
	const b = sectionB ? sectionBRange(lines) : null;
	return (i) => {
		if (b && i >= b.start && i < b.end) return true;
		if (!a || i < a.start || i >= a.end) return false;
		const line = lines[i];
		if (line === undefined)
			throw new Error(`line ${i} is past the map's ${lines.length} lines`);
		return registerRowPaths(line).length > 0;
	};
}

/**
 * Every `### B<n>` heading in the map, with its line index and whether it sits
 * inside Section B — the one parser both the stray-entry assertion and the
 * mover that fixes it read, so their verdict and their target are the same set
 * by construction (mantahostels#1352).
 *
 * `stray` matters because `sectionBWords` above reads the range and nothing
 * else: an entry appended below `## Section C` is missing from §B's word count
 * and so from the 80,000-word budget.
 *
 * Fenced blocks are skipped: this document quotes its own formats.
 * @param {string[]} lines
 * @returns {{ id: string, index: number, line: string, stray: boolean }[]}
 */
function figureHeadings(lines) {
	const range = sectionBRange(lines);
	const found = [];
	let fenced = false;
	for (const [index, line] of lines.entries()) {
		if (/^\s*(```|~~~)/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
		const m = line.match(FIGURE_ID);
		if (!m) continue;
		found.push({
			id: requiredGroup(m, 1, FIGURE_ID),
			index,
			line: line.trim(),
			stray: range ? index < range.start || index >= range.end : false,
		});
	}
	return found;
}

/**
 * The map's path as `git ls-files` states it. A scan recognises the map as itself
 * only once the CLI argument is in that same repo-relative form — `./docs/doc-map.md`
 * otherwise leaves Section B free to report every phrase and figure it quotes.
 * @param {string} p
 */
function repoRelative(p) {
	return path.relative(process.cwd(), path.resolve(p));
}

/* Directories git never tracks and that are expensive to walk. A materialised
 * tree holds none of them, so this is belt-and-braces: the same set, and the
 * same reason, as check-guard-registry.js's SKIP_DIRS. */
const UNWALKED_DIRS = new Set([".git", "node_modules", ".next", "__pycache__"]);

/** @param {string} root */
function walkTracked(root) {
	/** @type {string[]} */
	const out = [];
	/** @param {string} rel */
	const walk = (rel) => {
		for (const e of readTrackedDir(root, rel)) {
			if (e.isDirectory()) {
				if (UNWALKED_DIRS.has(e.name)) continue;
				walk(childRel(rel, e.name));
				continue;
			}
			/* isFile() would drop a symlink, and this repo tracks symlinks into
			 * .claude/skills. git lists them; so does this (mantahostels#1922). */
			out.push(childRel(rel, e.name));
		}
	};
	walk("");
	return out.sort();
}

/**
 * @param {string} root
 * @param {string} rel
 */
function readTrackedDir(root, rel) {
	try {
		return fs.readdirSync(path.join(root, rel), { withFileTypes: true });
	} catch (e) {
		/* Never softened: `root` is contractually an extraction, where a
		 * directory cannot vanish mid-walk, so an unreadable one is a real
		 * fault and not a race. */
		throw new Error(
			`could not read ${path.join(root, rel)} — ${caught(e).message}`,
			{
				cause: e,
			},
		);
	}
}

/**
 * @param {string} rel
 * @param {string} name
 */
function childRel(rel, name) {
	return rel ? `${rel}/${name}` : name;
}

/**
 * Every tracked path in the repo. Throws on failure rather than returning an
 * empty list: git is a scan's reading apparatus, not its subject, so a git that
 * cannot answer is BROKEN, never a clean tree.
 *
 * `root` points it at a MATERIALISED tree instead — a `git checkout-index`
 * extraction of the index, or a `git archive` one of a rev (mantahostels#1922). There is no
 * `.git` in one, so `ls-files` cannot be asked; the extraction holds exactly the
 * tracked set, so walking it answers the same question. Never a working
 * checkout, which holds untracked and ignored files this would count as
 * tracked.
 *
 * While the index holds a conflict a path is listed once per stage, so without
 * `--deduplicate` one conflicted file counts three times and inflates the
 * tracked-file total the doc map's header states (docs/doc-map.md §A).
 *
 * It wants git 2.31+. An older git rejects the option and throws, which surfaces
 * as BROKEN. A second dedupe here in JS would cover that, and is deliberately
 * absent: with both, neither can be shown to work, since removing either leaves
 * the other passing.
 *
 * `--deduplicate` applies only while filenames alone are shown, so adding `-t`,
 * `-s`/`--stage` or `--modified` here silently restores the miscount with no
 * test failing.
 */
/** @param {string | null} [root] */
function readTrackedFiles(root) {
	if (root) return walkTracked(root);
	return execGit(["ls-files", "--deduplicate", "-z"], {
		encoding: "utf8",
	})
		.split("\0")
		.filter(Boolean);
}

/**
 * The paths sitting on disk that git does not track — a written-but-not-yet-
 * committed file, which is what a route or register path naming a file mid-
 * ticket points at. `--exclude-standard` honours .gitignore, so build output and
 * scratch files are not offered as somewhere a route may legitimately point.
 *
 * Never throws, and answers `[]` where git cannot (mantahostels#1403, the ticket that
 * softened a doc-map route pointing at an uncommitted file): callers use it only
 * to soften a FAIL to a WARN, so an apparatus failure must leave the FAIL
 * standing rather than manufacture a pass.
 */
function readUntrackedFiles() {
	try {
		return execGit(["ls-files", "--others", "--exclude-standard", "-z"], {
			encoding: "utf8",
			// As in readConflictedPaths().
			stdio: ["ignore", "pipe", "ignore"],
		})
			.split("\0")
			.filter(Boolean);
	} catch {
		return [];
	}
}

/**
 * The paths the index currently holds as conflicted, if any. A non-empty answer
 * means a merge, rebase, cherry-pick or revert is mid-flight and the tracked set
 * is a snapshot of an unresolved state — countable, but not yet the count of
 * anything that will be committed.
 *
 * Never throws: it is asked only to decide whether a count is worth stating, so
 * a git that cannot answer leaves the caller where it already was.
 */
function readConflictedPaths() {
	try {
		return [
			...new Set(
				execGit(["ls-files", "--unmerged", "-z"], {
					encoding: "utf8",
					// git's own diagnostics are noise here: every failure is caught
					// below, and outside a repo this would print "fatal: not a git
					// repository" into a passing test run.
					stdio: ["ignore", "pipe", "ignore"],
				})
					.split("\0")
					.filter(Boolean)
					// `--unmerged` prints "<mode> <sha> <stage>\t<path>" per stage.
					// `-z` is load-bearing for this slice, not just the split: without
					// it git C-quotes a path holding a space or a tab, and the slice
					// hands back the quoted, escaped spelling instead of the path.
					.map((l) => l.slice(l.indexOf("\t") + 1)),
			),
		];
	} catch {
		return [];
	}
}

/**
 * Whether `relPath` differs from HEAD — staged, unstaged, or both. The signal
 * for "a live session is mid-edit on this file" (mantahostels#1193): a tracked file that
 * still matches HEAD cannot be someone else's uncommitted work in progress.
 *
 * `git diff --quiet HEAD` exits 1 on a real difference — the only case read as
 * dirty. Every other exit (0: clean; anything else: no HEAD yet, outside a
 * repo, git itself broken) falls back to `false`, the same settled-by-default
 * posture readConflictedPaths() takes: this is a severity softener, not a gate, so
 * an apparatus failure here must never manufacture a WARN.
 *
 * `relPath` must be the real tracked path — `.husky/pre-commit` feeds
 * check-doc-map.js a `$(mktemp -d)` copy of the map (mantahostels#1191), and that path
 * is never in the repo, so `isDirty` on it always answers `false` (apparatus
 * failure, not "clean"). A caller that only has the temp path must ask this
 * against the real one instead — check-doc-map.js's `--map-dirty` flag exists
 * for exactly that.
 * @param {string} relPath
 */
function isDirty(relPath) {
	try {
		execGit(["diff", "--quiet", "HEAD", "--", relPath], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		return false;
	} catch (e) {
		return caught(e).status === 1;
	}
}

/**
 * Whether a Section A register path exists on disk right now, tracked or not.
 * A register entry surviving a genuine rename is absent here too — the file is
 * gone, not merely uncommitted — so this alone is what should turn a dead
 * entry (FAIL) into an untracked one (WARN, mantahostels#1193).
 *
 * Wildcard entries (`docs/x/*`) are present if their directory holds anything;
 * a filename-prefix wildcard (`docs/adr-*`) is present if any name in its
 * directory starts with the prefix.
 * @param {string} entry
 */
function entryPresentOnDisk(entry) {
	if (!entry.endsWith("*")) return fs.existsSync(entry);
	const prefix = wildcardPrefix(entry);
	const dirWildcard = prefix.endsWith("/");
	const dir = dirWildcard ? prefix.slice(0, -1) : path.dirname(prefix);
	const base = dirWildcard ? "" : path.basename(prefix);
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch {
		return false;
	}
	return base === "" ? names.length > 0 : names.some((n) => n.startsWith(base));
}

/**
 * A tracked file's lines, or `null` where there is nothing to scan — a path that
 * will not read (a submodule, a broken symlink) or a binary one.
 *
 * The decode is inside the guard, not after it: a tracked file too large to hold
 * as a JS string throws `ERR_STRING_TOO_LONG` on the decode, not on the read.
 * @param {string} file
 */
function readTextLines(file) {
	try {
		const buf = fs.readFileSync(file);
		if (buf.subarray(0, 8192).includes(0)) return null;
		return buf.toString("utf8").split("\n");
	} catch {
		return null;
	}
}

/**
 * Drops a checker and its own test from the scan. Both quote retired wording and
 * superseded figures as fixtures, exactly as Section B does, so without this they
 * self-report.
 * @param {string} script
 */
function selfFilter(script) {
	const self = new Set([
		`scripts/${script}.js`,
		...siblingTests(`scripts/${script}`),
	]);
	return (/** @type {string} */ f) => self.has(f);
}

/*
 * Loaders for the §B data files — restatement paths, superseded needles and
 * retired vocabulary — relocated out of the map's prose (mantahostels#580). Every checker
 * reads the files through these three, so no checker holds private file-reading
 * code and a schema change fixes every reader at once (mantahostels#581).
 *
 * Validation is the point of loading, not a courtesy: a stem written in prose
 * was validated by nothing, which is how one entry shipped an empty stem and mantahostels#344 a
 * `(?i)` flag JavaScript does not have — both silently unscanned for as long as
 * they existed. A loader errors loudly, naming the file and the `B<n>` entry,
 * and never answers with an empty result: an empty data file is a broken
 * migration, never a clean scan — unless the caller passes `allowEmpty` for a
 * state where `{}` is real (a day-one map, an unsuperseded repo).
 *
 * A *missing* file is the one failure left to the caller — the read error
 * propagates with its `code` (ENOENT), so an absent file is distinguishable
 * from a malformed one. Every instrument treats both as BROKEN (mantahostels#591, mantahostels#707);
 * no route parses prose any more.
 */

const ENTRY_ID = /^B\d+$/;

const SUPERSEDES_LABEL = /^\s*[-*]\s+\*\*Supersedes/i;
const BULLET = /^\s*[-*]\s/;

/**
 * A §B entry's `Supersedes` bullet, plus its indented continuation lines, or
 * empty where it has none. A bullet's own wrapped text is indented; the next
 * top-level bullet ends it.
 * @param {string[]} lines
 */
function parseSupersedesText(lines) {
	return parseLabelledBulletText(lines, SUPERSEDES_LABEL) ?? "";
}

/**
 * One §B skeleton bullet's value — the text after `label`, plus the indented
 * continuation lines beneath it — or **null** where no line carries the label.
 * A bullet's own wrapped text is indented; the next top-level bullet ends it.
 *
 * Null, not empty, because a bullet written with nothing after its label is a
 * declaration all the same: a caller asking whether the entry declares one
 * would otherwise read the bare label as an absence, which is the false green
 * mantahostels#1247 exists to close.
 *
 * One body, not a copy per label: this file's header records what per-checker
 * copies cost (mantahostels#239, mantahostels#268), and a second bullet parser here would rebuild that
 * at one level down.
 * @param {string[]} lines
 * @param {RegExp} label
 */
function parseLabelledBulletText(lines, label) {
	const out = [];
	let inBullet = false;
	let seen = false;
	for (const line of lines) {
		const at = line.search(label);
		if (at !== -1) {
			inBullet = true;
			seen = true;
			/* Sliced from the label, so a mid-line bullet drops the run before it
			 * rather than returning that run as this bullet's value. */
			out.push(
				line
					.slice(at)
					.replace(label, "")
					.replace(/^[^*]*\*\*/, ""),
			);
			continue;
		}
		if (!inBullet) continue;
		if (BULLET.test(line) || !/^\s+\S/.test(line)) inBullet = false;
		else out.push(line);
	}
	return seen ? out.join(" ") : null;
}

/* Not anchored to the line start: B15's bullet has no `- ` marker, and B122's
 * follows a `**Rejected at mantahostels#415:**` run on the same line, so a line-initial
 * matcher reads both as absent. Residual: an entry quoting the label in prose
 * is read as carrying the bullet, and BROKENs the checker (mantahostels#1247). */
const RETIRED_LABEL = /\*\*Retired vocabulary/i;

/**
 * A §B entry's `Retired vocabulary` bullet, plus its indented continuation
 * lines, or empty where it has none — `parseSupersedesText`'s sibling, and read for
 * the same reason: check-retired-vocabulary.js is BROKEN where an entry the map
 * says has retired wording has no key in the data file holding the phrases.
 * @param {string[]} lines
 */
function parseRetiredVocabularyText(lines) {
	return parseLabelledBulletText(lines, RETIRED_LABEL);
}

/* Money and percentages, each optionally a range and optionally approximate.
 * Dash forms vary across files (en dash in the map, hyphen elsewhere), so both
 * the literal and the search pattern below accept either. */
const MONEY = /~?\$\s?\d[\d,]*(?:\.\d+)?(?:\s*[–—-]\s*\$?\d[\d,]*(?:\.\d+)?)?/g;
/* Tried only at a number's first digit: one later in it can only repeat the
 * match its first digit makes. */
const PERCENT =
	/~?(?=\d)(?<!\d,*)\d[\d,]*(?:\.\d+)?(?:\s*[–—-]\s*\d[\d,]*(?:\.\d+)?)?\s*%/g;

/**
 * The distinctive value literals in a span — money and percentages, whitespace
 * normalised.
 * @param {string} span
 */
function valueLiterals(span) {
	return [...(span.match(MONEY) || []), ...(span.match(PERCENT) || [])].map(
		(s) => s.replace(/\s+/g, ""),
	);
}

/**
 * Content words from a §B entry heading, used to qualify a needle that would
 * otherwise match everything — a name in check-superseded-values.js, a bare
 * count in check-restatement-edges.js. Four letters and up drops the
 * connectives without a stopword list.
 * @param {string} heading
 */
function headingWords(heading) {
	return [
		...new Set(
			(
				heading
					.replace(/^### B\d+/, "")
					.toLowerCase()
					.match(/[a-z]{4,}/g) || []
			).filter((w) => w !== "with" && w !== "than" && w !== "into"),
		),
	];
}

/**
 * A needle as a search pattern. The leading `~` and the dash form are both
 * optional variations of the same value, and both branches now match
 * case-insensitively so a sentence-initial copy of a letter-bearing numeric
 * needle (`Call list 23–25`) still hits (mantahostels#2443). Which BOUNDARY a needle
 * gets stays keyed on the digit, not the letter: a digit-bearing needle —
 * money, a percentage, or a qualified number like `call list 23-25` — keeps
 * the boundary that stops `$18` matching inside `$180` or `$18.50`. Plain
 * `\b` can't: it matches inside a longer number sharing the needle's tail
 * (`call list 23-25` inside `call list 23-25.5`), and fails to end a match
 * on a non-word character followed by a space (`800%`). One ending in a
 * letter also refuses a following word character, so a unit letter cannot
 * match the start of a longer word (#1620). A preceding `#` marks an issue
 * citation, not a figure, and a following `,\d` is the rest of a longer
 * comma-grouped number (`38,000` inside `38,000,000`), so neither matches
 * (#1875). A needle with no digit matches as a plain whole word.
 * @param {string} needle
 */
function needlePattern(needle) {
	const body = needle
		.replace(/^~/, "")
		.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
		.replace(/[–—-]/g, "[–—-]");
	if (!/\d/.test(needle)) return new RegExp(`\\b${body}\\b`, "gi");
	const tail = /[a-z]$/i.test(needle) ? "\\w" : "\\d";
	return new RegExp(`(?<![\\w.,#])~?${body}(?![${tail}]|[.,]\\d)`, "gi");
}

/* The data files' canonical names, resolved against the map's own
 * directory (or --data-dir). */
const DATA_FILES = {
	restatements: "doc-map-restatements.json",
	supersededNeedles: "doc-map-superseded.json",
	retiredVocabulary: "doc-map-retired-vocabulary.json",
	highWater: "doc-map-high-water.json",
	restatementAllowlist: "doc-map-restatement-allowlist.json",
	admissions: "doc-map-admissions.json",
};

/**
 * The repo-relative paths a grep-based checker drops from its scan: every
 * data file, whether or not the run read them. Every needle and phrase is by
 * construction live in the file that lists it — the same reason the scans
 * already skip the map's own §B. The superseded file is covered though nothing
 * writes it, so a later one cannot report its own needles as live hits.
 * @param {string} dataDir
 */
function dataFileSelfExemption(dataDir) {
	return new Set(
		Object.values(DATA_FILES).map((n) => repoRelative(path.join(dataDir, n))),
	);
}

/**
 * BROKEN where a data file keys an id the map holds no `### B<n>` entry for —
 * the loaders validate shape only.
 * @param {CheckContext} ctx
 * @param {Record<string, unknown>|null} data
 * @param {Entry[]} figures
 * @param {string} file
 */
function assertDataIdsKnown(ctx, data, figures, file) {
	if (!data) return;
	const known = new Set(figures.map((f) => f.id));
	const orphans = Object.keys(data).filter((id) => !known.has(id));
	if (orphans.length > 0)
		ctx.broken(
			`${file} keys entr(ies) the map has no ### heading for: ` +
				`${orphans.join(", ")} — an id typo in the data file, or an entry ` +
				"cut from the map without its data.",
		);
}

/* `(a+)+` — a quantified group whose own body is quantified. A stem is
 * arbitrary regex from a hand-written file, and this shape backtracks
 * exponentially: `(word\s+)+other` against a long line never returns, so the
 * scan never returns either. The test is a shape check, not a proof; a stem it
 * clears can still be slow. Shared with check-retired-vocabulary.js, whose
 * prose path runs the same gate. */
const CATASTROPHIC = /\([^()*+}]*[*+}][^()]*\)\s*(?:[*+]|\{\d+,\d*\})/;

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isPlainObject = (v) =>
	v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * @param {string} file
 * @param {string} message
 * @returns {never}
 */
function fail(file, message) {
	throw new Error(`${file}: ${message}`);
}

/* A typo'd field name would otherwise read as the field being absent — `sem`
 * for `stem` silently downgrades a pattern to its literal. The object check
 * covers a null or string item too, which would otherwise surface as a raw
 * TypeError naming no entry.
 *
 * `isPlainObject` IS a `v is` predicate, reversing mantahostels#1460, which made it a plain
 * boolean to keep `loadKeyed`'s return an `any` that cascaded into no caller.
 * mantahostels#1620 reopened that: with this function and its two siblings made assertions,
 * each loader absorbs its own share in the one cast at its return. What that
 * leaves broken: those casts are unchecked, so a loader whose validator stops
 * proving its declared shape now lies to every caller instead of handing back
 * an `any` they would have guarded.
 */
/**
 * @param {string} file
 * @param {string} where
 * @param {unknown} obj
 * @param {string[]} allowed
 * @returns {asserts obj is Record<string, unknown>}
 */
function onlyKeys(file, where, obj, allowed) {
	if (!isPlainObject(obj)) fail(file, `${where} holds a non-object item`);
	const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
	if (extra.length > 0)
		fail(file, `${where} carries unknown field(s) ${extra.join(", ")}`);
}

/**
 * @param {string} file
 * @param {string} where
 * @param {unknown} value
 * @returns {asserts value is string}
 */
function nonEmptyString(file, where, value) {
	if (typeof value !== "string" || !value.trim())
		fail(file, `${where} is not a non-empty string`);
}

/**
 * One keyed data file: a JSON object whose every key is a `B<n>` entry id,
 * each value handed to the loader's own validator. All three loaders come
 * through here, so the malformed/empty/misnamed failures are one behaviour.
 *
 * `key` overrides the id shape and the error's noun for a file not keyed by §B
 * entry — `machinery-superseded.json` (mantahostels#1440).
 *
 * `allowEmpty` admits `{}` for a file whose empty state is a real day-one state
 * rather than data gone missing — the superseded sidecar of a repo with no
 * superseded values yet (mantahostels#3515 F11, #2).
 * @param {string} file
 * @param {(id: string, entry: unknown) => unknown} validateEntry
 * @param {{test: RegExp, noun: string}} [key]
 * @param {{allowEmpty?: boolean}} [opts]
 */
function loadKeyed(
	file,
	validateEntry,
	key = { test: ENTRY_ID, noun: "a B<n> entry id" },
	{ allowEmpty = false } = {},
) {
	const raw = fs.readFileSync(file, "utf8");
	let data;
	try {
		data = JSON.parse(raw);
	} catch (e) {
		fail(file, `is not JSON — ${caught(e).message}`);
	}
	if (!isPlainObject(data))
		fail(file, "does not hold an object keyed by B<n> entry id");
	const ids = Object.keys(data);
	if (ids.length === 0 && !allowEmpty) fail(file, "holds no entries");
	for (const id of ids) {
		if (!key.test.test(id)) fail(file, `key "${id}" is not ${key.noun}`);
		validateEntry(id, data[id]);
	}
	return data;
}

/* An entry present with nothing in it is indistinguishable from data gone
 * missing, which is exactly the silence these files exist to end — an entry
 * with nothing to say is left out of the file instead.
 */
/**
 * @param {string} file
 * @param {string} where
 * @param {unknown} value
 * @returns {asserts value is unknown[]}
 */
function nonEmptyArray(file, where, value) {
	if (!Array.isArray(value) || value.length === 0)
		fail(file, `${where} does not hold a non-empty array`);
}

/* An ISO calendar date, `YYYY-MM-DD` — the date a `⚠ Restated-in is known
 * incomplete` marker was written. A marker the §B bullet leaves undated is
 * recorded in the entry's `note` instead, so this field never has to carry a
 * placeholder that sorts and compares like a date and is not one.
 */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Restatement paths, `{ "B1": { paths: [{ path, locator?, gloss? }], note?,
 * knownIncomplete? } }` — the `Restated in:` lists check-doc-map.js's dead-path
 * gate reads, plus the prose §B's own bullets carry beside them. Path, locator
 * and gloss are separate fields by design, so no stripping regex runs on the
 * data path; a path still holding whitespace is a locator left inside it, the
 * migration bug that split the fields in the first place.
 *
 * The object shape is the only shape (mantahostels#1469): a loader taking the array form
 * too would read a mistyped `paths` as an entry that legitimately has none,
 * which is the silence these files exist to end.
 * @typedef {{path: string, locator?: string, gloss?: string}} RestatementPath
 * @typedef {{paths: RestatementPath[], note?: string, knownIncomplete?: string}} RestatementEntry
 * @param {string} file
 * @param {{allowEmpty?: boolean}} [opts] `{}` is valid only where §B holds no
 *   entries — a day-one map, not a data file gone missing (#3).
 * @returns {Record<string, RestatementEntry>}
 */
function loadRestatements(file, opts = {}) {
	return /** @type {Record<string, RestatementEntry>} */ (
		loadKeyed(
			file,
			(id, entry) => {
				onlyKeys(file, id, entry, ["paths", "note", "knownIncomplete"]);
				nonEmptyArray(file, `${id}: paths`, entry.paths);
				for (const item of entry.paths) validateRestatementPath(file, id, item);
				if ("note" in entry) nonEmptyString(file, `${id}: note`, entry.note);
				if ("knownIncomplete" in entry)
					validateKnownIncomplete(file, id, entry.knownIncomplete);
			},
			undefined,
			opts,
		)
	);
}

/**
 * One item of a restatement entry's `paths`.
 * @param {string} file
 * @param {string} id
 * @param {unknown} item
 */
function validateRestatementPath(file, id, item) {
	onlyKeys(file, `${id}: paths`, item, ["path", "locator", "gloss"]);
	nonEmptyString(file, `${id}: path`, item.path);
	if (/\s/.test(item.path))
		fail(
			file,
			`${id}: path \`${item.path}\` holds whitespace — a locator belongs in its own field`,
		);
	for (const field of ["locator", "gloss"])
		if (field in item)
			nonEmptyString(file, `${id}: ${field} on \`${item.path}\``, item[field]);
}

/**
 * A restatement entry's `knownIncomplete` date.
 * @param {string} file
 * @param {string} id
 * @param {unknown} value
 */
function validateKnownIncomplete(file, id, value) {
	nonEmptyString(file, `${id}: knownIncomplete`, value);
	if (!ISO_DATE.test(value))
		fail(
			file,
			`${id}: knownIncomplete \`${value}\` is not an ISO YYYY-MM-DD date`,
		);
}

/**
 * A legitimate-hits allowlist, `[{ path, lines?, anchors? }]` — the paths and
 * the places in them a scan suppresses. A place is either an `L<n>` line number
 * or a content anchor: a substring of the line itself, which survives an
 * insertion above it where a line number does not (mantahostels#744). `lines: []` and no
 * anchors allows the whole file; an entry naming neither key allows nothing,
 * which is a migration typo rather than an intent.
 *
 * An anchor is either a bare string, suppressing every one of the entry's
 * needles on the line it matches, or `{ anchor, needle }`, suppressing that one
 * needle there and leaving the line scanned for the rest (mantahostels#2431). A big line is
 * where the difference bites: a roadmap card body is one physical line, so a
 * bare anchor on one blinds the scan to every other needle across the whole
 * card.
 *
 * `needleNames` is every needle the entry actually scans for; a scoped anchor
 * naming something else is refused, because it would suppress nothing and say
 * nothing about it. `null` refuses scoped anchors outright, and is what a
 * caller passes whose scan resolves allowlists with no needle in hand — there a
 * scoped anchor could only ever be inert.
 * @param {string} file
 * @param {string} id
 * @param {unknown} allowlist
 * @param {Set<string>|null} needleNames
 */
function validateAllowlist(file, id, allowlist, needleNames) {
	if (!Array.isArray(allowlist)) fail(file, `${id}: allowlist is not an array`);
	for (const allow of allowlist)
		validateAllowEntry(file, id, allow, needleNames);
}

/**
 * One row of `validateAllowlist`'s allowlist.
 * @param {string} file
 * @param {string} id
 * @param {unknown} allow
 * @param {Set<string>|null} needleNames
 */
function validateAllowEntry(file, id, allow, needleNames) {
	onlyKeys(file, `${id}: allowlist`, allow, ["path", "lines", "anchors"]);
	nonEmptyString(file, `${id}: allowlist path`, allow.path);
	if (!("lines" in allow) && !("anchors" in allow))
		fail(
			file,
			`${id}: allowlist \`${allow.path}\` states neither lines nor anchors — ` +
				"write `lines: []` for the whole file",
		);
	if (
		"lines" in allow &&
		(!Array.isArray(allow.lines) ||
			allow.lines.some(
				// `typeof` for the checker's benefit: JSON admits a string here.
				(/** @type {unknown} */ n) =>
					typeof n !== "number" || !Number.isInteger(n) || n < 1,
			))
	)
		fail(
			file,
			`${id}: allowlist \`${allow.path}\` lines is not an array of line numbers`,
		);
	if ("anchors" in allow) {
		if (!Array.isArray(allow.anchors) || allow.anchors.length === 0)
			fail(
				file,
				`${id}: allowlist \`${allow.path}\` anchors is not a non-empty array`,
			);
		const ctx = {
			id,
			where: `${id}: allowlist \`${allow.path}\``,
			needleNames,
		};
		for (const anchor of allow.anchors) validateAllowAnchor(file, ctx, anchor);
	}
}

/**
 * One anchor of an allowlist row: a bare string, or one scoped to a needle the
 * entry declares.
 * @param {string} file
 * @param {{id: string, where: string, needleNames: Set<string>|null}} ctx
 * @param {unknown} anchor
 */
function validateAllowAnchor(file, ctx, anchor) {
	const { id, where, needleNames } = ctx;
	if (typeof anchor === "string" || !isPlainObject(anchor)) {
		nonEmptyString(file, `${where} anchor`, anchor);
		return;
	}
	onlyKeys(file, `${where} anchor`, anchor, ["anchor", "needle"]);
	nonEmptyString(file, `${where} anchor`, anchor.anchor);
	nonEmptyString(
		file,
		`${where} anchor \`${anchor.anchor}\` needle`,
		anchor.needle,
	);
	if (needleNames === null)
		fail(
			file,
			`${where} anchor \`${anchor.anchor}\` ` +
				"is scoped to a needle, and this data file's scans resolve " +
				"allowlists with no needle in hand — write the anchor as a " +
				"plain string",
		);
	if (!needleNames.has(anchor.needle))
		fail(
			file,
			`${where} anchor \`${anchor.anchor}\` ` +
				`is scoped to \`${anchor.needle}\`, which ${id} does not ` +
				"declare as a needle — it would suppress nothing",
		);
}

/**
 * One content anchor as a data file writes it.
 * @typedef {string|{anchor: string, needle: string}} AllowlistAnchor
 */

/**
 * One allowlist row as a data file writes it: a path, plus the line pins and
 * content anchors that suppress hits under it.
 * @typedef {{path: string, lines?: number[], anchors?: AllowlistAnchor[]}} AllowlistRow
 */

/**
 * One content anchor with its scope resolved: `needle` is null where the anchor
 * suppresses the whole line.
 * @typedef {{text: string, needle: string|null}} CompiledAnchor
 */

/**
 * One allowlist row with its path matcher built and both lists defaulted.
 * @typedef {{path: string, matcher: (file: string) => boolean, lines: number[], anchors: CompiledAnchor[]}} CompiledAllowRow
 */

/**
 * An anchor that matched other than exactly one line. `lines` is every line it
 * did match, empty where the anchored text is gone; `needle` is set only where
 * the anchor is scoped to one.
 * @typedef {{entry: string, path: string, file: string, anchor: string, needle?: string|null, lines: number[]}} AnchorNote
 */

/**
 * A line pin carrying none of its entry's phrases. `fileLines` is set only
 * where the pin points past the end of the file, and `text` only where it does
 * not.
 * @typedef {{entry: string, path: string, file: string, line: number, fileLines?: number, text?: string}} PinNote
 */

/**
 * A whole-file allowlist row (`lines: []`, no anchors) whose file carries none
 * of its entry's phrases — the row suppresses everything there and covers
 * nothing.
 * @typedef {{entry: string, path: string, file: string}} WholeFileNote
 */

/**
 * The anchor diagnostics both grep instruments print. Never a hit and never a
 * gate: an anchor matching nothing has already stopped suppressing, so the hit
 * it covered is in the report above under its own name.
 *
 * NEVER A GATE IS SETTLED, NOT AN OVERSIGHT (mantahostels#2361). Asked directly, with the
 * backlog at zero, whether a dead anchor should FAIL — no, and a ratchet off a
 * committed baseline is no better. Both refuse the wrong commit. The fourteen
 * dead anchors mantahostels#2361 cleared were not fourteen drifts: eight died in one
 * commit, `fe6271b6`, which stopped hand-writing doc-map §A and started
 * rendering it, touching no allowlist and no figure. A gate refuses that
 * commit; a ratchet refuses it identically, the count going zero to eight in
 * one step. The right response either time would have been to switch the gate
 * off, which is the tell. Re-open this only on a dead anchor that hid a real
 * superseded value — the failure mode here is noise, never a missed check.
 * @param {CheckContext} ctx
 * @param {AnchorNote[]} notes
 */
function reportAnchors(ctx, notes) {
	if (notes.length === 0) return;
	ctx.say(
		`\n${notes.length} allowlist anchor(s) did not match exactly one line — ` +
			"an anchor is a substring of the line it suppresses, so re-read the file " +
			"and re-anchor:",
	);
	for (const n of notes) {
		const where =
			n.lines.length > 0
				? `matches ${n.lines.length} lines (${n.lines.join(", ")})`
				: "matches no line — the anchored text is gone, so it suppresses nothing";
		const scope = n.needle ? ` (scoped to "${n.needle}")` : "";
		ctx.warn(
			"ANCHOR",
			`§${n.entry}: "${n.anchor}"${scope} in ${n.file} ${where}`,
			n,
		);
		const row = n.path === n.file ? "" : ` (allowlist row \`${n.path}\`)`;
		ctx.say(`  §${n.entry} · ${n.file}${row} · "${n.anchor}"${scope} ${where}`);
	}
}

/**
 * An entry's allowlist, ready to ask about a file: each row keeps its path
 * matcher, its line pins and its content anchors.
 * @param {AllowlistRow[]|null|undefined} allowlist
 * @returns {CompiledAllowRow[]}
 */
function compileAllowlist(allowlist) {
	return (allowlist || []).map((a) => ({
		path: a.path,
		matcher: citationMatcher(a.path),
		lines: a.lines || [],
		anchors: (a.anchors || []).map((anchor) =>
			typeof anchor === "string"
				? { text: anchor, needle: null }
				: { text: anchor.anchor, needle: anchor.needle },
		),
	}));
}

/**
 * What a compiled allowlist suppresses in one file, resolved against that
 * file's current text: `allows(lineNo, needle)`, plus the anchors worth
 * reporting.
 *
 * A **scoped** anchor (`{ anchor, needle }`) suppresses only the needle it
 * names, so the line stays scanned for every other one (mantahostels#2431).
 *
 * An anchor is a plain substring of the line, not a pattern — the thing an
 * author can copy out of the file and paste in. Two cases are reported rather
 * than resolved silently, both of them safe by construction:
 *
 *   0 matches   the anchored line has been edited or removed, so the entry
 *               suppresses nothing and its hit reports again. Named, because
 *               otherwise a dead anchor is indistinguishable from a live one.
 *   >1 matches  nothing is suppressed either, and the spread is named. An
 *               anchor matching two lines is a claim about one of them, so the
 *               fix is a longer anchor, not a wider suppression.
 *
 * A **line pin** gets the same diagnostic where the caller passes `matches`, a
 * predicate asking whether a line still carries anything the entry greps for
 * (mantahostels#847). A pin whose line matches nothing suppresses nothing and, unlike a
 * dead anchor, said nothing about it (mantahostels#792). Reported, never resolved: the pin
 * keeps suppressing its line, which changes no verdict.
 *
 * A **scoped** anchor has a third state nothing reports: it matches its line,
 * but that line no longer carries the needle it names, so it suppresses nothing.
 * The `matches` predicate asks about the entry's needles as a set, not the one
 * the anchor named, so telling that apart needs a per-needle predicate this
 * signature does not carry. Safe either way — the hit re-reports under its own
 * name (mantahostels#2431).
 *
 * The pin that has drifted onto a *different* line still matching the entry's
 * phrases is deliberately not reported: a pin carries no record of the line it
 * was written against, so a drifted one is indistinguishable from a correct
 * one, and naming it would name every healthy pin too.
 * @param {CompiledAllowRow[]} allow
 * @param {string} file
 * @param {string[]} lines
 * @param {((line: string) => boolean)|null} [matches]
 */
function resolveAllowlist(allow, file, lines, matches) {
	const rows = allow.filter((a) => a.matcher(file));
	/** @type {AllowResolution} */
	const acc = {
		allowed: new Set(),
		/* A scoped anchor's suppression, per line: the needles it names, and only
		 * those (mantahostels#2431). */
		scoped: new Map(),
		notes: [],
		pins: [],
		wholeFile: false,
		wholeFileNotes: [],
	};
	/* A file's text splits into a trailing empty element the newline at its end
	 * produces, and that phantom line is not a line to pin. */
	const eof =
		lines.length > 0 && lines.at(-1) === "" ? lines.length - 1 : lines.length;
	/** @type {AllowFile} */
	const at = { file, lines, eof, matches };
	for (const row of rows) {
		resolveWholeFileRow(acc, row, at);
		resolveLinePins(acc, row, at);
		for (const anchor of row.anchors) resolveAnchor(acc, row, anchor, at);
	}
	/**
	 * @param {number} n
	 * @param {string} [needle] the needle being asked about, where the caller has
	 *   one — without it only whole-line suppression answers.
	 */
	const allows = (n, needle) =>
		acc.wholeFile ||
		acc.allowed.has(n) ||
		(needle !== undefined && (acc.scoped.get(n)?.has(needle) ?? false));
	return {
		allows,
		notes: acc.notes,
		pins: acc.pins,
		wholeFileNotes: acc.wholeFileNotes,
	};
}

/**
 * `resolveAllowlist`'s working state across one file's rows.
 * @typedef {object} AllowResolution
 * @property {Set<number>} allowed
 * @property {Map<number, Set<string>>} scoped
 * @property {Omit<AnchorNote, "entry">[]} notes
 * @property {Omit<PinNote, "entry">[]} pins
 * @property {boolean} wholeFile
 * @property {Omit<WholeFileNote, "entry">[]} wholeFileNotes
 */

/**
 * The file `resolveAllowlist` resolves against.
 * @typedef {object} AllowFile
 * @property {string} file
 * @property {string[]} lines
 * @property {number} eof
 * @property {((line: string) => boolean)|null|undefined} matches
 */

/**
 * @param {AllowResolution} acc accumulator: a whole-file row is marked, and noted where nothing in the file hits
 * @param {CompiledAllowRow} row
 * @param {AllowFile} at
 */
function resolveWholeFileRow(acc, row, at) {
	if (row.lines.length > 0 || row.anchors.length > 0) return;
	acc.wholeFile = true;
	const { file, lines, eof, matches } = at;
	if (matches && !lines.slice(0, eof).some(matches))
		acc.wholeFileNotes.push({ path: row.path, file });
}

/**
 * @param {AllowResolution} acc accumulator: each pinned line is allowed, and a pin that hits nothing noted
 * @param {CompiledAllowRow} row
 * @param {AllowFile} at
 */
function resolveLinePins(acc, row, at) {
	const { file, lines, eof, matches } = at;
	for (const n of row.lines) {
		acc.allowed.add(n);
		if (!matches) continue;
		if (n > eof) {
			acc.pins.push({ path: row.path, file, line: n, fileLines: eof });
			continue;
		}
		const line = lines[n - 1];
		if (line === undefined)
			throw new Error(
				`${row.path} pins ${file} at line ${n}, below line 1, which validation refuses`,
			);
		if (!matches(line))
			acc.pins.push({
				path: row.path,
				file,
				line: n,
				text: line.trim().slice(0, 120),
			});
	}
}

/**
 * @param {AllowResolution} acc accumulator: the anchor's line is allowed or scoped, or the anchor noted
 * @param {CompiledAllowRow} row
 * @param {CompiledAllowRow["anchors"][number]} anchor
 * @param {AllowFile} at
 */
function resolveAnchor(acc, row, anchor, at) {
	const matched = [];
	for (const [i, line] of at.lines.entries())
		if (line.includes(anchor.text)) matched.push(i + 1);
	const [only, ...more] = matched;
	if (only === undefined || more.length > 0) {
		acc.notes.push({
			path: row.path,
			file: at.file,
			anchor: anchor.text,
			needle: anchor.needle,
			lines: matched,
		});
		return;
	}
	if (anchor.needle === null) acc.allowed.add(only);
	else {
		let set = acc.scoped.get(only);
		if (!set) {
			set = new Set();
			acc.scoped.set(only, set);
		}
		set.add(anchor.needle);
	}
}

/**
 * The grep both supersession scans run: every needle against every line of every
 * file, minus what each entry's allowlist suppresses, plus the anchor and pin
 * diagnostics resolveAllowlist raises. Held here rather than copied per
 * checker.
 *
 * The caller owns what a hit IS. `hitsLine(needle, file, text)` carries its own
 * scope rules — check-superseded-values.js's prose-only and heading-word filters
 * live there — and `skipLine(file, lines)` returns a predicate over line index
 * naming what is never read. A needle is opaque here beyond its `entry` key and
 * its own text, which a scoped allowlist anchor suppresses by (mantahostels#2431), so each
 * checker shapes its own report off the needle a hit carries back.
 *
 * @template {{entry: string, needle: string}} N
 * @param {{ files: string[], needles: N[], allowlists: Map<string, CompiledAllowRow[]>,
 *   hitsLine: (needle: N, file: string, text: string) => boolean,
 *   skipLine?: (file: string, lines: string[]) => (((index: number) => boolean) | null) }} spec
 * @returns {{hits: {needle: N, file: string, line: number, text: string}[], anchorNotes: AnchorNote[], pinNotes: PinNote[], wholeFileNotes: WholeFileNote[], allowed: number}}
 */
function scanNeedles({ files, needles, allowlists, hitsLine, skipLine }) {
	/** @type {{needle: N, file: string, line: number, text: string}[]} */ const hits =
		[];
	/** @type {AnchorNote[]} */ const anchorNotes = [];
	/** @type {PinNote[]} */ const pinNotes = [];
	/** @type {WholeFileNote[]} */ const wholeFileNotes = [];
	let allowed = 0;
	/** @type {Map<string, N[]>} */ const byEntry = new Map();
	for (const needle of needles) {
		if (!byEntry.has(needle.entry)) byEntry.set(needle.entry, []);
		byEntry.get(needle.entry)?.push(needle);
	}
	for (const file of files) {
		const lines = readTextLines(file);
		if (!lines) continue;
		const skip = skipLine?.(file, lines);
		const { resolved, notes } = resolveFileAllowlists(
			{ allowlists, byEntry, hitsLine },
			file,
			lines,
		);
		anchorNotes.push(...notes.anchorNotes);
		pinNotes.push(...notes.pinNotes);
		wholeFileNotes.push(...notes.wholeFileNotes);
		for (const needle of needles) {
			const allows = resolved.get(needle.entry)?.allows;
			const scanned = scanNeedleLines({
				needle,
				file,
				lines,
				skip,
				allows,
				hitsLine,
			});
			hits.push(...scanned.hits);
			allowed += scanned.allowed;
		}
	}
	return { hits, anchorNotes, pinNotes, wholeFileNotes, allowed };
}

/**
 * Every entry's allowlist resolved against one file, and its notes.
 *
 * Resolved per file for every entry rather than only the ones that hit here:
 * an anchor matching nothing is a finding whether or not the needle it
 * suppresses still fires.
 * @template {{entry: string, needle: string}} N
 * @param {{ allowlists: Map<string, CompiledAllowRow[]>, byEntry: Map<string, N[]>,
 *   hitsLine: (needle: N, file: string, text: string) => boolean }} scan
 * @param {string} file
 * @param {string[]} lines
 * @returns {{resolved: Map<string, ReturnType<typeof resolveAllowlist>>,
 *   notes: {anchorNotes: AnchorNote[], pinNotes: PinNote[], wholeFileNotes: WholeFileNote[]}}}
 */
function resolveFileAllowlists(scan, file, lines) {
	const { allowlists, byEntry, hitsLine } = scan;
	/** @type {Map<string, ReturnType<typeof resolveAllowlist>>} */
	const resolved = new Map();
	/** @type {{anchorNotes: AnchorNote[], pinNotes: PinNote[], wholeFileNotes: WholeFileNote[]}} */
	const notes = { anchorNotes: [], pinNotes: [], wholeFileNotes: [] };
	for (const [id, allow] of allowlists) {
		const matches = (/** @type {string} */ text) =>
			(byEntry.get(id) || []).some((n) => hitsLine(n, file, text));
		const r = resolveAllowlist(allow, file, lines, matches);
		resolved.set(id, r);
		for (const note of r.notes) notes.anchorNotes.push({ entry: id, ...note });
		for (const note of r.pins) notes.pinNotes.push({ entry: id, ...note });
		for (const note of r.wholeFileNotes)
			notes.wholeFileNotes.push({ entry: id, ...note });
	}
	return { resolved, notes };
}

/**
 * One needle over one file's lines: its hits, and the count of hits the
 * allowlist suppressed.
 * @template {{entry: string, needle: string}} N
 * @param {{ needle: N, file: string, lines: string[],
 *   skip: ((index: number) => boolean) | null | undefined,
 *   allows: ((n: number, needle?: string) => boolean) | undefined,
 *   hitsLine: (needle: N, file: string, text: string) => boolean }} spec
 * @returns {{hits: {needle: N, file: string, line: number, text: string}[], allowed: number}}
 */
function scanNeedleLines(spec) {
	const { needle, file, lines, skip, allows, hitsLine } = spec;
	/** @type {{needle: N, file: string, line: number, text: string}[]} */
	const hits = [];
	let allowed = 0;
	for (const [i, line] of lines.entries()) {
		if (skip?.(i)) continue;
		if (!hitsLine(needle, file, line)) continue;
		if (allows?.(i + 1, needle.needle)) {
			allowed++;
			continue;
		}
		hits.push({
			needle,
			file,
			line: i + 1,
			text: line.trim().slice(0, 120),
		});
	}
	return { hits, allowed };
}

/**
 * The line-pin diagnostic, the anchor one's twin (mantahostels#847).
 * @param {CheckContext} ctx
 * @param {PinNote[]} notes
 */
function reportPins(ctx, notes) {
	if (notes.length === 0) return;
	ctx.say(
		`\n${notes.length} allowlist line pin(s) point at a line carrying none of ` +
			"their entry's phrases — the pinned line has moved or been rewritten, so " +
			"the pin suppresses nothing. Re-pin by content (an anchor follows its " +
			"line; a pin does not):",
	);
	for (const n of notes) {
		const where =
			n.fileLines === undefined
				? `line ${n.line} matches nothing the entry greps for`
				: `line ${n.line} is past the end of the file (${n.fileLines} lines)`;
		ctx.warn("PIN", `§${n.entry}: ${n.file} ${where}`, n);
		const row = n.path === n.file ? "" : ` (allowlist row \`${n.path}\`)`;
		const text = n.text ? ` · "${n.text}"` : "";
		ctx.say(`  §${n.entry} · ${n.file}${row} · ${where}${text}`);
	}
}

/**
 * The whole-file diagnostic, the anchor and pin ones' third twin (mantahostels#2403). A
 * whole-file row (`lines: []`, no anchors) suppresses every line under it, so
 * unlike an anchor or a pin it has no per-line miss to report — only whether
 * the file it names carries anything the entry greps for at all.
 *
 * THREE RESIDUALS. A caller passing no `matches` predicate gets no note at
 * all, same as an anchor or a pin (mantahostels#847's precedent). Coverage is ALL OR
 * NOTHING: a file with one matching line and nine that have since drifted
 * off-topic still reads fully covered — the note only ever fires on total
 * silence, so the partial-drift case an allowlist row warns against can still
 * hide behind a row that once matched. The scan reads every line in `lines`
 * unfiltered, so a caller's `skipLine` (the §B self-exemption both §B
 * checkers apply to their hit loop) is not applied here — a file whose only
 * matching lines sit inside a skipped region reads covered when nothing
 * outside that region ever fires.
 * @param {CheckContext} ctx
 * @param {WholeFileNote[]} notes
 */
function reportWholeFile(ctx, notes) {
	if (notes.length === 0) return;
	ctx.say(
		`\n${notes.length} whole-file allowlist row(s) suppress a file carrying ` +
			"none of their entry's phrases — the row currently covers nothing. " +
			"Narrow it to real lines or anchors, or delete it if nothing there " +
			"is live:",
	);
	for (const n of notes) {
		ctx.warn(
			"WHOLE-FILE",
			`§${n.entry}: ${n.file} matches none of the entry's phrases`,
			n,
		);
		const row = n.path === n.file ? "" : ` (allowlist row \`${n.path}\`)`;
		ctx.say(
			`  §${n.entry} · ${n.file}${row} · matches none of the entry's phrases`,
		);
	}
}

/**
 * One needle-ledger entry, superseded or machinery.
 * @typedef {{needle: string, scanned: boolean}} ScanNeedle
 * @typedef {{needles: ScanNeedle[], allowlist?: AllowlistRow[]}} NeedleEntry
 */

/**
 * Validates a NeedleEntry: its needles, each with a stated `scanned` flag, and
 * an optional allowlist.
 * @param {string} file
 * @param {string} id
 * @param {unknown} entry
 */
function validateNeedleEntry(file, id, entry) {
	if (!isPlainObject(entry)) fail(file, `${id} does not hold an object`);
	onlyKeys(file, id, entry, ["needles", "allowlist"]);
	nonEmptyArray(file, `${id}: needles`, entry.needles);
	/* Scanned needles only: an anchor scoped to an unscanned one would
	 * suppress nothing. */
	/** @type {Set<string>} */
	const scannedNeedles = new Set();
	for (const item of entry.needles) {
		onlyKeys(file, id, item, ["needle", "scanned"]);
		nonEmptyString(file, `${id}: needle`, item.needle);
		if (typeof item.scanned !== "boolean")
			fail(
				file,
				`${id}: needle \`${item.needle}\` states no boolean scanned flag`,
			);
		if (item.scanned) scannedNeedles.add(item.needle);
	}
	if ("allowlist" in entry)
		validateAllowlist(file, id, entry.allowlist, scannedNeedles);
}

/**
 * Superseded needles, `{ "B1": { needles: [{ needle, scanned }], allowlist?:
 * [{ path, lines?, anchors? }] } }` — the old values check-superseded-values.js
 * greps, and the legitimate-hits allowlist that suppresses them.
 *
 * `scanned: false` lists a span the checker reports for by-hand checking rather
 * than greps — a multi-value span is a claim about how figures relate, not a
 * literal — so the flag must be stated, never defaulted: an absent flag
 * silently promoting a span to a grep would hit hundreds of correct lines.
 *
 * The allowlist is per *entry*, not per needle — coarser, and chosen for one
 * shape across both instruments.
 * @param {string} file
 * @returns {Record<string, NeedleEntry>}
 */
function loadSupersededNeedles(file) {
	return /** @type {Record<string, NeedleEntry>} */ (
		loadKeyed(
			file,
			(id, entry) => validateNeedleEntry(file, id, entry),
			undefined,
			{ allowEmpty: true },
		)
	);
}

/* A machinery-figure key is documentation for a human reader, never a join key:
 * nothing cross-validates it against a heading anywhere (mantahostels#1440). Shape only, so
 * a typo cannot silently split one figure into two entries. */
const MACHINERY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Machinery-figure needles, `{ "fanout-share": { needles: [{ needle, scanned
 * }], allowlist?: [{ path, lines?, anchors? }] } }` — the retired values
 * check-machinery-superseded.js greps for, and the legitimate-hits allowlist
 * that suppresses them.
 *
 * Not a §B registry and deliberately not shaped like one (mantahostels#1440):
 * check-machinery-superseded.js's header holds the why.
 * @param {string} file
 * @returns {Record<string, NeedleEntry>}
 */
function loadMachineryNeedles(file) {
	return /** @type {Record<string, NeedleEntry>} */ (
		loadKeyed(file, (id, entry) => validateNeedleEntry(file, id, entry), {
			test: MACHINERY_ID,
			noun: "a kebab-case machinery-figure key",
		})
	);
}

/**
 * Retired vocabulary, `{ "B25": { phrases: [{ literal?, stem? }], allowlist?:
 * [{ path, lines?, anchors? }] } }` — the phrase lists
 * check-retired-vocabulary.js greps
 * and the legitimate-hits allowlist that suppresses them. The `Replacement:`
 * line stays in the entry's prose, so no field carries it here.
 *
 * Every stem is compiled at load, exactly as the checker will compile it, and
 * an uncompilable one is the loud error naming its entry.
 * @typedef {{literal?: string, stem?: string}} RetiredPhrase
 * @typedef {{phrases: RetiredPhrase[], allowlist?: AllowlistRow[]}} RetiredVocabularyEntry
 * @param {string} file
 * @param {{allowEmpty?: boolean}} [opts] as `loadRestatements`'s.
 * @returns {Record<string, RetiredVocabularyEntry>}
 */
function loadRetiredVocabulary(file, opts = {}) {
	return /** @type {Record<string, RetiredVocabularyEntry>} */ (
		loadKeyed(
			file,
			(id, entry) => {
				if (!isPlainObject(entry)) fail(file, `${id} does not hold an object`);
				onlyKeys(file, id, entry, ["phrases", "allowlist"]);
				nonEmptyArray(file, `${id}: phrases`, entry.phrases);
				for (const phrase of entry.phrases)
					validateRetiredPhrase(file, id, phrase);
				/* Null, not a needle set: the retired-vocabulary scan resolves its
				 * allowlist with no needle in hand, so a scoped anchor here would be
				 * inert rather than narrow (mantahostels#2431). */
				if ("allowlist" in entry)
					validateAllowlist(file, id, entry.allowlist, null);
			},
			undefined,
			opts,
		)
	);
}

/**
 * One phrase of a retired-vocabulary entry.
 * @param {string} file
 * @param {string} id
 * @param {unknown} phrase
 */
function validateRetiredPhrase(file, id, phrase) {
	onlyKeys(file, id, phrase, ["literal", "stem"]);
	if (!("literal" in phrase) && !("stem" in phrase))
		fail(file, `${id}: a phrase states neither literal nor stem`);
	if ("literal" in phrase)
		nonEmptyString(file, `${id}: literal`, phrase.literal);
	if ("stem" in phrase) validateRetiredStem(file, id, phrase.stem);
}

/**
 * @param {string} file
 * @param {string} id
 * @param {unknown} stem
 */
function validateRetiredStem(file, id, stem) {
	nonEmptyString(file, `${id}: stem`, stem);
	/* The one mis-escape the compile check below cannot catch. JSON's
	 * escape set overlaps regex's on exactly one character: `\b` is a
	 * word boundary to the engine and a backspace to JSON, so a stem
	 * written with one backslash parses, compiles as a backspace atom,
	 * and matches nothing. Every other slip (`\s`, `\d`) is a JSON
	 * parse error, and so already loud. `JSON.stringify` renders the
	 * stem because a raw backspace prints invisibly — backticks would
	 * show a broken stem and a correct one as identical. Stems only:
	 * `literal` and `needle` become patterns too, but a word boundary
	 * is never written in either. Settled at mantahostels#580. */
	if (stem.includes("\b"))
		fail(
			file,
			`${id}: stem ${JSON.stringify(stem)} holds a literal ` +
				"backspace (U+0008) — a word boundary written `\\b` where JSON " +
				"needs `\\\\b`. It compiles, and matches nothing. Double the " +
				"backslash.",
		);
	if (CATASTROPHIC.test(stem))
		fail(
			file,
			`${id}: stem \`${stem}\` holds a quantified group under a ` +
				"quantifier and can backtrack exponentially — rewrite it without " +
				"the nesting",
		);
	try {
		// biome-ignore lint/correctness/noUnusedInstantiation: false finding — compiled only to see whether the stem throws (#1381)
		new RegExp(stem, "i");
	} catch (e) {
		fail(
			file,
			`${id}: stem \`${stem}\` will not compile — ${caught(e).message}`,
		);
	}
}

/* ── Section A rendering (mantahostels#1808, mantahostels#1863) ───────────────────────────────────────
 *
 * One judgement per file — its authority class — lives in
 * docs/doc-map-classes.json, and every other cell comes from the path, the
 * class and the minority of per-file overrides that carry a fact recorded
 * nowhere else.
 *
 * These functions render; scripts/generate-doc-map-section-a.js drives them
 * and check-doc-map.js's assertion 17 compares their output with the file.
 */

/**
 * One docs/doc-map-classes.json entry: the class judgement, the §A subsection
 * it renders under, and the three cells a per-file override may replace.
 * @typedef {{section: string, class: string, classQualifier?: string|null, role?: string|null, route?: string|null, consumes?: ConsumesRef[]|null, reader?: string|null}} DocClassEntry
 */

/**
 * The closed `kind` vocabulary a typed `consumes` reference takes (mantahostels#2419). A
 * reference states its type rather than having it sniffed: `process.execPath`
 * is backticked and holds a dot, so a lexical scan over the free string cannot
 * tell a pointer from a mention.
 *
 * `external` and `note` exist to say "do not resolve this" — an out-of-repo
 * path and a code identifier respectively.
 *
 * `glob` is `citationMatcher`'s vocabulary and not a glob engine: a trailing
 * `*` or `/` for a directory, so `docs/research/*` resolves and
 * `scripts/*.test.ts` does not — or a leading `./` to pin an exact path
 * (mantahostels#2699), which a `path` ref may also spell.
 */
const CONSUMES_KINDS = ["path", "glob", "figure", "issue", "external", "note"];

/**
 * @typedef {{kind: string, ref: string, gloss?: string|null}} ConsumesRef
 */

/** The five documented authority classes (docs/doc-map.md §Authority classes),
 * the vocabulary register-doc.js writes and this renderer reads. */
const DOC_CLASSES = [
	"source-of-truth",
	"derived",
	"generated-only",
	"free-edit",
	"binary-asset",
];

/** Who reads a prose document (mantahostels#3348): the vocabulary register-doc.js writes
 * and assertion 31 gates. Never rendered into §A. */
const DOC_READERS = ["agent", "human", "both"];

/** A key `reader` is required on, and the only kind it is allowed on. A
 * wildcard key ends `*`, so it is never one. */
const isProseKey = (/** @type {string} */ key) => /\.(md|html)$/.test(key);

/**
 * Assertion 31's worklist (mantahostels#3412), from the RAW parse for assertion 19's
 * reason: `unknown` is a value outside DOC_READERS, which loadDocClasses
 * throws on; `missing` a prose key with none; `misplaced` a value on any
 * other key.
 * @param {Record<string, unknown>} parsed
 */
function badReaderEntries(parsed) {
	/** @type {{unknown: {path: string, reader: string}[], missing: string[], misplaced: string[]}} */
	const out = { unknown: [], missing: [], misplaced: [] };
	for (const [key, e] of Object.entries(parsed)) {
		if (!isPlainObject(e)) continue;
		const has = e.reader !== null && e.reader !== undefined;
		if (!isProseKey(key)) {
			if (has) out.misplaced.push(key);
		} else if (!has) out.missing.push(key);
		else if (!DOC_READERS.includes(/** @type {string} */ (e.reader)))
			out.unknown.push({ path: key, reader: JSON.stringify(e.reader) });
	}
	return out;
}

/**
 * The page–source assertion's worklist (mantahostels#3348, mantahostels#3412). A page key is a
 * `derived` `.html` key whose `consumes` holds a `path` ref ending `.md`; it
 * FAILs where that source has no key of its own or is read by `agent` alone.
 * The ref resolves as assertion 25 resolves it (`citationMatcher`): a pinned
 * `./` path or a suffix naming exactly one literal key.
 * @param {Record<string, unknown>} parsed
 */
function pageSourceFaults(parsed) {
	/** @type {{page: string, source: string, why: string}[]} */
	const out = [];
	const entries = /** @type {[string, Record<string, unknown>][]} */ (
		Object.entries(parsed).filter(([, e]) => isPlainObject(e))
	);
	for (const [page, e] of entries) {
		if (!page.endsWith(".html") || e.class !== "derived") continue;
		if (!Array.isArray(e.consumes)) continue;
		for (const ref of /** @type {Record<string, unknown>[]} */ (e.consumes))
			out.push(...pageRefFaults(page, ref, parsed, entries));
	}
	return out;
}

/**
 * `pageSourceFaults` for one `consumes` ref of page key `page`.
 * @param {string} page
 * @param {Record<string, unknown>} ref
 * @param {Record<string, unknown>} parsed
 * @param {[string, Record<string, unknown>][]} entries
 * @returns {{page: string, source: string, why: string}[]}
 */
function pageRefFaults(page, ref, parsed, entries) {
	if (!isPlainObject(ref) || ref.kind !== "path") return [];
	const spelt = String(ref.ref);
	if (!spelt.endsWith(".md")) return [];
	const named = entries
		.map(([k]) => k)
		.filter((k) => !k.endsWith("*") && citationMatcher(spelt)(k));
	const [only, ...more] = named;
	const source =
		only !== undefined && more.length === 0 ? only : spelt.replace(/^\.\//, "");
	const own = /** @type {Record<string, unknown> | undefined} */ (
		parsed[source]
	);
	if (!isPlainObject(own)) return [{ page, source, why: "has no key" }];
	if (own.reader === "agent")
		return [{ page, source, why: "is read by `agent` alone" }];
	return [];
}

/**
 * The sidecar entries whose `class` is outside the six documented tokens —
 * assertion 19's worklist (mantahostels#1849). It reads the RAW parsed JSON rather than
 * `loadDocClasses`'s output, because loadDocClasses throws on exactly this
 * fault: a typo'd token is a finding a session can fix, not apparatus that
 * failed, so it is named and FAILed rather than aborting the run.
 * @param {Record<string, unknown>} parsed
 */
function badClassEntries(parsed) {
	return Object.entries(parsed)
		.filter(
			([, e]) =>
				!(
					isPlainObject(e) &&
					DOC_CLASSES.includes(/** @type {string} */ (e.class))
				),
		)
		.map(([rel, e]) => ({
			path: rel,
			cls: isPlainObject(e) ? String(e.class) : "no object",
		}));
}

/**
 * A JSON document's top-level object keys, in the order the BYTES carry them —
 * duplicates included, which `JSON.parse` silently collapses to the last
 * winner. Strings are skipped over rather than scanned, so a `{` or a `"` inside
 * a `role` override changes nothing (mantahostels#1849).
 * @param {string} text
 */
function jsonTopLevelKeys(text) {
	/** @type {string[]} */
	const keys = [];
	let depth = 0;
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '"') {
			const j = jsonStringEnd(text, i);
			const k = skipJsonSpace(text, j + 1);
			// The caller has already parsed this text, so the escapes re-parse.
			if (depth === 1 && text[k] === ":")
				keys.push(JSON.parse(`"${text.slice(i + 1, j)}"`));
			i = j + 1;
			continue;
		}
		if (ch === "{" || ch === "[") depth++;
		else if (ch === "}" || ch === "]") depth--;
		i++;
	}
	return keys;
}

/**
 * The offset of the closing quote of the JSON string opening at `i`, or
 * `text.length` when it never closes.
 * @param {string} text
 * @param {number} i
 */
function jsonStringEnd(text, i) {
	let j = i + 1;
	while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
	return Math.min(j, text.length);
}

/**
 * The doc map's text, or BROKEN where it cannot be read: the map is tracked
 * in the repo, so an unreadable one is never a SKIP.
 * @param {CheckContext} ctx
 * @param {string} mapPath
 * @returns {string}
 */
function readMap(ctx, mapPath) {
	try {
		return fs.readFileSync(mapPath, "utf8");
	} catch (e) {
		return ctx.broken(
			`cannot read doc map at ${mapPath} — ${caught(e).message}`,
		);
	}
}

/**
 * The first offset at or after `k` that is not whitespace.
 * @param {string} text
 * @param {number} k
 */
function skipJsonSpace(text, k) {
	let at = k;
	while (at < text.length && /\s/.test(text.charAt(at))) at++;
	return at;
}

/**
 * The sidecar keys its own bytes carry more than once — assertion 8's worklist
 * (mantahostels#1849), the register key living in the sidecar. `JSON.parse` keeps the last
 * of a repeated key and drops the rest without a word, so a duplicate is
 * invisible to every reader that walks the parsed object: the raw text is read
 * for the same reason assertion 6 counts §B headings rather than parsed entries.
 * @param {string} text
 */
function duplicateSidecarKeys(text) {
	const seen = new Set();
	const dupes = [];
	for (const key of jsonTopLevelKeys(text)) {
		if (seen.has(key)) dupes.push(key);
		else seen.add(key);
	}
	return [...new Set(dupes)];
}

/** The Update route a class implies; only a genuine exception carries a
 * `route` override (mantahostels#1808 user story 10). These are §A's modal strings, not
 * the Authority-classes table's prose. */
/** @type {Record<string, string>} */
const CLASS_ROUTE = {
	"source-of-truth": "Direct",
	derived: "Regenerate only",
	"generated-only": "That skill only",
	"free-edit": "Direct",
	"binary-asset": "Replace the file",
};

/** The noun a directory gives its files, tried before the extension below: a
 * research note's own name says what it studied, not what kind of thing it is.
 * Longest prefix wins, so `docs/agents/rules/` beats `docs/agents/`. An
 * adopter's own folder takes its noun from its sidecar row's `role` instead
 * (#446, #454). */
/** @type {Record<string, string>} */
const KIND_BY_DIR = {
	"docs/research/": "research run",
	"docs/adr/": "architecture decision record",
	"docs/data/": "evidence record",
	"docs/agents/rules/": "agent rule",
	"docs/agents/": "agent guide",
	"docs/archive/sync-proposals/": "`manual-sync` artefact",
	"docs/archive/sync-reports/": "`manual-sync` artefact",
	".claude/skills/": "skill",
	".claude/commands/": "slash command",
	".claude/output-styles/": "output style",
	".claude/agents/": "agent definition",
};

/** The noun an extension gives a file the directory table did not place.
 * `.md` is absent deliberately: prose needs no noun. */
/** @type {Record<string, string>} */
const KIND_BY_EXT = {
	".json": "data file",
	".csv": "data table",
	".xlsx": "spreadsheet",
	".png": "image",
	".jpg": "image",
	".svg": "image",
	".html": "HTML document",
	".sh": "shell script",
	".py": "Python script",
	".js": "script",
	".ts": "script",
	".yml": "workflow",
	".yaml": "workflow",
	".txt": "text file",
};

/**
 * The human title a path carries when nothing else names it: the stem, with
 * separators opened out and the first letter raised. A `SKILL.md` takes its
 * directory's name instead.
 * @param {string} p
 */
function buildPathTitle(p) {
	const cut = p.lastIndexOf("/");
	let base = p.slice(cut + 1);
	if (/^(SKILL|README|AGENTS)\.md$/.test(base) && cut !== -1) {
		const dir = p.slice(0, cut);
		base = dir.slice(dir.lastIndexOf("/") + 1);
	}
	if (base === ".gitkeep") return "Directory placeholder";
	const stem = base.replace(/\.[^.]+$/, "");
	// An all-caps stem is an acronym-named contract — CLAUDE.md, AGENTS.md.
	// Opening it out spells it wrong, so the filename stands as its own title.
	if (/^[A-Z0-9]+$/.test(stem)) return base;
	const opened = stem.replace(/[-_]+/g, " ");
	return opened.charAt(0).toUpperCase() + opened.slice(1);
}

/**
 * The noun for a path, from its directory first and its extension second, or
 * null where neither table places it.
 * @param {string} p
 */
function pathKind(p) {
	const dir = Object.keys(KIND_BY_DIR)
		.filter((d) => p.startsWith(d))
		.sort((a, b) => b.length - a.length)[0];
	if (dir) return KIND_BY_DIR[dir];
	const ext = p.match(/\.[^./]+$/);
	return (ext && KIND_BY_EXT[ext[0]]) || null;
}

/**
 * The Role cell a path renders with when its sidecar entry sets no `role`. A
 * wildcard says what it covers; everything else is its title plus, where the
 * path places it, the kind of thing it is.
 * @param {string} p
 */
function renderRole(p) {
	if (p.endsWith("/.gitkeep")) return "Directory placeholder";
	const kind = pathKind(p);
	if (p.endsWith("*")) {
		const prefix = wildcardPrefix(p);
		return `Every file under \`${prefix}\`${kind ? ` — ${kind}s` : ""}`;
	}
	return kind ? `${buildPathTitle(p)} — ${kind}` : buildPathTitle(p);
}

/** A cell's `|` is a column break in GFM unless it is escaped, so a Role, a
 * Consumes or a class qualifier quoting one splits its own row (mantahostels#1863, mantahostels#2507).
 * A `\` is escaped too, or a quoted `\|` would read as an escaped `\` before a
 * bare break (#3364). */
/** @param {string} s */
function escapeCell(s) {
	return s.replace(/[\\|]/g, "\\$&");
}

/**
 * One typed reference as §A prints it: the reference in the form its kind
 * implies, then ` (gloss)` where it carries one (mantahostels#2419).
 * @param {ConsumesRef} r
 */
function renderConsumesRef(r) {
	let ref = `\`${r.ref}\``;
	if (r.kind === "figure") ref = `§${r.ref}`;
	else if (r.kind === "issue") ref = `#${r.ref}`;
	return r.gloss ? `${ref} (${r.gloss})` : ref;
}

/**
 * A `consumes` cell's text before `escapeCell`: the em dash for `null`, or the
 * typed list joined ` · `.
 * @param {ConsumesRef[]|null|undefined} consumes
 */
function renderConsumes(consumes) {
	if (!consumes) return "—";
	return consumes.map(renderConsumesRef).join(" · ");
}

/**
 * The `with <other-ref>: ` prefix a pair-scoped gloss opens with, or `null`
 * where the gloss carries none. The other reference is captured as §A prints
 * it, so the comparison is against `renderConsumesRef`.
 *
 * The capture is the three printed shapes and nothing else, so ordinary prose
 * opening `with ` — `with care: …` — is not read as a malformed prefix and
 * faulted for scoping back to `care`. The cost is the other way round: a
 * prefix misspelling its reference reads as prose and is seen by nothing.
 * @param {string|undefined} gloss
 */
function pairScopePrefix(gloss) {
	if (typeof gloss !== "string") return null;
	const m = /^with (§B\d+|#\d+|`[^`]+`): /.exec(gloss);
	return m ? m[1] : null;
}

/**
 * Every `with <other-ref>: ` prefix whose named reference is not the one
 * immediately before it in the same cell (mantahostels#2647).
 *
 * Only the prefix's own referential integrity is checkable here — whether a
 * gloss OUGHT to have been pair-scoped is intent, and no checker reads it.
 * @param {Record<string, unknown>} parsed
 * @returns {{ doc: string, ref: string, why: string }[]}
 */
function pairScopeFaults(parsed) {
	/** @type {{ doc: string, ref: string, why: string }[]} */
	const faults = [];
	for (const [doc, entry] of Object.entries(parsed)) {
		const consumes = isPlainObject(entry) ? entry.consumes : null;
		if (!Array.isArray(consumes)) continue;
		consumes.forEach((el, i) => {
			const fault = pairScopeFault(el, i, consumes);
			if (fault) faults.push({ doc, ...fault });
		});
	}
	return faults;
}

/**
 * `pairScopeFaults` for the reference at `i` of one `consumes` cell.
 * @param {unknown} el
 * @param {number} i
 * @param {unknown[]} consumes
 * @returns {{ ref: string, why: string } | null}
 */
function pairScopeFault(el, i, consumes) {
	/* A reference whose own shape is broken is assertion 25's to report,
	 * and reporting it twice would print it here as `undefined`. */
	if (!isPlainObject(el) || !CONSUMES_KINDS.includes(String(el.kind)))
		return null;
	const named = pairScopePrefix(
		typeof el.gloss === "string" ? el.gloss : undefined,
	);
	if (named === null) return null;
	const self = renderConsumesRef(
		/** @type {ConsumesRef} */ ({ kind: el.kind, ref: el.ref }),
	);
	if (i === 0)
		return {
			ref: self,
			why: `scopes back to ${named}, but is the cell's first reference — nothing precedes it`,
		};
	const printed = printedConsumesRef(consumes[i - 1]);
	if (named !== printed)
		return {
			ref: self,
			why: `scopes back to ${named}, but the reference before it is ${printed}`,
		};
	return null;
}

/**
 * A `consumes` element as §A prints it, or its JSON where it is no object.
 * @param {unknown} prev
 */
function printedConsumesRef(prev) {
	return isPlainObject(prev)
		? renderConsumesRef(
				/** @type {ConsumesRef} */ ({ kind: prev.kind, ref: prev.ref }),
			)
		: JSON.stringify(prev);
}

/**
 * A resolution fault, or — where `shape` is set — a malformed reference,
 * which is the subset `loadDocClasses` would abort the whole run over. The
 * caller stands its own loader down on one, so a named finding is not replaced
 * by a BROKEN.
 * @typedef {{doc: string, ref: string, why: string, shape?: boolean}} ConsumesFault
 */

/**
 * Every typed `consumes` reference resolving to nothing, split the way
 * assertion 4 splits a §C route: `dead` FAILs, `untracked` WARNs because the
 * register edit and the file's own commit are separate steps.
 *
 * It reads the RAW parsed sidecar rather than `loadDocClasses`'s output, on
 * `badClassTokens`'s reasoning. A `consumes` that is not an array is a shape
 * fault like any other.
 *
 * An `issue` is never resolved against the network (mantahostels#2532), and a closed issue
 * is corpus here rather than history, so a closed one is a valid target
 * anyway.
 *
 * @param {Record<string, unknown>} parsed the raw sidecar, keyed by path
 * @param {{
 *   tracked: string[],
 *   presentUntracked: (ref: string) => boolean,
 *   liveFigures: Set<string>,
 * }} world
 * @returns {{ dead: ConsumesFault[], untracked: ConsumesFault[] }}
 */
function consumesFaults(parsed, world) {
	/** @type {ConsumesFault[]} */
	const dead = [];
	/** @type {ConsumesFault[]} */
	const untracked = [];
	for (const [doc, entry] of Object.entries(parsed)) {
		const consumes = isPlainObject(entry) ? entry.consumes : null;
		if (consumes === null || consumes === undefined) continue;
		if (!Array.isArray(consumes)) {
			dead.push(consumesShapeFault(doc, consumes));
			continue;
		}
		listFaults(doc, consumes, world, { dead, untracked });
	}
	return { dead, untracked };
}

/**
 * Sorts each faulty element of one doc's `consumes` list into `into`.
 * @param {string} doc
 * @param {unknown[]} consumes
 * @param {Parameters<typeof consumesFaults>[1]} world
 * @param {{ dead: ConsumesFault[], untracked: ConsumesFault[] }} into accumulator: each faulty element lands in its list
 */
function listFaults(doc, consumes, world, into) {
	for (const el of consumes) {
		const found = consumesRefFault(doc, el, world);
		if (found) (found.untracked ? into.untracked : into.dead).push(found.fault);
	}
}

/**
 * The shape fault for a `consumes` that is not a list.
 * @param {string} doc
 * @param {unknown} consumes
 * @returns {ConsumesFault}
 */
function consumesShapeFault(doc, consumes) {
	return {
		doc,
		ref: JSON.stringify(consumes),
		why: "is not a list of typed references",
		shape: true,
	};
}

/**
 * `consumesFaults` for one element of a `consumes` list: its fault, `untracked`
 * where it is that WARN rather than a dead reference, or null where it is sound.
 * @param {string} doc
 * @param {unknown} el
 * @param {Parameters<typeof consumesFaults>[1]} world
 * @returns {{ fault: ConsumesFault, untracked: boolean } | null}
 */
function consumesRefFault(doc, el, world) {
	const shaped = consumesRefShape(doc, el);
	if ("fault" in shaped) return { fault: shaped.fault, untracked: false };
	const { ref, kind } = shaped;
	if (kind === "external" || kind === "note") return null;
	if (kind === "issue") {
		if (/^\d+$/.test(ref)) return null;
		return {
			fault: {
				doc,
				ref,
				why: "is not a bare issue number — shape is checked here, existence never is",
			},
			untracked: false,
		};
	}
	if (kind === "figure") {
		if (world.liveFigures.has(ref)) return null;
		return { fault: deadFigureFault(doc, ref), untracked: false };
	}
	if (world.tracked.some(citationMatcher(ref))) return null;
	/* A glob takes no untracked WARN of its own: mantahostels#1193's mid-ticket state
	 * is one named file not yet committed, and a glob that matches only
	 * uncommitted files matches no registered edge either way. */
	if (kind === "glob")
		return {
			fault: { doc, ref, why: "matches no tracked file" },
			untracked: false,
		};
	const onDisk = world.presentUntracked(ref);
	return {
		fault: {
			doc,
			ref,
			why: onDisk
				? "is present on disk but not yet tracked by git"
				: "names no tracked file and nothing on disk",
		},
		untracked: onDisk,
	};
}

/**
 * A `consumes` element's `ref` and `kind` where its shape is sound; its shape
 * fault where it is not.
 * @param {string} doc
 * @param {unknown} el
 * @returns {{ ref: string, kind: string } | { fault: ConsumesFault }}
 */
function consumesRefShape(doc, el) {
	if (!isPlainObject(el) || typeof el.ref !== "string" || !el.ref.trim())
		return {
			fault: {
				doc,
				ref: JSON.stringify(el),
				why: "is not a { kind, ref } reference object",
				shape: true,
			},
		};
	const ref = /** @type {string} */ (el.ref);
	const kind = el.kind;
	if (typeof kind !== "string" || !CONSUMES_KINDS.includes(kind))
		return {
			fault: {
				doc,
				ref,
				why: `carries kind ${JSON.stringify(kind)} — not one of ${CONSUMES_KINDS.join(", ")}`,
				shape: true,
			},
		};
	return { ref, kind };
}

/**
 * The fault for a `figure` reference heading no live §B entry.
 * @param {string} doc
 * @param {string} ref
 * @returns {ConsumesFault}
 */
function deadFigureFault(doc, ref) {
	return { doc, ref, why: `§${ref} heads no Section B entry` };
}

/**
 * One §A row, as `| path | role | class | update route | consumes |`.
 * @param {string} p
 * @param {DocClassEntry} entry
 */
function renderRegisterRow(p, entry) {
	const cls =
		`\`${entry.class}\`` +
		(entry.classQualifier ? ` ${escapeCell(entry.classQualifier)}` : "");
	const cells = [
		`\`${p}\``,
		escapeCell(entry.role || renderRole(p)),
		cls,
		escapeCell(entry.route || CLASS_ROUTE[entry.class] || "Direct"),
		escapeCell(renderConsumes(entry.consumes)),
	];
	return `| ${cells.join(" | ")} |`;
}

/** §A's register-table header and its separator — the two lines that mark a
 * table this renderer owns. The stamp table under §Version stamps carries a
 * different header and is left alone. */
const REGISTER_HEADER = "| Path | Role | Class | Update route | Consumes |";
const REGISTER_SEPARATOR = "|---|---|---|---|---|";

/*
 * A `docs/doc-map.md §<name>` reference, path backticked or bare, `docs/`
 * optional (#805). The lookbehind keeps out every other `doc-map.md`: the
 * adopter template's, and mantahostels' as a `mantahostels:docs/doc-map.md`
 * reference. Group 1 is the rest of the line after the `§`.
 */
const SECTION_REF = /(?<![\w/:.-])(?:docs\/)?doc-map\.md`?[ \t]*§([^\n]*)/g;

/**
 * @typedef {{ preamble: boolean, count: number, numbered: Set<string> }} SectionName
 */

/** A `##`–`######` heading: its hashes, then its title — runs that each end
 * on a non-blank, or one character, so trailing blanks are read once. */
const NAMED_HEADING =
	/^(#{2,6}) ((?:[^\S\n\r\u2028\u2029]*\S)+|[^\n\r\u2028\u2029])\s*$/;
const SECTION_LETTER = /^Section ([A-Z])\b/;
const SUB_NUMBER = /^(\d+)\./;
/** A `§<n>` straight after a section name, capturing `<n>`. */
const SUB_REF = /^(?:'s)?\s*§(\d+)\b/;

/**
 * Every name a `§<name>` reference to the map may resolve to. A heading answers
 * to its whole title, the title before its ` — ` or ` · `, a `Section X`
 * heading to `X`, and a `### <n>.` heading to `<n>`. Per name: whether its
 * section carries a preamble — prose before the next heading of any level, a
 * `None registered.` placeholder or a `---` rule not counting — how many
 * headings carry it, and, for
 * a `## ` heading, the `<n>` of each `### <n>.` beneath it. Fenced blocks are
 * skipped: the map quotes its own formats.
 * @param {string} text the doc map
 * @returns {Map<string, SectionName>}
 */
function docMapSectionNames(text) {
	const lines = text.split("\n");
	/** @type {Map<string, SectionName>} */
	const names = new Map();
	/** @type {Set<string>} */
	let numbered = new Set();
	let fenced = false;
	for (const [i, line] of lines.entries()) {
		if (/^(```|~~~)/.test(line)) fenced = !fenced;
		const m = fenced ? null : line.match(NAMED_HEADING);
		if (!m) continue;
		const hashes = requiredGroup(m, 1, NAMED_HEADING);
		const title = requiredGroup(m, 2, NAMED_HEADING);
		const keys = headingNameKeys(title);
		const n = subNumberOf(title);
		if (n !== null) keys.push(n);
		if (n !== null && hashes === "###") numbered.add(n);
		if (hashes === "##") numbered = new Set();
		recordSectionNames(names, keys, {
			preamble: hasPreamble(lines, i),
			hashes,
			numbered,
		});
	}
	return names;
}

/**
 * @param {string} title
 */
function headingNameKeys(title) {
	const separator = title.search(/ — | · /);
	const keys = [title, separator === -1 ? title : title.slice(0, separator)];
	const letter = title.match(SECTION_LETTER);
	if (letter) keys.push(requiredGroup(letter, 1, SECTION_LETTER));
	return keys;
}

/**
 * @param {string} title
 */
function subNumberOf(title) {
	const num = title.match(SUB_NUMBER);
	return num ? requiredGroup(num, 1, SUB_NUMBER) : null;
}

/**
 * Whether the heading at line `i` carries a preamble: prose before the next
 * heading, a `None registered.` placeholder not counting.
 * @param {string[]} lines
 * @param {number} i
 */
function hasPreamble(lines, i) {
	for (const next of lines.slice(i + 1)) {
		if (/^#{1,6} /.test(next)) return false;
		const t = next.trim();
		if (t && t !== "---" && t !== "None registered.") return true;
	}
	return false;
}

/**
 * Records one heading under each of its distinct `keys`.
 * @param {Map<string, SectionName>} names accumulator: each key's entry is created or counted here
 * @param {string[]} keys
 * @param {{ preamble: boolean, hashes: string, numbered: Set<string> }} heading
 */
function recordSectionNames(names, keys, heading) {
	const { preamble, hashes, numbered } = heading;
	for (const k of new Set(keys)) {
		const prev = names.get(k);
		names.set(k, {
			preamble: !!prev?.preamble || preamble,
			count: (prev?.count ?? 0) + 1,
			numbered: hashes === "##" ? numbered : (prev?.numbered ?? new Set()),
		});
	}
}

/**
 * `rest` with its trailing run of quotes, `*`, `+`, `,`, `;`, `)`, blanks and
 * written `\n` escapes cut.
 * @param {string} rest
 */
function withoutRefTail(rest) {
	let end = rest.length;
	for (;;) {
		if (end > 0 && /["'`*+,;)\s]/.test(rest.charAt(end - 1))) end--;
		else if (rest.endsWith("\\n", end)) end -= 2;
		else break;
	}
	return rest.slice(0, end);
}

/**
 * Whether one reference's line-rest names a section of the map. The longest
 * name the rest opens with, ending at a non-alphanumeric, wins — so `§B71`
 * needs a `B71` heading while `§B entry` resolves to Section B. A bare `§<n>`
 * must name exactly one `### <n>.` heading; `§<X> §<n>` needs `### <n>.` under
 * §X; `§<X> preamble` needs §X to carry one. A rest opening with `<` is a
 * placeholder (`§B<n>`). A rest that ends its line part-way through a name —
 * prose or a string literal wrapped mid-reference — resolves where the words
 * before the break open a name.
 * @param {string} rest
 * @param {Map<string, SectionName>} names
 */
function isLiveSectionRef(rest, names) {
	if (rest.startsWith("<")) return true;
	let best = "";
	for (const k of names.keys())
		if (
			k.length > best.length &&
			rest.startsWith(k) &&
			!/[A-Za-z\d]/.test(rest.charAt(k.length))
		)
			best = k;
	if (best) {
		const name = /** @type {SectionName} */ (names.get(best));
		const after = rest.slice(best.length);
		if (/^\d+$/.test(best) && name.count > 1) return false;
		const sub = after.match(SUB_REF);
		if (sub) return name.numbered.has(requiredGroup(sub, 1, SUB_REF));
		return /^(?:'s)?\s+preamble\b/i.test(after) ? name.preamble : true;
	}
	const head = withoutRefTail(rest);
	return (
		head.length > 0 &&
		[...names.keys()].some(
			(k) => k.startsWith(head) && k.charAt(head.length) === " ",
		)
	);
}

/**
 * Every `docs/doc-map.md §<name>` reference in `files` that names no section of
 * `mapText` (#805), deduplicated per file. `ref` is the reference as written,
 * cut to 40 characters — a fault's identity, so it carries no line number, and
 * an edit further along the line leaves the fault inherited rather than new.
 * Two faults agreeing in those 40 characters report as one.
 * @param {string} mapText
 * @param {{ file: string, text: string }[]} files
 * @returns {{ file: string, ref: string }[]}
 */
function unresolvedSectionRefs(mapText, files) {
	const names = docMapSectionNames(mapText);
	/** @type {{ file: string, ref: string }[]} */
	const out = [];
	for (const { file, text } of files) {
		if (!text.includes("doc-map.md")) continue;
		const seen = new Set();
		for (const m of text.matchAll(SECTION_REF)) {
			const rest = requiredGroup(m, 1, SECTION_REF);
			if (isLiveSectionRef(rest, names)) continue;
			const ref = `§${rest.slice(0, 40).trimEnd()}`;
			if (seen.has(ref)) continue;
			seen.add(ref);
			out.push({ file, ref });
		}
	}
	return out;
}

/* The §A subsections that render as a register LIST rather than a table
 * (mantahostels#2743). Every field stays in docs/doc-map-classes.json, which is what
 * assertions 17, 25 and 26 read. A subsection joins this set on a founder
 * ruling, never because its table looks long. */
const LIST_SECTIONS = new Set(["Research runs"]);

const SUBSECTION_HEADING =
	/^### ((?:[^\S\n\r\u2028\u2029]*\S)+|[^\n\r\u2028\u2029])\s*$/;

/**
 * The §A subsection a heading names, or null on any other line.
 * @param {string} line
 */
function subsectionHeading(line) {
	const m = line.match(SUBSECTION_HEADING);
	return m ? requiredGroup(m, 1, SUBSECTION_HEADING) : null;
}

/**
 * `text`'s §A with every register table re-rendered from `sidecar`, and every
 * other byte — the preamble, the subsection prose, §Version stamps and the two
 * prose subsections under it — left exactly as it stands.
 *
 * Rows sort by path inside their subsection, so two sessions registering two
 * documents produce a diff each can read (mantahostels#1808 user story 32) and running
 * this twice produces no second diff (user story 33). A `section` naming no
 * existing heading gets one, appended after the last register table (user
 * story 34).
 *
 * @param {string} text the whole doc map
 * @param {Record<string, DocClassEntry>} sidecar docs/doc-map-classes.json's contents
 * @returns {string} the whole doc map, §A re-rendered
 */
function renderSectionA(text, sidecar) {
	const [head, rest] = splitAtSectionA(text);
	if (rest === null) return text;
	const [region, tail] = splitAtSectionB(rest);

	const pathsBySection = entriesBySection(sidecar);

	/** @type {SectionARender} */
	const r = { out: [], rendered: new Set(), lastTableEnd: -1 };
	/** @type {string|null} */
	let section = null;
	let fenced = false;
	const lines = region.split("\n");
	for (let i = 0, line = lines[0]; line !== undefined; line = lines[++i]) {
		if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
		if (!fenced) section = subsectionHeading(line) ?? section;
		if (!fenced && section !== null) {
			const end = registerBlockEnd(lines, i);
			if (end !== null) {
				i = end;
				renderSectionOnce(r, pathsBySection, section);
				continue;
			}
		}
		r.out.push(line);
	}

	// A section the sidecar names and §A has no heading for: give it one, after
	// the last register table rather than at the foot, which would put it under
	// §Version stamps and the prose subsections.
	insertFreshSections(r, pathsBySection);

	return head + r.out.join("\n") + tail;
}

/**
 * `renderSectionA`'s output so far: its lines, the sections already rendered,
 * and where the last register block it emitted ends.
 * @typedef {{ out: string[], rendered: Set<string>, lastTableEnd: number }} SectionARender
 */

/**
 * The sidecar's entries grouped by §A subsection, each group sorted by path.
 * @param {Record<string, DocClassEntry>} sidecar
 */
function entriesBySection(sidecar) {
	/** @type {Map<string, [string, DocClassEntry][]>} section name → its sidecar entries */
	const pathsBySection = new Map();
	for (const [p, entry] of Object.entries(sidecar).sort(([a], [b]) =>
		byCodeUnit(a, b),
	)) {
		const rows = pathsBySection.get(entry.section) || [];
		rows.push([p, entry]);
		pathsBySection.set(entry.section, rows);
	}
	return pathsBySection;
}

/** The block a subsection registers its documents as: the list where
 * LIST_SECTIONS names it AND its rows agree on one class — qualifier and
 * all, since that is the whole text a Class cell would have carried. Mixed
 * classes fall back to the table rather than letting one marker speak for a
 * class a row does not hold. An empty class falls back too: `listBegin("")` emits a marker
 * `LIST_BEGIN_RE` cannot match, which the next render would read as prose
 * and duplicate the list under.
 * @param {Map<string, [string, DocClassEntry][]>} pathsBySection
 * @param {string} name */
function buildSectionBlock(pathsBySection, name) {
	const rows = pathsBySection.get(name) || [];
	if (LIST_SECTIONS.has(name) && rows.length > 0) {
		const classes = new Set(
			rows.map(([, entry]) => buildSidecarClassText(entry) || ""),
		);
		const [cls] = [...classes];
		if (classes.size === 1 && cls)
			return [listBegin(cls), ...rows.map(([p]) => `- \`${p}\``), LIST_END];
	}
	return [
		REGISTER_HEADER,
		REGISTER_SEPARATOR,
		...rows.map(([p, entry]) => renderRegisterRow(p, entry)),
	];
}

/**
 * Where the loop index lands after swallowing the register block opening at
 * line `i` — a table or a list — or null where line `i` opens neither.
 * @param {string[]} lines
 * @param {number} i
 * @returns {number|null}
 */
function registerBlockEnd(lines, i) {
	const line = lines[i];
	if (line === REGISTER_HEADER) return registerTableEnd(lines, i) - 1;
	if (line !== undefined && LIST_BEGIN_RE.test(line))
		return registerListEnd(lines, i);
	return null;
}

/**
 * Swallow the table the header at `i` opens: its header, its separator, every
 * row, and any blank line a row run is broken by, which ends the table in GFM
 * (mantahostels#1863). Returns the index of the first line after it.
 * @param {string[]} lines
 * @param {number} i
 */
function registerTableEnd(lines, i) {
	let j = i + 1;
	if (lines[j] === REGISTER_SEPARATOR) j++;
	for (;;) {
		if (lines[j]?.startsWith("|")) {
			j++;
			continue;
		}
		let k = j;
		while (lines[k]?.trim() === "") k++;
		if (k > j && lines[k]?.startsWith("|")) {
			j = k;
			continue;
		}
		break;
	}
	return j;
}

/**
 * Swallow the list the marker at `i` opens, through its closing marker — the
 * same job `registerTableEnd` does, for the other shape a subsection's
 * register can already be in. Bounded at the next heading as well: an
 * unclosed marker would otherwise swallow the rest of §A, deleting the prose
 * and headings of every later subsection and of §Version stamps.
 * @param {string[]} lines
 * @param {number} i
 */
function registerListEnd(lines, i) {
	const stop = lines.findIndex(
		(l, n) => n > i && (l === LIST_END || /^#+ /.test(l)),
	);
	const j = stop === -1 ? lines.length : stop;
	// Land on the closing marker; stop BEFORE a heading, which belongs
	// to the output.
	return lines[j] === LIST_END ? j : j - 1;
}

/**
 * A section's rows all render into its FIRST table; a second table under the
 * same heading is swallowed and emits nothing, its rows having moved up.
 * @param {SectionARender} r accumulator: the render state, its output, rendered set and last table end advanced
 * @param {Map<string, [string, DocClassEntry][]>} pathsBySection
 * @param {string} section
 */
function renderSectionOnce(r, pathsBySection, section) {
	if (r.rendered.has(section)) return;
	r.out.push(...buildSectionBlock(pathsBySection, section));
	r.rendered.add(section);
	r.lastTableEnd = r.out.length;
}

/**
 * @param {SectionARender} r accumulator: the render state, the unrendered sections spliced into its output
 * @param {Map<string, [string, DocClassEntry][]>} pathsBySection
 */
function insertFreshSections(r, pathsBySection) {
	const fresh = [...pathsBySection.keys()]
		.filter((s) => !r.rendered.has(s))
		.sort();
	if (fresh.length > 0 && r.lastTableEnd >= 0) {
		const block = [];
		for (const s of fresh)
			block.push("", `### ${s}`, "", ...buildSectionBlock(pathsBySection, s));
		r.out.splice(r.lastTableEnd, 0, ...block);
	}
}

/** @param {string} text @returns {[string, string|null]} */
function splitAtSectionA(text) {
	const m = text.match(/^## Section A[^\n]*\n/m);
	if (!m || m.index === undefined) return [text, null];
	const at = m.index + m[0].length;
	return [text.slice(0, at), text.slice(at)];
}

/** @param {string} rest @returns {[string, string]} */
function splitAtSectionB(rest) {
	const m = rest.match(/^## Section B/m);
	if (!m || m.index === undefined) return [rest, ""];
	return [rest.slice(0, m.index), rest.slice(m.index)];
}

/** The 300-word cap on a `role` override — assertion 14's cap on a new §B
 * entry, in the same shape (mantahostels#1808 user story 18). */
const ROLE_CAP_WORDS = 300;

/** How assertion 18 counts a `role`, shared with register-doc.js's --role so
 * the two cannot disagree on a borderline override (mantahostels#3376).
 * @param {string | null | undefined} role */
function roleWordCount(role) {
	return (role || "").trim().split(/\s+/).filter(Boolean).length;
}

/**
 * The sidecar entries whose `role` override exceeds the cap, largest excess
 * first — assertion 18's worklist.
 * @param {Record<string, DocClassEntry>} sidecar
 */
function overCapRoles(sidecar) {
	return Object.entries(sidecar)
		.map(([p, e]) => ({
			path: p,
			words: roleWordCount(e?.role),
		}))
		.filter((r) => r.words > ROLE_CAP_WORDS)
		.map((r) => ({ ...r, excess: r.words - ROLE_CAP_WORDS }))
		.sort((a, b) => b.excess - a.excess);
}

/**
 * `consumes` is `null` or a non-empty array of typed references (mantahostels#2419).
 *
 * An array present but empty is refused — "no override" stays exactly one
 * state (`null`) rather than two.
 * @param {string} file
 * @param {string} id
 * @param {unknown} consumes
 */
function validateConsumes(file, id, consumes) {
	if (consumes === null || consumes === undefined) return;
	if (!Array.isArray(consumes))
		fail(
			file,
			`${id}.consumes is ${JSON.stringify(consumes)} — it takes a list of { kind, ref, gloss? } references`,
		);
	nonEmptyArray(file, `${id}.consumes`, consumes);
	consumes.forEach((el, i) => {
		const where = `${id}.consumes[${i}]`;
		onlyKeys(file, where, el, ["kind", "ref", "gloss"]);
		if (!CONSUMES_KINDS.includes(/** @type {string} */ (el.kind)))
			fail(
				file,
				`${where}.kind is ${JSON.stringify(el.kind)} — not one of ${CONSUMES_KINDS.join(", ")}`,
			);
		nonEmptyString(file, `${where}.ref`, el.ref);
		if (el.gloss !== null && el.gloss !== undefined)
			nonEmptyString(file, `${where}.gloss`, el.gloss);
	});
}

/**
 * docs/doc-map-classes.json: a key is a path or a `docs/x/*` wildcard, `class` is one of
 * the five tokens, `section` is a non-empty string, `role` and `route` are a
 * string or null, and `consumes` is a typed reference list or null. A breach is
 * BROKEN, never a quiet empty register.
 * @param {string} file
 */
function loadDocClasses(file) {
	return /** @type {Record<string, DocClassEntry>} */ (
		loadKeyed(
			file,
			(id, entry) => {
				if (!isPlainObject(entry)) fail(file, `${id} does not hold an object`);
				onlyKeys(file, id, entry, [
					"section",
					"class",
					"classQualifier",
					"role",
					"route",
					"consumes",
					"reader",
				]);
				nonEmptyString(file, `${id}.section`, entry.section);
				if (!DOC_CLASSES.includes(/** @type {string} */ (entry.class)))
					fail(
						file,
						`${id}.class is "${entry.class}" — not one of ${DOC_CLASSES.join(", ")}`,
					);
				if (
					entry.reader !== null &&
					entry.reader !== undefined &&
					!DOC_READERS.includes(/** @type {string} */ (entry.reader))
				)
					fail(
						file,
						`${id}.reader is ${JSON.stringify(entry.reader)} — not one of ${DOC_READERS.join(", ")}`,
					);
				for (const k of ["classQualifier", "role", "route"])
					if (entry[k] !== null && entry[k] !== undefined)
						nonEmptyString(file, `${id}.${k}`, entry[k]);
				validateConsumes(file, id, entry.consumes);
			},
			{
				/* Any path git can track, plus an optional trailing `*`. Wider than
				 * mantahostels#1848's `[\w./@-]+` deliberately (mantahostels#1849): coverage is asked of
				 * these keys now, so a key vocabulary narrower than git's would make
				 * `docs/café notes.md` a file no session could ever register.
				 *
				 * The leading `[^\s*]` is the part that must not be relaxed. A key of
				 * `*` alone reaches `sectionAMatcher` as an empty wildcard prefix,
				 * which every path starts with — so one such key would report the
				 * whole tree covered and take assertion 1 green over a repo nothing
				 * is registered in. Interior `*` is refused with it: only a trailing
				 * one is a wildcard here. */
				test: /^[^\s*](?:[^\n\t*]*[^\s*])?\*?$/,
				noun: "a repo-relative path or a `dir/*` wildcard",
			},
		)
	);
}

module.exports = {
	BINARY_CLASS,
	CONSUMES_KINDS,
	DATA_FILES,
	roundedSectionBWords,
	jsonStringEnd,
	inScope,
	parseRoutes,
	readMap,
	FIGURE_ID,
	idNumber,
	ROUTE_ID,
	assertDataIdsKnown,
	dataFileSelfExemption,
	loadRestatements,
	loadRetiredVocabulary,
	headingWords,
	unresolvedSectionRefs,
	needlePattern,
	valueLiterals,
	parseSupersedesText,
	parseRetiredVocabularyText,
	loadSupersededNeedles,
	loadMachineryNeedles,
	sectionAMatcher,
	citationMatcher,
	parseRegister,
	registerPaths,
	registerRowPath,
	registerRowPaths,
	CORE_CLASSES,
	coverageMatchers,
	compileAllowlist,
	validateAllowlist,
	reportAnchors,
	reportPins,
	reportWholeFile,
	resolveAllowlist,
	scanNeedles,
	parseEntries,
	scanScope,
	sectionBRange,
	mapSkipLine,
	figureHeadings,
	sectionBWords,
	sectionBEntryCount,
	sectionBEntryRate,
	PROSE_CAP_WORDS,
	overCapEntries,
	staleExemptionMarkers,
	malformedExemptionMarkers,
	readMapTextAt,
	// Consumed by check-doc-map.js's assertion 16 (mantahostels#1788) — it reads the
	// same already-committed rev list for the pool delta and for the ledger.
	readCommittedRevs,
	newOverCapEntries,
	unrecordedAdmissions,
	HIGH_WATER_MARK_REMEDY,
	parseHighWaterMark,
	readHeadHighWaterMark,
	newIdsAtOrBelowMark,
	idsRemovedSinceHead,
	grownExemptEntries,
	droppedExemptionMarkers,
	LEDGER_ENTRY_CAP_BYTES,
	shedLedgerEntries,
	overCapLedgerEntries,
	// PREDICTION_MARKER stays file-local: nothing outside compactionVerdictFaults
	// reads a prediction. VERDICT_MARKER is check-doc-map.js's, for the shape its
	// advice string tells a session to write.
	VERDICT_MARKER,
	compactionVerdictFaults,
	readSectionBBirths,
	PAIRING_GRACE_MS,
	pairingHalfAgeMs,
	repoRelative,
	readTrackedFiles,
	readUntrackedFiles,
	readConflictedPaths,
	isDirty,
	entryPresentOnDisk,
	readTextLines,
	DOC_CLASSES,
	ROLE_CAP_WORDS,
	roleWordCount,
	loadDocClasses,
	consumesFaults,
	pairScopeFaults,
	CLASSES_FILE,
	badClassEntries,
	DOC_READERS,
	isProseKey,
	badReaderEntries,
	pageSourceFaults,
	duplicateSidecarKeys,
	overCapRoles,
	renderSectionA,
	REGISTER_HEADER,
	registerListPath,
	sectionARegion,
};
