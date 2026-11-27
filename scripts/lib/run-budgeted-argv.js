/**
 * @param {string[]} argv
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
