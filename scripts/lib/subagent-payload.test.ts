// @vitest-environment node
/*
 * lib/subagent-payload.js, and the shell face the bash hooks source, on one
 * table: every row asks both, so the routes never answer a payload apart
 * (#1837).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LIB_SH = path.join(__dirname, "subagent-payload.sh");
const { isSubagentPayload } =
	require("./subagent-payload") as typeof import("./subagent-payload.js");
const { compactPayloads, compactTranscripts } =
	require("./compact-payload-fixture") as typeof import("./compact-payload-fixture.js");

const shellSays = (payload: string) =>
	spawnSync(
		"/bin/bash",
		[
			"-c",
			`source ${JSON.stringify(LIB_SH)}; is_subagent_payload "$1"`,
			"_",
			payload,
		],
		{ encoding: "utf8" },
	).status === 0;

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-payload-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const both = (payload: unknown) => {
	const js = isSubagentPayload(payload);
	expect(shellSays(JSON.stringify(payload))).toBe(js);
	return js;
};

/** A `SessionStart:compact` payload over transcripts of the given ages. */
const atCompaction = (parentAgeS: number, subagentAgesS: number[]) =>
	compactPayloads({
		sessionId: "s1",
		transcriptPath: compactTranscripts(dir, {
			sessionId: "s1",
			parentAgeS,
			subagentAgesS,
		}),
		cwd: dir,
	}).sessionStart;

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
});

// Ages are seconds. "Replay" rows are compactions #1837's replay recorded.
describe("transcript freshness on SessionStart:compact (#1837)", () => {
	it.each([
		["replay: an idle parent", 757, [69]],
		["replay: a subagent just under two minutes", 318, [79]],
		["any one subagent fresh enough", 300, [600, 40]],
		["a parent just past 30 s", 35, [5]],
		["a subagent just under 120 s", 300, [110]],
	])("reads a subagent's compaction: %s", (_, parentAgeS, subAges) => {
		expect(both(atCompaction(parentAgeS, subAges))).toBe(true);
	});

	it.each([
		["replay: the parent writing while its subagent compacts", 0.1, [1.3]],
		["replay: a subagent over two minutes", 73, [180]],
		["replay: the stalest parent seen at its own compaction", 17, [10_080]],
		["a parent under 30 s beside a fresh subagent", 25, [0.1]],
		["a subagent just over 120 s", 300, [130]],
		["a subagent staler than the parent", 60, [90]],
		["no subagent transcripts", 300, []],
	])("reads the parent's compaction: %s", (_, parentAgeS, subAges) => {
		expect(both(atCompaction(parentAgeS, subAges))).toBe(false);
	});

	it("reads only SessionStart:compact this way", () => {
		const start = atCompaction(757, [5]);
		const { preCompact } = compactPayloads({
			sessionId: "s1",
			transcriptPath: String(start.transcript_path),
			cwd: dir,
		});
		expect(both(preCompact)).toBe(false);
		expect(both({ ...start, source: "resume" })).toBe(false);
	});

	it("reads a missing parent transcript as the parent's", () => {
		const start = atCompaction(757, [5]);
		fs.rmSync(String(start.transcript_path));
		expect(both(start)).toBe(false);
	});
});
