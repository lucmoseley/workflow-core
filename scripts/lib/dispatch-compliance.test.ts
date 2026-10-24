// @vitest-environment node
/*
 * The measurement behind mantahostels#766 (is the 95% subagent-dispatch compliance rate
 * stable or novelty?). mantahostels#689 measured the same thing and kept no script, which
 * is why the re-measure had to reconstruct the method from prose. This module
 * is that script's testable core, so the next re-measure is one command.
 *
 * In-process on hand-built transcript rows, never the live corpus, so each
 * rate is checked against a known answer.
 *
 * CI's vitest step runs this file; measure-dispatch-compliance.js itself gates
 * nothing and is run by hand. A loosened case skews the rate it prints against
 * mantahostels#689's reference points, the figure an enforcement call on the
 * artefact rule rests on.
 */

import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const compliance: any = createRequire(__filename)("./dispatch-compliance.js");

/** One row of `groupByDay`'s output — the shape its JSDoc `@returns` declares. */
interface DaySummary {
	day: string;
	total: number;
	compliant: number;
	rate: number | null;
}

/** One transcript row carrying a single Agent dispatch. */
function dispatchRow(id: string, timestamp: string, prompt: string) {
	return JSON.stringify({
		timestamp,
		message: {
			content: [{ type: "tool_use", id, name: "Agent", input: { prompt } }],
		},
	});
}

/** Whether `summarise` counts one dispatch carrying `prompt` as compliant. */
const isCompliant = (prompt: unknown) =>
	compliance.summarise([{ timestamp: "2026-08-22T00:00:00Z", prompt }])
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
		const out = compliance.extractDispatches(rows);
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
		expect(compliance.extractDispatches([row])).toHaveLength(1);
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
		expect(compliance.extractDispatches([row])).toEqual([]);
	});

	it("skips unparseable lines rather than throwing, so one bad row cannot void a run", () => {
		const rows = [
			"{not json",
			"",
			dispatchRow("t1", "2026-08-21T10:00:00.000Z", "incrementally"),
		];
		expect(compliance.extractDispatches(rows)).toHaveLength(1);
	});

	it("skips rows whose content is not a list", () => {
		const row = JSON.stringify({
			timestamp: "2026-08-21T10:00:00.000Z",
			message: { content: "hi" },
		});
		expect(compliance.extractDispatches([row])).toEqual([]);
	});

	it("deduplicates by tool_use id, so a resumed transcript is not double-counted", () => {
		const a = dispatchRow("same", "2026-08-21T10:00:00.000Z", "incrementally");
		expect(compliance.extractDispatches([a, a])).toHaveLength(1);
	});
});

describe("summarise", () => {
	const mk = (id: string, timestamp: string, prompt: string) => ({
		id,
		timestamp,
		prompt,
	});

	it("reports the compliant share of the window", () => {
		const out = compliance.summarise([
			mk("a", "2026-08-21T10:00:00.000Z", "write incrementally"),
			mk("b", "2026-08-21T10:00:00.000Z", "no clause"),
			mk("c", "2026-08-21T10:00:00.000Z", "as they land"),
			mk("d", "2026-08-21T10:00:00.000Z", "nothing"),
		]);
		expect(out).toMatchObject({ total: 4, compliant: 2, rate: 0.5 });
	});

	it("excludes dispatches before `since`, which is how the landing-day spike is dropped", () => {
		const out = compliance.summarise(
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
		const out = compliance.summarise(
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
		expect(compliance.summarise(rows, { since: "2026-08-20" })).toMatchObject({
			total: 0,
		});
		expect(compliance.summarise(rows)).toMatchObject({ total: 1 });
	});

	it("excludes a dispatch landing exactly on `until`, the window being half-open", () => {
		const out = compliance.summarise(
			[mk("a", "2026-08-22T00:00:00.000Z", "incrementally")],
			{ until: "2026-08-22" },
		);
		expect(out).toMatchObject({ total: 0 });
	});

	it("includes a dispatch landing exactly on `since`, the window being closed at that end", () => {
		const out = compliance.summarise(
			[mk("a", "2026-08-20T00:00:00.000Z", "incrementally")],
			{ since: "2026-08-20" },
		);
		expect(out).toMatchObject({ total: 1 });
	});

	it("drops an unreadable timestamp under an upper bound alone, where no comparison would exclude it", () => {
		// Guards the explicit null check: with only `until` set, a NaN timestamp
		// compares false against it and would otherwise be counted silently.
		const out = compliance.summarise([mk("a", "not-a-date", "incrementally")], {
			until: "2026-08-22",
		});
		expect(out).toMatchObject({ total: 0 });
	});

	it("returns a null rate rather than dividing by zero on an empty window", () => {
		expect(compliance.summarise([], { since: "2026-08-20" })).toMatchObject({
			total: 0,
			rate: null,
		});
	});
});

describe("verdict", () => {
	it("holds the rule unenforced at or above the 80% threshold mantahostels#766 set", () => {
		expect(compliance.verdict(0.95).hold).toBe(true);
		expect(compliance.verdict(0.8).hold).toBe(true);
	});

	it("reopens enforcement below 80%", () => {
		expect(compliance.verdict(0.79).hold).toBe(false);
	});

	it("refuses a verdict on a null rate rather than guessing one", () => {
		expect(compliance.verdict(null).hold).toBe(null);
	});
});

describe("groupByDay", () => {
	const mk = (id: string, timestamp: string, prompt: string) => ({
		id,
		timestamp,
		prompt,
	});

	it("buckets by UTC day and summarises each", () => {
		const out = compliance.groupByDay([
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
		// The bug this guards: a prefix-compare on the date string disagreed with
		// summarise's Date.parse whenever `since` carried a time component.
		const rows = [
			mk("a", "2026-08-20T06:00:00.000Z", "incrementally"),
			mk("b", "2026-08-20T18:00:00.000Z", "incrementally"),
			mk("c", "2026-08-21T06:00:00.000Z", "none"),
		];
		const window = { since: "2026-08-20T12:00:00.000Z" };
		const headline = compliance.summarise(rows, window);
		const days = compliance.groupByDay(rows, window);
		const summed = days.reduce((n: number, d: DaySummary) => n + d.total, 0);
		expect(summed).toBe(headline.total);
		expect(headline.total).toBe(2);
	});

	it("returns an empty list when the window excludes everything", () => {
		expect(
			compliance.groupByDay([mk("a", "2026-08-19T10:00:00.000Z", "x")], {
				since: "2026-08-20",
			}),
		).toEqual([]);
	});
});

describe("readCorpusLines", () => {
	it("yields lines lazily, holding one file in memory at a time", () => {
		// The corpus is ~2 GB across ~1,950 files against a 4 GB heap cap, so
		// materialising every line at once is what this seam exists to avoid.
		const seen: string[] = [];
		const read = (name: string) => (name === "a" ? "1\n2" : "3");
		for (const line of compliance.readCorpusLines(["a", "b"], read))
			seen.push(line);
		expect(seen).toEqual(["1", "2", "3"]);
	});

	it("skips a file it cannot read and reports the count, rather than aborting the run", () => {
		const read = (name: string) => {
			if (name === "bad") throw new Error("EACCES");
			return "ok";
		};
		const stats = { unreadable: 0 };
		const seen = [...compliance.readCorpusLines(["bad", "good"], read, stats)];
		expect(seen).toEqual(["ok"]);
		expect(stats.unreadable).toBe(1);
	});
});
