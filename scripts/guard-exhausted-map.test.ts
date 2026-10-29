// @vitest-environment node
/*
 * Pins the Stop guard that refuses to let a session end holding the claim on
 * an exhausted map — open, `takes:wayfinder`, unparked, ungated, no open
 * sub-issue (#3639) — and every exit it lets through.
 *
 * Breaking it either strands the map again, or blocks a session that gave
 * the map a route or never held one.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox, issueClaims } from "./lib/arbiter-testkit";
import { subIssuesAnswer } from "./lib/gh-fake";
import { type RouteAnswer, stubGhRoutes } from "./lib/gh-stub";
import { readStopGuardReason } from "./lib/stop-guard-testkit";

const GUARD = path.join(__dirname, "guard-exhausted-map.js");
const ME = "sess-me";
const MAP = 700;
const AT = `repos/acme/widgets/issues/${MAP}`;

const sb = freshSandbox((s) => {
	fs.mkdirSync(path.join(s.repo, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(s.repo, ".claude", "workflow-core.json"),
		JSON.stringify({ contract: 1, founder: "T", tracker: "acme/widgets" }),
	);
});

const MAP_LABELS = ["wayfinder:map", "takes:wayfinder"];

const mapIssue = ({
	state = "open",
	labels = MAP_LABELS,
	body = "## Destination\n\nSomewhere.\n",
}: {
	state?: string;
	labels?: string[];
	body?: string;
} = {}): RouteAnswer => ({
	kind: "issue",
	value: {
		number: MAP,
		state,
		labels: labels.map((name) => ({ name })),
		body,
	},
});

const child = (state: string, repo = "acme/widgets") => ({
	number: 701,
	state,
	repository_url: `https://api.github.com/repos/${repo}`,
});

/** The guard's refusal for a session claiming the map, served `routes`;
 *  `message: null` leaves the turn's text unreadable. */
const reasonFor = (
	routes: Record<string, RouteAnswer>,
	{
		claim = true,
		message = "Done.",
	}: { claim?: boolean; message?: string | null } = {},
) => {
	if (claim) issueClaims.claimIssue(MAP, { sessionId: ME });
	return readStopGuardReason(GUARD, {
		dir: sb.repo,
		sid: ME,
		config: sb.home,
		message: message ?? undefined,
		env: stubGhRoutes(sb.dir, routes).env,
	});
};

const EXHAUSTED = {
	[AT]: mapIssue(),
	[`${AT}/sub_issues`]: subIssuesAnswer([]),
};

describe("a claimed exhausted map", () => {
	it("refuses, naming steps (a) to (c) in order", () => {
		const reason = reasonFor({
			[AT]: mapIssue(),
			[`${AT}/sub_issues`]: subIssuesAnswer([child("closed")]),
		});
		expect(reason).toContain(`#${MAP}`);
		const a = reason.indexOf("(a) While *Not yet specified* holds anything");
		const b = reason.indexOf("(b) Once *Not yet specified* is empty");
		const c = reason.indexOf("(c) Where the map's destination is reached");
		expect(a).toBeGreaterThan(-1);
		expect(b).toBeGreaterThan(a);
		expect(c).toBeGreaterThan(b);
	});

	it("restates the rule's own steps", () => {
		const rule = fs.readFileSync(
			path.join(__dirname, "../docs/agents/rules/wayfinder-ops-shapes.txt"),
			"utf8",
		);
		const steps = reasonFor(EXHAUSTED)
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => /^\([a-c]\)/.test(l));
		expect(steps).toHaveLength(3);
		const [a, b, c] = steps;
		expect(rule).toContain(a);
		expect(rule).toContain(b?.split(":")[0]?.replace("exhausted-map ", ""));
		expect(rule).toContain(c);
	});

	it("refuses where the map's date gate has passed", () => {
		expect(
			reasonFor({
				...EXHAUSTED,
				[AT]: mapIssue({
					body: "**Gated until:** 2020-01-01 — the vendor ships v2.\n",
				}),
			}),
		).toContain(`#${MAP}`);
	});
});

describe("a stop it allows", () => {
	it("allows where an open sub-issue lives in another repo", () => {
		expect(
			reasonFor({
				[AT]: mapIssue(),
				[`${AT}/sub_issues`]: subIssuesAnswer([
					child("closed"),
					child("open", "acme/elsewhere"),
				]),
			}),
		).toBe("");
	});

	it.each([
		["parked", mapIssue({ labels: [...MAP_LABELS, "parked"] })],
		[
			"gated",
			mapIssue({
				body: "**Gated on:** the vendor ships v2 — abandon if: the vendor folds.\n\nBody.\n",
			}),
		],
		[
			"gated until a date still ahead",
			mapIssue({
				body: "**Gated until:** 2099-01-01 — the vendor ships v2.\n",
			}),
		],
		["closed", mapIssue({ state: "closed" })],
		[
			"relabelled off takes:wayfinder",
			mapIssue({ labels: ["wayfinder:map", "takes:to-spec"] }),
		],
		["not a map", mapIssue({ labels: ["takes:wayfinder"] })],
	])("allows where the map is %s", (_, issue) => {
		expect(
			reasonFor({ [AT]: issue, [`${AT}/sub_issues`]: subIssuesAnswer([]) }),
		).toBe("");
	});

	it("allows where the turn's message cannot be read", () => {
		expect(reasonFor(EXHAUSTED, { message: null })).toBe("");
	});

	it("allows a session holding no claim", () => {
		expect(
			reasonFor(
				{ [AT]: mapIssue(), [`${AT}/sub_issues`]: subIssuesAnswer([]) },
				{ claim: false },
			),
		).toBe("");
	});

	it.each([
		["the issue", { [`${AT}/sub_issues`]: subIssuesAnswer([]) }],
		[
			"its sub-issues",
			{ [AT]: mapIssue(), [`${AT}/sub_issues`]: subIssuesAnswer("fail") },
		],
	])("fails open where %s cannot be read", (_, routes) => {
		expect(reasonFor(routes)).toBe("");
	});
});
