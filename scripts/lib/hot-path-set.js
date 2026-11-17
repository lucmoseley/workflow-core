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
 * spelt as a program (a code extension or none) that resolves to a file in
 * the tree counts, an argument's included.
 *
 * `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}` and `$WFC_PLUGIN_ROOT`
 * (with any `:-` default) read as the tree root, and so does a leading `../`
 * in a hook line, which a `.husky` hook spells as `$(dirname "$0")/..`; a
 * registry's own `./` or `../` starts from the registry's directory.
 */

const path = require("node:path");
const { relativeUnder } = require("./is-under.js");
const { requiredGroup } = require("./regex-group.js");
const { isRepoPathList } = require("./repo-path.js");

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
const CODE_EXTENSION = String.raw`\.(?:c?js|mjs|ts|sh|py)`;
/** A path ending in a program's code extension. */
const CODE_FILE = new RegExp(`${CODE_EXTENSION}$`);
/** A path spelt as something that runs — a code extension, or none — whatever
 *  its code kind under base §0. */
const PROGRAM_SPELLING = new RegExp(
	`(?:^|/)(?:[^./]+|[^/]+${CODE_EXTENSION})$`,
);
const STRING_LITERAL = new RegExp(
	`(["'\`])([^"'\`\\s]+${CODE_EXTENSION})\\1`,
	"g",
);

/**
 * `token`'s path from the tree root, or null where it names none.
 * @param {string} root
 * @param {string} token
 * @param {string} [base] the directory a `./` or `../` spelling starts from;
 *   absent, every leading `./`, `../` and `/` is the root
 */
function fromRoot(root, token, base) {
	const under = path.isAbsolute(token) ? relativeUnder(root, token) : null;
	let rel;
	if (base !== undefined && /^\.\.?\//.test(token))
		rel = path.posix.join(base, token);
	else if (under) rel = under;
	else rel = token.replace(/^(?:\.{0,2}\/)+/, "");
	const inside = relativeUnder(root, path.join(root, rel));
	return inside ? inside.split(path.sep).join("/") : null;
}

/** @param {unknown} v @returns {unknown[]} */
const list = (v) => (Array.isArray(v) ? v : []);

/**
 * @param {unknown} v
 * @param {string} key
 * @returns {unknown}
 */
const field = (v, key) =>
	v !== null && typeof v === "object"
		? /** @type {Record<string, unknown>} */ (v)[key]
		: undefined;

/** @param {unknown} v @returns {v is string} */
const isString = (v) => typeof v === "string";

/**
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
 * Each program `text` names: its path in the tree, or null where none.
 * @param {string} root
 * @param {TreeReader} port
 * @param {string} text
 * @returns {(string|null)[]}
 */
const namedFiles = (root, port, text) =>
	[...text.replace(ROOT_VARS, "").matchAll(TOKEN)]
		.map(([token]) => token)
		.filter((token) => /[/.]/.test(token) && PROGRAM_SPELLING.test(token))
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
		/* Fail open (#5338): a source that will not parse names no program,
		 * and nothing is said here. The injector
		 * must never block a write; a write to a broken hook file or registry
		 * is told §G13 as a registration whatever it holds; and each file's
		 * own loader (the harness, a dispatcher, the config reader) reports
		 * the break. */
		return null;
	}
}

/**
 * The command lines a settings-shaped file runs per tool call, an exec
 * form's arguments included, and its status line's.
 * @param {unknown} settings
 * @returns {string[]}
 */
const perCallCommands = (settings) =>
	[
		...PER_CALL_EVENTS.flatMap((event) =>
			list(field(field(settings, "hooks"), event)),
		)
			.flatMap((entry) => list(field(entry, "hooks")))
			.flatMap((hook) => [
				field(hook, "command"),
				list(field(hook, "args")).join(" "),
			]),
		field(field(settings, "statusLine"), "command"),
	].filter(isString);

/**
 * Every module the core registry names, `core` and `host` alike.
 * @param {string} root
 * @param {TreeReader} port
 */
const registryModules = (root, port) =>
	Object.values(readJson(port, CORE_REGISTRY) ?? {})
		.flatMap(list)
		.flatMap((row) => [field(row, "core"), field(row, "host")])
		.filter(isString)
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
 * The config's `polled` entries that are files in the tree, none where the
 * config reader would refuse the key.
 * @param {string} root
 * @param {TreeReader} port
 */
function polledFiles(root, port) {
	const polled = field(readJson(port, CONFIG), "polled");
	return isRepoPathList(polled)
		? polled.map((entry) => inTree(root, port, entry))
		: [];
}

/**
 * The tree's hot-path programs, by path from `root`, sorted.
 * @param {string} root the tree root, absolute
 * @param {TreeReader} port
 * @returns {string[]}
 */
function hotPathSet(root, port) {
	const found = [
		...HOOK_FILES.flatMap((file) =>
			perCallCommands(readJson(port, file)),
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

module.exports = {
	CODE_FILE,
	PROGRAM_SPELLING,
	hotPathSet,
	isHookRegistration,
};
