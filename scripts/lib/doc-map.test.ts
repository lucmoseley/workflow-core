// @vitest-environment node
/*
 * The parsers the doc-map checkers read docs/doc-map.md with.
 *
 * One shared module, so per-checker copies cannot drift apart
 * (mantahostels#239; the section-reference check, #805).
 *
 * Every case reads a synthetic map and sidecar (doc-map-testkit) or a
 * throwaway repo, never this repo's own docs/doc-map.md, which every
 * registration edits.
 *
 * check-doc-map.js is a hard CI gate, so loosening a test here loosens CI.
 * It gates .husky/pre-commit too, so a parser bug can also refuse a sound commit.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	REGISTER_SEP,
	syntheticPaths,
	syntheticSidecar,
	writeSidecar,
} from "./doc-map-testkit";

const {
	CLASSES_FILE,
	DOC_CLASSES,
	DATA_FILES,
	badClassEntries,
	citationMatcher,
	compileAllowlist,
	readConflictedPaths,
	coverageMatchers,
	loadRestatements,
	loadRetiredVocabulary,
	loadSupersededNeedles,
	overCapEntries,
	malformedExemptionMarkers,
	staleExemptionMarkers,
	parseEntries,
	parseRegister,
	duplicateSidecarKeys,
	unresolvedSectionRefs,
	PROSE_CAP_WORDS,
	readTextLines,
	registerPaths,
	registerRowPath,
	repoRelative,
	resolveAllowlist,
	mapSkipLine,
	needlePattern,
	scanScope,
	parseSupersedesText,
	parseRetiredVocabularyText,
	sectionAMatcher,
	sectionBEntryCount,
	sectionBEntryRate,
	readSectionBBirths,
	newOverCapEntries,
	grownExemptEntries,
	droppedExemptionMarkers,
	readTrackedFiles,
	PAIRING_GRACE_MS,
	pairingHalfAgeMs,
	loadDocClasses,
	overCapRoles,
	pairScopeFaults,
	renderSectionA,
	ROLE_CAP_WORDS,
	REGISTER_HEADER,
	registerListPath,
} = require("./doc-map");

afterEach(() => {
	vi.restoreAllMocks();
});

/*
 * A Section A row decides what a scan SKIPS, so a loose match there silently
 * shrinks the scan; a §B allowlist path only suppresses a report its author
 * asked to suppress.
 */
describe("the two matchers are not interchangeable", () => {
	it("exempts only the Section A path itself, never a file ending in it", () => {
		expect(sectionAMatcher("CLAUDE.md")("CLAUDE.md")).toBe(true);
		expect(sectionAMatcher("CLAUDE.md")("vendor/x/CLAUDE.md")).toBe(false);
	});

	it("matches an allowlist path written as a bare filename", () => {
		expect(citationMatcher("brand-sheet.md")("docs/notes/brand-sheet.md")).toBe(
			true,
		);
	});

	it("answers opposite ways on the same token", () => {
		const token = "notes.md";
		const file = "docs/notes.md";
		expect(sectionAMatcher(token)(file)).toBe(false);
		expect(citationMatcher(token)(file)).toBe(true);
	});
});

describe("sectionAMatcher", () => {
	it("covers a directory from a trailing /* or /** entry", () => {
		expect(sectionAMatcher("docs/research/*")("docs/research/a.md")).toBe(true);
		expect(sectionAMatcher("docs/research/**")("docs/research/n/b.md")).toBe(
			true,
		);
		expect(sectionAMatcher("docs/research/*")("docs/other.md")).toBe(false);
	});

	it("covers a filename prefix from a bare * entry", () => {
		expect(sectionAMatcher("docs/adr-*")("docs/adr-0001.md")).toBe(true);
		expect(sectionAMatcher("docs/adr-*")("docs/notes.md")).toBe(false);
	});

	// A literal entry is an exact path, not a prefix, or docs/notes.md would
	// vouch for a docs/notes.md.bak nobody registered.
	it("does not let a literal entry cover a longer path sharing its prefix", () => {
		expect(sectionAMatcher("docs/notes.md")("docs/notes.md.bak")).toBe(false);
	});
});

describe("citationMatcher", () => {
	// Whole-segment, or `notes.md` would claim `release-notes.md`.
	it("matches on a segment boundary, not mid-segment", () => {
		expect(citationMatcher("notes.md")("docs/release-notes.md")).toBe(false);
		expect(citationMatcher("notes.md")("docs/notes.md")).toBe(true);
	});

	it("matches everything under a directory token", () => {
		expect(citationMatcher("docs/adr/")("docs/adr/0001.md")).toBe(true);
		expect(citationMatcher("adr/")("docs/adr/0001.md")).toBe(true);
	});

	it("treats a trailing * as a directory token", () => {
		expect(citationMatcher("docs/research/*")("docs/research/a.md")).toBe(true);
	});

	// The ambiguity the pin below exists to break (mantahostels#2699), not an endorsement of it.
	it("without a pin, a root-level filename also matches its subdirectory namesake", () => {
		expect(citationMatcher("vitest.config.ts")("vitest.config.ts")).toBe(true);
		expect(
			citationMatcher("vitest.config.ts")("scripts/census/vitest.config.ts"),
		).toBe(true);
	});

	it("a leading ./ pins the token to that exact path only (mantahostels#2699)", () => {
		expect(citationMatcher("./vitest.config.ts")("vitest.config.ts")).toBe(
			true,
		);
		expect(
			citationMatcher("./vitest.config.ts")("scripts/census/vitest.config.ts"),
		).toBe(false);
	});
});

describe("parseRegister", () => {
	const map = [
		"# Doc map",
		"",
		"## Authority classes",
		"",
		"| Class | Meaning |",
		"| `source-of-truth` | owns facts |",
		"",
		"## Section A — document register",
		"",
		"| Path | Role | Class | Update route |",
		"|---|---|---|---|",
		"| `docs/a.md` | a doc | `free-edit` | Direct |",
		"| `docs/b.md`, `docs/c.md` | docs | `binary-asset` | Replace |",
		"| `generated-only` | a class, not a path | `n/a` | — |",
		"| `docs/d.md` | derived from `docs/a.md` | `derived` | Regenerate |",
		"",
		"## Section B — figure registry",
		"",
		"| `docs/phantom.md` | quoted in prose | `free-edit` | Direct |",
	].join("\n");

	it("reads each row's paths and its class cell", () => {
		expect(parseRegister(map)).toEqual([
			{ paths: ["docs/a.md"], cls: "`free-edit`" },
			{ paths: ["docs/b.md", "docs/c.md"], cls: "`binary-asset`" },
			{ paths: ["docs/d.md"], cls: "`derived`" },
		]);
	});

	// The classes table sits above Section A and is a markdown table too.
	it("ignores tables outside Section A", () => {
		expect(registerPaths(map)).not.toContain("docs/phantom.md");
		expect(registerPaths(map)).not.toContain("source-of-truth");
	});

	// A path named in the second cell is a dependency, not a registration.
	it("reads only the first cell of a row", () => {
		expect(
			registerPaths(map).filter((p: string) => p === "docs/a.md"),
		).toHaveLength(1);
	});

	// §A's prose quotes register rows to explain their shape, and
	// lib/doc-map-regions.js skips fenced lines when it cuts a region per row. A
	// row read here but not there is a document the checkers register and the
	// arbiter has no lock for, whose writer then claims the whole file (mantahostels#1402).
	it("ignores a row quoted inside a fence, as the region parser does", () => {
		const fenced = [
			"## Section A — document register",
			"",
			"A row looks like this:",
			"",
			"```",
			"| `docs/example.md` | Role | `source-of-truth` | Direct |",
			"```",
			"",
			"| `docs/real.md` | Role | `source-of-truth` | Direct |",
			"",
		].join("\n");
		expect(registerPaths(fenced)).toEqual(["docs/real.md"]);
	});

	it("returns no rows where there is no Section A heading", () => {
		expect(parseRegister("# Doc map\n\n| `docs/a.md` | x | `y` |\n")).toEqual(
			[],
		);
	});
});

describe("registerRowPath", () => {
	const registered = new Set(["docs/a.md", "AGENTS.md"]);

	it("takes the path from the first cell", () => {
		expect(
			registerRowPath(
				"| `docs/a.md` | a doc | `derived` | Direct | `AGENTS.md` |",
				registered,
			),
		).toBe("docs/a.md");
	});

	it("is null on a line that is not a table row", () => {
		expect(registerRowPath("Prose citing `docs/a.md`.", registered)).toBeNull();
	});

	it("is null where the first cell names nothing registered", () => {
		expect(
			registerRowPath("| `docs/gone.md` | a doc |", registered),
		).toBeNull();
	});

	it("ignores a registered path cited in a later cell", () => {
		expect(
			registerRowPath(
				"| `derived` | a class, not a doc | `docs/a.md` |",
				registered,
			),
		).toBeNull();
	});

	it("is null on prose that merely contains a pipe", () => {
		expect(
			registerRowPath("Prose with a | pipe, citing `docs/a.md`.", registered),
		).toBeNull();
	});

	it("does not read the section it sits in — that is the caller's gate", () => {
		expect(registerRowPath("| `AGENTS.md` | anywhere |", registered)).toBe(
			"AGENTS.md",
		);
	});
});

/** A map whose §A holds `rows` as one register table, then a bare §B. */
const buildSectionAText = (rows: string[]) =>
	["## Section A — document register", "", ...rows, "", "## Section B"].join(
		"\n",
	);

/**
 * `scanScope`'s `{ files, exemptCount }` for a map reading `text`, run in a
 * throwaway repo tracking `files` — scope is `git ls-files` in the cwd — with
 * `sidecar`, where given, written untracked at docs/doc-map-classes.json.
 */
const scopeIn = (opts: {
	text: string;
	files: string[];
	sidecar?: Record<string, unknown>;
	mapPath?: string;
	checker?: string;
}) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scan-scope-"));
	try {
		const git = (...args: string[]) =>
			execFileSync("git", args, { cwd: dir, encoding: "utf8" });
		git("init", "-q", "-b", "main", ".");
		for (const rel of opts.files) {
			fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
			fs.writeFileSync(path.join(dir, rel), "{}\n");
		}
		git("add", "-A");
		if (opts.sidecar) {
			fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
			writeSidecar(path.join(dir, "docs", CLASSES_FILE), opts.sidecar);
		}
		const out = execFileSync(
			process.execPath,
			[
				"-e",
				`const { scanScope } = require(${JSON.stringify(path.join(__dirname, "doc-map.js"))});
const ctx = { broken: (m) => { throw new Error(m); } };
const r = scanScope(ctx, { text: ${JSON.stringify(opts.text)}, mapPath: ${JSON.stringify(opts.mapPath ?? "docs/doc-map.md")}, checker: ${JSON.stringify(opts.checker ?? "none")} });
process.stdout.write(JSON.stringify(r));`,
			],
			{ cwd: dir, encoding: "utf8" },
		);
		return JSON.parse(out) as { files: string[]; exemptCount: number };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
};

describe("scanScope's class exemptions", () => {
	it("exempts the binary class and nothing else", () => {
		const { files, exemptCount } = scopeIn({
			text: buildSectionAText([
				"| `docs/notes.md` | notes | `free-edit` | Direct |",
				"| `docs/logo.svg` | a logo | `binary-asset` | Replace |",
				"| `docs/live.md` | a doc | `source-of-truth` | Direct |",
			]),
			files: ["docs/notes.md", "docs/logo.svg", "docs/live.md"],
		});
		expect(files).toEqual(["docs/live.md", "docs/notes.md"]);
		expect(exemptCount).toBe(1);
	});

	it("exempts by exact path, not by suffix", () => {
		const { files } = scopeIn({
			text: buildSectionAText([
				"| `CLAUDE.md` | a contract | `binary-asset` | Replace |",
			]),
			files: ["CLAUDE.md", "v/CLAUDE.md"],
		});
		expect(files).toEqual(["v/CLAUDE.md"]);
	});
});

/*
 * `scanScope` keeps its signature — the sidecar reaches it through
 * `parseRegister`'s second argument — so the guarantee worth pinning is that
 * no `binary-asset` file changes what a
 * class-aware scan says about it.
 */
describe("the class sidecar as parseRegister's class source", () => {
	/** The tracked files `scanScope` drops as class-exempt from a map reading `text`. */
	const exemptSet = (
		text: string,
		files: string[],
		sidecar?: Record<string, unknown>,
	) => {
		const scanned = new Set(scopeIn({ text, files, sidecar }).files);
		return new Set(files.filter((f) => !scanned.has(f)));
	};

	it("names the same file the repo-relative SIDECAR_PATH does", () => {
		const regions = fs.readFileSync("scripts/lib/doc-map-regions.js", "utf8");
		expect(regions).toContain(`SIDECAR_PATH = "docs/${CLASSES_FILE}"`);
	});

	it("takes a row's class from the key its first path holds", () => {
		const map = [
			"## Section A",
			"",
			"| `docs/a.md` | a doc | `free-edit` | Direct |",
			"",
			"## Section B",
		].join("\n");
		const [rowFromSidecar] = parseRegister(map, {
			"docs/a.md": { class: "binary-asset", classQualifier: null },
		});
		expect(rowFromSidecar.cls).toBe("binary-asset");
		expect(parseRegister(map)[0].cls).toBe("`free-edit`");
	});

	it("keeps a row's own cell where the sidecar does not key it", () => {
		const map = [
			"## Section A",
			"",
			"| `docs/a.md` | a doc | `free-edit` | Direct |",
			"",
			"## Section B",
		].join("\n");
		expect(parseRegister(map, { "docs/b.md": { class: "derived" } })[0].cls) //
			.toBe("`free-edit`");
	});

	it("carries a qualifier through, so `includes` still answers the same", () => {
		const map = buildSectionAText([
			"| `docs/a.md` | a doc | `free-edit` | Direct |",
		]);
		expect(
			parseRegister(map, {
				"docs/a.md": {
					class: "source-of-truth",
					classQualifier: "\u00b7 consumer",
				},
			})[0].cls,
		).toBe("source-of-truth \u00b7 consumer");
	});

	/* The census of which files this misses moves as §A prose changes, so this
	 * pins the safety guarantee scanScope actually depends on: the sidecar route
	 * is never less exempting than the markdown route. The register and the
	 * tracked tree are a throwaway repo's. One row is exempt by its
	 * markdown Class cell alone (unkeyed in the sidecar, so the sidecar route
	 * falls back to that same cell); a second is NOT exempt on its markdown cell
	 * but IS exempt once the sidecar keys it — the widening the property allows. */
	it("exempts every file the markdown route did", () => {
		const [exemptByMarkdown, widenedBySidecar] = syntheticPaths(2);
		const map = [
			"## Section A",
			"",
			`| \`${exemptByMarkdown}\` | notes | \`binary-asset\` | Direct |`,
			`| \`${widenedBySidecar}\` | notes | \`free-edit\` | Direct |`,
			"",
			"## Section B",
		].join("\n");
		const sidecar = {
			[widenedBySidecar]: {
				class: "binary-asset",
				classQualifier: null,
			},
		};
		const files = [exemptByMarkdown, widenedBySidecar];
		const fromMarkdown = exemptSet(map, files);
		const fromSidecar = exemptSet(map, files, sidecar);
		expect(fromMarkdown.has(exemptByMarkdown)).toBe(true);
		expect(fromSidecar.has(widenedBySidecar)).toBe(true);
		for (const f of fromMarkdown) expect(fromSidecar.has(f)).toBe(true);
	});

	/* The mis-parse itself, pinned against a fixture rather than the live map,
	 * so it survives docs/doc-map.md's prose changing shape either way: an
	 * escaped `\|` in the Role cell shifts what a naive `line.split("|")` reads
	 * as the Class cell, so a binary-asset row reads as some other
	 * class entirely and a class-aware scan stops exempting it. */
	it("misreads the Class cell of a row whose Role prose holds an escaped `\\|`", () => {
		const map = [
			"## Section A",
			"",
			"| `docs/a.md` | Role text with an escaped \\| pipe | `binary-asset` | Direct |",
			"",
			"## Section B",
		].join("\n");
		expect(parseRegister(map)[0].cls).not.toBe("`binary-asset`");
	});

	/* The same two candidates check-doc-map.js resolves, in the same order, so a
	 * run handed an out-of-repo copy of the map reads one sidecar and not two.
	 * The second candidate is the literal, cwd-relative
	 * `docs/doc-map-classes.json`, so the throwaway repo carries a synthetic one
	 * there and the map path names a directory holding none. Every keyed path
	 * leaving scope proves the whole sidecar was read; the run without it is the
	 * control, scanning them all. */
	it("falls back to the tracked sidecar where none sits beside the map", () => {
		const paths = syntheticPaths(3);
		const text = buildSectionAText([
			"| `docs/logo.svg` | a logo | `binary-asset` | Replace |",
			...paths.map((p) => `| \`${p}\` | notes | \`free-edit\` | Direct |`),
		]);
		const sidecar = syntheticSidecar(paths, () => ({
			class: "binary-asset",
			classQualifier: null,
		}));
		const mapPath = "elsewhere/doc-map.md";
		expect(scopeIn({ text, files: paths, mapPath }).files).toEqual(paths);
		const { files, exemptCount } = scopeIn({
			text,
			files: paths,
			sidecar,
			mapPath,
		});
		expect(files).toEqual([]);
		expect(exemptCount).toBe(paths.length);
	});
});

describe("loadDocClasses's key vocabulary", () => {
	const made: string[] = [];
	afterEach(() => {
		for (const dir of made.splice(0))
			fs.rmSync(dir, { recursive: true, force: true });
	});
	const write = (data: unknown) => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-classes-"));
		made.push(dir);
		const file = path.join(dir, "doc-map-classes.json");
		fs.writeFileSync(file, JSON.stringify(data));
		return file;
	};
	const entry = { section: "Docs", class: "source-of-truth" };

	it("takes a path git can track, spaces and accents included", () => {
		expect(
			Object.keys(loadDocClasses(write({ "docs/caf\u00e9 notes.md": entry }))),
		).toEqual(["docs/caf\u00e9 notes.md"]);
	});

	it("refuses a reader outside the three tokens, quoting it and listing them (mantahostels#3412)", () => {
		expect(() =>
			loadDocClasses(write({ "docs/a.md": { ...entry, reader: "humans" } })),
		).toThrow(/reader is "humans" — not one of agent, human, both/);
	});

	it("takes one trailing `*` as a wildcard", () => {
		expect(Object.keys(loadDocClasses(write({ "docs/adr/*": entry })))) //
			.toEqual(["docs/adr/*"]);
	});

	/* A bare `*` reaches sectionAMatcher as an empty wildcard prefix, which every
	 * path starts with — one such key would report the whole tree covered and
	 * take check-doc-map.js's assertion 1 green over an unregistered repo. */
	it("refuses a key that is a wildcard and nothing else", () => {
		for (const key of ["*", "**"])
			expect(() => loadDocClasses(write({ [key]: entry }))).toThrow(
				/not a repo-relative path/,
			);
	});

	it("refuses an interior `*`, which is no wildcard here", () => {
		expect(() => loadDocClasses(write({ "docs/*/notes.md": entry }))).toThrow();
	});

	it("refuses a key padded with whitespace at either end", () => {
		for (const key of [" docs/a.md", "docs/a.md ", ""])
			expect(() => loadDocClasses(write({ [key]: entry }))).toThrow();
	});
});

describe("duplicateSidecarKeys", () => {
	it("names a key the bytes carry twice, which JSON.parse hides", () => {
		expect(duplicateSidecarKeys('{"a": 1, "b": 2, "a": 3}')).toEqual(["a"]);
	});

	it("says nothing about a nested key, or one quoted inside a value", () => {
		expect(
			duplicateSidecarKeys('{"a": {"b": 1, "c": 2}, "d": "{\\"a\\": 9}"}'),
		).toEqual([]);
	});

	it("counts a key repeated three times once", () => {
		expect(duplicateSidecarKeys('{"a":1,"a":2,"a":3}')).toEqual(["a"]);
	});

	it("finds none in a well-formed sidecar", () => {
		expect(duplicateSidecarKeys(JSON.stringify(oneOfEachClass()))).toEqual([]);
	});
});

/** A sidecar holding one entry of each of the five classes. */
const oneOfEachClass = () =>
	syntheticSidecar(syntheticPaths(DOC_CLASSES.length), (_, i) => ({
		class: DOC_CLASSES[i],
	}));

describe("badClassEntries", () => {
	it("names an entry whose class is outside the five tokens", () => {
		expect(
			badClassEntries({
				"docs/a.md": { class: "stable" },
				"docs/b.md": { class: "derived" },
			}),
		).toEqual([{ path: "docs/a.md", cls: "stable" }]);
	});

	it("names an entry that is not an object at all", () => {
		expect(badClassEntries({ "docs/a.md": null })).toEqual([
			{ path: "docs/a.md", cls: "no object" },
		]);
	});

	it("accepts every one of the five, together as well as alone", () => {
		for (const cls of DOC_CLASSES)
			expect(badClassEntries({ "docs/a.md": { class: cls } })).toEqual([]);
		expect(badClassEntries(oneOfEachClass())).toEqual([]);
	});
});

describe("parseEntries", () => {
	const doc = [
		"### B1 · the take rate",
		"- **Owner:** `docs/a.md`",
		"",
		"### B2 · the AOV",
		"- **Supersedes:** **an earlier figure**",
		"#### a sub-heading ends the entry",
		"stray prose",
		"### C1 · a route",
		"- **Read:** `docs/a.md`",
	].join("\n");

	it("reads id, heading line and body, in document order", () => {
		const figures = parseEntries(doc, /^### (B\d+)/);
		expect(figures.map((f: { id: string }) => f.id)).toEqual(["B1", "B2"]);
		expect(figures[0].heading).toBe("### B1 · the take rate");
		expect(figures[0].lines).toEqual(["- **Owner:** `docs/a.md`", ""]);
	});

	// A heading of any depth closes an entry, or B2 would swallow the route.
	it("stops an entry at the next heading of any depth", () => {
		const [, b2] = parseEntries(doc, /^### (B\d+)/);
		expect(b2.lines).toEqual(["- **Supersedes:** **an earlier figure**"]);
	});

	it("selects a registry by its id prefix", () => {
		expect(parseEntries(doc, /^### (C\d+)/).map((r: { id: string }) => r.id)) //
			.toEqual(["C1"]);
	});
});

/** `n` distinct prose words — one per bullet line's worth, joined on one line. */
const words = (n: number) =>
	Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

/*
 * No test pins a figure measured against the live `docs/doc-map.md`: §B moves
 * on nearly every doc-map commit, so one would fail within the day for reasons
 * that are not a regression. Fixtures with hand-counted expectations instead.
 * mantahostels#1317 asked for corpus figures; why they were refused, and the four readings
 * measured, are in its captured-fact comment.
 */
describe("an entry's prose count, as overCapEntries reads it", () => {
	/** `lines`' prose words as `overCapEntries` counts them, the entry padded just over the cap. */
	const proseWords = (lines: string[]) => {
		const pad = PROSE_CAP_WORDS + 1;
		const [entry] = overCapEntries(
			[
				"## Section B",
				"",
				"### B1 · probe",
				"",
				words(pad),
				...lines,
				"",
				"## Section C",
			].join("\n"),
		);
		return entry.words - pad;
	};

	it("counts a skeleton-only entry as zero prose", () => {
		const lines = [
			"- **Owner:** `docs/a.md`",
			"- **Inputs:** x plus y",
			"- **Restated in:** 2 paths, in `docs/doc-map-restatements.json`.",
			"- **Supersedes:** an earlier figure of three words",
			"- **Settled at #55**",
		];
		expect(proseWords(lines)).toBe(0);
	});

	it("drops a skeleton bullet's indented continuation lines too", () => {
		const lines = [
			"- **Owner:** `docs/a.md` — a long owner line that wraps onto",
			"  a continuation the entry indents under the bullet",
			words(4),
		];
		expect(proseWords(lines)).toBe(4);
	});

	it("counts a plain, unbolded skeleton leader the same as a bold one", () => {
		expect(proseWords(["- Owner: `docs/a.md` plain not bold"])).toBe(0);
	});

	it("counts a non-skeleton bullet — Downstream, a warning marker — as prose", () => {
		const lines = ["- **Downstream (must re-derive):**", words(3)];
		// "- **Downstream (must re-derive):**" is itself 4 whitespace-delimited
		// tokens, plus the 3 words appended.
		expect(proseWords(lines)).toBe(7);
	});

	it("resumes counting once a skeleton bullet's continuation ends", () => {
		const lines = [
			"- **Settled at #55**, with a continuation line",
			"  still indented under the settled-at bullet",
			"- prose bullet right after, three words",
		];
		// The whole "Settled at" bullet and its continuation are skipped; only
		// the 7-token bullet after it counts.
		expect(proseWords(lines)).toBe(7);
	});

	// The live shape this protects (mantahostels#1317): an entry nests an indented sub-bullet
	// under `Restated in`, which is skeleton, not prose.
	it("keeps a skeleton bullet's own indented sub-bullets out of prose (mantahostels#1317)", () => {
		const lines = [
			"- **Restated in — 7 paths, in `docs/doc-map-restatements.json`.**",
			"  - `partner-pipeline` (#88) restates the predicate and the gaps",
			"  - a second nested sub-bullet, also skeleton continuation",
		];
		expect(proseWords(lines)).toBe(0);
	});

	// Positive case: a nested sub-bullet under a *prose* bullet still counts.
	it("still counts an indented sub-bullet nested under a prose bullet", () => {
		const lines = [
			"- **Downstream (must re-derive):**",
			"  - a nested sub-bullet under prose, three words",
		];
		expect(proseWords(lines)).toBe(12);
	});

	// Skeleton is the five fields as an ENTRY'S OWN bullet leaders; an indented
	// sub-bullet under a prose bullet that merely opens on one of those words is
	// prose, and matching it would drop it and every line indented under it
	// (mantahostels#1317).
	it("counts an indented sub-bullet opening on a skeleton field word as prose", () => {
		const lines = [
			"- **Downstream (must re-derive):**",
			"  - Owner of the partner fee re-derives from this figure",
			"    a continuation of that prose sub-bullet",
		];
		// 4 tokens in the Downstream leader + 10 + 6.
		expect(proseWords(lines)).toBe(20);
	});

	// CommonMark keeps a list item open across a blank line, so an indented
	// continuation resuming after one is still the skeleton bullet's own value
	// (mantahostels#1317).
	it("keeps a skeleton bullet's continuation across a blank line out of prose", () => {
		const lines = [
			"- **Restated in:** 3 paths, in `docs/doc-map-restatements.json`.",
			"",
			"  - `partner-pipeline` (#88), still this bullet's own value",
			"",
			words(6),
		];
		expect(proseWords(lines)).toBe(6);
	});

	// The blank line only holds the run open while what follows stays
	// indented: a dedent to top level after one still ends the skeleton, or
	// every entry would count as zero prose from its first skeleton bullet on.
	it("ends a skeleton bullet at a top-level line following a blank", () => {
		const lines = ["- **Settled at #55**", "", words(5)];
		expect(proseWords(lines)).toBe(5);
	});
});

describe("overCapEntries", () => {
	const doc = (b1Words: number, b2Words: number) =>
		[
			"## Section B",
			"",
			"### B1 · small",
			"",
			"- **Owner:** x",
			words(b1Words),
			"",
			"### B2 · big",
			"",
			"- **Owner:** x",
			words(b2Words),
			"",
			"## Section C",
		].join("\n");

	it("returns nothing over cap when every entry is under it", () => {
		expect(overCapEntries(doc(3, 5))).toEqual([]);
	});

	it("lists only the entries over cap, largest excess first", () => {
		const text = doc(PROSE_CAP_WORDS + 10, PROSE_CAP_WORDS + 200);
		expect(overCapEntries(text)).toEqual([
			{
				id: "B2",
				words: PROSE_CAP_WORDS + 200,
				excess: 200,
				exemptedAt: null,
			},
			{ id: "B1", words: PROSE_CAP_WORDS + 10, excess: 10, exemptedAt: null },
		]);
	});

	it("treats exactly the cap as not over it", () => {
		expect(overCapEntries(doc(PROSE_CAP_WORDS, 1))).toEqual([]);
	});
});

// mantahostels#2058: overCapEntries()/staleExemptionMarkers() reading the §B preamble's
// `Over cap by ruling (#n)` marker, and refusing a stale one.
describe("overCapEntries / staleExemptionMarkers reading the exemption marker", () => {
	const marker = (n: number) =>
		`- **Over cap by ruling (#${n}):** every claim here is load-bearing — never cut one to reach 300; read the count from \`overCapEntries()\`.`;

	// The marker's own words count as prose (docs/doc-map.md §B preamble),
	// so a caller aiming for an exact total must budget for it.
	const wc = (s: string) => (s.match(/\S+/g) || []).length;

	const docWithMarker = (
		b1BodyWords: number,
		b1Marker: string | null,
		b2Words: number,
	) =>
		[
			"## Section B",
			"",
			"### B1 · small",
			"",
			"- **Owner:** x",
			words(b1BodyWords),
			...(b1Marker === null ? [] : [b1Marker]),
			"",
			"### B2 · big",
			"",
			"- **Owner:** x",
			words(b2Words),
			"",
			"## Section C",
		].join("\n");

	/** Body words to hand `docWithMarker` so the entry's total prose lands on `target`. */
	const bodyWordsFor = (target: number, markerLine: string | null) =>
		target - (markerLine === null ? 0 : wc(markerLine));

	/** The ruling each entry `staleExemptionMarkers` lists is marked by. */
	const staleRulings = (text: string) =>
		staleExemptionMarkers(text).map(
			(e: { exemptedAt: number }) => e.exemptedAt,
		);

	it("reads exemptedAt off a marked entry's own lines", () => {
		expect(staleRulings(docWithMarker(3, marker(1911), 5))).toEqual([1911]);
	});

	it("reads no marker off an entry that carries none", () => {
		expect(staleRulings(docWithMarker(3, "- **Settled at #1**", 5))).toEqual(
			[],
		);
	});

	it("carries exemptedAt through overCapEntries for a marked over-cap entry", () => {
		const target = PROSE_CAP_WORDS + 10;
		const text = docWithMarker(
			bodyWordsFor(target, marker(1911)),
			marker(1911),
			3,
		);
		expect(overCapEntries(text)).toEqual([
			{ id: "B1", words: target, excess: 10, exemptedAt: 1911 },
		]);
	});

	it("leaves exemptedAt null for an over-cap entry with no marker", () => {
		const target = PROSE_CAP_WORDS + 10;
		const text = docWithMarker(bodyWordsFor(target, null), null, 3);
		expect(overCapEntries(text)).toEqual([
			{ id: "B1", words: target, excess: 10, exemptedAt: null },
		]);
	});

	it("does not count a marker on an indented sub-bullet", () => {
		const subBullet = `  ${marker(1911)}`;
		const target = PROSE_CAP_WORDS + 10;
		const text = docWithMarker(bodyWordsFor(target, subBullet), subBullet, 3);
		expect(overCapEntries(text)).toEqual([
			{ id: "B1", words: target, excess: 10, exemptedAt: null },
		]);
		// A sub-bullet under B1 at or under cap is not stale either — it was
		// never read as a marker in the first place.
		const underCapText = docWithMarker(
			bodyWordsFor(1, subBullet),
			subBullet,
			3,
		);
		expect(staleExemptionMarkers(underCapText)).toEqual([]);
	});

	it("does not count a marker with an absent or malformed ticket number", () => {
		const noNumber =
			"- **Over cap by ruling (#):** every claim here is load-bearing.";
		const noHash =
			"- **Over cap by ruling (1911):** every claim here is load-bearing.";
		expect(staleRulings(docWithMarker(3, noNumber, 5))).toEqual([]);
		expect(staleRulings(docWithMarker(3, noHash, 5))).toEqual([]);
	});

	it("takes the first marker where an entry carries two", () => {
		const two = `${marker(1911)}\n${marker(1350)}`;
		expect(staleRulings(docWithMarker(3, two, 5))).toEqual([1911]);
	});

	describe("staleExemptionMarkers", () => {
		it("lists a marked entry that has fallen at or under the cap, though overCapEntries no longer sees it", () => {
			const text = docWithMarker(
				bodyWordsFor(PROSE_CAP_WORDS, marker(1911)),
				marker(1911),
				3,
			);
			expect(overCapEntries(text)).toEqual([]);
			expect(staleExemptionMarkers(text)).toEqual([
				{ id: "B1", words: PROSE_CAP_WORDS, exemptedAt: 1911 },
			]);
		});

		it("is empty where a marked entry is still over cap", () => {
			const target = PROSE_CAP_WORDS + 10;
			const text = docWithMarker(
				bodyWordsFor(target, marker(1911)),
				marker(1911),
				3,
			);
			expect(staleExemptionMarkers(text)).toEqual([]);
		});

		it("is empty where no entry carries a marker", () => {
			expect(staleExemptionMarkers(docWithMarker(3, null, 5))).toEqual([]);
		});

		it("ignores a marker outside any §B entry, such as the preamble's own example", () => {
			const text = [
				"## Section B",
				"",
				marker(1911),
				"",
				"### B1 · small",
				"",
				"- **Owner:** x",
				words(3),
				"",
				"## Section C",
			].join("\n");
			expect(staleExemptionMarkers(text)).toEqual([]);
		});
	});

	// mantahostels#2124: the near-miss residual. Every spelling below reads as
	// UNEXEMPTED (an under-cap entry carrying one is no stale marker), which is
	// the fault — this reports it rather than changing what counts as a marker.
	describe("malformedExemptionMarkers", () => {
		/** A near miss and the strict marker are indistinguishable to a reader. */
		const nearMisses = {
			"colon outside the bold":
				"- **Over cap by ruling (#1911)**: every claim here is load-bearing.",
			"no bold at all":
				"- Over cap by ruling (#1911): every claim here is load-bearing.",
			"an indented sub-bullet":
				"  - **Over cap by ruling (#1911):** every claim here is load-bearing.",
			"no hash before the number":
				"- **Over cap by ruling (1911):** every claim here is load-bearing.",
			"no ticket number":
				"- **Over cap by ruling (#):** every claim here is load-bearing.",
			// mantahostels#2124: the repo spells the adjective "over-cap"
			// everywhere, this checker's own message included, so the
			// hyphenated slip is the likeliest of all of them.
			"a hyphenated adjective":
				"- **Over-cap by ruling (#1911):** every claim here is load-bearing.",
			"lower case": "- **over cap by ruling (#1911):** it is load-bearing.",
			"a bold-italic leader":
				"- ***Over cap by ruling (#1911):*** every claim is load-bearing.",
			"no space after the bullet":
				"-**Over cap by ruling (#1911):** every claim is load-bearing.",
			"a plus-sign bullet":
				"+ **Over cap by ruling (#1911):** every claim is load-bearing.",
		};

		for (const [name, line] of Object.entries(nearMisses))
			it(`reports ${name}, which reads as unexempted`, () => {
				const text = docWithMarker(3, line, 5);
				expect(staleRulings(text)).toEqual([]);
				expect(malformedExemptionMarkers(text)).toEqual([
					{ id: "B1", line: line.trim() },
				]);
			});

		it("is empty on the marker's own correct spelling", () => {
			expect(
				malformedExemptionMarkers(docWithMarker(3, marker(1911), 5)),
			).toEqual([]);
		});

		it("is empty where no entry mentions the marker at all", () => {
			expect(malformedExemptionMarkers(docWithMarker(3, null, 5))).toEqual([]);
		});

		/*
		 * The scoping rule: an entry already carrying a valid marker IS exempt,
		 * so a second line echoing the words — mantahostels#2058's indented sub-bullet among
		 * them — costs nothing and is not reported.
		 */
		it("stays silent on an echo inside an entry that carries a valid marker", () => {
			const text = [
				"## Section B",
				"",
				"### B1 · small",
				"",
				"- **Owner:** x",
				marker(1911),
				`  ${marker(1911)}`,
				"",
				"## Section C",
			].join("\n");
			expect(staleRulings(text)).toEqual([1911]);
			expect(malformedExemptionMarkers(text)).toEqual([]);
		});

		it("ignores a mid-sentence mention, which nobody could mistake for a bullet", () => {
			const prose =
				"An entry may carry an Over cap by ruling (#1911) marker instead.";
			expect(malformedExemptionMarkers(docWithMarker(3, prose, 5))).toEqual([]);
		});

		it("names every entry where more than one carries a near miss", () => {
			const near = "- Over cap by ruling (#1911): load-bearing.";
			const text = [
				"## Section B",
				"",
				"### B1 · small",
				"",
				"- **Owner:** x",
				near,
				"",
				"### B2 · big",
				"",
				"- **Owner:** x",
				near,
				"",
				"## Section C",
			].join("\n");
			expect(malformedExemptionMarkers(text)).toEqual([
				{ id: "B1", line: near },
				{ id: "B2", line: near },
			]);
		});

		it("ignores a near miss outside any §B entry, such as the preamble's own example", () => {
			const text = [
				"## Section B",
				"",
				"- Over cap by ruling (#1911): the preamble's own gloss.",
				"",
				"### B1 · small",
				"",
				"- **Owner:** x",
				words(3),
				"",
				"## Section C",
			].join("\n");
			expect(malformedExemptionMarkers(text)).toEqual([]);
		});
	});
});

describe("parseSupersedesText", () => {
	it("takes the bullet and its indented continuation, stopping at the next", () => {
		const lines = [
			"- **Supersedes:** the old **$18** AOV,",
			"  measured on retail only.",
			"- **Restated in:** `docs/a.md`",
			"  and its **$45** successor.",
		];
		const text = parseSupersedesText(lines);
		expect(text).toContain("$18");
		expect(text).toContain("retail only");
		expect(text).not.toContain("$45");
	});

	it("answers empty where no bullet supersedes anything", () => {
		expect(parseSupersedesText(["- **Owner:** `docs/a.md`"]).trim()).toBe("");
	});
});

describe("parseRetiredVocabularyText", () => {
	it("takes a line-initial bullet and its indented continuation", () => {
		const lines = [
			"- **Retired vocabulary — grep these:** 3 phrases, in `x.json`.",
			"  **Legitimate hits:** this entry.",
			"- **Owner:** `docs/a.md`",
			"  and its **4 phrases**.",
		];
		const text = parseRetiredVocabularyText(lines);
		expect(text).toContain("3 phrases");
		expect(text).toContain("this entry");
		expect(text).not.toContain("4 phrases");
	});

	it("takes a bullet written with no list marker at all (B15's spelling)", () => {
		expect(
			parseRetiredVocabularyText([
				"**Retired vocabulary — grep these:** 5 phrases, in `x.json`.",
			]).trim(),
		).toContain("5 phrases");
	});

	it("takes a mid-line bullet, dropping the run before it (B122's spelling)", () => {
		const text = parseRetiredVocabularyText([
			"- **Rejected at #415:** a hard gate (**7%**). **Retired vocabulary:** 3 phrases, in `x.json`.",
		]);
		expect(text).toContain("3 phrases");
		expect(text).not.toContain("hard gate");
	});

	it("answers null where the entry carries no such bullet", () => {
		expect(parseRetiredVocabularyText(["- **Owner:** `docs/a.md`"])).toBeNull();
	});

	it("answers empty, not null, for a bullet written bare", () => {
		// A declaration with nothing after it is still a declaration; read as an
		// absence it would go unscanned, the false green mantahostels#1247 closes.
		expect(parseRetiredVocabularyText(["- **Retired vocabulary:**"])).toBe("");
	});
});

describe("readTextLines", () => {
	it("reads a text file as lines", () => {
		expect(readTextLines("package.json")?.[0]).toBe("{");
	});

	it("returns null for a path that will not read", () => {
		expect(readTextLines("docs/does-not-exist-here.md")).toBeNull();
	});

	it("returns null for a binary file", () => {
		expect(readTextLines("docs/brand_assets/NunitoSans.ttf")).toBeNull();
	});

	/*
	 * mantahostels#268 bug 2 (the three bugs one checker copy inherited from another). A
	 * tracked file too large to hold as a JS string throws
	 * ERR_STRING_TOO_LONG on the decode, not on the read — so with the decode
	 * outside the guard, one oversized file in the repo turns a report into a
	 * crash. Faked here: a real 512 MB fixture would exceed the machine's cap.
	 */
	it("returns null when the decode throws, rather than propagating", () => {
		vi.spyOn(fs, "readFileSync").mockReturnValue({
			subarray: () => ({ includes: () => false }),
			toString: () => {
				throw new Error("Cannot create a string longer than 0x1fffffe8");
			},
		} as never);
		expect(readTextLines("docs/enormous.md")).toBeNull();
	});
});

describe("repoRelative", () => {
	/*
	 * mantahostels#268. `git ls-files` states repo-relative paths, so a scan recognises
	 * the map as itself only once the CLI argument is in that same form —
	 * otherwise Section B is free to report every value it quotes by design.
	 */
	it("normalises the spellings of one path to what git states", () => {
		expect(repoRelative("./docs/doc-map.md")).toBe("docs/doc-map.md");
		expect(repoRelative("docs/doc-map.md")).toBe("docs/doc-map.md");
		expect(repoRelative("docs/../docs/doc-map.md")).toBe("docs/doc-map.md");
	});
});

describe("mapSkipLine", () => {
	const docMapPath = "docs/doc-map.md";
	const lines = [
		"# Doc map",
		"",
		"## Section A — document register",
		"The preamble is hand-written.",
		"| `docs/x.md` | a doc | `free-edit` | Direct | — |",
		"| Brand sheet version | `docs/brand-sheet.md` | `DESIGN.md` |",
		"",
		"## Section B — load-bearing figure registry",
		"### B1 · a figure",
	];

	it("scans every other file whole", () => {
		expect(mapSkipLine("docs/x.md", lines, docMapPath)).toBeNull();
	});

	/* mantahostels#2399: a §A cell is a verbatim copy of docs/doc-map-classes.json, so
	 * scanning both makes one sentence need two allowlist rows. */
	it("skips the map's generated §A register rows and not its prose", () => {
		const skip = mapSkipLine(docMapPath, lines, docMapPath);
		expect(skip?.(4)).toBe(true);
		expect(skip?.(3)).toBe(false);
	});

	/* §A's Version-stamps table is hand-written and the generator leaves it
	 * alone, so it has no source to carry a suppression instead: skipping it
	 * would strand a stale stamp with nowhere to be reported. */
	it("scans a hand-written §A table row, which registers no path", () => {
		expect(mapSkipLine(docMapPath, lines, docMapPath)?.(5)).toBe(false);
	});

	// check-machinery-superseded.js retires figures §B does not own, so its scan
	// keeps reading §B.
	it("skips §B only for a caller that asks", () => {
		expect(mapSkipLine(docMapPath, lines, docMapPath)?.(8)).toBe(false);
		expect(
			mapSkipLine(docMapPath, lines, docMapPath, { sectionB: true })?.(8),
		).toBe(true);
	});

	it("skips nothing where the map has neither section", () => {
		const bare = ["# Doc map", "| a | row |"];
		expect(
			mapSkipLine(docMapPath, bare, docMapPath, { sectionB: true })?.(1),
		).toBe(false);
	});
});

describe("needlePattern", () => {
	/* mantahostels#2443: every needle matches case-insensitively, a digit-bearing
	 * one included, so a sentence-initial copy of a letter-bearing numeric
	 * needle is found. */
	it("matches a sentence-initial copy of a letter-and-digit needle", () => {
		const pattern = needlePattern("call list 23-25");
		expect("Call list 23-25 goes out Monday.").toMatch(pattern);
	});

	/* The digit-safe boundary form is what mantahostels#2443 kept: a plain \b would give
	 * this collision back up, since the needle's own tail is a number. */
	it("still stops a letter-and-digit needle matching inside a longer number", () => {
		const pattern = needlePattern("call list 23-25");
		expect("call list 23-25.5 rooms").not.toMatch(pattern);
	});

	it("still stops a pure-number needle matching inside a longer number", () => {
		const pattern = needlePattern("$18");
		expect("$180 and $18.50").not.toMatch(pattern);
		expect("$18 flat").toMatch(pattern);
	});

	it("stops a needle ending in a letter matching inside a longer word", () => {
		expect("400 busy jiffies").not.toMatch(needlePattern("400 B"));
		expect("6 hours").not.toMatch(needlePattern("6 h"));
		expect("a 400 B cap").toMatch(needlePattern("400 B"));
	});

	it("still matches a needle ending in a digit against a figure with its unit attached", () => {
		expect("a 512MB heap").toMatch(needlePattern("512"));
	});

	it("does not match an issue citation carrying the needle's digits (#1875)", () => {
		expect("the stamp (#4821) gate").not.toMatch(needlePattern("4821"));
		expect("see acme/widgets#4821").not.toMatch(needlePattern("4821"));
		expect("a 4821 s run").toMatch(needlePattern("4821"));
	});

	it("does not match the head of a longer comma-grouped number (#1875)", () => {
		expect("38,000,000 characters").not.toMatch(needlePattern("38,000"));
		expect("a 38,000 B cap").toMatch(needlePattern("38,000"));
	});
});

describe("scanScope", () => {
	const map = [
		"## Section A — document register",
		"",
		"| `docs/live.md` | a doc | `free-edit` | Direct |",
		"| `docs/logo.svg` | a logo | `binary-asset` | Replace |",
		"",
		"## Section B",
	].join("\n");

	// ctx.broken throws in the real runner, so a stub that records and throws is
	// what distinguishes "reported broken" from "scanned anything at all".
	const stubCtx = () => {
		const broken: string[] = [];
		return {
			broken: (m: string) => {
				broken.push(m);
				throw new Error("broken");
			},
			messages: broken,
		};
	};

	it("drops the class-exempt files and the checker's own two", () => {
		const ctx = stubCtx();
		const { files, exemptCount } = scanScope(ctx, {
			text: map,
			mapPath: "docs/doc-map.md",
			checker: "check-superseded-values",
		});
		expect(files).not.toContain("scripts/check-superseded-values.js");
		expect(files).not.toContain("scripts/check-superseded-values.test.ts");
		expect(files).toContain("package.json");
		expect(exemptCount).toBe(0);
	});

	it("drops the checker's own two and nothing else", () => {
		const { files } = scopeIn({
			text: map,
			checker: "check-superseded-values",
			files: [
				"scripts/check-superseded-values.js",
				"scripts/check-superseded-values.test.ts",
				"scripts/check-retired-vocabulary.js",
				"docs/check-superseded-values.js",
			],
		});
		expect(files.sort()).toEqual([
			"docs/check-superseded-values.js",
			"scripts/check-retired-vocabulary.js",
		]);
	});

	/* mantahostels#2458 — why lockfiles leave scope at all: `LOCKFILES` in doc-map.js. */
	it("drops the dependency lockfiles from a scope that otherwise holds them", () => {
		const ctx = stubCtx();
		// Positive control: both are tracked, so the two negatives below cannot
		// pass merely because git stopped listing them.
		expect(readTrackedFiles()).toContain("package-lock.json");
		expect(readTrackedFiles()).toContain("skills-lock.json");
		const { files } = scanScope(ctx, {
			text: map,
			mapPath: "docs/doc-map.md",
			checker: "check-superseded-values",
		});
		expect(files).not.toContain("package-lock.json");
		expect(files).not.toContain("skills-lock.json");
		expect(files).toContain("package.json");
	});

	/* The basename choice is the load-bearing half, and no tracked lockfile in
	 * THIS repo sits in a subdirectory, so a throwaway repo tracks the cases. */
	it("reads a lockfile by basename, at any depth and not by resemblance", () => {
		const { files } = scopeIn({
			text: map,
			files: [
				"vendor/x/package-lock.json",
				"package-lock.json",
				"docs/my-package-lock.json",
				"package.json",
			],
		});
		expect(files).toEqual(["docs/my-package-lock.json", "package.json"]);
	});

	/* #2415 — why recordings leave scope: `isRecordedTranscript` in doc-map.js. */
	it("drops the recorded session transcripts from a scope that otherwise holds them", () => {
		const recording = "scripts/fixtures/arm-secondary/recorded-69f9fc0f.jsonl";
		// Positive control, as for the lockfiles.
		expect(readTrackedFiles()).toContain(recording);
		const { files } = scanScope(stubCtx(), {
			text: map,
			mapPath: "docs/doc-map.md",
			checker: "check-machinery-superseded",
		});
		expect(files).not.toContain(recording);
		expect(files).toContain("scripts/lib/arm-secondary.test.ts");
	});

	it("recognises a recording by a recorded-*.jsonl basename under scripts/fixtures/, at any depth", () => {
		const { files } = scopeIn({
			text: map,
			files: [
				"scripts/fixtures/recorded-a.jsonl",
				"scripts/fixtures/x/y/recorded-b.jsonl",
				"scripts/fixtures/x/recorded-c.json",
				"scripts/fixtures/x/not-recorded-d.jsonl",
				"docs/data/recorded-e.jsonl",
			],
		});
		expect(files.sort()).toEqual([
			"docs/data/recorded-e.jsonl",
			"scripts/fixtures/x/not-recorded-d.jsonl",
			"scripts/fixtures/x/recorded-c.json",
		]);
	});

	/* Criterion 4's other half: scanScope reads the class through the sidecar
	 * too, and a file whose §A cell disagrees is exempt by that route anyway.
	 * `readSidecarBeside` resolves its sidecar beside the MAP PATH, so an absolute
	 * mapPath pointing into a scratch dir finds a synthetic sidecar there —
	 * without a chdir that would break scanScope's own `readTrackedFiles()` git call. */
	it("exempts a file the sidecar classes binary-asset and §A's cell does not", () => {
		// scanScope returns tracked files only, so the target is the module under
		// test — tracked for as long as this suite can run.
		const target = "scripts/lib/doc-map.js";
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scanscope-sidecar-"));
		const scratchMap = path.join(dir, "doc-map.md");
		writeSidecar(path.join(dir, CLASSES_FILE), {
			[target]: { class: "binary-asset", classQualifier: null },
		});
		try {
			const ctx = stubCtx();
			const { files } = scanScope(ctx, {
				text: [
					"## Section A — document register",
					"",
					`| \`${target}\` | a doc | \`free-edit\` | Direct |`,
					"",
					"## Section B",
				].join("\n"),
				mapPath: scratchMap,
				checker: "check-superseded-values",
			});
			expect(files).not.toContain(target);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is BROKEN where Section A parses no row", () => {
		const ctx = stubCtx();
		expect(() =>
			scanScope(ctx, {
				text: "## Section A\n\nNo register yet.\n\n## Section B",
				mapPath: "docs/doc-map.md",
				checker: "check-superseded-values",
			}),
		).toThrow();
		expect(ctx.messages[0]).toContain("no Section A row parsed");
	});
});

/* #428. scanScope reads scope from `git ls-files` in the cwd, and this repo
 * tracks no archive file. */
describe("CORE_CLASSES", () => {
	const report = "docs/archive/sync-reports/2026-09-26.md";
	const proposal = "docs/archive/sync-proposals/2026-09-26.md";
	const covered = (f: string) =>
		coverageMatchers([]).some((t: (f: string) => boolean) => t(f));

	it("covers the archive folders and nothing else under docs/archive/", () => {
		expect(covered(report)).toBe(true);
		expect(covered(proposal)).toBe(true);
		expect(covered("docs/archive/x.md")).toBe(false);
	});

	it("covers the context-cost table an upgrade may seed after init (#679)", () => {
		expect(covered(".claude/plugin-context-cost.json")).toBe(true);
	});

	it("covers the session cost table an upgrade may build after init (#1734)", () => {
		expect(covered("docs/data/session-cost-table.json")).toBe(true);
	});

	it("scans an archive file with no key of its own", () => {
		const { files, exemptCount } = scopeIn({
			text: buildSectionAText([
				"| `docs/logo.svg` | a logo | `binary-asset` | Replace |",
			]),
			files: [report, "docs/live.md"],
		});
		expect(files).toContain("docs/live.md");
		expect(files).toContain(report);
		expect(exemptCount).toBe(0);
	});
});

describe("readTrackedFiles", () => {
	it("lists the tracked tree", () => {
		expect(readTrackedFiles()).toContain("package.json");
	});
});

describe("sectionBEntryCount", () => {
	it("counts non-stray ### B<n> headings only", () => {
		const text = [
			"## Section B",
			"",
			"### B1 · Alpha",
			"body",
			"",
			"### B2 · Beta",
			"body",
			"",
			"## Section C",
			"",
			"### B3 · Stray, below Section B",
		].join("\n");
		expect(sectionBEntryCount(text)).toBe(2);
	});
});

/*
 * sectionBEntryRate reads the CURRENT repo's git history, like readTrackedFiles
 * and readConflictedPaths above, so it runs inside a throwaway repo whose commit
 * dates are pinned with GIT_AUTHOR_DATE/GIT_COMMITTER_DATE.
 */
describe("sectionBEntryRate", () => {
	let repo: string;
	let cwd: string;
	const mapPath = "docs/doc-map.md";

	const git = (args: string[], env?: Record<string, string>) =>
		execFileSync("git", args, {
			cwd: repo,
			encoding: "utf8",
			env: { ...process.env, ...env },
		});

	const entryDoc = (n: number) => {
		const lines = ["## Section B", ""];
		for (let i = 1; i <= n; i++)
			lines.push(`### B${i} · E${i}`, "", "body", "");
		return lines.join("\n");
	};

	/** Commits `docs/doc-map.md` holding `n` entries, dated `daysAgo` days back. */
	const commitMap = (n: number, daysAgo: number) => {
		fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
		fs.writeFileSync(path.join(repo, mapPath), entryDoc(n));
		const date = new Date(
			Date.now() - daysAgo * 24 * 60 * 60 * 1000,
		).toISOString();
		git(["add", "--", mapPath]);
		git(["commit", "-qm", `map at ${daysAgo}d, ${n} entries`, "--", mapPath], {
			GIT_AUTHOR_DATE: date,
			GIT_COMMITTER_DATE: date,
		});
	};

	beforeEach(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "doc-map-rate-"));
		git(["init", "-q", "-b", "main", "."]);
		git(["config", "user.email", "test@example.com"]);
		git(["config", "user.name", "test"]);
		cwd = process.cwd();
		process.chdir(repo);
	});

	afterEach(() => {
		process.chdir(cwd);
		fs.rmSync(repo, { recursive: true, force: true });
	});

	it("returns null outside a git repo", () => {
		process.chdir(cwd);
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "doc-map-norate-"));
		process.chdir(outside);
		try {
			expect(sectionBEntryRate(mapPath, 5)).toBeNull();
		} finally {
			process.chdir(cwd);
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it("divides the delta since 7 days ago by 7", () => {
		commitMap(3, 10);
		commitMap(5, 7);
		commitMap(12, 0);

		const result = sectionBEntryRate(mapPath, 12);
		expect(result).not.toBeNull();
		expect(result?.days).toBeCloseTo(7, 1);
		expect(result?.rate).toBeCloseTo((12 - 5) / 7, 1);
	});

	// The case mantahostels#1347 names explicitly: history shorter than 7 days must not
	// crash or pad the denominator to 7 — it reports over the span it has.
	it("falls back to the oldest commit, and its actual span, when history is under 7 days", () => {
		commitMap(2, 3);
		commitMap(9, 0);

		const result = sectionBEntryRate(mapPath, 9);
		expect(result).not.toBeNull();
		expect(result?.days).toBeCloseTo(3, 1);
		expect(result?.rate).toBeCloseTo((9 - 2) / 3, 1);
	});

	it("returns null with under a day of history — too little span to divide by", () => {
		commitMap(4, 0);
		expect(sectionBEntryRate(mapPath, 4)).toBeNull();
	});

	// A commit history sparser than the 7-day window: the nearest commit at or
	// before the cutoff is 20 days old. Dividing its delta by a capped 7 would
	// read a slow map as a fast one.
	it("divides by the actual elapsed span, not a capped 7, when the baseline is far older than 7 days", () => {
		commitMap(1, 20);
		commitMap(15, 0);

		const result = sectionBEntryRate(mapPath, 15);
		expect(result).not.toBeNull();
		expect(result?.days).toBeCloseTo(20, 1);
		expect(result?.rate).toBeCloseTo((15 - 1) / 20, 1);
	});

	// `--follow` can pick up a pre-rename commit whose baseline sha never held
	// `mapPath` under its current name — `git show <sha>:<mapPath>` then fails
	// on a real commit, not a missing one, and must degrade to null rather than
	// throw.
	it("returns null when the baseline commit predates the file's current name", () => {
		const oldPath = "docs/doc-map-old.md";
		fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
		fs.writeFileSync(path.join(repo, oldPath), entryDoc(1));
		const oldDate = new Date(
			Date.now() - 10 * 24 * 60 * 60 * 1000,
		).toISOString();
		git(["add", "--", oldPath]);
		git(["commit", "-qm", "map at 10d under its old name", "--", oldPath], {
			GIT_AUTHOR_DATE: oldDate,
			GIT_COMMITTER_DATE: oldDate,
		});
		git(["mv", oldPath, mapPath]);
		git(["commit", "-qm", "renamed to its current name"]);
		commitMap(9, 0);

		expect(sectionBEntryRate(mapPath, 9)).toBeNull();
	});
});

/*
 * pairingHalfAgeMs (mantahostels#1785) — the one seam check-doc-map.js's UNCOVERED and
 * DEAD-ENTRY grace windows both date through. Same throwaway-repo pattern as
 * sectionBEntryRate above, with commits pinned by GIT_AUTHOR_DATE/
 * GIT_COMMITTER_DATE.
 */
describe("pairingHalfAgeMs", () => {
	let repo: string;
	let cwd: string;
	const mapPath = "docs/doc-map.md";

	const git = (args: string[], env?: Record<string, string>) =>
		execFileSync("git", args, {
			cwd: repo,
			encoding: "utf8",
			env: { ...process.env, ...env },
		});

	/** Commits `rel`'s currently-written content, dated `hoursAgo` back. */
	const commitFile = (rel: string, hoursAgo: number, msg = `add ${rel}`) => {
		const date = new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
		git(["add", "--", rel]);
		git(["commit", "-qm", msg, "--", rel], {
			GIT_AUTHOR_DATE: date,
			GIT_COMMITTER_DATE: date,
		});
	};

	beforeEach(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "doc-map-pairing-"));
		git(["init", "-q", "-b", "main", "."]);
		git(["config", "user.email", "test@example.com"]);
		git(["config", "user.name", "test"]);
		cwd = process.cwd();
		process.chdir(repo);
	});

	afterEach(() => {
		process.chdir(cwd);
		fs.rmSync(repo, { recursive: true, force: true });
	});

	it("dates a tracked file (no mapPath) by the oldest commit touching it", () => {
		fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
		fs.writeFileSync(path.join(repo, "docs", "notes.md"), "x\n");
		commitFile("docs/notes.md", 3);

		const now = Date.now();
		const ageMs = pairingHalfAgeMs("docs/notes.md", null, now);
		expect(ageMs).not.toBeNull();
		expect((ageMs as number) / (60 * 60 * 1000)).toBeCloseTo(3, 1);
	});

	/** A minimal but real Section A table, parseRegister()-shaped. */
	const sectionA = (...rows: string[]) =>
		[
			"v1.0 · x",
			"",
			"## Section A",
			"",
			"| Path | Role | Authority |",
			"| --- | --- | --- |",
			...rows,
			"",
			"## Section B",
			"",
		].join("\n");

	it("dates a Section A path string by the oldest commit whose map diff introduces it", () => {
		fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
		fs.writeFileSync(path.join(repo, mapPath), sectionA());
		commitFile(mapPath, 5, "base map");
		fs.writeFileSync(
			path.join(repo, mapPath),
			sectionA("| `docs/ghost.md` | a doc | `stable` |"),
		);
		commitFile(mapPath, 2, "add ghost row");

		const now = Date.now();
		const ageMs = pairingHalfAgeMs("docs/ghost.md", mapPath, now);
		expect(ageMs).not.toBeNull();
		expect((ageMs as number) / (60 * 60 * 1000)).toBeCloseTo(2, 1);
	});

	// The bug both review passes on mantahostels#1785 caught: a bare pickaxe (`-S`) hit
	// matches the path string ANYWHERE in the map, Section B prose included.
	// docs/doc-map.md is ~79,000 words and routinely mentions a path outside
	// its own register row, so dating must verify the hit is a genuine
	// Section A birth — present in the commit's register, absent from its
	// parent's — not just trust the oldest string match.
	it("is not misdated by an older §B prose mention of the same path", () => {
		fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
		fs.writeFileSync(
			path.join(repo, mapPath),
			`${sectionA()}\n§B1 — see \`docs/ghost.md\`.\n`,
		);
		commitFile(mapPath, 10, "mention it in §B prose");
		fs.writeFileSync(
			path.join(repo, mapPath),
			`${sectionA("| `docs/ghost.md` | a doc | `stable` |")}\n§B1 — see \`docs/ghost.md\`.\n`,
		);
		commitFile(mapPath, 1, "add the actual §A row");

		const now = Date.now();
		const ageMs = pairingHalfAgeMs("docs/ghost.md", mapPath, now) as number;
		expect(ageMs).not.toBeNull();
		// 1h, from the row's own commit — not 10h, from the older §B mention a
		// naive pickaxe search would have picked up as the "oldest" hit.
		expect(ageMs / (60 * 60 * 1000)).toBeCloseTo(1, 1);
	});

	it("returns null when no commit ever touches the path", () => {
		expect(pairingHalfAgeMs("docs/never-committed.md")).toBeNull();
	});

	it("returns null outside a git repo", () => {
		process.chdir(cwd);
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "doc-map-nogit-"));
		process.chdir(outside);
		try {
			expect(pairingHalfAgeMs("docs/whatever.md")).toBeNull();
		} finally {
			process.chdir(cwd);
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	// mantahostels#1191/mantahostels#1384: a pre-commit invocation hands the checker a temp-directory
	// copy of the map with no git identity of its own. The row's own path
	// string is still findable through the SECOND candidate, the tracked
	// docs/doc-map.md — readMapTextAt's fallback, reused here.
	it("falls back to the tracked docs/doc-map.md when mapPath has no git identity", () => {
		fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
		fs.writeFileSync(
			path.join(repo, mapPath),
			sectionA("| `docs/ghost.md` | a doc | `stable` |"),
		);
		commitFile(mapPath, 1, "add ghost row");

		const tempCopy = path.join(
			fs.mkdtempSync(path.join(os.tmpdir(), "doc-map-tmpcopy-")),
			"doc-map.md",
		);
		fs.writeFileSync(
			tempCopy,
			fs.readFileSync(path.join(repo, mapPath), "utf8"),
		);
		try {
			const now = Date.now();
			const ageMs = pairingHalfAgeMs("docs/ghost.md", tempCopy, now);
			expect(ageMs).not.toBeNull();
			expect((ageMs as number) / (60 * 60 * 1000)).toBeCloseTo(1, 1);
		} finally {
			fs.rmSync(path.dirname(tempCopy), { recursive: true, force: true });
		}
	});

	it("honours an injected `now` rather than the live clock", () => {
		fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
		fs.writeFileSync(path.join(repo, "docs", "notes.md"), "x\n");
		commitFile("docs/notes.md", 3);

		// A "now" 4h past the real clock, against a commit dated 3h before the
		// real clock: the injected reference makes it read as 7h old.
		const frozen = Date.now() + 4 * 60 * 60 * 1000;
		const ageMs = pairingHalfAgeMs("docs/notes.md", null, frozen) as number;
		expect(ageMs / (60 * 60 * 1000)).toBeCloseTo(7, 0);
	});

	it("PAIRING_GRACE_MS is 6 hours", () => {
		expect(PAIRING_GRACE_MS).toBe(6 * 60 * 60 * 1000);
	});

	// A commit dated in the future — clock skew, or a deliberately backdated
	// GIT_AUTHOR_DATE — must never read as permanently young: a negative age
	// is the same "never a silent pass" hazard `null` is, by another route.
	it("returns null, not a negative age, for a commit dated in the future", () => {
		fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
		fs.writeFileSync(path.join(repo, "docs", "notes.md"), "x\n");
		commitFile("docs/notes.md", -3); // 3h in the future

		expect(pairingHalfAgeMs("docs/notes.md")).toBeNull();
	});
});

/*
 * Both functions read the index of whatever repo they are called in, so these
 * run inside a throwaway one with a live conflict.
 */
describe("a conflicted index", () => {
	let repo: string;
	let cwd: string;
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repo, encoding: "utf8" });

	beforeEach(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "doc-map-conflict-"));
		git("init", "-q", "-b", "main", ".");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "test");
		fs.writeFileSync(path.join(repo, "clean.md"), "untouched\n");
		fs.writeFileSync(path.join(repo, "contested.md"), "base\n");
		git("add", "--", "clean.md", "contested.md");
		git("commit", "-qm", "base");

		git("checkout", "-qb", "other");
		fs.writeFileSync(path.join(repo, "contested.md"), "theirs\n");
		git("commit", "-qm", "theirs", "--", "contested.md");

		git("checkout", "-q", "main");
		fs.writeFileSync(path.join(repo, "contested.md"), "ours\n");
		git("commit", "-qm", "ours", "--", "contested.md");

		try {
			git("merge", "other");
		} catch {
			/* the conflict this fixture exists to create */
		}
		// The fixture is worthless if the merge resolved itself.
		expect(git("ls-files", "--unmerged")).not.toBe("");

		cwd = process.cwd();
		process.chdir(repo);
	});

	afterEach(() => {
		process.chdir(cwd);
		fs.rmSync(repo, { recursive: true, force: true });
	});

	it("counts a conflicted file once, not once per stage", () => {
		const files: string[] = readTrackedFiles();
		expect(files.filter((f: string) => f === "contested.md")).toHaveLength(1);
		expect(files).toEqual(["clean.md", "contested.md"]);
	});

	it("names the conflicted paths, and only those", () => {
		expect(readConflictedPaths()).toEqual(["contested.md"]);
	});

	/* Without `-z` git C-quotes a path holding a tab and both functions hand back
	 * the escaped spelling — a path no caller can match against. */
	it("returns a path holding a tab unescaped", () => {
		const odd = "sp ace\ttab.md";
		fs.writeFileSync(path.join(repo, odd), "ours\n");
		git("add", "--", odd);
		expect(readConflictedPaths()).toEqual(["contested.md"]);
		expect(readTrackedFiles()).toContain(odd);
	});

	it("reports no conflict once the merge is committed", () => {
		fs.writeFileSync(path.join(repo, "contested.md"), "resolved\n");
		// A merge cannot be concluded by a pathspec commit — git refuses a partial
		// one mid-merge — so the resolution is staged first.
		git("add", "--", "contested.md");
		git("commit", "-qm", "resolved");
		expect(readConflictedPaths()).toEqual([]);
		expect(readTrackedFiles()).toEqual(["clean.md", "contested.md"]);
	});
});

/*
 * The three §B data-file loaders (mantahostels#581). Validation is the point of loading:
 * a bad stem or an empty file is a loud error, never a silent shrink of the
 * scan.
 */
describe("the data-file loaders", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-map-data-"));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const fixture = (data: unknown) => {
		const file = path.join(dir, "data.json");
		fs.writeFileSync(
			file,
			typeof data === "string" ? data : JSON.stringify(data),
		);
		return file;
	};

	const loaders = [
		{
			name: "loadRestatements",
			load: loadRestatements,
			good: { B1: { paths: [{ path: "docs/a.md", locator: "§2" }] } },
		},
		{
			name: "loadSupersededNeedles",
			load: loadSupersededNeedles,
			// Empty is its day-one state (mantahostels#3515 F11).
			emptyOk: true,
			good: {
				B1: { needles: [{ needle: "$18", scanned: true }] },
			},
		},
		{
			name: "loadRetiredVocabulary",
			load: loadRetiredVocabulary,
			good: { B1: { phrases: [{ literal: "the call list" }] } },
		},
	] as const;

	describe.each(loaders)("$name", ({ load, good, ...rest }) => {
		it("returns the parsed entries keyed by id", () => {
			expect(load(fixture(good))).toEqual(good);
		});

		it("propagates a missing file with its code, so a caller can tell absence from corruption", () => {
			expect(() => load(path.join(dir, "absent.json"))).toThrow(
				expect.objectContaining({ code: "ENOENT" }),
			);
		});

		it("errors on malformed JSON, naming the file", () => {
			expect(() => load(fixture("{ not json"))).toThrow(/data\.json.*not JSON/);
		});

		// A zero-byte file is what a write that died mid-way leaves behind.
		it("errors on an empty file", () => {
			expect(() => load(fixture(""))).toThrow(/not JSON/);
		});

		it("errors on a file holding no entries, unless empty is a real state for it", () => {
			if ("emptyOk" in rest) expect(load(fixture({}))).toEqual({});
			else expect(() => load(fixture({}))).toThrow(/holds no entries/);
		});

		it("errors where the top level is not a keyed object", () => {
			expect(() => load(fixture([good.B1]))).toThrow(/keyed by B<n>/);
			expect(() => load(fixture(null))).toThrow(/keyed by B<n>/);
		});

		it("errors on a key that is not a B<n> entry id, naming the key", () => {
			expect(() => load(fixture({ C1: good.B1 }))).toThrow(
				/"C1" is not a B<n>/,
			);
			expect(() => load(fixture({ b1: good.B1 }))).toThrow(
				/"b1" is not a B<n>/,
			);
		});
	});

	describe("loadRestatements", () => {
		it("errors on an entry holding no paths, naming the entry", () => {
			expect(() => loadRestatements(fixture({ B1: { paths: [] } }))).toThrow(
				/B1: paths/,
			);
			expect(() => loadRestatements(fixture({ B1: {} }))).toThrow(/B1: paths/);
		});

		// The array-per-entry form the object shape replaced (mantahostels#1469). Accepting
		// both would read a mistyped `paths` as an entry legitimately without one.
		it("rejects the superseded array-per-entry shape outright, naming the entry", () => {
			expect(() =>
				loadRestatements(fixture({ B1: [{ path: "docs/a.md" }] })),
			).toThrow(/B1 holds a non-object item/);
		});

		it("accepts a path stating no locator and no gloss", () => {
			const data = { B1: { paths: [{ path: "docs/a.md" }] } };
			expect(loadRestatements(fixture(data))).toEqual(data);
		});

		it("carries a gloss, an entry note and a known-incomplete date through", () => {
			const data = {
				B1: {
					paths: [
						{ path: "docs/a.md", locator: "§2", gloss: "the launch-gate para" },
					],
					note: "Not a restatement: `docs/b.md` — it carries no figure.",
					knownIncomplete: "2026-08-19",
				},
			};
			expect(loadRestatements(fixture(data))).toEqual(data);
		});

		// Whitespace in a path is a locator left inside it — the migration bug
		// splitting the fields was meant to end.
		it("errors on a path still carrying its locator", () => {
			expect(() =>
				loadRestatements(
					fixture({ B1: { paths: [{ path: "docs/a.md L91" }] } }),
				),
			).toThrow(/holds whitespace/);
		});

		it("errors on an empty path, locator or gloss, naming the field", () => {
			expect(() =>
				loadRestatements(fixture({ B1: { paths: [{ path: " " }] } })),
			).toThrow(/B1: path/);
			expect(() =>
				loadRestatements(
					fixture({ B1: { paths: [{ path: "docs/a.md", locator: "" }] } }),
				),
			).toThrow(/locator/);
			expect(() =>
				loadRestatements(
					fixture({ B1: { paths: [{ path: "docs/a.md", gloss: "" }] } }),
				),
			).toThrow(/gloss/);
		});

		it("errors on an empty entry note, naming the entry", () => {
			expect(() =>
				loadRestatements(
					fixture({ B1: { paths: [{ path: "docs/a.md" }], note: "" } }),
				),
			).toThrow(/B1: note/);
		});

		// A marker date that is not a date sorts and compares like one and is not.
		it("errors on a known-incomplete value that is not an ISO date", () => {
			expect(() =>
				loadRestatements(
					fixture({
						B1: {
							paths: [{ path: "docs/a.md" }],
							knownIncomplete: "19 August 2026",
						},
					}),
				),
			).toThrow(/not an ISO YYYY-MM-DD date/);
		});

		// A typo'd field name must not read as the field being absent.
		it("errors on an unknown field, on the entry and on a path, naming the field", () => {
			expect(() =>
				loadRestatements(
					fixture({ B1: { paths: [{ path: "docs/a.md", line: 91 }] } }),
				),
			).toThrow(/unknown field\(s\) line/);
			expect(() =>
				loadRestatements(
					fixture({ B1: { paths: [{ path: "docs/a.md" }], notes: "x" } }),
				),
			).toThrow(/B1 carries unknown field\(s\) notes/);
		});

		// A raw TypeError from Object.keys(null) would name no file or entry.
		it("errors on a null path item, still naming its entry", () => {
			expect(() =>
				loadRestatements(fixture({ B1: { paths: [null] } })),
			).toThrow(/B1: paths holds a non-object item/);
		});
	});

	describe("loadSupersededNeedles", () => {
		it("keeps the unscanned flag on a multi-value span", () => {
			const data = {
				B9: {
					needles: [
						{ needle: "~4–6% direct all-in vs 12% vendor", scanned: false },
					],
				},
			};
			expect(loadSupersededNeedles(fixture(data))).toEqual(data);
		});

		/* The allowlist is the whole point of mantahostels#707: a superseded value quoted on
		 * purpose — a compliance history row, a checker's own test fixture — is
		 * permanently unfixable, so it reports forever without one. */
		it("accepts an entry carrying an allowlist", () => {
			const data = {
				B1: {
					needles: [{ needle: "$18", scanned: true }],
					allowlist: [
						{ path: "scripts/lib/doc-map.test.ts", lines: [432, 534] },
						{ path: "docs/compliance/a.md", lines: [] },
					],
				},
			};
			expect(loadSupersededNeedles(fixture(data))).toEqual(data);
		});

		// An absent flag silently promoting a span to a grep would hit hundreds
		// of correct lines, so the flag is stated, never defaulted.
		it("errors where the scanned flag is absent or not boolean", () => {
			expect(() =>
				loadSupersededNeedles(
					fixture({ B1: { needles: [{ needle: "$18" }] } }),
				),
			).toThrow(/no boolean scanned flag/);
			expect(() =>
				loadSupersededNeedles(
					fixture({
						B1: { needles: [{ needle: "$18", scanned: "yes" }] },
					}),
				),
			).toThrow(/no boolean scanned flag/);
		});

		it("errors on an empty needle, naming the entry", () => {
			expect(() =>
				loadSupersededNeedles(
					fixture({
						B1: { needles: [{ needle: "", scanned: true }] },
					}),
				),
			).toThrow(/B1: needle/);
		});

		it("errors on an unknown field, naming it", () => {
			expect(() =>
				loadSupersededNeedles(
					fixture({
						B1: {
							needles: [{ needle: "$18", scanned: true, note: "old AOV" }],
						},
					}),
				),
			).toThrow(/unknown field\(s\) note/);
			// A field beside needles and allowlist is refused, not ignored.
			expect(() =>
				loadSupersededNeedles(
					fixture({
						B1: {
							text: "**$18**.",
							needles: [{ needle: "$18", scanned: true }],
						},
					}),
				),
			).toThrow(/unknown field\(s\) text/);
		});

		it("errors on an entry with no needles, naming the entry", () => {
			expect(() =>
				loadSupersededNeedles(fixture({ B1: { needles: [] } })),
			).toThrow(/B1: needles/);
			expect(() => loadSupersededNeedles(fixture({ B1: [] }))).toThrow(
				/does not hold an object/,
			);
		});

		/* Same validation the retired-vocabulary allowlist runs, so a migration
		 * typo cannot silently widen a suppression to a whole file. */
		it("errors on a malformed allowlist, saying what is wrong with it", () => {
			const entry = (allowlist: unknown) => ({
				B1: {
					needles: [{ needle: "$18", scanned: true }],
					allowlist,
				},
			});
			expect(() =>
				loadSupersededNeedles(fixture(entry([{ path: "docs/a.md" }]))),
			).toThrow(/states neither lines nor anchors/);
			expect(() =>
				loadSupersededNeedles(
					fixture(entry([{ path: "docs/a.md", lines: ["L91"] }])),
				),
			).toThrow(/lines is not an array/);
			expect(() =>
				loadSupersededNeedles(fixture(entry([{ path: "", lines: [] }]))),
			).toThrow(/allowlist path/);
			// Line numbers are 1-based; a 0 is an off-by-one from the migration.
			expect(() =>
				loadSupersededNeedles(
					fixture(entry([{ path: "docs/a.md", lines: [0] }])),
				),
			).toThrow(/lines is not an array/);
			expect(() =>
				loadSupersededNeedles(
					fixture(entry([{ path: "docs/a.md", lines: [], note: "x" }])),
				),
			).toThrow(/unknown field\(s\) note/);
		});
	});

	/* mantahostels#744: a line pin rots on every insertion above it — one moved twice
	 * inside one session — so an allowlist row may name the line's content
	 * instead. Validated in the loader, shared by both grep instruments. */
	describe("allowlist content anchors", () => {
		const load = (allowlist: unknown) =>
			loadSupersededNeedles(
				fixture({
					B1: {
						needles: [{ needle: "$18", scanned: true }],
						allowlist,
					},
				}),
			);

		it("accepts anchors alone, and beside line pins", () => {
			const data = [
				{ path: "docs/a.md", anchors: ["| v1.2 |"] },
				{ path: "docs/b.md", lines: [7], anchors: ["Desk kill-test"] },
			];
			expect(load(data).B1.allowlist).toEqual(data);
		});

		it("errors on an empty or non-string anchor list", () => {
			expect(() => load([{ path: "docs/a.md", anchors: [] }])).toThrow(
				/anchors is not a non-empty array/,
			);
			expect(() => load([{ path: "docs/a.md", anchors: "v1.2" }])).toThrow(
				/anchors is not a non-empty array/,
			);
			expect(() => load([{ path: "docs/a.md", anchors: [""] }])).toThrow(
				/anchor/,
			);
		});

		/* mantahostels#2431: an anchor may name the one needle it suppresses, so the line it
		 * sits on stays scanned for the rest. */
		it("accepts an anchor scoped to a needle the entry declares", () => {
			const data = [
				{ path: "docs/a.md", anchors: [{ anchor: "| v1.2 |", needle: "$18" }] },
			];
			expect(load(data).B1.allowlist).toEqual(data);
		});

		it("errors on a scoped anchor naming a needle the entry does not declare", () => {
			expect(() =>
				load([
					{
						path: "docs/a.md",
						anchors: [{ anchor: "| v1.2 |", needle: "$40" }],
					},
				]),
			).toThrow(/does not declare as a needle/);
		});

		/* An unscanned needle is greped for by nothing, so an anchor scoped to one
		 * suppresses nothing. */
		it("errors on a scoped anchor naming a needle the entry does not scan", () => {
			expect(() =>
				loadSupersededNeedles(
					fixture({
						B1: {
							needles: [
								{ needle: "$18", scanned: true },
								{ needle: "Ruritanian LLC", scanned: false },
							],
							allowlist: [
								{
									path: "docs/a.md",
									anchors: [{ anchor: "| v1.2 |", needle: "Ruritanian LLC" }],
								},
							],
						},
					}),
				),
			).toThrow(/does not declare as a needle/);
		});

		it("errors on a scoped anchor missing either half, naming the missing half", () => {
			expect(() =>
				load([{ path: "docs/a.md", anchors: [{ anchor: "| v1.2 |" }] }]),
			).toThrow(/needle/);
			expect(() =>
				load([{ path: "docs/a.md", anchors: [{ needle: "$18" }] }]),
			).toThrow(/anchor/);
		});

		it("errors on a scoped anchor carrying an unknown field", () => {
			expect(() =>
				load([
					{
						path: "docs/a.md",
						anchors: [{ anchor: "| v1.2 |", needle: "$18", why: "x" }],
					},
				]),
			).toThrow(/why/);
		});

		/* The retired-vocabulary scan resolves its allowlist with no needle in
		 * hand, so a scoped anchor there would suppress nothing at all. */
		it("refuses a scoped anchor in the retired-vocabulary data file, saying no needle is in hand", () => {
			expect(() =>
				loadRetiredVocabulary(
					fixture({
						B1: {
							phrases: [{ literal: "the call list" }],
							allowlist: [
								{
									path: "docs/a.md",
									anchors: [{ anchor: "| v1.2 |", needle: "the call list" }],
								},
							],
						},
					}),
				),
			).toThrow(/no needle in hand/);
		});
	});

	describe("resolveAllowlist", () => {
		const lines = ["a stale $18", "| v1.2 | $18 |", "a stale $18"];
		const resolve = (allowlist: unknown[]) =>
			resolveAllowlist(compileAllowlist(allowlist), "docs/a.md", lines);

		it("allows the line an anchor sits on, and nothing else", () => {
			const { allows, notes } = resolve([
				{ path: "docs/a.md", anchors: ["| v1.2 |"] },
			]);
			expect([1, 2, 3].filter(allows)).toEqual([2]);
			expect(notes).toEqual([]);
		});

		it("suppresses only the needle a scoped anchor names", () => {
			const { allows, notes } = resolve([
				{
					path: "docs/a.md",
					anchors: [{ anchor: "| v1.2 |", needle: "$18" }],
				},
			]);
			expect(allows(2, "$18")).toBe(true);
			expect(allows(2, "$40")).toBe(false);
			expect(allows(1, "$18")).toBe(false);
			// No needle in hand: only whole-line suppression answers.
			expect(allows(2)).toBe(false);
			expect(notes).toEqual([]);
		});

		it("keeps a bare anchor suppressing every needle on its line", () => {
			const { allows } = resolve([
				{ path: "docs/a.md", anchors: ["| v1.2 |"] },
			]);
			expect(allows(2, "$40")).toBe(true);
			expect(allows(2)).toBe(true);
		});

		it("carries the needle into the note when a scoped anchor matches no line", () => {
			const { notes } = resolve([
				{ path: "docs/a.md", anchors: [{ anchor: "gone", needle: "$18" }] },
			]);
			expect(notes).toEqual([
				{
					path: "docs/a.md",
					file: "docs/a.md",
					anchor: "gone",
					needle: "$18",
					lines: [],
				},
			]);
		});

		it("ignores a row whose path does not match the file", () => {
			const { allows } = resolve([
				{ path: "docs/other.md", anchors: ["| v1.2 |"] },
			]);
			expect([1, 2, 3].filter(allows)).toEqual([]);
		});

		/* Whole-file suppression stays the empty line list mantahostels#707 shipped: an entry
		 * naming an anchor is asking about one line, never the file. */
		it("allows every line only where a row names neither lines nor anchors", () => {
			expect(
				[1, 2, 3].filter(resolve([{ path: "docs/a.md", lines: [] }]).allows),
			).toEqual([1, 2, 3]);
			expect(
				[1, 2, 3].filter(
					resolve([{ path: "docs/a.md", lines: [], anchors: ["| v1.2 |"] }])
						.allows,
				),
			).toEqual([2]);
		});

		it("names an anchor that matches no line, or several", () => {
			expect(resolve([{ path: "docs/a.md", anchors: ["gone"] }]).notes).toEqual(
				[
					{
						path: "docs/a.md",
						file: "docs/a.md",
						anchor: "gone",
						needle: null,
						lines: [],
					},
				],
			);
			const spread = resolve([{ path: "docs/a.md", anchors: ["a stale"] }]);
			expect(spread.notes[0].lines).toEqual([1, 3]);
			// Named, and suppressing neither: the entry meant one of the two, and
			// an allowlist never hides a line nobody chose to allow.
			expect([1, 2, 3].filter(spread.allows)).toEqual([]);
		});

		/* The line-pin twin of the anchor diagnostic (mantahostels#847). A pin points at a
		 * number, so once the line beneath it changes the pin covers nothing and
		 * — before this — said nothing about it (mantahostels#792). */
		describe("line pins", () => {
			const pinned = (allowlist: unknown[], matches?: (t: string) => boolean) =>
				resolveAllowlist(
					compileAllowlist(allowlist),
					"docs/a.md",
					lines,
					matches,
				);
			const holds = (t: string) => t.includes("$18");

			it("says nothing about a pin whose line still carries a phrase", () => {
				const r = pinned([{ path: "docs/a.md", lines: [2] }], holds);
				expect(r.pins).toEqual([]);
				expect([1, 2, 3].filter(r.allows)).toEqual([2]);
			});

			it("names a pin whose line matches nothing, quoting the line", () => {
				const r = pinned([{ path: "docs/a.md", lines: [2] }], (t) =>
					t.includes("gone"),
				);
				expect(r.pins).toEqual([
					{
						path: "docs/a.md",
						file: "docs/a.md",
						line: 2,
						text: "| v1.2 | $18 |",
					},
				]);
				// Reported, never resolved: the pin keeps suppressing, which changes
				// no verdict — a line matching no phrase raises no hit to suppress.
				expect([1, 2, 3].filter(r.allows)).toEqual([2]);
			});

			it("names a pin past the end of the file, and its length", () => {
				const r = pinned([{ path: "docs/a.md", lines: [9] }], holds);
				expect(r.pins).toEqual([
					{ path: "docs/a.md", file: "docs/a.md", line: 9, fileLines: 3 },
				]);
			});

			/* A caller with no phrases to ask about — or one not asking — gets the
			 * pre-mantahostels#847 behaviour rather than a note it cannot interpret. */
			it("reports no pin at all where the caller passes no predicate", () => {
				expect(pinned([{ path: "docs/a.md", lines: [1, 9] }]).pins).toEqual([]);
			});

			it("ignores a pin on a row whose path is a different file", () => {
				expect(
					pinned([{ path: "docs/other.md", lines: [9] }], holds).pins,
				).toEqual([]);
			});
		});

		/* The whole-file twin of the anchor and pin diagnostics. A row naming
		 * neither lines nor anchors suppresses every line in the file, so it
		 * has no per-line miss to report — only whether the file carries
		 * anything the entry greps for at all. */
		describe("whole-file coverage", () => {
			const wholeFile = (
				allowlist: unknown[],
				matches?: (t: string) => boolean,
			) =>
				resolveAllowlist(
					compileAllowlist(allowlist),
					"docs/a.md",
					lines,
					matches,
				);
			const holds = (t: string) => t.includes("$18");

			it("names a whole-file row whose file matches none of the entry's phrases", () => {
				const r = wholeFile([{ path: "docs/a.md", lines: [] }], (t) =>
					t.includes("gone"),
				);
				expect(r.wholeFileNotes).toEqual([
					{ path: "docs/a.md", file: "docs/a.md" },
				]);
				// Still suppressing, same as an anchor or pin note.
				expect([1, 2, 3].filter(r.allows)).toEqual([1, 2, 3]);
			});

			it("says nothing about a whole-file row whose file matches something", () => {
				expect(
					wholeFile([{ path: "docs/a.md", lines: [] }], holds).wholeFileNotes,
				).toEqual([]);
			});

			it("reports nothing where the caller passes no predicate", () => {
				expect(
					wholeFile([{ path: "docs/a.md", lines: [] }]).wholeFileNotes,
				).toEqual([]);
			});

			it("ignores a whole-file row on a different file", () => {
				expect(
					wholeFile([{ path: "docs/other.md", lines: [] }], (t) =>
						t.includes("gone"),
					).wholeFileNotes,
				).toEqual([]);
			});
		});
	});

	describe("loadRetiredVocabulary", () => {
		it("accepts a stem-and-literal phrase with an allowlist", () => {
			const data = {
				B25: {
					phrases: [{ literal: "hand-edit", stem: "hand.edits?" }],
					allowlist: [
						{ path: "docs/a.md", lines: [91, 96] },
						{ path: "docs/b.md", lines: [] },
					],
				},
			};
			expect(loadRetiredVocabulary(fixture(data))).toEqual(data);
		});

		/* The B49 key's actual stem (mantahostels#344): JavaScript has no inline `(?i)` flag, so in prose
		 * it sat unscanned in a footer. Here it is the loud error, naming the
		 * entry that owns it. */
		it("errors on an uncompilable stem, naming its entry", () => {
			expect(() =>
				loadRetiredVocabulary(
					fixture({
						B49: { phrases: [{ stem: "(?i)hooksPath.{0,40}relative" }] },
					}),
				),
			).toThrow(/B49: stem .*will not compile/);
		});

		/* The B38 key's real stem (mantahostels#287), corrupted the one way the compile check above lets
		 * through: `\bGUARDED` with a single backslash is a backspace, not a word
		 * boundary. */
		it("errors on a stem holding a literal backspace, naming its entry", () => {
			expect(() =>
				loadRetiredVocabulary(
					fixture({ B38: { phrases: [{ stem: "\bGUARDED\\s*=" }] } }),
				),
			).toThrow(/B38: stem .*literal backspace/);
		});

		// The live failure: a stem whose backticked chunk quoted nothing.
		it("errors on an empty stem, naming the entry", () => {
			expect(() =>
				loadRetiredVocabulary(fixture({ B30: { phrases: [{ stem: "" }] } })),
			).toThrow(/B30: stem/);
		});

		it("errors on a phrase stating neither literal nor stem", () => {
			expect(() =>
				loadRetiredVocabulary(fixture({ B1: { phrases: [{}] } })),
			).toThrow(/neither literal nor stem/);
		});

		// The exact typo the field check exists for: `sem` reads as no stem at
		// all, silently downgrading the pattern to its literal.
		it("errors on a typo'd phrase field, naming it", () => {
			expect(() =>
				loadRetiredVocabulary(
					fixture({ B1: { phrases: [{ literal: "x y", sem: "x.y" }] } }),
				),
			).toThrow(/unknown field\(s\) sem/);
		});

		/* Compiling fine is not scannable: the checker refuses this shape at scan
		 * time as an exponential-backtracking hazard, so accepting it at load
		 * would recreate the silent-unscanned class the loader exists to end. */
		it("errors on a catastrophic-backtracking stem, naming its entry", () => {
			expect(() =>
				loadRetiredVocabulary(
					fixture({ B1: { phrases: [{ stem: "(word\\s+)+other" }] } }),
				),
			).toThrow(/B1: stem .*backtrack/);
		});

		it("errors on an entry with no phrases, naming the entry", () => {
			expect(() =>
				loadRetiredVocabulary(fixture({ B1: { phrases: [] } })),
			).toThrow(/B1: phrases/);
			expect(() => loadRetiredVocabulary(fixture({ B1: [] }))).toThrow(
				/does not hold an object/,
			);
		});

		it("errors on a malformed allowlist, saying what is wrong with it", () => {
			const entry = (allowlist: unknown) => ({
				B1: { phrases: [{ literal: "x y" }], allowlist },
			});
			expect(() =>
				loadRetiredVocabulary(fixture(entry([{ path: "docs/a.md" }]))),
			).toThrow(/states neither lines nor anchors/);
			expect(() =>
				loadRetiredVocabulary(
					fixture(entry([{ path: "docs/a.md", lines: ["L91"] }])),
				),
			).toThrow(/lines is not an array/);
			expect(() =>
				loadRetiredVocabulary(fixture(entry([{ path: "", lines: [] }]))),
			).toThrow(/allowlist path/);
			// Line numbers are 1-based; a 0 is an off-by-one from the migration.
			expect(() =>
				loadRetiredVocabulary(
					fixture(entry([{ path: "docs/a.md", lines: [0] }])),
				),
			).toThrow(/lines is not an array/);
			expect(() =>
				loadRetiredVocabulary(
					fixture(entry([{ path: "docs/a.md", lines: [], note: "x" }])),
				),
			).toThrow(/unknown field\(s\) note/);
		});
	});
});

describe("readConflictedPaths outside a repo", () => {
	it("answers empty rather than throwing", () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "doc-map-norepo-"));
		const cwd = process.cwd();
		try {
			process.chdir(outside);
			expect(readConflictedPaths()).toEqual([]);
		} finally {
			process.chdir(cwd);
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});
});

/* The names are the wire contract between the checkers and the migration that
 * writes the files (mantahostels#590) — a rename on either side silently restores the
 * prose fallback everywhere. */
describe("DATA_FILES", () => {
	it("states the six canonical file names", () => {
		expect(DATA_FILES).toEqual({
			restatements: "doc-map-restatements.json",
			supersededNeedles: "doc-map-superseded.json",
			retiredVocabulary: "doc-map-retired-vocabulary.json",
			restatementAllowlist: "doc-map-restatement-allowlist.json",
			highWater: "doc-map-high-water.json",
			admissions: "doc-map-admissions.json",
		});
	});
});

/*
 * The two git-reading halves of mantahostels#1384 (the ticket that refused a commit adding
 * a §B entry over the 300-word prose cap, and reported births-over-cap into
 * mantahostels#1079). Both read a repo's history, so both run inside a throwaway one.
 */
describe("the new-entry cap's git readers", () => {
	let repo: string;
	let cwd: string;
	const mapPath = "docs/doc-map.md";

	const git = (args: string[], env?: Record<string, string>) =>
		execFileSync("git", args, {
			cwd: repo,
			encoding: "utf8",
			env: { ...process.env, ...env },
		});

	/** `n` whitespace-delimited words of prose. */
	const prose = (n: number) =>
		Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

	/** A §B holding one entry per `[id, proseWords]` pair. */
	const doc = (entries: [string, number][]) =>
		[
			"## Section B",
			"",
			...entries.flatMap(([id, n]) => [
				`### ${id} · Figure ${id}`,
				"",
				"- **Owner:** x",
				"",
				prose(n),
				"",
			]),
		].join("\n");

	const commit = (entries: [string, number][], daysAgo: number) => {
		fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
		fs.writeFileSync(path.join(repo, mapPath), doc(entries));
		const date = new Date(
			Date.now() - daysAgo * 24 * 60 * 60 * 1000,
		).toISOString();
		git(["add", "--", mapPath]);
		git(["commit", "-qm", `map at ${daysAgo}d`, "--", mapPath], {
			GIT_AUTHOR_DATE: date,
			GIT_COMMITTER_DATE: date,
		});
	};

	beforeEach(() => {
		repo = fs.mkdtempSync(path.join(os.tmpdir(), "doc-map-births-"));
		git(["init", "-q", "-b", "main", "."]);
		git(["config", "user.email", "test@example.com"]);
		git(["config", "user.name", "test"]);
		cwd = process.cwd();
		process.chdir(repo);
	});

	afterEach(() => {
		process.chdir(cwd);
		fs.rmSync(repo, { recursive: true, force: true });
	});

	/* HEAD's copy of the map is newOverCapEntries' baseline. Null where HEAD
	 * holds none is pinned under newOverCapEntries below. */
	describe("the HEAD baseline", () => {
		it("reads HEAD's copy, not the working tree's", () => {
			commit([["B1", 10]], 1);
			const staged = doc([
				["B1", 10],
				["B2", 400],
			]);
			fs.writeFileSync(path.join(repo, mapPath), staged);
			expect(newOverCapEntries(staged, mapPath)).toEqual([
				{ id: "B2", words: 400, excess: 100 },
			]);
		});

		/*
		 * The fallback the pre-commit hook depends on: it hands the checker a
		 * `$(mktemp -d)` copy of the INDEX (mantahostels#1191), a path with no git identity,
		 * so `HEAD:<that>` resolves to nothing and the tracked path must answer.
		 */
		it("falls back to the tracked path for a copy git has never seen", () => {
			commit([["B1", 10]], 1);
			const copy = path.join(repo, "scratch-map.md");
			fs.writeFileSync(copy, doc([["B1", 900]]));
			expect(newOverCapEntries(doc([["B1", 900]]), copy)).toEqual([]);
		});
	});

	describe("newOverCapEntries", () => {
		it("is null where HEAD holds no copy, never an empty list", () => {
			expect(newOverCapEntries(doc([["B1", 900]]), mapPath)).toBeNull();
		});

		it("names an added entry over the cap, with its excess", () => {
			commit([["B1", 10]], 1);
			const result = newOverCapEntries(
				doc([
					["B1", 10],
					["B2", 400],
				]),
				mapPath,
			);
			expect(result).toEqual([{ id: "B2", words: 400, excess: 100 }]);
		});

		it("ignores an entry HEAD already holds, however far over the cap", () => {
			commit([["B1", 900]], 1);
			expect(newOverCapEntries(doc([["B1", 950]]), mapPath)).toEqual([]);
		});

		it("ignores an added entry at the cap exactly", () => {
			commit([["B1", 10]], 1);
			expect(
				newOverCapEntries(
					doc([
						["B1", 10],
						["B2", 300],
					]),
					mapPath,
				),
			).toEqual([]);
		});

		/*
		 * The merge case mantahostels#1384 named: once the author stages the resolution the
		 * index is no longer conflicted, so the check runs — and every entry
		 * arriving from the OTHER parent is absent from HEAD. Refusing there
		 * would refuse a merge for an entry somebody else already committed.
		 */
		it("does not read the other parent's entries as new, mid-merge", () => {
			commit([["B1", 10]], 1);
			git(["checkout", "-qb", "other"]);
			fs.writeFileSync(
				path.join(repo, mapPath),
				doc([
					["B1", 10],
					["B2", 900],
				]),
			);
			git(["add", "--", mapPath]);
			git(["commit", "-qm", "theirs adds a fat B2", "--", mapPath]);
			git(["checkout", "-q", "main"]);
			fs.writeFileSync(path.join(repo, "docs", "other.md"), "ours\n");
			git(["add", "--", "docs/other.md"]);
			git(["commit", "-qm", "ours", "--", "docs/other.md"]);
			git(["merge", "-q", "--no-commit", "--no-ff", "other"]);

			const merged = fs.readFileSync(path.join(repo, mapPath), "utf8");
			expect(newOverCapEntries(merged, mapPath)).toEqual([]);
		});

		it("orders by excess, heaviest first", () => {
			commit([["B1", 10]], 1);
			const result = newOverCapEntries(
				doc([
					["B1", 10],
					["B2", 400],
					["B3", 700],
				]),
				mapPath,
			);
			expect(result?.map((e: { id: string }) => e.id)).toEqual(["B3", "B2"]);
		});
	});

	/*
	 * mantahostels#2050 (the ticket that bounded an over-cap-by-ruling entry's growth). The
	 * marker disapplies the on-touch reduction, so before this nothing at all
	 * stood against an addition to one — assertion 14 refuses a birth only.
	 * Direction, never level: no second cap.
	 */
	describe("grownExemptEntries / droppedExemptionMarkers", () => {
		const exemptMarker =
			"- **Over cap by ruling (#1911):** every claim here is load-bearing — never cut one to reach 300; read the count from `overCapEntries()`.";
		/** The marker's own words count as prose, so a total budgets for them. */
		const markerWords = (exemptMarker.match(/\S+/g) || []).length;

		/** A §B holding one entry per `[id, proseWords, marked]` triple. */
		const markedDoc = (entries: [string, number, boolean][]) =>
			[
				"## Section B",
				"",
				...entries.flatMap(([id, n, marked]) => [
					`### ${id} · Figure ${id}`,
					"",
					"- **Owner:** x",
					"",
					...(marked ? [exemptMarker] : []),
					prose(marked ? n - markerWords : n),
					"",
				]),
			].join("\n");

		const commitMarked = (entries: [string, number, boolean][]) => {
			fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
			fs.writeFileSync(path.join(repo, mapPath), markedDoc(entries));
			git(["add", "--", mapPath]);
			git(["commit", "-qm", "marked map", "--", mapPath]);
		};

		it("is null where HEAD holds no copy, never an empty list", () => {
			expect(
				grownExemptEntries(markedDoc([["B1", 400, true]]), mapPath),
			).toBeNull();
		});

		it("names a marked entry that grew, with what it was and by how much", () => {
			commitMarked([["B1", 400, true]]);
			expect(
				grownExemptEntries(markedDoc([["B1", 420, true]]), mapPath),
			).toEqual([
				{ id: "B1", words: 420, was: 400, growth: 20, exemptedAt: 1911 },
			]);
		});

		/*
		 * Marked-only is the ruling's own scope (mantahostels#2050): an UNMARKED over-cap
		 * entry is already bound by the §B preamble's on-touch reduction, and
		 * widening to all 38 of them was left out of scope there.
		 */
		it("ignores growth in an over-cap entry carrying no marker", () => {
			commitMarked([["B1", 400, false]]);
			expect(
				grownExemptEntries(markedDoc([["B1", 420, false]]), mapPath),
			).toEqual([]);
		});

		it("ignores a marked entry that shrank", () => {
			commitMarked([["B1", 420, true]]);
			expect(
				grownExemptEntries(markedDoc([["B1", 400, true]]), mapPath),
			).toEqual([]);
		});

		it("ignores a marked entry that held steady", () => {
			commitMarked([["B1", 400, true]]);
			expect(
				grownExemptEntries(markedDoc([["B1", 400, true]]), mapPath),
			).toEqual([]);
		});

		/* A birth is assertion 14's, and has no baseline to grow from. */
		it("ignores a marked entry no committed rev holds", () => {
			commitMarked([["B1", 400, true]]);
			expect(
				grownExemptEntries(
					markedDoc([
						["B1", 400, true],
						["B2", 500, true],
					]),
					mapPath,
				),
			).toEqual([]);
		});

		/* A marked entry under the cap is assertion 21's stale marker. */
		it("ignores a marked entry that grew but is still under the cap", () => {
			commitMarked([["B1", 200, true]]);
			expect(
				grownExemptEntries(markedDoc([["B1", 250, true]]), mapPath),
			).toEqual([]);
		});

		/* Assertion 14's merge case, in this assertion's shape. */
		it("does not read the other parent's growth as this commit's, mid-merge", () => {
			commitMarked([["B1", 400, true]]);
			git(["checkout", "-qb", "other"]);
			fs.writeFileSync(
				path.join(repo, mapPath),
				markedDoc([["B1", 450, true]]),
			);
			git(["add", "--", mapPath]);
			git(["commit", "-qm", "theirs grows B1", "--", mapPath]);
			git(["checkout", "-q", "main"]);
			fs.writeFileSync(path.join(repo, "docs", "other.md"), "ours\n");
			git(["add", "--", "docs/other.md"]);
			git(["commit", "-qm", "ours", "--", "docs/other.md"]);
			git(["merge", "-q", "--no-commit", "--no-ff", "other"]);

			const merged = fs.readFileSync(path.join(repo, mapPath), "utf8");
			expect(grownExemptEntries(merged, mapPath)).toEqual([]);
		});

		/*
		 * mantahostels#2050's review: CHERRY_PICK_HEAD names the SOURCE commit, not a
		 * parent, so counting it in the maximum-count baseline would mask the
		 * growth the pick brings in.
		 */
		it("reads growth a cherry-pick brings in, never taking its source as baseline", () => {
			commitMarked([["B1", 400, true]]);
			git(["checkout", "-qb", "other"]);
			commitMarked([["B1", 450, true]]);
			const sha = git(["rev-parse", "HEAD"]).trim();
			git(["checkout", "-q", "main"]);
			commitMarked([["B1", 410, true]]);
			try {
				git(["cherry-pick", sha]);
			} catch {
				// A conflicting pick is what leaves CHERRY_PICK_HEAD set; with
				// `--no-commit` git 2.43 writes none, conflict or not.
			}
			expect(
				git(["rev-parse", "--verify", "--quiet", "CHERRY_PICK_HEAD"]).trim(),
			).toBe(sha);
			expect(
				grownExemptEntries(markedDoc([["B1", 450, true]]), mapPath),
			).toEqual([
				{ id: "B1", words: 450, was: 410, growth: 40, exemptedAt: 1911 },
			]);
		});

		/*
		 * The marker's own bullet counts as prose, so the commit that FIRST marks
		 * an undrainable entry — the act the §B preamble prescribes — would
		 * otherwise be warned for the marker it was told to write (mantahostels#2050 review).
		 */
		it("ignores the commit that first marks an unmarked over-cap entry", () => {
			commitMarked([["B1", 400, false]]);
			expect(
				grownExemptEntries(markedDoc([["B1", 400, true]]), mapPath),
			).toEqual([]);
		});

		it("still ignores a first marking that also grew the entry", () => {
			commitMarked([["B1", 400, false]]);
			expect(
				grownExemptEntries(markedDoc([["B1", 450, true]]), mapPath),
			).toEqual([]);
		});

		it("orders by growth, largest first", () => {
			commitMarked([
				["B1", 400, true],
				["B2", 400, true],
			]);
			const result = grownExemptEntries(
				markedDoc([
					["B1", 410, true],
					["B2", 450, true],
				]),
				mapPath,
			);
			expect(result?.map((e: { id: string }) => e.id)).toEqual(["B2", "B1"]);
		});

		/*
		 * mantahostels#2227 (the ticket that closed the defeat mantahostels#2050 recorded and left
		 * unrefused). The block above needs the marker on BOTH sides, so
		 * dropping it leaves that list; assertion 21 sees a missing marker only
		 * below the cap.
		 */
		describe("droppedExemptionMarkers", () => {
			it("is null where HEAD holds no copy, never an empty list", () => {
				expect(
					droppedExemptionMarkers(markedDoc([["B1", 400, false]]), mapPath),
				).toBeNull();
			});

			it("names an over-cap entry whose marker went, and the ruling it cited", () => {
				commitMarked([["B1", 400, true]]);
				expect(
					droppedExemptionMarkers(markedDoc([["B1", 400, false]]), mapPath),
				).toEqual([{ id: "B1", words: 400, exemptedAt: 1911 }]);
			});

			it("names it even where the entry did not grow or shrink", () => {
				commitMarked([["B1", 400, true]]);
				expect(
					droppedExemptionMarkers(markedDoc([["B1", 380, false]]), mapPath),
				).toEqual([{ id: "B1", words: 380, exemptedAt: 1911 }]);
			});

			/* The sanctioned drain: the §B preamble asks for exactly this. */
			it("ignores an entry drained under the cap in the same commit", () => {
				commitMarked([["B1", 400, true]]);
				expect(
					droppedExemptionMarkers(markedDoc([["B1", 250, false]]), mapPath),
				).toEqual([]);
			});

			it("ignores an over-cap entry no baseline rev marked", () => {
				commitMarked([["B1", 400, false]]);
				expect(
					droppedExemptionMarkers(markedDoc([["B1", 420, false]]), mapPath),
				).toEqual([]);
			});

			it("ignores an entry that still carries its marker", () => {
				commitMarked([["B1", 400, true]]);
				expect(
					droppedExemptionMarkers(markedDoc([["B1", 420, true]]), mapPath),
				).toEqual([]);
			});

			/*
			 * A downgraded marker reads as null to `entryExemptedAt`, so it is a
			 * drop here as well as assertion 23's malformed line — deliberate: 23
			 * says the line does not parse, this says the baseline went with it.
			 *
			 * The reported count falls by the marker's own words: indenting turns
			 * it into a sub-bullet, which `entryProseWords` does not count.
			 */
			it("reads an indented marker as dropped", () => {
				commitMarked([["B1", 400, true]]);
				const indented = markedDoc([["B1", 400, true]]).replace(
					exemptMarker,
					` ${exemptMarker}`,
				);
				expect(droppedExemptionMarkers(indented, mapPath)).toEqual([
					{ id: "B1", words: 400 - markerWords, exemptedAt: 1911 },
				]);
			});

			/*
			 * HEAD alone, and NOT assertion 22's `readParentRevs()` — the header's
			 * reason. Any-parent would charge every merge of a long-lived branch
			 * for a drop that happened, and was warned, on `main` weeks earlier.
			 * The price is this case: the drop the merge itself resolves is
			 * invisible.
			 */
			it("ignores a marker only the other parent carried, mid-merge", () => {
				commitMarked([["B1", 400, false]]);
				git(["checkout", "-qb", "other"]);
				fs.writeFileSync(
					path.join(repo, mapPath),
					markedDoc([["B1", 400, true]]),
				);
				git(["add", "--", mapPath]);
				git(["commit", "-qm", "theirs marks B1", "--", mapPath]);
				git(["checkout", "-q", "main"]);
				fs.writeFileSync(path.join(repo, "docs", "other.md"), "ours\n");
				git(["add", "--", "docs/other.md"]);
				git(["commit", "-qm", "ours", "--", "docs/other.md"]);
				git(["merge", "-q", "--no-commit", "--no-ff", "other"]);

				expect(
					droppedExemptionMarkers(markedDoc([["B1", 400, false]]), mapPath),
				).toEqual([]);
			});

			/* The cap test is `<=`, and the cap is the whole subject. */
			it("ignores an entry drained to exactly the cap", () => {
				commitMarked([["B1", 400, true]]);
				expect(
					droppedExemptionMarkers(
						markedDoc([["B1", PROSE_CAP_WORDS, false]]),
						mapPath,
					),
				).toEqual([]);
			});

			it("names an entry one word over the cap", () => {
				commitMarked([["B1", 400, true]]);
				expect(
					droppedExemptionMarkers(
						markedDoc([["B1", PROSE_CAP_WORDS + 1, false]]),
						mapPath,
					),
				).toEqual([{ id: "B1", words: PROSE_CAP_WORDS + 1, exemptedAt: 1911 }]);
			});

			/* A deletion, which the permanent-id rule governs. */
			it("ignores a marked entry the working text no longer holds", () => {
				commitMarked([
					["B1", 400, true],
					["B2", 400, true],
				]);
				expect(
					droppedExemptionMarkers(markedDoc([["B2", 400, true]]), mapPath),
				).toEqual([]);
			});

			/*
			 * The three-commit defeat end to end. Only the drop warns: the growth
			 * commit is unmarked on both sides, and the re-marking is exempt as a
			 * first marking, so each later step must be silent here AND in
			 * `grownExemptEntries`.
			 */
			it("warns on the drop alone across the drop / grow / re-mark sequence", () => {
				commitMarked([["B1", 400, true]]);
				expect(
					droppedExemptionMarkers(markedDoc([["B1", 400, false]]), mapPath),
				).toHaveLength(1);

				commitMarked([["B1", 400, false]]);
				const grown = markedDoc([["B1", 600, false]]);
				expect(droppedExemptionMarkers(grown, mapPath)).toEqual([]);
				expect(grownExemptEntries(grown, mapPath)).toEqual([]);

				commitMarked([["B1", 600, false]]);
				const reMarked = markedDoc([["B1", 600, true]]);
				expect(droppedExemptionMarkers(reMarked, mapPath)).toEqual([]);
				expect(grownExemptEntries(reMarked, mapPath)).toEqual([]);
			});

			it("orders by size, largest first", () => {
				commitMarked([
					["B1", 400, true],
					["B2", 500, true],
				]);
				const result = droppedExemptionMarkers(
					markedDoc([
						["B1", 400, false],
						["B2", 500, false],
					]),
					mapPath,
				);
				expect(result?.map((e: { id: string }) => e.id)).toEqual(["B2", "B1"]);
			});
		});
	});

	describe("readSectionBBirths", () => {
		it("is null outside a git repo", () => {
			process.chdir(cwd);
			const outside = fs.mkdtempSync(path.join(os.tmpdir(), "no-births-"));
			process.chdir(outside);
			try {
				expect(readSectionBBirths(mapPath)).toBeNull();
			} finally {
				process.chdir(cwd);
				fs.rmSync(outside, { recursive: true, force: true });
			}
		});

		it("measures each entry at its BIRTH commit, not at HEAD", () => {
			commit([["B1", 900]], 3);
			commit([["B1", 20]], 1);

			const result = readSectionBBirths(mapPath);
			expect(result?.born).toEqual([
				{ id: "B1", words: 900, sha: expect.any(String) },
			]);
		});

		it("ignores a birth older than the window", () => {
			commit([["B1", 900]], 30);
			commit(
				[
					["B1", 900],
					["B2", 400],
				],
				1,
			);

			expect(
				readSectionBBirths(mapPath)?.born.map((b: { id: string }) => b.id),
			).toEqual(["B2"]);
		});

		/*
		 * The reason the cheap `git log -p` pass alone is wrong: moving an entry
		 * adds the same `+### B<n>` line a birth does — which is exactly what
		 * move-stray-doc-map-entries.js does to a stray. The parent-blob check is
		 * what tells them apart.
		 */
		it("does not read a MOVED entry as a birth", () => {
			commit(
				[
					["B1", 10],
					["B2", 400],
				],
				30,
			);
			commit(
				[
					["B2", 400],
					["B1", 10],
				],
				1,
			);

			expect(readSectionBBirths(mapPath)?.born).toEqual([]);
		});

		it("reports the window it measured over", () => {
			commit([["B1", 10]], 1);
			expect(readSectionBBirths(mapPath)?.days).toBe(7);
		});

		it("honours a window the caller narrows", () => {
			commit([["B1", 10]], 5);
			commit(
				[
					["B1", 10],
					["B2", 20],
				],
				1,
			);

			const day2 = readSectionBBirths(mapPath, 2 * 24 * 60 * 60 * 1000);
			expect(day2?.days).toBe(2);
			expect(day2?.born.map((b: { id: string }) => b.id)).toEqual(["B2"]);
		});
	});
});

/* §A rendering (mantahostels#1863). check-doc-map.js's assertion 17 gates the committed
 * map against exactly this output. */
describe("Section A rendering", () => {
	const entry = (over: Record<string, unknown> = {}) => ({
		section: "Research runs",
		class: "free-edit",
		classQualifier: null,
		role: null,
		route: null,
		consumes: null,
		...over,
	});

	/** A doc map whose §A holds one register table under one heading. */
	const map = (rows: string[], section = "Research runs") =>
		[
			"# Doc map",
			"",
			"v1.0 · 5 August 2026",
			"",
			"## Section A — document register",
			"",
			"Preamble prose that the generator must not touch.",
			"",
			`### ${section}`,
			"",
			"Subsection prose, also untouched.",
			"",
			REGISTER_HEADER,
			REGISTER_SEP,
			...rows,
			"",
			"## Section B — figure registry",
			"",
		].join("\n");

	/** The §A row `renderSectionA` renders for `p` alone in a table subsection. */
	const renderedRow = (p: string, e: Record<string, unknown>): string =>
		renderSectionA(map([], "Book notes"), {
			[p]: { ...e, section: "Book notes" },
		})
			.split("\n")
			.find((l: string) => l.startsWith(`| \`${p}\` |`)) ??
		expect.fail(`no rendered row for ${p}`);

	/** The Role cell `p` renders with when its sidecar entry sets none. */
	const defaultRole = (p: string) => renderedRow(p, entry()).split(" | ")[1];

	describe("the default Role", () => {
		it("names a research note by its stem and its directory's kind", () => {
			expect(defaultRole("docs/research/foo-bar.md")).toBe(
				"Foo bar — research run",
			);
		});

		it("takes a SKILL.md's title from its directory, not its filename", () => {
			// Every one of them is called SKILL.md, so the stem alone renders
			// dozens of identical rows.
			expect(defaultRole(".claude/skills/tdd/SKILL.md")).toBe("Tdd — skill");
		});

		it("leaves an acronym-named root contract spelled as its filename", () => {
			expect(defaultRole("CLAUDE.md")).toBe("CLAUDE.md");
		});

		it("says what a wildcard covers", () => {
			expect(defaultRole("docs/adr/*")).toBe(
				"Every file under `docs/adr/` — architecture decision records",
			);
		});

		it("gives a manual-sync report or proposal under docs/archive/ its artefact noun (#414)", () => {
			expect(defaultRole("docs/archive/sync-reports/manual-sync-x.md")).toBe(
				"Manual sync x — `manual-sync` artefact",
			);
			expect(defaultRole("docs/archive/sync-proposals/manual-sync-x.md")).toBe(
				"Manual sync x — `manual-sync` artefact",
			);
		});

		it("falls back to the extension where no directory places the file", () => {
			expect(defaultRole("docs/x/thing.csv")).toBe("Thing — data table");
		});

		it("gives a .md outside every known directory no kind clause at all", () => {
			expect(defaultRole("docs/lean-canvas.md")).toBe("Lean canvas");
		});
	});

	describe("a rendered row", () => {
		it("defaults Role, Update route and Consumes from the class", () => {
			expect(renderedRow("docs/research/foo.md", entry())).toBe(
				"| `docs/research/foo.md` | Foo — research run | " +
					"`free-edit` | Direct | — |",
			);
		});

		it("prefers every override the sidecar sets", () => {
			expect(
				renderedRow(
					"docs/research/foo.md",
					entry({
						role: "⚠ superseded by bar.md",
						route: "Never edit — it predates the result",
						consumes: [
							{ kind: "issue", ref: "1" },
							{ kind: "issue", ref: "2" },
						],
					}),
				),
			).toBe(
				"| `docs/research/foo.md` | ⚠ superseded by bar.md | " +
					"`free-edit` | Never edit — it predates the result | " +
					"#1 · #2 |",
			);
		});

		it("names an adopter's own folder only through its sidecar role (#446)", () => {
			// mantahostels renamed docs/brand_assets/ to docs/brand-assets/; a
			// core-held noun for either spelling drifts the adopter's §A.
			expect(defaultRole("docs/brand-assets/*")).toBe(
				"Every file under `docs/brand-assets/`",
			);
			expect(defaultRole("docs/brand_assets/*")).toBe(
				"Every file under `docs/brand_assets/`",
			);
			const role = "Every file under `docs/brand-assets/` — brand assets";
			expect(
				renderedRow(
					"docs/brand-assets/*",
					entry({ class: "binary-asset", role }),
				),
			).toBe(
				`| \`docs/brand-assets/*\` | ${role} | \`binary-asset\` | Replace the file | — |`,
			);
		});

		it("gives mantahostels' compliance and notes folders no core noun (#454)", () => {
			expect(defaultRole("docs/compliance/adequacy-singapore.md")).toBe(
				"Adequacy singapore",
			);
			expect(defaultRole("docs/notes/momtest.md")).toBe("Momtest");
			expect(defaultRole("docs/compliance/*")).toBe(
				"Every file under `docs/compliance/`",
			);
		});

		it("renders a dual-class judgement's qualifier beside its class", () => {
			expect(
				renderedRow(
					"AGENTS.md",
					entry({
						class: "source-of-truth",
						classQualifier: "(for code rules) · consumer (for invariants)",
					}),
				),
			).toContain(
				"| `source-of-truth` (for code rules) · consumer (for invariants) |",
			);
		});

		it("escapes a `|` inside a class qualifier, which §A invites (mantahostels#2507)", () => {
			const line = renderedRow(
				"docs/research/foo.md",
				entry({ classQualifier: "· restates `a | b`" }),
			);
			expect(line).toContain("`a \\| b`");
			expect(line.split(/(?<!\\)\|/)).toHaveLength(7);
		});

		it("escapes a `|` inside a cell, which would otherwise split the row (mantahostels#1863)", () => {
			const line = renderedRow(
				"docs/research/foo.md",
				entry({ role: "it split pipelines on a bare `|`" }),
			);
			expect(line).toContain("bare `\\|`");
			expect(line.split(/(?<!\\)\|/)).toHaveLength(7);
		});

		it("escapes a `\\` before a `|`, which would otherwise unescape the break (#3364)", () => {
			const line = renderedRow(
				"docs/research/foo.md",
				entry({ role: "quotes `a \\| b`" }),
			);
			expect(line).toContain("`a \\\\\\| b`");
			// A break is a `|` behind an even run of `\`.
			expect(line.match(/(?<!\\)(?:\\\\)*\|/g)).toHaveLength(6);
		});

		/* mantahostels#2419: `consumes` typed as a reference list. */
		it("renders each kind in the form §A prints it, joined ` · `", () => {
			expect(
				renderedRow(
					"docs/research/foo.md",
					entry({
						consumes: [
							{ kind: "path", ref: "scripts/toggle-mode.sh" },
							{ kind: "glob", ref: "docs/research/*" },
							{ kind: "figure", ref: "B68" },
							{ kind: "issue", ref: "457" },
							{ kind: "external", ref: "~/.claude/statusline.sh" },
							{ kind: "note", ref: "process.execPath" },
						],
					}),
				),
			).toContain(
				"| `scripts/toggle-mode.sh` · `docs/research/*` · §B68 · #457 · " +
					"`~/.claude/statusline.sh` · `process.execPath` |",
			);
		});

		it("suffixes a reference's gloss, which is why the edge exists", () => {
			expect(
				renderedRow(
					"docs/research/foo.md",
					entry({
						consumes: [
							{ kind: "path", ref: "a.md", gloss: "the loop it delegates to" },
							{ kind: "figure", ref: "B7" },
						],
					}),
				),
			).toContain("| `a.md` (the loop it delegates to) · §B7 |");
		});

		it("escapes a `|` inside a composed Consumes cell (mantahostels#1863)", () => {
			const line = renderedRow(
				"docs/research/foo.md",
				entry({
					consumes: [{ kind: "note", ref: "a | b", gloss: "split | here" }],
				}),
			);
			expect(line).toContain("`a \\| b` (split \\| here)");
			expect(line.split(/(?<!\\)\|/)).toHaveLength(7);
		});

		it("renders a null Consumes as the em dash, as 63 rows rely on", () => {
			expect(
				renderedRow("docs/research/foo.md", entry({ consumes: null })),
			).toMatch(/ \| — \|$/);
		});
	});

	describe("pair-scope prefixes (mantahostels#2647)", () => {
		const cell = (consumes: unknown[]) => ({
			"docs/research/foo.md": { class: "hand-written", consumes },
		});

		it("accepts a prefix naming the reference immediately before it", () => {
			expect(
				pairScopeFaults(
					cell([
						{ kind: "figure", ref: "B243" },
						{
							kind: "issue",
							ref: "1564",
							gloss: "with §B243: the pair this covers",
						},
					]),
				),
			).toEqual([]);
		});

		it("reports a prefix naming a reference that is not the one before it", () => {
			const faults = pairScopeFaults(
				cell([
					{ kind: "figure", ref: "B243" },
					{ kind: "issue", ref: "99" },
					{
						kind: "issue",
						ref: "1564",
						gloss: "with §B243: the pair this covers",
					},
				]),
			);
			expect(faults).toHaveLength(1);
			expect(faults[0].ref).toBe("#1564");
			expect(faults[0].why).toContain("the reference before it is #99");
		});

		it("reports a prefix on the cell's first reference, which has no neighbour", () => {
			const faults = pairScopeFaults(
				cell([
					{ kind: "issue", ref: "1564", gloss: "with §B243: nothing precedes" },
				]),
			);
			expect(faults).toHaveLength(1);
			expect(faults[0].why).toContain("nothing precedes it");
		});

		it("compares against the printed form, so a path prefix takes its backticks", () => {
			expect(
				pairScopeFaults(
					cell([
						{ kind: "path", ref: "a.md" },
						{ kind: "path", ref: "b.md", gloss: "with `a.md`: the pair" },
					]),
				),
			).toEqual([]);
			expect(
				pairScopeFaults(
					cell([
						{ kind: "figure", ref: "B1" },
						{ kind: "path", ref: "b.md", gloss: "with `B1`: the pair" },
					]),
				),
			).toHaveLength(1);
		});

		/* The capture is the three printed shapes, so ordinary prose opening
		 * `with ` is not faulted for scoping back to a word (mantahostels#2647 review). */
		it("reads prose opening `with ` as prose, not a malformed prefix", () => {
			expect(
				pairScopeFaults(
					cell([
						{ kind: "figure", ref: "B1" },
						{
							kind: "path",
							ref: "b.md",
							gloss: "with care: the caveat it carries",
						},
					]),
				),
			).toEqual([]);
		});

		/* Shape is assertion 25's, and reporting it here too prints `undefined`. */
		it("leaves an element of an unknown kind to the shape assertion", () => {
			expect(
				pairScopeFaults(
					cell([
						{ kind: "figure", ref: "B1" },
						{ kind: "card", ref: "x", gloss: "with §B9: the pair" },
					]),
				),
			).toEqual([]);
		});

		it("leaves a plural-worded gloss alone — it carries its own scope", () => {
			expect(
				pairScopeFaults(
					cell([
						{ kind: "issue", ref: "467" },
						{ kind: "issue", ref: "557", gloss: "the severance rulings" },
					]),
				),
			).toEqual([]);
		});

		it("reads the prefix only at the gloss's head, never mid-sentence", () => {
			/** `gloss`'s faults as the cell's first reference, where any prefix is one. */
			const firstFaults = (gloss?: unknown) =>
				pairScopeFaults(cell([{ kind: "issue", ref: "1564", gloss }]));
			expect(firstFaults("the rule it works with §B243: not a prefix")).toEqual(
				[],
			);
			expect(firstFaults("with §B243: a prefix")[0].why).toMatch(
				/^scopes back to §B243,/,
			);
			expect(firstFaults(undefined)).toEqual([]);
		});

		it("skips a cell whose consumes is not a list, which assertion 25 owns", () => {
			expect(
				pairScopeFaults({
					"docs/research/foo.md": { class: "hand-written", consumes: "legacy" },
				}),
			).toEqual([]);
		});
	});

	describe("rendering §A into the map", () => {
		/* `Research runs` renders as a list (mantahostels#2743), so the table's own
		 * behaviour is asserted through a subsection that is not in
		 * LIST_SECTIONS. */
		const tableSection = "Book notes";
		const tableMap = (rows: string[]) => map(rows, tableSection);
		const tableEntry = (over: Record<string, unknown> = {}) =>
			entry({ section: tableSection, ...over });

		it("replaces the table's rows and leaves every other byte alone", () => {
			const before = tableMap([
				"| `docs/notes/old.md` | hand-written | x | y | z |",
			]);
			const after = renderSectionA(before, {
				"docs/notes/foo.md": tableEntry(),
			});
			expect(after).toContain(
				"Preamble prose that the generator must not touch.",
			);
			expect(after).toContain("Subsection prose, also untouched.");
			expect(after).toContain("| `docs/notes/foo.md` |");
			expect(after).not.toContain("hand-written");
		});

		it("is idempotent", () => {
			const sidecar = {
				"docs/notes/b.md": tableEntry(),
				"docs/notes/a.md": tableEntry(),
			};
			const once = renderSectionA(tableMap([]), sidecar);
			expect(renderSectionA(once, sidecar)).toBe(once);
		});

		it("sorts rows by path, so two sessions' registrations diff readably", () => {
			const out = renderSectionA(tableMap([]), {
				"docs/notes/z.md": tableEntry(),
				"docs/notes/a.md": tableEntry(),
			});
			expect(out.indexOf("`docs/notes/a.md`")).toBeLessThan(
				out.indexOf("`docs/notes/z.md`"),
			);
		});

		it("swallows a blank line a row run is broken by, which ends the table in GFM", () => {
			const broken = tableMap([
				"| `docs/notes/a.md` | x | y | z | w |",
				"",
				"| `docs/notes/b.md` | x | y | z | w |",
			]);
			const out = renderSectionA(broken, {
				"docs/notes/a.md": tableEntry(),
				"docs/notes/b.md": tableEntry(),
			});
			const rows = out.split("\n").filter((l: string) => l.startsWith("| `"));
			expect(rows).toHaveLength(2);
		});

		it("gives a section §A has no heading for one, after the last table", () => {
			const out = renderSectionA(tableMap([]), {
				"docs/notes/a.md": tableEntry(),
				"docs/other/b.md": tableEntry({ section: "Sync artefacts" }),
			});
			expect(out).toContain("### Sync artefacts");
			expect(out.indexOf("### Sync artefacts")).toBeLessThan(
				out.indexOf("## Section B"),
			);
		});

		it("leaves a §A carrying no register table untouched", () => {
			const noTable =
				"# Doc map\n\n## Section A\n\nprose only\n\n## Section B\n";
			expect(renderSectionA(noTable, { "docs/research/a.md": entry() })).toBe(
				noTable,
			);
		});
	});

	/* mantahostels#2743. `Research runs` renders one path per line between two markers, its
	 * one class stated once on the opening marker, and Role, Update route and
	 * Consumes left in the sidecar. */
	describe("rendering a LIST_SECTIONS subsection", () => {
		it("renders paths as a marked list carrying the class once", () => {
			const out = renderSectionA(
				map(["| `docs/research/old.md` | long role prose | x | y | z |"]),
				{ "docs/research/a.md": entry(), "docs/research/b.md": entry() },
			);
			expect(out).toContain("<!-- register-list: free-edit -->");
			expect(out).toContain("- `docs/research/a.md`");
			expect(out).toContain("- `docs/research/b.md`");
			expect(out).toContain("<!-- /register-list -->");
			expect(out).not.toContain(REGISTER_HEADER);
			expect(out).not.toContain("long role prose");
		});

		it("drops the role, route and consumes a table row would have carried", () => {
			const out = renderSectionA(map([]), {
				"docs/research/a.md": entry({
					role: "an abstract nobody looks up",
					route: "Edit through the research skill",
					consumes: [{ kind: "issue", ref: "2743" }],
				}),
			});
			expect(out).not.toContain("an abstract nobody looks up");
			expect(out).not.toContain("Edit through the research skill");
		});

		it("is idempotent, so a second generator run makes no diff", () => {
			const sidecar = {
				"docs/research/b.md": entry(),
				"docs/research/a.md": entry(),
			};
			const once = renderSectionA(map([]), sidecar);
			expect(renderSectionA(once, sidecar)).toBe(once);
		});

		it("re-renders an already-listed subsection, picking up a new path", () => {
			const sidecar = { "docs/research/a.md": entry() };
			const once = renderSectionA(map([]), sidecar);
			const twice = renderSectionA(once, {
				...sidecar,
				"docs/research/b.md": entry(),
			});
			expect(twice).toContain("- `docs/research/b.md`");
			expect(twice.match(/<!-- register-list:/g)).toHaveLength(1);
			expect(twice).toContain("Subsection prose, also untouched.");
		});

		it("falls back to the table where the rows disagree on a class", () => {
			const out = renderSectionA(map([]), {
				"docs/research/a.md": entry(),
				"docs/research/b.md": entry({ class: "hand-written" }),
			});
			expect(out).toContain(REGISTER_HEADER);
			expect(out).not.toContain("<!-- register-list:");
		});

		it("keeps every listed path and its class readable to the parser", () => {
			const out = renderSectionA(map([]), {
				"docs/research/a.md": entry(),
				"docs/research/b.md": entry(),
			});
			expect(registerPaths(out)).toEqual([
				"docs/research/a.md",
				"docs/research/b.md",
			]);
			expect(parseRegister(out).map((r: { cls: string }) => r.cls)).toEqual([
				"free-edit",
				"free-edit",
			]);
		});

		it("keeps a listed binary-asset file exempt from the wording scans", () => {
			const out = renderSectionA(map([]), {
				"docs/research/a.md": entry({ class: "binary-asset" }),
			});
			const { files, exemptCount } = scopeIn({
				text: out,
				files: ["docs/research/a.md"],
			});
			expect(files).toEqual([]);
			expect(exemptCount).toBe(1);
		});

		it("reads a path only between the markers, never a bullet in prose", () => {
			const stray = [
				"# Doc map",
				"",
				"## Section A",
				"",
				"- `docs/research/loose.md`",
				"",
				"## Section B",
				"",
			].join("\n");
			expect(registerPaths(stray)).toEqual([]);
		});

		/* An unclosed marker is bounded at the next heading, in the renderer and
		 * in the parser alike. */
		describe("an unclosed register-list marker", () => {
			const unclosed = [
				"# Doc map",
				"",
				"## Section A — document register",
				"",
				"### Research runs",
				"",
				"<!-- register-list: free-edit -->",
				"- `docs/research/a.md`",
				"",
				"### Book notes",
				"",
				"Book notes prose that must survive.",
				"",
				REGISTER_HEADER,
				REGISTER_SEP,
				"| `docs/notes/b.md` | r | `hand-written` | Direct | — |",
				"",
				"## Section B — figure registry",
				"",
			].join("\n");

			it("leaves the later subsection's prose, heading and rows standing", () => {
				const out = renderSectionA(unclosed, {
					"docs/research/a.md": entry(),
					"docs/notes/b.md": entry({
						section: "Book notes",
						class: "hand-written",
					}),
				});
				expect(out).toContain("### Book notes");
				expect(out).toContain("Book notes prose that must survive.");
				expect(out).toContain("| `docs/notes/b.md` |");
			});

			it("does not drop the later subsection's rows from the register", () => {
				expect(registerPaths(unclosed)).toEqual([
					"docs/research/a.md",
					"docs/notes/b.md",
				]);
			});
		});

		it("swallows a second list under one heading, its paths having moved up", () => {
			const twoLists = map([]).replace(
				`${REGISTER_HEADER}\n${REGISTER_SEP}`,
				[
					"<!-- register-list: free-edit -->",
					"- `docs/research/a.md`",
					"<!-- /register-list -->",
					"",
					"<!-- register-list: free-edit -->",
					"- `docs/research/b.md`",
					"<!-- /register-list -->",
				].join("\n"),
			);
			const out = renderSectionA(twoLists, {
				"docs/research/a.md": entry(),
				"docs/research/b.md": entry(),
			});
			expect(out.match(/<!-- register-list:/g)).toHaveLength(1);
			expect(out).toContain("- `docs/research/a.md`");
			expect(out).toContain("- `docs/research/b.md`");
		});

		it("re-renders a list under a heading no longer in LIST_SECTIONS as a table", () => {
			const listed = renderSectionA(map([]), { "docs/research/a.md": entry() });
			const moved = listed.replace("### Research runs", "### Book notes");
			const out = renderSectionA(moved, {
				"docs/research/a.md": entry({ section: "Book notes" }),
			});
			expect(out).toContain(REGISTER_HEADER);
			expect(out).not.toContain("<!-- register-list:");
		});

		it("is idempotent on the mixed-class fallback too", () => {
			const sidecar = {
				"docs/research/a.md": entry(),
				"docs/research/b.md": entry({ class: "hand-written" }),
			};
			const once = renderSectionA(map([]), sidecar);
			expect(renderSectionA(once, sidecar)).toBe(once);
		});

		it("falls back to the table on an empty class, which no marker can carry", () => {
			const out = renderSectionA(map([]), {
				"docs/research/a.md": entry({ class: "" }),
			});
			expect(out).toContain(REGISTER_HEADER);
			expect(out).not.toContain("<!-- register-list:");
		});

		it("names the path a list line registers, and nothing else", () => {
			expect(registerListPath("- `docs/research/a.md`")).toBe(
				"docs/research/a.md",
			);
			expect(registerListPath("- `not-a-path`")).toBe(null);
			expect(registerListPath("- some prose")).toBe(null);
			expect(registerListPath("| `docs/research/a.md` | x |")).toBe(null);
		});
	});

	describe("the role word cap", () => {
		it("names an override over the cap, with its excess", () => {
			const over = Array.from(
				{ length: ROLE_CAP_WORDS + 5 },
				(_, i) => `w${i}`,
			).join(" ");
			expect(
				overCapRoles({ "docs/research/a.md": entry({ role: over }) }),
			).toEqual([
				{ path: "docs/research/a.md", words: ROLE_CAP_WORDS + 5, excess: 5 },
			]);
		});

		it("passes an override at exactly the cap, and a null one", () => {
			const at = Array.from({ length: ROLE_CAP_WORDS }, (_, i) => `w${i}`).join(
				" ",
			);
			expect(
				overCapRoles({
					"docs/research/a.md": entry({ role: at }),
					"docs/research/b.md": entry(),
				}),
			).toEqual([]);
		});
	});

	describe("the sidecar loader", () => {
		let dir: string;
		beforeEach(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-classes-"));
		});
		afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

		const writeRawSidecar = (data: unknown) => {
			const f = path.join(dir, "doc-map-classes.json");
			fs.writeFileSync(f, JSON.stringify(data));
			return f;
		};

		it("loads a well-formed sidecar", () => {
			const f = writeRawSidecar({ "docs/research/a.md": entry() });
			expect(Object.keys(loadDocClasses(f))).toEqual(["docs/research/a.md"]);
		});

		it("refuses a class outside the six documented tokens", () => {
			const f = writeRawSidecar({
				"docs/research/a.md": entry({ class: "stable" }),
			});
			expect(() => loadDocClasses(f)).toThrow(/not one of/);
		});

		it("refuses an entry with a key nothing renders", () => {
			const f = writeRawSidecar({
				"docs/research/a.md": { ...entry(), authority: "x" },
			});
			expect(() => loadDocClasses(f)).toThrow(/authority/);
		});

		it("refuses an empty section, which would render a headingless row", () => {
			const f = writeRawSidecar({
				"docs/research/a.md": entry({ section: "" }),
			});
			expect(() => loadDocClasses(f)).toThrow(/section/);
		});

		/* `consumes` takes two states — null and the typed reference list
		 * (mantahostels#2419, narrowed from three at mantahostels#2534). */
		it("takes a typed reference list and a null, and nothing else", () => {
			expect(() =>
				loadDocClasses(
					writeRawSidecar({
						"docs/research/b.md": entry({
							consumes: [{ kind: "path", ref: "a.md", gloss: "why" }],
						}),
						"docs/research/c.md": entry({ consumes: null }),
					}),
				),
			).not.toThrow();
		});

		it("refuses a string, naming the reference list shape it takes", () => {
			const f = writeRawSidecar({
				"docs/research/a.md": entry({ consumes: "`b.md` (a gloss)" }),
			});
			expect(() => loadDocClasses(f)).toThrow(
				/takes a list of \{ kind, ref, gloss\? \} references/,
			);
		});

		it("refuses a kind outside the six", () => {
			const f = writeRawSidecar({
				"docs/research/a.md": entry({
					consumes: [{ kind: "card", ref: "a.md" }],
				}),
			});
			expect(() => loadDocClasses(f)).toThrow(/not one of/);
		});

		it("refuses a reference carrying a key nothing renders", () => {
			const f = writeRawSidecar({
				"docs/research/a.md": entry({
					consumes: [{ kind: "path", ref: "a.md", why: "x" }],
				}),
			});
			expect(() => loadDocClasses(f)).toThrow(/why/);
		});

		it("refuses a reference with no `ref`, and one with an empty gloss", () => {
			expect(() =>
				loadDocClasses(
					writeRawSidecar({
						"docs/research/a.md": entry({ consumes: [{ kind: "path" }] }),
					}),
				),
			).toThrow(/ref/);
			expect(() =>
				loadDocClasses(
					writeRawSidecar({
						"docs/research/a.md": entry({
							consumes: [{ kind: "path", ref: "a.md", gloss: "" }],
						}),
					}),
				),
			).toThrow(/gloss/);
		});

		/* "No override" stays exactly one state (`null`), never two. */
		it("refuses a `consumes` present but empty", () => {
			const f = writeRawSidecar({
				"docs/research/a.md": entry({ consumes: [] }),
			});
			expect(() => loadDocClasses(f)).toThrow(/non-empty array/);
		});
	});
});

describe("unresolvedSectionRefs (#805)", () => {
	const mapText = [
		"# Map",
		"",
		"## Section A — register",
		"",
		"Rows are generated.",
		"",
		"### Repo-root contracts",
		"",
		"## Section B — registry",
		"",
		"None registered.",
		"",
		"### B71 · A figure",
		"",
		"## Capture and placement — where a fact goes",
		"",
		"### 5. Sheds paid",
		"",
		"## The propagation pass",
		"",
		"### 5. One adversarial subagent",
		"",
		"### 6. Audit trail",
		"",
		"```",
		"## Fenced heading",
		"```",
	].join("\n");
	const refs = (text: string) =>
		unresolvedSectionRefs(mapText, [{ file: "f.md", text }]).map(
			(r: { ref: string }) => r.ref,
		);

	it("names a section by letter, number, short title or entry id", () => {
		expect(
			refs(
				[
					"`docs/doc-map.md` §A to confirm",
					"docs/doc-map.md §B entry",
					"doc-map.md §B's word budget",
					"docs/doc-map.md §Capture and placement §5's ripeness test",
					"docs/doc-map.md §6 audit trail",
					"docs/doc-map.md §Capture and placement states it",
					"docs/doc-map.md §B71 holds it",
				].join("\n"),
			),
		).toEqual([]);
	});

	it("refuses a name no heading carries, and a fenced heading", () => {
		expect(
			refs(
				"docs/doc-map.md §The handover pass in full\ndocs/doc-map.md §Fenced heading\ndocs/doc-map.md §B72 too",
			),
		).toEqual(["§The handover pass in full", "§Fenced heading", "§B72 too"]);
	});

	it("refuses a bare number two headings share, and a number its section lacks", () => {
		expect(
			refs(
				"docs/doc-map.md §5's ripeness test\ndocs/doc-map.md §Capture and placement §6 too",
			),
		).toEqual(["§5's ripeness test", "§Capture and placement §6 too"]);
	});

	it("requires prose under the heading for a preamble reference", () => {
		expect(
			refs(
				"docs/doc-map.md §A's preamble\ndocs/doc-map.md §B preamble, which owns it",
			),
		).toEqual(["§B preamble, which owns it"]);
	});

	it("passes a placeholder and a name wrapped at its line's end", () => {
		expect(
			refs(
				[
					"(`docs/doc-map.md` §B<n> …)",
					"see docs/doc-map.md §Capture and",
					"placement for it",
					'"Move it in docs/doc-map.md §Capture and\\n" +',
				].join("\n"),
			),
		).toEqual([]);
	});

	it("reads no other repo's or template's doc-map", () => {
		expect(
			refs(
				"scripts/templates/adopter/doc-map.md §Nope\nmantahostels:docs/doc-map.md §Nope",
			),
		).toEqual([]);
	});

	it("reports a repeated reference once per file", () => {
		expect(refs("docs/doc-map.md §Nope\ndocs/doc-map.md §Nope")).toEqual([
			"§Nope",
		]);
	});
});
