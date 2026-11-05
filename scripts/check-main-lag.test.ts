// @vitest-environment node

/*
 * scripts/check-main-lag.js and .github/workflows/main-lag.yml (#4443), with
 * GitHub's activity and compare endpoints stubbed. Break this and the one
 * stall alarm that outlives the machine stays green through a stall, or the
 * workflow's email names a threshold the check no longer applies.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "./check-main-lag.js";
import { STALL_MS } from "./lib/landing-stall.js";
import { ROOT } from "./lib/precommit-gate-testkit";

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
}

/* `main` at sha M; `landing`'s pushes, newest first, each its own sha. */
const stub =
	({ mainPushed, landing, pushes = [], atMove = "identical" }: Queue) =>
	async (p: string) => {
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
	const code = await main({ get, now: NOW, say: (l) => said.push(l) });
	return { code, out: said.join("\n") };
};

const STALL_MIN = STALL_MS / MIN;

describe("check-main-lag.js", () => {
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
		expect(r.out).toContain("Landing queue stalled");
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

	it("fails as a broken check, naming the way out, where the API will not read", async () => {
		const r = await run(async () => {
			throw new Error("/activity: HTTP 503");
		});
		expect(r.code).toBe(1);
		expect(r.out).toContain("::error title=Check broken, not a stall::");
		expect(r.out).toContain("HTTP 503");
		expect(r.out).toContain("git log origin/main..origin/landing");
		expect(r.out).not.toContain("Main lagging");
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
			"node scripts/check-main-lag.js",
		]);
	});

	it("names the threshold the check applies where an email shows it", () => {
		const hours = STALL_MS / 3_600_000;
		expect(workflow.name).toContain(`${hours}h`);
		expect(job.name).toContain(`${hours} hours`);
	});
});
