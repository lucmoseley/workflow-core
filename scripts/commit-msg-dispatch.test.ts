// @vitest-environment node
/*
 * scripts/commit-msg-dispatch.js and lib/commit-msg-rows.js (#5208, spec
 * #5207): the registry's order and route gating, and the boundary set through
 * the real .husky/commit-msg as git fires it — a pass, a refusal ending the
 * run at the first red, and a dispatcher that is missing. The replay
 * stand-down with `.local` still running, `$route` naming the replay, is
 * commit-msg-local-gate.test.ts's; each check's own verdicts are its own
 * file's and lib/commit-msg-checks.contract.test.ts's.
 *
 * Breaking it costs all three message checks at once: the hook's one line
 * runs them all.
 *
 * spawn-kept: the boundary cases commit in a temp repo so git itself fires
 * the real hook, which is the process boundary under test.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROWS } from "./lib/commit-msg-rows.js";
import { installCommitMsgHook } from "./lib/commit-msg-testkit";
import { initGitRepo, mkScratchDir } from "./lib/git-fixture";

const ROOT = path.join(__dirname, "..");

let dir: string;
let hooks: string;
let plugin = ROOT;

beforeEach(() => {
	dir = mkScratchDir("commit-msg-dispatch-");
	hooks = mkScratchDir("commit-msg-dispatch-hooks-");
	initGitRepo(dir, hooks);
	installCommitMsgHook(hooks);
	plugin = ROOT;
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	fs.rmSync(hooks, { recursive: true, force: true });
});

const git = (args: string[]) => {
	const r = spawnSync("git", args, {
		cwd: dir,
		encoding: "utf8",
		env: { ...process.env, CLAUDE_PROJECT_DIR: dir, WFC_PLUGIN_ROOT: plugin },
	});
	return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

let change = 0;
const commit = (message: string) => {
	change += 1;
	fs.writeFileSync(path.join(dir, "a.md"), `a ${change}\n`);
	git(["add", "a.md"]);
	return git(["commit", "-q", "-m", message]);
};
const head = () => git(["rev-parse", "-q", "--verify", "HEAD"]).out.trim();

describe("the registry", () => {
	it("gates on all three checks in the hook's order, the scan and the subject standing down on a replay and the Weakens: check on a merge too", () => {
		expect(
			ROWS.map((r) => [r.id, r.policy, r.when?.unlessRoutes ?? null]),
		).toEqual([
			["closing-keyword", "gate", ["replay"]],
			["subject", "gate", ["replay"]],
			["weakens-line", "gate", ["replay", "merge"]],
		]);
	});
});

describe("the real hook", () => {
	it("lands a clean message, printing the Weakens: check's pass line alone", () => {
		const r = commit("Add a line");
		expect(r).toEqual({ status: 0, out: "OK: no weakened check staged.\n" });
	});

	it("refuses at the first red, the checks after it unrun", () => {
		const before = head();
		const r = commit(`Add ${"x".repeat(80)}\n\nFixes #12\n`);
		expect(r.status).toBe(1);
		expect(r.out).toContain("commit-msg:");
		expect(r.out).toContain("#12");
		expect(r.out).not.toContain("over the 72-character limit");
		expect(head()).toBe(before);
	});

	it("refuses every commit where the dispatcher is missing, naming it", () => {
		plugin = mkScratchDir("commit-msg-dispatch-plugin-");
		fs.mkdirSync(path.join(plugin, "scripts"));
		fs.symlinkSync(
			path.join(ROOT, "scripts", "lib"),
			path.join(plugin, "scripts", "lib"),
		);
		const dispatcher = path.join(plugin, "scripts", "commit-msg-dispatch.js");
		try {
			const before = head();
			const r = commit("Add a line");
			expect(r.status).toBe(1);
			expect(r.out).toBe(
				`commit-msg: ${dispatcher} is missing, so the message checks did not run.\n  Refusing rather than passing the message unread (#138).\n`,
			);
			expect(head()).toBe(before);
		} finally {
			fs.rmSync(plugin, { recursive: true, force: true });
		}
	});
});
