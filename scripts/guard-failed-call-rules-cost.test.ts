// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callCost } from "./lib/call-cost-harness.js";
import { type CostFixture, defineCostFixture } from "./lib/hook-cost-testkit";

const ENTRY = path.join(__dirname, "guard-failed-call-rules.js");

const costFixture = defineCostFixture();

let fx: CostFixture;

beforeEach(() => {
	fx = costFixture("failed-call-rules-cost-");
});

afterEach(() => {
	fs.rmSync(fx.dir, { recursive: true, force: true });
});

const guard = (payload: Record<string, unknown>) =>
	callCost(ENTRY, [], {
		cwd: fx.repo,
		env: fx.env,
		stdin: JSON.stringify({
			session_id: "sess-5338",
			transcript_path: path.join(fx.dir, "home", "transcript.jsonl"),
			cwd: fx.repo,
			...payload,
		}),
	});

describe("guard-failed-call-rules.js's per-call cost (#5338)", () => {
	it("costs an ordinary failed Bash call under PostToolUseFailure these modules and starts", () => {
		const r = guard({
			hook_event_name: "PostToolUseFailure",
			tool_name: "Bash",
			tool_input: { command: "ls missing" },
			error:
				"Exit code 2\nls: cannot access 'missing': No such file or directory",
			is_interrupt: false,
		});
		expect(r.stdout).toBe("");
		// #1497
		expect(r.modules).toEqual([
			"guard-failed-call-rules.js",
			"lib/caught.js",
			"lib/child-buffer.js",
			"lib/deny-capable.js",
			"lib/deref.js",
			"lib/entry-input.js",
			"lib/failed-call-rules.js",
			"lib/file-read.js",
			"lib/gh-binary.js",
			"lib/git-mode.js",
			"lib/git-objects.js",
			"lib/git-read-memo.js",
			"lib/git.js",
			"lib/guard-cores.js",
			"lib/guard-entry.js",
			"lib/hook-deadline.js",
			"lib/hook-events.js",
			"lib/host-root.js",
			"lib/if-clause.js",
			"lib/kit-context.js",
			"lib/main-checkout.js",
			"lib/marker-root.js",
			"lib/outcome-error.js",
			"lib/read-fd.js",
			"lib/regex-group.js",
			"lib/repo-path.js",
			"lib/review-suffix.js",
			"lib/sleep-sync.js",
			"lib/trim-run.js",
			"lib/workflow-core-config.js",
			"lib/write-fd.js",
		]);
		expect(r.children).toEqual([]);
	});

	it("costs an ordinary PostToolBatch these modules and starts", () => {
		const r = guard({
			hook_event_name: "PostToolBatch",
			tool_calls: [
				{
					tool_name: "Bash",
					tool_input: { command: "ls" },
					tool_use_id: "a",
					tool_response: { stdout: "README.md\n", stderr: "" },
				},
				{
					tool_name: "Read",
					tool_input: { file_path: path.join(fx.repo, "README.md") },
					tool_use_id: "b",
					tool_response: "fixture\n",
				},
			],
		});
		expect(r.stdout).toBe("");
		// #1497
		expect(r.modules).toEqual([
			"guard-failed-call-rules.js",
			"lib/caught.js",
			"lib/child-buffer.js",
			"lib/deny-capable.js",
			"lib/deref.js",
			"lib/entry-input.js",
			"lib/failed-call-rules.js",
			"lib/file-read.js",
			"lib/gh-binary.js",
			"lib/git-mode.js",
			"lib/git-objects.js",
			"lib/git-read-memo.js",
			"lib/git.js",
			"lib/guard-cores.js",
			"lib/guard-entry.js",
			"lib/hook-deadline.js",
			"lib/hook-events.js",
			"lib/host-root.js",
			"lib/if-clause.js",
			"lib/kit-context.js",
			"lib/main-checkout.js",
			"lib/marker-root.js",
			"lib/outcome-error.js",
			"lib/read-fd.js",
			"lib/regex-group.js",
			"lib/repo-path.js",
			"lib/review-suffix.js",
			"lib/sleep-sync.js",
			"lib/trim-run.js",
			"lib/workflow-core-config.js",
			"lib/write-fd.js",
		]);
		expect(r.children).toEqual([]);
	});
});
