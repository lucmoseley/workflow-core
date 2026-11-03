/*
 * git-alias.js — what a git word means once its aliases are read (#3997, #4009):
 * `git -c alias.s=symbolic-ref s HEAD` is a `symbolic-ref`.
 *
 * Measured on git 2.43.0: an alias takes its leading words as arguments, one
 * alias may name another, the last definition wins, a builtin of the same name
 * beats it, `--config-env`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_PARAMETERS`
 * define one as `-c` does, and `-c` beats a `GIT_CONFIG_KEY_<n>`, which itself
 * beats a config file and counts only below `GIT_CONFIG_COUNT`.
 *
 * A config file's alias arrives through the walk's port, read as it stands when
 * the hook runs. A file the command points git at, by `include.path` or the
 * variables in CONFIG_FILE_VARS, may not exist yet, so any word could be an alias
 * under it; so under a `git config` touching an alias earlier in the command, and
 * where git could not say what its config holds.
 *
 * LIMITS: an alias written to a config file some other way earlier in the same
 * command is read as absent, and a tree that will not resolve has its repo's
 * aliases unread: the hook's own directory's are read in its place.
 */

const { literal } = require("./shell-words.js");

/** The `sub` of a call whose alias cannot be read; no git command has spaces. */
const UNREAD_ALIAS = "unread alias";

/**
 * @typedef {Map<string, string | null>} FileAliases each lowercased name's
 *   definition in the config files, null where it cannot be read
 */

/**
 * `git config -z --get-regexp ^alias\\.`'s output as a table: the last of a name
 * wins.
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
		const name = dot < 0 ? full : full.slice(0, dot);
		aliases.set(name, nl < 0 || dot >= 0 ? null : entry.slice(nl + 1));
	}
	return aliases;
}

/**
 * @typedef {object} AliasTable the aliases a command line defines
 * @property {Map<string, string | null>} named each lowercased name's last
 *   definition, null where it cannot be read
 * @property {boolean} anyUnread a definition whose name cannot be read, so any
 *   word could be an alias
 */

/* Commands no alias can shadow: each walk's judged ones, and those sessions run
 * all day (#4009). */
const BUILTINS = new Set(
	"add am apply archive bisect blame branch bundle cat-file check-ignore check-ref-format checkout cherry cherry-pick clean clone commit config count-objects describe diff diff-files diff-index diff-tree fetch for-each-ref fsck gc grep hash-object help init log ls-files ls-remote ls-tree merge merge-base merge-file merge-tree mktree mv name-rev notes pack-refs prune pull push range-diff read-tree rebase reflog remote repack rerere reset restore rev-list rev-parse revert rm shortlog show show-ref sparse-checkout stash status stripspace submodule switch symbolic-ref tag update-index update-ref var verify-commit version whatchanged worktree write-tree".split(
		" ",
	),
);

/* Where git finds a config file other than the repo's, each named by the command.
 * `/dev/null` holds no alias. */
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
	if (INCLUDE_KEY.test(lower)) table.anyUnread = true;
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
 * Read `GIT_CONFIG_PARAMETERS`, CONFIG_FILE_VARS and the
 * `GIT_CONFIG_KEY_<n>`/`VALUE_<n>` pairs of a command's environment onto `table`.
 * @param {AliasTable} table accumulator
 * @param {Map<string, string | null>} env each name's raw value word, null
 *   where it cannot be read
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
		/* Which of two definitions wins hangs on the indices, so neither is
		 * believed; nor is one past the count, which git ignores. */
		const defined = table.named.has(aliasNameOf(key.text));
		define(table, {
			key: key.known ? key.text : key.head,
			complete: key.known,
			value:
				value?.known && !defined && Number(n) < counted ? value.text : null,
		});
	}
}

/* An alias git hands to a shell (`!`), one opening on a git option, which git
 * refuses or reads apart, and one its own quoting splits. */
const UNREADABLE_VALUE = /^\s*(?:$|!|-)|['"\\]/;

/**
 * What `name` is an alias for: undefined where it is none, null where that
 * cannot be told.
 * @param {string} name lowercased
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
 * The subcommand and arguments `sub` comes to through `table` and the config
 * files. A word in `subs` or BUILTINS stops the walk. `sub` read as UNREAD_ALIAS
 * where the words cannot be told.
 * @param {string} sub read
 * @param {string[]} args raw
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
	CONFIG_FILE_VARS,
	expandAlias,
	isAliasKey,
	parseFileAliases,
	defineFromEnv,
	defineFromConfigEnvWord,
	defineFromConfigWord,
};
