// @vitest-environment node
/*
 * lib/npm-workspaces.js against what npm 11.16.0 ran in this same tree: each
 * row's directories are the scripts `npm <flags>` ran there (#4041).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { npmCanon } from "./npm-options.js";
import { parseSelection, resolveSelection } from "./npm-workspaces.js";
import { buildPackageReader } from "./package-reader.js";

let dir: string;

const write = (rel: string, pkg: object) => {
	fs.mkdirSync(path.join(dir, rel), { recursive: true });
	fs.writeFileSync(path.join(dir, rel, "package.json"), JSON.stringify(pkg));
};

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-workspaces-"));
	write(".", { name: "top", workspaces: ["web", "pkgs/*"] });
	write("web", { name: "@x/web" });
	write("pkgs/a", { name: "a" });
	write("pkgs/b", {});
});

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/** The directories `flags` select from `from`, relative to the top; "." for it. */
const select = (flags: string, from = ".") => {
	const selection = parseSelection(npmCanon(flags.split(" ")));
	if (!selection) return;
	const { dirs } = resolveSelection(
		selection,
		path.join(dir, from),
		dir,
		buildPackageReader(),
	);
	return dirs.map((d: string) => path.relative(dir, d) || ".");
};

describe("the directories npm's selectors run in", () => {
	it.each([
		["-w web", ["web"]],
		["-w @x/web", ["web"]],
		["-w ./web/", ["web"]],
		["-w pkgs", ["pkgs/a", "pkgs/b"]],
		["-w b", ["pkgs/b"]],
		["-ws", ["web", "pkgs/a", "pkgs/b"]],
		["-ws -iwr", [".", "web", "pkgs/a", "pkgs/b"]],
		["-w web -iwr", [".", "web"]],
		["-ws -w web", ["web"]],
		["-w web -w nosuch", ["web"]],
		["-w nosuch", []],
		["--workspaces=true", ["web", "pkgs/a", "pkgs/b"]],
		["--no-workspaces --workspaces", ["web", "pkgs/a", "pkgs/b"]],
		["--no-workspaces=false", ["web", "pkgs/a", "pkgs/b"]],
		["-ws --no-include-workspace-root", ["web", "pkgs/a", "pkgs/b"]],
		["-ws --iwr=false", ["web", "pkgs/a", "pkgs/b"]],
		["--no-workspace web", ["web"]],
		["--workspace", []],
		["--no-workspace", []],
		["--no-workspace -w web", ["web"]],
		["-iwr", ["."]],
		["-w nosuch -iwr", ["."]],
		["-w !web", ["web", "pkgs/a", "pkgs/b"]],
		["-w !pkgs", ["web"]],
	])("npm %s runs in %j", (flags, dirs) => {
		expect(select(flags)?.sort()).toEqual([...dirs].sort());
	});

	it.each([
		"--no-workspaces -iwr",
		"--workspaces=false",
		"--no-workspaces",
		"--no-workspaces=true",
		"--no-workspaces=null",
		"--workspaces --no-workspaces",
	])("npm %s selects nothing", (flags) => {
		expect(select(flags)).toBeUndefined();
	});

	it.each([
		["-ws", "web", ["web"]],
		["-w a", "web", ["pkgs/a"]],
		["-w a", "pkgs", ["pkgs/a"]],
		["-iwr", "web", [".", "web"]],
		["--workspace", "web", []],
	])("npm %s from %s runs in %j", (flags, from, dirs) => {
		expect(select(flags, from)).toEqual(dirs);
	});

	describe("from a member that declares workspaces of its own", () => {
		beforeAll(() => {
			write("pkgs/a", { name: "a", workspaces: ["sub"] });
			write("pkgs/a/sub", { name: "sub" });
		});

		afterAll(() => {
			write("pkgs/a", { name: "a" });
		});

		it.each([
			["-ws", ["pkgs/a"]],
			["-ws --prefix .", ["pkgs/a/sub"]],
			["--no-workspaces --workspaces", ["pkgs/a"]],
		])("npm %s runs in %j", (flags, dirs) => {
			expect(select(flags, "pkgs/a")).toEqual(dirs);
		});
	});
});
