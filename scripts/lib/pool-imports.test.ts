// @vitest-environment node
import { describe, expect, it } from "vitest";

const { importTokens } =
	require("./pool-imports.js") as typeof import("./pool-imports");

describe("importTokens: an import inside a code span is no import", () => {
	it.each([
		["@a `@b` @c", ["a", "c"]],
		["``@x`` @y", ["y"]],
		["x ```@x``` @y", ["y"]],
		["x ```@x`` @y", ["y"]],
		["x `````@x``` @y", ["y"]],
		["x ````@x @y", ["x", "y"]],
		["``@x` @y`` @z", ["x", "z"]],
		["`@x @y", ["y"]],
	])("reads %j as %j", (line, tokens) => {
		expect(importTokens(line)).toEqual(tokens);
	});

	it("reads a long line after an unclosed backtick in one pass (#5559)", () => {
		expect(importTokens(`\`${" @a".repeat(60_000)}`)).toHaveLength(60_000);
	});

	it("closes a long span whose opening run outnumbers its closing one (#5559)", () => {
		expect(importTokens(`x \`\`\`${" @a".repeat(60_000)}\`\``)).toEqual([]);
	});
});
