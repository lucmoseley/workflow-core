// @vitest-environment node
/*
 * patch-in-tree.test.ts — whether a patch section's post-image is in the tree
 * (#4338). A break lets commit-paths --patch commit lines the
 * calling tree lacks, or refuse a patch the tree does hold.
 */

import { describe, expect, it } from "vitest";
import { notInTree } from "./patch-in-tree.js";

const regular = (text: string) => ({ text, blob: "", mode: "100644" });

const section = (...hunks: string[]) =>
	`diff --git a/f b/f\n--- a/f\n+++ b/f\n${hunks.join("")}`;

const judge = (s: string, text: string) =>
	notInTree({ section: s, file: "f" }, () => regular(text));

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
	const reader = (files: Record<string, string>) => (f: string) =>
		f in files ? regular(files[f] as string) : null;

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

describe("notInTree on a section with no text hunk (#4339)", () => {
	const judgeOn = (text: string, tree: Parameters<typeof notInTree>[1]) =>
		notInTree({ section: text, file: "f" }, tree);
	const held =
		(mode: string | null, blob = "") =>
		() => ({
			text: "x\n",
			blob,
			mode,
		});

	it("names a mode change the tree's file does not have", () => {
		const s = "diff --git a/f b/f\nold mode 100644\nnew mode 100755\n";
		expect(judgeOn(s, held("100755"))).toBeNull();
		expect(judgeOn(s, held("100644"))).toBe(
			"mode 100644, the patch gives 100755",
		);
		expect(judgeOn(s, () => null)).toBe("not on disk");
	});

	it("passes either regular-file mode where the checkout tracks no executable bit, but not a symlink", () => {
		const s = "diff --git a/f b/f\nold mode 100644\nnew mode 100755\n";
		expect(judgeOn(s, held(null))).toBeNull();
		const link = "diff --git a/f b/f\nold mode 100644\nnew mode 120000\n";
		expect(judgeOn(link, held(null))).toBe(
			"mode of a regular file, the patch gives 120000",
		);
	});

	it("names a new file whose mode differs", () => {
		const s =
			"diff --git a/f b/f\nnew file mode 100755\nindex 0000000..e69de29\n";
		expect(judgeOn(s, held("100644"))).toBe(
			"mode 100644, the patch gives 100755",
		);
	});

	it("names a binary patch whose new blob the tree's file does not hash to", () => {
		const s =
			"diff --git a/f b/f\nindex 1111111..abcdef0\nGIT binary patch\nliteral 1\nIc${{Tm1^@s6u4c^\n\nliteral 1\nIc${{Tm1^@s6u4c^\n";
		expect(judgeOn(s, held("100644", "abcdef0123"))).toBeNull();
		expect(judgeOn(s, held("100644", "1111111999"))).toBe(
			"blob 1111111, the patch gives abcdef0",
		);
		expect(judgeOn(s, () => null)).toBe("not on disk");
	});
});
