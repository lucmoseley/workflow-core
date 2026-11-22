const fs = require("node:fs");
const path = require("node:path");

const { readRuleText, withRuleStore } = require("./rule-text");
const { hostRoot } = require("./host-root.js");
const { moduleOn } = require("./workflow-core-config");
const { requiredGroup } = require("./regex-group.js");
const { caught } = require("./caught.js");
const { limitIn } = require("./hook-limits.js");
const {
	MatcherError,
	isToolCovered,
	readOwnHooks,
} = require("./core-hooks.js");
const { AFTER_EVENTS } = require("./hook-events.js");
const { closeOf, statementEnd } = require("./js-lex.js");
const { blankComments } = require("./strip-comments.js");
const {
	expandDispatched,
	manifestAt,
	readManifest,
} = require("./guard-cores.js");
const { walkReach } = require("./guard-reach.js");
const {
	RULE_ARG_RE,
	RULE_ID,
	directAccessorCalls,
	directRuleCounts,
	emissionMatches,
} = require("./rule-emission-calls.js");

const CAP_FILE = path.join(__dirname, "hook-limits.js");

const EVENT = "PreToolUse";

const CAP_SOURCE = path.join("scripts", "lib", "hook-limits.js");

const LATCHED_RULE_RE = /\bctx\.told\(\s*["'](?:rule:)?([a-z0-9-]+)["']\s*\)/g;

const MARKED_RULE_RE = /\blatchAfter:\s*["'](?:rule:)?([a-z0-9-]+)["']/g;

const MODULE_RULE_RE = new RegExp(
	`^[ \\t]*(?:skip:\\s*)?(?:\\.\\.\\.)?ruleModule\\(\\s*\\w+\\s*,\\s*["']([a-z]+)["']\\s*,\\s*\\[((?:\\s*["']${RULE_ID}["']\\s*,?)+)\\s*\\]`,
	"gm",
);

const WIRED_SCRIPT_RE =
	/(?:^|[\s"'/=([])((?:scripts|\.husky|\.claude)\/[\w.-]+(?:\/[\w.-]+)*\.(?:sh|js|mjs|cjs|ts))/g;

const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * @typedef {{ hooks?: Record<string, Array<{ matcher?: string, hooks?: Array<{ command?: string, args?: unknown }> }>> }} Settings
 */

/**
 * @typedef {{ matcher: string | undefined, commandLine: string }} Registration
 */

/** @param {{ command?: string, args?: unknown }} entry @returns {string} */
function buildHookCommandLine(entry) {
	const args = Array.isArray(entry?.args)
		? entry.args.filter((a) => typeof a === "string")
		: [];
	return [entry?.command ?? "", ...args].join(" ");
}

/**
 * @typedef {{ file: string, bytes: number, calls: number, ids: string[] }} GuardFigure
 */

/** @param {string} rel */
const isNodeGuard = (rel) => rel.endsWith(".js");

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

/** @param {string} file @param {string} name @returns {number} */
function readLimitLine(file, name) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		throw new RuleEmissionError(
			`rule-emission: cannot read ${file}, where ${name} is assigned: ${caught(e).message}`,
			{ cause: e },
		);
	}
	const n = limitIn(text, name);
	if (n === null)
		throw new RuleEmissionError(
			`rule-emission: no \`const ${name} = <n>;\` line in ${file}, ` +
				"and the ceiling is read rather than restated here, so there is no fallback.",
		);
	return n;
}

/** @param {string} [file] @returns {number} */
function readRuleCap(file = CAP_FILE) {
	return readLimitLine(file, "RULE_CAP");
}

/** @returns {number} */
function readHookPersistChars() {
	return readLimitLine(CAP_FILE, "HOOK_PERSIST_CHARS");
}

/** @param {string} text @returns {string[][]} */
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

/** @param {string} text @param {string} root @returns {Set<string>} */
function gatedOffIds(text, root) {
	/** @type {Set<string>} */
	const off = new Set();
	for (const m of text.matchAll(MODULE_RULE_RE)) {
		const module = /** @type {import("./workflow-core-config").Module} */ (
			m[1]
		);
		if (moduleOn(module, { root })) continue;
		for (const a of (m[2] ?? "").matchAll(RULE_ARG_RE)) if (a[1]) off.add(a[1]);
	}
	return off;
}

const NODE_BINDING_RE =
	/\b(?:(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*=(?!=)|function[ \t]+([A-Za-z_$][\w$]*)[ \t]*\()/g;

const NODE_FUNCTION_VALUE_RE =
	/^\s*(?:async\s+)?(?:function\b[^(]*\([^)]*\)\s*|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*)(?=\{|\(\s*\{)/;

/**
 * @typedef {object} NodeBinding
 * @property {string} name
 * @property {[number, number]} head
 * @property {[number, number][]} values
 */

/** @param {string} text @param {number} open @returns {[number, number][]} */
function returnSpans(text, open) {
	const body = bracketed(text, open);
	return [...body.matchAll(/\breturn\b(?![ \t]*\{)/g)].map((r) => {
		const from = (r.index ?? 0) + r[0].length;
		return [open + from, open + statementEnd(body, from)];
	});
}

/**
 * @param {string} text
 * @param {RegExpMatchArray} m
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

/** @param {string} text @param {number} open @returns {string} */
function bracketed(text, open) {
	if (open === -1) return "";
	const end = closeOf(text, open);
	return text.slice(open, end === -1 ? text.length : end);
}

/**
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

/** @param {string} text @param {string} id @returns {[number, number][]} */
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

/** @param {string} text @param {string} id @returns {number} */
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

/** @typedef {"none" | "bounded" | "ambiguous"} LatchState */

/** @type {Record<LatchState, number>} */
const LATCH_RANK = { none: 0, ambiguous: 1, bounded: 2 };

/** @param {LatchState} a @param {LatchState} b @returns {LatchState} */
function weakerLatch(a, b) {
	return LATCH_RANK[a] <= LATCH_RANK[b] ? a : b;
}

/** @param {string} text @returns {string[]} */
function latchedRuleIds(text) {
	return idsMatching(text, LATCHED_RULE_RE);
}

/** @param {string} text @returns {string[]} */
function markedRuleIds(text) {
	return idsMatching(text, MARKED_RULE_RE);
}

/** @param {string} text @param {RegExp} re @returns {string[]} */
function idsMatching(text, re) {
	/** @type {string[]} */
	const ids = [];
	for (const m of text.matchAll(re)) {
		const id = m[1];
		if (id && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/** @param {Iterable<number>} ns @returns {number} */
function sum(ns) {
	let t = 0;
	for (const n of ns) t += n;
	return t;
}

/**
 * @param {string[][]} calls
 * @param {(id: string) => string} resolve
 * @param {number} cap
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
 * @param {Record<string, string>} sources
 * @param {string} rel
 * @returns {string}
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
 * @param {string} rel
 * @param {string} text
 * @param {(rel: string) => string | null} readLib
 * @returns {string}
 */
function readEffectiveSource(rel, text, readLib) {
	return [text, ...readSourcedClosure(rel, text, readLib).values()].join("\n");
}

/**
 * @param {string} rel
 * @param {string} text
 * @param {(rel: string) => string | null} readLib
 * @returns {Map<string, string>}
 */
function readSourcedClosure(rel, text, readLib) {
	const reached = walkReach(
		[rel],
		(paths) => paths.map((p) => (p === rel ? text : readLib(p))),
		{
			follow: ["source", "require"],
			keep: (edge, from) =>
				edge.kind === "source" ||
				(isNodeGuard(from) && edge.to.startsWith("scripts/lib/")),
		},
	);
	reached.delete(rel);
	/** @type {Map<string, string>} */
	const libs = new Map();
	for (const [lib, libText] of reached)
		if (libText !== null) libs.set(lib, libText);
	return libs;
}

/** @param {string} abs @param {string} rel @returns {string} */
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
 * @param {Settings} settings
 * @param {string} event
 * @param {import("./guard-cores.js").Manifest} [manifest]
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
 * @param {string | undefined} matcher
 * @param {string} tool
 * @returns {boolean}
 */
function isCovered(matcher, tool) {
	try {
		return isToolCovered(matcher, tool);
	} catch (e) {
		if (!(e instanceof MatcherError)) throw e;
		throw new RuleEmissionError(
			`rule-emission: the ${EVENT} matcher ${JSON.stringify(matcher)} is not a ` +
				`valid regular expression, so the tools it covers cannot be read: ${caught(e.cause).message}`,
			{ cause: e },
		);
	}
}

/** @typedef {{ bytes: number | null, latch: LatchState }} DirectFigure */

/**
 * @typedef {{ id: string, resolves: boolean, bound: boolean, marked: boolean }} LatchFault
 */

/**
 * @typedef {{ ids: string[], bytes: Map<string, number>, overCap: { id: string, bytes: number }[], calls: number, direct: Map<string, DirectFigure>, latchFaults: LatchFault[] }} GuardReach
 */

/**
 * @param {string} rel
 * @param {Record<string, string> | undefined} sources
 * @param {string} root
 * @returns {string}
 */
function readGuardSource(rel, sources, root) {
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
 * @param {string} rel
 * @param {string} effective
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
 * @param {Map<string, number>} counts
 * @param {Set<string>} latched
 * @param {Set<string>} marked
 * @param {(id: string) => number} sitesOf
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
 * @param {Map<string, number>} counts
 * @param {Set<string>} latched
 * @param {Set<string>} marked
 * @param {string[][]} calls
 * @returns {LatchFault[]}
 */
function guardLatchFaults(counts, latched, marked, calls) {
	/** @type {LatchFault[]} */
	const latchFaults = [];
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
		const selfBounding = !orphanSplice && !resolves && !bound;
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

/** @param {Registration[]} registrations @returns {Set<string>} */
function matcherTools(registrations) {
	/** @type {Set<string>} */
	const tools = new Set();
	for (const { matcher } of registrations)
		for (const token of (matcher ?? "").split("|"))
			if (TOOL_NAME_RE.test(token)) tools.add(token);
	return tools;
}

/**
 * @param {string} tool
 * @param {Registration[]} registrations
 * @param {Map<string, GuardReach>} byGuard
 * @returns {{ bytes: number, ids: string[], guards: GuardFigure[] }}
 */
function toolFigure(tool, registrations, byGuard) {
	/** @type {GuardFigure[]} */
	const guards = [];
	const seen = new Set();
	/** @type {Map<string, number>} */
	const union = new Map();
	for (const { matcher, commandLine } of registrations) {
		if (!isCovered(matcher, tool)) continue;
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
	return [...overCapById.entries()].map(([id, v]) => ({
		id,
		bytes: v.bytes,
		guards: v.guards.slice().sort(),
	}));
}

/**
 * @param {Map<string, GuardReach>} byGuard
 * @returns {(LatchFault & { guard: string })[]}
 */
function latchFaultRows(byGuard) {
	return [...byGuard]
		.flatMap(([rel, g]) => g.latchFaults.map((f) => ({ ...f, guard: rel })))
		.sort((a, b) => a.id.localeCompare(b.id) || a.guard.localeCompare(b.guard));
}

/**
 * @param {Map<string, GuardReach>} byGuard
 * @param {Map<string, number>} acrossGuards
 * @returns {{ id: string, bytes: number | null, guards: string[], counted: boolean, latched: LatchState }[]}
 */
function directRows(byGuard, acrossGuards) {
	/** @type {Map<string, { bytes: number | null, guards: string[], latched: LatchState }>} */
	const directById = new Map();
	for (const [rel, g] of byGuard)
		for (const [id, d] of g.direct) {
			const entry = directById.get(id);
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
 * @typedef {object} ReachOptions
 * @property {Settings} [settings]
 * @property {Record<string, string>} [sources]
 * @property {string} [root]
 * @property {string} [rulesDir]
 * @property {string} [rulesFallbackDir]
 * @property {string} [capFile]
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
	/** @type {Map<string, number>} */
	const acrossGuards = new Map();
	for (const g of byGuard.values())
		for (const [id, n] of g.bytes) acrossGuards.set(id, n);
	for (const tool of [...tools].sort())
		out[tool] = toolFigure(tool, registrations, byGuard);

	const overCap = overCapRows(byGuard);
	const direct = directRows(byGuard, acrossGuards);

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

/**
 * @typedef {{ event: string, matcher: string | undefined, file: string, once: { bytes: number, ids: string[] }, perFire: { id: string, bytes: number | null }[] }} AfterHook
 */

/**
 * @param {ReachOptions} [options]
 * @returns {{ cap: number, hooks: AfterHook[], once: { bytes: number, ids: string[] }, overCap: { id: string, bytes: number, guards: string[] }[], latchFaults: (LatchFault & { guard: string })[] }}
 */
function reachableAfterCall(options = {}) {
	const root = options.root ?? hostRoot();
	const settings = readSettings(options, root);
	const manifest = readManifest(manifestAt(root));
	const wired = AFTER_EVENTS.flatMap((event) =>
		registrationsOn(settings, event, manifest).map((r) => ({ ...r, event })),
	);
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
	CAP_SOURCE,
	EVENT,
	registrationsOn,
	WIRED_SCRIPT_RE,
	readRuleCap,
	readHookPersistChars,
	buildHookCommandLine,
	readSourcedClosure,
	reachableAfterCall,
	reachableByTool,
};
