// @vitest-environment node
/*
 * report-cost-per-unit.js — the cost-per-unit-of-work reading, reported and
 * never triggered on (mantahostels#1740), so what its tests guard is arithmetic
 * and loss: the two exclusions mantahostels#1737 settled are applied, GitHub's
 * silent 1,000-result truncation is declared rather than swallowed, and a
 * write to the series appends rather than rewriting, so a parallel session's
 * row is never lost (mantahostels#2880), save a re-reading of a day the series
 * holds, which replaces that day's row.
 *
 * Nothing triggers on the figure, so a wrong one is read as real and a lost
 * row is never missed; this test fails CI when red.
 *
 * Each case runs the command in-process against a throwaway host root, its
 * `gh` stubbed at WFC_GH, so nothing here reaches the network or the tracked
 * series.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "report-cost-per-unit.js");
const SERIES_LABEL = "docs/data/cost-per-unit.jsonl";
const USAGE = "usage: node scripts/report-cost-per-unit.js";
/* The search cap the script asks `gh` for, restated so a day served at it
 * reads as truncated. */
const SEARCH_CAP = 1000;

interface Close {
	number: number;
	stateReason: string;
	labels: { name: string }[];
}
interface Row {
	taken: string;
	from: string;
	to: string;
	total: number;
	notPlanned: number;
	children: number;
	counted: number;
	bill: number;
	seats: number;
	costPerUnit: number | null;
	truncated: string[];
}

/**
 * A day of `total` closes, `counted` of them counted. The excluded remainder is
 * split across BOTH exclusions rather than all landing on `takes:children`:
 * with `not planned` pinned at 0 its roll-up could be mutated away with the
 * suite green.
 */
const closes = (total: number, counted = total): Close[] => {
	const notPlanned = Math.floor((total - counted) / 2);
	return Array.from({ length: total }, (_, i): Close => {
		if (i < counted) return { number: i, stateReason: "COMPLETED", labels: [] };
		if (i < counted + notPlanned)
			return { number: i, stateReason: "NOT_PLANNED", labels: [] };
		return {
			number: i,
			stateReason: "COMPLETED",
			labels: [{ name: "takes:children" }],
		};
	});
};

const roots: string[] = [];
afterEach(() => {
	for (const r of roots.splice(0))
		fs.rmSync(r, { recursive: true, force: true });
});

/**
 * One run of the command. `series` seeds the host's series file line by line
 * (null: no file); `gh` serves each day its own closes, `daily` serving every
 * day it does not name — verbatim where it is a string.
 */
const run = (
	argv: string[],
	{
		today = "2026-09-11",
		series = null as string[] | null,
		daily = closes(100, 50) as Close[] | string,
		gh = {} as Record<string, Close[]>,
	} = {},
) => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "cost-per-unit-"));
	roots.push(root);
	const file = path.join(root, ...SERIES_LABEL.split("/"));
	if (series) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, `${series.join("\n")}\n`);
	}
	const served = path.join(root, "served");
	fs.mkdirSync(served);
	fs.writeFileSync(
		path.join(served, "default.json"),
		typeof daily === "string" ? daily : JSON.stringify(daily),
	);
	for (const [date, rows] of Object.entries(gh))
		fs.writeFileSync(path.join(served, `${date}.json`), JSON.stringify(rows));
	const log = path.join(root, "gh-argv.log");
	const stub = path.join(root, "gh");
	fs.writeFileSync(
		stub,
		[
			"#!/bin/sh",
			`printf '%s\\n' "$*" >> '${log}'`,
			`d=$(printf '%s\\n' "$@" | sed -n 's/^closed://p')`,
			`f='${served}'/"$d.json"; [ -f "$f" ] || f='${served}/default.json'`,
			'cat "$f"',
			"",
		].join("\n"),
		{ mode: 0o755 },
	);
	const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
	const r = runInProcess(SCRIPT, argv, {
		cwd: root,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: root,
			WFC_GH: stub,
			COST_TODAY: today,
		},
	});
	const after = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
	return {
		code: r.status,
		out: r.stdout + r.stderr,
		before,
		after,
		/* Every line that parses, the seeded ones included. */
		rows: (after ?? "")
			.split("\n")
			.flatMap((l) => {
				try {
					return [JSON.parse(l)];
				} catch {
					return [];
				}
			})
			.filter((x) => x && typeof x === "object" && "taken" in x) as Row[],
		ghCalls: fs.existsSync(log)
			? fs.readFileSync(log, "utf8").split("\n").filter(Boolean)
			: [],
	};
};

/** The row a due reading on `today` appends. */
const appended = (opts: Parameters<typeof run>[1] = {}) => {
	const r = run([], opts);
	expect(r.code).toBe(0);
	const row = r.rows.at(-1);
	if (!row) throw new Error(`no row appended:\n${r.out}`);
	return { ...r, row };
};

const logLine = (taken: string, counted: number) =>
	JSON.stringify({ taken, counted, bill: 600, seats: 3 });
const seeded = [logLine("2026-09-04", 2554)];

describe("the window", () => {
	it("is 30 complete UTC days ending yesterday, one query a day", () => {
		const { row, ghCalls } = appended({ today: "2026-08-28" });
		expect([row.from, row.to]).toEqual(["2026-07-29", "2026-08-27"]);
		const dates = ghCalls.map((c) => c.match(/closed:(\S+)/)?.[1]);
		expect(dates).toHaveLength(30);
		expect([dates[0], dates.at(-1)]).toEqual(["2026-07-29", "2026-08-27"]);
		// Today is excluded: a partial day would drag the mean down by the hour.
		expect(dates).not.toContain("2026-08-28");
	});
});

describe("the reading", () => {
	it("divides the standing bill by the filtered count", () => {
		const { row, out } = appended();
		expect([row.counted, row.total]).toEqual([30 * 50, 30 * 100]);
		expect(row.costPerUnit).toBeCloseTo(600 / (30 * 50), 10);
		expect(out).toContain(
			"1,500 units, $0.400/unit at $600/month across 3 seats",
		);
	});

	it("reports no reading rather than an infinite one on an empty window", () => {
		const { row, out } = appended({ daily: [] });
		expect(row.costPerUnit).toBeNull();
		expect(out).toContain("0 units, no units");
	});

	it("names every day that hit the search cap, in the row and on screen", () => {
		const { row, out } = appended({
			daily: closes(10),
			gh: { "2026-08-20": closes(SEARCH_CAP) },
		});
		expect(row.truncated).toEqual(["2026-08-20"]);
		expect(out).toContain(
			"1 day(s) hit the 1,000-result search cap: 2026-08-20. The unit count is a FLOOR",
		);
	});

	it("asks gh for the cap and no more", () => {
		const { ghCalls } = appended();
		for (const c of ghCalls) expect(c).toContain(`--limit ${SEARCH_CAP} `);
	});
});

describe("the counting rule", () => {
	it("excludes `not planned` and `takes:children`, and counts wayfinder work", () => {
		const { row } = appended({
			daily: [
				{
					number: 1,
					stateReason: "COMPLETED",
					labels: [{ name: "takes:implement" }],
				},
				{ number: 2, stateReason: "NOT_PLANNED", labels: [] },
				{
					number: 3,
					stateReason: "COMPLETED",
					labels: [{ name: "takes:children" }],
				},
				{
					number: 4,
					stateReason: "COMPLETED",
					labels: [{ name: "takes:wayfinder" }],
				},
			],
		});
		expect(row).toMatchObject({
			total: 30 * 4,
			notPlanned: 30,
			children: 30,
			counted: 30 * 2,
			truncated: [],
		});
	});
});

describe("the series file", () => {
	it("is the tracked path under the host root, whatever the working directory", () => {
		// A gitignored series would leave the review with nothing to read.
		const { after, out } = appended();
		expect(after).not.toBeNull();
		expect(out).toContain(`Appended to ${SERIES_LABEL}`);
		expect(out).toContain(`git commit -m "…" -- ${SERIES_LABEL}`);
	});

	it("skips a line that parses but is not a row, rather than passing it to the gate", () => {
		// `null` and `[]` are valid JSON: syntax alone would let them through.
		const r = run([], {
			today: "2026-09-05",
			series: ["null", "[]", '{"counted":10}', logLine("2026-09-04", 2554)],
		});
		expect(r.out).toContain("3 unparseable line(s)");
		expect(r.out).toContain("skipped: 1, 2, 3.");
		expect(r.out).toContain("Not due: the series was last read 2026-09-04");
	});

	it("skips a row whose date is not ISO, which would sort to the head and wedge the gate", () => {
		const r = run([], {
			today: "2026-09-05",
			series: [
				JSON.stringify({ taken: "4/9/26", counted: 10 }),
				logLine("2026-09-04", 2554),
			],
		});
		expect(r.out).toContain("skipped: 1.");
		expect(r.out).toContain("Not due: the series was last read 2026-09-04");
	});

	it("reads every row back", () => {
		const r = run(["--force"], {
			series: [logLine("2026-08-28", 1587), logLine("2026-09-04", 2554)],
		});
		expect(r.out).toContain("(3 row(s))");
		expect(r.out).not.toContain("unparseable");
	});

	it("has no rows and no complaint before the first reading", () => {
		const r = appended();
		expect(r.before).toBeNull();
		expect(r.rows).toHaveLength(1);
		expect(r.out).toContain("(1 row(s))");
		expect(r.out).not.toContain("unparseable");
	});

	it("names an unparseable line rather than dropping it in silence", () => {
		const r = run([], {
			series: [
				logLine("2026-08-28", 1587),
				"{ this is not json",
				logLine("2026-09-04", 2554),
			],
		});
		expect(r.out).toContain("1 unparseable line(s)");
		expect(r.out).toContain("skipped: 2.");
		expect(r.out).toContain("(3 row(s))");
	});

	it("appends rather than rewriting, so an existing row and even a broken line survive verbatim", () => {
		const r = appended({ series: ["{ not json", ...seeded] });
		expect(r.after?.startsWith(r.before ?? "")).toBe(true);
		expect(r.rows).toHaveLength(2);
	});

	it("creates the file and its directory on the first reading", () => {
		const r = appended({ series: null });
		expect(r.before).toBeNull();
		expect(r.rows).toHaveLength(1);
	});

	it("replaces the row of a date read again, keeping every other line verbatim", () => {
		const r = run(["--force"], {
			today: "2026-09-04",
			series: ["{ not json", logLine("2026-08-28", 900), ...seeded],
		});
		expect(r.rows.map((x) => [x.taken, x.counted])).toEqual([
			["2026-08-28", 900],
			["2026-09-04", 1500],
		]);
		expect(
			r.after?.startsWith(`{ not json\n${logLine("2026-08-28", 900)}\n`),
		).toBe(true);
		expect(r.out).toContain(
			`Replaced the row dated 2026-09-04 in ${SERIES_LABEL} (2 row(s)).`,
		);
	});
});

describe("the cadence", () => {
	it("is weekly, per mantahostels#1740: due on the seventh day, not the sixth", () => {
		expect(run([], { today: "2026-09-10", series: seeded }).out).toContain(
			"Not due: the series was last read 2026-09-04, next in 1 day(s).",
		);
		expect(appended({ today: "2026-09-11", series: seeded }).rows).toHaveLength(
			2,
		);
	});

	it("takes the newest date, not the last line, so a backfill cannot look overdue", () => {
		const r = run([], {
			today: "2026-09-05",
			series: [logLine("2026-09-04", 2554), logLine("2026-08-28", 1587)],
		});
		expect(r.out).toContain("Not due: the series was last read 2026-09-04");
		expect(r.ghCalls).toEqual([]);
	});
});

describe("what each row says it was measuring", () => {
	it("records the bill and seat count in force when it was taken, at the $200 seat price", () => {
		// A ratio alone cannot say the arrangement changed underneath it (mantahostels#2750).
		const { row } = appended();
		expect([row.bill, row.seats]).toEqual([600, 3]);
		expect(row.bill).toBe(row.seats * 200);
	});

	it("carries the window it covers, not just the date it was taken", () => {
		const { row } = appended({ today: "2026-08-28" });
		expect([row.taken, row.from, row.to]).toEqual([
			"2026-08-28",
			"2026-07-29",
			"2026-08-27",
		]);
	});

	it("keeps the whole close breakdown, so a row can be audited without re-querying", () => {
		const { row } = appended();
		expect(row).toMatchObject({
			total: 30 * 100,
			counted: 30 * 50,
			notPlanned: 30 * 25,
			children: 30 * 25,
		});
	});
});

describe("the command", () => {
	it("appends a row when the reading is due", () => {
		expect(appended({ series: seeded }).rows).toHaveLength(2);
	});

	it("writes nothing at all on --dry-run, however due it is", () => {
		const r = run(["--dry-run"], { series: seeded });
		expect(r.code).toBe(0);
		expect(r.after).toBe(r.before);
		expect(r.out).toContain("--dry-run: nothing appended");
	});

	it("still prints a figure on --dry-run before the reading is due", () => {
		const r = run(["--dry-run"], { today: "2026-09-05", series: seeded });
		expect(r.code).toBe(0);
		expect(r.out).toContain("units");
		expect(r.out).not.toContain("Not due");
	});

	it("takes no reading, calls gh not at all and writes nothing before the cadence is up", () => {
		const r = run([], { today: "2026-09-05", series: seeded });
		expect(r.code).toBe(0);
		expect(r.out).toContain("Not due");
		expect(r.ghCalls).toEqual([]);
		expect(r.after).toBe(r.before);
	});

	it("takes one anyway on --force", () => {
		const r = run(["--force"], { today: "2026-09-05", series: seeded });
		expect(r.code).toBe(0);
		expect(r.rows).toHaveLength(2);
	});

	it("refuses a malformed COST_TODAY as not an ISO date, leaving the series as it was, rather than blaming GitHub for it", () => {
		const r = run(["--force"], { today: "4/9/26", series: seeded });
		expect(r.code).toBe(2);
		expect(r.out).toContain("not an ISO date");
		expect(r.ghCalls).toEqual([]);
		expect(r.after).toBe(r.before);
	});

	it("says a row is dated in the future rather than reading it as never due", () => {
		const r = run([], {
			series: [JSON.stringify({ taken: "2027-01-01", counted: 10 })],
		});
		expect(r.out).toContain("after 2026-09-11");
	});

	it("takes no reading, exit 0 and nothing written, where gh fails", () => {
		const r = run([], { series: seeded, daily: "gh: not authenticated" });
		expect(r.code).toBe(0);
		expect(r.out).toContain("No reading taken");
		expect(r.after).toBe(r.before);
	});
});

/* lib/cli-args.js's exit is what is asserted. */
describe("the command line", () => {
	it("prints usage on --help and -h, exits 0, and calls gh not at all", () => {
		for (const flag of ["--help", "-h"]) {
			const r = run([flag]);
			expect(r.code).toBe(0);
			expect(r.out).toContain(USAGE);
			expect(r.ghCalls).toEqual([]);
			expect(r.after).toBeNull();
		}
	});

	it("refuses an unknown flag, naming it and the usage, exits non-zero, writes nothing, and calls gh not at all", () => {
		const r = run(["--publish"]);
		expect(r.code).toBe(2);
		expect(r.out).toContain("unknown flag: --publish");
		expect(r.out).toContain(USAGE);
		expect(r.ghCalls).toEqual([]);
		expect(r.after).toBeNull();
	});

	it("refuses a positional, naming it, exits non-zero, writes nothing, and calls gh not at all", () => {
		const r = run(["now"]);
		expect(r.code).toBe(2);
		expect(r.out).toContain("unexpected argument: now");
		expect(r.ghCalls).toEqual([]);
		expect(r.after).toBeNull();
	});
});
