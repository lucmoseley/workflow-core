// @vitest-environment node
/*
 * guard-commit-form in a session's own worktree (#4242): with
 * CLAUDE_PROJECT_DIR on the main checkout and the session in a linked
 * worktree, a pathspec commit's untracked-path warn reads the worktree's
 * files, never the main checkout's.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
