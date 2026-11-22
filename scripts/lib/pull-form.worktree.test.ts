// @vitest-environment node

import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import { runCore, splitCheckout, toolCall } from "./guard-core-testkit";

let at: { main: string; worktree: string };

freshSandbox((sb) => {
	at = splitCheckout(path.join(sb.dir, "split"));
});

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
