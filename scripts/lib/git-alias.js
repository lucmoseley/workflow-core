/*
 * git-alias.js — what a git word means once the aliases its own command line
 * defines are read (#3997): `git -c alias.s=symbolic-ref s HEAD` is a
 * `symbolic-ref`. walkGit's read.
 *
 * Measured on git 2.43.0: an alias takes its leading words as arguments, one
 * alias may name another, the last definition wins, a builtin of the same name
 * beats it, and `--config-env`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_PARAMETERS`
 * define one as `-c` does.
 *
 * LIMITS: an alias in a config file is not read, nor is `GIT_CONFIG_GLOBAL` or
 * `GIT_CONFIG_SYSTEM`.
 */

const { literal } = require("./shell-words.js");

/** The `sub` of a call whose alias cannot be read; no git command has spaces. */
const UNREAD_ALIAS = "unread alias";

/**
 * @typedef {object} AliasTable the aliases a command line defines
 * @property {Map<string, string | null>} named each lowercased name's last
 *   definition, null where it cannot be read
 * @property {boolean} anyUnread a definition whose name cannot be read, so any
 *   word could be an alias
 */

/** @returns {AliasTable} */
const emptyAliasTable = () => ({ named: new Map(), anyUnread: false });

/** @param {string} key an `alias.<name>` key */
const aliasNameOf = (key) => key.slice("alias.".length).toLowerCase();

/**
 * One config key onto `table`. A dotted alias name is the subsection form newer
 * gits read, which is not followed here.
 * @param {AliasTable} table accumulator
 * @param {{ key: string, complete: boolean, value: string | null }} entry
 *   `complete` false where only the head of the key can be read
 */
function define(table, { key, complete, value }) {
	const lower = key.toLowerCase();
	if (!complete) {
		if (lower.startsWith("alias.") || "alias.".startsWith(lower))
			table.anyUnread = true;
		return;
	}
	if (!lower.startsWith("alias.")) return;
	const name = aliasNameOf(lower);
	if (name.includes(".")) table.anyUnread = true;
	else table.named.set(name, value);
}

/**
 * @param {string} word raw
 * @param {string[]} spans
 */
function splitConfig(word, spans) {
	const { known, text, head } = literal(word, spans);
	const visible = known ? text : head;
	const eq = visible.indexOf("=");
	return {
		key: eq < 0 ? visible : visible.slice(0, eq),
		complete: known || eq >= 0,
		value: known && eq >= 0 ? visible.slice(eq + 1) : null,
	};
}

/**
 * @param {AliasTable} table accumulator
 * @param {string} word raw
 * @param {string[]} spans
 */
const defineFromConfigWord = (table, word, spans) =>
	define(table, splitConfig(word, spans));

/**
 * Read one `--config-env <key>=<envvar>` word onto `table`: its value is in the
 * environment, so an alias it names is unread whatever the variable holds.
 * @param {AliasTable} table accumulator
 * @param {string} word raw
 * @param {string[]} spans
 */
const defineFromConfigEnvWord = (table, word, spans) =>
	define(table, { ...splitConfig(word, spans), value: null });

/**
 * Read `GIT_CONFIG_PARAMETERS` and the `GIT_CONFIG_KEY_<n>`/`VALUE_<n>` pairs of
 * a command's environment onto `table`.
 * @param {AliasTable} table accumulator
 * @param {Map<string, string | null>} env each name's raw value word, null
 *   where it cannot be read
 * @param {string[]} spans
 */
function defineFromEnv(table, env, spans) {
	if (env.has("GIT_CONFIG_PARAMETERS")) table.anyUnread = true;
	for (const [name, word] of env) {
		const n = /^GIT_CONFIG_KEY_(\d+)$/.exec(name)?.[1];
		if (n === undefined || word === null) continue;
		const key = literal(word, spans);
		const valueWord = env.get(`GIT_CONFIG_VALUE_${n}`);
		const value = valueWord ? literal(valueWord, spans) : null;
		/* Which of two definitions wins hangs on GIT_CONFIG_COUNT and the indices,
		 * so neither is believed. */
		const defined = table.named.has(aliasNameOf(key.text));
		define(table, {
			key: key.known ? key.text : key.head,
			complete: key.known,
			value: value?.known && !defined ? value.text : null,
		});
	}
}

/* An alias git hands to a shell (`!`), one opening on a git option, which git
 * refuses or reads apart, and one its own quoting splits. */
const UNREADABLE_VALUE = /^\s*(?:$|!|-)|['"\\]/;

/**
 * The subcommand and arguments `sub` comes to through `table`. A word in `subs`
 * stops the walk, each being a builtin, which beats any alias of its name.
 * `sub` read as UNREAD_ALIAS where the words cannot be told.
 * @param {string} sub raw
 * @param {string[]} args raw
 * @param {AliasTable} table
 * @param {{ subs: string[], spans: string[] }} opts
 * @returns {{ sub: string, args: string[] }}
 */
function expandAlias(sub, args, table, { subs, spans }) {
	if (subs.includes(sub) || (table.named.size === 0 && !table.anyUnread))
		return { sub, args };
	const spelt = literal(sub, spans);
	if (!spelt.known) return { sub: UNREAD_ALIAS, args: [] };
	let word = spelt.text;
	let words = args;
	const seen = new Set();
	while (!subs.includes(word)) {
		const name = word.toLowerCase();
		const value = table.named.get(name);
		if (value === undefined && table.anyUnread)
			return { sub: UNREAD_ALIAS, args: [] };
		/* No alias of that name, or a loop, which git refuses. */
		if (value === undefined || seen.has(name)) break;
		seen.add(name);
		if (value === null || UNREADABLE_VALUE.test(value))
			return { sub: UNREAD_ALIAS, args: [] };
		const [head = "", ...rest] = value.trim().split(/\s+/);
		word = head;
		words = [...rest, ...words];
	}
	return { sub: word, args: words };
}

module.exports = {
	UNREAD_ALIAS,
	emptyAliasTable,
	expandAlias,
	defineFromEnv,
	defineFromConfigEnvWord,
	defineFromConfigWord,
};
