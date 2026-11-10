/*
 * queue-tickets.js — the refill loop's landing-queue tickets: their fixed
 * titles, by which lib/queue-issue.js finds the open one and
 * lib/queue-wait-alarm.js names it. A leaf, so the off-machine alarm loads no
 * tracker; the record each keeps is lib/record-ticket.js's (#4485, spec #4458).
 */

/* `main` stood past lib/landing-stall.js's STALL_MS (lib/stall-ticket.js). */
const STALL_TITLE = "Landing queue stalled: main has not moved for 2 h";

/* An off-machine queue alarm red at `main`'s sha (lib/alarm-ticket.js). */
const ALARM_TITLE =
	"Landing alarm red: an off-machine queue alarm failed since main last moved";

/* A queue limit crossed (lib/queue-alert.js). */
const QUEUE_ALERT_TITLES = {
	age: "Landing queue slow: a queue ref has waited past its limit",
	depth: "Landing queue deep: more queue refs wait than its limit",
};

module.exports = {
	ALARM_TITLE,
	QUEUE_ALERT_TITLES,
	STALL_TITLE,
};
