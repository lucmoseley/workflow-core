// @vitest-environment node
/*
 * Pins that check-issue-cycles.js reports each loop of open issues waiting on
 * each other — through blockers and sub-issues together — once, never writes,
 * and goes BROKEN rather than OK on an unread blocker list.
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
import { GH_LOGGED_OUT, GH_NOT_FOUND } from "./lib/gh-fake";
import { page, type RouteAnswer, stubGhRoutes } from "./lib/gh-stub";
import { runInProcessAsync } from "./lib/run-in-process.js";

const SCRIPT = path.resolve(__dirname, "check-issue-cycles.js");

let dir: string;

interface Blocker {
	number: number;
	state: "open" | "closed";
}

interface Issue {
	number: number;
	/** the open parent's number; the list call renders it as parent_issue_url */
	parent?: number;
	blockedBy?: (Blocker & { repository_url?: string })[];
	repository_url?: string;
	/** this one issue's blockers read fails, batched and alone alike */
	failBlockers?: boolean;
	pull_request?: object;
}

interface Fixture {
	issues: Issue[];
	failList?: boolean;
	unreachable?: boolean;
	/** the list reads, then the blockers read finds gh logged out */
	blockersUnreachable?: boolean;
}

const CALL_LOG = () => path.join(dir, "calls.log");

const stubGh = ({
	issues,
	failList,
	unreachable,
	blockersUnreachable,
}: Fixture) => {
	const log = { log: CALL_LOG() };
	if (unreachable) return stubGhRoutes(dir, { "*": GH_LOGGED_OUT }, log);
	const routes: Record<string, RouteAnswer> = {};
	if (blockersUnreachable) routes.graphql = GH_LOGGED_OUT;
	for (const i of issues)
		routes[`repos/{owner}/{repo}/issues/${i.number}/dependencies/blocked_by`] =
			i.failBlockers ? GH_NOT_FOUND : page("blockedByPage", i.blockedBy ?? []);
	routes["repos/{owner}/{repo}/issues?*state=open*"] = failList
		? GH_NOT_FOUND
		: page(
				"issuesPage",
				issues.map((i) => ({
					number: i.number,
					title: `issue ${i.number}`,
					html_url: `http://example/${i.number}`,
					pull_request: i.pull_request,
					repository_url: i.repository_url,
					parent_issue_url: i.parent
						? `https://api.github.com/repos/o/r/issues/${i.parent}`
						: null,
				})),
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
		expect(j.cycles[0].members).toEqual([1, 2, 3]);
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

	it("does not count a blocker from another repository as a link", async () => {
		const here = "https://api.github.com/repos/o/r";
		const r = await run({
			issues: [
				{ number: 1, repository_url: here, blockedBy: [open(2)] },
				{
					number: 2,
					repository_url: here,
					blockedBy: [
						{ ...open(1), repository_url: "https://api.github.com/repos/o/x" },
					],
				},
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

	it("is BROKEN (exit 2) when the issue list fails", async () => {
		const r = await run({ issues: [], failList: true });
		expect(r.status).toBe(2);
		expect(r.out).toContain("BROKEN");
	});

	it("is BROKEN, never OK, when one issue's blockers cannot be read, naming the issue", async () => {
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
