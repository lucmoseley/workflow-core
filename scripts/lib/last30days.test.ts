// @vitest-environment node
/*
 * lib/last30days.js, a PreToolUse dispatcher core (#2792), keeps the
 * last30days skill out of the main session, where one invocation leaves ~87k
 * tokens in its context.
 *
 * Module cases, run in process through lib/guard-core-testkit.ts over the
 * production adapters. The hook line, stdin and the error log's own format
 * are scripts/guard-dispatch.test.ts's boundary set.
 *
 * It runs on every Skill call: loosen it and one inline call leaves ~87k
 * tokens in a main session's context; make it deny inside a subagent and the
 * skill cannot run at all.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCore } from "./guard-core-testkit";

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "last30days-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const run = (payload: Record<string, unknown>) =>
	runCore("guard-last30days", { tool_name: "Skill", ...payload }, { root });

/** A call the core passes, and says nothing anywhere about. */
const expectSilentAllow = (r: ReturnType<typeof run>) => {
	expect(r.output).toBeNull();
	expect(r.logs).toEqual([]);
};

describe("the main session is denied", () => {
	it.each([
		["last30days", "the bare skill name"],
		["last30days:last30days", "the plugin-namespaced form"],
		["plugin:last30days", "namespaced the other way"],
	])("%s — %s", (skill) => {
		const { output } = run({ tool_input: { skill } });
		expect(output?.permissionDecision).toBe("deny");
		expect(output?.additionalContext).toBeUndefined();
		// The deny has to say what to do instead, or it just blocks the work.
		const reason = output?.permissionDecisionReason ?? "";
		expect(reason).toMatch(
			/^last30days must run in a subagent, not the main session: /,
		);
		expect(reason).toContain("(subagent_type: general-purpose)");
		expect(reason).toContain(
			"\n\n    Artefact: .claude/tmp/last30days-<slug>.md\n\n",
		);
		expect(reason).toMatch(/resolving inside that worktree\.$/);
	});

	it.each([
		["absent", {}],
		["empty", { agent_id: "" }],
	])("an %s agent_id is the main session", (_s, extra) => {
		const { output } = run({ tool_input: { skill: "last30days" }, ...extra });
		expect(output?.permissionDecision).toBe("deny");
	});
});

describe("the sanctioned and unrelated paths pass", () => {
	it("allows the call inside a subagent — agent_id is the whole signal", () => {
		expectSilentAllow(
			run({ tool_input: { skill: "last30days" }, agent_id: "abc" }),
		);
	});

	it("stays out of the way of every other skill", () => {
		expectSilentAllow(run({ tool_input: { skill: "research" } }));
	});

	it("does not match a skill that merely mentions it", () => {
		expectSilentAllow(run({ tool_input: { skill: "last30days-notes" } }));
	});
});

/*
 * This guard hid its fail-opens worst of any of them (mantahostels#147): a
 * skill name read as empty reads as "not our skill", and the ~87k-token
 * inline call the guard exists to stop goes through with nothing said
 * anywhere.
 */
describe("the fail-open record (mantahostels#147)", () => {
	it("records a payload whose shape no longer carries what it reads (mantahostels#157)", () => {
		const r = run({ tool_input: {} });
		expect(r.output).toBeNull();
		expect(r.logs.join("\n")).toMatch(
			/no skill in payload — skill call allowed unchecked/,
		);
	});

	it("says nothing about an ordinary skill it judged and passed", () => {
		expectSilentAllow(run({ tool_input: { skill: "roadmap-edit" } }));
	});
});

describe("the cases a mutant must not survive (#2792)", () => {
	it.each(["mylast30days", "last30daysx", "x:last30days-notes"])(
		"passes %s, a name that only contains the skill's",
		(skill) => {
			expectSilentAllow(run({ tool_input: { skill } }));
		},
	);

	// The kit keys a latch on the same reading (agentKey): an id that is no
	// string is the main session's.
	it("allows where agent_id is no string, as any agent_id names a subagent", () => {
		expect(
			run({ tool_input: { skill: "last30days" }, agent_id: 7 }).output,
		).toBeNull();
	});

	it("denies a namespace with nothing after its colon", () => {
		expect(
			run({ tool_input: { skill: "last30days:" } }).output?.permissionDecision,
		).toBe("deny");
	});
});
