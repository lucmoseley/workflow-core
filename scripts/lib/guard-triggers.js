/*
 * guard-triggers.js — which tool call fires which tool-call hook, DERIVED
 * from the core's hook registration rather than written down (mantahostels#3287). Deny-capable
 * `PreToolUse` guards by default; `triggerTable`'s `scope` widens it to the
 * rest (mantahostels#3350) and its `event` moves it to `PostToolUse` (mantahostels#3356).
 *
 * WHY DERIVED. The lost-deny census (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/lost-deny-recoverability.md)
 * needed a true-invocation denominator per guard: not "how often did it print
 * something" but "how many tool calls reached it at all", silent allows
 * included. `matcher` already names the tools a registration binds to, and
 * `if` already names the command condition, so the table is a reading of the
 * registration and goes stale only if it does.
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
 *   - A DISPATCHER CORE IS READ OFF ITS MANIFEST ROW, NOT THE REGISTRATION
 *     (#3424). The `guard-dispatch.js` registration is expanded into one row
 *     per core of its event (`lib/guard-cores.js` `expandDispatched`), each on
 *     its own `tools` and judged by the dispatcher's own `if` reading
 *     (`lib/if-clause.js` `clausesAdmit`, which does split a compound
 *     command). The host's
 *     disabled cores and switched-off modules are read as they stand today,
 *     not as they stood when the corpus was written.
 *   - A `PostToolUse` POPULATION IS AN UPPER BOUND ON DELIVERY, and by more
 *     than the `PreToolUse` one (mantahostels#3356). Every `tool_use` block is a routed
 *     call either way, but a `PostToolUse` hook additionally never fires on a
 *     call that was denied or cancelled before it ran, and the transcript's
 *     `tool_use` block is written whether or not the call completed.
 */

const path = require("node:path");
const { registeredGuards } = require("./guard-fires.js");
const { buildToolCoverage, MatcherError } = require("./core-hooks.js");
const { cutAt } = require("./cut-at.js");
const { clausesAdmit, globToRegExp, parseIfClause } = require("./if-clause.js");
const { isDenyCapableIn, isDenyingCore } = require("./deny-capable.js");
const {
	DISPATCH_ENTRY,
	MANIFEST,
	corePath,
	expandDispatched,
	readManifest,
} = require("./guard-cores.js");

const ALL_ON = { disabled: () => false, moduleOn: () => true };

const DISPATCHER = path.basename(DISPATCH_ENTRY);

const DENY_EVENT = "PreToolUse";

/**
 * @type {ReadonlySet<string>}
 */
const EVENTS = new Set(["PreToolUse", "PostToolUse"]);

/**
 * @type {ReadonlySet<string>}
 */
const SCOPES = new Set(["deny", "nondeny", "all"]);

/**
 * @typedef {object} Trigger
 * @property {string} guard
 * @property {string | null} via
 * @property {boolean} denyCapable
 * @property {Array<{isToolCovered: (tool: string) => boolean, raw: string,
 *   tool: string | null, glob: string | null, test: RegExp | null}>} rules
 * @property {string[]} conditions
 * @property {string | null} unknown
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
	if (!SCOPES.has(scope))
		throw new Error(
			`unknown scope ${JSON.stringify(scope)} — one of ${[...SCOPES].join(", ")}`,
		);
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
 * @param {boolean} capable
 * @returns {boolean}
 */
function isInScope(scope, capable) {
	if (scope === "deny") return capable;
	if (scope === "nondeny") return !capable;
	return true;
}

/**
 * @param {Map<string, Trigger>} table
 * @param {string} guard
 * @param {boolean} capable
 * @param {string | null} [via]
 * @returns {Trigger}
 */
function ensureRow(table, guard, capable, via = null) {
	const existing = table.get(guard);
	if (existing) return existing;
	/** @type {Trigger} */
	const row = {
		guard,
		via,
		denyCapable: capable,
		rules: [],
		conditions: [],
		unknown: null,
	};
	table.set(guard, row);
	return row;
}

/**
 * @param {Trigger} row
 * @param {Registration} reg
 * @param {(guard: string, reason: string) => string} note
 * @returns {void}
 */
function addRegistration(row, reg, note) {
	const { guard } = row;
	const spelling = reg.matcher ?? "*";
	const raw = spelling === "" ? "*" : spelling;
	let isToolCovered;
	try {
		isToolCovered = buildToolCoverage(raw);
	} catch (err) {
		if (!(err instanceof MatcherError)) throw err;
		row.unknown = note(guard, `matcher ${JSON.stringify(raw)} is not a regexp`);
		return;
	}

	if (reg.if === undefined) {
		row.rules.push({ isToolCovered, raw, tool: null, glob: null, test: null });
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
		isToolCovered,
		raw,
		tool: parsed.tool,
		glob: parsed.glob,
		test: globToRegExp(parsed.glob),
	});
}

/**
 * @param {Trigger} row
 * @param {import("./guard-cores.js").CoreRow} core
 * @param {(guard: string, reason: string) => string} note
 * @returns {void}
 */
function addCore(row, core, note) {
	let matcher;
	try {
		matcher = new RegExp(`^(?:${core.tools})$`);
	} catch {
		row.unknown = note(
			row.guard,
			`core tools ${JSON.stringify(core.tools)} is not a regexp`,
		);
		return;
	}
	row.rules.push({
		isToolCovered: (tool) => matcher.test(tool),
		raw: core.tools,
		tool: null,
		glob: null,
		test: null,
	});
	row.conditions.push(...(core.if ?? []));
}

/**
 * @param {Record<string, any>} settings
 * @param {string[]} guardDirs
 * @param {{scope?: "deny" | "nondeny" | "all", event?: "PreToolUse" | "PostToolUse",
 *   manifest?: string, host?: Parameters<typeof import("./guard-cores.js").isDispatchedOn>[2]}} [options]
 * @returns {Map<string, Trigger>}
 */
function triggerTable(settings, guardDirs, options = {}) {
	const scope = options.scope ?? "deny";
	const event = options.event ?? DENY_EVENT;
	assertTableOptions(scope, event);
	const isDenyCapable = isDenyCapableIn(guardDirs);
	const manifestFile = options.manifest ?? MANIFEST;
	const cores = hostCores(manifestFile, event, options.host ?? ALL_ON);
	/** @type {Map<string, Trigger>} */
	const table = new Map();
	/** @type {Map<string, string[]>} */
	const reasons = new Map();
	/**
	 * @param {string} guard
	 * @param {string} reason
	 * @returns {string}
	 */
	const note = (guard, reason) => {
		const seen = reasons.get(guard) ?? [];
		if (!seen.includes(reason)) seen.push(reason);
		reasons.set(guard, seen);
		return seen.join("; ");
	};
	const regs = registeredGuards(settings)
		.filter((reg) => reg.event === event)
		.map((reg) => ({ ...reg, commandLine: reg.command }));
	for (const reg of expandDispatched(event, regs, { [event]: cores })) {
		const core = reg.core && cores.find((c) => c.name === reg.core);
		if (core) {
			const capable =
				event === DENY_EVENT &&
				isDenyingCore(corePath(core.core, path.dirname(manifestFile)));
			if (!isInScope(scope, capable)) continue;
			addCore(ensureRow(table, core.name, capable, DISPATCHER), core, note);
			continue;
		}
		const [guard] = cutAt(reg.key, " ");
		// lucmoseley/mantahostels#3356
		const capable = event === DENY_EVENT && isDenyCapable(guard);
		if (!isInScope(scope, capable)) continue;
		addRegistration(ensureRow(table, guard, capable), reg, note);
	}
	return table;
}

/**
 * @param {string} manifestFile
 * @param {string} event
 * @param {Parameters<typeof import("./guard-cores.js").isDispatchedOn>[2]} host
 * @returns {import("./guard-cores.js").CoreRow[]}
 */
function hostCores(manifestFile, event, host) {
	return (readManifest(manifestFile)[event] ?? []).filter(
		(c) => !host.disabled(c.name) && !(c.module && !host.moduleOn(c.module)),
	);
}

/**
 * @param {Trigger} trigger
 * @param {string} toolName
 * @param {string} command
 * @returns {boolean}
 */
function firesOn(trigger, toolName, command) {
	if (trigger.unknown) return false;
	if (trigger.via)
		return (
			trigger.rules.some((r) => r.isToolCovered(toolName)) &&
			clausesAdmit(trigger.conditions, toolName, command)
		);
	for (const rule of trigger.rules) {
		if (!rule.isToolCovered(toolName)) continue;
		if (rule.test === null) return true;
		if (rule.tool !== null && rule.tool !== toolName) continue;
		if (rule.test.test(command)) return true;
	}
	return false;
}

/**
 * @param {Map<string, Trigger>} table
 * @returns {Array<{guard: string, via: string | null, denyCapable: boolean, matchers: string[], conditions: string[], unconditionalMatchers: string[], unknown: string | null}>}
 */
function triggerRows(table) {
	return [...table.values()]
		.map((t) => ({
			guard: t.guard,
			via: t.via,
			denyCapable: t.denyCapable,
			matchers: t.unknown ? [] : [...new Set(t.rules.map((r) => r.raw))],
			conditions: t.unknown ? [] : [...new Set(t.conditions)],
			unconditionalMatchers: t.unknown ? [] : unconditionalMatchersOf(t),
			unknown: t.unknown,
		}))
		.sort((a, b) => a.guard.localeCompare(b.guard));
}

/**
 * @param {Trigger} t
 * @returns {string[]}
 */
function unconditionalMatchersOf(t) {
	if (!t.via)
		return [
			...new Set(t.rules.filter((r) => r.test === null).map((r) => r.raw)),
		];
	const named = new Set(t.conditions.map((c) => parseIfClause(c)?.tool));
	const tools = t.rules
		.flatMap((r) => r.raw.split("|"))
		.filter((tool) => !named.has(tool));
	return tools.length > 0 ? [tools.join("|")] : [];
}

module.exports = {
	triggerTable,
	triggerRows,
	firesOn,
	DENY_EVENT,
	DISPATCHER,
	EVENTS,
	SCOPES,
};
