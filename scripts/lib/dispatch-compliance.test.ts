// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
	extractDispatches,
	groupByDay,
	readCorpusLines,
	summarise,
	verdict,
} from "./dispatch-compliance.js";

interface DaySummary {
	day: string;
	total: number;
	compliant: number;
	rate: number | null;
}

function dispatchRow(id: string, timestamp: string, prompt: string) {
	return JSON.stringify({
		timestamp,
		message: {
			content: [{ type: "tool_use", id, name: "Agent", input: { prompt } }],
		},
	});
}

const isCompliant = (prompt: unknown) =>
	summarise([{ timestamp: "2026-08-22T00:00:00Z", prompt: prompt as string }])
		.compliant === 1;

describe("which prompts count as compliant", () => {
	it("matches each of the four phrases mantahostels#689 counted", () => {
		expect(isCompliant("write findings incrementally")).toBe(true);
		expect(isCompliant("append to the file as you go")).toBe(true);
		expect(isCompliant("record them as they land")).toBe(true);
		expect(isCompliant("append each finding to notes.md")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isCompliant("Write Incrementally")).toBe(true);
		expect(isCompliant("As They Land, append")).toBe(true);
	});

	it("does not match a prompt naming a path but no incremental write", () => {
		expect(isCompliant("read docs/doc-map.md and report back")).toBe(false);
	});

	it("treats a missing or non-string prompt as non-compliant, never throwing", () => {
		expect(isCompliant(undefined)).toBe(false);
		expect(isCompliant(null)).toBe(false);
		expect(isCompliant(42)).toBe(false);
	});
});

describe("extractDispatches", () => {
	it("pulls Agent and Task tool_use blocks with their timestamp", () => {
		const rows = [
			dispatchRow("t1", "2026-08-21T10:00:00.000Z", "do it incrementally"),
			dispatchRow("t2", "2026-08-21T11:00:00.000Z", "just report"),
		];
		const out = extractDispatches(rows);
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({
			id: "t1",
			timestamp: "2026-08-21T10:00:00.000Z",
		});
		expect(out[0].prompt).toBe("do it incrementally");
	});

	it("counts a Task dispatch too, the older spelling of the same tool", () => {
		const row = JSON.stringify({
			timestamp: "2026-08-21T10:00:00.000Z",
			message: {
				content: [
					{
						type: "tool_use",
						id: "t9",
						name: "Task",
						input: { prompt: "as you go" },
					},
				],
			},
		});
		expect(extractDispatches([row])).toHaveLength(1);
	});

	it("ignores tool_use blocks for other tools", () => {
		const row = JSON.stringify({
			timestamp: "2026-08-21T10:00:00.000Z",
			message: {
				content: [
					{ type: "tool_use", id: "r1", name: "Read", input: { prompt: "x" } },
				],
			},
		});
		expect(extractDispatches([row])).toEqual([]);
	});

	it("skips unparseable lines rather than throwing, so one bad row cannot void a run", () => {
		const rows = [
			"{not json",
			"",
			dispatchRow("t1", "2026-08-21T10:00:00.000Z", "incrementally"),
		];
		expect(extractDispatches(rows)).toHaveLength(1);
	});

	it("skips rows whose content is not a list", () => {
		const row = JSON.stringify({
			timestamp: "2026-08-21T10:00:00.000Z",
			message: { content: "hi" },
		});
		expect(extractDispatches([row])).toEqual([]);
	});

	it("deduplicates by tool_use id, so a resumed transcript is not double-counted", () => {
		const a = dispatchRow("same", "2026-08-21T10:00:00.000Z", "incrementally");
		expect(extractDispatches([a, a])).toHaveLength(1);
	});
});

describe("summarise", () => {
	const mk = (id: string, timestamp: string, prompt: string) => ({
		id,
		timestamp,
		prompt,
	});

	it("reports the compliant share of the window", () => {
		const out = summarise([
			mk("a", "2026-08-21T10:00:00.000Z", "write incrementally"),
			mk("b", "2026-08-21T10:00:00.000Z", "no clause"),
			mk("c", "2026-08-21T10:00:00.000Z", "as they land"),
			mk("d", "2026-08-21T10:00:00.000Z", "nothing"),
		]);
		expect(out).toMatchObject({ total: 4, compliant: 2, rate: 0.5 });
	});

	it("excludes dispatches before `since`, which is how the landing-day spike is dropped", () => {
		const out = summarise(
			[
				mk("a", "2026-08-19T10:00:00.000Z", "incrementally"),
				mk("b", "2026-08-21T10:00:00.000Z", "incrementally"),
				mk("c", "2026-08-21T10:00:00.000Z", "none"),
			],
			{ since: "2026-08-20" },
		);
		expect(out).toMatchObject({ total: 2, compliant: 1 });
	});

	it("excludes dispatches on or after `until`, so a window is half-open", () => {
		const out = summarise(
			[
				mk("a", "2026-08-21T10:00:00.000Z", "incrementally"),
				mk("b", "2026-08-23T10:00:00.000Z", "incrementally"),
			],
			{ until: "2026-08-22" },
		);
		expect(out).toMatchObject({ total: 1 });
	});

	it("drops a dispatch with an unreadable timestamp when a window is set, and counts it when none is", () => {
		const rows = [mk("a", "not-a-date", "incrementally")];
		expect(summarise(rows, { since: "2026-08-20" })).toMatchObject({
			total: 0,
		});
		expect(summarise(rows)).toMatchObject({ total: 1 });
	});

	it("excludes a dispatch landing exactly on `until`, the window being half-open", () => {
		const out = summarise(
			[mk("a", "2026-08-22T00:00:00.000Z", "incrementally")],
			{ until: "2026-08-22" },
		);
		expect(out).toMatchObject({ total: 0 });
	});

	it("includes a dispatch landing exactly on `since`, the window being closed at that end", () => {
		const out = summarise(
			[mk("a", "2026-08-20T00:00:00.000Z", "incrementally")],
			{ since: "2026-08-20" },
		);
		expect(out).toMatchObject({ total: 1 });
	});

	it("drops an unreadable timestamp under an upper bound alone, where no comparison would exclude it", () => {
		const out = summarise([mk("a", "not-a-date", "incrementally")], {
			until: "2026-08-22",
		});
		expect(out).toMatchObject({ total: 0 });
	});

	it("returns a null rate rather than dividing by zero on an empty window", () => {
		expect(summarise([], { since: "2026-08-20" })).toMatchObject({
			total: 0,
			rate: null,
		});
	});
});

describe("verdict", () => {
	it("holds the rule unenforced at or above the 80% threshold mantahostels#766 set", () => {
		expect(verdict(0.95).hold).toBe(true);
		expect(verdict(0.8).hold).toBe(true);
	});

	it("reopens enforcement below 80%", () => {
		expect(verdict(0.79).hold).toBe(false);
	});

	it("refuses a verdict on a null rate rather than guessing one", () => {
		expect(verdict(null).hold).toBe(null);
	});
});

describe("groupByDay", () => {
	const mk = (id: string, timestamp: string, prompt: string) => ({
		id,
		timestamp,
		prompt,
	});

	it("buckets by UTC day and summarises each", () => {
		const out = groupByDay([
			mk("a", "2026-08-20T10:00:00.000Z", "incrementally"),
			mk("b", "2026-08-20T23:59:59.000Z", "none"),
			mk("c", "2026-08-21T00:00:00.000Z", "as they land"),
		]);
		expect(out.map((d: DaySummary) => d.day)).toEqual([
			"2026-08-20",
			"2026-08-21",
		]);
		expect(out[0]).toMatchObject({ total: 2, compliant: 1 });
		expect(out[1]).toMatchObject({ total: 1, compliant: 1 });
	});

	it("applies the SAME window filter as summarise, so the days always sum to the headline", () => {
		const rows = [
			mk("a", "2026-08-20T06:00:00.000Z", "incrementally"),
			mk("b", "2026-08-20T18:00:00.000Z", "incrementally"),
			mk("c", "2026-08-21T06:00:00.000Z", "none"),
		];
		const window = { since: "2026-08-20T12:00:00.000Z" };
		const headline = summarise(rows, window);
		const days = groupByDay(rows, window);
		const summed = days.reduce((n: number, d: DaySummary) => n + d.total, 0);
		expect(summed).toBe(headline.total);
		expect(headline.total).toBe(2);
	});

	it("returns an empty list when the window excludes everything", () => {
		expect(
			groupByDay([mk("a", "2026-08-19T10:00:00.000Z", "x")], {
				since: "2026-08-20",
			}),
		).toEqual([]);
	});
});

describe("readCorpusLines", () => {
	it("yields lines lazily, holding one file in memory at a time", () => {
		const seen: string[] = [];
		const read = (name: string) => (name === "a" ? "1\n2" : "3");
		for (const line of readCorpusLines(["a", "b"], read)) seen.push(line);
		expect(seen).toEqual(["1", "2", "3"]);
	});

	it("skips a file it cannot read and reports the count, rather than aborting the run", () => {
		const read = (name: string) => {
			if (name === "bad") throw new Error("EACCES");
			return "ok";
		};
		const stats = { unreadable: 0 };
		const seen = [...readCorpusLines(["bad", "good"], read, stats)];
		expect(seen).toEqual(["ok"]);
		expect(stats.unreadable).toBe(1);
	});
});
