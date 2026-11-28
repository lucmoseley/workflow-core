// #5804

const TASKS = {
	on: "Verifier 5743 combining on",
	off: "Verifier 5743 combining off",
	dump: "Verifier 5743 live dump",
};
const HOLDER = "page-combining-trial";
const REPORT_ISSUE = 5743;
// guess, #5804: half the hold's 60-minute limit
const RENEW_MS = 30 * 60_000;
// guess, #5804
const POLL_MS = 10_000;
// guess, #5804
const TOGGLE_WAIT_MS = 5 * 60_000;
// guess, #5804: the dump task's own limit
const DUMP_WAIT_MS = 60 * 60_000;

/**
 * @typedef {"combining.log" | "dumps.log"} LogName
 * @typedef {{
 *   now: () => number,
 *   ended: () => boolean,
 *   readLog: (name: LogName) => string,
 *   startTask: (name: string) => string | null,
 *   sleep: (ms: number) => void,
 *   hold: () => string | null,
 *   release: () => string | null,
 *   scan: (dump: string, combining: string) => string | null,
 *   post: (body: string) => string | null,
 *   say: (line: string) => void,
 * }} Ports
 */

/** @param {string} text */
const logLines = (text) =>
	text
		.replace(/^﻿/, "")
		.split(/\r?\n/)
		.filter((l) => l.trim() !== "");

/**
 * @param {Ports} ports
 * @param {{task: string, log: LogName, waitMs: number, renew?: boolean}} what
 * @returns {string | null}
 */
function act(ports, { task, log, waitMs, renew = false }) {
	const before = logLines(ports.readLog(log)).length;
	const err = ports.startTask(task);
	if (err !== null) {
		ports.say(`could not start '${task}': ${err}`);
		return null;
	}
	const deadline = ports.now() + waitMs;
	let renewAt = ports.now() + RENEW_MS;
	for (;;) {
		const lines = logLines(ports.readLog(log));
		if (lines.length > before) return lines.at(-1) ?? null;
		if (ports.now() >= deadline) {
			ports.say(`'${task}' wrote nothing to ${log} in ${waitMs / 60_000} min`);
			return null;
		}
		ports.sleep(POLL_MS);
		if (renew && ports.now() >= renewAt) {
			renewAt = ports.now() + RENEW_MS;
			const renewed = ports.hold();
			if (renewed !== null) ports.say(`hold renewal failed: ${renewed}`);
		}
	}
}

/**
 * @param {Ports} ports
 * @returns {number}
 */
function runNight(ports) {
	if (ports.ended()) {
		ports.say("the Verifier pass has ended (ended.txt); combining stays off");
		return 0;
	}
	const line = act(ports, {
		task: TASKS.on,
		log: "combining.log",
		waitMs: TOGGLE_WAIT_MS,
	});
	if (line === null || !/ on PageCombining=True\b/.test(line)) {
		ports.say(`combining did not turn on: ${line ?? "no log line"}`);
		return 1;
	}
	ports.say(line);
	return 0;
}

/**
 * @param {Ports} ports
 * @param {string} last
 * @param {string | null} dumped
 * @param {string | null} off
 * @returns {string[]}
 */
function scanAndListProblems(ports, last, dumped, off) {
	const combining = `last combining.log line before the dump: \`${last}\``;
	/** @type {string[]} */
	const problems = [];
	if (off === null || !/ off PageCombining=False\b/.test(off))
		problems.push(
			`**Page combining did not turn off**: \`${off ?? "no log line"}\`. Start it by hand: \`schtasks.exe /Run /TN "${TASKS.off}"\`.`,
		);
	const path = dumped && / ok path=(\S.*?) bytes=\d+$/.exec(dumped)?.[1];
	if (!path) {
		problems.push(
			`**No live dump this morning**: \`${dumped ?? "no log line"}\` (${combining}).`,
		);
		return problems;
	}
	const err = ports.scan(path, combining);
	if (err !== null)
		problems.push(`**The PFN scan of \`${path}\` failed**: ${err}`);
	return problems;
}

/**
 * @param {Ports} ports
 * @returns {number}
 */
function runMorning(ports) {
	const last = logLines(ports.readLog("combining.log")).at(-1) ?? "none";
	const wasOn = / on PageCombining=True\b/.test(last);
	if (wasOn) {
		const held = ports.hold();
		if (held !== null) ports.say(`launches not held: ${held}`);
	}
	const dumped = act(ports, {
		task: TASKS.dump,
		log: "dumps.log",
		waitMs: DUMP_WAIT_MS,
		renew: wasOn,
	});
	const off = act(ports, {
		task: TASKS.off,
		log: "combining.log",
		waitMs: TOGGLE_WAIT_MS,
		renew: wasOn,
	});
	if (wasOn) ports.release();
	const problems = scanAndListProblems(ports, last, dumped, off);
	for (const p of problems) {
		ports.say(p);
		const err = ports.post(`${p} (#5804's morning run)`);
		if (err !== null) ports.say(`could not post on #${REPORT_ISSUE}: ${err}`);
	}
	return problems.length === 0 ? 0 : 1;
}

module.exports = {
	HOLDER,
	REPORT_ISSUE,
	runMorning,
	runNight,
};
