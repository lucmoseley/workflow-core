/*
 * context-budget-tags.js — the tags check-context-budget.js raises, in the one
 * place the checker and the direction gate both read (mantahostels#1938). Every one but
 * DEAD_LATCH marks a breached cap; OVER_CAP_TAGS below is what the gate reads,
 * and membership of it is the difference.
 *
 * THE WIRE SPELLING IS PINNED ELSEWHERE, deliberately: raiser and gate move
 * together, so a rename here breaks neither. What catches one is
 * check-context-budget.test.ts's literal `"OVER-POOL"` and `"OVER-INJECTION"`
 * assertions, and check-context-budget-session-cap.test.ts's `"OVER-SESSION"`,
 * `"OVER-RATCHET"` and `"OVER-FRAGMENT"` ones, the only remaining statement of
 * what a reader of the envelope will actually see. Do not tidy them into
 * imports of this file.
 * lib/fault-diff.test.ts spells the tags a third time, inside its `capped`
 * helper, and is not one of these: it is a unit test of that library, and
 * deliberately duplicates a profile-shaped object by hand.
 *
 * Constants only, and no requires: check-context-budget.js runs on the
 * SessionStart hook, where a module pulled in behind two strings is a cost
 * every session pays.
 */

/** The always-loaded pool is at or over docs/doc-map.md §Capture and placement §4's cap. */
const OVER_POOL = "OVER-POOL";

/** The injected tracker docs are at or over their own cap, the same way. */
const OVER_INJECTION = "OVER-INJECTION";

/** The route (f) bytes one SESSION can be made to pay through a PreToolUse
 * tool are at or over its cap (mantahostels#2004 per event; mantahostels#2046 re-based it on the
 * session, which is the unit the injection latch actually charges). */
const OVER_SESSION = "OVER-SESSION";

/**
 * The reachable `injectRules` delivery, unioned across every PreToolUse trigger rather
 * than taken per tool, is at or over route (f)'s second, shared-ratchet axis
 * (mantahostels#1720, seeded at mantahostels#1787).
 */
const OVER_RATCHET = "OVER-RATCHET";

/**
 * A rule fragment reachable by a wired guard is over RULE_CAP on its own —
 * it can never be emitted, and refuses the call it leads outright. The repo's
 * own text, not the checker's apparatus (mantahostels#2054).
 */
const OVER_FRAGMENT = "OVER-FRAGMENT";

/**
 * A `ctx.told("<id>")` in a wired guard that bounds nothing — the id resolves
 * to no fragment, or the same guard makes no direct accessor call on it. The
 * latch is stranded and the census would otherwise report the fragment bounded
 * (mantahostels#2283).
 *
 * WHAT A LATCH MAY LEGITIMATELY BOUND is a store fragment OR text the guard
 * composes itself, `ctx.told` serving both (mantahostels#2275). Only the first can
 * be checked by resolving the id, so a guard reaching the store by neither a
 * direct accessor call nor `injectRules` is judged on its `latchAfter` alone —
 * the one pairing a self-composing latch can misspell (mantahostels#2446).
 *
 * DELIBERATELY OUTSIDE OVER_CAP_TAGS below: no cap is breached, no figure
 * moves, and the direction gate has nothing to compare. It reports.
 */
const DEAD_LATCH = "DEAD-LATCH";

/**
 * A `trigger` ledger entry whose ticket has closed while its rule is still in
 * the pool (workflow-core#2033). Outside OVER_CAP_TAGS: it reports. Read on the --against
 * index side alone, since its ticket lookup is a network call (workflow-core#2056).
 */
const CLOSED_TRIGGER = "CLOSED-TRIGGER";

/**
 * What a dead latch's `surface` opens with, `<guard>:<id>` following it.
 * Keyed on both because the bound is a property of one guard's source: two
 * guards stranding the same id are two repairs.
 */
const LATCH_SURFACE_PREFIX = "latch:";

/**
 * What a session finding's `surface` opens with, the tool name following it —
 * `session:Bash`. Per TOOL rather than one `session` surface because the
 * direction gate's `family` is `(tag, surface)`: a shared surface would make two
 * tools one family, and a rise in one would read as a fall in the other.
 */
const SESSION_SURFACE_PREFIX = "session:";

/**
 * What an over-cap fragment finding's `surface` opens with, the rule id
 * following it — `fragment:whale`. Keyed on the id rather than the guard: two
 * guards reaching the same over-cap fragment are the same repo fault, not two.
 */
const FRAGMENT_SURFACE_PREFIX = "fragment:";

/**
 * All five, for the direction gate's membership test.
 *
 * A Set rather than a comparison per tag so that adding a capped surface is one
 * edit here and none in the profile.
 */
const OVER_CAP_TAGS = new Set([
	OVER_POOL,
	OVER_INJECTION,
	OVER_SESSION,
	OVER_RATCHET,
	OVER_FRAGMENT,
]);

module.exports = {
	OVER_POOL,
	OVER_INJECTION,
	OVER_SESSION,
	OVER_RATCHET,
	OVER_FRAGMENT,
	DEAD_LATCH,
	CLOSED_TRIGGER,
	SESSION_SURFACE_PREFIX,
	FRAGMENT_SURFACE_PREFIX,
	LATCH_SURFACE_PREFIX,
	OVER_CAP_TAGS,
};
