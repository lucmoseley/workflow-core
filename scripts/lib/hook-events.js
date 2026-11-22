const AFTER_EVENTS = /** @type {const} */ ([
	"PostToolUse",
	"PostToolUseFailure",
	"PostToolBatch",
]);
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
