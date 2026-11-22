// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shellCallCost } from "./lib/call-cost-harness.js";
import {
	type CommitFixture,
	defineCommitFixture,
} from "./lib/hook-cost-testkit";

const HUSKY = path.resolve(__dirname, "..", ".husky");

const commitFixture = defineCommitFixture();

let c: CommitFixture;

beforeEach(() => {
	c = commitFixture("husky-cost-");
});

afterEach(() => {
	fs.rmSync(c.fx.dir, { recursive: true, force: true });
});

const hook = (name: string, args: string[] = []) =>
	shellCallCost(path.join(HUSKY, name), args, {
		cwd: c.wt.wt,
		env: c.env,
		allowStderr: true,
	});

describe("the per-commit .husky hooks' starts on an ordinary commit (#5338)", () => {
	it("starts these binaries from pre-commit", () => {
		const r = hook("pre-commit");
		expect(r.children).toEqual([
			"git rev-parse",
			"git -C",
			"git rev-parse",
			"git symbolic-ref",
			"git rev-parse",
			"git rev-parse",
			"node run-budgeted.js node precommit-dispatch.js",
			"node run-budgeted.js node workflow-core-config.js",
			"node run-budgeted.js gitleaks git",
			"git diff",
			"node run-budgeted.js node test-gate.js",
			"node mutation-hold-gate.js",
			"git rev-parse",
			"git write-tree",
		]);
	});

	it("starts these binaries from prepare-commit-msg", () => {
		c.stamped();
		const r = hook("prepare-commit-msg", [c.message, "message"]);
		expect(r.children).toEqual([
			"git rev-parse",
			"git -C",
			"node run-budgeted.js node prepare-commit-msg-dispatch.js",
		]);
	});

	it("starts these binaries from commit-msg", () => {
		const r = hook("commit-msg", [c.message]);
		expect(r.children).toEqual([
			"git rev-parse",
			"git -C",
			"node run-budgeted.js node commit-msg-dispatch.js",
		]);
	});

	it("starts these binaries from post-commit", () => {
		c.committed();
		const r = hook("post-commit");
		expect(r.children).toEqual([
			"git rev-parse",
			"git -C",
			"node run-budgeted.js node post-commit-dispatch.js",
			"git rev-parse",
			"git diff",
		]);
	});
});
