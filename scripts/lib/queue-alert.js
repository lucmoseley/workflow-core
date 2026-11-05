/*
 * queue-alert.js — the landing queue's alert (#4485, spec #4458): once per
 * crossing of a limit lib/queue-gauge.js sets, the oldest waiting ref's wait
 * or the queue's depth, the refill loop files that crossing's ticket, as
 * lib/queue-issue.js files the stall ticket (#4443), and closes it once the
 * queue is back within the limit.
 *
 * ONCE PER CROSSING: a record in the markers directory names the crossings
 * already alerted, so a pass still past a limit files nothing and reads no
 * tracker, and a pass back within it closes the ticket and re-arms it. A
 * torn record reads as none alerted, so a crossing still standing is filed
 * again, which refreshes the open ticket.
 */

const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { formatHoursMin } = require("./landing-stall.js");
const { buildCrossingLines } = require("./queue-gauge.js");
const { queueIssueCloser, queueIssueFiler } = require("./queue-issue.js");

/**
 * @typedef {"age"|"depth"} Crossing
 * @typedef {Record<Crossing, boolean>} AlertRecord the crossings alerted
 */

const KINDS = /** @type {const} */ (["age", "depth"]);

const TITLES = {
	age: "Landing queue stalled: a queue ref has waited past its limit",
	depth: "Landing queue deep: more queue refs wait than its limit",
};

const RECORD = ".queue-alert.json";

/**
 * Which crossings fire and which re-arm, from the record and the crossings
 * standing now.
 * @param {AlertRecord} record
 * @param {AlertRecord} crossed
 * @returns {{fire: Crossing[], rearm: Crossing[]}}
 */
function alertStep(record, crossed) {
	return {
		fire: KINDS.filter((k) => crossed[k] && !record[k]),
		rearm: KINDS.filter((k) => !crossed[k] && record[k]),
	};
}

/**
 * @param {string} file
 * @returns {AlertRecord}
 */
function readAlertRecord(file) {
	try {
		const rec = JSON.parse(fs.readFileSync(file, "utf8"));
		return { age: rec.age === true, depth: rec.depth === true };
	} catch {
		/* Absent, or torn by a hand edit: none alerted. */
		return { age: false, depth: false };
	}
}

/**
 * @param {Crossing} kind
 * @param {string} line the crossing's line from buildCrossingLines
 * @param {import("./queue-gauge.js").QueueGauge} g
 */
const buildAlertBody = (kind, line, g) => `## What to build

${line} (#4485).

- Refs waiting: ${g.waiting.length > 0 ? g.waiting.map((w) => `\`queue/${w.name}\` since ${new Date(w.since).toISOString()}`).join(", ") : "none"}

${kind === "age" ? "The queue lander takes every waiting ref" : "Each ref waits for the queue lander"}; its runs log to \`.queue-log.jsonl\` in the checkout's markers directory, and \`node scripts/landing-status.js\` prints the queue's line.

## Acceptance criteria

- [ ] The cause is fixed, and the queue is back within its limit.
`;

/**
 * @param {Crossing} kind
 * @param {import("./queue-gauge.js").QueueGauge} g
 */
function buildRearmComment(kind, g) {
	const at = new Date(g.now).toISOString();
	if (kind === "depth")
		return `${g.waiting.length} queue refs wait at ${at}, within the limit again.`;
	const waited = g.waiting.map((w) => g.now - w.since);
	return waited.length === 0
		? `No queue ref waits at ${at}.`
		: `The oldest queue ref has waited ${formatHoursMin(Math.max(...waited))} at ${at}, within its limit again.`;
}

/**
 * One supervision pass's act on the queue's alerts. Each act's record is
 * written once it succeeds, so a filing or close that throws is retried on
 * the next pass.
 * @param {import("./queue-issue.js").QueueIssueDeps} deps
 * @param {string} markers the markers directory
 * @returns {(g: import("./queue-gauge.js").QueueGauge,
 *   c: import("./queue-gauge.js").QueueCrossings) => string[]} the lines
 *   naming what it did
 */
function queueAlertTender(deps, markers) {
	const file = queueIssueFiler(deps);
	const close = queueIssueCloser(deps);
	const recordFile = path.join(markers, RECORD);
	return (g, c) => {
		const record = readAlertRecord(recordFile);
		const lines = buildCrossingLines(c, g.baseline);
		const { fire, rearm } = alertStep(record, {
			age: c.age !== null,
			depth: c.depth !== null,
		});
		/** @type {string[]} */
		const said = [];
		const save = () =>
			writeFileAtomic(recordFile, `${JSON.stringify(record)}\n`, {
				mkdir: true,
			});
		for (const kind of fire) {
			said.push(
				file(
					{
						title: TITLES[kind],
						standalone:
							"The queue alert tracks the landing queue, not one ticket's work.",
						noun: "queue alert",
						subject: "the queue's crossing",
					},
					buildAlertBody(kind, lines[kind] ?? "", g),
				),
			);
			record[kind] = true;
			save();
		}
		for (const kind of rearm) {
			const closed = close(TITLES[kind], () => buildRearmComment(kind, g));
			if (closed !== null) said.push(`queue alert: closed #${closed}.`);
			record[kind] = false;
			save();
		}
		return said;
	};
}

module.exports = { QUEUE_ALERT_TITLES: TITLES, queueAlertTender };
