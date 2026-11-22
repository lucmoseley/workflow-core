/*
 * main-rewind.js — the refusal of a command that moves `main` backwards
 * (workflow-core#765, workflow-core#1733, workflow-core#1777): lib/pull-form.js's local reset or ref write prints
 * docs/agents/rules/main-rewind.txt, and lib/branch-publish.js's forced push
 * or remote deletion prints main-remote-rewind.txt, framed with the session's
 * own queue ref (workflow-core#4856).
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
 * known bad and only its rule is unreadable (workflow-core#772).
 * @param {import("./guard-verdict.js").RulePorts} ctx
 * @param {string} what completing "This …"
 */
const rewindReason = (ctx, what) =>
	`This ${what}: @CMD@\n\n${ruleOrFallback(ctx, "main-rewind", "Never move `main` backwards")}`;

/**
 * The rule for a remote rewind: only the lander moves `main`.
 * @param {import("./guard-verdict.js").RulePorts} ctx
 */
const remoteRewindRule = (ctx) =>
	ruleOrFallback(
		ctx,
		"main-remote-rewind",
		"Only the queue lander moves `main`, and never backwards",
	);

module.exports = { remoteRewindRule, rewindReason };
