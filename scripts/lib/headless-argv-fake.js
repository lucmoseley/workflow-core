/** @typedef {import("./headless-options.js").HelpOption} HelpOption */

const isFlag = (/** @type {string|undefined} */ a) =>
	Boolean(a?.startsWith("-")) && a !== "-";

/**
 * @param {HelpOption} option
 * @param {string[]} argv
 * @param {number} i
 * @returns {{value: string|true, last: number}|{error: string}}
 */
function parseValue(option, argv, i) {
	const arg = argv[i] ?? "";
	const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
	if (eq !== -1) return { value: arg.slice(eq + 1), last: i };
	const next = argv[i + 1];
	if (option.value === "required")
		return next === undefined
			? { error: `error: option '${option.flags}' argument missing` }
			: { value: next, last: i + 1 };
	if (option.value === "optional")
		return next === undefined || isFlag(next)
			? { value: true, last: i }
			: { value: next, last: i + 1 };
	if (option.value === "variadic") {
		let last = i;
		while (last + 1 < argv.length && !isFlag(argv[last + 1])) last++;
		return { value: argv.slice(i + 1, last + 1).join(" "), last };
	}
	return { value: true, last: i };
}

/**
 * @param {HelpOption[]} options
 * @param {string[]} argv
 * @returns {{flags: Map<string, string|true>, positionals: string[]}|{error: string}}
 */
function parseArgv(options, argv) {
	const byName = new Map(options.flatMap((o) => o.names.map((n) => [n, o])));
	/** @type {Map<string, string|true>} */
	const flags = new Map();
	/** @type {string[]} */
	const positionals = [];
	let i = 0;
	while (i < argv.length) {
		const arg = argv[i] ?? "";
		if (arg === "--") {
			positionals.push(...argv.slice(i + 1));
			break;
		}
		if (!isFlag(arg)) {
			positionals.push(arg);
			i++;
			continue;
		}
		const name = arg.startsWith("--") ? (arg.split("=")[0] ?? arg) : arg;
		const option = byName.get(name);
		if (!option) return { error: `error: unknown option '${name}'` };
		const read = parseValue(option, argv, i);
		if ("error" in read) return read;
		for (const n of option.names) flags.set(n, read.value);
		i = read.last + 1;
	}
	return { flags, positionals };
}

module.exports = { parseArgv };
