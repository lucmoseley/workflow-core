// @vitest-environment node

/*
 * scripts/main-lag-alarm.js and .github/workflows/main-lag.yml (#4443,
 * #4485), with GitHub's activity, compare and ref endpoints stubbed. Break
 * this and the one stall alarm that outlives the machine stays green through
 * a stall, a queue ref pushed again stops ageing, one failed read hides the
 * other's stall, or the workflow's email names a threshold the check no
 * longer applies.
 */

import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { STALL_MS } from "./lib/landing-stall.js";
import { ROOT } from "./lib/precommit-gate-testkit";
import { QUEUE_ALERT_TITLES, STALL_TITLE } from "./lib/queue-tickets.js";
import { runInProcessAsync } from "./lib/run-in-process.js";
import { QUEUE_BACKSTOP_MS, runAlarm } from "./main-lag-alarm.js";

// Through `require`: js-yaml ships no types.
const yaml = createRequire(import.meta.url)("js-yaml");

const MIN = 60_000;
const NOW = Date.parse("2026-11-05T12:00:00Z");
const ago = (min: number) => new Date(NOW - min * MIN).toISOString();

type Status = "ahead" | "diverged" | "identical" | "behind";
interface Queue {
	mainPushed: number;
	landing: Status;
	pushes?: { at: number; after: string }[];
	atMove?: Status;
	branchSha?: string;
	/* Each queue ref's activity feed, newest first, minutes ago. */
	queue?: Activity[][];
}
type Activity = [number, "push" | "branch_creation" | "branch_deletion"];

/* A queue ref first pushed `min` ago and pushed again since. */
const created = (min: number): Activity[] => [
	[1, "push"],
	[min, "branch_creation"],
];

/* `main` at sha M; `landing`'s pushes, newest first, each its own sha. */
const stub =
	({
		mainPushed,
		landing,
		pushes = [],
		atMove = "identical",
		branchSha = "M",
		queue = [],
	}: Queue) =>
	async (p: string): Promise<unknown> => {
		if (p === "/git/ref/heads/main") return { object: { sha: branchSha } };
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
		if (p.startsWith("/activity?ref=refs/heads/main&"))
			return [{ timestamp: ago(mainPushed), after: "M" }];
		if (p.startsWith("/activity?ref=refs/heads/landing&"))
			return pushes.map((x) => ({ timestamp: ago(x.at), after: x.after }));
		if (p === "/compare/M...landing") return { status: landing };
		if (p.startsWith("/compare/M...")) return { status: atMove };
		throw new Error(`unstubbed ${p}`);
	};

const run = async (get: (p: string) => Promise<unknown>) => {
	const said: string[] = [];
	const code = await runAlarm({ get, now: NOW, say: (l) => said.push(l) });
	return { code, out: said.join("\n") };
};

const STALL_MIN = STALL_MS / MIN;

describe("main-lag-alarm.js", () => {
	it("passes where main is level with landing, however old its push", async () => {
		const r = await run(stub({ mainPushed: 600, landing: "identical" }));
		expect(r.code).toBe(0);
		expect(r.out).toContain("is level with landing (identical)");
	});

	it("fails where landing has been ahead of a main unmoved past the threshold", async () => {
		const r = await run(
			stub({
				mainPushed: STALL_MIN + 30,
				landing: "ahead",
				pushes: [
					{ at: 5, after: "L2" },
					{ at: STALL_MIN + 10, after: "L1" },
					{ at: STALL_MIN + 40, after: "L0" },
				],
			}),
		);
		expect(r.code).toBe(1);
		expect(r.out).toContain("::error title=Main lagging landing::");
		expect(r.out).toContain(`since ${ago(STALL_MIN + 10)}`);
		expect(r.out).toContain(`the open "${STALL_TITLE}" ticket`);
	});

	it("passes a push onto a main idle for hours until it has waited the threshold (#3303)", async () => {
		const r = await run(
			stub({
				mainPushed: 600,
				landing: "ahead",
				pushes: [
					{ at: STALL_MIN - 1, after: "L1" },
					{ at: 700, after: "L0" },
				],
			}),
		);
		expect(r.code).toBe(0);
		expect(r.out).toContain(`since ${ago(STALL_MIN - 1)}`);
	});

	it("counts from main's push where landing was already ahead of it then", async () => {
		const r = await run(
			stub({
				mainPushed: STALL_MIN + 1,
				landing: "diverged",
				atMove: "ahead",
				pushes: [
					{ at: 3, after: "L1" },
					{ at: 700, after: "L0" },
				],
			}),
		);
		expect(r.code).toBe(1);
		expect(r.out).toContain(`since ${ago(STALL_MIN + 1)}`);
	});

	it("counts from the oldest listed push where every one came after main's", async () => {
		const r = await run(
			stub({
				mainPushed: 900,
				landing: "ahead",
				pushes: [
					{ at: 10, after: "L1" },
					{ at: STALL_MIN + 5, after: "L0" },
				],
			}),
		);
		expect(r.code).toBe(1);
		expect(r.out).toContain(`since ${ago(STALL_MIN + 5)}`);
	});

	it("passes where main has moved past the activity feed's last push", async () => {
		const r = await run(
			stub({
				mainPushed: 600,
				landing: "ahead",
				branchSha: "N",
				pushes: [{ at: 700, after: "L0" }],
			}),
		);
		expect(r.code).toBe(0);
		expect(r.out).toContain("newer than the activity feed's last push");
	});

	it("passes a queue within the 2 h backstop, naming its oldest ref by its first push", async () => {
		const r = await run(
			stub({
				mainPushed: 600,
				landing: "identical",
				queue: [created(5), created(119)],
			}),
		);
		expect(r.code).toBe(0);
		expect(r.out).toContain(
			`queue/q1, the oldest of 2 queue refs, has waited since its first push at ${ago(119)}: 1 h 59 min, against 2 h 0 min.`,
		);
	});

	it("says so where no queue ref waits", async () => {
		const r = await run(stub({ mainPushed: 600, landing: "identical" }));
		expect(r.out).toContain("No queue ref waits.");
	});

	it("fails where a queue ref pushed again has waited past 2 h since its first push after its last deletion", async () => {
		const r = await run(
			stub({
				mainPushed: 600,
				landing: "identical",
				queue: [
					created(5),
					[
						[1, "push"],
						[30, "push"],
						[121, "branch_creation"],
						[200, "branch_deletion"],
						[900, "branch_creation"],
					],
				],
			}),
		);
		expect(r.code).toBe(1);
		expect(r.out).toContain(
			`::error title=Queue ref waiting::queue/q1, the oldest of 2 queue refs, has waited since its first push at ${ago(121)}`,
		);
		expect(r.out).toContain(`the open "${QUEUE_ALERT_TITLES.age}" ticket`);
		expect(QUEUE_ALERT_TITLES.age).not.toBe(STALL_TITLE);
	});

	it("holds no depth: eleven fresh queue refs pass", async () => {
		const r = await run(
			stub({
				mainPushed: 600,
				landing: "identical",
				queue: new Array(11).fill(created(1)),
			}),
		);
		expect(r.code).toBe(0);
		expect(r.out).not.toContain("::error");
	});

	it("skips and names a queue ref whose feed lists no push, failing on nothing", async () => {
		const r = await run(
			stub({
				mainPushed: 600,
				landing: "identical",
				queue: [[], [[300, "branch_deletion"]], created(5)],
			}),
		);
		expect(r.code).toBe(0);
		expect(r.out).toContain(
			"queue/q0 is skipped: its activity feed lists no push.",
		);
		expect(r.out).toContain(
			"queue/q1 is skipped: its activity feed lists no push.",
		);
		expect(r.out).toContain("queue/q2, the oldest of 1 queue refs");
	});

	it("reports the lag's stall where the queue will not read, naming the queue's read as broken", async () => {
		const real = stub({
			mainPushed: STALL_MIN + 30,
			landing: "ahead",
			pushes: [{ at: STALL_MIN + 10, after: "L0" }],
		});
		const r = await run(async (p) => {
			if (p.startsWith("/git/matching-refs/")) throw new Error("HTTP 502");
			return real(p);
		});
		expect(r.code).toBe(1);
		expect(r.out).toContain("::error title=Main lagging landing::");
		expect(r.out).toContain(
			"::error title=Check broken, not a stall::Could not read the queue refs: HTTP 502.",
		);
		expect(r.out).not.toContain("Could not read main's lag");
	});

	it("reports the queue where main's lag will not read, naming the lag's read as broken", async () => {
		const real = stub({
			mainPushed: 600,
			landing: "identical",
			queue: [created(5)],
		});
		const r = await run(async (p) => {
			if (p.startsWith("/compare/")) throw new Error("HTTP 502");
			return real(p);
		});
		expect(r.code).toBe(2);
		expect(r.out).toContain(
			"::error title=Check broken, not a stall::Could not read main's lag behind landing: HTTP 502.",
		);
		expect(r.out).toContain("queue/q0, the oldest of 1 queue refs");
		expect(r.out).not.toContain("Could not read the queue refs");
	});

	it("fails as a broken check on a feed entry with no timestamp", async () => {
		const real = stub({ mainPushed: 600, landing: "ahead" });
		const r = await run(async (p) =>
			p.startsWith("/activity?ref=refs/heads/landing&")
				? [{ after: "L0" }]
				: real(p),
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
		expect(r.out).toContain("git log origin/main..origin/landing");
		expect(r.out).toContain("git ls-remote origin 'refs/heads/queue/*'");
		expect(r.out).not.toContain("Main lagging");
	});
});

describe("main-lag-alarm.js through fetch", () => {
	/* Crosses a real socket: the script's own fetch adapter and environment,
	 * against a local server standing in for GitHub's API. */
	it("reads GitHub's API from the environment Actions sets and exits on the verdict", async () => {
		const seen: string[] = [];
		const api = stub({ mainPushed: 1, landing: "identical" });
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
			expect(out.status).toBe(0);
			expect(out.stdout).toContain("is level with landing (identical)");
			expect(seen).toContain("/compare/M...landing Bearer tok");
		} finally {
			server.close();
		}
	});
});

interface Workflow {
	name: string;
	on: { schedule: { cron: string }[] };
	jobs: {
		lag: { name: string; if: string; steps: { run?: string }[] };
	};
}

describe("main-lag.yml", () => {
	const workflow = yaml.load(
		fs.readFileSync(path.join(ROOT, ".github/workflows/main-lag.yml"), "utf8"),
	) as Workflow;
	const job = workflow.jobs.lag;

	it("runs the check hourly, in the code repo alone", () => {
		expect(workflow.on.schedule).toEqual([{ cron: "47 * * * *" }]);
		expect(job.if).toContain("lucmoseley/workflow-core");
		expect(job.steps.map((s) => s.run).filter(Boolean)).toEqual([
			"node scripts/main-lag-alarm.js",
		]);
	});

	it("names the threshold the check applies where an email shows it", () => {
		const hours = STALL_MS / 3_600_000;
		expect(workflow.name).toContain(`${hours}h`);
		expect(job.name).toContain(`${hours} hours of landing going ahead`);
		expect(job.name).toContain(
			`no queue ref waited over ${QUEUE_BACKSTOP_MS / 3_600_000} hours`,
		);
		expect(job.name.replace(/\b2 hours\b/g, "")).not.toMatch(/\d/);
	});
});
