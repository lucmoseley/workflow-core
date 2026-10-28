/*
 * rule-emission.js — the rule bytes ONE SESSION can be made to pay through
 * each PreToolUse tool (route (f)), and through each hook that fires once its
 * call has run.
 *
 * THE UNIT IS THE SESSION, NOT THE EVENT (mantahostels#2046). An `injectRules`
 * id latches per (rule, agent, session) — lib/guard-entry.js's latchPath — so
 * it is delivered once in a session's life however many events could carry
 * it. What a session can be made to pay through one tool is therefore the sum
 * of the DISTINCT ids every guard that tool wires can reach.
 *
 * For a hook wiring, a set of guard sources and a fragment store: what is the
 * byte total each PreToolUse tool can be made to deliver over a session
 * (reachableByTool), and what each AFTER_EVENTS hook can (reachableAfterCall,
 * #2144).
 *
 * THE ARITHMETIC:
 *   one guard   = the sum of its own DISTINCT ids' fragment bytes, over every
 *                 emission it makes — never the maximum over emissions, because
 *                 two mutually exclusive branches are still both reachable
 *                 across a session's many events;
 *   one tool    = the sum over the UNION of the ids its wired guards reach, so
 *                 an id two guards both name is counted once, the latch making
 *                 the second guard's call a no-op;
 *   the ratchet = the same union taken across every wired guard at once.
 *
 * A DIRECT `rule_text` CALL IS NOT PRICED HERE (mantahostels#2055). The figures are route
 * (f)'s, and docs/doc-map.md §Capture and placement §3 defines that route as a
 * guard injecting the rule BEFORE the call it governs; a guard that composes the
 * text itself is delivering on the branch where it has already fired, which is
 * route (e) and owes no shed. Those calls are censused instead, as `direct`
 * below.
 *
 * WHICH IDS A GUARD REACHES IS READ FROM ITS EFFECTIVE SOURCE (mantahostels#2488) — its own
 * text plus every lib it `source`s or `require`s, transitively.
 *
 * WHAT IT CANNOT SEE: a call whose id is a VARIABLE (`rule_text "$id"`, the
 * shape at lib/rule-text.sh), and a lib behind a path this cannot resolve —
 * see §sourcedLibs.
 *
 * A DECISION'S `skip` DOES NOT ENTER IT. A skip sits behind its own condition
 * on the command in front of the guard, so a ceiling must assume it does not
 * fire, and an id deferred past RULE_CAP on one event simply arrives on a
 * later one.
 *
 * JOINS ARE NOT COUNTED. The separator is 2 B per fragment beyond the
 * first IN ONE DELIVERY, and how a session's ids fall across deliveries is not
 * statically knowable. The omission is under 2 B per id.
 *
 * KEYED ON TOOL NAMES, NOT MATCHER STRINGS. Matchers overlap — `Bash` and
 * `Bash|Read|ListAgents` both cover `Bash` — so a per-matcher figure would
 * under-report every overlapping group.
 *
 * WHY NOT IMPORT hook-wiring.ts. It is TypeScript and the consuming checker is
 * a plain-Node CLI that cannot require it.
 */

const fs = require("node:fs");
const path = require("node:path");

const { readRuleText } = require("./rule-text");
const { hostRoot } = require("./host-root.js");
const { moduleOn } = require("./workflow-core-config");
const { requiredGroup } = require("./regex-group.js");
const { caught } = require("./caught.js");
const { readOwnHooks } = require("./core-hooks.js");
const { AFTER_EVENTS } = require("./hook-events.js");
const { blankComments, closeOf, statementEnd } = require("./js-lex.js");
const {
	expandDispatched,
	manifestAt,
	readManifest,
} = require("./guard-cores.js");

/*
 * CAP_FILE names hook-limits.sh, which ships beside this file, so it is reached
 * from THIS DIRECTORY and a plugin install still finds it (#1). Every other root
 * below — the hook wiring, and the guard sources its commands point at — is
 * host content and reads through hostRoot().
 */
const CAP_FILE = path.join(__dirname, "hook-limits.sh");

/** The event a pre-emptive emission rides, and the only one route (f)'s caps price (spec
 * mantahostels#1932). */
const EVENT = "PreToolUse";

/** Where RULE_CAP is assigned, relative to the repo root. */
const CAP_SOURCE = path.join("scripts", "lib", "hook-limits.sh");

const RULE_ID = "(?:rule:)?[a-z0-9]+(?:-[a-z0-9]+)*";
/**
 * The pre-emptive emission, a Node guard core's `{ injectRules: [<id>…] }`
 * decision, which lib/guard-entry.js latches and caps (#2784). Shared with
 * scripts/check-guard-registry.js so the two readings cannot drift. The ids
 * must be quoted literals in the array: one held in a constant is invisible.
 */
const INJECT_RULES_RE = new RegExp(
	`\\binjectRules:\\s*\\[((?:\\s*["']${RULE_ID}["']\\s*,?)+)\\s*\\]`,
	"g",
);

/**
 * An injectRules key, never a `.injectRules` read; a shorthand key included.
 * Residual: a destructure (`{ injectRules } = d`) and a mention inside a
 * string literal match too, and so read as unread — the safe direction.
 */
const INJECT_RULES_KEY_RE = /(?<![\w$.])injectRules(?=\s*[:,}])/g;
/* INJECT_RULES_RE admits no empty array, which emits nothing and is no
 * unread injection either. */
const LITERAL_INJECTION_RE = new RegExp(
	`(?:${INJECT_RULES_RE.source}|injectRules:\\s*\\[\\s*\\])`,
	"y",
);

/**
 * Where `text` first hands injectRules something other than a literal id
 * array — a variable, a spread, a shorthand key — whose ids no scan can read
 * (#3011), or undefined.
 * @param {string} text
 * @returns {number | undefined}
 */
function firstUnreadInjection(text) {
	return [...text.matchAll(INJECT_RULES_KEY_RE)]
		.map((m) => m.index ?? 0)
		.find((at) => {
			LITERAL_INJECTION_RE.lastIndex = at;
			return !LITERAL_INJECTION_RE.test(text);
		});
}

/**
 * Every pre-emptive emission in `text`; group 1 holds the ids.
 * @param {string} text
 */
const emissionMatches = (text) => [...text.matchAll(INJECT_RULES_RE)];

/**
 * The bare ids in one emission's id run.
 *
 * ONE optional `rule:` comes off, because the latch bares one (mantahostels#2719).
 */
const RULE_ARG_RE = /["']?(?:rule:)?([a-z0-9]+(?:-[a-z0-9]+)*)["']?/g;

/**
 * The DIRECT accessor call — a shell hook's `rule_text <id>`, or
 * concision-backstop.sh's `rule_or_path <id>`, which wraps it with a logged
 * pointer fallback (#3439) — which splices the fragment into text the hook
 * composes itself.
 *
 * UNANCHORED: the call sits inside a condition rather than at the head of its
 * own statement. The cost is that a mention in a comment matches, which
 * over-reports the census.
 */
const DIRECT_RULE_RE =
	/\brule_(?:text|or_path)\s+(?:"(?:rule:)?([a-z0-9-]+)"|'(?:rule:)?([a-z0-9-]+)'|(?:rule:)?([a-z0-9-]+))/g;
/**
 * The Node accessors' direct call, the id a quoted literal first, split across
 * lines as Biome formats it: `readRuleText`, `readRuleTextOr`, and `ruleText`,
 * a core's injected port onto readRuleText (lib/guard-entry.js) (#2905); and
 * lib/guard-verdict.js's `ruleOrFallback`, the id second after the core's
 * context (#3146).
 */
const NODE_DIRECT_RULE_RE =
	/\b(?:(?:readRuleText|readRuleTextOr|ruleText)\(|ruleOrFallback\(\s*[\w.]+\s*,)\s*["']([a-z0-9-]+)["']\s*[),]/g;

/**
 * The bound on a direct call: a Node core's `ctx.told("<id>")`, which asks
 * whether this session has already been handed the fragment the core is about
 * to compose (mantahostels#2275). A core that asks pays the fragment once a
 * session rather than once per firing. The id must be a literal at the call:
 * one held in a constant, or a `told` destructured off the receiver, reads as
 * no bound — the safe direction.
 *
 * A BOUND IS CREDITED only where the guard makes exactly ONE direct call on the
 * id AND marks it at exactly ONE emission site (mantahostels#2283,
 * mantahostels#2354). Two or more of either read as `ambiguous`, as does a
 * bound with no emission site at all — see §emissionSites.
 */
const LATCHED_RULE_RE = /\bctx\.told\(\s*["'](?:rule:)?([a-z0-9-]+)["']\s*\)/g;

/**
 * The other half of the bound: a `latchAfter: "<id>"` decision, which
 * lib/guard-entry.js writes once the envelope is out. A `ctx.told` with no
 * matching mark never becomes true, so the bound is stranded permanently and
 * the fragment is paid on every firing.
 *
 * UNANCHORED, since the key sits inside an object literal anywhere on its
 * line. A mention inside a string counts as a mark and as an emission site,
 * which can invent a bound.
 */
const MARKED_RULE_RE = /\blatchAfter:\s*["'](?:rule:)?([a-z0-9-]+)["']/g;

/**
 * A Node guard core's module gates, lib/rule-gates.js's `ruleModule(ctx,
 * "<module>", [<id>…])`, which skips the ids unless the host has <module> on
 * (#449), and `ruleUnlessModule`, which skips them where it is on (#2409,
 * #2785). Anchored at the line's head, a spread allowed, so a mention in a
 * comment reads as none.
 */
const MODULE_RULE_RE = new RegExp(
	`^[ \\t]*(?:\\.\\.\\.)?rule(Module|UnlessModule)\\(\\s*\\w+\\s*,\\s*["']([a-z]+)["']\\s*,\\s*\\[((?:\\s*["']${RULE_ID}["']\\s*,?)+)\\s*\\]`,
	"gm",
);

/**
 * A repo-relative script path inside a hook command string.
 *
 * There are two house spellings (mantahostels#2059): the shell form
 * `"$CLAUDE_PROJECT_DIR"/scripts/x.sh` and the exec form
 * `${CLAUDE_PROJECT_DIR}/scripts/x.sh`, which carries an `args` key. Both put a
 * slash immediately before the path, which is why the preceding character class
 * admits `/`; it admits whitespace for the `node scripts/x.js` spelling.
 * Shared with scripts/check-guard-registry.js, which reads the same settings
 * file to decide which script a command wires.
 *
 * Every caller runs it over buildHookCommandLine() below rather than over `command`
 * alone (mantahostels#2266), so the interpreter spelling — `"command": "node", "args":
 * ["…/scripts/x.js"]` — has its path seen rather than reading as unwired.
 */
const WIRED_SCRIPT_RE =
	/(?:^|[\s"'/=([])((?:scripts|\.husky|\.claude)\/[\w.-]+(?:\/[\w.-]+)*\.(?:sh|js|mjs|cjs|ts))/g;

/**
 * A tool name as a matcher may spell one. Anything else in an alternation — a
 * character class, a wildcard, an empty match-all — names no tool and so opens
 * no group of its own, while still covering the groups it matches.
 */
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * The settings-shaped hook wiring this module reads, `{ hooks }`. Deliberately looser
 * than scripts/lib/hook-wiring.ts's SettingsShape: an event key this module
 * does not know still parses, because a group must never vanish through a
 * narrow type.
 *
 * @typedef {{ hooks?: Record<string, Array<{ matcher?: string, hooks?: Array<{ command?: string, args?: unknown }> }>> }} Settings
 */

/** One hook registration, flattened out of the entry carrying its matcher.
 * @typedef {{ matcher: string | undefined, commandLine: string }} Registration */

/**
 * One hook entry as the single command line it runs — `command` and the exec
 * form's `args` joined, which is the spelling both forms share and the one the
 * transcript records (mantahostels#2266).
 *
 * Shared with scripts/check-guard-registry.js on WIRED_SCRIPT_RE's own grounds,
 * stated above it.
 *
 * The hooks file is untyped JSON, so an `args` that is not an array of
 * strings contributes nothing rather than throwing.
 *
 * @param {{ command?: string, args?: unknown }} entry
 * @returns {string}
 */
function buildHookCommandLine(entry) {
	const args = Array.isArray(entry?.args)
		? entry.args.filter((a) => typeof a === "string")
		: [];
	return [entry?.command ?? "", ...args].join(" ");
}

/** One contributing guard, as reachableByTool reports it. `ids` are the
 * distinct rule ids it can reach and `bytes` their total — which may overlap
 * another guard's, so a tool's own figure is the union and not this sum.
 * @typedef {{ file: string, bytes: number, calls: number, ids: string[] }} GuardFigure */

/**
 * Whether a wired script is a Node guard, whose core is reached by `require`.
 * @param {string} rel
 */
const isNodeGuard = (rel) => rel.endsWith(".js");

/** Thrown where an input this module reads the repo WITH cannot be read, or
 * where an emission it reads can never fire at all. */
class RuleEmissionError extends Error {
	/**
	 * @param {string} message
	 * @param {ErrorOptions} [options]
	 */
	constructor(message, options) {
		super(message, options);
		this.name = "RuleEmissionError";
	}
}

/**
 * A bare `NAME=<digits>` assignment at column zero of a bash library, the
 * shape the limits are read in rather than restated.
 *
 * @param {string} file absolute path of the assigning file
 * @param {string} name
 * @returns {number}
 * @throws {RuleEmissionError} where the file cannot be read, or holds no
 *   anchored assignment — never a default, which would pass a group that will
 *   really be truncated.
 */
function readShellInt(file, name) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		throw new RuleEmissionError(
			`rule-emission: cannot read ${file}, where ${name} is assigned: ${caught(e).message}`,
			{ cause: e },
		);
	}
	const m = new RegExp(`^[ \\t]*${name}=(\\d+)[ \\t]*$`, "m").exec(text);
	if (!m)
		throw new RuleEmissionError(
			`rule-emission: no anchored ${name}=<digits> assignment in ${file}, ` +
				"and the ceiling is read rather than restated here, so there is no fallback.",
		);
	return Number(m[1]);
}

/**
 * RULE_CAP, read out of lib/hook-limits.sh.
 *
 * @param {string} [file] absolute path of the assigning file
 * @returns {number} the ceiling in bytes
 */
function readRuleCap(file = CAP_FILE) {
	return readShellInt(file, "RULE_CAP");
}

/**
 * HOOK_PERSIST_CHARS: the characters of additionalContext the harness keeps
 * inline per hook entry, read out of lib/hook-limits.sh.
 *
 * @returns {number}
 */
function readHookPersistChars() {
	return readShellInt(CAP_FILE, "HOOK_PERSIST_CHARS");
}

/**
 * Every pre-emptive emission in one guard's source, as its list of ids.
 *
 * An emission naming the same id twice yields it once, matching the latch,
 * which renders an id once per decision.
 *
 * @param {string} text the guard's source
 * @returns {string[][]} one entry per emission, ids in the order given
 */
function ruleCalls(text) {
	/** @type {string[][]} */
	const calls = [];
	for (const m of emissionMatches(text)) {
		/** @type {string[]} */
		const ids = [];
		for (const a of (m[1] ?? "").matchAll(RULE_ARG_RE))
			if (a[1] && !ids.includes(a[1])) ids.push(a[1]);
		if (ids.length > 0) calls.push(ids);
	}
	return calls;
}

/**
 * The ids one guard's source gates off for the host at <root>: through
 * `ruleModule` on a module it has off, and through `ruleUnlessModule` on one
 * it has on.
 *
 * @param {string} text the guard's source
 * @param {string} root the host root whose config decides
 * @returns {Set<string>}
 */
function gatedOffIds(text, root) {
	/** @type {Set<string>} */
	const off = new Set();
	for (const m of text.matchAll(MODULE_RULE_RE)) {
		/* Unchecked cast: moduleOn itself throws on a name it does not know. */
		const module = /** @type {import("./workflow-core-config").Module} */ (
			m[2]
		);
		const gatesIn = m[1] === "Module";
		if (moduleOn(module, { root }) === gatesIn) continue;
		for (const a of (m[3] ?? "").matchAll(RULE_ARG_RE)) if (a[1]) off.add(a[1]);
	}
	return off;
}

/**
 * Every DIRECT accessor call in one source, shell and Node spellings alike, as
 * the id it fetches and where the call starts. Shared with
 * scripts/check-guard-registry.js.
 *
 * @param {string} text
 * @returns {{ id: string, index: number }[]}
 */
function directAccessorCalls(text) {
	/** @type {{ id: string, index: number }[]} */
	const calls = [];
	for (const re of [DIRECT_RULE_RE, NODE_DIRECT_RULE_RE])
		for (const m of text.matchAll(re)) {
			const id = m[1] ?? m[2] ?? m[3];
			if (id) calls.push({ id, index: m.index ?? 0 });
		}
	return calls;
}

/**
 * Every DIRECT accessor call in one guard's source, as id → how many CALL
 * SITES name it, in the order given.
 *
 * @param {string} text the guard's source
 * @returns {Map<string, number>}
 */
function directRuleCounts(text) {
	/** @type {Map<string, number>} */
	const counts = new Map();
	for (const { id } of directAccessorCalls(text))
		counts.set(id, (counts.get(id) ?? 0) + 1);
	return counts;
}

/** A Node binding's head: `const|let|var <name> =` or `function <name>(`. */
const NODE_BINDING_RE =
	/\b(?:(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=(?!=)|function[ \t]+([A-Za-z_$][\w$]*)[ \t]*\()/g;

/** A function expression's head, at the start of a variable's value, up to
 * its body's `{` or a concise arrow's `({`. */
const NODE_FUNCTION_VALUE_RE =
	/^\s*(?:async\s+)?(?:function\b[^(]*\([^)]*\)\s*|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*)(?=\{|\(\s*\{)/;

/**
 * @typedef {object} NodeBinding
 * @property {string} name
 * @property {[number, number]} head the declaration, `const <name> =` or
 *   `function <name>(`
 * @property {[number, number][]} values the stretches whose value the name
 *   takes
 */

/**
 * Where a function body opening at `open` returns a value, as spans: each
 * `return` statement bar one returning an object literal. A function that
 * returns a decision spending the fetch — a core's `decide` — carries nothing
 * on, so the kit passing that decision around is no spend.
 *
 * @param {string} text
 * @param {number} open the body's `{`
 * @returns {[number, number][]}
 */
function returnSpans(text, open) {
	const body = bracketed(text, open);
	return [...body.matchAll(/\breturn\b(?![ \t]*\{)/g)].map((r) => {
		const from = (r.index ?? 0) + r[0].length;
		return [open + from, open + statementEnd(body, from)];
	});
}

/**
 * Where a binding's value sits. A function declaration, or a variable
 * holding a function with a body, takes its non-literal returns
 * (returnSpans); an arrow returning an object literal, `=> ({ … })`, takes
 * none; any other variable takes its whole statement.
 *
 * @param {string} text
 * @param {RegExpMatchArray} m a NODE_BINDING_RE match
 * @returns {[number, number][]}
 */
function valueSpans(text, m) {
	const at = (m.index ?? 0) + m[0].length;
	if (!m[1]) return returnSpans(text, text.indexOf("{", closeOf(text, at - 1)));
	const end = statementEnd(text, at);
	const fn = NODE_FUNCTION_VALUE_RE.exec(text.slice(at, end));
	if (!fn) return [[at, end]];
	const open = at + fn[0].length;
	return text[open] === "{" ? returnSpans(text, open) : [];
}

/**
 * @param {string} text
 * @returns {NodeBinding[]}
 */
function nodeBindings(text) {
	return [...text.matchAll(NODE_BINDING_RE)].map((m) => {
		const index = m.index ?? 0;
		return {
			name: m[1] ?? requiredGroup(m, 2, NODE_BINDING_RE),
			head: [index, index + m[0].length],
			values: valueSpans(text, m),
		};
	});
}

/**
 * The bracketed text opening at `open`, through its closing bracket or the end
 * of the text; empty where `open` is -1.
 *
 * @param {string} text
 * @param {number} open
 * @returns {string}
 */
function bracketed(text, open) {
	if (open === -1) return "";
	const end = closeOf(text, open);
	return text.slice(open, end === -1 ? text.length : end);
}

/**
 * The offset of each accessor call on `id` and each carrier mention in a Node
 * source.
 *
 * @param {string} text
 * @param {string} id
 * @param {Set<string>} carriers
 * @returns {number[]}
 */
function fetchMentions(text, id, carriers) {
	const at = directAccessorCalls(text)
		.filter((c) => c.id === id)
		.map((c) => c.index);
	for (const name of carriers)
		for (const m of text.matchAll(
			new RegExp(`(?<![\\w$.])${name.replaceAll("$", "\\$")}(?![\\w$])`, "g"),
		))
			at.push(m.index ?? 0);
	return at;
}

/**
 * The names in a Node source whose value can hold the fetch of `id`.
 *
 * @param {string} text
 * @param {NodeBinding[]} bindings
 * @param {string} id
 * @returns {Set<string>}
 */
function nodeCarriers(text, bindings, id) {
	/** @type {Set<string>} */
	const carriers = new Set();
	for (let grew = true; grew; ) {
		grew = false;
		for (const { name, values } of bindings) {
			const value = values.map(([a, b]) => text.slice(a, b)).join("\n");
			if (
				!carriers.has(name) &&
				fetchMentions(value, id, carriers).length > 0
			) {
				carriers.add(name);
				grew = true;
			}
		}
	}
	return carriers;
}

/**
 * The object literal around each `latchAfter: "<id>"` mark: the nearest `{`
 * before it whose closing brace falls after it, never an outer one.
 *
 * @param {string} text
 * @param {string} id
 * @returns {[number, number][]}
 */
function latchedLiterals(text, id) {
	/** @type {[number, number][]} */
	const out = [];
	for (const m of text.matchAll(MARKED_RULE_RE)) {
		if (m[1] !== id) continue;
		const at = m.index ?? 0;
		for (let open = text.lastIndexOf("{", at); open !== -1; ) {
			const end = closeOf(text, open);
			if (end === -1 || end > at) {
				out.push([open, end === -1 ? text.length : end]);
				break;
			}
			open = text.lastIndexOf("{", open - 1);
		}
	}
	return out;
}

/**
 * How many emission sites in a guard's EFFECTIVE source can spend an id
 * (#2905): its `latchAfter: "<id>"` decisions, plus each place it spends the
 * fetch with no such mark (#3051). A core emits only through the decision it
 * returns, and the kit marks the latch once that decision's envelope is out,
 * so each latched decision is one site.
 *
 * An unlatched SPEND is any accessor call or mention of a CARRIER — a binding
 * whose value holds either, transitively (nodeBindings) — outside a latched
 * decision's literal, a carrier's own value and a declaration. Names are not
 * scoped, so a local sharing a carrier's name counts too — the safe direction.
 *
 * A mark covers only the innermost literal holding it, so a latch spread in on
 * one branch, `...(c ? { latchAfter } : {})`, leaves a fetch in the outer
 * literal an unlatched spend (#3148).
 *
 * RESIDUAL: a conditional that clears an unconditional mark,
 * `{ latchAfter: "<id>", ...(c ? { latchAfter: undefined } : {}) }`, still
 * reads as latched on its clearing branch. No core writes that shape.
 *
 * @param {string} text the guard's effective source, comments blanked
 * @param {string} id
 * @returns {number}
 */
function emissionSites(text, id) {
	const bindings = nodeBindings(text);
	const carriers = nodeCarriers(text, bindings, id);
	const latched = latchedLiterals(text, id);
	const covered = [
		...latched,
		...bindings.map((b) => b.head),
		...bindings.filter((b) => carriers.has(b.name)).flatMap((b) => b.values),
	];
	const spends = fetchMentions(text, id, carriers).filter(
		(at) => !covered.some(([a, b]) => a <= at && at < b),
	);
	return latched.length + spends.length;
}

/**
 * How well one guard's `ctx.told` bound covers its own direct calls on an id
 * (mantahostels#2283).
 *
 * `none` — no bound at all, or a `ctx.told` with no matching `latchAfter`
 *   (MARKED_RULE_RE's docstring above) — either way the fragment is paid on
 *   every firing.
 * `bounded` — a bound, one fetch site, and one emission site spending it.
 * `ambiguous` — a bound whose target cannot be read off the text: more than one
 *   fetch site, more than one emission site, or none (mantahostels#2354).
 *
 * @typedef {"none" | "bounded" | "ambiguous"} LatchState
 */

/** Worst-first, so a set of states is aggregated by taking the minimum: one
 * guard's unbounded path decides the id however well its neighbours bound
 * theirs.
 * @type {Record<LatchState, number>} */
const LATCH_RANK = { none: 0, ambiguous: 1, bounded: 2 };

/**
 * The least-covered of a set of latch states.
 *
 * @param {LatchState} a
 * @param {LatchState} b
 * @returns {LatchState}
 */
function weakerLatch(a, b) {
	return LATCH_RANK[a] <= LATCH_RANK[b] ? a : b;
}

/**
 * The distinct ids one guard's source latches through `ctx.told`.
 *
 * @param {string} text the guard's source
 * @returns {string[]}
 */
function latchedRuleIds(text) {
	return idsMatching(text, LATCHED_RULE_RE);
}

/**
 * The distinct ids one guard's source RECORDS as delivered, through
 * `latchAfter`.
 *
 * @param {string} text the guard's source
 * @returns {string[]}
 */
function markedRuleIds(text) {
	return idsMatching(text, MARKED_RULE_RE);
}

/**
 * The distinct ids a pattern finds, in the order given.
 *
 * @param {string} text
 * @param {RegExp} re a global pattern whose group 1 is the id
 * @returns {string[]}
 */
function idsMatching(text, re) {
	/** @type {string[]} */
	const ids = [];
	for (const m of text.matchAll(re)) {
		const id = m[1];
		if (id && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/**
 * Total of an id→bytes map's values, the shape every figure below is summed in.
 *
 * @param {Iterable<number>} ns
 * @returns {number}
 */
function sum(ns) {
	let t = 0;
	for (const n of ns) t += n;
	return t;
}

/**
 * The DISTINCT rule ids one guard can reach, and the bytes they resolve to.
 *
 * EVERY FRAGMENT IS RESOLVED, including one that would fall past RULE_CAP on
 * a crowded emission: lib/guard-entry.js resolves every id before it emits
 * anything and refuses the call on any id the store cannot answer for, so an
 * unresolvable id is a store fault wherever it sits.
 *
 * A FRAGMENT OVER THE CAP ON ITS OWN IS NOT A THROW (mantahostels#2054): it can
 * never be emitted whole — offered first with nothing else emitted yet, it
 * denies the tool call outright; offered after other ids, it is deferred
 * instead (guard-entry.js's fitCap), unlatched, so the same refusal lands once
 * those have latched and it is first in line. Either way it is the repo's own
 * rule text, not this module's apparatus — a fact for the caller to report as
 * a finding, not a fault this module raises. It is excluded from `ids`/`bytes`
 * (an emission that can never carry it pays nothing) and named in `overCap`
 * instead, so the caller can tell "pays nothing" from "was never even
 * offered".
 *
 * @param {string[][]} calls the guard's emissions
 * @param {(id: string) => string} resolve
 * @param {number} cap RULE_CAP
 * @returns {{ ids: string[], bytes: Map<string, number>, overCap: { id: string, bytes: number }[] }}
 */
function guardIds(calls, resolve, cap) {
	/** @type {string[]} */
	const ids = [];
	/** @type {Map<string, number>} */
	const bytes = new Map();
	/** @type {{ id: string, bytes: number }[]} */
	const overCap = [];
	const seen = new Set();
	for (const id of calls.flat()) {
		if (seen.has(id)) continue;
		seen.add(id);
		const n = Buffer.byteLength(resolve(id), "utf8");
		if (n > cap) {
			overCap.push({ id, bytes: n });
			continue;
		}
		ids.push(id);
		bytes.set(id, n);
	}
	return { ids, bytes, overCap };
}

/**
 * One guard's source from an explicit `sources` map.
 *
 * @param {Record<string, string>} sources
 * @param {string} rel
 * @returns {string}
 * @throws {RuleEmissionError} where the map does not carry the path
 */
function sourceOf(sources, rel) {
	const source = sources[rel];
	if (source === undefined)
		throw new RuleEmissionError(
			`rule-emission: the wiring names ${rel}, which the supplied sources do not carry.`,
		);
	return source;
}

/**
 * A `source` or `.` line's argument, at the head of its statement.
 *
 * ANCHORED: `source` and `.` are bare words, and the shellcheck directive
 * above every real one (`# shellcheck source=lib/rule-text.sh`) would
 * otherwise match as a second source line for the same lib. A conditional
 * `[ -f x ] && source x` is invisible.
 */
const SOURCE_LINE_RE = /^[ \t]*(?:source|\.)[ \t]+(\S.*)$/gm;

/**
 * The shell expansion in front of a sourced path, taken to the LAST of them —
 * `$here/`, `${BASH_SOURCE[0]%/*}/` and `$(dirname "${BASH_SOURCE[0]}")/` are
 * the repo's three, guards using the first and libs the other two. Every one
 * ends `$`, `}` or `)`, then an optional word, then the slash, which is what
 * this matches rather than the expansions themselves.
 */
const SOURCE_PREFIX_RE = /^.*[$})]\w*\//;

/**
 * A Node file's relative `require`: a Node guard reaches its core, and the
 * core's ids, this way. Only scripts/lib is followed, here and in
 * check-guard-registry.js.
 */
const REQUIRE_RE = /require\(\s*["'](\.[\w./-]+\.js)["']\s*\)/g;

/**
 * The libs one file `source`s, as repo-relative paths, in the order given.
 *
 * RESOLVED AGAINST THE SOURCING FILE'S OWN DIRECTORY, which is what every
 * expansion above computes. Bash would resolve a BARE `source lib/x.sh` against
 * the caller's working directory instead.
 *
 * DROPPED, both silently: an absolute path, and one escaping the repo root.
 * A PATH STILL HOLDING A VARIABLE names no file and yields nothing here.
 *
 * @param {string} text the file's source
 * @param {string} rel the file's own repo-relative path
 * @returns {string[]}
 */
function sourcedLibs(text, rel) {
	const dir = path.posix.dirname(rel.split(path.sep).join("/"));
	/** @type {string[]} */
	const out = [];
	for (const m of text.matchAll(SOURCE_LINE_RE)) {
		const [tail = ""] = (m[1] ?? "")
			.replace(SOURCE_PREFIX_RE, "")
			.split(/["'\s]/, 1);
		if (!/^[\w.-]+(?:\/[\w.-]+)*\.sh$/.test(tail)) continue;
		const resolved = path.posix.normalize(path.posix.join(dir, tail));
		if (resolved.startsWith("..")) continue;
		if (!out.includes(resolved)) out.push(resolved);
	}
	if (isNodeGuard(rel))
		for (const m of text.matchAll(REQUIRE_RE)) {
			const resolved = path.posix.normalize(
				path.posix.join(dir, requiredGroup(m, 1, REQUIRE_RE)),
			);
			if (resolved.startsWith("scripts/lib/") && !out.includes(resolved))
				out.push(resolved);
		}
	return out;
}

/**
 * One guard's EFFECTIVE source: its own text, then every lib it sources,
 * transitively, joined by newlines.
 *
 * AN UNREADABLE LIB IS SKIPPED SILENTLY (mantahostels#2488), unlike an unreadable wired
 * guard, which throws. A source line may name a path this module has no
 * business insisting on — a test's `sources` map carries the wired guards and
 * not their libs. IT IS A FAIL-OPEN AND NOTHING REPORTS IT: a lib whose
 * accessor calls go unread reads as absent.
 *
 * WHAT THE WIDENING COSTS IN THE OTHER DIRECTION. DIRECT_RULE_RE is unanchored,
 * so a literal `rule_text` fetch — or a mention of one in a lib COMMENT —
 * becomes a splice for every guard sourcing that lib, and an unlatched one
 * strands the self-composing predicate of every guard that reads as splicing
 * nothing today.
 *
 * @param {string} rel the guard's repo-relative path
 * @param {string} text the guard's own source
 * @param {(rel: string) => string | null} readLib a lib's source, or null where
 *   it cannot be read
 * @returns {string}
 */
function readEffectiveSource(rel, text, readLib) {
	return [text, ...readSourcedClosure(rel, text, readLib).values()].join("\n");
}

/**
 * Every lib one guard sources, transitively, as path → source in the order
 * read; a lib `readLib` cannot read is left out, and its own libs with it.
 * The one walk, so the files --against fetches and the source measured from
 * them cannot disagree (#1120).
 *
 * @param {string} rel the guard's repo-relative path
 * @param {string} text the guard's own source
 * @param {(rel: string) => string | null} readLib
 * @returns {Map<string, string>}
 */
function readSourcedClosure(rel, text, readLib) {
	const seen = new Set([rel]);
	/** @type {Map<string, string>} */
	const libs = new Map();
	const queue = sourcedLibs(text, rel);
	while (queue.length > 0) {
		const next = /** @type {string} */ (queue.shift());
		if (seen.has(next)) continue;
		seen.add(next);
		const libText = readLib(next);
		if (libText === null) continue;
		libs.set(next, libText);
		queue.push(...sourcedLibs(libText, next));
	}
	return libs;
}

/**
 * One guard's source from disk.
 *
 * @param {string} abs
 * @param {string} rel
 * @returns {string}
 * @throws {RuleEmissionError} on any read failure, ENOENT included — a hook
 *   naming a script that is not there is a wiring fault, not an empty guard
 */
function readGuard(abs, rel) {
	try {
		return fs.readFileSync(abs, "utf8");
	} catch (e) {
		throw new RuleEmissionError(
			`rule-emission: cannot read ${rel}, which a registered hook runs: ${caught(e).message}`,
			{ cause: e },
		);
	}
}

/**
 * Every registration on `event` in a settings object, flattened.
 *
 * @param {Settings} settings
 * @param {string} event
 * @param {import("./guard-cores.js").Manifest} [manifest] the dispatcher
 *   rows of the tree measured, this plugin's where unnamed
 * @returns {Registration[]}
 */
function registrationsOn(settings, event, manifest) {
	const entries = settings?.hooks?.[event];
	if (entries === undefined) return [];
	if (!Array.isArray(entries))
		throw new RuleEmissionError(
			`rule-emission: settings.hooks.${event} is not an array, so no group can be computed.`,
		);
	return expandDispatched(
		event,
		entries.flatMap((entry) =>
			(entry?.hooks ?? []).map((h) => ({
				matcher: entry?.matcher,
				commandLine: buildHookCommandLine(h),
			})),
		),
		manifest,
	);
}

/**
 * Does `matcher` cover `tool`? Anchored exactly as hookIsWired anchors, so
 * `Write` does not answer for `WriteFile`.
 *
 * AN ABSENT OR EMPTY MATCHER COVERS EVERY TOOL. `undefined` is the settings
 * shape for the events that take no matcher; `""` is the shape Claude Code
 * reads as match-all, and anchoring it literally would produce `/^()$/`, which
 * covers nothing and would silently drop that guard from every group.
 *
 * A MATCHER THAT IS NOT A VALID REGEX THROWS, naming itself — `"*"` is the
 * shape that does.
 *
 * @param {string | undefined} matcher
 * @param {string} tool
 * @returns {boolean}
 * @throws {RuleEmissionError} where `matcher` is not a valid regex
 */
function matcherCovers(matcher, tool) {
	if (matcher === undefined || matcher === "") return true;
	let re;
	try {
		re = new RegExp(`^(${matcher})$`);
	} catch (e) {
		throw new RuleEmissionError(
			`rule-emission: the ${EVENT} matcher ${JSON.stringify(matcher)} is not a ` +
				`valid regular expression, so the tools it covers cannot be read: ${caught(e).message}`,
			{ cause: e },
		);
	}
	return re.test(tool);
}

/** One id's direct-call census entry within one guard.
 * @typedef {{ bytes: number | null, latch: LatchState }} DirectFigure */

/** A `ctx.told` bound covering nothing, before reachableByTool names its
 * guard.
 * @typedef {{ id: string, resolves: boolean, bound: boolean, marked: boolean }} LatchFault */

/** What one wired guard reaches.
 * @typedef {{ ids: string[], bytes: Map<string, number>, overCap: { id: string, bytes: number }[], calls: number, direct: Map<string, DirectFigure>, latchFaults: LatchFault[] }} GuardReach */

/**
 * @param {string} name
 * @param {string | undefined} value undefined deletes the variable
 */
function setEnv(name, value) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/**
 * `read`'s result with the fragment store at `rulesDir` and its fallback layer
 * at `rulesFallbackDir`, both restored after; untouched where `rulesDir` is
 * undefined.
 *
 * @template T
 * @param {string | undefined} rulesDir
 * @param {string | undefined} rulesFallbackDir
 * @param {() => T} read
 * @returns {T}
 */
function withRuleStore(rulesDir, rulesFallbackDir, read) {
	const before = process.env.WFC_RULES_DIR;
	const fallbackBefore = process.env.WFC_RULES_FALLBACK_DIR;
	if (rulesDir !== undefined) {
		setEnv("WFC_RULES_DIR", rulesDir);
		setEnv("WFC_RULES_FALLBACK_DIR", rulesFallbackDir);
	}
	try {
		return read();
	} finally {
		if (rulesDir !== undefined) {
			setEnv("WFC_RULES_DIR", before);
			setEnv("WFC_RULES_FALLBACK_DIR", fallbackBefore);
		}
	}
}

/**
 * One guard's effective source, from `sources` where given, else from disk
 * under `root`.
 *
 * @param {string} rel
 * @param {Record<string, string> | undefined} sources
 * @param {string} root
 * @returns {string}
 */
function readGuardSource(rel, sources, root) {
	/* A guard the wiring names but this module cannot read throws rather
	 * than contributing 0 B: a silent skip deflates the total in the one
	 * direction that makes an over-cap group look compliant. */
	const own = sources
		? sourceOf(sources, rel)
		: readGuard(path.join(root, rel), rel);
	return readEffectiveSource(rel, own, (lib) => {
		if (sources) return sources[lib] ?? null;
		try {
			return fs.readFileSync(path.join(root, lib), "utf8");
		} catch {
			return null;
		}
	});
}

/**
 * One guard's emissions, each with its module-off ids dropped and an
 * emptied call dropped with them.
 *
 * @param {string} rel
 * @param {string} effective the guard's effective source
 * @param {string} root
 * @returns {string[][]}
 */
function liveRuleCalls(rel, effective, root) {
	let off;
	try {
		off = gatedOffIds(effective, root);
	} catch (e) {
		throw new RuleEmissionError(`rule-emission: ${rel}: ${caught(e).message}`, {
			cause: e,
		});
	}
	return ruleCalls(effective)
		.map((ids) => ids.filter((id) => !off.has(id)))
		.filter((ids) => ids.length);
}

/**
 * @param {string} rel
 * @param {string[][]} calls
 * @param {number} cap
 * @returns {ReturnType<typeof guardIds>}
 */
function reachedIds(rel, calls, cap) {
	/* rule-text's throw names the id and not the caller, and the caller is
	 * what a session has to open to fix it. */
	try {
		return guardIds(calls, readRuleText, cap);
	} catch (e) {
		const { message } = caught(e);
		throw new RuleEmissionError(
			e instanceof RuleEmissionError
				? `rule-emission: ${rel}: ${message}`
				: `rule-emission: ${rel} injects an id the store cannot ` +
						`resolve: ${message}`,
			{ cause: e },
		);
	}
}

/**
 * The direct-call census of one guard, id by id.
 *
 * The direct census never throws where guardIds does. An injected id the
 * store cannot answer for denies the tool call at run time, so it is a
 * fault worth stopping on; a direct call falls back to the guard's own
 * hardcoded sentence and still fires, so the same id costs a census
 * entry reading `unresolved` and nothing more.
 *
 * @param {Map<string, number>} counts direct call sites per id
 * @param {Set<string>} latched
 * @param {Set<string>} marked
 * @param {(id: string) => number} sitesOf the emission sites spending an id
 * @returns {Map<string, DirectFigure>}
 */
function directCensus(counts, latched, marked, sitesOf) {
	/** @type {Map<string, DirectFigure>} */
	const direct = new Map();
	for (const [id, sites] of counts) {
		let n = null;
		try {
			n = Buffer.byteLength(readRuleText(id), "utf8");
		} catch {
			n = null;
		}
		/** @type {LatchState} */
		let latch = "ambiguous";
		if (!latched.has(id) || !marked.has(id)) latch = "none";
		else if (sites === 1 && sitesOf(id) === 1) latch = "bounded";
		direct.set(id, { bytes: n, latch });
	}
	return direct;
}

/**
 * @param {Map<string, number>} counts direct call sites per id
 * @param {Set<string>} latched
 * @param {Set<string>} marked
 * @param {string[][]} calls the guard's live emissions
 * @returns {LatchFault[]}
 */
function guardLatchFaults(counts, latched, marked, calls) {
	/* A bound that covers nothing (mantahostels#2283): a typo strands the latch forever
	 * while the census reports the real fragment bounded. */
	/** @type {LatchFault[]} */
	const latchFaults = [];
	/* A guard composing its own text and latching THAT, which `ctx.told`
	 * was built for (mantahostels#2275), has no fragment to resolve and no accessor to
	 * bind, so those two limbs read as failures on a working bound (mantahostels#2446).
	 *
	 * ORPHAN SPLICE is what separates it from the mantahostels#2283 typo, whose misspelt
	 * id also resolves to nothing and binds to nothing: an id the guard
	 * FETCHES and never latches is a splice the typo could have been meant
	 * for, and a guard with none has nothing for it to be a typo of. Both
	 * fetch routes count, a direct accessor call and `injectRules` alike —
	 * over `counts` alone a guard reaching the store only through
	 * `injectRules` reads as having no splices at all, and its typo goes
	 * unreported (mantahostels#2470).
	 *
	 * BACKTICK EVERY ACCESSOR NAMED IN PROSE HERE. check-guard-registry.js
	 * scans this file for accessor calls lexically, and an unquoted
	 * `rule_text` followed by a bare word reads as a call on a rule id that
	 * does not exist, failing the build. */
	const spliced = new Set([...counts.keys(), ...calls.flat()]);
	const orphanSplice = [...spliced].some((k) => !latched.has(k));
	for (const id of latched) {
		let resolves = true;
		try {
			readRuleText(id);
		} catch {
			resolves = false;
		}
		/* `counts` and `marked` read the EFFECTIVE source (mantahostels#2488), so a
		 * call or a `latchAfter` in a sourced lib is seen. What
		 * neither can still say is that the call does not EXIST: an id
		 * passed as a variable is invisible either way (mantahostels#2283, mantahostels#2378).
		 * check-context-budget.js hedges both fault messages accordingly
		 * ("no direct accessor call ... is visible" / "no latchAfter
		 * decision ... is visible"), pinned in
		 * check-context-budget-session-cap.test.ts. */
		const bound = counts.has(id);
		const isMarked = marked.has(id);
		/* `!resolves` keeps the "meant to splice it, forgot the accessor
		 * call" fault reported, its fragment being live and never emitted.
		 *
		 * `spliced` reads the EFFECTIVE source (mantahostels#2488), so a guard whose
		 * only fetch sits in a sourced lib splices what that lib fetches and
		 * its mantahostels#2283 typo is reported. THE RESIDUAL IS NARROWER, not
		 * gone: a lib fetching under an id passed as an ARGUMENT splices
		 * nothing this can see, and that guard's typo still reads as
		 * self-composed. Closing that needs the latch to DECLARE what it
		 * bounds, priced and declined at mantahostels#2446.
		 *
		 * The narrower gap mantahostels#2470 accepted in taking this signal: a guard that
		 * latches every id it splices and separately mistypes a latch for a
		 * fragment it never fetches has no orphan splice, so that typo reads
		 * as self-composed. */
		const selfBounding = !orphanSplice && !resolves && !bound;
		/* Both limbs read as PASSING on a self-bounding latch rather than
		 * being dropped from the object: the fault's consumer composes its
		 * message limb by limb, so a false here would send the reader after
		 * a fragment and an accessor the guard is right not to have. */
		const resolvesLimb = selfBounding || resolves;
		const boundLimb = selfBounding || bound;
		if (!resolvesLimb || !boundLimb || !isMarked)
			latchFaults.push({
				id,
				resolves: resolvesLimb,
				bound: boundLimb,
				marked: isMarked,
			});
	}
	return latchFaults;
}

/**
 * @param {string} rel
 * @param {Record<string, string> | undefined} sources
 * @param {string} root
 * @param {number} cap
 * @returns {GuardReach}
 */
function guardReach(rel, sources, root, cap) {
	const effective = readGuardSource(rel, sources, root);
	const calls = liveRuleCalls(rel, effective, root);
	const reached = reachedIds(rel, calls, cap);
	/* A Node guard reads with its comments blanked, so a mention in one is no
	 * call, bound or mark (#3051). A bash guard keeps them: `#` is no JS
	 * comment, and DIRECT_RULE_RE's docstring says why over-counting is safe. */
	const code = isNodeGuard(rel) ? blankComments(effective) : effective;
	const counts = directRuleCounts(code);
	const latched = new Set(latchedRuleIds(code));
	const marked = new Set(markedRuleIds(code));
	const direct = directCensus(counts, latched, marked, (id) =>
		emissionSites(code, id),
	);
	const latchFaults = guardLatchFaults(counts, latched, marked, calls);
	return { ...reached, calls: calls.length, direct, latchFaults };
}

/**
 * Every tool any matcher names, so a group with no emitter still reports.
 *
 * @param {Registration[]} registrations
 * @returns {Set<string>}
 */
function matcherTools(registrations) {
	/** @type {Set<string>} */
	const tools = new Set();
	for (const { matcher } of registrations)
		for (const token of (matcher ?? "").split("|"))
			if (TOOL_NAME_RE.test(token)) tools.add(token);
	return tools;
}

/**
 * One tool's figure: the union of the ids its wired guards reach, and each
 * contributing guard, biggest first.
 *
 * @param {string} tool
 * @param {Registration[]} registrations
 * @param {Map<string, GuardReach>} byGuard
 * @returns {{ bytes: number, ids: string[], guards: GuardFigure[] }}
 */
function toolFigure(tool, registrations, byGuard) {
	/** @type {GuardFigure[]} */
	const guards = [];
	/* A guard wired twice on one tool is read once. */
	const seen = new Set();
	/** @type {Map<string, number>} */
	const union = new Map();
	for (const { matcher, commandLine } of registrations) {
		if (!matcherCovers(matcher, tool)) continue;
		for (const m of commandLine.matchAll(WIRED_SCRIPT_RE)) {
			const rel = requiredGroup(m, 1, WIRED_SCRIPT_RE);
			const g = byGuard.get(rel);
			if (!g || g.ids.length === 0 || seen.has(rel)) continue;
			seen.add(rel);
			for (const [id, n] of g.bytes) union.set(id, n);
			guards.push({
				file: rel,
				bytes: sum(g.bytes.values()),
				calls: g.calls,
				ids: g.ids,
			});
		}
	}
	guards.sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file));
	return { bytes: sum(union.values()), ids: [...union.keys()], guards };
}

/**
 * One entry per over-cap id, not per (guard, id) pair: two guards reaching
 * the same over-cap fragment are the same repo fault, so the caller reports
 * it once, naming every guard that reaches it.
 *
 * @param {Map<string, GuardReach>} byGuard
 * @returns {{ id: string, bytes: number, guards: string[] }[]}
 */
function overCapRows(byGuard) {
	/** @type {Map<string, { bytes: number, guards: string[] }>} */
	const overCapById = new Map();
	for (const [rel, g] of byGuard)
		for (const o of g.overCap) {
			const entry = overCapById.get(o.id);
			if (entry) entry.guards.push(rel);
			else overCapById.set(o.id, { bytes: o.bytes, guards: [rel] });
		}
	/* Sorted, not insertion order: guards is founder-facing text, and insertion
	 * order is an accident of registration order in the hooks file. */
	return [...overCapById.entries()].map(([id, v]) => ({
		id,
		bytes: v.bytes,
		guards: v.guards.slice().sort(),
	}));
}

/**
 * One entry per (guard, id), not per id: `bound` is a property of the guard's
 * own source, so two guards latching the same stranded id are two dead bounds
 * to repair and not one.
 *
 * @param {Map<string, GuardReach>} byGuard
 * @returns {(LatchFault & { guard: string })[]}
 */
function latchFaultRows(byGuard) {
	return [...byGuard]
		.flatMap(([rel, g]) => g.latchFaults.map((f) => ({ ...f, guard: rel })))
		.sort((a, b) => a.id.localeCompare(b.id) || a.guard.localeCompare(b.guard));
}

/**
 * The direct-call census (mantahostels#2055).
 *
 * NOTHING IS DROPPED: a direct call does not consult the injection latch, so
 * it is paid again every time its guard fires. That is true of an id
 * `injectRules` ALSO reaches — the figures carry its once-a-session pre-emission, never
 * its repeats — so such an id is flagged `counted` rather than omitted, and
 * a reader adding this census to the tool and ratchet figures does not double
 * it.
 *
 * A CALLER MAY BOUND ITS OWN REPEAT, through `ctx.told`'s separate latch
 * (mantahostels#2275), and `latched` says which do. That changes no figure here: the
 * bytes are still route (e) and still uncapped.
 *
 * @param {Map<string, GuardReach>} byGuard
 * @param {Map<string, number>} acrossGuards the ratchet's union
 * @returns {{ id: string, bytes: number | null, guards: string[], counted: boolean, latched: LatchState }[]}
 */
function directRows(byGuard, acrossGuards) {
	/** @type {Map<string, { bytes: number | null, guards: string[], latched: LatchState }>} */
	const directById = new Map();
	for (const [rel, g] of byGuard)
		for (const [id, d] of g.direct) {
			const entry = directById.get(id);
			/* The weakest guard's reading decides the id. */
			if (entry) {
				entry.guards.push(rel);
				entry.latched = weakerLatch(entry.latched, d.latch);
			} else
				directById.set(id, {
					bytes: d.bytes,
					guards: [rel],
					latched: d.latch,
				});
		}
	return [...directById.entries()]
		.map(([id, v]) => ({
			id,
			bytes: v.bytes,
			guards: v.guards.slice().sort(),
			counted: acrossGuards.has(id),
			latched: v.latched,
		}))
		.sort(
			(a, b) => (b.bytes ?? 0) - (a.bytes ?? 0) || a.id.localeCompare(b.id),
		);
}

/**
 * What reachableByTool and reachableAfterCall read.
 *
 * @typedef {object} ReachOptions
 * @property {Settings} [settings] the hook wiring; defaults to the hooks
 *   `root` registers itself (lib/core-hooks.js's `ownHooks`).
 * @property {Record<string, string>} [sources] repo-relative guard path → its
 *   source text, for tests that must not read the tree. Where absent, each
 *   wired command's path is read from `root`.
 * @property {string} [root] repo root the sources are read from.
 * @property {string} [rulesDir] the fragment store, as WFC_RULES_DIR spells
 *   it. Set around the resolution and restored after, because rule-text.js
 *   reads that variable at call time by design.
 * @property {string} [rulesFallbackDir] the layer beneath it, as
 *   WFC_RULES_FALLBACK_DIR spells it (#101). Set and restored with `rulesDir`,
 *   and cleared where omitted, so a test's throwaway store inherits nothing: an
 *   override implies no core layer (rule-text.js rulesDirs()). Ignored without
 *   `rulesDir`.
 * @property {string} [capFile] absolute path of the RULE_CAP assignment.
 */

/**
 * The route (f) bytes a session can be made to pay through each PreToolUse
 * tool, and the same union taken across every wired guard at once.
 *
 * @param {ReachOptions} [options]
 * @returns {{ cap: number, tools: Record<string, { bytes: number, ids: string[], guards: GuardFigure[] }>, ratchet: { bytes: number, ids: string[] }, overCap: { id: string, bytes: number, guards: string[] }[], direct: { id: string, bytes: number | null, guards: string[], counted: boolean, latched: LatchState }[], latchFaults: { id: string, guard: string, resolves: boolean, bound: boolean, marked: boolean }[], fragmentBytes: Record<string, number> }}
 *   Every tool any PreToolUse matcher names gets an entry, at zero where its
 *   group emits nothing. `overCap` names every fragment a wired guard
 *   reaches that can never be emitted (mantahostels#2054), one entry per id naming every
 *   guard that reaches it. `direct` is the census of every id a wired guard
 *   reaches through a direct `rule_text` call (mantahostels#2055): route (e) delivery, so
 *   no figure above prices it. `counted` marks an id the figures DO carry by
 *   the pre-emptive route, whose direct repeats they still do not. `latched`
 *   reads `bounded` where every direct caller bounds its own repeat through
 *   `ctx.told` (mantahostels#2275) AND that bound correlates with the call it covers,
 *   `ambiguous` where a caller's cannot be correlated, `none` otherwise
 *   (mantahostels#2283). `bytes` is null on an id the store cannot answer for, which a direct call
 *   survives. `latchFaults` names every `ctx.told` bounding nothing —
 *   `resolves: false` for an id no fragment answers to, `bound: false` for one
 *   its own guard makes no visible direct call on, `marked: false` for one its
 *   own guard makes no visible `latchAfter` decision on, so the bound never
 *   comes true — and over WIRED guards only, so a dead latch in an unwired
 *   script is invisible. A guard reaching the store by neither route composes
 *   its own text and is judged on the `marked` limb alone (mantahostels#2446).
 *   `fragmentBytes` is every reachable id's bytes
 *   by either route, over cap or not (mantahostels#2260).
 * @throws {RuleEmissionError} on an unreadable cap source or a malformed
 *   settings shape; and it lets rule-text's own throw escape, so an emission
 *   naming an id with no fragment surfaces there rather than counting as zero.
 */
function reachableByTool(options = {}) {
	const root = options.root ?? hostRoot();
	const settings = readSettings(options, root);
	const cap = readRuleCap(options.capFile);
	const registrations = registrationsOn(
		settings,
		EVENT,
		readManifest(manifestAt(root)),
	);
	const tools = matcherTools(registrations);
	const byGuard = guardReaches(registrations, options, root, cap);

	/** @type {Record<string, { bytes: number, ids: string[], guards: GuardFigure[] }>} */
	const out = {};
	/* The ratchet's union, taken over EVERY WIRED GUARD rather than over the
	 * tools walked below: a match-all matcher (`""` or absent) names no tool and
	 * so opens no group, and accumulating inside that loop would report its
	 * guards' bytes as zero. */
	/** @type {Map<string, number>} */
	const acrossGuards = new Map();
	for (const g of byGuard.values())
		for (const [id, n] of g.bytes) acrossGuards.set(id, n);
	for (const tool of [...tools].sort())
		out[tool] = toolFigure(tool, registrations, byGuard);

	const overCap = overCapRows(byGuard);
	const direct = directRows(byGuard, acrossGuards);

	/* Every id a wired guard reaches, and its bytes, over cap or not (mantahostels#2260).
	 *
	 * THE TWO INJECTION SETS ARE DISJOINT BY CONSTRUCTION, not merged here:
	 * guardIds() puts an over-cap id in `overCap` and excludes it from `bytes`,
	 * so neither loop below can overwrite the other's entry.
	 *
	 * THE DIRECT CENSUS IS SEEDED FIRST and so never overwrites an injection
	 * figure, which is the one the caps are taken against. It is included at
	 * all because an id can move BETWEEN the routes. */
	/** @type {Record<string, number>} */
	const fragmentBytes = {};
	for (const d of direct) if (d.bytes !== null) fragmentBytes[d.id] = d.bytes;
	for (const [id, n] of acrossGuards) fragmentBytes[id] = n;
	for (const o of overCap) fragmentBytes[o.id] = o.bytes;

	return {
		cap,
		tools: out,
		direct,
		latchFaults: latchFaultRows(byGuard),
		ratchet: {
			bytes: sum(acrossGuards.values()),
			ids: [...acrossGuards.keys()],
		},
		overCap,
		fragmentBytes,
	};
}

/**
 * @param {ReachOptions} options
 * @param {string} root
 * @returns {Settings}
 */
function readSettings(options, root) {
	return options.settings ?? { hooks: readOwnHooks(root) ?? {} };
}

/**
 * What each guard `registrations` wire reaches, read once per guard: its
 * reachable set is the same wherever it is wired.
 *
 * @param {Registration[]} registrations
 * @param {ReachOptions} options
 * @param {string} root
 * @param {number} cap
 * @returns {Map<string, GuardReach>}
 */
function guardReaches(registrations, options, root, cap) {
	const { sources, rulesDir, rulesFallbackDir } = options;
	/** @type {Map<string, GuardReach>} */
	const byGuard = new Map();
	withRuleStore(rulesDir, rulesFallbackDir, () => {
		for (const { commandLine } of registrations)
			for (const m of commandLine.matchAll(WIRED_SCRIPT_RE)) {
				const rel = requiredGroup(m, 1, WIRED_SCRIPT_RE);
				if (!byGuard.has(rel))
					byGuard.set(rel, guardReach(rel, sources, root, cap));
			}
	});
	return byGuard;
}

/**
 * One guard's ids split by what a latch bounds: id → bytes paid once a
 * session, and the direct calls paid on every firing.
 *
 * @param {GuardReach} g
 * @returns {{ once: Map<string, number>, perFire: { id: string, bytes: number | null }[] }}
 */
function afterSplit(g) {
	const once = new Map(g.bytes);
	/** @type {{ id: string, bytes: number | null }[]} */
	const perFire = [];
	for (const [id, d] of g.direct)
		if (d.latch === "bounded" && d.bytes !== null) once.set(id, d.bytes);
		else perFire.push({ id, bytes: d.bytes });
	return { once, perFire };
}

/** One hook on an AFTER_EVENTS event, as reachableAfterCall reports it.
 * @typedef {{ event: string, matcher: string | undefined, file: string, once: { bytes: number, ids: string[] }, perFire: { id: string, bytes: number | null }[] }} AfterHook */

/**
 * The rule text each hook on AFTER_EVENTS can hand a session (#2144), priced
 * as reachableByTool prices a PreToolUse guard: an id is paid once a session
 * where a latch bounds it — the injection latch, or a direct call's
 * `bounded` `ctx.told` — and the session figure is the union of those ids.
 * No cap prices them (docs/doc-map.md §Capture and placement §3).
 *
 * AN UNBOUNDED DIRECT CALL IS PAID EVERY TIME ITS HOOK FIRES, so it goes in
 * `perFire` and on no session figure; `ambiguous` counts as unbounded, the
 * safe direction. A `?` id the store cannot answer for is listed with null
 * bytes.
 *
 * KEYED ON THE HOOK, NOT THE TOOL: a guard wired on two events is two rows,
 * and the union counts its ids once. Each row lists every id its guard
 * reaches, whatever event branch the guard takes them on — the safe
 * direction. It is not unioned with the PreToolUse ratchet: `ctx.told`'s
 * latch is not the injection latch, so an id both routes reach is paid by each.
 *
 * `overCap` and `latchFaults` are reachableByTool's, over these guards.
 *
 * @param {ReachOptions} [options] as reachableByTool's
 * @returns {{ cap: number, hooks: AfterHook[], once: { bytes: number, ids: string[] }, overCap: { id: string, bytes: number, guards: string[] }[], latchFaults: (LatchFault & { guard: string })[] }}
 */
function reachableAfterCall(options = {}) {
	const root = options.root ?? hostRoot();
	const settings = readSettings(options, root);
	const manifest = readManifest(manifestAt(root));
	const wired = AFTER_EVENTS.flatMap((event) =>
		registrationsOn(settings, event, manifest).map((r) => ({ ...r, event })),
	);
	/* Nothing wired reads no RULE_CAP: a host need not ship hook-limits.sh
	 * to have no hooks. */
	if (wired.length === 0)
		return {
			cap: 0,
			hooks: [],
			once: { bytes: 0, ids: [] },
			overCap: [],
			latchFaults: [],
		};
	const cap = readRuleCap(options.capFile);
	const byGuard = guardReaches(wired, options, root, cap);
	/** @type {AfterHook[]} */
	const hooks = [];
	/** @type {Map<string, number>} */
	const union = new Map();
	for (const { event, matcher, commandLine } of wired)
		for (const m of commandLine.matchAll(WIRED_SCRIPT_RE)) {
			const file = requiredGroup(m, 1, WIRED_SCRIPT_RE);
			const g = byGuard.get(file);
			if (!g)
				throw new Error(
					`rule-emission: ${file} is wired but guardReaches read no figure for it`,
				);
			const { once, perFire } = afterSplit(g);
			if (once.size === 0 && perFire.length === 0) continue;
			for (const [id, n] of once) union.set(id, n);
			hooks.push({
				event,
				matcher,
				file,
				once: { bytes: sum(once.values()), ids: [...once.keys()] },
				perFire,
			});
		}
	return {
		cap,
		hooks,
		once: { bytes: sum(union.values()), ids: [...union.keys()] },
		overCap: overCapRows(byGuard),
		latchFaults: latchFaultRows(byGuard),
	};
}

module.exports = {
	REQUIRE_RE,
	CAP_SOURCE,
	EVENT,
	registrationsOn,
	directAccessorCalls,
	emissionMatches,
	firstUnreadInjection,
	RULE_ARG_RE,
	WIRED_SCRIPT_RE,
	directRuleCounts,
	readRuleCap,
	readHookPersistChars,
	buildHookCommandLine,
	readSourcedClosure,
	reachableAfterCall,
	reachableByTool,
};
