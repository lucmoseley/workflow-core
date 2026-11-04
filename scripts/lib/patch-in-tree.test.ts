// @vitest-environment node
/*
 * patch-in-tree.test.ts — whether a patch section's post-image is in the tree
 * (#4338). A break lets commit-paths --patch commit lines the
 * calling tree lacks, or refuse a patch the tree does hold.
 */

import { describe, expect, it } from "vitest";
import { notInTree } from "./patch-in-tree.js";

const section = (...hunks: string[]) =>
	`diff --git a/f b/f\n--- a/f\n+++ b/f\n${hunks.join("")}`;

const judge = (s: string, text: string) =>
	notInTree({ section: s, file: "f" }, () => text);

describe("notInTree on a file's hunks", () => {
	it("passes a tree holding each hunk's lines at its line", () => {
		const s = section("@@ -1,0 +2 @@\n+mine\n", "@@ -3 +4 @@\n-old\n+new\n");
		expect(judge(s, "a\nmine\nb\nnew\n")).toBeNull();
	});

	it("names each hunk whose lines the tree lacks", () => {
		const s = section(
			"@@ -1,0 +2 @@\n+mine\n",
			"@@ -3 +4,2 @@\n-old\n+n1\n+n2\n",
		);
		expect(judge(s, "a\nb\nold\n")).toBe("lacks the lines of hunk +2, +4,2");
	});

	it("refuses a common line the tree holds only elsewhere", () => {
		const s = section("@@ -3,0 +4 @@\n+}\n");
		expect(judge(s, "}\na\nb\nc\nd\n")).toBe("lacks the lines of hunk +4");
	});

	it("checks context lines too, and skips a hunk that only deletes", () => {
		const s = section(
			"@@ -1,2 +1,2 @@\n a\n-b\n+B\n",
			"@@ -5 +4,0 @@\n-gone\n",
		);
		expect(judge(s, "a\nB\n")).toBeNull();
		expect(judge(s, "z\nB\n")).toBe("lacks the lines of hunk +1,2");
	});

	it("reads a file with no final newline", () => {
		const s = section("@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n");
		expect(judge(s, "b")).toBeNull();
		expect(judge(s, "b\n")).toBe("lacks the lines of hunk +1");
		const ends = section("@@ -1 +1 @@\n-a\n+b\n");
		expect(judge(ends, "b\n")).toBeNull();
		expect(judge(ends, "b")).toBe("lacks the lines of hunk +1");
	});
});

describe("notInTree", () => {
	const reader =
		(files: Record<string, string>) =>
		(f: string): string | null =>
			files[f] ?? null;

	it("names a file not on disk whose hunks add lines, and passes one that holds them", () => {
		const s = { section: section("@@ -0,0 +1 @@\n+a\n"), file: "f" };
		expect(notInTree(s, reader({}))).toBe("not on disk");
		expect(notInTree(s, reader({ f: "a\n" }))).toBeNull();
		expect(notInTree(s, reader({ f: "b\n" }))).toBe(
			"lacks the lines of hunk +1",
		);
	});

	it("names a new empty file not on disk", () => {
		const s = {
			section:
				"diff --git a/f b/f\nnew file mode 100644\nindex 0000000..e69de29\n",
			file: "f",
		};
		expect(notInTree(s, reader({}))).toBe("not on disk");
		expect(notInTree(s, reader({ f: "" }))).toBeNull();
	});

	it("names a deleted file still on disk", () => {
		const s = {
			section:
				"diff --git a/f b/f\ndeleted file mode 100644\n--- a/f\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n",
			file: "f",
		};
		expect(notInTree(s, reader({ f: "a\n" }))).toBe("deleted, still on disk");
		expect(notInTree(s, reader({}))).toBeNull();
	});

	it("names a rename whose new name is not on disk, its old name left alone", () => {
		const s = {
			section:
				"diff --git a/o b/n\nsimilarity index 100%\nrename from o\nrename to n\n",
			file: "n",
		};
		expect(notInTree(s, reader({ o: "x\n", n: "x\n" }))).toBeNull();
		expect(notInTree(s, reader({}))).toBe("not on disk");
		expect(notInTree(s, reader({ n: "x\n" }))).toBeNull();
	});
});
