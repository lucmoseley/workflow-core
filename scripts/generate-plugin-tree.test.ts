// @vitest-environment node
/*
 * Pins generate-plugin-tree.js's command line: it writes the release tree into
 * the directory named, ships the prose and hooks a guard reads at run time,
 * leaves the core's local standards file out, and refuses a shipped npm
 * require.
 *
 * It runs the CLI over a minimal fake repo in a temp dir, so what lands is
 * exactly what the fixture holds, and no change to this repo's tree moves a
 * test.
 *
 * Breaking it ships adopters a tree missing a file a hook needs, or one that
 * requires a package an install never brings (#4).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "generate-plugin-tree.js");
const USAGE = "usage: node scripts/generate-plugin-tree.js <out-dir>";

let dir: string;
const write = (rel: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), body);
};
const run = (...args: string[]) =>
	runInProcess(SCRIPT, args, {
		cwd: dir,
		env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
	});

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugin-tree-cli-"));
	write("self-plugin/hooks/hooks.json", JSON.stringify({ hooks: {} }));
	write(".claude-plugin/plugin.json", "{}");
	write("scripts/a.js", 'require("node:fs");\n');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("generate-plugin-tree", () => {
	it("writes the tree into the named directory", () => {
		const r = run("out");
		expect(r.stderr).toBe("");
		expect(r.status).toBe(0);
		expect(fs.existsSync(path.join(dir, "out/scripts/a.js"))).toBe(true);
		expect(fs.existsSync(path.join(dir, "out/hooks/hooks.json"))).toBe(true);
	});

	it("ships the core prose and hooks a guard reads at run time", () => {
		/* An adopter has no copy of any of these: without them a deny prints a
		 * rule id and no text, and init finds no hook to rewrite (#5). */
		write("docs/agents/rules/rule-x.txt", "text\n");
		write("docs/effort-guide.md", "guide\n");
		write("docs/code-standards-base.md", "base\n");
		write("docs/environment.md", "limits\n");
		write(".husky/pre-commit", "#!/bin/sh\nexit 0\n");
		write("docs/operating-manual.md", "not shipped\n");
		expect(run("out").status).toBe(0);
		for (const rel of [
			"docs/agents/rules/rule-x.txt",
			"docs/effort-guide.md",
			"docs/code-standards-base.md",
			"docs/environment.md",
			".husky/pre-commit",
		]) {
			expect(fs.existsSync(path.join(dir, "out", rel)), rel).toBe(true);
		}
		/* And no wider slice of docs/ than the four the guards read. */
		expect(fs.existsSync(path.join(dir, "out/docs/operating-manual.md"))).toBe(
			false,
		);
	});

	it("leaves the core's local standards file behind (#967)", () => {
		/* Every review route reads the base from the plugin and the local file
		 * from the host, so a shipped local file would be read by no one and
		 * mistaken for a template. That the base ships is asserted above. */
		write("docs/code-standards.md", "the core's own choices\n");
		expect(run("out").status).toBe(0);
		expect(fs.existsSync(path.join(dir, "out/docs/code-standards.md"))).toBe(
			false,
		);
	});

	it("exits 1 naming the usage where no directory is given", () => {
		const r = run();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(USAGE);
	});

	it("exits 1 naming the unknown flag and the usage, rather than writing the tree to a directory named after it (#1715)", () => {
		const r = run("--check");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("unknown flag: --check");
		expect(r.stderr).toContain(USAGE);
		expect(fs.existsSync(path.join(dir, "--check"))).toBe(false);
	});

	it("exits 1, never cli-args' 2, naming the usage on a second directory", () => {
		const r = run("out", "extra");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(USAGE);
	});

	it("exits 1 naming the script and package a shipped require needs", () => {
		write("scripts/b.js", 'require("left-pad");\n');
		const r = run("out");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			"generate-plugin-tree: scripts/b.js requires the npm package left-pad",
		);
		expect(fs.existsSync(path.join(dir, "out"))).toBe(false);
	});
});
