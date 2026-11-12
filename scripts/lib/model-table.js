/*
 * model-table.js — the one table every model choice is translated through:
 * which model and effort a dispatch, a launch or a plan's session runs on.
 * The values are the routing file's, lib/model-routing.json, beside this one
 * (#5032).
 *
 * THE ROUTING FILE holds each `Agent`-tool alias's current model id and its
 * other names, and per mode (`standard`, `burn`) a row per alias naming the
 * alias it runs as and the effort it runs at (`null` keeping the call's),
 * the plans' session model and the per-model settings effort. Which mode
 * applies is the caller's: burn mode's marker, read through lib/burn-mode.js.
 * `WFC_MODEL_ROUTING` names another file, so a test never reads the real one.
 *
 * ONE SPELLING RULE. A spelling is an alias where it equals the alias, its
 * `id` or one of its `also` names, with or without a `[1m]` suffix. Any other
 * spelling passes through unchanged. A launch target is its alias's full id with
 * `[1m]`, since an alias has moved under this repo once already (#353); a
 * dispatch target is the bare alias, all the `Agent` tool takes.
 *
 * A dispatch naming no model inherits its session's, so a session launched
 * under burn mode would go on handing its model to subagents after `off`: in
 * standard mode a call inheriting a model the standard rows route away from
 * is pinned to that row (#4992).
 *
 * Effort rides with the dispatch remap on the call's own `effort` field, which
 * replaces an agent definition's `effort:` (forks excepted). A launch's effort
 * comes from settings.json's per-model `modelSettings`, read at session start,
 * which scripts/burn-mode.sh writes from the mode's `settings` (CLI below).
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { caught } = require("./caught.js");
const { coreRoot, docPath, scriptPath } = require("./script-path.js");
const { trimmed } = require("./trimmed.js");
const { writeFd } = require("./write-fd.js");

/** The routing file this module reads unless `WFC_MODEL_ROUTING` names another. */
const ROUTING_FILE = path.join(__dirname, "model-routing.json");

const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const MODES = ["standard", "burn"];
const LONG_CONTEXT = "[1m]";

/**
 * @typedef {{to: string, effort: string | null}} Row
 * @typedef {{session: string, modelSettings: Record<string, string>,
 *   route: Record<string, Row>}} Mode
 * @typedef {{models: Record<string, {id: string, also: string[]}>,
 *   modes: Record<"standard" | "burn", Mode>}} Routing
 */

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
function routingPath(env = process.env) {
	return env.WFC_MODEL_ROUTING || ROUTING_FILE;
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
const isObject = (v) =>
	v !== null && typeof v === "object" && !Array.isArray(v);

/** @param {unknown} v */
const isLevel = (v) => typeof v === "string" && LEVELS.includes(v);

/**
 * @param {unknown} v
 * @param {string[]} aliases
 */
const isAlias = (v, aliases) => typeof v === "string" && aliases.includes(v);

/**
 * The first fault the checks find, run in order; "" for none.
 * @param {Array<() => string>} checks
 */
function firstOf(checks) {
	for (const check of checks) {
		const fault = check();
		if (fault) return fault;
	}
	return "";
}

/**
 * @param {string} alias
 * @param {unknown} m its `models` entry
 * @param {Map<string, string>} seen every name read so far, to its alias
 */
function modelFault(alias, m, seen) {
	if (!isObject(m) || typeof m.id !== "string" || m.id === "")
		return `models.${alias} has no \`id\``;
	if (
		!Array.isArray(m.also) ||
		m.also.some((/** @type {unknown} */ a) => typeof a !== "string")
	)
		return `models.${alias}.also is not a list of names`;
	for (const name of [alias, m.id, .../** @type {string[]} */ (m.also)]) {
		const owner = seen.get(name);
		if (owner !== undefined && owner !== alias)
			return `\`${name}\` names both ${owner} and ${alias}`;
		seen.set(name, alias);
	}
	return "";
}

/**
 * @param {string} at
 * @param {unknown} modelSettings
 * @param {string[]} aliases
 */
function settingsFault(at, modelSettings, aliases) {
	if (!isObject(modelSettings)) return `${at}.modelSettings is missing`;
	for (const [alias, level] of Object.entries(modelSettings)) {
		if (!aliases.includes(alias))
			return `${at}.modelSettings.${alias} is not a known alias`;
		if (!isLevel(level))
			return `${at}.modelSettings.${alias} is not an effort level`;
	}
	return "";
}

/**
 * @param {string} at
 * @param {unknown} route
 * @param {string[]} aliases
 */
function routeFault(at, route, aliases) {
	if (!isObject(route)) return `${at}.route is missing`;
	const unknown = Object.keys(route).find((a) => !aliases.includes(a));
	if (unknown !== undefined)
		return `${at}.route.${unknown} is not a known alias`;
	for (const alias of aliases) {
		const row = route[alias];
		if (!isObject(row)) return `${at}.route has no row for ${alias}`;
		if (!isAlias(row.to, aliases))
			return `${at}.route.${alias}.to is not a known alias`;
		if (row.effort !== null && !isLevel(row.effort))
			return `${at}.route.${alias}.effort is neither an effort level nor null`;
	}
	return "";
}

/**
 * @param {string} name
 * @param {unknown} mode
 * @param {string[]} aliases
 */
function modeFault(name, mode, aliases) {
	const at = `modes.${name}`;
	if (!isObject(mode)) return `${at} is missing`;
	return firstOf([
		() =>
			isAlias(mode.session, aliases)
				? ""
				: `${at}.session is not a known alias`,
		() => settingsFault(at, mode.modelSettings, aliases),
		() => routeFault(at, mode.route, aliases),
	]);
}

/**
 * The first fault in a parsed routing file, or "" where it has none.
 * @param {unknown} r
 * @returns {string}
 */
function firstFault(r) {
	if (!isObject(r) || !isObject(r.models)) return "no `models` object";
	const { models, modes } = r;
	const aliases = Object.keys(models);
	if (aliases.length === 0) return "`models` names no alias";
	/** @type {Map<string, string>} */
	const seen = new Map();
	return firstOf([
		...aliases.map((alias) => () => modelFault(alias, models[alias], seen)),
		() => (isObject(modes) ? "" : "no `modes` object"),
		...MODES.map(
			(name) => () =>
				modeFault(name, isObject(modes) ? modes[name] : undefined, aliases),
		),
	]);
}

/** @type {Map<string, Routing>} */
const loaded = new Map();

/**
 * The routing file, read and shape-checked once per path.
 * @param {Record<string, string | undefined>} [env]
 * @returns {Routing}
 * @throws naming the file and its first fault
 */
function loadRouting(env = process.env) {
	const file = routingPath(env);
	const cached = loaded.get(file);
	if (cached) return cached;
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		throw new Error(`${file}: cannot be read — ${caught(e).message}`, {
			cause: e,
		});
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (e) {
		throw new Error(`${file}: will not read as JSON — ${caught(e).message}`, {
			cause: e,
		});
	}
	const fault = firstFault(parsed);
	if (fault) throw new Error(`${file}: ${fault}`);
	loaded.set(file, parsed);
	return parsed;
}

/**
 * @param {boolean} burn
 * @returns {Mode}
 */
function modeOf(burn) {
	return loadRouting().modes[burn ? "burn" : "standard"];
}

/**
 * The alias a spelling runs as, by the one spelling rule; "" for none.
 * @param {string} spelling
 * @returns {string}
 */
function aliasOf(spelling) {
	const s = spelling.trim();
	const bare = s.endsWith(LONG_CONTEXT) ? s.slice(0, -LONG_CONTEXT.length) : s;
	const { models } = loadRouting();
	for (const [alias, m] of Object.entries(models))
		if (bare === alias || bare === m.id || m.also.includes(bare)) return alias;
	return "";
}

/**
 * An alias's current model id.
 * @param {string} alias
 * @returns {string}
 * @throws where the routing file names no such alias
 */
function modelId(alias) {
	return modelOf(alias).id;
}

/**
 * An alias's entry in the routing file's models.
 * @param {string} alias
 * @throws where the routing file names no such alias
 */
function modelOf(alias) {
	const m = loadRouting().models[alias];
	if (!m) throw new Error(`${routingPath()}: no model \`${alias}\``);
	return m;
}

/**
 * A mode's row for an alias; the load check gives every alias one.
 * @param {boolean} burn
 * @param {string} alias
 * @throws where the mode has no row for the alias
 */
function rowOf(burn, alias) {
	const row = modeOf(burn).route[alias];
	if (!row) throw new Error(`${routingPath()}: no route for \`${alias}\``);
	return row;
}

/**
 * The standard row for the alias a spelling runs as; null where the file
 * does not recognise it.
 * @param {string} spelling
 */
function standardRoute(spelling) {
	const alias = aliasOf(spelling);
	return alias ? rowOf(false, alias) : null;
}

/**
 * An alias's launch spelling: its full id with the 1M suffix.
 * @param {string} alias
 */
function launchSpelling(alias) {
	return `${modelId(alias)}${LONG_CONTEXT}`;
}

/**
 * Whether a spelling is a model only burn mode puts work on: one the standard
 * rows route to another alias, and some burn row or the burn session runs on
 * (#4992).
 * @param {string} spelling
 * @returns {boolean}
 */
function isRoutedAway(spelling) {
	const alias = aliasOf(spelling);
	if (!alias) return false;
	if (rowOf(false, alias).to === alias) return false;
	const burn = modeOf(true);
	return (
		burn.session === alias ||
		Object.values(burn.route).some((row) => row.to === alias)
	);
}

/*
 * Burn mode never reaches an overflow seat (#4919). Its seats share the plans'
 * settings file, whose `model` burn mode moves, so its launch names the
 * overflow alias's model outright; and its child carries OVERFLOW_SESSION_VAR
 * set to its own session id, so the dispatch remap skips the burn mode there
 * and nowhere else — a session that child starts runs under another id.
 */
const OVERFLOW_ALIAS = "opus";
const OVERFLOW_SESSION_VAR = "WFC_OVERFLOW_SESSION";

/** What opens an overflow session's name, so its row says it spends API credits. */
const OVERFLOW_PREFIX = "Overflow · ";

/**
 * Whether a spelling may launch on an overflow seat: the overflow alias or
 * its current id, each bare or `[1m]`. A retired id is refused.
 * @param {string} spelling
 */
function isOverflowAdmitted(spelling) {
	const id = modelId(OVERFLOW_ALIAS);
	return [OVERFLOW_ALIAS, id]
		.flatMap((s) => [s, `${s}${LONG_CONTEXT}`])
		.includes(spelling);
}

/** The overflow seat's launch spelling. */
function overflowModel() {
	return launchSpelling(OVERFLOW_ALIAS);
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} session the session id the hook payload names
 * @returns {boolean} whether that session runs on an overflow seat
 */
function isOverflowSession(env, session) {
	const pinned = env[OVERFLOW_SESSION_VAR];
	return Boolean(pinned) && pinned === session;
}

/**
 * One launch spelling through the mode's row: the target's launch spelling,
 * or the spelling as given where the row keeps it on its own alias or the
 * file does not recognise it.
 * @param {string} model
 * @param {boolean} burn
 * @returns {string}
 */
function mapLaunch(model, burn) {
	const alias = aliasOf(model);
	if (!alias) return model;
	const { to } = rowOf(burn, alias);
	return to === alias ? model : launchSpelling(to);
}

/**
 * The model a plan's session runs on, its settings `model` read through the
 * mode's rows; "" or none meaning the mode's session model.
 * @param {string | undefined} model
 * @param {boolean} burn
 * @returns {string}
 */
function mapSessionModel(model, burn) {
	if (!model) return launchSpelling(modeOf(burn).session);
	return mapLaunch(model, burn);
}

/**
 * The settings a mode writes into every plan: its session model's launch
 * spelling, and the effort under each named alias's id and every `also` id.
 * @param {boolean} burn
 * @returns {{model: string, modelSettings: Record<string, {effortLevel: string}>}}
 */
function modeSettings(burn) {
	const mode = modeOf(burn);
	/** @type {Record<string, {effortLevel: string}>} */
	const modelSettings = {};
	for (const [alias, effortLevel] of Object.entries(mode.modelSettings)) {
		const m = modelOf(alias);
		for (const id of [m.id, ...m.also]) modelSettings[id] = { effortLevel };
	}
	return { model: launchSpelling(mode.session), modelSettings };
}

/**
 * A job's saved launch flags for a resume while burn mode is off: a saved
 * `--model` routed away in standard mode, saved by a launch under burn mode,
 * moved to the standard row's launch spelling, since resumed as saved it
 * brings that model back after `off` (#4992). Anything else, and every flag
 * under burn mode, comes back as the very array given, so a caller tells a
 * move by identity.
 * @param {string[]} flags
 * @param {boolean} burn whether burn mode's marker exists
 * @returns {string[]}
 */
function relaunchFlags(flags, burn) {
	if (burn) return flags;
	const found = parseModelFlag(flags);
	if (!found || !isRoutedAway(found.model)) return flags;
	const to = mapLaunch(found.model, false);
	const moved = found.width === 1 ? [`--model=${to}`] : ["--model", to];
	return [
		...flags.slice(0, found.at),
		...moved,
		...flags.slice(found.at + found.width),
	];
}

/**
 * Where a flag list names its `--model`, joined (`--model=x`, one element
 * wide) or split (`--model x`, two); null where it names none.
 * @param {string[]} flags
 * @returns {{at: number, width: 1 | 2, model: string} | null}
 */
function parseModelFlag(flags) {
	const at = flags.findIndex(
		(f) => f === "--model" || f.startsWith("--model="),
	);
	const flag = flags[at];
	if (flag === undefined) return null;
	if (flag !== "--model")
		return { at, width: 1, model: flag.slice("--model=".length) };
	const model = flags[at + 1];
	return model === undefined ? null : { at, width: 2, model };
}

/** The plugin's own agent definitions — the code reviewer's among them. */
const AGENTS_DIR = path.join(coreRoot(), ".claude", "agents");

/**
 * The `model:` an agent definition this plugin ships pins, for a call that
 * names none: the harness runs the definition's model then, so it is the
 * model to translate. A namespaced type (`wfc:code-reviewer`) is read by its
 * bare name; any other type, or a definition naming none, gives "".
 * @param {string} type
 * @returns {string}
 */
function readDefinitionModel(type) {
	const bare = type.replace(/^[\w-]+:/, "");
	if (!/^[\w-]+$/.test(bare)) return "";
	let text;
	try {
		text = fs.readFileSync(path.join(AGENTS_DIR, `${bare}.md`), "utf8");
	} catch {
		return "";
	}
	const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
	return /^model:\s*([\w-]+)\s*$/m.exec(front)?.[1] ?? "";
}

/**
 * The model one `Agent` call runs on, as the table must read it: its own
 * `model`, else the one its plugin definition pins; "" for a fork, which
 * ignores the field, and for a call inheriting the session's model.
 * @param {Record<string, unknown>} call
 * @returns {string}
 */
function dispatchedModel(call) {
	const type = trimmed(call.subagent_type);
	if (type === "fork") return "";
	const named = trimmed(call.model);
	if (named === "inherit") return "";
	return named || (type ? readDefinitionModel(type) : "");
}

/**
 * The model-table transform over one `Agent` call's input: the call with its
 * model and effort moved by the mode's row, and what the session is told, or
 * null where nothing changes — a fork (which ignores both fields), a spelling
 * the file does not know, or a row that keeps both model and effort.
 *
 * Every other field is carried through untouched, `updatedInput` replacing the whole
 * input.
 *
 * A call naming no model inherits the session's, and is left alone unless,
 * in standard mode, that model is routed away: then it is pinned to the
 * standard row (#4992).
 *
 * @param {unknown} input the tool_input object
 * @param {boolean} burn whether burn mode's marker exists
 * @param {string} [inherited] the session's own model, "" where unknown
 * @returns {null | {input: Record<string, unknown>, note: string}}
 */
function remapModel(input, burn, inherited = "") {
	if (input === null || typeof input !== "object") return null;
	const call = /** @type {Record<string, unknown>} */ (input);
	const from = dispatchedModel(call);
	return from
		? routeNamed(call, from, burn)
		: pinInherited(call, burn, inherited);
}

/** @param {string} effort */
const atEffort = (effort) => (effort ? ` at \`${effort}\`` : "");

/**
 * A call naming no model, pinned to the standard row in standard mode where
 * the session's model is routed away; null otherwise, and for a fork.
 * @param {Record<string, unknown>} call
 * @param {boolean} burn
 * @param {string} inherited
 */
function pinInherited(call, burn, inherited) {
	if (burn || trimmed(call.subagent_type) === "fork") return null;
	if (!isRoutedAway(inherited)) return null;
	const row = rowOf(false, aliasOf(inherited));
	const effort = row.effort ?? trimmed(call.effort);
	return {
		input: { ...call, model: row.to, ...(effort ? { effort } : {}) },
		note: `Burn mode is off, so this dispatch, which would have inherited this session's \`${inherited}\`, runs on \`${row.to}\`${atEffort(effort)} (#4992).`,
	};
}

/**
 * A call naming a model, or pinned one by its definition, moved by the mode's
 * row; null where the file does not know it or the row keeps both fields.
 * @param {Record<string, unknown>} call
 * @param {string} from
 * @param {boolean} burn
 */
function routeNamed(call, from, burn) {
	const asked = trimmed(call.effort);
	const alias = aliasOf(from);
	if (!alias) return null;
	const row = rowOf(burn, alias);
	const { to } = row;
	const effort = row.effort ?? asked;
	if (to === from && effort === asked) return null;
	const what = `\`${from}\`${atEffort(asked)} to \`${to}\`${atEffort(effort)}`;
	const standing = rowOf(false, alias);
	const burned =
		burn && (standing.to !== to || (standing.effort ?? asked) !== effort);
	return {
		input: { ...call, model: to, ...(effort ? { effort } : {}) },
		note: burned
			? `Burn mode moved this dispatch from ${what} (scripts/burn-mode.sh; \`${scriptPath("burn-mode.sh")} off\` ends it).`
			: `The standing model table moved this dispatch from ${what} (${scriptPath("lib/model-routing.json")}; ${docPath("effort-guide.md")} §Which model each subagent dispatch runs on).`,
	};
}

module.exports = {
	isOverflowSession,
	isRoutedAway,
	loadRouting,
	parseModelFlag,
	modelId,
	modeSettings,
	OVERFLOW_PREFIX,
	OVERFLOW_SESSION_VAR,
	overflowModel,
	relaunchFlags,
	remapModel,
	routingPath,
	standardRoute,
};

/*
 * CLI mode. Every mode exits 2 on a routing file that will not load, naming
 * it on stderr.
 *
 *   launch <spelling> [--burn]
 *                     prints the spelling to launch under the mode's rows
 *   session <model> [--burn]
 *                     the same for a plan's settings `model`, "" meaning the
 *                     mode's session model
 *   alias <spelling>  prints the alias the spelling runs as, or nothing
 *   admits <spelling> exits 0 where the spelling may launch on an overflow
 *                     seat, 1 where it may not
 *   settings [--burn] prints the mode's settings writes as JSON
 *
 * stdout is always a pipe here, so it is written synchronously before the
 * exit — process.stdout.write can be cut off by process.exit on a pipe.
 */
/**
 * Each CLI mode: the positionals it takes, whether it takes `--burn`, and its
 * run, printing through `say` and giving the exit code.
 * @type {Record<string, {arity: number, burn: boolean,
 *   run: (args: string[], burn: boolean, say: (s: string) => void) => number}>}
 */
const CLI = {
	launch: {
		arity: 1,
		burn: true,
		run: ([spelling = ""], burn, say) => {
			if (!spelling) return 2;
			say(mapLaunch(spelling, burn));
			return 0;
		},
	},
	session: {
		arity: 1,
		burn: true,
		run: ([model = ""], burn, say) => {
			say(mapSessionModel(model, burn));
			return 0;
		},
	},
	alias: {
		arity: 1,
		burn: false,
		run: ([spelling = ""], _burn, say) => {
			say(aliasOf(spelling));
			return 0;
		},
	},
	admits: {
		arity: 1,
		burn: false,
		run: ([spelling = ""]) => (isOverflowAdmitted(spelling) ? 0 : 1),
	},
	settings: {
		arity: 0,
		burn: true,
		run: (_args, burn, say) => {
			say(JSON.stringify(modeSettings(burn)));
			return 0;
		},
	},
};

/**
 * One CLI call's exit code.
 * @param {string[]} argv
 * @returns {number}
 */
function runCli(argv) {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		strict: true,
		options: { burn: { type: "boolean" } },
	});
	const [mode = "", ...args] = positionals;
	const burn = values.burn === true;
	const spec = Object.hasOwn(CLI, mode) ? CLI[mode] : undefined;
	if (!spec || args.length !== spec.arity || (burn && !spec.burn)) return 2;
	loadRouting();
	return spec.run(args, burn, (line) => writeFd(1, `${line}\n`));
}

if (require.main === module) {
	let code = 2;
	try {
		code = runCli(process.argv.slice(2));
	} catch (e) {
		writeFd(2, `model-table: ${caught(e).message}\n`);
		code = 2;
	}
	process.exit(code);
}
