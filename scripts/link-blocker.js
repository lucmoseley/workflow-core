#!/usr/bin/env node
/*
 * link-blocker.js <blocked> <blocker> — make <blocker> block <blocked>, each
 * a bare number or `owner/name#n`, refusing a link that would close a loop of open
 * issues waiting on each other (#5070). It resolves the blocker's database id
 * itself and verifies the edge in a separate read of the blocked issue's
 * canonical list.
 *
 * The writer is lib/link-writer.js, whose header holds why each step is there
 * and the exit codes: 0 linked, 3 refused with nothing changed (a self-link or
 * a loop), 1 any other failure.
 *
 * cli-args-exempt: a pass-through; lib/link-writer.js's runCli parses its argv with a strict parseArgs.
 */

const { runCli } = require("./lib/link-writer.js");

const main = () => runCli("blocker", process.argv.slice(2));

module.exports = { main };

if (require.main === module)
	main().catch((e) => {
		process.stderr.write(`link-blocker: ${e}\n`);
		process.exitCode = 1;
	});
