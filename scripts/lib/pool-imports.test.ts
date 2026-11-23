// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { readImportedFiles } =
	require("./pool-imports.js") as typeof import("./pool-imports");

/* guess: a line far longer than any real import line (#5559) */
const LONG = 60_000;

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pool-imports-"));
	for (const name of ["a", "b", "c", "x", "y", "z"])
		fs.writeFileSync(path.join(root, name), "");
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const imported = (line: string) => {
	fs.writeFileSync(path.join(root, "CLAUDE.md"), line);
	return readImportedFiles(root, ["CLAUDE.md"]).map((f) => f.path);
};

describe("readImportedFiles: an import inside a code span is no import", () => {
	it.each([
		["@a `@b` @c", ["a", "c"]],
		["``@x`` @y", ["y"]],
		["x ```@x``` @y", ["y"]],
		["x ```@x`` @y", ["y"]],
		["x `````@x``` @y", ["y"]],
		["x ````@x @y", ["x", "y"]],
		["``@x` @y`` @z", ["x", "z"]],
		["`@x @y", ["y"]],
	])("reads %j as importing %j", (line, files) => {
		expect(imported(line)).toEqual(files);
	});

	it("reads the imports on a long line after an unclosed backtick", () => {
		expect(imported(`\`${" @a".repeat(LONG)} @b`)).toEqual(["a", "b"]);
	});

	it("reads none inside a long span whose opening run outnumbers its closing one", () => {
		expect(imported(`x \`\`\`${" @a".repeat(LONG)}\`\` @b`)).toEqual(["b"]);
	});
});
