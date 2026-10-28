// @vitest-environment node
/*
 * The region parser's own suite (mantahostels#970): how docs/doc-map.md
 * splits into claimable regions, and which region an edit's anchor lands in.
 *
 * Everything here is pure text in, regions out — the claim machinery that
 * consumes it is proved in arbiter-store.test.ts and session-arbiter.test.ts.
 *
 * lib/file-claim.js claims docs/doc-map.md per region on these answers, so
 * a loosened case lets two sessions write one entry uncontended, or folds
 * entries back into one shared region and the whole-file queue mantahostels#848
 * set out to end.
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
	registerRow,
	syntheticDocMap,
	syntheticPaths,
	syntheticSidecar,
} from "./doc-map-testkit";

// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const regions: any = createRequire(__filename)("./doc-map-regions.js");

const doc = (...lines: string[]) => lines.join("\n");

const MAP = doc(
	"# MantaHostels document map",
	"",
	"v3.9 · 21 August 2026",
	"",
	"> A preamble.",
	"",
	"## Authority classes",
	"",
	"Prose about classes.",
	"",
	"## Section A — document register",
	"",
	"Prose before the first row.",
	"",
	"### Repo-root contracts",
	"",
	"| Path | Role | Class | Update route | Consumes |",
	"|---|---|---|---|---|",
	"| `CLAUDE.md` | Entry contract | `source-of-truth` | Direct | — |",
	"| `docs/environment.md` | The dev machine | `source-of-truth` | Direct | — |",
	"",
	"| a | b |",
	"",
	"## Section B — load-bearing figure registry",
	"",
	"Preamble to section B.",
	"",
	"### B1 · The first figure",
	"",
	"Body of B1.",
	"",
	"### B2 · The second figure",
	"",
	"Body of B2.",
	"",
	"## Section C — question routes",
	"",
	"Routes.",
	"",
);

const ids = (text: string): string[] =>
	regions.parseRegions(text).map((r: { id: string }) => r.id);

describe("parseRegions", () => {
	it("gives every §B entry its own region, and holds §A in one", () => {
		expect(ids(MAP)).toEqual([
			"head",
			"stamp",
			"head",
			"authority-classes",
			"section-a",
			"section-b-preamble",
			"B1",
			"B2",
			"section-c",
		]);
	});

	it("tiles the document with no gap and no overlap", () => {
		const parsed = regions.parseRegions(MAP);
		expect(parsed[0].start).toBe(0);
		for (let i = 1; i < parsed.length; i++)
			expect(parsed[i].start).toBe(parsed[i - 1].end);
		expect(parsed.at(-1).end).toBe(MAP.length);
	});

	it("holds §A's rows in `section-a` with its headings and prose", () => {
		const sectionA = regions.parseRegionText(MAP, "section-a");
		expect(sectionA).toContain("Prose before the first row.");
		expect(sectionA).toContain("### Repo-root contracts");
		expect(sectionA).toContain("| Path | Role |");
		expect(sectionA).toContain("|---|---|---|---|---|");
		expect(sectionA).toContain("| a | b |");
		// The rows, which had regions of their own until mantahostels#2422.
		expect(sectionA).toContain("Entry contract");
		expect(sectionA).toContain("The dev machine");
	});

	it("mints no `A:<path>` id on the map, in §A or out of it (mantahostels#2422)", () => {
		// The Authority-classes table above §A quotes the same paths §A's rows do,
		// so a parser that split either would mint the id twice over.
		const text = MAP.replace(
			"Prose about classes.",
			"| `CLAUDE.md` | not a register row |",
		);
		expect(ids(text).filter((id: string) => id.startsWith("A:"))).toEqual([]);
		expect(regions.parseRegionText(text, "authority-classes")).toContain(
			"not a register row",
		);
	});

	it("gives the version stamp a region of its own", () => {
		// Every editing session rewrites it, so leaving it in `head` would hand
		// every session one shared region and return universal contention.
		expect(regions.parseRegionText(MAP, "stamp")).toBe(
			"v3.9 · 21 August 2026\n",
		);
	});

	it("hands back both `head` ranges as one text", () => {
		const head = regions.parseRegionText(MAP, "head");
		expect(head).toContain("# MantaHostels document map");
		expect(head).toContain("> A preamble.");
		expect(head).not.toContain("v3.9");
	});

	it("answers null for a region the document does not hold", () => {
		expect(regions.parseRegionText(MAP, "B99")).toBeNull();
	});
});

describe("resolveRegion", () => {
	it("places an edit inside the entry it anchors on", () => {
		expect(regions.resolveRegion(MAP, "Body of B2.")).toEqual({
			region: "B2",
			why: null,
		});
	});

	it("places an anchor that is the entry heading itself", () => {
		expect(regions.resolveRegion(MAP, "### B1 · The first figure").region).toBe(
			"B1",
		);
	});

	it("refuses an anchor spanning two regions, naming both", () => {
		const spanning = "Body of B1.\n\n### B2 · The second figure";
		const answer = regions.resolveRegion(MAP, spanning);
		expect(answer.region).toBeNull();
		expect(answer.why).toContain("B1");
		expect(answer.why).toContain("B2");
	});

	it("names the regions a spanning anchor touches, so the write claims them all (mantahostels#1685)", () => {
		// The one unplaceable arm where the touched set is known EXACTLY: the
		// caller takes both regions all-or-none instead of the file entire, which
		// would block every neighbour on the map.
		const spanning = "Body of B1.\n\n### B2 \u00b7 The second figure";
		expect(regions.resolveRegion(MAP, spanning).regions).toEqual(["B1", "B2"]);
	});

	it("names no set where the spanning anchor occurs more than once", () => {
		// Two occurrences, each straddling the same pair: which of them the edit
		// rewrites is unknown, so the extent is not, and the whole file stands.
		const text = MAP.replace(
			"Body of B2.",
			"Body of B1.\n\n### B2 \u00b7 The second figure\n\nBody of B2.",
		);
		const spanning = "Body of B1.\n\n### B2 \u00b7 The second figure";
		const answer = regions.resolveRegion(text, spanning);
		expect(answer.region).toBeNull();
		expect(answer.regions).toBeUndefined();
	});

	it("refuses an anchor occurring in two different regions", () => {
		const text = MAP.replace("Body of B2.", "Body of B1.");
		const answer = regions.resolveRegion(text, "Body of B1.");
		expect(answer.region).toBeNull();
		expect(answer.why).toContain("2 regions");
	});

	it("accepts an anchor occurring twice inside ONE region", () => {
		const text = MAP.replace("Body of B2.", "same\nsame");
		expect(regions.resolveRegion(text, "same").region).toBe("B2");
	});

	it("places an edit anchored on a §A row in `section-a`", () => {
		expect(
			regions.resolveRegion(MAP, "| `docs/environment.md` | The dev machine")
				.region,
		).toBe("section-a");
	});

	it("places an anchor spanning two §A rows in `section-a`, not refusing it (mantahostels#2422)", () => {
		const spanning =
			"| `CLAUDE.md` | Entry contract | `source-of-truth` | Direct | — |\n| `docs/environment.md` |";
		expect(regions.resolveRegion(MAP, spanning).region).toBe("section-a");
	});

	it("places an anchor crossing a §A table header into its first row", () => {
		const crossing = "|---|---|---|---|---|\n| `CLAUDE.md` |";
		expect(regions.resolveRegion(MAP, crossing).region).toBe("section-a");
	});

	it("refuses an anchor that is not in the file", () => {
		const answer = regions.resolveRegion(MAP, "nothing like this");
		expect(answer.region).toBeNull();
		expect(answer.why).toContain("not found");
	});

	it("refuses an anchor occurring past the ambiguity ceiling", () => {
		const answer = regions.resolveRegion(MAP, "\n");
		expect(answer.region).toBeNull();
		expect(answer.why).toContain("too many times");
	});

	it("treats no anchor as no answer — a whole-file write", () => {
		for (const none of [undefined, null, ""]) {
			const answer = regions.resolveRegion(MAP, none);
			expect(answer.region).toBeNull();
			expect(answer.why).toBe("no anchor");
		}
	});
});

describe("nextEntryNumber", () => {
	it("is max + 1, never the lowest gap", () => {
		// mantahostels#892 made ids permanent: a gap is a retired id, not a free slot.
		const gappy = MAP.replace("### B1 ·", "### B7 ·");
		expect(regions.nextEntryNumber(gappy, 0)).toBe(8);
	});

	it("starts at B1 on a document holding no entry", () => {
		expect(regions.nextEntryNumber("# nothing\n", 0)).toBe(1);
	});

	it("starts above the high-water mark where a removed id sits above every live one", () => {
		expect(regions.nextEntryNumber(MAP, 9)).toBe(10);
	});
});

describe("isRegioned", () => {
	it("is docs/doc-map.md and its class sidecar, nothing else", () => {
		// mantahostels#848 priced a general mechanism at 35% and refused it. mantahostels#1848 widened
		// the set by exactly one member, the sidecar.
		expect(regions.isRegioned("docs/doc-map.md")).toBe(true);
		expect(regions.isRegioned(regions.SIDECAR_PATH)).toBe(true);
		for (const other of [
			"docs/operating-manual.md",
			"CLAUDE.md",
			"AGENTS.md",
			".claude/settings.json",
			"scripts/pick-next.js",
		])
			expect(regions.isRegioned(other)).toBe(false);
	});
});

/* The class sidecar's JSON-key regions (mantahostels#1848). */
describe("the sidecar's regions", () => {
	const sidecarText = JSON.stringify(
		{
			"docs/research/foo.md": {
				section: "Research runs",
				class: "free-edit",
			},
			"docs/adr/*": {
				section: "Domain decisions",
				class: "free-edit",
			},
		},
		null,
		2,
	);

	it("gives every key a region id'd A:<key>, which is now a sidecar id alone", () => {
		const found = regions.parseRegions(sidecarText, regions.SIDECAR_PATH);
		expect(found.map((r: { id: string }) => r.id)).toEqual([
			"A:docs/research/foo.md",
			"A:docs/adr/*",
		]);
	});

	it("hands back a key's own bytes under that id", () => {
		expect(
			regions.parseRegionText(
				sidecarText,
				"A:docs/adr/*",
				regions.SIDECAR_PATH,
			),
		).toContain('"docs/adr/*"');
	});

	it("does not treat a value string as a key", () => {
		const withStringValue = JSON.stringify({
			"docs/x.md": { section: "S", class: "free-edit", role: "not a key" },
		});
		const found = regions.parseRegions(withStringValue, regions.SIDECAR_PATH);
		expect(found.map((r: { id: string }) => r.id)).toEqual(["A:docs/x.md"]);
	});

	it("does not let a scalar-valued key swallow the key after it (review finding)", () => {
		const withScalar = JSON.stringify({
			"a.md": "scalar",
			"b.md": { x: 1 },
		});
		expect(
			regions
				.parseRegions(withScalar, regions.SIDECAR_PATH)
				.map((r: { id: string }) => r.id),
		).toEqual(["A:b.md"]);

		const twoScalars = JSON.stringify({
			"a.md": { x: 1 },
			"b.md": null,
			"c.md": { x: 1 },
		});
		expect(
			regions
				.parseRegions(twoScalars, regions.SIDECAR_PATH)
				.map((r: { id: string }) => r.id),
		).toEqual(["A:a.md", "A:c.md"]);
	});

	it("resolveRegion places an anchor inside one key's value and not another's", () => {
		const resolved = regions.resolveRegion(
			sidecarText,
			'"class": "free-edit"',
			undefined,
			regions.SIDECAR_PATH,
		);
		// Both entries share this exact string, so it is ambiguous — proving the
		// parser tells the two entries apart rather than merging them.
		expect(resolved.region).toBeNull();
		expect(resolved.why).toMatch(/2 regions/);
	});

	it("markdown parsing is unaffected when rel is omitted or names the map", () => {
		expect(regions.parseRegions(MAP).length).toBeGreaterThan(0);
		expect(regions.parseRegions(MAP, "docs/doc-map.md").length).toBe(
			regions.parseRegions(MAP).length,
		);
	});
});

/* §Capture and placement's §5 ledger, split off at mantahostels#1845. */
describe("the shed ledger's own region", () => {
	const capture = doc(
		"# map",
		"",
		"v1.0 · 28 August 2026",
		"",
		"## Capture and placement — where a settled fact goes",
		"",
		"### 3. Retrieval is bought separately",
		"",
		"Route prose.",
		"",
		"### 4. The always-loaded budget binds trigger lines",
		"",
		"Budget prose.",
		"",
		"### 5. Sheds paid — the ledger",
		"",
		"- **#1000**, 1 August 2026 — a tranche.",
		"",
		"## The propagation pass",
		"",
		"### 5. One adversarial subagent",
		"",
		"Pass prose.",
		"",
	);

	it("cuts the section in two at `### 5. `, and nowhere else", () => {
		// Splitting per `### ` generally was option (C) on mantahostels#1837, refused at 20%:
		// it mints ids for prose sub-parts nobody writes.
		expect(ids(capture)).toEqual([
			"head",
			"stamp",
			"head",
			"capture-and-placement-where-a-settled",
			"capture-and-placement-shed-ledger",
			"the-propagation-pass",
		]);
		expect(
			regions.parseRegionText(capture, "capture-and-placement-shed-ledger"),
		).toContain("- **#1000**");
	});

	it("leaves §3 and §4 sharing the section's existing id", () => {
		const rest = regions.parseRegionText(
			capture,
			"capture-and-placement-where-a-settled",
		);
		expect(rest).toContain("Route prose.");
		expect(rest).toContain("Budget prose.");
		expect(rest).not.toContain("- **#1000**");
	});

	it("splits a `### 5. ` in no other section", () => {
		// The propagation pass has one too. Split, it would take the ledger's id
		// and two unrelated writers would contend on one lock.
		expect(regions.parseRegionText(capture, "the-propagation-pass")).toContain(
			"### 5. One adversarial subagent",
		);
	});

	it("does not contend a §5 edit with a §3 edit", () => {
		expect(regions.resolveRegion(capture, "- **#1000**").region).toBe(
			"capture-and-placement-shed-ledger",
		);
		expect(regions.resolveRegion(capture, "Route prose.").region).toBe(
			"capture-and-placement-where-a-settled",
		);
	});

	it("falls back — announced — on an anchor spanning the §4/§5 boundary", () => {
		const spanning = "Budget prose.\n\n### 5. Sheds paid — the ledger";
		const answer = regions.resolveRegion(capture, spanning);
		expect(answer.region).toBeNull();
		expect(answer.why).toContain("capture-and-placement-where-a-settled");
		expect(answer.why).toContain("capture-and-placement-shed-ledger");
		expect(answer.regions).toEqual([
			"capture-and-placement-where-a-settled",
			"capture-and-placement-shed-ledger",
		]);
	});

	it("keeps the id readable in a denial and in a lock filename", () => {
		// The id the parser hands out: LEDGER_ID is hand-spelled, so nothing but
		// this holds it under sectionId's 40-char cap.
		const id = regions.resolveRegion(capture, "- **#1000**").region;
		expect(id.length).toBeLessThanOrEqual(40);
	});

	it("keeps a second `### 5. ` inside the ledger rather than cutting it in two", () => {
		// One id carried by two ranges with a gap between them is the
		// `head`-across-the-stamp shape resolveRegion refuses: an anchor landing in
		// each end reads as placeable while the write rewrites the span between.
		const twice = capture.replace(
			"- **#1000**, 1 August 2026 — a tranche.",
			"- **#1000**, 1 August 2026 — a tranche.\n\n### 5. A second one\n\nMore.",
		);
		const ranges = regions
			.parseRegions(twice)
			.filter(
				(r: { id: string }) => r.id === "capture-and-placement-shed-ledger",
			);
		expect(ranges).toHaveLength(1);
		expect(
			regions.parseRegionText(twice, "capture-and-placement-shed-ledger"),
		).toContain("### 5. A second one");
	});
});

/*
 * A large, realistic map — built in-test rather than read off HEAD (#16).
 * "tiles it exhaustively" wants >100 REGIONS overall,
 * and §A rows carry none of their own (mantahostels#2422), so it is §B's entry
 * count, not §A's row count, that has to clear that bar.
 */
describe("against a large synthetic map", () => {
	const rowCount = 150;
	const entryCount = 120;
	const rowPaths = syntheticPaths(rowCount);
	const anchorPath = rowPaths[0];

	const syntheticMap = syntheticDocMap({
		head: [
			"# MantaHostels document map",
			"",
			"v1.0 · 17 September 2026",
			"",
			"> A preamble.",
			"",
			"## Authority classes",
			"",
			"Prose about classes.",
			"",
		],
		sectionAProse: ["Prose before the first row.", ""],
		subsections: [
			{ heading: "Synthetic docs", rows: rowPaths.map((p) => registerRow(p)) },
		],
		after: [
			"## Section B — load-bearing figure registry",
			"",
			"Preamble to section B.",
			"",
			...Array.from({ length: entryCount }, (_, i) => [
				`### B${i + 1} · Figure ${i + 1}`,
				"",
				`Body of B${i + 1}.`,
				"",
			]).flat(),
			"## Capture and placement — where a settled fact goes",
			"",
			"### 3. Retrieval is bought separately",
			"",
			"Route prose.",
			"",
			"### 4. The always-loaded budget binds trigger lines",
			"",
			"Budget prose.",
			"",
			"### 5. Sheds paid — the ledger",
			"",
			"- **#1000**, 1 August 2026 — a tranche.",
			"",
			"## Section C — question routes",
			"",
			"Routes.",
			"",
		],
	});

	const sidecar = JSON.stringify(
		syntheticSidecar(rowPaths, () => ({
			section: "Synthetic docs",
			class: "free-edit",
		})),
		null,
		2,
	);

	it("tiles it exhaustively", () => {
		const parsed = regions.parseRegions(syntheticMap);
		expect(parsed.length).toBeGreaterThan(100);
		expect(parsed[0].start).toBe(0);
		for (let i = 1; i < parsed.length; i++)
			expect(parsed[i].start).toBe(parsed[i - 1].end);
		expect(parsed.at(-1).end).toBe(syntheticMap.length);
	});

	it("gives the sidecar one region per key, and no other id", () => {
		// The sidecar's agreement (mantahostels#1402, mantahostels#2422): a key the checkers
		// register but the region parser cannot see gets no lock of its own.
		const keys = Object.keys(JSON.parse(sidecar));
		expect(keys.length).toBeGreaterThan(100);
		expect(
			regions
				.parseRegions(sidecar, regions.SIDECAR_PATH)
				.map((r: { id: string }) => r.id),
		).toEqual(keys.map((k: string) => `A:${k}`));
	});

	it("gives its ~150 register rows no region of their own (mantahostels#2422)", () => {
		// The rows parse, but carry no locks, §A being rendered whole from the
		// sidecar.
		// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types
		const docMap: any = createRequire(__filename)("./doc-map.js");
		expect(docMap.parseRegister(syntheticMap).length).toBeGreaterThan(100);
		expect(
			ids(syntheticMap).filter((id: string) => id.startsWith("A:")),
		).toEqual([]);
	});

	it("resolves an edit anchored on a §A row to `section-a`", () => {
		const row = syntheticMap
			.split("\n")
			.find((l: string) => l.startsWith(`| \`${anchorPath}\` |`));
		expect(row).toBeDefined();
		expect(regions.resolveRegion(syntheticMap, row).region).toBe("section-a");
	});

	it("holds the shed ledger as its own region, ending at the next `## `", () => {
		// The section is named by the id `sectionId` derives from its heading, so
		// a rewording would stop the split silently (mantahostels#1845).
		const ledger = regions.parseRegionText(
			syntheticMap,
			"capture-and-placement-shed-ledger",
		);
		expect(ledger).not.toBeNull();
		expect(ledger.startsWith("### 5. Sheds paid")).toBe(true);
		expect(ledger).not.toContain("\n## ");
		const rest = regions.parseRegionText(
			syntheticMap,
			"capture-and-placement-where-a-settled",
		);
		expect(rest).toContain("### 4. ");
		expect(rest).not.toContain("### 5. Sheds paid");
	});

	it("finds every entry id exactly once", () => {
		const found = regions.entryIds(syntheticMap);
		expect(new Set(found).size).toBe(found.length);
	});

	it("resolves an edit anchored on an entry's heading", () => {
		// The HEADING, not a line from its body: §B text gets restated across the
		// document — the map keeps a restatement sidecar precisely because it does
		// — so a body line is not reliably unique, and the assertion would fail on
		// the map's content rather than on the parser.
		// The id is taken from the map rather than written down: mantahostels#1027 deleted 89
		// entries at once, and a hard-coded one made this fail on the map's
		// contents instead of on the parser.
		const id = regions.entryIds(syntheticMap)[0];
		const heading = regions.parseRegionText(syntheticMap, id).split("\n")[0];
		expect(heading).toContain(`### ${id}`);
		expect(regions.resolveRegion(syntheticMap, heading).region).toBe(id);
	});
});

/*
 * Findings from the mantahostels#970 code review.
 */
describe("review findings", () => {
	const withFence = doc(
		"# map",
		"",
		"v1.0 · 21 August 2026",
		"",
		"## Section B",
		"",
		"### B1 · One",
		"",
		"An entry that quotes the stamp format:",
		"",
		"```",
		"v5.62 · 3 August 2026",
		"### B99 · a quoted example",
		"```",
		"",
		"Still inside B1.",
		"",
		"### B2 · Two",
		"",
		"Body.",
		"",
	);

	it("does not let a fenced example split an entry in two", () => {
		// Split, the two halves become independently claimable and two sessions
		// editing one entry never contend — the failure the mechanism exists to
		// prevent.
		expect(ids(withFence)).toEqual([
			"head",
			"stamp",
			"head",
			"section-b-preamble",
			"B1",
			"B2",
		]);
		expect(regions.parseRegionText(withFence, "B1")).toContain(
			"Still inside B1.",
		);
	});

	it("mints no region from a §A row quoted inside a fence", () => {
		// §A's own prose quotes register rows to explain their shape. Split, the
		// quote becomes claimable and the entry around it becomes two regions.
		const quoting = doc(
			"# map",
			"",
			"v1.0 · 21 August 2026",
			"",
			"## Section A — document register",
			"",
			"A row looks like this:",
			"",
			"```",
			"| `docs/example.md` | Role | `source-of-truth` | Direct | — |",
			"```",
			"",
			"| `docs/real.md` | Role | `source-of-truth` | Direct | — |",
			"",
			"Trailing prose.",
			"",
		);
		expect(ids(quoting)).toEqual(["head", "stamp", "head", "section-a"]);
	});

	it("mints no phantom entry from a heading inside a fence", () => {
		expect(regions.entryIds(withFence)).toEqual(["B1", "B2"]);
		expect(regions.nextEntryNumber(withFence, 0)).toBe(3);
	});

	it("refuses an anchor crossing the stamp, which sits between two `head` ranges", () => {
		// Both ends are `head`, so only the range between them reveals the stamp.
		const crossing = "# map\n\nv1.0 · 21 August 2026\n\n## Section B";
		const answer = regions.resolveRegion(withFence, crossing);
		expect(answer.region).toBeNull();
		expect(answer.why).toContain("stamp");
	});

	it("treats a truncated anchor as unplaceable, never as its surviving prefix", () => {
		// The guard caps old_string at 8000 characters, which loses the end — and
		// the end is the whole of what the spans-regions test reads.
		const answer = regions.resolveRegion(withFence, "Body.", 9000);
		expect(answer.region).toBeNull();
		expect(answer.why).toContain("truncated");
		expect(regions.resolveRegion(withFence, "Body.", 5).region).toBe("B2");
	});

	it("caps a long section id without eating a short one's last word", () => {
		const long = doc(`## ${"a".repeat(80)}`, "", "x", "");
		const capped = regions.parseRegions(long)[0].id;
		expect(capped.length).toBeLessThanOrEqual(40);
		const short = doc("## Authority classes", "", "x", "");
		expect(regions.parseRegions(short)[0].id).toBe("authority-classes");
	});

	it("tiles a document whose last line has no trailing newline", () => {
		const noNewline =
			"# map\n\nv1.0 · 1 January 2026\n\n## Section B\n\n### B1 · One\n\nBody.";
		const parsed = regions.parseRegions(noNewline);
		expect(parsed.at(-1).end).toBe(noNewline.length);
	});
});

/*
 * The §A subjects the map offers nobody but the generator (mantahostels#2422).
 */
describe("isGeneratorOnlyRegion", () => {
	const map = "docs/doc-map.md"; // MAP_PATH, doc-map-regions.js
	it("shuts §A and its old row ids on the map", () => {
		expect(regions.isGeneratorOnlyRegion(map, "section-a")).toBe(true);
		expect(regions.isGeneratorOnlyRegion(map, "A:docs/environment.md")).toBe(
			true,
		);
	});

	it("leaves every other region of the map open", () => {
		for (const id of [
			"head",
			"stamp",
			"B200",
			"section-b-preamble",
			"section-c",
		])
			expect(regions.isGeneratorOnlyRegion(map, id)).toBe(false);
	});

	it("fires on no sidecar id — its keys are authored, and it has no §A", () => {
		expect(
			regions.isGeneratorOnlyRegion(regions.SIDECAR_PATH, "A:docs/adr/*"),
		).toBe(false);
		expect(
			regions.isGeneratorOnlyRegion(regions.SIDECAR_PATH, "section-a"),
		).toBe(false);
	});
});
