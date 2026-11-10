/*
 * mutation-hold-testkit.ts — the fixture both mutation-hold-gate suites stand
 * on (#1906, #4943): a seeded repo whose pre-commit hook is the live hook's own
 * stamp read, line ending its early gates, test gate and mutation-hold block,
 * with a stub lint gate above that line, against a stub Stryker named by
 * WFC_STRYKER. The report shape is the one #1901 recorded from Stryker 10.0.0.
 *
 * Built once per file and copied per case. Break it and both suites fail at
 * once, or pass blind against a hook that is not the live one.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import { writeFaultyGit } from "./git-fault-fake";
import { defineTemplate, mkScratchDir } from "./git-fixture";
import { readGuardErrorsLog } from "./guard-errors-log";
import {
	CORE_ROOT,
	coreCall,
	cutHookBlock,
	HOOK,
	ROOT,
} from "./precommit-gate-testkit";

export const WIRING = `  ${coreCall("command node", "scripts/mutation-hold-gate.js")} || exit "$?"`;
export const HOLD_BLOCK = cutHookBlock('mh_why=""', "fi");
export const TEST_GATE_OPEN = `if ! lander_batch && declared_cmd ${coreCall("node", "scripts/lib/test-gate.js")} commit`;
export const GATES_END = HOOK.split("\n").find((l) =>
	l.startsWith("# ---- end of the gates"),
);
export const COMMIT_PATHS = path.join(ROOT, "scripts/commit-paths.js");
export const COMMIT_KEY = path.join(ROOT, "scripts/lib/commit-key.js");

const STUB_LINT = `echo lint >> "$STUB_DIR/lint.log"
if [ -f "$STUB_DIR/lint-red" ]; then echo "lint: a finding in lib/money.js"; exit 1; fi`;
export const MONEY = "lib/money.js";
export const SEED = [
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

export let scratch: string;
export let repo: string;
export let hooks: string;
export let stubDir: string;

export const env = (extra: Record<string, string | undefined> = {}) => {
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

export const git = (...args: string[]) => {
	const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: env() });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
};
export const write = (rel: string, text: string, root = repo) => {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), text);
};

/** A commit as commit-paths makes one; with no paths, the index as staged. */
export const commitArgs = (paths: string[]) => [
	"-c",
	`core.hooksPath=${hooks}`,
	"commit",
	"-qm",
	"land",
	...(paths.length > 0 ? ["--", ...paths] : []),
];
export const commit = (
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
export const install = (names: string[], root = repo) => {
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
export const linkedTree = (name: string) => {
	const dir = path.join(scratch, name);
	git("worktree", "add", "-q", "-b", name, dir);
	install(TOOLS, dir);
	write(MONEY, SEED.replace("amount > 100", "amount >= 100"), dir);
	return dir;
};

/** Land a host Stryker config, unheld, as the base the next commit runs on. */
export const landHostConfig = () => {
	git("add", "-A");
	git("commit", "-qm", "host config");
};

/** The fixture's hook, carrying the live test gate where `testGate`, which prints a line on every commit declaring no test. */
export const writeHook = ({ testGate = false } = {}) =>
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

export const commitCount = () => Number(git("rev-list", "--count", "HEAD"));

/** Every fail-open record the gate logged, check-guard-errors.js's input. */
export const readLog = () => readGuardErrorsLog(scratch);

/**
 * sh is faked here, failing one chosen call, as it has no WFC_ variable to
 * name a stub by and the hook calls it itself.
 */
const onPath = (name: string, script: string) =>
	fs.writeFileSync(path.join(scratch, "bin", name), `#!/bin/sh\n${script}`, {
		mode: 0o755,
	});
export const STUB_GIT_REFUSAL =
	'echo "fatal: stub git will not answer" >&2; exit 128';
/** A git call holding `words` in a row fails; every other call runs. */
export const gitRefuses = (
	words = ["diff", "--cached", "--name-only", "--no-renames", "-z"],
) => ({
	WFC_GIT: writeFaultyGit(
		{ words },
		{ script: STUB_GIT_REFUSAL },
		{ under: scratch },
	).git,
});
export const routeRefuses = () =>
	onPath(
		"sh",
		`case "\${4-}" in */commit-route.sh) echo "stub sh: no route" >&2; exit 2 ;; esac\nexec /bin/sh "$@"\n`,
	);
export const CONFIG = ".claude/workflow-core.json";
export const switchModuleOff = () => {
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
export const readRuns = (): Runs[] => {
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
export const report = (
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
export const RULE = fs.readFileSync(
	path.join(ROOT, "docs/agents/rules/mutation-hold.txt"),
	"utf8",
);

/** Every refusal ends on the whole rule and the closing line (#2077). */
export const expectRuleAppended = (r: ReturnType<typeof commit>) => {
	expect(r.stderr).toContain(
		`${RULE.trim()}\n\npre-commit: the mutation hold refused this commit (rule:mutation-hold). Nothing was committed.`,
	);
};

export const INSTALL =
	"npm install --save-dev @stryker-mutator/core@10.0.0 @stryker-mutator/vitest-runner@10.0.0";

export const changeLine2 = () =>
	write(MONEY, SEED.replace("amount > 100", "amount >= 100"));

export const expectLanded = (r: ReturnType<typeof commit>) => {
	expect(r.stderr).not.toContain("refused");
	expect(r.status).toBe(0);
	expect(commitCount()).toBe(2);
};
export const expectHeld = (r: ReturnType<typeof commit>) => {
	expect(r.status).toBe(1);
	expect(commitCount()).toBe(1);
};

/** Points the fixture's paths at the tree under `root`. */
const placeAt = (root: string) => {
	scratch = root;
	repo = path.join(root, "repo");
	hooks = path.join(root, "hooks");
	stubDir = path.join(root, "stub");
};

/* The seeded repo, hook and stub, built once and copied per case. */
const fixture = defineTemplate((root) => {
	placeAt(root);
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

/** Register the beforeEach/afterEach that copy the template per case and remove it. */
export const mutationHoldFixture = () => {
	beforeEach(() => {
		const root = mkScratchDir("mutation-hold-gate-");
		fixture.instantiate(root);
		placeAt(root);
	});
	afterEach(() => {
		fs.rmSync(scratch, { recursive: true, force: true });
	});
};
