#!/usr/bin/env node

const { writeFd } = require("./lib/write-fd.js");
const { scriptPath } = require("./lib/script-path.js");
const {
	machineAdmission,
	LAUNCH_SPARES,
	readCpuSlots,
	buildSessionCeilingText,
	buildSessionDrawLine,
	buildWindowsLine,
	buildLiveDrawLine,
	SUITE_GATE_MB,
	buildMemoryBreakdownLines,
	reclaimableMb,
	SUITE_RESTING_MB,
} = require("./lib/admission");
const { readReserves } = require("./lib/admission-reserves.js");
const { admissionSessionIds } = require("./lib/agent-liveness");
const { readJobs, findHungJobs } = require("./lib/hung-jobs");
const { readAllowance } = require("./lib/allowance");
const { overloadReading, buildOverloadText } = require("./lib/cpu-sample");
const { parseOrExit } = require("./lib/cli-args");

const USAGE = `Usage: node ${scriptPath("admission.js")} [--json] [--launch] [--skip-allowance]
       node ${scriptPath("admission.js")} --load-only`;

// #371
const ALLOWANCE_BACKSTOP = 100;

/** @returns {{ breach: string | null, warning: string | null }} */
function allowanceCheck() {
	const allowance = readAllowance();
	/** @type {[string, "weekly_all" | "session"][]} */
	const bars = [
		["weekly", "weekly_all"],
		["session", "session"],
	];
	const warnings = [];
	let breach = null;
	for (const [label, key] of bars) {
		const bar = allowance[key];
		if (bar.trust === "unreported") continue;
		if (bar.trust !== "fresh") {
			warnings.push(
				`${label} allowance reading is ${bar.trust} — admitting anyway`,
			);
			continue;
		}
		if (
			breach === null &&
			bar.percent !== null &&
			bar.percent >= ALLOWANCE_BACKSTOP
		) {
			breach = `${label} allowance ${bar.percent}% used (backstop ${ALLOWANCE_BACKSTOP}%)`;
		}
	}
	return { breach, warning: warnings.length > 0 ? warnings.join("; ") : null };
}

const CPU_LOAD_UNKNOWN =
	"cpu load           unknown — /proc/loadavg unreadable, so nothing is held on load";

/**
 * @param {import("./lib/cpu-sample").LoadReading} load
 * @param {ReturnType<typeof readCpuSlots>} cpu
 * @param {boolean} only
 */
function buildCpuHoldLines(load, cpu, only) {
	const lines = [
		...(load.overloaded
			? [`cpu load           ${buildOverloadText(load)}`]
			: []),
		...(cpu.full ? [`cpu sessions       ${buildSessionCeilingText(cpu)}`] : []),
	];
	if (only && lines.length > 0) lines[lines.length - 1] += " — the only hold";
	return lines;
}

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: {
			"--json": "boolean",
			"--launch": "boolean",
			"--skip-allowance": "boolean",
			"--load-only": "boolean",
		},
	});
	if (flags["--load-only"]) return cpuLimbOnly();
	const json = flags["--json"] === true;
	const spares = flags["--launch"] ? LAUNCH_SPARES : 0;
	const listed = admissionSessionIds();
	const { overhead, host, live, load, cpu, verdict, memory } = machineAdmission(
		{
			listed,
			reclaimable: reclaimableMb(),
			pendingSpares: spares,
			reserves: readReserves(),
		},
	);
	const memoryText = `\n\n${buildMemoryBreakdownLines(memory).join("\n")}`;

	const allowance = flags["--skip-allowance"]
		? { breach: null, warning: null }
		: allowanceCheck();
	if (verdict.ok && allowance.breach) {
		verdict.admit = false;
		verdict.reason = allowance.breach;
	}

	const hungJobs = listed.ids && listed.pids ? readHungJobs(listed) : [];

	if (json) return writeJson({ verdict, hungJobs, allowance, memory });

	if (!verdict.ok)
		return writeRefusal({ verdict, load, cpu, memoryText, hungJobs });
	const lines = buildReportLines({
		verdict,
		host,
		live,
		overhead,
		spares,
		allowance,
	});
	writeFd(
		1,
		`${lines.join("\n")}${memoryText}${buildHungJobsText(hungJobs)}\n`,
	);
	return verdict.admit ? 0 : 1;
}

/**
 * @typedef {ReturnType<typeof machineAdmission>} Admission
 * @typedef {{breach: string | null, warning: string | null}} AllowanceRead
 */

/** @returns {number} */
function cpuLimbOnly() {
	const load = overloadReading();
	const cpu = readCpuSlots();
	const lines = [
		...(load.load1 === null ? [CPU_LOAD_UNKNOWN] : []),
		...(cpu.unknown === null ? [] : [cpuSessionsUnknown(cpu)]),
		...buildCpuHoldLines(load, cpu, true),
	];
	if (lines.length > 0) writeFd(1, `${lines.join("\n")}\n`);
	return load.overloaded || cpu.full ? 1 : 0;
}

/** @param {ReturnType<typeof readCpuSlots>} cpu */
const cpuSessionsUnknown = (cpu) =>
	`cpu sessions       unknown — ${cpu.unknown}, so nothing is held on the session count`;

/**
 * @param {Parameters<typeof findHungJobs>[1]} listed
 * @returns {ReturnType<typeof findHungJobs>}
 */
function readHungJobs(listed) {
	const jobs = readJobs();
	return jobs ? findHungJobs(jobs, listed) : [];
}

/**
 * @param {{verdict: Admission["verdict"], hungJobs: ReturnType<typeof findHungJobs>, allowance: AllowanceRead, memory: Admission["memory"]}} a
 * @returns {number}
 */
function writeJson({ verdict, hungJobs, allowance, memory }) {
	writeFd(
		1,
		`${JSON.stringify({ ...verdict, hungJobs, allowanceWarning: allowance.warning, memory }, null, 2)}\n`,
	);
	if (!verdict.ok) return 2;
	return verdict.admit ? 0 : 1;
}

/**
 * @param {{verdict: Extract<Admission["verdict"], {ok: false}>, load: Admission["load"], cpu: Admission["cpu"], memoryText: string, hungJobs: ReturnType<typeof findHungJobs>}} a
 * @returns {number}
 */
function writeRefusal({ verdict, load, cpu, memoryText, hungJobs }) {
	const cpuRemedy = buildCpuHoldLines(load, cpu, false)
		.map((l) => `\n${l}`)
		.join("");
	writeFd(
		2,
		`ADMISSION REFUSED — ${verdict.error}\n  Start nothing on a guess: an over-admission freezes the machine.${cpuRemedy}${memoryText}\n${buildHungJobsText(hungJobs)}`,
	);
	return 2;
}

/**
 * @param {{verdict: Extract<Admission["verdict"], {ok: true}>, host: Admission["host"], live: Admission["live"], overhead: Admission["overhead"], spares: number, allowance: AllowanceRead}} a
 * @returns {string[]}
 */
function buildReportLines({
	verdict,
	host,
	live,
	overhead,
	spares,
	allowance,
}) {
	const windowsLine = buildWindowsLine(verdict);
	return [
		`available memory   ${verdict.availableMb} MB`,
		`live sessions      ${verdict.sessions} alongside this one`,
		`session draw       ${buildSessionDrawLine(host)}`,
		`live draw          ${buildLiveDrawLine(live)}`,
		...(overhead.ok && overhead.pendingMb
			? [
					`pending spares     ${overhead.pendingMb} MB reserved for the ${spares} spare(s) this launch will warm, at ${overhead.perPairMb} MB a pair, and as much again for each slot past the first (#2511)`,
				]
			: []),
		`reclaimable        ${verdict.reclaimedMb} MB about to be reaped`,
		...(windowsLine ? [`windows memory     ${windowsLine}`] : []),
		`slots              ${verdict.slots} — ${verdict.admit ? "ADMIT" : "HOLD"}: ${verdict.reason}`,
		...(verdict.load.load1 === null ? [CPU_LOAD_UNKNOWN] : []),
		...buildCpuHoldLines(
			verdict.load,
			verdict.cpu,
			verdict.cpuIsSoleHold && !allowance.breach,
		),
		`test suites        ${verdict.suites} concurrent${
			verdict.availableMb - verdict.reservedMb >= SUITE_GATE_MB
				? ""
				: ` (under the ~${SUITE_GATE_MB} MB three-suite gate)`
		}${
			verdict.suites > 0 &&
			verdict.availableMb - verdict.reservedMb < SUITE_RESTING_MB[1]
				? " — on the pretest reap `npm run test` and `test:changed` run; a build and a bare `vitest run` collect no credit"
				: ""
		}`,
		...(allowance.warning ? [`allowance          ${allowance.warning}`] : []),
	];
}

/** @param {ReturnType<typeof findHungJobs>} hungJobs */
function buildHungJobsText(hungJobs) {
	if (hungJobs.length === 0) return "";
	const lines = [
		"",
		`hung job(s)        ${hungJobs.length} — listed and alive, but silent; may be holding a slot or a ledger entry:`,
	];
	for (const h of hungJobs) {
		lines.push(
			`  ${h.intent || h.job} — job ${h.job}, session ${h.sessionId}, pid ${h.pid ?? "unknown"}`,
			`    roster: ${h.rosterPath}`,
		);
	}
	return `\n${lines.join("\n")}`;
}

if (require.main === module) process.exit(main());

module.exports = { main };
