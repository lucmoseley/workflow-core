// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptWith } from "./init-adopter-fixture";
import { defineTemplate, mkScratchDir } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process.js";

const CORE = path.resolve(__dirname, "..");
const CHECK = path.join(__dirname, "check-gate-switches.js");

const SUBJECTS: Record<string, string> = {
	"package.json": JSON.stringify({ scripts: { test: "node --test" } }),
	"lib/a.test.js": "x\n",
	"docs/operating-manual.md": "# Manual\n",
	"docs/brand-sheet.md": "# Brand\n",
	"app/page.tsx": "x\n",
};

let dir: string;

const env = () => {
	const e: NodeJS.ProcessEnv = { ...process.env };
	delete e.WFC_MODULES;
	delete e.CLAUDE_PROJECT_DIR;
	return e;
};

const gitIn = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });
const git = (...args: string[]) => gitIn(dir, ...args);

const copiedRepo = defineTemplate((root) => {
	gitIn(root, "init", "-q", "-b", "main", ".");
	gitIn(root, "config", "user.email", "fixture@example.invalid");
	gitIn(root, "config", "user.name", "Adopter Fixture");
	for (const [file, body] of Object.entries(SUBJECTS)) {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), body);
	}
	fs.copyFileSync(
		path.join(__dirname, "templates/adopter/reference-roadmap.html"),
		path.join(root, "docs/reference-roadmap.html"),
	);
	gitIn(
		root,
		"add",
		"--",
		...Object.keys(SUBJECTS),
		"docs/reference-roadmap.html",
	);
	gitIn(root, "commit", "-qm", "copied", "--no-verify");
});

const init = (...args: string[]) =>
	adoptWith(
		[
			"--root",
			dir,
			"--plugin-root",
			CORE,
			"--founder",
			"A Founder",
			"--no-tracker",
			"--no-plugin-install",
			...args,
		],
		{ cwd: dir, env: env() },
	);

const check = () =>
	runInProcess(CHECK, [], {
		cwd: dir,
		env: { ...env(), CLAUDE_PROJECT_DIR: dir },
	});

const readModules = () =>
	JSON.parse(
		fs.readFileSync(path.join(dir, ".claude/workflow-core.json"), "utf8"),
	).modules;

beforeEach(() => {
	dir = copiedRepo.instantiate(mkScratchDir("init-subjects-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("init-adopter's module choice on a copied repo", () => {
	it("writes the three modules where the tree holds all four subjects, leaving the checker nothing to refuse", () => {
		const r = init();
		expect(r.status, r.stdout + r.stderr).toBe(0);
		expect([...readModules()].sort()).toEqual(
			["governance", "roadmap", "site"].sort(),
		);
		const c = check();
		expect(c.status, c.stderr).toBe(0);
	});

	it("leaves every module off under an explicit empty --modules, and the checker refuses all four subjects", () => {
		const r = init("--modules", "");
		expect(r.status, r.stdout + r.stderr).toBe(0);
		expect(readModules()).toEqual([]);
		fs.writeFileSync(
			path.join(dir, ".claude/workflow-core.json"),
			JSON.stringify({ contract: 1, founder: "A Founder", modules: [] }),
		);
		const c = check();
		expect(c.status).toBe(1);
		expect(c.stderr).toContain("FAIL: 4 gate(s)");
		for (const line of [
			"The tree tracks lib/a.test.js, but commands.test is undeclared",
			'The tree tracks docs/reference-roadmap.html, but module "roadmap" is off',
			'The tree tracks docs/operating-manual.md, but module "governance" is off',
			'The tree tracks docs/brand-sheet.md, app/page.tsx, but module "site" is off',
		])
			expect(c.stderr).toContain(line);
	});

	it("switches no module on for a test file no command is inferred for, and the checker refuses it until commands.test is declared", () => {
		git("rm", "-q", "package.json");
		git("mv", "lib/a.test.js", "lib/a.test.ts");
		const r = init();
		expect(r.status, r.stdout + r.stderr).toBe(0);
		expect([...readModules()].sort()).toEqual(
			["governance", "roadmap", "site"].sort(),
		);
		const c = check();
		expect(c.status).toBe(1);
		expect(c.stderr).toContain(
			"The tree tracks lib/a.test.ts, but commands.test is undeclared",
		);
		expect(c.stderr).toContain("FAIL: 1 gate(s)");
	});

	it("keeps a written config's modules on a re-run, inferring nothing past it", () => {
		expect(init("--modules", "roadmap").status).toBe(0);
		const again = init();
		expect(again.status, again.stdout + again.stderr).toBe(0);
		expect(readModules()).toEqual(["roadmap"]);
	});
});
