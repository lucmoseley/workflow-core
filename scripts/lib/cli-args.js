/*
 * cli-args.js — the one argument reader a script with a side effect calls
 * before doing anything (#920).
 *
 * A hand-rolled `argv.includes("--dry-run")` ignores every flag it does not
 * name, so `--help` and a typo both fall through to the default action.
 *
 * THE CONTRACT:
 *   - `--help` or `-h` anywhere before a `--` prints the usage to stdout and
 *     exits 0 — the subcommand's usage where one is named;
 *   - an undeclared flag exits 2, `unknown flag: <flag>` plus the usage on
 *     stderr;
 *   - a value flag with no value exits 2 the same way. A next token that is
 *     itself a declared flag is no value, so `--repo --dry-run` refuses rather
 *     than taking `--dry-run` as the repo; any other token is the value;
 *   - a boolean flag never takes the next token (#743's bug), and refuses an
 *     `=value`;
 *   - a list flag is a value flag that may repeat, its values gathered in
 *     order under `lists` (#1078);
 *   - more positionals than declared exits 2.
 *
 * NOT `util.parseArgs`: its strict mode refuses any value starting `-`, which
 * `issue-body.js tick --match "- [ ] …"` passes on every call.
 *
 * `parse` THROWS a CliExit rather than exiting, so a test can call it; the
 * script itself calls `parseOrExit`, or `parseOrCode` where its `main`
 * returns the exit code.
 */

const { cutAt } = require("./cut-at.js");
const { writeFd } = require("./write-fd.js");

/**
 * @typedef {"boolean" | "value" | "list"} FlagType
 *
 * @typedef {object} CommandSpec
 * @property {string} usage
 * @property {Record<string, FlagType>} [flags]
 * @property {number} [min]  fewest positionals; 0 by default
 * @property {number} [max]  most positionals; `min` by default, Infinity allowed
 *
 * @typedef {CommandSpec & { commands?: Record<string, CommandSpec> }} CliSpec
 *   With `commands`, the first token names one; its `flags` add to the
 *   top level's, and its `min`/`max` count the positionals after it.
 *
 * @typedef {{ command: string | undefined, flags: Record<string, string | true>,
 *   lists: Record<string, string[]>, positionals: string[] }} Parsed
 *   `flags` and `lists` are keyed by the flag as declared (`"--dry-run"`),
 *   holding only those given.
 */

/** Why the process should end now, and with what. */
class CliExit extends Error {
	/**
	 * @param {0 | 2} code
	 * @param {string} text  the whole output, usage included
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
 * The subcommand `before` names, and its spec where `spec` declares it.
 *
 * @param {string[]} before  the tokens ahead of any `--`
 * @param {CliSpec} spec
 * @returns {{named: string | undefined, sub: CommandSpec | undefined}}
 */
function resolveCommand(before, spec) {
	/* The subcommand is the first token, never the first non-flag one: that
	 * could be a top-level flag's value. */
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
 * Reads one flag token, taking its value from `tokens` where it has none of
 * its own.
 *
 * @param {string} token
 * @param {Iterator<string>} tokens accumulator: the caller's cursor, advanced past a value taken from it
 * @param {{declared: Record<string, FlagType>, usage: string}} at
 * @returns {{flag: string, value: string | true, list: boolean}} `list` where
 *   the value joins the flag's others rather than replacing them
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
 * @param {string[]} argv  process.argv.slice(2)
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
 * Sorts each remaining token into `out`'s flags, lists or positionals.
 *
 * @param {IterableIterator<string>} tokens
 * @param {Parsed} out accumulator: each token lands in its flags, lists or positionals
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
 * Refuses a spec with commands where none, or an undeclared one, is named.
 *
 * @param {string} usage
 * @param {string | undefined} named
 * @param {CommandSpec | undefined} sub
 */
function requireCommand(usage, named, sub) {
	if (named === undefined) throw buildRefusal(usage, "a command is required");
	if (!sub) throw buildRefusal(usage, `unknown command: ${named}`);
}

/**
 * Refuses more positionals than `counted` declares, or fewer.
 *
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
 * Prints a CliExit as it says — help to stdout, a refusal to stderr — and
 * returns its code, for a caller that owns its own process.exit.
 * writeFd, never console: a hook's stdout is a pipe, and node drops a
 * buffered write at process.exit.
 *
 * @param {CliExit} e
 * @returns {0 | 2}
 */
function printExit(e) {
	writeFd(e.code === 0 ? 1 : 2, e.text);
	return e.code;
}

/**
 * Ends the process as a CliExit says.
 *
 * @param {CliExit} e
 * @returns {never}
 */
function exitWith(e) {
	process.exit(printExit(e));
}

/**
 * `parse`, ending the process on help or a refusal.
 *
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
 * `parse`, printing help or a refusal and returning its code, for a `main`
 * that returns its exit code rather than ending the process.
 *
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
 * A value flag's value, or undefined where it was not given: `Parsed.flags`
 * holds a boolean flag's `true` beside value flags' strings, so a script reads
 * a value flag through this rather than narrowing it itself.
 *
 * @param {Parsed["flags"]} flags
 * @param {string} name  the flag as declared (`"--repo"`)
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
