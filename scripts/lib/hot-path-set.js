const path = require("node:path");
const { dataOrThrow } = require("./file-read.js");
const { relativeUnder } = require("./is-under.js");
const { requiredGroup } = require("./regex-group.js");
const { isRepoPathList } = require("./repo-path.js");

/**
 * @typedef {Pick<import("./guard-host-ports.js").TreePorts, "read"> & { isFile: (rel: string) => boolean }} TreeReader
 */

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

const COMMIT_HOOKS = [
	"pre-commit",
	"prepare-commit-msg",
	"commit-msg",
	"post-commit",
].flatMap((hook) => [`.husky/${hook}`, `.husky/${hook}.local`]);

const CORE_REGISTRY = "scripts/lib/guard-cores.json";

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

/** @param {string} rel */
const isHookRegistration = (rel) => REGISTRATIONS.has(rel);

const ROOT_VARS =
	/\$\{(?:CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|WFC_PLUGIN_ROOT)(?::-[^}]*)?\}|\$(?:CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|WFC_PLUGIN_ROOT)\b/g;
const TOKEN = /[\w.@+/-]+/g;
const CODE_EXTENSION = String.raw`\.(?:c?js|mjs|ts|sh|py)`;
const CODE_FILE = new RegExp(`${CODE_EXTENSION}$`);
const PROGRAM_SPELLING = new RegExp(
	`(?:^|/)(?:[^./]+|[^/]+${CODE_EXTENSION})$`,
);
const STRING_LITERAL = new RegExp(
	`(["'\`])([^"'\`\\s]+${CODE_EXTENSION})\\1`,
	"g",
);

/**
 * @param {string} root
 * @param {string} token
 * @param {string} [base]
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
	const text = dataOrThrow(port.read(rel));
	if (text === null) return null;
	try {
		const parsed = JSON.parse(text);
		return parsed !== null && typeof parsed === "object" ? parsed : null;
	} catch {
		// #5338
		return null;
	}
}

/**
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
 * @param {string} root
 * @param {TreeReader} port
 * @param {string} registry
 */
const rowsModules = (root, port, registry) =>
	[...(dataOrThrow(port.read(registry)) ?? "").matchAll(STRING_LITERAL)].map(
		(match) =>
			inTree(
				root,
				port,
				requiredGroup(match, 2, STRING_LITERAL),
				path.posix.dirname(registry),
			),
	);

/** @param {string} text */
const uncommented = (text) =>
	text
		.split("\n")
		.filter((line) => !/^\s*#/.test(line))
		.join("\n");

/**
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
 * @param {string} root
 * @param {TreeReader} port
 * @returns {string[]}
 */
function hotPathSet(root, port) {
	const found = [
		...HOOK_FILES.flatMap((file) =>
			perCallCommands(readJson(port, file)),
		).flatMap((line) => namedFiles(root, port, line)),
		...COMMIT_HOOKS.flatMap((hook) =>
			namedFiles(root, port, uncommented(dataOrThrow(port.read(hook)) ?? "")),
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
