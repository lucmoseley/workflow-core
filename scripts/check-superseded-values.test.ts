// @vitest-environment node
/*
 * Pins where a superseded §B figure counts as still live, which files and
 * lines are exempt or anchored out, and when the needle data is BROKEN
 * (mantahostels#707, mantahostels#861).
 *
 * check-superseded-values.js enumerates the repo with `git ls-files`, so it is
 * exercised inside a throwaway repository rather than against this one — a
 * fixture pinned to this repo's own docs/ tree would go red on every doc added.
 *
 * Findings never gate, so a test asserting a hit also asserts exit 0. The
 * --broken-only block at the end is the exception: its subject is the exit code.
 *
 * The scan reports in the scheduled sweep (`.github/workflows/roadmap-digest.yml`),
 * and `--broken-only` is a hard gate in `.husky/pre-commit`: loosen a case and a
 * corrected figure keeps circulating unreported, or a `Supersedes` bullet with
 * no needle lands unscanned.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-superseded-values.js");
const MAP = "docs/doc-map.md";

let repo: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" });

const track = (file: string, body: string) => {
	fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
	fs.writeFileSync(path.join(repo, file), body);
	git("add", "--", file);
};

const DATA = "docs/doc-map-superseded.json";

/** Untracked, which is how the checker reads the data file in most tests. */
const write = (file: string, body: string) => {
	fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
	fs.writeFileSync(path.join(repo, file), body);
};

/** A Section A register row: path, role, class, update route, consumes. */
const row = (p: string, cls: string) =>
	`| \`${p}\` | a doc | \`${cls}\` | Direct | — |`;

/**
 * The map as the script parses it: a Section A register giving each file its
 * authority class, then Section B entries carrying `Supersedes` bullets.
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

/** A Section B entry with a single `Supersedes` bullet. */
const entry = (
	id: string,
	title: string,
	supersedes: string,
	...rest: string[]
) =>
	[
		`### ${id} · ${title}`,
		"",
		"- **Owner:** `docs/owner.md`",
		...rest,
		`- **Supersedes:** ${supersedes}`,
		"",
	].join("\n");

interface Needle {
	needle: string;
	scanned: boolean;
}

/*
 * The checker reads needles from the data file alone (#707), so the map and
 * its data file are written together: each entry's needles are the values its
 * `Supersedes` bullet bolds, scanned, unless `needles` names that entry's list.
 */
const writeMap = (
	rows: string[],
	entries: string[],
	needles: Record<string, Needle[]> = {},
) => {
	track(MAP, mapDoc(rows, entries));
	const data: Record<string, { needles: Needle[] }> = {};
	for (const body of entries) {
		const id = body.match(/^### (B\d+)/)?.[1];
		const prose = body.match(/^- \*\*Supersedes:\*\* (.*)$/m)?.[1];
		if (!id || !prose) continue;
		const bolded = [...prose.matchAll(/\*\*(.+?)\*\*/g)].map((m) => ({
			needle: m[1],
			scanned: true,
		}));
		data[id] = { needles: needles[id] ?? bolded };
	}
	if (Object.keys(data).length > 0) write(DATA, JSON.stringify(data));
	else fs.rmSync(path.join(repo, DATA), { force: true });
};

/** An entry's legitimate-hits allowlist, patched into the data file. */
const allow = (id: string, allowlist: unknown[]) => {
	const file = path.join(repo, "docs/doc-map-superseded.json");
	const data = JSON.parse(fs.readFileSync(file, "utf8"));
	data[id].allowlist = allowlist;
	fs.writeFileSync(file, JSON.stringify(data));
};

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
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "superseded-test-"));
	git("init", "-q", ".");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	track("docs/history.bin", "the run recorded $18 on its date\n");
});
afterEach(() => {
	fs.rmSync(repo, { recursive: true, force: true });
});

describe("check-superseded-values", () => {
	// A fresh adopter's day-one state: an empty §B and an empty sidecar
	// (mantahostels#3515 F11).
	it("accepts an empty sidecar beside a map with no Supersedes bullet", () => {
		track(MAP, mapDoc([row(MAP, "source-of-truth")], []));
		track(DATA, "{}\n");
		for (const args of [["--broken-only"], []]) {
			const r = check(...args);
			expect(r.status).toBe(0);
			expect(r.out).not.toMatch(/BROKEN/);
		}
	});

	it("reports a superseded figure still live in a direct-class file", () => {
		track("docs/notes.md", "the average order is $18\n");
		writeMap(
			[row("docs/notes.md", "free-edit"), row(MAP, "source-of-truth")],
			[entry("B1", "AOV ≈ $45", "retail-only **$18** AOV.")],
		);

		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/WARN/);
		expect(r.out).toContain("docs/notes.md:1");
		expect(r.out).toContain("$18");
		expect(r.out).toContain("B1");
	});

	/* #743 ruled the roadmap's done-logs allowlist-eligible — a `log:` field
	 * quoting the figure it recorded is the record of the supersession, not a
	 * stale copy — and #744 anchors them by content, because the file is one
	 * long line per card and a line pin rots on every card inserted above. */
	it("suppresses a hit by content anchor, and follows the line as it moves", () => {
		track(
			"docs/roadmap.html",
			'b:"live text $18"\nlog:"pitch settled — $18 basis gone"\n',
		);
		writeMap(
			[row("docs/roadmap.html", "source-of-truth"), row(MAP, "s")],
			[entry("B1", "AOV ≈ $45", "retail-only **$18** AOV.")],
		);
		allow("B1", [{ path: "docs/roadmap.html", anchors: ["pitch settled"] }]);

		const before = json();
		expect(before.hits).toHaveLength(1);
		expect(before.hits[0].line).toBe(1);
		expect(before.allowed).toBe(1);

		// A card inserted above: a line pin would now suppress the wrong line.
		track(
			"docs/roadmap.html",
			'b:"a new card $18"\nb:"live text $18"\nlog:"pitch settled — $18 basis gone"\n',
		);
		const after = json();
		expect(after.hits.map((h: { line: number }) => h.line)).toEqual([1, 2]);
		expect(after.allowed).toBe(1);
		expect(after.anchorNotes).toEqual([]);
	});

	it("keeps a scoped anchor's line scanned for the entry's other needles", () => {
		track(
			"docs/roadmap.html",
			'log:"pitch settled — the $18 basis and the $45 one are both gone"\n',
		);
		writeMap(
			[row("docs/roadmap.html", "source-of-truth"), row(MAP, "s")],
			[entry("B1", "AOV", "retail-only **$18** AOV, revised from **$45**.")],
		);
		allow("B1", [
			{
				path: "docs/roadmap.html",
				anchors: [{ anchor: "pitch settled", needle: "$18" }],
			},
		]);

		const r = json();
		expect(r.allowed).toBe(1);
		expect(r.hits.map((h: { needle: string }) => h.needle)).toEqual(["$45"]);
		expect(r.anchorNotes).toEqual([]);
	});

	it("reports an anchor that has stopped matching, without gating", () => {
		track("docs/roadmap.html", 'log:"the wording has since changed — $18"\n');
		writeMap(
			[row("docs/roadmap.html", "source-of-truth"), row(MAP, "s")],
			[entry("B1", "AOV ≈ $45", "retail-only **$18** AOV.")],
		);
		allow("B1", [{ path: "docs/roadmap.html", anchors: ["pitch settled"] }]);

		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("matches no line");
		expect(json().hits).toHaveLength(1);
	});

	it("exempts a file classed binary-asset in Section A", () => {
		writeMap(
			[row(MAP, "source-of-truth")],
			[entry("B1", "AOV", "**$18** AOV.")],
		);

		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("docs/history.bin");
		expect(r.out).toMatch(/^OK:/m);
	});

	it("drives the exemption off the class, not the path", () => {
		// An archive path classed free-edit is still scanned: the exemption
		// follows the register, not what the filename suggests.
		track("docs/archive/sync-reports/old-run.md", "still reads $18\n");
		writeMap(
			[row("docs/archive/sync-reports/old-run.md", "free-edit"), row(MAP, "s")],
			[entry("B1", "AOV", "**$18** AOV.")],
		);

		const r = json();
		expect(r.outcome).toBe("WARN");
		expect(r.hits.map((h: { file: string }) => h.file)).toContain(
			"docs/archive/sync-reports/old-run.md",
		);
	});

	it("exempts a file covered by a wildcard binary-asset entry", () => {
		track("docs/images/2026-08-01.svg", "carried $18 that day\n");
		writeMap(
			[row("docs/images/*", "binary-asset"), row(MAP, "s")],
			[entry("B1", "AOV", "**$18** AOV.")],
		);

		expect(check().out).not.toContain("docs/images");
	});

	it("does not report doc-map's own Section B against itself", () => {
		writeMap(
			[row(MAP, "source-of-truth")],
			[entry("B1", "AOV", "**$18** AOV.")],
		);

		const r = json();
		expect(r.hits).toEqual([]);
		expect(r.outcome).toBe("OK");
	});

	it("still reports a stale copy elsewhere in doc-map, outside Sections A and B", () => {
		writeMap(
			[row(MAP, "source-of-truth")],
			[entry("B1", "AOV", "**$18** AOV.")],
		);
		const body = fs
			.readFileSync(path.join(repo, MAP), "utf8")
			.replace(
				"## Section C — question routes",
				"## Section C — question routes\n\nStill costed at $18 here.",
			);
		track(MAP, body);

		expect(check().out).toContain(`${MAP}:`);
	});

	/* #2399: a §A cell is copied verbatim out of docs/doc-map-classes.json by
	 * the generator, so scanning both copies makes one sentence need two
	 * allowlist rows. */
	it("does not report a generated Section A table row, but does report its source", () => {
		writeMap(
			[row(MAP, "source-of-truth")],
			[entry("B1", "AOV", "**$18** AOV.")],
		);
		const body = fs
			.readFileSync(path.join(repo, MAP), "utf8")
			.replace("| a doc |", "| a doc costed at $18 |");
		track(MAP, body);
		track(
			"docs/doc-map-classes.json",
			'{"docs/x.md":{"role":"costed at $18"}}\n',
		);

		const hits = json().hits;
		expect(hits).toHaveLength(1);
		expect(hits[0].file).toBe("docs/doc-map-classes.json");
	});

	it("exits 0 however many hits there are", () => {
		const lines = Array.from({ length: 40 }, () => "priced at $18").join("\n");
		track("docs/notes.md", `${lines}\n`);
		writeMap(
			[row("docs/notes.md", "free-edit"), row(MAP, "s")],
			[entry("B1", "AOV", "**$18** AOV.")],
		);

		const r = json();
		expect(r.exit).toBe(0);
		expect(check().status).toBe(0);
		expect(r.count).toBe(40);
	});

	it("does not match a longer number containing the needle", () => {
		track("docs/notes.md", "$180 and $18.50 and 4.37% and 137%\n");
		writeMap(
			[row("docs/notes.md", "free-edit"), row(MAP, "s")],
			[
				entry("B1", "AOV", "**$18** AOV."),
				entry("B6", "Concentration", "**~37%**, one vendor only."),
			],
		);

		const r = json();
		expect(r.hits).toEqual([]);
	});

	it("matches a percentage with or without its tilde, and across dash forms", () => {
		track("docs/notes.md", "37% here\nabout $0.40-0.75 there\n");
		writeMap(
			[row("docs/notes.md", "free-edit"), row(MAP, "s")],
			[
				entry(
					"B6",
					"Concentration",
					"**~37%**, which counted one vendor only.",
				),
				entry("B2", "Referral", "**$0.40–0.75** off the old AOV."),
			],
		);

		const r = json();
		expect(r.hits.map((h: { needle: string }) => h.needle).sort()).toEqual([
			"$0.40–0.75",
			"~37%",
		]);
	});

	it("lists an entry whose superseded value is a bare number as unscanned", () => {
		track("docs/notes.md", "the pool was 61 properties\n");
		writeMap(
			[row("docs/notes.md", "free-edit"), row(MAP, "s")],
			[entry("B7", "Chain", "S2 pool **61** · call list **26–28**.")],
			{
				B7: [
					{ needle: "61", scanned: false },
					{ needle: "call list 26–28", scanned: true },
				],
			},
		);

		const r = json();
		expect(r.hits).toEqual([]);
		const unscanned = r.unscanned.find(
			(u: { entry: string }) => u.entry === "B7",
		);
		expect(unscanned.spans).toContain("61");
		expect(check().out).toMatch(/unscanned|not scanned/i);
	});

	it("flags a needle that is also a live figure in another entry", () => {
		track("docs/notes.md", "the card says 93%\n");
		writeMap(
			[row("docs/notes.md", "free-edit"), row(MAP, "s")],
			[
				entry(
					"B16",
					"Consideration set",
					"a **set of ten**, which gave **~93%**.",
					"- **Restated in:** `partner-pipeline` — **93%** = 1 − C(10,6)/C(14,6)",
				),
			],
		);

		const r = json();
		const hit = r.hits[0];
		expect(hit.needle).toBe("~93%");
		expect(hit.ambiguous).toBe(true);
		expect(check().out).toMatch(/also live/i);
	});

	it("requires a heading word on the line before reporting a name", () => {
		track(
			"docs/notes.md",
			"Juniper House Velmora, 8.80\nthe pilot node is Velmora\n",
		);
		writeMap(
			[row("docs/notes.md", "free-edit"), row(MAP, "s")],
			[entry("B11", "Pilot node — Brennick", "**Velmora** as pilot.")],
		);

		const r = json();
		expect(r.hits.map((h: { line: number }) => h.line)).toEqual([2]);
	});

	it("reads a name as a claim only in prose, not in data or fixtures", () => {
		track("docs/data/nodes.csv", "id,node\n1,Velmora pilot node\n");
		track("docs/notes.md", "the pilot node is Velmora\n");
		writeMap(
			[
				row("docs/data/nodes.csv", "free-edit"),
				row("docs/notes.md", "free-edit"),
				row(MAP, "s"),
			],
			[entry("B11", "Pilot node — Brennick", "**Velmora** as pilot.")],
		);

		const r = json();
		expect(r.hits.map((h: { file: string }) => h.file)).toEqual([
			"docs/notes.md",
		]);
	});

	it("reports one value stated twice in a bullet only once", () => {
		track("docs/notes.md", "the card says 93%\n");
		writeMap(
			[row("docs/notes.md", "free-edit"), row(MAP, "s")],
			[entry("B16", "Set", "gave **~93%**, and both read **93%**.")],
		);

		const r = json();
		expect(r.hits.length).toBe(1);
	});

	it("treats a collision-hazard bullet as evidence the needle is also live", () => {
		track("docs/notes.md", "37% of members disagree\n");
		writeMap(
			[row("docs/notes.md", "free-edit"), row(MAP, "s")],
			[
				entry(
					"B6",
					"Concentration",
					"**~37%**, one vendor only.",
					"- **⚠ Collision hazard:** an unrelated, still-correct **37%** in the audit.",
				),
			],
		);

		expect(json().hits[0].ambiguous).toBe(true);
	});

	it("keeps a collision-hazard bullet that says which twin is superseded", () => {
		// The real B6 bullet closes "Only the concentration one is superseded". The
		// fixture mirrors that wording deliberately — drop it and this collapses
		// into the test above, which is why that one passed while B6 did not.
		track("docs/notes.md", "37% of members disagree\n");
		writeMap(
			[row("docs/notes.md", "free-edit"), row(MAP, "s")],
			[
				entry(
					"B6",
					"Concentration",
					"**~37%**, one vendor only.",
					"- **⚠ Collision hazard:** an unrelated, still-correct **37%** in the" +
						" audit. Only the concentration one is superseded.",
				),
			],
		);

		expect(json().hits[0].ambiguous).toBe(true);
	});

	it("skips a binary-asset file and one holding a NUL byte", () => {
		track("docs/blob.bin", "$18 binary\n");
		writeMap(
			[row("docs/blob.bin", "binary-asset"), row(MAP, "s")],
			[entry("B1", "AOV", "**$18** AOV.")],
		);

		expect(check().out).not.toContain("docs/blob.bin");
	});

	it("does not report its own source or tests, which quote needles by design", () => {
		track("scripts/check-superseded-values.js", "// e.g. the superseded $18\n");
		track("scripts/check-superseded-values.test.ts", 'track("x", "$18")\n');
		writeMap([row(MAP, "s")], [entry("B1", "AOV", "**$18** AOV.")]);

		expect(json().hits).toEqual([]);
	});

	it("does not read a bullet ruling the old value out as evidence it is live", () => {
		track("docs/notes.md", "priced at $18\n");
		writeMap(
			[row("docs/notes.md", "free-edit"), row(MAP, "s")],
			[
				entry(
					"B1",
					"AOV",
					"retail-only **$18**.",
					"- **Inputs:** on the **$45** blended AOV, never the superseded **$18**",
				),
			],
		);

		expect(json().hits[0].ambiguous).toBe(false);
	});

	it("is BROKEN when Section A parses no row", () => {
		writeMap([], [entry("B1", "AOV", "**$18** AOV.")]);
		const doc = mapDoc([], [entry("B1", "AOV", "**$18** AOV.")]).replace(
			`${row("docs/history.bin", "binary-asset")}\n`,
			"",
		);
		track(MAP, doc);

		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("no Section A row parsed");
	});

	it("is BROKEN when the map cannot be read", () => {
		const r = check("docs/absent.md");
		expect(r.status).toBe(2);
		expect(r.out).toMatch(/BROKEN/);
	});

	/*
	 * #268 bug 1 (the bugs this checker inherited from the copy it was made
	 * from). `git ls-files` states repo-relative paths, so the map is recognised
	 * as itself only once the CLI argument is in that same form.
	 */
	it("skips Section B when the map is named by a non-canonical path", () => {
		writeMap([row(MAP, "s")], [entry("B1", "AOV", "retail-only **$18** AOV.")]);

		const canonical = json(MAP);
		const prefixed = json(`./${MAP}`);
		expect(prefixed.hits).toEqual(canonical.hits);
		expect(prefixed.hits.every((h: { file: string }) => h.file !== MAP)).toBe(
			true,
		);
	});

	/*
	 * #268 bug 3. The exempt count is counted against the Section A matchers, not
	 * as the scan's shortfall, which also swept in the self-excluded files.
	 */
	it("counts as exempt only what Section A exempts, not its own source", () => {
		track("scripts/check-superseded-values.js", "// quotes $18\n");
		writeMap([row(MAP, "s")], [entry("B1", "AOV", "**$18** AOV.")]);

		// docs/history.bin is the one binary-asset row every fixture map carries.
		expect(json().exempt).toBe(1);
		expect(check().out).toContain("(1 exempt by class, 0 hit(s) allowlisted)");
	});

	it("is OK when no Section B entry carries a Supersedes line", () => {
		writeMap(
			[row(MAP, "source-of-truth")],
			["### B1 · AOV", "", "- **Owner:** `docs/owner.md`", ""],
		);

		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/^OK:/m);
	});
});

/*
 * Needles come from doc-map-superseded.json and from nowhere else (#707), so
 * these write it directly, over whatever writeMap derived from the map.
 * The file is untracked in most of them deliberately — the checker reads it
 * from disk; the exemption test tracks it, because that is the state in which
 * a needle could self-report.
 */
describe("the needle data file", () => {
	it("greps the needle the file states, not the one the prose bolds", () => {
		track("docs/notes.md", "the average order is $18 or $45\n");
		writeMap(
			[row("docs/notes.md", "free-edit")],
			[entry("B1", "AOV", "retail-only **$45**.")],
		);
		write(
			DATA,
			JSON.stringify({
				B1: { needles: [{ needle: "$18", scanned: true }] },
			}),
		);
		const j = json();
		expect(j.hits).toMatchObject([
			{ entry: "B1", needle: "$18", file: "docs/notes.md" },
		]);
	});

	it("keeps the scanned/unscanned split the file states", () => {
		track("docs/notes.md", "pool is 61 again\n");
		writeMap([], [entry("B2", "pool", "**x**")]);
		write(
			DATA,
			JSON.stringify({
				B2: { needles: [{ needle: "61", scanned: false }] },
			}),
		);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("Not scanned");
		expect(r.out).toContain("§B2: 61");
		expect(json().hits).toHaveLength(0);
	});

	it("still qualifies a non-numeric needle against the entry's heading", () => {
		track("docs/notes.md", "Velmora as the pilot node\nVelmora Beach Road\n");
		writeMap([], [entry("B3", "pilot node choice", "**x**")]);
		write(
			DATA,
			JSON.stringify({
				B3: {
					needles: [{ needle: "Velmora", scanned: true }],
				},
			}),
		);
		const j = json();
		expect(j.hits).toMatchObject([{ file: "docs/notes.md", line: 1 }]);
	});

	it("exempts all three data files from the scan itself", () => {
		track("docs/notes.md", "the average order is $18\n");
		writeMap([], [entry("B1", "AOV", "**x**")]);
		track(
			DATA,
			JSON.stringify({
				B1: { needles: [{ needle: "$18", scanned: true }] },
			}),
		);
		track(
			"docs/doc-map-retired-vocabulary.json",
			JSON.stringify({ B1: { phrases: [{ literal: "$18" }] } }),
		);
		track(
			"docs/doc-map-restatements.json",
			JSON.stringify({ B1: [{ path: "docs/a.md", locator: "$18" }] }),
		);
		const j = json();
		expect(j.hits).toMatchObject([{ file: "docs/notes.md" }]);
	});

	/*
	 * The allowlist (#707). Some superseded values can never be fixed — a
	 * compliance document's history row records the figure it replaced, and §9 of
	 * those documents says rows are never edited — so without a suppression they
	 * report forever.
	 */
	it("suppresses an allowlisted line and counts it", () => {
		track("docs/notes.md", "history: was $18\nstill priced at $18\n");
		writeMap(
			[row("docs/notes.md", "free-edit")],
			[entry("B1", "AOV", "**x**")],
		);
		write(
			DATA,
			JSON.stringify({
				B1: {
					needles: [{ needle: "$18", scanned: true }],
					allowlist: [{ path: "docs/notes.md", lines: [1] }],
				},
			}),
		);
		const j = json();
		expect(j.hits).toMatchObject([{ file: "docs/notes.md", line: 2 }]);
		expect(j.allowed).toBe(1);
		expect(check().out).toContain("1 hit(s) allowlisted");
	});

	/* The line-pin diagnostic (#847), shared with check-retired-vocabulary.js
	 * through the resolver: a pin whose line has stopped carrying the needle
	 * suppresses nothing, and used to say nothing about it. */
	it("names a line pin whose line no longer carries the needle", () => {
		track("docs/notes.md", "a row inserted above\nhistory: was $18\n");
		writeMap(
			[row("docs/notes.md", "free-edit")],
			[entry("B1", "AOV", "**x**")],
		);
		write(
			DATA,
			JSON.stringify({
				B1: {
					needles: [{ needle: "$18", scanned: true }],
					allowlist: [{ path: "docs/notes.md", lines: [1] }],
				},
			}),
		);
		const j = json();
		expect(j.pinNotes).toMatchObject([
			{ entry: "B1", file: "docs/notes.md", line: 1 },
		]);
		// The hit the pin has stopped covering reports under its own name.
		expect(j.hits).toMatchObject([{ file: "docs/notes.md", line: 2 }]);
		expect(check().out).toContain("line pin(s)");
	});

	it("says nothing about a pin still sitting on its needle", () => {
		track("docs/notes.md", "history: was $18\nstill priced at $18\n");
		writeMap(
			[row("docs/notes.md", "free-edit")],
			[entry("B1", "AOV", "**x**")],
		);
		write(
			DATA,
			JSON.stringify({
				B1: {
					needles: [{ needle: "$18", scanned: true }],
					allowlist: [{ path: "docs/notes.md", lines: [1] }],
				},
			}),
		);
		expect(json().pinNotes).toEqual([]);
	});

	/* A pin is judged by what would in fact have hit its line, not by the raw
	 * pattern: "Velmora" alone is an address, and only a line also carrying a
	 * word from the entry's heading is a hit. So a pin on the address line
	 * covers nothing and is named. */
	it("judges a pin on a non-numeric needle by the heading-word filter", () => {
		track("docs/notes.md", "Velmora Beach Road\nVelmora as the pilot node\n");
		writeMap(
			[row("docs/notes.md", "free-edit")],
			[entry("B3", "pilot node choice", "**x**")],
		);
		write(
			DATA,
			JSON.stringify({
				B3: {
					needles: [{ needle: "Velmora", scanned: true }],
					allowlist: [{ path: "docs/notes.md", lines: [1] }],
				},
			}),
		);
		const j = json();
		expect(j.pinNotes).toMatchObject([{ entry: "B3", line: 1 }]);
		expect(j.hits).toMatchObject([{ file: "docs/notes.md", line: 2 }]);
	});

	/* A non-numeric needle is scanned in prose only — in data a name is a key —
	 * so a pin on one in a data file was never suppressing a hit either. */
	it("names a pin on a prose-only needle sitting in a data file", () => {
		track("docs/data.json", '{ "node": "Velmora pilot node" }\n');
		writeMap(
			[row("docs/data.json", "free-edit")],
			[entry("B3", "pilot node choice", "**x**")],
		);
		write(
			DATA,
			JSON.stringify({
				B3: {
					needles: [{ needle: "Velmora", scanned: true }],
					allowlist: [{ path: "docs/data.json", lines: [1] }],
				},
			}),
		);
		const j = json();
		expect(j.hits).toEqual([]);
		expect(j.pinNotes).toMatchObject([{ entry: "B3", file: "docs/data.json" }]);
	});

	it("suppresses a whole file where the allowlist states no lines", () => {
		track("docs/fixtures.md", "quotes $18\nand $18 again\n");
		track("docs/notes.md", "still priced at $18\n");
		writeMap(
			[row("docs/fixtures.md", "free-edit"), row("docs/notes.md", "free-edit")],
			[entry("B1", "AOV", "**x**")],
		);
		write(
			DATA,
			JSON.stringify({
				B1: {
					needles: [{ needle: "$18", scanned: true }],
					allowlist: [{ path: "docs/fixtures.md", lines: [] }],
				},
			}),
		);
		const j = json();
		expect(j.hits).toMatchObject([{ file: "docs/notes.md" }]);
		expect(j.allowed).toBe(2);
	});

	it("applies an allowlist only to its own entry", () => {
		track("docs/notes.md", "was $18 at 37%\n");
		writeMap(
			[row("docs/notes.md", "free-edit")],
			[entry("B1", "AOV", "**x**"), entry("B6", "Concentration", "**y**")],
		);
		write(
			DATA,
			JSON.stringify({
				B1: {
					needles: [{ needle: "$18", scanned: true }],
					allowlist: [{ path: "docs/notes.md", lines: [1] }],
				},
				B6: { needles: [{ needle: "37%", scanned: true }] },
			}),
		);
		const j = json();
		expect(j.hits).toMatchObject([{ entry: "B6", needle: "37%" }]);
		expect(j.allowed).toBe(1);
	});

	/*
	 * The hazard the relocation creates: with the prose no longer a source, an
	 * entry whose bullet never reached the data file is scanned by nothing while
	 * the summary still counts as though it were.
	 */
	/** B6 supersedes something and has no data key; B1 is otherwise sound. */
	const writeUncovered = () => {
		writeMap(
			[],
			[entry("B1", "AOV", "**$18**."), entry("B6", "Conc", "**37%**")],
		);
		write(
			DATA,
			JSON.stringify({
				B1: { needles: [{ needle: "$18", scanned: true }] },
			}),
		);
	};

	it("is BROKEN where an entry carries a Supersedes bullet but no data key", () => {
		writeUncovered();
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("B6");
		expect(r.out).toContain("scanned by");
		expect(r.out).toContain("whose needles are the values it supersedes");
	});

	it("is BROKEN where the data file is missing but an entry supersedes something, naming the file", () => {
		writeMap([], [entry("B1", "AOV", "**$18**.")]);
		fs.rmSync(path.join(repo, DATA));
		const r = check();
		expect(r.status).toBe(2);
		/* The message, not just the exit code: the uncovered-entry assertion below
		 * also exits 2 here, and the two remedies differ — restore the file,
		 * versus add one entry's key to it. */
		expect(r.out).toContain("doc-map-superseded.json");
		expect(r.out).toContain("is missing");
	});

	it("is OK where the file is missing and no entry supersedes anything", () => {
		track("docs/notes.md", "nothing stale here\n");
		writeMap([row("docs/notes.md", "free-edit")], [entry("B1", "AOV", "")]);
		expect(fs.existsSync(path.join(repo, DATA))).toBe(false);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/^OK:/m);
	});

	// A day-one map (#395 Q1).
	it("skips by name on a §B with no entry, even with no Section A row", () => {
		track(
			MAP,
			mapDoc([], []).replace(
				`${row("docs/history.bin", "binary-asset")}\n`,
				"",
			),
		);
		const r = check();
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP: docs/doc-map.md has no §B entry yet");
	});

	it("is BROKEN where the data file keys an entry the map lacks, naming the key", () => {
		writeMap([], [entry("B1", "AOV", "**x**")]);
		write(
			DATA,
			JSON.stringify({
				B9: { needles: [{ needle: "$18", scanned: true }] },
			}),
		);
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("B9");
	});

	it("is BROKEN on a data file that exists but will not load, naming it — never a fallback", () => {
		writeMap([], [entry("B1", "AOV", "**$18**.")]);
		write(DATA, "{ not json");
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("doc-map-superseded.json");
	});

	it("takes the data directory from --data-dir", () => {
		track("docs/notes.md", "the average order is $18\n");
		writeMap([], [entry("B1", "AOV", "**x**")]);
		write(
			"dd/doc-map-superseded.json",
			JSON.stringify({
				B1: { needles: [{ needle: "$18", scanned: true }] },
			}),
		);
		expect(json("--data-dir", "dd").hits).toMatchObject([
			{ file: "docs/notes.md" },
		]);
	});
});

/*
 * The mode .husky/pre-commit gates on (#861).
 */
describe("--broken-only", () => {
	const writeData = (body: string) =>
		fs.writeFileSync(path.join(repo, DATA), body);

	it("is BROKEN where an entry carries a Supersedes bullet with no key", () => {
		/* Two entries, one keyed: an empty file is BROKEN a step earlier, so the
		 * uncovered-entry branch needs a data file that is otherwise sound. */
		writeMap(
			[],
			[
				entry("B1", "AOV", "retail-only **$18** AOV."),
				entry("B2", "Take", "**$45** take."),
			],
		);
		writeData(
			JSON.stringify({
				B2: { needles: [{ needle: "$45", scanned: true }] },
			}),
		);
		const r = check("--broken-only");
		expect(r.status).toBe(2);
		expect(r.out).toContain("B1");
	});

	/* The guarantee the hook rests on: a stale value live in the tree is a WARN
	 * finding, and this mode must not see it at all. */
	it("never gates on a live stale value, and does not scan for one", () => {
		track("docs/notes.md", "the average order is $18\n");
		writeMap(
			[row("docs/notes.md", "free-edit"), row(MAP, "source-of-truth")],
			[entry("B1", "AOV ≈ $45", "retail-only **$18** AOV.")],
		);
		expect(check().out).toContain("docs/notes.md");
		const r = check("--broken-only");
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("docs/notes.md");
	});

	it("still fails on a data file that will not load", () => {
		writeMap([], [entry("B1", "AOV", "**$18**.")]);
		writeData("{ not json");
		expect(check("--broken-only").status).toBe(2);
	});
});

describe("an entry's fields", () => {
	it("is BROKEN where an entry carries a field beside its needles and allowlist", () => {
		writeMap([], [entry("B1", "AOV", "retail-only **$18** AOV.")]);
		fs.writeFileSync(
			path.join(repo, DATA),
			JSON.stringify({
				B1: {
					text: "retail-only **$18** AOV.",
					needles: [{ needle: "$18", scanned: true }],
				},
			}),
		);
		const r = check("--broken-only");
		expect(r.status).toBe(2);
		expect(r.out).toContain("B1 carries unknown field(s) text");
	});
});
