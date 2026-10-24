/*
 * claude-argv0.js — the argv[0] spellings a live Claude process wears.
 *
 * ONE COPY, because a second would drift. `scripts/lib/admission.js` counts
 * Claude processes for the memory ladder and `scripts/reconcile-plugin.js`
 * (workflow-core#247) counts live sessions before rotating the plugin supply; both must
 * agree on what a Claude process looks like or one of them silently sees
 * none.
 *
 * Three shapes run at once (docs/environment.md). The bare name and the
 * launcher path both basename to `claude`, so CLAUDE_NAME covers the pair;
 * the versioned binary a RESUMED session re-execs basenames to a version
 * string, and needs CLAUDE_VERSIONED. ARGV[0], NEVER `comm` — a backgrounded
 * session's `comm` IS that version number, so a `comm` matcher finds no
 * session at all (mantahostels#481, this machine's session counters).
 */

const path = require("node:path");

const CLAUDE_NAME = /^claude(\.exe)?$/;
const CLAUDE_VERSIONED = /(^|\/)claude\/versions\/[^/]+$/;

/** @param {string | null | undefined} argv0 */
function isClaudeArgv0(argv0) {
	if (!argv0) return false;
	return CLAUDE_NAME.test(path.basename(argv0)) || CLAUDE_VERSIONED.test(argv0);
}

module.exports = { isClaudeArgv0 };
