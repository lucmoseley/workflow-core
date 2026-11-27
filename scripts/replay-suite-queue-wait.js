#!/usr/bin/env node

const os = require("node:os");
const { scriptPath } = require("./lib/script-path.js");
const path = require("node:path");
const { flagValue, parseOrCode } = require("./lib/cli-args");
const { loadCeiling } = require("./lib/cpu-sample");
const { hostRoot } = require("./lib/host-root");
const { queueExitLogPath } = require("./lib/queue-exit-log");
const { readLogs, render, replay } = require("./lib/suite-queue-replay");
const { minuteLogPath } = require("./lib/windows-memory");
const { writeFd } = require("./lib/write-fd");

const USAGE = `usage: node ${scriptPath("replay-suite-queue-wait.js")} --since <utc> --until <utc> [options]
  --since, --until   the window, ISO UTC; --until is the alarm's reading time
  --era <label>=<utc>   split the limbs where a change to the gate landed in
                     the window, at its commit time; repeatable
  --markers <dir>    the marker stores (default: the canonical checkout's)
  --memwatch <file>  a memwatch log, local time; repeatable (default:
                     ~/memwatch-archive.log and ~/memwatch.log)
  --minute-log <file> memwatch's minute log, the windows limb's
                     (default: ~/memwatch-minute.jsonl)
  --mem-total-mb <n> MemTotal the memwatch \`used\` is taken from (default: this machine's)
  --load-ceiling <n> the load1 hold (default: this machine's)
  --cap-from <utc>   model the per-session cap from this time, to read a
                     window before it landed against it (default: its commit time)`;

/**
 * @param {string | undefined} s
 * @returns {number | null}
 */
function parseUtc(s) {
	const t = Date.parse(s ?? "");
	return Number.isNaN(t) ? null : t;
}

/**
 * @param {string} message
 * @returns {2}
 */
function refuse(message) {
	writeFd(2, `${message}\n\n${USAGE}\n`);
	return 2;
}

/**
 * @param {Parameters<typeof flagValue>[0]} flags
 * @param {Record<string, string[]>} lists
 */
function memwatchLogs(flags, lists) {
	return {
		memwatch: lists["--memwatch"] ?? [
			path.join(os.homedir(), "memwatch-archive.log"),
			path.join(os.homedir(), "memwatch.log"),
		],
		minuteLog: flagValue(flags, "--minute-log") ?? minuteLogPath(),
	};
}

/**
 * @param {string[]} specs
 * @returns {{ label: string, from: number }[] | string}
 */
function parseEras(specs) {
	const eras = [];
	for (const spec of specs) {
		const i = spec.lastIndexOf("=");
		const from = parseUtc(spec.slice(i + 1));
		if (i < 1 || from === null) return `--era ${spec} is not <label>=<utc>`;
		eras.push({ label: spec.slice(0, i), from });
	}
	return eras;
}

/** @returns {0 | 2} */
function main() {
	const parsed = parseOrCode(process.argv.slice(2), {
		usage: USAGE,
		flags: {
			"--since": "value",
			"--until": "value",
			"--era": "list",
			"--markers": "value",
			"--memwatch": "list",
			"--minute-log": "value",
			"--mem-total-mb": "value",
			"--load-ceiling": "value",
			"--cap-from": "value",
		},
	});
	if (typeof parsed === "number") return parsed;
	const { flags, lists } = parsed;
	const since = parseUtc(flagValue(flags, "--since"));
	const until = parseUtc(flagValue(flags, "--until"));
	if (since === null || until === null || since >= until)
		return refuse("--since and --until must each be a time, --since first");
	const eras = parseEras(lists["--era"] ?? []);
	if (typeof eras === "string") return refuse(eras);
	const given = flagValue(flags, "--markers");
	const exitLog = given ? null : queueExitLogPath(hostRoot());
	const markers = given ?? (exitLog && path.dirname(exitLog));
	if (!markers)
		return refuse("git names no canonical checkout; pass --markers");
	const capGiven = flagValue(flags, "--cap-from");
	const capFrom = capGiven === undefined ? null : parseUtc(capGiven);
	if (capFrom === null && capGiven !== undefined)
		return refuse(`--cap-from ${capGiven} is not a time`);
	const memTotal = flagValue(flags, "--mem-total-mb");
	const ceiling = flagValue(flags, "--load-ceiling");
	/** @type {import("./lib/suite-queue-replay").Window} */
	const w = {
		since,
		until,
		eras,
		memTotalMb: memTotal
			? Number(memTotal)
			: Math.floor(os.totalmem() / 1_048_576),
		loadCeiling: ceiling ? Number(ceiling) : loadCeiling(),
		...(capFrom === null ? {} : { capFrom }),
	};
	const logs = readLogs({
		markers,
		...memwatchLogs(flags, lists),
		since,
		until,
	});
	writeFd(1, `${render(replay(logs, w), w)}\n`);
	return 0;
}

module.exports = { main };

if (require.main === module) process.exitCode = main();
