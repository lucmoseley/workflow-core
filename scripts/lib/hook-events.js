/*
 * hook-events.js — the hook event names, the one list every reader derives its
 * subset from (#3438). It requires nothing, so lib/guard-entry.js, on every
 * hook call's path, pays nothing to read it.
 */

/* The events that fire once a call has run (#2144). */
const AFTER_EVENTS = /** @type {const} */ ([
	"PostToolUse",
	// #1575. A Bash call exiting non-zero reaches this event instead.
	"PostToolUseFailure",
	// #2026. Fires once per batch with every call's result, a refused Skill's
	// included, which no per-call event sees.
	"PostToolBatch",
]);
/*
 * The events a hook registers on. A closed set deliberately: as a bare
 * string, a misspelt event finds no registration and reads as "not wired";
 * through hook-wiring.ts's HookEvent a typo is a compile error instead.
 */
const HOOK_EVENTS = /** @type {const} */ ([
	"PreToolUse",
	...AFTER_EVENTS,
	"UserPromptSubmit",
	"Stop",
	"SessionStart",
	"PreCompact",
	"SessionEnd",
]);

module.exports = { AFTER_EVENTS, HOOK_EVENTS };
