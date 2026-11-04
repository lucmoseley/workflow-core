// @vitest-environment node
/*
 * guard-registry-atomicity in a session's own worktree (#4242): with
 * CLAUDE_PROJECT_DIR on the main checkout and the session in a linked
 * worktree, a commit landing a new checker is judged on the worktree's files,
 * never the main checkout's. Real git, built by `splitCheckout()`, inside an
 * arbiter sandbox.
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

/** A new unwired checker, written untracked in `root`. */
const newChecker = (root: string) => {
	fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
	fs.writeFileSync(path.join(root, "scripts", "check-new.js"), "// new\n");
};

/** The core's verdict on committing it by commit-paths.js, run from the worktree. */
const verdict = () =>
	runCore(
		"guard-registry-atomicity",
		toolCall("Bash", {
			command: 'node scripts/commit-paths.js -m "x" -- scripts/check-new.js',
		}),
		{ root: at.main, worktree: at.worktree },
	).output;

describe("a commit from a worktree is judged on the worktree's files (#4242)", () => {
	it("refuses the unwired checker the worktree holds", () => {
		newChecker(at.worktree);
		const out = verdict();
		expect(out?.permissionDecision).toBe("deny");
		expect(out?.permissionDecisionReason).toContain("scripts/check-new.js");
	});

	it("refuses nothing where only the main checkout holds it", () => {
		newChecker(at.main);
		expect(verdict()?.permissionDecision).toBeUndefined();
	});
});
