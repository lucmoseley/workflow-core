/*
 * main-rewind.js — the one refusal of a command that moves `main` backwards,
 * printing docs/agents/rules/main-rewind.txt (#765, #1733, #1777), for the
 * cores that refuse one: lib/pull-form.js (a reset, a ref write) and
 * lib/branch-publish.js (a forced push, a remote deletion).
 *
 * The rule's id is a literal here, which check-guard-registry.js's emitter
 * scan reaches through each caller's require.
 *
 * guard-fire-needles.json keys this refusal's fallback, and keys
 * lib/branch-publish.js's two framings ("force-pushes", "` on the remote")
 * apart from the rest; reword either there too.
 */

const { ruleOrFallback } = require("./guard-verdict.js");

/**
 * The refusal's reason, `@CMD@` still standing where the caller splices the
 * command in. A rule the store cannot give still refuses: the command is
 * known bad and only its rule is unreadable (#772).
 * @param {import("./guard-verdict.js").RulePorts} ctx
 * @param {string} what completing "This …"
 */
const rewindReason = (ctx, what) =>
	`This ${what}: @CMD@\n\n${ruleOrFallback(ctx, "main-rewind", "Never move `main` backwards")}`;

module.exports = { rewindReason };
