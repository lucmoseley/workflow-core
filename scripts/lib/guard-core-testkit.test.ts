// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import { runCore, splitCheckout, toolCall } from "./guard-core-testkit";

let at: { main: string; worktree: string };

freshSandbox((sb) => {
	at = splitCheckout(path.join(sb.dir, "split"));
	execFileSync("git", ["branch", "-q", "side"], { cwd: at.main });
	execFileSync("git", ["config", "branch.main.merge", "refs/heads/landing"], {
		cwd: at.main,
	});
});

const branchVerdict = (opts: { worktree?: string }) =>
	runCore("guard-branch", toolCall("Bash", { command: "git checkout side" }), {
		root: at.main,
		env: opts.worktree ? {} : { CLAUDE_PROJECT_DIR: at.main },
		...opts,
	}).output?.permissionDecision;

const reviewText = (opts: { worktree?: string }) =>
	runCore("inject-review-tier", toolCall("Skill", { skill: "code-review" }), {
		root: at.main,
		env: opts.worktree ? {} : { CLAUDE_PROJECT_DIR: at.main },
		...opts,
	}).output?.additionalContext ?? "";

const declareIn = (tree: string) => {
	fs.mkdirSync(path.join(tree, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(tree, ".claude", "workflow-core.json"),
		JSON.stringify({
			sensitivePaths: [
				{ name: "RLS", description: "who may read what", globs: ["db/**"] },
			],
		}),
	);
};

const stageSensitiveInWorktree = () => {
	const skill = path.join(at.main, ".claude", "skills", "code-review");
	fs.mkdirSync(skill, { recursive: true });
	fs.writeFileSync(
		path.join(skill, "SKILL.md"),
		"---\nname: code-review\n---\n",
	);
	fs.mkdirSync(path.join(at.worktree, "db"));
	fs.writeFileSync(path.join(at.worktree, "db", "a.sql"), "x\n");
	execFileSync("git", ["add", "db/a.sql"], { cwd: at.worktree });
};

describe("splitCheckout", () => {
	it("builds a linked worktree of the main checkout, its HEAD detached", () => {
		const list = execFileSync("git", ["worktree", "list", "--porcelain"], {
			cwd: at.main,
			encoding: "utf8",
		});
		expect(list).toContain(`worktree ${at.main}\n`);
		expect(list).toMatch(new RegExp(`worktree ${at.worktree}\\n.*\\ndetached`));
	});
});

describe("the worktree option", () => {
	it("runs the hook from the linked worktree, where a branch move is allowed", () => {
		expect(branchVerdict({ worktree: at.worktree })).not.toBe("deny");
	});

	it("leaves the main checkout's own run refusing the same move", () => {
		expect(branchVerdict({})).toBe("deny");
	});

	it("hands the payload the worktree as its cwd, so a path staged there escalates the review", () => {
		stageSensitiveInWorktree();
		declareIn(at.worktree);
		expect(reviewText({ worktree: at.worktree })).toContain(
			"Tier owed: escalated.",
		);
	});

	it("reads the declaration in the worktree, so the main checkout's alone escalates nothing", () => {
		stageSensitiveInWorktree();
		declareIn(at.main);
		expect(reviewText({ worktree: at.worktree })).not.toContain(
			"Tier owed: escalated.",
		);
	});

	it("leaves the main checkout's own run blind to that worktree's staged path", () => {
		stageSensitiveInWorktree();
		declareIn(at.main);
		expect(reviewText({})).not.toContain("Tier owed: escalated.");
	});
});
