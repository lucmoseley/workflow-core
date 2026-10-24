// @vitest-environment node
/*
 * card-restatement-report.test.ts — the pre-cut lookup mantahostels#3339 built, driven end
 * to end through runInProcess (§X3): it has a `require.main` guard and a
 * synchronous `main`, so no spawn is owed.
 *
 * The fixtures are a map and sidecar in a temp directory, not this repo's docs/
 * — a test pinned to the live §B goes red on every entry added. `mkdtempSync`
 * alone, no git repo: the script reads files and never git state.
 *
 * The one live-tree case asserts the shape claim `roadmap-edit`'s pre-cut step
 * rests on — every roadmap locator a bare card id, so check-doc-map.js's
 * quoted-locator check reaches none of them.
 *
 * roadmap-edit's pre-cut step runs this before a card sentence is cut, and no
 * check-doc-map.js fault fires on such a cut: loosen a case and a session can
 * delete a figure §B says other documents restate, with nothing to stop it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "card-restatement-report.js");

let dir: string;
const mapFile = () => path.join(dir, "docs", "doc-map.md");

/** The two files the script reads, laid out as `docs/` beside each other. */
const write = (sidecar: unknown, map: string) => {
	fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "docs", "doc-map-restatements.json"),
		JSON.stringify(sidecar),
	);
	fs.writeFileSync(mapFile(), map);
};

const run = (...args: string[]) =>
	runInProcess(SCRIPT, [...args, "--map", mapFile()], { cwd: dir });

/** A §B section holding the entries the fixtures cite: one with a claim line, one without. */
const MAP = `## Section A

## Section B

### B1 · Blended average order value ≈ $45

- **Owner:** \`docs/operating-manual.md\`

### B2 · Referral income per routed order

- **The claim.** Referral income is ≈ $1.20 per routed order.

## Section C
`;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "card-restatements-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("card-restatement-report", () => {
	it("names every entry restating the card, under both roadmap path spellings", () => {
		write(
			{
				B1: {
					paths: [{ path: "reference-roadmap.html", locator: "`market-size`" }],
				},
				B2: {
					paths: [
						{
							path: "docs/reference-roadmap.html",
							locator: "`market-size`",
							gloss: "the log line",
						},
					],
				},
			},
			MAP,
		);
		const r = run("market-size");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("2 §B entr(ies) restate `market-size`");
		expect(r.stdout).toContain("a propagation pass, not a trim");
		expect(r.stdout).toContain("B1 · Blended average order value ≈ $45");
		expect(r.stdout).toContain("B2 · Referral income per routed order");
		expect(r.stdout).toContain("gloss: the log line");
	});

	it("prints the entry's claim line where it has one, and the heading alone otherwise", () => {
		write(
			{
				B1: { paths: [{ path: "reference-roadmap.html", locator: "`msc`" }] },
				B2: { paths: [{ path: "reference-roadmap.html", locator: "`msc`" }] },
			},
			MAP,
		);
		const r = run("msc");
		expect(r.stdout).toContain(
			"- **The claim.** Referral income is ≈ $1.20 per routed order.",
		);
		// B1 carries no claim line: its heading stands in, and nothing empty is printed.
		expect(r.stdout).toContain("B1 · Blended average order value ≈ $45");
		expect(r.stdout).not.toMatch(/\n {2}\n/);
	});

	it("exits 0 with no hits, and ignores paths that are not the roadmap", () => {
		write(
			{
				B1: {
					paths: [
						{ path: "operating-manual.md", locator: "`market-size`" },
						{ path: "reference-roadmap.html", locator: "`other-card`" },
					],
				},
			},
			MAP,
		);
		const r = run("market-size");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("No §B entry restates `market-size`");
	});

	it("reads a locator as a card id only when it is the whole locator", () => {
		write(
			{
				B1: {
					paths: [
						{ path: "reference-roadmap.html", locator: '§4 "`msc` bar"' },
						{ path: "reference-roadmap.html", locator: "`msc`" },
					],
				},
			},
			MAP,
		);
		expect(run("msc").stdout).toContain("1 §B entr(ies)");
		const audit = run("--audit");
		expect(audit.stdout).toContain(
			"2 roadmap path(s) across 1 card(s); 1 locator(s) that are not a bare card id",
		);
		expect(audit.stdout).toContain('B1 → §4 "`msc` bar"');
	});

	it("resolves docs/doc-map.md from the working directory when --map is absent", () => {
		// The flag's value is read at `mapArg + 1`, which is index 0 when there is
		// no flag: without the guard on mapArg the card id is eaten as the value.
		write(
			{ B1: { paths: [{ path: "reference-roadmap.html", locator: "`msc`" }] } },
			MAP,
		);
		const r = runInProcess(SCRIPT, ["msc"], { cwd: dir });
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("1 §B entr(ies) restate `msc`");
	});

	it("exits 2 naming what it could not read, on a missing and on a malformed sidecar", () => {
		fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
		fs.writeFileSync(mapFile(), MAP);
		const missing = run("market-size");
		expect(missing.status).toBe(2);
		expect(missing.stderr).toContain("cannot read the §B restatement record");
		expect(missing.stderr).toContain("ENOENT");

		fs.writeFileSync(
			path.join(dir, "docs", "doc-map-restatements.json"),
			"{ not json",
		);
		const malformed = run("market-size");
		expect(malformed.status).toBe(2);
		expect(malformed.stderr).toContain("cannot read the §B restatement record");
		expect(malformed.stderr).toContain("doc-map-restatements.json");
	});

	it("skips by name on a §B with no entry and an empty sidecar, in both modes (#418)", () => {
		write({}, "## Section B\n\n## Section C\n");
		for (const args of [["--audit"], ["msc"]]) {
			const r = run(...args);
			expect(r.status).toBe(0);
			expect(r.stderr).toContain("has no §B entry yet");
		}
	});

	it("stays red on an empty sidecar once §B holds an entry (#418)", () => {
		write({}, MAP);
		const r = run("--audit");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("holds no entries");
	});

	it("exits 2 naming the usage when given no card id", () => {
		write({ B1: { paths: [{ path: "reference-roadmap.html" }] } }, MAP);
		const r = runInProcess(SCRIPT, ["--map", mapFile()], { cwd: dir });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("usage: card-restatement-report.js <card-id>");
	});

	it("refuses an unknown flag at exit 2, naming it with usage, rather than reading it as the card id", () => {
		write({ B1: { paths: [{ path: "reference-roadmap.html" }] } }, MAP);
		const r = runInProcess(SCRIPT, ["--audits", "--map", mapFile()], {
			cwd: dir,
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("unknown flag: --audits");
		expect(r.stderr).toContain("usage:");
	});
});
