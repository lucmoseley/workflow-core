// @vitest-environment node
/*
 * Pins the governance cluster against a Manta-free corpus (#412 Seam 1). Its zero
 * case is the empty corpus: `init` with `governance` on, the skeleton
 * committed, and every gated script run against it — each exits 0, and one
 * with nothing written yet to read says so by name (#395 Q1). Its second case
 * is `roadmap` off: the manual half skips naming `roadmap` and the §B half
 * runs as it does with `roadmap` on (#395 Q2, #418).
 *
 * Not run to a verdict here: check-capture-drain.js and, with `roadmap` on,
 * check-cleared-trackers.js, which need a GitHub remote and are proved on the
 * dry-run adopter (#420).
 *
 * Loosen a case and an adopter switching governance on before writing anything
 * meets errors from every gated check, or a check that should skip by name
 * files an issue against an empty corpus.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const CORE = path.resolve(__dirname, "..");
const script = (name: string) => path.join(__dirname, name);

let dir: string;

/* The scripts read git history, so the skeleton is committed as an adopter's
 * would be; its hook stack is init-adopter.test.ts's to prove, not this
 * file's. */
function skeleton(modules: string) {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "governance-empty-"));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, encoding: "utf8" });
	git("init", "-q", "-b", "main", ".");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "user.name", "Governance Fixture");
	const init = runInProcess(
		script("init-adopter.js"),
		[
			"--root",
			dir,
			"--plugin-root",
			CORE,
			"--no-plugin-install",
			"--no-tracker",
			"--founder",
			"A Founder",
			"--modules",
			modules,
		],
		{ cwd: dir, env: process.env },
	);
	if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
	git("add", "-A");
	git("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "skeleton");
}

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function run(name: string, ...args: string[]) {
	return runEnv(name, {}, ...args);
}

/* WFC_MODULES is dropped so each case reads the modules its own init wrote,
 * not the suite's all-on default. */
function runEnv(name: string, extra: NodeJS.ProcessEnv, ...args: string[]) {
	const r = runInProcess(script(name), args, {
		cwd: dir,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: dir,
			WFC_MODULES: undefined,
			...extra,
		},
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const readStatus = () =>
	execFileSync("git", ["status", "--porcelain"], {
		cwd: dir,
		encoding: "utf8",
	});

/** The §B half: its empty-corpus line, the same whether `roadmap` is on or off. */
const B_HALF: [string, string[], string][] = [
	[
		"report-cycle-review-due.js",
		[],
		"SKIP: no cycle log at docs/cycle-log.md yet",
	],
	[
		"check-superseded-values.js",
		[],
		"SKIP: docs/doc-map.md has no §B entry yet",
	],
	[
		"check-restatement-edges.js",
		[],
		"SKIP: docs/doc-map.md has no §B entry yet",
	],
	[
		"report-doc-map-budget.js",
		["--dry-run"],
		"Under budget — nothing to file.",
	],
];

describe("governance on an empty corpus", () => {
	beforeEach(() => skeleton("governance,roadmap"), 60_000);

	it("starts from a skeleton init wrote no placeholder corpus into", () => {
		const docs = path.join(dir, "docs");
		expect(fs.existsSync(path.join(docs, "operating-manual.md"))).toBe(false);
		expect(fs.existsSync(path.join(docs, "cycle-log.md"))).toBe(false);
		const map = fs.readFileSync(path.join(docs, "doc-map.md"), "utf8");
		expect(map).not.toMatch(/^### B\d+/m);
	});

	it.each([
		[
			"check-manual-freshness.js",
			[],
			"SKIP: no operating manual at docs/operating-manual.md yet",
		],
		[
			"report-manual-staleness.js",
			[],
			"SKIP: no operating manual at docs/operating-manual.md yet",
		],
		[
			"card-restatement-report.js",
			["--audit"],
			"SKIP: docs/doc-map.md has no §B entry yet",
		],
		...B_HALF,
	])("%s exits 0 and says so", (name, args, line) => {
		const r = run(name, ...args);
		expect(r.out).toContain(line);
		expect(r.status).toBe(0);
		expect(readStatus()).toBe("");
	});

	it("files nothing on a cycle log that declares no cycle", () => {
		fs.writeFileSync(
			path.join(dir, "docs", "cycle-log.md"),
			"# Cycle log\n\nNothing declared yet.\n",
		);
		const r = run("report-cycle-review-due.js");
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP: docs/cycle-log.md declares no cycle yet");
		expect(r.out).not.toContain("No cycle declared");
	});

	// The skips key on the default input being absent, never on any path that does not read.
	it.each([["check-manual-freshness.js", ["docs/no-such-manual.md"]]])(
		"%s stays red on a path that does not exist",
		(name, args) => {
			const r = run(name, ...args);
			expect(r.status).toBe(2);
			expect(r.out).not.toContain("SKIP:");
			expect(r.out).toContain("no-such-");
		},
	);
});

describe("governance with roadmap off", () => {
	beforeEach(() => skeleton("governance"), 60_000);

	const roadmapOff =
		'SKIP: module "roadmap" is off — .claude/workflow-core.json does not list it under "modules"';

	it.each([
		["check-manual-freshness.js", []],
		["report-manual-staleness.js", []],
		["card-restatement-report.js", ["--audit"]],
		["check-cleared-trackers.js", []],
	])("%s, of the manual half, skips naming roadmap", (name, args) => {
		const r = run(name, ...args);
		expect(r.out).toContain(roadmapOff);
		expect(r.status).toBe(0);
	});

	// manual-sync's gate, and so the operating manual's, is a skill's first step.
	it("gives manual-sync the same line, exiting 1 so the skill stops", () => {
		const r = run(
			"lib/workflow-core-config.js",
			"module",
			"governance",
			"roadmap",
		);
		expect(r.out).toContain(roadmapOff);
		expect(r.status).toBe(1);
	});

	it.each(B_HALF)(
		"%s, of the §B half, runs and says so",
		(name, args, line) => {
			const r = run(name, ...args);
			expect(r.out).toContain(line);
			expect(r.out).not.toContain("is off");
			expect(r.status).toBe(0);
			expect(readStatus()).toBe("");
		},
	);

	/* It runs past the gate to its gh call, which a remote-less fixture refuses.
	 * A dummy token and an empty gh config: an unauthenticated gh, as on CI,
	 * stops at auth before it looks for a remote (#443). Residual: a gh that
	 * validates the token before that lookup fails this on auth instead. */
	it("check-capture-drain.js, of the capture half, runs rather than skipping", () => {
		const ghConfig = fs.mkdtempSync(path.join(os.tmpdir(), "gh-empty-"));
		const r = runEnv("check-capture-drain.js", {
			GH_TOKEN: "dummy",
			GH_CONFIG_DIR: ghConfig,
		});
		fs.rmSync(ghConfig, { recursive: true, force: true });
		expect(r.out).not.toContain("SKIP:");
		expect(r.out).toContain("no git remotes found");
		expect(r.status).toBe(2);
	});
});
