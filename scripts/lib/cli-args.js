const { cutAt } = require("./cut-at.js");
const { writeFd } = require("./write-fd.js");

/**
 * @typedef {"boolean" | "value" | "list"} FlagType
 * @typedef {object} CommandSpec
 * @property {string} usage
 * @property {Record<string, FlagType>} [flags]
 * @property {number} [min]
 * @property {number} [max]
 * @typedef {CommandSpec & { commands?: Record<string, CommandSpec> }} CliSpec
 * @typedef {{ command: string | undefined, flags: Record<string, string | true>,
 *   lists: Record<string, string[]>, positionals: string[] }} Parsed
 */

class CliExit extends Error {
	/**
	 * @param {0 | 2} code
	 * @param {string} text
	 */
	constructor(code, text) {
		super(text);
		this.name = "CliExit";
		this.code = code;
		this.text = text;
	}
}

const HELP = new Set(["--help", "-h"]);

/** @param {string} token */
const isFlag = (token) => /^--?[A-Za-z]/.test(token);

/**
 * @param {string} usage
 * @param {string} message
 * @returns {CliExit}
 */
const buildRefusal = (usage, message) =>
	new CliExit(2, `${message}\n\n${usage}\n`);

/**
 * @param {string[]} before
 * @param {CliSpec} spec
 * @returns {{named: string | undefined, sub: CommandSpec | undefined}}
 */
function resolveCommand(before, spec) {
	const commands = spec.commands;
	const [first] = before;
	const named =
		commands && first !== undefined && !isFlag(first) ? first : undefined;
	const sub =
		commands && named !== undefined && Object.hasOwn(commands, named)
			? commands[named]
			: undefined;
	return { named, sub };
}

/**
 * @param {string} token
 * @param {Iterator<string>} tokens
 * @param {{declared: Record<string, FlagType>, usage: string}} at
 * @returns {{flag: string, value: string | true, list: boolean}}
 */
function readFlag(token, tokens, { declared, usage }) {
	const eq = token.indexOf("=");
	const flag = eq === -1 ? token : token.slice(0, eq);
	const type = Object.hasOwn(declared, flag) ? declared[flag] : undefined;
	if (!type) throw buildRefusal(usage, `unknown flag: ${flag}`);
	if (type === "boolean") {
		if (eq !== -1) throw buildRefusal(usage, `${flag} takes no value`);
		return { flag, value: true, list: false };
	}
	const value = eq === -1 ? tokens.next().value : token.slice(eq + 1);
	if (value === undefined) throw buildRefusal(usage, `${flag} needs a value`);
	const [next] = cutAt(value, "=");
	if (eq === -1 && Object.hasOwn(declared, next))
		throw buildRefusal(usage, `${flag} needs a value`);
	return { flag, value, list: type === "list" };
}

/**
 * @param {string[]} argv
 * @param {CliSpec} spec
 * @returns {Parsed}
 */
function parse(argv, spec) {
	const end = argv.indexOf("--");
	const before = end === -1 ? argv : argv.slice(0, end);
	const { named, sub } = resolveCommand(before, spec);

	if (before.some((t) => HELP.has(t)))
		throw new CliExit(0, `${(sub ?? spec).usage}\n`);

	if (spec.commands) requireCommand(spec.usage, named, sub);
	const usage = (sub ?? spec).usage;
	/** @type {Record<string, FlagType>} */
	const declared = { ...spec.flags, ...sub?.flags };

	/** @type {Parsed} */
	const out = {
		command: sub ? named : undefined,
		flags: {},
		lists: {},
		positionals: [],
	};
	const tokens = before.values();
	if (sub) tokens.next();
	readTokens(tokens, out, { declared, usage });
	if (end !== -1) out.positionals.push(...argv.slice(end + 1));

	countPositionals(out.positionals, sub ?? spec, usage);
	return out;
}

/**
 * @param {IterableIterator<string>} tokens
 * @param {Parsed} out
 * @param {{ declared: Record<string, FlagType>, usage: string }} ctx
 */
function readTokens(tokens, out, ctx) {
	for (const token of tokens) {
		if (!isFlag(token)) {
			out.positionals.push(token);
			continue;
		}
		const { flag, value, list } = readFlag(token, tokens, ctx);
		if (list) out.lists[flag] = [...(out.lists[flag] ?? []), String(value)];
		else out.flags[flag] = value;
	}
}

/**
 * @param {string} usage
 * @param {string | undefined} named
 * @param {CommandSpec | undefined} sub
 */
function requireCommand(usage, named, sub) {
	if (named === undefined) throw buildRefusal(usage, "a command is required");
	if (!sub) throw buildRefusal(usage, `unknown command: ${named}`);
}

/**
 * @param {string[]} positionals
 * @param {CommandSpec} counted
 * @param {string} usage
 */
function countPositionals(positionals, counted, usage) {
	const min = counted.min ?? 0;
	const max = counted.max ?? min;
	if (positionals.length > max)
		throw buildRefusal(usage, `unexpected argument: ${positionals[max]}`);
	if (positionals.length < min) throw buildRefusal(usage, "missing argument");
}

/**
 * @param {CliExit} e
 * @returns {0 | 2}
 */
function printExit(e) {
	writeFd(e.code === 0 ? 1 : 2, e.text);
	return e.code;
}

/**
 * @param {CliExit} e
 * @returns {never}
 */
function exitWith(e) {
	process.exit(printExit(e));
}

/**
 * @param {string[]} argv
 * @param {CliSpec} spec
 * @returns {Parsed}
 */
function parseOrExit(argv, spec) {
	try {
		return parse(argv, spec);
	} catch (e) {
		if (!(e instanceof CliExit)) throw e;
		exitWith(e);
	}
}

/**
 * @param {string[]} argv
 * @param {CliSpec} spec
 * @returns {Parsed | 0 | 2}
 */
function parseOrCode(argv, spec) {
	try {
		return parse(argv, spec);
	} catch (e) {
		if (!(e instanceof CliExit)) throw e;
		return printExit(e);
	}
}

/**
 * @param {Parsed["flags"]} flags
 * @param {string} name
 * @returns {string | undefined}
 */
function flagValue(flags, name) {
	const v = flags[name];
	return typeof v === "string" ? v : undefined;
}

module.exports = {
	HELP,
	parse,
	parseOrExit,
	parseOrCode,
	flagValue,
	exitWith,
	printExit,
	CliExit,
};
