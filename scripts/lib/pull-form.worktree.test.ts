// @vitest-environment node
/*
 * guard-pull-form in a session's own worktree (#4242): with
 * CLAUDE_PROJECT_DIR on the main checkout and the session in a linked
 * worktree, a reset is judged in the tree the command stands in — the
 * worktree's own ref — not the host's. Real git, built by `splitCheckout()`,
 * inside an arbiter sandbox.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import { runCore, splitCheckout, toolCall } from "./guard-core-testkit";

let at: { main: string; worktree: string };

freshSandbox((sb) => {
	at = splitCheckout(path.join(sb.dir, "split"));
});

/** The verdict on a hard reset; with no `worktree`, run from the main checkout. */
const verdict = (opts: { worktree?: string }) =>
	runCore(
		"guard-pull-form",
		toolCall("Bash", { command: "git reset --hard HEAD~1" }),
		{ root: at.main, ...opts },
	).output?.permissionDecision;

describe("a reset is judged in the tree the session stands in (#4242)", () => {
	it("is allowed from the worktree, whose branch is its own", () => {
		expect(verdict({ worktree: at.worktree })).toBeUndefined();
	});

	it("is refused from the main checkout, the same command", () => {
		expect(verdict({})).toBe("deny");
	});
});
