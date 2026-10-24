// @vitest-environment node
/*
 * init-adopter.js's first run switches on each module whose subject a copied
 * repo already tracks, by the predicate check-gate-switches.js refuses a
 * commit on (#1506). Were the two to read the tree differently, a copied repo
 * would start with a commit gate its own setup cannot satisfy.
 *
 * init runs as a process, as init-adopter.test.ts runs it, because what it
 * promises is a repo that commits (#5); the checker runs in-process.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkScratchDir } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process.js";

const CORE = path.resolve(__dirname, "..");
const INIT = path.join(__dirname, "init-adopter.js");
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

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: dir, encoding: "utf8" });

const init = (...args: string[]) =>
	spawnSync(
		process.execPath,
		[
			INIT,
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
		{ cwd: dir, encoding: "utf8", env: env() },
	);

const check = () =>
	runInProcess(CHECK, [], {
		cwd: dir,
		env: { ...env(), CLAUDE_PROJECT_DIR: dir },
	});

const modules = () =>
	JSON.parse(
		fs.readFileSync(path.join(dir, ".claude/workflow-core.json"), "utf8"),
	).modules;

beforeEach(() => {
	dir = mkScratchDir("init-subjects-");
	git("init", "-q", "-b", "main", ".");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "user.name", "Adopter Fixture");
	for (const [file, body] of Object.entries(SUBJECTS)) {
		fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), body);
	}
	/* The adopter template, since init renders its digest from it. */
	fs.copyFileSync(
		path.join(__dirname, "templates/adopter/reference-roadmap.html"),
		path.join(dir, "docs/reference-roadmap.html"),
	);
	git("add", "--", ...Object.keys(SUBJECTS), "docs/reference-roadmap.html");
	git("commit", "-qm", "copied", "--no-verify");
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("init-adopter's module choice on a copied repo", () => {
	it("writes all four modules where the tree holds all four subjects, leaving the checker nothing to refuse", () => {
		const r = init();
		expect(r.status, r.stdout + r.stderr).toBe(0);
		expect([...modules()].sort()).toEqual(
			["governance", "roadmap", "site", "suites"].sort(),
		);
		const c = check();
		expect(c.status, c.stderr).toBe(0);
	});

	it("leaves every module off under an explicit empty --modules, and the checker refuses all four subjects", () => {
		const r = init("--modules", "");
		expect(r.status, r.stdout + r.stderr).toBe(0);
		expect(modules()).toEqual([]);
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

	it("switches suites on for a test file no command is inferred for, and the checker still refuses it until commands.test is declared", () => {
		/* A *.test.js file infers `node --test`; a *.test.ts file infers nothing. */
		git("rm", "-q", "package.json");
		git("mv", "lib/a.test.js", "lib/a.test.ts");
		const r = init();
		expect(r.status, r.stdout + r.stderr).toBe(0);
		expect(modules()).toContain("suites");
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
		expect(modules()).toEqual(["roadmap"]);
	});
});
