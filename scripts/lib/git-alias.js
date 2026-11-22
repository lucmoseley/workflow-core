// biome-ignore lint/suspicious/noImportCycles: shell-words.js requires shell-parse.js only inside runScript, once both have loaded (#4863).
const { literal } = require("./shell-words.js");

const UNREAD_ALIAS = "unread alias";

/** @typedef {Map<string, string | null>} FileAliases */

/**
 * @param {string} out
 * @returns {FileAliases}
 */
function parseFileAliases(out) {
	/** @type {FileAliases} */
	const aliases = new Map();
	for (const entry of out.split("\0")) {
		const nl = entry.indexOf("\n");
		const key = nl < 0 ? entry : entry.slice(0, nl);
		if (!key.toLowerCase().startsWith("alias.")) continue;
		const full = aliasNameOf(key);
		const dot = full.indexOf(".");
		if (dot >= 0) {
			aliases.set(full.slice(0, dot), null);
			aliases.set(full, null);
		} else aliases.set(full, nl < 0 ? null : entry.slice(nl + 1));
	}
	return aliases;
}

/**
 * @typedef {object} AliasTable
 * @property {Map<string, string | null>} named
 * @property {boolean} anyUnread
 */

const BUILTINS = new Set(
	"add am apply archive bisect blame branch bundle cat-file check-ignore check-ref-format checkout cherry cherry-pick clean clone commit config count-objects describe diff diff-files diff-index diff-tree fetch for-each-ref fsck gc grep hash-object help init log ls-files ls-remote ls-tree merge merge-base merge-file merge-tree mktree mv name-rev notes pack-refs prune pull push range-diff read-tree rebase reflog remote repack rerere reset restore rev-list rev-parse revert rm shortlog show show-ref sparse-checkout stash status stripspace submodule switch symbolic-ref tag update-index update-ref var verify-commit version whatchanged worktree write-tree".split(
		" ",
	),
);

const CONFIG_FILE_VARS = [
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_SYSTEM",
	"XDG_CONFIG_HOME",
	"HOME",
];

const INCLUDE_KEY = /^include(?:\.path$|if\..*\.path$)/;

/** @param {string} key */
const isAliasKey = (key) => /^(?:alias|include(?:if)?)(?:\.|$)/i.test(key);

/** @returns {AliasTable} */
const emptyAliasTable = () => ({ named: new Map(), anyUnread: false });

/** @param {string} key */
const aliasNameOf = (key) => key.slice("alias.".length).toLowerCase();

/**
 * @param {AliasTable} table
 * @param {{ key: string, complete: boolean, value: string | null }} entry
 */
function define(table, { key, complete, value }) {
	const lower = key.toLowerCase();
	if (!complete) {
		if (lower.startsWith("alias.") || "alias.".startsWith(lower))
			table.anyUnread = true;
		return;
	}
	if (INCLUDE_KEY.test(lower)) table.anyUnread = true;
	if (!lower.startsWith("alias.")) return;
	const name = aliasNameOf(lower);
	if (name.includes(".")) table.anyUnread = true;
	else table.named.set(name, value);
}

/**
 * @param {string} word
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
 * @param {AliasTable} table
 * @param {string} word
 * @param {string[]} spans
 */
const defineFromConfigWord = (table, word, spans) =>
	define(table, splitConfig(word, spans));

/**
 * @param {AliasTable} table
 * @param {string} word
 * @param {string[]} spans
 */
const defineFromConfigEnvWord = (table, word, spans) =>
	define(table, { ...splitConfig(word, spans), value: null });

/**
 * @param {AliasTable} table
 * @param {Map<string, string | null>} env
 * @param {string[]} spans
 */
function defineFromEnv(table, env, spans) {
	if (env.has("GIT_CONFIG_PARAMETERS")) table.anyUnread = true;
	/** @param {string} name */
	const literalOf = (name) => {
		const word = env.get(name);
		return word ? literal(word, spans) : null;
	};
	for (const name of CONFIG_FILE_VARS)
		if (env.has(name) && literalOf(name)?.text !== "/dev/null")
			table.anyUnread = true;
	const count = literalOf("GIT_CONFIG_COUNT");
	const counted = count?.known ? Number(count.text) : 0;
	for (const [name, word] of env) {
		const n = /^GIT_CONFIG_KEY_(\d+)$/.exec(name)?.[1];
		if (n === undefined || word === null) continue;
		const key = literal(word, spans);
		const value = literalOf(`GIT_CONFIG_VALUE_${n}`);
		const defined = table.named.has(aliasNameOf(key.text));
		define(table, {
			key: key.known ? key.text : key.head,
			complete: key.known,
			value:
				value?.known && !defined && Number(n) < counted ? value.text : null,
		});
	}
}

const UNREADABLE_VALUE = /(?:^\s*(?:$|!|-))|['"\\]/;

/**
 * @param {string} name
 * @param {AliasTable} table
 * @param {() => FileAliases | null} readFileAliases
 * @returns {string | null | undefined}
 */
function definitionOf(name, table, readFileAliases) {
	const own = table.named.get(name);
	if (own !== undefined) return own;
	if (table.anyUnread) return null;
	const files = readFileAliases();
	return files === null ? null : files.get(name);
}

/**
 * @param {string} sub
 * @param {string[]} args
 * @param {AliasTable} table
 * @param {{ subs: string[], readFileAliases: () => FileAliases | null }} opts
 * @returns {{ sub: string, args: string[] }}
 */
function expandAlias(sub, args, table, { subs, readFileAliases }) {
	if (sub === UNREAD_ALIAS) return { sub, args: [] };
	let word = sub;
	let words = args;
	const seen = new Set();
	while (!subs.includes(word) && !BUILTINS.has(word)) {
		const name = word.toLowerCase();
		const value = definitionOf(name, table, readFileAliases);
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
	CONFIG_FILE_VARS,
	expandAlias,
	isAliasKey,
	parseFileAliases,
	defineFromEnv,
	defineFromConfigEnvWord,
	defineFromConfigWord,
};
