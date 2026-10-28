// @vitest-environment node
/*
 * The guard-pull-form core of guard-dispatch.js refuses a non-fast-forward
 * reconciliation of the shared `main` (mantahostels#245), a rewind of `main`
 * (#765) and a discard of the shared tree's uncommitted work (#768), and hands
 * the pull rule to a sanctioned reconciliation instead. These are its boundary
 * cases, the dispatcher entry run on it alone: each exit path, each input
 * channel, and each production read crossed once against a real repo. Which
 * command earns which verdict and text is lib/pull-form.test.ts's (#2797);
 * the entry's payload faults and the throw policy are guard-dispatch's own
 * tests' (#3226).
 *
 * The guard compares the target tree against CLAUDE_PROJECT_DIR's, so a
 * throwaway repo stands in for the shared tree and a worktree of it for the
 * exempt case.
 *
 * It runs as a core of the `PreToolUse` dispatcher on a git command: loosen it and a merge, rebase, rewind or discard in the
 * shared tree can wipe a neighbour's commits or uncommitted edits; break it
 * and every git command is refused.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath, readFailOpenLog } from "./guard-log-fixture";
import { defineTemplate, mkScratchDir, trioTemplate } from "./lib/git-fixture";
import {
	buildBashPayload,
	dispatchCoreOutput,
	runDispatchCore,
} from "./lib/pretool-guard-testkit";

const CORE = "guard-pull-form";

let dir: string;
let config: string;
let shared: string;
let worktree: string;
let elsewhere: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

/*
 * Built once and copied, not rebuilt per test, via scripts/lib/git-fixture.ts
 * (mantahostels#2068) — its own header explains what a naive copy breaks and why.
 */
const template = defineTemplate(trioTemplate());

interface Spawn {
	cwd?: string;
	session?: string | null;
	env?: Record<string, string | undefined>;
}

/** Runs the guard on `command`, as Claude Code would. */
const runGuard = (
	command: string,
	{ cwd = shared, session = "test", env = {} }: Spawn = {},
) =>
	runDispatchCore(CORE, buildBashPayload(command, session), {
		project: shared,
		config,
		cwd,
		env,
	});

/** The whole hook output for `command`, parsed. Null where it said nothing. */
const emission = (
	command: string,
	{ cwd = shared, session = "test", env = {} }: Spawn = {},
) =>
	dispatchCoreOutput(CORE, buildBashPayload(command, session), {
		project: shared,
		config,
		cwd,
		env,
	});

const verdict = (command: string, at: Spawn = {}) =>
	emission(command, at)?.permissionDecision === "deny" ? "deny" : "allow";

/** The refusal `command` earns, as the session reads it. Throws on an allow. */
const readDenyReason = (command: string, at: Spawn = {}) => {
	const out = emission(command, at);
	if (out?.permissionDecision !== "deny")
		throw new Error(`expected a deny for: ${command}`);
	return out.permissionDecisionReason as string;
};

const { readRuleText } = require("./lib/rule-text") as {
	readRuleText: (id: string) => string;
};
const readPullRule = () => readRuleText("pull-fast-forward");

/** A rule store with no fragments in it. */
const emptyStore = () => fs.mkdtempSync(path.join(dir, "store-"));

beforeEach(() => {
	dir = mkScratchDir("guard-pull-form-");
	config = path.join(dir, "claude-config");
	shared = path.join(dir, "shared");
	worktree = path.join(dir, "wt");
	elsewhere = path.join(dir, "elsewhere");
	template.instantiate(dir);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("each exit path", () => {
	it("refuses as permissionDecision JSON on exit 0, framing the rule", () => {
		const r = runGuard("git pull --rebase");
		expect(r.status).toBe(0);
		const out = JSON.parse(r.stdout).hookSpecificOutput;
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toBe(
			`This reconciles the shared \`main\` by rewriting or merging, not by fast-forward: git pull --rebase\n\n${readPullRule()}`,
		);
		// The two limbs are exclusive: a refused session gets one copy, not two.
		expect(out.additionalContext).toBeUndefined();
	});

	/* MUTATION ANCHORS for the injected copy — guard-branch.test.ts carries the
	 * rationale. */
	it("hands an allowed --ff-only pull the rule as context, refusing nothing", () => {
		const out = emission("git pull --ff-only");
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain(readPullRule());
		for (const clause of [
			"git pull --ff-only",
			"A MERGE OR A REBASE IN THE SHARED TREE IS REFUSED",
			"git worktree add -b reconcile-",
		])
			expect(out.additionalContext).toContain(clause);
	});

	it("says it once per session, and again for a different session", () => {
		expect(
			emission("git pull --ff-only", { session: "sess-A" }),
		).not.toBeNull();
		expect(emission("git pull --ff-only", { session: "sess-A" })).toBeNull();
		expect(
			emission("git pull --ff-only", { session: "sess-B" }),
		).not.toBeNull();
	});

	it("says nothing about an ordinary command it judged and passed", () => {
		const r = runGuard("git status");
		expect([r.status, r.stdout]).toEqual([0, ""]);
		expect(fs.existsSync(failOpenLogPath(config, shared))).toBe(false);
	});

	it("allows, recorded, in a directory git cannot resolve to a repo at all", () => {
		const notARepo = path.join(dir, "not-a-repo");
		fs.mkdirSync(notARepo);
		const r = runDispatchCore(
			CORE,
			buildBashPayload("git rebase main", "test"),
			{
				project: notARepo,
				config,
				cwd: notARepo,
				// Otherwise git walks up out of the fixture into a real repository.
				env: { GIT_CEILING_DIRECTORIES: dir },
			},
		);
		expect([r.status, r.stdout]).toEqual([0, ""]);
		expect(readFailOpenLog(config, notARepo).split("\t")[2]).toMatch(
			/^git could not resolve a git dir/,
		);
	});
});

describe("each input channel", () => {
	it("says nothing and logs where the payload carries no session", () => {
		// No session id is no latch key, so an injection would repeat every call.
		const r = runGuard("git pull --ff-only", { session: null });
		expect([r.status, r.stdout]).toEqual([0, ""]);
		expect(readFailOpenLog(config, shared)).toMatch(/no session_id in payload/);
	});
});

describe("each production read, crossed once", () => {
	it("reads pull.ff from the target tree's config", () => {
		git(shared, "config", "pull.ff", "only");
		expect(emission("git pull").permissionDecision).toBeUndefined();
		expect(verdict("git pull --rebase")).toBe("deny");
	});

	it("reads clean.requireForce from the target tree's config", () => {
		expect(verdict("git clean -d")).toBe("allow");
		git(shared, "config", "clean.requireForce", "false");
		expect(readDenyReason("git clean -d")).toContain(
			readRuleText("shared-tree-discard"),
		);
	});

	it("asks git whether a reset's word is a commit, and which branch is out", () => {
		fs.writeFileSync(path.join(shared, "b.md"), "b\n");
		git(shared, "add", "b.md");
		git(shared, "commit", "-qm", "second", "--", "b.md");
		expect(readDenyReason("git reset --hard HEAD~1")).toBe(
			`This moves the shared \`main\` to another commit, dropping whatever came after it if that commit is behind — to move \`main\` forward, \`git merge --ff-only <commit>\`: git reset --hard HEAD~1\n\n${readRuleText("main-rewind")}`,
		);
		expect(verdict("git reset a.md")).toBe("allow");
		/* #3177: real git, not the fake, finding no HEAD~5. */
		expect(verdict("git reset --hard HEAD~5")).toBe("deny");
		expect(verdict("git reset --soft main")).toBe("allow");
		expect(verdict("git reset --soft side")).toBe("deny");
	});

	it("asks git whether a checkout's word is a tree", () => {
		expect(verdict("git checkout --force main")).toBe("deny");
		expect(verdict("git checkout -f a.md")).toBe("allow");
	});

	it("reads the tree's top level and prefix for a pathspec", () => {
		fs.mkdirSync(path.join(shared, "sub"));
		expect(verdict("git -C sub restore ..")).toBe("deny");
		expect(verdict("git -C sub restore .")).toBe("allow");
		expect(verdict(`git restore ${shared}`)).toBe("deny");
		expect(verdict(`git restore ${path.join(shared, "sub")}`)).toBe("allow");
	});

	it("classes the tree a command lands in", () => {
		expect(verdict("git pull --rebase", { cwd: worktree })).toBe("allow");
		expect(verdict("git reset --hard", { cwd: worktree })).toBe("allow");
		expect(verdict("git pull --rebase", { cwd: elsewhere })).toBe("allow");
		expect(verdict(`git -C ${shared} pull --rebase`, { cwd: worktree })).toBe(
			"deny",
		);
		expect(
			verdict("git update-ref refs/heads/main HEAD", { cwd: worktree }),
		).toBe("deny");
	});

	it("records a bare pull whose tree it cannot resolve, and hands it the rule", () => {
		const out = emission("cd $TARGET && git pull");
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain(readPullRule());
		expect(readFailOpenLog(config, shared)).toMatch(
			/could not resolve the working tree for a git pull — the reconciliation allowed unchecked/,
		);
	});

	it("reads the landing module, for the rule and the upstream (#2409, #2536)", () => {
		const env = { WFC_MODULES: "landing" };
		const out = emission("git pull --ff-only", { env });
		expect(out.additionalContext).toContain(
			readRuleText("pull-fast-forward-landing"),
		);
		expect(out.additionalContext).not.toContain(readPullRule());
		expect(readDenyReason("git merge origin/landing", { env })).toContain(
			readRuleText("pull-fast-forward-landing"),
		);
		expect(
			readDenyReason('git -C "$W" merge origin/landing', { env }),
		).toContain("`git -C .claude/worktrees/reconcile merge origin/landing`");
		expect(readDenyReason('git -C "$W" merge origin/main')).toContain(
			"`git -C .claude/worktrees/reconcile merge origin/main`",
		);
	});

	it("refuses with the rule's fallback sentence where the store cannot give it (mantahostels#1648)", () => {
		expect(
			readDenyReason("git pull --rebase", {
				env: { WFC_RULES_DIR: emptyStore() },
			}),
		).toContain(
			"Reconcile the shared `main` by fast-forward or not at all; the rule could not be read from",
		);
	});

	it("refuses an injection the store cannot give, naming the rule (mantahostels#1762)", () => {
		const r = runGuard("git pull --ff-only", {
			env: { WFC_RULES_DIR: emptyStore() },
		});
		expect(r.status).toBe(0);
		const out = JSON.parse(r.stdout).hookSpecificOutput;
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toMatch(/^guard-pull-form: /);
		expect(out.permissionDecisionReason).toContain("pull-fast-forward");
	});

	it("the rule id resolves through the session accessor", () => {
		expect(
			execFileSync(path.resolve(__dirname, "lib/rule-text.sh"), [
				"rule:shared-tree-discard",
			]).toString(),
		).toContain(readRuleText("shared-tree-discard"));
	});
});

/*
 * mantahostels#2068. git-fixture.ts's own leak scan already proves no copy
 * still carries the template's path. What is left to assert here is what that
 * scan cannot see: that relink() wrote THIS instance's own path rather than
 * some third, wrong one, and — the BEHAVIOURAL limb — that a write made in the
 * instantiated copy does not reach a second, independent instantiation of the
 * same template.
 */
describe("the copied fixture is isolated from its template (mantahostels#2068)", () => {
	const freshCopy = () => {
		const fresh = mkScratchDir("guard-pull-form-fresh-");
		try {
			template.instantiate(fresh);
		} catch (err) {
			fs.rmSync(fresh, { recursive: true, force: true });
			throw err;
		}
		return fresh;
	};

	it("a commit made in the copied WORKTREE leaves the template untouched", () => {
		// The worktree shares its parent's object store, so a stale gitdir
		// pointer here writes into the template rather than failing loudly.
		fs.writeFileSync(path.join(worktree, "c.md"), "c\n");
		git(worktree, "add", "c.md");
		git(worktree, "commit", "-qm", "worktree copy only", "--", "c.md");
		expect(git(worktree, "log", "--oneline")).toContain("worktree copy only");

		const fresh = freshCopy();
		try {
			expect(
				git(path.join(fresh, "shared"), "log", "--all", "--oneline"),
			).not.toContain("worktree copy only");
		} finally {
			fs.rmSync(fresh, { recursive: true, force: true });
		}
	});

	it("each copy's core.hooksPath is relinked, not left pointing at the template", () => {
		// Reads back the relinked path directly (mantahostels#2193): anchoring
		// on `dir`, this instance's own root, is what tells a relinked path
		// apart from a leaked one. This block sits last in the file so the
		// beforeEach instance is a LATE instantiation (mantahostels#2232); run
		// alone, it becomes the first, and that limb goes unasserted.
		for (const repo of [shared, elsewhere]) {
			const hooksPath = git(repo, "config", "core.hooksPath").trim();
			expect(hooksPath).toBe(path.join(dir, "no-hooks"));
			expect(fs.existsSync(hooksPath)).toBe(true);
			expect(fs.readdirSync(hooksPath)).toEqual([]);
		}
	});
});
