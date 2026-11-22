// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REPLAY_MARKERS, UNTRACKED_BLOCKS } from "./doc-map-gate-markers.js";
import { greenReport } from "./doc-map-gate-report.js";
import {
	syntheticDocMap as buildDocMap,
	emptyDataFile,
	registerRow,
	sidecarEntry,
	syntheticSidecar,
	writeSidecar,
} from "./doc-map-testkit";
import { runInProcess } from "./run-in-process.js";

const ROOT = path.join(__dirname, "..", "..");

const temps: string[] = [];
afterEach(() => {
	for (const t of temps.splice(0))
		fs.rmSync(t, { recursive: true, force: true });
});

const UNTRACKED_ENTRIES = [
	"docs/research/machine-binding-constraints.md",
	"docs/research/artefact-family-costs.md",
];

const UNTRACKED_REPORT = [
	"2 doc-map register entr(ies) name a file present on disk but not yet tracked by git:",
	...UNTRACKED_ENTRIES.map((e) => `  ${e}`),
	"",
	"Likely mid-ticket: the register edit and the file's own commit are separate steps.",
	"",
	"Files no Section C route reaches:",
	"  docs/research/unreached-noise.md",
	"WARN: 0 doc-map problem(s)",
].join("\n");

const GREW_REPORT = [
	"1 §B entr(ies) marked over cap by ruling grew in this commit:",
	"  B223 — 379 → 402 prose words, +23, marked exempt by #1911",
	"",
	"Pay for the addition inside the same entry: cut surplus wording until the entry is no larger than it was.",
	"",
	"Files no Section C route reaches:",
	"  docs/research/unreached-noise.md",
	"WARN: 0 doc-map problem(s)",
].join("\n");

const MALFORMED_REPORT = [
	"1 §B line(s) look like an over-cap marker but do not parse as one:",
	"  B1 — - **Over cap by ruling (#2124)** the colon sits outside the bold",
	"",
	"Respell the bullet exactly `- **Over cap by ruling (#n):**` — a top-level bullet, the whole leader bold, the colon INSIDE the bold, and a bare issue number after the `#`. Where the line is prose rather than an attempted marker, reword its opening so it does not read as one.",
	"",
	"Reached by no Section C route (261 of 340 in-scope files, not a failure):",
	"  docs/research/unreached-noise.md",
	"WARN: 0 doc-map problem(s)",
].join("\n");

const DROPPED_REPORT = [
	"1 over-cap §B entr(ies) lost the marker the baseline carried:",
	"  B223 — 402 prose words, marked exempt by #1911 until this commit",
	"",
	"Deleted by accident? Put the `- **Over cap by ruling (#n):**` bullet back.",
	"",
	"Reached by no Section C route (261 of 340 in-scope files, not a failure):",
	"  docs/research/unreached-noise.md",
	"WARN: 0 doc-map problem(s)",
].join("\n");

const UNTRACKED_ROUTES = [
	{ id: "C36", path: "docs/production-runbook.md" },
	{ id: "C37", path: "docs/release-strategy.md" },
];

const UNTRACKED_ROUTE_REPORT = [
	"2 Section C route path(s) in /tmp/staged/doc-map.md name a file present on disk but not yet tracked by git:",
	...UNTRACKED_ROUTES.map((r) => `  ${r.id} → ${r.path}`),
	"",
	"Likely mid-ticket: the route and the file it sends the reader to are separate steps.",
	"",
	"Files no Section C route reaches:",
	"  docs/research/unreached-noise.md",
	"WARN: 0 doc-map problem(s)",
].join("\n");

const OK_REPORT = "OK: doc map covers everything";

const sectionARow = (entry: string) =>
	`| \`${entry}\` | a note | \`reference\` |`;

const headWithRows = (inherited: string[] = UNTRACKED_ENTRIES) =>
	["# Section A", ...inherited.map(sectionARow)].join("\n");

const headWithRoutes = (
	inherited: string[] = UNTRACKED_ROUTES.map((r) => r.path),
) =>
	["# Section C", ...inherited.map((p) => `- **Read:** \`${p}\``)].join("\n");

describe("the WARN blocks a green run replays", () => {
	it("replays the growth block when the checker passes", () => {
		const { text, exit } = greenReport(GREW_REPORT, "");
		expect(exit).toBe(0);
		expect(text).toContain("marked over cap by ruling grew in this commit:");
		expect(text).toContain("B223 — 379 → 402 prose words, +23");
		expect(text).toContain("Pay for the addition inside the same entry");
	});

	it("replays the growth block alone, not the report around it", () => {
		expect(greenReport(GREW_REPORT, "").text).not.toContain(
			"unreached-noise.md",
		);
	});

	it("replays the malformed-marker block when the checker passes", () => {
		const { text, exit } = greenReport(MALFORMED_REPORT, "");
		expect(exit).toBe(0);
		expect(text).toContain(
			"look like an over-cap marker but do not parse as one:",
		);
		expect(text).toContain("B1 — - **Over cap by ruling (#2124)**");
		expect(text).toContain("Respell the bullet exactly");
	});

	it("replays the malformed-marker block alone, not the report around it", () => {
		expect(greenReport(MALFORMED_REPORT, "").text).not.toContain(
			"unreached-noise.md",
		);
	});

	it("replays the dropped-marker block when the checker passes", () => {
		const { text, exit } = greenReport(DROPPED_REPORT, "");
		expect(exit).toBe(0);
		expect(text).toContain("lost the marker the baseline carried:");
		expect(text).toContain("B223 — 402 prose words, marked exempt by #1911");
		expect(text).toContain("Deleted by accident?");
	});

	it("replays the dropped-marker block alone, not the report around it", () => {
		expect(greenReport(DROPPED_REPORT, "").text).not.toContain(
			"unreached-noise.md",
		);
	});

	it("says nothing on a green run that reports no WARN block", () => {
		expect(greenReport(OK_REPORT, "")).toEqual({ text: "", exit: 0 });
	});
});

describe("the untracked blocks a green run replays and judges", () => {
	it("replays the untracked-entry block when the checker passes", () => {
		const { text, exit } = greenReport(UNTRACKED_REPORT, headWithRows());
		expect(exit).toBe(0);
		expect(text).toContain("not yet tracked by git:");
		expect(text).toContain("docs/research/machine-binding-constraints.md");
		expect(text).toContain("docs/research/artefact-family-costs.md");
		expect(text).toContain("Likely mid-ticket:");
		expect(text).toContain(
			"DEAD, which FAILs there (mantahostels#1300, mantahostels#1403)",
		);
	});

	it("replays that block alone, not the report-only section around it", () => {
		const { text } = greenReport(UNTRACKED_REPORT, headWithRows());
		expect(text).not.toContain("unreached-noise.md");
		expect(text).not.toContain("Files no Section C route reaches");
		expect(text).not.toContain("WARN: 0 doc-map problem(s)");
	});

	it("refuses a commit that adds a row for a file it does not contain, naming each row and offering to name the file in the pathspec as the way out", () => {
		const { text, exit } = greenReport(UNTRACKED_REPORT, headWithRows([]));
		expect(exit).toBe(1);
		expect(text).toBe(
			`${UNTRACKED_REPORT.split("\n").slice(0, 5).join("\n")}\n` +
				"pre-commit: this commit adds the doc-map Section A row(s) below and not the file(s) they name:\n" +
				UNTRACKED_ENTRIES.map((e) => `  ${e}\n`).join("") +
				"  The sweeps run a clean checkout, where the file is not on disk either — so it reads as DEAD there and FAILs (mantahostels#1300, mantahostels#1403).\n" +
				"  Fix: name the file in this commit's pathspec too, or drop the row until it lands.\n",
		);
	});

	it("only warns on a row HEAD's map already carried", () => {
		const { text, exit } = greenReport(UNTRACKED_REPORT, headWithRows());
		expect(exit).toBe(0);
		expect(text).toContain(
			"pre-commit: left as they are, the Section A row(s) above reach the scheduled sweeps as DEAD, which FAILs there (mantahostels#1300, mantahostels#1403).",
		);
		expect(text).not.toContain("and not the file(s) they name");
	});

	it("names the added row alone when the other was inherited", () => {
		const { text, exit } = greenReport(
			UNTRACKED_REPORT,
			headWithRows([UNTRACKED_ENTRIES[0]]),
		);
		expect(exit).toBe(1);
		const listed = text.slice(text.indexOf("and not the file(s) they name"));
		expect(listed).toContain(UNTRACKED_ENTRIES[1]);
		expect(listed).not.toContain(UNTRACKED_ENTRIES[0]);
	});

	it("replays the untracked-route block when the checker passes", () => {
		const { text, exit } = greenReport(
			UNTRACKED_ROUTE_REPORT,
			headWithRoutes(),
		);
		expect(exit).toBe(0);
		expect(text).toContain("C36 → docs/production-runbook.md");
		expect(text).toContain("C37 → docs/release-strategy.md");
		expect(text).toContain("Section C route(s) above reach");
		expect(text).not.toContain("unreached-noise.md");
	});

	it("refuses a commit that adds a route for a file it does not contain, offering to drop the route until it lands as the way out", () => {
		const { text, exit } = greenReport(
			UNTRACKED_ROUTE_REPORT,
			headWithRoutes([]),
		);
		expect(exit).toBe(1);
		expect(text).toContain("and not the file(s) they name");
		expect(text).toContain("drop the route until it lands");
	});

	it("judges a route against HEAD by its path, never its id", () => {
		const { text, exit } = greenReport(
			UNTRACKED_ROUTE_REPORT,
			headWithRoutes(),
		);
		expect(exit).toBe(0);
		expect(text).toContain("left as they are");
		expect(text).not.toContain("and not the file(s) they name");
	});

	it("names the added route alone when the other was inherited", () => {
		const { text, exit } = greenReport(
			UNTRACKED_ROUTE_REPORT,
			headWithRoutes([UNTRACKED_ROUTES[0].path]),
		);
		expect(exit).toBe(1);
		const listed = text.slice(text.indexOf("and not the file(s) they name"));
		expect(listed).toContain(UNTRACKED_ROUTES[1].path);
		expect(listed).not.toContain(UNTRACKED_ROUTES[0].path);
	});

	it("replays both blocks when the report holds an entry and a route", () => {
		const { text, exit } = greenReport(
			[UNTRACKED_REPORT, UNTRACKED_ROUTE_REPORT].join("\n"),
			`${headWithRows()}\n${headWithRoutes()}`,
		);
		expect(exit).toBe(0);
		expect(text).toContain(UNTRACKED_ENTRIES[0]);
		expect(text).toContain("C36 → docs/production-runbook.md");
		expect(text).toContain("Section A row(s) above reach");
		expect(text).toContain("Section C route(s) above reach");
	});

	it("warns without refusing when HEAD has no doc-map.md at all", () => {
		const { text, exit } = greenReport(UNTRACKED_REPORT, "");
		expect(exit).toBe(0);
		expect(text).toContain("left as they are");
		expect(text).not.toContain("and not the file(s) they name");
	});

	it("refuses an inherited row when the HEAD comparison is dropped", () => {
		expect(greenReport(UNTRACKED_REPORT, headWithRows()).exit).toBe(0);
		const { text, exit } = greenReport(UNTRACKED_REPORT, "# Section A");
		expect(exit).toBe(1);
		for (const entry of UNTRACKED_ENTRIES)
			expect(text).toContain(`  ${entry}\n`);
	});

	it("stays silent on a green run whose report holds no untracked entry", () => {
		expect(
			greenReport(
				[
					"Files no Section C route reaches:",
					"  docs/research/unreached-noise.md",
					"OK: doc map covers all 208 tracked files in scope",
				].join("\n"),
				headWithRows(),
			),
		).toEqual({ text: "", exit: 0 });
	});
});

const RESEARCH_PATH = "docs/research/synthetic-model.md";

const DOC_MAP_FILES = [
	"doc-map.md",
	"doc-map-restatements.json",
	"doc-map-superseded.json",
	"doc-map-retired-vocabulary.json",
	"doc-map-restatement-allowlist.json",
	"doc-map-high-water.json",
	"doc-map-classes.json",
];

const syntheticDocMap = () =>
	buildDocMap({
		head: ["# Doc map", "", "v1.0 · 17 September 2026", ""],
		sectionA: "## Section A — authority register",
		subsections: [
			{ heading: "Research runs", list: [RESEARCH_PATH] },
			{
				heading: "Docs",
				rows: [
					registerRow("docs/doc-map.md", "the map", "source-of-truth"),
					...DOC_MAP_FILES.filter((n) => n !== "doc-map.md").map((n) =>
						registerRow(`docs/${n}`, "a sidecar", "generated-only"),
					),
				],
			},
		],
		after: [
			"## Section B — figure registry",
			"",
			"### B1 · A figure with no marker yet",
			"",
			"Prose only — no `**Over cap by ruling (#N):**` bullet below it, so this",
			"is the entry the malformed-marker case injects its near miss beside.",
			"",
		],
	});

function syntheticDocMapDir(prefix: string): { dir: string; map: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temps.push(dir);
	for (const name of DOC_MAP_FILES.filter(
		(n) =>
			n !== "doc-map.md" &&
			n !== "doc-map-classes.json" &&
			n !== "doc-map-restatements.json",
	))
		fs.writeFileSync(path.join(dir, name), emptyDataFile(name));
	fs.writeFileSync(
		path.join(dir, "doc-map-restatements.json"),
		JSON.stringify({ B1: { paths: [{ path: "docs/doc-map.md" }] } }),
	);
	writeSidecar(
		path.join(dir, "doc-map-classes.json"),
		syntheticSidecar(
			["docs/doc-map.md", RESEARCH_PATH, "docs/doc-map-classes.json"].concat(
				DOC_MAP_FILES.filter(
					(n) => n !== "doc-map.md" && n !== "doc-map-classes.json",
				).map((n) => `docs/${n}`),
			),
			(p) =>
				p === RESEARCH_PATH
					? sidecarEntry({ section: "Research runs" })
					: sidecarEntry({ class: "source-of-truth" }),
		),
	);
	return { dir, map: syntheticDocMap() };
}

const NO_ANNOTATIONS = { ...process.env, GITHUB_ACTIONS: "" };

const realReport = (dir: string) => {
	const run = runInProcess(
		path.join(ROOT, "scripts", "check-doc-map.js"),
		[path.join(dir, "doc-map.md"), "--data-dir", dir],
		{ cwd: ROOT, env: NO_ANNOTATIONS },
	);
	return `${run.stdout}${run.stderr}`;
};

describe("the slice against the real checker's wording and shape", () => {
	it("cuts the real checker's untracked block, wording and shape both", () => {
		const { dir, map } = syntheticDocMapDir("doc-map-slice-");
		const scratch = `docs/research/.slice-fixture-${process.pid}.md`;
		const { parseRegister, registerListPath, registerRowPaths } =
			require("./doc-map") as typeof import("./doc-map");
		const registered = new Set(
			parseRegister(map).flatMap((r: { paths: string[] }) => r.paths),
		);
		const model = map.split("\n").find((l) => {
			const p = registerListPath(l) ?? registerRowPaths(l)[0];
			return !!p && p.startsWith("docs/research/") && registered.has(p);
		});
		expect(
			model,
			"no docs/research register entry to model the injected one on",
		).toBeTruthy();
		const injected = (model as string).replace(
			/`docs\/research\/[^`]+`/,
			`\`${scratch}\``,
		);
		fs.writeFileSync(
			path.join(dir, "doc-map.md"),
			map.replace(model as string, `${model}\n${injected}`),
		);

		fs.writeFileSync(path.join(ROOT, scratch), "scratch\n");
		let report: string;
		try {
			report = realReport(dir);
		} finally {
			fs.rmSync(path.join(ROOT, scratch), { force: true });
		}
		expect(
			report,
			"the real checker did not raise the untracked entry",
		).toContain(scratch);

		const { text, exit } = greenReport(report, "# Section A");
		expect(exit).toBe(1);
		const [sliced, refusal] = text.split(
			"\npre-commit: this commit adds the doc-map Section A row(s) below",
		);
		expect(sliced).toContain("not yet tracked by git:");
		expect(sliced).toContain(scratch);
		expect(sliced).toContain("Commit the file, or drop the entry");
		expect(refusal.split("\n").filter((l) => l.startsWith("  docs/"))).toEqual([
			`  ${scratch}`,
		]);
		expect(sliced).not.toContain("Section C route");
		expect(sliced.split("\n").length).toBe(4);

		expect(
			greenReport(
				report.replace("not yet tracked by git:", "not yet tracked by git —"),
				"# Section A",
			).text,
		).not.toContain(scratch);
	});

	it("cuts the real checker's malformed-marker block, wording and shape both", () => {
		const { dir, map } = syntheticDocMapDir("doc-map-marker-");
		const entries = map.split(/^### (?=B\d+ )/m).slice(1);
		const target = entries.find(
			(e) => !/^[-*]\s+\*\*Over cap by ruling \(#\d+\):\*\*/m.test(e),
		);
		expect(
			target,
			"no unmarked §B entry to inject the near miss into",
		).toBeTruthy();
		const heading = `### ${(target as string).split("\n")[0]}`;
		const id = /B\d+/.exec(heading)?.[0] as string;
		const nearMiss =
			"- **Over cap by ruling (#2124)** the colon sits outside the bold";
		fs.writeFileSync(
			path.join(dir, "doc-map.md"),
			map.replace(heading, `${heading}\n\n${nearMiss}`),
		);

		const report = realReport(dir);
		expect(
			report,
			"the real checker did not raise the malformed marker",
		).toContain("do not parse as one:");

		const sliced = greenReport(report, "").text.replace(/\n$/, "");
		expect(sliced).toContain("do not parse as one:");
		expect(sliced).toContain(`${id} — ${nearMiss}`);
		expect(sliced).toContain("Respell the bullet exactly");
		expect(sliced.split("\n").length).toBe(4);

		expect(
			greenReport(
				report.replace("do not parse as one:", "do not parse as one —"),
				"",
			).text,
		).toBe("");
	});

	it("anchors every marker on wording the checker still emits", () => {
		const checker = fs
			.readFileSync(path.join(ROOT, "scripts", "check-doc-map.js"), "utf8")
			.replace(/["`]\s*\+\s*\n?\s*["`]/g, "");
		const markers = [
			...REPLAY_MARKERS,
			...UNTRACKED_BLOCKS.map((b) => b.marker),
		].map((m) => m.source.replace(/\$$/, ""));
		expect(markers).toHaveLength(5);
		for (const marker of markers) {
			const literal = marker.split(".*");
			for (const part of literal)
				expect(checker, `no check-doc-map.js message emits ${part}`).toContain(
					part,
				);
		}
	});
});
