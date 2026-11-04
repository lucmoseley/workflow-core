// @vitest-environment node
/*
 * guard-main-checkout-write at the hook input contract (#4248): with
 * CLAUDE_PROJECT_DIR on the main checkout and the session in a linked
 * worktree, a write to the main checkout's tracked tree is refused once it is
 * cut over, naming the worktree; the worktree's own files and gitignored
 * stores stay writable. Driven through runCore on the testkit's split
 * checkout, so the dispatcher's root and tree come from a real worktree pair.
 *
 * Loosen it and a session's edit lands as dirt in the main checkout, which
 * the levelling fast-forward then refuses on.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshSandbox } from "./arbiter-testkit";
import { runCore, splitCheckout, toolCall } from "./guard-core-testkit";

let at: { main: string; worktree: string };

freshSandbox((sb) => {
	at = splitCheckout(path.join(sb.dir, "split"));
	fs.writeFileSync(path.join(at.main, ".gitignore"), ".claude/\n");
});

beforeEach(() => {
	vi.stubEnv("WFC_MODULES", "landing");
});

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, stdio: "pipe" });

const run = (
	name: string,
	tool: string,
	input: Record<string, unknown>,
	from: { worktree?: string; cwd?: string } = { worktree: at.worktree },
) =>
	runCore(name, toolCall(tool, input), { root: at.main, ...from }).output
		?.permissionDecisionReason ?? null;

const refusal = (
	tool: string,
	input: Record<string, unknown>,
	from?: { worktree?: string; cwd?: string },
) => run("guard-main-checkout-write", tool, input, from);

const edit = (file: string) =>
	refusal("Edit", { file_path: file, old_string: "a", new_string: "b" });

describe("a cut-over main checkout refuses writes to its tree (#4248)", () => {
	it("refuses an Edit of a tracked main-checkout file, naming the worktree's copy", () => {
		const reason = edit(path.join(at.main, "a.md"));
		expect(reason).toContain("writes a.md in the main checkout");
		expect(reason).toContain(path.join(at.worktree, "a.md"));
	});

	it("allows the same Edit in the session's worktree", () => {
		expect(edit(path.join(at.worktree, "a.md"))).toBeNull();
	});

	it("refuses a Write of a new file git would not ignore", () => {
		expect(
			refusal("Write", {
				file_path: path.join(at.main, "docs", "new.md"),
				content: "x",
			}),
		).toContain("writes docs/new.md in the main checkout");
	});

	it("allows a Write into a gitignored store under it", () => {
		expect(
			refusal("Write", {
				file_path: path.join(at.main, ".claude", "tmp", "x.json"),
				content: "{}",
			}),
		).toBeNull();
	});

	it("refuses a Bash redirect into a tracked file, and one reached through a cd", () => {
		expect(
			refusal("Bash", { command: `echo x > ${path.join(at.main, "a.md")}` }),
		).toContain("writes a.md");
		expect(
			refusal("Bash", { command: `cd ${at.main} && echo x | tee a.md` }),
		).toContain("writes a.md");
	});

	it("refuses a git write there and allows a read", () => {
		expect(
			refusal("Bash", { command: `git -C ${at.main} commit -m x` }),
		).toContain("writes the main checkout's index, HEAD or files");
		expect(refusal("Bash", { command: `git -C ${at.main} status` })).toBeNull();
		expect(
			refusal("Bash", { command: `git -C ${at.main} stash list` }),
		).toBeNull();
	});

	it("names the cut where the session stands in the main checkout", () => {
		expect(
			refusal(
				"Edit",
				{
					file_path: path.join(at.main, "a.md"),
					old_string: "a",
					new_string: "b",
				},
				{ cwd: at.main },
			),
		).toContain("session-checkout.js cut <session-name>");
	});

	it("leaves the branch move to this core, the pin standing down", () => {
		const command = `git -C ${at.main} checkout -b x`;
		expect(run("guard-branch", "Bash", { command })).toBeNull();
		expect(refusal("Bash", { command })).toContain(
			"writes the main checkout's index, HEAD or files",
		);
	});
});

describe("before the cutover, or with `landing` off, it refuses nothing (#4248)", () => {
	it("allows an Edit of the main checkout while its main tracks landing", () => {
		git(at.main, "config", "branch.main.merge", "refs/heads/landing");
		expect(edit(path.join(at.main, "a.md"))).toBeNull();
	});

	it("allows it with the `landing` module off", () => {
		vi.stubEnv("WFC_MODULES", "");
		expect(edit(path.join(at.main, "a.md"))).toBeNull();
	});
});
