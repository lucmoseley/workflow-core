// @vitest-environment node
/*
 * The check-interop-latency.js program (#3564): its adapters crossed once for
 * real, and its outcomes and exits. A reg.exe sleeping 3 s reads DEGRADED
 * with its latencies and writes one evidence record of every field, read
 * through the real fs, dmesg, typeperf and /proc adapters; a fast one reads
 * OK and prints nothing at session start; no reg.exe is a silent SKIP; a bad
 * flag is BROKEN. The judging itself is lib/interop-latency.test.ts's.
 *
 * reg.exe is lib/reg-fake.ts's, typeperf.exe lib/typeperf-fake.ts's, dmesg
 * lib/dmesg-fake.ts's and /proc lib/proc-fake.ts's, so no case crosses the
 * machine's own bridge.
 *
 * It is a SessionStart `--notify` hook: loosen a case and a degraded bridge
 * reads as load again, or every healthy start prints a warning.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dmesgLine, writeDmesg } from "./lib/dmesg-fake";
import { makeProcRoot } from "./lib/proc-fake";
import { regCalls, writeReg } from "./lib/reg-fake";
import { runInProcess } from "./lib/run-in-process.js";
import { writeTypeperf } from "./lib/typeperf-fake";

const SCRIPT = path.join(__dirname, "check-interop-latency.js");

/** #3564's degraded readings. */
const SAMPLE = { cpuPct: 62.5, availableMb: 1700, vmmemBytes: 6.5 * 2 ** 30 };

/* Two queries of a reg.exe sleeping 3 s, plus the evidence reads, against
 * vitest's 5 s default. */
const DEGRADED_CASE_MS = 20_000;

let dir: string;
let proc: ReturnType<typeof makeProcRoot>;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "interop-latency-"));
	proc = makeProcRoot(68_400);
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	proc.remove();
});

const logPath = () =>
	path.join(
		dir,
		"host",
		".claude",
		"tmp",
		"markers",
		".interop-degraded.jsonl",
	);

/** An arm64 ring holding one order-4 `hvs_probe` failure, as dmesg prints it. */
function ring(): string[] {
	const t0 = Date.parse("2026-10-29T02:20:00Z");
	return [
		"Booting Linux on physical CPU 0x0000000000",
		"kworker/0:3: page allocation failure: order:4, mode:0xdc0(GFP_KERNEL|__GFP_ZERO), nodemask=(null),cpuset=/,mems_allowed=0",
		"Call trace:",
		" vmbus_alloc_ring+0x94/0xf8",
		" vmbus_open+0x38/0xa8",
		" hvs_probe+0x214/0x4e8",
	].map((msg, i) => dmesgLine(t0 + i, msg));
}

function run(args: string[], reg: string, env: Record<string, string> = {}) {
	const vmbus = path.join(dir, "vmbus");
	for (const id of ["a", "b", "c"])
		fs.mkdirSync(path.join(vmbus, id), { recursive: true });
	return runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			GITHUB_ACTIONS: "",
			CLAUDE_PROJECT_DIR: path.join(dir, "host"),
			CLAUDE_INTEROP_REG: reg,
			WFC_TYPEPERF: writeTypeperf(path.join(dir, "win"), SAMPLE),
			WFC_DMESG: writeDmesg(path.join(dir, "dmesg"), ring()),
			WFC_VMBUS_DEVICES: vmbus,
			WFC_PROC: proc.root,
			...env,
		},
	});
}

describe("a degraded bridge", () => {
	it("reads DEGRADED with both latencies and writes one evidence record of every #3564 field", {
		timeout: DEGRADED_CASE_MS,
	}, () => {
		proc.proc(4100, {
			argv: ["/init", "/mnt/c/Windows/System32/reg.exe", "reg.exe", "query"],
		});
		proc.proc(4101, { argv: "/init" });
		// §X9: crosses the real clock — #3564's acceptance names a reg.exe
		// sleeping 3 s, and the latency is the reading under test. A sleep
		// cannot return early, so the 3 s floor cannot flake.
		const r = run(["--notify"], writeReg(path.join(dir, "reg"), [3]));
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(
			/INTEROP-DEGRADED — .* two policy queries took 3\.\d\d s and 3\.\d\d s/,
		);
		expect(r.stdout).toContain("wsl --shutdown");
		expect(r.stdout).toContain(logPath());

		const rows = fs
			.readFileSync(logPath(), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(rows).toHaveLength(1);
		const [row] = rows;
		expect(row.latenciesS).toHaveLength(2);
		expect(row).toMatchObject({
			expired: false,
			uptimeS: 68_400,
			hvsProbeFailures: { "4": 1 },
			vmbusDevices: 3,
			windowsCpuPct: 62.5,
			windowsAvailableMb: 1700,
			vmmemWorkingSetMb: 6656,
			interopInFlight: 1,
		});
		expect(Date.parse(row.at)).not.toBeNaN();
	});

	it("exits 1 on a plain run, recording an unreadable reading as null, never 0", {
		timeout: DEGRADED_CASE_MS,
	}, () => {
		// §X9: crosses the real clock — 1.1 s is the shortest sleep over the
		// check's 1 s threshold.
		const r = run(["--json"], writeReg(path.join(dir, "reg"), [1.1]), {
			WFC_TYPEPERF: writeTypeperf(path.join(dir, "win-failing"), "failing"),
			WFC_DMESG: path.join(dir, "no-dmesg"),
			WFC_VMBUS_DEVICES: path.join(dir, "no-vmbus"),
			WFC_PROC: path.join(dir, "no-proc"),
		});
		expect(r.status).toBe(1);
		const envelope = JSON.parse(r.stdout);
		expect(envelope.summary).toBe("FAIL: 1 degraded interop bridge");
		expect(envelope.evidence).toEqual({
			uptimeS: null,
			hvsProbeFailures: null,
			vmbusDevices: null,
			windowsCpuPct: null,
			windowsAvailableMb: null,
			vmmemWorkingSetMb: null,
			interopInFlight: null,
		});
	});
});

describe("a healthy bridge", () => {
	it("reads OK after one query, and prints nothing at session start", () => {
		const regDir = path.join(dir, "reg");
		const reg = writeReg(regDir, [0]);
		expect(run(["--notify"], reg).stdout).toBe("");
		const r = run([], reg);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(
			"OK: the interop bridge answered a policy query in",
		);
		expect(regCalls(regDir)).toBe(2);
		expect(fs.existsSync(logPath())).toBe(false);
	});
});

describe("no bridge to probe", () => {
	it("is a silent SKIP where reg.exe is absent", () => {
		const r = run(["--notify"], path.join(dir, "no-reg"));
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(run([], path.join(dir, "no-reg")).stderr).toContain("SKIP:");
	});
});

describe("a bad invocation", () => {
	it("is BROKEN, exit 2, on an unknown flag", () => {
		const r = run(["--bogus"], path.join(dir, "no-reg"));
		expect(r.status).toBe(2);
	});
});
