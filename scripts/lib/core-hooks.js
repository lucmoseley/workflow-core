/*
 * core-hooks.js — the core's own registered hooks, read in one place (#2295).
 *
 * At the core's own checkout the registration is the self-plugin's file,
 * `self-plugin/hooks/hooks.json`, loaded in place as the `wfc-self` plugin,
 * plus the canary its `.claude/settings.json` keeps (#2473). At
 * an adopter host it is the host's `.claude/settings.json` hooks merged with
 * the core plugin's `hooks/hooks.json` (#940).
 */

const fs = require("node:fs");
const path = require("node:path");
const { coreRoot } = require("./script-path.js");
const { caught } = require("./caught.js");
const { mainCheckout } = require("./main-checkout.js");
const { writeFd } = require("./write-fd.js");
const { execGit } = require("./git.js");

const SELF_PLUGIN_DIR = "self-plugin";
const SELF_PLUGIN_HOOKS = `${SELF_PLUGIN_DIR}/hooks/hooks.json`;
const HOST_SETTINGS = ".claude/settings.json";
/* The core's scripts/ directory as a hook command spells it, in either form. */
const SCRIPT_PREFIX =
	/"\$CLAUDE_PROJECT_DIR"\/scripts\/|\$\{CLAUDE_PROJECT_DIR\}\/scripts\//g;
/* The self-plugin's session-marker writer. It feeds the canary in the core's
 * settings, so it registers in the self-plugin alone (#2438). */
const MARKER_WRITER = "write-self-plugin-marker.sh";
/* The self-plugin's marketplace and plugin are both `wfc-self` (#2295). */
const SELF_PLUGIN_MARKETPLACE = "wfc-self";
const SELF_PLUGIN_ID = `${SELF_PLUGIN_MARKETPLACE}@${SELF_PLUGIN_MARKETPLACE}`;
/* The one hook the core's settings keeps: a PreToolUse entry with no matcher
 * that refuses a session the self-plugin did not load (#2447). */
const CANARY_COMMAND = '"$CLAUDE_PROJECT_DIR"/scripts/self-plugin-canary.sh';

/**
 * @typedef {{type?: string, command?: string, args?: unknown, if?: string, timeout?: number, async?: boolean, [field: string]: unknown}} Hook
 * @typedef {Record<string, Array<{matcher?: string, hooks?: Hook[]}>>} Hooks
 * @typedef {Hook & {event: string, matcher?: string}} HookEntry
 */

/**
 * A hook file that is absent registers nothing, and says so unless `quiet`:
 * an adopter whose hooks all come from the plugin may carry no settings file
 * (#940). One that is present but unparseable still throws, naming the file,
 * since reading it as empty would report its hooks as never fired.
 * @param {string} p
 * @param {boolean} [quiet] for a reader to whom an absent settings file is
 *   an adopter's ordinary case, not news (#2462)
 * @returns {{hooks?: Hooks} | null} only `hooks` is read off the parsed file
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
 * Throws where an event of `hooks` holds anything but a list of matcher
 * groups, naming the event, where a reader iterating it would fail as a bare
 * TypeError (#2572).
 * @param {Hooks} hooks
 * @param {string} where the file, and the revision where one is read
 */
function listedEvents(hooks, where) {
	for (const [event, groups] of Object.entries(hooks))
		if (groups != null && !Array.isArray(groups))
			throw new Error(`${where}: its ${event} hooks are not a list`);
}

/**
 * Where the plugin registers its hooks: under the core, not in the host's
 * settings (#940).
 * @param {string} [core]
 * @returns {string}
 */
function pluginHooksFile(core = coreRoot()) {
	return path.join(core, "hooks", "hooks.json");
}

/**
 * The two files that register hooks for `host`, in merge order: its own
 * `.claude/settings.json`, then `pluginHooksFile(core)`.
 * @param {string} host
 * @param {string} [core] a program that reads its needles from beside itself
 *   passes that same root, so `WFC_SCRIPT_ROOT` cannot split the two reads
 * @param {boolean} [quiet] as `readHooksFile` takes it
 * @returns {Array<{file: string, settings: {hooks?: Hooks} | null}>}
 */
function readHookSources(host, core = coreRoot(), quiet = false) {
	return [path.join(host, HOST_SETTINGS), pluginHooksFile(core)].map(
		(file) => ({ file, settings: readHooksFile(file, quiet) }),
	);
}

/**
 * Several parsed hook files folded into one settings-shaped object, each
 * event's entries concatenated in source order.
 *
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
 * The text of `rel` under `root`, on disk or at `rev`; null where it is absent.
 * Any other failure to read throws.
 * @param {string} root
 * @param {string} rel
 * @param {string} [rev] a git revision; `""` names the index
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
		/* git's English stderr is the only sign the path is absent at `rev`; under
		 * another locale an absent file throws as unreadable instead. */
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
 * The `hooks` object of `text`, the JSON read from `rel` at `where`.
 * Malformed, or carrying no `hooks` object, throws; with `optional`, a file
 * carrying no `hooks` key registers none.
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
 * The `hooks` object of the JSON file `rel` under `root`, on disk or at `rev`.
 * Absent, malformed or carrying no `hooks` object throws.
 * @param {string} root
 * @param {string} rel
 * @param {string} [rev] a git revision; `""` names the index
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
 * Does `root` hold the core's own registration, the self-plugin's file? THE
 * ONE PLACE the core/adopter split is made (#2456).
 *
 * It does where `root` is the checkout `core`, compared through symlinks as a
 * host root is (a worktree of the core is its own `core`, since `coreRoot()` is
 * the checkout the script runs from). It does too where the tree carries the
 * self-plugin's file, on disk or at `rev`: `--against` measures a revision
 * materialised into a temporary directory, which identity cannot name the
 * core, and no adopter carries the file (#2445).
 * Residual: an adopter that vendored `self-plugin/` would read as the core
 * for every reader here.
 *
 * @param {string} root
 * @param {{rev?: string, core?: string}} [opts]
 * @returns {boolean}
 */
function isCoreRoot(root, { rev, core = coreRoot() } = {}) {
	return isSameDir(root, core) || hasPath(root, SELF_PLUGIN_HOOKS, rev);
}

/**
 * Is `rel` in the tree at `root`, on disk or at `rev`? Read from git's
 * listing, not its stderr, so the answer holds under any locale; a revision
 * git cannot list throws.
 * @param {string} root
 * @param {string} rel
 * @param {string} [rev] a git revision; `""` names the index
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
 * A path that does not exist resolves no link, so it is compared as written.
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
 * The files that register `host`'s hooks, each parsed, in merge order. At the
 * core that is the self-plugin's file, which throws where absent or malformed,
 * then `.claude/settings.json`, whose one hook is the canary (#2473), each at
 * `rev` where one is given. At an adopter it is `readHookSources`' pair, either
 * of which may be absent, read from disk; no caller reads an adopter at a
 * revision, so `rev` there throws. `quiet` reaches only the adopter's pair:
 * the core's settings file, absent, is read silently.
 *
 * @param {string} host
 * @param {{rev?: string, core?: string, quiet?: boolean}} [opts] `quiet` as
 *   `readHooksFile` takes it
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
 * `root`'s `.claude/settings.json`, on disk or at `rev`, reduced to its hooks;
 * null where it is absent. Absence is read from git's listing, as `hasPath`
 * reads it: `readTextAt` knows absence at a revision only by git's stderr, which
 * names a file absent from both index and disk in other words (#2473).
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
 * The hooks `root` runs, event to matcher groups: `readHostHookSources` merged.
 * @param {string} root
 * @param {{rev?: string, core?: string, quiet?: boolean}} [opts]
 * @returns {Hooks}
 */
function readRunningHooks(root, opts = {}) {
	return mergeHooks(readHostHookSources(root, opts)).hooks;
}

/**
 * The file a new hook of `root`'s own registers in: the self-plugin's at the
 * core, the host's `.claude/settings.json` anywhere else.
 * @param {string} root
 * @param {{rev?: string, core?: string}} [opts]
 * @returns {string} relative to `root`
 */
function ownHooksFile(root, opts = {}) {
	return isCoreRoot(root, opts) ? SELF_PLUGIN_HOOKS : HOST_SETTINGS;
}

/**
 * The files `root` registers its own hooks in, each parsed, in merge order,
 * without the plugin's that an adopter also runs (#2442). At the core that is
 * `readHostHookSources` (#2572). At an adopter it is the host's `.claude/settings.json` alone, null
 * where absent, and registering none where it carries no `hooks` key.
 *
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
 * The hooks `root` registers itself: `readOwnHookSources` merged. At the core an
 * absent self-plugin file throws; at an adopter an absent
 * settings file is null.
 *
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
 * A group or event that leaves empty goes with it; one already empty stays as
 * it stands (#2441).
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
 * The one-time, per-machine command that registers the self-plugin's
 * marketplace for the core checkout holding `root`. DUPLICATED BY HAND as
 * `setup` in scripts/self-plugin-canary.sh, which runs with no node.
 * @param {string} root
 * @returns {string}
 */
function selfPluginSetup(root) {
	/* Never a worktree: a marketplace registered at one breaks once the
	 * worktree is deleted (#2461). */
	const dir = `${mainCheckout(root) ?? "<absolute path to the main checkout>"}/${SELF_PLUGIN_DIR}`;
	return `claude plugin marketplace add '${dir.replace(/'/g, "'\\''")}' --scope user`;
}

/**
 * An `enabledPlugins` map with the self-plugin left out: it loads the core's
 * own guards, which an adopter does not carry, so its canary would refuse
 * every session there (#2440).
 * @template T
 * @param {Record<string, T>} enabled
 * @returns {Record<string, T>}
 */
function withoutSelfPlugin(enabled) {
	const { [SELF_PLUGIN_ID]: _, ...rest } = enabled;
	return rest;
}

/**
 * Every hook in `hooks`, one per `hooks[]` entry with every field it carries,
 * tagged with the event and matcher holding it.
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
	SCRIPT_PREFIX,
	SELF_PLUGIN_DIR,
	SELF_PLUGIN_HOOKS,
	SELF_PLUGIN_ID,
	SELF_PLUGIN_MARKETPLACE,
	readRunningHooks,
	flattenHooks,
	readHostHookSources,
	readHooksAt,
	isCoreRoot,
	mergeHooks,
	readOwnHookSources,
	readOwnHooks,
	readSettingsAt,
	ownHooksFile,
	pluginHooksFile,
	selfPluginSetup,
	withoutMarkerWriter,
	withoutSelfPlugin,
};
