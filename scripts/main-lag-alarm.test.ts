// @vitest-environment node

/*
 * scripts/main-lag-alarm.js, its core lib/main-lag-alarm.js and
 * .github/workflows/main-lag.yml (#4443, #4485), with GitHub's activity and
 * ref endpoints stubbed. Break this and the one stall alarm that outlives
 * the machine stays green through a stall, a queue ref pushed again stops
 * ageing, or the workflow's run page names a threshold the check no longer
 * applies.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAlarm } from "./lib/main-lag-alarm.js";
import { ROOT } from "./lib/precommit-gate-testkit";
import { QUEUE_ALERT_TITLES, STALL_TITLE } from "./lib/queue-tickets.js";
import { runInProcessAsync } from "./lib/run-in-process.js";
import { loadWorkflow } from "./lib/workflow-yaml-testkit";

const MIN = 60_000;
const NOW = Date.parse("2026-11-05T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * MIN).toISOString();

/* Each queue ref's activity feed, newest first, minutes ago. */
type Activity = [number, "push" | "branch_creation" | "branch_deletion"];

/* A queue ref first pushed `min` ago and pushed again since. */
const created = (min: number): Activity[] => [
	[1, "push"],
	[min, "branch_creation"],
];

const stub =
	(queue: Activity[][] = []) =>
	async (p: string): Promise<unknown> => {
		if (p === "/git/matching-refs/heads/queue/")
			return queue.map((_, i) => ({
				ref: `refs/heads/queue/q${i}`,
				object: { sha: `Q${i}` },
			}));
		const q =
			/^\/activity\?ref=refs%2Fheads%2Fqueue%2Fq(\d+)&per_page=100$/.exec(p);
		if (q)
			return (queue[Number(q[1])] ?? []).map(([min, type]) => ({
				timestamp: ago(min),
				activity_type: type,
				after: type === "branch_deletion" ? "0" : `Q${q[1]}`,
			}));
		throw new Error(`unstubbed ${p}`);
	};

const run = async (get: (p: string) => Promise<unknown>) => {
	const said: string[] = [];
	const code = await runAlarm({ get, now: NOW, say: (l) => said.push(l) });
	return { code, out: said.join("\n") };
};

describe("lib/main-lag-alarm.js", () => {
	it("passes a queue within the 2 h backstop, naming its oldest ref by its first push", async () => {
		const r = await run(stub([created(5), created(119)]));
		expect(r.code).toBe(0);
		expect(r.out).toContain(
			`queue/q1, the oldest of 2 queue refs, has waited since its first push at ${ago(119)}: 1 h 59 min, against 2 h 0 min.`,
		);
	});

	it("says so where no queue ref waits", async () => {
		const r = await run(stub());
		expect(r.out).toContain("No queue ref waits.");
	});

	it("fails where a queue ref pushed again has waited past 2 h since its first push after its last deletion", async () => {
		const r = await run(
			stub([
				created(5),
				[
					[1, "push"],
					[30, "push"],
					[121, "branch_creation"],
					[200, "branch_deletion"],
					[900, "branch_creation"],
				],
			]),
		);
		expect(r.code).toBe(1);
		expect(r.out).toContain(
			`::error title=Queue ref waiting::queue/q1, the oldest of 2 queue refs, has waited since its first push at ${ago(121)}`,
		);
		expect(r.out).toContain(`the open "${QUEUE_ALERT_TITLES.age}" ticket`);
		expect(QUEUE_ALERT_TITLES.age).not.toBe(STALL_TITLE);
	});

	it("holds no depth: eleven fresh queue refs pass", async () => {
		const r = await run(stub(new Array(11).fill(created(1))));
		expect(r.code).toBe(0);
		expect(r.out).not.toContain("::error");
	});

	it("skips and names a queue ref whose feed lists no push, failing on nothing", async () => {
		const r = await run(stub([[], [[300, "branch_deletion"]], created(5)]));
		expect(r.code).toBe(0);
		expect(r.out).toContain(
			"queue/q0 is skipped: its activity feed lists no push.",
		);
		expect(r.out).toContain(
			"queue/q1 is skipped: its activity feed lists no push.",
		);
		expect(r.out).toContain("queue/q2, the oldest of 1 queue refs");
	});

	it("fails as a broken check on a feed entry with no timestamp", async () => {
		const real = stub([created(5)]);
		const r = await run(async (p) =>
			p.startsWith("/activity?") ? [{ after: "Q0" }] : real(p),
		);
		expect(r.code).toBe(2);
		expect(r.out).toContain("no timestamp or sha");
	});

	it("fails as a broken check, naming the way out, where the API will not read", async () => {
		const r = await run(async () => {
			throw new Error("/activity: HTTP 503");
		});
		expect(r.code).toBe(2);
		expect(r.out).toContain("::error title=Check broken, not a stall::");
		expect(r.out).toContain("HTTP 503");
		expect(r.out).toContain("git ls-remote origin 'refs/heads/queue/*'");
	});
});

/* Crosses a real socket: the script's own fetch adapter and environment,
 * against a local server standing in for GitHub's API. */
const throughFetch = async (api: (p: string) => Promise<unknown>) => {
	const seen: string[] = [];
	const server = http.createServer(async (req, res) => {
		const url = (req.url ?? "").replace("/repos/owner/repo", "");
		seen.push(`${url} ${req.headers.authorization}`);
		res.setHeader("content-type", "application/json");
		res.end(JSON.stringify(await api(url)));
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as AddressInfo;
	try {
		const out = await runInProcessAsync(
			path.join(ROOT, "scripts/main-lag-alarm.js"),
			[],
			{
				env: {
					PATH: process.env.PATH,
					GITHUB_API_URL: `http://127.0.0.1:${port}`,
					GITHUB_REPOSITORY: "owner/repo",
					GH_TOKEN: "tok",
				},
			},
		);
		return { ...out, seen };
	} finally {
		server.close();
	}
};

describe("main-lag-alarm.js through fetch", () => {
	it("reads GitHub's API from the environment Actions sets and exits 0 where nothing waits", async () => {
		const out = await throughFetch(stub());
		expect(out.status).toBe(0);
		expect(out.stdout).toContain("No queue ref waits.");
		expect(out.seen).toContain("/git/matching-refs/heads/queue/ Bearer tok");
	});

	/* The program reads the real clock, which NOW is behind: any ref the
	 * stub lists has waited past the backstop. */
	it("exits 1 on a stalled queue ref", async () => {
		const out = await throughFetch(stub([created(121)]));
		expect(out.status).toBe(1);
		expect(out.stdout).toContain("::error title=Queue ref waiting::queue/q0");
	});

	it("exits 2 where the API answers with no list of queue refs", async () => {
		const out = await throughFetch(async () => ({}));
		expect(out.status).toBe(2);
		expect(out.stdout).toContain("::error title=Check broken, not a stall::");
	});
});

describe("main-lag.yml", () => {
	const workflow = loadWorkflow(
		path.join(ROOT, ".github/workflows/main-lag.yml"),
	);
	const job = workflow.jobs.lag;

	it("runs the check hourly, in the code repo alone", () => {
		expect(workflow.on?.schedule).toEqual([{ cron: "47 * * * *" }]);
		expect(job?.if).toContain("lucmoseley/workflow-core");
		expect((job?.steps ?? []).map((s) => s.run).filter(Boolean)).toEqual([
			[
				"node scripts/main-lag-alarm.js || exit",
				'if [ "$FORCE_FAILURE" = true ]; then',
				`  echo "::error title=Forced failure::This run tests the founder's notice route."`,
				"  exit 1",
				"fi",
				"",
			].join("\n"),
		]);
	});

	it("takes a boolean forced failure, failed only after the check itself passed", () => {
		expect(workflow.on?.workflow_dispatch?.inputs?.force_failure?.type).toBe(
			"boolean",
		);
	});

	it("names the threshold the check applies on the run page the notice links", async () => {
		const { out } = await run(stub([created(5)]));
		const hours = Number(/against (\d+) h 0 min\.$/.exec(out)?.[1]);
		expect(hours).toBeGreaterThan(0);
		expect(workflow.name).toContain(`${hours}h`);
		expect(job?.name).toContain(`No queue ref waited over ${hours} hours`);
		expect(job?.name?.replace(/\b2 hours\b/g, "")).not.toMatch(/\d/);
	});
});
