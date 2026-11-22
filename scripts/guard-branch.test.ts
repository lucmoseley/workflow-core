// @vitest-environment node

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

const CORE = "guard-branch";

const { readRuleText } = require("./lib/rule-text") as {
	readRuleText: (id: string) => string;
};

let dir: string;
let config: string;
let shared: string;
let worktree: string;
let elsewhere: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

const template = defineTemplate(trioTemplate());

const MOVED = "moves the shared working tree off its branch";

const emission = (
	command: string,
	{
		cwd = shared,
		session = "test",
		env = {},
	}: { cwd?: string; session?: string; env?: NodeJS.ProcessEnv } = {},
) =>
	dispatchCoreOutput(CORE, buildBashPayload(command, session), {
		project: shared,
		config,
		cwd,
		env,
	});

beforeEach(() => {
	dir = mkScratchDir("guard-branch-");
	config = path.join(dir, "claude-config");
	shared = path.join(dir, "shared");
	worktree = path.join(dir, "wt");
	elsewhere = path.join(dir, "elsewhere");
	template.instantiate(dir);
	git(shared, "config", "branch.main.merge", "refs/heads/landing");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the guard, end to end", () => {
	it("refuses a branch move as JSON on exit 0, carrying the whole rule (mantahostels#87)", () => {
		const out = emission("git checkout -b manual-sync-2026-08-03");
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			`${MOVED}: git checkout -b manual-sync-2026-08-03`,
		);
		expect(out.permissionDecisionReason).toContain(
			readRuleText("branch-shared-tree"),
		);
		expect(out.additionalContext).toBeUndefined();
	});

	it("resolves a leading cd against the real tree, from another repo's cwd", () => {
		expect(
			emission(`cd ${shared} && git checkout -b foo`, { cwd: elsewhere })
				.permissionDecision,
		).toBe("deny");
	});

	it("leaves a linked worktree and an unrelated repository alone", () => {
		expect(emission("git checkout -b another", { cwd: worktree })).toBeNull();
		expect(emission(`git -C ${elsewhere} checkout -b foo`)).toBeNull();
		expect(fs.existsSync(failOpenLogPath(config, shared))).toBe(false);
	});

	it("passes a file restore naming a real file, and refuses a name that is also a real branch", () => {
		fs.mkdirSync(path.join(shared, "docs"));
		fs.writeFileSync(path.join(shared, "docs", "x.md"), "x\n");
		git(shared, "add", "docs/x.md");
		git(shared, "commit", "-qm", "docs");
		expect(emission("git checkout docs")).toBeNull();
		git(shared, "tag", "docs");
		expect(emission("git checkout docs")).toBeNull();
		git(shared, "branch", "docs");
		expect(emission("git checkout docs").permissionDecision).toBe("deny");
	});

	it("hands the rule before the sanctioned recipe, once a session, and again to a new session (mantahostels#1647)", () => {
		const first = emission("git worktree add -b s1 /tmp/w1 main", {
			session: "sess-A",
		});
		expect(first.permissionDecision).toBeUndefined();
		expect(first.additionalContext).toContain(
			readRuleText("branch-shared-tree"),
		);
		expect(
			emission("git worktree add -b s2 /tmp/w2 main", { session: "sess-A" }),
		).toBeNull();
		expect(
			emission("git worktree add -b s3 /tmp/w3 main", { session: "sess-B" }),
		).not.toBeNull();
	});

	it("hands the origin/landing upstream line with the shared-tree rule (#2409)", () => {
		const out = emission("git checkout main");
		expect(out.additionalContext).toContain(readRuleText("branch-shared-tree"));
		expect(out.additionalContext).toContain("origin/landing");
	});

	it("passes the whole sanctioned recipe in silence, logging nothing (mantahostels#208)", () => {
		const fresh = path.join(dir, "recipe-wt");
		const out = emission(
			`WT=${fresh} && git worktree add --detach "$WT" main && git -C "$WT" checkout -b side3`,
		);
		expect(out.permissionDecision).toBeUndefined();
		expect(fs.existsSync(failOpenLogPath(config, shared))).toBe(false);
	});

	it("is silent on a command that is no branch move", () => {
		expect(emission("git status")).toBeNull();
	});
});

describe("a refusal whose rule it cannot read still refuses (mantahostels#1648)", () => {
	it("refuses with an empty store, names the fragment's file, and records no fail-open", () => {
		const store = fs.mkdtempSync(path.join(dir, "store-"));
		const out = emission("git checkout -b foo", {
			env: { WFC_RULES_DIR: store },
		});
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"docs/agents/rules/branch-shared-tree.txt",
		);
		expect(fs.existsSync(failOpenLogPath(config, shared))).toBe(false);
	});
});

describe("the fail-open record", () => {
	const run = (
		payload: Record<string, unknown>,
		project = shared,
		env: NodeJS.ProcessEnv = {},
	) => runDispatchCore(CORE, payload, { project, config, cwd: project, env });

	it("records a checkout whose working tree cannot be resolved, allowing", () => {
		expect(emission("cd $TARGET && git checkout -b foo")).toBeNull();
		expect(readFailOpenLog(config, shared)).toMatch(
			/could not resolve the working tree for a git checkout/,
		);
	});

	it("records a repo git cannot answer for at all, allowing every command", () => {
		const notARepo = path.join(dir, "not-a-repo");
		fs.mkdirSync(notARepo, { recursive: true });
		const r = run(buildBashPayload("git checkout -b foo", "test"), notARepo, {
			GIT_CEILING_DIRECTORIES: dir,
		});
		expect([r.status, r.stdout, r.stderr]).toEqual([0, "", ""]);
		expect(readFailOpenLog(config, notARepo).split("\t")[2]).toMatch(
			/^git could not resolve a git dir/,
		);
	});
});

describe("the copied fixture is isolated from its template (mantahostels#2085)", () => {
	const freshCopy = () => {
		const fresh = mkScratchDir("guard-branch-fresh-");
		try {
			template.instantiate(fresh);
		} catch (err) {
			fs.rmSync(fresh, { recursive: true, force: true });
			throw err;
		}
		return fresh;
	};

	it("the copy's core.hooksPath is relinked, not left pointing at the template", () => {
		const fresh = freshCopy();
		try {
			for (const repo of ["shared", "elsewhere"]) {
				const hooksPath = git(
					path.join(fresh, repo),
					"config",
					"core.hooksPath",
				).trim();
				expect(hooksPath).toBe(path.join(fresh, "no-hooks"));
				expect(fs.existsSync(hooksPath)).toBe(true);
				expect(fs.readdirSync(hooksPath)).toEqual([]);
			}
		} finally {
			fs.rmSync(fresh, { recursive: true, force: true });
		}
	});

	it("a commit made in the copied worktree leaves the template untouched", () => {
		fs.writeFileSync(path.join(worktree, "c.md"), "c\n");
		git(worktree, "add", "c.md");
		git(worktree, "commit", "-qm", "worktree copy only", "--", "c.md");
		expect(git(worktree, "log", "--oneline")).toContain("worktree copy only");

		const fresh = freshCopy();
		try {
			expect(git(path.join(fresh, "wt"), "log", "--oneline")).not.toContain(
				"worktree copy only",
			);
		} finally {
			fs.rmSync(fresh, { recursive: true, force: true });
		}
	});
});
