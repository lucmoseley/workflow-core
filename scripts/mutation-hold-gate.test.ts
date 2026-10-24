// @vitest-environment node
/*
 * Pins the pre-commit hold on a surviving mutant (#1906, spec #1871): with the
 * `mutation` module on, a commit changing a line on a declared sensitive path
 * is refused while a mutant StrykerJS plants on that line survives or has no
 * covering test. Break it and money or personal-data code lands with a test
 * gap nothing sees, or a commit is charged for mutants on lines it never
 * touched.
 *
 * Driven through real `git commit`s in a fixture repo whose pre-commit hook is
 * the live hook's own stamp read, line ending its early gates, test gate and
 * mutation-hold block, with a stub lint gate above that line, against a stub
 * Stryker named by WFC_STRYKER. The report shape is the one #1901 recorded from Stryker 10.0.0.
 *
 * The same seam drives commit-paths' pre-lock run of the hold (#1910): loosen
 * those cases and a cold run of minutes holds the index lock against every
 * neighbour, a lint finding waits behind it, or a change the pre-lock run
 * never saw lands on its green.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stampFile, writeStamp } from "./lib/commit-key.js";
import { mkScratchDir } from "./lib/git-fixture";
import {
	CORE_ROOT,
	coreCall,
	cutHookBlock,
	HOOK,
	ROOT,
} from "./lib/precommit-gate-testkit";
import { runInProcess } from "./lib/run-in-process";

const WIRING = `  ${coreCall("node", "scripts/mutation-hold-gate.js")} || exit 1`;
const HOLD_BLOCK = cutHookBlock('mh_why=""', "fi");
const TEST_GATE_OPEN = `if declared_cmd ${coreCall("node", "scripts/lib/test-gate.js")} commit`;
const GATES_END = HOOK.split("\n").find((l) =>
	l.startsWith("# ---- end of the gates"),
);
const COMMIT_PATHS = path.join(ROOT, "scripts/commit-paths.js");
const COMMIT_KEY = path.join(ROOT, "scripts/lib/commit-key.js");

const STUB_LINT = `echo lint >> "$STUB_DIR/lint.log"
if [ -f "$STUB_DIR/lint-red" ]; then echo "lint: a finding in lib/money.js"; exit 1; fi`;
const MONEY = "lib/money.js";
const SEED = [
	"export function fee(amount) {",
	"  if (amount > 100) return amount * 0.1;",
	"  return 0;",
	"}",
	"export function tax(amount) {",
	"  return amount * 0.2;",
	"}",
	"",
].join("\n");

/**
 * What the hold reads of Stryker: `run <config>`, a red initial run's line and
 * exit 1, a JSON report at the config's path.
 */
const STUB = `const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
(async () => {
	const dir = process.env.STUB_DIR;
	const config = (await import(pathToFileURL(process.argv[3]).href)).default;
	const money = path.join(process.cwd(), ${JSON.stringify(MONEY)});
	const inc = config.incrementalFile;
	fs.appendFileSync(path.join(dir, "stub.log"), JSON.stringify({
		argv: process.argv.slice(2),
		config,
		cwd: fs.realpathSync(process.cwd()),
		money: fs.existsSync(money) ? fs.readFileSync(money, "utf8") : null,
		seeded: fs.existsSync(inc) ? fs.readFileSync(inc, "utf8") : null,
		lock: fs.existsSync(path.join(process.env.STUB_REPO, ".git", "index.lock")),
	}) + "\\n");
	// A named file edited mid-run: "mid" holds what lib/money.js becomes.
	const mid = path.join(dir, "mid");
	if (fs.existsSync(mid)) {
		fs.writeFileSync(path.join(process.env.STUB_REPO, ${JSON.stringify(MONEY)}), fs.readFileSync(mid));
		fs.rmSync(mid);
	}
	if (fs.existsSync(path.join(dir, "red"))) {
		console.log("ERROR Stryker There were failed tests in the initial test run.");
		process.exit(1);
	}
	// A barrier: with "pair" present, two runs meet here before either writes,
	// the first to arrive writing 1 MiB and the second 8 bytes of padding, so a
	// write-back that is not atomic tears the cache into JSON that will not
	// parse. The 20 s ceiling and 20 ms poll are guesses.
	let pad = 1 << 20;
	if (fs.existsSync(path.join(dir, "pair"))) {
		const met = () => fs.readdirSync(dir).filter((f) => f.startsWith("met-")).length;
		if (met() > 0) pad = 8;
		fs.writeFileSync(path.join(dir, "met-" + process.pid), "");
		const until = Date.now() + 20000;
		while (met() < 2 && Date.now() < until)
			await new Promise((r) => setTimeout(r, 20));
	}
	const cannedInc = path.join(dir, "incremental.json");
	fs.writeFileSync(inc, fs.existsSync(cannedInc)
		? fs.readFileSync(cannedInc, "utf8")
		: JSON.stringify({ by: process.pid, pad: "x".repeat(pad) }));
	if (fs.existsSync(path.join(dir, "no-report"))) return;
	const canned = path.join(dir, "report.json");
	fs.writeFileSync(config.jsonReporter.fileName,
		fs.existsSync(canned) ? fs.readFileSync(canned, "utf8") : '{"files":{}}');
})();
`;

let scratch: string;
let repo: string;
let hooks: string;
let stubDir: string;

const env = (extra: Record<string, string | undefined> = {}) => {
	const e: Record<string, string | undefined> = {
		...process.env,
		CLAUDE_CODE_SESSION_ID: "",
		CLAUDE_CONFIG_DIR: scratch,
		WFC_PLUGIN_ROOT: ROOT,
		WFC_STRYKER: path.join(stubDir, "stryker.js"),
		STUB_DIR: stubDir,
		STUB_REPO: repo,
		PATH: `${path.join(scratch, "bin")}${path.delimiter}${process.env.PATH}`,
		...extra,
	};
	delete e.CLAUDE_PROJECT_DIR;
	delete e.GIT_INDEX_FILE;
	delete e.GIT_REFLOG_ACTION;
	return e;
};

const git = (...args: string[]) => {
	const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: env() });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
};
const write = (rel: string, text: string, root = repo) => {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), text);
};

/** A commit as commit-paths makes one; with no paths, the index as staged. */
const commitArgs = (paths: string[]) => [
	"-c",
	`core.hooksPath=${hooks}`,
	"commit",
	"-qm",
	"land",
	...(paths.length > 0 ? ["--", ...paths] : []),
];
const commit = (
	paths: string[],
	{
		cwd = repo,
		extra = {},
	}: { cwd?: string; extra?: Record<string, string | undefined> } = {},
) =>
	spawnSync("git", commitArgs(paths), {
		cwd,
		encoding: "utf8",
		env: env(extra),
	});

const TOOLS = [
	"@stryker-mutator/core",
	"@stryker-mutator/vitest-runner",
	"vitest",
];
/**
 * Install each named package, empty, in `root`'s node_modules; with Stryker's
 * core, its instrumenter beside it, whose Babel core is the core's own.
 */
const install = (names: string[], root = repo) => {
	for (const n of names) write(`node_modules/${n}/package.json`, "{}\n", root);
	if (!names.includes("@stryker-mutator/core")) return;
	write(
		"node_modules/@stryker-mutator/instrumenter/package.json",
		"{}\n",
		root,
	);
	fs.mkdirSync(path.join(root, "node_modules/@babel"), { recursive: true });
	fs.symlinkSync(
		path.join(ROOT, "node_modules/@babel/core"),
		path.join(root, "node_modules/@babel/core"),
	);
};

/** A linked worktree on a branch of its own, holding the line-2 change. */
const linkedTree = (name: string) => {
	const dir = path.join(scratch, name);
	git("worktree", "add", "-q", "-b", name, dir);
	install(TOOLS, dir);
	write(MONEY, SEED.replace("amount > 100", "amount >= 100"), dir);
	return dir;
};

/** Land a host Stryker config, unheld, as the base the next commit runs on. */
const landHostConfig = () => {
	git("add", "-A");
	git("commit", "-qm", "host config");
};

/** The fixture's hook, carrying the live test gate where `testGate`, which prints a line on every commit declaring no test. */
const writeHook = ({ testGate = false } = {}) =>
	fs.writeFileSync(
		path.join(hooks, "pre-commit"),
		[
			"#!/usr/bin/env sh",
			"set -e",
			cutHookBlock("tg_stamp=", "unset WFC_TEST_STAMP WFC_MUTATION_STAMP"),
			`. ${CORE_ROOT}scripts/lib/precommit-gate.sh`,
			STUB_LINT,
			GATES_END,
			...(testGate ? [cutHookBlock(TEST_GATE_OPEN, "fi")] : []),
			HOLD_BLOCK,
			"",
		].join("\n"),
		{ mode: 0o755 },
	);

const commitCount = () => Number(git("rev-list", "--count", "HEAD"));

/** Every fail-open record the gate logged, check-guard-errors.js's input. */
const logged = () => {
	const found: string[] = [];
	const walk = (d: string) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.includes("error")) found.push(fs.readFileSync(p, "utf8"));
		}
	};
	const projects = path.join(scratch, "projects");
	if (fs.existsSync(projects)) walk(projects);
	return found.join("");
};

const REAL_GIT = spawnSync("sh", ["-c", "command -v git"], {
	encoding: "utf8",
}).stdout.trim();
/**
 * git and sh are faked here, failing one chosen call, as neither has a WFC_
 * variable to name a stub by and the hook calls both itself.
 */
const onPath = (name: string, script: string) =>
	fs.writeFileSync(path.join(scratch, "bin", name), `#!/bin/sh\n${script}`, {
		mode: 0o755,
	});
/** Put on GIT_EXEC_PATH, which git puts first on a hook's PATH. */
const gitRefuses = () => {
	onPath(
		"git",
		`case " $* " in *" diff --cached --name-only --no-renames -z "*) echo "fatal: stub git will not answer" >&2; exit 128 ;; esac\nexec ${REAL_GIT} "$@"\n`,
	);
	return { GIT_EXEC_PATH: path.join(scratch, "bin") };
};
const routeRefuses = () =>
	onPath(
		"sh",
		`case "\${4-}" in */commit-route.sh) echo "stub sh: no route" >&2; exit 2 ;; esac\nexec /bin/sh "$@"\n`,
	);
const CONFIG = ".claude/workflow-core.json";
const switchModuleOff = () => {
	write(
		CONFIG,
		JSON.stringify({
			sensitivePaths: [
				{ name: "money", description: "what a guest pays", globs: ["lib/**"] },
			],
		}),
	);
	git("commit", "-qm", "module off", "--", CONFIG);
};

interface Runs {
	argv: string[];
	config: Record<string, unknown>;
	cwd: string;
	money: string | null;
	seeded: string | null;
	lock: boolean;
}
const runs = (): Runs[] => {
	const log = path.join(stubDir, "stub.log");
	if (!fs.existsSync(log)) return [];
	return fs
		.readFileSync(log, "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));
};

interface Mutant {
	line: number;
	status: string;
	/** null leaves the start column out. */
	col?: number | null;
	endCol?: number;
	endLine?: number;
	mutatorName?: string;
	replacement?: string;
	static?: boolean;
	testsCompleted?: number;
}
/** `source` is the report's source text, true for the file's own, false for none. */
const report = (
	mutants: Mutant[],
	{ source = true as boolean | string, file = MONEY } = {},
) => {
	const text =
		typeof source === "string"
			? source
			: fs.readFileSync(path.join(repo, file), "utf8");
	fs.writeFileSync(
		path.join(stubDir, "report.json"),
		JSON.stringify({
			schemaVersion: "1.0",
			files: {
				[file]: {
					language: "javascript",
					...(source === false ? {} : { source: text }),
					mutants: mutants.map((m, i) => ({
						id: String(i),
						mutatorName: m.mutatorName ?? "ConditionalExpression",
						replacement: m.replacement ?? "true",
						status: m.status,
						static: m.static ?? false,
						...(m.testsCompleted === undefined
							? {}
							: { testsCompleted: m.testsCompleted }),
						location: {
							start: {
								line: m.line,
								...(m.col === null ? {} : { column: m.col ?? 7 }),
							},
							end: { line: m.endLine ?? m.line, column: m.endCol ?? 20 },
						},
					})),
				},
			},
		}),
	);
};

/** The rule the refusal appends, read as the gate reads it. */
const RULE = fs.readFileSync(
	path.join(ROOT, "docs/agents/rules/mutation-hold.txt"),
	"utf8",
);

/** Every refusal ends on the whole rule and the closing line (#2077). */
const expectRuleAppended = (r: ReturnType<typeof commit>) => {
	expect(r.stderr).toContain(
		`${RULE.trim()}\n\npre-commit: the mutation hold refused this commit (rule:mutation-hold). Nothing was committed.`,
	);
};

const INSTALL =
	"npm install --save-dev @stryker-mutator/core@10.0.0 @stryker-mutator/vitest-runner@10.0.0";

const changeLine2 = () =>
	write(MONEY, SEED.replace("amount > 100", "amount >= 100"));

const expectLanded = (r: ReturnType<typeof commit>) => {
	expect(r.stderr).not.toContain("refused");
	expect(r.status).toBe(0);
	expect(commitCount()).toBe(2);
};
const expectHeld = (r: ReturnType<typeof commit>) => {
	expect(r.status).toBe(1);
	expect(commitCount()).toBe(1);
};

beforeEach(() => {
	scratch = mkScratchDir("mutation-hold-gate-");
	repo = path.join(scratch, "repo");
	hooks = path.join(scratch, "hooks");
	stubDir = path.join(scratch, "stub");
	fs.mkdirSync(repo);
	fs.mkdirSync(stubDir);
	fs.mkdirSync(path.join(scratch, "bin"));
	fs.writeFileSync(
		path.join(stubDir, "stryker.js"),
		`#!/usr/bin/env node\n${STUB}`,
		{
			mode: 0o755,
		},
	);
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	write(
		".claude/workflow-core.json",
		JSON.stringify({
			modules: ["mutation"],
			sensitivePaths: [
				{ name: "money", description: "what a guest pays", globs: ["lib/**"] },
			],
		}),
	);
	write(".gitignore", ".claude/worktrees/\nnode_modules/\n");
	install(TOOLS);
	write(MONEY, SEED);
	write("lib/rates.json", "{}\n");
	write("app/page.js", "old\n");
	git("add", "-A");
	git("commit", "-qm", "seed");
	fs.mkdirSync(hooks);
	writeHook();
});

afterEach(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

describe("mutation-hold-gate.js — wiring", () => {
	it("runs from .husky/pre-commit below the early-gates marker, after the test gate", () => {
		const lines = HOOK.split("\n");
		const at = lines.indexOf(HOLD_BLOCK.split("\n")[0] ?? "");
		expect(HOLD_BLOCK.split("\n")).toContain(WIRING);
		expect(at).toBeGreaterThan(lines.indexOf(GATES_END ?? ""));
		expect(at).toBeGreaterThan(
			lines.findIndex((l) => l.startsWith(TEST_GATE_OPEN)),
		);
	});
});

describe("mutation-hold-gate.js — the verdict", () => {
	it("refuses a survivor on a changed line, naming the area, the mutant, the ways past and the rule", () => {
		changeLine2();
		report([{ line: 2, status: "Survived", col: 7, endCol: 20 }]);
		const r = commit([MONEY]);
		expectHeld(r);
		expect(r.stderr).toContain("Areas touched: money.");
		expect(r.stderr).toContain(
			"  lib/money.js:2:7  ConditionalExpression  amount >= 100 → true  Survived",
		);
		expect(r.stderr).toContain("a test that kills it");
		expect(r.stderr).toContain(
			"// Stryker disable next-line <mutator>: <reason>",
		);
		expectRuleAppended(r);
	});

	it("passes a survivor on an unchanged line, as a report carrying cached mutants has", () => {
		changeLine2();
		report([
			{ line: 2, status: "Killed" },
			{ line: 6, status: "Survived", col: 10, endCol: 16 },
		]);
		expectLanded(commit([MONEY]));
	});

	it("refuses NoCoverage like a survivor, and names only the in-range mutant", () => {
		changeLine2();
		report([
			{ line: 2, status: "NoCoverage" },
			{ line: 6, status: "NoCoverage", col: 10, endCol: 16 },
		]);
		const r = commit([MONEY]);
		expectHeld(r);
		expect(r.stderr).toContain("lib/money.js:2:7 ");
		expect(r.stderr).toContain("NoCoverage");
		expect(r.stderr).not.toContain("lib/money.js:6:");
	});

	it.each(["Killed", "Timeout", "Ignored", "CompileError", "RuntimeError"])(
		"passes %s on a changed line",
		(status) => {
			changeLine2();
			report([{ line: 2, status }]);
			expectLanded(commit([MONEY]));
		},
	);

	it("refuses a static NoCoverage mutant, which no false Survived explains", () => {
		changeLine2();
		report([
			{ line: 2, status: "NoCoverage", static: true, testsCompleted: 0 },
		]);
		expectHeld(commit([MONEY]));
	});

	it("leaves a static mutant no test ran unjudged, naming it", () => {
		changeLine2();
		report([{ line: 2, status: "Survived", static: true, testsCompleted: 0 }]);
		const r = commit([MONEY]);
		expectLanded(r);
		expect(r.stderr).toContain("static mutant(s) no test ran");
		expect(r.stderr).toContain("lib/money.js:2:7");
	});

	it("reads the replaced source from the staged file where the report carries none", () => {
		changeLine2();
		report([{ line: 2, status: "Survived" }], { source: false });
		const r = commit([MONEY]);
		expectHeld(r);
		expect(r.stderr).toContain("amount >= 100 → true");
	});

	it("refuses a red initial run as red tests, not as mutants", () => {
		changeLine2();
		report([{ line: 2, status: "Survived" }]);
		fs.writeFileSync(path.join(stubDir, "red"), "");
		const r = commit([MONEY]);
		expectHeld(r);
		expect(r.stderr).toContain("initial test run is RED");
		expect(r.stderr).not.toContain("lib/money.js:2:");
		expectRuleAppended(r);
	});

	it("refuses a Stryker that cannot run, rather than passing", () => {
		changeLine2();
		const r = commit([MONEY], {
			extra: { WFC_STRYKER: path.join(scratch, "no-such-stryker") },
		});
		expectHeld(r);
		expect(r.stderr).toContain("Stryker did not finish");
		expect(r.stderr).toContain("and commit again");
		expectRuleAppended(r);
	});
});

describe("mutation-hold-gate.js — the disable comment (#1909)", () => {
	/** SEED with `comment` added above line 2, the fee guard. */
	const disableAbove = (comment: string) =>
		write(
			MONEY,
			SEED.replace("  if (amount > 100)", `  ${comment}\n  if (amount > 100)`),
		);

	it.each([
		"// Stryker disable next-line all",
		"// Stryker disable next-line ConditionalExpression:",
		"// Stryker disable next-line all:   ",
		"/* Stryker disable next-line all: */",
		"// Stryker disable StringLiteral,ObjectLiteral",
		"/* Stryker disable next-line all */ const x = a ? b : c;",
		"/* Stryker disable all */ const t = { a: 1 };",
	])("refuses an added %j, naming its line, and runs nothing", (comment) => {
		disableAbove(comment);
		const r = commit([MONEY]);
		expectHeld(r);
		expect(r.stderr).toContain("stating no reason");
		expect(r.stderr).toContain("Say after a colon why");
		const printed = /^(\/\/.*|\/\*.*?\*\/)/.exec(comment)?.[1].trim();
		expect(r.stderr).toContain(`  lib/money.js:2  ${printed}`);
		expectRuleAppended(r);
		expect(runs()).toEqual([]);
	});

	it.each([
		[
			"a directive on its own line inside a block comment",
			"/*\nStryker disable next-line all\n*/",
			"/* Stryker disable next-line all */",
			3,
		],
		[
			"a line comment after a string holding //",
			'const u = "https://x"; // Stryker disable all',
			"// Stryker disable all",
			2,
		],
		[
			"a line comment after a string holding /*",
			'const s = "/*"; // Stryker disable next-line all',
			"// Stryker disable next-line all",
			2,
		],
	])(
		"refuses %s, as Babel's parser reads it (#2366)",
		(_, comment, printed, line) => {
			disableAbove(comment);
			const r = commit([MONEY]);
			expectHeld(r);
			expect(r.stderr).toContain(`  lib/money.js:${line}  ${printed}\n`);
			expect(runs()).toEqual([]);
		},
	);

	it.each([
		"/* Stryker disable next-line all: an unreachable guard */ // Stryker disable all",
		"/* Stryker disable all */ // Stryker disable next-line all: an unreachable guard",
	])(
		"refuses a line where any directive is unreasoned, naming it once: %j",
		(comment) => {
			disableAbove(comment);
			const r = commit([MONEY]);
			expectHeld(r);
			expect(r.stderr).toContain("stating no reason");
			expect(r.stderr.match(/ {2}lib\/money\.js:2 {2}/g)).toHaveLength(1);
		},
	);

	it.each([
		["lib/Widget.vue", 'setup lang="ts"', "const n: number = 1;"],
		["lib/Widget.vue", 'lang="tsx"', "const n = <b>{1 as number}</b>;"],
		["lib/page.html", 'type="text/typescript"', "const n: number = 1;"],
		["lib/Widget.svelte", 'lang="ts"', "const n: number = 1;"],
	])(
		"refuses an unreasoned directive in %s's <script %s> block, on its own line",
		(widget, attrs, code) => {
			write(
				widget,
				`<template>\n  <p>{{ "// Stryker disable all" }}</p>\n</template>\n<script ${attrs}>\n${code}\n// Stryker disable next-line all\nexport const m = n > 0;\n</script>\n`,
			);
			git("add", widget);
			const r = commit([widget]);
			expectHeld(r);
			expect(r.stderr).toContain(
				`  ${widget}:6  // Stryker disable next-line all\n`,
			);
			expect(r.stderr).not.toContain(`${widget}:2`);
			expect(r.stderr).not.toContain("could not read");
		},
	);

	it.each(['src="./a.js"', 'type="text/x-template"'])(
		"reads no <script %s> block, which Stryker does not parse",
		(attrs) => {
			const widget = "lib/Widget.vue";
			write(
				widget,
				`<script ${attrs}>\n// Stryker disable next-line all\nconst n: number = 1;\n</script>\n`,
			);
			git("add", widget);
			report([]);
			const r = commit([widget]);
			expect(r.status).toBe(0);
			expect(r.stderr).not.toContain("stating no reason");
			expect(r.stderr).not.toContain("could not read");
		},
	);

	it("charges no directive already in a block comment the commit adds a line to below its directive", () => {
		write(
			MONEY,
			SEED.replace(
				"  if (amount > 100)",
				"  /*\nStryker disable next-line all\n  */\n  if (amount > 100)",
			),
		);
		git("add", MONEY);
		git("commit", "-qm", "an old unreasoned comment, landed unheld");
		write(
			MONEY,
			fs
				.readFileSync(path.join(repo, MONEY), "utf8")
				.replace("  */", "  a note\n  */"),
		);
		report([]);
		const before = commitCount();
		const r = commit([MONEY]);
		expect(r.stderr).not.toContain("stating no reason");
		expect(r.status).toBe(0);
		expect(commitCount()).toBe(before + 1);
	});

	it("refuses an old note the commit arms as a directive by editing the comment's opening line, naming its line (#2573)", () => {
		write(
			MONEY,
			SEED.replace(
				"  if (amount > 100)",
				"  /* note\nStryker disable all\n  */\n  if (amount > 100)",
			),
		);
		git("add", MONEY);
		git("commit", "-qm", "a note, no directive, landed unheld");
		write(
			MONEY,
			fs
				.readFileSync(path.join(repo, MONEY), "utf8")
				.replace("  /* note", "  /*"),
		);
		const r = commit([MONEY]);
		expect(r.status).toBe(1);
		expect(commitCount()).toBe(2);
		expect(r.stderr).toContain("  lib/money.js:3  /* Stryker disable all */\n");
		expect(runs()).toEqual([]);
	});

	it("refuses an old directive the commit arms by editing its enclosing block comment's delimiters, naming its line (#2624)", () => {
		write(
			MONEY,
			SEED.replace(
				"  if (amount > 100)",
				"  /* outer\n  // Stryker disable all\n  */\n  if (amount > 100)",
			),
		);
		git("add", MONEY);
		git(
			"commit",
			"-qm",
			"commented-out code holding a directive, landed unheld",
		);
		write(
			MONEY,
			fs
				.readFileSync(path.join(repo, MONEY), "utf8")
				.replace("  /* outer", "  // outer")
				.replace("  */", "  // end"),
		);
		const r = commit([MONEY]);
		expect(r.status).toBe(1);
		expect(commitCount()).toBe(2);
		expect(r.stderr).toContain("  lib/money.js:3  // Stryker disable all\n");
		expect(runs()).toEqual([]);
	});

	it("refuses an old note the commit arms by deleting a line inside its comment, where it adds a line to the file, naming its line (#2624)", () => {
		write(
			MONEY,
			SEED.replace(
				"  if (amount > 100)",
				"  /*\n  a note\nStryker disable all\n  */\n  if (amount > 100)",
			),
		);
		git("add", MONEY);
		git("commit", "-qm", "a note, no directive, landed unheld");
		write(
			MONEY,
			fs
				.readFileSync(path.join(repo, MONEY), "utf8")
				.replace("  a note\n", "")
				.replace("amount * 0.2", "amount * 0.25"),
		);
		const r = commit([MONEY]);
		expect(r.status).toBe(1);
		expect(commitCount()).toBe(2);
		expect(r.stderr).toContain("  lib/money.js:3  /* Stryker disable all */\n");
		expect(runs()).toEqual([]);
	});

	it.each([
		["babel.config.json", "#2573", '{ "plugins": ["./flow-syntax.js"] }\n'],
		[
			"babel.config.mjs",
			"top-level await, #2624",
			'await Promise.resolve();\nexport default { plugins: ["./flow-syntax.js"] };\n',
		],
	])(
		"refuses an unreasoned disable in a Flow file the host's %s parses, naming its line, not reporting it unread (%s)",
		(config, _, text) => {
			write(
				"flow-syntax.js",
				'module.exports = () => ({ manipulateOptions: (_, p) => p.plugins.push("flow") });\n',
			);
			write(config, text);
			git("add", "flow-syntax.js", config);
			git("commit", "-qm", "a host Babel config for Flow, landed unheld");
			write(
				MONEY,
				SEED.replace(
					"  if (amount > 100)",
					"  const n: number = 1;\n  // Stryker disable next-line all\n  if (amount > 100)",
				),
			);
			const r = commit([MONEY]);
			expect(r.status).toBe(1);
			expect(commitCount()).toBe(2);
			expect(r.stderr).not.toContain("could not read");
			expect(r.stderr).toContain(
				"  lib/money.js:3  // Stryker disable next-line all\n",
			);
			expect(runs()).toEqual([]);
		},
	);

	it("refuses an unreasoned disable in a file the host's Babel config parses only under its mutator.plugins, naming its line, not reporting it unread (#2624)", () => {
		write(
			"legacy-decorators.js",
			'module.exports = () => ({ manipulateOptions: (_, p) => p.plugins.push("decorators-legacy") });\n',
		);
		write("babel.config.json", '{ "plugins": ["./legacy-decorators.js"] }\n');
		write(
			"stryker.config.json",
			JSON.stringify({ testRunner: "vitest", mutator: { plugins: [] } }),
		);
		landHostConfig();
		disableAbove("// Stryker disable next-line all");
		const r = commit([MONEY]);
		expect(r.status).toBe(1);
		expect(commitCount()).toBe(2);
		expect(r.stderr).not.toContain("could not read");
		expect(r.stderr).toContain(
			"  lib/money.js:2  // Stryker disable next-line all\n",
		);
		expect(runs()).toEqual([]);
	});

	it("reads the disable comments only once the tools are installed, so a missing Stryker refuses first", () => {
		fs.rmSync(path.join(repo, "node_modules", "@stryker-mutator"), {
			recursive: true,
		});
		disableAbove("// Stryker disable next-line all");
		const r = commit([MONEY]);
		expectHeld(r);
		expect(r.stderr).toContain(INSTALL);
		expect(r.stderr).not.toContain("stating no reason");
	});

	it.each([
		[
			"no instrumenter to load the parser beside",
			() =>
				fs.rmSync(
					path.join(repo, "node_modules/@stryker-mutator/instrumenter"),
					{
						recursive: true,
					},
				),
		],
		[
			"a file the parser will not read",
			() =>
				write(MONEY, `${fs.readFileSync(path.join(repo, MONEY), "utf8")}}}}\n`),
		],
	])(
		"leaves the file to Stryker, named and logged, where it has %s",
		(_, breakIt) => {
			disableAbove("// Stryker disable next-line all");
			breakIt();
			report([]);
			const r = commit([MONEY]);
			expect(r.status).toBe(0);
			expect(r.stderr).toContain(
				"could not read the added disable comments in lib/money.js: ",
			);
			expect(r.stderr).toContain("so Stryker alone judges them");
			expect(runs()).toHaveLength(1);
			expect(logged()).toContain("a commit's disable comments went unchecked");
		},
	);

	it.each([
		"// Stryker disable next-line ConditionalExpression: the 100 tier is unreachable from checkout",
		"/* Stryker disable next-line all: an unreachable guard */",
	])("passes the same comment with a reason: %j", (comment) => {
		disableAbove(comment);
		report([{ line: 3, status: "Ignored" }]);
		expectLanded(commit([MONEY]));
		expect(runs()[0].config).toMatchObject({ mutate: ["lib/money.js:2-2"] });
	});

	it.each([
		"//   Stryker disable next-line all",
		"/**\n   * Stryker disable next-line all\n   */",
		'const u = "// Stryker disable all";',
	])("refuses no comment Stryker reads as no directive: %j", (comment) => {
		disableAbove(comment);
		report([]);
		expectLanded(commit([MONEY]));
	});

	it("honours a reasoned region disable over a message table, judging the mutants Stryker ignores inside it", () => {
		write(
			MONEY,
			`${SEED}// Stryker disable StringLiteral,ObjectLiteral: display text only\nexport const MESSAGES = {\n  over: "Over the limit",\n  under: "Under the limit",\n};\n// Stryker restore StringLiteral,ObjectLiteral\n`,
		);
		report([
			{ line: 9, status: "Ignored", mutatorName: "ObjectLiteral" },
			{ line: 10, status: "Ignored", mutatorName: "StringLiteral" },
			{ line: 11, status: "Ignored", mutatorName: "StringLiteral" },
		]);
		const r = commit([MONEY]);
		expectLanded(r);
		expect(r.stderr).not.toContain("stating no reason");
		expect(runs()[0].config).toMatchObject({ mutate: ["lib/money.js:8-13"] });
	});

	const landOldDirective = (seed = SEED) => {
		write(
			MONEY,
			`// fees\n// in pence\n${seed.replace(
				"  if (amount > 100)",
				"  // Stryker disable next-line all\n  // spare\n  if (amount > 100)",
			)}`,
		);
		git("add", MONEY);
		git("commit", "-qm", "an old unreasoned comment, landed unheld");
	};
	const changeTax = (t: string) => t.replace("amount * 0.2", "amount * 0.25");

	it.each([
		["adding a line below it", changeTax],
		["adding a line above it, moving it down", (t: string) => `// rates\n${t}`],
		[
			"deleting a line above it, moving it up",
			(t: string) => changeTax(t.replace("// in pence\n", "")),
		],
		[
			"replacing a line above it with two",
			(t: string) => t.replace("// in pence\n", "// in\n// pence\n"),
		],
		[
			"deleting the line just below it",
			(t: string) => changeTax(t.replace("  // spare\n", "")),
		],
	])("charges no disable comment the commit did not add, %s", (_, edit) => {
		landOldDirective();
		write(MONEY, edit(fs.readFileSync(path.join(repo, MONEY), "utf8")));
		report([]);
		const r = commit([MONEY]);
		expect(r.stderr).not.toContain("stating no reason");
		expect(r.status).toBe(0);
		expect(commitCount()).toBe(3);
	});

	it("charges no old directive in a file HEAD's copy of will not parse, saying so (#2624)", () => {
		landOldDirective(`${SEED}}}}\n`);
		write(
			MONEY,
			changeTax(fs.readFileSync(path.join(repo, MONEY), "utf8")).replace(
				"}}}\n",
				"",
			),
		);
		report([]);
		const r = commit([MONEY]);
		expect(r.stderr).toContain("could not read lib/money.js at HEAD");
		expect(r.stderr).not.toContain("stating no reason");
		expect(r.status).toBe(0);
		expect(commitCount()).toBe(3);
	});

	it("ships no mutator exclusion with the core, and passes the host's own as written", () => {
		changeLine2();
		report([]);
		expectLanded(commit([MONEY]));
		expect(runs()[0].config).not.toHaveProperty("mutator");
		write(
			"stryker.config.json",
			JSON.stringify({
				testRunner: "vitest",
				mutator: { excludedMutations: ["Regex"] },
			}),
		);
		landHostConfig();
		write(MONEY, SEED.replace("amount * 0.2", "amount * 0.25"));
		const r = commit([MONEY]);
		expect(r.status).toBe(0);
		expect(runs()[1].config).toMatchObject({
			mutator: { excludedMutations: ["Regex"] },
		});
	});
});

describe("mutation-hold-gate.js — a missing tool (#1911)", () => {
	it.each([
		[["@stryker-mutator/core"], "@stryker-mutator/core is not installed"],
		[
			["@stryker-mutator/vitest-runner"],
			"@stryker-mutator/vitest-runner is not installed",
		],
		[
			["@stryker-mutator/core", "@stryker-mutator/vitest-runner"],
			"@stryker-mutator/core and @stryker-mutator/vitest-runner are not installed",
		],
	])(
		"refuses with the install line where %j is absent, running nothing",
		(absent, says) => {
			for (const n of absent)
				fs.rmSync(path.join(repo, "node_modules", n), { recursive: true });
			changeLine2();
			const r = commit([MONEY]);
			expectHeld(r);
			expect(r.stderr).toContain(says);
			expect(r.stderr).toContain(INSTALL);
			expectRuleAppended(r);
			expect(runs()).toEqual([]);
		},
	);

	it("refuses a host with no vitest, saying only vitest is supported", () => {
		fs.rmSync(path.join(repo, "node_modules", "vitest"), { recursive: true });
		changeLine2();
		const r = commit([MONEY]);
		expectHeld(r);
		expect(r.stderr).toContain("supports only the vitest test runner");
		expect(r.stderr).toContain('switch "mutation" off');
		expect(r.stderr).not.toContain(INSTALL);
		expectRuleAppended(r);
		expect(runs()).toEqual([]);
	});

	it("names every missing tool in one refusal", () => {
		fs.rmSync(path.join(repo, "node_modules"), { recursive: true });
		changeLine2();
		const r = commit([MONEY]);
		expectHeld(r);
		expect(r.stderr).toContain(INSTALL);
		expect(r.stderr).toContain("supports only the vitest test runner");
		expect(r.stderr.split(RULE.trim())).toHaveLength(2);
	});

	it.each([
		["app/page.js", "an undeclared path"],
		["lib/rates.json", "a declared path Stryker cannot mutate"],
	])("asks for no tool on a commit to %s, %s", (file) => {
		fs.rmSync(path.join(repo, "node_modules"), { recursive: true });
		write(file, '{"new":1}\n');
		expectLanded(commit([file]));
	});
});

describe("mutation-hold-gate.js — what the run is given", () => {
	it("passes one line range per changed hunk, and the options the hold controls", () => {
		write(
			MONEY,
			SEED.replace("amount > 100", "amount >= 100").replace(
				"  return amount * 0.2;\n}",
				"  const rate = 0.2;\n  return amount * rate;\n}",
			),
		);
		report([]);
		expectLanded(commit([MONEY]));
		const [run] = runs();
		expect(run.argv[0]).toBe("run");
		expect(run.config).toMatchObject({
			mutate: ["lib/money.js:2-2", "lib/money.js:6-7"],
			testRunner: "vitest",
			coverageAnalysis: "perTest",
			reporters: ["json"],
			concurrency: 2,
			incremental: true,
			thresholds: { high: 0, low: 0, break: null },
		});
		const config = run.config as {
			incrementalFile: string;
			jsonReporter: { fileName: string };
		};
		expect(path.isAbsolute(config.incrementalFile)).toBe(true);
		expect(path.isAbsolute(config.jsonReporter.fileName)).toBe(true);
	});

	it.each([
		["stryker.conf.json", "stryker.config.mjs"],
		["stryker.config.mjs", ".stryker.conf.json"],
		[".stryker.config.cjs", ""],
	])(
		"uses the host's %s over %s, overriding only what the hold controls, and never writes it",
		(own, beaten) => {
			const options = {
				testRunner: "vitest",
				coverageAnalysis: "all",
				vitest: { configFile: "vitest.mutation.ts" },
				mutate: ["lib/**"],
				concurrency: 8,
				reporters: ["html", "dashboard"],
				thresholds: { high: 90, low: 80, break: 75 },
			};
			const body = JSON.stringify(options);
			const text = {
				json: body,
				cjs: `module.exports = ${body};\n`,
				mjs: `export default ${body};\n`,
			}[own.split(".").pop() as "json" | "cjs" | "mjs"];
			write(own, text);
			if (beaten)
				write(beaten, 'export default { coverageAnalysis: "off" };\n');
			landHostConfig();
			changeLine2();
			report([]);
			const before = commitCount();
			const r = commit([MONEY]);
			expect(r.status).toBe(0);
			expect(commitCount()).toBe(before + 1);
			const [run] = runs();
			expect(run.config).toMatchObject({
				testRunner: "vitest",
				coverageAnalysis: "all",
				vitest: { configFile: "vitest.mutation.ts" },
				mutate: ["lib/money.js:2-2"],
				concurrency: 2,
				reporters: ["json"],
				incremental: true,
				thresholds: { high: 0, low: 0, break: null },
			});
			expect(fs.readFileSync(path.join(repo, own), "utf8")).toBe(text);
			expect(git("status", "--porcelain")).toBe("");
		},
	);

	it("reads no host config the commit's tree lacks", () => {
		write("stryker.config.json", JSON.stringify({ coverageAnalysis: "off" }));
		changeLine2();
		report([]);
		expectLanded(commit([MONEY]));
		expect(runs()[0].config).toMatchObject({ coverageAnalysis: "perTest" });
	});

	it.each([
		[
			"stryker.config.mjs",
			"export const x = 1;\n",
			"exports no options object",
		],
		["stryker.config.json", "{nope", "stryker.config.json:"],
	])(
		"fails open on a host %s that will not read, with one stderr line",
		(own, text, detail) => {
			write(own, text);
			landHostConfig();
			changeLine2();
			const r = commit([MONEY]);
			expect(r.status).toBe(0);
			const lines = r.stderr
				.split("\n")
				.filter((l) => l.includes("NOT checked"));
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain("could not read the host's Stryker config");
			expect(lines[0]).toContain(detail);
		},
	);

	it("runs over HEAD plus the commit's changes in a throwaway worktree, never the shared tree", () => {
		changeLine2();
		git("add", MONEY);
		write(
			MONEY,
			`${fs.readFileSync(path.join(repo, MONEY), "utf8")}// unsaved\n`,
		);
		report([]);
		expect(commit([]).status).toBe(0);
		const [run] = runs();
		expect(run.cwd).not.toBe(fs.realpathSync(repo));
		expect(run.money).toBe(SEED.replace("amount > 100", "amount >= 100"));
	});
});

describe("mutation-hold-gate.js — the shared cache", () => {
	const cache = () => path.join(repo, ".git", "wfc-mutation-incremental.json");
	const leftovers = () =>
		fs
			.readdirSync(path.join(repo, ".git"))
			.filter((f) => f.startsWith("wfc-mutation-incremental.json."));

	it("runs cold with no cache, and leaves one for the next run", () => {
		changeLine2();
		report([]);
		expectLanded(commit([MONEY]));
		expect(runs()[0].seeded).toBeNull();
		expect(JSON.parse(fs.readFileSync(cache(), "utf8"))).toHaveProperty("by");
	});

	it("seeds the run from the cache and renames the run's back, on a refusal too", () => {
		fs.writeFileSync(cache(), '{"old":true}');
		fs.writeFileSync(path.join(stubDir, "incremental.json"), '{"new":true}');
		changeLine2();
		report([{ line: 2, status: "Survived" }]);
		expectHeld(commit([MONEY]));
		expect(runs()[0].seeded).toBe('{"old":true}');
		expect(fs.readFileSync(cache(), "utf8")).toBe('{"new":true}');
		expect(leftovers()).toEqual([]);
	});

	it("leaves the cache untouched where the run left its copy as seeded, as a red initial run does", () => {
		fs.writeFileSync(cache(), '{"old":true}');
		const before = fs.statSync(cache()).ino;
		fs.writeFileSync(path.join(stubDir, "red"), "");
		changeLine2();
		expectHeld(commit([MONEY]));
		expect(fs.statSync(cache()).ino).toBe(before);
	});

	it("shares one cache with a linked worktree", () => {
		fs.writeFileSync(cache(), '{"old":true}');
		fs.writeFileSync(path.join(stubDir, "incremental.json"), '{"new":true}');
		const linked = linkedTree("side");
		report([]);
		expect(commit([MONEY], { cwd: linked }).status).toBe(0);
		expect(runs()[0].seeded).toBe('{"old":true}');
		expect(fs.readFileSync(cache(), "utf8")).toBe('{"new":true}');
	});

	it("keeps the cache where the run's own will not parse", () => {
		fs.writeFileSync(cache(), '{"old":true}');
		fs.writeFileSync(path.join(stubDir, "incremental.json"), '{"half');
		changeLine2();
		report([]);
		const r = commit([MONEY]);
		expectLanded(r);
		expect(r.stderr).toContain("kept its cache");
		expect(fs.readFileSync(cache(), "utf8")).toBe('{"old":true}');
		expect(leftovers()).toEqual([]);
	});

	it("leaves one whole cache, the last writer's, when two runs write it at once", async () => {
		fs.writeFileSync(path.join(stubDir, "pair"), "");
		report([]);
		const trees = ["a", "b"].map(linkedTree);
		const codes = await Promise.all(
			trees.map(
				(cwd) =>
					new Promise<number | null>((resolve) => {
						// Async, not commit()'s spawnSync: the two must run at once.
						const child = spawn("git", commitArgs([MONEY]), {
							cwd,
							env: env(),
							stdio: "ignore",
						});
						child.on("close", resolve);
					}),
			),
		);
		expect(codes).toEqual([0, 0]);
		expect(
			fs.readdirSync(stubDir).filter((f) => f.startsWith("met-")),
		).toHaveLength(2);
		const left = JSON.parse(fs.readFileSync(cache(), "utf8"));
		expect([1 << 20, 8]).toContain(left.pad.length);
		expect(leftovers()).toEqual([]);
	});
});

describe("mutation-hold-gate.js — what runs nothing", () => {
	it("runs nothing and requires no tool with the module off", () => {
		switchModuleOff();
		changeLine2();
		report([{ line: 2, status: "Survived" }]);
		fs.rmSync(path.join(repo, "node_modules"), { recursive: true });
		const r = commit([MONEY], { extra: { WFC_MODULES: undefined } });
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
		expect(runs()).toEqual([]);
	});

	it.each([
		[
			"a staged config that will not read",
			() => {
				write(CONFIG, "{nope");
				return [MONEY, CONFIG];
			},
		],
		[
			"a broken staged config naming the module outside its list",
			() => {
				write(CONFIG, '{"sensitivePaths": [{"name": "mutation",}]}');
				return [MONEY, CONFIG];
			},
		],
		[
			"a commit route that will not read",
			() => {
				routeRefuses();
				return [MONEY];
			},
		],
	])(
		"reports no fault of its own with the module off, over %s (#2077)",
		(_, arrange) => {
			switchModuleOff();
			changeLine2();
			report([{ line: 2, status: "Survived" }]);
			const r = commit(arrange(), { extra: { WFC_MODULES: undefined } });
			expect(r.status).toBe(0);
			expect(r.stderr).not.toContain("mutation hold");
			expect(logged()).toBe("");
			expect(runs()).toEqual([]);
		},
	);

	it("fails open loudly where a broken staged config lists the module, off at HEAD (#2077)", () => {
		switchModuleOff();
		changeLine2();
		write(CONFIG, '{"modules": ["mutation"],}');
		const r = commit([MONEY, CONFIG], { extra: { WFC_MODULES: undefined } });
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("could not read .claude/workflow-core.json (");
		expect(r.stderr).toContain("this commit is NOT checked");
	});

	it("holds a commit that switches the module off in the same breath", () => {
		write(".claude/workflow-core.json", JSON.stringify({ sensitivePaths: [] }));
		changeLine2();
		report([{ line: 2, status: "Survived" }]);
		expectHeld(
			commit([MONEY, ".claude/workflow-core.json"], {
				extra: { WFC_MODULES: undefined },
			}),
		);
	});

	it("runs nothing on a path no glob declares", () => {
		write("app/page.js", "new\n");
		expectLanded(commit(["app/page.js"]));
		expect(runs()).toEqual([]);
	});

	it("runs nothing on a deletion-only commit", () => {
		write(MONEY, SEED.replace("  return 0;\n", ""));
		report([{ line: 3, status: "Survived" }]);
		expectLanded(commit([MONEY]));
		expect(runs()).toEqual([]);
	});

	it("runs nothing on a test file or a path Stryker cannot mutate, naming each once (#1911)", () => {
		write("lib/money.test.js", "test\n");
		write("lib/rates.json", '{"a":1}\n');
		git("add", "-N", "lib/money.test.js");
		const r = commit(["lib/money.test.js", "lib/rates.json"]);
		expectLanded(r);
		expect(runs()).toEqual([]);
		expect(r.stderr).toContain("skipped: lib/money.test.js, lib/rates.json.");
		expect(r.stderr.split("skipped:")).toHaveLength(2);
	});
});

describe("mutation-hold-gate.js — which commits are held", () => {
	it("holds a session's commit as it holds the founder's terminal", () => {
		changeLine2();
		report([{ line: 2, status: "Survived" }]);
		expectHeld(commit([MONEY], { extra: { CLAUDE_CODE_SESSION_ID: "s1" } }));
	});

	it("holds a commit in a linked worktree", () => {
		const linked = linkedTree("side");
		report([{ line: 2, status: "Survived" }]);
		const r = commit([MONEY], { cwd: linked });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("(rule:mutation-hold)");
	});

	it.each([
		["a rebase", "rebase-merge/"],
		["a cherry-pick", "CHERRY_PICK_HEAD"],
		["`git am`", "rebase-apply/applying"],
	])("skips a commit made mid-%s, marked by %s", (_, marker) => {
		const at = path.join(repo, ".git", marker);
		if (marker.endsWith("/")) fs.mkdirSync(at);
		else {
			fs.mkdirSync(path.dirname(at), { recursive: true });
			fs.writeFileSync(at, `${git("rev-parse", "HEAD")}\n`);
		}
		changeLine2();
		git("add", MONEY);
		report([{ line: 2, status: "Survived" }]);
		// No pathspec: git refuses a partial commit mid-cherry-pick.
		expectLanded(commit([]));
		expect(runs()).toEqual([]);
	});

	it("skips a merge commit", () => {
		git("checkout", "-q", "-b", "side");
		write("app/page.js", "side\n");
		git("commit", "-qam", "side");
		const side = git("rev-parse", "HEAD");
		git("checkout", "-q", "main");
		// Diverged, or git reduces the side branch to the merge's only parent.
		write("app/other.js", "main\n");
		git("add", "app/other.js");
		git("commit", "-qm", "main moves");
		changeLine2();
		git("add", MONEY);
		report([{ line: 2, status: "Survived" }]);
		fs.writeFileSync(path.join(repo, ".git", "MERGE_HEAD"), `${side}\n`);
		expect(commit([]).status).toBe(0);
		expect(git("rev-list", "--count", "--merges", "HEAD")).toBe("1");
		expect(runs()).toEqual([]);
	});
});

describe("mutation-hold-gate.js — its own faults", () => {
	const faults: [
		string,
		() => { paths: string[]; extra?: Record<string, string> },
		string,
	][] = [
		[
			"a report that will not parse",
			() => {
				fs.writeFileSync(path.join(stubDir, "report.json"), "{not json");
				return { paths: [MONEY] };
			},
			"could not parse Stryker's JSON report",
		],
		[
			"a Stryker exiting 0 with no report",
			() => {
				fs.writeFileSync(path.join(stubDir, "no-report"), "");
				return { paths: [MONEY] };
			},
			"found no Stryker JSON report",
		],
		[
			"a status it cannot classify",
			() => ({ paths: [MONEY] }),
			"could not classify a mutant's status",
		],
		[
			"a survivor located past the end of its source (#2078)",
			() => {
				report([{ line: 2, status: "Survived" }], { source: "one line" });
				return { paths: [MONEY] };
			},
			"could not parse Stryker's JSON report",
		],
		[
			"a survivor located past the end of its line (#2078)",
			() => {
				report([{ line: 2, col: 1, endCol: 500, status: "Survived" }]);
				return { paths: [MONEY] };
			},
			"could not parse Stryker's JSON report",
		],
		[
			"a survivor with no start column (#2250)",
			() => {
				report([{ line: 2, col: null, status: "Survived" }]);
				return { paths: [MONEY] };
			},
			"could not parse Stryker's JSON report",
		],
		[
			"a survivor at column 0 (#2250)",
			() => {
				report([{ line: 2, col: 0, status: "Survived" }]);
				return { paths: [MONEY] };
			},
			"could not parse Stryker's JSON report",
		],
		[
			"a survivor ending at column 0 (#2250)",
			() => {
				report([{ line: 2, endCol: 0, status: "Survived" }]);
				return { paths: [MONEY] };
			},
			"could not parse Stryker's JSON report",
		],
		[
			"a survivor ending where it starts, on one line (#2318)",
			() => {
				report([{ line: 2, col: 10, endCol: 10, status: "Survived" }]);
				return { paths: [MONEY] };
			},
			"could not parse Stryker's JSON report",
		],
		[
			"a survivor ending on a line before its start (#2318)",
			() => {
				report([{ line: 2, endLine: 1, status: "Survived" }]);
				return { paths: [MONEY] };
			},
			"could not parse Stryker's JSON report",
		],
		[
			"a config that will not read",
			() => {
				write(".claude/workflow-core.json", "{nope");
				return { paths: [MONEY, ".claude/workflow-core.json"] };
			},
			"could not read .claude/workflow-core.json",
		],
		[
			"git that will not answer",
			() => ({ paths: [MONEY], extra: gitRefuses() }),
			"could not list the staged paths",
		],
		[
			"a commit route that will not read",
			() => {
				routeRefuses();
				return { paths: [MONEY] };
			},
			"could not read the commit route",
		],
		[
			"no throwaway worktree",
			() => {
				// A file where the worktrees' directory goes.
				write(".claude/worktrees", "");
				return { paths: [MONEY] };
			},
			"could not make a throwaway worktree",
		],
	];
	it("refuses an in-range survivor, naming it, beside an out-of-range Killed mutant with no column (#2318)", () => {
		changeLine2();
		report([
			{ line: 2, status: "Survived" },
			{ line: 6, col: null, status: "Killed" },
		]);
		const r = commit([MONEY]);
		expectHeld(r);
		expect(r.stderr).toContain("lib/money.js:2:7 ");
		expect(r.stderr).not.toContain("NOT checked");
	});

	it.each(faults)(
		"fails open on %s, with one stderr line and a log record",
		(_, arrange, fault) => {
			changeLine2();
			report([{ line: 2, status: "Pending" }]);
			const { paths, extra } = arrange();
			const r = commit(paths, { extra });
			expectLanded(r);
			const lines = r.stderr
				.split("\n")
				.filter((l) => l.includes("NOT checked"));
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain(fault);
			expect(logged()).toContain(
				`${fault} — a commit went unchecked for a surviving mutant`,
			);
		},
	);
});

describe("mutation-hold-gate.js — before the index lock (#1910)", () => {
	const commitPaths = (
		paths: string[],
		extra: Record<string, string | undefined> = {},
	) => {
		git("config", "core.hooksPath", hooks);
		return runInProcess(COMMIT_PATHS, ["-m", "land", "--", ...paths], {
			cwd: repo,
			env: env(extra),
		});
	};
	const stamp = (gate: string) => {
		const r = runInProcess(COMMIT_KEY, ["key", gate], {
			cwd: repo,
			env: env(),
		});
		expect(r.status, r.stderr).toBe(0);
		const at = stampFile(gate, path.join(repo, ".git"), "fixture");
		writeStamp(at, r.stdout.trim());
		return at;
	};
	const logLines = (name: string) => {
		const log = path.join(stubDir, name);
		return fs.existsSync(log)
			? fs.readFileSync(log, "utf8").split("\n").filter(Boolean).length
			: 0;
	};
	/** Declares a commit-gated test, logging each run, and puts the live test gate in the hook. */
	const declareTest = () => {
		fs.writeFileSync(
			path.join(stubDir, "test.sh"),
			`echo run >> "${stubDir}/test.log"\n`,
		);
		write(
			".claude/workflow-core.json",
			JSON.stringify({
				modules: ["mutation"],
				commands: { test: `sh ${stubDir}/test.sh` },
				sensitivePaths: [
					{
						name: "money",
						description: "what a guest pays",
						globs: ["lib/**"],
					},
				],
			}),
		);
		writeHook({ testGate: true });
	};
	const moved = SEED.replace("amount > 100", "amount > 99");
	const inLock =
		"running the mutation hold in the lock — no pre-lock green stands it down";

	it("runs the hold once through commit-paths, before the lock, and the hook stands down on its green", () => {
		changeLine2();
		report([{ line: 2, status: "Killed" }]);
		const r = commitPaths([MONEY]);
		expect(r.status, r.stderr).toBe(0);
		expect(commitCount()).toBe(2);
		expect(runs().map((x) => x.lock)).toEqual([false]);
		expect(r.stderr).toContain("commit-paths: the mutation hold is green");
		expect(r.stderr).not.toContain(inLock);
	});

	it("names a path it cannot mutate once through commit-paths, the hook standing down", () => {
		changeLine2();
		write("lib/rates.json", '{"a":1}\n');
		report([{ line: 2, status: "Killed" }]);
		const r = commitPaths([MONEY, "lib/rates.json"]);
		expect(r.status, r.stderr).toBe(0);
		expect(r.stderr.split("skipped: lib/rates.json.")).toHaveLength(2);
	});

	it("refuses a survivor before the lock with exit 3, nothing written", () => {
		changeLine2();
		report([{ line: 2, status: "Survived" }]);
		const r = commitPaths([MONEY]);
		expect(r.status).toBe(3);
		expect(commitCount()).toBe(1);
		expect(runs().map((x) => x.lock)).toEqual([false]);
		expect(r.stderr).toContain(
			"  lib/money.js:2:7  ConditionalExpression  amount >= 100 → true  Survived",
		);
		expect(r.stderr).toContain(
			"the mutation hold refused this commit before it took the index lock",
		);
		expect(git("diff", "--cached", "--name-only")).toBe("");
	});

	it("reports a lint finding before any mutation run starts", () => {
		changeLine2();
		fs.writeFileSync(path.join(stubDir, "lint-red"), "");
		const r = commitPaths([MONEY]);
		expect(r.status).toBe(3);
		expect(r.stderr).toContain("lint: a finding in lib/money.js");
		expect(r.stderr).toContain("so the mutation hold never started");
		expect(runs()).toEqual([]);
		expect(commitCount()).toBe(1);
	});

	it("runs no early gate on a commit the hold does not judge, the hook running its gates once", () => {
		write("app/page.js", "new\n");
		const r = commitPaths(["app/page.js"]);
		expect(r.status, r.stderr).toBe(0);
		expect(logLines("lint.log")).toBe(1);
		expect(runs()).toEqual([]);
	});

	it("re-runs the hold in the lock where the commit's changes moved while the pre-lock run went", () => {
		changeLine2();
		fs.writeFileSync(path.join(stubDir, "mid"), moved);
		report([{ line: 2, status: "Killed" }]);
		const r = commitPaths([MONEY]);
		expect(r.status, r.stderr).toBe(0);
		expect(r.stderr).toContain(
			"no pre-lock green for the mutation hold — it was green",
		);
		expect(r.stderr).toContain("the commit's own changes moved while it ran");
		expect(runs().map((x) => [x.lock, x.money])).toEqual([
			[false, SEED.replace("amount > 100", "amount >= 100")],
			[true, moved],
		]);
		expect(git("show", `HEAD:${MONEY}`)).toBe(moved.trim());
	});

	it("stands the in-lock hold down on a stamp matching the commit's changes", () => {
		changeLine2();
		git("add", MONEY);
		const r = commit([MONEY], {
			extra: { WFC_MUTATION_STAMP: stamp("mutation") },
		});
		expectLanded(r);
		expect(runs()).toEqual([]);
	});

	it("runs the hold in the lock on a stamp naming other changes, saying so, and in silence where none is named", () => {
		changeLine2();
		git("add", MONEY);
		const at = stamp("mutation");
		write(MONEY, moved);
		report([{ line: 2, status: "Killed" }]);
		const r = commit([MONEY], { extra: { WFC_MUTATION_STAMP: at } });
		expectLanded(r);
		expect(r.stderr).toContain(`${inLock}: changes that do not match.`);
		expect(runs()).toHaveLength(1);

		write(MONEY, SEED);
		const plain = commit([MONEY]);
		expect(plain.status).toBe(0);
		expect(plain.stderr).not.toContain(inLock);
		expect(runs()).toHaveLength(2);
	});

	it("never stands the hold down on the test gate's stamp, nor the test gate on the hold's", () => {
		declareTest();
		changeLine2();
		git("add", MONEY);
		report([{ line: 2, status: "Killed" }]);
		const r = commit([MONEY], {
			extra: {
				WFC_MUTATION_STAMP: stamp("test"),
				WFC_TEST_STAMP: stamp("mutation"),
			},
		});
		expectLanded(r);
		expect(r.stderr).toContain(`${inLock}: changes that do not match.`);
		expect(r.stderr).toContain(
			"in the lock — no pre-lock green stands it down: changes that do not match.",
		);
		expect(runs()).toHaveLength(1);
		expect(logLines("test.log")).toBe(1);
	});

	it("leaves a pre-lock fault to the hook, which fails open in the lock and logs it once", () => {
		changeLine2();
		report([{ line: 2, status: "Pending" }]);
		const r = commitPaths([MONEY]);
		expect(r.status, r.stderr).toBe(0);
		expect(commitCount()).toBe(2);
		expect(r.stderr).toContain(
			"could not classify a mutant's status (lib/money.js:2:7 Pending) before the lock, so the commit's hook judges it in the lock.",
		);
		expect(r.stderr).toContain(
			"no pre-lock green for the mutation hold — it judged nothing before the lock",
		);
		expect(runs().map((x) => x.lock)).toEqual([false, true]);
		expect(
			logged().split("a commit went unchecked for a surviving mutant"),
		).toHaveLength(2);
	});

	it("starts nothing before the lock with the module off, the hook running its gates once", () => {
		changeLine2();
		const r = commitPaths([MONEY], { WFC_MODULES: "" });
		expect(r.status, r.stderr).toBe(0);
		expect(runs()).toEqual([]);
		expect(logLines("lint.log")).toBe(1);
	});

	it("runs the declared test, then the hold, once each before the lock, and the hook stands both down", () => {
		declareTest();
		changeLine2();
		report([{ line: 2, status: "Killed" }]);
		const r = commitPaths([MONEY]);
		expect(r.status, r.stderr).toBe(0);
		expect(logLines("test.log")).toBe(1);
		expect(runs().map((x) => x.lock)).toEqual([false]);
		expect(r.stderr.indexOf(`running 'sh ${stubDir}/test.sh'`)).toBeLessThan(
			r.stderr.indexOf("running the mutation hold before"),
		);
		expect(r.stderr).not.toContain("in the lock —");
	});
});

describe("mutation-hold-gate.js — seeding the cache (#1912)", () => {
	const gateScript = path.join(ROOT, "scripts/mutation-hold-gate.js");
	const cache = () => path.join(repo, ".git", "wfc-mutation-incremental.json");
	const seed = () =>
		runInProcess(gateScript, ["--seed"], { cwd: repo, env: env() });

	beforeEach(() => {
		write("lib/money.test.js", "test\n");
		write(
			".claude/workflow-core.json",
			JSON.stringify({
				modules: [],
				sensitivePaths: [
					{
						name: "money",
						description: "what a guest pays",
						globs: ["lib/**"],
					},
				],
			}),
		);
		git("add", "-A");
		git("commit", "-qm", "test file, module not yet on");
	});

	it("runs Stryker over each whole file HEAD declares and the hold would mutate, before the module is on, and caches the results", () => {
		const commits = commitCount();
		report([{ line: 2, status: "Survived" }]);
		const r = seed();
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("lib/money.test.js, lib/rates.json");
		expect(r.stderr).toContain("cached 1 mutant result(s)");
		expect(runs()).toHaveLength(1);
		expect(runs()[0].config).toMatchObject({
			mutate: [MONEY],
			incremental: true,
			concurrency: 2,
		});
		expect(JSON.parse(fs.readFileSync(cache(), "utf8"))).toHaveProperty("by");
		expect(commitCount()).toBe(commits);
	});

	it("seeds HEAD in a throwaway worktree, never an uncommitted edit, staged or not", () => {
		changeLine2();
		git("add", MONEY);
		expect(seed().status).toBe(0);
		expect(runs()[0].money).toBe(SEED);
		expect(runs()[0].cwd).not.toBe(fs.realpathSync(repo));
	});

	it("seeds nothing, with the install line, where Stryker is missing", () => {
		fs.rmSync(path.join(repo, "node_modules", "@stryker-mutator"), {
			recursive: true,
		});
		const r = seed();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			"npm install --save-dev @stryker-mutator/core@10.0.0",
		);
		expect(r.stderr).toContain("nothing was seeded");
		expect(runs()).toEqual([]);
	});

	it("seeds nothing where no declared file is code the hold would mutate", () => {
		git("rm", "-q", MONEY);
		git("commit", "-qm", "no code left");
		const r = seed();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("nothing was seeded");
		expect(runs()).toEqual([]);
	});

	it("seeds nothing on a red initial run, leaving no cache", () => {
		fs.writeFileSync(path.join(stubDir, "red"), "");
		const r = seed();
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("RED at HEAD");
		expect(r.stderr).toContain("seed again");
		expect(r.stderr).not.toContain("commit again");
		expect(fs.existsSync(cache())).toBe(false);
	});

	it("speaks as seed, never the hook, where its cache will not read or write back (#2250)", () => {
		// A directory where the cache goes: unreadable, and no rename lands on it.
		fs.mkdirSync(cache());
		report([{ line: 2, status: "Survived" }]);
		const r = seed();
		expect(r.stderr).toContain(
			"seed: the mutation hold could not read its cache",
		);
		expect(r.stderr).toContain("seed: the mutation hold kept its cache");
		expect(r.stderr).not.toContain("pre-commit:");
	});

	it("prints a fault of no gate's own as 'failed', so nothing was seeded (#2250)", () => {
		// A spy, as no fixture or stub reaches a plain error inside seed's run:
		// every fault its own reads raise is a HoldFaultError.
		const tool = path.join("@stryker-mutator", "core");
		const real = fs.existsSync;
		const spy = vi.spyOn(fs, "existsSync").mockImplementation((p) => {
			if (String(p).includes(tool)) throw new TypeError("planted");
			return real(p);
		});
		try {
			const r = seed();
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(
				"seed: the mutation hold failed (planted), so nothing was seeded.",
			);
		} finally {
			spy.mockRestore();
		}
	});

	it("refuses --seed beside another mode", () => {
		const r = runInProcess(gateScript, ["--seed", "--due"], {
			cwd: repo,
			env: env(),
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("--due and --seed are one or the other");
	});
});
