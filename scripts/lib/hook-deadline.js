// measured 12 s at Stop, workflow-core#4115
const ENTRY_BUDGET_MS = { PreToolUse: 30_000, PostToolUse: 7500, Stop: 12_000 };

/** @type {number | null} */
let startedAt = null;
let budget = 0;

/**
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

const entryStartedAt = () => startedAt;

/**
 * @param {number} cap
 * @param {number} [now]
 * @returns {number}
 */
const budgetMs = (cap, now = Date.now()) =>
	startedAt === null
		? cap
		: Math.max(1, Math.min(cap, Math.floor(budget - (now - startedAt))));

/**
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
