// @vitest-environment node
/*
 * Pins that check-restatement-edges.js reports a tracked file carrying a §B
 * figure's current value that the entry's `Restated in:` list does not name,
 * as a candidate and never a verdict (mantahostels#1104).
 *
 * check-restatement-edges.js enumerates the repo with `git ls-files`, so it is
 * exercised inside a throwaway repository rather than against this one — a
 * fixture pinned to this repo's own docs/ tree would go red on every doc added.
 *
 * Findings never gate, so a test asserting a candidate edge also asserts exit 0.
 *
 * It reports in the daily repo-checks run: loosen a case and a file the
 * restatement list misses is skipped by every propagation pass, leaving a
 * stale figure live.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-restatement-edges.js");
const MAP = "docs/doc-map.md";
const RESTATEMENTS = "docs/doc-map-restatements.json";
const ALLOWLIST = "docs/doc-map-restatement-allowlist.json";

let repo: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" });

const track = (file: string, body: string) => {
	fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
	fs.writeFileSync(path.join(repo, file), body);
	git("add", "--", file);
};

/** A Section A register row: path, role, class, update route, consumes. */
const row = (p: string, cls: string) =>
	`| \`${p}\` | a doc | \`${cls}\` | Direct | — |`;

/**
 * The map as the script parses it: a Section A register giving each file its
 * authority class, then Section B entries whose headings carry the figure.
 *
 * One `binary-asset` row is always present — the script treats a Section A
 * that parses no row as unreadable, since without the register the scan cannot
 * tell a binary asset from prose.
 */
const mapDoc = (rows: string[], entries: string[]) =>
	[
		"# Doc map",
		"",
		"## Section A — document register",
		"",
		"| Path | Role | Class | Update route | Consumes |",
		"|---|---|---|---|---|",
		row("docs/history.bin", "binary-asset"),
		...rows,
		"",
		"## Section B — load-bearing figure registry",
		"",
		...entries,
		"",
		"## Section C — question routes",
		"",
	].join("\n");

/** A Section B entry: the heading states the figure, the bullets its sources. */
const entry = (id: string, title: string, ...bullets: string[]) =>
	[
		`### ${id} · ${title}`,
		"",
		"- **Owner:** `docs/owner.md`",
		...bullets,
		"",
	].join("\n");

/** The restatement edges the entry already has, keyed by entry id. */
const edges = (
	data: Record<
		string,
		{
			paths: { path: string; locator?: string; gloss?: string }[];
			note?: string;
		}
	>,
) => track(RESTATEMENTS, JSON.stringify(data));

const allow = (data: unknown) => track(ALLOWLIST, JSON.stringify(data));

const writeMap = (rows: string[], entries: string[]) =>
	track(MAP, mapDoc(rows, entries));

const check = (...args: string[]) => {
	const r = runInProcess(SCRIPT, args, { cwd: repo });
	return {
		status: r.status,
		stdout: r.stdout,
		out: `${r.stdout}${r.stderr}`,
	};
};

const json = (...args: string[]) => JSON.parse(check("--json", ...args).stdout);

beforeEach(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "restatement-edges-test-"));
	git("init", "-q", ".");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	track("docs/history.bin", "on its date the figure was $45\n");
	edges({ B1: { paths: [{ path: "docs/owner.md" }] } });
	track("docs/owner.md", "the blended average order value is $45\n");
});
afterEach(() => {
	fs.rmSync(repo, { recursive: true, force: true });
});

describe("check-restatement-edges", () => {
	it("reports a file carrying the current figure that the entry does not name", () => {
		track("docs/pitch.md", "we assume $45 an order\n");
		writeMap(
			[
				row("docs/pitch.md", "free-edit"),
				row("docs/owner.md", "s"),
				row(MAP, "s"),
			],
			[entry("B1", "Blended average order value ≈ $45")],
		);

		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/WARN/);
		expect(r.out).toContain("docs/pitch.md:1");
		expect(r.out).toContain("B1");
	});

	it("drops the file once the entry's restatement list names it", () => {
		track("docs/pitch.md", "we assume $45 an order\n");
		writeMap(
			[
				row("docs/pitch.md", "free-edit"),
				row("docs/owner.md", "s"),
				row(MAP, "s"),
			],
			[entry("B1", "Blended average order value ≈ $45")],
		);
		expect(json().hits).toHaveLength(1);

		edges({
			B1: {
				paths: [{ path: "docs/owner.md" }, { path: "pitch.md", locator: "L1" }],
			},
		});
		const after = json();
		expect(after.hits).toEqual([]);
		expect(after.outcome).toBe("OK");
	});

	it("does not report a file the entry names in prose rather than its list", () => {
		track("docs/inputs.md", "the retail leg totals $45\n");
		writeMap(
			[
				row("docs/inputs.md", "free-edit"),
				row("docs/owner.md", "s"),
				row(MAP, "s"),
			],
			[
				entry(
					"B1",
					"Blended average order value ≈ $45",
					"- **Inputs:** derived in `docs/inputs.md`",
				),
			],
		);

		expect(json().hits).toEqual([]);
	});

	it("does not report a file named only in a sidecar gloss", () => {
		track("docs/glossed.md", "the retail leg totals $45\n");
		writeMap(
			[
				row("docs/glossed.md", "free-edit"),
				row("docs/owner.md", "s"),
				row(MAP, "s"),
			],
			[entry("B1", "Blended average order value ≈ $45")],
		);
		const before = check();
		expect(before.status).toBe(0);
		expect(before.out).toContain("docs/glossed.md:1");

		edges({
			B1: {
				paths: [
					{
						path: "docs/owner.md",
						gloss: "derived alongside `docs/glossed.md`",
					},
				],
			},
		});
		const after = json();
		expect(after.hits).toEqual([]);
		expect(after.outcome).toBe("OK");
	});

	it("still reports a file the sidecar's note or locator names, which as often denies the edge as cites it", () => {
		track("docs/noted.md", "the retail leg totals $45\n");
		writeMap(
			[
				row("docs/noted.md", "free-edit"),
				row("docs/owner.md", "s"),
				row(MAP, "s"),
			],
			[entry("B1", "Blended average order value ≈ $45")],
		);
		edges({
			B1: {
				paths: [{ path: "docs/owner.md", locator: "beside `docs/noted.md`" }],
				note: "Not a restatement: `docs/noted.md`",
			},
		});

		const r = check();
		expect(r.status).toBe(0);
		expect(json().hits.map((h: { file: string }) => h.file)).toEqual([
			"docs/noted.md",
		]);
	});

	it("reads a gloss's inline code only, not a bare path in its prose", () => {
		track("docs/bare.md", "the retail leg totals $45\n");
		writeMap(
			[
				row("docs/bare.md", "free-edit"),
				row("docs/owner.md", "s"),
				row(MAP, "s"),
			],
			[entry("B1", "Blended average order value ≈ $45")],
		);
		edges({
			B1: {
				paths: [
					{ path: "docs/owner.md", gloss: "derived beside docs/bare.md" },
				],
			},
		});

		expect(json().hits.map((h: { file: string }) => h.file)).toEqual([
			"docs/bare.md",
		]);
	});

	it("suppresses a fixture hit by content anchor, and follows the line as it moves", () => {
		track("scripts/thing.test.ts", 'live text $45\nconst fixture = "$45";\n');
		writeMap(
			[row("docs/owner.md", "s"), row(MAP, "s")],
			[entry("B1", "Blended average order value ≈ $45")],
		);
		allow({
			B1: [{ path: "scripts/thing.test.ts", anchors: ["const fixture"] }],
		});

		const before = json();
		expect(before.hits[0].line).toBe(1);
		expect(before.allowed).toBe(1);

		track("scripts/thing.test.ts", 'const fixture = "$45";\nlive text $45\n');
		const after = json();
		expect(after.hits[0].line).toBe(2);
		expect(after.allowed).toBe(1);
		expect(after.anchorNotes).toEqual([]);
	});

	it("reports an anchor that has stopped matching, without gating", () => {
		track("scripts/thing.test.ts", "the fixture was renamed — $45\n");
		writeMap(
			[row("docs/owner.md", "s"), row(MAP, "s")],
			[entry("B1", "Blended average order value ≈ $45")],
		);
		allow({
			B1: [{ path: "scripts/thing.test.ts", anchors: ["const fixture"] }],
		});

		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("matches no line");
		expect(json().hits).toHaveLength(1);
	});

	it("skips a file the entry names before the allowlist, so its anchor cannot rot in silence", () => {
		// Both mechanisms cover the same fixture; the entry's own prose wins (mantahostels#1104).
		track("scripts/thing.test.ts", 'const fixture = "$45";\n');
		writeMap(
			[row("docs/owner.md", "s"), row(MAP, "s")],
			[
				entry(
					"B1",
					"Blended average order value \u2248 $45",
					"- **Legitimate hits:** `scripts/thing.test.ts`",
				),
			],
		);
		allow({
			B1: [{ path: "scripts/thing.test.ts", anchors: ["renamed away"] }],
		});

		expect(check().status).toBe(0);
		const r = json();
		expect(r.hits).toEqual([]);
		expect(r.allowed).toBe(0);
		expect(r.anchorNotes).toEqual([]);
	});

	it("exempts a file classed binary-asset in Section A", () => {
		// docs/history.bin carries the same $45 and is registered binary-asset.
		writeMap(
			[row("docs/owner.md", "s"), row(MAP, "s")],
			[entry("B1", "Blended average order value ≈ $45")],
		);

		const r = check();
		expect(r.out).not.toContain("docs/history.bin");
		expect(r.out).toMatch(/^OK:/m);
	});

	it("does not report the map itself, which states the figure rather than restating it", () => {
		writeMap(
			[row("docs/owner.md", "s"), row(MAP, "s")],
			[entry("B1", "Blended average order value ≈ $45")],
		);

		expect(json().hits).toEqual([]);
	});

	it("scans a bare count only where the line carries a heading word", () => {
		track("docs/catalogue.md", "the launch catalogue is 205 properties\n");
		track("docs/timings.md", "the probe waited 205 milliseconds\n");
		writeMap(
			[
				row("docs/catalogue.md", "free-edit"),
				row("docs/timings.md", "free-edit"),
				row("docs/owner.md", "s"),
				row(MAP, "s"),
			],
			[entry("B1", "The launch catalogue is 205 properties")],
		);

		const files = json().hits.map((h: { file: string }) => h.file);
		expect(files).toEqual(["docs/catalogue.md"]);
	});

	it("takes no needle from an issue number or a year in the heading", () => {
		track("docs/plan.md", "settled at #631, ramping to mid-2029\n");
		writeMap(
			[
				row("docs/plan.md", "free-edit"),
				row("docs/owner.md", "s"),
				row(MAP, "s"),
			],
			[entry("B1", "The ramp reaches its target by mid-2029, settled at #631")],
		);

		const r = json();
		expect(r.hits).toEqual([]);
		expect(r.claims).toBe(1);
	});

	it("lists a multi-value heading as unscanned rather than grepping it", () => {
		track("docs/chain.md", "310 rows, of which 205 pass\n");
		writeMap(
			[
				row("docs/chain.md", "free-edit"),
				row("docs/owner.md", "s"),
				row(MAP, "s"),
			],
			[entry("B1", "Evidence-audit chain — 310 → 205 → 140")],
		);

		const r = json();
		expect(r.hits).toEqual([]);
		expect(r.spans).toEqual([{ entry: "B1", spans: ["310", "205", "140"] }]);
		expect(r.outcome).toBe("OK");
	});

	it("counts a claim entry as out of reach rather than clean", () => {
		writeMap(
			[row("docs/owner.md", "s"), row(MAP, "s")],
			[entry("B1", "An unjudgeable flag is excluded from both counts")],
		);

		const r = json();
		expect(r.claims).toBe(1);
		expect(r.needles).toEqual([]);
		expect(check().out).toContain("state no scannable literal");
	});

	it("runs with no allowlist file at all", () => {
		track("docs/pitch.md", "we assume $45 an order\n");
		writeMap(
			[
				row("docs/pitch.md", "free-edit"),
				row("docs/owner.md", "s"),
				row(MAP, "s"),
			],
			[entry("B1", "Blended average order value ≈ $45")],
		);

		expect(fs.existsSync(path.join(repo, ALLOWLIST))).toBe(false);
		expect(json().hits).toHaveLength(1);
	});

	it("is BROKEN where the restatement data file is missing", () => {
		fs.rmSync(path.join(repo, RESTATEMENTS));
		git("rm", "-q", "--cached", "--", RESTATEMENTS);
		writeMap(
			[row("docs/owner.md", "s"), row(MAP, "s")],
			[entry("B1", "Blended average order value ≈ $45")],
		);

		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("is missing");
	});

	it("passes where §B holds no entries and the restatement file is empty (#52)", () => {
		edges({});
		writeMap([row("docs/owner.md", "s"), row(MAP, "s")], []);

		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("BROKEN");
	});

	it("is BROKEN where the restatement data file is empty but §B holds entries (#52)", () => {
		edges({});
		writeMap(
			[row("docs/owner.md", "s"), row(MAP, "s")],
			[entry("B1", "Blended average order value ≈ $45")],
		);

		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("holds no entries");
	});

	it("is BROKEN where the allowlist exists but does not parse", () => {
		track(ALLOWLIST, "{ not json");
		writeMap(
			[row("docs/owner.md", "s"), row(MAP, "s")],
			[entry("B1", "Blended average order value ≈ $45")],
		);

		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("allowlist unreadable");
	});

	it("is BROKEN where the allowlist carries a needle-scoped anchor", () => {
		allow({
			B1: [
				{
					path: "docs/pitch.md",
					anchors: [{ anchor: "the old basis", needle: "$45" }],
				},
			],
		});
		writeMap(
			[row("docs/owner.md", "s"), row(MAP, "s")],
			[entry("B1", "Blended average order value ≈ $45")],
		);

		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("no needle in hand");
	});

	it("is BROKEN where the allowlist keys an entry the map has no heading for, naming the key", () => {
		allow({ B9: [{ path: "docs/pitch.md", lines: [] }] });
		writeMap(
			[row("docs/owner.md", "s"), row(MAP, "s")],
			[entry("B1", "Blended average order value ≈ $45")],
		);

		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("B9");
	});
});
