/*
 * main-rewind.js — the one refusal of a command that moves `main` backwards,
 * printing docs/agents/rules/main-rewind.txt (#765, #1733, #1777), for the
 * cores that refuse one: lib/pull-form.js (a reset, a ref write) and
 * lib/branch-publish.js (a forced push, a remote deletion).
 *
 * The rule's id stays a literal at each caller's own `ruleText("main-rewind")`
 * call, where check-guard-registry.js's emitter scan reads it.
 *
 * guard-fire-needles.json keys the fallback below, and keys
 * lib/branch-publish.js's two framings ("force-pushes", "` on the remote")
 * apart from the rest; reword either there too.
 */

/* The rule where the store cannot give it, which still refuses: the command
 * is known bad and only its rule is unreadable (#772). */
const REWIND_RULE_FALLBACK =
	"Never move `main` backwards; the rule could not be read from docs/agents/rules/main-rewind.txt. Read that file before doing anything else.";

/**
 * The refusal's reason, `@CMD@` still standing where the caller splices the
 * command in.
 * @param {string} what completing "This …"
 * @param {() => string} readRule the fragment's text; throws where the store
 *   cannot give it
 */
function rewindReason(what, readRule) {
	let rule;
	try {
		rule = readRule();
	} catch {
		rule = REWIND_RULE_FALLBACK;
	}
	return `This ${what}: @CMD@\n\n${rule}`;
}

module.exports = { REWIND_RULE_FALLBACK, rewindReason };
