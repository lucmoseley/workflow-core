// @vitest-environment node
/*
 * lib/npm-workspaces.js against what npm 11.16.0 ran in this same tree: each
 * row's directories are the scripts `npm <flags>` ran there (#4041). The rows
 * are measured, not read off npm's source, so a row edited to fit the code
 * rather than rerun against npm stops checking that a selector reaches what npm
 * reaches, and check_staged is judged on the wrong `package.json`.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseNpmArgv } from "./npm-options.js";
import { parseSelection, resolveSelection } from "./npm-workspaces.js";
import { buildPackageReader } from "./package-reader.js";

const trees: string[] = [];

/** A new tree holding each `package.json` in `pkgs`, by its directory. */
const makeTree = (pkgs: Record<string, object>) => {
	const top = fs.mkdtempSync(path.join(os.tmpdir(), "npm-workspaces-"));
	trees.push(top);
	for (const [rel, pkg] of Object.entries(pkgs)) {
		fs.mkdirSync(path.join(top, rel), { recursive: true });
		fs.writeFileSync(path.join(top, rel, "package.json"), JSON.stringify(pkg));
	}
	return top;
};

const TREE = {
	".": { name: "top", workspaces: ["web", "pkgs/*"] },
	web: { name: "@x/web" },
	"pkgs/a": { name: "a" },
	"pkgs/b": {},
};

let dir: string;

beforeAll(() => {
	dir = makeTree(TREE);
});

afterAll(() => {
	for (const top of trees) fs.rmSync(top, { recursive: true, force: true });
});

/** The directories `flags` select in `top` from `from`, relative to `top`; "."
 * for it. `prefix` is the directory a `--prefix` names. */
const select = (top: string, flags: string, from = ".", prefix = "") => {
	const { options } = parseNpmArgv(
		flags.split(" ").map((value) => ({ value })),
	);
	const selection = parseSelection(options, prefix);
	if (!selection) return;
	const { dirs } = resolveSelection(
		selection,
		path.join(top, from),
		top,
		buildPackageReader(),
	);
	return dirs.map((d: string) => path.relative(top, d) || ".");
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
		expect(select(dir, flags)?.sort()).toEqual([...dirs].sort());
	});

	it.each([
		"--no-workspaces -iwr",
		"--workspaces=false",
		"--no-workspaces",
		"--no-workspaces=true",
		"--no-workspaces=null",
		"--workspaces --no-workspaces",
	])("npm %s selects nothing", (flags) => {
		expect(select(dir, flags)).toBeUndefined();
	});

	it.each([
		["-ws", "web", ["web"]],
		["-w a", "web", ["pkgs/a"]],
		["-w a", "pkgs", ["pkgs/a"]],
		["-iwr", "web", [".", "web"]],
		["--workspace", "web", []],
	])("npm %s from %s runs in %j", (flags, from, dirs) => {
		expect(select(dir, flags, from)).toEqual(dirs);
	});

	describe("from a member that declares workspaces of its own", () => {
		let nested: string;

		beforeAll(() => {
			nested = makeTree({
				...TREE,
				"pkgs/a": { name: "a", workspaces: ["sub"] },
				"pkgs/a/sub": { name: "sub" },
			});
		});

		const rows: [string, string, string[]][] = [
			["-ws", "", ["pkgs/a"]],
			["-ws", ".", ["pkgs/a/sub"]],
			["--no-workspaces --workspaces", "", ["pkgs/a"]],
		];
		it.each(
			rows.map(([flags, prefix, dirs]) => ({
				line: prefix ? `${flags} --prefix ${prefix}` : flags,
				flags,
				prefix,
				dirs,
			})),
		)("npm $line runs in $dirs", ({ flags, prefix, dirs }) => {
			expect(select(nested, flags, "pkgs/a", prefix)).toEqual(dirs);
		});
	});
});
