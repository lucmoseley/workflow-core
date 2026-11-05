// @vitest-environment node
/*
 * Pins the selection shortlist: which open issues are ready and count as
 * work, their order, the gates a body sets, and why each frontier issue did
 * not launch (mantahostels#102, mantahostels#105, mantahostels#106).
 *
 * `/pick-next` launches work off this output: loosen a case and it can
 * dispatch a blocked issue or one that is not work. Claims, admission and
 * launches are pinned in pick-next-claims.test.ts; the collision, write-set
 * and summary annotations in pick-next-output.test.ts. The harness is
 * lib/pick-next-testkit.ts.
 *
 * Each case runs scripts/pick-next.js in process against a stub gh, a git
 * tree and a claim store: ~0.2 s a case, under #4302's 60 s per-file limit.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeAdopterCheckout } from "./lib/claim-store-testkit";
import { GH_NOT_FOUND } from "./lib/gh-fake";
import {
	CALL_LOG,
	daysAgo,
	expectGraphqlReadsOnly,
	type Fixture,
	installPickNextHarness,
	kit,
	kitHome,
	restCalls,
	run,
	sessionProcs,
	WITA_OFFSET_MS,
	WORKING_PAIR_KB,
} from "./lib/pick-next-testkit";
import { runInProcess } from "./lib/run-in-process";

const writeSetCache = require("./lib/write-set-cache.js");
const selectionMarker = require("./lib/selection-marker.js");
const { issuesIn, commandOf } = require("./lib/dispatch-ledger.js");
const { RETRO_BUNDLE_MODEL } = require("./lib/retro-bundles.js");

import type { RetroLaunch } from "./lib/retro-bundles.js";

installPickNextHarness();

describe("readiness", () => {
	it("drops an issue with an open blocker and keeps one whose blocker closed", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }, { number: 3 }],
			deps: {
				2: [{ number: 1, state: "open" }],
				3: [{ number: 99, state: "closed" }],
			},
		});
		expect(r.order()).toContain(3);
		expect(r.order()).not.toContain(2);
		expect(r.out).toMatch(/#2\s+.*blocked by #1/);
	});

	it("ignores issue_dependencies_summary.blocked_by — the mantahostels#19 staleness trap", async () => {
		const r = await run({
			issues: [{ number: 18 }, { number: 19, summaryBlockedBy: 0 }],
			deps: { 19: [{ number: 18, state: "open" }] },
		});
		expect(r.order()).not.toContain(19);
		expect(r.out).toMatch(/#19\s+.*blocked by #18/);
	});

	it("honours a blocker that is also the blocked issue's own child", async () => {
		// The live cross-group edge mantahostels#105 found: mantahostels#93 blocks mantahostels#79 while being mantahostels#79's
		// child. A query assuming edges run parent-downward drops it.
		const r = await run({
			issues: [{ number: 79 }, { number: 93, parent: 79 }],
			deps: { 79: [{ number: 93, state: "open" }] },
		});
		expect(r.order()).toEqual([93]);
		expect(r.out).toMatch(/#79\s+.*blocked by #93/);
	});

	it("excludes an issue whose prose `**Blocked on**` names a still-open issue (mantahostels#1289)", async () => {
		const r = await run({
			issues: [{ number: 831 }, { number: 832, body: "**Blocked on** #831." }],
		});
		expect(r.order()).not.toContain(832);
		expect(r.out).toMatch(/#832\s+.*blocked by #831 \(prose only\)/);
	});

	it("resolves a prose blocker naming a closed issue for free, no second call", async () => {
		// mantahostels#831 closed; mantahostels#832/mantahostels#833/mantahostels#835 named it and were takeable all along
		// (the real shape measured 24 August 2026).
		const r = await run({
			issues: [{ number: 832, body: "**Blocked on** #831." }],
		});
		expect(r.order()).toContain(832);
		for (const call of r.calls()) expect(call).not.toMatch(/issues\/831\b/);
	});

	it("merges a prose blocker with a native one rather than doubling it", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2, body: "**Blocked on** #1." }],
			deps: { 2: [{ number: 1, state: "open" }] },
		});
		expect(r.out).toMatch(/#2\s+.*blocked by #1(?!.*#1)/);
	});

	it("carries a blocker naming no issue number, and excludes nothing on it", async () => {
		// mantahostels#927's shape: the marker names a roadmap card, mid-sentence, so there
		// is no number to resolve against the open list.
		const r = await run(
			{
				issues: [
					{
						number: 9,
						body: "Standalone work. **Blocked on the `seed-listings` roadmap card** — meaningless against an empty table.",
					},
				],
			},
			["--json"],
		);
		const entry = r
			.json()
			.proseBlocked.find((p: { number: number }) => p.number === 9) as {
			named: string[];
			unparsed: string[];
		};
		expect(entry.named).toEqual([]);
		expect(entry.unparsed).toEqual([
			"**Blocked on the `seed-listings` roadmap card** — meaningless against an empty table.",
		]);
		expect(
			r.json().frontier.map((f: { number: number }) => f.number),
		).toContain(9);
	});

	it("marks a frontier row whose latest loop launch committed and did not close (#3782)", async () => {
		const refill = path.join(kit.dir, "refill");
		fs.mkdirSync(refill);
		fs.writeFileSync(
			path.join(refill, ".refill-loop-state.json"),
			JSON.stringify({
				launches: [
					{
						root: kit.repoRoot,
						issues: [9],
						prompt: "/implement 9",
						seat: "/home/u/.claude",
						jobId: "job9",
						launchedAt: Date.parse("2026-10-29T18:00:00Z"),
						finishedAt: Date.parse("2026-10-29T19:00:00Z"),
						sessionId: "s9",
						acts: { commit: 1 },
					},
				],
			}),
		);
		const r = await run(
			{ issues: [{ number: 8 }, { number: 9 }] },
			["--json"],
			{
				env: { WFC_REFILL_DIR: refill },
			},
		);
		const rows = r.json().frontier;
		const of = (n: number) =>
			rows.find((f: { number: number }) => f.number === n).unclosedLaunch;
		expect(of(8)).toBeNull();
		expect(of(9)).toEqual({
			launchedAt: "2026-10-29T18:00:00.000Z",
			sessionId: "s9",
			acts: { commit: 1 },
		});
	});

	it("carries every prose blocker in --json, resolved or not", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1 },
					{ number: 2, body: "**Blocked on** #1." },
					{ number: 3, body: "**Blocked on** #831." },
				],
			},
			["--json"],
		);
		expect(r.json().proseBlocked).toEqual([
			{
				number: 2,
				title: "issue 2",
				named: ["#1"],
				open: ["#1"],
				closed: [],
				unreadable: [],
				unparsed: [],
			},
			{
				number: 3,
				title: "issue 3",
				named: ["#831"],
				open: [],
				closed: ["#831"],
				unreadable: [],
				unparsed: [],
			},
		]);
	});

	it("judges a marker naming this repo as `owner/name#n` against the open list (#3277)", async () => {
		const r = await run({
			issues: [
				{ number: 1 },
				{ number: 2, body: "**Blocked on** o/r#1." },
				{ number: 3, body: "**Blocked on** O/R#831." },
			],
		});
		expect(r.out).toMatch(/#2\s+names #1 — still blocked by #1/);
		expect(r.out).toMatch(
			/#3\s+names #831 — every named issue is closed, resolved/,
		);
		for (const call of r.calls()) expect(call).not.toMatch(/issues\/(1|831)\b/);
	});

	it("reports a marker in another repo whose read fails as unreadable, and holds it", async () => {
		const fx = { issues: [{ number: 2, body: "**Blocked on** o/x#5." }] };
		const text = await run(fx);
		expect(text.out).toMatch(/#2\s+names o\/x#5 — o\/x#5 unreadable, held \(/);
		const r = await run(fx, ["--json"]);
		const row = r.json().proseBlocked[0];
		expect(row.named).toEqual(["o/x#5"]);
		expect(row.closed).toEqual([]);
		expect(row.unreadable).toEqual([
			{ ref: "o/x#5", error: expect.any(String) },
		]);
		expect(
			r.json().frontier.map((f: { number: number }) => f.number),
		).not.toContain(2);
	});

	it("prints the prose self-gate block, split by still-open and resolved", async () => {
		const r = await run({
			issues: [
				{ number: 1 },
				{ number: 2, body: "**Blocked on** #1." },
				{ number: 3, body: "**Blocked on** #831." },
			],
		});
		expect(r.out).toMatch(/PROSE SELF-GATES/);
		expect(r.out).toMatch(/#2\s+names #1 — still blocked by #1/);
		expect(r.out).toMatch(
			/#3\s+names #831 — every named issue is closed, resolved/,
		);
	});

	it("says nothing about prose self-gates when no body carries one", async () => {
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).not.toMatch(/PROSE SELF-GATES/);
	});

	it("names a blocker in another repo as owner/name#n, crediting nothing to the issue here sharing its number (#2427)", async () => {
		const r = await run(
			{
				issues: [{ number: 1 }, { number: 5 }],
				deps: { 1: [{ number: 5, state: "open", repo: "o/there" }] },
			},
			["--json"],
		);
		const j = r.json();
		expect(j.frontier.map((f: { number: number }) => f.number)).toEqual([5]);
		expect(j.frontier[0].reach).toBe(0);
		const text = await run({
			issues: [{ number: 1 }, { number: 5 }],
			deps: { 1: [{ number: 5, state: "open", repo: "o/there" }] },
		});
		expect(text.out).toMatch(/#1\s+.*blocked by o\/there#5/);
	});

	it("pulls in the open end of a foreign chain, held where no checkout tracks its repo (#2427)", async () => {
		const fx = {
			issues: [{ number: 1 }],
			deps: { 1: [{ number: 10, state: "open" as const, repo: "o/y" }] },
			foreignDeps: {
				"o/y#10": [{ number: 20, state: "open" as const, repo: "o/z" }],
			},
		};
		const r = await run(fx, ["--json"]);
		expect(r.json().pulledIn).toEqual([
			expect.objectContaining({
				repo: "o/z",
				number: 20,
				reach: 1,
				holds: ["o/r#1"],
				root: null,
				held: `no checkout under ${kitHome()} tracks o/z`,
			}),
		]);
		const text = await run(fx);
		expect(text.out).toMatch(
			/PULLED IN FROM OTHER REPOS[\s\S]*o\/z#20\s+depth 1\s+reach 1\s+holds o\/r#1\s+HELD OUTSIDE THE LOOP: no checkout under \S+ tracks o\/z/,
		);
	});

	it("offers a pulled-in blocker from its checkout, refillLoop: false or not (#2427, #3281)", async () => {
		const home = path.join(kit.dir, "adopters");
		const z = path.join(home, "z");
		writeAdopterCheckout(z, "o/z");
		const fx = {
			issues: [{ number: 1 }],
			deps: { 1: [{ number: 20, state: "open" as const, repo: "o/z" }] },
		};
		const r = await run(fx, ["--json"], { env: { HOME: home } });
		expect(r.json().pulledIn[0]).toMatchObject({ root: z, held: null });
		fs.writeFileSync(
			path.join(z, ".claude", "workflow-core.json"),
			JSON.stringify({ tracker: "o/z", refillLoop: false }),
		);
		const off = await run(fx, ["--json"], { env: { HOME: home } });
		expect(off.json().pulledIn[0]).toMatchObject({ root: z, held: null });
	});

	it("never calls the /dependencies/blocking endpoint", async () => {
		const r = await run({ issues: [{ number: 1 }, { number: 2 }] });
		expect(r.calls().join("\n")).not.toMatch(/dependencies\/blocking/);
	});
});

describe("what counts as work", () => {
	it("excludes an open issue with an open child, whatever its labels", async () => {
		// mantahostels#40 has four open children and no `wayfinder:map` label. The label-based
		// container test let it into the frontier; the structural test drops it.
		const r = await run({
			issues: [
				{ number: 40 },
				{ number: 78, parent: 40 },
				{ number: 83, parent: 40 },
			],
		});
		expect(r.order()).toEqual([78, 83]);
		expect(r.out).toMatch(/#40\s+.*container — 2 open children/);
	});

	it("excludes a map whose only open child is in another repo (#3658)", async () => {
		const r = await run({
			issues: [
				// A summary of 0: a map is read whatever its summary says.
				{ number: 40, labels: ["wayfinder:map"] },
				{ number: 41 },
			],
			subIssues: { 40: [{ number: 9, state: "open", repo: "o/other" }] },
		});
		expect(r.order()).toEqual([41]);
		expect(r.out).toMatch(/#40\s+.*container — 1 open children\s{2,}/);
	});

	it("holds a map back on its summary where its sub-issues cannot be read, saying so (#3658)", async () => {
		const r = await run({
			issues: [{ number: 40, openSubIssues: 1 }, { number: 41 }],
			failSubIssues: [40],
		});
		expect(r.order()).toEqual([41]);
		expect(r.out).toMatch(
			/#40\s+.*container — 1 open children by its summary; sub-issues unreadable/,
		);
	});

	it("reads an empty sub-issues answer as unreadable, not as no children (#3658)", async () => {
		const r = await run({
			issues: [{ number: 40, openSubIssues: 1 }, { number: 41 }],
			emptySubIssues: [40],
		});
		expect(r.order()).toEqual([41]);
	});

	it("re-admits a parent once its last child closes", async () => {
		const r = await run({ issues: [{ number: 40 }] });
		expect(r.order()).toEqual([40]);
	});

	it("treats an assignee as the claim and drops the issue", async () => {
		const r = await run({
			issues: [{ number: 1, assignees: ["owner"] }, { number: 2 }],
			claims: { 1: "self" },
		});
		expect(r.order()).toEqual([2]);
		expect(r.out).toMatch(/#1\s+.*claimed by owner/);
	});

	it("never filters on a readiness label, since no close clears one", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2, labels: ["takes:implement"] }],
		});
		expect(r.order()).toEqual([1, 2]);
	});

	it("drops pull requests, which share the issue number space", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2, pull_request: { url: "x" } }],
		});
		expect(r.order()).toEqual([1]);
		expect(r.out).toMatch(/OPEN ISSUES: 1/);
	});
});

describe("ordering", () => {
	it("counts reach transitively over open descendants", async () => {
		// 1 <- 2 <- 3 <- 4: only mantahostels#1 is takeable, and its reach is 3, not 1 — mantahostels#101
		// (what defines urgency) made reach transitive.
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }],
			deps: {
				2: [{ number: 1, state: "open" }],
				3: [{ number: 2, state: "open" }],
				4: [{ number: 3, state: "open" }],
			},
		});
		expect(r.out).toMatch(/#1\s+3\s/);
	});

	it("sorts an urgent above every non-bug, and reports who applied it", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }, { number: 3, labels: ["urgent"] }],
			deps: { 2: [] },
			timeline: {
				3: [{ label: "urgent", created_at: daysAgo(2), actor: "owner" }],
			},
			// mantahostels#1 and mantahostels#2 have reach 0 too, so only urgency can lift mantahostels#3 to the top.
		});
		expect(r.order()[0]).toBe(3);
		expect(r.out).toMatch(/#3\s+applied by owner 2d ago/);
	});

	it("keeps an urgent applied 9 days ago in the urgent band — it never expires (#2664)", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 3, labels: ["urgent"] }],
			timeline: {
				3: [{ label: "urgent", created_at: daysAgo(9), actor: "owner" }],
			},
		});
		expect(r.order()).toEqual([3, 1]);
		expect(r.out).toMatch(/#3\s+applied by owner 9d ago/);
	});

	it("ranks a descendant of an urgent map as urgent, with no label of its own (#2664)", async () => {
		const fx = {
			issues: [
				{ number: 1 },
				{ number: 10, labels: ["wayfinder:map", "urgent"] },
				{ number: 11, parent: 10 },
				{ number: 12, parent: 11 },
			],
			timeline: {
				10: [{ label: "urgent", created_at: daysAgo(10), actor: "owner" }],
			},
		};
		const rows = (await run(fx, ["--json"])).json().frontier;
		expect(rows.map((f: { number: number }) => f.number)).toEqual([12, 1]);
		expect(rows[0]).toMatchObject({
			urgent: true,
			urgentVia: { number: 10, path: ["#11", "#10"] },
			bug: false,
		});
		const text = await run(fx);
		expect(text.out).toMatch(
			/^ {2}#12 {2}urgent via #10 \(holds #11 → #10\)$/m,
		);
		expect(text.out).toMatch(/#12\s+via\s/);
	});

	it("passes urgency down from a parent that is not a map (#3250)", async () => {
		const r = await run({
			issues: [
				{ number: 1 },
				{ number: 10, labels: ["kind:spec", "urgent"] },
				{ number: 11, parent: 10 },
			],
			timeline: {
				10: [{ label: "urgent", created_at: daysAgo(1), actor: "owner" }],
			},
		});
		expect(r.order()).toEqual([11, 1]);
	});

	it("passes a plain ticket's urgency down its child, to that child's blocker, and on to the blocker's child (#3250)", async () => {
		// #10 urgent, a plain ticket, parent of #11; #20 blocks #11; #21 is
		// #20's child, so #20 is a heading and #21 the work.
		const fx = {
			issues: [
				{ number: 1 },
				{ number: 10, labels: ["urgent"] },
				{ number: 11, parent: 10 },
				{ number: 20 },
				{ number: 21, parent: 20 },
			],
			deps: { 11: [{ number: 20, state: "open" as const }] },
			timeline: {
				10: [{ label: "urgent", created_at: daysAgo(1), actor: "owner" }],
			},
		};
		const rows = (await run(fx, ["--json"])).json().frontier;
		expect(rows.map((f: { number: number }) => f.number)).toEqual([21, 1]);
		expect(rows[0]).toMatchObject({
			urgent: true,
			urgentVia: { number: 10, path: ["#20", "#11", "#10"] },
		});
	});

	it("ranks a map's last open child on depth plus closes, carrying both in --json (#3613)", async () => {
		// #11 is #10's only open child, so it closes #10; #3 shares parent #2
		// with #4. Both score depth 1, reach 1; closes lifts #11.
		const fx = {
			issues: [
				{ number: 2 },
				{ number: 3, parent: 2 },
				{ number: 4, parent: 2 },
				{ number: 10 },
				{ number: 11, parent: 10 },
			],
		};
		const rows = (await run(fx, ["--json"])).json().frontier;
		expect(rows.map((f: { number: number }) => f.number)).toEqual([11, 3, 4]);
		expect(rows[0]).toMatchObject({ depth: 1, closes: 1, reach: 1 });
		expect(rows[1]).toMatchObject({ depth: 1, closes: 0, reach: 1 });
	});

	it("passes an urgent map's tier through its child to that child's blocker (#3222)", async () => {
		// #10 urgent map, its child #11, which #20 blocks. #1 ties #20 on
		// reach, so only the inherited tier can lift #20 above it.
		const fx = {
			issues: [
				{ number: 1 },
				{ number: 2 },
				{ number: 3 },
				{ number: 10, labels: ["wayfinder:map", "urgent"] },
				{ number: 11, parent: 10 },
				{ number: 20 },
			],
			deps: {
				2: [{ number: 1, state: "open" as const }],
				3: [{ number: 1, state: "open" as const }],
				11: [{ number: 20, state: "open" as const }],
			},
			timeline: {
				10: [{ label: "urgent", created_at: daysAgo(1), actor: "owner" }],
			},
		};
		const rows = (await run(fx, ["--json"])).json().frontier;
		expect(rows.map((f: { number: number }) => f.number)).toEqual([20, 1]);
		expect(rows[0]).toMatchObject({
			urgent: true,
			urgentVia: { number: 10, path: ["#11", "#10"] },
			depth: 2,
			closes: 0,
			reach: 2,
		});
		const text = await run(fx);
		expect(text.out).toMatch(
			/^ {2}#20 {2}urgent via #10 \(holds #11 → #10\)$/m,
		);
	});

	it("ranks the deeper blocker of an urgent issue above the wider one (#3222)", async () => {
		// #30 urgent, blocked by #31 and #32; #33 blocks #31. #32 also holds
		// #40 and #41, so it leads on reach (3 to 2); depth (2 to 1) must win.
		const fx = {
			issues: [30, 31, 32, 33, 40, 41].map((number) => ({
				number,
				...(number === 30 ? { labels: ["urgent"] } : {}),
			})),
			deps: {
				30: [
					{ number: 31, state: "open" as const },
					{ number: 32, state: "open" as const },
				],
				31: [{ number: 33, state: "open" as const }],
				40: [{ number: 32, state: "open" as const }],
				41: [{ number: 32, state: "open" as const }],
			},
			timeline: {
				30: [{ label: "urgent", created_at: daysAgo(1), actor: "owner" }],
			},
		};
		const rows = (await run(fx, ["--json"])).json().frontier;
		expect(rows.map((f: { number: number }) => f.number)).toEqual([33, 32]);
		expect(rows[0]).toMatchObject({ urgent: true, depth: 2, reach: 2 });
		expect(rows[1]).toMatchObject({ urgent: true, depth: 1, reach: 3 });
	});

	it("passes goal-set membership to every issue holding a member out (#3222)", async () => {
		// #2 blocks #3, whose parent #5 is the goal; #1 holds nothing.
		const r = await run(
			{
				issues: [
					{ number: 1 },
					{ number: 2 },
					{ number: 3, parent: 5 },
					{ number: 5 },
				],
				deps: { 3: [{ number: 2, state: "open" as const }] },
			},
			["--goal", "5", "--json"],
		);
		const rows = r.json().frontier;
		expect(rows.map((f: { number: number }) => f.number)).toEqual([2, 1]);
		expect(rows[0]).toMatchObject({
			goal: true,
			goalVia: { number: 5, path: ["#3", "#5"] },
		});
		expect(rows[1]).toMatchObject({ goal: false, goalVia: null, depth: 0 });
	});

	it("ranks an unlabelled bug above an urgent non-bug (#2664)", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1 },
					{ number: 2, labels: ["urgent"] },
					{ number: 3, labels: ["bug"] },
				],
				timeline: {
					2: [{ label: "urgent", created_at: daysAgo(1), actor: "owner" }],
				},
			},
			["--json"],
		);
		const rows = r.json().frontier;
		expect(rows.map((f: { number: number }) => f.number)).toEqual([3, 2, 1]);
		expect(rows[0]).toMatchObject({ bug: true, urgent: true, urgentVia: null });
	});

	it("flags an empty or whitespace-only body on the frontier under EMPTY BODY, naming each issue in text and JSON, excluding nothing (mantahostels#3443)", async () => {
		const fx = {
			issues: [
				{ number: 1, body: "Real work." },
				{ number: 2 },
				{ number: 3, body: " \n\t\n" },
			],
		};
		const text = await run(fx);
		expect(text.out).toMatch(/EMPTY BODY/);
		expect(text.out).toMatch(/^ {2}#2 {2}issue 2$/m);
		expect(text.out).toMatch(/^ {2}#3 {2}issue 3$/m);
		expect(text.out).not.toMatch(/^ {2}#1 {2}issue 1$/m);
		expect(text.order()).toEqual([1, 2, 3]);

		const json = (await run(fx, ["--json"])).json();
		expect(json.emptyBody).toEqual([
			{ number: 2, title: "issue 2" },
			{ number: 3, title: "issue 3" },
		]);
	});

	it("prints no EMPTY BODY block when every frontier body has text", async () => {
		const r = await run({ issues: [{ number: 1, body: "Real work." }] });
		expect(r.out).not.toMatch(/EMPTY BODY/);
	});

	it("ranks an urgent whose timeline is unreachable, saying its start is unrecorded", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 3, labels: ["urgent"] }],
			failTimeline: [3],
		});
		expect(r.order()).toEqual([3, 1]);
		expect(r.out).toMatch(/^ {2}#3 {2}URGENT — start unrecorded$/m);
	});

	it("puts the goal band above reach, keeping the high-reach issue on screen", async () => {
		// mantahostels#106 (how a stated goal reweights the queue) accepted this consequence:
		// draining a goal set lifts a reach-0 member above the most load-bearing
		// issue on the tracker, which must still print beneath the band.
		const r = await run(
			{
				issues: [{ number: 22 }, { number: 25 }, { number: 116 }],
				deps: { 25: [{ number: 22, state: "open" }] },
			},
			["--goal", "116"],
		);
		expect(r.order()).toEqual([116, 22]);
		expect(r.out).toMatch(/GOAL SET \(1\): #116/);
	});

	it("breaks a tie within each ticket-type band toward the ticket that writes no repo file", async () => {
		const r = await run({
			issues: [
				{ number: 1, labels: ["kind:ticket"] },
				{ number: 2, labels: ["wayfinder:grilling", "takes:wayfinder"] },
				{ number: 3, labels: ["wayfinder:research"] },
				{ number: 4, labels: ["takes:wayfinder"] },
			],
		});
		// All four tie at reach 0; within each type band only collision orders them.
		expect(r.order()).toEqual([2, 4, 3, 1]);
	});

	/* #2001. */
	it("puts a question-asking ticket above an implement ticket with higher reach", async () => {
		// Issue 2 outranks every other on reach; delete the type level and it leads.
		const r = await run(
			{
				issues: [
					{ number: 1, labels: ["wayfinder:grilling", "takes:wayfinder"] },
					{ number: 2, labels: ["kind:ticket", "takes:implement"] },
					{ number: 3 },
					{ number: 4, labels: ["wayfinder:prototype", "takes:wayfinder"] },
					{ number: 5, labels: ["takes:wayfinder"] },
					{ number: 6, labels: ["wayfinder:map", "takes:wayfinder"] },
					{ number: 7, labels: ["wayfinder:grilling", "takes:implement"] },
				],
				deps: { 3: [{ number: 2, state: "open" }] },
			},
			["--json"],
		);
		const frontier = r.json().frontier;
		expect(frontier.map((i: { number: number }) => i.number)).toEqual([
			1, 4, 5, 2, 7, 6,
		]);
		expect(frontier[0].asksQuestions).toBe(true);
		expect(frontier[3].reach).toBe(1);
		expect(frontier[3].asksQuestions).toBe(false);
		// A `takes:` value overrides the type label that disagrees with it.
		expect(frontier[4].asksQuestions).toBe(false);
		// A map asks nothing by itself, though it takes /wayfinder.
		expect(frontier[5].asksQuestions).toBe(false);
	});

	it("keeps an urgent, the goal set and a stalled wait above the type level", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, labels: ["wayfinder:grilling", "takes:wayfinder"] },
					{ number: 4, labels: ["takes:implement"] },
					{ number: 2, labels: ["urgent", "takes:implement"] },
					{ number: 3, labels: ["waiting:external", "takes:implement"] },
				],
				timeline: {
					2: [{ label: "urgent", created_at: daysAgo(1), actor: "owner" }],
					3: [
						{
							label: "waiting:external",
							created_at: daysAgo(30),
							actor: "owner",
						},
					],
				},
			},
			["--goal", "4"],
		);
		expect(r.order()).toEqual([2, 4, 3, 1]);
	});

	it("falls back to issue number when every other level ties", async () => {
		const r = await run({
			issues: [{ number: 9 }, { number: 4 }, { number: 7 }],
		});
		expect(r.order()).toEqual([4, 7, 9]);
	});

	it("hands each frontier row's creation date to the merge across repos", async () => {
		const r = await run(
			{ issues: [{ number: 4, createdAt: "2026-01-02T03:04:05Z" }] },
			["--json"],
		);
		expect(r.json().frontier[0].createdAt).toBe("2026-01-02T03:04:05Z");
	});
});

describe("a goal the script works out itself (#3866)", () => {
	const members = (r: {
		json: () => { goalSet: { members: { repo: string; number: number }[] } };
	}) => r.json().goalSet.members.map((m) => `${m.repo}#${m.number}`);
	const map = {
		issues: [
			{ number: 1 },
			{ number: 2, parent: 1 },
			{ number: 3, parent: 2 },
			{ number: 4 },
			{ number: 5, parent: 4 },
		],
	};

	it("drains a ref's open descendants at any depth, not the ref or a stranger", async () => {
		const r = await run(map, ["--json", "--goal", "drain #1"]);
		expect(members(r)).toEqual(["o/r#2", "o/r#3"]);
		const goalRows = r
			.json()
			.frontier.filter((row: { goal: boolean }) => row.goal)
			.map((row: { number: number }) => row.number);
		expect(goalRows).toContain(3);
		expect(goalRows).not.toContain(5);
	});

	it("takes a child filed since on the next run, the goal unchanged", async () => {
		const later = { issues: [...map.issues, { number: 6, parent: 2 }] };
		expect(members(await run(later, ["--json", "--goal", "drain #1"]))).toEqual(
			["o/r#2", "o/r#3", "o/r#6"],
		);
	});

	it("drains a child whose parent is another checkout's issue", async () => {
		const home = path.join(kit.dir, "adopters");
		writeAdopterCheckout(path.join(home, "manta"), "o/manta");
		const r = await run(
			{
				issues: [
					{
						number: 7,
						parentUrl: "https://api.github.com/repos/o/manta/issues/40",
					},
					{ number: 8, parent: 7 },
					{
						number: 9,
						parentUrl: "https://api.github.com/repos/o/z/issues/40",
					},
				],
			},
			["--json", "--goal", "drain manta#40"],
			{ env: { HOME: home } },
		);
		expect(members(r)).toEqual(["o/r#7", "o/r#8"]);
	});

	it("unblocks a ref through its blockers, across repos and through its children", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1 },
					{ number: 2, parent: 1 },
					{ number: 3 },
					{ number: 4 },
				],
				deps: {
					1: [
						{ number: 3, state: "open" as const },
						{ number: 10, state: "open" as const, repo: "o/y" },
						{ number: 11, state: "closed" as const, repo: "o/y" },
					],
				},
				foreignDeps: {
					"o/y#10": [{ number: 20, state: "open" as const, repo: "o/z" }],
				},
			},
			["--json", "--goal", "unblock #1"],
		);
		expect(members(r)).toEqual(["o/r#1", "o/r#2", "o/r#3", "o/y#10", "o/z#20"]);
		expect(r.json().pulledIn).toEqual([
			expect.objectContaining({ repo: "o/z", number: 20, goal: true }),
		]);
		const row = (n: number) =>
			r.json().frontier.find((f: { number: number }) => f.number === n);
		expect(row(3).goal).toBe(true);
		expect(row(4).goal).toBe(false);
	});

	it("prints the set it worked out before the ranking", async () => {
		const r = await run(map, ["--goal", "drain #1"]);
		expect(r.out).toMatch(/GOAL SET \(2\): #2, #3/);
		const none = await run(map, ["--goal", "drain #3"]);
		expect(none.out).toMatch(/GOAL SET \(0\): none open/);
	});

	it("finds nothing open for a ref closed since, so the run ranks bare", async () => {
		for (const goal of ["unblock #99", "99", "drain #99"]) {
			const r = await run(map, ["--json", "--goal", goal]);
			expect(members(r)).toEqual([]);
			expect(r.json().frontier.some((row: { goal: boolean }) => row.goal)).toBe(
				false,
			);
		}
	});

	it("reports the open issues a live session holds, for the goal's running count", async () => {
		const r = await run(
			{
				issues: [{ number: 1, assignees: ["me"] }, { number: 2 }],
				claims: { 1: "self" },
			},
			["--json"],
		);
		expect(r.json().running).toEqual([1]);
		expect(r.json().goalSet).toBeNull();
	});

	it.each(["drain", "drain #1 #2", "soon"])(
		"refuses %j, naming it",
		async (goal) => {
			const r = await run(map, ["--goal", goal]);
			expect(r.status).toBe(2);
			expect(r.out).toContain("--goal takes issue refs");
			expect(r.out).toContain(goal);
		},
	);

	it("ranks nothing for a checkout gone from the machine, keeping its shortlist", async () => {
		const r = await run(map, ["--json", "--goal", "drain ghost#5"]);
		expect(r.status).toBe(0);
		expect(r.out).toContain("--goal names ghost#5: no checkout named ghost");
		expect(members(r)).toEqual([]);
		expect(
			r.json().frontier.map((row: { number: number }) => row.number),
		).toEqual([3, 5]);
	});

	it("refuses an unblock in another repo: that repo's run walks it", async () => {
		const home = path.join(kit.dir, "adopters");
		writeAdopterCheckout(path.join(home, "manta"), "o/manta");
		const r = await run(map, ["--goal", "unblock manta#40"], {
			env: { HOME: home },
		});
		expect(r.status).toBe(2);
		expect(r.out).toContain("o/manta#40, another repo's: run it there");
	});
});

/* mantahostels#227, which gave the `takes:` label its first reader. */
describe("the takes: column", () => {
	it("shows each shortlisted issue's takes: value", async () => {
		const r = await run({
			issues: [
				{ number: 1, labels: ["takes:implement"] },
				{ number: 2, labels: ["takes:wayfinder"] },
			],
		});
		expect(r.out).toMatch(/^#1\s.*\simplement\s/m);
		expect(r.out).toMatch(/^#2\s.*\swayfinder\s/m);
		expect(r.out).toMatch(/TAKES/);
	});

	it("prints `none` rather than a blank when the label is missing", async () => {
		// Every open issue carries exactly one, so absence is a fault to see, not
		// a state.
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.out).toMatch(/^#1\s.*\snone\s/m);
	});

	it("shows both when an issue wrongly carries two", async () => {
		const r = await run({
			issues: [{ number: 1, labels: ["takes:implement", "takes:triage"] }],
		});
		expect(r.out).toMatch(/implement\+triage/);
	});

	it("never lets the label reach the ordering", async () => {
		// Display only: mantahostels#111 rejected selection writing `takes:`.
		const r = await run({
			issues: [
				{ number: 9, labels: ["takes:human"] },
				{ number: 4 },
				{ number: 7, labels: ["takes:implement"] },
			],
		});
		expect(r.order()).toEqual([4, 7, 9]);
	});

	it("carries the value into --json", async () => {
		const r = await run(
			{ issues: [{ number: 1, labels: ["takes:to-spec"] }] },
			["--json"],
		);
		expect(r.json().frontier[0].takes).toEqual(["to-spec"]);
	});
});

/*
 * mantahostels#259: the shape `waiting:external` defends against is mantahostels#85 (no working channel
 * to an outside partner), whose request stalled with nothing surfacing the
 * silence.
 */
describe("the waiting:external escalation", () => {
	const waiting = (n: number, days: number) => ({
		[n]: [
			{
				label: "waiting:external",
				created_at: daysAgo(days),
				actor: "owner",
			},
		],
	});

	it("lifts a stalled wait above a higher-reach issue, and prints the days", async () => {
		// Delete the stall level from the sort and mantahostels#2 wins on reach.
		const r = await run({
			issues: [
				{ number: 1, labels: ["waiting:external"] },
				{ number: 2 },
				{ number: 3 },
			],
			deps: { 3: [{ number: 2, state: "open" }] },
			timeline: waiting(1, 40),
		});
		expect(r.order()).toEqual([1, 2]);
		expect(r.out).toMatch(/^#1\s+40d!\s/m);
		expect(r.out).toMatch(/#1\s+40d, since .* by owner — STALLED, ranked up/);
	});

	it("puts a longer stall above a shorter one", async () => {
		const r = await run({
			issues: [
				{ number: 1, labels: ["waiting:external"] },
				{ number: 2, labels: ["waiting:external"] },
			],
			timeline: { ...waiting(1, 20), ...waiting(2, 60) },
		});
		expect(r.order()).toEqual([2, 1]);
	});

	it("leaves a wait under the threshold ranked exactly as an unlabelled one", async () => {
		const r = await run({
			issues: [
				{ number: 1, labels: ["waiting:external"] },
				{ number: 2 },
				{ number: 3 },
			],
			deps: { 3: [{ number: 2, state: "open" }] },
			timeline: waiting(1, 3),
		});
		expect(r.order()).toEqual([2, 1]);
		expect(r.out).toMatch(/^#1\s+3d\s/m);
	});

	it("escalates on either side of the 7-day threshold", async () => {
		// `daysAgo(7)` drifts by the milliseconds between building the fixture
		// and reading the clock, so asserting on exactly 7 is a coin toss.
		// mantahostels#2 outranks mantahostels#1 on reach, so only a firing stall can invert the pair.
		const pair = [
			{ number: 1, labels: ["waiting:external"] },
			{ number: 2 },
			{ number: 3 },
		];
		const deps = { 3: [{ number: 2, state: "open" as const }] };

		const under = await run({ issues: pair, deps, timeline: waiting(1, 6.9) });
		expect(under.order()).toEqual([2, 1]);
		expect(under.out).toMatch(/^#1\s+6d\s/m);

		const over = await run({ issues: pair, deps, timeline: waiting(1, 7.1) });
		expect(over.order()).toEqual([1, 2]);
		expect(over.out).toMatch(/^#1\s+7d!\s/m);
	});

	it("keeps an urgent and the goal set above even a long stall", async () => {
		// Both are what a human just said matters; the stall is inferred.
		const r = await run(
			{
				issues: [
					{ number: 1, labels: ["waiting:external"] },
					{ number: 2, labels: ["urgent"] },
					{ number: 3 },
				],
				timeline: {
					...waiting(1, 60),
					2: [{ label: "urgent", created_at: daysAgo(1), actor: "owner" }],
				},
			},
			["--goal", "3"],
		);
		expect(r.order()).toEqual([2, 3, 1]);
	});

	it("keeps a waiting issue in the shortlist", async () => {
		const r = await run({
			issues: [{ number: 1, labels: ["waiting:external"] }, { number: 2 }],
			timeline: waiting(1, 60),
		});
		expect(r.order()).toContain(1);
	});

	it("still shows the wait on an issue the shortlist excludes", async () => {
		// mantahostels#85 was claimed while its silence ran, so the rank level cannot reach it.
		const r = await run({
			issues: [
				{ number: 85, labels: ["waiting:external"], assignees: ["owner"] },
				{ number: 2 },
			],
			claims: { 85: "self" },
			timeline: waiting(85, 44),
		});
		expect(r.order()).not.toContain(85);
		expect(r.out).toMatch(/#85\s+44d, since/);
		expect(r.out).toMatch(/not in the shortlist: claimed by owner/);
	});

	it("leaves the rank untouched when the label's start is unreadable", async () => {
		const r = await run({
			issues: [
				{ number: 1, labels: ["waiting:external"] },
				{ number: 2 },
				{ number: 3 },
			],
			deps: { 3: [{ number: 2, state: "open" }] },
			failTimeline: [1],
		});
		expect(r.order()).toEqual([2, 1]);
		expect(r.out).toMatch(/^#1\s+\?\s/m);
		expect(r.out).toMatch(/#1\s+age unknown \(.*\) — rank untouched/);
	});

	it("reads the timeline once for an issue carrying both age-sensitive labels", async () => {
		const r = await run({
			issues: [{ number: 1, labels: ["waiting:external", "urgent"] }],
			timeline: {
				1: [
					{ label: "waiting:external", created_at: daysAgo(40), actor: "a" },
					{ label: "urgent", created_at: daysAgo(1), actor: "a" },
				],
			},
		});
		expect(r.calls().filter((c) => /timeline/.test(c))).toHaveLength(1);
		expect(r.out).toMatch(/^#1\s+yes\s+40d!\s/m);
	});

	it("never writes the label — no method, no labels endpoint", async () => {
		const r = await run({
			issues: [{ number: 1, labels: ["waiting:external"] }],
			timeline: waiting(1, 60),
		});
		for (const call of r.calls())
			expect(call).not.toMatch(/(^|\s)(-X|--method)(\s|$)/);
		expect(restCalls(r.calls()).join("\n")).not.toMatch(/labels/);
		expectGraphqlReadsOnly(r.calls());
	});

	it("carries the wait into --json, excluded issues included", async () => {
		const r = await run(
			{
				issues: [
					{ number: 85, labels: ["waiting:external"], assignees: ["luc"] },
					{ number: 90, labels: ["waiting:external"] },
				],
				claims: { 85: "self" },
				timeline: { ...waiting(85, 44), ...waiting(90, 2) },
			},
			["--json"],
		);
		const w = r.json().waiting;
		expect(w.map((x: { number: number }) => x.number)).toEqual([85, 90]);
		expect(w[0].stalled).toBe(true);
		expect(w[0].excluded).toBe("claimed by luc");
		expect(w[1].stalled).toBe(false);
		expect(w[1].excluded).toBe(null);
	});
});

/*
 * #2000, #2703: a parked ticket stays choosable; the refill loop holds it out
 * of a launch (lib/refill-decide.js). The PARKED block keeps the park from
 * going quiet.
 */
describe("the parked label", () => {
	const parked = (n: number, days: number) => ({
		[n]: [{ label: "parked", created_at: daysAgo(days), actor: "owner" }],
	});

	it("keeps a parked ticket choosable and lists it under PARKED with its age", async () => {
		const r = await run({
			issues: [
				{ number: 1, labels: ["takes:wayfinder", "parked"] },
				{ number: 2, labels: ["takes:implement"] },
			],
			timeline: parked(1, 3),
		});
		expect([...r.order()].sort()).toEqual([1, 2]);
		expect(r.out).toMatch(/^PARKED — /m);
		expect(r.out).toMatch(/#1\s+3d, since \S+/);
		expect(r.out).toMatch(
			/Choosable here\. An away-mode refill loop skips it; a normal-mode one resumes\n {2}it ahead of new work, oldest park first\./,
		);
		expect(r.out).toMatch(/open tally +2 open, 2 frontier/);
	});

	it("puts a parked ticket on the --json frontier and in its parked list", async () => {
		const r = await run(
			{
				issues: [{ number: 1, labels: ["parked"] }, { number: 2 }],
				timeline: parked(1, 3),
			},
			["--json"],
		);
		const j = r.json();
		expect(j.frontier.map((x: { number: number }) => x.number)).toContain(1);
		expect(j.parked.map((x: { number: number }) => x.number)).toEqual([1]);
	});

	it("lists a parked ticket another limb excludes, oldest park first", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, labels: ["parked"] },
					{ number: 2, labels: ["parked"], assignees: ["owner"] },
				],
				claims: { 2: "self" },
				timeline: { ...parked(1, 1), ...parked(2, 9) },
			},
			["--json"],
		);
		const p = r.json().parked;
		expect(p.map((x: { number: number }) => x.number)).toEqual([2, 1]);
		expect(p[0].days).toBe(9);
		expect(p[0].ageUnknown).toBe(null);
	});

	it("says the age is unknown where the timeline is unreadable", async () => {
		const r = await run({
			issues: [{ number: 1, labels: ["parked"] }, { number: 2 }],
			failTimeline: [1],
		});
		expect(r.out).toMatch(/#1\s+age unknown \(/);
	});
});

describe("when the tracker misbehaves", () => {
	it("retries a failed dependency call once and keeps the issue on a success", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			failDepsOnce: [2],
		});
		expect(r.status).toBe(0);
		expect(r.order()).toEqual([1, 2]);
		expect(r.out).not.toMatch(/DEGRADED/);
	});

	it("reads every issue's blockers in one batched call, no per-issue call (#2685)", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }, { number: 3 }],
			deps: { 3: [{ number: 1, state: "open" }] },
		});
		expect(r.order()).toEqual([1, 2]);
		const calls = fs.readFileSync(CALL_LOG(), "utf8");
		expect(calls).not.toMatch(/dependencies\/blocked_by/);
		expect(calls.match(/^api graphql /gm)).toHaveLength(1);
	});

	it("reads the full blocker list of an issue with more than the batch's inner page (#2685)", async () => {
		// The batch reads 25 blockers per issue; #1's 26th, the only open one,
		// is past that page, so only the REST read can see it.
		const many = Array.from({ length: 26 }, (_, k) => ({
			number: 100 + k,
			state: k === 25 ? ("open" as const) : ("closed" as const),
		}));
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }, { number: 125 }],
			deps: { 1: many },
		});
		expect(r.order()).toEqual([125, 2]);
		const calls = fs.readFileSync(CALL_LOG(), "utf8");
		expect(calls).toMatch(/issues\/1\/dependencies\/blocked_by/);
		expect(calls).not.toMatch(/issues\/2\/dependencies\/blocked_by/);
	});

	it("holds every issue in a failed batch out as readiness unknown, never unblocked (#2685)", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			failGraphql: true,
		});
		expect(r.status).toBe(0);
		expect(r.order()).toEqual([]);
		expect(r.out).toMatch(/DEGRADED \(2\) — readiness unknown/);
		expect(r.out).toContain(GH_NOT_FOUND.stderr.trim());
		const calls = fs.readFileSync(CALL_LOG(), "utf8");
		expect(calls).not.toMatch(/dependencies\/blocked_by/);
	});

	it("retries a failed batch once and keeps its issues on a success (#2685)", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			failGraphqlOnce: true,
		});
		expect(r.order()).toEqual([1, 2]);
		expect(r.out).not.toMatch(/DEGRADED/);
	});

	for (const answer of ["empty", "noRepo"] as const)
		it(`reads a batch answering ${answer} as readiness unknown, never as no blockers (#2685)`, async () => {
			const r = await run({
				issues: [{ number: 1 }],
				deps: { 1: [{ number: 9, state: "open" }] },
				graphqlAnswers: answer,
			});
			expect(r.order()).toEqual([]);
			expect(r.out).toMatch(/DEGRADED \(1\) — readiness unknown/);
		});

	it("holds an issue out of the shortlist when its readiness stays unknown", async () => {
		// Never assumed takeable: a session would claim work something else gates.
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			failDeps: [2],
		});
		expect(r.status).toBe(0);
		expect(r.order()).toEqual([1]);
		expect(r.out).toMatch(/DEGRADED \(1\) — readiness unknown/);
		expect(r.out).toMatch(/#2\s/);
		expect(r.out).toContain(GH_NOT_FOUND.stderr.trim());
	});

	it("qualifies the headline on the same line when any issue is degraded (#93)", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }],
			failDeps: [2],
		});
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/TAKEABLE NOW: 1\s+\(1 unread, see DEGRADED\)/);
	});

	it("leaves the headline unqualified with nothing degraded (#93)", async () => {
		const r = await run({ issues: [{ number: 1 }] });
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/TAKEABLE NOW: 1\n/);
		expect(r.out).not.toContain("see DEGRADED");
	});

	it("collapses more than 3 degraded issues failing the same way into one line (#93)", async () => {
		const numbers = [11, 12, 13, 14];
		const r = await run({
			issues: [{ number: 1 }, ...numbers.map((number) => ({ number }))],
			failDeps: numbers,
		});
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/DEGRADED \(4\)/);
		expect(r.out).toContain(
			`4 failing the same way — ${GH_NOT_FOUND.stderr.trim()}`,
		);
		for (const n of numbers) expect(r.out).toContain(`#${n}`);
	});

	it("keeps individual blocks for 3 or fewer degraded issues sharing an error (#93)", async () => {
		const numbers = [21, 22, 23];
		const r = await run({
			issues: [{ number: 1 }, ...numbers.map((number) => ({ number }))],
			failDeps: numbers,
		});
		expect(r.status).toBe(0);
		expect(r.out).not.toMatch(/failing the same way/);
		for (const n of numbers) {
			expect(r.out).toMatch(new RegExp(`#${n}\\s+issue ${n}`));
		}
	});

	it("says reach is a lower bound when an issue is degraded", async () => {
		// mantahostels#3's blocked_by is what would have recorded the mantahostels#1 -> mantahostels#3 edge, so losing
		// that call costs mantahostels#1 a reach point.
		const r = await run({
			issues: [{ number: 1 }, { number: 2 }, { number: 3 }],
			deps: { 3: [{ number: 1, state: "open" }] },
			failDeps: [3],
		});
		expect(r.out).toMatch(/#1\s+0\s/);
		expect(r.out).toMatch(/every REACH above is a lower\s+bound/);
	});

	it("flags the lower bound in JSON too", async () => {
		const clean = await run({ issues: [{ number: 1 }] }, ["--json"]);
		expect(clean.json().reachIsLowerBound).toBe(false);
	});

	it("fails loudly when the issue list itself is unreachable, warning it is no empty frontier and printing no shortlist", async () => {
		// An empty shortlist would read as "the tracker is drained".
		const r = await run({ issues: [{ number: 1 }], failList: true });
		expect(r.status).toBe(1);
		expect(r.out).toMatch(/FAILED: could not list open issues/);
		expect(r.out).toMatch(/do not\s+read this as an empty frontier/);
		expect(r.out).not.toMatch(/TAKEABLE NOW/);
	});
});

describe("an empty issue list (#2565)", () => {
	it("re-reads it, then fails loudly where the repo counts open issues, printing the refusal whole", async () => {
		const r = await run({ issues: [], openCount: 5 });
		expect(r.status).toBe(1);
		expect(r.calls().filter((c) => /issues\?state=open/.test(c))).toHaveLength(
			2,
		);
		expect(r.out).toMatch(/GitHub counts 5 open on the repo/);
		expect(r.out).not.toMatch(/fault in the query/);
		expect(r.out).toMatch(/do not\s+read this as an empty frontier/);
	});
});

describe("advisory only", () => {
	it("issues nothing but gh api GETs — no method, no write subcommand", async () => {
		const r = await run({
			issues: [{ number: 1, labels: ["urgent"] }, { number: 2 }],
			timeline: {
				1: [{ label: "urgent", created_at: daysAgo(1), actor: "someone" }],
			},
		});
		for (const call of r.calls()) {
			expect(call.split(" ")[0]).toBe("api");
			expect(call).not.toMatch(/(^|\s)(-X|--method)(\s|$)/);
		}
		// The `urgent` path is the one mantahostels#101 (what defines urgency) and mantahostels#111 (who
		// may apply it) both guarded: read and display, never apply, never strip.
		expect(restCalls(r.calls()).join("\n")).not.toMatch(/labels/);
		expectGraphqlReadsOnly(r.calls());
		expect(r.out).toMatch(/nothing here was written back to the tracker/);
	});

	it("emits the same frontier as JSON, with the reasons for each exclusion", async () => {
		const r = await run(
			{
				issues: [{ number: 1 }, { number: 2, assignees: ["someone"] }],
				claims: { 2: "self" },
			},
			["--json"],
		);
		const j = r.json();
		expect(j.frontier.map((f: { number: number }) => f.number)).toEqual([1]);
		expect(j.excluded).toEqual([
			{ number: 2, title: "issue 2", reason: "claimed by someone" },
		]);
		expect(j.degraded).toEqual([]);
	});

	it("refuses a flag given as another flag's value, naming the flag that needs a value (#920)", async () => {
		// `--goal --json` must not resolve to the goal set "--json".
		const r = await run({ issues: [{ number: 1 }] }, ["--goal", "--json"]);
		expect(r.status).toBe(2);
		expect(r.out).toMatch(/--goal needs a value/);
	});

	it("caps the printed shortlist with --limit without hiding the true count", async () => {
		const r = await run(
			{ issues: [{ number: 1 }, { number: 2 }, { number: 3 }] },
			["--limit", "2"],
		);
		expect(r.order()).toEqual([1, 2]);
		expect(r.out).toMatch(/TAKEABLE NOW: 3\s+\(showing 2\)/);
	});
});

describe("a date gate in the body (mantahostels#85)", () => {
	/*
	 * A YYYY-MM-DD `n` days from now, the shape the marker takes — on WITA, the
	 * clock a gate is written and read on. A UTC date here would put every case
	 * a day out for the eight hours after 16:00 UTC.
	 */
	const isoIn = (n: number) =>
		new Date(Date.now() + WITA_OFFSET_MS + n * 86_400_000)
			.toISOString()
			.slice(0, 10);
	const gate = (n: number, why = "waiting on Bunkward") =>
		`Some body text.\n\n**Gated until:** ${isoIn(n)} — ${why}\n\nMore text.`;

	it("holds a gated issue out of the shortlist and says until when", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 85, body: gate(9) }],
		});
		expect(r.order()).toEqual([1]);
		expect(r.out).toMatch(
			new RegExp(
				`#85\\s+held until ${isoIn(9)}, 9d left — waiting on Bunkward`,
			),
		);
	});

	it("still prints it under the waiting banner, to be chased anyway", async () => {
		// The point of reusing `excluded` rather than dropping the issue: it leaves
		// the batch without leaving the report.
		const r = await run({
			issues: [
				{ number: 1 },
				{ number: 85, body: gate(9), labels: ["waiting:external"] },
			],
			timeline: {
				85: [
					{ label: "waiting:external", created_at: daysAgo(5), actor: "luc" },
				],
			},
		});
		expect(r.order()).toEqual([1]);
		expect(r.out).toMatch(
			/not in the shortlist: gated until .* — chase it anyway/,
		);
	});

	it("lets the issue back in once the date is reached, and says the gate lapsed", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 85, body: gate(-1) }],
		});
		expect(r.order()).toContain(85);
		expect(r.out).toMatch(
			new RegExp(`#85\\s+LAPSED ${isoIn(-1)} — back in the batch`),
		);
	});

	it("treats the named day itself as takeable, not as the last held day", async () => {
		// "Gated until the 24th" means free on the 24th: the boundary is that
		// date's midnight UTC, so a gate naming today is already spent.
		const r = await run({ issues: [{ number: 85, body: gate(0) }] });
		expect(r.order()).toContain(85);
		expect(r.out).toMatch(/LAPSED/);
	});

	it("turns the day on the founder's clock, not UTC", async () => {
		// WITA is UTC+8, so for the eight hours after 16:00 UTC the two disagree
		// about what day it is. Reading UTC would hold a gate through the morning
		// it was meant to lapse on. Only the WITA-dated gate is spent.
		const utcToday = new Date().toISOString().slice(0, 10);
		const r = await run({
			issues: [
				{ number: 85, body: `**Gated until:** ${isoIn(0)} — spent` },
				{ number: 86, body: `**Gated until:** ${isoIn(1)} — still holding` },
			],
		});
		expect(r.order()).toContain(85);
		expect(r.order()).not.toContain(86);
		// Only meaningful on the days the two clocks differ; harmless otherwise.
		if (utcToday !== isoIn(0)) expect(isoIn(0) > utcToday).toBe(true);
	});

	it("gates nothing on a date it cannot read, and says so rather than failing quietly", async () => {
		const r = await run({
			issues: [
				{ number: 85, body: "**Gated until:** next Tuesday — a chase is due" },
			],
		});
		expect(r.order()).toContain(85);
		// The whole tail comes back verbatim: which part of it was meant as the
		// date is precisely what could not be worked out.
		expect(r.out).toMatch(
			/#85\s+UNREADABLE DATE `next Tuesday — a chase is due` — GATING NOTHING/,
		);
	});

	it("rejects a well-shaped date that is not a real day, naming it as an UNREADABLE DATE and keeping the issue ranked", async () => {
		// 2026-02-30 parses in JS and silently becomes 2 March, so a round-trip is
		// what catches it.
		const r = await run({
			issues: [{ number: 85, body: "**Gated until:** 2026-02-30 — typo" }],
		});
		expect(r.order()).toContain(85);
		expect(r.out).toMatch(/UNREADABLE DATE `2026-02-30`/);
	});

	it("reports a gate with no reason rather than refusing to gate", async () => {
		const r = await run({
			issues: [
				{ number: 1 },
				{ number: 85, body: `**Gated until:** ${isoIn(5)}` },
			],
		});
		expect(r.order()).toEqual([1]);
		expect(r.out).toMatch(/#85\s+held until .*5d left — no reason given/);
	});

	it("reports a concrete blocker instead of the gate when both apply", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 85, body: gate(9) }],
			deps: { 85: [{ number: 1, state: "open" }] },
		});
		expect(r.out).toMatch(/#85\s+\w*\s*blocked by #1/);
		expect(r.out).not.toMatch(/#85\s+spec\s+gated until/);
	});

	it("ignores a marker that is not at the head of its own line", async () => {
		const r = await run({
			issues: [
				{ number: 85, body: `See also **Gated until:** ${isoIn(9)} — nope` },
			],
		});
		expect(r.order()).toContain(85);
		expect(r.out).not.toMatch(/GATED BY A LINE/);
	});

	it("carries every gate into --json, lapsed and unreadable ones included", async () => {
		const r = await run(
			{
				issues: [
					{ number: 85, body: gate(9) },
					{ number: 86, body: gate(-2, "lapsed one") },
					{ number: 87, body: "**Gated until:** soon — bad" },
				],
			},
			["--json"],
		);
		const g = r.json().gated;
		expect(g.map((x: { number: number }) => x.number)).toEqual([85, 86, 87]);
		expect(g[0]).toMatchObject({ active: true, until: isoIn(9), daysLeft: 9 });
		expect(g[1]).toMatchObject({ active: false, reason: "lapsed one" });
		expect(g[2]).toMatchObject({ active: false, malformed: "soon — bad" });
	});
});

describe("a data-condition gate in the body (mantahostels#1419)", () => {
	/** A YYYY-MM-DD `n` days from now on WITA, the clock a date gate is read on. */
	const isoIn = (n: number) =>
		new Date(Date.now() + WITA_OFFSET_MS + n * 86_400_000)
			.toISOString()
			.slice(0, 10);
	const gateCondition =
		"the eleven tickets have cleared the 5-day rework horizon";
	/* Backtick-quoted in a real body; kept regex-safe here so the assertions can
	 * match the printed line literally. */
	const gateCommand = "python3 scan_rework.py";
	const abandonCondition = "the label stops being applied";
	const gateOn = (cond = gateCondition, cmd: string | null = gateCommand) =>
		`Some body text.\n\n**Gated on:** ${cond}${cmd ? ` — check: ${cmd}` : ""} — abandon if: ${abandonCondition}\n\nMore text.`;

	it("holds a conditioned issue out of the shortlist and prints its line", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 1215, body: gateOn() }],
		});
		expect(r.order()).toEqual([1]);
		expect(r.out).toMatch(
			new RegExp(
				`#1215\\s+held on ${gateCondition} — check: ${gateCommand} — abandon if: ${abandonCondition}`,
			),
		);
	});

	it("holds a conditioned goal-set member out of the shortlist (#3102)", async () => {
		const r = await run(
			{ issues: [{ number: 1 }, { number: 1215, body: gateOn() }] },
			// --json: the frontier the refill loop reads (lib/refill-frontier.js)
			["--json", "--goal", "1215"],
		);
		expect(r.status).toBe(0);
		expect(r.json().frontier.map((f: { number: number }) => f.number)).toEqual([
			1,
		]);
	});

	it("states the condition in the exclusion reason, never a date", async () => {
		// The defect this whole marker exists to fix: a date-shaped reason line
		// where the truth is a sample count the reader could have checked.
		const r = await run({
			issues: [
				{ number: 1 },
				{
					number: 1215,
					body: gateOn(),
					labels: ["waiting:external"],
				},
			],
			timeline: {
				1215: [
					{ label: "waiting:external", created_at: daysAgo(5), actor: "luc" },
				],
			},
		});
		expect(r.out).toMatch(
			new RegExp(`not in the shortlist: gated on ${gateCondition}`),
		);
		expect(r.out).not.toMatch(/not in the shortlist: gated until/);
	});

	it("heads the banner with both spellings", async () => {
		const r = await run({ issues: [{ number: 1215, body: gateOn() }] });
		expect(r.out).toMatch(/GATED BY A LINE IN THE BODY/);
		expect(r.out).toMatch(/\*\*Gated until:\*\* YYYY-MM-DD/);
		expect(r.out).toMatch(/\*\*Gated on:\*\* <condition>/);
	});

	it("interleaves a dated and a conditioned issue by number under one banner", async () => {
		const r = await run({
			issues: [
				{ number: 1215, body: gateOn() },
				{
					number: 85,
					body: `**Gated until:** ${isoIn(9)} — chase Bunkward`,
				},
			],
		});
		const lines = r.out.split("\n");
		const banners = lines.filter((l) => /GATED BY A LINE/.test(l));
		expect(banners).toHaveLength(1);
		const dated = lines.findIndex((l) => /#85\s+held until/.test(l));
		const conditioned = lines.findIndex((l) => /#1215\s+held on/.test(l));
		expect(dated).toBeGreaterThan(-1);
		expect(conditioned).toBeGreaterThan(dated);
	});

	it("prints both footers, the date one and the judge-it-yourself one (#2279)", async () => {
		const r = await run({ issues: [{ number: 1215, body: gateOn() }] });
		expect(r.out).toMatch(
			/Move the date or delete the line; nothing expires it/,
		);
		expect(r.out).toMatch(
			/The `check:` on a condition gate is yours to run and judge/,
		);
		expect(r.out).toMatch(/`check-gates.js --issue <n>`, and on met/);
		expect(r.out).toMatch(/launching `\/triage <n>`\s+on a changed reading/);
		expect(r.out).toMatch(/`abandon if:` alone retires one unmet/);
	});

	it("says `check: none stated` where no command is given", async () => {
		// Separates "no command tests this" from "the parser dropped one".
		const r = await run({
			issues: [
				{
					number: 1105,
					body: gateOn("an `opusplan` session has happened", null),
				},
			],
		});
		expect(r.order()).not.toContain(1105);
		expect(r.out).toMatch(
			/#1105\s+held on .* — check: none stated — abandon if:/,
		);
	});

	it("gates nothing on a line missing its abort clause, and echoes the raw text", async () => {
		// `abandon if:` is the only thing that retires a condition, so holding on a
		// line that lacks it holds the issue under a rule nothing can release.
		const r = await run({
			issues: [{ number: 1215, body: "**Gated on:** enough samples exist" }],
		});
		expect(r.order()).toContain(1215);
		expect(r.out).toMatch(
			/#1215\s+MALFORMED GATE \(no `— abandon if:`\) `enough samples exist` — GATING NOTHING/,
		);
	});

	it("names the reason for a malformed gate that reads well-formed on its own", async () => {
		// mantahostels#1652: a duplicate `— check:`/`— abandon if:` inside the prose leaves
		// the raw tail looking like a valid three-segment gate, so the print
		// site must say *why* it was rejected, not just echo the tail.
		const r = await run({
			issues: [
				{
					number: 1215,
					body: "**Gated on:** rerun — check: the corpus first — check: `scan.py` — abandon if: retired",
				},
			],
		});
		expect(r.order()).toContain(1215);
		expect(r.out).toMatch(
			/#1215\s+MALFORMED GATE \(more than one `— check:`\)/,
		);
	});

	it("gates nothing when a body carries both markers, and says which defect", async () => {
		const r = await run({
			issues: [
				{
					number: 1215,
					body: `**Gated until:** ${isoIn(9)} — guessed\n\n**Gated on:** ${gateCondition} — abandon if: ${abandonCondition}`,
				},
			],
		});
		expect(r.order()).toContain(1215);
		expect(r.out).toMatch(/#1215\s+TWO GATE LINES, a date and a condition/);
		expect(r.out).not.toMatch(/#1215\s+held until/);
		expect(r.out).not.toMatch(/#1215\s+held on/);
	});

	it("carries conditioned issues in a sibling array, leaving `gated[]` alone", async () => {
		const r = await run(
			{
				issues: [
					{ number: 85, body: `**Gated until:** ${isoIn(9)} — chase` },
					{ number: 1105, body: gateOn("a session has happened", null) },
					{ number: 1215, body: gateOn() },
					{ number: 1216, body: "**Gated on:** enough samples exist" },
				],
			},
			["--json"],
		);
		const j = r.json();
		expect(j.gated.map((x: { number: number }) => x.number)).toEqual([85]);
		expect(j.gated[0]).toMatchObject({ active: true, until: isoIn(9) });
		expect(j.gatedOn.map((x: { number: number }) => x.number)).toEqual([
			1105, 1215, 1216,
		]);
		expect(j.gatedOn[0]).toMatchObject({
			condition: "a session has happened",
			command: null,
			abandonIf: abandonCondition,
			holding: true,
			malformed: null,
		});
		expect(j.gatedOn[1]).toMatchObject({ command: gateCommand, holding: true });
		expect(j.gatedOn[2]).toMatchObject({
			holding: false,
			malformed: "enough samples exist",
			malformedReason: "no `— abandon if:`",
			condition: null,
		});
	});

	it("flags a two-marker issue in the JSON, not only in the printed banner", async () => {
		// Without the flag a conflicted issue reads exactly like a lapsed date in
		// `gated[]` — `active: false` beside a positive `daysLeft` — so a consumer
		// that never sees the banner cannot tell the two apart (mantahostels#1333, one gate
		// line per issue).
		const r = await run(
			{
				issues: [
					{
						number: 1215,
						body: `**Gated until:** ${isoIn(9)} — guessed\n\n**Gated on:** ${gateCondition} — abandon if: ${abandonCondition}`,
					},
					{ number: 1216, body: gateOn() },
				],
			},
			["--json"],
		);
		const j = r.json();
		expect(j.gated[0]).toMatchObject({
			number: 1215,
			active: false,
			daysLeft: 9,
			bothMarkers: true,
		});
		expect(j.gatedOn[0]).toMatchObject({
			number: 1215,
			holding: false,
			bothMarkers: true,
		});
		// The unconflicted neighbour is untouched by the flag.
		expect(j.gatedOn[1]).toMatchObject({
			number: 1216,
			holding: true,
			bothMarkers: false,
		});
	});
});

describe("why each frontier issue did not launch, and the open tally (#591)", () => {
	const here = (fx: Fixture, args: string[] = []) =>
		run(fx, args, { ownRepo: true });
	const warm = (
		number: number,
		body: string,
		fields: Record<string, unknown>,
	) =>
		writeSetCache.writeEntry(kit.repoRoot, {
			issue: number,
			bodyHash: writeSetCache.bodyHash(body),
			trackedAtDerive: [],
			sizeBand: "M",
			gist: "what it does",
			...fields,
		});
	const reasons = (j: { notLaunched: { number: number; reason: string }[] }) =>
		Object.fromEntries(j.notLaunched.map((e) => [e.number, e.reason]));

	it("fills every reason the script can know, with its detail", async () => {
		kit.oracleSessions = ["self", "worker"];
		kit.oracleNames = { worker: "Implement 900" };
		warm(1, "one", { writeSet: ["scripts/a.js"] });
		warm(2, "two", { writeSet: ["scripts/a.js"] });
		warm(3, "three", { writeSet: ["scripts/held.js"] });
		const j = (
			await here(
				{
					issues: [
						{ number: 1, body: "one", labels: ["takes:implement"] },
						{ number: 2, body: "two", labels: ["takes:implement"] },
						{ number: 3, body: "three", labels: ["takes:implement"] },
						{ number: 4, labels: ["takes:human"] },
					],
					heldFiles: { "scripts/held.js": "worker" },
				},
				["--json"],
			)
		).json();
		expect(j.notLaunched).toEqual([
			{
				number: 2,
				reason: "shares a file",
				detail: { with: 1, file: "scripts/a.js", provisional: true },
			},
			{
				number: 3,
				reason: "file held by a running session",
				detail: {
					files: ["scripts/held.js"],
					session: "Implement 900",
					sessionId: "worker",
				},
			},
			{ number: 4, reason: "no command", detail: { takes: ["human"] } },
		]);
	});

	it("cuts the set below the slot count as no admission slot", async () => {
		kit.oracleSessions = ["self", "a@601", "b@602"];
		kit.procPssKb = { "601": WORKING_PAIR_KB, "602": WORKING_PAIR_KB };
		kit.psOut = [...sessionProcs("a"), ...sessionProcs("b")].join("\n");
		// 2706 − 212 − 794 − 300 = 1400 MB: 3 more need 1432 and two pairs.
		kit.memAvailableKb = 2706 * 1024;
		const j = (
			await run(
				{
					issues: [1, 2, 3, 4, 5].map((number) => ({
						number,
						labels: ["takes:implement"],
					})),
				},
				["--json"],
			)
		).json();
		expect(j.admission.freeSlots).toBe(2);
		expect(reasons(j)).toEqual({
			3: "no admission slot",
			4: "no admission slot",
			5: "no admission slot",
		});
		expect(j.notLaunched[0].detail).toEqual({ slots: 2, freeSlots: 2 });
	});

	it("gives an issue matching two reasons the earlier one", async () => {
		kit.oracleSessions = ["self", "worker"];
		warm(1, "one", { writeSet: ["scripts/held.js"] });
		const j = (
			await here(
				{
					issues: [{ number: 1, body: "one", labels: ["takes:human"] }],
					heldFiles: { "scripts/held.js": "worker" },
				},
				["--json"],
			)
		).json();
		expect(reasons(j)).toEqual({ 1: "no command" });
	});

	it("counts an issue merged into a set member's line as launched", async () => {
		warm(1, "one", { writeSet: ["scripts/a.js"], sizeBand: "small" });
		warm(2, "two", { writeSet: ["scripts/a.js"], sizeBand: "small" });
		const j = (
			await here(
				{
					issues: [
						{ number: 1, body: "one", labels: ["takes:implement"] },
						{ number: 2, body: "two", labels: ["takes:implement"] },
					],
				},
				["--json"],
			)
		).json();
		expect(j.conflictGraph.proposed).toEqual([1]);
		expect(j.notLaunched).toEqual([]);
	});

	const retro = "Standalone: retro-sweep finding (#948)";

	/**
	 * The sessions guard-selection-sum.js keys `lines` on, run as Claude Code
	 * runs it at Stop over a wave-1 turn of this run's own marker, and read back
	 * off the wave it records there.
	 */
	const guardSessionKeys = (lines: string[], frontier: number) => {
		const transcript = path.join(kit.dir, "guard-transcript.jsonl");
		const text = [
			...lines,
			`Wave 1 of 2 — frontier ${frontier}: ${frontier - 1} dispatched + 0 disqualified + 0 no command + 1 pending band read.`,
			"**Admission cut:** none.",
		].join("\n");
		fs.writeFileSync(
			transcript,
			`${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } })}\n`,
		);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			WFC_REPO_ROOT: kit.repoRoot as string,
		};
		/* Off, or a suite run from a background job arms the completion-mark limb. */
		delete env.CLAUDE_JOB_DIR;
		const r = runInProcess(
			path.resolve(__dirname, "guard-selection-sum.js"),
			[],
			{
				stdin: JSON.stringify({
					session_id: kit.oracleSelfId,
					transcript_path: transcript,
				}),
				env,
			},
		);
		expect(r.stdout.trim(), "the guard must pass the wave-1 turn").toBe("");
		return selectionMarker.read(kit.repoRoot, kit.oracleSelfId)?.wave?.keys;
	};
	const nineFindings = () =>
		Array.from({ length: 9 }, (_, k) => ({
			number: 10 + k,
			body: retro,
			labels: ["takes:triage"],
		}));
	const nineBundled = [
		[10, 11, 12, 13, 14],
		[15, 16, 17, 18],
	];

	it("launches retro findings as bundles of at most 8, one slot each (#1105)", async () => {
		warm(10, retro, { writeSet: ["scripts/a.js"] });
		warm(11, retro, { writeSet: ["scripts/a.js"] });
		const j = (
			await here(
				{
					issues: [
						...nineFindings(),
						{ number: 30, body: "not a finding", labels: ["takes:triage"] },
					],
				},
				["--json"],
			)
		).json();
		expect(j.retroBundles.map((b: RetroLaunch) => b.issues)).toEqual(
			nineBundled,
		);
		// Two bundles plus the lone non-retro triage issue, despite 10 sharing a file with 11.
		expect(j.dispatchableFloor).toBe(3);
		expect(j.notLaunched).toEqual([]);
	});

	it("prints each bundle's line and prompt and carries both in --json, so every reader gets its issues back (#1195, #1206)", async () => {
		const fixture = {
			issues: nineFindings(),
		};
		const bundles: RetroLaunch[] = (await here(fixture, ["--json"])).json()
			.retroBundles;
		const out = (await here(fixture)).out;
		const lines = out
			.split("\n")
			.filter((l) => /^\s+\*\*[\d, ]+\*\* - takes:triage/.test(l));
		expect(guardSessionKeys(lines, 9)).toEqual(
			nineBundled.map((b) => b.join(",")),
		);
		// Line i launches bundle i, so a swap between lines fails here.
		expect(lines.map((l) => l.match(/· (\S+) {4}→ "(.*)"$/)?.slice(1))).toEqual(
			bundles.map((b) => [b.model, b.prompt]),
		);
		expect(bundles.map((b) => issuesIn(b.prompt))).toEqual(nineBundled);
		for (const b of bundles) {
			// The bundle rule the vendored /triage skill lacks (#1195).
			expect(b.prompt).toContain(
				"one decision, one round comment and one brief per issue",
			);
			expect(commandOf(b.prompt)).toBe("triage");
			expect(b.model).toBe(RETRO_BUNDLE_MODEL);
		}
	});

	it("never drops a non-retro issue for a file a retro finding names (#1105)", async () => {
		warm(1, retro, { writeSet: ["scripts/a.js"], sizeBand: "small" });
		warm(2, "two", { writeSet: ["scripts/a.js"], sizeBand: "small" });
		const j = (
			await here(
				{
					issues: [
						{ number: 1, body: retro, labels: ["takes:triage"] },
						{ number: 2, body: "two", labels: ["takes:implement"] },
					],
				},
				["--json"],
			)
		).json();
		expect(j.conflictGraph.proposed).toEqual([2]);
		expect(j.conflictGraph.mergeable).toEqual([]);
		expect(j.dispatchableFloor).toBe(2);
		expect(j.notLaunched).toEqual([]);
	});

	it("tallies the open issues by the EXCLUDED table's own categories", async () => {
		const r = await run({
			issues: [
				{ number: 1, labels: ["takes:implement"] },
				{ number: 2, labels: ["takes:implement"] },
				{ number: 3, labels: ["takes:implement"] },
				{ number: 4, labels: ["takes:implement"] },
				{ number: 5, labels: ["takes:implement"] },
				{ number: 6, labels: ["takes:implement"], assignees: ["me"] },
				{ number: 7, labels: ["takes:children"] },
				{ number: 8, labels: ["takes:implement"], parent: 7 },
			],
			deps: {
				2: [{ number: 99, state: "open" }],
				3: [{ number: 99, state: "open" }],
				4: [{ number: 99, state: "open" }],
				5: [{ number: 99, state: "open" }],
			},
			claims: { 6: "self" },
		});
		const excluded = r.out.split("\nEXCLUDED\n")[1].split("\nNOT PROPOSED")[0];
		expect(excluded.match(/blocked by/g)).toHaveLength(4);
		expect(excluded.match(/claimed by/g)).toHaveLength(1);
		expect(excluded.match(/container —/g)).toHaveLength(1);
		expect(r.out).toMatch(
			/open tally +8 open, 2 frontier, 4 blocked, 1 claimed \(#6\), 1 container \(#7\)\n/,
		);
	});

	it("tallies the gated, dispatched and degraded categories too", async () => {
		const isoIn = (n: number) =>
			new Date(Date.now() + WITA_OFFSET_MS + n * 86_400_000)
				.toISOString()
				.slice(0, 10);
		const j = (
			await run(
				{
					issues: [
						{ number: 1, labels: ["takes:implement"] },
						{
							number: 2,
							body: `**Gated until:** ${isoIn(9)} — later`,
							labels: ["takes:implement"],
						},
						{ number: 3, labels: ["takes:implement"] },
						{ number: 4, labels: ["takes:implement"] },
					],
					dispatched: [{ issues: [3], prompt: "/implement 3" }],
					failDeps: [4],
				},
				["--json"],
			)
		).json();
		const count = (name: string) =>
			j.openTally.categories.find(
				(c: { category: string }) => c.category === name,
			);
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
		expect(j.openTally.frontier).toBe(1);
	});

	it("lists a dropped issue whose mergeable partner is not the one it clashed with", async () => {
		// #3 clashes with #1 on a.js; its merge pair is with #2 on b.js, so
		// nothing carries it.
		warm(1, "one", { writeSet: ["scripts/a.js"], sizeBand: "M" });
		warm(2, "two", { writeSet: ["scripts/b.js"], sizeBand: "small" });
		warm(3, "three", {
			writeSet: ["scripts/a.js", "scripts/b.js"],
			sizeBand: "small",
		});
		const j = (
			await here(
				{
					issues: [
						{ number: 1, body: "one", labels: ["takes:implement"] },
						{ number: 2, body: "two", labels: ["takes:implement"] },
						{ number: 3, body: "three", labels: ["takes:implement"] },
					],
				},
				["--json"],
			)
		).json();
		expect(j.conflictGraph.proposed).toEqual([1, 2]);
		expect(reasons(j)).toEqual({ 3: "shares a file" });
	});

	it("carries the tally in --json with every number, however many", async () => {
		const j = (
			await run(
				{
					issues: [1, 2, 3, 4, 5].map((number) => ({
						number,
						labels: ["takes:implement"],
					})),
					deps: Object.fromEntries(
						[2, 3, 4, 5].map((n) => [n, [{ number: 99, state: "open" }]]),
					),
				},
				["--json"],
			)
		).json();
		expect(j.openTally.open).toBe(5);
		expect(j.openTally.frontier).toBe(1);
		expect(
			j.openTally.categories.find(
				(c: { category: string }) => c.category === "blocked",
			),
		).toEqual({ category: "blocked", count: 4, numbers: [2, 3, 4, 5] });
	});

	it("caps the printed block, grouped by reason, and --json carries all", async () => {
		const issues = Array.from({ length: 25 }, (_, n) => ({
			number: n + 1,
			labels: ["takes:human"],
		}));
		const r = await run({ issues });
		const block = r.out.split("NOT PROPOSED")[1].split("\nRUN SUMMARY")[0];
		expect(block).toMatch(/^ \(25\)/);
		expect(block.match(/^ {2}no command:$/gm)).toHaveLength(1);
		expect(block.match(/^ {4}#\d+ {2}human$/gm)).toHaveLength(20);
		expect(block).toMatch(/\.\.\. and 5 more — --json carries every one\./);
		const j = (await run({ issues }, ["--json"])).json();
		expect(j.notLaunched).toHaveLength(25);
	});

	it("prints none where every frontier issue is in the set", async () => {
		const r = await run({
			issues: [{ number: 1, labels: ["takes:implement"] }],
		});
		expect(r.out).toMatch(/NOT PROPOSED \(0\)[^\n]*\n\n {2}none\n/);
	});
});
