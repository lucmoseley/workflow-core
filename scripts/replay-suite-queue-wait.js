#!/usr/bin/env node
/*
 * replay-suite-queue-wait.js — the command line of lib/suite-queue-replay.js
 * (workflow-core#3060): what held each queued test run over a window, for a firing of the
 * queue-wait alarm to answer by limb. The alarm's issue body prints the
 * command over its own window.
 *
 * IN NO FAMILY (code-standards §N3, §G4): it files nothing and gates nothing;
 * it prints a reading on demand and exits 0, or 2 on a bad argument.
 */

const os = require("node:os");
const path = require("node:path");
const { flagValue, parseOrCode } = require("./lib/cli-args");
const { loadCeiling } = require("./lib/cpu-sample");
const { hostRoot } = require("./lib/host-root");
const { queueExitLogPath } = require("./lib/queue-exit-log");
const { readLogs, render, replay } = require("./lib/suite-queue-replay");
const { writeFd } = require("./lib/write-fd");

const USAGE = `usage: node scripts/replay-suite-queue-wait.js --since <utc> --until <utc> [options]
  --since, --until   the window, ISO UTC; --until is the alarm's reading time
  --era <label>=<utc>   split the limbs where a change to the gate landed in
                     the window, at its commit time; repeatable
  --markers <dir>    the marker stores (default: the canonical checkout's)
  --memwatch <file>  a memwatch log, local time; repeatable (default:
                     ~/memwatch-archive.log and ~/memwatch.log)
  --mem-total-mb <n> MemTotal the memwatch \`used\` is taken from (default: this machine's)
  --load-ceiling <n> the load1 hold (default: this machine's)`;

/**
 * @param {string | undefined} s
 * @returns {number | null} null where `s` is no time
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
			"--mem-total-mb": "value",
			"--load-ceiling": "value",
		},
	});
	if (typeof parsed === "number") return parsed;
	const { flags, lists } = parsed;
	const since = parseUtc(flagValue(flags, "--since"));
	const until = parseUtc(flagValue(flags, "--until"));
	if (since === null || until === null || since >= until)
		return refuse("--since and --until must each be a time, --since first");
	const eras = [];
	for (const spec of lists["--era"] ?? []) {
		const i = spec.lastIndexOf("=");
		const from = parseUtc(spec.slice(i + 1));
		if (i < 1 || from === null)
			return refuse(`--era ${spec} is not <label>=<utc>`);
		eras.push({ label: spec.slice(0, i), from });
	}
	const given = flagValue(flags, "--markers");
	const exitLog = given ? null : queueExitLogPath(hostRoot());
	const markers = given ?? (exitLog && path.dirname(exitLog));
	if (!markers)
		return refuse("git names no canonical checkout; pass --markers");
	const memwatch = lists["--memwatch"] ?? [
		path.join(os.homedir(), "memwatch-archive.log"),
		path.join(os.homedir(), "memwatch.log"),
	];
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
	};
	const logs = readLogs({ markers, memwatch, since, until });
	writeFd(1, `${render(replay(logs, w), w)}\n`);
	return 0;
}

module.exports = { main };

if (require.main === module) process.exitCode = main();
