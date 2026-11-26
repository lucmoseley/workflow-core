#!/usr/bin/env node
// #5661
const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const { caught } = require("./lib/caught.js");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const {
	guardKey,
	transcriptDirs,
	readTranscriptCorpus,
	fireSpans,
	needleIn,
} = require("./lib/guard-fires.js");
const { readHostHookSources, mergeHooks } = require("./lib/core-hooks.js");
const { mainChainRecords } = require("./lib/transcript.js");
const { guardDirs } = require("./lib/deny-capable.js");
const {
	firesOn,
	triggerTable,
	triggerRows,
	DENY_EVENT,
	DISPATCHER,
	EVENTS,
	SCOPES,
} = require("./lib/guard-triggers.js");
const { manifestAt } = require("./lib/guard-cores.js");
const { coreHost } = require("./lib/workflow-core-config.js");
const { parseSince } = require("./count-guard-fires.js");
const rateTable = require("./lib/guard-deny-rates.js");
const { hostRoot } = require("./lib/host-root.js");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const { cutAt } = require("./lib/cut-at.js");
const { byCodeUnit } = require("./lib/by-code-unit.js");

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: [
		`Usage: node ${scriptPath("lost-deny-rates.js")} [--dir <path>] [--since <date>]`,
		"         [--until <date>] [--json] [--triggers]",
		"         [--scope deny|nondeny|all] [--event PreToolUse|PostToolUse]",
		"         [--failures] [--union]",
	].join("\n"),
	flags: {
		"--dir": "value",
		"--since": "value",
		"--until": "value",
		"--json": "boolean",
		"--triggers": "boolean",
		"--scope": "value",
		"--event": "value",
		"--failures": "boolean",
		"--union": "boolean",
	},
};

const OVERRIDE = process.env.WFC_LOST_DENY_ROOT
	? path.resolve(process.env.WFC_LOST_DENY_ROOT)
	: null;
const HOST = OVERRIDE ?? hostRoot();
const CORE = OVERRIDE ?? path.join(__dirname, "..");
const FAILURE_TYPES = new Set(["hook_cancelled", "hook_non_blocking_error"]);
const CORE_MANIFEST = manifestAt(CORE);
const CORE_HOST = coreHost(HOST);

/** @param {string} key */
const basenameOf = (key) => cutAt(key, " ")[0];

/**
 * @param {Record<string, any>} needles
 * @param {Map<string, unknown>} triggers
 * @returns {Map<string, Needle[]>}
 */
function denyNeedlesByGuard(needles, triggers) {
	/** @type {Map<string, Needle[]>} */
	const out = new Map();
	for (const [key, entry] of Object.entries(needles?.guards ?? {})) {
		for (const n of entry?.needles ?? []) {
			const guard = n.core ?? basenameOf(key);
			if (!triggers.has(guard)) continue;
			out.set(guard, [...(out.get(guard) ?? []), n]);
		}
	}
	return out;
}

/**
 * @param {Map<string, Set<string>>} into
 * @param {string} guard
 * @param {string} id
 */
function addCall(into, guard, id) {
	let set = into.get(guard);
	if (!set) {
		set = new Set();
		into.set(guard, set);
	}
	set.add(id);
}

/**
 * @param {TranscriptRecord} record
 * @returns {string[]}
 */
function callIds(record) {
	const attached = record?.attachment?.toolUseID;
	if (typeof attached === "string" && attached) return [attached];
	const content = record?.message?.content;
	const ids = [];
	if (Array.isArray(content))
		for (const part of content)
			if (
				part?.type === "tool_result" &&
				typeof part.tool_use_id === "string" &&
				part.tool_use_id
			)
				ids.push(part.tool_use_id);
	if (ids.length > 0) return ids;
	return [typeof record?.uuid === "string" ? record.uuid : ""];
}

/**
 * @param {string | null} at
 * @param {{since: string | null, until: string | null}} window
 * @returns {"keep" | "before" | "after" | "undated"}
 */
function windowVerdict(at, window) {
	if (!window.since && !window.until) return "keep";
	if (!at) return "undated";
	if (window.since && at < window.since) return "before";
	if (window.until && at > window.until) return "after";
	return "keep";
}

/**
 * @param {number} hits
 * @param {number} n
 * @returns {{pct: number, lowPct: number, highPct: number} | null}
 */
function wilson(hits, n) {
	if (!n) return null;
	const z = 1.959_964;
	const p = hits / n;
	const d = 1 + (z * z) / n;
	const centre = p + (z * z) / (2 * n);
	const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
	/** @param {number} x */
	const round = (x) => Number(Math.min(100, Math.max(0, x * 100)).toFixed(10));
	return {
		pct: round(p),
		lowPct: round((centre - spread) / d),
		highPct: round((centre + spread) / d),
	};
}

/**
 * @param {TranscriptRecord["attachment"]} a
 * @param {Map<string, Map<string, boolean>> | null} classify
 * @param {{failures: Map<string, number>}} acc
 */
function bucketFailure(a, classify, acc) {
	const event =
		typeof a.hookEvent === "string" && a.hookEvent ? a.hookEvent : "(no event)";
	const guards = classify?.get(event) ?? null;
	const bucket = guards ? guardBucket(a, event, guards) : event;
	acc.failures.set(bucket, (acc.failures.get(bucket) || 0) + 1);
}

/**
 * @typedef {import("./lib/guard-fires.js").Needle} Needle
 * @typedef {import("./lib/transcript.js").TranscriptRecord} TranscriptRecord
 * @typedef {import("./lib/transcript.js").TranscriptBlock} TranscriptBlock
 */

/**
 * @param {TranscriptRecord["attachment"]} a
 * @param {string} event
 * @param {Map<string, boolean>} guards
 * @returns {string}
 */
function guardBucket(a, event, guards) {
	const { named, pinned } = attribution(a);
	if (!named || !pinned) return `${event}, unattributed`;
	if (!guards.has(named)) return `${event}, unregistered`;
	if (event !== DENY_EVENT) return `${event}, guard named`;
	return guards.get(named) ? `${event}, deny-capable` : `${event}, non-deny`;
}

/**
 * @param {TranscriptRecord["attachment"]} a
 * @returns {{named: string, pinned: string}}
 */
function attribution(a) {
	return {
		named:
			typeof a.command === "string" && a.command
				? basenameOf(guardKey(a.command))
				: "",
		pinned: typeof a.toolUseID === "string" && a.toolUseID ? a.toolUseID : "",
	};
}

/**
 * @param {Map<string, UnionEntry>} into
 * @param {string} tool
 * @returns {UnionEntry}
 */
function unionEntry(into, tool) {
	let entry = into.get(tool);
	if (!entry) {
		entry = {
			calls: new Set(),
			blocks: 0,
			records: 0,
			idless: 0,
			failed: new Map(),
		};
		into.set(tool, entry);
	}
	return entry;
}

/** @typedef {{calls: Set<string>, blocks: number, records: number, idless: number, failed: Map<string, number>}} UnionEntry */

/**
 * @param {TranscriptRecord["attachment"]} a
 * @param {string} event
 * @returns {string}
 */
function hookTool(a, event) {
	const name = typeof a.hookName === "string" ? a.hookName : "";
	return name.startsWith(`${event}:`) && name.length > event.length + 1
		? name.slice(event.length + 1)
		: "(no tool)";
}

/** @typedef {{window: {since: string | null, until: string | null}, event?: string, classify?: Map<string, Map<string, boolean>> | null, union?: boolean}} ScanOptions */

/** @typedef {{lost: Map<string, number>, denyCalls: Map<string, Set<string>>, anyCalls: Map<string, Set<string>>, population: Map<string, number>, lostCalls: Set<string>, failures: Map<string, number>, union: Map<string, UnionEntry>, undated: number, unresolved: number, first: string | null, last: string | null, skipped: number, zeroed: number}} ScanAcc */

/**
 * @param {string} text
 * @param {ScanAcc} acc
 * @param {ScanOptions & {tier: "main" | "subagent", triggers: Map<string, import("./lib/guard-triggers.js").Trigger>, needles: Map<string, Needle[]>}} options
 */
function scanTranscript(text, acc, options) {
	const { tier, triggers, needles, window } = options;
	const event = options.event ?? DENY_EVENT;
	const classify = options.classify ?? null;
	const union = options.union ?? false;
	const stats = { skipped: 0, zeroed: 0 };
	const records = [...mainChainRecords(text, tier, stats)];
	const calls = new Map(
		records.flatMap(toolCalls).flatMap((c) => (c.id ? [[c.id, c]] : [])),
	);
	/** @type {Array<{id: string, at: string | null}>} */
	const dispatched = [];
	for (const record of records) {
		const at = typeof record.timestamp === "string" ? record.timestamp : null;
		const verdict = windowVerdict(at, window);
		if (verdict === "undated") acc.undated++;
		if (verdict !== "keep") continue;

		const loss = countFailure(record?.attachment, at, acc, {
			event,
			classify,
			union,
			triggers,
		});
		if (loss) dispatched.push(loss);

		countDenyEvents(record, needles, acc);

		countPopulation(record, acc, { triggers, union });
	}
	acc.skipped += stats.skipped;
	acc.zeroed += stats.zeroed;
	for (const loss of dispatched) creditCores(acc, triggers, calls, loss);
}

/**
 * @param {ScanAcc} acc
 * @param {Map<string, import("./lib/guard-triggers.js").Trigger>} triggers
 * @param {Map<string, ToolCall>} calls
 * @param {{id: string, at: string | null}} loss
 */
function creditCores(acc, triggers, calls, { id, at }) {
	const call = calls.get(id);
	if (!call) {
		acc.unresolved++;
		return;
	}
	for (const [guard, t] of triggers)
		if (t.via === DISPATCHER && firesOn(t, call.name, call.command))
			recordLoss(acc, guard, id, at);
}

/**
 * @param {TranscriptRecord["attachment"] | undefined} a
 * @param {string | null} at
 * @param {ScanAcc} acc
 * @param {{event: string, classify: Map<string, Map<string, boolean>> | null, union: boolean, triggers: Map<string, import("./lib/guard-triggers.js").Trigger>}} ctx
 * @returns {{id: string, at: string | null} | null}
 */
function countFailure(a, at, acc, ctx) {
	if (!a || !FAILURE_TYPES.has(a.type)) return null;
	const { event, classify, union, triggers } = ctx;
	bucketFailure(a, classify, acc);
	if (union && a.hookEvent === event) countUnionFailure(a, event, acc);
	if (
		a.hookEvent !== event ||
		typeof a.command !== "string" ||
		!a.command ||
		typeof a.toolUseID !== "string" ||
		!a.toolUseID
	)
		return null;
	const guard = basenameOf(guardKey(a.command));
	if (guard === DISPATCHER) return { id: a.toolUseID, at };
	if (triggers.has(guard)) recordLoss(acc, guard, a.toolUseID, at);
	return null;
}

/**
 * @param {TranscriptRecord["attachment"]} a
 * @param {string} event
 * @param {ScanAcc} acc
 */
function countUnionFailure(a, event, acc) {
	const { named, pinned } = attribution(a);
	if (named && pinned) return;
	const entry = unionEntry(acc.union, hookTool(a, event));
	entry.records++;
	if (pinned) entry.failed.set(pinned, (entry.failed.get(pinned) || 0) + 1);
	else entry.idless++;
}

/**
 * @param {ScanAcc} acc
 * @param {string} guard
 * @param {string} id
 * @param {string | null} at
 */
function recordLoss(acc, guard, id, at) {
	acc.lost.set(guard, (acc.lost.get(guard) || 0) + 1);
	acc.lostCalls.add(id);
	if (!at) return;
	if (!acc.first || at < acc.first) acc.first = at;
	if (!acc.last || at > acc.last) acc.last = at;
}

/**
 * @param {TranscriptRecord} record
 * @param {Map<string, Needle[]>} needles
 * @param {ScanAcc} acc
 */
function countDenyEvents(record, needles, acc) {
	const spans = fireSpans(record).filter((s) => s.route !== "cli");
	if (spans.length === 0) return;
	const fallback = callIds(record);
	for (const [guard, list] of needles) {
		for (const span of spans) {
			const ids = span.toolUseID ? [span.toolUseID] : fallback;
			const { any, deny } = spanMatch(span.text, list);
			if (any) addCalls(acc.anyCalls, guard, ids);
			if (deny) addCalls(acc.denyCalls, guard, ids);
		}
	}
}

/**
 * @param {string} text
 * @param {Needle[]} list
 * @returns {{any: boolean, deny: boolean}}
 */
function spanMatch(text, list) {
	let any = false;
	let deny = false;
	for (const needle of list) {
		if (!needleIn(text, needle)) continue;
		any = true;
		if (needle.kind === "deny") deny = true;
	}
	return { any, deny };
}

/**
 * @param {Map<string, Set<string>>} into
 * @param {string} guard
 * @param {string[]} ids
 */
function addCalls(into, guard, ids) {
	for (const id of ids) addCall(into, guard, id);
}

/**
 * @param {TranscriptRecord} record
 * @param {ScanAcc} acc
 * @param {{triggers: Map<string, import("./lib/guard-triggers.js").Trigger>, union: boolean}} ctx
 */
function countPopulation(record, acc, ctx) {
	if (record?.type !== "assistant") return;
	const content = record.message?.content;
	if (!Array.isArray(content)) return;
	for (const [i, block] of content.entries()) {
		if (block?.type !== "tool_use") continue;
		const call = toolCall(block);
		const routed = routedGuards(ctx.triggers, call);
		for (const guard of routed)
			acc.population.set(guard, (acc.population.get(guard) || 0) + 1);
		if (!ctx.union || routed.length === 0) continue;
		const uuid = typeof record.uuid === "string" ? record.uuid : "";
		const id = call.id ?? `${uuid}#${i}`;
		const entry = unionEntry(acc.union, call.name);
		entry.calls.add(id);
		entry.blocks++;
	}
}

/**
 * @typedef {{name: string, command: string, id: string | null}} ToolCall
 */

/**
 * @param {TranscriptRecord} record
 * @returns {ToolCall[]}
 */
function toolCalls(record) {
	const content = record?.type === "assistant" && record.message?.content;
	if (!Array.isArray(content)) return [];
	return content.filter((b) => b?.type === "tool_use").map(toolCall);
}

/**
 * @param {TranscriptBlock} block
 * @returns {ToolCall}
 */
function toolCall(block) {
	const name = typeof block.name === "string" ? block.name : "";
	const command =
		block.input && typeof block.input.command === "string"
			? block.input.command
			: "";
	const id = typeof block.id === "string" && block.id ? block.id : null;
	return { name, command, id };
}

/**
 * @param {Map<string, import("./lib/guard-triggers.js").Trigger>} triggers
 * @param {{name: string, command: string}} call
 * @returns {string[]}
 */
function routedGuards(triggers, call) {
	/** @type {string[]} */
	const routed = [];
	for (const [guard, trigger] of triggers)
		if (firesOn(trigger, call.name, call.command)) routed.push(guard);
	return routed;
}

function freshAcc() {
	return {
		lost: new Map(),
		denyCalls: new Map(),
		anyCalls: new Map(),
		population: new Map(),
		lostCalls: new Set(),
		failures: new Map(),
		/** @type {Map<string, UnionEntry>} */
		union: new Map(),
		undated: 0,
		unresolved: 0,
		first: null,
		last: null,
		skipped: 0,
		zeroed: 0,
	};
}

/**
 * @param {Array<{file: string, tier: "main" | "subagent"}>} files
 * @param {Map<string, import("./lib/guard-triggers.js").Trigger>} triggers
 * @param {Map<string, Needle[]>} needles
 * @param {ScanOptions} options
 */
function scan(files, triggers, needles, options) {
	if (options.event && !EVENTS.has(options.event))
		throw new Error(
			`unknown event ${JSON.stringify(options.event)} — one of ${[...EVENTS].join(", ")}`,
		);
	const acc = freshAcc();
	/** @type {string[]} */
	const unreadable = [];
	let scanned = 0;
	for (const { file, tier } of files) {
		let text;
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {
			unreadable.push(file);
			continue;
		}
		scanTranscript(text, acc, { ...options, tier, triggers, needles });
		scanned++;
	}
	return { acc, unreadable, scanned };
}

/**
 * @param {number} lost
 * @param {number|null} population
 * @returns {number|null}
 */
function lossPercent(lost, population) {
	if (population === null) return null;
	if (population) return (lost / population) * 100;
	return 0;
}

/**
 * @param {Map<string, import("./lib/guard-triggers.js").Trigger>} triggers
 * @param {ReturnType<typeof scan>["acc"]} acc
 * @param {Map<string, Needle[]>} needles
 */
function rows(triggers, acc, needles) {
	const out = [];
	for (const [guard, trigger] of triggers)
		out.push(guardRow(guard, trigger, acc, needles));
	return out.sort(byExpectedEscapes);
}

/**
 * @param {string} guard
 * @param {import("./lib/guard-triggers.js").Trigger} trigger
 * @param {ReturnType<typeof scan>["acc"]} acc
 * @param {Map<string, Needle[]>} needles
 */
function guardRow(guard, trigger, acc, needles) {
	const lost = acc.lost.get(guard) || 0;
	const denies = acc.denyCalls.get(guard)?.size || 0;
	const spoke = acc.anyCalls.get(guard)?.size || 0;
	const population = trigger.unknown ? null : acc.population.get(guard) || 0;
	const hasDenyNeedle = (needles?.get(guard) ?? []).some(
		(n) => n.kind === "deny",
	);
	const rate =
		population === null || !hasDenyNeedle ? null : wilson(denies, population);
	return {
		guard,
		lost,
		denies,
		spoke,
		population,
		unknown: trigger.unknown,
		// lucmoseley/mantahostels#3350
		cannotDeny: !trigger.denyCapable,
		noDenyNeedle: population !== null && trigger.denyCapable && !hasDenyNeedle,
		lossPct: lossPercent(lost, population),
		ratePct: rate?.pct ?? null,
		rateLowPct: rate?.lowPct ?? null,
		rateHighPct: rate?.highPct ?? null,
		expected: rate === null ? null : (lost * rate.pct) / 100,
		expectedLow: rate === null ? null : (lost * rate.lowPct) / 100,
		expectedHigh: rate === null ? null : (lost * rate.highPct) / 100,
	};
}

/**
 * @param {ReturnType<typeof guardRow>} a
 * @param {ReturnType<typeof guardRow>} b
 * @returns {number}
 */
function byExpectedEscapes(a, b) {
	if (a.expected === null && b.expected === null)
		return byCodeUnit(a.guard, b.guard);
	return (
		(b.expected ?? Number.POSITIVE_INFINITY) -
		(a.expected ?? Number.POSITIVE_INFINITY)
	);
}

/**
 * @param {Map<string, import("./lib/guard-triggers.js").Trigger>} triggers
 * @returns {string[]}
 */
function unpinned(triggers) {
	return [...triggers]
		.filter(([g, t]) => t.denyCapable && !rateTable.RATES[g])
		.map(([g]) => g)
		.sort();
}

/** @type {ReadonlyMap<string, string>} */
const TRUE_DENOMINATOR = new Map([
	["PreToolUse, deny-capable", "mantahostels#3287"],
	["PreToolUse, non-deny", "mantahostels#3350"],
	["PostToolUse, guard named", "mantahostels#3356"],
	["PostToolUse, unattributed", "mantahostels#3372"],
]);

/**
 * @param {Map<string, number>} failures
 * @returns {{rows: Array<{bucket: string, records: number, pct: number | null, ticket: string | null}>, total: number, covered: number, pct: number | null}}
 */
function failureShare(failures) {
	const sorted = [...failures].sort(
		(a, b) => b[1] - a[1] || byCodeUnit(a[0], b[0]),
	);
	const total = sorted.reduce((n, [, c]) => n + c, 0);
	let covered = 0;
	const bucketRows = sorted.map(([bucket, records]) => {
		const ticket = TRUE_DENOMINATOR.get(bucket) ?? null;
		if (ticket) covered += records;
		return {
			bucket,
			records,
			pct: total ? (records / total) * 100 : null,
			ticket,
		};
	});
	return {
		rows: bucketRows,
		total,
		covered,
		pct: total ? (covered / total) * 100 : null,
	};
}

/**
 * @param {Map<string, number>} failures
 * @returns {string}
 */
function renderFailures(failures) {
	const { rows: bucketRows, total, covered, pct } = failureShare(failures);
	const lines = [];
	lines.push("");
	lines.push(
		`HOOK FAILURES on this sweep: ${total} record(s) (hook_cancelled + hook_non_blocking_error)`,
	);
	lines.push("");
	lines.push(
		"bucket                            records    share   true denominator",
	);
	for (const r of bucketRows)
		lines.push(
			`${r.bucket.padEnd(33)} ${String(r.records).padStart(7)}  ${num(r.pct, 2).padStart(6)}%   ${r.ticket ?? "—"}`,
		);
	lines.push("");
	lines.push(
		`SHARE on a true tool-call denominator: ${num(pct, 1)}% (${covered} of ${total})`,
	);
	lines.push(
		"  Measured on THIS corpus and this sweep. A share from another run prices",
	);
	lines.push(
		"  another corpus: the two are not nested (mantahostels#3350, Correction 2).",
	);
	return lines.join("\n");
}

/**
 * @param {Map<string, UnionEntry>} union
 * @returns {{rows: Array<UnionRow & {tool: string}>, total: UnionRow}}
 * @typedef {{calls: number, blocks: number, records: number, failedCalls: number, inUnion: number, outside: number, failurePct: number | null}} UnionRow
 */
function unionShare(union) {
	const toolRows = [...union.keys()].sort().map((tool) => {
		const e = unionEntry(union, tool);
		let inUnion = 0;
		let outside = e.idless;
		for (const [id, n] of e.failed)
			if (e.calls.has(id)) inUnion++;
			else outside += n;
		return {
			tool,
			calls: e.calls.size,
			blocks: e.blocks,
			records: e.records,
			failedCalls: e.failed.size,
			inUnion,
			outside,
			failurePct:
				e.calls.size > 0 ? ((e.records - outside) / e.calls.size) * 100 : null,
		};
	});
	/** @param {"calls" | "blocks" | "records" | "failedCalls" | "inUnion" | "outside"} k */
	const sum = (k) => toolRows.reduce((n, r) => n + r[k], 0);
	const calls = sum("calls");
	const outside = sum("outside");
	return {
		rows: toolRows,
		total: {
			calls,
			blocks: sum("blocks"),
			records: sum("records"),
			failedCalls: sum("failedCalls"),
			inUnion: sum("inUnion"),
			outside,
			failurePct: calls ? ((sum("records") - outside) / calls) * 100 : null,
		},
	};
}

/**
 * @param {ReturnType<typeof unionShare>} u
 * @param {string} event
 * @returns {string}
 */
function renderUnion(u, event) {
	const lines = [""];
	lines.push(
		`UNION — ${event} failure records naming no guard, over calls routed to ANY ${event} guard, deduped by call id`,
	);
	lines.push("");
	lines.push(
		"tool              routed calls   (blocks)   records   failed calls   in union   outside   failure %",
	);
	const line = (
		/** @type {string} */ tool,
		/** @type {ReturnType<typeof unionShare>["total"]} */ r,
	) =>
		`${tool.padEnd(17)} ${String(r.calls).padStart(13)} ${`(${r.blocks})`.padStart(10)} ${String(r.records).padStart(9)} ${String(r.failedCalls).padStart(14)} ${String(r.inUnion).padStart(10)} ${String(r.outside).padStart(9)}   ${num(r.failurePct, 4).padStart(9)}`;
	for (const r of u.rows) lines.push(line(r.tool, r));
	lines.push(line("ALL TOOLS", u.total));
	if (u.total.outside)
		lines.push(
			`  ⚠ ${u.total.outside} record(s) are outside the base: no call id, or a call no registered ${event} guard routes —`,
			"    a hook the repo does not register fired there. They are left out of failure %, not priced against it.",
		);
	return lines.join("\n");
}

/** @param {number | null} n @param {number} dp */
function num(n, dp) {
	return n === null ? "—" : n.toFixed(dp);
}

/**
 * @param {ReturnType<typeof rows>} data
 * @param {{dirs: string[], event: string, files: number, scanned: number, unreadable: string[],
 *   window: {since: string|null, until: string|null}, undated: number,
 *   first: string|null, last: string|null, lostCalls: number, unresolved: number,
 *   unpinned: string[], skipped: number, zeroed: number, scope: string, guards: number}} corpus
 * @returns {string}
 */
function render(data, corpus) {
	const lines = [];
	lines.push(`corpus  ${corpus.dirs.join(", ")}`);
	lines.push(
		`SCOPE   ${corpus.scope} — ${corpus.guards} ${corpus.event} guard(s). A figure read off this table` +
			"\n        prices that population and no other.",
	);
	lines.push(
		`        ${corpus.scanned} of ${corpus.files} transcripts read, ${corpus.unreadable.length} unreadable`,
	);
	if (corpus.skipped)
		lines.push(
			`        ${corpus.skipped} malformed line(s) skipped within otherwise-readable transcripts (mantahostels#3307)`,
		);
	if (corpus.zeroed)
		lines.push(
			`        ${corpus.zeroed} record(s) zeroed by a crash within otherwise-readable transcripts`,
		);
	if (corpus.window.since || corpus.window.until)
		lines.push(
			`WINDOW  ${corpus.window.since ?? "(open)"} .. ${corpus.window.until ?? "(open)"} — ${corpus.undated} undated records excluded`,
		);
	else lines.push("        whole corpus, no window");
	lines.push(
		`losses  ${corpus.first ?? "—"} .. ${corpus.last ?? "—"}, on ${corpus.lostCalls} distinct tool calls`,
	);
	lines.push("");
	lines.push(
		"guard                          lost   denies   population     loss %   deny rate %          expected escaped",
	);
	for (const r of data) lines.push(buildRowLine(r));
	const { total, low, high, uncounted, nonDeny } = escapedTotals(data);
	lines.push("");
	lines.push(
		`TOTAL expected escaped denies: ${num(total, 2)} (95% CI ${num(low, 2)}-${num(high, 2)})`,
	);
	if (uncounted)
		lines.push(
			`  ⚠ ${uncounted} guard(s) have NO RATE, so the total is a floor. A guard whose trigger`,
		);
	if (uncounted)
		lines.push(
			"    could not be read, or has no deny needle registered, says so in its row; the",
		);
	if (uncounted) lines.push("    rest simply had no call in this window.");
	if (nonDeny)
		lines.push(
			`  ${nonDeny} guard(s) cannot deny at all, so they are absent from the total by construction,` +
				"\n    not missing from it. Their population and loss % are still measured.",
		);
	lines.push(...corpusWarnings(corpus));
	return lines.join("\n");
}

/**
 * @param {ReturnType<typeof rows>[number]} r
 * @returns {string}
 */
function buildRowLine(r) {
	return `${r.guard.padEnd(30)} ${String(r.lost).padStart(4)} ${String(r.denies).padStart(8)} ${String(r.population ?? "—").padStart(12)}   ${num(r.lossPct, 4).padStart(8)}   ${rateCell(r).padEnd(20)} ${expectedCell(r)}`;
}

/**
 * @param {ReturnType<typeof rows>[number]} r
 * @returns {string}
 */
function rateCell(r) {
	if (r.ratePct !== null)
		return `${num(r.ratePct, 4)} [${num(r.rateLowPct, 2)}-${num(r.rateHighPct, 2)}]`;
	if (r.unknown) return "unknown (trigger)";
	if (r.cannotDeny) return "n/a (cannot deny)";
	if (r.noDenyNeedle) return "unknown (no deny needle)";
	return "unknown (no calls)";
}

/**
 * @param {ReturnType<typeof rows>[number]} r
 * @returns {string}
 */
function expectedCell(r) {
	if (r.expected !== null)
		return `${num(r.expected, 3)} [${num(r.expectedLow, 2)}-${num(r.expectedHigh, 2)}]`;
	if (r.cannotDeny) return "n/a";
	return "unknown";
}

/**
 * @param {ReturnType<typeof rows>} data
 * @returns {{total: number, low: number, high: number, uncounted: number, nonDeny: number}}
 */
function escapedTotals(data) {
	let total = 0;
	let low = 0;
	let high = 0;
	let uncounted = 0;
	let nonDeny = 0;
	for (const r of data) {
		if (
			r.expected === null ||
			r.expectedLow === null ||
			r.expectedHigh === null
		) {
			if (r.cannotDeny) nonDeny++;
			else uncounted++;
		} else {
			total += r.expected;
			low += r.expectedLow;
			high += r.expectedHigh;
		}
	}
	return { total, low, high, uncounted, nonDeny };
}

/**
 * @param {Parameters<typeof render>[1]} corpus
 * @returns {string[]}
 */
function corpusWarnings(corpus) {
	/** @type {string[]} */
	const lines = [];
	if (corpus.unpinned.length > 0) {
		lines.push("");
		lines.push(
			`  ⚠ STALE: lib/guard-deny-rates.js has no row for ${corpus.unpinned.length} deny-capable guard(s):`,
		);
		for (const g of corpus.unpinned) lines.push(`      ${g}`);
		lines.push(
			"    They report as unknown to guard-lost-deny.js, which is correct and not a bug —",
		);
		lines.push(
			"    fix it by copying this run's figures into that table, dating them there.",
		);
	}
	if (corpus.unresolved > 0) {
		lines.push("");
		lines.push(
			`  ⚠ ${corpus.unresolved} ${DISPATCHER} failure record(s) name a call their transcript does not hold,`,
			"    so no core could be credited: their losses are missing from the rows above.",
		);
	}
	if (corpus.unreadable.length > 0) {
		lines.push("");
		lines.push(`  ⚠ unreadable (${corpus.unreadable.length}):`);
		for (const f of corpus.unreadable.slice(0, 10)) lines.push(`      ${f}`);
	}
	return lines;
}

/**
 * @param {string} file
 * @returns {{ok: true, value: any} | {ok: false, error: string}}
 */
function readJson(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		return {
			ok: false,
			error: `cannot read ${file}: ${e instanceof Error ? e.message : e}`,
		};
	}
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (e) {
		return {
			ok: false,
			error: `${file} is not valid JSON: ${e instanceof Error ? e.message : e}`,
		};
	}
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
	const { flags } = parseOrExit(argv, CLI);
	/** @param {string} s */
	const say = (s) => writeFd(1, `${s}\n`);
	/** @param {string} s */
	const err = (s) => writeFd(2, `${s}\n`);

	const window = parseWindow(flags, err);
	if (!window) return 2;
	const chosen = scopeAndEvent(flags, err);
	if (!chosen) return 2;
	const { scope, event } = chosen;

	const given = flagValue(flags, "--dir");
	const corpusDirs = given ? [given] : transcriptDirs();

	const sources = readHookSourcesOrNull(err);
	if (!sources) return 2;
	const settings = mergeHooks(sources);
	const scriptsDir = path.join(CORE, "scripts");
	const dirs = guardDirs(CORE, HOST);
	const triggers = triggerTable(settings, dirs, {
		scope,
		event,
		manifest: CORE_MANIFEST,
		host: CORE_HOST,
	});
	const classify = flags["--failures"]
		? failureClassifier(settings, dirs)
		: null;

	if (flags["--triggers"]) {
		say(JSON.stringify(triggerRows(triggers), null, 2));
		return 0;
	}

	const needlesRead = readJson(
		path.join(scriptsDir, "guard-fire-needles.json"),
	);
	if (!needlesRead.ok) {
		err(needlesRead.error);
		return 2;
	}
	const needles = denyNeedlesByGuard(needlesRead.value, triggers);

	const { files, unreadable: unlisted } = readTranscriptCorpus(corpusDirs);
	if (unlisted.length > 0) {
		err(`cannot read the corpus directory: ${unlisted.join(", ")}`);
		err("A wrong --dir reports here, never as an empty corpus.");
		return 2;
	}

	const union = Boolean(flags["--union"]);
	const { acc, unreadable, scanned } = scan(files, triggers, needles, {
		window,
		event,
		classify,
		union,
	});
	const unionReport = union ? unionShare(acc.union) : null;
	const data = rows(triggers, acc, needles);
	const corpus = {
		dirs: corpusDirs,
		event,
		files: files.length,
		scanned,
		unreadable,
		window,
		undated: acc.undated,
		first: acc.first,
		last: acc.last,
		lostCalls: acc.lostCalls.size,
		unresolved: acc.unresolved,
		unpinned: unpinned(triggers),
		skipped: acc.skipped,
		zeroed: acc.zeroed,
		scope,
		guards: triggers.size,
	};

	if (flags["--json"]) {
		say(
			JSON.stringify(
				buildJsonReport(corpus, data, { acc, classify, unionReport }),
				null,
				2,
			),
		);
		return 0;
	}
	say(render(data, corpus));
	if (classify) say(renderFailures(acc.failures));
	if (unionReport) say(renderUnion(unionReport, event));
	return 0;
}

/**
 * @param {import("./lib/cli-args").Parsed["flags"]} flags
 * @param {(s: string) => void} err
 * @returns {{since: string|null, until: string|null} | null}
 */
function parseWindow(flags, err) {
	/** @type {{since: string|null, until: string|null}} */
	const window = { since: null, until: null };
	for (const flag of ["--since", "--until"]) {
		const raw = flagValue(flags, flag);
		if (raw === undefined) continue;
		const parsed = parseSince(raw);
		if (!parsed.ok) {
			err(parsed.error.replace("--since", flag));
			return null;
		}
		window[flag === "--since" ? "since" : "until"] = parsed.since;
	}
	return window;
}

/**
 * @param {import("./lib/cli-args").Parsed["flags"]} flags
 * @param {(s: string) => void} err
 * @returns {{scope: "deny" | "nondeny" | "all", event: "PreToolUse" | "PostToolUse"} | null}
 */
function scopeAndEvent(flags, err) {
	const scopeArg = flagValue(flags, "--scope");
	if (!SCOPES.has(scopeArg ?? "deny")) {
		err(`--scope ${scopeArg} is not one of ${[...SCOPES].join(", ")}.`);
		return null;
	}
	const eventArg = flagValue(flags, "--event");
	if (!EVENTS.has(eventArg ?? DENY_EVENT)) {
		err(`--event ${eventArg} is not one of ${[...EVENTS].join(", ")}.`);
		err(
			"An event that does not fire on a tool call has no tool-call denominator at any scope.",
		);
		return null;
	}
	const event = /** @type {"PreToolUse" | "PostToolUse"} */ (
		eventArg ?? DENY_EVENT
	);
	// lucmoseley/mantahostels#3356
	const scope = /** @type {"deny" | "nondeny" | "all"} */ (
		scopeArg ?? (event === DENY_EVENT ? "deny" : "all")
	);
	if (event !== DENY_EVENT && scope !== "all") {
		err(`--scope ${scope} is meaningless with --event ${event}:`);
		err("no hook on that event can deny a call, so every row is non-deny.");
		err("Drop --scope, or pass --scope all.");
		return null;
	}

	if (flags["--union"] && scope !== "all") {
		err(
			`--union needs --scope all: --scope ${scope} unions only part of the ${event} guards.`,
		);
		return null;
	}
	return { scope, event };
}

/**
 * @param {(s: string) => void} err
 * @returns {ReturnType<typeof readHostHookSources> | null}
 */
function readHookSourcesOrNull(err) {
	let sources;
	try {
		sources = readHostHookSources(HOST, { core: CORE });
	} catch (e) {
		err(caught(e).message);
		return null;
	}
	if (sources.every((s) => s.settings === null)) {
		err("No hook file was found, so there is no guard to count.");
		return null;
	}
	return sources;
}

/**
 * @param {ReturnType<typeof mergeHooks>} settings
 * @param {string[]} dirs
 * @returns {Map<string, Map<string, boolean>>}
 */
function failureClassifier(settings, dirs) {
	return new Map(
		[...EVENTS].map((e) => {
			/** @type {Map<string, boolean>} */
			const guards = new Map();
			const table = triggerTable(settings, dirs, {
				scope: "all",
				event: /** @type {"PreToolUse" | "PostToolUse"} */ (e),
				manifest: CORE_MANIFEST,
				host: CORE_HOST,
			});
			for (const [guard, t] of table) {
				const named = t.via ?? guard;
				guards.set(named, Boolean(guards.get(named)) || t.denyCapable);
			}
			return [e, guards];
		}),
	);
}

/**
 * @param {Parameters<typeof render>[1]} corpus
 * @param {ReturnType<typeof rows>} data
 * @param {{acc: ReturnType<typeof scan>["acc"],
 *   classify: Map<string, Map<string, boolean>> | null,
 *   unionReport: ReturnType<typeof unionShare> | null}} extras
 */
function buildJsonReport(corpus, data, { acc, classify, unionReport }) {
	return {
		corpus: { ...corpus, unreadable: corpus.unreadable.length },
		rows: data,
		...(classify ? { failures: failureShare(acc.failures) } : {}),
		...(unionReport ? { union: unionReport } : {}),
	};
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
