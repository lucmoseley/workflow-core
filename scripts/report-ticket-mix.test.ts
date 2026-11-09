// @vitest-environment node
/*
 * report-ticket-mix.test.ts — the ticket-mix counting script (#4797, spec
 * #4796 §Testing Decisions Seam 3). Break it and the weekly review counts an
 * origin or a template wrongly, sets a kind's limit wrongly, fires a trigger
 * under the 10-ticket floor or on a trend it cannot yet read, misses the
 * Pareto level, or judges a kind on count alone when the week's total moved.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.join(__dirname, "report-ticket-mix.js");
const REPO = "lucmoseley/workflow-core-tracker";
const START = "2026-11-02T00:00:00.000Z";
const END = "2026-11-09T00:00:00.000Z";
const IN_WEEK = "2026-11-04T12:00:00Z";
const DAY = 86_400_000;

interface Issue {
	number: number;
	title: string;
	body?: string;
	labels?: { name: string }[];
	createdAt?: string;
}
type Line = Record<string, unknown>;
interface Kind {
	id: string;
	meaning: string;
	firstSeen: string;
}

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "ticket-mix-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (name: string, data: unknown) => {
	const f = path.join(dir, name);
	fs.writeFileSync(
		f,
		typeof data === "string" ? data : JSON.stringify(data),
		"utf8",
	);
	return f;
};

const weekly = (weeksBack: number, extra: Line): Line => {
	const s = new Date(Date.parse(START) - weeksBack * 7 * DAY);
	return {
		date: new Date(s.getTime() + 7 * DAY).toISOString().slice(0, 10),
		mode: "weekly",
		week: {
			start: s.toISOString(),
			end: new Date(s.getTime() + 7 * DAY).toISOString(),
		},
		...extra,
	};
};

/** Weekly lines, oldest first. */
const history = (id: string, counts: number[], totals?: number[]) =>
	counts.map((c, i) =>
		weekly(counts.length - i, {
			kinds: { [id]: { count: c, share: totals ? c / (totals[i] ?? 1) : 0 } },
			...(totals ? { ticketMixStep: { total: totals[i] } } : {}),
		}),
	);

const issues = (from: number, n: number, title = "Some fault") =>
	Array.from(
		{ length: n },
		(_, i): Issue => ({
			number: from + i,
			title: `${title} ${from + i}`,
			createdAt: IN_WEEK,
			labels: [],
		}),
	);

const assign = (list: Issue[], id: string) =>
	Object.fromEntries(list.map((i) => [`${REPO}#${i.number}`, id]));

const kind = (id: string, firstSeen = "2026-01-01"): Kind => ({
	id,
	meaning: `${id} meaning`,
	firstSeen,
});

function run(o: {
	issues: Issue[];
	runs?: Line[];
	kinds?: Kind[];
	assigned?: Record<string, string>;
	extra?: string[];
}) {
	const args = [
		"--issues",
		`${REPO}=${write("tracker.json", o.issues)}`,
		"--week-start",
		START,
		"--week-end",
		END,
		"--runs",
		write(
			"runs.jsonl",
			(o.runs ?? []).map((l) => JSON.stringify(l)).join("\n"),
		),
		"--kinds",
		write("kinds.json", o.kinds ?? []),
		"--json",
		...(o.assigned ? ["--assigned", write("assigned.json", o.assigned)] : []),
		...(o.extra ?? []),
	];
	const r = runInProcess(SCRIPT, args, { cwd: dir });
	return {
		...r,
		json: r.status === 0 ? JSON.parse(r.stdout) : null,
	};
}

const rowOf = (r: ReturnType<typeof run>, id: string) =>
	r.json.triggers.kinds.find((k: { id: string }) => k.id === id);

describe("counting", () => {
	it("counts only the week's issues and masks titles into templates", () => {
		const list: Issue[] = [
			{
				number: 1,
				title: "Lander dropped q/fix-12 at 1a2b3c4d",
				createdAt: IN_WEEK,
			},
			{
				number: 2,
				title: "Lander dropped q/other-7 at ffee0099aa",
				createdAt: IN_WEEK,
			},
			{
				number: 3,
				title: "Fix `scripts/lib/x.js` for #4797",
				createdAt: IN_WEEK,
			},
			{
				number: 4,
				title: "Fix README.md for lucmoseley/mantahostels#12",
				createdAt: IN_WEEK,
			},
			{
				number: 5,
				title: "Worktree implement-4797-3da39c left on refs/heads/main",
				createdAt: IN_WEEK,
			},
			{
				number: 6,
				title: "Last week's issue",
				createdAt: "2026-11-01T23:59:59Z",
			},
			{ number: 7, title: "Next week's issue", createdAt: END },
		];
		const r = run({ issues: list });
		expect(r.status).toBe(0);
		expect(r.json.total).toBe(5);
		expect(r.json.templates).toEqual([
			{ template: "Fix <path> for <issue>", count: 2 },
			{ template: "Lander dropped <branch> at <sha>", count: 2 },
			{ template: "Worktree <branch> left on <branch>", count: 1 },
		]);
	});

	it("masks plain numbers and leaves hex-letter words alone", () => {
		const r = run({
			issues: [
				{
					number: 1,
					title: "Suite took 412.5s over 3 runs, defaced",
					createdAt: IN_WEEK,
				},
			],
		});
		expect(r.json.templates).toEqual([
			{ template: "Suite took <n>s over <n> runs, defaced", count: 1 },
		]);
	});

	it("takes the origin label first and falls back to the keyword rules", () => {
		const r = run({
			issues: [
				{
					number: 1,
					title: "Orphaned edit: x",
					labels: [{ name: "origin:code-review" }],
					createdAt: IN_WEEK,
				},
				{
					number: 2,
					title: "Orphaned edit: y",
					labels: [],
					createdAt: IN_WEEK,
				},
				{
					number: 3,
					title: "Something",
					body: "Standalone: found while running the suite.",
					labels: [],
					createdAt: IN_WEEK,
				},
				{ number: 4, title: "Plain", body: "", labels: [], createdAt: IN_WEEK },
				{
					number: 5,
					title: "Plain too",
					labels: [{ name: "origin:code-review" }],
					createdAt: IN_WEEK,
				},
			],
		});
		expect(r.json.origins).toEqual([
			{ origin: "code-review", count: 2, label: 2, fallback: 0 },
			{ origin: "found-in-passing", count: 1, label: 0, fallback: 1 },
			{ origin: "orphaned-edit-script", count: 1, label: 0, fallback: 1 },
			{ origin: "unmarked", count: 1, label: 0, fallback: 1 },
		]);
	});

	it("reads a kind's prior points, a missing kind as 0 and a line without kinds as no point", () => {
		const runs = [
			weekly(3, { kinds: { a: { count: 4, share: 0.1 } } }),
			weekly(2, { filed: [] }),
			weekly(1, { kinds: { b: { count: 9, share: 0.2 } } }),
		];
		const r = run({ issues: issues(1, 1), runs, kinds: [kind("a")] });
		expect(r.json.kinds[0].points).toEqual([4, 0]);
		expect(r.json.kinds[0].limits.mean).toBe(2);
	});

	it("sets the c-chart limit, mean + 3 × √mean, under 20 points", () => {
		const r = run({
			issues: issues(1, 1),
			runs: history("a", [4, 4, 4, 4]),
			kinds: [kind("a")],
		});
		expect(r.json.kinds[0].limits).toEqual({
			points: 4,
			mean: 4,
			upper: 10,
			lower: 0,
			method: "c-chart",
		});
	});

	it("switches to XmR, mean + 2.66 × mean moving range, at 20 points", () => {
		const alt = (n: number) =>
			Array.from({ length: n }, (_, i) => (i % 2 ? 12 : 10));
		const at19 = run({
			issues: issues(1, 1),
			runs: history("a", alt(19)),
			kinds: [kind("a")],
		});
		expect(at19.json.kinds[0].limits.method).toBe("c-chart");
		const at20 = run({
			issues: issues(1, 1),
			runs: history("a", alt(20)),
			kinds: [kind("a")],
		});
		const l = at20.json.kinds[0].limits;
		expect(l.method).toBe("xmr");
		expect(l.mean).toBe(11);
		expect(l.upper).toBeCloseTo(11 + 2.66 * 2, 9);
	});

	it("names a snapshot issue with no createdAt and exits 1", () => {
		const r = run({ issues: [{ number: 9, title: "x" }] });
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(
			/1 issue\(s\) with no readable createdAt \(first #9\)/,
		);
	});

	it("names a kept list that will not read and exits 1, never counting it zero", () => {
		const r = runInProcess(
			SCRIPT,
			[
				"--issues",
				`${REPO}=${write("tracker.json", issues(1, 1))}`,
				"--week-start",
				START,
				"--week-end",
				END,
				"--runs",
				write("runs.jsonl", ""),
				"--kinds",
				path.join(dir, "missing.json"),
			],
			{ cwd: dir },
		);
		expect(r.status).toBe(1);
		expect(r.stdout).toBe("");
		expect(r.stderr).toMatch(
			/the kept list of kinds .*missing\.json will not read/,
		);
	});

	it("names a run line that will not parse and exits 1, still counting the rest", () => {
		const f = write("runs.jsonl", '{"mode":"weekly"}\n{not json\n');
		const r = runInProcess(
			SCRIPT,
			[
				"--issues",
				`${REPO}=${write("tracker.json", issues(1, 1))}`,
				"--week-start",
				START,
				"--week-end",
				END,
				"--runs",
				f,
				"--kinds",
				write("kinds.json", []),
			],
			{ cwd: dir },
		);
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/line 2 will not parse/);
		expect(r.stdout).toMatch(/^Ticket mix, .*: 1 issue\(s\)/);
	});

	it("refuses a week whose end is not after its start, exit 2", () => {
		const r = runInProcess(
			SCRIPT,
			["--issues", `${REPO}=x.json`, "--week-start", END, "--week-end", START],
			{ cwd: dir },
		);
		expect(r.status).toBe(2);
	});
});

describe("triggers", () => {
	it("fires over-limit on a count over the c-chart limit", () => {
		const hot = issues(1, 11);
		const r = run({
			issues: [...hot, ...issues(100, 89, "Other")],
			runs: history("a", [4, 4, 4, 4]),
			kinds: [kind("a"), kind("rest")],
			assigned: {
				...assign(hot, "a"),
				...assign(issues(100, 89, "Other"), "rest"),
			},
		});
		const a = rowOf(r, "a");
		expect(a.limit).toBe(10);
		expect(a.triggers).toContain("over-limit");
	});

	it("holds every trigger under 10 tickets and lists the kind on watch", () => {
		const nine = issues(1, 9);
		const r = run({
			issues: nine,
			runs: history("fresh", [1, 2, 3, 4, 5]),
			kinds: [kind("fresh", "2026-11-03")],
			assigned: assign(nine, "fresh"),
		});
		const row = rowOf(r, "fresh");
		expect(row.triggers).toEqual([]);
		expect(row.held).toEqual(["new-kind", "over-limit", "trend", "level"]);
		expect(r.json.triggers.candidates).toEqual([]);
		expect(r.json.triggers.watch).toEqual(["fresh"]);
	});

	it("fires the same triggers at 10 tickets", () => {
		const ten = issues(1, 10);
		const r = run({
			issues: ten,
			runs: history("fresh", [1, 2, 3, 4, 5]),
			kinds: [kind("fresh", "2026-11-03")],
			assigned: assign(ten, "fresh"),
		});
		expect(r.json.triggers.candidates).toEqual([
			{
				kind: "fresh",
				count: 10,
				share: 1,
				triggers: ["new-kind", "over-limit", "trend", "level"],
				refs: ten.map((i) => `${REPO}#${i.number}`),
			},
		]);
	});

	it("fires trend on 6 weekly points rising, and shows watch-only under 6", () => {
		const hot = issues(1, 12);
		const rest = issues(100, 88, "Other");
		const base = {
			issues: [...hot, ...rest],
			kinds: [kind("a"), kind("rest")],
			assigned: { ...assign(hot, "a"), ...assign(rest, "rest") },
		};
		/* Limits wide enough that 12 is under them: only the trend can fire. */
		const six = run({ ...base, runs: history("a", [7, 8, 9, 10, 11]) });
		expect(rowOf(six, "a").direction).toBe("up");
		expect(rowOf(six, "a").triggers).toEqual(["trend"]);
		const five = run({ ...base, runs: history("a", [8, 9, 10, 11]) });
		expect(rowOf(five, "a").direction).toBe("watch-only");
		expect(rowOf(five, "a").triggers).toEqual([]);
		expect(five.json.triggers.watch).toContain("a");
		const broken = run({ ...base, runs: history("a", [7, 8, 11, 10, 11]) });
		expect(rowOf(broken, "a").direction).toBe("none");
		expect(rowOf(broken, "a").triggers).toEqual([]);
	});

	it("fires level on the kinds that reach 80% of the week, at most 3, steady or not", () => {
		const sizes: [string, number][] = [
			["a", 25],
			["b", 20],
			["c", 15],
			["d", 15],
			["e", 15],
			["f", 10],
		];
		let n = 1;
		const all: Issue[] = [];
		let assigned: Record<string, string> = {};
		for (const [id, size] of sizes) {
			const list = issues(n, size, id);
			n += size;
			all.push(...list);
			assigned = { ...assigned, ...assign(list, id) };
		}
		/* Each kind steady at its own size for 6 weeks: no limit, no trend. */
		const runs = Array.from({ length: 6 }, (_, w) =>
			weekly(6 - w, {
				kinds: Object.fromEntries(
					sizes.map(([id, size]) => [id, { count: size, share: size / 100 }]),
				),
				ticketMixStep: { total: 100 },
			}),
		);
		const r = run({
			issues: all,
			runs,
			kinds: sizes.map(([id]) => kind(id)),
			assigned,
		});
		expect(
			r.json.triggers.candidates.map(
				(c: { kind: string; triggers: string[] }) => [c.kind, c.triggers],
			),
		).toEqual([
			["a", ["level"]],
			["b", ["level"]],
			["c", ["level"]],
		]);
		expect(r.json.triggers.runLine.kinds.a).toEqual({ count: 25, share: 0.25 });
		expect(r.json.triggers.runLine.total).toBe(100);
	});

	it("compares share as well as count only when the week's total moved sharply", () => {
		/* Prior: total 100 a week, the kind 20 of it (share 0.2); count limit
		 * 20 + 3√20 ≈ 33.4, totals' limits 70–130. */
		const runs = history("a", [20, 20, 20, 20], [100, 100, 100, 100]);
		const week = (kindCount: number, total: number) => {
			const hot = issues(1, kindCount);
			const rest = issues(1000, total - kindCount, "Other");
			return run({
				issues: [...hot, ...rest],
				runs,
				kinds: [kind("a"), kind("rest")],
				assigned: { ...assign(hot, "a"), ...assign(rest, "rest") },
			});
		};
		/* Total 50 is under 70: share 0.4 is over the p-chart limit
		 * 0.2 + 3√(0.16/50) ≈ 0.37 while the count 20 is under its own. */
		const sharp = week(20, 50);
		expect(sharp.json.totals.sharp).toBe(true);
		expect(rowOf(sharp, "a").over).toEqual({ count: false, share: true });
		expect(rowOf(sharp, "a").triggers).toContain("over-limit");
		/* Total 75 is inside 70–130: share 0.4 is not compared. */
		const steady = week(30, 75);
		expect(steady.json.totals.sharp).toBe(false);
		expect(rowOf(steady, "a").over).toEqual({ count: false, share: false });
		expect(rowOf(steady, "a").triggers).not.toContain("over-limit");
	});

	it("names unassigned issues and refuses a kind off the kept list", () => {
		const list = issues(1, 3);
		const r = run({
			issues: list,
			kinds: [kind("a")],
			assigned: { [`${REPO}#1`]: "a" },
		});
		expect(r.json.triggers.unassigned).toEqual([`${REPO}#2`, `${REPO}#3`]);
		const off = run({
			issues: list,
			kinds: [kind("a")],
			assigned: { [`${REPO}#1`]: "zzz" },
		});
		expect(off.status).toBe(1);
		expect(off.stderr).toMatch(/off the kept list: zzz/);
	});

	it("is flip-due at the step's 4th weekly run, this run counted with --this-run", () => {
		const runs = [1, 2, 3].map((w) =>
			weekly(w, { kinds: {}, ticketMixStep: { total: 0 } }),
		);
		expect(run({ issues: issues(1, 1), runs }).json.flip).toEqual({
			runs: 3,
			due: false,
		});
		expect(
			run({ issues: issues(1, 1), runs, extra: ["--this-run"] }).json.flip,
		).toEqual({ runs: 4, due: true });
	});
});
