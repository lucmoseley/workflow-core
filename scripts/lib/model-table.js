const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { caught } = require("./caught.js");
const { coreRoot, docPath, scriptPath } = require("./script-path.js");
const { trimmed } = require("./trimmed.js");
const { writeFd } = require("./write-fd.js");

const ROUTING_FILE = path.join(__dirname, "model-routing.json");

const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const MODES = ["standard", "burn"];
const LONG_CONTEXT = "[1m]";

/**
 * @typedef {{to: string, effort: string | null}} Row
 * @typedef {{route: Record<string, Row>}} Mode
 * @typedef {{models: Record<string, {id: string, also: string[]}>,
 *   session: string, modelSettings: Record<string, string>,
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
 * @param {unknown} m
 * @param {Map<string, string>} seen
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
 * @param {unknown} modelSettings
 * @param {string[]} aliases
 */
function settingsFault(modelSettings, aliases) {
	if (!isObject(modelSettings)) return "`modelSettings` is missing";
	for (const [alias, level] of Object.entries(modelSettings)) {
		if (!aliases.includes(alias))
			return `modelSettings.${alias} is not a known alias`;
		if (!isLevel(level)) return `modelSettings.${alias} is not an effort level`;
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
	return routeFault(at, mode.route, aliases);
}

/**
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
		() => (isAlias(r.session, aliases) ? "" : "`session` is not a known alias"),
		() => settingsFault(r.modelSettings, aliases),
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
 * @param {Record<string, string | undefined>} [env]
 * @returns {Routing}
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
 * @param {string} alias
 * @returns {string}
 */
function modelId(alias) {
	return modelOf(alias).id;
}

/** @param {string} alias */
function modelOf(alias) {
	const m = loadRouting().models[alias];
	if (!m) throw new Error(`${routingPath()}: no model \`${alias}\``);
	return m;
}

/**
 * @param {boolean} burn
 * @param {string} alias
 */
function rowOf(burn, alias) {
	const row = modeOf(burn).route[alias];
	if (!row) throw new Error(`${routingPath()}: no route for \`${alias}\``);
	return row;
}

/** @param {string} spelling */
function standardRoute(spelling) {
	const alias = aliasOf(spelling);
	return alias ? rowOf(false, alias) : null;
}

/** @param {string} alias */
function launchSpelling(alias) {
	return `${modelId(alias)}${LONG_CONTEXT}`;
}

/**
 * @param {string} spelling
 * @returns {boolean}
 */
function isRoutedAway(spelling) {
	const alias = aliasOf(spelling);
	if (!alias) return false;
	if (rowOf(false, alias).to === alias) return false;
	return Object.values(modeOf(true).route).some((row) => row.to === alias);
}

// workflow-core#4919
const OVERFLOW_ALIAS = "opus";
const OVERFLOW_SESSION_VAR = "WFC_OVERFLOW_SESSION";

const OVERFLOW_PREFIX = "Overflow · ";

/** @param {string} spelling */
function isOverflowAdmitted(spelling) {
	const id = modelId(OVERFLOW_ALIAS);
	return [OVERFLOW_ALIAS, id]
		.flatMap((s) => [s, `${s}${LONG_CONTEXT}`])
		.includes(spelling);
}

function overflowModel() {
	return launchSpelling(OVERFLOW_ALIAS);
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} session
 * @returns {boolean}
 */
function isOverflowSession(env, session) {
	const pinned = env[OVERFLOW_SESSION_VAR];
	return Boolean(pinned) && pinned === session;
}

/**
 * @param {string} model
 * @returns {string}
 */
function mapLaunch(model) {
	const alias = aliasOf(model);
	if (!alias) return model;
	const { to } = rowOf(false, alias);
	return to === alias ? model : launchSpelling(to);
}

/**
 * @param {string | undefined} model
 * @returns {string}
 */
function mapSessionModel(model) {
	if (!model) return launchSpelling(loadRouting().session);
	return mapLaunch(model);
}

/**
 * @returns {{model: string, modelSettings: Record<string, {effortLevel: string}>}}
 */
function buildPlanSettings() {
	const routing = loadRouting();
	/** @type {Record<string, {effortLevel: string}>} */
	const modelSettings = {};
	for (const [alias, effortLevel] of Object.entries(routing.modelSettings)) {
		const m = modelOf(alias);
		for (const id of [m.id, ...m.also]) modelSettings[id] = { effortLevel };
	}
	return { model: launchSpelling(routing.session), modelSettings };
}

/**
 * @param {string[]} flags
 * @returns {string[]}
 */
function relaunchFlags(flags) {
	const found = parseModelFlag(flags);
	if (!found || !isRoutedAway(found.model)) return flags;
	const to = mapLaunch(found.model);
	const moved = found.width === 1 ? [`--model=${to}`] : ["--model", to];
	return [
		...flags.slice(0, found.at),
		...moved,
		...flags.slice(found.at + found.width),
	];
}

/**
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

const AGENTS_DIR = path.join(coreRoot(), ".claude", "agents");

/**
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
 * @param {unknown} input
 * @param {boolean} burn
 * @param {string} [inherited]
 * @returns {null | {input: Record<string, unknown>, note: string}}
 */
function remapModel(input, burn, inherited = "") {
	if (input === null || typeof input !== "object") return null;
	const call = /** @type {Record<string, unknown>} */ (input);
	const from = dispatchedModel(call);
	return from ? routeNamed(call, from, burn) : pinInherited(call, inherited);
}

/** @param {string} effort */
const atEffort = (effort) => (effort ? ` at \`${effort}\`` : "");

/**
 * @param {Record<string, unknown>} call
 * @param {string} inherited
 */
function pinInherited(call, inherited) {
	if (trimmed(call.subagent_type) === "fork") return null;
	if (!isRoutedAway(inherited)) return null;
	const row = rowOf(false, aliasOf(inherited));
	const effort = row.effort ?? trimmed(call.effort);
	return {
		input: { ...call, model: row.to, ...(effort ? { effort } : {}) },
		note: `This dispatch, which would have inherited this session's \`${inherited}\`, runs on \`${row.to}\`${atEffort(effort)}: the standing model table routes \`${inherited}\` work there (workflow-core#4992).`,
	};
}

/**
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
	buildPlanSettings,
	OVERFLOW_PREFIX,
	OVERFLOW_SESSION_VAR,
	overflowModel,
	relaunchFlags,
	remapModel,
	routingPath,
	standardRoute,
};

/**
 * @type {Record<string, {arity: number,
 *   run: (args: string[], say: (s: string) => void) => number}>}
 */
const CLI = {
	launch: {
		arity: 1,
		run: ([spelling = ""], say) => {
			if (!spelling) return 2;
			say(mapLaunch(spelling));
			return 0;
		},
	},
	session: {
		arity: 1,
		run: ([model = ""], say) => {
			say(mapSessionModel(model));
			return 0;
		},
	},
	alias: {
		arity: 1,
		run: ([spelling = ""], say) => {
			say(aliasOf(spelling));
			return 0;
		},
	},
	admits: {
		arity: 1,
		run: ([spelling = ""]) => (isOverflowAdmitted(spelling) ? 0 : 1),
	},
	settings: {
		arity: 0,
		run: (_args, say) => {
			say(JSON.stringify(buildPlanSettings()));
			return 0;
		},
	},
};

/**
 * @param {string[]} argv
 * @returns {number}
 */
function runCli(argv) {
	const { positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		strict: true,
	});
	const [mode = "", ...args] = positionals;
	const spec = Object.hasOwn(CLI, mode) ? CLI[mode] : undefined;
	if (!spec || args.length !== spec.arity) return 2;
	loadRouting();
	return spec.run(args, (line) => writeFd(1, `${line}\n`));
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
