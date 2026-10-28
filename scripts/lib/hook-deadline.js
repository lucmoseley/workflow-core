/*
 * hook-deadline.js — the timeout a spawn in the dispatcher's process may still
 * spend (#2792). Every core runs in the entry's one process, so the entry
 * starts the clock at the process's own start, and lib/git.js and lib/gh.js
 * cut every git and gh call to what is left: a read ends inside the budget
 * however many cores read before it, where the harness's kill at the
 * registration's timeout would refuse a PreToolUse call unexplained through
 * `"onFailure": "block"`. Unstarted, as in a test calling a core in process
 * or a hook of its own, the cap stands alone.
 */

/* Half each dispatcher registration's timeout (self-plugin/hooks/hooks.json):
 * the reads end by then, and the other half holds node's start, the work
 * between reads and the output write. At PreToolUse it also holds the 20 s
 * npm-install's last registry call may run past that core's own 30 s budget,
 * which runs from the same start (lib/npm-install.js). */
const ENTRY_BUDGET_MS = { PreToolUse: 30_000, PostToolUse: 7500 };

/** @type {number | null} */
let startedAt = null;
let budget = 0;

/**
 * The entry's clock, started where node started, with `event`'s budget; an
 * event with none leaves it unstarted.
 * @param {string} event
 * @param {number} [now]
 */
function startEntryClock(event, now = Date.now()) {
	const own =
		ENTRY_BUDGET_MS[/** @type {keyof typeof ENTRY_BUDGET_MS} */ (event)];
	if (own === undefined) return;
	startedAt = now - process.uptime() * 1000;
	budget = own;
}

/** When the entry's clock started, null where it never did. */
const entryStartedAt = () => startedAt;

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
		: Math.max(1, Math.min(cap, Math.floor(budget - (now - startedAt))));

/**
 * A spawn's `timeout`, 0 for none, cut by budgetMs: what lib/git.js and
 * lib/gh.js hand child_process.
 * @param {number} [ms]
 */
const spawnTimeout = (ms) => {
	const cut = budgetMs(ms || Number.POSITIVE_INFINITY);
	return Number.isFinite(cut) ? cut : 0;
};

module.exports = {
	budgetMs,
	ENTRY_BUDGET_MS,
	entryStartedAt,
	spawnTimeout,
	startEntryClock,
};
