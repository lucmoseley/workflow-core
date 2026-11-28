// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubGhScript } from "./gh-stub.js";

const {
	parseFailureLine,
	refillFrontier: buildFrontier,
} = require("./refill-frontier.js");
const { blockerGraph, pulledInOf } = require("./blocker-graph.js");
const { decideTick } = require("./refill-decide.js");

let home: string;
let served: string;
let other: string;

beforeEach(() => {
	home = fs.mkdtempSync(path.join(os.tmpdir(), "refill-frontier-"));
	served = path.join(home, "served");
	other = path.join(home, "other");
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

const noBumps = async () => [];
const refillFrontier = (
	roots: string[],
	goal: unknown,
	readList: unknown,
	readBumps: unknown = noBumps,
) => buildFrontier(roots, goal, readList, readBumps);

const row = (number: number, over: Record<string, unknown> = {}) => ({
	number,
	bug: false,
	urgent: false,
	goal: false,
	stallDays: 0,
	asksQuestions: false,
	depth: 0,
	closes: 0,
	agePoints: 0,
	reach: 0,
	collision: "comment-only",
	takes: ["implement"],
	labels: ["takes:implement"],
	...over,
});

const pulled = (number: number, over: Record<string, unknown> = {}) => ({
	repo: "o/other",
	number,
	reach: 1,
	bug: false,
	urgent: false,
	goal: false,
	depth: 1,
	holds: ["o/served#1"],
	root: other,
	held: null,
	...over,
});

const shortlists = (by: Record<string, unknown>) => {
	const asked: string[] = [];
	const fn = async (root: string) => {
		asked.push(root);
		const answer = by[root] as Record<string, unknown>;
		return "error" in answer ? answer : { pulledInUnread: [], ...answer };
	};
	return { fn, asked };
};

const NOW = Date.parse("2026-10-22T12:00:00Z");
const launchesOf = (frontier: unknown[]) =>
	(
		decideTick({
			now: NOW,
			runFrom: NOW - 3_600_000,
			stopRequested: false,
			frontier,
			retroBundles: [],
			running: [],
			freeSlots: 3,
			seats: [{ seat: "~/.claude2", week: 10, session: 10, fits: 9 }],
			history: [],
			lastActAt: {},
		}).launches ?? []
	).map(
		(l: { root: string; issues: number[] }) =>
			`${path.basename(l.root)}#${l.issues.join("+")}`,
	);

const list = (numbers: number[]) => ({
	rows: numbers.map((n) => row(n)),
	retroBundles: [],
	pulledIn: [],
	pulledInUnread: [],
	ownRepo: null,
	goalSet: null,
	running: [],
});

describe("the loop's goal (#3864)", () => {
	it("hands each ticked repo its own refs and no other's", async () => {
		const asked: Record<string, string | null> = {};
		const unticked = path.join(path.dirname(served), "unticked");
		await refillFrontier(
			[served, other],
			{
				form: "issues",
				text: "x",
				refs: [
					{ repo: path.basename(served), number: 2 },
					{ repo: path.basename(other), number: 20 },
					{ repo: path.basename(other), number: 21 },
					{ repo: path.basename(unticked), number: 9 },
				],
				setAt: 1,
			},
			async (root: string, goal: string | null) => {
				asked[root] = goal;
				return list([]);
			},
		);
		expect(asked).toEqual({ [served]: "2", [other]: "20,21" });
	});

	it("hands a confirmed topic's stored set out as its refs, on every read", async () => {
		const asked: (string | null)[] = [];
		const topic = {
			form: "topic",
			text: "faster tests",
			refs: [{ repo: path.basename(served), number: 7 }],
			setAt: 3,
		};
		for (let read = 0; read < 2; read++)
			await refillFrontier(
				[served],
				topic,
				async (_root: string, goal: string | null) => {
					asked.push(goal);
					return list([]);
				},
			);
		expect(asked).toEqual(["7", "7"]);
	});

	it.each([
		["drain", (s: string) => `drain ${s}#5`, (s: string) => `drain ${s}#5`],
		["unblock", () => "unblock #5", () => null],
	])(
		"hands a %s out by where its walk runs",
		async (form, inServed, inOther) => {
			const asked: Record<string, string | null> = {};
			const name = path.basename(served);
			await refillFrontier(
				[served, other],
				{
					form,
					text: "x",
					refs: [{ repo: name, number: 5 }],
					setAt: 1,
				},
				async (root: string, goal: string | null) => {
					asked[root] = goal;
					return list([]);
				},
			);
			expect(asked).toEqual({
				[served]: inServed(name),
				[other]: inOther(name),
			});
		},
	);

	const drain = (repo: string) => ({
		form: "drain",
		text: "x",
		refs: [{ repo, number: 5 }],
		setAt: 7,
	});
	const member = (repo: string, number: number) => ({
		repo,
		number,
		title: `t${number}`,
	});

	it("counts a set's open, takeable and running members across repos", async () => {
		const m = await refillFrontier(
			[served, other],
			drain(path.basename(served)),
			async (root: string) =>
				root === served
					? {
							...list([1, 2]),
							ownRepo: "o/served",
							goalSet: {
								members: [member("o/served", 2), member("o/served", 3)],
							},
							running: [3, 9],
						}
					: {
							...list([20]),
							ownRepo: "o/other",
							goalSet: { members: [member("o/other", 20)] },
							running: [],
						},
		);
		expect(m.goal).toEqual({
			setAt: 7,
			set: [
				member("o/served", 2),
				member("o/served", 3),
				member("o/other", 20),
			],
			takeable: 2,
			running: 1,
			complete: true,
		});
	});

	it("never calls an empty set complete where a shortlist failed or the ref's repo went unread", async () => {
		const failing = await refillFrontier(
			[served, other],
			drain(path.basename(served)),
			async (root: string) =>
				root === served
					? { ...list([]), goalSet: { members: [] } }
					: { error: "x" },
		);
		expect(failing.goal).toMatchObject({ set: [], complete: false });
		const unread = await refillFrontier(
			[other],
			drain(path.basename(served)),
			async () => ({ ...list([]), goalSet: { members: [] } }),
		);
		expect(unread.goal).toMatchObject({ set: [], complete: false });
	});

	it("reads no goal where none is set", async () => {
		const m = await refillFrontier([served], null, async () => list([1]));
		expect(m.goal).toBeNull();
	});

	it("ranks a goal's rows first in each repo's read", async () => {
		const name = (root: string) => path.basename(root);
		const rowsOf: Record<string, number[]> = {
			[served]: [1, 2],
			[other]: [20, 21],
		};
		const m = await refillFrontier(
			[served, other],
			{
				form: "issues",
				text: "x",
				refs: [
					{ repo: name(served), number: 2 },
					{ repo: name(other), number: 21 },
				],
				setAt: 1,
			},
			async (root: string, goal: string | null) => ({
				...list([]),
				rows: rowsOf[root].map((n) =>
					goal === String(n) ? { ...row(n), goal: true } : row(n),
				),
			}),
		);
		expect(
			m.frontier.slice(0, 2).map((r: { number: number }) => r.number),
		).toEqual(expect.arrayContaining([2, 21]));
	});
});

describe("a foreign blocker the served shortlist pulls in", () => {
	it("launches from its own checkout, the rest of that repo left out", async () => {
		const s = shortlists({
			[served]: { rows: [row(2)], retroBundles: [], pulledIn: [pulled(20)] },
			[other]: {
				rows: [row(20), row(21)],
				retroBundles: [{ prompt: "/retro", issues: [21] }],
				pulledIn: [],
				pulledInUnread: [],
			},
		});
		const m = await refillFrontier([served], null, s.fn);
		expect(s.asked).toEqual([served, other]);
		expect(m.frontier.map((r: { number: number }) => r.number)).toEqual([
			20, 2,
		]);
		expect(m.retroBundles).toEqual([]);
		expect(launchesOf(m.frontier)).toContain("other#20");
	});

	it("ranks on the served issues it holds, not its own repo's reach", async () => {
		const s = shortlists({
			[served]: {
				rows: [row(2, { reach: 1 })],
				retroBundles: [],
				pulledIn: [
					pulled(20, { reach: 2, holds: ["o/served#1", "o/served#3"] }),
				],
			},
			[other]: {
				rows: [row(20, { reach: 9 })],
				retroBundles: [],
				pulledIn: [],
				pulledInUnread: [],
			},
		});
		const m = await refillFrontier([served], null, s.fn);
		expect(
			m.frontier.find((r: { number: number }) => r.number === 20).reach,
		).toBe(2);
	});

	it("inherits the tier and chain depth of what it holds across repos, not its own repo's depth (#3222)", async () => {
		const s = shortlists({
			[served]: {
				rows: [row(2, { reach: 3 })],
				retroBundles: [],
				pulledIn: [pulled(20, { urgent: true, depth: 2 })],
			},
			[other]: {
				rows: [row(20, { depth: 7 })],
				retroBundles: [],
				pulledIn: [],
				pulledInUnread: [],
			},
		});
		const m = await refillFrontier([served], null, s.fn);
		expect(m.frontier.map((r: { number: number }) => r.number)).toEqual([
			20, 2,
		]);
		expect(m.frontier[0]).toMatchObject({ urgent: true, depth: 2, reach: 1 });
	});

	it("keeps its own repo's age points while depth, closes and reach come from what it holds (#5880)", async () => {
		const s = shortlists({
			[served]: {
				rows: [row(2, { depth: 2 })],
				retroBundles: [],
				pulledIn: [pulled(20, { depth: 0, reach: 0 })],
			},
			[other]: {
				rows: [row(20, { depth: 7, closes: 3, reach: 9, agePoints: 3 })],
				retroBundles: [],
				pulledIn: [],
				pulledInUnread: [],
			},
		});
		const m = await refillFrontier([served], null, s.fn);
		expect(m.frontier[0]).toMatchObject({
			number: 20,
			agePoints: 3,
			depth: 0,
			closes: 0,
			reach: 0,
		});
		expect(m.frontier.map((r: { number: number }) => r.number)).toEqual([
			20, 2,
		]);
	});

	it("joins the tiers and keeps the deepest chain across the served repos that pull it in (#3222)", async () => {
		const third = path.join(home, "third");
		const s = shortlists({
			[served]: {
				rows: [],
				retroBundles: [],
				pulledIn: [pulled(20, { goal: true, depth: 3 })],
			},
			[third]: {
				rows: [],
				retroBundles: [],
				pulledIn: [pulled(20, { bug: true, urgent: true })],
			},
			[other]: {
				rows: [row(20)],
				retroBundles: [],
				pulledIn: [],
				pulledInUnread: [],
			},
		});
		const m = await refillFrontier([served, third], null, s.fn);
		expect(m.frontier[0]).toMatchObject({
			bug: true,
			urgent: true,
			goal: true,
			depth: 3,
		});
	});

	it("is held, not launched, where its own shortlist leaves it out (#3285)", async () => {
		const s = shortlists({
			[served]: { rows: [], retroBundles: [], pulledIn: [pulled(20)] },
			[other]: { rows: [], retroBundles: [], pulledIn: [], pulledInUnread: [] },
		});
		const m = await refillFrontier([served], null, s.fn);
		expect(m.frontier).toEqual([]);
		expect(m.held).toEqual([
			{
				ref: "o/other#20",
				why: "not on o/other's shortlist",
				holds: ["o/served#1"],
			},
		]);
	});

	it("is held where its served repo's shortlist leaves it out (#3285)", async () => {
		const s = shortlists({
			[served]: { rows: [], retroBundles: [], pulledIn: [pulled(20)] },
			[other]: { rows: [row(21)], retroBundles: [], pulledIn: [] },
		});
		const m = await refillFrontier([served, other], null, s.fn);
		expect(m.frontier.map((r: { number: number }) => r.number)).toEqual([21]);
		expect(m.held.map((h: { ref: string }) => h.ref)).toEqual(["o/other#20"]);
	});

	it("adds its reach to the row where its repo is served already", async () => {
		const s = shortlists({
			[served]: { rows: [], retroBundles: [], pulledIn: [pulled(20)] },
			[other]: {
				rows: [row(20, { reach: 1 })],
				retroBundles: [],
				pulledIn: [],
				pulledInUnread: [],
			},
		});
		const m = await refillFrontier([served, other], null, s.fn);
		expect(s.asked).toEqual([served, other]);
		expect(m.frontier.map((r: { reach: number }) => r.reach)).toEqual([2]);
		expect(m.held).toEqual([]);
	});

	it("sums its reach across the served repos that pull it in", async () => {
		const third = path.join(home, "third");
		const s = shortlists({
			[served]: { rows: [], retroBundles: [], pulledIn: [pulled(20)] },
			[third]: { rows: [], retroBundles: [], pulledIn: [pulled(20)] },
			[other]: {
				rows: [row(20)],
				retroBundles: [],
				pulledIn: [],
				pulledInUnread: [],
			},
		});
		const m = await refillFrontier([served, third], null, s.fn);
		expect(s.asked.filter((r) => r === other)).toHaveLength(1);
		expect(m.frontier.map((r: { reach: number }) => r.reach)).toEqual([2]);
	});
});

describe("a release bump in an unserved adopter (#5847)", () => {
	const Bump = { labels: ["takes:implement", "urgent", "origin:release-bump"] };
	const bumpsIn = (numbers: number[]) => async (roots: string[]) => {
		expect(roots).toEqual([served]);
		return [{ root: other, repo: "o/other", numbers }];
	};

	it("joins the frontier alone, the repo's other issues left out", async () => {
		const s = shortlists({
			[served]: list([2]),
			[other]: {
				...list([]),
				rows: [row(20, { ...Bump, urgent: true }), row(21)],
			},
		});
		const m = await refillFrontier([served], null, s.fn, bumpsIn([20]));
		expect(s.asked).toEqual([served, other]);
		expect(m.frontier.map((r: { number: number }) => r.number)).toEqual([
			20, 2,
		]);
		expect(m.frontier[0]).toMatchObject({ root: other, urgent: true });
		expect(launchesOf(m.frontier)).toContain("other#20");
	});

	it("costs no shortlist read where the repo holds no open bump", async () => {
		const s = shortlists({ [served]: list([2]) });
		const m = await refillFrontier([served], null, s.fn, bumpsIn([]));
		expect(s.asked).toEqual([served]);
		expect(m.failed).toEqual([]);
	});

	it("appears once where a blocker edge pulls it in too", async () => {
		const s = shortlists({
			[served]: { ...list([]), pulledIn: [pulled(20)] },
			[other]: { ...list([]), rows: [row(20, Bump)] },
		});
		const m = await refillFrontier([served], null, s.fn, bumpsIn([20]));
		expect(s.asked).toEqual([served, other]);
		expect(m.frontier.map((r: { number: number }) => r.number)).toEqual([20]);
		expect(m.frontier[0].reach).toBe(1);
		expect(m.held).toEqual([]);
	});

	it("is held, naming it a release bump, where its shortlist leaves it out", async () => {
		const s = shortlists({ [served]: list([]), [other]: list([]) });
		const m = await refillFrontier([served], null, s.fn, bumpsIn([20]));
		expect(m.frontier).toEqual([]);
		expect(m.held).toEqual([
			{
				ref: "o/other#20",
				why: "a release bump, not on o/other's shortlist",
				holds: [],
			},
		]);
	});

	it("logs an unread bump query apart from the failed shortlists", async () => {
		const s = shortlists({ [served]: list([2]) });
		const m = await refillFrontier([served], null, s.fn, async () => [
			{ root: other, error: "HTTP 502" },
		]);
		expect(m.failed).toEqual([]);
		expect(m.bumpsUnread).toEqual([{ root: other, error: "HTTP 502" }]);
		expect(m.frontier.map((r: { number: number }) => r.number)).toEqual([2]);
	});

	it("names the launch a release bump on the launch line", async () => {
		const { buildLaunchLine } = require("./refill-loop.js");
		const s = shortlists({
			[served]: list([]),
			[other]: { ...list([]), rows: [row(20, Bump)] },
		});
		const m = await refillFrontier([served], null, s.fn, bumpsIn([20]));
		const { launches } = decideTick({
			now: NOW,
			runFrom: NOW - 3_600_000,
			stopRequested: false,
			frontier: m.frontier,
			retroBundles: [],
			running: [],
			freeSlots: 3,
			seats: [{ seat: "~/.claude2", week: 10, session: 10, fits: 9 }],
			history: [],
			lastActAt: {},
		});
		expect(launches).toMatchObject([{ root: other, releaseBump: true }]);
		expect(buildLaunchLine(launches)).toMatch(
			/^launch other \/implement 20 \(release bump\) on /,
		);
	});
});

describe("the unserved adopters' bump read (#5847)", () => {
	let log: string;
	beforeEach(() => {
		vi.stubEnv("HOME", home);
		log = path.join(home, "gh.log");
	});
	const adopter = (name: string, config: Record<string, unknown>) => {
		const root = path.join(home, name);
		fs.mkdirSync(path.join(root, ".git"), { recursive: true });
		fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(root, ".claude", "workflow-core.json"),
			JSON.stringify(config),
		);
		return root;
	};
	const ghAnswering = (stdout: string, status = 0) =>
		vi.stubEnv(
			"WFC_GH",
			stubGhScript(
				home,
				`#!/bin/sh\necho "$*" >> ${log}\nprintf '%s' '${stdout}'\nexit ${status}\n`,
			).gh,
		);
	const asked = () =>
		fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : [];

	it("queries only the unserved, undisabled adopter, and launches its bump", async () => {
		const root = adopter("served", { tracker: "o/served" });
		adopter("off", { tracker: "o/off", refillLoop: false });
		const bumped = adopter("bumped", { tracker: "o/bumped" });
		ghAnswering('[{"number":20}]');
		const s = shortlists({
			[root]: list([2]),
			[bumped]: { ...list([]), rows: [row(20), row(21)] },
		});
		const m = await buildFrontier([root], null, s.fn);
		expect(asked()).toEqual([
			"issue list -R o/bumped --state open --label origin:release-bump --json number",
		]);
		expect(s.asked).toEqual([root, bumped]);
		expect(
			m.frontier
				.map(
					(r: { root: string; number: number }) =>
						`${path.basename(r.root)}#${r.number}`,
				)
				.sort(),
		).toEqual(["bumped#20", "served#2"]);
	});

	it("names a failed bump query and still reads the served repo", async () => {
		const root = adopter("served", { tracker: "o/served" });
		const bumped = adopter("bumped", { tracker: "o/bumped" });
		ghAnswering("", 1);
		const s = shortlists({ [root]: list([2]) });
		const m = await buildFrontier([root], null, s.fn);
		expect(m.bumpsUnread).toEqual([
			{ root: bumped, error: expect.any(String) },
		]);
		expect(m.failed).toEqual([]);
		expect(s.asked).toEqual([root]);
	});
});

describe("a pulled-in issue held outside the loop", () => {
	it("is reported with what it holds, never launched or read", async () => {
		const s = shortlists({
			[served]: {
				rows: [],
				retroBundles: [],
				pulledIn: [
					pulled(30, {
						repo: "o/far",
						root: null,
						held: "no checkout under /home tracks o/far",
					}),
				],
			},
		});
		const m = await refillFrontier([served], null, s.fn);
		expect(s.asked).toEqual([served]);
		expect(m.frontier).toEqual([]);
		expect(m.held).toEqual([
			{
				ref: "o/far#30",
				why: "no checkout under /home tracks o/far",
				holds: ["o/served#1"],
			},
		]);
	});
});

describe("a pulled-in repo whose shortlist fails", () => {
	it("is reported failed and launches nothing from it", async () => {
		const s = shortlists({
			[served]: { rows: [row(2)], retroBundles: [], pulledIn: [pulled(20)] },
			[other]: { error: "exit 1" },
		});
		const m = await refillFrontier([served], null, s.fn);
		expect(m.failed).toEqual([{ root: other, error: "exit 1" }]);
		expect(m.held).toEqual([]);
		expect(m.frontier.map((r: { number: number }) => r.number)).toEqual([2]);
	});
});

describe("a pulled-in issue whose own blockers would not read", () => {
	it("is reported held with what it holds, never launched", async () => {
		const s = shortlists({
			[served]: {
				rows: [],
				retroBundles: [],
				pulledIn: [],
				pulledInUnread: [
					{ ref: "o/other#20", error: "HTTP 502", holds: ["o/served#1"] },
				],
			},
		});
		const m = await refillFrontier([served], null, s.fn);
		expect(m.frontier).toEqual([]);
		expect(m.held).toEqual([
			{
				ref: "o/other#20",
				why: "its blockers could not be read: HTTP 502",
				holds: ["o/served#1"],
			},
		]);
	});
});

describe("served X blocked by foreign Y, Y by foreign Z (#2427 acceptance)", () => {
	const servedShortlist = async (zState: "open" | "closed") => {
		const issue = (repo: string, number: number, state: string) => ({
			repo,
			number,
			state,
			title: `${repo}#${number}`,
			url: "",
			labels: [],
			body: "",
		});
		const deps: Record<string, unknown[]> = {
			"o/other#10": [issue("o/other", 20, zState)],
		};
		const graph = await blockerGraph(
			[{ number: 1, edges: [issue("o/other", 10, "open")], body: "" }],
			"o/served",
			{
				blockedBy: async (ref: { repo: string; number: number }) => ({
					ok: true,
					edges: deps[`${ref.repo}#${ref.number}`] ?? [],
				}),
				issue: async () => ({ ok: false, error: "unused" }),
				each: <T, R>(items: T[], fn: (item: T) => Promise<R>) =>
					Promise.all(items.map(fn)),
			},
		);
		const { rows, unread } = pulledInOf(graph);
		return {
			rows: [],
			retroBundles: [],
			pulledIn: rows.map((r: object) => ({ ...r, root: other, held: null })),
			pulledInUnread: unread,
		};
	};

	it("launches Z while Y is blocked, then Y once Z closes", async () => {
		const before = await refillFrontier(
			[served],
			null,
			shortlists({
				[served]: await servedShortlist("open"),
				[other]: { rows: [row(10), row(20)], retroBundles: [], pulledIn: [] },
			}).fn,
		);
		expect(launchesOf(before.frontier)).toEqual(["other#20"]);
		const after = await refillFrontier(
			[served],
			null,
			shortlists({
				[served]: await servedShortlist("closed"),
				[other]: { rows: [row(10)], retroBundles: [], pulledIn: [] },
			}).fn,
		);
		expect(launchesOf(after.frontier)).toEqual(["other#10"]);
	});
});

describe("a checkout whose shortlist timed out (#2677)", () => {
	it("is unread for the tick, while a healthy one still merges", async () => {
		const s = shortlists({
			[served]: { rows: [row(2)], retroBundles: [], pulledIn: [] },
			[other]: { error: "timed out after 300 s" },
		});
		const m = await refillFrontier([served, other], null, s.fn);
		expect(m.failed).toEqual([{ root: other, error: "timed out after 300 s" }]);
		expect(m.frontier.map((r: { number: number }) => r.number)).toEqual([2]);
	});
});

describe("a checkout whose shortlist fails (#2561)", () => {
	it("idles the tick on that checkout and its reason, not on an empty frontier", async () => {
		const s = shortlists({ [served]: { error: "exited 1 FAILED: offline" } });
		const m = await refillFrontier([served], null, s.fn);
		expect(
			decideTick({
				now: NOW,
				runFrom: NOW - 3_600_000,
				stopRequested: false,
				frontier: m.frontier,
				retroBundles: m.retroBundles,
				running: [],
				freeSlots: 3,
				seats: [{ seat: "~/.claude2", week: 10, session: 10, fits: 9 }],
				history: [],
				lastActAt: {},
				failedShortlists: m.failed,
			}),
		).toMatchObject({
			launches: [],
			idle: {
				reason: "shortlist failed in",
				detail: " served: exited 1 FAILED: offline",
			},
		});
	});

	it("keeps pick-next's FAILED: line over its closing line", () => {
		expect(
			parseFailureLine(
				"FAILED: could not list open issues (Could not resolve host: github.com).\n" +
					"        Check your connection.\n" +
					"        No shortlist produced — do not read this as an empty frontier.\n",
			),
		).toBe(
			"FAILED: could not list open issues (Could not resolve host: github.com).",
		);
		expect(parseFailureLine("boom\nlast line\n")).toBe("last line");
	});
});
