/*
 * run-budgeted-argv.js — run-budgeted.js's command line split into its
 * fields, read by run-budgeted.js and by the pin harness's shell half (#5361).
 *
 *   <budget-ms> <kill-after-ms> <command> [args…]
 *   --hook <hook> [--pausable] <command> [args…]
 */

/**
 * @param {string[]} argv run-budgeted.js's own arguments
 * @returns {{ hook: string | undefined, pausable: boolean,
 *   budgetRaw: string | undefined, killAfterRaw: string | undefined,
 *   command: string | undefined, args: string[] }}
 */
function splitRunArgv(argv) {
	if (argv[0] === "--hook") {
		const pausable = argv[2] === "--pausable";
		const [command, ...args] = argv.slice(pausable ? 3 : 2);
		return {
			hook: argv[1],
			pausable,
			budgetRaw: undefined,
			killAfterRaw: undefined,
			command,
			args,
		};
	}
	const [budgetRaw, killAfterRaw, command, ...args] = argv;
	return {
		hook: undefined,
		pausable: false,
		budgetRaw,
		killAfterRaw,
		command,
		args,
	};
}

module.exports = { splitRunArgv };
