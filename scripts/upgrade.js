#!/usr/bin/env node
const { writeFd } = require("./lib/write-fd.js");
const { coreRoot, scriptPath } = require("./lib/script-path.js");
const { worktreeRoot } = require("./lib/host-root.js");
const { ghLabels } = require("./lib/core-owned-files.js");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const { measurerFor } = require("./lib/core-context-cost.js");
const { claudeBin } = require("./lib/claude-bin.js");
const { upgrade } = require("./lib/upgrade-walk.js");

/** @param {string[]} argv */
function main(argv) {
	const { flags } = parseOrExit(argv, {
		usage: `usage: node ${scriptPath("upgrade.js")} [--root <dir>] [--plugin-root <dir>] [--dry-run]`,
		flags: {
			"--root": "value",
			"--plugin-root": "value",
			"--dry-run": "boolean",
		},
	});
	const root = flagValue(flags, "--root") ?? worktreeRoot();
	const pluginRoot = flagValue(flags, "--plugin-root") ?? coreRoot();
	const result = upgrade({
		root,
		pluginRoot,
		dryRun: flags["--dry-run"] === true,
		out: (line) => writeFd(1, `${line}\n`),
		measureCore: measurerFor({
			root,
			claudeBin: claudeBin(),
		}),
		labels: ghLabels(root),
	});
	if (result.reason) writeFd(2, `upgrade: ${result.reason}\n`);
	return result.status;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
