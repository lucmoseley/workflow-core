// @vitest-environment node
/*
 * The guard registry's anchors merged per row (#4171). Loosen it and a merge
 * driver drops a row one side added, takes a digest neither side attested
 * over the current side's, or writes bytes `--review` would rewrite.
 */
import { describe, expect, it } from "vitest";
import {
	buildAnchorsText,
	buildMergedAnchors,
} from "./registry-anchors-merge.js";

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

it("buildAnchorsText round-trips the committed file byte for byte", async () => {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const committed = fs.readFileSync(
		path.resolve(__dirname, "../../.claude/guard-registry-anchors.json"),
		"utf8",
	);
	expect(buildAnchorsText(JSON.parse(committed))).toBe(committed);
});
