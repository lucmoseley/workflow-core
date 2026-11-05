// @vitest-environment node
/*
 * Pins pick-next's accounting of a run (#4329): why each frontier issue
 * outside the set did not launch (#591), the open-issue tally, the
 * DISPATCHABLE FLOOR (mantahostels#1507), the band no command opens
 * (mantahostels#1626), and the §6 summary's figures (mantahostels#1001,
 * mantahostels#3363).
 *
 * Loosen a case and §5's accounting line stops summing, or §6 is written off
 * a figure the run never decided.
 */
import { describe, expect, it } from "vitest";

const {
	dispatchableFloorOf,
	noCommandOf,
	notLaunchedOf,
	notProposedLines,
	openTallyOf,
	summaryOf,
} = require("./pick-next-accounting.js");

const issue = (number: number, takes: string[] = ["implement"]) => ({
	number,
	takes,
});
const graph = (over: Record<string, unknown> = {}) => ({
	proposed: [],
	dropped: [],
	mergeable: [],
	candidates: [],
	nominated: [],
	...over,
});
const launchState = (over: Record<string, unknown> = {}) => ({
	frontier: [],
	graph: graph(),
	admission: { freeSlots: 10, admit: true },
	noCommand: [],
	retroBundles: [],
	...over,
});
const reasons = (rows: { number: number; reason: string }[]) =>
	Object.fromEntries(rows.map((r) => [r.number, r.reason]));

describe("why a frontier issue did not launch (#591)", () => {
	it("cuts the set below the slot count as no admission slot", () => {
		const rows = notLaunchedOf(
			launchState({
				frontier: [1, 2, 3, 4, 5].map((n) => issue(n)),
				graph: graph({ proposed: [1, 2, 3, 4, 5] }),
				admission: { freeSlots: 2, admit: true },
			}),
		);
		expect(reasons(rows)).toEqual({
			3: "no admission slot",
			4: "no admission slot",
			5: "no admission slot",
		});
		expect(rows[0].detail).toEqual({ slots: 2, freeSlots: 2 });
	});

	it("gives an issue matching two reasons the earlier one", () => {
		const rows = notLaunchedOf(
			launchState({
				frontier: [issue(1, ["human"])],
				graph: graph({
					dropped: [
						{
							number: 1,
							kind: "held",
							paths: ["scripts/held.js"],
							heldBy: "worker",
							sessionId: "worker",
						},
					],
				}),
				noCommand: [1],
			}),
		);
		expect(reasons(rows)).toEqual({ 1: "no command" });
	});

	it("counts an issue merged into a set member's line as launched", () => {
		const rows = notLaunchedOf(
			launchState({
				frontier: [issue(1), issue(2)],
				graph: graph({
					proposed: [1],
					dropped: [
						{ number: 2, kind: "clash", with: 1, paths: ["scripts/a.js"] },
					],
					mergeable: [{ a: 1, b: 2 }],
				}),
			}),
		);
		expect(rows).toEqual([]);
	});

	it("lists a dropped issue whose mergeable partner is not the one it clashed with", () => {
		// #3 clashes with #1 on a.js; its merge pair is with #2 on b.js, so
		// nothing carries it.
		const rows = notLaunchedOf(
			launchState({
				frontier: [issue(1), issue(2), issue(3)],
				graph: graph({
					proposed: [1, 2],
					dropped: [
						{ number: 3, kind: "clash", with: 1, paths: ["scripts/a.js"] },
					],
					mergeable: [{ a: 2, b: 3 }],
				}),
			}),
		);
		expect(rows).toEqual([
			{
				number: 3,
				reason: "shares a file",
				detail: { with: 1, file: "scripts/a.js", provisional: true },
			},
		]);
	});

	it("launches retro findings as bundles, one slot each (#1105)", () => {
		const bundles = [
			[10, 11, 12, 13, 14],
			[15, 16, 17, 18],
		];
		const frontier = [...bundles.flat(), 30].map((n) => issue(n, ["triage"]));
		const g = graph({ proposed: [30] });
		// Two bundles plus the lone non-retro issue: three slots, none short.
		expect(
			notLaunchedOf(
				launchState({
					frontier,
					graph: g,
					admission: { freeSlots: 3, admit: true },
					retroBundles: bundles.map((issues) => ({ issues })),
				}),
			),
		).toEqual([]);
		expect(dispatchableFloorOf(g, frontier, bundles)).toBe(3);
	});
});

describe("the DISPATCHABLE FLOOR (mantahostels#1507)", () => {
	it("counts proposed members minus takes:human and takes:children", () => {
		const frontier = [issue(1), issue(2, ["human"]), issue(3, ["children"])];
		expect(
			dispatchableFloorOf(graph({ proposed: [1, 2, 3] }), frontier, []),
		).toBe(1);
	});
});

describe("the open-issue tally (#591)", () => {
	it("tallies the gated, dispatched and degraded categories too", () => {
		const enriched = [
			{ number: 1, excluded: null },
			{ number: 2, excluded: "gated until 2026-11-14 (9d) — later" },
			{ number: 3, excluded: "dispatched 0.1h ago — /implement 3" },
			{ number: 4, excluded: "readiness unknown — HTTP 502" },
		];
		const tally = openTallyOf({ enriched, frontier: [enriched[0]] });
		const count = (name: string) =>
			tally.categories.find((c: { category: string }) => c.category === name);
		expect(count("gated")).toEqual({
			category: "gated",
			count: 1,
			numbers: [2],
		});
		expect(count("already dispatched")).toEqual({
			category: "already dispatched",
			count: 1,
			numbers: [3],
		});
		expect(count("degraded")).toEqual({
			category: "degraded",
			count: 1,
			numbers: [4],
		});
		expect(tally.frontier).toBe(1);
	});
});

describe("the band no command opens (mantahostels#1626)", () => {
	it("counts a takes:human issue, which no /-command opens", () => {
		const r = noCommandOf([issue(1), issue(2, ["human"])], new Map());
		expect(r.noCommand.map((i: { number: number }) => i.number)).toEqual([2]);
	});

	it("names no rotted container where the band is takes:human alone", () => {
		const r = noCommandOf([issue(1), issue(2, ["human"])], new Map());
		expect(r.rottedContainers).toEqual([]);
	});

	it("counts a takes:children container whose last child has closed", () => {
		const r = noCommandOf([issue(1), issue(2, ["children"])], new Map());
		expect(r.noCommand.map((i: { number: number }) => i.number)).toEqual([2]);
		expect(r.rottedContainers).toEqual([2]);
	});

	it("counts nothing for a container still holding an open child", () => {
		const r = noCommandOf([issue(1, ["children"])], new Map([[1, 1]]));
		expect(r).toEqual({ noCommand: [], rottedContainers: [] });
	});
});

describe("the §6 summary (mantahostels#1001)", () => {
	const run = (over: Record<string, unknown> = {}) =>
		summaryOf({
			enriched: [],
			frontier: [],
			shown: [],
			admission: { admit: true, freeSlots: 1 },
			reclaimable: { ok: true, count: 0 },
			cacheState: { warm: [], provisional: [], cold: [] },
			graph: graph(),
			degraded: [],
			dispatched: { why: null },
			debts: { ok: true, count: 0 },
			stranded: { ok: true, stranded: 0, carrying: null, strandedWorktrees: 0 },
			noCommandCount: 0,
			rottedContainers: [],
			...over,
		});

	it("names the frontier issues whose takes: label is missing or doubled", () => {
		const frontier = [
			issue(1, []),
			issue(2, ["implement", "triage"]),
			issue(3),
		];
		expect(run({ frontier, shown: frontier }).labelDefects).toEqual([
			{ number: 1, takes: [] },
			{ number: 2, takes: ["implement", "triage"] },
		]);
	});

	it("reports a label defect on a frontier issue --limit cut from the table (mantahostels#3363)", () => {
		const frontier = [issue(1), issue(2, [])];
		const s = run({ frontier, shown: frontier.slice(0, 1) });
		expect(s.shown).toBe(1);
		expect(s.labelDefects).toEqual([{ number: 2, takes: [] }]);
	});

	it("gives each proposed member the takes: value and write-set §6's line needs", () => {
		const frontier = [issue(1)];
		const s = run({
			frontier,
			shown: frontier,
			graph: graph({
				proposed: [1],
				candidates: [{ number: 1, writeSet: ["scripts/a.js"] }],
			}),
		});
		expect(s.proposed).toEqual([
			{ number: 1, takes: ["implement"], writeSet: ["scripts/a.js"] },
		]);
	});

	it("gives a proposed member its takes: value even below the --limit cut (mantahostels#3363)", () => {
		const frontier = [issue(1), issue(2, ["to-spec"])];
		const s = run({
			frontier,
			shown: frontier.slice(0, 1),
			graph: graph({
				proposed: [1, 2],
				candidates: [
					{ number: 1, writeSet: ["scripts/a.js"] },
					{ number: 2, writeSet: ["scripts/b.js"] },
				],
			}),
		});
		expect(s.shown).toBe(1);
		expect(s.proposed).toEqual([
			{ number: 1, takes: ["implement"], writeSet: ["scripts/a.js"] },
			{ number: 2, takes: ["to-spec"], writeSet: ["scripts/b.js"] },
		]);
	});

	it("reports a failed reclaimable probe as unknown, never as zero", () => {
		const s = run({ reclaimable: { ok: false, error: "oracle refused" } });
		expect(s.reclaimable).toBeNull();
		expect(s.reclaimableUnknown).toBe("oracle refused");
	});
});

describe("the NOT PROPOSED lines (#4382)", () => {
	const row = (number: number, reason: string, detail: object) => ({
		number,
		reason,
		detail,
	});

	it("prints a no-admission-slot row's slot count, or unknown where admission read none", () => {
		const out = notProposedLines([
			row(3, "no admission slot", { slots: 2, freeSlots: 2 }),
			row(4, "no admission slot", { slots: 1, freeSlots: null }),
		]);
		expect(out).toContain("    #3  2 slot(s), as of this run");
		expect(out).toContain("    #4  free slots unknown, as of this run");
	});

	it("caps the printed block, grouped by reason in precedence order", () => {
		const rows = [
			row(99, "no admission slot", { slots: 0, freeSlots: 0 }),
			...Array.from({ length: 25 }, (_, n) =>
				row(n + 1, "no command", { takes: ["human"] }),
			),
		];
		const out = notProposedLines(rows);
		expect(out[0]).toMatch(/^\nNOT PROPOSED \(26\) — /);
		expect(out.filter((l: string) => l === "  no command:")).toHaveLength(1);
		expect(
			out.filter((l: string) => /^ {4}#\d+ {2}human$/.test(l)),
		).toHaveLength(20);
		expect(out).not.toContain("  no admission slot:");
		expect(out.at(-1)).toBe("  ... and 6 more — --json carries every one.");
	});

	it("prints none where every frontier issue is in the set", () => {
		expect(notProposedLines([]).slice(1)).toEqual(["  none"]);
		expect(
			notProposedLines([row(1, "no command", { takes: [] })]),
		).not.toContain("  none");
	});
});
