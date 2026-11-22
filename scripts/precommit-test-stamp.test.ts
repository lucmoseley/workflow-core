// @vitest-environment node

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { renderHookShim } from "./lib/adopter-skeleton.js";
import { ignoreFailure } from "./lib/caught.js";
import { stampFile, stampVariable, writeStamp } from "./lib/commit-key.js";
import { installHuskyShim } from "./lib/husky-testkit";
import { keptSpawn } from "./lib/kept-spawn.js";
import { newRepo, registerTempCleanup } from "./lib/precommit-gate-harness";
import {
	CORE_ROOT,
	coreCall,
	cutHookBlock as cut,
	HOOK,
	ROOT,
} from "./lib/precommit-gate-testkit";
import { copyRequireClosure, launchedScripts } from "./lib/require-closure";
import { runInProcess } from "./lib/run-in-process";
import { shellQuote } from "./lib/sh-quote.js";

const temps = registerTempCleanup();

const GATES_END = HOOK.split("\n").find((l) =>
	l.startsWith(": end of the gates"),
);
if (GATES_END === undefined)
	throw new Error("no line ending the pre-lock gates in .husky/pre-commit");

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

const SLOW_S = 0.5;

const stub = (root: string) => `#!/bin/sh
r=${shellQuote(root)}
[ -f "$r/stub-slow" ] && sleep ${SLOW_S}
lock=0; [ -f "$r/.git/index.lock" ] && lock=1
staged="$(git diff --cached --name-only | paste -sd, -)"
echo "lock=$lock stamp=\${WFC_TEST_STAMP-unset} staged=$staged" >> "$r/stub.log"
if [ -f "$r/stub-mid.sh" ]; then (RUN_DIR="$(pwd)"; export RUN_DIR; cd "$r" && sh stub-mid.sh); rm -f "$r/stub-mid.sh"; fi
if [ -f "$r/stub-red" ]; then echo "stub: the widget is broken"; exit 1; fi
if [ -f "$r/stub-needs-gen" ] && [ ! -f gen.txt ]; then echo "stub: gen.txt is missing"; exit 1; fi
case ",$staged," in *,a.txt,*) if [ -e stray.txt ] || grep -qs broken b.txt; then echo "stub: b.txt is broken"; exit 1; fi;; esac
`;

const buildOtherCommit = (rel: string, body: string) => `t="$(mktemp -u)"
p=""
if git rev-parse -q --verify HEAD >/dev/null; then GIT_INDEX_FILE="$t" git read-tree HEAD; p="-p HEAD"; fi
b="$(printf ${shellQuote(body)} | git hash-object -w --stdin)"
GIT_INDEX_FILE="$t" git update-index --add --cacheinfo "100644,$b,${rel}"
tree="$(GIT_INDEX_FILE="$t" git write-tree)"
git update-ref HEAD "$(git commit-tree $p -m other "$tree")"
rm -f "$t"
`;

const PROVEN_STUB = `if [ -n "$WFC_VERDICT_PROBE" ]; then echo " FAIL  $1"; exit 1; fi\n`;
const PUSH = JSON.stringify({
	commands: { test: "sh stub-proven.sh", testCanary: "stub-proven.sh" },
});

function fixture({
	born = true,
	config = JSON.stringify({ commands: { test: "sh stub.sh" } }),
	adopter = false,
} = {}) {
	const { root, git } = newRepo("precommit-test-stamp-", temps);
	copyRequireClosure(root, ROOT, COPIED);
	fs.mkdirSync(path.join(root, ".husky"), { recursive: true });
	fs.copyFileSync(
		path.join(ROOT, ".husky/prepare-commit-msg"),
		path.join(root, ".husky/prepare-commit-msg"),
	);
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
	} else fs.writeFileSync(path.join(root, ".husky/pre-commit"), PRECOMMIT);
	fs.mkdirSync(path.join(root, ".claude"));
	fs.writeFileSync(path.join(root, ".claude/workflow-core.json"), config);
	fs.writeFileSync(path.join(root, "stub.sh"), stub(root));
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
		fs.rmSync(path.join(root, "stub.log"), { force: true });
	}
	installHuskyShim(root);
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

const IN_HOOK = "no pre-lock green stands it down";
const reason = (why: string) => `${IN_HOOK}: ${why}.`;

it("runs the declared test inside the hook, the lock held, where no stamp is named", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const r = f.commit();
	expect(r.code).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=1 stamp=unset staged=a.txt"]);
	expect(r.out).toContain(reason("no stamp named"));
});

it("exits 2 where the worktree runner crashes before the suite's verdict (#3808)", () => {
	const f = fixture();
	fs.writeFileSync(
		path.join(f.root, "scripts/lib/isolated-worktree.js"),
		"process.exit(7);\n",
	);
	f.stage("a.txt", "changed\n");
	const r = f.runHook();
	expect(r.stderr).toContain(
		"scripts/lib/isolated-worktree.js failed (exit 7) before the suite gave a verdict",
	);
	expect(r.stderr).toContain("commit again once it runs");
	expect(r.status).toBe(2);
});

it("stands the test down on a stamp matching the commit's changes, and the commit lands", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const stamp = f.stamp();
	const r = f.commit(stamp);
	expect(r.code).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual([]);
	expect(fs.existsSync(stamp)).toBe(true);
});

it("runs the test in the lock on a matching stamp outside the hook's git directory, saying so", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "test-stamp-out-"));
	temps.push(outside);
	const r = f.commit(f.stamp(path.join(outside, "stamp")));
	expect(r.code).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=1 stamp=unset staged=a.txt"]);
	expect(r.out).toContain(
		reason("stamp unreadable or outside this checkout's git directory"),
	);
});

it("runs the test in the lock on a matching stamp in a linked worktree's git directory, saying so", () => {
	const f = fixture();
	f.git("worktree", "add", "-q", "--detach", path.join(f.root, ".wt"));
	f.stage("a.txt", "changed\n");
	const sibling = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
		cwd: path.join(f.root, ".wt"),
		encoding: "utf8",
	}).trim();
	const r = f.commit(f.stamp(path.join(sibling, "stamp")));
	expect(r.code).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=1 stamp=unset staged=a.txt"]);
	expect(r.out).toContain(
		reason("stamp unreadable or outside this checkout's git directory"),
	);
});

it("runs the test in the lock on a stamp naming no file, saying so", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const r = f.commit(path.join(f.gitDir, "no-such-stamp"));
	expect(r.code).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=1 stamp=unset staged=a.txt"]);
	expect(r.out).toContain(
		reason("stamp unreadable or outside this checkout's git directory"),
	);
});

it("runs the test in the lock on a stamp whose key does not match, saying so, and keeps the variable from it", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const stamp = f.stamp();
	f.stage("a.txt", "changed again\n");
	const r = f.commit(stamp);
	expect(r.code).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=1 stamp=unset staged=a.txt"]);
	expect(r.out).toContain(reason("changes that do not match"));
});

it("does not match a commit differing from the stamp's only by a deletion", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const stamp = f.stamp();
	f.stage("b.txt", null);
	const r = f.commit(stamp);
	expect(r.code).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=1 stamp=unset staged=a.txt,b.txt"]);
	expect(r.out).toContain(reason("changes that do not match"));
});

it("does not match a commit differing from the stamp's only by a mode change", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const stamp = f.stamp();
	fs.chmodSync(path.join(f.root, "a.txt"), 0o755);
	const r = f.commit(stamp);
	expect(r.code).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=1 stamp=unset staged=a.txt"]);
	expect(r.out).toContain(reason("changes that do not match"));
});

it("runs the test in the lock on another gate's stamp matching the commit's changes (#1904)", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const r = f.commit(
		f.stamp(path.join(f.gitDir, "wfc-1.mutation-stamp"), "mutation"),
	);
	expect(r.code).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=1 stamp=unset staged=a.txt"]);
	expect(r.out).toContain(reason("changes that do not match"));
});

it("lets a second gate write and read a stamp of its own, the test gate's untouched (#1904)", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const run = "wfc-1";
	const testStamp = f.stamp(stampFile("test", f.gitDir, run));
	const testKey = fs.readFileSync(testStamp, "utf8");
	const mutationStamp = f.stamp(
		stampFile("mutation", f.gitDir, run),
		"mutation",
	);
	expect(mutationStamp).not.toBe(testStamp);
	expect(stampVariable("test")).toBe("WFC_TEST_STAMP");
	expect(stampVariable("mutation")).not.toBe(stampVariable("test"));
	expect(f.standDown("mutation", mutationStamp).status).toBe(0);
	expect(f.standDown("test", testStamp).status).toBe(0);
	expect(fs.readFileSync(testStamp, "utf8")).toBe(testKey);
	const crossed = f.standDown("test", mutationStamp);
	expect(crossed.status).toBe(1);
	expect(crossed.stdout).toBe("changes that do not match\n");
});

it("stands down on an unborn branch's first commit with a matching stamp", () => {
	const f = fixture({ born: false });
	f.stage("a.txt", "first\n");
	const r = f.commit(f.stamp());
	expect(r.code).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual([]);
});

it("applies the same rule on the --no-verify route, through prepare-commit-msg", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const stood = f.commit(f.stamp(), "--no-verify");
	expect(stood.landed).toBe(true);
	expect(stood.runs).toEqual([]);

	f.stage("a.txt", "changed again\n");
	const ran = f.commit(undefined, "--no-verify");
	expect(ran.landed).toBe(true);
	expect(ran.runs).toEqual(["lock=1 stamp=unset staged=a.txt"]);
});

it("runs the declared test once through commit-paths, before the lock, on exactly the named paths, and the hook stands down", () => {
	const f = fixture();
	fs.writeFileSync(path.join(f.root, "c.txt"), "theirs\n");
	f.git("add", "-f", "c.txt");
	f.edit("a.txt", "changed\n");
	f.edit("b.txt", "changed too\n");
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt,b.txt"]);
	expect(r.leftInGitDir).toEqual([]);
});

const readGateRunRecord = (root: string) => {
	const file = path.join(root, ".claude/tmp/markers/.gate-runs.jsonl");
	return fs.existsSync(file)
		? fs
				.readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];
};

it("runs the pre-lock and the in-lock test as commit gates, each one gate-run record line naming the tree its commit holds (#5274, #5448)", () => {
	const f = fixture();
	const headTree = () => String(f.git("rev-parse", "HEAD^{tree}")).trim();
	f.edit("a.txt", "changed\n");
	const pre = f.commitPaths();
	expect(pre.code, pre.out).toBe(0);
	expect(pre.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
	const preTree = headTree();
	expect(readGateRunRecord(f.root)).toEqual([
		expect.objectContaining({
			command: "sh stub.sh",
			outcome: "pass",
			tree: preTree,
		}),
	]);
	f.stage("b.txt", "changed too\n");
	const inLock = f.commit();
	expect(inLock.code, inLock.out).toBe(0);
	expect(inLock.runs.at(-1)).toBe("lock=1 stamp=unset staged=b.txt");
	expect(readGateRunRecord(f.root)).toEqual([
		expect.objectContaining({ outcome: "pass", tree: preTree }),
		expect.objectContaining({
			command: "sh stub.sh",
			outcome: "pass",
			tree: headTree(),
		}),
	]);
});

it("runs the pre-lock suite on HEAD plus the named paths alone, so unsaved files outside the commit cannot refuse it, and the hook stands down (#1760)", () => {
	const f = fixture();
	unsavedDirt(f);
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
	expect(r.out).not.toContain(IN_HOOK);
	expect(fs.readFileSync(path.join(f.root, "b.txt"), "utf8")).toBe("broken\n");
	expect(r.otherWorktrees).toEqual([]);
	expect(r.leftInGitDir).toEqual([]);
});

it("runs the pre-lock suite on a named path as on disk, refusing the commit it breaks (#1760)", () => {
	const f = fixture();
	f.edit("a.txt", "changed\n");
	f.edit("b.txt", "broken\n");
	const r = f.commitPaths();
	expect(r.code).toBe(3);
	expect(r.landed).toBe(false);
	expect(r.out).toContain("stub: b.txt is broken");
	expect(r.otherWorktrees).toEqual([]);
});

function needsGen(config: object) {
	const f = fixture({ config: JSON.stringify(config) });
	f.git("add", "-f", ".claude/workflow-core.json");
	f.git("commit", "-qm", "config", "--no-verify");
	fs.rmSync(path.join(f.root, "stub.log"), { force: true });
	fs.writeFileSync(path.join(f.root, "stub-needs-gen"), "");
	fs.writeFileSync(path.join(f.root, "gen.txt"), "generated\n");
	f.edit("a.txt", "changed\n");
	return f;
}

it("links each gitignored path worktreeLinks declares into the pre-lock worktree, skipping one the checkout lacks, so a suite reading it goes green (#1767)", () => {
	const f = needsGen({
		commands: { test: "sh stub.sh" },
		worktreeLinks: ["gen.txt", "absent/none.txt"],
	});
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
	expect(String(f.git("ls-files", "--", "gen.txt")).trim()).toBe("");
	expect(fs.readFileSync(path.join(f.root, "gen.txt"), "utf8")).toBe(
		"generated\n",
	);
	expect(r.otherWorktrees).toEqual([]);
});

it("refuses a pre-lock suite red on an undeclared gitignored file, naming worktreeLinks as the way round (#1767)", () => {
	const f = needsGen({ commands: { test: "sh stub.sh" } });
	const r = f.commitPaths();
	expect(r.code).toBe(3);
	expect(r.landed).toBe(false);
	expect(r.out).toContain("stub: gen.txt is missing");
	expect(r.out).toContain(
		"name it in `worktreeLinks` in .claude/workflow-core.json",
	);
});

it("keeps a stamp variable commit-paths inherited from its caller out of its pre-lock run", () => {
	const f = fixture();
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths({
		inherited: path.join(f.gitDir, "a-caller.test-stamp"),
	});
	expect(r.code, r.out).toBe(0);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
});

it("keeps an inherited stamp out of the commit where the pre-lock run defers to the hook, though it matches what lands", () => {
	const f = fixture();
	f.edit("a.txt", "edited mid-run\n");
	f.git("add", "a.txt");
	const inherited = f.stamp(path.join(f.gitDir, "a-caller.test-stamp"));
	f.git("reset", "-q", "--", "a.txt");
	f.edit("a.txt", "changed\n");
	fs.writeFileSync(
		path.join(f.root, "stub-mid.sh"),
		"printf 'edited mid-run\\n' > a.txt\n",
	);
	const r = f.commitPaths({ inherited });
	expect(r.code, r.out).toBe(0);
	expect(r.runs).toEqual([
		"lock=0 stamp=unset staged=a.txt",
		"lock=1 stamp=unset staged=a.txt",
	]);
});

function unsavedDirt(f: ReturnType<typeof fixture>) {
	fs.writeFileSync(path.join(f.root, "b.txt"), "broken\n");
	fs.writeFileSync(path.join(f.root, "stray.txt"), "theirs\n");
}

it("runs the in-lock suite on HEAD plus the commit's staged paths alone, so unsaved files outside the commit cannot refuse a plain git commit (#1766)", () => {
	const f = fixture();
	unsavedDirt(f);
	f.stage("a.txt", "changed\n");
	const r = f.commit();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=1 stamp=unset staged=a.txt"]);
	expect(fs.readFileSync(path.join(f.root, "b.txt"), "utf8")).toBe("broken\n");
	expect(r.otherWorktrees).toEqual([]);
});

it("refuses an in-lock red on the commit's own paths, blaming no file outside them (#1766)", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	f.stage("b.txt", "broken\n");
	const r = f.commit();
	expect(r.code).toBe(1);
	expect(r.landed).toBe(false);
	expect(r.out).toContain("stub: b.txt is broken");
	expect(r.out).toContain(
		"pre-commit: the declared test command is RED — 'sh stub.sh' — so this commit is refused.",
	);
	expect(r.out).toContain(
		"It ran on HEAD plus this commit's own changes, so no unsaved edit outside them reached it (#1766)",
	);
	expect(r.out).not.toContain("mantahostels#273");
	expect(r.otherWorktrees).toEqual([]);
});

it("runs the in-lock suite in the checkout where no worktree can be made, saying so, and its red names mantahostels#273 (#1766)", () => {
	const f = fixture();
	fs.writeFileSync(path.join(f.root, ".claude/worktrees"), "");
	unsavedDirt(f);
	f.stage("a.txt", "changed\n");
	const r = f.commit();
	expect(r.code).toBe(1);
	expect(r.landed).toBe(false);
	expect(r.out).toContain(
		"no worktree holds this commit's tree alone, so 'sh stub.sh' runs in this checkout.",
	);
	expect(r.out).toContain("stub: b.txt is broken");
	expect(r.out).toContain("mantahostels#273");
});

it("refuses a red pre-lock run with exit 3, the suite's output and the hook's three lines, before the lock and with the index untouched", () => {
	const f = fixture();
	fs.writeFileSync(path.join(f.root, "stub-red"), "");
	f.edit("a.txt", "changed\n");
	f.edit("new.txt", "new\n");
	const r = f.commitPaths();
	expect(r.code).toBe(3);
	expect(r.landed).toBe(false);
	expect(r.indexKept).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt,new.txt"]);
	expect(r.out).toContain("stub: the widget is broken");
	expect(r.out).toContain(
		"the declared test command is RED — 'sh stub.sh' — so this commit is refused.",
	);
	expect(r.out).toContain(
		"It ran on HEAD plus this commit's own paths, so no unsaved edit outside them reached it (#1760)",
	);
	expect(r.out).not.toContain("It ran in this checkout");
	expect(r.out).toContain("Fix the failing test and commit again.");
	expect(r.leftInGitDir).toEqual([]);
	expect(r.otherWorktrees).toEqual([]);
});

it("refuses a red pre-lock gate with exit 3 and its output, starting no suite and writing nothing, the hook's own stamp included (#1763)", () => {
	const f = fixture();
	fs.writeFileSync(path.join(f.root, "stub-gate-red"), "");
	f.edit("a.txt", "changed\n");
	f.edit("new.txt", "new\n");
	const r = f.commitPaths();
	expect(r.code).toBe(3);
	expect(r.landed).toBe(false);
	expect(r.indexKept).toBe(true);
	expect(r.gateRuns).toEqual(["lock=0 staged=a.txt,new.txt"]);
	expect(r.runs).toEqual([]);
	expect(r.out).toContain("gate: a lint finding in a.txt,new.txt");
	expect(r.out).toContain(
		"a pre-commit gate refused this commit (exit 1), so 'sh stub.sh' never started. Nothing written.",
	);
	expect(r.out).not.toContain("before the commit takes the index lock");
	expect(fs.existsSync(path.join(f.gitDir, "wfc-precommit-stamp"))).toBe(false);
	expect(r.leftInGitDir).toEqual([]);
	expect(r.otherWorktrees).toEqual([]);
});

it("runs the gates before the pre-lock suite and again in the lock, where only the test gate stands down (#1763)", () => {
	const f = fixture();
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.gateRuns).toEqual(["lock=0 staged=a.txt", "lock=1 staged=a.txt"]);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
	const gatesAt = r.out.indexOf(
		"running the pre-commit hook's gates but its slow ones, before 'sh stub.sh'",
	);
	expect(gatesAt, r.out).toBeGreaterThan(-1);
	expect(gatesAt).toBeLessThan(
		r.out.indexOf("before the commit takes the index lock"),
	);
	expect(r.out).not.toContain(IN_HOOK);
	expect(r.leftInGitDir).toEqual([]);
});

it.each([
	["gated at push", PUSH],
	["with no test command", JSON.stringify({ commands: {} })],
])(
	"runs the gates in the lock alone where the test is %s (#1763)",
	(_kind, config) => {
		const f = fixture({ config });
		f.edit("a.txt", "changed\n");
		const r = f.commitPaths();
		expect(r.code, r.out).toBe(0);
		expect(r.gateRuns).toEqual(["lock=1 staged=a.txt"]);
		expect(r.out).not.toContain("running the pre-commit hook's gates");
	},
);

it("runs the gates in the lock alone where the hook has no line ending them, saying so, and the suite still runs before the lock (#1763)", () => {
	const f = fixture();
	const hook = path.join(f.root, ".husky/pre-commit");
	fs.writeFileSync(
		hook,
		fs.readFileSync(hook, "utf8").replace(`${GATES_END}\n`, ""),
	);
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.gateRuns).toEqual(["lock=1 staged=a.txt"]);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
	expect(r.out).toContain(
		`no early gate run — ${hook} has no line marking where its gates end, an older hook than this script. The commit's hook runs its gates after 'sh stub.sh', in the lock.`,
	);
});

it("runs the core's gates before the pre-lock suite where the repo's hook is the core's shim, reaching the core as the shim does (#5288)", () => {
	const f = fixture({ adopter: true });
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.gateRuns).toEqual(["lock=0 staged=a.txt", "lock=1 staged=a.txt"]);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
	expect(r.out).toContain(
		"running the pre-commit hook's gates but its slow ones, before 'sh stub.sh'",
	);
	expect(r.out).not.toContain("no early gate run");
});

it("refuses a red gate before the pre-lock suite where the repo's hook is the core's shim (#5288)", () => {
	const f = fixture({ adopter: true });
	fs.writeFileSync(path.join(f.root, "stub-gate-red"), "");
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths();
	expect(r.code).toBe(3);
	expect(r.landed).toBe(false);
	expect(r.gateRuns).toEqual(["lock=0 staged=a.txt"]);
	expect(r.runs).toEqual([]);
});

it("refuses before the pre-lock suite where the repo's hook is the core's shim and no core resolves for it (#5288)", () => {
	const f = fixture({ adopter: true });
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths({ unsetCore: true });
	expect(r.code).toBe(3);
	expect(r.landed).toBe(false);
	expect(r.gateRuns).toEqual([]);
	expect(r.runs).toEqual([]);
	expect(r.out).toContain(
		"this repo's pre-commit hook is workflow-core's shim, and no core resolves for it to run (resolve-core: no workflow-core directory",
	);
	expect(r.out).toContain("'sh stub.sh' never started. Nothing written.");
});

it("runs the gates once, in the lock, on a plain git commit (#1763)", () => {
	const f = fixture();
	f.stage("a.txt", "changed\n");
	const r = f.commit();
	expect(r.code, r.out).toBe(0);
	expect(r.gateRuns).toEqual(["lock=1 staged=a.txt"]);
	expect(r.runs).toEqual(["lock=1 stamp=unset staged=a.txt"]);
});

it("ends the live hook's early gates on one line directly above its test gate, below every other core gate, with no switch to stop there (#1763)", () => {
	const lines = HOOK.replaceAll(CORE_ROOT, "").split("\n");
	expect(lines.filter((l) => l === GATES_END)).toHaveLength(1);
	const end = lines.indexOf(GATES_END);
	const above = lines.slice(0, end).join("\n");
	const below = lines.slice(end + 1);
	for (const gate of [
		"node scripts/check-ruff-introduced.js",
		"node scripts/check-format-staged.js",
	])
		expect(above).toContain(gate);
	expect(below.find((l) => !/^\s*(#|$)/.test(l))).toBe(
		"if ! lander_batch && ! lander_tested && declared_cmd node scripts/lib/test-gate.js commit; then",
	);
	const runners = new Set(
		below.join("\n").match(/\b(?:node|bash|sh) scripts\/\S+/g) ?? [],
	);
	expect([...runners].sort()).toEqual([
		"node scripts/lib/commit-key.js",
		"node scripts/lib/isolated-worktree.js",
		"node scripts/lib/test-gate.js",
		"node scripts/mutation-hold-gate.js",
		"node scripts/queue-run.js",
	]);
	expect(below.join("\n")).toContain("/wfc-precommit-stamp");
	expect(above).not.toContain("wfc-precommit-stamp");
	expect(
		cut(
			`if ! lander_batch && ! lander_tested && declared_cmd ${coreCall("node", "scripts/lib/test-gate.js")} commit`,
			"fi",
		).replaceAll(CORE_ROOT, ""),
	).not.toMatch(/\$\{?[A-Z_]+/);
});

it("runs nothing before the lock where the test is gated at push", () => {
	const f = fixture({
		config: PUSH,
	});
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual([]);
	expect(r.out).not.toContain("before the commit takes the index lock");
});

it("runs nothing before the lock where no test command is declared", () => {
	const f = fixture({ config: JSON.stringify({ commands: {} }) });
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.out).not.toContain("before the commit takes the index lock");
});

it("runs nothing before the lock on an unreadable config, leaving the hook's refusal the only one", () => {
	const f = fixture({ config: "{ not json" });
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths();
	expect(r.code).toBe(3);
	expect(r.landed).toBe(false);
	expect(r.runs).toEqual([]);
	expect(r.out).not.toContain("before the commit takes the index lock");
	expect(r.out.match(/BROKEN/g)).toHaveLength(1);
	expect(r.out).toContain("husky - pre-commit script failed");
});

it.each([
	["gated at push", PUSH, false],
	["with no test command", JSON.stringify({ commands: {} }), false],
	["gated at commit", undefined, true],
] as const)(
	"starts the sweeper on a plain commit %s only where a pre-lock run is due (#1639 story 14)",
	async (_kind, config, swept) => {
		const f = fixture(config === undefined ? {} : { config });
		f.edit("a.txt", "changed\n");
		const preload = path.join(f.root, "stub-spawn.js");
		fs.writeFileSync(
			preload,
			`const cp = require("node:child_process");
const real = cp.spawn;
cp.spawn = (cmd, args, opts) => {
	if (cmd === "sh" && String(args[1]).startsWith("trap")) process.stderr.write("sweeper started\\n");
	return real(cmd, args, opts);
};
`,
		);
		const run = f.spawnCommitPaths({ nodeArgs: ["--require", preload] });
		const out = await run.closed;
		expect(await run.exited, out).toEqual({ code: 0, signal: null });
		expect(out.includes("sweeper started"), out).toBe(swept);
	},
);

it("stands down after a green pre-lock run on a commit naming a new file", () => {
	const f = fixture();
	f.edit("new.txt", "new\n");
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=new.txt"]);
});

it("stands down after a green pre-lock run on a commit naming a deletion", () => {
	const f = fixture();
	f.edit("b.txt", null);
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=b.txt"]);
});

it("stands down after a green pre-lock run on an unborn branch's first commit, which holds the suite it runs", () => {
	const f = fixture({ born: false });
	f.edit("a.txt", "first\n");
	f.edit("stub.sh", stub(f.root));
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt,stub.sh"]);
	expect(r.otherWorktrees).toEqual([]);
});

it("prints the pre-lock run's start and green lines, and logs its seconds", () => {
	const f = fixture();
	fs.writeFileSync(path.join(f.root, "stub-slow"), "");
	f.edit("a.txt", "changed\n");
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.out).toContain(
		"commit-paths: running 'sh stub.sh' before the commit takes the index lock.",
	);
	expect(r.out).toMatch(/commit-paths: 'sh stub\.sh' is green \(\d+\.\ds\)/);
	const [, outcome, preLock] = r.outcome ?? [];
	expect(outcome).toBe("committed");
	expect(Number(preLock)).toBeGreaterThanOrEqual(SLOW_S);
});

it("writes no stamp where a named file is edited while the pre-lock run goes, saying so, and the hook runs the test in the lock", () => {
	const f = fixture();
	f.edit("a.txt", "changed\n");
	fs.writeFileSync(
		path.join(f.root, "stub-mid.sh"),
		"printf 'edited mid-run\\n' > a.txt\n",
	);
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.out).toMatch(
		/commit-paths: no pre-lock green for 'sh stub\.sh' — it was green \(\d+\.\ds\), but the commit's own changes moved while it ran\. The commit's hook runs it in the lock instead\./,
	);
	expect(r.out).toContain(reason("no stamp named"));
	expect(r.runs).toEqual([
		"lock=0 stamp=unset staged=a.txt",
		"lock=1 stamp=unset staged=a.txt",
	]);
	expect(r.leftInGitDir).toEqual([]);
});

it("stands down where another commit to a path this commit does not name lands while the pre-lock run goes", () => {
	const f = fixture();
	f.edit("a.txt", "changed\n");
	fs.writeFileSync(
		path.join(f.root, "stub-mid.sh"),
		buildOtherCommit("c.txt", "theirs\\n"),
	);
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
	expect(String(f.git("log", "-1", "--format=%s", "HEAD~1")).trim()).toBe(
		"other",
	);
	expect(r.leftInGitDir).toEqual([]);
});

it("stands down where another commit gives an unborn branch its first commit, to a path this commit does not name, while the pre-lock run goes", () => {
	const f = fixture({ born: false });
	f.edit("a.txt", "first\n");
	f.edit("stub.sh", stub(f.root));
	fs.writeFileSync(
		path.join(f.root, "stub-mid.sh"),
		buildOtherCommit("c.txt", "theirs\\n"),
	);
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt,stub.sh"]);
	expect(String(f.git("log", "-1", "--format=%s", "HEAD~1")).trim()).toBe(
		"other",
	);
});

it("writes no stamp where another commit to a named path changes what this commit adds, and the hook runs the test in the lock", () => {
	const f = fixture();
	f.edit("a.txt", "changed\n");
	f.edit("b.txt", "changed too\n");
	fs.writeFileSync(
		path.join(f.root, "stub-mid.sh"),
		buildOtherCommit("a.txt", "changed\\n"),
	);
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.out).toContain("but the commit's own changes moved while it ran");
	expect(r.out).toContain(reason("no stamp named"));
	expect(r.runs).toEqual([
		"lock=0 stamp=unset staged=a.txt,b.txt",
		"lock=1 stamp=unset staged=b.txt",
	]);
});

it("stands down where another commit to a named path lands while the pre-lock run goes, leaving what this commit adds unchanged", () => {
	const f = fixture();
	f.edit("a.txt", "changed\n");
	fs.writeFileSync(
		path.join(f.root, "stub-mid.sh"),
		buildOtherCommit("a.txt", "theirs\\n"),
	);
	const r = f.commitPaths();
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
	expect(String(f.git("show", "HEAD:a.txt"))).toBe("changed\n");
	expect(r.leftInGitDir).toEqual([]);
});

const cutPatch = (f: ReturnType<typeof fixture>): string => {
	fs.writeFileSync(path.join(f.root, "a.txt"), "mine\na.txt\ntheirs\n");
	const diff = String(f.git("diff", "HEAD", "-U0", "--", "a.txt"));
	const at = path.join(f.root, "stub-mine.patch");
	fs.writeFileSync(at, diff.slice(0, diff.lastIndexOf("@@ -1,0")));
	return at;
};

const recordStaged = (f: ReturnType<typeof fixture>) => {
	fs.writeFileSync(
		path.join(f.root, "stub-mid.sh"),
		'git -C "$RUN_DIR" show :a.txt > stub-staged.out; cat "$RUN_DIR/a.txt" >> stub-staged.out\n',
	);
	return () => fs.readFileSync(path.join(f.root, "stub-staged.out"), "utf8");
};

it("runs the declared test once under --patch, before the commit, on the patch's private index alone, and the hook stands down", () => {
	const f = fixture();
	const patch = cutPatch(f);
	const readStaged = recordStaged(f);
	const r = f.commitPaths({ patch });
	expect(r.code, r.out).toBe(0);
	expect(r.landed).toBe(true);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
	expect(r.out).not.toContain(IN_HOOK);
	expect(readStaged()).toBe("mine\na.txt\nmine\na.txt\n");
	expect(String(f.git("show", "HEAD:a.txt"))).toBe("mine\na.txt\n");
	expect(r.leftInGitDir).toEqual([]);
});

it("refuses a red pre-lock run under --patch with exit 3, writing neither the commit nor the index", () => {
	const f = fixture();
	const patch = cutPatch(f);
	fs.writeFileSync(path.join(f.root, "stub-red"), "");
	const r = f.commitPaths({ patch });
	expect(r.code).toBe(3);
	expect(r.landed).toBe(false);
	expect(r.indexKept).toBe(true);
	expect(fs.readFileSync(path.join(f.root, "a.txt"), "utf8")).toBe(
		"mine\na.txt\ntheirs\n",
	);
	expect(r.runs).toEqual(["lock=0 stamp=unset staged=a.txt"]);
	expect(r.out).not.toContain(IN_HOOK);
	expect(r.out).toContain(
		"the declared test command is RED — 'sh stub.sh' — so this commit is refused.",
	);
	expect(r.out).toContain("Fix the failing test and commit again.");
	expect(r.leftInGitDir).toEqual([]);
	expect(r.otherWorktrees).toEqual([]);
});

it("refuses a red pre-lock gate under --patch with exit 3, starting no suite and writing neither the commit nor the index (#1763)", () => {
	const f = fixture();
	const patch = cutPatch(f);
	fs.writeFileSync(path.join(f.root, "stub-gate-red"), "");
	const r = f.commitPaths({ patch });
	expect(r.code).toBe(3);
	expect(r.landed).toBe(false);
	expect(r.indexKept).toBe(true);
	expect(fs.readFileSync(path.join(f.root, "a.txt"), "utf8")).toBe(
		"mine\na.txt\ntheirs\n",
	);
	expect(r.gateRuns).toEqual(["lock=0 staged=a.txt"]);
	expect(r.runs).toEqual([]);
	expect(r.out).toContain("gate: a lint finding in a.txt");
	expect(r.leftInGitDir).toEqual([]);
});

function readProcessTree(pid: number): number[] {
	const parentOf = new Map<number, number>();
	for (const d of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name)))
		ignoreFailure(() => {
			const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
			parentOf.set(
				Number(d),
				Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]),
			);
		});
	const tree = [pid];
	for (let i = 0; i < tree.length; i++)
		for (const [child, ppid] of parentOf)
			if (ppid === tree[i]) tree.push(child);
	return tree;
}

function signalIfAlive(pid: number, signal: NodeJS.Signals) {
	try {
		process.kill(pid, signal);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
	}
}

const UNTIL_MS = 5000;
async function until(ok: () => boolean, ms = UNTIL_MS) {
	for (const end = Date.now() + ms; !ok() && Date.now() < end; )
		await new Promise((r) => setTimeout(r, 20));
}

it.each([
	["SIGINT", "group", "the pre-lock suite", "stub-mid.sh"],
	["SIGTERM", "process", "the pre-lock suite", "stub-mid.sh"],
	["SIGINT", "process", "git commit", "stub-in-hook.sh"],
	["SIGTERM", "group", "git commit", "stub-in-hook.sh"],
	["SIGTERM", "process tree", "git commit", "stub-in-hook.sh"],
	["SIGKILL", "group", "git commit", "stub-in-hook.sh"],
] as const)(
	"leaves no file of its own in the git directory where %s reaches its %s during %s, and dies of it (#1680)",
	async (signal, to, _during, hold) => {
		const f = fixture();
		f.edit("a.txt", "changed\n");
		fs.writeFileSync(
			path.join(f.root, hold),
			`touch held\nsleep ${(2 * UNTIL_MS) / 1000}\n`,
		);
		const run = f.spawnCommitPaths();
		try {
			await until(() => fs.existsSync(path.join(f.root, "held")));
			const mine = `commit-paths-${run.pid}`;
			expect(f.readLeftInGitDir()).toEqual(
				hold === "stub-in-hook.sh"
					? [`${mine}.index`, `${mine}.test-stamp`]
					: [`${mine}.index`],
			);
			if (to === "group") process.kill(-run.pid, signal);
			else if (to === "process") process.kill(run.pid, signal);
			else for (const p of readProcessTree(run.pid)) signalIfAlive(p, signal);
			expect(await run.exited).toEqual({ code: null, signal });
			await until(() => f.readLeftInGitDir().length === 0);
			expect(f.readLeftInGitDir()).toEqual([]);
		} finally {
			ignoreFailure(() => process.kill(-run.pid, "SIGKILL"));
		}
	},
);

it.each([
	["a plain commit", false],
	["a --patch commit", true],
] as const)(
	"leaves no file of its own in the git directory where %s throws after writing its stamp (#1680)",
	async (_kind, underPatch) => {
		const f = fixture();
		const patch = underPatch ? cutPatch(f) : undefined;
		if (!underPatch) f.edit("a.txt", "changed\n");
		const preload = path.join(f.root, "stub-throw.js");
		fs.writeFileSync(
			preload,
			`const cp = require("node:child_process");
const fs = require("node:fs");
const real = cp.spawnSync;
let stamp;
cp.spawnSync = (cmd, args, opts) => {
	const r = real(cmd, args, opts);
	stamp = opts?.env?.WFC_TEST_STAMP ?? stamp;
	if (cmd === "git" && (args[0] === "commit" || args[0] === "update-ref")) {
		throw new Error(\`thrown after the commit, its stamp \${stamp && fs.existsSync(stamp) ? "written" : "missing"}\`);
	}
	return r;
};
`,
		);
		const run = f.spawnCommitPaths({ nodeArgs: ["--require", preload], patch });
		const out = await run.closed;
		expect(await run.exited, out).toEqual({ code: 1, signal: null });
		expect(out).toContain("thrown after the commit, its stamp written");
		await until(() => f.readLeftInGitDir().length === 0);
		expect(f.readLeftInGitDir()).toEqual([]);
	},
);
