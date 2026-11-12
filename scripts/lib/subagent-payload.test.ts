// @vitest-environment node
/*
 * lib/subagent-payload.js, and the shell face name-issue-session.sh sources, on
 * one table: every row asks both, so the routes never answer a payload apart
 * (#1785).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { shellQuote } from "./sh-quote.js";

const LIB_SH = path.join(__dirname, "subagent-payload.sh");
const { isSubagentPayload } =
	require("./subagent-payload") as typeof import("./subagent-payload.js");
const { compactPayloads } =
	require("./compact-payload-fixture") as typeof import("./compact-payload-fixture.js");

const shellSays = (payload: string) =>
	spawnSync(
		"/bin/bash",
		[
			"-c",
			`source ${shellQuote(LIB_SH)}; is_subagent_payload "$1"`,
			"_",
			payload,
		],
		{ encoding: "utf8" },
	).status === 0;

const both = (payload: unknown) => {
	const js = isSubagentPayload(payload);
	expect(shellSays(JSON.stringify(payload))).toBe(js);
	return js;
};

describe("agent_id", () => {
	it("marks a subagent's payload on any event", () => {
		expect(both({ hook_event_name: "PreToolUse", agent_id: "a1" })).toBe(true);
	});

	it("reads null, false and an empty string as the parent's", () => {
		for (const agentId of [null, false, ""])
			expect(both({ hook_event_name: "PreToolUse", agent_id: agentId })).toBe(
				false,
			);
	});

	it("marks a subagent's compaction payloads, which carry its parent's session (#1837)", () => {
		const { preCompact, sessionStart } = compactPayloads({
			sessionId: "s1",
			transcriptPath: "/x/s1.jsonl",
			cwd: "/x",
			agentId: "a1",
		});
		expect(both(preCompact)).toBe(true);
		expect(both(sessionStart)).toBe(true);
	});

	it("reads a parent's compaction payloads as the parent's", () => {
		const { preCompact, sessionStart } = compactPayloads({
			sessionId: "s1",
			transcriptPath: "/x/s1.jsonl",
			cwd: "/x",
		});
		expect(both(preCompact)).toBe(false);
		expect(both(sessionStart)).toBe(false);
	});

	it("reads a payload jq cannot parse as the parent's", () => {
		expect(shellSays("{not json")).toBe(false);
	});
});
