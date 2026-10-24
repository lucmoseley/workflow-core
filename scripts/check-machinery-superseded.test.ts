// @vitest-environment node
/*
 * Pins that check-machinery-superseded.js reports a retired repo-machinery
 * figure from docs/machinery-superseded.json still live in a tracked file, in
 * either of its spellings (mantahostels#1440).
 *
 * check-machinery-superseded.js enumerates the repo with `git ls-files`, so it
 * is exercised inside a throwaway repository rather than against this one — a
 * fixture pinned to this repo's own docs/ tree would go red on every doc added.
 *
 * Findings never gate, so a test asserting a hit also asserts exit 0. The only
 * exit codes that are ever 2 are the data file's: absent, or malformed.
 *
 * It reports in the daily repo-checks run: loosen a case and a retired
 * figure stays quoted in a live script or doc.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "check-machinery-superseded.js");
const MAP = "docs/doc-map.md";
const DATA = "docs/machinery-superseded.json";

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
 * The map as the script parses it — Section A alone. No Section B entry is ever
 * needed: the machinery registry keys join to nothing in the map (mantahostels#1440), and
 * the map is read only for the authority classes the scan exempts.
 *
 * One `binary-asset` row is always present: a Section A parsing no row is
 * BROKEN, since without the register the scan cannot tell a binary asset from
 * prose.
 */
const mapDoc = (rows: string[]) =>
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
	].join("\n");

interface Needle {
	needle: string;
	scanned: boolean;
}
interface Figure {
	needles: Needle[];
	allowlist?: unknown[];
}

const writeMap = (rows: string[]) => track(MAP, mapDoc(rows));

const writeData = (data: Record<string, Figure> | string) =>
	track(DATA, typeof data === "string" ? data : JSON.stringify(data));

/** The fan-out share, in both spellings — the figure mantahostels#1440 was built for. */
const fanout = (
	needles: Needle[] = [
		{ needle: "28.1%", scanned: true },
		{ needle: "0.281", scanned: true },
	],
): Record<string, Figure> => ({
	"fanout-share": { needles },
});

const check = (...args: string[]) => {
	const r = spawnSync("node", [SCRIPT, MAP, ...args], {
		cwd: repo,
		encoding: "utf8",
	});
	return {
		status: r.status ?? -1,
		stdout: r.stdout ?? "",
		out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
	};
};

const json = (...args: string[]) => JSON.parse(check("--json", ...args).stdout);

beforeEach(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "machinery-test-"));
	git("init", "-q", ".");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
});
afterEach(() => {
	fs.rmSync(repo, { recursive: true, force: true });
});

describe("check-machinery-superseded", () => {
	it("reports a retired percent share still live in a prose file", () => {
		track("docs/notes.md", "subagent fan-out is 28.1% of spend\n");
		writeMap([row("docs/notes.md", "free-edit"), row(MAP, "source-of-truth")]);
		writeData(fanout());

		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/WARN/);
		expect(r.out).toContain("docs/notes.md:1");
		expect(r.out).toContain("28.1%");
		expect(r.out).toContain("fanout-share");
		expect(r.out).toContain("Read the figure's current value where it is set");
	});

	/* The breach that opened mantahostels#1440: `FANOUT_SHARE = 0.281` in a measurement
	 * script, months after the share was retired. The percent needle cannot match
	 * it — needlePattern compiles `28.1%` with the literal `%` — so the decimal
	 * spelling is a needle of its own, and scripts/ is in scope. */
	it("matches the decimal spelling of a share in a Python file", () => {
		track("scripts/measure/scan.py", "FANOUT_SHARE = 0.281\n");
		writeMap([row(MAP, "source-of-truth")]);
		writeData(fanout());

		const r = json();
		expect(r.outcome).toBe("WARN");
		expect(r.hits).toHaveLength(1);
		expect(r.hits[0]).toMatchObject({
			file: "scripts/measure/scan.py",
			needle: "0.281",
			figure: "fanout-share",
		});
	});

	/* The mutation this pins: drop the decimal needle and the same file goes
	 * clean, which is the state the repo was in when mantahostels#1407 published a
	 * ~11%-wrong figure. */
	it("finds nothing in that file on the percent needle alone", () => {
		track("scripts/measure/scan.py", "FANOUT_SHARE = 0.281\n");
		writeMap([row(MAP, "source-of-truth")]);
		writeData(fanout([{ needle: "28.1%", scanned: true }]));

		const r = json();
		expect(r.outcome).toBe("OK");
		expect(r.hits).toHaveLength(0);
	});

	/* mantahostels#2399: §A's cells are copied verbatim out of docs/doc-map-classes.json by
	 * the generator, so scanning both copies makes one sentence need two
	 * allowlist rows. */
	it("does not report a generated Section A table row, but does report its source", () => {
		track(
			"docs/doc-map-classes.json",
			'{"docs/x.md":{"role":"28.1% of spend"}}\n',
		);
		writeMap([
			"| `docs/x.md` | 28.1% of spend | `free-edit` | Direct | — |",
			row(MAP, "source-of-truth"),
		]);
		writeData(fanout());

		const r = json();
		expect(r.hits).toHaveLength(1);
		expect(r.hits[0].file).toBe("docs/doc-map-classes.json");
	});

	// §A's preamble is hand-written and has no source to suppress against.
	it("reports Section A's hand-written prose", () => {
		writeMap(["fan-out was 28.1% when this preamble was written"]);
		writeData(fanout());

		const r = json();
		expect(r.hits).toHaveLength(1);
		expect(r.hits[0].file).toBe(MAP);
	});

	it("exempts a file classed binary-asset in Section A", () => {
		track("docs/history.bin", "measured 28.1% on the day\n");
		writeMap([row(MAP, "source-of-truth")]);
		writeData(fanout());

		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("docs/history.bin");
		expect(r.out).toMatch(/^OK:/m);
	});

	it("drives that exemption off the class, not the path", () => {
		track("docs/history-lookalike.md", "still reads 28.1%\n");
		writeMap([row("docs/history-lookalike.md", "free-edit"), row(MAP, "s")]);
		writeData(fanout());

		expect(json().hits.map((h: { file: string }) => h.file)).toContain(
			"docs/history-lookalike.md",
		);
	});

	it("suppresses a hit by content anchor, and follows the line as it moves", () => {
		track(
			"docs/register.md",
			"the ladder still prices 28.1%\ncorrected 28.1% to 20.0% at #1121\n",
		);
		writeMap([row("docs/register.md", "source-of-truth"), row(MAP, "s")]);
		const data = fanout();
		data["fanout-share"].allowlist = [
			{ path: "docs/register.md", anchors: ["corrected"] },
		];
		writeData(data);

		const before = json();
		expect(before.hits).toHaveLength(1);
		expect(before.hits[0].line).toBe(1);
		expect(before.allowed).toBe(1);

		// A line inserted above: a line pin would now suppress the wrong line.
		track(
			"docs/register.md",
			"a new line 28.1%\nthe ladder still prices 28.1%\ncorrected 28.1% to 20.0% at #1121\n",
		);
		const after = json();
		expect(after.hits.map((h: { line: number }) => h.line)).toEqual([1, 2]);
		expect(after.allowed).toBe(1);
		expect(after.anchorNotes).toEqual([]);
	});

	it("reports an anchor that has stopped matching, without gating", () => {
		track("docs/register.md", "the wording has since changed — 28.1%\n");
		writeMap([row("docs/register.md", "source-of-truth"), row(MAP, "s")]);
		const data = fanout();
		data["fanout-share"].allowlist = [
			{ path: "docs/register.md", anchors: ["corrected at #1121"] },
		];
		writeData(data);

		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("matches no line");
		expect(json().hits).toHaveLength(1);
	});

	/* Every needle is live in the file that lists them, by construction. */
	it("never reports its own data file", () => {
		writeMap([row(MAP, "source-of-truth"), row(DATA, "source-of-truth")]);
		writeData(fanout());

		const r = json();
		expect(r.outcome).toBe("OK");
		expect(r.hits).toHaveLength(0);
	});

	it("lists an unscanned span for by-hand checking rather than grepping it", () => {
		track("docs/notes.md", "a coefficient of 0.13 and a p of 0.13\n");
		writeMap([row("docs/notes.md", "free-edit"), row(MAP, "s")]);
		writeData({
			"thinking-share": {
				needles: [
					{ needle: "13.0%", scanned: true },
					{ needle: "0.13", scanned: false },
				],
			},
		});

		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/^OK:/m);
		expect(r.out).toContain("Not scanned");
		expect(r.out).toContain("0.13");
	});

	it("is BROKEN where the data file is missing, naming the file", () => {
		writeMap([row(MAP, "source-of-truth")]);
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain(DATA);
	});

	it("is BROKEN where the data file will not load", () => {
		writeMap([row(MAP, "source-of-truth")]);
		writeData("{ not json");
		expect(check().status).toBe(2);
	});

	it("is BROKEN where an entry carries a field beside its needles and allowlist", () => {
		writeMap([row(MAP, "source-of-truth")]);
		writeData(
			JSON.stringify({
				"fanout-share": {
					figure: "Subagent fan-out",
					needles: [{ needle: "28.1%", scanned: true }],
				},
			}),
		);
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("fanout-share carries unknown field(s) figure");
	});

	it("is BROKEN where a needle states no scanned flag", () => {
		writeMap([row(MAP, "source-of-truth")]);
		writeData(
			JSON.stringify({
				"fanout-share": {
					needles: [{ needle: "28.1%" }],
				},
			}),
		);
		expect(check().status).toBe(2);
	});

	it("is BROKEN where a key is not a kebab-case figure name", () => {
		writeMap([row(MAP, "source-of-truth")]);
		writeData(
			JSON.stringify({
				"Fanout Share": {
					needles: [{ needle: "28.1%", scanned: true }],
				},
			}),
		);
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("Fanout Share");
	});

	it("is BROKEN where Section A parses no row at all", () => {
		track(
			MAP,
			mapDoc([]).replace(`${row("docs/history.bin", "binary-asset")}\n`, ""),
		);
		writeData(fanout());
		expect(check().status).toBe(2);
	});
});
