import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect } from "vitest";
import { renderHookShim } from "./adopter-skeleton.js";
import { writeStamp } from "./commit-key.js";
import { defineTemplate } from "./git-fixture";
import { installHuskyShim } from "./husky-testkit";
import { keptSpawn } from "./kept-spawn.js";
import { registerTempCleanup } from "./precommit-gate-harness";
import {
	CORE_ROOT,
	coreCall,
	cutHookBlock as cut,
	HOOK,
	ROOT,
} from "./precommit-gate-testkit";
import { copyRequireClosure, launchedScripts } from "./require-closure";
import { runInProcess } from "./run-in-process";
import { shellQuote } from "./sh-quote.js";

export const temps = registerTempCleanup();

function readGatesEnd(): string {
	const line = HOOK.split("\n").find((l) => l.startsWith(": end of the gates"));
	if (line === undefined)
		throw new Error("no line ending the pre-lock gates in .husky/pre-commit");
	return line;
}

export const GATES_END = readGatesEnd();

const gitIn =
	(root: string) =>
	(...args: string[]) =>
		execFileSync("git", args, { cwd: root });

const STUB_GATE = `staged="$(git diff --cached --name-only | paste -sd, -)"
lock=0; [ -f .git/index.lock ] && lock=1
echo "lock=$lock staged=$staged" >> stub-gate.log
if [ -f stub-gate-red ]; then echo "gate: a lint finding in $staged"; exit 1; fi`;

const PRECOMMIT = [
	"#!/usr/bin/env sh",
	"set -e",
	cut("tg_stamp=", "unset WFC_TEST_STAMP WFC_MUTATION_STAMP"),
	`. ${CORE_ROOT}scripts/lib/precommit-gate.sh`,
	STUB_GATE,
	GATES_END,
	cut(
		`if ! lander_batch && ! lander_tested && declared_cmd ${coreCall("node", "scripts/lib/test-gate.js")} commit`,
		"fi",
	),
	cut("pc_stamp_dir=", "fi"),
	"if [ -f stub-in-hook.sh ]; then sh stub-in-hook.sh; rm -f stub-in-hook.sh; fi",
	"",
].join("\n");

const LISTED = [
	"scripts/lib/precommit-gate.sh",
	"scripts/lib/workflow-core-config.js",
	"scripts/lib/host-root.js",
	"scripts/lib/caught.js",
	"scripts/lib/write-fd.js",
	"scripts/lib/test-gate.js",
	"scripts/lib/commit-key.js",
	"scripts/lib/isolated-worktree.js",
	"scripts/queue-run.js",
	"scripts/prepare-commit-msg-dispatch.js",
	"scripts/lib/hook-root.sh",
	"scripts/lib/hook-bound.sh",
	"scripts/check-commit-message-closes.js",
	"scripts/lib/rule-text.sh",
	"docs/agents/rules/commit-closes-keyword.txt",
];

const PREPARE_COMMIT_MSG = fs.readFileSync(
	path.join(ROOT, ".husky/prepare-commit-msg"),
	"utf8",
);
const COPIED = [
	...LISTED,
	...launchedScripts(PRECOMMIT),
	...launchedScripts(PREPARE_COMMIT_MSG),
];

const COMMIT_PATHS = path.join(ROOT, "scripts/commit-paths.js");
const COMMIT_KEY = path.join(ROOT, "scripts/lib/commit-key.js");

export const SLOW_S = 0.5;

export const STUB = `#!/bin/sh
r="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
[ -f "$r/stub-slow" ] && sleep ${SLOW_S}
lock=0; [ -f "$r/.git/index.lock" ] && lock=1
staged="$(git diff --cached --name-only | paste -sd, -)"
echo "lock=$lock stamp=\${WFC_TEST_STAMP-unset} staged=$staged" >> "$r/stub.log"
if [ -f "$r/stub-mid.sh" ]; then (RUN_DIR="$(pwd)"; export RUN_DIR; cd "$r" && sh stub-mid.sh); rm -f "$r/stub-mid.sh"; fi
if [ -f "$r/stub-red" ]; then echo "stub: the widget is broken"; exit 1; fi
if [ -f "$r/stub-needs-gen" ] && [ ! -f gen.txt ]; then echo "stub: gen.txt is missing"; exit 1; fi
case ",$staged," in *,a.txt,*) if [ -e stray.txt ] || grep -qs broken b.txt; then echo "stub: b.txt is broken"; exit 1; fi;; esac
`;

export const buildOtherCommit = (rel: string, body: string) => `t="$(mktemp -u)"
p=""
if git rev-parse -q --verify HEAD >/dev/null; then GIT_INDEX_FILE="$t" git read-tree HEAD; p="-p HEAD"; fi
b="$(printf ${shellQuote(body)} | git hash-object -w --stdin)"
GIT_INDEX_FILE="$t" git update-index --add --cacheinfo "100644,$b,${rel}"
tree="$(GIT_INDEX_FILE="$t" git write-tree)"
git update-ref HEAD "$(git commit-tree $p -m other "$tree")"
rm -f "$t"
`;

const PROVEN_STUB = `if [ -n "$WFC_VERDICT_PROBE" ]; then echo " FAIL  $1"; exit 1; fi\n`;
export const PUSH = JSON.stringify({
	commands: { test: "sh stub-proven.sh", testCanary: "stub-proven.sh" },
});

const DEFAULT_CONFIG = JSON.stringify({ commands: { test: "sh stub.sh" } });

const buildRepo = (born: boolean) => (root: string) => {
	const git = gitIn(root);
	git("init", "-q", ".");
	git("config", "user.email", "t@t");
	git("config", "user.name", "t");
	copyRequireClosure(root, ROOT, COPIED);
	fs.mkdirSync(path.join(root, ".husky"), { recursive: true });
	fs.copyFileSync(
		path.join(ROOT, ".husky/prepare-commit-msg"),
		path.join(root, ".husky/prepare-commit-msg"),
	);
	fs.writeFileSync(path.join(root, ".husky/pre-commit"), PRECOMMIT);
	fs.mkdirSync(path.join(root, ".claude"));
	fs.writeFileSync(
		path.join(root, ".claude/workflow-core.json"),
		DEFAULT_CONFIG,
	);
	fs.writeFileSync(path.join(root, "stub.sh"), STUB);
	fs.writeFileSync(path.join(root, "stub-proven.sh"), PROVEN_STUB);
	fs.writeFileSync(
		path.join(root, ".git/info/exclude"),
		"/scripts/\n/docs/\n/.claude/\n/.husky/\n/stub*\n!/stub.sh\n/gen.txt\n",
	);
	if (born) {
		for (const f of ["a.txt", "b.txt"])
			fs.writeFileSync(path.join(root, f), `${f}\n`);
		git("add", "-f", "a.txt", "b.txt", "stub.sh");
		git("commit", "-qm", "base", "--no-verify");
	}
	installHuskyShim(root);
};

const template = defineTemplate({
	born: buildRepo(true),
	unborn: buildRepo(false),
});

export function fixture({
	born = true,
	config = DEFAULT_CONFIG,
	adopter = false,
} = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "precommit-test-stamp-"));
	temps.push(root);
	template.instantiate(root, born ? "born" : "unborn");
	const git = gitIn(root);
	let coreDir: string | null = null;
	if (adopter) {
		coreDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-stamp-core-"));
		temps.push(coreDir);
		copyRequireClosure(coreDir, ROOT, COPIED);
		fs.mkdirSync(path.join(coreDir, ".husky"));
		fs.writeFileSync(path.join(coreDir, ".husky/pre-commit"), PRECOMMIT);
		fs.copyFileSync(
			path.join(ROOT, "scripts/lib/resolve-core.js"),
			path.join(root, "scripts/lib/resolve-core.js"),
		);
		fs.rmSync(path.join(root, "scripts/lib/precommit-gate.sh"));
		fs.writeFileSync(
			path.join(root, ".husky/pre-commit"),
			renderHookShim("pre-commit"),
		);
	}
	if (config !== DEFAULT_CONFIG)
		fs.writeFileSync(path.join(root, ".claude/workflow-core.json"), config);
	const gitDir = path.join(root, ".git");
	const named: string[] = [];
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-stamp-cfg-"));
	temps.push(configDir);
	const readHead = () =>
		spawnSync("git", ["rev-parse", "-q", "--verify", "HEAD"], {
			cwd: root,
			encoding: "utf8",
		}).stdout.trim();
	const readLog = (name: string) => {
		const log = path.join(root, name);
		return fs.existsSync(log)
			? fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
			: [];
	};
	const readRuns = () => readLog("stub.log");
	const readGateRuns = () => readLog("stub-gate.log");

	const env = (stamp?: string): NodeJS.ProcessEnv => {
		const e: NodeJS.ProcessEnv = { ...process.env, GIT_EDITOR: "true" };
		for (const k of [
			"WFC_TEST_STAMP",
			"WFC_MODULES",
			"CLAUDE_PROJECT_DIR",
			"GIT_INDEX_FILE",
		])
			delete e[k];
		if (stamp !== undefined) e.WFC_TEST_STAMP = stamp;
		if (coreDir !== null) e.WORKFLOW_CORE_DIR = coreDir;
		return e;
	};

	const commitPathsEnv = (inherited?: string) => {
		const e = env(inherited);
		delete e.CLAUDE_CODE_SESSION_ID;
		e.CLAUDE_CONFIG_DIR = configDir;
		return e;
	};
	const readLeftInGitDir = () =>
		fs.readdirSync(gitDir).filter((f) => f.startsWith("commit-paths-"));
	const readOtherWorktrees = () =>
		String(git("worktree", "list", "--porcelain"))
			.split("\n")
			.filter((l) => l.startsWith("worktree ") && l !== `worktree ${root}`);
	const commitPathsArgs = (patch?: string) => [
		"-m",
		"m",
		...(patch === undefined ? [] : ["--patch", patch]),
		"--",
		...named,
	];

	return {
		root,
		gitDir,
		readLeftInGitDir,
		stage(rel: string, body: string | null) {
			if (!named.includes(rel)) named.push(rel);
			if (body === null) git("rm", "-q", "--", rel);
			else {
				fs.writeFileSync(path.join(root, rel), body);
				git("add", "-f", "--", rel);
			}
		},
		edit(rel: string, body: string | null) {
			if (!named.includes(rel)) named.push(rel);
			if (body === null) fs.rmSync(path.join(root, rel));
			else fs.writeFileSync(path.join(root, rel), body);
		},
		git,
		stamp(at = path.join(gitDir, "wfc-test-stamp-1"), gate = "test"): string {
			const r = runInProcess(COMMIT_KEY, ["key", gate], {
				cwd: root,
				env: env(),
			});
			expect(r.status, r.stderr).toBe(0);
			writeStamp(at, r.stdout.trim());
			return at;
		},
		standDown(gate: string, stamp: string) {
			return runInProcess(COMMIT_KEY, ["stand-down", gate, stamp], {
				cwd: root,
				env: env(),
			});
		},
		runHook() {
			return spawnSync("sh", [".husky/pre-commit"], {
				cwd: root,
				env: env(),
				encoding: "utf8",
			});
		},
		commit(stamp?: string, ...flags: string[]) {
			const before = readHead();
			const r = spawnSync(
				"git",
				["commit", "-qm", "m", ...flags, "--", ...named],
				{
					cwd: root,
					env: env(stamp),
					encoding: "utf8",
				},
			);
			return {
				code: r.status,
				out: `${r.stdout}${r.stderr}`,
				landed: readHead() !== before,
				runs: readRuns(),
				gateRuns: readGateRuns(),
				otherWorktrees: readOtherWorktrees(),
			};
		},
		commitPaths({
			patch,
			inherited,
			unsetCore = false,
		}: {
			patch?: string;
			inherited?: string;
			unsetCore?: boolean;
		} = {}) {
			const before = readHead();
			const readStaged = () => String(git("ls-files", "--stage"));
			const index = readStaged();
			const e = commitPathsEnv(inherited);
			if (unsetCore) {
				delete e.WORKFLOW_CORE_DIR;
				delete e.WORKFLOW_CORE_CHECKOUT;
			}
			const r = runInProcess(COMMIT_PATHS, commitPathsArgs(patch), {
				cwd: root,
				env: e,
			});
			const projects = path.join(configDir, "projects");
			const [slug] = fs.existsSync(projects) ? fs.readdirSync(projects) : [];
			const log = slug && path.join(projects, slug, "commit-paths.log");
			return {
				code: r.status,
				out: `${r.stdout}${r.stderr}`,
				landed: readHead() !== before,
				indexKept: readStaged() === index,
				runs: readRuns(),
				gateRuns: readGateRuns(),
				leftInGitDir: readLeftInGitDir(),
				otherWorktrees: readOtherWorktrees(),
				outcome:
					log && fs.existsSync(log)
						? fs
								.readFileSync(log, "utf8")
								.trim()
								.split("\n")
								.at(-1)
								?.split("\t")
						: undefined,
			};
		},
		spawnCommitPaths({
			nodeArgs = [],
			patch,
		}: {
			nodeArgs?: string[];
			patch?: string;
		} = {}) {
			const child = keptSpawn("signal").spawn(
				process.execPath,
				[...nodeArgs, COMMIT_PATHS, ...commitPathsArgs(patch)],
				{ cwd: root, env: commitPathsEnv(), detached: true },
			);
			let out = "";
			child.stdout.on("data", (d) => {
				out += d;
			});
			child.stderr.on("data", (d) => {
				out += d;
			});
			const pid = child.pid;
			if (pid === undefined) throw new Error("commit-paths did not start");
			return {
				pid,
				exited: new Promise<{ code: number | null; signal: string | null }>(
					(resolve) =>
						child.on("exit", (code, signal) => resolve({ code, signal })),
				),
				closed: new Promise<string>((resolve) =>
					child.on("close", () => resolve(out)),
				),
			};
		},
	};
}

export const IN_HOOK = "no pre-lock green stands it down";
export const reason = (why: string) => `${IN_HOOK}: ${why}.`;

export const cutPatch = (f: ReturnType<typeof fixture>): string => {
	fs.writeFileSync(path.join(f.root, "a.txt"), "mine\na.txt\ntheirs\n");
	const diff = String(f.git("diff", "HEAD", "-U0", "--", "a.txt"));
	const at = path.join(f.root, "stub-mine.patch");
	fs.writeFileSync(at, diff.slice(0, diff.lastIndexOf("@@ -1,0")));
	return at;
};

export const recordStaged = (f: ReturnType<typeof fixture>) => {
	fs.writeFileSync(
		path.join(f.root, "stub-mid.sh"),
		'git -C "$RUN_DIR" show :a.txt > stub-staged.out; cat "$RUN_DIR/a.txt" >> stub-staged.out\n',
	);
	return () => fs.readFileSync(path.join(f.root, "stub-staged.out"), "utf8");
};
