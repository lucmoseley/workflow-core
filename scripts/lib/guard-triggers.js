/*
 * guard-triggers.js — which tool call fires which tool-call hook, DERIVED
 * from the core's hook registration rather than written down (mantahostels#3287). Deny-capable
 * `PreToolUse` guards by default; `triggerTable`'s `scope` widens it to the
 * rest (mantahostels#3350) and its `event` moves it to `PostToolUse` (mantahostels#3356).
 *
 * WHY DERIVED. The lost-deny census (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/lost-deny-recoverability.md)
 * needed a true-invocation denominator per guard: not "how often did it print
 * something" but "how many tool calls reached it at all", silent allows
 * included. Its scratch instrument carried that as a hand-written 21-row table,
 * and mantahostels#3287 was written to land that table as checked-in data on the assumption
 * it could not be derived. It can: `matcher` already names the tools a
 * registration binds to, and `if` already names the command condition, so the
 * table is a reading of the registration and goes stale only if it does.
 *
 * A GUARD WITH NO READABLE TRIGGER IS `unknown`, NEVER ZERO — the same rule
 * `lib/guard-deny-rates.js` states for a guard with no measured row. An `if`
 * this file cannot parse marks the whole guard unknown rather than quietly
 * narrowing its population, because an under-counted denominator inflates every
 * rate derived from it.
 *
 * NAMED RESIDUALS, all of them ways this reading can differ from Claude Code's
 * own:
 *
 *   - A COMPOUND COMMAND IS MATCHED WHOLE. Claude Code splits a command on
 *     `&&`, `;` and `|` and evaluates each part against a permission rule; this
 *     matches the raw command string. So `ls && git status` matches
 *     `Bash(*git *)` here and `Bash(git *)` there, and this file says no to the
 *     second where the harness says yes. It biases a prefix-anchored
 *     denominator DOWN.
 *   - THE GLOB IS TRANSLATED, NOT THE HARNESS'S. `*` becomes `[\s\S]*` and
 *     every other character is escaped; there is no `?`, no character class and
 *     no brace expansion, none of which appear in this repo's `if` clauses.
 *   - THE MATCHER IS READ AS A REGEXP, anchored at both ends, which is what
 *     Claude Code documents. A matcher that will not compile marks the guard
 *     unknown.
 *   - A `PreToolUse` HOOK THAT NEVER RAN IS INVISIBLE HERE. This says which
 *     calls settings.json routes to a guard, not which ones the harness
 *     actually delivered — the lost-deny population is exactly the gap.
 *   - A `PostToolUse` POPULATION IS AN UPPER BOUND ON DELIVERY, and by more
 *     than the `PreToolUse` one (mantahostels#3356). Every `tool_use` block is a routed
 *     call either way, but a `PostToolUse` hook additionally never fires on a
 *     call that was denied or cancelled before it ran, and the transcript's
 *     `tool_use` block is written whether or not the call completed.
 */

const { registeredGuards } = require("./guard-fires.js");
const { cutAt } = require("./cut-at.js");
const { requiredGroup } = require("./regex-group.js");
const { isDenyCapableIn } = require("./deny-capable.js");

/** The hook event a deny can be issued on, and `triggerTable`'s default. */
const DENY_EVENT = "PreToolUse";

/**
 * The hook events this file can derive a population for: the two that fire on a
 * tool call and therefore have `matcher` and `if` to read (mantahostels#3356).
 *
 * `UserPromptSubmit`, `Stop`, `PreCompact` and `SessionStart` are deliberately
 * absent rather than merely unsupported: none of them fires on a tool call at
 * all, so no count of `tool_use` blocks is their denominator at any scope.
 *
 * @type {ReadonlySet<string>}
 */
const EVENTS = new Set(["PreToolUse", "PostToolUse"]);

/**
 * Which of an event's guards a table covers.
 *
 *   deny — the deny-capable ones alone, the lost-deny census's population and
 *     this file's original and default scope (mantahostels#3287).
 *   nondeny — the rest: guards that warn, inject context or hand over a rule,
 *     but cannot deny. mantahostels#3350's population.
 *   all — both, for a denominator over every one of the event's guards at once.
 *
 * ONLY `all` IS ACCEPTED ON `PostToolUse` (mantahostels#3356). The tool call has already
 * run by the time that event fires, so no `PostToolUse` hook can deny one
 * whatever its source says; `deny` there would report an empty table and
 * `nondeny` a table indistinguishable from `all`, both of them reading as a
 * measurement.
 *
 * @type {ReadonlySet<string>}
 */
const SCOPES = new Set(["deny", "nondeny", "all"]);

/**
 * A permission-rule glob as an anchored RegExp.
 *
 * `[\s\S]*` rather than `.*`: a Bash command is routinely multi-line, and `.`
 * stops at a newline, so `Bash(*npm *)` would miss `npm test` on line two.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
	const body = String(glob)
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("[\\s\\S]*");
	return new RegExp(`^${body}$`);
}

// One tool name, deliberately: `firesOn` compares the name literally, so an
// alternation here would match no tool at all and silently narrow a
// denominator to nothing. An unreadable clause marks the guard unknown.
const IF_CLAUSE_RE = /^([A-Za-z]\w*)\(([\s\S]*)\)$/;

/**
 * A settings.json `if` clause split into the tool it names and its glob.
 * `null` where it is not of the `Tool(pattern)` shape this file can read.
 *
 * @param {unknown} clause
 * @returns {{tool: string, glob: string} | null}
 */
function parseIfClause(clause) {
	if (typeof clause !== "string") return null;
	const m = IF_CLAUSE_RE.exec(clause.trim());
	if (!m) return null;
	return {
		tool: requiredGroup(m, 1, IF_CLAUSE_RE),
		glob: requiredGroup(m, 2, IF_CLAUSE_RE),
	};
}

/**
 * @typedef {object} Trigger
 * @property {string} guard the script's basename
 * @property {boolean} denyCapable whether the script can refuse a call
 *   (`lib/deny-capable.js`), and always false on `PostToolUse`, where nothing can. Carried
 *   on the row so a caller reading a `nondeny` or `all` table can say WHY a
 *   guard has no deny rate — it cannot have one — rather than reporting it as
 *   an unmeasured zero (mantahostels#3350).
 * @property {Array<{matcher: RegExp | null, raw: string, tool: string | null,
 *   glob: string | null, test: RegExp | null}>} rules one per settings.json
 *   registration; `raw` is the matcher as settings.json spells it, which is
 *   what reporting prints.
 * @property {string[]} conditions the raw `if` clauses, for reporting
 * @property {string | null} unknown why this guard's population cannot be
 *   counted, or null where it can. EVERY unreadable registration is named, not
 *   just the last: this string is the whole of what `--triggers`
 *   reports about the guard (mantahostels#3296, mantahostels#3310). Reasons join with `; `, two
 *   registrations producing the identical reason saying it once. The joined
 *   string is for a reader, never for splitting: a reason embeds
 *   `JSON.stringify` output, which can hold the separator itself.
 */

/**
 * @typedef {{key: string, event: string, matcher?: string, if?: string,
 *   command: string}} Registration
 */

/**
 * @param {string} scope
 * @param {string} event
 * @returns {void}
 */
function assertTableOptions(scope, event) {
	// Refused rather than defaulted: a typo silently narrowing to the deny set
	// would report a nondeny denominator of zero.
	if (!SCOPES.has(scope))
		throw new Error(
			`unknown scope ${JSON.stringify(scope)} — one of ${[...SCOPES].join(", ")}`,
		);
	// Same rule, same reason: a typo, or an event that fires on no tool call,
	// would match no registration and report an empty table as a measurement.
	if (!EVENTS.has(event))
		throw new Error(
			`unknown event ${JSON.stringify(event)} — one of ${[...EVENTS].join(", ")}`,
		);
	if (event !== DENY_EVENT && scope !== "all")
		throw new Error(
			`scope ${JSON.stringify(scope)} is meaningless on ${event} — no hook on that event can deny; use "all"`,
		);
}

/**
 * @param {"deny" | "nondeny" | "all"} scope
 * @param {boolean} capable  whether the guard can deny
 * @returns {boolean}
 */
function isInScope(scope, capable) {
	if (scope === "deny") return capable;
	if (scope === "nondeny") return !capable;
	return true;
}

/**
 * @param {Map<string, Trigger>} table accumulator: a new guard's empty row is added
 * @param {string} guard
 * @param {boolean} capable
 * @returns {Trigger}
 */
function ensureRow(table, guard, capable) {
	const existing = table.get(guard);
	if (existing) return existing;
	/** @type {Trigger} */
	const row = {
		guard,
		denyCapable: capable,
		rules: [],
		conditions: [],
		unknown: null,
	};
	table.set(guard, row);
	return row;
}

/**
 * Adds one registration's rule to its guard's row, or, where its matcher or
 * `if` will not read, the reason to the row's `unknown`.
 * @param {Trigger} row accumulator: the registration's rule and condition, or its unknown reason, is added
 * @param {Registration} reg
 * @param {(guard: string, reason: string) => string} note  records a reason,
 *   returning the guard's reasons so far, joined
 * @returns {void}
 */
function addRegistration(row, reg, note) {
	const { guard } = row;
	// Claude Code reads an absent matcher, `"*"` and `""` alike as "every
	// tool". A null RegExp carries that: `"*"` will not compile at all and
	// `""` compiles to `^(?:)$`, which matches only the empty tool name and
	// would report a silent zero population.
	//
	// All three normalise to `*` for reporting: they are one route (mantahostels#3296).
	const spelling = reg.matcher ?? "*";
	const raw = spelling === "" ? "*" : spelling;
	let matcher = null;
	if (raw !== "*") {
		try {
			matcher = new RegExp(`^(?:${raw})$`);
		} catch {
			row.unknown = note(
				guard,
				`matcher ${JSON.stringify(raw)} is not a regexp`,
			);
			return;
		}
	}

	if (reg.if === undefined) {
		row.rules.push({ matcher, raw, tool: null, glob: null, test: null });
		return;
	}
	const parsed = parseIfClause(reg.if);
	if (!parsed) {
		row.unknown = note(
			guard,
			`if clause ${JSON.stringify(reg.if)} is not Tool(pattern)`,
		);
		return;
	}
	row.conditions.push(reg.if);
	row.rules.push({
		matcher,
		raw,
		tool: parsed.tool,
		glob: parsed.glob,
		test: globToRegExp(parsed.glob),
	});
}

/**
 * The `event` guards the registration holds within `scope`, with the tool
 * calls that reach each.
 *
 * Keyed on the script's BASENAME, not `guardKey`: two registrations of one
 * script are two ways into the same guard, and a call reaching either is one
 * invocation of it. `guardKey` deliberately keeps them apart, which is right
 * for counting what a hook PRINTED and wrong for counting what reached it.
 *
 * SCOPE CHANGES WHICH GUARDS GET A ROW, NEVER HOW A ROW IS DERIVED (mantahostels#3350).
 * `denyCapable` is the only filter it moves, so a guard's matchers, conditions
 * and `unknown` reason read identically whichever scope produced it — which is
 * what lets a `nondeny` denominator be compared with a `deny` one.
 *
 * EVENT CHANGES WHICH REGISTRATIONS ARE READ, AND NOTHING ELSE (mantahostels#3356). A
 * `PostToolUse` registration carries the same `matcher` and the same
 * `Tool(pattern)` `if`, so the derivation, `addRegistration`, never looks at
 * the event again after the filter — which is what lets a `PostToolUse`
 * denominator be compared with a `PreToolUse` one.
 *
 * @param {Record<string, any>} settings
 * @param {string[]} guardDirs where the guard scripts are looked up, in order
 *   (`lib/deny-capable.js` `guardDirs`)
 * @param {{scope?: "deny" | "nondeny" | "all", event?: "PreToolUse" | "PostToolUse"}} [options]
 * @returns {Map<string, Trigger>}
 */
function triggerTable(settings, guardDirs, options = {}) {
	const scope = options.scope ?? "deny";
	const event = options.event ?? DENY_EVENT;
	assertTableOptions(scope, event);
	const isDenyCapable = isDenyCapableIn(guardDirs);
	/** @type {Map<string, Trigger>} */
	const table = new Map();
	// The reasons behind each row's `unknown`, kept apart from the joined string
	// the row carries so a repeat can be recognised before it is appended.
	/** @type {Map<string, string[]>} */
	const reasons = new Map();
	/**
	 * @param {string} guard
	 * @param {string} reason
	 * @returns {string} the guard's reasons so far, joined for its row's `unknown`
	 */
	const note = (guard, reason) => {
		const seen = reasons.get(guard) ?? [];
		if (!seen.includes(reason)) seen.push(reason);
		reasons.set(guard, seen);
		return seen.join("; ");
	};
	for (const reg of registeredGuards(settings)) {
		if (reg.event !== event) continue;
		const [guard] = cutAt(reg.key, " ");
		// A deny is only issuable before the call runs, so the textual test is
		// asked at all only on `PreToolUse` (mantahostels#3356). Otherwise a `PostToolUse`
		// script that merely spells a deny verdict — in a comment, or because it
		// greps the guards for one — would be reported as able to deny a call it cannot.
		const capable = event === DENY_EVENT && isDenyCapable(guard);
		if (!isInScope(scope, capable)) continue;
		addRegistration(ensureRow(table, guard, capable), reg, note);
	}
	return table;
}

/**
 * Does this tool call reach this guard?
 *
 * `false` for an unknown guard: a caller must ask `trigger.unknown` first and
 * report the guard as uncounted rather than reading this as "no calls reached
 * it". Every caller in this repo does; this returns false rather than throwing
 * so that a caller that forgets under-counts one guard instead of dying.
 *
 * @param {Trigger} trigger
 * @param {string} toolName
 * @param {string} command the tool's `command` input, "" where it has none
 * @returns {boolean}
 */
function firesOn(trigger, toolName, command) {
	if (trigger.unknown) return false;
	for (const rule of trigger.rules) {
		// A null matcher is the all-tools wildcard.
		if (rule.matcher !== null && !rule.matcher.test(toolName)) continue;
		if (rule.test === null) return true;
		// An `if` names the tool its glob is written against; a registration
		// whose matcher admits several tools narrows to that one here.
		if (rule.tool !== null && rule.tool !== toolName) continue;
		if (rule.test.test(command)) return true;
	}
	return false;
}

/**
 * The table as plain data — no RegExps — for printing or serialising.
 *
 * ONE ROUTE PRINTS ONE WAY, as settings.json spells it — every-tool as `*`,
 * never a compiled RegExp source (mantahostels#3296).
 *
 * AN `unknown` GUARD REPORTS NO ROUTES. Its readable registrations are a
 * partial reading of a guard `firesOn` refuses to count, and listing them reads
 * as "counted via these routes"; the `unknown` string names what could not be
 * read (mantahostels#3296). A reader wanting the registrations that DID read opens
 * settings.json — nothing here reports them.
 *
 * @param {Map<string, Trigger>} table
 * @returns {Array<{guard: string, denyCapable: boolean, matchers: string[], conditions: string[], unconditionalMatchers: string[], unknown: string | null}>}
 */
function triggerRows(table) {
	return [...table.values()]
		.map((t) => ({
			guard: t.guard,
			// Reported even for an unknown guard, unlike the routes: it is read off
			// the script on disk, not off the registration that would not parse.
			denyCapable: t.denyCapable,
			matchers: t.unknown ? [] : [...new Set(t.rules.map((r) => r.raw))],
			conditions: t.unknown ? [] : [...new Set(t.conditions)],
			// The matchers a registration binds with NO `if`, i.e. the tools every
			// call of which reaches this guard. Empty where every route is
			// condition-narrowed.
			unconditionalMatchers: t.unknown
				? []
				: [
						...new Set(
							t.rules.filter((r) => r.test === null).map((r) => r.raw),
						),
					],
			unknown: t.unknown,
		}))
		.sort((a, b) => a.guard.localeCompare(b.guard));
}

module.exports = {
	triggerTable,
	triggerRows,
	firesOn,
	DENY_EVENT,
	EVENTS,
	SCOPES,
};
