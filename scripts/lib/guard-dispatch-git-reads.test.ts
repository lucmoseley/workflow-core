// @vitest-environment node
// full-sweep-only: #4127

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFaultyGit } from "./git-fault-fake";
import { initGitRepo, mkScratchDir } from "./git-fixture";
import { requireClosure } from "./require-closure-testkit";
import { runInProcess } from "./run-in-process";
import { shellQuote } from "./sh-quote.js";

const { readDispatchedCores } =
	require("./guard-cores.js") as typeof import("./guard-cores.js");

const ROOT = path.resolve(__dirname, "../..");
const ENTRY = path.join(ROOT, "scripts/guard-dispatch.js");

let dir: string;
let repo: string;
let calls: string;
let stub: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(() => {
	dir = mkScratchDir("guard-dispatch-git-reads-");
	repo = path.join(dir, "repo");
	calls = path.join(dir, "calls");
	stub = path.join(dir, "git-log");
	fs.mkdirSync(path.join(dir, "no-hooks"));
	initGitRepo(repo, path.join(dir, "no-hooks"));
	fs.writeFileSync(path.join(repo, "b.md"), "b\n");
	git("add", "b.md");
	git("commit", "-qm", "second");
	git("update-ref", "refs/remotes/origin/main", "HEAD~1");
	fs.writeFileSync(path.join(repo, "c.md"), "c\n");
	fs.writeFileSync(path.join(repo, "e.js"), "e\n");
	git("add", "c.md", "e.js");
	fs.writeFileSync(path.join(repo, "d.md"), "d\n");
	fs.writeFileSync(
		path.join(repo, "package.json"),
		'{"scripts":{"test":"vitest"}}\n',
	);
	stub = writeFaultyGit(
		{ all: true },
		{
			script: `echo "$PWD $*" >>${shellQuote(calls)}\nexec "$REAL_GIT" "$@"`,
		},
		{ under: dir },
	).git;
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function runEntry(tool: string, toolInput: Record<string, unknown>) {
	const r = runInProcess(ENTRY, [], {
		cwd: repo,
		env: {
			PATH: process.env.PATH,
			HOME: dir,
			CLAUDE_PROJECT_DIR: repo,
			CLAUDE_CONFIG_DIR: path.join(dir, "config"),
			WFC_GIT: stub,
		},
		stdin: JSON.stringify({
			hook_event_name: "PreToolUse",
			session_id: "s1",
			cwd: repo,
			tool_name: tool,
			tool_input: toolInput,
		}),
	});
	expect(r.status).toBe(0);
	const spawns = fs.existsSync(calls)
		? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean)
		: [];
	return { stdout: r.stdout, spawns };
}

const repeats = (spawns: string[]) =>
	spawns.filter((call, i) => spawns.indexOf(call) !== i);

describe("one PreToolUse call", () => {
	it.each([
		["git commit -m x -- d.md", /git does not track yet:\\n\\n {2}d\.md/],
		["git commit -m x -- c.md", /BIOME GATE READS ONLY/],
		["npm run test", /"hookEventName":"PreToolUse"/],
		["git push", /PUSH YOUR QUEUE REF/],
		["git pull", /"permissionDecision":"deny".*HEAD or files: git pull/],
		["gh issue close 1", /tracker rules/],
	])("runs no argv twice on `%s`, and still answers", (command, answer) => {
		const { stdout, spawns } = runEntry("Bash", { command });
		expect(stdout).toMatch(answer);
		expect(spawns.length).toBeGreaterThan(0);
		expect(repeats(spawns)).toEqual([]);
	});

	it("runs no argv twice on a Skill call", () => {
		const { spawns } = runEntry("Skill", { skill: "code-review" });
		expect(repeats(spawns)).toEqual([]);
	});
});

const SPAWNS_GIT_ITSELF = ["scripts/lib/git.js"];

describe("what the dispatcher loads", () => {
	const loaded = requireClosure(ROOT, readDispatchedCores());

	it("spawns git only through lib/git.js's memo or an injected execFn", () => {
		const own = loaded.filter((rel) => {
			if (SPAWNS_GIT_ITSELF.includes(rel)) return false;
			const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
			return (
				/\bexecGitAsync\(/.test(text) ||
				/(?<!execFn\(\s*)\bgitBinary\(\)/.test(text)
			);
		});
		expect(own).toEqual([]);
	});

	it("defaults an injected execFn to execProgram, which reaches that memo", () => {
		const raw = loaded.filter((rel) =>
			/\bexecFn = execFileSync\b/.test(
				fs.readFileSync(path.join(ROOT, rel), "utf8"),
			),
		);
		expect(raw).toEqual([]);
	});
});
