// @vitest-environment node
/*
 * Pins what one guard-lost-verdict.js call costs on the common path: the repo
 * modules it loads and the processes it starts (base §G13, #5338). The
 * shipped hooks/hooks.json runs it unnarrowed on every Bash call's
 * PostToolUse and PostToolUseFailure, so each module or child past what the
 * call needs is paid on every Bash call of every session.
 *
 * Program cases (base §X3), run through lib/call-cost.js in
 * lib/hook-cost-testkit.ts's fixture repo. Which run's verdict is handed
 * over is guard-lost-verdict.test.ts's and lib/lost-verdict.test.ts's.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callCost } from "./lib/call-cost.js";
import { type CostFixture, costFixture } from "./lib/hook-cost-testkit";

const ENTRY = path.join(__dirname, "guard-lost-verdict.js");

let fx: CostFixture;

beforeEach(() => {
	fx = costFixture("lost-verdict-cost-");
});

afterEach(() => {
	fs.rmSync(fx.dir, { recursive: true, force: true });
});

/** One guard call on a plain `ls`'s `payload`, as the harness sends it. */
const guard = (payload: Record<string, unknown>) =>
	callCost(ENTRY, [], {
		cwd: fx.repo,
		env: fx.env,
		stdin: JSON.stringify({
			session_id: "sess-5338",
			transcript_path: path.join(fx.dir, "home", "transcript.jsonl"),
			cwd: fx.repo,
			tool_name: "Bash",
			tool_input: { command: "ls" },
			duration_ms: 12,
			...payload,
		}),
	});

describe("guard-lost-verdict.js's per-call cost (#5338)", () => {
	// The hot-path entry: the PostToolUse Bash line. The common call: a plain
	// `ls` that listed the tree.
	it("costs a plain Bash call under PostToolUse these modules and starts", () => {
		const r = guard({
			hook_event_name: "PostToolUse",
			tool_response: { stdout: "README.md\n", stderr: "" },
		});
		expect(r.stdout).toBe("");
		// The module set and the child list are internals, asserted because
		// no output shows the start-up cost they guard (base §X6, #1497).
		expect(r.modules).toEqual([
			"guard-lost-verdict.js",
			"lib/arbiter-proc.js",
			"lib/atomic-write.js",
			"lib/caught.js",
			"lib/child-buffer.js",
			"lib/content-ids.js",
			"lib/cpu-sample.js",
			"lib/deny-capable.js",
			"lib/deref.js",
			"lib/dir-lock.js",
			"lib/dirty-tree.js",
			"lib/entry-input.js",
			"lib/file-read.js",
			"lib/git-alias.js",
			"lib/git-mode.js",
			"lib/git-objects.js",
			"lib/git-options.js",
			"lib/git-read-memo.js",
			"lib/git.js",
			"lib/guard-cores.js",
			"lib/guard-entry.js",
			"lib/home-path.js",
			"lib/hook-deadline.js",
			"lib/hook-events.js",
			"lib/host-root.js",
			"lib/if-clause.js",
			"lib/jsonl.js",
			"lib/kit-context.js",
			"lib/landing-refs.js",
			"lib/lost-verdict-host.js",
			"lib/lost-verdict.js",
			"lib/machine-marker.js",
			"lib/machine-setting.js",
			"lib/main-checkout.js",
			"lib/marker-root.js",
			"lib/npm-options.js",
			"lib/outcome-error.js",
			"lib/proc-environ.js",
			"lib/proc-root.js",
			"lib/proc-stat.js",
			"lib/push-refs.js",
			"lib/read-fd.js",
			"lib/regex-group.js",
			"lib/retained-jsonl.js",
			"lib/review-suffix.js",
			"lib/run-ledger.js",
			"lib/session-id.js",
			"lib/sh-quote.js",
			"lib/shell-dirs.js",
			"lib/shell-lexer.js",
			"lib/shell-parse.js",
			"lib/shell-words.js",
			"lib/sleep-sync.js",
			"lib/suite-bounded.js",
			"lib/suite-ceiling.js",
			"lib/suite-launch.js",
			"lib/test-kind.js",
			"lib/test-log.js",
			"lib/test-pass-marker.js",
			"lib/trim-run.js",
			"lib/workflow-core-config.js",
			"lib/worktree-dirs.js",
			"lib/write-fd.js",
		]);
		expect(r.children).toEqual(["git rev-parse"]);
	});

	// The hot-path entry: the PostToolUseFailure Bash line. The common call:
	// a plain `ls` that exited non-zero.
	it("costs a plain failed Bash call under PostToolUseFailure these modules and starts", () => {
		const r = guard({
			hook_event_name: "PostToolUseFailure",
			error:
				"Exit code 2\nls: cannot access 'missing': No such file or directory",
			is_interrupt: false,
		});
		expect(r.stdout).toBe("");
		// As above, base §X6, #1497.
		expect(r.modules).toEqual([
			"guard-lost-verdict.js",
			"lib/arbiter-proc.js",
			"lib/atomic-write.js",
			"lib/caught.js",
			"lib/child-buffer.js",
			"lib/content-ids.js",
			"lib/cpu-sample.js",
			"lib/deny-capable.js",
			"lib/deref.js",
			"lib/dir-lock.js",
			"lib/dirty-tree.js",
			"lib/entry-input.js",
			"lib/file-read.js",
			"lib/git-alias.js",
			"lib/git-mode.js",
			"lib/git-objects.js",
			"lib/git-options.js",
			"lib/git-read-memo.js",
			"lib/git.js",
			"lib/guard-cores.js",
			"lib/guard-entry.js",
			"lib/home-path.js",
			"lib/hook-deadline.js",
			"lib/hook-events.js",
			"lib/host-root.js",
			"lib/if-clause.js",
			"lib/jsonl.js",
			"lib/kit-context.js",
			"lib/landing-refs.js",
			"lib/lost-verdict-host.js",
			"lib/lost-verdict.js",
			"lib/machine-marker.js",
			"lib/machine-setting.js",
			"lib/main-checkout.js",
			"lib/marker-root.js",
			"lib/npm-options.js",
			"lib/outcome-error.js",
			"lib/proc-environ.js",
			"lib/proc-root.js",
			"lib/proc-stat.js",
			"lib/push-refs.js",
			"lib/read-fd.js",
			"lib/regex-group.js",
			"lib/retained-jsonl.js",
			"lib/review-suffix.js",
			"lib/run-ledger.js",
			"lib/session-id.js",
			"lib/sh-quote.js",
			"lib/shell-dirs.js",
			"lib/shell-lexer.js",
			"lib/shell-parse.js",
			"lib/shell-words.js",
			"lib/sleep-sync.js",
			"lib/suite-bounded.js",
			"lib/suite-ceiling.js",
			"lib/suite-launch.js",
			"lib/test-kind.js",
			"lib/test-log.js",
			"lib/test-pass-marker.js",
			"lib/trim-run.js",
			"lib/workflow-core-config.js",
			"lib/worktree-dirs.js",
			"lib/write-fd.js",
		]);
		expect(r.children).toEqual(["git rev-parse"]);
	});
});
