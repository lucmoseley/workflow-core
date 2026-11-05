// @vitest-environment node
/*
 * guard-pull-form in a session's own worktree (#4242): with
 * CLAUDE_PROJECT_DIR on the main checkout and the session in a linked
 * worktree, a reset is judged in the tree the command stands in — the
 * worktree's own ref — not the host's, and the module config is the host's.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import {
	runCore,
	splitCheckout,
	toolCall,
	writeHostConfig,
} from "./guard-core-testkit";

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

/*
 * Which route the unresolved-tree refusal names is the `landing` module as the
 * main checkout's config declares it (#4274, #4229), wherever the session
 * stands.
 */
describe("the landing module is read from the main checkout's config (#4274)", () => {
	const landingOn = (root: string) =>
		writeHostConfig(root, { modules: ["landing"] });

	/* The suite injects its modules over every config (vitest.setup.ts);
	 * uninjected, the config read declares them. */
	const reason = () => {
		delete process.env.WFC_MODULES;
		return String(
			runCore(
				"guard-pull-form",
				toolCall("Bash", { command: 'git -C "$W" merge origin/main' }),
				{ root: at.main, worktree: at.worktree },
			).output?.permissionDecisionReason,
		);
	};

	it("names the worktree land route where the main checkout turns landing on", () => {
		landingOn(at.main);
		expect(reason()).toContain("session-checkout.js land");
	});

	it("names the reconcile recipe where only the worktree's config turns it on", () => {
		landingOn(at.worktree);
		expect(reason()).toContain("reconcile merge origin/main`");
	});
});
