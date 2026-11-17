/*
 * hot-path-set.js — the programs base §G13 calls hot-path in one tree, and
 * the files that register them (#5335): a program a per-tool-call hook entry
 * runs, the status line's, one a per-commit git hook runs, a module a hook
 * or git-hook dispatcher's registry names, and one the config declares
 * `polled`.
 *
 * A core: every read goes through the port, and each source is read as data,
 * never loaded, so a registry's own load set is never paid for. Paths are
 * read lexically: a path built in a variable goes unseen, and every token
 * that resolves to a file in the tree counts, an argument's included.
 *
 * `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}` and `$WFC_PLUGIN_ROOT`
 * (with any `:-` default) read as the tree root, and so does a leading `../`,
 * which a `.husky` hook spells as `$(dirname "$0")/..`.
 */

const path = require("node:path");
const { requiredGroup } = require("./regex-group.js");

/**
 * @typedef {{
 *   readText: (rel: string) => string | null,
 *   isFile: (rel: string) => boolean,
 * }} TreeReader a tree's file text by its path from the root, null where it
 *   is absent; and whether that path is a regular file
 */

/** The events a hook entry runs on per tool call. */
const PER_CALL_EVENTS = [
	"PreToolUse",
	"PostToolUse",
	"PostToolUseFailure",
	"PostToolBatch",
];

const HOOK_FILES = [
	".claude/settings.json",
	".claude/settings.local.json",
	"hooks/hooks.json",
	"self-plugin/hooks/hooks.json",
];

/** The git hooks git runs on each commit, each with its adopter companion. */
const COMMIT_HOOKS = [
	"pre-commit",
	"prepare-commit-msg",
	"commit-msg",
	"post-commit",
].flatMap((hook) => [`.husky/${hook}`, `.husky/${hook}.local`]);

/** The PreToolUse/PostToolUse dispatcher's core registry; its paths are
 *  spelt from its own directory. */
const CORE_REGISTRY = "scripts/lib/guard-cores.json";

/** The git-hook dispatchers' rows registries. */
const ROWS_REGISTRIES = [
	"scripts/lib/precommit-gates.js",
	"scripts/lib/prepare-commit-msg-rows.js",
	"scripts/lib/commit-msg-rows.js",
	"scripts/lib/post-commit-rows.js",
];

const CONFIG = ".claude/workflow-core.json";

const REGISTRATIONS = new Set([
	...HOOK_FILES,
	...COMMIT_HOOKS,
	CORE_REGISTRY,
	...ROWS_REGISTRIES,
]);

/**
 * Whether `rel`, a path from the tree root with `/`, is a file that
 * registers hot-path programs: a write to one binds §G13 whatever it adds.
 * @param {string} rel
 */
const isHookRegistration = (rel) => REGISTRATIONS.has(rel);

const ROOT_VARS =
	/\$\{(?:CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|WFC_PLUGIN_ROOT)(?::-[^}]*)?\}|\$(?:CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|WFC_PLUGIN_ROOT)\b/g;
const TOKEN = /[\w.@+/-]+/g;
/* A program's spelling: a code extension, or none. A data file a hook names
 * (a config, a doc a gate reads) is no program. */
const PROGRAM_NAME = /(?:^|\/)(?:[^./]+|[^/]+\.(?:c?js|mjs|ts|sh|py))$/;
const STRING_LITERAL = /(["'`])([^"'`\s]+\.(?:c?js|mjs|ts|sh|py))\1/g;

/**
 * `token`'s path from the tree root, or null where it names none. A
 * relative spelling joins `base`.
 * @param {string} root
 * @param {string} token
 * @param {string} [base] the directory a `./` or `../` spelling starts from;
 *   absent, every leading `./`, `../` and `/` is the root
 */
function fromRoot(root, token, base) {
	let rel;
	if (base !== undefined && /^\.\.?\//.test(token))
		rel = path.posix.join(base, token);
	else if (token.startsWith(`${root}/`)) rel = token.slice(root.length + 1);
	else rel = token.replace(/^(?:\.{0,2}\/)+/, "");
	rel = path.posix.normalize(rel);
	return rel === "." || rel.startsWith("../") || rel === ".." ? null : rel;
}

/** @param {unknown} v @returns {any[]} */
const list = (v) => (Array.isArray(v) ? v : []);

/**
 * `token` as a file in the tree, by its path from the root, or null.
 * @param {string} root
 * @param {TreeReader} port
 * @param {string} token
 * @param {string} [base]
 */
function inTree(root, port, token, base) {
	const rel = fromRoot(root, token, base);
	return rel !== null && port.isFile(rel) ? rel : null;
}

/**
 * Each program `text` names that is a file in the tree.
 * @param {string} root
 * @param {TreeReader} port
 * @param {string} text
 * @returns {(string|null)[]}
 */
const namedFiles = (root, port, text) =>
	[...text.replace(ROOT_VARS, "").matchAll(TOKEN)]
		.map(([token]) => token)
		.filter((token) => /[/.]/.test(token) && PROGRAM_NAME.test(token))
		.map((token) => inTree(root, port, token));

/**
 * @param {TreeReader} port
 * @param {string} rel
 * @returns {Record<string, unknown> | null}
 */
function readJson(port, rel) {
	const text = port.readText(rel);
	if (text === null) return null;
	try {
		const parsed = JSON.parse(text);
		return parsed !== null && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * The command lines a settings-shaped file runs per tool call, an exec
 * form's arguments included, and its status line's.
 * @param {Record<string, any>} settings
 * @returns {string[]}
 */
const perCallCommands = (settings) =>
	[
		...PER_CALL_EVENTS.flatMap((event) => list(settings.hooks?.[event]))
			.flatMap((entry) => list(entry?.hooks))
			.flatMap((hook) => [hook?.command, list(hook?.args).join(" ")]),
		settings.statusLine?.command,
	].filter((line) => typeof line === "string");

/**
 * Every module the core registry names, `core` and `host` alike, spelt from
 * the registry's own directory.
 * @param {string} root
 * @param {TreeReader} port
 */
const registryModules = (root, port) =>
	Object.values(readJson(port, CORE_REGISTRY) ?? {})
		.flatMap(list)
		.flatMap((row) => [row?.core, row?.host])
		.filter((name) => typeof name === "string")
		.map((name) =>
			inTree(root, port, `./${name}`, path.posix.dirname(CORE_REGISTRY)),
		);

/**
 * Every module a rows registry names as a string literal, a `require` or a
 * row's `script`.
 * @param {string} root
 * @param {TreeReader} port
 * @param {string} registry
 */
const rowsModules = (root, port, registry) =>
	[...(port.readText(registry) ?? "").matchAll(STRING_LITERAL)].map((match) =>
		inTree(
			root,
			port,
			requiredGroup(match, 2, STRING_LITERAL),
			path.posix.dirname(registry),
		),
	);

/** A shell file's text less its comment lines, which name paths it never runs.
 * @param {string} text */
const uncommented = (text) =>
	text
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");

/**
 * The config's `polled` entries that are files in the tree. The config
 * reader is not loaded here, since it reaches for git; an entry it would
 * refuse is skipped.
 * @param {string} root
 * @param {TreeReader} port
 */
const polledFiles = (root, port) =>
	list(readJson(port, CONFIG)?.polled)
		.filter(
			(entry) =>
				typeof entry === "string" &&
				!entry.startsWith("/") &&
				!entry.split(/[\\/]/).includes(".."),
		)
		.map((entry) => inTree(root, port, entry));

/**
 * The tree's hot-path programs, by path from `root`, sorted.
 * @param {string} root the tree root, absolute
 * @param {TreeReader} port
 * @returns {string[]}
 */
function hotPathSet(root, port) {
	const found = [
		...HOOK_FILES.flatMap((file) =>
			perCallCommands(readJson(port, file) ?? {}),
		).flatMap((line) => namedFiles(root, port, line)),
		...COMMIT_HOOKS.flatMap((hook) =>
			namedFiles(root, port, uncommented(port.readText(hook) ?? "")),
		),
		...registryModules(root, port),
		...ROWS_REGISTRIES.flatMap((registry) => rowsModules(root, port, registry)),
		...polledFiles(root, port),
	];
	return [
		...new Set(/** @type {string[]} */ (found.filter((rel) => rel !== null))),
	].sort();
}

module.exports = { hotPathSet, isHookRegistration };
