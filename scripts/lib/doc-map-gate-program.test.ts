// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ignoreFailure } from "./caught.js";
import { coreFile } from "./core-path-testkit";
import { PROGRAM } from "./doc-map-gate-program.js";
import { emptyDataFile } from "./doc-map-testkit";
import { defineTemplate, mkScratchDir } from "./git-fixture";
import { dispatch } from "./precommit-dispatch.js";
import { registerTempCleanup, type TempRepo } from "./precommit-gate-harness";
import {
	buildRepoPorts,
	ROOT,
	writeCheckerDelegates,
} from "./precommit-gate-testkit";
import { GATES, type PrecommitGate } from "./precommit-gates.js";
import { runInProcess } from "./run-in-process.js";
import { shellQuote } from "./sh-quote.js";

const PORTS = "scripts/lib/doc-map-gate-ports.js";
const PROGRAM_FILE = "scripts/lib/doc-map-gate-program.js";

const ROW = GATES.find((g) => g.id === "doc-map") as PrecommitGate;

const { readTrackedFiles } = require("./doc-map") as typeof import("./doc-map");

const portScripts = () =>
	[
		...new Set(
			[
				...fs
					.readFileSync(path.join(ROOT, PORTS), "utf8")
					.matchAll(/"([\w-]+\.js)"/g),
			].map((m) => `scripts/${m[1]}`),
		),
	].sort();

const STUBBED = ["scripts/check-doc-map.js", "scripts/checker-new-faults.js"];
const realCheckerNames = () => STUBBED.map((s) => s.replace(/^scripts\//, ""));

const bareRepoTemplate = defineTemplate((root) => {
	execFileSync("git", ["init", "-q", "."], { cwd: root });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
	execFileSync("git", ["config", "user.name", "t"], { cwd: root });
});

function newRepo(prefix: string, tempDirs: string[]): TempRepo {
	const root = mkScratchDir(prefix);
	tempDirs.push(root);
	try {
		bareRepoTemplate.instantiate(root);
	} catch (err) {
		fs.rmSync(root, { recursive: true, force: true });
		throw err;
	}
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
	return { root, git };
}

const DOC_MAP_FILES = [
	"doc-map.md",
	"doc-map-restatements.json",
	"doc-map-superseded.json",
	"doc-map-retired-vocabulary.json",
	"doc-map-restatement-allowlist.json",
	"doc-map-high-water.json",
	"doc-map-classes.json",
];

const seededRepoTemplate = defineTemplate((root) => {
	execFileSync("git", ["init", "-q", "."], { cwd: root });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
	execFileSync("git", ["config", "user.name", "t"], { cwd: root });
	fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
	fs.mkdirSync(path.join(root, "docs"), { recursive: true });
	for (const name of DOC_MAP_FILES)
		fs.writeFileSync(path.join(root, "docs", name), `committed ${name}\n`);
	execFileSync("git", ["add", "--", "seed.txt", "docs"], { cwd: root });
	execFileSync("git", ["commit", "-qm", "seed"], { cwd: root });
});

function newSeededRepo(tempDirs: string[]): TempRepo {
	const root = mkScratchDir("doc-map-gate-");
	tempDirs.push(root);
	try {
		seededRepoTemplate.instantiate(root);
	} catch (err) {
		fs.rmSync(root, { recursive: true, force: true });
		throw err;
	}
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
	return { root, git };
}

const armingOf = (row: PrecommitGate) =>
	"pattern" in row.arm ? row.arm.pattern.source.replaceAll("\\/", "/") : "";

const withPattern = (edit: (source: string) => string): PrecommitGate => {
	const source = armingOf(ROW);
	const mutant = edit(source);
	expect(mutant).not.toBe(source);
	return { ...ROW, arm: { pattern: new RegExp(mutant) } };
};

function parityGap(
	arming: string,
	checker: string = fs.readFileSync(
		path.join(ROOT, "scripts", "lib", "doc-map.js"),
		"utf8",
	),
	tracked: string[] = readTrackedFiles(),
): string | null {
	const decl = /const SCOPE = \[([^\]]*)\]/.exec(checker);
	if (!decl) return "SCOPE no longer parses out of lib/doc-map.js";
	const scope = [...decl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
	if (scope.length === 0) return "SCOPE parsed empty";

	const pattern = /^\^\(([^)]*)\)$/.exec(arming);
	if (!pattern)
		return "the gate's arming pattern is no longer one `^(…)` group";

	const isDir = (m: string) => tracked.some((f) => f.startsWith(`${m}/`));
	const spelled = scope
		.map((m) =>
			isDir(m)
				? `${m.replaceAll(".", "\\.")}/`
				: `${m.replaceAll(".", "\\.")}$`,
		)
		.sort();
	const alternatives = pattern[1].split("|").sort();

	return JSON.stringify(alternatives) === JSON.stringify(spelled)
		? null
		: `row matches ${JSON.stringify(alternatives)}, SCOPE is ${JSON.stringify(spelled)}`;
}

const temps = registerTempCleanup();

const STUB_MARKER = "STUB-CHECK-RAN";

const CALL_LOG = "stub-calls.log";

const UNTRACKED_REPORT = [
	"1 doc-map register entr(ies) name a file present on disk but not yet tracked by git:",
	"  docs/research/fresh.md",
	"",
	"Likely mid-ticket: the register edit and the file's own commit are separate steps.",
	"",
	"Files no Section C route reaches:",
	"  docs/research/unreached-noise.md",
].join("\n");

interface FixtureOpts {
	staged: Record<string, string>;
	checkerExit: number;
	docMapFiles?: string[];
	docMapInHead?: boolean;
	checkerStdout?: string;
	headMap?: string;
	newFaultsExit?: number;
	scriptsDir?: string;
}

function writeStubs(dir: string, opts: FixtureOpts) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "check-doc-map.js"), checkerStub(opts));
	fs.writeFileSync(
		path.join(dir, "checker-new-faults.js"),
		`if (process.argv[2] !== "doc-map") {\n` +
			`  console.error("stub: profile " + process.argv[2]);\n` +
			"  process.exit(2);\n" +
			"}\n" +
			`console.log("dead: stub-new-fault.md");\n` +
			`process.exit(${opts.newFaultsExit ?? 1});\n`,
	);
}

function fixture(opts: FixtureOpts): string {
	const usesDefaultSeed =
		opts.docMapFiles === undefined &&
		opts.docMapInHead !== false &&
		opts.headMap === undefined;
	const { root, git } = usesDefaultSeed
		? newSeededRepo(temps)
		: newRepo("doc-map-gate-", temps);

	writeStubs(opts.scriptsDir ?? path.join(root, "scripts"), opts);
	if (!usesDefaultSeed) seedByHand(root, git, opts);

	for (const [rel, body] of Object.entries(opts.staged)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, body);
		git("add", "--", rel);
	}
	return root;
}

function checkerStub(opts: FixtureOpts): string {
	return opts.checkerStdout === undefined
		? `const fs = require("node:fs");\n` +
				`const root = process.argv[process.argv.indexOf("--root") + 1];\n` +
				`fs.appendFileSync(${JSON.stringify(CALL_LOG)}, (process.env.GIT_INDEX_FILE ?? "-") + " " + process.argv.slice(2).join(" ") + "\\n");\n` +
				`console.log("${STUB_MARKER}");\n` +
				`console.log(process.argv.slice(2).join(" "));\n` +
				`console.log(fs.readFileSync(root + "/docs/doc-map.md", "utf8"));\n` +
				`console.log("DIR:" + fs.readdirSync(root + "/docs").sort().join(","));\n` +
				`console.log(fs.readFileSync(root + "/docs/doc-map-high-water.json", "utf8"));\n` +
				`process.exit(${opts.checkerExit});\n`
		: `console.log(${JSON.stringify(opts.checkerStdout)});\n` +
				`process.exit(${opts.checkerExit});\n`;
}

function seedByHand(root: string, git: TempRepo["git"], opts: FixtureOpts) {
	fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
	fs.mkdirSync(path.join(root, "docs"), { recursive: true });
	const docMapPaths = (opts.docMapFiles ?? DOC_MAP_FILES).map(
		(n) => `docs/${n}`,
	);
	for (const name of opts.docMapFiles ?? DOC_MAP_FILES)
		fs.writeFileSync(
			path.join(root, "docs", name),
			name === "doc-map.md" && opts.headMap !== undefined
				? opts.headMap
				: `committed ${name}\n`,
		);
	git("add", "--", "seed.txt");
	if (opts.docMapInHead !== false && docMapPaths.length > 0)
		git("add", "--", ...docMapPaths);
	git("commit", "-qm", "seed");
	if (opts.docMapInHead === false && docMapPaths.length > 0)
		git("add", "--", ...docMapPaths);
}

const NO_ANNOTATIONS = { ...process.env, GITHUB_ACTIONS: "" };

async function runGate(
	cwd: string,
	row: PrecommitGate = ROW,
): Promise<{ code: number; output: string }> {
	let output = "";
	const code = await dispatch({
		rows: [row],
		gates: "batch",
		ports: buildRepoPorts(cwd, {
			load: () => () => PROGRAM({ cwd, env: NO_ANNOTATIONS }),
			write: (_fd: number, text: string) => {
				output += text;
			},
		}),
	});
	return { code, output };
}

function runProgram(
	cwd: string,
	env: Record<string, string> = {},
): { code: number; output: string } {
	const run = PROGRAM({ cwd, env: { ...NO_ANNOTATIONS, ...env } });
	return { code: run.exit, output: `${run.stdout}${run.stderr}` };
}

describe("the dispatcher row", () => {
	it("is a program row gating the lander's batch, its script this module", () => {
		expect(ROW).toMatchObject({
			script: PROGRAM_FILE,
			kind: "program",
			policy: "gate",
			lander: "batch",
			args: [],
		});
	});

	it("supplies exactly the scripts the ports run", () => {
		expect(portScripts()).toEqual(STUBBED);
	});

	it("covers exactly the SCOPE check-doc-map.js enforces", () => {
		expect(parityGap(armingOf(ROW))).toBeNull();
	});

	it("reports a gap when the regex loses a SCOPE member", () => {
		expect(
			parityGap(armingOf(ROW).replace("|CLAUDE\\.md$", "")),
		).not.toBeNull();
	});

	it("spells a new directory member of SCOPE as a directory (#17)", () => {
		const checker = 'const SCOPE = ["docs", ".claude", "scripts", "CLAUDE.md"]';
		const tracked = ["docs/a.md", ".claude/x", "scripts/b.js", "CLAUDE.md"];
		const gateArmedOn = (alts: string) => `^(${alts})`;
		expect(
			parityGap(
				gateArmedOn("docs/|\\.claude/|scripts/|CLAUDE\\.md$"),
				checker,
				tracked,
			),
		).toBeNull();
		expect(
			parityGap(
				gateArmedOn("docs/|\\.claude/|scripts$|CLAUDE\\.md$"),
				checker,
				tracked,
			),
		).not.toBeNull();
	});

	const arms = (rel: string, row = ROW) =>
		"pattern" in row.arm && row.arm.pattern.test(rel);

	it("arms on a path under each SCOPE member", () => {
		for (const rel of [
			"docs/research/note.md",
			".claude/skills/x/SKILL.md",
			"hooks/hooks.json",
			"self-plugin/hooks/hooks.json",
			"AGENTS.md",
			"CLAUDE.md",
			"PRODUCT.md",
			"DESIGN.md",
			"GLOSSARY.md",
		])
			expect(arms(rel), rel).toBe(true);
	});

	it("does not arm on a path outside the scope, or one that only resembles it", () => {
		for (const rel of [
			"app/page.tsx",
			"scripts/thing.js",
			"my-docs/a.md",
			"vendor/CLAUDE.md",
		])
			expect(arms(rel), rel).toBe(false);
	});

	it("arms on a look-alike path when the pattern loses its anchor", () => {
		const mutant = withPattern((p) => p.replace("^(docs/", "(docs/"));
		expect(arms("my-docs/a.md", mutant)).toBe(true);
	});

	it("stops covering CLAUDE.md when its alternative is dropped", () => {
		const mutant = withPattern((p) => p.replace("|CLAUDE\\.md$", ""));
		expect(arms("CLAUDE.md", mutant)).toBe(false);
	});

	it("runs the gate for a commit touching the scope, refusing on the checker's failure", async () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});

		const { code, output } = await runGate(repo);
		expect(code).toBe(1);
		expect(output).toContain(STUB_MARKER);
	});

	it("does not run the gate for a commit outside the map's scope", async () => {
		const repo = fixture({
			staged: { "app/page.tsx": "x\n", "scripts/thing.js": "x\n" },
			checkerExit: 1,
		});

		const { code, output } = await runGate(repo);
		expect(code).toBe(0);
		expect(output).not.toContain(STUB_MARKER);
	});

	it("runs the gate out of scope when the path filter is dropped", async () => {
		const repo = fixture({ staged: { "app/page.tsx": "x\n" }, checkerExit: 1 });

		const mutant: PrecommitGate = { ...ROW, arm: { always: true } };
		const { code, output } = await runGate(repo, mutant);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("fires on a deletion", async () => {
		const repo = fixture({ staged: {}, checkerExit: 1 });
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
		fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
		fs.writeFileSync(path.join(repo, "docs", "gone.md"), "x\n");
		git("add", "--", "docs/gone.md");
		git("commit", "-qm", "add doc");
		git("rm", "-q", "--", "docs/gone.md");

		const { code, output } = await runGate(repo);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});
});

describe("PROGRAM's exits and input channels", () => {
	it("prints nothing and exits 0 when the checker passes", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 0,
		});

		expect(runProgram(repo)).toEqual({ code: 0, output: "" });
	});

	it("propagates the checker's own exit code", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 2,
		});

		const { code, output } = runProgram(repo);
		expect(code).toBe(2);
		expect(output).toContain(STUB_MARKER);
		expect(output).toContain("NOT in HEAD");
	});

	it("passes a failing check whose every fault is inherited, still replaying its report", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
			newFaultsExit: 0,
		});

		const { code, output } = runProgram(repo);
		expect(code).toBe(0);
		expect(output).toContain(STUB_MARKER);
		expect(output).toContain("already in HEAD");
	});

	it("says the comparison could not run when its script is gone, blaming the commit for nothing", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});
		fs.rmSync(path.join(repo, "scripts", "checker-new-faults.js"));

		const { code, output } = runProgram(repo);
		expect(code).toBe(1);
		expect(output).toContain("could not tell inherited doc-map faults");
		expect(output).not.toContain("NOT in HEAD");
		expect(output).toContain("diagnostics, not findings");
		expect(output).toContain("MODULE_NOT_FOUND");
	});

	it("fails closed when HEAD holds no baseline to compare against", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
			docMapInHead: false,
			newFaultsExit: 0,
		});

		const { code, output } = runProgram(repo);
		expect(code).toBe(1);
		expect(output).toContain("no readable HEAD baseline for the doc-map check");
	});

	it("refuses a commit that adds a row for a file it does not contain", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 0,
			checkerStdout: UNTRACKED_REPORT,
			headMap: "# Section A\n| `docs/other.md` | a note | `reference` |\n",
		});

		const { code, output } = runProgram(repo);
		expect(code).toBe(1);
		expect(output).toContain(
			"this commit adds the doc-map Section A row(s) below and not the file(s) they name:\n  docs/research/fresh.md",
		);
		expect(output).not.toContain("unreached-noise.md");
	});

	it("refuses an argument as a bad invocation, running nothing", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});

		const run = runInProcess(path.join(ROOT, PROGRAM_FILE), ["--force"], {
			cwd: repo,
			env: NO_ANNOTATIONS,
		});
		expect(run.status).toBe(2);
		expect(`${run.stdout}${run.stderr}`).toBe(
			"unknown flag: --force\n\nusage: node doc-map-gate-program.js (takes no arguments)\n",
		);
	});

	it("exits 143 on a SIGTERM that ends the checker, leaving no scratch behind", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
			newFaultsExit: 0,
		});
		fs.writeFileSync(
			path.join(repo, "scripts", "check-doc-map.js"),
			'if (!process.argv.includes("--json")) process.kill(process.pid, "SIGTERM");\n' +
				"else console.log('{}');\n",
		);
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "doc-map-sig-"));
		temps.push(scratch);
		vi.stubEnv("TMPDIR", scratch);
		expect(runProgram(repo, { TMPDIR: scratch })).toEqual({
			code: 143,
			output: "",
		});
		expect(fs.readdirSync(scratch)).toEqual([]);
	});

	it("runs the scripts under WFC_PLUGIN_ROOT when it is set", () => {
		const plugin = fs.mkdtempSync(path.join(os.tmpdir(), "doc-map-plugin-"));
		temps.push(plugin);
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 3,
			scriptsDir: path.join(plugin, "scripts"),
		});

		const { code, output } = runProgram(repo, { WFC_PLUGIN_ROOT: plugin });
		expect(code).toBe(3);
		expect(output).toContain(STUB_MARKER);
	});
});

describe("the index the checker is handed, extracted by real git", () => {
	it("hands the checker the INDEX's map, not the worktree's", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});
		fs.writeFileSync(
			path.join(repo, "docs", "doc-map.md"),
			"dirty worktree map\n",
		);

		const { output } = runProgram(repo);
		expect(output).toContain("committed doc-map.md");
		expect(output).not.toContain("dirty worktree map");
	});

	it("judges a dirty map and sidecar by their committed pair", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});
		for (const name of ["doc-map.md", "doc-map-high-water.json"])
			fs.writeFileSync(path.join(repo, "docs", name), "half-written\n");

		const { output } = runProgram(repo);
		expect(output).toContain("committed doc-map.md");
		expect(output).toContain("committed doc-map-high-water.json");
		expect(output).not.toContain("half-written");
	});

	it("hands the checker the commit's whole docs/, and no --map-dirty for a clean map", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});

		const { output } = runProgram(repo);
		const listed = /DIR:(\S*)/.exec(output)?.[1];
		expect(listed?.split(",").sort()).toEqual(
			[...DOC_MAP_FILES, "research"].sort(),
		);
		expect(output).not.toContain("--map-dirty");
	});

	it("reaches the checker when a data file is missing from the index", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
			docMapFiles: DOC_MAP_FILES.filter((n) => n !== "doc-map-high-water.json"),
		});

		const { code, output } = runProgram(repo);
		expect(output).toContain(STUB_MARKER);
		expect(output).not.toContain("skipped the doc-map check");
		expect(code).not.toBe(0);
	});

	it("hands the checker the staged map, flagged dirty, when only the map is staged", () => {
		const repo = fixture({
			staged: { "docs/doc-map.md": "edited doc-map\n" },
			checkerExit: 1,
		});

		const { output } = runProgram(repo);
		expect(output).toContain(STUB_MARKER);
		expect(output).toContain(`DIR:${DOC_MAP_FILES.slice().sort().join(",")}`);
		expect(output).toContain("edited doc-map");
		expect(output).toContain("--map-dirty");
	});

	it("runs the baseline under HEAD's index and the staged side under this one", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});

		runProgram(repo);
		const calls = fs
			.readFileSync(path.join(repo, CALL_LOG), "utf8")
			.trim()
			.split("\n");
		expect(calls).toHaveLength(3);
		expect(calls[0].startsWith("- ")).toBe(true);
		expect(calls[1].startsWith("- ")).toBe(true);
		expect(calls[2]).toMatch(/^\S+\/index /);
	});
});

describe("a pathspec commit's index isolation", () => {
	it("hides a neighbour's intent-to-add file from the hook", () => {
		const { root, git } = newRepo("index-isolation-", temps);
		git("config", "core.hooksPath", ".githooks");
		fs.writeFileSync(path.join(root, "base.txt"), "x\n");
		git("add", "--", "base.txt");
		git("commit", "-qm", "base");

		fs.mkdirSync(path.join(root, ".githooks"));
		const hook = path.join(root, ".githooks", "pre-commit");
		fs.writeFileSync(hook, "#!/bin/sh\ngit ls-files > ls-files.out\n");
		fs.chmodSync(hook, 0o755);

		fs.writeFileSync(path.join(root, "neighbour.md"), "n\n");
		git("add", "-N", "--", "neighbour.md");
		fs.writeFileSync(path.join(root, "mine.md"), "m\n");
		git("add", "-N", "--", "mine.md");

		git("commit", "-qm", "mine", "--", "mine.md");

		const seen = fs
			.readFileSync(path.join(root, "ls-files.out"), "utf8")
			.split("\n")
			.filter(Boolean);
		expect(seen).toContain("mine.md");
		expect(seen).not.toContain("neighbour.md");
	});
});

describe("a conflicted index and the pre-commit hook", () => {
	function conflictedRepo(): { root: string; ran: () => boolean } {
		const { root, git } = newRepo("conflicted-index-", temps);
		git("config", "core.hooksPath", ".githooks");
		fs.writeFileSync(path.join(root, "f.txt"), "a\n");
		git("add", "--", "f.txt");
		git("commit", "-qm", "base");

		git("checkout", "-q", "-b", "other");
		fs.writeFileSync(path.join(root, "f.txt"), "b\n");
		git("commit", "-qm", "other", "--", "f.txt");
		git("checkout", "-q", "-");
		fs.writeFileSync(path.join(root, "f.txt"), "c\n");
		git("commit", "-qm", "mine", "--", "f.txt");

		fs.mkdirSync(path.join(root, ".githooks"));
		const hook = path.join(root, ".githooks", "pre-commit");
		fs.writeFileSync(
			hook,
			`#!/bin/sh\necho ${shellQuote(STUB_MARKER)} > hook.out\n`,
		);
		fs.chmodSync(hook, 0o755);

		ignoreFailure(() => git("merge", "other"));

		expect(
			execFileSync("git", ["ls-files", "-u"], { cwd: root }).length,
		).toBeGreaterThan(0);
		return { root, ran: () => fs.existsSync(path.join(root, "hook.out")) };
	}

	it("refuses the commit before the hook runs", () => {
		const { root, ran } = conflictedRepo();
		let status: number | undefined;
		let stderr = "";
		try {
			execFileSync("git", ["commit", "-qm", "resolve"], {
				cwd: root,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e) {
			const err = e as { status?: number; stderr?: Buffer };
			status = err.status;
			stderr = String(err.stderr ?? "");
		}
		expect(status).toBe(128);
		expect(stderr).toContain("unmerged");
		expect(ran()).toBe(false);
	});

	it("runs the hook once the resolution is staged", () => {
		const { root, ran } = conflictedRepo();
		fs.writeFileSync(path.join(root, "f.txt"), "resolved\n");
		execFileSync("git", ["add", "--", "f.txt"], { cwd: root });

		expect(execFileSync("git", ["ls-files", "-u"], { cwd: root }).length).toBe(
			0,
		);
		execFileSync("git", ["commit", "-qm", "resolve"], { cwd: root });
		expect(ran()).toBe(true);
	});
});

describe("a pointer count disagreeing with its sidecar", () => {
	const mapText = [
		"# Doc map",
		"",
		"v1.0 · 26 August 2026",
		"",
		"## Section A — authority register",
		"",
		"| Path | Role | Authority |",
		"| --- | --- | --- |",
		"| `docs/doc-map.md` | the map | `stable` |",
		"| `docs/notes.md` | a doc | `stable` |",
		"| `docs/doc-map-restatements.json` | a sidecar | `generated-only` |",
		"| `docs/doc-map-superseded.json` | a sidecar | `generated-only` |",
		"| `docs/doc-map-retired-vocabulary.json` | a sidecar | `generated-only` |",
		"| `docs/doc-map-restatement-allowlist.json` | a sidecar | `generated-only` |",
		"| `docs/doc-map-high-water.json` | a sidecar | `source-of-truth` |",
		"| `docs/doc-map-classes.json` | the class sidecar | `source-of-truth` |",
		"",
		"## Section B — figure registry",
		"",
		"### B1 · A figure",
		"",
		"- **Restated in:** <n> paths, in `docs/doc-map-restatements.json`.",
		"- **Settled at #1**",
		"",
	].join("\n");

	function realCheckerRepo(
		stated = 2,
		seedPaths = 1,
		stagedPaths = seedPaths,
	): string {
		const { root, git } = newRepo("doc-map-pointer-", temps);
		writeCheckerDelegates(root, realCheckerNames());
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		fs.writeFileSync(
			path.join(root, "docs", "doc-map.md"),
			mapText.replace("<n> paths", `${stated} path${stated === 1 ? "" : "s"}`),
		);
		fs.writeFileSync(path.join(root, "docs", "notes.md"), "x\n");
		const restatements = (n: number) =>
			JSON.stringify({
				B1: {
					paths: ["docs/notes.md", "docs/doc-map.md"]
						.slice(0, n)
						.map((rel) => ({ path: rel })),
				},
			});
		fs.writeFileSync(
			path.join(root, "docs", "doc-map-restatements.json"),
			restatements(seedPaths),
		);
		for (const name of DOC_MAP_FILES)
			if (!fs.existsSync(path.join(root, "docs", name)))
				fs.writeFileSync(path.join(root, "docs", name), emptyDataFile(name));
		fs.writeFileSync(
			path.join(root, "docs", "doc-map-classes.json"),
			JSON.stringify(
				Object.fromEntries(
					[
						"docs/doc-map.md",
						"docs/notes.md",
						...DOC_MAP_FILES.filter((n) => n.endsWith(".json")).map(
							(n) => `docs/${n}`,
						),
						"docs/doc-map-classes.json",
					].map((p) => [
						p,
						{
							section: "Docs",
							class: "source-of-truth",
							classQualifier: null,
							role: null,
							route: null,
							consumes: null,
						},
					]),
				),
			),
		);
		fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
		git("add", "--", "seed.txt", "scripts", "docs");
		git("commit", "-qm", "seed");
		fs.writeFileSync(path.join(root, "docs", "notes.md"), "y\n");
		git("add", "--", "docs/notes.md");
		if (stagedPaths !== seedPaths) {
			fs.writeFileSync(
				path.join(root, "docs", "doc-map-restatements.json"),
				restatements(stagedPaths),
			);
			git("add", "--", "docs/doc-map-restatements.json");
		}
		return root;
	}

	it("lets the commit through when the pointer and its key agree", async () => {
		const repo = realCheckerRepo(1);
		const { code, output } = await runGate(repo);
		expect(code).toBe(0);
		expect(output).not.toContain("pointer says");
	});

	it("refuses a commit that deletes a registration key, naming the file left with no register entry", async () => {
		const repo = realCheckerRepo(1);
		const old = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
		execFileSync(
			"git",
			["commit", "-q", "--amend", "--no-edit", "--date", old],
			{
				cwd: repo,
				env: { ...process.env, GIT_COMMITTER_DATE: old },
			},
		);

		const sidecar = path.join(repo, "docs", "doc-map-classes.json");
		const register = JSON.parse(fs.readFileSync(sidecar, "utf8"));
		delete register["docs/notes.md"];
		fs.writeFileSync(sidecar, JSON.stringify(register));
		fs.writeFileSync(
			path.join(repo, "docs", "doc-map.md"),
			fs
				.readFileSync(path.join(repo, "docs", "doc-map.md"), "utf8")
				.replace("| `docs/notes.md` | a doc | `stable` |\n", ""),
		);
		execFileSync(
			"git",
			["add", "--", "docs/doc-map-classes.json", "docs/doc-map.md"],
			{
				cwd: repo,
			},
		);

		const { code, output } = await runGate(repo);
		expect(code).not.toBe(0);
		expect(output).toContain("docs/notes.md");
		expect(output).toContain("no doc-map register entry");
	});

	it("refuses the commit and prints the fix", async () => {
		const { code, output } = await runGate(realCheckerRepo(2, 2, 1));
		expect(code).not.toBe(0);
		expect(output).toContain(
			"B1 — pointer says 2 path(s), the sidecar holds 1",
		);
		expect(output).toContain(
			"- **Restated in:** <n> paths, in `docs/doc-map-restatements.json`.",
		);
		expect(output).toContain(
			"- **Restated in:** none — <one clause saying why>.",
		);
		expect(output).toContain(
			"- **Supersedes:** see `docs/doc-map-superseded.json`.",
		);
	});
});

describe("a hand-edited Section A row", () => {
	// guess, lucmoseley/mantahostels#1852
	const slowGateMs = 20_000;

	const { renderSectionA, REGISTER_HEADER } =
		require("./doc-map") as typeof import("./doc-map");

	const skeleton = [
		"# Doc map",
		"",
		"v1.0 · 26 August 2026",
		"",
		"## Section A — document register",
		"",
		"### Docs",
		"",
		REGISTER_HEADER,
		"|---|---|---|---|---|",
		"",
		"## Section B — figure registry",
		"",
		"### B1 · A figure",
		"",
		"- **Restated in:** 1 path, in `docs/doc-map-restatements.json`.",
		"- **Settled at #1**",
		"",
	].join("\n");

	const registeredPaths = [
		"docs/doc-map.md",
		"docs/notes.md",
		...DOC_MAP_FILES.filter((n) => n !== "doc-map.md").map((n) => `docs/${n}`),
	];

	const sidecar = Object.fromEntries(
		registeredPaths.map((p) => [
			p,
			{
				section: "Docs",
				class: "source-of-truth",
				classQualifier: null,
				role: null,
				route: null,
				consumes: null,
			},
		]),
	);

	function renderAgreeingRepo(): string {
		const { root, git } = newRepo("doc-map-render-", temps);
		writeCheckerDelegates(root, realCheckerNames());
		fs.mkdirSync(path.join(root, "docs"), { recursive: true });
		fs.writeFileSync(path.join(root, "docs", "notes.md"), "x\n");
		for (const name of DOC_MAP_FILES)
			if (name.endsWith(".json"))
				fs.writeFileSync(path.join(root, "docs", name), emptyDataFile(name));
		fs.writeFileSync(
			path.join(root, "docs", "doc-map-restatements.json"),
			JSON.stringify({ B1: { paths: [{ path: "docs/notes.md" }] } }),
		);
		fs.writeFileSync(
			path.join(root, "docs", "doc-map-classes.json"),
			JSON.stringify(sidecar),
		);
		fs.writeFileSync(
			path.join(root, "docs", "doc-map.md"),
			renderSectionA(skeleton, sidecar),
		);
		fs.writeFileSync(path.join(root, "seed.txt"), "seed\n");
		git("add", "--", "seed.txt", "scripts", "docs");
		git("commit", "-qm", "seed");
		return root;
	}

	const stage = (root: string, edit: (text: string) => string) => {
		const map = path.join(root, "docs", "doc-map.md");
		fs.writeFileSync(map, edit(fs.readFileSync(map, "utf8")));
		fs.writeFileSync(path.join(root, "docs", "notes.md"), "y\n");
		execFileSync("git", ["add", "--", "docs/doc-map.md", "docs/notes.md"], {
			cwd: root,
		});
	};

	it(
		"lets a commit through while §A matches the sidecar",
		async () => {
			const root = renderAgreeingRepo();
			const seeded = fs.readFileSync(
				path.join(root, "docs", "doc-map.md"),
				"utf8",
			);
			expect(seeded).toContain(REGISTER_HEADER);
			expect(seeded).toContain("| `docs/notes.md` |");

			stage(root, (t) => t);
			const { code, output } = await runGate(root);
			expect(code).toBe(0);
			expect(output).not.toContain("does not match what the generator renders");
		},
		slowGateMs,
	);

	it(
		"refuses the commit, naming the row and the regeneration command",
		async () => {
			const root = renderAgreeingRepo();
			stage(root, (t) =>
				t.replace(
					/^\| `docs\/notes\.md` .*$/m,
					"| `docs/notes.md` | hand-written prose | `source-of-truth` | Direct | — |",
				),
			);
			const { code, output } = await runGate(root);
			expect(code).not.toBe(0);
			expect(output).toContain("§A does not match what the generator renders");
			expect(output).toContain("docs/notes.md — row differs");
			expect(output).toContain(
				`node ${coreFile("scripts/generate-doc-map-section-a.js")}`,
			);
			expect(output).toContain("are NOT in HEAD — this commit adds them");
		},
		slowGateMs,
	);
});

describe("the copied fixture is isolated from its template (mantahostels#2079)", () => {
	it("a commit made in one copy leaves a fresh copy untouched", () => {
		const { root, git } = newRepo("doc-map-gate-isolation-", temps);
		fs.writeFileSync(path.join(root, "only-here.txt"), "x\n");
		git("add", "--", "only-here.txt");
		git("commit", "-qm", "only in this copy");
		expect(git("log", "--oneline").toString()).toContain("only in this copy");

		const { root: fresh, git: freshGit } = newRepo(
			"doc-map-gate-isolation-",
			temps,
		);
		fs.writeFileSync(path.join(fresh, "unrelated.txt"), "y\n");
		freshGit("add", "--", "unrelated.txt");
		freshGit("commit", "-qm", "unrelated");
		expect(freshGit("log", "--oneline").toString()).not.toContain(
			"only in this copy",
		);
		expect(fs.existsSync(path.join(fresh, "only-here.txt"))).toBe(false);
	});

	it("a commit made in one seeded copy leaves a fresh seeded copy untouched", () => {
		const { root, git } = newSeededRepo(temps);
		fs.writeFileSync(path.join(root, "only-here.txt"), "x\n");
		git("add", "--", "only-here.txt");
		git("commit", "-qm", "only in this copy");
		const log = git("log", "--oneline").toString();
		expect(log).toContain("only in this copy");
		expect(log).toContain("seed");

		const { root: fresh, git: freshGit } = newSeededRepo(temps);
		const freshLog = freshGit("log", "--oneline").toString();
		expect(freshLog).toContain("seed");
		expect(freshLog).not.toContain("only in this copy");
		expect(fs.existsSync(path.join(fresh, "only-here.txt"))).toBe(false);
	});
});
