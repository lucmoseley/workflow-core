/*
 * hook-deadline.js — the timeout an adapter of the PreToolUse dispatcher may
 * still spend (#2792). Every core runs in the entry's one process, so the
 * entry starts the clock at the process's own start: an adapter capped here
 * ends its read before the registration's 10 s timeout however many cores
 * read before it, where the harness's kill would reach `"onFailure": "block"`
 * and refuse the call. Unstarted, as in a test calling a core in process, the
 * cap stands alone.
 */

/* 2 s under the registration's `"timeout": 10`, for the output write. */
const ENTRY_BUDGET_MS = 8000;

/** @type {number | null} */
let startedAt = null;

/** The entry's clock, started where node started. */
function startEntryClock(now = Date.now()) {
	startedAt = now - process.uptime() * 1000;
}

/**
 * `cap`, or what is left of the entry's budget where that is less. At least
 * 1 ms, since a timeout of 0 means none to child_process: a read started past
 * the budget times out at once.
 * @param {number} cap
 * @param {number} [now]
 * @returns {number}
 */
const budgetMs = (cap, now = Date.now()) =>
	startedAt === null
		? cap
		: Math.max(
				1,
				Math.min(cap, Math.floor(ENTRY_BUDGET_MS - (now - startedAt))),
			);

module.exports = { budgetMs, ENTRY_BUDGET_MS, startEntryClock };
