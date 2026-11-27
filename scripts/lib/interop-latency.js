// guess, workflow-core#3564
const DEGRADED_S = 1;

const COUNTERS = [
	"\\Processor(_Total)\\% Processor Time",
	"\\Memory\\Available MBytes",
	"\\Process(vmmemWSL)\\Working Set",
];

const ALLOC_FAILURE = /page allocation failure: order:(\d+)/;
const HVS_PROBE_FRAME = /\bhvs_probe\+0x/;

/** @typedef {{ s: number, expired: boolean }} Reading */
/**
 * @typedef {{
 *   uptimeS: number | null,
 *   hvsProbeFailures: Record<string, number> | null,
 *   vmbusDevices: number | null,
 *   windowsCpuPct: number | null,
 *   windowsAvailableMb: number | null,
 *   vmmemWorkingSetMb: number | null,
 *   interopInFlight: number | null,
 * }} Evidence
 */
/**
 * @typedef {{
 *   query: () => Reading | null,
 *   readEvidence: () => Evidence,
 *   record: (entry: Record<string, unknown> & { at: string }) => boolean,
 *   now: () => string,
 * }} Ports
 */
/**
 * @typedef {{ state: "UNPROBED" }
 *   | { state: "OK", latenciesS: number[], okLine: string }
 *   | { state: "DEGRADED", latenciesS: number[], evidence: Evidence,
 *       logged: boolean, finding: string, warning: string[] }} Verdict
 */

/** @param {number} n */
const finite = (n) => (Number.isFinite(n) ? n : null);

/** @param {string} stdout */
function parseTypeperf(stdout) {
	const lines = stdout.split(/\r?\n/);
	/** @param {string | undefined} line */
	const cells = (line) =>
		[...(line ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1] ?? "").slice(1);
	const names = cells(lines.find((l) => l.startsWith('"(')));
	const values = cells(lines.find((l) => /^"\d/.test(l)));
	const aligned = values.length === names.length;
	/** @param {string} counter */
	const read = (counter) => {
		const column = names.findIndex((n) => n.endsWith(counter));
		return !aligned || column === -1
			? null
			: finite(Number.parseFloat(values[column] ?? ""));
	};
	const [cpu = "", available = "", workingSet = ""] = COUNTERS;
	const wsBytes = read(workingSet);
	return {
		cpuPct: read(cpu),
		availableMb: read(available),
		vmmemMb: wsBytes === null ? null : Math.round(wsBytes / 2 ** 20),
	};
}

/**
 * @param {string} text
 * @returns {Record<string, number>}
 */
function countHvsProbeFailures(text) {
	/** @type {Record<string, number>} */
	const byOrder = {};
	/** @type {string | null} */
	let order = null;
	for (const line of text.split("\n")) {
		const failure = line.match(ALLOC_FAILURE);
		if (failure?.[1] !== undefined) order = failure[1];
		else if (order !== null && HVS_PROBE_FRAME.test(line)) {
			byOrder[order] = (byOrder[order] ?? 0) + 1;
			order = null;
		}
	}
	return byOrder;
}

/** @param {Iterable<{ argv: string[] }>} procs */
const countInterop = (procs) =>
	[...procs].filter(
		(p) => p.argv[0] === "/init" && /\.exe$/i.test(p.argv[1] ?? ""),
	).length;

/** @param {Reading} r */
const isSlow = (r) => r.expired || r.s > DEGRADED_S;

/** @param {Reading} r */
const latency = (r) =>
	r.expired ? `over ${r.s.toFixed(1)} s` : `${r.s.toFixed(2)} s`;

/**
 * @param {Reading[]} readings
 * @param {{ logged: boolean, logFile: string, doc: string }} at
 */
const buildWarning = (readings, { logged, logFile, doc }) => [
	`INTEROP-DEGRADED — the WSL↔Windows interop bridge is degraded: two policy queries took ${readings.map(latency).join(" and ")}, where a healthy one takes 0.03–0.07 s.`,
	"  Every `claude` start, `gh` call and Windows-path lookup is slow with it, and it stays",
	`  slow until the VM restarts (${doc} §9).`,
	logged
		? `  Evidence logged to ${logFile}.`
		: `  The evidence record would not write to ${logFile}.`,
	"  Commit what you can, then at your next chance:",
	"    sync                      # in WSL — flushes writes `wsl --shutdown` would discard",
	"    wsl --shutdown            # in Windows PowerShell, then reopen the terminal",
	"  Nothing was shut down; this check only reports.",
];

/**
 * @param {Ports} ports
 * @param {{ logFile: string, doc: string }} names
 * @returns {Verdict}
 */
function judgeBridge(ports, { logFile, doc }) {
	const first = ports.query();
	if (!first) return { state: "UNPROBED" };
	if (!isSlow(first))
		return {
			state: "OK",
			latenciesS: [first.s],
			okLine: `the interop bridge answered a policy query in ${latency(first)}.`,
		};
	const second = ports.query();
	if (!second) return { state: "UNPROBED" };
	const readings = [first, second];
	const latenciesS = readings.map((r) => r.s);
	if (!isSlow(second))
		return {
			state: "OK",
			latenciesS,
			okLine: `the interop bridge answered in ${latency(second)} after one slow query (${latency(first)}), §9's vsock-stall shape.`,
		};
	const evidence = ports.readEvidence();
	const logged = ports.record({
		at: ports.now(),
		latenciesS,
		expired: readings.some((r) => r.expired),
		...evidence,
	});
	return {
		state: "DEGRADED",
		latenciesS,
		evidence,
		logged,
		finding: `two policy queries took ${readings.map(latency).join(" and ")}`,
		warning: buildWarning(readings, { logged, logFile, doc }),
	};
}

module.exports = {
	COUNTERS,
	countHvsProbeFailures,
	countInterop,
	judgeBridge,
	parseTypeperf,
};
