// @vitest-environment node
/*
 * hook-envelope.test.ts — the dispatcher's merged output in each event's own
 * decision control (#2787). Loosen a case and a PostToolUse block reaches the
 * harness as a permission it ignores, or a context goes unsaid.
 */
import { describe, expect, it } from "vitest";

const { envelope } = require("./hook-envelope.js") as {
	envelope: (
		event: string,
		output: Record<string, string>,
	) => Record<string, unknown>;
};

describe("the envelope (vendor §PostToolUse decision control)", () => {
	it("writes a PreToolUse merge as the event's own hookSpecificOutput", () => {
		expect(
			envelope("PreToolUse", {
				permissionDecision: "deny",
				permissionDecisionReason: "no",
				additionalContext: "c",
			}),
		).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: "no",
				additionalContext: "c",
			},
		});
	});

	it("turns a PostToolUse deny into a top-level block, its context beside it", () => {
		expect(
			envelope("PostToolUse", {
				permissionDecision: "deny",
				permissionDecisionReason: "no",
				additionalContext: "c",
			}),
		).toEqual({
			decision: "block",
			reason: "no",
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				additionalContext: "c",
			},
		});
	});

	it("writes a PostToolUse context alone with no decision, and no permission at all", () => {
		expect(envelope("PostToolUse", { additionalContext: "c" })).toEqual({
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				additionalContext: "c",
			},
		});
		expect(envelope("PostToolUse", { permissionDecision: "allow" })).toEqual(
			{},
		);
	});
});
