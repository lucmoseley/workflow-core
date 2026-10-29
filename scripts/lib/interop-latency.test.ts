// @vitest-environment node
/*
 * The check-interop-latency core (#3564), in process, its ports filled by the
 * test: two slow policy queries read DEGRADED and write one record, one slow
 * then one fast reads OK as §9's vsock stall, a fast first query is the only
 * one made, and the evidence parsers keep each `hvs_probe` failure's order
 * and count interop calls alone. Loosen a case and a degraded bridge reads as
 * load again, or a vsock stall raises a false alarm at session start.
 */
import { describe, expect, it } from "vitest";

interface Reading {
	s: number;
	expired: boolean;
}
const { countHvsProbeFailures, countInterop, judgeBridge, parseTypeperf } =
	require("./interop-latency.js") as {
		countHvsProbeFailures: (text: string) => Record<string, number>;
		countInterop: (procs: { argv: string[] }[]) => number;
		judgeBridge: (
			ports: object,
			names: { logFile: string; doc: string },
		) => Record<string, unknown> & { state: string };
		parseTypeperf: (stdout: string) => Record<string, number | null>;
	};

const EVIDENCE = {
	uptimeS: 68_400,
	hvsProbeFailures: { "4": 14 },
	vmbusDevices: 43,
	windowsCpuPct: 62.5,
	windowsAvailableMb: 1700,
	vmmemWorkingSetMb: 6656,
	interopInFlight: 2,
};
const NAMES = {
	logFile: "/m/.interop-degraded.jsonl",
	doc: "docs/environment.md",
};

function judge(readings: (Reading | null)[], { lands = true } = {}) {
	const queue = [...readings];
	const records: object[] = [];
	let queries = 0;
	const verdict = judgeBridge(
		{
			query: () => {
				queries++;
				return queue.shift() ?? null;
			},
			readEvidence: () => EVIDENCE,
			record: (entry: object) => {
				records.push(entry);
				return lands;
			},
			now: () => "2026-10-29T02:20:00.000Z",
		},
		NAMES,
	);
	return { verdict, records, queries };
}

const fast = { s: 0.04, expired: false };
const slow = (s: number) => ({ s, expired: false });

describe("judgeBridge", () => {
	it("reads a fast first query OK, making no second", () => {
		const { verdict, records, queries } = judge([fast]);
		expect(verdict).toMatchObject({
			state: "OK",
			okLine: "the interop bridge answered a policy query in 0.04 s.",
		});
		expect(queries).toBe(1);
		expect(records).toEqual([]);
	});

	it("reads one slow query then a fast one as §9's vsock stall, not DEGRADED", () => {
		const { verdict, records } = judge([slow(10.06), fast]);
		expect(verdict.state).toBe("OK");
		expect(verdict.okLine).toContain("after one slow query (10.06 s)");
		expect(records).toEqual([]);
	});

	it("reads two slow queries DEGRADED and records one line of latencies and evidence", () => {
		const { verdict, records } = judge([slow(3.9), slow(7.4)]);
		expect(verdict).toMatchObject({
			state: "DEGRADED",
			latenciesS: [3.9, 7.4],
			finding: "two policy queries took 3.90 s and 7.40 s",
		});
		expect((verdict.warning as string[]).join("\n")).toContain(
			`Evidence logged to ${NAMES.logFile}.`,
		);
		expect(records).toEqual([
			{
				at: "2026-10-29T02:20:00.000Z",
				latenciesS: [3.9, 7.4],
				expired: false,
				...EVIDENCE,
			},
		]);
	});

	it("reads a query past its budget as slow, and says so in the record", () => {
		const { verdict, records } = judge([
			{ s: 12, expired: true },
			{ s: 12, expired: true },
		]);
		expect(verdict.finding).toBe(
			"two policy queries took over 12.0 s and over 12.0 s",
		);
		expect(records[0]).toMatchObject({ expired: true });
	});

	it("names a record that would not write", () => {
		const { verdict } = judge([slow(4), slow(4)], { lands: false });
		expect((verdict.warning as string[]).join("\n")).toContain(
			"The evidence record would not write",
		);
	});

	it("is UNPROBED where no query can run", () => {
		expect(judge([null]).verdict).toEqual({ state: "UNPROBED" });
	});
});

describe("countHvsProbeFailures", () => {
	/* An arm64 trace as dmesg prints it: the failure line, then `Call trace:`
	 * on its own line and one frame a line (this machine's 28 Oct boot). */
	const trace = (order: number, frame: string) => [
		`[ 100.000000] kworker/0:3: page allocation failure: order:${order}, mode:0xdc0(GFP_KERNEL|__GFP_ZERO), nodemask=(null),cpuset=/,mems_allowed=0`,
		"[ 100.000001] Workqueue: hv_pri_chan vmbus_add_channel_work",
		"[ 100.000002] Call trace:",
		"[ 100.000003]  vmbus_alloc_ring+0x94/0xf8",
		"[ 100.000004]  vmbus_open+0x38/0xa8",
		`[ 100.000005]  ${frame}`,
		"[ 100.000006]  vmbus_probe+0x4c/0xb0",
	];

	it("counts each failed allocation under hvs_probe by its order", () => {
		const text = [
			...trace(4, "hvs_probe+0x214/0x4e8"),
			...trace(4, "hvs_probe+0x214/0x4e8"),
			...trace(7, "hvs_probe+0x214/0x4e8"),
		].join("\n");
		expect(countHvsProbeFailures(text)).toEqual({ "4": 2, "7": 1 });
	});

	it("skips a failure in another driver and a stray hvs_probe line", () => {
		const text = [
			...trace(4, "netvsc_probe+0x1c/0x2a0"),
			"[ 200.000000] hv_sock: hvs_probe: channel offer",
		].join("\n");
		expect(countHvsProbeFailures(text)).toEqual({});
	});
});

describe("countInterop", () => {
	it("counts /init-launched .exe calls alone", () => {
		expect(
			countInterop([
				{ argv: ["/init", "/mnt/c/Windows/System32/reg.exe", "reg.exe"] },
				{ argv: ["/init", "/mnt/c/Windows/System32/PING.EXE", "PING.EXE"] },
				{ argv: ["/init"] },
				{ argv: ["/usr/bin/node", "x.exe"] },
			]),
		).toBe(2);
	});
});

describe("parseTypeperf", () => {
	it("reads nulls from output with a counter missing", () => {
		expect(
			parseTypeperf(
				'\r\n"(PDH-CSV 4.0)","\\\\H\\A","\\\\H\\B"\r\n"10/29/2026 12:00:00.000","1.0","2.0"\r\n',
			),
		).toEqual({ cpuPct: null, availableMb: null, vmmemMb: null });
	});
});
