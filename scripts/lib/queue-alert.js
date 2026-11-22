const path = require("node:path");
const { scriptPath } = require("./script-path.js");
const { queueBranch } = require("./landing-refs.js");
const { buildCrossingLines, formatHoursMin } = require("./queue-gauge.js");
const { QUEUE_ALERT_TITLES: TITLES } = require("./queue-tickets.js");
const { recordTicket } = require("./record-ticket.js");

/**
 * @typedef {"age"|"depth"} Crossing
 * @typedef {Record<Crossing, boolean>} AlertRecord
 */

const KINDS = /** @type {const} */ (["age", "depth"]);

const RECORD = ".queue-alert.json";

const CRITERION = "The cause is fixed, and the queue is back within its limit.";

/**
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
 * @param {string} line
 * @param {import("./queue-gauge.js").QueueGauge} g
 */
const buildAlertBody = (kind, line, g) => `## What to build

${line}.

- Refs waiting: ${g.waiting.length > 0 ? g.waiting.map((w) => `\`${queueBranch(w.name)}\` since ${new Date(w.since).toISOString()}`).join(", ") : "none"}

${kind === "age" ? "The queue lander takes every waiting ref" : "Each ref waits for the queue lander"}; its runs log to \`.queue-log.jsonl\` in the checkout's markers directory, and \`node ${scriptPath("landing-status.js")}\` prints the queue's line.

## Acceptance criteria

- [ ] ${CRITERION}
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
 * @param {import("./queue-issue.js").QueueIssueDeps} deps
 * @param {string} markers
 * @returns {(g: import("./queue-gauge.js").QueueGauge,
 *   c: import("./queue-gauge.js").QueueCrossings) => string[]}
 */
function queueAlertTender(deps, markers) {
	const ticket = recordTicket(deps, {
		record: path.join(markers, RECORD),
		parse: parseAlertRecord,
		noun: "queue alert",
		subject: "the queue's crossing",
		criterion: CRITERION,
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
