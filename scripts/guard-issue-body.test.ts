// @vitest-environment node
/*
 * The guard-issue-body core of guard-dispatch.js refuses a raw issue-body
 * write (mantahostels#132). These are its boundary cases, the dispatcher
 * entry run on it alone on a harness-shaped payload: each exit, and the rule
 * store and the script-path resolver crossed for real. Which command is
 * refused, and why, is lib/issue-body-write.test.ts's; the entry's payload
 * faults and the throw policy are guard-dispatch's own tests' (#2798, #3225).
 * The core calls no gh and reads no file of its own, so there is no other
 * adapter to cross.
 *
 * CLAUDE_PROJECT_DIR is a temp project, so the fail-open log lands in the
 * temp CLAUDE_CONFIG_DIR and never the founder's.
 *
 * Make it allow a whole-body `gh issue edit` and a parallel session's edit is
 * silently erased; make it deny on a fault and every `gh` call is wedged.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFailOpenRecords } from "./guard-log-fixture";
import {
	buildBashPayload,
	dispatchCoreOutput,
	guardDirs,
} from "./lib/pretool-guard-testkit";

const CORE = "guard-issue-body";
const { readRuleText } = require("./lib/rule-text") as {
	readRuleText: (id: string) => string;
};

let dir: string;
let config: string;

beforeEach(() => {
	({ dir, config } = guardDirs("issue-body-entry-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The core's hookSpecificOutput for `command`, run in `cwd`. */
const emission = (
	command: string,
	{ env = {}, cwd = dir }: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
) =>
	dispatchCoreOutput(
		CORE,
		{ ...buildBashPayload(command, "s1"), cwd },
		{ project: dir, config, cwd, env },
	);

describe("each exit", () => {
	it("refuses a body write as permissionDecision JSON on exit 0, splicing the stored rule", () => {
		const out = emission('gh issue edit 132 --body "new text"');
		expect(out.hookEventName).toBe("PreToolUse");
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toBe(
			`This writes an issue body whole, erasing any parallel session's edit: gh issue edit 132 --body "…"\n\n${readRuleText("issue-body-clobber")}`,
		);
		expect(readFailOpenRecords(config, dir)).toEqual([]);
	});

	it("still refuses, naming the fragment, where the rule store cannot give it", () => {
		const out = emission('gh issue edit 132 --body "x"', {
			env: { WFC_RULES_DIR: fs.mkdtempSync(path.join(dir, "store-")) },
		});
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(
			"docs/agents/rules/issue-body-clobber.txt",
		);
	});

	it("warns, as additionalContext on exit 0, on a PATCH whose fields it cannot read (mantahostels#103)", () => {
		const out = emission(
			"gh api --method PATCH repos/o/r/issues/96 --input payload.json",
		);
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain(
			"This PATCHes an issue resource directly, and the guard cannot see whether it writes the body:",
		);
	});

	it("names the helper at the plugin root in an install, WFC_SCRIPT_ROOT standing in for one (#1248)", () => {
		const plugin = fs.mkdtempSync(path.join(dir, "plugin-"));
		fs.mkdirSync(path.join(plugin, "scripts"));
		fs.writeFileSync(path.join(plugin, "scripts", "issue-body.js"), "");
		const out = emission("gh api graphql --input payload.json", {
			env: { WFC_SCRIPT_ROOT: plugin },
		});
		expect(out.additionalContext).toContain(
			`  node ${plugin}/scripts/issue-body.js append <n> --text "…"`,
		);
	});

	it("says nothing about a comment or a field-only edit, and judges the command, not the cwd", () => {
		expect(emission('gh issue comment 96 --body "x"')).toBeNull();
		expect(emission("gh issue edit 96 --add-label kind:ticket")).toBeNull();
		const elsewhere = fs.mkdtempSync(path.join(dir, "elsewhere-"));
		expect(
			emission("gh issue edit 96 --body x", { cwd: elsewhere })
				.permissionDecision,
		).toBe("deny");
		expect(readFailOpenRecords(config, dir)).toEqual([]);
	});
});
