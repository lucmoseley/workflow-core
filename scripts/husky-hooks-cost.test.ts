// @vitest-environment node
/*
 * Pins the binaries each per-commit `.husky` hook starts on one ordinary
 * commit (base §G13, #5338). Every commit of every session runs all four, so
 * a start past what the commit needs is paid on every commit.
 *
 * Program cases (base §X3) through lib/call-cost.js's shell half, in
 * lib/hook-cost-testkit.ts's commit fixture: a session's linked worktree
 * committing one staged plain file. Each case seeds the state git and the
 * hooks before it leave on a real commit — the staged file, pre-commit's
 * stand-down stamp, the message file, the commit itself — and runs its hook
 * with the arguments and GIT_* variables git hands it. It runs past the 10 s
 * budget (base §X8 (5)) because its time is the four hooks' own, run for
 * real: what it pins is what they start, which no seeded stand-in shows. Every `node` a hook starts goes through
 * lib/hook-bound.sh's run-budgeted.js, so it shows as `node run-budgeted.js`.
 * The dispatchers' own loads and starts are commit-dispatch-cost.test.ts's.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shellCallCost } from "./lib/call-cost.js";
import { type CommitFixture, commitFixture } from "./lib/hook-cost-testkit";

const HUSKY = path.resolve(__dirname, "..", ".husky");

let c: CommitFixture;

beforeEach(() => {
	c = commitFixture("husky-cost-");
});

afterEach(() => {
	fs.rmSync(c.fx.dir, { recursive: true, force: true });
});

/** One `.husky/<hook>` run as git runs it, from the worktree. */
const hook = (name: string, args: string[] = []) =>
	shellCallCost(path.join(HUSKY, name), args, {
		cwd: c.wt.wt,
		env: c.env,
		allowStderr: true,
	});

describe("the per-commit .husky hooks' starts on an ordinary commit (#5338)", () => {
	// The hot-path entry: .husky/pre-commit. The common call: a session's
	// commit of one staged plain file.
	it("starts these binaries from pre-commit", () => {
		const r = hook("pre-commit");
		// The child list is an internal, asserted because no output shows the
		// start-up cost it guards (base §X6, #1497).
		expect(r.children).toEqual([
			"git rev-parse",
			"git -C",
			"git rev-parse",
			"git symbolic-ref",
			"git rev-parse",
			"git rev-parse",
			"node run-budgeted.js",
			"node run-budgeted.js",
			"node run-budgeted.js",
			"git diff",
			"node run-budgeted.js",
			"node mutation-hold-gate.js",
			"git rev-parse",
			"git write-tree",
		]);
	});

	// The hot-path entry: .husky/prepare-commit-msg. The common call: the
	// same commit, pre-commit's stamp standing its gates down.
	it("starts these binaries from prepare-commit-msg", () => {
		c.stamped();
		const r = hook("prepare-commit-msg", [c.message, "message"]);
		// As above, base §X6, #1497.
		expect(r.children).toEqual([
			"git rev-parse",
			"git -C",
			"node run-budgeted.js",
		]);
	});

	// The hot-path entry: .husky/commit-msg. The common call: the same
	// commit's message, no `.husky/commit-msg.local` in the repo.
	it("starts these binaries from commit-msg", () => {
		const r = hook("commit-msg", [c.message]);
		// As above, base §X6, #1497.
		expect(r.children).toEqual([
			"git rev-parse",
			"git -C",
			"node run-budgeted.js",
		]);
	});

	// The hot-path entry: .husky/post-commit. The common call: the same
	// commit, made.
	it("starts these binaries from post-commit", () => {
		c.committed();
		const r = hook("post-commit");
		// As above, base §X6, #1497.
		expect(r.children).toEqual([
			"git rev-parse",
			"git -C",
			"node run-budgeted.js",
			"git rev-parse",
			"git diff",
		]);
	});
});
