const fs = require("node:fs");
const path = require("node:path");
const {
	TRIGGER_VERDICT_MIN_WORDS,
	entryIssue: ledgerEntryIssue,
	entryLabel: ledgerEntryLabel,
} = require("./always-loaded-pool.js");
const { escapeRe, requiredGroup } = require("./regex-group.js");
const { trimEndRun } = require("./trim-run.js");
const { cutAt } = require("./cut-at.js");
const { byCodeUnit } = require("./by-code-unit.js");
const { caught, orFallback } = require("./caught.js");
const { isUnder } = require("./is-under.js");
const { execGit, gitOrNull } = require("./git.js");
const { readMergeHeadLines } = require("./merge-heads.js");
const { readCommitOrBroken } = require("./commit-sha.js");
const { brokenError } = require("./outcome-error.js");
const { siblingTests } = require("./test-kind.js");

const BACKTICKED = /`([^`]+)`/g;

/** @typedef {import("./check.js").Ctx} CheckContext */

/**
 * @typedef {{paths: string[], cls: string}} RegisterRow
 * @typedef {{id: string, heading: string, lines: string[]}} Entry
 */

const CLASS_CELL = 3;
const PATH_CELL = 1;
const BINARY_CLASS = "binary-asset";

/** @param {string} entry */
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

/** @param {string} token */
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

/** @param {string} line */
function registerRowPaths(line) {
	if (!line.startsWith("|")) return [];
	return [...(line.split("|")[PATH_CELL] || "").matchAll(BACKTICKED)]
		.map((m) => requiredGroup(m, 1, BACKTICKED).trim())
		.filter((p) => p.includes("/") || p.endsWith(".md"));
}

const LIST_BEGIN_RE = /^<!-- register-list: (.+?) -->$/;
const LIST_END = "<!-- /register-list -->";

/** @param {string} cls */
function listBegin(cls) {
	return `<!-- register-list: ${cls} -->`;
}

const LIST_PATH_RE = /^- `([^`]+)`$/;

/** @param {string} line */
function registerListPath(line) {
	const m = line.match(LIST_PATH_RE);
	if (!m) return null;
	const p = requiredGroup(m, 1, LIST_PATH_RE).trim();
	return p.includes("/") || p.endsWith(".md") ? p : null;
}

/**
 * @param {string} text
 * @param {Record<string, {class?: string, classQualifier?: string|null}>|null} [sidecar]
 * @returns {RegisterRow[]}
 */
function parseRegister(text, sidecar = null) {
	const region = sectionARegion(text);
	if (!region) return [];
	const rows = [];
	let fenced = false;
	let listClass = null;
	for (const line of region.split("\n")) {
		if (/^\s*(```|~~~)/.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
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

/** @param {string} text */
function sectionARegion(text) {
	const sectionB = text.search(/^## Section B/m);
	return (sectionB === -1 ? text : text.slice(0, sectionB)).split(
		/^## Section A/m,
	)[1];
}

/**
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

/** @param {{class?: string, classQualifier?: string|null}} entry */
function buildSidecarClassText(entry) {
	const cls = (entry.class || "").trim();
	const qualifier = (entry.classQualifier || "").trim();
	return qualifier ? `${cls} ${qualifier}` : cls;
}

/**
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

/** @param {string} text */
function registerPaths(text) {
	return [...new Set(parseRegister(text).flatMap((r) => r.paths))];
}

const CLASSES_FILE = "doc-map-classes.json";

/**
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

/** @param {RegisterRow[]} register */
function classExemptMatchers(register) {
	return register
		.filter((r) => r.cls.includes(BINARY_CLASS))
		.flatMap((r) => r.paths.map(sectionAMatcher));
}

/** @type {Readonly<Record<string, string>>} */
const CORE_CLASSES = Object.freeze({
	".claude/workflow-core.reference.md": "generated-only",
	".claude/workflow-core.glossary.md": "generated-only",
	".claude/workflow-core.doc-map.md": "generated-only",
	"docs/archive/sync-proposals/*": "free-edit",
	"docs/archive/sync-reports/*": "free-edit",
	".claude/plugin-context-cost.json": "source-of-truth",
	"docs/data/session-cost-table.json": "generated-only",
	".claude/registrations.json": "source-of-truth",
	".claude/guard-fire-needles.json": "source-of-truth",
});

/**
 * @param {string[]} sidecarKeys
 * @returns {((f: string) => boolean)[]}
 */
function coverageMatchers(sidecarKeys) {
	return [...sidecarKeys, ...Object.keys(CORE_CLASSES)].map((k) =>
		sectionAMatcher(k),
	);
}

const LOCKFILES = new Set(["package-lock.json", "skills-lock.json"]);

/** @param {string} file */
function isLockfile(file) {
	return LOCKFILES.has(path.basename(file));
}

const FROZEN_CORPORA = [
	/^scripts\/fixtures\/(?:[^/]+\/)*recorded-[^/]+\.jsonl$/,
	/^scripts\/fixtures\/gate-judge-cases\.json$/,
	/^scripts\/arm-tasks\/[^/]+\.patch$/,
];

/** @param {string} file */
function isFrozenCorpus(file) {
	return FROZEN_CORPORA.some((re) => re.test(file));
}

/**
 * @param {CheckContext} ctx
 * @param {{text: string, mapPath: string, checker: string}} spec
 */
function scanScope(ctx, { text, mapPath, checker }) {
	const register = parseRegister(text, readSidecarBeside(mapPath));
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
				!isFrozenCorpus(f) &&
				!exempt.some((m) => m(f)),
		),
		exemptCount: tracked.filter((f) => exempt.some((m) => m(f))).length,
	};
}

const FIGURE_ID = /^### (B\d+)/;
const ROUTE_ID = /^### (C\d+)/;
const ADDED_FIGURE = /^\+### (B\d+)\b/gm;

/**
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

/**
 * @param {string[]} allTracked
 */
function inScope(allTracked) {
	return allTracked.filter((f) => isUnder(f, SCOPE));
}

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

/** @param {string} text */
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

/** @param {string} text */
function sectionBEntryCount(text) {
	return figureHeadings(text.split("\n")).filter((h) => !h.stray).length;
}

// guess, lucmoseley/mantahostels#1347
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
// guess, lucmoseley/mantahostels#1347
const MIN_SPAN_DAYS = 1;

/**
 * @param {string} mapPath
 * @param {number} currentEntries
 * @returns {{ rate: number, days: number } | null}
 */
function sectionBEntryRate(mapPath, currentEntries) {
	const relPath = repoRelative(mapPath);

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
	const baseline =
		commits.find((c) => c.date.getTime() <= cutoff) ?? commits.at(-1);
	if (baseline === undefined)
		throw new Error(`git log of ${relPath} printed text but no commit`);

	const days = (now - baseline.date.getTime()) / (24 * 60 * 60 * 1000);
	if (days < MIN_SPAN_DAYS) return null;

	const oldText = gitOrNull(["show", `${baseline.sha}:${relPath}`]);
	if (oldText === null) return null;

	const oldEntries = sectionBEntryCount(oldText);
	return { rate: (currentEntries - oldEntries) / days, days };
}

const SKELETON_FIELDS = [
	"Owner",
	"Inputs",
	"Restated in",
	"Supersedes",
	"Settled at",
];

const SKELETON_LABEL = new RegExp(
	`^[-*]\\s+\\*{0,2}(?:${SKELETON_FIELDS.map(escapeRe).join("|")})\\b`,
);

const TOP_LEVEL_BULLET = /^[-*]\s/;

/** @param {string[]} lines */
function entryProseWords(lines) {
	let count = 0;
	let inSkeleton = false;
	for (const line of lines) {
		if (SKELETON_LABEL.test(line)) {
			inSkeleton = true;
			continue;
		}
		if (inSkeleton) {
			if (!line.trim()) continue;
			if (TOP_LEVEL_BULLET.test(line) || !/^\s+\S/.test(line))
				inSkeleton = false;
			else continue;
		}
		count += (line.match(/\S+/g) || []).length;
	}
	return count;
}

/** @param {string} text */
function sectionBEntryProseWords(text) {
	/** @type {Record<string, number>} */
	const out = {};
	for (const entry of parseEntries(text, FIGURE_ID))
		out[entry.id] = entryProseWords(entry.lines);
	return out;
}

// guess, lucmoseley/mantahostels#891
const PROSE_CAP_WORDS = 300;

const EXEMPTION_MARKER = /^[-*]\s+\*\*Over cap by ruling \(#(\d+)\):\*\*/;

/**
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

const EXEMPTION_MARKER_NEAR_MISS =
	/^\s*(?:[-*+]\s*)?(?:[*_]{1,3}\s*)?over[- ]cap by ruling\b/i;

/**
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

const LEDGER_STEM = "Sheds paid, most recent first";

// 432 B worst live entry measured, lucmoseley/mantahostels#2236
const LEDGER_ENTRY_CAP_BYTES = 440;

/**
 * @param {string} text
 * @returns {string[][] | null}
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
		if (!line.trim() || indent <= stemIndent) break;
		const bullet = /^\s*- /.test(line);
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

const PREDICTION_MARKER = "**Prediction";

const VERDICT_MARKER = "**Verdict";
const VERDICT_ON = /^\s+on\s+(#\d+)/;

/**
 * @param {string} text
 * @param {string} issue
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
 * @param {string[][]} entries
 * @param {string[][] | null} committed
 * @returns {{ label: string, fault: string }[]}
 */
function compactionVerdictFaults(entries, committed) {
	const newest = entries[0];
	if (committed === null) return [];
	const displaced = committed[0];
	if (newest === undefined || displaced === undefined) return [];
	const label = ledgerEntryLabel(displaced);
	if (label === ledgerEntryLabel(newest)) return [];
	const issue = ledgerEntryIssue(displaced);
	const held = new Set(committed.map(ledgerEntryLabel));
	const older = entries.slice(1);
	const compacted =
		older.find((e) => ledgerEntryLabel(e) === label) ??
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

const DEFAULT_MAP_PATH = "docs/doc-map.md";

/**
 * @param {string} rev
 * @param {string} file
 * @param {string} fallback
 * @returns {string | null}
 */
function readCommittedTextAt(rev, file, fallback) {
	for (const p of new Set([repoRelative(file), fallback])) {
		const text = orFallback(
			() =>
				execGit(["show", `${rev}:${p}`], {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}),
			null,
		);
		if (text !== null) return text;
	}
	return null;
}

/**
 * @param {string} rev
 * @param {string} mapPath
 * @returns {string | null}
 */
function readMapTextAt(rev, mapPath) {
	return readCommittedTextAt(rev, mapPath, DEFAULT_MAP_PATH);
}

/**
 * @param {string} mapPath
 * @returns {string | null}
 */
function readHeadMapText(mapPath) {
	return readMapTextAt("HEAD", mapPath);
}

/** @returns {string[]} */
function readParentRevs() {
	const sides = readMergeHeadLines().map((line) => {
		const sha = readCommitOrBroken(line);
		if (sha === null)
			throw brokenError(
				`MERGE_HEAD names ${line}, which is no commit — run \`git rev-parse --git-path MERGE_HEAD\` and read the file`,
			);
		return sha;
	});
	return ["HEAD", ...new Set(sides)];
}

/**
 * @param {string} mapPath
 * @returns {Set<string> | null}
 */
function readCommittedEntryIds(mapPath) {
	const head = readHeadMapText(mapPath);
	if (head === null) return null;
	const ids = new Set();
	for (const rev of readParentRevs()) {
		const t = rev === "HEAD" ? head : readMapTextAt(rev, mapPath);
		if (t === null) continue;
		for (const id of Object.keys(sectionBEntryProseWords(t))) ids.add(id);
	}
	return ids;
}

/**
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

const HIGH_WATER_MARK_REMEDY =
	'Write it as { "highWaterMark": <n> }, n being the number of the highest ' +
	"§B id ever removed from the map (0 where none has been).";

/**
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

/** @param {string} id */
const idNumber = (id) => Number(id.slice(1));

/** @param {string[]} ids */
const sortedByIdNumber = (ids) =>
	[...ids].sort((a, b) => idNumber(a) - idNumber(b));

/**
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

const ADMISSION_COMMENT_URL =
	/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)#issuecomment-\d+$/;

/**
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

const LOG_RECORD_SEP = "\x1e";

/**
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
			maxBuffer: 256 * 1024 * 1024,
		},
	);
	if (log === null) return null;

	const show = cachedGitShow();
	/** @param {string} rev */
	const blob = (rev) => show(`${rev}:${relPath}`);

	/** @type {{id: string, words: number, sha: string}[]} */
	const born = [];
	const seen = new Set();
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

// guess, lucmoseley/mantahostels#1785
const PAIRING_GRACE_MS = 6 * 60 * 60 * 1000;

/** @param {string} sha */
function readCommitterDateSec(sha) {
	const out = gitOrNull(["show", "-s", "--format=%ct", sha]);
	if (out === null) return null;
	const sec = Number(out.trim());
	return Number.isFinite(sec) ? sec : null;
}

/**
 * @param {number | null} sec
 * @param {number} nowMs
 */
function ageFromSec(sec, nowMs) {
	if (sec === null) return null;
	const ageMs = nowMs - sec * 1000;
	return ageMs < 0 ? null : ageMs;
}

/**
 * @param {string} target
 * @param {string} mapPath
 * @param {number} [now]
 * @returns {number | null}
 */
function pairingHalfAgeMs(target, mapPath, now = Date.now()) {
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
		const shas = shaOut.split("\n").filter(Boolean).reverse();
		const sha = shas.find((s) => isRegisterBirth(show, s, p, target));
		if (sha !== undefined) return ageFromSec(readCommitterDateSec(sha), now);
	}
	return null;
}

/**
 * @param {number} [now]
 * @returns {(target: string) => number | null}
 */
function buildFileAgeReader(now = Date.now()) {
	/** @type {Map<string, number> | undefined} */
	let oldestSec;
	return (target) => {
		oldestSec ??= readOldestTouchSecs();
		return ageFromSec(oldestSec.get(target) ?? null, now);
	};
}

/** @returns {Map<string, number>} */
function readOldestTouchSecs() {
	const out = gitOrNull([
		"log",
		"--format=%x01%ct",
		"--name-only",
		"--no-renames",
		"--diff-merges=combined",
		"--relative",
		"-z",
	]);
	/** @type {Map<string, number>} */
	const oldest = new Map();
	for (const commit of (out ?? "").split("\x01").slice(1)) {
		const [sec, ...paths] = commit.split("\0");
		for (const p of paths) {
			const name = p.replace(/^\n/, "");
			if (name !== "") oldest.set(name, Number(sec));
		}
	}
	return oldest;
}

/**
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

/** @returns {(spec: string) => string | null} */
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

/** @param {string} text */
function roundedSectionBWords(text) {
	return Math.round(sectionBWords(text) / 1000) * 1000;
}

/**
 * @param {string[]} lines
 * @param {RegExp} heading
 */
function sectionRange(lines, heading) {
	const start = lines.findIndex((l) => heading.test(l));
	if (start === -1) return null;
	const rest = lines.slice(start + 1).findIndex((l) => /^## /.test(l));
	return { start, end: rest === -1 ? lines.length : start + 1 + rest };
}

/** @param {string[]} lines */
function sectionBRange(lines) {
	return sectionRange(lines, /^## Section B/);
}

/** @param {string[]} lines */
function sectionARange(lines) {
	return sectionRange(lines, /^## Section A/);
}

/**
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

/** @param {string} p */
function repoRelative(p) {
	return path.relative(process.cwd(), path.resolve(p));
}

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
 * @param {{ quiet: boolean }} how
 * @returns {{ stage: string, path: string }[]}
 */
function readIndexEntries({ quiet }) {
	return execGit(["ls-files", "--stage", "-z"], {
		encoding: "utf8",
		...(quiet ? { stdio: ["ignore", "pipe", "ignore"] } : {}),
	})
		.split("\0")
		.filter(Boolean)
		.map((line) => {
			const tab = line.indexOf("\t");
			return { stage: line.slice(tab - 1, tab), path: line.slice(tab + 1) };
		});
}

/** @param {string | null} [root] */
function readTrackedFiles(root) {
	if (root) return walkTracked(root);
	return [...new Set(readIndexEntries({ quiet: false }).map((e) => e.path))];
}

function readUntrackedFiles() {
	try {
		return execGit(["ls-files", "--others", "--exclude-standard", "-z"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.split("\0")
			.filter(Boolean);
	} catch {
		return [];
	}
}

function readConflictedPaths() {
	try {
		return [
			...new Set(
				readIndexEntries({ quiet: true })
					.filter((e) => e.stage !== "0")
					.map((e) => e.path),
			),
		];
	} catch {
		return [];
	}
}

/** @param {string} relPath */
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

/** @param {string} entry */
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

/** @param {string} file */
function readTextLines(file) {
	try {
		const buf = fs.readFileSync(file);
		if (buf.subarray(0, 8192).includes(0)) return null;
		return buf.toString("utf8").split("\n");
	} catch {
		return null;
	}
}

/** @param {string} script */
function selfFilter(script) {
	const self = new Set([
		`scripts/${script}.js`,
		...siblingTests(`scripts/${script}`),
	]);
	return (/** @type {string} */ f) => self.has(f);
}

const ENTRY_ID = /^B\d+$/;

const SUPERSEDES_LABEL = /^\s*[-*]\s+\*\*Supersedes/i;
const BULLET = /^\s*[-*]\s/;

/** @param {string[]} lines */
function parseSupersedesText(lines) {
	return parseLabelledBulletText(lines, SUPERSEDES_LABEL) ?? "";
}

/**
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

const RETIRED_LABEL = /\*\*Retired vocabulary/i;

/** @param {string[]} lines */
function parseRetiredVocabularyText(lines) {
	return parseLabelledBulletText(lines, RETIRED_LABEL);
}

const MONEY = /~?\$\s?\d[\d,]*(?:\.\d+)?(?:\s*[–—-]\s*\$?\d[\d,]*(?:\.\d+)?)?/g;
const PERCENT =
	/~?(?=\d)(?<!\d,*)\d[\d,]*(?:\.\d+)?(?:\s*[–—-]\s*\d[\d,]*(?:\.\d+)?)?\s*%/g;

/** @param {string} span */
function valueLiterals(span) {
	return [...(span.match(MONEY) || []), ...(span.match(PERCENT) || [])].map(
		(s) => s.replace(/\s+/g, ""),
	);
}

/** @param {string} heading */
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

/** @param {string} needle */
function needlePattern(needle) {
	const body = escapeRe(needle.replace(/^~/, "")).replace(/[–—-]/g, "[–—-]");
	if (!/\d/.test(needle)) return new RegExp(`\\b${body}\\b`, "gi");
	const tail = /[a-z]$/i.test(needle) ? "\\w" : "\\d";
	return new RegExp(`(?<![\\w.,#])~?${body}(?![${tail}]|[.,]\\d)`, "gi");
}

const DATA_FILES = {
	restatements: "doc-map-restatements.json",
	supersededNeedles: "doc-map-superseded.json",
	retiredVocabulary: "doc-map-retired-vocabulary.json",
	highWater: "doc-map-high-water.json",
	restatementAllowlist: "doc-map-restatement-allowlist.json",
	admissions: "doc-map-admissions.json",
};

/** @param {string} dataDir */
function dataFileSelfExemption(dataDir) {
	return new Set(
		Object.values(DATA_FILES).map((n) => repoRelative(path.join(dataDir, n))),
	);
}

/**
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

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @typedef {{path: string, locator?: string, gloss?: string}} RestatementPath
 * @typedef {{paths: RestatementPath[], note?: string, knownIncomplete?: string}} RestatementEntry
 * @param {string} file
 * @param {{allowEmpty?: boolean}} [opts]
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

/** @typedef {string|{anchor: string, needle: string}} AllowlistAnchor */

/** @typedef {{path: string, lines?: number[], anchors?: AllowlistAnchor[]}} AllowlistRow */

/** @typedef {{text: string, needle: string|null}} CompiledAnchor */

/** @typedef {{path: string, matcher: (file: string) => boolean, lines: number[], anchors: CompiledAnchor[]}} CompiledAllowRow */

/** @typedef {{entry: string, path: string, file: string, anchor: string, needle?: string|null, lines: number[]}} AnchorNote */

/** @typedef {{entry: string, path: string, file: string, line: number, fileLines?: number, text?: string}} PinNote */

/** @typedef {{entry: string, path: string, file: string}} WholeFileNote */

/**
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
		scoped: new Map(),
		notes: [],
		pins: [],
		wholeFile: false,
		wholeFileNotes: [],
	};
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
	 * @param {string} [needle]
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
 * @typedef {object} AllowResolution
 * @property {Set<number>} allowed
 * @property {Map<number, Set<string>>} scoped
 * @property {Omit<AnchorNote, "entry">[]} notes
 * @property {Omit<PinNote, "entry">[]} pins
 * @property {boolean} wholeFile
 * @property {Omit<WholeFileNote, "entry">[]} wholeFileNotes
 */

/**
 * @typedef {object} AllowFile
 * @property {string} file
 * @property {string[]} lines
 * @property {number} eof
 * @property {((line: string) => boolean)|null|undefined} matches
 */

/**
 * @param {AllowResolution} acc
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
 * @param {AllowResolution} acc
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
 * @param {AllowResolution} acc
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
 * @typedef {{needle: string, scanned: boolean}} ScanNeedle
 * @typedef {{needles: ScanNeedle[], allowlist?: AllowlistRow[]}} NeedleEntry
 */

/**
 * @param {string} file
 * @param {string} id
 * @param {unknown} entry
 */
function validateNeedleEntry(file, id, entry) {
	if (!isPlainObject(entry)) fail(file, `${id} does not hold an object`);
	onlyKeys(file, id, entry, ["needles", "allowlist"]);
	nonEmptyArray(file, `${id}: needles`, entry.needles);
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

const MACHINERY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
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
 * @typedef {{literal?: string, stem?: string}} RetiredPhrase
 * @typedef {{phrases: RetiredPhrase[], allowlist?: AllowlistRow[]}} RetiredVocabularyEntry
 * @param {string} file
 * @param {{allowEmpty?: boolean}} [opts]
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
				if ("allowlist" in entry)
					validateAllowlist(file, id, entry.allowlist, null);
			},
			undefined,
			opts,
		)
	);
}

/**
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
	const compiled = compiledOrError(stem);
	if (typeof compiled === "string")
		fail(file, `${id}: stem \`${stem}\` will not compile — ${compiled}`);
}

/**
 * @param {string} source
 * @returns {RegExp | string}
 */
function compiledOrError(source) {
	try {
		return new RegExp(source, "i");
	} catch (e) {
		return caught(e).message;
	}
}

/** @typedef {{section: string, class: string, classQualifier?: string|null, role?: string|null, route?: string|null, consumes?: ConsumesRef[]|null, reader?: string|null}} DocClassEntry */

const CONSUMES_KINDS = ["path", "glob", "figure", "issue", "external", "note"];

/**
 * @typedef {{kind: string, ref: string, gloss?: string|null}} ConsumesRef
 */

const DOC_CLASSES = [
	"source-of-truth",
	"derived",
	"generated-only",
	"free-edit",
	"binary-asset",
];

const DOC_READERS = ["agent", "human", "both"];

const isProseKey = (/** @type {string} */ key) => /\.(md|html)$/.test(key);

/** @param {Record<string, unknown>} parsed */
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

/** @param {Record<string, unknown>} parsed */
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

/** @param {Record<string, unknown>} parsed */
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

/** @param {string} text */
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
 * @param {string} text
 * @param {number} i
 */
function jsonStringEnd(text, i) {
	let j = i + 1;
	while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
	return Math.min(j, text.length);
}

/**
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
 * @param {string} text
 * @param {number} k
 */
function skipJsonSpace(text, k) {
	let at = k;
	while (at < text.length && /\s/.test(text.charAt(at))) at++;
	return at;
}

/** @param {string} text */
function duplicateSidecarKeys(text) {
	const seen = new Set();
	const dupes = [];
	for (const key of jsonTopLevelKeys(text)) {
		if (seen.has(key)) dupes.push(key);
		else seen.add(key);
	}
	return [...new Set(dupes)];
}

/** @type {Record<string, string>} */
const CLASS_ROUTE = {
	"source-of-truth": "Direct",
	derived: "Regenerate only",
	"generated-only": "That skill only",
	"free-edit": "Direct",
	"binary-asset": "Replace the file",
};

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

/** @param {string} p */
function buildPathTitle(p) {
	const cut = p.lastIndexOf("/");
	let base = p.slice(cut + 1);
	if (/^(SKILL|README|AGENTS)\.md$/.test(base) && cut !== -1) {
		const dir = p.slice(0, cut);
		base = dir.slice(dir.lastIndexOf("/") + 1);
	}
	if (base === ".gitkeep") return "Directory placeholder";
	const stem = base.replace(/\.[^.]+$/, "");
	if (/^[A-Z0-9]+$/.test(stem)) return base;
	const opened = stem.replace(/[-_]+/g, " ");
	return opened.charAt(0).toUpperCase() + opened.slice(1);
}

/** @param {string} p */
function pathKind(p) {
	const dir = Object.keys(KIND_BY_DIR)
		.filter((d) => p.startsWith(d))
		.sort((a, b) => b.length - a.length)[0];
	if (dir) return KIND_BY_DIR[dir];
	const ext = p.match(/\.[^./]+$/);
	return (ext && KIND_BY_EXT[ext[0]]) || null;
}

/** @param {string} p */
function renderRole(p) {
	if (p.endsWith("/.gitkeep")) return "Directory placeholder";
	const kind = pathKind(p);
	if (p.endsWith("*")) {
		const prefix = wildcardPrefix(p);
		return `Every file under \`${prefix}\`${kind ? ` — ${kind}s` : ""}`;
	}
	return kind ? `${buildPathTitle(p)} — ${kind}` : buildPathTitle(p);
}

/** @param {string} s */
function escapeCell(s) {
	return s.replace(/[\\|]/g, "\\$&");
}

/** @param {ConsumesRef} r */
function renderConsumesRef(r) {
	let ref = `\`${r.ref}\``;
	if (r.kind === "figure") ref = `§${r.ref}`;
	else if (r.kind === "issue") ref = `#${r.ref}`;
	return r.gloss ? `${ref} (${r.gloss})` : ref;
}

/** @param {ConsumesRef[]|null|undefined} consumes */
function renderConsumes(consumes) {
	if (!consumes) return "—";
	return consumes.map(renderConsumesRef).join(" · ");
}

/** @param {string|undefined} gloss */
function pairScopePrefix(gloss) {
	if (typeof gloss !== "string") return null;
	const m = /^with (§B\d+|#\d+|`[^`]+`): /.exec(gloss);
	return m ? m[1] : null;
}

/**
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
 * @param {unknown} el
 * @param {number} i
 * @param {unknown[]} consumes
 * @returns {{ ref: string, why: string } | null}
 */
function pairScopeFault(el, i, consumes) {
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

/** @param {unknown} prev */
function printedConsumesRef(prev) {
	return isPlainObject(prev)
		? renderConsumesRef(
				/** @type {ConsumesRef} */ ({ kind: prev.kind, ref: prev.ref }),
			)
		: JSON.stringify(prev);
}

/** @typedef {{doc: string, ref: string, why: string, shape?: boolean}} ConsumesFault */

/**
 * @param {Record<string, unknown>} parsed
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
 * @param {string} doc
 * @param {unknown[]} consumes
 * @param {Parameters<typeof consumesFaults>[1]} world
 * @param {{ dead: ConsumesFault[], untracked: ConsumesFault[] }} into
 */
function listFaults(doc, consumes, world, into) {
	for (const el of consumes) {
		const found = consumesRefFault(doc, el, world);
		if (found) (found.untracked ? into.untracked : into.dead).push(found.fault);
	}
}

/**
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
 * @param {string} doc
 * @param {string} ref
 * @returns {ConsumesFault}
 */
function deadFigureFault(doc, ref) {
	return { doc, ref, why: `§${ref} heads no Section B entry` };
}

/**
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

const REGISTER_HEADER = "| Path | Role | Class | Update route | Consumes |";
const REGISTER_SEPARATOR = "|---|---|---|---|---|";

const SECTION_REF = /(?<![\w/:.-])(?:docs\/)?doc-map\.md`?[ \t]*§([^\n]*)/g;

/**
 * @typedef {{ preamble: boolean, count: number, numbered: Set<string> }} SectionName
 */

const NAMED_HEADING =
	/^(#{2,6}) ((?:[^\S\n\r\u2028\u2029]*\S)+|[^\n\r\u2028\u2029])\s*$/;
const SECTION_LETTER = /^Section ([A-Z])\b/;
const SUB_NUMBER = /^(\d+)\./;
const SUB_REF = /^(?:'s)?\s*§(\d+)\b/;

/**
 * @param {string} text
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
 * @param {Map<string, SectionName>} names
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

/** @param {string} rest */
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

const LIST_SECTIONS = new Set(["Research runs"]);

const SUBSECTION_HEADING =
	/^### ((?:[^\S\n\r\u2028\u2029]*\S)+|[^\n\r\u2028\u2029])\s*$/;

/** @param {string} line */
function subsectionHeading(line) {
	const m = line.match(SUBSECTION_HEADING);
	return m ? requiredGroup(m, 1, SUBSECTION_HEADING) : null;
}

/**
 * @param {string} text
 * @param {Record<string, DocClassEntry>} sidecar
 * @returns {string}
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

	insertFreshSections(r, pathsBySection);

	return head + r.out.join("\n") + tail;
}

/** @typedef {{ out: string[], rendered: Set<string>, lastTableEnd: number }} SectionARender */

/** @param {Record<string, DocClassEntry>} sidecar */
function entriesBySection(sidecar) {
	/** @type {Map<string, [string, DocClassEntry][]>} */
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

/**
 * @param {Map<string, [string, DocClassEntry][]>} pathsBySection
 * @param {string} name
 */
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
 * @param {string[]} lines
 * @param {number} i
 */
function registerListEnd(lines, i) {
	const stop = lines.findIndex(
		(l, n) => n > i && (l === LIST_END || /^#+ /.test(l)),
	);
	const j = stop === -1 ? lines.length : stop;
	return lines[j] === LIST_END ? j : j - 1;
}

/**
 * @param {SectionARender} r
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
 * @param {SectionARender} r
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

// guess, lucmoseley/mantahostels#1808
const ROLE_CAP_WORDS = 300;

/** @param {string | null | undefined} role */
function roleWordCount(role) {
	return (role || "").trim().split(/\s+/).filter(Boolean).length;
}

/** @param {Record<string, DocClassEntry>} sidecar */
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

/** @param {string} file */
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
	readParentRevs,
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
	VERDICT_MARKER,
	compactionVerdictFaults,
	readSectionBBirths,
	PAIRING_GRACE_MS,
	buildFileAgeReader,
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
