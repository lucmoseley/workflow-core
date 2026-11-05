// @vitest-environment node
/*
 * The dispatcher's contract 5 over the whole entry (#2733, #4127): one tool
 * call starts one git per distinct argument list, whichever core, host or
 * library under them asks. A host spawning its own git past lib/git.js's memo
 * repeats an argv here. Its writes are lib/git-read-memo.test.ts's.
 *
 * full-sweep-only: the source scan reads every dispatched module through the
 * manifest, so no one host's change selects it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeFaultyGit } from "./git-fault-fake";
import { initGitRepo, mkScratchDir } from "./git-fixture";
import { requireClosure } from "./require-closure";
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
	/* A second commit and a pushed base, so the test core's selection reads a
	 * range, and an untracked file, so the commit core lists what git tracks. */
	fs.writeFileSync(path.join(repo, "b.md"), "b\n");
	git("add", "b.md");
	git("commit", "-qm", "second");
	git("update-ref", "refs/remotes/origin/main", "HEAD~1");
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

/**
 * The entry's stdout on `tool_input`, and each git it started, spelled with the
 * directory it ran in: the same argv in two directories asks two questions.
 */
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
	/* Each pattern is the core's own answer, so a replay that misshaped a read
	 * shows as a lost verdict. The test launch's answer rests on free memory. */
	it.each([
		["git commit -m x -- d.md", /git does not track yet:\\n\\n {2}d\.md/],
		["npm run test", /"hookEventName":"PreToolUse"/],
		["git push", /PUSH WHEN/],
		["git pull", /"permissionDecision":"deny".*git pull --ff-only/],
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

/* lander.js's is a commit, which no memo owes a repeat of. git.js's own spawns
 * are the seam, and git.test.ts refuses a spawn naming the binary anywhere. */
const SPAWNS_GIT_ITSELF = ["scripts/lib/git.js", "scripts/lib/lander.js"];

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
