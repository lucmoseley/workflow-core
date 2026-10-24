/*
 * The tracker-wide `gh issue list` ceiling, alone in a module so that a caller
 * can hold it without loading lib/gh.js.
 *
 * WHY IT IS NOT IN lib/gh.js WITH THE REST (mantahostels#2512). gh.js requires lib/check.js
 * for skipError/brokenError, and check.js's module body installs
 * `process.on("uncaughtException")` handlers ending in `process.exit`.
 * lib/arbiter-debts.js runs inside the session arbiter, called from hooks, and
 * must never hand a hook's process an exit of its own.
 *
 * `assertWholeTracker` stayed behind because it throws a check.js error class by
 * design — see its docstring there.
 */

/*
 * The ceiling every full-tracker `gh issue list` passes to --limit. gh returns
 * at most this many rows and says nothing about the ones it dropped, so a
 * tracker that reaches the ceiling silently narrows every check to a subset of
 * itself.
 *
 * Set BELOW what gh.js's MAX_BUFFER carries (~23,500 issues, measured in its
 * comment), so the check that fires first is this one, which names what to
 * raise, rather than an ENOBUFS. That ordering holds only while the mean issue
 * stays under ~12.8 KiB; above it this guard goes silent, since it can fire
 * only after the response has already fit. A limit larger than the tracker
 * costs nothing: gh stops at the last issue, not at the ceiling.
 */
const ISSUE_LIST_LIMIT = 20_000;

module.exports = { ISSUE_LIST_LIMIT };
