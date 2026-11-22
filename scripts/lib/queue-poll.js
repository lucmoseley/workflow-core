/*
 * queue-poll.js — how often a queued waiter re-reads the gate, apart from
 * lib/suite-queue.js so a reader the gate requires, such as
 * lib/part-suite-ledger.js's cache, can size itself on it without a cycle.
 *
 * The 10 s poll is a guess, set when the queue was built (mantahostels#2024)
 * and never measured.
 */
const QUEUE_POLL_MS = 10_000;

module.exports = { QUEUE_POLL_MS };
