/*
 * queue-alert.js — the landing queue's alert: for a crossing of a limit
 * lib/queue-gauge.js sets, the oldest waiting ref's wait or the queue's
 * depth, the refill loop files that crossing's ticket, as lib/queue-issue.js
 * files the stall ticket, and closes it once the queue is back within the
 * limit (#4485, spec #4458).
 *
 * ONCE PER CROSSING: a record in the markers directory names the crossings
 * already alerted, so a pass still past a limit files nothing and reads no
 * tracker, and a pass back within it closes the ticket and re-arms it. A
 * torn record is named and dropped, and reads as none alerted, so a crossing
 * still standing is filed again, which refreshes the open ticket.
 */

const path = require("node:path");
const { scriptPath } = require("./script-path.js");
const { buildCrossingLines, formatHoursMin } = require("./queue-gauge.js");
const { QUEUE_ALERT_TITLES: TITLES } = require("./queue-tickets.js");
const { recordTicket } = require("./record-ticket.js");

/**
 * @typedef {"age"|"depth"} Crossing
 * @typedef {Record<Crossing, boolean>} AlertRecord the crossings alerted
 */

const KINDS = /** @type {const} */ (["age", "depth"]);

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

/** @param {unknown} rec @returns {AlertRecord|null} */
function parseAlertRecord(rec) {
	const { age, depth } = /** @type {{age?: unknown, depth?: unknown}} */ (
		rec ?? {}
	);
	return typeof age === "boolean" && typeof depth === "boolean"
		? { age, depth }
		: null;
}

/**
 * @param {Crossing} kind
 * @param {string} line the crossing's line from buildCrossingLines
 * @param {import("./queue-gauge.js").QueueGauge} g
 */
const buildAlertBody = (kind, line, g) => `## What to build

${line}.

- Refs waiting: ${g.waiting.length > 0 ? g.waiting.map((w) => `\`queue/${w.name}\` since ${new Date(w.since).toISOString()}`).join(", ") : "none"}

${kind === "age" ? "The queue lander takes every waiting ref" : "Each ref waits for the queue lander"}; its runs log to \`.queue-log.jsonl\` in the checkout's markers directory, and \`node ${scriptPath("landing-status.js")}\` prints the queue's line.

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
	const ticket = recordTicket(deps, {
		record: path.join(markers, RECORD),
		parse: parseAlertRecord,
		noun: "queue alert",
		subject: "the queue's crossing",
		/* Fail-open (#4485), as the stall ticket's record: a crossing still standing
		 * is filed again, and a ticket open over a queue back within its
		 * limit stays open until its next crossing. */
		tornNote: "; an open queue alert stays open until its next crossing",
	});
	return (g, c) => {
		/** @type {string[]} */
		const said = [];
		const read = ticket.read(said);
		let record =
			read === null || read === "torn" ? { age: false, depth: false } : read;
		const lines = buildCrossingLines(c, g.baseline);
		const { fire, rearm } = alertStep(record, {
			age: c.age !== null,
			depth: c.depth !== null,
		});
		for (const kind of fire) {
			record = { ...record, [kind]: true };
			ticket.file(
				TITLES[kind],
				buildAlertBody(kind, lines[kind] ?? "", g),
				record,
				said,
			);
		}
		for (const kind of rearm) {
			record = { ...record, [kind]: false };
			ticket.close(
				TITLES[kind],
				() => buildRearmComment(kind, g),
				record,
				said,
			);
		}
		return said;
	};
}

module.exports = { queueAlertTender };
