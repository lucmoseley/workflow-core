/*
 * clock.js — the one clock every program reads, apart from lib/check.js so a
 * hook reads it without loading check.js and its git libraries (#5151).
 * lib/check.js re-exports it.
 */

/**
 * The wall clock, injectable through WFC_NOW so a check's tests do not depend
 * on the time of day or the calendar date they happen to run at (mantahostels#2176, mantahostels#2209).
 *
 * A malformed value throws rather than falling back to the wall clock: silent
 * fallback would turn a typo'd test clock into a report that passes or fails by
 * time of day.
 *
 * RESIDUAL: the variable is process-wide, so an unrelated session exporting
 * WFC_NOW skews or silences any DURABLE stamp a caller writes off this clock,
 * not just its in-test reading (mantahostels#2161). A caller that persists a timestamp
 * inherits that and should say so at its own call site.
 *
 * A guard core passes its injected `ctx.env`, never the process's (#3566).
 *
 * @type {(env?: Record<string, string | undefined>) => number}
 */
const now = (env = process.env) => {
	const raw = env.WFC_NOW;
	if (!raw) return Date.now();
	const t = Date.parse(raw);
	if (Number.isNaN(t)) throw new Error(`WFC_NOW is not a date: ${raw}`);
	return t;
};

module.exports = { now };
