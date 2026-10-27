#!/usr/bin/env node
/*
 * upgrade.js — walks an adopter from its pinned release to the plugin
 * version actually installed, applying each major's migration note in tag
 * order (workflow-core#6; spec §Releases and migration, mantahostels#3527).
 *
 * Usage:
 *   node scripts/upgrade.js [--root <dir>] [--plugin-root <dir>] [--dry-run]
 *
 * RUN AFTER re-materialising the plugin and restarting — the full recipe,
 * flags included, is `materialisePlugin`'s JSDoc in
 * `scripts/lib/materialise-plugin.js` (`marketplace add` → `install` →
 * `update`, each `--scope project`), never the `plugin update; restart`
 * shorthand, which skips the `marketplace add` that actually rotates the ref
 * (workflow-core#214). CLAUDE_PLUGIN_ROOT (or --plugin-root)
 * already holds the NEW plugin.json; the adopter's committed pin (still
 * `.claude/settings.json`'s `ref` today) still names the OLD one. This
 * walker never touches that pin — it is the consent target, not a progress
 * marker. Progress is `walkedTo`, a committed field in
 * `.claude/workflow-core.json`. Each note between `walkedTo` (or the pin,
 * where `walkedTo` is absent) and the installed plugin is applied and
 * verified in order; `walkedTo` only advances past a note whose own *Verify*
 * command passed, so a note that fails is retried, and its predecessors are
 * not re-applied, on the next run. Materialising the plugin so the install
 * catches up with the pin is wholly the reconciler's job, not this walker's
 * (workflow-core#217, workflow-core#230).
 *
 * The walk itself: lib/upgrade-walk.js.
 *
 * EXITS 0 up to date or fully upgraded / 1 a note is malformed or its Verify
 * failed (prints which, and how far it got) / 2 the arguments or the
 * installed plugin's manifest are wrong / 3 the pin is ahead of the
 * installed plugin — install behind pin, reconciliation owed.
 *
 * Joins no §N3 family: it walks a note set and mutates adopter-repo files
 * rather than writing one file of its own.
 */

const { writeFd } = require("./lib/write-fd.js");
const { hostRoot } = require("./lib/host-root.js");
const { ghLabels } = require("./lib/core-owned-files.js");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const { measurerFor } = require("./lib/core-context-cost.js");
const { upgrade } = require("./lib/upgrade-walk.js");

/** @param {string[]} argv */
function main(argv) {
	const { flags } = parseOrExit(argv, {
		usage:
			"usage: node scripts/upgrade.js [--root <dir>] [--plugin-root <dir>] [--dry-run]",
		flags: {
			"--root": "value",
			"--plugin-root": "value",
			"--dry-run": "boolean",
		},
	});
	const root = flagValue(flags, "--root") ?? hostRoot();
	const pluginRoot =
		flagValue(flags, "--plugin-root") ?? process.env.CLAUDE_PLUGIN_ROOT ?? root;
	const result = upgrade({
		root,
		pluginRoot,
		dryRun: flags["--dry-run"] === true,
		out: (line) => writeFd(1, `${line}\n`),
		measureCore: measurerFor({
			root,
			claudeBin: process.env.WFC_CLAUDE_BIN || "claude",
		}),
		labels: ghLabels(root),
	});
	if (result.reason) writeFd(2, `upgrade: ${result.reason}\n`);
	return result.status;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
