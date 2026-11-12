// @vitest-environment node
/*
 * Pins that check-issue-cycles.js reports each loop of open issues waiting on
 * each other — through blockers and sub-issues together, in any repo the
 * corpus reaches — once, never writes, and goes BROKEN rather than OK on an
 * unread node.
 *
 * The check is #495's, run here with a stub `gh` injected via WFC_GH: no
 * network, no auth, and no dependence on this repo's own tracker state — which
 * is what the script reports on and so cannot also be its fixture.
 *
 * It runs daily in the repo-checks run, report-only: loosen a case and a
 * ticket can sit blocked on itself unnoticed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	GH_LOGGED_OUT,
	GH_NOT_FOUND,
	GH_VALIDATION_FAILED,
	type GhAnswer,
	readGhAnswer,
} from "./lib/gh-fake";
import { page, type RouteAnswer, stubGhRoutes } from "./lib/gh-stub";
import { runInProcessAsync } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-issue-cycles.js");
const FORBIDDEN = path.join(__dirname, "lib/fixtures/gh/checks-forbidden.json");

let dir: string;

interface Blocker {
	number: number;
	state: "open" | "closed";
	repository_url?: string;
}

interface Issue {
	number: number;
	/** `owner/name`; `o/r` where unset */
	repo?: string;
	/** the open parent's number, in the same repo */
	parent?: number;
	blockedBy?: Blocker[];
	/** this one issue's blockers read fails, batched and alone alike */
	failBlockers?: boolean;
	pull_request?: object;
	/** read by the walk alone: absent from its repo's open-issue list */
	unlisted?: boolean;
}

interface Fixture {
	issues: Issue[];
	/** the trackers the corpus declares; `o/r` alone where unset */
	corpus?: string[];
	/** each repo's open-issue list answer, where it fails */
	failList?: Record<string, GhAnswer>;
	unreachable?: boolean;
	/** the list reads, then the links read finds gh logged out */
	blockersUnreachable?: boolean;
}

const CALL_LOG = () => path.join(dir, "calls.log");
const API = "https://api.github.com/repos";

const stubGh = ({
	issues,
	corpus = ["o/r"],
	failList = {},
	unreachable,
	blockersUnreachable,
}: Fixture) => {
	const log = { log: CALL_LOG() };
	if (unreachable) return stubGhRoutes(dir, { "*": GH_LOGGED_OUT }, log);
	const routes: Record<string, RouteAnswer> = {};
	if (blockersUnreachable) routes.graphql = GH_LOGGED_OUT;
	const repoOf = (i: Issue) => i.repo ?? "o/r";
	for (const i of issues)
		routes[`repos/${repoOf(i)}/issues/${i.number}/dependencies/blocked_by`] =
			i.failBlockers
				? GH_NOT_FOUND
				: page(
						"blockedByPage",
						(i.blockedBy ?? []).map((b) => ({
							...b,
							repository_url: b.repository_url ?? `${API}/${repoOf(i)}`,
						})),
					);
	for (const p of issues)
		routes[`repos/${repoOf(p)}/issues/${p.number}/sub_issues`] = page(
			"subIssuesPage",
			issues
				.filter((c) => c.parent === p.number && repoOf(c) === repoOf(p))
				.map((c) => ({
					number: c.number,
					state: "open",
					repository_url: `${API}/${repoOf(c)}`,
				})),
		);
	for (const repo of corpus)
		routes[`repos/${repo}/issues?*state=open*`] =
			failList[repo] ??
			page(
				"issuesPage",
				issues
					.filter((i) => repoOf(i) === repo && !i.unlisted)
					.map((i) => ({
						number: i.number,
						title: `issue ${i.number}`,
						html_url: `http://example/${i.number}`,
						pull_request: i.pull_request,
						repository_url: `${API}/${repo}`,
					})),
			);
	fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, ".claude", "workflow-core.json"),
		JSON.stringify({ tracker: "o/r", corpus }),
	);
	return stubGhRoutes(dir, routes, log);
};

const run = async (fx: Fixture, args: string[] = []) => {
	const stub = stubGh(fx);
	const r = await runInProcessAsync(SCRIPT, args, {
		env: {
			...process.env,
			...stub.env,
			GITHUB_ACTIONS: "",
			CLAUDE_PROJECT_DIR: dir,
		},
	});
	const log = CALL_LOG();
	return {
		status: r.status,
		out: `${r.stdout}${r.stderr}`,
		calls: () =>
			fs.existsSync(log)
				? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
				: [],
		json: () => JSON.parse(r.stdout),
	};
};

const open = (number: number): Blocker => ({ number, state: "open" });

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "issue-cycles-test-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("cycles", () => {
	it("reports a loop made of blocked_by links alone", async () => {
		const r = await run({
			issues: [
				{ number: 1, blockedBy: [open(2)] },
				{ number: 2, blockedBy: [open(1)] },
			],
		});
		expect(r.status).toBe(0);
		expect(r.out).toContain("ISSUE-CYCLE");
		expect(r.out).toContain("#1 is blocked by #2");
		expect(r.out).toContain("#2 is blocked by #1");
	});

	it("reports a loop that needs both kinds of link, naming each link's kind", async () => {
		const r = await run({
			issues: [
				{ number: 422 },
				{ number: 453, parent: 422 },
				{ number: 457, parent: 453 },
				{ number: 485, parent: 457, blockedBy: [open(424)] },
				{ number: 424, blockedBy: [open(423)] },
				{ number: 423, blockedBy: [open(422)] },
			],
		});
		expect(r.status).toBe(0);
		expect(r.out).toContain("ISSUE-CYCLE");
		for (const link of [
			"#422 waits on child #453",
			"#453 waits on child #457",
			"#457 waits on child #485",
			"#485 is blocked by #424",
			"#424 is blocked by #423",
			"#423 is blocked by #422",
		])
			expect(r.out).toContain(link);
	});

	it("reports a loop once, not once per member", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, blockedBy: [open(2)] },
					{ number: 2, blockedBy: [open(3)] },
					{ number: 3, blockedBy: [open(1)] },
				],
			},
			["--json"],
		);
		const j = r.json();
		expect(j.cycleCount).toBe(1);
		expect(j.cycles[0].members).toEqual(["#1", "#2", "#3"]);
	});

	it("reports two separate loops separately", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, blockedBy: [open(2)] },
					{ number: 2, blockedBy: [open(1)] },
					{ number: 5 },
					{ number: 6, parent: 5, blockedBy: [open(5)] },
				],
			},
			["--json"],
		);
		expect(r.json().cycleCount).toBe(2);
	});

	it("does not count a closed blocker as a link", async () => {
		const r = await run({
			issues: [
				{ number: 1, blockedBy: [open(2)] },
				{ number: 2, blockedBy: [{ number: 1, state: "closed" }] },
			],
		});
		expect(r.out).not.toContain("ISSUE-CYCLE");
		expect(r.status).toBe(0);
	});

	it("does not count another repository's issue of the same number as ours", async () => {
		const r = await run({
			issues: [
				{ number: 1, blockedBy: [open(2)] },
				{
					number: 2,
					blockedBy: [{ ...open(1), repository_url: `${API}/o/x` }],
				},
				{ number: 1, repo: "o/x", unlisted: true },
			],
		});
		expect(r.status).toBe(0);
		expect(r.out).not.toContain("ISSUE-CYCLE");
	});

	it("says OK when there is no loop", async () => {
		const r = await run({
			issues: [
				{ number: 1, blockedBy: [open(2)] },
				{ number: 2, parent: 3 },
				{ number: 3 },
			],
		});
		expect(r.status).toBe(0);
		expect(r.out).toContain("OK");
		expect(r.out).not.toContain("ISSUE-CYCLE");
	});

	it("skips pull requests", async () => {
		const r = await run({
			issues: [{ number: 1, pull_request: {} }, { number: 2 }],
		});
		expect(r.calls().some((c) => c.includes("issues/1/dependencies"))).toBe(
			false,
		);
		expect(r.calls().some((c) => c.includes("i1: issue("))).toBe(false);
	});
});

describe("across trackers (#5070)", () => {
	/* #5055's shape: a loop crossing two repos, one sub-issue link and two
	 * blocker links. */
	const twoRepoLoop: Issue[] = [
		{
			number: 3864,
			blockedBy: [{ ...open(4891), repository_url: `${API}/o/x` }],
		},
		{ number: 4891, repo: "o/x" },
		{
			number: 4893,
			repo: "o/x",
			parent: 4891,
			blockedBy: [{ ...open(3864), repository_url: `${API}/o/r` }],
		},
	];

	it("reports a loop crossing two corpus trackers once, foreign issues by their full reference", async () => {
		const r = await run({ issues: twoRepoLoop, corpus: ["o/r", "o/x"] }, [
			"--json",
		]);
		const j = r.json();
		expect(j.cycleCount).toBe(1);
		expect(j.cycles[0].members).toEqual(["#3864", "o/x#4891", "o/x#4893"]);
		expect(j.cycles[0].path).toEqual([
			"#3864 is blocked by o/x#4891",
			"o/x#4891 waits on child o/x#4893",
			"o/x#4893 is blocked by #3864",
		]);
	});

	it("finds a loop through a repo outside the corpus", async () => {
		const r = await run({
			issues: twoRepoLoop.map((i) => ({ ...i, unlisted: i.repo === "o/x" })),
			corpus: ["o/r"],
		});
		expect(r.out).toContain("ISSUE-CYCLE");
		expect(r.out).toContain("o/x#4891 waits on child o/x#4893");
	});

	it("names both the issue count and the tracker count on the OK line", async () => {
		const r = await run({
			issues: [{ number: 1 }, { number: 2, repo: "o/x" }],
			corpus: ["o/r", "o/x"],
		});
		expect(r.status).toBe(0);
		expect(r.out).toContain("2 open issue(s) across 2 tracker(s)");
	});

	it.for([
		["not-found", GH_NOT_FOUND],
		["forbidden", readGhAnswer(FORBIDDEN)],
	] as const)(
		"names a corpus tracker whose list answers %s on its own line and checks the rest",
		async ([, answer]) => {
			const r = await run({
				issues: [{ number: 1 }],
				corpus: ["o/r", "o/hidden"],
				failList: { "o/hidden": answer },
			});
			expect(r.status).toBe(0);
			expect(r.out).toMatch(/^Not read: o\/hidden — /m);
			expect(r.out).toContain("1 open issue(s) across 1 tracker(s)");
			expect(r.out).not.toContain("BROKEN");
		},
	);

	it("is BROKEN (exit 2) when GitHub would list no corpus tracker, never OK over none", async () => {
		const r = await run({
			issues: [],
			corpus: ["o/r", "o/hidden"],
			failList: { "o/r": GH_NOT_FOUND, "o/hidden": readGhAnswer(FORBIDDEN) },
		});
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN");
		expect(r.out).toContain("none of the 2 corpus tracker(s)");
	});
});

describe("never gates, never writes", () => {
	it("exits 0 on a finding — WARN, not FAIL", async () => {
		const r = await run({
			issues: [
				{ number: 1, blockedBy: [open(2)] },
				{ number: 2, blockedBy: [open(1)] },
			],
		});
		expect(r.status).toBe(0);
		expect(r.out).toContain("WARN");
		expect(r.out).not.toContain("FAIL");
	});

	it("issues nothing but gh api GETs", async () => {
		const r = await run({
			issues: [{ number: 1, blockedBy: [open(2)] }, { number: 2 }],
		});
		for (const call of r.calls()) {
			expect(call.split(" ")[0]).toBe("api");
			expect(call).not.toMatch(/(^|\s)(-X|--method)\s+(?!GET\b)/);
		}
	});
});

describe("failure handling", () => {
	it("SKIPs at exit 0 when GitHub is unreachable", async () => {
		const r = await run({ issues: [], unreachable: true });
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP");
		expect(r.out).not.toContain("OK:");
	});

	it("SKIPs at exit 0, naming the remedy, when GitHub goes unreachable after the list read", async () => {
		const r = await run({ issues: [{ number: 1 }], blockersUnreachable: true });
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP");
		expect(r.out).toContain("Needs an authenticated `gh`.");
		expect(r.out).not.toContain("BROKEN");
	});

	it("is BROKEN (exit 2) when the issue list fails other than not-found or forbidden", async () => {
		const r = await run({
			issues: [],
			failList: { "o/r": GH_VALIDATION_FAILED },
		});
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN");
	});

	it("is BROKEN, never OK, when one issue's links cannot be read, naming the issue", async () => {
		// An unread blocker list could hide the one link that closes a loop.
		const r = await run({
			issues: [{ number: 1 }, { number: 2, failBlockers: true }],
		});
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN");
		expect(r.out).toContain("#2");
		expect(r.out).not.toContain("OK:");
	});
});
