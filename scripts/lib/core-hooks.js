const fs = require("node:fs");
const path = require("node:path");
const { coreRoot } = require("./script-path.js");
const { caught } = require("./caught.js");
const { mainCheckout } = require("./main-checkout.js");
const { writeFd } = require("./write-fd.js");
const { execGit } = require("./git.js");
const { shellQuote } = require("./sh-quote.js");
const { escapeRe } = require("./regex-group.js");

const SELF_PLUGIN_DIR = "self-plugin";
const SELF_PLUGIN_HOOKS = `${SELF_PLUGIN_DIR}/hooks/hooks.json`;
const HOST_SETTINGS = ".claude/settings.json";
const MAIN_SCRIPTS = `"\${CLAUDE_PLUGIN_ROOT}"/../scripts/`;
const CANARY_MAIN_SCRIPTS =
	'"$(git -C "$CLAUDE_PROJECT_DIR" rev-parse --path-format=absolute --git-common-dir)"/../scripts/';
const SCRIPT_PREFIX = new RegExp(
	`${escapeRe(MAIN_SCRIPTS)}|${escapeRe(CANARY_MAIN_SCRIPTS)}`,
	"g",
);
/** @param {string} command */
const toScriptsRel = (command) => command.replace(SCRIPT_PREFIX, "scripts/");
const PINNED_GUARD_PREFIX = new RegExp(
	escapeRe(
		`${MAIN_SCRIPTS}run-pinned-guards.js "\${WFC_GUARD_CODE_DIR:-$HOME/.claude/.guard-code}".current/scripts/`,
	),
	"g",
);
const MARKER_WRITER = "write-self-plugin-marker.sh";
const SELF_PLUGIN_MARKETPLACE = "wfc-self";
const SELF_PLUGIN_ID = `${SELF_PLUGIN_MARKETPLACE}@${SELF_PLUGIN_MARKETPLACE}`;

/** @param {string} dir */
const buildSelfMarketplaceEntry = (dir) => ({
	source: { source: "directory", path: dir },
	installLocation: dir,
});

const CANARY_COMMAND = `${CANARY_MAIN_SCRIPTS}self-plugin-canary.sh`;

/**
 * @typedef {{type?: string, command?: string, args?: unknown, if?: string, timeout?: number, async?: boolean, [field: string]: unknown}} Hook
 * @typedef {Record<string, Array<{matcher?: string, hooks?: Hook[]}>>} Hooks
 * @typedef {Hook & {event: string, matcher?: string}} HookEntry
 */

/**
 * @param {string} p
 * @param {boolean} [quiet]
 * @returns {{hooks?: Hooks} | null}
 */
function readHooksFile(p, quiet = false) {
	let parsed;
	try {
		parsed = JSON.parse(fs.readFileSync(p, "utf8"));
	} catch (e) {
		if (caught(e).code === "ENOENT") {
			if (!quiet) writeFd(2, `⚠ ${p} is absent — it registers no hook here.\n`);
			return null;
		}
		const what =
			e instanceof SyntaxError ? "is not valid JSON" : "cannot be read";
		throw new Error(`${p} ${what}: ${caught(e).message}`, { cause: e });
	}
	if (parsed?.hooks) listedEvents(parsed.hooks, p);
	return parsed;
}

/**
 * @param {Hooks} hooks
 * @param {string} where
 */
function listedEvents(hooks, where) {
	for (const [event, groups] of Object.entries(hooks))
		if (groups != null && !Array.isArray(groups))
			throw new Error(`${where}: its ${event} hooks are not a list`);
}

class MatcherError extends Error {
	/**
	 * @param {string} matcher
	 * @param {{cause: unknown}} options
	 */
	constructor(matcher, { cause }) {
		super(
			`the matcher ${JSON.stringify(matcher)} is not a valid regular expression: ${caught(cause).message}`,
			{ cause },
		);
		this.name = "MatcherError";
		this.matcher = matcher;
	}
}

/**
 * @param {string | undefined} matcher
 * @returns {(tool: string) => boolean}
 */
function buildToolCoverage(matcher) {
	if (matcher === undefined || matcher === "" || matcher === "*")
		return () => true;
	let re;
	try {
		re = new RegExp(`^(?:${matcher})$`);
	} catch (e) {
		throw new MatcherError(matcher, { cause: e });
	}
	return (tool) => re.test(tool);
}

/**
 * @param {string | undefined} matcher
 * @param {string} tool
 * @returns {boolean}
 */
function isToolCovered(matcher, tool) {
	return buildToolCoverage(matcher)(tool);
}

/**
 * @param {string} [core]
 * @returns {string}
 */
function pluginHooksFile(core = coreRoot()) {
	return path.join(core, "hooks", "hooks.json");
}

/**
 * @param {string} host
 * @param {string} [core]
 * @param {boolean} [quiet]
 * @returns {Array<{file: string, settings: {hooks?: Hooks} | null}>}
 */
function readHookSources(host, core = coreRoot(), quiet = false) {
	return [path.join(host, HOST_SETTINGS), pluginHooksFile(core)].map(
		(file) => ({ file, settings: readHooksFile(file, quiet) }),
	);
}

/**
 * @param {Array<{settings: {hooks?: Hooks} | null}>} sources
 * @returns {{hooks: Hooks}}
 */
function mergeHooks(sources) {
	/** @type {Hooks} */
	const hooks = {};
	for (const { settings } of sources)
		for (const [event, entries] of Object.entries(settings?.hooks ?? {}))
			hooks[event] = [...(hooks[event] ?? []), ...(entries ?? [])];
	return { hooks };
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {string} [rev]
 * @returns {string | null}
 */
function readTextAt(root, rel, rev) {
	try {
		return rev === undefined
			? fs.readFileSync(path.join(root, rel), "utf8")
			: execGit(["-C", root, "show", `${rev}:./${rel}`], {
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				});
	} catch (e) {
		const err = caught(e);
		if (
			err.code === "ENOENT" ||
			/does not exist in|exists on disk, but not in/.test(
				String(err.stderr ?? ""),
			)
		)
			return null;
		throw new Error(
			`${rel} cannot be read at ${whereOf(root, rev)}: ${err.message}`,
			{ cause: e },
		);
	}
}

/**
 * @param {string} root
 * @param {string} [rev]
 */
function whereOf(root, rev) {
	return rev === undefined ? root : `${rev || "the index"} in ${root}`;
}

/**
 * @param {string} text
 * @param {{rel: string, where: string, optional?: boolean}} from
 * @returns {Hooks}
 */
function parseHooks(text, { rel, where, optional = false }) {
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		throw new Error(
			`${rel} at ${where} is not valid JSON: ${caught(e).message}`,
			{ cause: e },
		);
	}
	const hooks = parsed?.hooks;
	if (optional && hooks === undefined) return {};
	if (hooks === null || typeof hooks !== "object" || Array.isArray(hooks))
		throw new Error(`${rel} at ${where} carries no hooks object`);
	listedEvents(hooks, `${rel} at ${where}`);
	return hooks;
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {string} [rev]
 * @returns {Hooks}
 */
function readHooksAt(root, rel, rev) {
	const where = whereOf(root, rev);
	const text = readTextAt(root, rel, rev);
	if (text === null)
		throw new Error(`${rel} cannot be read at ${where}: it is absent`);
	return parseHooks(text, { rel, where });
}

/**
 * @param {string} root
 * @param {{rev?: string, core?: string}} [opts]
 * @returns {boolean}
 */
function isCoreRoot(root, { rev, core = coreRoot() } = {}) {
	return isSameDir(root, core) || hasPath(root, SELF_PLUGIN_HOOKS, rev);
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {string} [rev]
 * @returns {boolean}
 */
function hasPath(root, rel, rev) {
	if (rev === undefined) return fs.existsSync(path.join(root, rel));
	const args =
		rev === ""
			? ["ls-files", "--cached", "--", rel]
			: ["ls-tree", "--name-only", rev, "--", rel];
	try {
		return (
			execGit(["-C", root, ...args], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}) !== ""
		);
	} catch (e) {
		throw new Error(
			`${rel} cannot be looked for at ${whereOf(root, rev)}: ${caught(e).message}`,
			{ cause: e },
		);
	}
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function isSameDir(a, b) {
	try {
		return fs.realpathSync(a) === fs.realpathSync(b);
	} catch {
		return path.resolve(a) === path.resolve(b);
	}
}

/**
 * @param {string} host
 * @param {{rev?: string, core?: string, quiet?: boolean}} [opts]
 * @returns {ReturnType<typeof readHookSources>}
 */
function readHostHookSources(
	host,
	{ rev, core = coreRoot(), quiet = false } = {},
) {
	if (isCoreRoot(host, { rev, core }))
		return [
			{
				file: path.join(host, SELF_PLUGIN_HOOKS),
				settings: { hooks: readHooksAt(host, SELF_PLUGIN_HOOKS, rev) },
			},
			{
				file: path.join(host, HOST_SETTINGS),
				settings: readSettingsAt(host, rev),
			},
		];
	if (rev !== undefined)
		throw new Error(
			`an adopter host is read from disk only, not at ${rev || "the index"}: ${host}`,
		);
	return readHookSources(host, core, quiet);
}

/**
 * @param {string} root
 * @param {string} [rev]
 * @returns {{hooks: Hooks} | null}
 */
function readSettingsAt(root, rev) {
	if (!hasPath(root, HOST_SETTINGS, rev)) return null;
	const text = readTextAt(root, HOST_SETTINGS, rev);
	if (text === null) return null;
	return {
		hooks: parseHooks(text, {
			rel: HOST_SETTINGS,
			where: whereOf(root, rev),
			optional: true,
		}),
	};
}

/**
 * @param {string} root
 * @param {{rev?: string, core?: string, quiet?: boolean}} [opts]
 * @returns {Hooks}
 */
function readRunningHooks(root, opts = {}) {
	return mergeHooks(readHostHookSources(root, opts)).hooks;
}

/**
 * @param {string} root
 * @param {{rev?: string, core?: string}} [opts]
 * @returns {string}
 */
function ownHooksFile(root, opts = {}) {
	return isCoreRoot(root, opts) ? SELF_PLUGIN_HOOKS : HOST_SETTINGS;
}

/**
 * @param {string} root
 * @param {{rev?: string, core?: string}} [opts]
 * @returns {ReturnType<typeof readHookSources>}
 */
function readOwnHookSources(root, { rev, core = coreRoot() } = {}) {
	if (isCoreRoot(root, { rev, core }))
		return readHostHookSources(root, { rev, core });
	return [
		{
			file: path.join(root, HOST_SETTINGS),
			settings: readSettingsAt(root, rev),
		},
	];
}

/**
 * @param {string} root
 * @param {{rev?: string, core?: string}} [opts]
 * @returns {Hooks | null}
 */
function readOwnHooks(root, opts = {}) {
	const sources = readOwnHookSources(root, opts);
	if (sources.every(({ settings }) => settings === null)) return null;
	return mergeHooks(sources).hooks;
}

/**
 * @param {Hook} h
 * @returns {boolean}
 */
function isMarkerWriter(h) {
	return (
		typeof h.command === "string" &&
		h.command.split(SCRIPT_PREFIX).some((after, i) => {
			if (i === 0) return false;
			const rest = after.slice(MARKER_WRITER.length);
			return after.startsWith(MARKER_WRITER) && !/^[\w.-]/.test(rest);
		})
	);
}

/**
 * @param {Hooks} hooks
 * @returns {Hooks}
 */
function withoutMarkerWriter(hooks) {
	/** @type {Hooks} */
	const out = {};
	for (const [event, groups] of Object.entries(hooks)) {
		const kept = groups.flatMap((group) => {
			const rest = (group.hooks ?? []).filter((h) => !isMarkerWriter(h));
			if (rest.length === 0 && (group.hooks ?? []).length > 0) return [];
			return [{ ...group, hooks: rest }];
		});
		if (kept.length > 0 || groups.length === 0) out[event] = kept;
	}
	return out;
}

/**
 * @param {string} root
 * @returns {string}
 */
function selfPluginSetup(root) {
	// #2461
	const dir = `${mainCheckout(root) ?? "<absolute path to the main checkout>"}/${SELF_PLUGIN_DIR}`;
	return `claude plugin marketplace add ${shellQuote(dir)} --scope user`;
}

/**
 * @template T
 * @param {Record<string, T>} enabled
 * @returns {Record<string, T>}
 */
function withoutSelfPlugin(enabled) {
	const { [SELF_PLUGIN_ID]: _, ...rest } = enabled;
	return rest;
}

/**
 * @param {Hooks} hooks
 * @returns {HookEntry[]}
 */
function flattenHooks(hooks) {
	return Object.entries(hooks).flatMap(([event, entries]) =>
		(entries ?? []).flatMap((entry) =>
			(entry?.hooks ?? []).map((h) => ({
				event,
				...(entry.matcher === undefined ? {} : { matcher: entry.matcher }),
				...h,
			})),
		),
	);
}

module.exports = {
	CANARY_COMMAND,
	HOST_SETTINGS,
	MARKER_WRITER,
	MatcherError,
	PINNED_GUARD_PREFIX,
	SCRIPT_PREFIX,
	SELF_PLUGIN_DIR,
	SELF_PLUGIN_HOOKS,
	SELF_PLUGIN_ID,
	SELF_PLUGIN_MARKETPLACE,
	buildToolCoverage,
	readRunningHooks,
	toScriptsRel,
	flattenHooks,
	readHostHookSources,
	readHooksAt,
	isCoreRoot,
	isToolCovered,
	mergeHooks,
	readOwnHookSources,
	readOwnHooks,
	readSettingsAt,
	buildSelfMarketplaceEntry,
	ownHooksFile,
	pluginHooksFile,
	selfPluginSetup,
	withoutMarkerWriter,
	withoutSelfPlugin,
};
