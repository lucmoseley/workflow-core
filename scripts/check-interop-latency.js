#!/usr/bin/env node
/*
 * check-interop-latency.js — say so when the WSL↔Windows interop bridge is
 * degraded: answering, but slowly, and staying slow until `wsl --shutdown`
 * (#3564). docs/environment.md §9's third mode; its wedge probe,
 * lib/interop-probe.sh, reads such a bridge as healthy, since every call
 * returns inside its 12 s budget.
 *
 * Usage:  node scripts/check-interop-latency.js [--notify] [--json]
 *
 * THE READING is the policy query every `claude` start makes, timed, at the
 * probe's own seam, CLAUDE_INTEROP_REG. Two slow queries in a row read
 * DEGRADED.
 *
 * ON DETECTION it appends one evidence record to `.interop-degraded.jsonl`
 * under the host's .claude/tmp/markers: the two latencies, uptime, dmesg's
 * failed `hvs_probe` ring allocations by order, the vmbus device count,
 * Windows' CPU and Available MBytes counters, vmmemWSL's working set, and the
 * interop calls in flight. A reading that cannot be taken is null, never 0.
 * Each binary or tree is injected at a named var (§N7): WFC_DMESG,
 * WFC_TYPEPERF, WFC_VMBUS_DEVICES and WFC_PROC.
 *
 * FAILS OPEN, SILENTLY. No executable reg.exe — not WSL, or interop off — is
 * SKIP. A DEGRADED bridge is FAIL, so a plain run exits 1; under --notify it
 * exits 0 and prints the warning.
 *
 * IT NEVER RECOVERS ANYTHING — §9's rule for Guard 2: a false positive that
 * ran `wsl --shutdown` would kill every live session.
 *
 * IMPLICIT:  at every session start, times one Windows policy query through the interop bridge, and a second where the first is slow; where both are slow, appends one evidence record to `.interop-degraded.jsonl` under .claude/tmp/markers and prints that the bridge is degraded with the sync-then-shutdown recovery; prints nothing on a fast or unprobeable bridge.
 * JUSTIFIED: fail-safe — a degraded bridge otherwise reads as load, and the record is the only trace of its cause once the VM restarts.
 * DEFEAT:    none at the hook; a `wsl --shutdown` clears the fault.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./lib/caught.js");
const { runCheck } = require("./lib/check");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { hostRoot } = require("./lib/host-root.js");
const {
	COUNTERS,
	countHvsProbeFailures,
	countInterop,
	judgeBridge,
	parseTypeperf,
} = require("./lib/interop-latency.js");
const { markersDir } = require("./lib/marker-root.js");
const { procRoot } = require("./lib/proc-root.js");
const { readProcTable, readUptime } = require("./lib/proc-table.js");
const { DAY_MS, appendRetained } = require("./lib/retained-jsonl.js");
const { docPath } = require("./lib/script-path.js");

/**
 * Per query: lib/interop-probe.sh's per-attempt budget, above the ~10 s vsock
 * stall, and above the slowest degraded query, 7.4 s (#3564). Its
 * CLAUDE_INTEROP_PROBE_TIMEOUT override is not read: that tunes the wedge
 * test, and a lower one here would cut a degraded reading short.
 */
const QUERY_BUDGET_MS = 12_000;

/**
 * typeperf's one sample took 1.35 s on a healthy bridge (#3564); the rest is
 * room for a degraded bridge's 3.9–7.4 s per call. A guess beyond that.
 */
const TYPEPERF_BUDGET_MS = 15_000;

/**
 * A plain dmesg read of a 30 KB ring took 4 ms (#3564), and the kernel's ring
 * is 256 KB (CONFIG_LOG_BUF_SHIFT=18); the rest is a guessed margin for load.
 */
const DMESG_TIMEOUT_MS = 5000;

/* 30 days, a guess: a month of incident evidence outlasts the restart that
 * ends each incident by far. */
const RETAIN_MS = 30 * DAY_MS;

const LOG = ".interop-degraded.jsonl";
const POLICY_KEY = "HKCU\\SOFTWARE\\Policies\\ClaudeCode";

/** @typedef {import("./lib/interop-latency.js").Evidence} Evidence */
/** @typedef {import("./lib/interop-latency.js").Reading} Reading */

/** @returns {Reading | null} */
function query() {
	const reg =
		process.env.CLAUDE_INTEROP_REG || "/mnt/c/Windows/System32/reg.exe";
	try {
		fs.accessSync(reg, fs.constants.X_OK);
	} catch {
		// Not WSL, or interop off: the check SKIPs.
		return null;
	}
	const start = process.hrtime.bigint();
	const r = spawnSync(reg, ["query", POLICY_KEY, "/v", "Settings"], {
		stdio: "ignore",
		timeout: QUERY_BUDGET_MS,
		killSignal: "SIGKILL",
	});
	const s = Number(process.hrtime.bigint() - start) / 1e9;
	const expired = r.error !== undefined && caught(r.error).code === "ETIMEDOUT";
	// Any exit, 1 for the absent key included, is the bridge answering.
	if (r.error && !expired) return null;
	return { s, expired };
}

/** dmesg's failed `hvs_probe` allocations by order, or null where it will not read. */
function readHvsProbeFailures() {
	const r = spawnSync(process.env.WFC_DMESG || "dmesg", [], {
		encoding: "utf8",
		timeout: DMESG_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "ignore"],
		maxBuffer: CHILD_MAX_BUFFER,
	});
	if (r.error || r.status !== 0) return null;
	return countHvsProbeFailures(r.stdout);
}

function readVmbusDevices() {
	try {
		return fs.readdirSync(
			process.env.WFC_VMBUS_DEVICES || "/sys/bus/vmbus/devices",
		).length;
	} catch {
		// Recorded as null: an unread count is not 0.
		return null;
	}
}

/** typeperf's one sample of COUNTERS; nulls where it will not run or answer. */
function readWindowsCounters() {
	const r = spawnSync(
		process.env.WFC_TYPEPERF || "/mnt/c/Windows/System32/typeperf.exe",
		[...COUNTERS, "-sc", "1"],
		{
			encoding: "utf8",
			timeout: TYPEPERF_BUDGET_MS,
			stdio: ["ignore", "pipe", "ignore"],
		},
	);
	return parseTypeperf(r.error || r.status !== 0 ? "" : r.stdout);
}

/** @param {string} proc */
function readInteropInFlight(proc) {
	const table = readProcTable(proc);
	return table ? countInterop(table.procs.values()) : null;
}

/** @returns {Evidence} */
function readEvidence() {
	const proc = procRoot();
	const win = readWindowsCounters();
	return {
		uptimeS: readUptime(proc),
		hvsProbeFailures: readHvsProbeFailures(),
		vmbusDevices: readVmbusDevices(),
		windowsCpuPct: win.cpuPct,
		windowsAvailableMb: win.availableMb,
		vmmemWorkingSetMb: win.vmmemMb,
		interopInFlight: readInteropInFlight(proc),
	};
}

runCheck({
	name: "interop-latency",
	usage: "node check-interop-latency.js [--notify] [--json]",
	run(ctx) {
		const logFile = path.join(markersDir(hostRoot()), LOG);
		const verdict = judgeBridge(
			{
				query,
				readEvidence,
				record: (entry) => appendRetained(logFile, entry, RETAIN_MS),
				now: () => new Date().toISOString(),
			},
			{ logFile, doc: docPath("environment.md") },
		);
		if (verdict.state === "UNPROBED")
			return ctx.skip(
				"no executable reg.exe answered, so the interop bridge's latency is unknown — not WSL, or interop is off.",
			);
		if (verdict.state === "OK")
			return {
				okLine: verdict.okLine,
				data: { latenciesS: verdict.latenciesS },
			};
		const { latenciesS, evidence, logged } = verdict;
		ctx.fail("INTEROP-DEGRADED", verdict.finding, { latenciesS });
		ctx.say(`${verdict.warning.join("\n")}\n`);
		return {
			noun: "degraded interop bridge",
			count: 1,
			data: { latenciesS, evidence, logged },
		};
	},
});
