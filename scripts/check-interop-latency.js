#!/usr/bin/env node

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

// measured 7.4 s slowest degraded query, ~10 s vsock stall, workflow-core#3564
const QUERY_BUDGET_MS = 12_000;

// measured 1.35 s healthy, 3.9–7.4 s degraded, workflow-core#3564
const TYPEPERF_BUDGET_MS = 15_000;

// measured 4 ms for a 30 KB ring, workflow-core#3564
const DMESG_TIMEOUT_MS = 5000;

// guess, workflow-core#3564
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
	if (r.error && !expired) return null;
	return { s, expired };
}

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
		return null;
	}
}

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
