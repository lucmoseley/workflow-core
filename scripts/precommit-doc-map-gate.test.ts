// @vitest-environment node
/*
 * The pre-commit doc-map gate (mantahostels#390) at its boundary: the hook's arming line,
 * and scripts/precommit-doc-map-gate.js run as a program over real git in a
 * throwaway repo (base §X11, #5155). The gate's branch cases are module cases
 * on its cores — lib/doc-map-gate.test.ts and lib/doc-map-gate-report.test.ts —
 * over the fake lib/doc-map-gate.contract.test.ts holds to the production ports.
 *
 * What stays here: the hook's wiring and its scope's parity with SCOPE; each
 * exit path and input channel of the entry; each production adapter crossed for
 * real (git's index extraction, HEAD's baseline under its own index, the dirty
 * check, HEAD's map, the checker and comparison spawns); the §X4 regressions
 * whose incident was at that boundary; and the real-commit cases, which run the
 * real checker and comparison through the hook line.
 *
 * `check-doc-map.js` and `checker-new-faults.js` are stubbed in each fixture
 * so every exit code can be driven, except in `a pointer count disagreeing with
 * its sidecar` and `a hand-edited Section A row`, which run the real ones.
 *
 * It is a hard gate in `.husky/pre-commit`: loosen a case and a commit leaving
 * `docs/doc-map.md` unregistered, dangling or hand-edited lands unrefused, and
 * the authority map every session checks before an edit stops telling the truth.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emptyDataFile } from "./lib/doc-map-testkit";
import { defineTemplate, mkScratchDir } from "./lib/git-fixture";
import {
	armingPattern,
	cutGateScript,
	expectFixtureSupplies,
	gateHead,
	registerTempCleanup,
	type TempRepo,
} from "./lib/precommit-gate-harness";
import {
	coreCall,
	HOOK,
	ROOT,
	writeCheckerDelegates,
} from "./lib/precommit-gate-testkit";
import { runInProcess } from "./lib/run-in-process.js";
import { shellQuote } from "./lib/sh-quote.js";

const ENTRY = "scripts/precommit-doc-map-gate.js";
const PORTS = "scripts/lib/doc-map-gate-ports.js";

const { readTrackedFiles } =
	require("./lib/doc-map") as typeof import("./lib/doc-map");

/** The scripts the entry's production ports run, read off their source. */
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

/** What a fixture running the hook line supplies: the entry and its scripts. */
const STUBBED = ["scripts/check-doc-map.js", "scripts/checker-new-faults.js"];
const realCheckerNames = () =>
	[ENTRY, ...STUBBED].map((s) => s.replace(/^scripts\//, ""));

/*
 * The bare repo is built once and copied (scripts/lib/git-fixture.ts), not
 * `git init` afresh per call. Fixtures with the default seed commit use
 * seededRepoTemplate below; the customised minority build on this one.
 */
const bareRepoTemplate = defineTemplate((root) => {
	execFileSync("git", ["init", "-q", "."], { cwd: root });
	// A repo-local identity: a machine with no global `user.email` cannot
	// commit at all.
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

/** The map, its five data files and the class sidecar — what a fixture repo
 * carries under docs/ (mantahostels#1849). The gate names none of them: it extracts the
 * whole index (mantahostels#1922), so this list is the FIXTURES'. */
const DOC_MAP_FILES = [
	"doc-map.md",
	"doc-map-restatements.json",
	"doc-map-superseded.json",
	"doc-map-retired-vocabulary.json",
	"doc-map-restatement-allowlist.json",
	"doc-map-high-water.json",
	"doc-map-classes.json",
];

/*
 * mantahostels#2200's template: a repo already carrying `fixture()`'s default seed
 * commit — seed.txt plus all seven DOC_MAP_FILES at their generic committed
 * content. The stub checkers are written per call off the worktree, never
 * committed: the gate runs them by path and only docs/ goes through git.
 */
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

const gateFragment = () => cutGateScript(ENTRY);

/**
 * How the hook's arming alternation differs from `SCOPE` in lib/doc-map.js, or
 * `null` where they agree. The two are separate spellings of one list — a new
 * SCOPE member would otherwise leave the gate silently not covering it.
 */
function parityGap(
	fragment: string,
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

	const pattern = /^\^\(([^)]*)\)$/.exec(armingPattern(ENTRY, fragment));
	if (!pattern)
		return "the gate's arming pattern is no longer one `^(…)` group";

	// A directory member is spelled `docs/`, a root file `AGENTS\.md$`; a member
	// with tracked files under it is a directory.
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
		: `hook matches ${JSON.stringify(alternatives)}, SCOPE is ${JSON.stringify(spelled)}`;
}

const temps = registerTempCleanup();

const STUB_MARKER = "STUB-CHECK-RAN";

/** Where the stub records what each invocation was handed, one line per call. */
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
	/** Which of DOC_MAP_FILES the fixture repo carries; all seven by default. */
	docMapFiles?: string[];
	/** Whether those files are COMMITTED or only staged. Committed by default. */
	docMapInHead?: boolean;
	/** Replaces the stub's whole report, for cases that read its text. */
	checkerStdout?: string;
	/** Replaces the COMMITTED docs/doc-map.md. */
	headMap?: string;
	/** The comparison's exit: 1 adds faults, 0 inherits them all. Default 1. */
	newFaultsExit?: number;
	/** Where the stubs go; the fixture's own scripts/ by default. */
	scriptsDir?: string;
}

/** Writes the two stub scripts the entry runs into `dir`. */
function writeStubs(dir: string, opts: FixtureOpts) {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "check-doc-map.js"), checkerStub(opts));
	/*
	 * It refuses any profile but `doc-map` (mantahostels#1797): the real script exits 2 on
	 * an unknown profile, so without this every case would pass a gate whose
	 * profile argument had been misspelled.
	 */
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

/**
 * A git repo with one commit, the stubs, and a delegate for the entry so the
 * hook line runs it. `staged` is written and staged; nothing else is.
 */
function fixture(opts: FixtureOpts): string {
	const usesDefaultSeed =
		opts.docMapFiles === undefined &&
		opts.docMapInHead !== false &&
		opts.headMap === undefined;
	const { root, git } = usesDefaultSeed
		? newSeededRepo(temps)
		: newRepo("doc-map-gate-", temps);

	writeStubs(opts.scriptsDir ?? path.join(root, "scripts"), opts);
	writeCheckerDelegates(root, [path.basename(ENTRY)]);
	if (!usesDefaultSeed) seedByHand(root, git, opts);

	for (const [rel, body] of Object.entries(opts.staged)) {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, body);
		git("add", "--", rel);
	}
	return root;
}

/** The stub checker's source: a call recorder, or a fixed report. */
function checkerStub(opts: FixtureOpts): string {
	return opts.checkerStdout === undefined
		? `const fs = require("node:fs");\n` +
				`const root = process.argv[process.argv.indexOf("--root") + 1];\n` +
				// The baseline call's stdout goes to a file, so what it was handed
				// is recorded here instead — see CALL_LOG.
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

/** The seed commit, built by hand where the options customise its docs. */
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

/*
 * GITHUB_ACTIONS off for every child here. check.js writes its ::error:: and
 * ::warning:: annotations to stdout when it is set, so on a CI runner the
 * checker's report gains lines the assertions below do not model.
 */
const NO_ANNOTATIONS = { ...process.env, GITHUB_ACTIONS: "" };

/*
 * The hook line, cut out and run under `sh -e` as husky runs it: spawnSync,
 * not execFileSync, since the gate writes to stderr and execFileSync returns
 * stdout alone on a zero exit (mantahostels#1300).
 */
function runGate(
	cwd: string,
	fragment: string = gateFragment(),
): { code: number; output: string } {
	const run = spawnSync("sh", ["-ec", fragment], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: NO_ANNOTATIONS,
	});
	return {
		code: run.status ?? 1,
		output: `${run.stdout ?? ""}${run.stderr ?? ""}`,
	};
}

/** The entry as a program, in-process, its cwd the fixture repo. */
function runEntry(
	cwd: string,
	{
		args = [],
		env = {},
	}: { args?: string[]; env?: Record<string, string> } = {},
): { code: number; output: string } {
	const run = runInProcess(path.join(ROOT, ENTRY), args, {
		cwd,
		env: { ...NO_ANNOTATIONS, ...env },
	});
	return { code: run.status, output: `${run.stdout}${run.stderr}` };
}

describe("the hook line", () => {
	it("is wired into .husky/pre-commit, passing the entry's exit code on", () => {
		expect(HOOK).toContain(`${coreCall("node", ENTRY)} || exit "$?"`);
	});

	// mantahostels#2071: a fixture short of a script the gate runs dies MODULE_NOT_FOUND,
	// which reads as a refusal and proves nothing.
	it("supplies exactly the scripts the hook line and the entry's ports run", () => {
		expectFixtureSupplies(ENTRY, [ENTRY]);
		expect(portScripts()).toEqual(STUBBED);
	});

	it("covers exactly the SCOPE check-doc-map.js enforces", () => {
		expect(parityGap(gateFragment())).toBeNull();
	});

	it("reports a gap when the regex loses a SCOPE member", () => {
		expect(
			parityGap(gateFragment().replace("|CLAUDE\\.md$", "")),
		).not.toBeNull();
	});

	it("spells a new directory member of SCOPE as a directory (#17)", () => {
		const checker = 'const SCOPE = ["docs", ".claude", "scripts", "CLAUDE.md"]';
		const tracked = ["docs/a.md", ".claude/x", "scripts/b.js", "CLAUDE.md"];
		const gateArmedOn = (alts: string) =>
			`if armed '^(${alts})'; then\n\tnode ${ENTRY}\nfi`;
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

	/*
	 * `armed` hands the pattern to `grep -E` over the staged names (lib/
	 * precommit-gate.sh); a group of alternatives, `\.` and `$` read the same
	 * in a JS RegExp, so each path is judged here and one case per direction
	 * runs the line for real below.
	 */
	const arms = (rel: string, fragment = gateFragment()) =>
		new RegExp(armingPattern(ENTRY, fragment)).test(rel);

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

	// A path merely CONTAINING a scope name is not in scope: the pattern is
	// anchored, so `my-docs/` and `x/CLAUDE.md` must not arm it.
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
		const mutant = gateFragment().replace("'^(docs/", "'(docs/");
		expect(mutant).not.toBe(gateFragment());
		expect(arms("my-docs/a.md", mutant)).toBe(true);
	});

	it("stops covering CLAUDE.md when its alternative is dropped", () => {
		const mutant = gateFragment().replace("|CLAUDE\\.md$", "");
		expect(mutant).not.toBe(gateFragment());
		expect(arms("CLAUDE.md", mutant)).toBe(false);
	});

	it("runs the gate for a commit touching the scope, refusing on the checker's failure", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});

		const { code, output } = runGate(repo);
		expect(code).toBe(1);
		expect(output).toContain(STUB_MARKER);
	});

	it("does not run the gate for a commit outside the map's scope", () => {
		const repo = fixture({
			staged: { "app/page.tsx": "x\n", "scripts/thing.js": "x\n" },
			// Exit 1, so a gate that wrongly ran fails loudly.
			checkerExit: 1,
		});

		const { code, output } = runGate(repo);
		expect(code).toBe(0);
		expect(output).not.toContain(STUB_MARKER);
	});

	it("runs the gate out of scope when the path filter is dropped", () => {
		const repo = fixture({ staged: { "app/page.tsx": "x\n" }, checkerExit: 1 });

		const mutant = gateFragment().replace(gateHead(ENTRY), "if true; then\n");
		expect(mutant).not.toBe(gateFragment());
		const { code, output } = runGate(repo, mutant);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});

	it("fires on a deletion", () => {
		const repo = fixture({ staged: {}, checkerExit: 1 });
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
		fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
		fs.writeFileSync(path.join(repo, "docs", "gone.md"), "x\n");
		git("add", "--", "docs/gone.md");
		git("commit", "-qm", "add doc");
		git("rm", "-q", "--", "docs/gone.md");

		const { code, output } = runGate(repo);
		expect(code).not.toBe(0);
		expect(output).toContain(STUB_MARKER);
	});
});

describe("the entry's exits and input channels", () => {
	it("prints nothing and exits 0 when the checker passes", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 0,
		});

		expect(runEntry(repo)).toEqual({ code: 0, output: "" });
	});

	// BROKEN (2) and FAIL (1) stay distinguishable, as in the digest-version gate.
	it("propagates the checker's own exit code", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 2,
		});

		const { code, output } = runEntry(repo);
		expect(code).toBe(2);
		expect(output).toContain(STUB_MARKER);
		expect(output).toContain("NOT in HEAD");
	});

	// Silence would hide a red main from the one person able to repair it.
	it("passes a failing check whose every fault is inherited, still replaying its report", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
			newFaultsExit: 0,
		});

		const { code, output } = runEntry(repo);
		expect(code).toBe(0);
		expect(output).toContain(STUB_MARKER);
		expect(output).toContain("already in HEAD");
	});

	/* End to end, over the real crash rather than a driven exit code: node exits
	 * 1 on a missing module, which the gate once read as a clean "this commit
	 * added these" and printed the MODULE_NOT_FOUND trace as the fault list
	 * (mantahostels#2026). */
	it("says the comparison could not run when its script is gone, blaming the commit for nothing", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});
		fs.rmSync(path.join(repo, "scripts", "checker-new-faults.js"));

		const { code, output } = runEntry(repo);
		expect(code).toBe(1);
		expect(output).toContain("could not tell inherited doc-map faults");
		expect(output).not.toContain("NOT in HEAD");
		expect(output).toContain("diagnostics, not findings");
		expect(output).toContain("MODULE_NOT_FOUND");
	});

	/* HEAD's real extraction, through `read-tree` into a temp index, holds no
	 * map: no baseline, so refuse. */
	it("fails closed when HEAD holds no baseline to compare against", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
			docMapInHead: false,
			newFaultsExit: 0,
		});

		const { code, output } = runEntry(repo);
		expect(code).toBe(1);
		expect(output).toContain("no readable HEAD baseline for the doc-map check");
	});

	/* The half of mantahostels#1300 a replay does not close, over HEAD's real map: the
	 * session that ADDS the row is the one that can still fix it. */
	it("refuses a commit that adds a row for a file it does not contain", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 0,
			checkerStdout: UNTRACKED_REPORT,
			headMap: "# Section A\n| `docs/other.md` | a note | `reference` |\n",
		});

		const { code, output } = runEntry(repo);
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

		const { code, output } = runEntry(repo, { args: ["--force"] });
		expect(code).toBe(2);
		expect(output).toBe(
			"usage: node precommit-doc-map-gate.js (takes no arguments)\n",
		);
	});

	/* An interrupt reaches the whole process group, as a terminal's Ctrl-C does:
	 * the checker dies at once, and the gate, deferring the signal to the end of
	 * its synchronous run, removes its scratch and exits 128 + the signal. */
	it("exits 143 on SIGTERM, leaving no scratch behind", async () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
			newFaultsExit: 0,
		});
		fs.writeFileSync(
			path.join(repo, "scripts", "check-doc-map.js"),
			'if (!process.argv.includes("--json")) {\n' +
				'  require("node:fs").writeFileSync("started", "");\n' +
				"  setTimeout(() => {}, 30000);\n" +
				"} else console.log('{}');\n",
		);
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "doc-map-sig-"));
		temps.push(scratch);
		// spawn-kept: a signal, sent to a live process group.
		const child = spawn(process.execPath, [path.join(ROOT, ENTRY)], {
			cwd: repo,
			detached: true,
			stdio: "ignore",
			env: { ...NO_ANNOTATIONS, TMPDIR: scratch },
		});
		const code = await new Promise<number | null>((resolve) => {
			child.on("exit", (c) => resolve(c));
			const poll = setInterval(() => {
				if (!fs.existsSync(path.join(repo, "started"))) return;
				clearInterval(poll);
				process.kill(-(child.pid as number), "SIGTERM");
			}, 10);
		});
		expect(code).toBe(143);
		expect(fs.readdirSync(scratch)).toEqual([]);
	});

	// An adopter's shim sets WFC_PLUGIN_ROOT so the plugin's scripts run (#1839).
	it("runs the scripts under WFC_PLUGIN_ROOT when it is set", () => {
		const plugin = fs.mkdtempSync(path.join(os.tmpdir(), "doc-map-plugin-"));
		temps.push(plugin);
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 3,
			scriptsDir: path.join(plugin, "scripts"),
		});

		const { code, output } = runEntry(repo, {
			env: { WFC_PLUGIN_ROOT: plugin },
		});
		expect(code).toBe(3);
		expect(output).toContain(STUB_MARKER);
	});
});

describe("the index the checker is handed, extracted by real git", () => {
	// mantahostels#1191 (the ticket that fed this gate from the index, not the worktree).
	it("hands the checker the INDEX's map, not the worktree's", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});
		fs.writeFileSync(
			path.join(repo, "docs", "doc-map.md"),
			"dirty worktree map\n",
		);

		const { output } = runEntry(repo);
		expect(output).toContain("committed doc-map.md");
		expect(output).not.toContain("dirty worktree map");
	});

	// The deadlock mantahostels#1191 records: the map and a sidecar dirty together, in the
	// state where the pair on disk disagrees. The checker must see the committed
	// pair, so both files' contents are asserted, not just the exit.
	it("judges a dirty map and sidecar by their committed pair", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});
		for (const name of ["doc-map.md", "doc-map-high-water.json"])
			fs.writeFileSync(path.join(repo, "docs", name), "half-written\n");

		const { output } = runEntry(repo);
		expect(output).toContain("committed doc-map.md");
		expect(output).toContain("committed doc-map-high-water.json");
		expect(output).not.toContain("half-written");
	});

	/* Not a named list (mantahostels#1922): the sidecars arrive because the WHOLE index
	 * does, which `research` — a directory no copy loop would have carried — is
	 * what proves. The map is clean here, so git's dirty check passes no flag. */
	it("hands the checker the commit's whole docs/, and no --map-dirty for a clean map", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});

		const { output } = runEntry(repo);
		const listed = /DIR:(\S*)/.exec(output)?.[1];
		expect(listed?.split(",").sort()).toEqual(
			[...DOC_MAP_FILES, "research"].sort(),
		);
		expect(output).not.toContain("--map-dirty");
	});

	/* With the whole index extracted there is no per-file apparatus failure
	 * left, so a data file genuinely absent from the index is a repo fault and
	 * reaches the checker as one (mantahostels#1922). */
	it("reaches the checker when a data file is missing from the index", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
			docMapFiles: DOC_MAP_FILES.filter((n) => n !== "doc-map-high-water.json"),
		});

		const { code, output } = runEntry(repo);
		expect(output).toContain(STUB_MARKER);
		expect(output).not.toContain("skipped the doc-map check");
		expect(code).not.toBe(0);
	});

	/* Half-staging the map does not skip the gate (mantahostels#1202), and git's dirty
	 * check passes the flag on (mantahostels#1193). */
	it("hands the checker the staged map, flagged dirty, when only the map is staged", () => {
		const repo = fixture({
			staged: { "docs/doc-map.md": "edited doc-map\n" },
			checkerExit: 1,
		});

		const { output } = runEntry(repo);
		expect(output).toContain(STUB_MARKER);
		expect(output).toContain(`DIR:${DOC_MAP_FILES.slice().sort().join(",")}`);
		expect(output).toContain("edited doc-map");
		expect(output).toContain("--map-dirty");
	});

	/* mantahostels#1922's blocker: --root moves the FILESYSTEM reads, and assertion 16's
	 * pool delta is an INDEX read, which only GIT_INDEX_FILE can point at HEAD. */
	it("runs the baseline under HEAD's index and the staged side under this one", () => {
		const repo = fixture({
			staged: { "docs/research/note.md": "x\n" },
			checkerExit: 1,
		});

		runEntry(repo);
		const calls = fs
			.readFileSync(path.join(repo, CALL_LOG), "utf8")
			.trim()
			.split("\n");
		// held run, --json staged run, --json baseline run.
		expect(calls).toHaveLength(3);
		expect(calls[0].startsWith("- ")).toBe(true);
		expect(calls[1].startsWith("- ")).toBe(true);
		expect(calls[2]).toMatch(/^\S+\/index /);
	});
});

/*
 * The safety claim the hook's own comment makes: under a PATHSPEC commit, git hands
 * the hook a temporary index, so the checker's `git ls-files` sees this commit's
 * paths and not a parallel session's `git add -N` file.
 */
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

		// A parallel session's in-flight file, and this commit's own.
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

/*
 * Why the checker's conflicted-index SKIP is unreachable from any hook (scripts/check-doc-map.js's header):
 * git refuses a commit holding unmerged entries before pre-commit fires, so the
 * only caller that can reach a conflicted index is a person running the checker
 * by hand mid-resolution.
 */
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

		/* Installed after the setup commits, so hook.out can only come from the commit under test. */
		fs.mkdirSync(path.join(root, ".githooks"));
		const hook = path.join(root, ".githooks", "pre-commit");
		fs.writeFileSync(
			hook,
			`#!/bin/sh\necho ${shellQuote(STUB_MARKER)} > hook.out\n`,
		);
		fs.chmodSync(hook, 0o755);

		try {
			git("merge", "other");
		} catch {
			/* expected: the merge conflicts */
		}

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
			// Piped, so git's expected refusal is not printed into a green run.
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

/*
 * Assertion 11 (mantahostels#1474) through the hook rather than through a stub: the gate is
 * where a pointer disagreeing with its sidecar is caught before the push.
 */
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

	/* `stated` is §B1's pointer count, `seedPaths` the restatement paths HEAD
	 * carries and `stagedPaths` the ones this commit stages. The gate is
	 * direction-gated, so a fault present in both readings is INHERITED and
	 * passes — a case meant to be refused must differ across them. The
	 * divergence is put in the SIDECAR rather than the map because editing the
	 * map makes it dirty, and a pointer fault against a dirty map is a WARN by
	 * design (mantahostels#1193), which never reaches the direction gate at all. */
	function realCheckerRepo(
		stated = 2,
		seedPaths = 1,
		stagedPaths = seedPaths,
	): string {
		const { root, git } = newRepo("doc-map-pointer-", temps);
		// The direction comparer as well as the checker: without it the gate dies
		// MODULE_NOT_FOUND and its refusal proves nothing about the comparison.
		// The entry and the two scripts it runs, each checked against the
		// invocation lists, so a name silently dropped here is caught rather
		// than surviving as an unreached MODULE_NOT_FOUND refusal (mantahostels#2237).
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
		/* The class sidecar is the coverage register (mantahostels#1849), and the loop
		 * above has already written it as `{}`. Overwrite that with the real
		 * register: a repo whose sidecar keys no file is BROKEN. */
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

	it("lets the commit through when the pointer and its key agree", () => {
		const repo = realCheckerRepo(1);
		const { code, output } = runGate(repo);
		expect(code).toBe(0);
		expect(output).not.toContain("pointer says");
	});

	/* Left to the checker's tracked-path fallback both readings resolve one
	 * working-tree file, the fault sets are identical and the deletion passes;
	 * read from each side's own extraction they differ (mantahostels#1849, mantahostels#1922).
	 *
	 * The seed commit is backdated because an uncovered file inside
	 * PAIRING_GRACE_MS is a WARN kept out of the --json envelope (mantahostels#1785), so a
	 * key deleted in the same session that registered the file is NOT refused. */
	it("refuses a commit that deletes a registration key, naming the file left with no register entry", () => {
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
		// The §A row goes with it, or assertion 17 refuses the commit on the
		// orphaned row instead and the coverage limb is never reached.
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

		const { code, output } = runGate(repo);
		expect(code).not.toBe(0);
		expect(output).toContain("docs/notes.md");
		expect(output).toContain("no doc-map register entry");
	});

	it("refuses the commit and prints the fix", () => {
		const { code, output } = runGate(realCheckerRepo(2, 2, 1));
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

/*
 * Assertion 17 (mantahostels#1852) through the hook rather than through the checker alone:
 * §A is rendered from the sidecar, so a hand edit to a row has to be refused at
 * the COMMIT.
 */
describe("a hand-edited Section A row", () => {
	/* Each case runs over vitest's 5 s default, which would read as a failure
	 * rather than as load (mantahostels#1852). */
	const slowGateMs = 20_000;

	const { renderSectionA, REGISTER_HEADER } =
		require("./lib/doc-map") as typeof import("./lib/doc-map");

	/** The map before §A is rendered into it: heading, subsection, bare table. */
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

	/** A repo whose §A agrees with its sidecar, seeded and committed. */
	function renderAgreeingRepo(): string {
		const { root, git } = newRepo("doc-map-render-", temps);
		// As realCheckerRepo's (mantahostels#2237, mantahostels#2242).
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

	/** Stage `edit` applied to the map, plus an unrelated touch to notes.md. */
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
		() => {
			const root = renderAgreeingRepo();
			/* The assertion skips a §A with no register table, exiting 0 having
			 * compared nothing (check-doc-map.js:1204) — and the gate holds the
			 * checker's report on a green run, so the skip is invisible in `output`. */
			const seeded = fs.readFileSync(
				path.join(root, "docs", "doc-map.md"),
				"utf8",
			);
			expect(seeded).toContain(REGISTER_HEADER);
			expect(seeded).toContain("| `docs/notes.md` |");

			stage(root, (t) => t);
			const { code, output } = runGate(root);
			expect(code).toBe(0);
			expect(output).not.toContain("does not match what the generator renders");
		},
		slowGateMs,
	);

	it(
		"refuses the commit, naming the row and the regeneration command",
		() => {
			const root = renderAgreeingRepo();
			stage(root, (t) =>
				t.replace(
					/^\| `docs\/notes\.md` .*$/m,
					"| `docs/notes.md` | hand-written prose | `source-of-truth` | Direct | — |",
				),
			);
			const { code, output } = runGate(root);
			expect(code).not.toBe(0);
			expect(output).toContain("§A does not match what the generator renders");
			expect(output).toContain("docs/notes.md — row differs");
			expect(output).toContain("npm run gen:doc-map-section-a");
			/* The gate replays the checker's report BEFORE the direction verdict
			 * (lib/doc-map-gate.js), so the three strings above are printed
			 * whichever way it resolves — including its could-not-answer refusal. */
			expect(output).toContain("are NOT in HEAD — this commit adds them");
		},
		slowGateMs,
	);
});

/*
 * git-fixture.ts (mantahostels#2068) leak-checks every instantiate() call itself (proven
 * in git-fixture.test.ts), so newRepo() above already throws before any test
 * body runs were a copy still pointing at the template. bareRepoTemplate
 * writes no absolute-path-bearing content — no hooksPath, no worktree, no
 * alternates — so relink() has nothing to find there, and the first case below
 * cannot exercise a relink regression on that front. What it DOES check, and
 * what mantahostels#2079's acceptance criteria ask for, is a narrower thing: a commit made
 * in one instantiated copy must not reach a second, independent instantiation
 * of the same template, i.e. that `fs.cpSync` isn't sharing a git object store
 * or a ref namespace between copies.
 *
 * seededRepoTemplate (mantahostels#2200) is the first template in this file that ISN'T
 * empty at the point of copy: it already carries one commit, a populated
 * object store and a ref — exactly the sharing vector the isolation claim
 * above is about, so it needs its own case rather than inheriting coverage
 * from the bare one (mantahostels#2200's review, spec axis finding 3).
 */
describe("the copied fixture is isolated from its template (mantahostels#2079)", () => {
	it("a commit made in one copy leaves a fresh copy untouched", () => {
		const { root, git } = newRepo("doc-map-gate-isolation-", temps);
		fs.writeFileSync(path.join(root, "only-here.txt"), "x\n");
		git("add", "--", "only-here.txt");
		git("commit", "-qm", "only in this copy");
		expect(git("log", "--oneline").toString()).toContain("only in this copy");

		// The fresh copy needs its own commit before `git log` is even callable
		// (a brand-new repo has no HEAD) — an unrelated one, so a shared object
		// store or ref namespace between copies would surface here rather than
		// being masked by the fresh copy having nothing to compare against.
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

	/* As above, but starting from seededRepoTemplate's own one-commit history
	 * — the discriminating case a template with no prior content cannot pose. */
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
