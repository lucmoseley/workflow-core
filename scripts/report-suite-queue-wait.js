#!/usr/bin/env node

const path = require("node:path");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");
const { logError } = require("./lib/arbiter-core");
const { errMessage, now } = require("./lib/check");
const { parseOrExit } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root");
const { periodicReading, buildSkipLine } = require("./lib/periodic-reading");
const { isCoreHost } = require("./lib/plugin-state");
const { qualifyProse } = require("./lib/qualify-citations");
const { queueExitLogPath } = require("./lib/queue-exit-log");
const { fileOrRefresh, findTrackingIssue } = require("./lib/tracking-issue");
const {
	buildCommandUndeclaredLine,
	readCommandFor,
} = require("./lib/workflow-core-config");
const { caught } = require("./lib/caught.js");
const { readJsonl } = require("./lib/jsonl.js");
const { takesLabel } = require("./lib/takes-label");

const USAGE = `usage: node ${scriptPath("report-suite-queue-wait.js")} [--dry-run]\n  --dry-run  read now, whatever the stamp says; print the reading and file nothing`;

const TITLE = "Suite queue wait is over its daily limit";
const LABEL = takesLabel("wayfinder");
const LIMIT_H = 2;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// guess, workflow-core#1157
const SERIES_DAYS = 14;
const TOP_SESSIONS = 5;
const KINDS = ["bare", "changed", "full", "named", "other", "seat"];
const STAMP = ".suite-queue-wait-read";
const LOCK = ".suite-queue-wait-read.lock";
const WHERE = "report-suite-queue-wait";

const HOST_TEXT = {
	core: {
		ruling: "a ruling, which the session that takes this issue may make",
		questions: [
			"This issue is the route back for the fog the queue-wait map left deferred (workflow-core#1152):",
			"",
			"- Is the alarm false? If so, re-rule the limit (workflow-core#1157 Q6).",
			"- A suite growth budget: a priced cost per added test file or guard.",
			"- Hub fan-out: whether runs touching `scripts/session-arbiter.js`, `.husky/pre-commit`, `.claude/settings.json` or `docs/doc-map.md` still go heavy.",
			"- A per-session run cap (workflow-core#1153 Q3).",
		],
		finish: (/** @type {string} */ body) => body,
	},
	adopter: {
		ruling: "a ruling filed in workflow-core",
		questions: [
			"Take this with this repo's own `/wayfinder`. The queue and its limit are workflow-core's, so an answer that changes either is filed there; its own queue-wait map left the same fog deferred (workflow-core#1152):",
			"",
			"- Is the alarm false? (workflow-core#1157 Q6)",
			"- A suite growth budget: a priced cost per added test file or guard.",
			"- Hub fan-out: whether runs touching this repo's most-imported files still go heavy.",
			"- A per-session run cap (workflow-core#1153 Q3).",
		],
		finish: qualifyProse,
	},
};

/**
 * @typedef {{ at: string, waitS: number, reason: string, kind: string,
 *   session: string | null, empty: boolean, skipped?: boolean,
 *   joined?: { pid: number, session: string | null } }} QueueExit
 * @typedef {{ runs: number, waits: number, waitS: number }} Tally
 */

/**
 * @param {string} file
 * @returns {{ exits: QueueExit[], unparsed: number }}
 */
function readExits(file) {
	let read;
	try {
		read = readJsonl(file);
	} catch (e) {
		const { code, message } = caught(e);
		throw new Error(`${file} will not read — ${code || message}`, {
			cause: e,
		});
	}
	if (!read) return { exits: [], unparsed: 0 };
	const exits = /** @type {QueueExit[]} */ (
		read.rows.filter(
			(row) =>
				!Number.isNaN(Date.parse(String(row.at))) && Number.isFinite(row.waitS),
		)
	);
	return {
		exits,
		unparsed: read.bad.length + read.rows.length - exits.length,
	};
}

/**
 * @param {QueueExit} exit
 * @param {number} from
 * @param {number} to
 */
function waitWithin(exit, from, to) {
	const end = Date.parse(exit.at);
	const start = end - exit.waitS * 1000;
	return Math.max(0, Math.min(end, to) - Math.max(start, from)) / 1000;
}

/**
 * @param {QueueExit[]} exits
 * @param {number} from
 * @param {number} to
 * @param {(e: QueueExit) => string} groupOf
 * @returns {Map<string, Tally>}
 */
function tally(exits, from, to, groupOf) {
	/** @type {Map<string, Tally>} */
	const groups = new Map();
	for (const e of exits) {
		const end = Date.parse(e.at);
		if (end < from || end - e.waitS * 1000 >= to) continue;
		const s = waitWithin(e, from, to);
		const g = groups.get(groupOf(e)) ?? { runs: 0, waits: 0, waitS: 0 };
		g.waits++;
		if (e.joined === undefined) g.runs++;
		g.waitS += s;
		groups.set(groupOf(e), g);
	}
	return groups;
}

/**
 * @param {QueueExit[]} exits
 * @param {number} from
 * @param {number} to
 * @param {(e: QueueExit) => boolean} [keep]
 * @returns {Tally}
 */
const total = (exits, from, to, keep = () => true) =>
	tally(exits.filter(keep), from, to, () => "").get("") ?? {
		runs: 0,
		waits: 0,
		waitS: 0,
	};

/** @param {number} s */
const hours = (s) => (s / 3600).toFixed(1);

/** @param {number} t */
const minute = (t) =>
	`${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * @param {QueueExit[]} logged
 * @param {number} nowMs
 * @param {number} unparsed
 * @param {boolean} core
 * @returns {{ waitS: number, body: string }}
 */
function reading(logged, nowMs, unparsed, core) {
	const host = HOST_TEXT[core ? "core" : "adopter"];
	const from = nowMs - DAY_MS;
	const skipped = total(logged, from, nowMs, (e) => e.skipped === true);
	const exits = logged.filter((e) => e.skipped !== true);
	const all = total(exits, from, nowMs);
	const none = total([], from, nowMs);
	const row = (/** @type {string} */ label, /** @type {Tally} */ t) =>
		`| ${label} | ${t.runs} | ${hours(t.waitS)} |`;

	const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
	const series = [];
	for (let i = SERIES_DAYS - 1; i >= 0; i--) {
		const day = today - i * DAY_MS;
		const t = total(exits, day, Math.min(day + DAY_MS, nowMs));
		const date = new Date(day).toISOString().slice(0, 10);
		series.push(row(i ? date : `${date} (to now)`, t));
	}

	const byKind = tally(exits, from, nowMs, (e) => e.kind);
	const bySession = [
		...tally(exits, from, nowMs, (e) => e.session ?? "(no session)"),
	]
		.sort((a, b) => b[1].waitS - a[1].waitS)
		.slice(0, TOP_SESSIONS);
	const empty = total(exits, from, nowMs, (e) => e.empty === true);
	const killed = total(exits, from, nowMs, (e) => e.reason === "killed");
	const joined = total(exits, from, nowMs, (e) => e.joined !== undefined);

	const body = [
		`**${hours(all.waitS)} h** of suite queue wait in the 24 h to ${minute(nowMs)}, over ${all.runs} queued run(s). The limit is ${LIMIT_H} h, fixed in hours: it changes only by ${host.ruling} (workflow-core#1157 Q5, Q6).`,
		"",
		`${joined.waits} more wait(s) joined a queued same-key \`tsc\` run rather than queue their own, ${hours(joined.waitS)} h of that wait (workflow-core#5639).`,
		"",
		"Read from `.suite-queue-exits.jsonl` by `scripts/report-suite-queue-wait.js` (workflow-core#1219), at most hourly at session start. While this issue is open, each reading at or over the limit refreshes this body; once it is closed, only a 24 h window starting after the close files it again.",
		...(unparsed
			? ["", `${unparsed} log line(s) would not parse and are not counted.`]
			: []),
		"",
		"Each run's wait is counted only where it falls inside the window or day.",
		"",
		...(core
			? [
					`What held each wait — the count cap, the memory rung, the FIFO turn, the load hold — and who held the whole-suite slot: \`node ${scriptPath("replay-suite-queue-wait.js")} --since ${new Date(from).toISOString()} --until ${new Date(nowMs).toISOString()}\`, adding \`--era <label>=<utc>\` at each change to the gate that landed in the window (workflow-core#3060).`,
					"",
				]
			: []),
		`## Daily wait, last ${SERIES_DAYS} days (UTC)`,
		"",
		"| Day | Runs | Wait (h) |",
		"| --- | --- | --- |",
		...series,
		"",
		"## Last 24 h by run kind",
		"",
		"| Kind | Runs | Wait (h) |",
		"| --- | --- | --- |",
		...KINDS.map((k) => row(`\`${k}\``, byKind.get(k) ?? none)),
		...[...byKind]
			.filter(([k]) => !KINDS.includes(k))
			.map(([k, t]) => row(`\`${k}\``, t)),
		"",
		`## The ${TOP_SESSIONS} launching sessions with most wait, last 24 h`,
		"",
		"| Session | Runs | Wait (h) |",
		"| --- | --- | --- |",
		...bySession.map(([s, t]) => row(`\`${s}\``, t)),
		"",
		"## Waits that found nothing to test, last 24 h",
		"",
		`${empty.runs} run(s) left the queue with an empty selection, after ${hours(empty.waitS)} h of wait. ${skipped.runs} more skipped it at once, their own work reaching no test file (workflow-core#1221).`,
		"",
		"## Killed waits, last 24 h",
		"",
		`${killed.waits} wait(s) ended by a signal, after ${hours(killed.waitS)} h of wait.`,
		"",
		"## Candidate questions",
		"",
		...host.questions,
	].join("\n");
	return { waitS: all.waitS, body: host.finish(body) };
}

/**
 * @param {string} logFile
 * @param {number} nowMs
 * @param {boolean} dryRun
 * @param {boolean} core
 * @returns {string}
 */
function readAndFile(logFile, nowMs, dryRun, core) {
	const { exits, unparsed } = readExits(logFile);
	const { waitS, body } = reading(exits, nowMs, unparsed, core);
	const figure = `${hours(waitS)} h of queue wait in the last 24 h, against the ${LIMIT_H} h limit`;
	if (dryRun) return `${body}\n\nDry run: ${figure}; nothing filed.`;
	if (waitS < LIMIT_H * 3600) return `${figure}; nothing filed.`;
	const latest = findTrackingIssue({ title: TITLE }, "all");
	const closed = latest?.closedAt ? Date.parse(latest.closedAt) : null;
	if (closed !== null && closed > nowMs - DAY_MS)
		return `${figure}, but "${TITLE}" was closed at ${minute(closed)}, inside this window; it files again once a window starts after that.`;
	return `${figure}. ${fileOrRefresh({ title: TITLE, labels: [LABEL], body })}`;
}

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: { "--dry-run": "boolean" },
	});
	const dryRun = "--dry-run" in flags;
	try {
		if (readCommandFor("test") === null) {
			writeFd(2, `SKIP: ${buildCommandUndeclaredLine("test")}\n`);
			return;
		}
		const core = isCoreHost(hostRoot());
		const logFile = queueExitLogPath(hostRoot());
		if (!logFile) throw new Error("git names no canonical checkout");
		const nowMs = now();
		if (dryRun) {
			writeFd(1, `${readAndFile(logFile, nowMs, true, core)}\n`);
			return;
		}
		const dir = path.dirname(logFile);
		const gate = periodicReading(
			{
				stamp: path.join(dir, STAMP),
				lock: path.join(dir, LOCK),
				script: path.basename(__filename),
				nowMs,
				everyMs: HOUR_MS,
			},
			() => readAndFile(logFile, nowMs, false, core),
		);
		writeFd(1, `${gate.ran ? gate.value : buildSkipLine(gate, "an hour")}\n`);
	} catch (e) {
		logError(WHERE, e);
		writeFd(
			2,
			`FAILED OPEN: ${errMessage(e)} — recorded in the guard-error log; the next hourly reading retries.\n`,
		);
	}
}

if (require.main === module) main();
