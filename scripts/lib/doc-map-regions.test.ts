// @vitest-environment node

import { describe, expect, it } from "vitest";
import { parseRegister } from "./doc-map.js";
import {
	entryIds,
	isGeneratorOnlyRegion,
	isRegioned,
	nextEntryNumber,
	parseRegions,
	parseRegionText,
	resolveRegion,
	SIDECAR_PATH,
} from "./doc-map-regions.js";
import {
	registerRow,
	syntheticDocMap,
	syntheticPaths,
	syntheticSidecar,
} from "./doc-map-testkit";

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
	parseRegions(text).map((r: { id: string }) => r.id);

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
		const parsed = parseRegions(MAP);
		expect(parsed[0].start).toBe(0);
		for (let i = 1; i < parsed.length; i++)
			expect(parsed[i].start).toBe(parsed[i - 1].end);
		expect(parsed.at(-1)?.end).toBe(MAP.length);
	});

	it("holds §A's rows in `section-a` with its headings and prose", () => {
		const sectionA = parseRegionText(MAP, "section-a");
		expect(sectionA).toContain("Prose before the first row.");
		expect(sectionA).toContain("### Repo-root contracts");
		expect(sectionA).toContain("| Path | Role |");
		expect(sectionA).toContain("|---|---|---|---|---|");
		expect(sectionA).toContain("| a | b |");
		expect(sectionA).toContain("Entry contract");
		expect(sectionA).toContain("The dev machine");
	});

	it("mints no `A:<path>` id on the map, in §A or out of it (mantahostels#2422)", () => {
		const text = MAP.replace(
			"Prose about classes.",
			"| `CLAUDE.md` | not a register row |",
		);
		expect(ids(text).filter((id: string) => id.startsWith("A:"))).toEqual([]);
		expect(parseRegionText(text, "authority-classes")).toContain(
			"not a register row",
		);
	});

	it("gives the version stamp a region of its own", () => {
		expect(parseRegionText(MAP, "stamp")).toBe("v3.9 · 21 August 2026\n");
	});

	it("hands back both `head` ranges as one text", () => {
		const head = parseRegionText(MAP, "head");
		expect(head).toContain("# MantaHostels document map");
		expect(head).toContain("> A preamble.");
		expect(head).not.toContain("v3.9");
	});

	it("answers null for a region the document does not hold", () => {
		expect(parseRegionText(MAP, "B99")).toBeNull();
	});
});

describe("resolveRegion", () => {
	it("places an edit inside the entry it anchors on", () => {
		expect(resolveRegion(MAP, "Body of B2.")).toEqual({
			region: "B2",
			why: null,
		});
	});

	it("places an anchor that is the entry heading itself", () => {
		expect(resolveRegion(MAP, "### B1 · The first figure").region).toBe("B1");
	});

	it("refuses an anchor spanning two regions, naming both", () => {
		const spanning = "Body of B1.\n\n### B2 · The second figure";
		const answer = resolveRegion(MAP, spanning);
		expect(answer.region).toBeNull();
		expect(answer.why).toContain("B1");
		expect(answer.why).toContain("B2");
	});

	it("names the regions a spanning anchor touches, so the write claims them all (mantahostels#1685)", () => {
		const spanning = "Body of B1.\n\n### B2 \u00b7 The second figure";
		expect(resolveRegion(MAP, spanning).regions).toEqual(["B1", "B2"]);
	});

	it("names no set where the spanning anchor occurs more than once", () => {
		const text = MAP.replace(
			"Body of B2.",
			"Body of B1.\n\n### B2 \u00b7 The second figure\n\nBody of B2.",
		);
		const spanning = "Body of B1.\n\n### B2 \u00b7 The second figure";
		const answer = resolveRegion(text, spanning);
		expect(answer.region).toBeNull();
		expect(answer.regions).toBeUndefined();
	});

	it("refuses an anchor occurring in two different regions", () => {
		const text = MAP.replace("Body of B2.", "Body of B1.");
		const answer = resolveRegion(text, "Body of B1.");
		expect(answer.region).toBeNull();
		expect(answer.why).toContain("2 regions");
	});

	it("accepts an anchor occurring twice inside ONE region", () => {
		const text = MAP.replace("Body of B2.", "same\nsame");
		expect(resolveRegion(text, "same").region).toBe("B2");
	});

	it("places an edit anchored on a §A row in `section-a`", () => {
		expect(
			resolveRegion(MAP, "| `docs/environment.md` | The dev machine").region,
		).toBe("section-a");
	});

	it("places an anchor spanning two §A rows in `section-a`, not refusing it (mantahostels#2422)", () => {
		const spanning =
			"| `CLAUDE.md` | Entry contract | `source-of-truth` | Direct | — |\n| `docs/environment.md` |";
		expect(resolveRegion(MAP, spanning).region).toBe("section-a");
	});

	it("places an anchor crossing a §A table header into its first row", () => {
		const crossing = "|---|---|---|---|---|\n| `CLAUDE.md` |";
		expect(resolveRegion(MAP, crossing).region).toBe("section-a");
	});

	it("refuses an anchor that is not in the file", () => {
		const answer = resolveRegion(MAP, "nothing like this");
		expect(answer.region).toBeNull();
		expect(answer.why).toContain("not found");
	});

	it("refuses an anchor occurring past the ambiguity ceiling", () => {
		const answer = resolveRegion(MAP, "\n");
		expect(answer.region).toBeNull();
		expect(answer.why).toContain("too many times");
	});

	it("treats no anchor as no answer — a whole-file write", () => {
		for (const none of [undefined, null, ""]) {
			const answer = resolveRegion(MAP, none);
			expect(answer.region).toBeNull();
			expect(answer.why).toBe("no anchor");
		}
	});
});

describe("nextEntryNumber", () => {
	it("is max + 1, never the lowest gap", () => {
		const gappy = MAP.replace("### B1 ·", "### B7 ·");
		expect(nextEntryNumber(gappy, 0)).toBe(8);
	});

	it("starts at B1 on a document holding no entry", () => {
		expect(nextEntryNumber("# nothing\n", 0)).toBe(1);
	});

	it("starts above the high-water mark where a removed id sits above every live one", () => {
		expect(nextEntryNumber(MAP, 9)).toBe(10);
	});
});

describe("isRegioned", () => {
	it("is docs/doc-map.md and its class sidecar, nothing else", () => {
		expect(isRegioned("docs/doc-map.md")).toBe(true);
		expect(isRegioned(SIDECAR_PATH)).toBe(true);
		for (const other of [
			"docs/operating-manual.md",
			"CLAUDE.md",
			"AGENTS.md",
			".claude/settings.json",
			"scripts/pick-next.js",
		])
			expect(isRegioned(other)).toBe(false);
	});
});

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
		const found = parseRegions(sidecarText, SIDECAR_PATH);
		expect(found.map((r: { id: string }) => r.id)).toEqual([
			"A:docs/research/foo.md",
			"A:docs/adr/*",
		]);
	});

	it("hands back a key's own bytes under that id", () => {
		expect(
			parseRegionText(sidecarText, "A:docs/adr/*", SIDECAR_PATH),
		).toContain('"docs/adr/*"');
	});

	it("does not treat a value string as a key", () => {
		const withStringValue = JSON.stringify({
			"docs/x.md": { section: "S", class: "free-edit", role: "not a key" },
		});
		const found = parseRegions(withStringValue, SIDECAR_PATH);
		expect(found.map((r: { id: string }) => r.id)).toEqual(["A:docs/x.md"]);
	});

	it("does not let a scalar-valued key swallow the key after it (review finding)", () => {
		const withScalar = JSON.stringify({
			"a.md": "scalar",
			"b.md": { x: 1 },
		});
		expect(
			parseRegions(withScalar, SIDECAR_PATH).map((r: { id: string }) => r.id),
		).toEqual(["A:b.md"]);

		const twoScalars = JSON.stringify({
			"a.md": { x: 1 },
			"b.md": null,
			"c.md": { x: 1 },
		});
		expect(
			parseRegions(twoScalars, SIDECAR_PATH).map((r: { id: string }) => r.id),
		).toEqual(["A:a.md", "A:c.md"]);
	});

	it("resolveRegion places an anchor inside one key's value and not another's", () => {
		const resolved = resolveRegion(
			sidecarText,
			'"class": "free-edit"',
			undefined,
			SIDECAR_PATH,
		);
		expect(resolved.region).toBeNull();
		expect(resolved.why).toMatch(/2 regions/);
	});

	it("markdown parsing is unaffected when rel is omitted or names the map", () => {
		expect(parseRegions(MAP).length).toBeGreaterThan(0);
		expect(parseRegions(MAP, "docs/doc-map.md").length).toBe(
			parseRegions(MAP).length,
		);
	});
});

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
		expect(ids(capture)).toEqual([
			"head",
			"stamp",
			"head",
			"capture-and-placement-where-a-settled",
			"capture-and-placement-shed-ledger",
			"the-propagation-pass",
		]);
		expect(
			parseRegionText(capture, "capture-and-placement-shed-ledger"),
		).toContain("- **#1000**");
	});

	it("leaves §3 and §4 sharing the section's existing id", () => {
		const rest = parseRegionText(
			capture,
			"capture-and-placement-where-a-settled",
		);
		expect(rest).toContain("Route prose.");
		expect(rest).toContain("Budget prose.");
		expect(rest).not.toContain("- **#1000**");
	});

	it("splits a `### 5. ` in no other section", () => {
		expect(parseRegionText(capture, "the-propagation-pass")).toContain(
			"### 5. One adversarial subagent",
		);
	});

	it("does not contend a §5 edit with a §3 edit", () => {
		expect(resolveRegion(capture, "- **#1000**").region).toBe(
			"capture-and-placement-shed-ledger",
		);
		expect(resolveRegion(capture, "Route prose.").region).toBe(
			"capture-and-placement-where-a-settled",
		);
	});

	it("falls back — announced — on an anchor spanning the §4/§5 boundary", () => {
		const spanning = "Budget prose.\n\n### 5. Sheds paid — the ledger";
		const answer = resolveRegion(capture, spanning);
		expect(answer.region).toBeNull();
		expect(answer.why).toContain("capture-and-placement-where-a-settled");
		expect(answer.why).toContain("capture-and-placement-shed-ledger");
		expect(answer.regions).toEqual([
			"capture-and-placement-where-a-settled",
			"capture-and-placement-shed-ledger",
		]);
	});

	it("keeps the id readable in a denial and in a lock filename", () => {
		const id = resolveRegion(capture, "- **#1000**").region;
		expect(id?.length).toBeLessThanOrEqual(40);
	});

	it("keeps a second `### 5. ` inside the ledger rather than cutting it in two", () => {
		const twice = capture.replace(
			"- **#1000**, 1 August 2026 — a tranche.",
			"- **#1000**, 1 August 2026 — a tranche.\n\n### 5. A second one\n\nMore.",
		);
		const ranges = parseRegions(twice).filter(
			(r: { id: string }) => r.id === "capture-and-placement-shed-ledger",
		);
		expect(ranges).toHaveLength(1);
		expect(
			parseRegionText(twice, "capture-and-placement-shed-ledger"),
		).toContain("### 5. A second one");
	});
});

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
		const parsed = parseRegions(syntheticMap);
		expect(parsed.length).toBeGreaterThan(100);
		expect(parsed[0].start).toBe(0);
		for (let i = 1; i < parsed.length; i++)
			expect(parsed[i].start).toBe(parsed[i - 1].end);
		expect(parsed.at(-1)?.end).toBe(syntheticMap.length);
	});

	it("gives the sidecar one region per key, and no other id", () => {
		const keys = Object.keys(JSON.parse(sidecar));
		expect(keys.length).toBeGreaterThan(100);
		expect(
			parseRegions(sidecar, SIDECAR_PATH).map((r: { id: string }) => r.id),
		).toEqual(keys.map((k: string) => `A:${k}`));
	});

	it("gives its ~150 register rows no region of their own (mantahostels#2422)", () => {
		expect(parseRegister(syntheticMap).length).toBeGreaterThan(100);
		expect(
			ids(syntheticMap).filter((id: string) => id.startsWith("A:")),
		).toEqual([]);
	});

	it("resolves an edit anchored on a §A row to `section-a`", () => {
		const row = syntheticMap
			.split("\n")
			.find((l: string) => l.startsWith(`| \`${anchorPath}\` |`));
		expect(row).toBeDefined();
		expect(resolveRegion(syntheticMap, row).region).toBe("section-a");
	});

	it("holds the shed ledger as its own region, ending at the next `## `", () => {
		const ledger = parseRegionText(
			syntheticMap,
			"capture-and-placement-shed-ledger",
		);
		expect(ledger).not.toBeNull();
		expect(ledger?.startsWith("### 5. Sheds paid")).toBe(true);
		expect(ledger).not.toContain("\n## ");
		const rest = parseRegionText(
			syntheticMap,
			"capture-and-placement-where-a-settled",
		);
		expect(rest).toContain("### 4. ");
		expect(rest).not.toContain("### 5. Sheds paid");
	});

	it("finds every entry id exactly once", () => {
		const found = entryIds(syntheticMap);
		expect(new Set(found).size).toBe(found.length);
	});

	it("resolves an edit anchored on an entry's heading", () => {
		const id = entryIds(syntheticMap)[0];
		const heading = parseRegionText(syntheticMap, id)?.split("\n")[0];
		expect(heading).toContain(`### ${id}`);
		expect(resolveRegion(syntheticMap, heading).region).toBe(id);
	});
});

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
		expect(ids(withFence)).toEqual([
			"head",
			"stamp",
			"head",
			"section-b-preamble",
			"B1",
			"B2",
		]);
		expect(parseRegionText(withFence, "B1")).toContain("Still inside B1.");
	});

	it("mints no region from a §A row quoted inside a fence", () => {
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
		expect(entryIds(withFence)).toEqual(["B1", "B2"]);
		expect(nextEntryNumber(withFence, 0)).toBe(3);
	});

	it("refuses an anchor crossing the stamp, which sits between two `head` ranges", () => {
		const crossing = "# map\n\nv1.0 · 21 August 2026\n\n## Section B";
		const answer = resolveRegion(withFence, crossing);
		expect(answer.region).toBeNull();
		expect(answer.why).toContain("stamp");
	});

	it("treats a truncated anchor as unplaceable, never as its surviving prefix", () => {
		const answer = resolveRegion(withFence, "Body.", 9000);
		expect(answer.region).toBeNull();
		expect(answer.why).toContain("truncated");
		expect(resolveRegion(withFence, "Body.", 5).region).toBe("B2");
	});

	it("caps a long section id without eating a short one's last word", () => {
		const long = doc(`## ${"a".repeat(80)}`, "", "x", "");
		const capped = parseRegions(long)[0].id;
		expect(capped.length).toBeLessThanOrEqual(40);
		const short = doc("## Authority classes", "", "x", "");
		expect(parseRegions(short)[0].id).toBe("authority-classes");
	});

	it("tiles a document whose last line has no trailing newline", () => {
		const noNewline =
			"# map\n\nv1.0 · 1 January 2026\n\n## Section B\n\n### B1 · One\n\nBody.";
		const parsed = parseRegions(noNewline);
		expect(parsed.at(-1)?.end).toBe(noNewline.length);
	});
});

describe("isGeneratorOnlyRegion", () => {
	const map = "docs/doc-map.md";
	it("shuts §A and its old row ids on the map", () => {
		expect(isGeneratorOnlyRegion(map, "section-a")).toBe(true);
		expect(isGeneratorOnlyRegion(map, "A:docs/environment.md")).toBe(true);
	});

	it("leaves every other region of the map open", () => {
		for (const id of [
			"head",
			"stamp",
			"B200",
			"section-b-preamble",
			"section-c",
		])
			expect(isGeneratorOnlyRegion(map, id)).toBe(false);
	});

	it("fires on no sidecar id — its keys are authored, and it has no §A", () => {
		expect(isGeneratorOnlyRegion(SIDECAR_PATH, "A:docs/adr/*")).toBe(false);
		expect(isGeneratorOnlyRegion(SIDECAR_PATH, "section-a")).toBe(false);
	});
});
