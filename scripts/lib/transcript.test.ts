// @vitest-environment node
/*
 * Pins the transcript seam's readings — standing context, the main chain,
 * the subagent tier, autocompactions and turn counts — and its refusal to
 * read "no usage record" as zero.
 *
 * The transcript seam in-process, where the two CLIs above it can only be
 * driven as subprocesses (§X3).
 *
 * The property that matters most is the one a caller cannot recover from:
 * `lastStandingContext` returns null rather than 0 when it finds no usage
 * record, because a session reading an unreadable transcript as 0 tokens of
 * standing context would merge on for ever (mantahostels#1094, the ticket that capped a
 * dispatch bundle on accumulated context).
 */

import { describe, expect, it } from "vitest";
import {
	autocompactions,
	countTurns,
	isSubagentTranscript,
	lastStandingContext,
	lastTurn,
	mainChainRecords,
	parseContentText,
	standingContext,
	subagentDirOf,
	turnRecords,
} from "./transcript.js";

const turn = (ctx: number, extra: Record<string, unknown> = {}) =>
	JSON.stringify({
		type: "assistant",
		timestamp: "2026-08-22T04:00:00.000Z",
		message: {
			id: `msg_${ctx}`,
			usage: {
				input_tokens: 2,
				cache_creation_input_tokens: 1000,
				cache_read_input_tokens: ctx - 1002,
				output_tokens: 400,
			},
		},
		...extra,
	});

describe("standingContext", () => {
	it("sums what the model was sent, and ignores what it produced", () => {
		expect(
			standingContext({
				input_tokens: 2,
				cache_creation_input_tokens: 1000,
				cache_read_input_tokens: 98_998,
				output_tokens: 50_000,
			}),
		).toBe(100_000);
	});

	it("treats an absent token class as zero rather than NaN", () => {
		expect(standingContext({ cache_read_input_tokens: 40 })).toBe(40);
		expect(standingContext({})).toBe(0);
	});
});

describe("mainChainRecords", () => {
	it("skips a half-written final line rather than throwing on it", () => {
		const records = [
			...mainChainRecords(`${turn(10_000)}\n{"type":"assi`, "main"),
		];
		expect(records).toHaveLength(1);
	});

	it("skips a subagent's turns, which are not the session's context, on tier main", () => {
		const text = [turn(10_000), turn(500_000, { isSidechain: true })].join(
			"\n",
		);
		expect([...mainChainRecords(text, "main")]).toHaveLength(1);
	});

	it("reads every record on tier subagent, none of them filtered as sidechain — mantahostels#1779", () => {
		// A subagent's own file: every record carries isSidechain true relative
		// to its PARENT, and here that IS the chain, not something to skip.
		const text = [
			turn(10_000, { isSidechain: true }),
			turn(500_000, { isSidechain: true }),
		].join("\n");
		expect([...mainChainRecords(text, "subagent")]).toHaveLength(2);
	});

	it("throws rather than silently returning empty when given no tier — mantahostels#1779", () => {
		expect(() => [
			...mainChainRecords(turn(10_000), undefined as never),
		]).toThrow(/tier/);
	});

	it("throws on an invalid tier rather than silently returning empty — mantahostels#1779", () => {
		expect(() => [...mainChainRecords(turn(10_000), "both" as never)]).toThrow(
			/tier/,
		);
	});

	it("counts a skipped malformed line on a passed-in stats object — mantahostels#3307", () => {
		const stats = { skipped: 0 };
		const records = [
			...mainChainRecords(
				`garbage\n${turn(10_000)}\nmore garbage`,
				"main",
				stats,
			),
		];
		expect(records).toHaveLength(1);
		expect(stats.skipped).toBe(2);
	});

	it("never touches stats where a caller omits it — opt-in, not required", () => {
		expect(() => [...mainChainRecords("garbage", "main")]).not.toThrow();
	});
});

describe("subagentDirOf", () => {
	it("is the session's own directory's subagents/, beside its log", () => {
		expect(subagentDirOf("/p/slug/abc.jsonl")).toBe("/p/slug/abc/subagents");
	});
});

describe("parseContentText", () => {
	it("reads a string as itself and blocks as text, marking each image", () => {
		expect(parseContentText("hi")).toBe("hi");
		expect(
			parseContentText([
				{ type: "text", text: "look" },
				{ type: "image", source: {} },
				{ type: "tool_use", id: "t" },
				{ type: "text", text: 7 },
			]),
		).toBe("look [image]");
		expect(parseContentText(undefined)).toBe("");
	});
});

describe("isSubagentTranscript", () => {
	it("is true for a file under a session's subagents directory", () => {
		expect(
			isSubagentTranscript(
				"/home/x/.claude/projects/-repo/abc/subagents/agent-def.jsonl",
			),
		).toBe(true);
	});

	it("is false for a top-level session file", () => {
		expect(
			isSubagentTranscript("/home/x/.claude/projects/-repo/abc.jsonl"),
		).toBe(false);
	});
});

describe("lastStandingContext", () => {
	it("reads the most recent turn, not the largest", () => {
		expect(
			lastStandingContext([turn(300_000), turn(120_000)].join("\n"), "main"),
		).toMatchObject({ tokens: 120_000 });
	});

	it("returns null, never 0, when no turn carries a usage record", () => {
		expect(
			lastStandingContext('{"type":"user","message":{}}', "main"),
		).toBeNull();
	});

	it("returns null on an empty transcript", () => {
		expect(lastStandingContext("", "main")).toBeNull();
	});

	it("carries the timestamp of the turn it read", () => {
		expect(lastStandingContext(turn(50_000), "main")).toMatchObject({
			at: "2026-08-22T04:00:00.000Z",
		});
	});

	it("reads a subagent's own turn on tier subagent, where tier main would see nothing — mantahostels#1779", () => {
		const text = turn(50_000, { isSidechain: true });
		expect(lastStandingContext(text, "main")).toBeNull();
		expect(lastStandingContext(text, "subagent")).toMatchObject({
			tokens: 50_000,
		});
	});
});

describe("autocompactions (#1032)", () => {
	const boundary = (extra: Record<string, unknown>) =>
		JSON.stringify({ type: "system", subtype: "compact_boundary", ...extra });

	it("keys each main-chain boundary, on its uuid else its timestamp", () => {
		const text = [
			boundary({ uuid: "c1" }),
			boundary({ timestamp: "2026-10-05T00:00:00Z" }),
			JSON.stringify({ type: "system", subtype: "api_error", uuid: "e1" }),
		].join("\n");
		expect(autocompactions(text, "main")).toEqual([
			"c1",
			"2026-10-05T00:00:00Z",
		]);
	});

	it("leaves out a subagent's inline boundary, a manual one and a keyless one", () => {
		const text = [
			boundary({ uuid: "s1", isSidechain: true }),
			boundary({ uuid: "m1", compactMetadata: { trigger: "manual" } }),
			boundary({}),
		].join("\n");
		expect(autocompactions(text, "main")).toEqual([]);
		expect(autocompactions(text, "subagent")).toEqual(["s1"]);
	});
});

describe("lastTurn (#2980)", () => {
	const row = (r: Record<string, unknown>) => JSON.stringify(r);
	const assistant = row({ type: "assistant", message: { content: [] } });
	const summary = row({ type: "system", subtype: "stop_hook_summary" });
	const duration = row({ type: "system", subtype: "turn_duration" });
	const blocked = row({
		type: "attachment",
		attachment: { type: "hook_blocking_error", hookEvent: "Stop" },
	});
	const request = row({ type: "api-request" });
	const lines = (...rs: string[]) => rs.join("\n");
	const ended = (text: string) => lastTurn(text)?.ended;

	it("reads a turn ended where turn_duration follows the last assistant row", () => {
		expect(
			ended(lines(assistant, summary, duration, row({ type: "cost-state" }))),
		).toBe(true);
	});

	it("reads a turn running where the Stop hooks have not yet finished", () => {
		expect(ended(lines(assistant))).toBe(false);
	});

	it("reads a turn running where a Stop hook blocked and forced a turn", () => {
		// #2977's 9b4f2431: block, its feedback, the summary, the forced request.
		expect(
			ended(lines(assistant, blocked, row({ type: "user" }), summary, request)),
		).toBe(false);
		expect(ended(lines(assistant, duration, blocked))).toBe(false);
		expect(ended(lines(assistant, duration, request))).toBe(false);
	});

	it("dates the last turn row, never a bookkeeping row after it", () => {
		const text = lines(
			row({ type: "api-request", timestamp: "2026-10-25T13:00:27.336Z" }),
			row({ type: "cost-state", timestamp: "2026-10-25T13:09:00.000Z" }),
		);
		expect(lastTurn(text)).toEqual({
			ended: false,
			at: Date.parse("2026-10-25T13:00:27.336Z"),
		});
		expect(lastTurn(lines(request))).toEqual({ ended: false, at: null });
	});

	it("ignores a subagent's inline rows and a line cut mid-record", () => {
		expect(
			ended(
				lines(
					'"cut":"mid-record"}',
					assistant,
					duration,
					row({ type: "assistant", isSidechain: true }),
				),
			),
		).toBe(true);
	});

	it("cannot say where the text holds no turn row", () => {
		expect(lastTurn("")).toBeNull();
		expect(lastTurn(lines(summary, row({ type: "cost-state" })))).toBeNull();
	});
});

describe("countTurns (mantahostels#2601, the 100-turn band's instrument)", () => {
	/* One API response, written as three records — a text block and two
	 * tool_use blocks — all repeating the same requestId and the same usage. */
	const response = (id: string, records = 3) =>
		Array.from({ length: records }, (_, i) =>
			JSON.stringify({
				type: "assistant",
				requestId: id,
				uuid: `${id}-${i}`,
				message: {
					usage: { input_tokens: 1, cache_read_input_tokens: 50_000 },
				},
			}),
		).join("\n");

	it("counts one turn per requestId, not one per record", () => {
		expect(
			countTurns([response("req_a"), response("req_b")].join("\n"), "main"),
		).toBe(2);
	});

	it("counts nothing on a transcript with no assistant turn", () => {
		expect(countTurns('{"type":"user","message":{}}', "main")).toBe(0);
	});

	it("ignores an assistant record carrying no usage", () => {
		const bare = JSON.stringify({
			type: "assistant",
			requestId: "req_c",
			message: { content: [] },
		});
		expect(countTurns([response("req_a"), bare].join("\n"), "main")).toBe(1);
	});

	it("counts a record with no requestId on its own uuid, rather than collapsing them", () => {
		const noReq = (uuid: string) =>
			JSON.stringify({
				type: "assistant",
				uuid,
				message: { usage: { input_tokens: 1 } },
			});
		expect(countTurns([noReq("u1"), noReq("u2")].join("\n"), "main")).toBe(2);
	});

	it("counts records carrying neither requestId nor uuid separately, never as one", () => {
		const bare = JSON.stringify({
			type: "assistant",
			message: { usage: { input_tokens: 1 } },
		});
		expect(countTurns([bare, bare, bare].join("\n"), "main")).toBe(3);
	});

	it("ignores a turn whose usage sums to zero, as lastStandingContext does", () => {
		const zero = JSON.stringify({
			type: "assistant",
			requestId: "req_z",
			message: { usage: { output_tokens: 400 } },
		});
		expect(countTurns([response("req_a"), zero].join("\n"), "main")).toBe(1);
	});

	it("skips a sidechain turn on tier main and counts it on tier subagent", () => {
		const text = JSON.stringify({
			type: "assistant",
			isSidechain: true,
			requestId: "req_s",
			message: { usage: { input_tokens: 1 } },
		});
		expect(countTurns(text, "main")).toBe(0);
		expect(countTurns(text, "subagent")).toBe(1);
	});

	describe("turnRecords (mantahostels#2618, the seam a calibration reads)", () => {
		it("yields every record countTurns counts, keyed as it keys them", () => {
			const rows = [...turnRecords(response("req_a", 2), "main")];
			expect(rows.map((r) => r.key)).toEqual(["req:req_a", "req:req_a"]);
			expect(rows.map((r) => r.usage.cache_read_input_tokens)).toEqual([
				50_000, 50_000,
			]);
		});

		it("keys an unkeyed record null, which is what makes it count once alone", () => {
			const bare = JSON.stringify({
				type: "assistant",
				message: { usage: { input_tokens: 1 } },
			});
			expect([...turnRecords(bare, "main")].map((r) => r.key)).toEqual([null]);
		});

		it("agrees with countTurns on what to skip", () => {
			const zero = JSON.stringify({
				type: "assistant",
				requestId: "req_z",
				message: { usage: { output_tokens: 400 } },
			});
			const text = [response("req_a"), zero, '{"type":"user"}'].join("\n");
			expect(
				new Set([...turnRecords(text, "main")].map((r) => r.key)).size,
			).toBe(countTurns(text, "main"));
		});
	});
});
