// @vitest-environment node
/*
 * guard-commit-form in a session's own worktree (#4242): with
 * CLAUDE_PROJECT_DIR on the main checkout and the session in a linked
 * worktree, a pathspec commit's untracked-path warn reads the worktree's
 * files, never the main checkout's, an amend reads the worktree's HEAD, and
 * `git commit -a` is denied there as in the main checkout.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import { runCore, splitCheckout, toolCall } from "./guard-core-testkit";

let at: { main: string; worktree: string };

freshSandbox((sb) => {
	at = splitCheckout(path.join(sb.dir, "split"));
});

const UNTRACKED = "names path(s) git does not track yet";

/** What the core says to a pathspec commit of new.md, run from the worktree. */
const said = () => {
	const out = runCore(
		"guard-commit-form",
		toolCall("Bash", { command: 'git commit -m "x" -- new.md' }),
		{ root: at.main, worktree: at.worktree },
	).output;
	return String(out?.additionalContext ?? out?.permissionDecisionReason ?? "");
};

describe("a pathspec commit from a worktree is judged on the worktree's files (#4242)", () => {
	it("warns of a path the worktree holds untracked", () => {
		fs.writeFileSync(path.join(at.worktree, "new.md"), "new\n");
		expect(said()).toContain(UNTRACKED);
	});

	it("says nothing of it where only the main checkout holds it", () => {
		fs.writeFileSync(path.join(at.main, "new.md"), "new\n");
		expect(said()).not.toContain(UNTRACKED);
	});
});

describe("a commit from a worktree reads the host's rule layer at the main checkout (#4274)", () => {
	const hostRule = "The host's own closing-keyword rule (#4274).";

	const fragmentIn = (root: string) => {
		const dir = path.join(root, "docs", "agents", "rules");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "commit-closes-keyword.txt"), hostRule);
	};

	/* The suite pins every rule read to the core's layer (vitest.setup.ts);
	 * unpinned, a read takes the host's layer first. */
	const refusal = () => {
		vi.stubEnv("WFC_RULES_DIR", undefined);
		return (
			runCore(
				"guard-commit-form",
				toolCall("Bash", { command: 'git commit -m "Closes #12" -- a.md' }),
				{ root: at.main, worktree: at.worktree },
			).output?.permissionDecisionReason ?? ""
		);
	};

	it("states the closing-keyword rule the main checkout's rule layer holds", () => {
		fragmentIn(at.main);
		expect(refusal()).toContain(hostRule);
	});

	it("states the core's rule where only the worktree's rule layer holds the host's", () => {
		fragmentIn(at.worktree);
		const reason = refusal();
		expect(reason).toContain("Closes #12");
		expect(reason).not.toContain(hostRule);
	});
});

describe("an amend from a worktree is judged on the worktree's HEAD (#4384)", () => {
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8" });

	/** The core's decision on an amend run from the worktree. */
	const amend = () =>
		runCore(
			"guard-commit-form",
			toolCall("Bash", { command: "git commit --amend --no-edit" }),
			{ root: at.main, worktree: at.worktree },
		).output;

	it("denies it where the worktree's HEAD is on origin/main", () => {
		git(at.main, "update-ref", "refs/remotes/origin/main", "HEAD");
		expect(amend()?.permissionDecisionReason).toContain(
			"as `HEAD` is on `origin/main`",
		);
	});

	it("allows it once the worktree has committed past origin/main", () => {
		git(at.main, "update-ref", "refs/remotes/origin/main", "HEAD");
		fs.writeFileSync(path.join(at.worktree, "a.md"), "unpushed\n");
		git(at.worktree, "commit", "-qm", "unpushed", "--", "a.md");
		expect(amend()?.permissionDecision).toBeUndefined();
	});
});

describe("`git commit -a` from a worktree is denied, its subagents sharing it", () => {
	const Sweeps = "This commit form sweeps in every dirty tracked file";

	/** The core's decision on `command`, run from the worktree. */
	const decision = (command: string) =>
		runCore("guard-commit-form", toolCall("Bash", { command }), {
			root: at.main,
			worktree: at.worktree,
		}).output;

	it.each([
		['git commit -a -m "x"'],
		['git commit -am "x"'],
		['git commit --all -m "x"'],
	])("denies %s", (command) => {
		expect(decision(command)?.permissionDecisionReason).toContain(Sweeps);
	});

	it("allows -i, which commits only the paths it names", () => {
		expect(
			decision('git commit -i -m "x" -- a.md')?.permissionDecision,
		).toBeUndefined();
	});
});
