// @vitest-environment node
/*
 * wsl-disk-compaction.js's run (#5044), every effect behind a port, so the
 * order is seen: nothing shuts WSL down while a session is live, a hold is
 * always released on a path that does not start the task, and a run that is
 * not due does nothing. Loosened, the monthly job kills live sessions, or
 * leaves the loop held.
 */
import { describe, expect, it } from "vitest";
import { parseLog } from "./lib/wsl-disk.js";
import { MAX_WAIT_MS, runCompaction } from "./wsl-disk-compaction.js";

const NOW = Date.parse("2026-12-20T02:00:00");
const OLD = parseLog("2026-11-12T21:00:00 registered");
const FRESH = parseLog("2026-12-15T02:00:00 ok after_gb=100");

function ports(over: Record<string, unknown> = {}) {
	const calls: string[] = [];
	let clock = NOW;
	const live = (over.live as number[]) ?? [0];
	let polls = 0;
	const p = {
		now: () => clock,
		isWsl: () => true,
		readEntries: () => OLD,
		appendLine: (l: string) => calls.push(`log ${l}`),
		sparseWatch: () => {
			calls.push("sparse");
			return ["no trigger"];
		},
		liveSessions: () => live[Math.min(polls++, live.length - 1)],
		hold: () => {
			calls.push("hold");
			return null;
		},
		release: () => {
			calls.push("release");
			return null;
		},
		sleep: (ms: number) => {
			clock += ms;
		},
		trim: () => {
			calls.push("trim");
			return { out: "/: 10 GiB trimmed", error: null };
		},
		startTask: () => {
			calls.push("start");
			return null;
		},
		say: (l: string) => calls.push(`say ${l}`),
		...over,
	};
	return { p, calls };
}
const steps = (calls: string[]) => calls.filter((c) => !c.startsWith("say "));

describe("runCompaction", () => {
	it("does nothing when not due", () => {
		const { p, calls } = ports({ readEntries: () => FRESH });
		expect(runCompaction(p as never, { force: false })).toBe(0);
		expect(steps(calls)).toEqual([]);
	});

	it("runs a due one: watch, hold, trim, then start, with no release", () => {
		const { p, calls } = ports();
		expect(runCompaction(p as never, { force: false })).toBe(0);
		expect(steps(calls)).toEqual(["sparse", "hold", "trim", "start"]);
	});

	it("runs one not due under --now", () => {
		const { p, calls } = ports({ readEntries: () => FRESH });
		expect(runCompaction(p as never, { force: true })).toBe(0);
		expect(steps(calls)).toContain("start");
	});

	it("waits for live sessions, renewing the hold each poll", () => {
		const { p, calls } = ports({ live: [2, 1, 0] });
		expect(runCompaction(p as never, { force: false })).toBe(0);
		expect(steps(calls)).toEqual([
			"sparse",
			"hold",
			"hold",
			"hold",
			"trim",
			"start",
		]);
	});

	it("treats a listing it cannot read as live, never as none", () => {
		const { p, calls } = ports({ live: [{ why: "oracle down" }, 0] });
		expect(runCompaction(p as never, { force: false })).toBe(0);
		expect(calls.some((c) => c.includes("waiting: oracle down"))).toBe(true);
	});

	it("defers after MAX_WAIT_MS, releasing the hold, logging, starting nothing", () => {
		const { p, calls } = ports({ live: [1] });
		expect(runCompaction(p as never, { force: false })).toBe(1);
		const s = steps(calls);
		expect(s).not.toContain("start");
		expect(s).not.toContain("trim");
		expect(s.slice(-2)).toEqual(["release", "log deferred sessions=1_live"]);
		expect(s.filter((c) => c === "hold").length).toBeGreaterThan(
			MAX_WAIT_MS / 3_600_000,
		);
	});

	it("releases and logs when the task will not start", () => {
		const { p, calls } = ports({ startTask: () => "schtasks exited 1" });
		expect(runCompaction(p as never, { force: false })).toBe(1);
		expect(steps(calls).slice(-2)).toEqual([
			"release",
			"log failed step=schtasks error=schtasks_exited_1",
		]);
	});

	it("compacts untrimmed where fstrim fails", () => {
		const { p, calls } = ports({ trim: () => ({ out: "", error: "denied" }) });
		expect(runCompaction(p as never, { force: false })).toBe(0);
		expect(steps(calls)).toContain("start");
	});

	it("stops, holding nothing, where the hold will not set", () => {
		const { p, calls } = ports({ hold: () => "refill-loop exited 1" });
		expect(runCompaction(p as never, { force: false })).toBe(1);
		expect(steps(calls)).not.toContain("start");
		expect(steps(calls)).toContain("release");
	});

	it("says the task is not installed where no log exists", () => {
		const { p, calls } = ports({ readEntries: () => null });
		expect(runCompaction(p as never, { force: true })).toBe(1);
		expect(steps(calls)).toEqual([]);
	});
});
