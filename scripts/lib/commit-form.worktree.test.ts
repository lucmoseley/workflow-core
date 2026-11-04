// @vitest-environment node
/*
 * guard-commit-form in a session's own worktree (#4242): with
 * CLAUDE_PROJECT_DIR on the main checkout and the session in a linked
 * worktree, a pathspec commit's untracked-path warn reads the worktree's
 * files, never the main checkout's. Real git, built by `splitCheckout()`,
 * inside an arbiter sandbox so the core's ledger reads stay out of the real
 * one.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox, store, storeAt } from "./arbiter-testkit";
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

/*
 * The host's own stores, read at the main checkout from the worktree (#4274):
 * the rule a closing-keyword refusal states, read from the host's rule layer,
 * and the write ledger a bare commit to the shared tree is judged against,
 * the arbiter's on the host. The ledger is the arbiter store's, keyed by the
 * process's CLAUDE_PROJECT_DIR, which runCore's env does not reach, so the
 * process's is set to the checkout whose store is seeded.
 */
describe("a commit from a worktree reads the host's stores at the main checkout (#4274)", () => {
	const hostRule = "The host's own closing-keyword rule (#4274).";

	const fragmentIn = (root: string) => {
		const dir = path.join(root, "docs", "agents", "rules");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "commit-closes-keyword.txt"), hostRule);
	};

	/* The suite pins every rule read to the core's layer (vitest.setup.ts);
	 * unpinned, a read takes the host's layer first. */
	const refusal = () => {
		delete process.env.WFC_RULES_DIR;
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

	/** What the core says to a bare commit to the main checkout's index. */
	const bareToShared = () => {
		fs.writeFileSync(path.join(at.main, "b.md"), "b\n");
		execFileSync("git", ["add", "b.md"], { cwd: at.main });
		storeAt(at.main);
		const out = runCore(
			"guard-commit-form",
			toolCall("Bash", { command: `git -C ${at.main} commit -m "x"` }),
			{ root: at.main, worktree: at.worktree },
		).output;
		return String(out?.additionalContext ?? "");
	};

	const wroteIn = (root: string, file: string) => {
		storeAt(root);
		store.recordWrite(path.join(root, file), "s1");
	};

	it("credits a staged path the host's write ledger records this session writing", () => {
		wroteIn(at.main, "b.md");
		expect(bareToShared()).not.toContain("never wrote");
	});

	it("warns of it where only the worktree's ledger records the write", () => {
		wroteIn(at.worktree, "b.md");
		expect(bareToShared()).toContain("never wrote");
	});
});
