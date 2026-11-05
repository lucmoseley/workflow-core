/*
 * queue-tickets.js — the refill loop's landing-queue tickets: their fixed
 * titles, by which lib/queue-issue.js finds the open one and
 * main-lag-alarm.js names it, and the read of the record each keeps in the
 * markers directory. A leaf, so the off-machine alarm loads no tracker.
 */

const fs = require("node:fs");

/* `main` stood past lib/landing-stall.js's STALL_MS (lib/stall-ticket.js). */
const STALL_TITLE = "Landing queue stalled: main has not moved for 2 h";

/* A queue limit crossed (lib/queue-alert.js). */
const QUEUE_ALERT_TITLES = {
	age: "Landing queue slow: a queue ref has waited past its limit",
	depth: "Landing queue deep: more queue refs wait than its limit",
};

/**
 * A ticket's record: null where none is, "torn" where `parse` finds none in
 * it or it will not parse. A read failing for any reason but absence throws.
 * @template T
 * @param {string} file
 * @param {(rec: unknown) => T|null} parse null where the record is torn
 * @returns {T|null|"torn"}
 */
function readTicketRecord(file, parse) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (/** @type {{code?: unknown}} */ (e).code === "ENOENT") return null;
		throw e;
	}
	try {
		return parse(JSON.parse(text)) ?? "torn";
	} catch {
		/* Torn by a hand edit: the caller names it and drops it (#4485). */
		return "torn";
	}
}

module.exports = { QUEUE_ALERT_TITLES, STALL_TITLE, readTicketRecord };
