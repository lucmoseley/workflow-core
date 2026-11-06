/*
 * headless-options.js — the options `claude --help` lists, and an argv read
 * against them the way the binary's parser reads it (#4586). The recorder
 * (record-headless-run.js) records the first into
 * scripts/fixtures/headless-run.json; lib/headless-run-fake.ts's program
 * refuses a flag the second finds unknown, in the binary's words, so a
 * launch passing a flag the harness lacks fails its suite.
 */

/**
 * @typedef {"none"|"required"|"optional"|"variadic"} Arity
 * @typedef {{names: string[], value: Arity}} HelpOption
 */

/* `  -n, --name <name>   Set a…`: the names, then at most one placeholder. */
const OPTION_LINE =
	/^ {2}(-[\w-]+(?:, -[\w-]+)*)(?: ([<[][^>\]]+[>\]]))?(?: {2,}|$)/;

/**
 * @param {string} help `claude --help`'s stdout
 * @returns {HelpOption[]}
 */
function parseHelpOptions(help) {
	/** @type {HelpOption[]} */
	const options = [];
	for (const line of help.split("\n")) {
		const m = line.match(OPTION_LINE);
		if (!m?.[1]) continue;
		const placeholder = m[2] ?? "";
		/** @type {Arity} */
		let value = "none";
		if (placeholder.endsWith("...>") || placeholder.endsWith("...]"))
			value = "variadic";
		else if (placeholder.startsWith("<")) value = "required";
		else if (placeholder.startsWith("[")) value = "optional";
		options.push({ names: m[1].split(", "), value });
	}
	return options;
}

const isFlag = (/** @type {string|undefined} */ a) =>
	Boolean(a?.startsWith("-")) && a !== "-";

/**
 * The value `option`, met at `argv[i]`, takes, inline after `=` or in
 * the arguments after it, and the index of its last argument; or the binary's error line where a required value is missing.
 * @param {HelpOption} option
 * @param {string[]} argv
 * @param {number} i
 * @returns {{value: string|true, last: number}|{error: string}}
 */
function readValue(option, argv, i) {
	const arg = argv[i] ?? "";
	const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
	if (eq !== -1) return { value: arg.slice(eq + 1), last: i };
	const next = argv[i + 1];
	if (option.value === "required")
		return next === undefined
			? { error: `error: option '${option.names.join(", ")}' argument missing` }
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
 * `argv` read against `options`: each option met, keyed by every name it
 * has, with its value (true where it takes none); the positionals; or the
 * binary's own error line for an unknown option or a missing value.
 * @param {HelpOption[]} options
 * @param {string[]} argv
 * @returns {{flags: Map<string, string|true>, positionals: string[]}|{error: string}}
 */
function readArgv(options, argv) {
	const byName = new Map(options.flatMap((o) => o.names.map((n) => [n, o])));
	/** @type {Map<string, string|true>} */
	const flags = new Map();
	/** @type {string[]} */
	const positionals = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--") {
			positionals.push(...argv.slice(i + 1));
			break;
		}
		if (!isFlag(arg)) {
			positionals.push(arg);
			continue;
		}
		const name = arg.startsWith("--") ? (arg.split("=")[0] ?? arg) : arg;
		const option = byName.get(name);
		if (!option) return { error: `error: unknown option '${name}'` };
		const read = readValue(option, argv, i);
		if ("error" in read) return read;
		i = read.last;
		for (const n of option.names) flags.set(n, read.value);
	}
	return { flags, positionals };
}

module.exports = { parseHelpOptions, readArgv };
