// @vitest-environment node
/*
 * check-gate-switches.js refuses a commit while the tracked tree holds a gate's
 * subject and that gate's switch is off (#1506). Each case commits through a
 * real git hook in a throwaway repo, so what is proven is the refusal of a
 * commit, not only an exit code. Loosen one and a repo's tests, roadmap,
 * manual or site pages sit ungated while every commit passes.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initGitRepo, mkScratchDir } from "./lib/git-fixture";

const SCRIPT = path.join(__dirname, "check-gate-switches.js");
const CONFIG = ".claude/workflow-core.json";

let dir: string;
let hooks: string;

const env = () => {
	const e: NodeJS.ProcessEnv = { ...process.env, CLAUDE_PROJECT_DIR: dir };
	delete e.WFC_MODULES;
	return e;
};

const write = (file: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
	fs.writeFileSync(path.join(dir, file), body);
};

/** `modules` and `commands` as the host declares them; no file where null. */
const configure = (cfg: { modules?: string[]; test?: string } | null) => {
	if (cfg === null) return fs.rmSync(path.join(dir, CONFIG), { force: true });
	write(
		CONFIG,
		JSON.stringify({
			contract: 1,
			founder: "T",
			modules: cfg.modules ?? [],
			commands: cfg.test ? { test: cfg.test } : {},
		}),
	);
};

const commit = (...files: string[]) => {
	const run = (...args: string[]) =>
		spawnSync("git", args, { cwd: dir, encoding: "utf8", env: env() });
	run("add", "--", ...files);
	const r = run("commit", "-qm", "c");
	return { status: r.status, out: r.stdout + r.stderr };
};

beforeEach(() => {
	dir = mkScratchDir("gate-switches-");
	hooks = mkScratchDir("gate-switches-hooks-");
	fs.writeFileSync(
		path.join(hooks, "pre-commit"),
		`#!/bin/sh\nexec node ${JSON.stringify(SCRIPT)}\n`,
		{ mode: 0o755 },
	);
	initGitRepo(dir, hooks);
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(hooks, { recursive: true, force: true });
});

const SECTION_B = "## Section B — registry\n\n### B1 · A figure\n\nBody.\n";

describe("check-gate-switches", () => {
	it("lets an empty repo with no modules, no commands and no config commit", () => {
		configure(null);
		write("notes.md", "n\n");
		expect(commit("notes.md").status).toBe(0);
	});

	it.each([
		{
			subject: "a test file",
			files: { "lib/a.test.ts": "x\n" },
			switchOn: { test: "npx vitest run" },
			names: [
				"lib/a.test.ts",
				"commands.test is undeclared",
				'"commands": { "test"',
			],
		},
		{
			subject: "the roadmap",
			files: { "docs/reference-roadmap.html": "<html></html>\n" },
			switchOn: { modules: ["roadmap"] },
			names: [
				"docs/reference-roadmap.html",
				'module "roadmap" is off',
				'add "roadmap"',
			],
		},
		{
			subject: "the operating manual",
			files: { "docs/operating-manual.md": "# Manual\n" },
			switchOn: { modules: ["governance"] },
			names: [
				"docs/operating-manual.md",
				'module "governance" is off',
				'add "governance"',
			],
		},
		{
			subject: "a doc-map §B entry",
			files: { "docs/doc-map.md": SECTION_B },
			switchOn: { modules: ["governance"] },
			names: [
				"docs/doc-map.md §B",
				'module "governance" is off',
				'add "governance"',
			],
		},
		{
			subject: "the brand sheet with app/",
			files: { "docs/brand-sheet.md": "# Brand\n", "app/page.tsx": "x\n" },
			switchOn: { modules: ["site"] },
			names: [
				"docs/brand-sheet.md, app/page.tsx",
				'module "site" is off',
				'add "site"',
			],
		},
	])(
		"refuses $subject while its switch is off, and passes once it is set",
		({ files, switchOn, names }) => {
			configure({});
			for (const [file, body] of Object.entries(files)) write(file, body);
			const refused = commit(...Object.keys(files));
			expect(refused.status).not.toBe(0);
			for (const n of names) expect(refused.out).toContain(n);
			expect(refused.out).toContain("init-adopter.js --no-plugin-install");

			configure(switchOn);
			const passed = commit(...Object.keys(files));
			expect(passed.status, passed.out).toBe(0);
		},
	);

	it("refuses a commit staging none of the subject's files while one is tracked", () => {
		configure({ modules: ["roadmap"] });
		write("docs/reference-roadmap.html", "<html></html>\n");
		expect(commit("docs/reference-roadmap.html").status).toBe(0);
		configure({});
		write("notes.md", "n\n");
		const r = commit("notes.md");
		expect(r.status).not.toBe(0);
		expect(r.out).toContain(
			'The tree tracks docs/reference-roadmap.html, but module "roadmap" is off',
		);
		expect(r.out).toContain('Fix: add "roadmap" to "modules"');
	});

	it("refuses the commit as BROKEN on a config that does not parse", () => {
		write(CONFIG, "{");
		write("notes.md", "n\n");
		const r = commit("notes.md");
		expect(r.status).not.toBe(0);
		expect(r.out).toMatch(/BROKEN: .*does not parse/);
	});
});
