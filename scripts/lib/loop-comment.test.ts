// @vitest-environment node
// full-sweep-only: #5912
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const {
	LOOP_COMMENT_PREFIX,
	buildLoopComment,
	isLoopComment,
} = require("./loop-comment.js");

const ROOT = path.resolve(__dirname, "../..");
const SOURCE = /\.(?:c?js|mjs|sh|py)$/;

const sourcesUnder = (dir: string): string[] =>
	fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const full = path.join(dir, e.name);
		if (e.isDirectory())
			return e.name === "node_modules" ? [] : sourcesUnder(full);
		return SOURCE.test(e.name) ? [full] : [];
	});

describe("loop comments", () => {
	it("reads a built comment, plain or bold, and nothing else", () => {
		expect(isLoopComment(buildLoopComment("stopped QUESTION park."))).toBe(
			true,
		);
		expect(
			isLoopComment(`**${buildLoopComment("handed off.")}** Session x`),
		).toBe(true);
		expect(isLoopComment("B, go. Refill loop: noted")).toBe(false);
		expect(isLoopComment(undefined)).toBe(false);
	});

	it("is the one spelling of the prefix in the shipped sources, #5912 (C5 false positive)", () => {
		const own = path.join(__dirname, "loop-comment.js");
		const spelt = ["scripts", "hooks"]
			.flatMap((d) => sourcesUnder(path.join(ROOT, d)))
			.filter((f) => f !== own)
			.filter((f) => fs.readFileSync(f, "utf8").includes(LOOP_COMMENT_PREFIX))
			.map((f) => path.relative(ROOT, f));
		expect(spelt).toEqual([]);
	});
});
