// @vitest-environment node
import { describe, expect, it } from "vitest";

const { planStaleRun } = require("./stale-run-plan.js");

const NOW = "2026-11-28T06:00:00.000Z";
const REPO = "o/r";
const CORE = "o/core";
const daysAgo = (d: number) =>
	new Date(Date.parse(NOW) - d * 864e5).toISOString();

type Issue = Record<string, unknown> & { number: number };

const issue = (number: number, over: Record<string, unknown> = {}): Issue => ({
	number,
	title: `issue ${number}`,
	labels: ["takes:implement"],
	body: "",
	createdAt: daysAgo(10),
	assignees: [],
	blockedBy: [],
	subIssues: [],
	timeline: [],
	...over,
});

const repo = (over: Record<string, unknown> = {}) => ({
	root: "/h/r",
	tracker: REPO,
	fault: null,
	served: true,
	pin: null,
	bumps: [],
	frontier: [],
	issues: [],
	gates: [],
	labelFindings: [],
	containerRetags: [],
	staleClaims: [],
	claims: [],
	parkMarkers: [],
	closedRefs: [],
	cycles: [],
	...over,
});

const snap = (repos: unknown[], over: Record<string, unknown> = {}) => ({
	now: NOW,
	coreTracker: CORE,
	latestRelease: "v2.0.0",
	liveSessions: ["live-1"],
	previous: null,
	hub: null,
	repos,
	...over,
});

const plan = (repos: unknown[], over: Record<string, unknown> = {}) =>
	planStaleRun(snap(repos, over));

const texts = (p: { lines: { text: string }[] }) => p.lines.map((l) => l.text);
const classOf = (p: { lines: { number: number; cls: string }[] }, n: number) =>
	p.lines.filter((l) => l.number === n).map((l) => l.cls);

const GATE = (cond: string) =>
	`**Gated on:** ${cond} — check: \`echo x\` — abandon if: never\n**Gate basis:** basis`;

describe("planStaleRun: repo lines", () => {
	it("writes a served repo's takeable count and oldest age", () => {
		const p = plan([
			repo({
				frontier: [1, 2],
				issues: [
					issue(1, { createdAt: daysAgo(3) }),
					issue(2, { createdAt: daysAgo(9) }),
				],
			}),
		]);
		expect(p.repoLines).toEqual(["o/r: 2 takeable, oldest 9 d, served"]);
	});

	it("names a pin behind the latest release before the served set", () => {
		const p = plan([repo({ served: false, pin: "v1.0.0" })]);
		expect(p.repoLines[0]).toBe(
			"o/r: 0 takeable, oldest 0 d, unserved because pin v1.0.0 is behind latest release v2.0.0",
		);
	});

	it("names an open, unlaunched release bump", () => {
		const p = plan([
			repo({
				served: false,
				pin: "v2.0.0",
				bumps: [{ number: 7, assigned: false }],
			}),
		]);
		expect(p.repoLines[0]).toContain("release bump #7 is open and unlaunched");
	});

	it("names a repo left out of the served set", () => {
		expect(plan([repo({ served: false })]).repoLines[0]).toContain(
			"unserved because not in the served set",
		);
	});

	it("gives a malformed checkout a repo line naming its fault", () => {
		const p = plan([
			repo({ tracker: null, fault: "workflow-core.json: bad JSON" }),
		]);
		expect(p.repoLines[0]).toBe(
			"/h/r: 0 takeable, oldest 0 d, unserved because config or tracker fault: workflow-core.json: bad JSON",
		);
	});
});

describe("planStaleRun: selection", () => {
	it("lists an issue just over 7 days from createdAt, not one at 7", () => {
		const p = plan([
			repo({
				frontier: [1, 2],
				issues: [
					issue(1, { createdAt: daysAgo(8) }),
					issue(2, { createdAt: daysAgo(7) }),
				],
			}),
		]);
		expect(p.lines.map((l: { number: number }) => l.number)).toEqual([1]);
	});

	it("lists an old issue whose updatedAt is fresh", () => {
		const p = plan([
			repo({
				frontier: [1],
				issues: [issue(1, { updatedAt: NOW, createdAt: daysAgo(30) })],
			}),
		]);
		expect(classOf(p, 1)).toEqual(["unclassified"]);
	});

	it("counts an issue whose only cause is the unserved repo on the repo line", () => {
		const p = plan([
			repo({ served: false, frontier: [1], issues: [issue(1)] }),
		]);
		expect(p.lines).toEqual([]);
		expect(p.repoLines[0]).toContain("1 takeable, oldest 10 d");
	});

	it("leaves out a gate with a fresh reading that states its basis", () => {
		const p = plan(
			[
				repo({
					issues: [issue(1, { body: GATE("x reaches 5") })],
					gates: [
						{ number: 1, state: "READING", reading: "2 of 5", closed: false },
					],
				}),
			],
			{
				previous: prevRow({
					gates: { "o/r#1": { reading: "2 of 5", since: daysAgo(3) } },
				}),
			},
		);
		expect(p.lines).toEqual([]);
	});

	it("leaves out a Gated until date carrying a reason", () => {
		const p = plan([
			repo({
				issues: [
					issue(1, { body: "**Gated until:** 2026-12-20 the sale ends" }),
				],
			}),
		]);
		expect(p.lines).toEqual([]);
	});

	it("lists a container's line and not the container in another class", () => {
		const p = plan([
			repo({
				frontier: [1],
				issues: [
					issue(1, {
						labels: ["takes:children"],
						subIssues: [{ repo: null, number: 2, state: "open" }],
					}),
					issue(2, { createdAt: daysAgo(2) }),
				],
				labelFindings: [{ tag: "NO-TAKES", number: 1 }],
			}),
		]);
		expect(texts(p)).toEqual([
			"o/r#1 container held by 1 open children: o/r#2",
		]);
	});
});

const prevRow = (over: Record<string, unknown> = {}) => ({
	date: daysAgo(1),
	repoLines: [],
	listed: [],
	owed: [],
	acts: [],
	filings: [],
	hub: { number: null, keys: [] },
	disposed: [],
	gates: {},
	...over,
});

describe("planStaleRun: the catalogue", () => {
	it("C1: a DEAD check gives its gate state and reading", () => {
		const p = plan([
			repo({
				issues: [issue(1, { body: GATE("x") })],
				gates: [
					{
						number: 1,
						state: "DEAD",
						reading: "exit 1, nothing on stdout",
						closed: false,
					},
				],
			}),
		]);
		expect(texts(p)).toEqual(["o/r#1 gate DEAD: exit 1, nothing on stdout"]);
	});

	it("C1: NO-OUTPUT and NOT-STATED each give their state", () => {
		const p = plan([
			repo({
				issues: [issue(1, { body: GATE("x") }), issue(2, { body: GATE("y") })],
				gates: [
					{
						number: 1,
						state: "NO-OUTPUT",
						reading: "exit 0, nothing on stdout",
						closed: false,
					},
					{
						number: 2,
						state: "NOT-STATED",
						reading: "no check",
						closed: false,
					},
				],
			}),
		]);
		expect(texts(p)).toEqual([
			"o/r#1 gate NO-OUTPUT: exit 0, nothing on stdout",
			"o/r#2 gate NOT-STATED: no check",
		]);
	});

	it("C2: a met reading is discharged, a closed watch one reopened too", () => {
		const p = plan([
			repo({
				issues: [issue(1, { body: `x\n${GATE("y")}` })],
				gates: [
					{
						number: 1,
						state: "READING",
						reading: "met: on main",
						closed: false,
					},
					{ number: 3, state: "READING", reading: "5 of 5", closed: true },
				],
			}),
		]);
		expect(p.acts).toMatchObject([
			{ kind: "discharge", number: 1, closed: false, body: "x" },
			{ kind: "discharge", number: 3, closed: true },
		]);
		expect(p.lines).toEqual([]);
	});

	it("C2: a changed reading with no verdict needs a judge", () => {
		const p = plan(
			[
				repo({
					issues: [issue(1, { body: GATE("x") })],
					gates: [
						{ number: 1, state: "READING", reading: "now 4", closed: false },
					],
				}),
			],
			{
				previous: prevRow({
					gates: { "o/r#1": { reading: "now 3", since: daysAgo(9) } },
				}),
			},
		);
		expect(texts(p)).toEqual(["o/r#1 gate reading changed, needs a judge"]);
		expect(p.acts).toEqual([]);
	});

	it("C3: an open blocker that is itself stuck is named with its class and age", () => {
		const p = plan([
			repo({
				issues: [
					issue(1, { blockedBy: [{ repo: null, number: 2, state: "open" }] }),
					issue(2, { createdAt: daysAgo(20) }),
				],
				labelFindings: [{ tag: "NO-TAKES", number: 2 }],
			}),
		]);
		expect(texts(p)).toContain("o/r#1 blocked by o/r#2 (C5, 20 d)");
	});

	it("C3: cycles and SHIPPED-GATED / PROSE-BLOCKED findings", () => {
		const p = plan([
			repo({
				issues: [issue(1), issue(2)],
				labelFindings: [
					{ tag: "SHIPPED-GATED", number: 1 },
					{ tag: "PROSE-BLOCKED", number: 2 },
				],
				cycles: [
					{
						members: [
							{ repo: REPO, number: 1 },
							{ repo: REPO, number: 2 },
						],
					},
				],
			}),
		]);
		expect(texts(p)).toEqual([
			"o/r#1 SHIPPED-GATED",
			"cycle: o/r#1 → o/r#2 → o/r#1",
			"o/r#2 PROSE-BLOCKED",
		]);
	});

	it("C3: clears a closed native blocker and a Gated on whose issue closed", () => {
		const p = plan([
			repo({
				issues: [
					issue(1, { blockedBy: [{ repo: null, number: 9, state: "closed" }] }),
					issue(2, { body: `keep\n${GATE("#8 closes")}` }),
					issue(3, { body: GATE("#8 closes and the metric reaches 5") }),
				],
				closedRefs: ["o/r#8"],
			}),
		]);
		expect(p.acts).toMatchObject([
			{ kind: "unblock", number: 1, blocker: { repo: REPO, number: 9 } },
			{ kind: "strip-gate", number: 2, blocker: "o/r#8", body: "keep" },
		]);
	});

	it("C4: a stale-container finding and the retag act", () => {
		const p = plan([
			repo({
				issues: [issue(1, { labels: ["takes:children"] })],
				labelFindings: [{ tag: "STALE-CONTAINER", number: 1 }],
				containerRetags: [1],
			}),
		]);
		expect(texts(p)).toEqual(["o/r#1 STALE-CONTAINER"]);
		expect(p.acts).toEqual([
			{ kind: "retag", root: "/h/r", repo: REPO, numbers: [1] },
		]);
	});

	it("C5: label findings, a parked label with no marker, a stale urgent", () => {
		const p = plan([
			repo({
				issues: [
					issue(1),
					issue(2, { labels: ["takes:implement", "parked"] }),
					issue(3, {
						labels: ["takes:human", "urgent"],
						timeline: [
							{
								event: "labeled",
								created_at: daysAgo(15),
								label: { name: "urgent" },
							},
						],
					}),
				],
				labelFindings: [
					{ tag: "MANY-TAKES", number: 1 },
					{ tag: "HUMAN-UNREVIEWED", number: 3 },
				],
			}),
		]);
		expect(texts(p)).toEqual([
			"o/r#1 MANY-TAKES",
			"o/r#2 parked, its park marker is gone",
			"o/r#3 HUMAN-UNREVIEWED",
			"o/r#3 urgent, held on an answer 15 d",
		]);
	});

	it("C6: releases only an ended holder's claim, reports a live or unrecorded one", () => {
		const stale = (number: number) => ({
			number,
			ageDays: 20.4,
			assignees: ["me"],
		});
		const p = plan([
			repo({
				issues: [issue(1), issue(2), issue(3)],
				staleClaims: [stale(1), stale(2), stale(3)],
				claims: [
					{ issue: 1, sessionId: "dead-1", claimedAt: daysAgo(20) },
					{ issue: 2, sessionId: "live-1", claimedAt: daysAgo(20) },
				],
			}),
		]);
		expect(p.acts).toEqual([
			{
				kind: "release",
				root: "/h/r",
				repo: REPO,
				number: 1,
				assignees: ["me"],
				sessionId: "dead-1",
			},
		]);
		expect(texts(p)).toEqual([
			"o/r#2 claim live, idle 20 d",
			"o/r#3 claim has no arbiter record, idle 20 d",
		]);
	});

	it("C6: releases nothing when the live sessions could not be read", () => {
		const p = plan(
			[
				repo({
					issues: [issue(1)],
					staleClaims: [{ number: 1, ageDays: 20, assignees: ["me"] }],
					claims: [{ issue: 1, sessionId: "dead-1", claimedAt: daysAgo(20) }],
				}),
			],
			{ liveSessions: null },
		);
		expect(p.acts).toEqual([]);
		expect(texts(p)).toEqual(["o/r#1 claim live, idle 20 d"]);
	});

	it("C7: a check DEAD because its source is absent files a data-route ticket", () => {
		const p = plan([
			repo({
				issues: [issue(1, { body: GATE("x") })],
				gates: [
					{
						number: 1,
						state: "DEAD",
						reading: "exit 1, nothing on stdout",
						detail: "grep: data/log.jsonl: No such file or directory",
						closed: false,
					},
				],
			}),
		]);
		expect(texts(p)).toEqual([
			"o/r#1 data not accruing (exit 1, nothing on stdout, 0 d)",
		]);
		expect(p.filings).toMatchObject([
			{
				kind: "data-route",
				tracker: REPO,
				root: "/h/r",
				title: "Gate data not accruing: #1",
			},
		]);
	});

	it("C8: an unanswered round, a takes:human and a parked question are owed", () => {
		const p = plan([
			repo({
				issues: [
					issue(1, {
						timeline: [
							{
								event: "commented",
								created_at: daysAgo(9),
								body: "❓ **Q1** which?",
							},
						],
					}),
					issue(2, {
						labels: ["takes:human"],
						timeline: [
							{
								event: "labeled",
								created_at: daysAgo(12),
								label: { name: "takes:human" },
							},
						],
					}),
					issue(3, { labels: ["takes:implement", "parked"] }),
					issue(4, {
						blockedBy: [{ repo: null, number: 1, state: "open" }],
						createdAt: daysAgo(2),
					}),
				],
				parkMarkers: [{ sessionId: "s", issues: [3] }],
			}),
		]);
		expect(p.owed.map((o: { text: string }) => o.text)).toEqual([
			`o/r#1 asked ${daysAgo(9).slice(0, 10)}, 9 d, holds 1 issues`,
			`o/r#2 asked ${daysAgo(12).slice(0, 10)}, 12 d, holds 0 issues`,
			`o/r#3 asked ${daysAgo(10).slice(0, 10)}, 10 d, holds 0 issues`,
		]);
		expect(p.lines).toEqual([]);
	});

	it("C8: an ask under the founder-owed floor is not listed", () => {
		const p = plan([
			repo({
				issues: [
					issue(1, {
						timeline: [
							{ event: "commented", created_at: daysAgo(3), body: "❓ **Q1**" },
						],
					}),
				],
			}),
		]);
		expect(p.owed).toEqual([]);
	});

	it("C12: waiting:external over 14 d, parked on another cause, the stall alarm", () => {
		const p = plan([
			repo({
				issues: [
					issue(1, {
						labels: ["takes:implement", "waiting:external"],
						body: "**Waiting on:** the bank",
						timeline: [
							{
								event: "labeled",
								created_at: daysAgo(15),
								label: { name: "waiting:external" },
							},
						],
					}),
					issue(2, { labels: ["takes:implement", "parked"] }),
					issue(3, {
						title: "Landing queue stalled: main has not moved for 2 h",
					}),
				],
				parkMarkers: [{ sessionId: "s", issues: [2], cause: "API_ERROR" }],
			}),
		]);
		expect(p.owed.map((o: { text: string }) => o.text)).toEqual([
			"o/r#1 waiting on the bank 15 d",
		]);
		expect(texts(p)).toEqual([
			"o/r#2 parked (API_ERROR)",
			"o/r#3 lander stall alarm open",
		]);
	});

	it("unclassified: takeable over the floor with its claim count", () => {
		const p = plan([
			repo({
				frontier: [1],
				issues: [
					issue(1, {
						timeline: [
							{ event: "assigned", created_at: daysAgo(8) },
							{ event: "assigned", created_at: daysAgo(4) },
						],
					}),
				],
			}),
		]);
		expect(texts(p)).toEqual(["o/r#1 takeable 10 d, never picked (claims: 2)"]);
	});
});

describe("planStaleRun: filings", () => {
	const noTakes = (n: number) => ({ tag: "NO-TAKES", number: n });

	it("files nothing for one issue and one cause ticket for two, across repos", () => {
		const one = plan([
			repo({ issues: [issue(1)], labelFindings: [noTakes(1)] }),
		]);
		expect(one.filings).toEqual([]);
		const two = plan([
			repo({ issues: [issue(1)], labelFindings: [noTakes(1)] }),
			repo({
				root: "/h/q",
				tracker: "o/q",
				issues: [issue(5)],
				labelFindings: [noTakes(5)],
			}),
		]);
		expect(two.filings).toMatchObject([
			{
				kind: "cause",
				tracker: CORE,
				title: "Stale-ticket cause: C5 NO-TAKES",
			},
		]);
		expect(two.filings[0].body).toContain("o/q#5 NO-TAKES");
	});

	it("files the same title on a second run, so fileOrRefresh refreshes it", () => {
		const repos = [
			repo({
				issues: [issue(1), issue(2)],
				labelFindings: [noTakes(1), noTakes(2)],
			}),
		];
		expect(plan(repos).filings[0].title).toBe(
			plan(repos, { previous: prevRow() }).filings[0].title,
		);
	});
});

describe("planStaleRun: the hub issue", () => {
	const listed = [
		repo({
			issues: [issue(1)],
			labelFindings: [{ tag: "NO-TAKES", number: 1 }],
		}),
	];

	it("is refreshed while an undisposed session-owed line exists", () => {
		const p = plan(listed);
		expect(p.hub.action).toBe("refresh");
		expect(p.hub.body).toContain("o/r#1 NO-TAKES (new)");
		expect(p.hubKeys).toEqual(["o/r#1:C5"]);
	});

	it("a close disposes its keys, which stay out until the class changes", () => {
		const closed = plan(listed, {
			previous: prevRow({ hub: { number: 40, keys: ["o/r#1:C5"] } }),
			hub: { number: 40, state: "closed" },
		});
		expect(closed.disposed).toEqual(["o/r#1:C5"]);
		expect(closed.hub).toEqual({ action: "none" });

		const later = plan(listed, {
			previous: prevRow({ disposed: closed.disposed }),
		});
		expect(later.hub).toEqual({ action: "none" });

		const changed = plan(
			[
				repo({
					issues: [issue(1)],
					labelFindings: [{ tag: "SHIPPED-GATED", number: 1 }],
				}),
			],
			{ previous: prevRow({ disposed: closed.disposed }) },
		);
		expect(changed.disposed).toEqual([]);
		expect(changed.hub.action).toBe("refresh");
	});

	it("closes an open hub issue once nothing undisposed is left", () => {
		const p = plan([repo()], { hub: { number: 40, state: "open" } });
		expect(p.hub).toEqual({ action: "close", number: 40 });
	});

	it("never names who an owed line waits on", () => {
		const p = plan([
			repo({
				issues: [
					issue(1, { labels: ["takes:human"] }),
					issue(2, { labelFindings: [] }),
				],
				labelFindings: [{ tag: "NO-TAKES", number: 2 }],
			}),
		]);
		expect(p.hub.body).not.toMatch(/founder|@/i);
	});
});
