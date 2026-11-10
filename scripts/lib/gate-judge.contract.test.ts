// @vitest-environment node
/*
 * Holds the gate judge's launch (#4964) to the installed harness's recording
 * (scripts/fixtures/gate-judge-reply.json, re-recorded by
 * `node scripts/record-gate-judge-reply.js`): the `result` row
 * lib/gate-judge.js reads, the row lib/gate-judge-stub.ts serves every suite
 * in its place, the flags lib/gate-judge-mode.js passes, and what a child
 * under those flags was seen to load and leave. Breaking it lets a renamed
 * result field or flag pass every suite while each live call falls back to
 * the patterns, and lets the child start loading tools, plugins or hooks, or
 * writing transcripts, unseen.
 */
import { describe, expect, it } from "vitest";
import { parseReading } from "./gate-judge.js";
import { JUDGE_ARGS } from "./gate-judge-mode.js";
import { buildReplyRow, recorded } from "./gate-judge-stub";
import { recorded as headless } from "./headless-run-fake";

describe(`the judge mode's reply, in ${recorded.harness}'s recording`, () => {
	it("carries a reading that fits the schema, in the field the judge reads", () => {
		expect(recorded.result.type).toBe("result");
		expect(recorded.result.is_error).toBe(false);
		expect(parseReading(recorded.result.structured_output)).not.toBeNull();
	});

	it("quotes the recorded body's own words", () => {
		const reading = parseReading(recorded.result.structured_output);
		for (const w of reading?.waits ?? [])
			expect(recorded.body).toContain(w.sentence);
		for (const b of reading?.bases ?? [])
			expect(recorded.body).toContain(b.basis);
	});

	it("is the shape the stub serves", () => {
		const row = buildReplyRow({ waits: [], bases: [] });
		expect(Object.keys(row).sort()).toEqual(
			Object.keys(recorded.result).sort(),
		);
		expect(typeof row.result).toBe(typeof recorded.result.result);
	});
});

describe("the judge mode's flags", () => {
	it("are each an option the recorded harness lists", () => {
		const names = new Set(headless.options.flatMap((o) => o.names));
		for (const flag of JUDGE_ARGS.filter((a) => a.startsWith("-")))
			expect(names, flag).toContain(flag);
	});
});

describe("a child under the judge mode's flags was seen", () => {
	it("to load the answer tool alone: no MCP server, slash command or plugin", () => {
		expect(recorded.observed).toMatchObject({
			tools: ["StructuredOutput"],
			mcpServers: 0,
			slashCommands: 0,
			plugins: [],
		});
	});

	it("to fire no hook and leave no transcript", () => {
		expect(recorded.observed).toMatchObject({ hookEvents: 0, transcripts: 0 });
	});
});
