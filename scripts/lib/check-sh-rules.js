/*
 * check-sh-rules.js — the guard-check-sh core (workflow-core#2800, workflow-core#3224): which rules a
 * shell-gate command is handed before it runs (mantahostels#1805, spec
 * mantahostels#1762), and, before the full run, the changed-paths route that
 * costs seconds rather than minutes (workflow-core#1015).
 *
 * INJECTION ONLY — it never denies and never warns. The third text, the
 * changed-paths route, is advice, not a rule.
 *
 * The ids' priority order is shellcheck-not-installed first — it is about
 * whether this run means anything at all — then the directive rule,
 * shellcheck-source-directive, which is about reading what it found. They are
 * literal arrays at the call site, where lib/rule-emission.js and
 * check-guard-registry.js read them.
 *
 * ONE INJECTION A COMMAND: every segment is walked first, so a command
 * carrying two runs is told once, and the full run's third id rides if any
 * segment is one.
 *
 * LIMITS
 *  - SCOPE is `npm run check:sh` and `npm run check:sh:changed` (and their
 *    `npm check:sh…` shorthands) and a direct `shellcheck` invocation. Only
 *    the full run is told about `check:sh:changed`.
 *  - It fires on a segment's own first word, as written: `npm` and
 *    `shellcheck` exactly, never a path to either and never a quoted one. A
 *    run reached through `xargs`, `env`, `sudo` or a wrapper script states
 *    nothing.
 *  - It does NOT check whether shellcheck is actually installed.
 */

const { parseCommand, walkCommands } = require("./shell-parse.js");

/**
 * The npm script a segment runs, null where it is not npm. `npm check:sh` —
 * no `run` — is npm's own shorthand and runs the same script.
 * @param {string[]} words
 */
function npmScript(words) {
	if (words[0] !== "npm") return null;
	return (words[1] === "run" ? words[2] : words[1]) ?? null;
}

/**
 * @param {string} command
 * @param {import("./kit-context.js").KitContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	let subject = false;
	let fullRun = false;
	walkCommands(
		parseCommand(command),
		({ words }) => {
			const script = npmScript(words);
			if (words[0] === "shellcheck" || script === "check:sh:changed")
				subject = true;
			else if (script === "check:sh") {
				subject = true;
				fullRun = true;
			}
		},
		ctx,
	);
	if (!subject) return null;
	if (fullRun)
		return {
			injectRules: [
				"shellcheck-not-installed",
				"shellcheck-source-directive",
				"shellcheck-changed-scope",
			],
		};
	return {
		injectRules: ["shellcheck-not-installed", "shellcheck-source-directive"],
	};
}

module.exports = { field: "command", noun: "command", decide };
