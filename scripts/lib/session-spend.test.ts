// @vitest-environment node
/*
 * session-spend.js: pricing a transcript, the conditional remainder off the
 * cost table, and which listed sessions count as running on this seat (#372,
 * #1197).
 *
 * In-process, over JSONL transcripts and project trees written to a temp dir,
 * with a hand-built cost table, so no case reads this machine's sessions or
 * moves with the committed table — bar one case that reads the committed table
 * on purpose.
 *
 * `allowance.js` sizes `/pick-next`'s capped launch in `dispatch-sessions.sh`
 * from these figures; loosen a case and a mispriced spend launches a set past
 * the usage bar, or cuts one that would have fitted.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	fileSpend,
	LIST_PRICES,
	landedShare,
	readCostTable,
	readSessionSpendEvents,
	runningRemainders,
	sessionSpendUsd,
} from "./session-spend";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-spend-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const turn = (
	requestId: string,
	model: string,
	usage: Record<string, unknown>,
) =>
	JSON.stringify({ type: "assistant", requestId, message: { model, usage } });

const table = {
	meanUsd: 3,
	quantilesUsd: [0, 1, 2, 4, 8],
	tailRemainderUsd: 3,
	landedByHours: [
		[1, 0.6],
		[3, 1],
	] as [number, number][],
};

/** The window a listed session with no transcript yet counts as just
 *  launched (#371 item 6), spelled here rather than imported. */
const FRESH_LAUNCH_MS = 10 * 60 * 1000;

describe("sessionSpendUsd", () => {
	it("prices each field at its model's rate, keeping the max per requestId", () => {
		const file = path.join(dir, "s.jsonl");
		fs.writeFileSync(
			file,
			[
				// A streamed turn logged twice: the second, larger output wins.
				turn("r1", "claude-opus-5-5", { output_tokens: 100_000 }),
				turn("r1", "claude-opus-5-5", { output_tokens: 200_000 }),
				turn("r2", "claude-sonnet-5", {
					input_tokens: 1_000_000,
					cache_creation_input_tokens: 1_000_000,
					cache_read_input_tokens: 1_000_000,
				}),
				turn("r3", "claude-haiku-4-5", { output_tokens: 1_000_000 }),
				'{"type":"user"}',
				"not json",
			].join("\n"),
		);
		// opus 0.2M out × $20 = 4; sonnet 2 + 2.5 + 0.2 = 4.7; haiku unpriced.
		expect(sessionSpendUsd(file)).toBeCloseTo(8.7, 6);
	});

	it("adds the session's subagent transcripts", () => {
		const file = path.join(dir, "s.jsonl");
		fs.writeFileSync(
			file,
			turn("r1", "claude-sonnet-5", { output_tokens: 100_000 }),
		);
		fs.mkdirSync(path.join(dir, "s", "subagents"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "s", "subagents", "agent-a.jsonl"),
			turn("r1", "claude-sonnet-5", { output_tokens: 100_000 }),
		);
		fs.writeFileSync(
			path.join(dir, "s", "subagents", "other.jsonl"),
			turn("r9", "claude-sonnet-5", { output_tokens: 100_000 }),
		);
		expect(sessionSpendUsd(file)).toBeCloseTo(2, 6);
	});
});

describe("fileSpend", () => {
	const assistantAt = (requestId: string, model: string, timestamp: string) =>
		JSON.stringify({
			type: "assistant",
			requestId,
			timestamp,
			message: { model, usage: { output_tokens: 1_000_000 } },
		});

	it("counts only records inside the window, and counts unpriced ones", () => {
		const file = path.join(dir, "s.jsonl");
		fs.writeFileSync(
			file,
			[
				assistantAt("r1", "claude-sonnet-5", "2026-09-26T00:00:00Z"),
				assistantAt("r2", "claude-sonnet-5", "2026-09-26T02:00:00Z"),
				assistantAt("r3", "claude-fable-5-1", "2026-09-26T00:30:00Z"),
				// Zero tokens: nothing left out, so not counted as unpriced.
				JSON.stringify({
					type: "assistant",
					requestId: "r4",
					timestamp: "2026-09-26T00:30:00Z",
					message: { model: "<synthetic>", usage: { output_tokens: 0 } },
				}),
			].join("\n"),
		);
		const window = {
			fromMs: Date.parse("2026-09-26T00:00:00Z"),
			toMs: Date.parse("2026-09-26T01:00:00Z"),
		};
		expect(fileSpend(file, { window })).toEqual({ usd: 10, unpriced: 1 });
		expect(fileSpend(file, { window, prices: LIST_PRICES })).toEqual({
			usd: 60,
			unpriced: 0,
		});
	});

	it("prices Opus 5.5 at its own rate, not Opus 5's, under the list table", () => {
		const file = path.join(dir, "s.jsonl");
		fs.writeFileSync(
			file,
			[
				assistantAt("r1", "claude-opus-5-5", "2026-09-26T00:00:00Z"),
				assistantAt("r2", "claude-opus-5", "2026-09-26T00:00:00Z"),
			].join("\n"),
		);
		expect(fileSpend(file, { prices: LIST_PRICES }).usd).toBeCloseTo(45, 6);
	});

	it("prices each cache write at its own TTL, the max of each across a requestId's records", () => {
		const file = path.join(dir, "s.jsonl");
		const split = (m5: number, h1: number) => ({
			cache_creation_input_tokens: m5 + h1,
			cache_creation: {
				ephemeral_5m_input_tokens: m5,
				ephemeral_1h_input_tokens: h1,
			},
		});
		fs.writeFileSync(
			file,
			[
				turn("r1", "claude-opus-5-5", split(0, 500_000)),
				turn("r1", "claude-opus-5-5", split(1_000_000, 1_000_000)),
			].join("\n"),
		);
		// 1M × $5 (5-minute) + 1M × $8 (1-hour).
		expect(fileSpend(file).usd).toBeCloseTo(13, 6);
	});

	it("prices a write with no split at the 5-minute rate", () => {
		const file = path.join(dir, "s.jsonl");
		fs.writeFileSync(
			file,
			turn("r1", "claude-opus-5-5", { cache_creation_input_tokens: 1_000_000 }),
		);
		expect(fileSpend(file).usd).toBeCloseTo(5, 6);
	});
});

describe("the conditional remainder a working session is charged", () => {
	/** A working session that has spent `usd` on Sonnet output ($10 a million
	 *  tokens), and the remainder `runningRemainders` charges it. */
	const remainderAfter = (usd: number) => {
		const p = path.join(dir, "projects", "-repo");
		fs.mkdirSync(p, { recursive: true });
		fs.writeFileSync(
			path.join(p, "a.jsonl"),
			usd > 0
				? turn("r1", "claude-sonnet-5", { output_tokens: usd * 100_000 })
				: "",
		);
		const [r] = runningRemainders({
			agents: [{ sessionId: "a", state: "working" }],
			table,
			configDir: dir,
		});
		expect(r.spentUsd).toBeCloseTo(usd, 6);
		return r.remainderUsd;
	};

	it("is the mean for a session that has spent nothing", () => {
		expect(remainderAfter(0)).toBe(3);
	});

	it("averages the gap to every quantile above the spend, the top one standing at the tail's mean, never flooring at zero", () => {
		// The top point stands at u 4 + tail 3 = 7, not the maximum 8. Above
		// 3: 4 and 7 → gaps 1 and 4.
		expect(remainderAfter(3)).toBe(2.5);
		// Past the median a session is not read as finished.
		expect(remainderAfter(2)).toBe(3.5);
	});

	it("charges the tail's measured remainder at or past the second-highest quantile, however far past (#2925)", () => {
		expect(remainderAfter(4)).toBe(3);
		expect(remainderAfter(7.9)).toBe(3);
		expect(remainderAfter(50)).toBe(3);
	});
});

describe("landedShare (#2925)", () => {
	it("is none at or before now", () => {
		expect(landedShare(table, 0)).toBe(0);
		expect(landedShare(table, -2)).toBe(0);
	});

	it("reads between marks by straight lines from (0, 0)", () => {
		expect(landedShare(table, 0.5)).toBeCloseTo(0.3, 9);
		expect(landedShare(table, 1)).toBeCloseTo(0.6, 9);
		expect(landedShare(table, 2)).toBeCloseTo(0.8, 9);
	});

	it("holds the last mark's share past it", () => {
		expect(landedShare(table, 200)).toBe(1);
	});
});

describe("readSessionSpendEvents", () => {
	it("prices each request at its first record's time, in time order, an unstamped one first", () => {
		const main = path.join(dir, "s.jsonl");
		const at = (rid: string, timestamp: string | null, output: number) =>
			JSON.stringify({
				type: "assistant",
				requestId: rid,
				...(timestamp ? { timestamp } : {}),
				message: {
					model: "claude-sonnet-5",
					usage: { output_tokens: output },
				},
			});
		fs.writeFileSync(
			main,
			[
				at("late", "2026-10-25T10:00:00Z", 100_000),
				at("early", "2026-10-25T09:00:00Z", 100_000),
				at("early", "2026-10-25T09:30:00Z", 200_000),
				at("bare", null, 300_000),
			].join("\n"),
		);
		const events = readSessionSpendEvents(main);
		expect(events.map((e) => e.usd)).toEqual([3, 2, 1]);
		expect(events[0]?.atMs).toBeNaN();
		expect(events[1]?.atMs).toBe(Date.parse("2026-10-25T09:00:00Z"));
		expect(events.reduce((s, e) => s + e.usd, 0)).toBeCloseTo(
			sessionSpendUsd(main),
			9,
		);
	});
});

describe("readCostTable", () => {
	it("reads the committed table", () => {
		const t = readCostTable();
		expect(t?.meanUsd).toBeGreaterThan(0);
		expect(t?.quantilesUsd.length).toBeGreaterThanOrEqual(2);
	});

	it("is null for a missing or malformed file", () => {
		expect(readCostTable(path.join(dir, "none.json"))).toBeNull();
		const bad = path.join(dir, "bad.json");
		fs.writeFileSync(bad, JSON.stringify({ ...table, quantilesUsd: [1] }));
		expect(readCostTable(bad)).toBeNull();
		const { tailRemainderUsd: _, ...noTail } = table;
		fs.writeFileSync(bad, JSON.stringify(noTail));
		expect(readCostTable(bad)).toBeNull();
		fs.writeFileSync(bad, JSON.stringify({ ...table, landedByHours: [[1]] }));
		expect(readCostTable(bad)).toBeNull();
	});
});

describe("runningRemainders", () => {
	const now = 10 * FRESH_LAUNCH_MS;
	const project = () => {
		const p = path.join(dir, "projects", "-repo");
		fs.mkdirSync(p, { recursive: true });
		return p;
	};

	it("reads a working session's own transcript for its conditional remainder", () => {
		fs.writeFileSync(
			path.join(project(), "a.jsonl"),
			turn("r1", "claude-sonnet-5", { output_tokens: 300_000 }),
		);
		const r = runningRemainders({
			agents: [{ sessionId: "a", state: "working" }],
			table,
			configDir: dir,
			now,
		});
		expect(r).toEqual([{ sessionId: "a", spentUsd: 3, remainderUsd: 2.5 }]);
	});

	it("skips terminal sessions, which spend nothing more", () => {
		fs.writeFileSync(path.join(project(), "a.jsonl"), "");
		const agents = ["done", "failed", "stopped"].map((state) => ({
			sessionId: "a",
			state,
		}));
		expect(runningRemainders({ agents, table, configDir: dir, now })).toEqual(
			[],
		);
	});

	it("charges a just-launched session with no transcript the full mean", () => {
		const r = runningRemainders({
			agents: [
				{ sessionId: "new", state: "working", startedAt: now - 1000 },
				{ sessionId: "unstamped", state: "working" },
			],
			table,
			configDir: dir,
			now,
		});
		expect(r.map((x) => [x.sessionId, x.remainderUsd])).toEqual([
			["new", 3],
			["unstamped", 3],
		]);
	});

	it("still counts a session started exactly ten minutes ago as just launched", () => {
		const r = runningRemainders({
			agents: [
				{
					sessionId: "edge",
					state: "working",
					startedAt: now - FRESH_LAUNCH_MS,
				},
			],
			table,
			configDir: dir,
			now,
		});
		expect(r.map((x) => x.sessionId)).toEqual(["edge"]);
	});

	it("skips an older session with no transcript here, which spends another seat", () => {
		const r = runningRemainders({
			agents: [
				{
					sessionId: "elsewhere",
					state: "working",
					startedAt: now - FRESH_LAUNCH_MS - 1,
				},
			],
			table,
			configDir: dir,
			now,
		});
		expect(r).toEqual([]);
	});
});
