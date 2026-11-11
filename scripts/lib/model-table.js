/*
 * model-table.js — the one table every model choice is translated through:
 * which model and effort a dispatch, a launch or a plan's session runs on.
 *
 * THREE LAYERS, applied in order (#4919):
 *
 *   standing — always on. Work the effort guide once routed to Sonnet 5.5
 *              runs on Haiku 5.5 at xhigh, so a `sonnet` dispatch or launch
 *              spelling is moved to Haiku.
 *   burn     — only while burn mode's marker exists (lib/burn-mode.js). Haiku
 *              work runs on Opus 5.5 at medium, and Opus work, the code
 *              reviewer's included, on Fable 5.2 at medium.
 *   off      — only while it does not: a Fable dispatch or launch spelling
 *              is moved to Opus, so Fable runs under burn mode alone (#4992).
 *
 * Each function takes whether burn applies as an argument; reading the marker
 * is the caller's.
 *
 * A dispatch naming no model inherits its session's, so a session launched
 * under burn mode would go on handing Fable to its subagents after `off`:
 * with the marker gone, a call inheriting Fable is pinned to Opus (#4992).
 *
 * Effort rides with the dispatch remap on the call's own `effort` field, which
 * replaces an agent definition's `effort:` (forks excepted). A launch's effort comes
 * from settings.json's per-model `modelSettings`, read at session start.
 *
 * The maps are exact-match on purpose. An `Agent` call takes only the four
 * bare aliases, so a suffix there is impossible; a launch spelling this table
 * does not know passes through unchanged rather than being guessed at.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const { coreRoot, docPath, scriptPath } = require("./script-path.js");
const { trimmed } = require("./trimmed.js");
const { writeFd } = require("./write-fd.js");

/*
 * Launch spellings: the full ids with the 1M suffix, because the `opus` alias
 * moved under this repo once already (#353).
 */
const LAUNCH_HAIKU = "claude-haiku-5-5[1m]";
const LAUNCH_OPUS = "claude-opus-5-5[1m]";
const LAUNCH_FABLE = "claude-fable-5-2[1m]";

/** What settings.json's `model` means when it names none: plain Opus. */
const SESSION_DEFAULT = LAUNCH_OPUS;

/*
 * Burn mode never reaches an overflow seat (#4919). Its seats share the plans'
 * settings file, whose `model` burn mode moves, so its launch names this model
 * outright; and its child carries OVERFLOW_SESSION_VAR set to its own session
 * id, so the dispatch remap skips the burn layer there and nowhere else — a
 * session that child starts runs under another id.
 */
const OVERFLOW_MODEL = LAUNCH_OPUS;
const OVERFLOW_SESSION_VAR = "WFC_OVERFLOW_SESSION";

/** What opens an overflow session's name, so its row says it spends API credits. */
const OVERFLOW_PREFIX = "Overflow · ";

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} session the session id the hook payload names
 * @returns {boolean} whether that session runs on an overflow seat
 */
function isOverflowSession(env, session) {
	const pinned = env[OVERFLOW_SESSION_VAR];
	return Boolean(pinned) && pinned === session;
}

/** The effort each layer's target runs at on a dispatch: the founder's ruling (#4919). */
const STANDING_EFFORT = "xhigh";
const BURN_EFFORT = "medium";

const DISPATCH_HAIKU = "haiku";

const DISPATCH_OPUS = "opus";

const DISPATCH = {
	standing: new Map([["sonnet", DISPATCH_HAIKU]]),
	off: new Map([["fable", DISPATCH_OPUS]]),
	burn: new Map([
		[DISPATCH_HAIKU, "opus"],
		["opus", "fable"],
	]),
};

/** Every Fable spelling a launch, a settings `model` or a transcript carries. */
const FABLE_SPELLINGS = [
	"fable",
	"fable[1m]",
	"claude-fable-5",
	"claude-fable-5[1m]",
	"claude-fable-5-1",
	"claude-fable-5-1[1m]",
	"claude-fable-5-2",
	"claude-fable-5-2[1m]",
];

/**
 * @param {string} model a model id as a transcript or a launch spells it
 * @returns {boolean} whether it runs as Fable
 */
function isFable(model) {
	return FABLE_SPELLINGS.includes(model.trim());
}

/**
 * Launch spellings `scripts/dispatch-sessions.sh` and the plans' settings
 * `model` may hold. `opusplan` outside plan mode resolves to plain Sonnet
 * (docs/effort-guide.md), so it is Sonnet here.
 */
const LAUNCH = {
	standing: new Map(
		[
			"sonnet",
			"sonnet[1m]",
			"claude-sonnet-5",
			"claude-sonnet-5[1m]",
			"claude-sonnet-5-5",
			"claude-sonnet-5-5[1m]",
			"opusplan",
			"opusplan[1m]",
		].map((m) => [m, LAUNCH_HAIKU]),
	),
	off: new Map(
		FABLE_SPELLINGS.map(
			(m) => /** @type {[string, string]} */ ([m, LAUNCH_OPUS]),
		),
	),
	burn: new Map([
		...["haiku", "haiku[1m]", "claude-haiku-5-5", "claude-haiku-5-5[1m]"].map(
			(m) => /** @type {[string, string]} */ ([m, LAUNCH_OPUS]),
		),
		...[
			"opus",
			"opus[1m]",
			"claude-opus-5",
			"claude-opus-5[1m]",
			"claude-opus-5-5",
			"claude-opus-5-5[1m]",
		].map((m) => /** @type {[string, string]} */ ([m, LAUNCH_FABLE])),
	]),
};

/**
 * One model through a table's standing layer, then its burn layer where burn
 * applies and its off layer where it does not; a spelling none knows comes
 * back as given.
 * @param {{standing: Map<string, string>, burn: Map<string, string>,
 *   off: Map<string, string>}} table
 * @param {string} model
 * @param {boolean} burn
 * @returns {string}
 */
function mapModel(table, model, burn) {
	const standing = table.standing.get(model) ?? model;
	const layer = burn ? table.burn : table.off;
	return layer.get(standing) ?? standing;
}

/**
 * The model a plan's session runs on, its settings `model` read through the
 * launch table; "" or none meaning the default session model.
 * @param {string | undefined} model
 * @param {boolean} burn
 * @returns {string}
 */
function mapSessionModel(model, burn) {
	return mapModel(LAUNCH, model || SESSION_DEFAULT, burn);
}

/**
 * A job's saved launch flags for a resume while burn mode is off: a Fable
 * `--model`, saved by a launch under burn mode, moved to Opus, since resumed
 * as saved it brings Fable back after `off` (#4992). Anything else, and every
 * flag under burn mode, comes back as the very array given, so a caller tells
 * a move by identity.
 * @param {string[]} flags
 * @param {boolean} burn whether burn mode's marker exists
 * @returns {string[]}
 */
function relaunchFlags(flags, burn) {
	if (burn) return flags;
	const at = flags.findIndex(
		(f) => f === "--model" || f.startsWith("--model="),
	);
	if (at === -1) return flags;
	const flag = flags[at] ?? "";
	const joined = flag.startsWith("--model=");
	const saved = joined ? flag.slice("--model=".length) : flags[at + 1];
	if (saved === undefined || !isFable(saved)) return flags;
	const moved = joined ? [`--model=${LAUNCH_OPUS}`] : ["--model", LAUNCH_OPUS];
	return [
		...flags.slice(0, at),
		...moved,
		...flags.slice(at + (joined ? 1 : 2)),
	];
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
 * @param {string} from
 * @param {string} asked the effort the call named, "" for none
 * @param {boolean} burn
 * @returns {{to: string, effort: string}}
 */
function translate(from, asked, burn) {
	const to = mapModel(DISPATCH, from, burn);
	const standing = DISPATCH.standing.get(from) ?? from;
	if (burn && to !== standing) return { to, effort: BURN_EFFORT };
	if (to === DISPATCH_HAIKU) return { to, effort: STANDING_EFFORT };
	return { to, effort: asked };
}

/**
 * The model-table transform over one `Agent` call's input: the call with its
 * model and effort moved, and what the session is told, or null where nothing
 * changes — no model named nor pinned by a definition (the session's model is
 * inherited), a fork (which ignores both fields), or a model neither layer
 * moves and an effort already set.
 *
 * Every other field is carried through untouched, `updatedInput` replacing the whole
 * input.
 *
 * A call inheriting Fable while burn mode is off is the exception: it is
 * pinned to `opus` (#4992).
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
	if (!from) {
		if (burn || !isFable(inherited) || trimmed(call.subagent_type) === "fork")
			return null;
		return {
			input: { ...call, model: DISPATCH_OPUS },
			note: `Burn mode is off, so this dispatch, which would have inherited this session's \`${inherited}\`, runs on \`${DISPATCH_OPUS}\` (#4992).`,
		};
	}
	const asked = trimmed(call.effort);
	const { to, effort } = translate(from, asked, burn);
	if (to === from && effort === asked) return null;
	const moved = { ...call, model: to, ...(effort ? { effort } : {}) };
	const what = `\`${from}\`${asked ? ` at \`${asked}\`` : ""} to \`${to}\` at \`${effort}\``;
	return {
		input: moved,
		note: burn
			? `Burn mode moved this dispatch from ${what} (scripts/burn-mode.sh; \`${scriptPath("burn-mode.sh")} off\` ends it).`
			: `The standing model table moved this dispatch from ${what} (${scriptPath("lib/model-table.js")}; ${docPath("effort-guide.md")} §Which model each subagent dispatch runs on).`,
	};
}

module.exports = {
	isFable,
	isOverflowSession,
	OVERFLOW_MODEL,
	OVERFLOW_PREFIX,
	OVERFLOW_SESSION_VAR,
	relaunchFlags,
	remapModel,
	SESSION_DEFAULT,
	mapSessionModel,
};

/*
 * CLI mode.
 *
 *   launch <model> [--burn]
 *                     prints the spelling to launch: the standing layer, then
 *                     burn mode's where --burn is given
 *   session <model> [--burn]
 *                     the same for a plan's settings `model`, "" meaning the
 *                     default session model
 *
 * stdout is always a pipe here, so it is written synchronously before the
 * exit — process.stdout.write can be cut off by process.exit on a pipe.
 */
if (require.main === module) {
	const say = (/** @type {string} */ s) => writeFd(1, `${s}\n`);
	try {
		const { values, positionals } = parseArgs({
			allowPositionals: true,
			strict: true,
			options: { burn: { type: "boolean" } },
		});
		const [mode, arg] = positionals;
		const burn = values.burn === true;
		if (mode === "launch" && arg !== undefined && arg !== "") {
			say(mapModel(LAUNCH, arg, burn));
			process.exit(0);
		}
		if (mode === "session" && arg !== undefined) {
			say(mapSessionModel(arg, burn));
			process.exit(0);
		}
		process.exit(2);
	} catch {
		process.exit(2);
	}
}
