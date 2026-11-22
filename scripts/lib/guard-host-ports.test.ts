// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { treePorts } from "./guard-host-ports.js";

const repoRel = (file: string, root: string) => treePorts(root).repoRel(file);

let dir: string;

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "host-ports-")));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("a tree's repoRel, the reading of a written path", () => {
	it("is null for a sibling whose name starts with the root's (#2546)", () => {
		expect(
			repoRel(`${dir}/repository/a.md`, path.join(dir, "repo")),
		).toBeNull();
	});

	it("reads a name inside the root that starts with `..` as inside it (#4134)", () => {
		expect(repoRel(`${dir}/repo/..foo/a.md`, path.join(dir, "repo"))).toBe(
			"..foo/a.md",
		);
	});

	it("reads every absolute path under a root of `/` (#2546)", () => {
		expect(repoRel("/a/../b.md", "/")).toBe("b.md");
	});

	it("resolves a `..` through a symlink to the checkout, and refuses the link itself or a path out of it (#2553)", () => {
		const repo = path.join(dir, "repo");
		fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
		fs.symlinkSync(repo, path.join(dir, "link"));
		expect(repoRel(`${dir}/link/nope/../a.ts`, repo)).toBe("a.ts");
		for (const tail of ["", "/", "/../x.ts"])
			expect(repoRel(`${dir}/link${tail}`, repo)).toBeNull();
	});

	it.each([
		["/a.ts", "a.ts"],
		["/sub/../tests/a.ts", "tests/a.ts"],
		["/../tests/notes.md", null],
		["/sub/../../tests/a.ts", null],
		["", null],
	])("reads %s under the root as %s (#2546)", (tail, want) => {
		expect(repoRel(`${dir}/repo${tail}`, path.join(dir, "repo"))).toBe(want);
	});

	it("is null for a relative path", () => {
		expect(repoRel("repo/a.ts", path.join(dir, "repo"))).toBeNull();
		expect(repoRel("scripts/a.ts", process.cwd())).toBeNull();
	});

	it("reads a write spelled through a symlink to the checkout, a new file included (#2553)", () => {
		const repo = path.join(dir, "repo");
		fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
		fs.symlinkSync(repo, path.join(dir, "link"));
		expect(repoRel(`${dir}/link/scripts/new.test.ts`, repo)).toBe(
			"scripts/new.test.ts",
		);
		expect(repoRel(`${dir}/link/no/such/dir/a.ts`, repo)).toBe(
			"no/such/dir/a.ts",
		);
	});
});

describe("a tree's read, the one read of a file that may be absent", () => {
	it("answers read, absent or unreadable, and readText folds the same answer", () => {
		fs.writeFileSync(path.join(dir, "a.md"), "x");
		fs.mkdirSync(path.join(dir, "sub"));
		const tree = treePorts(dir);
		expect(tree.read("a.md")).toEqual({ state: "read", data: "x" });
		expect(tree.read("nope.md")).toEqual({ state: "absent" });
		expect(tree.read("sub").state).toBe("unreadable");
		expect(tree.readText("a.md")).toBe("x");
		expect(tree.readText("nope.md")).toBeNull();
		expect(() => tree.readText("sub")).toThrow();
	});
});
