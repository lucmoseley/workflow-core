// @vitest-environment node
import { describe, expect, it } from "vitest";

const {
	actComment,
	bodyUnchanged,
	buildHubBody,
	buildRunRow,
	hubAfter,
	planStaleRun,
	reopenSteps,
} = require("./stale-run-plan.js");
const { UPSTREAM_TRACKER } = require("./workflow-core-config.js");

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
	checkFindings: [],
	containerRetags: [],
	staleClaims: [],
	claims: [],
	parkMarkers: [],
	closedRefs: [],
	watched: [],
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

const hubBody = (p: { hub: { parts?: unknown } }) =>
	buildHubBody(p.hub.parts, { done: [], failed: [] });

const texts = (p: { lines: { text: string }[] }) => p.lines.map((l) => l.text);
const classOf = (p: { lines: { number: number; cls: string }[] }, n: number) =>
	p.lines.filter((l) => l.number === n).map((l) => l.cls);

const GATE = (cond: string, basis = "basis") =>
	`**Gated on:** ${cond} — check: \`echo x\` — abandon if: never\n**Gate basis:** ${basis}`;

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
						{
							number: 1,
							state: "READING",
							reading: "2 of 5",
							closed: false,
							history: [],
						},
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
				checkFindings: [{ tag: "NO-TAKES", number: 1 }],
			}),
		]);
		expect(texts(p)).toEqual(["o/r#1 container held by 1 open child: o/r#2"]);
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
				checkFindings: [{ tag: "NO-TAKES", number: 2 }],
			}),
		]);
		expect(texts(p)).toContain("o/r#1 blocked by o/r#2 (C5, 20 d)");
	});

	it("C3: cycles and SHIPPED-GATED / PROSE-BLOCKED findings", () => {
		const p = plan([
			repo({
				issues: [issue(1), issue(2)],
				checkFindings: [
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

	it("C3: leaves a closed native blocker on an issue the run does not list", () => {
		const closed = [{ repo: null, number: 9, state: "closed" }];
		const p = plan([
			repo({
				issues: [
					issue(1, { blockedBy: closed, createdAt: daysAgo(3) }),
					issue(2, { blockedBy: closed }),
				],
				frontier: [2],
			}),
		]);
		expect(
			p.acts.filter((a: { kind: string }) => a.kind === "unblock"),
		).toEqual([]);
	});

	it("a gate the run strips lists no gate line for its issue", () => {
		const p = plan([
			repo({
				issues: [issue(2, { body: GATE("#8 closes") })],
				gates: [
					{
						number: 2,
						state: "NO-OUTPUT",
						reading: "",
						closed: false,
						detail: "exit 0",
					},
				],
				closedRefs: ["o/r#8"],
			}),
		]);
		expect(p.acts.map((a: { kind: string }) => a.kind)).toEqual(["strip-gate"]);
		expect(texts(p)).toEqual([]);
	});

	it("C3: a Gated on whose open issue is stuck names that issue", () => {
		const p = plan([
			repo({
				issues: [
					issue(1, { body: GATE("#2 closes") }),
					issue(2, { createdAt: daysAgo(20) }),
				],
				checkFindings: [{ tag: "NO-TAKES", number: 2 }],
			}),
		]);
		expect(texts(p)).toContain("o/r#1 blocked by o/r#2 (C5, 20 d)");
	});

	it("C3: a stuck blocker on another tracker is named with its own class", () => {
		const p = plan([
			repo({
				issues: [
					issue(1, {
						blockedBy: [{ repo: "o/other", number: 5, state: "open" }],
					}),
				],
			}),
			repo({
				root: "/h/other",
				tracker: "o/other",
				issues: [issue(5, { createdAt: daysAgo(15) })],
				checkFindings: [{ tag: "MANY-TAKES", number: 5 }],
			}),
		]);
		expect(texts(p)).toContain("o/r#1 blocked by o/other#5 (C5, 15 d)");
	});

	it("C4: an undischarged map, an unplaced issue and a child under a closed parent", () => {
		const p = plan([
			repo({
				issues: [
					issue(1),
					issue(2),
					issue(3, { parent: { repo: REPO, number: 9 } }),
					issue(4, { parent: { repo: REPO, number: 8 } }),
				],
				checkFindings: [
					{ tag: "UNDISCHARGED-MAP", number: 1 },
					{ tag: "UNPLACED", number: 2 },
				],
				closedRefs: ["o/r#9"],
			}),
		]);
		expect(texts(p)).toEqual([
			"o/r#1 UNDISCHARGED-MAP",
			"o/r#2 UNPLACED",
			"o/r#3 open under closed parent o/r#9",
		]);
		expect(classOf(p, 3)).toEqual(["C4"]);
	});

	it("C3: names a stuck blocker whatever order its chain is read in", () => {
		const p = plan([
			repo({
				issues: [
					issue(1, { blockedBy: [{ repo: null, number: 2, state: "open" }] }),
					issue(2, { blockedBy: [{ repo: null, number: 3, state: "open" }] }),
					issue(3),
				],
				checkFindings: [{ tag: "NO-TAKES", number: 3 }],
			}),
		]);
		expect(texts(p)).toContain("o/r#2 blocked by o/r#3 (C5, 10 d)");
		expect(texts(p)).toContain("o/r#1 blocked by o/r#2 (C3, 10 d)");
	});

	it("C4: a container under a closed parent, and a container that is an undischarged map", () => {
		const p = plan([
			repo({
				issues: [
					issue(1, {
						labels: ["takes:children"],
						parent: { repo: REPO, number: 9 },
					}),
					issue(2, { labels: ["takes:children"] }),
				],
				checkFindings: [{ tag: "UNDISCHARGED-MAP", number: 2 }],
				closedRefs: ["o/r#9"],
			}),
		]);
		expect(texts(p)).toEqual([
			"o/r#1 open under closed parent o/r#9",
			"o/r#2 UNDISCHARGED-MAP",
		]);
	});

	it("C4: a stale-container finding and the retag act", () => {
		const p = plan([
			repo({
				issues: [issue(1, { labels: ["takes:children"] })],
				checkFindings: [{ tag: "STALE-CONTAINER", number: 1 }],
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
				checkFindings: [
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

	const countGate = (
		reading: string,
		history: unknown[],
		body = GATE("x reaches 50"),
		{ previous = null as unknown, tracker = REPO } = {},
	) =>
		plan(
			[
				repo({
					tracker,
					issues: [issue(1, { createdAt: daysAgo(20), body })],
					gates: [
						{ number: 1, state: "READING", reading, closed: false, history },
					],
				}),
			],
			{ previous },
		);
	const row = (d: number, a: number, since: number) => ({
		repo: REPO,
		issue: 1,
		command: "echo x",
		at: Date.parse(daysAgo(d)),
		counts: [{ a, b: 50, since: Date.parse(daysAgo(since)) }],
	});

	it("C1/C7: a count reading unmoved over its window is data not accruing", () => {
		const p = countGate("3 of 50", [row(9, 3, 9), row(0, 3, 9)]);
		expect(texts(p)).toEqual([
			"o/r#1 gate READING: 3 of 50; unmoved 9 d",
			"o/r#1 data not accruing (3 of 50, 9 d)",
		]);
		expect(p.filings).toMatchObject([
			{
				kind: "data-route",
				tracker: REPO,
				root: "/h/r",
				title: "Gate data not accruing: #1",
			},
		]);
		expect(p.filings[0].body).toContain("has not moved for 9 d");
	});

	it("C1/C7: a count reading projected past its bound is data not accruing", () => {
		const p = countGate("5 of 50", [row(8, 1, 8), row(2, 4, 2), row(0, 5, 0)]);
		expect(texts(p)).toEqual([
			"o/r#1 gate READING: 5 of 50; projected met 2027-02-26",
			"o/r#1 data not accruing (5 of 50, 7 d)",
		]);
		expect(p.filings).toMatchObject([
			{ kind: "data-route", title: "Gate data not accruing: #1" },
		]);
	});

	it("a count reading moving fast enough lists nothing and files nothing", () => {
		const p = countGate("40 of 50", [
			row(7, 5, 7),
			row(3, 25, 3),
			row(0, 40, 0),
		]);
		expect(p.lines).toEqual([]);
		expect(p.filings).toEqual([]);
	});

	it("a projection past its bound on a basis citing a founder round lists nothing; unmoved still lists", () => {
		const ruled = GATE("x reaches 50", "the wait set at #12 Q2");
		const projected = countGate(
			"5 of 50",
			[row(8, 1, 8), row(2, 4, 2), row(0, 5, 0)],
			ruled,
		);
		expect(projected.lines).toEqual([]);
		expect(projected.filings).toEqual([]);
		const unmoved = countGate("3 of 50", [row(9, 3, 9), row(0, 3, 9)], ruled);
		expect(classOf(unmoved, 1)).toEqual(["C1", "C7"]);
	});

	it("a basis citing only the bound's own round lists on workflow-core's own tracker, and reads as a founder round in an adopter", () => {
		const bound = GATE("x reaches 50", "the wait set at #5687 Q1");
		const history = [row(8, 1, 8), row(2, 4, 2), row(0, 5, 0)];
		const own = countGate("5 of 50", history, bound, {
			tracker: UPSTREAM_TRACKER,
		});
		expect(classOf(own, 1)).toEqual(["C1", "C7"]);
		const adopter = countGate("5 of 50", history, bound);
		expect(adopter.lines).toEqual([]);
		expect(adopter.filings).toEqual([]);
	});

	it("a flat count reading on under a week of history lists nothing", () => {
		const p = countGate("3 of 50", [row(1.5, 3, 1.5), row(0, 3, 1.5)]);
		expect(p.lines).toEqual([]);
		expect(p.filings).toEqual([]);
	});

	it("a count reading with no history falls back to the run record's unmoved line", () => {
		const p = countGate("3 of 50", [], GATE("x reaches 50"), {
			previous: prevRow({
				gates: { "o/r#1": { reading: "3 of 50", since: daysAgo(8) } },
			}),
		});
		expect(texts(p)).toEqual(["o/r#1 gate READING: 3 of 50; unmoved 8 d"]);
		expect(p.filings).toEqual([]);
	});

	it("a stalled count gate with no basis gets its basis line and its data-route filing", () => {
		const p = countGate(
			"3 of 50",
			[row(9, 3, 9), row(0, 3, 9)],
			"**Gated on:** x reaches 50 — check: `echo x` — abandon if: never",
		);
		expect(texts(p)).toEqual([
			"o/r#1 gate READING: 3 of 50; unmoved 9 d",
			"o/r#1 data not accruing (3 of 50, 9 d)",
			"o/r#1 gate READING states no basis: 3 of 50",
		]);
		expect(p.filings).toHaveLength(1);
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
			`o/r#1 asked ${daysAgo(9).slice(0, 10)}, 9 d, holds 1 issue`,
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
			repo({ issues: [issue(1)], checkFindings: [noTakes(1)] }),
		]);
		expect(one.filings).toEqual([]);
		const two = plan([
			repo({ issues: [issue(1)], checkFindings: [noTakes(1)] }),
			repo({
				root: "/h/q",
				tracker: "o/q",
				issues: [issue(5)],
				checkFindings: [noTakes(5)],
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
				checkFindings: [noTakes(1), noTakes(2)],
			}),
		];
		expect(plan(repos).filings[0].title).toBe(
			plan(repos, { previous: prevRow() }).filings[0].title,
		);
	});
});

describe("planStaleRun: review fixes", () => {
	it("lists no gate line and files nothing for an issue under the floor", () => {
		const p = plan([
			repo({
				issues: [issue(1, { createdAt: daysAgo(2), body: GATE("y") })],
				gates: [
					{
						number: 1,
						state: "DEAD",
						reading: "ENOENT: no such file",
						closed: false,
					},
				],
			}),
		]);
		expect(p.lines).toEqual([]);
		expect(p.filings).toEqual([]);
	});

	it("discharges a closed watch:closed issue with its body read", () => {
		const p = plan([
			repo({
				watched: [issue(3, { body: `x\n${GATE("y")}` })],
				gates: [
					{ number: 3, state: "READING", reading: "5 of 5", closed: true },
				],
			}),
		]);
		expect(p.acts).toMatchObject([
			{ kind: "discharge", number: 3, closed: true, body: "x" },
		]);
	});

	it("files no cause for two lines of one signature on one issue", () => {
		const open = (n: number) => ({ repo: null, number: n, state: "open" });
		const p = plan([
			repo({
				issues: [
					issue(1, { blockedBy: [open(2), open(3)] }),
					issue(2, { labels: [] }),
					issue(3, { labels: [] }),
				],
			}),
		]);
		expect(
			p.filings
				.filter((f: { kind: string }) => f.kind === "cause")
				.map((f: { title: string }) => f.title),
		).not.toContain("Stale-ticket cause: C3 stuck blocker");
	});

	it("reads a parked question answered only by a comment after the label", () => {
		const parked = (n: number, commentAt: string) =>
			issue(n, {
				labels: ["takes:implement", "parked"],
				timeline: [
					{ event: "commented", created_at: commentAt },
					{
						event: "labeled",
						created_at: daysAgo(9),
						label: { name: "parked" },
					},
				],
			});
		const p = plan([
			repo({
				issues: [parked(1, daysAgo(9.5)), parked(2, daysAgo(8))],
				parkMarkers: [{ sessionId: "s", issues: [1, 2] }],
			}),
		]);
		expect(p.owed.map((o: { number: number }) => o.number)).toEqual([1]);
		expect(texts(p)).toEqual([
			"o/r#2 parked, its question has a later comment",
		]);
	});
});

describe("planStaleRun: the hub issue", () => {
	const listed = [
		repo({
			issues: [issue(1)],
			checkFindings: [{ tag: "NO-TAKES", number: 1 }],
		}),
	];

	it("is refreshed while an undisposed session-owed line exists", () => {
		const p = plan(listed);
		expect(p.hub.action).toBe("refresh");
		expect(hubBody(p)).toContain("o/r#1 NO-TAKES (new)");
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
					checkFindings: [{ tag: "SHIPPED-GATED", number: 1 }],
				}),
			],
			{ previous: prevRow({ disposed: closed.disposed }) },
		);
		expect(changed.disposed).toEqual([]);
		expect(changed.hub.action).toBe("refresh");
	});

	it("lists the acts done and gives a failed-acts section only when one failed", () => {
		const parts = plan(listed).hub.parts;
		const clean = buildHubBody(parts, { done: ["cleared: o/r#2"], failed: [] });
		expect(clean).toContain("## Restored this run\n\n- cleared: o/r#2\n");
		expect(clean).not.toContain("## Failed this run");
		const failed = buildHubBody(parts, {
			done: [],
			failed: ["discharged: o/r#3 (met) — failed: refused"],
		});
		expect(failed).toContain("## Restored this run\n\nNone.\n");
		expect(failed).toContain(
			"## Failed this run\n\n- discharged: o/r#3 (met) — failed: refused\n",
		);
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
					issue(2, { checkFindings: [] }),
				],
				checkFindings: [{ tag: "NO-TAKES", number: 2 }],
			}),
		]);
		expect(hubBody(p)).not.toMatch(/founder|@/i);
	});
});

describe("the executor's decisions", () => {
	const discharge = (closed: boolean) => ({
		kind: "discharge",
		root: "/h/r",
		repo: REPO,
		number: 3,
		reading: "3 of 3",
		seen: "3 of 3",
		closed,
		body: "",
		wasBody: "",
	});

	it("reopens a closed discharge and drops its watch label, and leaves an open one", () => {
		expect(reopenSteps(discharge(true))).toEqual([
			["reopen"],
			["edit", "--remove-label", "watch:closed"],
		]);
		expect(reopenSteps(discharge(false))).toEqual([]);
	});

	it("writes a body only while it still reads as the plan saw it", () => {
		expect(bodyUnchanged("a\n", "a")).toBe(true);
		expect(bodyUnchanged("a, edited", "a")).toBe(false);
	});

	it("comments a kept marker on a discharge whose body changed, and nothing on a kept strip", () => {
		expect(actComment(discharge(false), { stripped: false })?.text).toContain(
			"the marker is left for a session to strip",
		);
		expect(actComment(discharge(false), { stripped: true })?.text).toContain(
			"marker is stripped",
		);
		const strip = {
			kind: "strip-gate",
			root: "/h/r",
			repo: REPO,
			number: 2,
			blocker: "o/r#8",
			body: "",
			wasBody: "x",
		};
		expect(actComment(strip, { stripped: false })).toBeNull();
		expect(actComment(strip, { stripped: true })).toMatchObject({ number: 2 });
		expect(
			actComment(
				{ kind: "retag", root: "/h/r", repo: REPO, numbers: [1] },
				{ stripped: false },
			),
		).toBeNull();
	});

	it("keeps a line's first-listed date across runs and stamps a new one today", () => {
		const listed = [
			repo({
				issues: [issue(1), issue(2)],
				checkFindings: [
					{ tag: "NO-TAKES", number: 1 },
					{ tag: "NO-TAKES", number: 2 },
				],
			}),
		];
		const s = snap(listed, {
			previous: prevRow({
				listed: [{ key: "o/r#1:C5", cls: "C5", firstListed: daysAgo(4) }],
			}),
		});
		const row = buildRunRow(planStaleRun(s), s, {
			acts: [],
			filings: [],
			hub: 40,
		});
		expect(row.listed).toEqual([
			{ key: "o/r#1:C5", cls: "C5", firstListed: daysAgo(4) },
			{ key: "o/r#2:C5", cls: "C5", firstListed: NOW },
		]);
		expect(row.hub).toEqual({ number: 40, keys: ["o/r#1:C5", "o/r#2:C5"] });
	});

	it("records the hub a refresh names, else the one open before; none after a close", () => {
		const refresh = { action: "refresh", body: "" };
		expect(hubAfter(refresh, { filed: 77, before: 40 })).toBe(77);
		expect(hubAfter(refresh, { filed: null, before: 40 })).toBe(40);
		expect(
			hubAfter({ action: "close", number: 40 }, { filed: null, before: 40 }),
		).toBeNull();
	});
});
