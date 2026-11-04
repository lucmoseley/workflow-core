// @vitest-environment node
/*
 * The guard registry's anchors merged per row (#4171). Loosen it and a merge
 * driver drops a row one side added, takes a digest neither side attested
 * over the current side's, or writes bytes `--review` would rewrite.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildMergedAnchors } from "./registry-anchors-merge.js";
import { runInProcess } from "./run-in-process.js";

const text = (rows: Record<string, string>) =>
	`${JSON.stringify(rows, null, "\t")}\n`;

describe("buildMergedAnchors", () => {
	const base = text({ "a.js": "a0", "b.js": "b0", "c.js": "c0" });

	it("takes each side's own moves, additions and deletions", () => {
		const ours = text({ "a.js": "a1", "b.js": "b0", "c.js": "c0" });
		const theirs = text({ "a.js": "a0", "b.js": "b2", "d.js": "d2" });
		expect(JSON.parse(buildMergedAnchors(base, ours, theirs) ?? "")).toEqual({
			"a.js": "a1",
			"b.js": "b2",
			"d.js": "d2",
		});
	});

	it("keeps the current side's digest on a row both sides moved", () => {
		const ours = text({ "a.js": "a1", "b.js": "b0", "c.js": "c0" });
		const theirs = text({ "a.js": "a2", "b.js": "b0", "c.js": "c0" });
		expect(JSON.parse(buildMergedAnchors(base, ours, theirs) ?? "")).toEqual({
			"a.js": "a1",
			"b.js": "b0",
			"c.js": "c0",
		});
	});

	it("keeps a row the current side moved and the other deleted", () => {
		const ours = text({ "a.js": "a1", "b.js": "b0", "c.js": "c0" });
		const theirs = text({ "b.js": "b0", "c.js": "c0" });
		expect(
			JSON.parse(buildMergedAnchors(base, ours, theirs) ?? ""),
		).toHaveProperty("a.js", "a1");
	});

	it("writes the rows sorted, as --review does", () => {
		const theirs = text({
			"a.js": "a0",
			"b.js": "b0",
			"c.js": "c0",
			"0.js": "z",
		});
		expect(buildMergedAnchors(base, base, theirs)).toBe(
			text({ "0.js": "z", "a.js": "a0", "b.js": "b0", "c.js": "c0" }),
		);
	});

	it.each([
		["markers", "<<<<<<< ours\n{}\n"],
		["an array", "[]\n"],
		["a non-digest row", text({ "a.js": 1 as unknown as string })],
	])("is null where a side holds %s", (_, bad) => {
		expect(buildMergedAnchors(base, bad, base)).toBeNull();
		expect(buildMergedAnchors(bad, base, base)).toBeNull();
	});
});

it("writes the committed file back byte for byte", () => {
	const committed = fs.readFileSync(
		path.resolve(__dirname, "../../.claude/guard-registry-anchors.json"),
		"utf8",
	);
	expect(buildMergedAnchors(committed, committed, committed)).toBe(committed);
});

describe("merge-registry-anchors.js, as git runs it", () => {
	const Driver = path.resolve(__dirname, "../merge-registry-anchors.js");
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "registry-merge-"));
	});
	afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

	const run = (o: string, a: string, b: string) => {
		const files = ["o", "a", "b"].map((n) => path.join(dir, n));
		for (const [i, t] of [o, a, b].entries())
			fs.writeFileSync(files[i] as string, t);
		const r = runInProcess(Driver, files, { cwd: dir });
		return { ...r, merged: fs.readFileSync(files[1] as string, "utf8") };
	};

	it("exits 0, writing the per-row merge over the current side", () => {
		const r = run(
			text({ "a.js": "a0" }),
			text({ "a.js": "a1" }),
			text({ "a.js": "a0", "b.js": "b2" }),
		);
		expect(r.status, r.stderr).toBe(0);
		expect(r.merged).toBe(text({ "a.js": "a1", "b.js": "b2" }));
	});

	it("exits 1 with git's text merge and its markers where a side is not digests", () => {
		const r = run(
			text({ "a.js": "a0" }),
			'{\n\t"a.js": 1\n}\n',
			text({ "a.js": "a2" }),
		);
		expect(r.status, r.stderr).toBe(1);
		expect(r.stderr).toContain("resolve the markers");
		expect(r.merged).toContain("<<<<<<< ours");
	});

	it("exits 129, git's merge failure, on a call missing a file", () => {
		const r = runInProcess(Driver, ["only-one"], { cwd: dir });
		expect(r.status).toBe(129);
		expect(r.stderr).toContain("usage");
	});
});
