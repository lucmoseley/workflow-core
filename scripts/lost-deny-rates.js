#!/usr/bin/env node
/*
 * lost-deny-rates.js — recompute the lost-deny census.
 *
 *   Usage: CLI below, which `--help` prints.
 *
 * WHAT IT ANSWERS (mantahostels#3287, landing the instrument mantahostels#3263 left in scratch). For
 * each deny-capable `PreToolUse` guard: how often it failed open, how often it
 * actually denied, how many tool calls reached it at all, and therefore how
 * many real denies escaped. https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/lost-deny-recoverability.md states
 * those figures for a corpus whose losses run 15 Aug – 5 Sep 2026;
 * `docs/data/lost-deny-*-2026-09-06.csv` is that run's output, and this
 * recomputes it.
 *
 * A RE-RUN NEVER REPRODUCES THE PUBLISHED FIGURES EXACTLY. The corpus is
 * machine-local and grows every session, so a later run prices a later window;
 * `--since`/`--until` narrow it back, and even then the transcripts inside the
 * window keep arriving until the window's last session ends.
 *
 * THE THREE COUNTS, one pass over the corpus each file read once:
 *
 *   LOST — `hook_cancelled` / `hook_non_blocking_error` attachment records
 *     whose `hookEvent` is `PreToolUse` and whose named guard can deny
 *     (`lib/deny-capable.js`).
 *     The guard failed open: the call went through unjudged.
 *
 *   DENY EVENTS — distinct tool calls on which the guard printed one of its
 *     own `kind: "deny"` needles (`scripts/guard-fire-needles.json`). Distinct
 *     CALLS, not needle matches: one deny can trip several needles at once.
 *     Read per basename off the trigger table (`denyNeedlesByGuard`), never
 *     through `registeredGuardSubjects`, whose subjects are per registration
 *     and take no scope (#2297).
 *
 *   TRUE POPULATION — every `tool_use` block the host's registrations
 *     (`lib/core-hooks.js`'s `hookSourcesOf`) route to the guard, read through
 *     `lib/guard-triggers.js`. A needle sweep cannot reach this count: a
 *     guard that allowed a call silently printed nothing, so a needle-based
 *     denominator sees only the calls it spoke on and overstates the rate by
 *     two orders of magnitude.
 *
 * WHY A DENY IS COUNTED OFF NEEDLES AND NOT OFF THE HARNESS. A PreToolUse deny
 * writes no attachment record at all — the reason reaches the session only as
 * the denied call's own error result (`lib/guard-fires.js`, route `deny`). So
 * the guard's own words are the only evidence a deny happened, and a guard with
 * no `kind: "deny"` needle registered reads as UNKNOWN, never as a measured
 * zero — nothing was there to catch a deny even if one occurred.
 *
 * STALENESS. The report ends with `lib/guard-deny-rates.js`'s pinned table
 * checked against the deny-capable set derived here: a guard with no row there
 * is named, which is the check mantahostels#3261 shipped without. Nothing recomputes that
 * table automatically, deliberately — the figures in it are a dated census, not
 * a live reading.
 *
 * `--scope` (mantahostels#3350). `deny` is the default and the census's own population.
 * `nondeny` swaps in the `PreToolUse` guards that cannot deny — they
 * warn, inject context or hand over a rule — so their true invocation counts can
 * be read the same way; `all` reports both tables at once. THE THREE COUNTS AND
 * THE WINDOW ARE IDENTICAL WHATEVER THE SCOPE; only which guards get a row moves.
 *
 * A NON-DENY GUARD HAS NO DENY RATE AND NO ESCAPED-DENY ESTIMATE, BY
 * CONSTRUCTION, and its row says so rather than reporting a zero. Its `lost`
 * count is still real and still a loss — the session lost a warning, a claim
 * announcement or a rule hand-over. Its `spoke` count is real too, so a `lost / population` rate
 * reads honestly; only the deny column is meaningless.
 *
 * `--event` (mantahostels#3356). `PreToolUse` is the default and everything above.
 * `PostToolUse` swaps the table for the hooks that run AFTER a tool call —
 * `post-write.sh`, `scan-injection.js`, the issue-claim recorders.
 * The same three counts on the same window: only the registrations read move.
 * `--scope` is fixed at `all` there, since no hook on that event can deny, so
 * every row reports `n/a (cannot deny)` and the escaped-deny total is zero by
 * construction rather than missing.
 *
 * A `PostToolUse` POPULATION OVER-COUNTS DELIVERY. A call denied or cancelled
 * before it ran still writes its `tool_use` block, and no `PostToolUse` hook
 * fired on it. The count is of calls the hook files ROUTE to the guard, which is
 * the denominator a routing-loss rate wants; a delivery rate would want less.
 *
 * `--failures` (mantahostels#3356). The whole hook-failure population of the same sweep,
 * split by `hookEvent` and, within each tool-call event, by whether the record
 * names a registered guard at all.
 * UNNARROWED BY `--scope` AND `--event`, deliberately: it is the denominator
 * those tables are shares OF, so narrowing it with them would make every share
 * 100%.
 *
 * `--union` (mantahostels#3372). The population of a failure record that names NO guard:
 * every tool call routed to at least one guard of `--event`, deduped by the
 * `tool_use` block's own id — never a sum of the per-guard populations, which
 * overlap. Split by tool, because such a record still carries `hookName:
 * "<event>:<tool>"`, and a record on one tool is at risk only on that tool's
 * calls. Each record's `toolUseID` is looked up in its tool's union.
 *
 * IN NO §N3 FAMILY, DELIBERATELY: it gates nothing, runs from a prompt, writes
 * no file and files no issue.
 */

const fs = require("node:fs");
const { caught } = require("./lib/caught.js");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const {
	guardKey,
	transcriptDir,
	transcriptFiles,
	fireSpans,
	needleIn,
} = require("./lib/guard-fires.js");
const { hookSourcesOf, mergeHooks } = require("./lib/core-hooks.js");
const { mainChainRecords } = require("./lib/transcript.js");
const { guardDirs } = require("./lib/deny-capable.js");
const {
	firesOn,
	triggerTable,
	triggerRows,
	DENY_EVENT,
	EVENTS,
	SCOPES,
} = require("./lib/guard-triggers.js");
/* `parseSince` refuses an ISO spelling that parses but sorts wrong, which is
 * the fault it was written for (mantahostels#1896); duplicating it here would duplicate the
 * chance of getting that wrong. It is a CLI's export rather than a lib's
 * because it has only ever had one caller. */
const { parseSince } = require("./count-guard-fires.js");
const rateTable = require("./lib/guard-deny-rates.js");
const { hostRoot } = require("./lib/host-root.js");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const { cutAt } = require("./lib/cut-at.js");
const { byCodeUnit } = require("./lib/by-code-unit.js");

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage: [
		"Usage: node scripts/lost-deny-rates.js [--dir <path>] [--since <date>]",
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

/* AN ADOPTER'S HOOKS AND GUARDS LIVE IN THE PLUGIN, not the host (#954): its
 * `hooks/hooks.json` registers them and its `scripts/` holds their source and
 * the needles. So the host answers only `.claude/settings.json` and the
 * transcript directory; the rest is read from beside this script. At the core
 * the host is the core, whose self-plugin file registers its hooks.
 *
 * `WFC_LOST_DENY_ROOT` stands one tree in for both, so it is read as a core:
 * the seam `main()`'s exit-2 branches needed to be reachable from a CLI test
 * at all (mantahostels#3307).
 * Deliberately its own var rather than layering over `lib/hook-block.js`'s
 * `WFC_REPO_ROOT`: a suite redirecting hook counters through that var for an
 * unrelated test should not also redirect this script's reads. */
const OVERRIDE = process.env.WFC_LOST_DENY_ROOT
	? path.resolve(process.env.WFC_LOST_DENY_ROOT)
	: null;
const HOST = OVERRIDE ?? hostRoot();
const CORE = OVERRIDE ?? path.join(__dirname, "..");
const FAILURE_TYPES = new Set(["hook_cancelled", "hook_non_blocking_error"]);

/**
 * The basename a `guardKey` opens with: everything before its first space.
 * @param {string} key
 */
const basenameOf = (key) => cutAt(key, " ")[0];

/**
 * Every needle of each guard IN THE TABLE, keyed by basename — deny-kind
 * needles ALONGSIDE warn and inject, despite the name: `scanTranscript`
 * filters to `kind === "deny"` for the deny count and takes any kind for the
 * "spoke on this call at all" count, so both need the full list here.
 *
 * The needle registry is keyed by `guardKey` — basename plus the arguments that
 * tell two registrations apart — and this collapses to the basename, matching
 * `triggerTable`: a deny is a deny whichever registration printed it.
 *
 * NARROWED BY THE TRIGGER TABLE, not by `denyCapable` (mantahostels#3350): the table is
 * already the scope's population, and re-deriving the filter here would have
 * dropped every non-deny guard's needles under `--scope nondeny`, reporting a
 * silent zero in the `spoke` column for guards that speak on most of their
 * calls.
 *
 * @param {Record<string, any>} needles
 * @param {Map<string, unknown>} triggers the scope's guards, keyed by basename
 * @returns {Map<string, Needle[]>}
 */
function denyNeedlesByGuard(needles, triggers) {
	/** @type {Map<string, Needle[]>} */
	const out = new Map();
	for (const [key, entry] of Object.entries(needles?.guards ?? {})) {
		const guard = basenameOf(key);
		if (!triggers.has(guard)) continue;
		const list = out.get(guard) ?? [];
		for (const n of entry?.needles ?? []) list.push(n);
		out.set(guard, list);
	}
	return out;
}

/**
 * Add one call id to a per-guard set, creating the set on first sight.
 * @param {Map<string, Set<string>>} into accumulator: `id` is added to `guard`'s set
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
 * A record's identity for "one tool call" — every distinct one it carries.
 * Almost always one id: the attachment's `toolUseID` where the harness gave
 * one, else every `tool_use_id` a deny route's own `tool_result` content
 * blocks carry — the harness's own per-call ids, not this record's.
 *
 * The record's own `uuid` identifies the JSONL LINE, not a call, and is only
 * the LAST resort here, once no `tool_use_id` is available at all. Two
 * deny-route records for one call (a retry, or a split write) carry two
 * different uuids but the same `tool_use_id`.
 *
 * MORE THAN ONE ID: a record whose single message carries several
 * `tool_result` blocks (parallel tool calls, more than one denied) returns
 * every one of them.
 *
 * THIS IS NOW THE FALLBACK, NOT THE ATTRIBUTION (mantahostels#3311). `fireSpans` tags each
 * span with the `tool_use_id` its own `tool_result` block carried, so
 * `scanTranscript` credits a matched span to that one call rather than to every
 * id this returns — the bounded over-count mantahostels#3307 accepted is gone. What is left
 * here is the case no span names: a deny result with no `tool_use_id` at all,
 * where the record's uuid is the only identity available.
 *
 * @param {Record<string, any>} record
 * @returns {string[]}
 */
function callIds(record) {
	const attached = record?.attachment?.toolUseID;
	if (attached) return [attached];
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
	return [record?.uuid || ""];
}

/**
 * Is this record inside the window? A record with no timestamp is excluded from
 * a windowed run and counted as undated rather than guessed either way.
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
 * Wilson score interval for a proportion, as percentages. `null` with no
 * observations — a rate over an empty population is unknown, not zero.
 *
 * Rounded to 10 decimal places, which no real figure here reaches and which
 * stops the arithmetic's own dust being printed.
 *
 * @param {number} hits
 * @param {number} n
 * @returns {{pct: number, lowPct: number, highPct: number} | null}
 */
function wilson(hits, n) {
	if (!n) return null;
	// z for a two-sided 95% interval.
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
 * The `--failures` bucket one hook-failure record falls in (mantahostels#3356).
 *
 * EVERY TOOL-CALL EVENT IS SPLIT, not just `PreToolUse`. The buckets are defined
 * to hold exactly what the LOST count would credit to a guard on that event, so
 * a share taken over them RECONCILES with the tables above rather than merely
 * resembling them.
 *
 *   <event>, unattributed — no readable guard name, or no `toolUseID` to pin it
 *     to a call. Exactly what the LOST count drops.
 *   <event>, unregistered — a guard name no registration on that event mentions.
 *   PreToolUse, deny-capable / PreToolUse, non-deny — the two mantahostels#3287 and mantahostels#3350
 *     measured.
 *   PostToolUse, guard named — the one class there is: nothing on that event can
 *     deny, so there is no split to make.
 *
 * An event that fires on no tool call keeps its bare name: there is no guard
 * table to sort it against, and inventing one would read as a measurement.
 *
 * `classify` null means the caller wants no split at all.
 *
 * @param {Record<string, any>} a the record's `attachment`
 * @param {Map<string, Map<string, boolean>> | null} classify event -> (guard
 *   basename -> deny-capable), over every registered guard of that event
 * @param {{failures: Map<string, number>}} acc accumulator: the record's bucket is counted in failures
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
 * @typedef {Record<string, any>} TranscriptPart One object from a parsed
 * transcript line — a record, its `attachment`, or a content block. `any`
 * because JSON.parse types nothing and each field is type-checked where it
 * is read.
 */

/**
 * The bucket of a failure record on an event that fires on tool calls — the
 * split `bucketFailure`'s docstring lists.
 * @param {TranscriptPart} a the record's `attachment`
 * @param {string} event
 * @param {Map<string, boolean>} guards guard basename -> deny-capable
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
 * The guard basename a failure record names and the call id it is pinned to,
 * each `""` where absent — a record missing either is unattributed, in the
 * `--failures` split and the `--union` count alike.
 * @param {Record<string, any>} a the record's `attachment`
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
 * One tool's `--union` counts, created on first sight.
 * @param {Map<string, UnionEntry>} into accumulator: a fresh entry is set for a tool first seen
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

/**
 * @typedef {{calls: Set<string>, blocks: number, records: number,
 *   idless: number, failed: Map<string, number>}} UnionEntry
 *   `calls`: ids routed to any guard; `blocks`: the same before the dedupe;
 *   `records`: failure records naming no guard; `idless`: those with no call
 *   id; `failed`: the records the rest carry, per call id.
 */

/**
 * The tool a failure record's `hookName` names — `"PostToolUse:Bash"` → `Bash`
 * — or `"(no tool)"` where it names none for this event.
 * @param {Record<string, any>} a the record's `attachment`
 * @param {string} event
 * @returns {string}
 */
function hookTool(a, event) {
	const name = typeof a.hookName === "string" ? a.hookName : "";
	return name.startsWith(`${event}:`) && name.length > event.length + 1
		? name.slice(event.length + 1)
		: "(no tool)";
}

/**
 * `event` is the hook event the LOST count reads; `classify` is
 * `bucketFailure`'s guard tables, or null where the caller wants no
 * `--failures` split; `union` takes the `--union` counts.
 * @typedef {{window: {since: string | null, until: string | null},
 *   event?: string, classify?: Map<string, Map<string, boolean>> | null,
 *   union?: boolean}} ScanOptions
 */

/**
 * @typedef {{lost: Map<string, number>, denyCalls: Map<string, Set<string>>,
 *   anyCalls: Map<string, Set<string>>, population: Map<string, number>,
 *   lostCalls: Set<string>, failures: Map<string, number>,
 *   union: Map<string, UnionEntry>, undated: number,
 *   first: string | null, last: string | null, skipped: number}} ScanAcc
 */

/**
 * One transcript's contribution to all three counts.
 *
 * @param {string} text
 * @param {ScanAcc} acc accumulator: the transcript's counts are added
 * @param {ScanOptions & {tier: "main" | "subagent",
 *   triggers: Map<string, import("./lib/guard-triggers.js").Trigger>,
 *   needles: Map<string, Needle[]>}} options
 */
function scanTranscript(text, acc, options) {
	const { tier, triggers, needles, window } = options;
	const event = options.event ?? DENY_EVENT;
	const classify = options.classify ?? null;
	const union = options.union ?? false;
	const stats = { skipped: 0 };
	for (const record of mainChainRecords(text, tier, stats)) {
		const at = typeof record.timestamp === "string" ? record.timestamp : null;
		const verdict = windowVerdict(at, window);
		if (verdict === "undated") acc.undated++;
		if (verdict !== "keep") continue;

		// LOST.
		const a = record?.attachment;
		if (a && FAILURE_TYPES.has(a.type))
			countFailure(a, at, acc, { event, classify, union, triggers });

		// DENY EVENTS. A guard speaks through the harness's own records only, so
		// the mention-contaminated `cli` route is refused here as it is in
		// `subjectsFor` — a `cat` of a guard is not a deny.
		countDenyEvents(record, needles, acc);

		// TRUE POPULATION.
		countPopulation(record, acc, { triggers, union });
	}
	acc.skipped += stats.skipped;
}

/**
 * One hook-failure record's share of the LOST count, the `--failures` split
 * and the `--union` count.
 * @param {TranscriptPart} a the record's `attachment`
 * @param {string | null} at the record's timestamp
 * @param {ScanAcc} acc accumulator: the failure's counts are added
 * @param {{event: string, classify: Map<string, Map<string, boolean>> | null,
 *   union: boolean,
 *   triggers: Map<string, import("./lib/guard-triggers.js").Trigger>}} ctx
 */
function countFailure(a, at, acc, ctx) {
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
		return;
	const guard = basenameOf(guardKey(a.command));
	if (triggers.has(guard)) recordLoss(acc, guard, a.toolUseID, at);
}

/**
 * A failure record naming no guard, or pinned to no call, into its tool's
 * `--union` counts.
 * @param {TranscriptPart} a the record's `attachment`
 * @param {string} event
 * @param {ScanAcc} acc accumulator: the failure is counted in its tool's union entry
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
 * One lost record credited to its guard and call, widening the losses' span.
 * @param {ScanAcc} acc accumulator: lost, lostCalls, first and last are updated
 * @param {string} guard
 * @param {string} id the call's `toolUseID`
 * @param {string | null} at the record's timestamp
 */
function recordLoss(acc, guard, id, at) {
	acc.lost.set(guard, (acc.lost.get(guard) || 0) + 1);
	acc.lostCalls.add(id);
	if (!at) return;
	if (!acc.first || at < acc.first) acc.first = at;
	if (!acc.last || at > acc.last) acc.last = at;
}

/**
 * One record's DENY EVENTS: each needle-matched span credited to its calls.
 * @param {TranscriptPart} record
 * @param {Map<string, Needle[]>} needles
 * @param {ScanAcc} acc accumulator: matched call ids are added to anyCalls and denyCalls
 */
function countDenyEvents(record, needles, acc) {
	const spans = fireSpans(record).filter((s) => s.route !== "cli");
	if (spans.length === 0) return;
	/* Attributed per span, not per record — `callIds`'s docstring. */
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
 * Whether a span matched any of a guard's needles, and any `deny` one.
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
 * @param {Map<string, Set<string>>} into accumulator: each id is added to `guard`'s set
 * @param {string} guard
 * @param {string[]} ids
 */
function addCalls(into, guard, ids) {
	for (const id of ids) addCall(into, guard, id);
}

/**
 * One assistant record's TRUE POPULATION: each `tool_use` block credited to
 * every guard it routes to, and to its tool's `--union` calls.
 * @param {TranscriptPart} record
 * @param {ScanAcc} acc accumulator: population and the union calls are counted
 * @param {{triggers: Map<string, import("./lib/guard-triggers.js").Trigger>,
 *   union: boolean}} ctx
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
		// A block with no id counts once, keyed off its line and place in it. Two
		// id-less, uuid-less blocks at one index would collapse to one call.
		const id =
			typeof block.id === "string" && block.id
				? block.id
				: `${record.uuid ?? ""}#${i}`;
		const entry = unionEntry(acc.union, call.name);
		entry.calls.add(id);
		entry.blocks++;
	}
}

/**
 * A `tool_use` block's tool name and Bash command, each `""` where absent.
 * @param {TranscriptPart} block
 * @returns {{name: string, command: string}}
 */
function toolCall(block) {
	const name = typeof block.name === "string" ? block.name : "";
	const command =
		block.input && typeof block.input.command === "string"
			? block.input.command
			: "";
	return { name, command };
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

/** A fresh, empty accumulator — one corpus-wide, one per file (below). */
function freshAcc() {
	return {
		lost: new Map(),
		denyCalls: new Map(),
		anyCalls: new Map(),
		population: new Map(),
		lostCalls: new Set(),
		failures: new Map(),
		/** @type {Map<string, UnionEntry>} keyed by tool */
		union: new Map(),
		undated: 0,
		first: null,
		last: null,
		skipped: 0,
	};
}

/**
 * Folds `from` into `into` — how a per-file accumulator's counts join the
 * corpus-wide one, once that file is known to have parsed clean.
 * @param {ReturnType<typeof freshAcc>} into accumulator: the corpus-wide one, `from`'s counts folded in
 * @param {ReturnType<typeof freshAcc>} from
 */
function mergeAcc(into, from) {
	addCounts(into.lost, from.lost);
	addIdSets(into.denyCalls, from.denyCalls);
	addIdSets(into.anyCalls, from.anyCalls);
	addCounts(into.population, from.population);
	for (const id of from.lostCalls) into.lostCalls.add(id);
	addCounts(into.failures, from.failures);
	mergeUnion(into.union, from.union);
	into.undated += from.undated;
	into.skipped += from.skipped;
	if (from.first && (!into.first || from.first < into.first))
		into.first = from.first;
	if (from.last && (!into.last || from.last > into.last)) into.last = from.last;
}

/**
 * Adds each count in `from` to its key's count in `into`.
 * @param {Map<string, number>} into accumulator: each of `from`'s counts is added
 * @param {Map<string, number>} from
 */
function addCounts(into, from) {
	for (const [key, n] of from) into.set(key, (into.get(key) || 0) + n);
}

/**
 * Unions each guard's call ids in `from` into its set in `into`.
 * @param {Map<string, Set<string>>} into accumulator: each of `from`'s ids is added
 * @param {Map<string, Set<string>>} from
 */
function addIdSets(into, from) {
	for (const [guard, ids] of from) {
		const set = into.get(guard) ?? new Set();
		for (const id of ids) set.add(id);
		into.set(guard, set);
	}
}

/**
 * Folds one accumulator's `--union` counts into another's, tool by tool.
 * @param {Map<string, UnionEntry>} into accumulator: each of `from`'s entries is folded in
 * @param {Map<string, UnionEntry>} from
 */
function mergeUnion(into, from) {
	for (const [tool, entry] of from) {
		const to = unionEntry(into, tool);
		for (const id of entry.calls) to.calls.add(id);
		addCounts(to.failed, entry.failed);
		to.blocks += entry.blocks;
		to.records += entry.records;
		to.idless += entry.idless;
	}
}

/**
 * Sweep the corpus and roll the three counts up per guard.
 *
 * @param {Array<{file: string, tier: "main" | "subagent"}>} files
 * @param {Map<string, import("./lib/guard-triggers.js").Trigger>} triggers
 * @param {Map<string, Needle[]>} needles
 * @param {ScanOptions} options
 */
function scan(files, triggers, needles, options) {
	// Refused, not defaulted, and refused HERE rather than only in `main`: an
	// event outside the set matches no failure record, so a caller passing one
	// would read a measured zero out of a count that was never taken. Same rule
	// as `triggerTable`'s.
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
		// A per-file accumulator: a throw mid-parse must not leave the records it
		// already read before the throw counted, nor count the file as scanned —
		// it read only PART of the file, which is what "unreadable" already means
		// for a file that could not be opened at all.
		const fileAcc = freshAcc();
		try {
			scanTranscript(text, fileAcc, { ...options, tier, triggers, needles });
		} catch (e) {
			unreadable.push(`${file} (parse: ${e instanceof Error ? e.message : e})`);
			continue;
		}
		scanned++;
		mergeAcc(acc, fileAcc);
	}
	return { acc, unreadable, scanned };
}

/**
 * Lost records as a percentage of the population: null where the population
 * could not be read, zero where it read as no calls.
 *
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
 * The report's rows, sorted by expected escaped denies.
 *
 * A guard whose trigger cannot be read has a null population and a null rate —
 * never a zero, which would read as "measured, and it never denies". Same for
 * a guard with no `kind: "deny"` needle registered at all: with none to match,
 * a 0-of-N deny count is not a measurement, so the rate is null there too.
 *
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
 * One guard's report row — `rows`' docstring says what its nulls mean.
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
		// A guard that cannot deny is reported apart from one that can but has
		// no needle registered (mantahostels#3350): the first is a property of the guard and
		// nothing to fix, the second is a hole in the needle registry.
		cannotDeny: !trigger.denyCapable,
		noDenyNeedle: population !== null && trigger.denyCapable && !hasDenyNeedle,
		// Lost records over true invocations — the per-invocation loss rate
		// https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/census-denominators.md §Step 3 reports, and the only
		// rate a non-deny guard can have (mantahostels#3350). A plain percentage, not a
		// Wilson interval: `lost` counts failure RECORDS and one tool call can
		// carry several, so the binomial the interval assumes does not hold.
		// ZERO, NOT NULL, ON A READABLE TRIGGER THAT NOTHING CALLED — null is
		// reserved for a population that could not be read at all, matching the
		// deny-rate column, which already tells those two apart. One null
		// covering both would read "no calls" as "unmeasurable".
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
 * `rows`' order: most expected escaped denies first, a null rate ahead of all.
 * @param {ReturnType<typeof guardRow>} a
 * @param {ReturnType<typeof guardRow>} b
 * @returns {number}
 */
function byExpectedEscapes(a, b) {
	// Two nulls would otherwise subtract Infinity from Infinity — NaN, which
	// the spec coerces to +0, silently pinning the pair to whatever order
	// they happened to be inserted in rather than a chosen one. Break the
	// tie on the guard name instead.
	if (a.expected === null && b.expected === null)
		return byCodeUnit(a.guard, b.guard);
	return (
		(b.expected ?? Number.POSITIVE_INFINITY) -
		(a.expected ?? Number.POSITIVE_INFINITY)
	);
}

/**
 * Guards this run found deny-capable that `lib/guard-deny-rates.js` has no
 * pinned row for — the staleness signal.
 *
 * SCOPE-BLIND (mantahostels#3350): a non-deny row is skipped rather than reported stale.
 * That table pins DENY rates, so a guard that cannot deny is correctly absent
 * from it, and naming it here would be a false alarm on every `--scope nondeny`
 * run.
 *
 * @param {Map<string, import("./lib/guard-triggers.js").Trigger>} triggers
 * @returns {string[]}
 */
function unpinned(triggers) {
	return [...triggers]
		.filter(([g, t]) => t.denyCapable && !rateTable.RATES[g])
		.map(([g]) => g)
		.sort();
}

/**
 * The `--failures` buckets that HAVE a true tool-call denominator, and the
 * ticket that gave each one (mantahostels#3356).
 *
 * A LANDED FACT ABOUT THIS REPO, not a derivation: a bucket joins this set when
 * a run of this script over it has been landed as data, so adding a row here
 * without landing that run overstates the share it prints.
 *
 * `SessionStart` is deliberately absent though mantahostels#2288 reports it honestly: its
 * base is sessions, not tool calls, and folding it in here would answer a
 * looser question than the one this share asks (mantahostels#3350's Correction 6).
 *
 * @type {ReadonlyMap<string, string>}
 */
const TRUE_DENOMINATOR = new Map([
	["PreToolUse, deny-capable", "mantahostels#3287"],
	["PreToolUse, non-deny", "mantahostels#3350"],
	["PostToolUse, guard named", "mantahostels#3356"],
	["PostToolUse, unattributed", "mantahostels#3372"],
]);

/**
 * The share of a sweep's hook failures that sits on a true tool-call
 * denominator, and the buckets behind it — the figure and the arithmetic BOTH
 * report, so the text and the JSON cannot state different numbers (mantahostels#3356).
 *
 * `pct` is null over an empty sweep: a share of nothing is unknown, not zero,
 * the same rule `wilson` and the deny-rate column already follow.
 *
 * @param {Map<string, number>} failures
 * @returns {{rows: Array<{bucket: string, records: number, pct: number | null,
 *   ticket: string | null}>, total: number, covered: number,
 *   pct: number | null}}
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
 * The hook-failure census as the report prints it.
 *
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
 * The `--union` report (mantahostels#3372), per tool and in total.
 *
 * A RECORD IS OUTSIDE THE BASE where its call id is not among its tool's routed
 * calls, or where it carries no id to look up — either way no registered guard
 * can be shown to have been at risk on it, so it is counted in `outside` and
 * kept out of `failurePct`'s numerator. A tool with no routed calls has a null
 * rate, not a division by zero.
 *
 * @param {Map<string, UnionEntry>} union
 * @returns {{rows: Array<UnionRow & {tool: string}>, total: UnionRow}}
 * @typedef {{calls: number, blocks: number, records: number, failedCalls: number,
 *   inUnion: number, outside: number, failurePct: number | null}} UnionRow
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
 * The `--union` report as text.
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
 * @param {{dir: string, event: string, files: number, scanned: number, unreadable: string[],
 *   window: {since: string|null, until: string|null}, undated: number,
 *   first: string|null, last: string|null, lostCalls: number,
 *   unpinned: string[], skipped: number, scope: string, guards: number}} corpus
 * @returns {string}
 */
function render(data, corpus) {
	const lines = [];
	lines.push(`corpus  ${corpus.dir}`);
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
	for (const r of data) lines.push(rowLine(r));
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
function rowLine(r) {
	return `${r.guard.padEnd(30)} ${String(r.lost).padStart(4)} ${String(r.denies).padStart(8)} ${String(r.population ?? "—").padStart(12)}   ${num(r.lossPct, 4).padStart(8)}   ${rateCell(r).padEnd(20)} ${expectedCell(r)}`;
}

/**
 * The deny-rate cell: the rate and its interval, or why there is none.
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
 * The expected-escaped cell: the estimate and its interval, or why there is none.
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
 * The expected escaped denies summed over every rated row, and the count of
 * rows left out of that sum on each side of the deny-capable line.
 * @param {ReturnType<typeof rows>} data
 * @returns {{total: number, low: number, high: number, uncounted: number,
 *   nonDeny: number}}
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
			// A guard that cannot deny is not an uncounted deny: it contributes no
			// escaped denies to be a floor UNDER, so folding it into that warning
			// would report the total as understated when it is not (mantahostels#3350).
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
 * The report's closing warnings: guards with no pinned rate, and transcripts
 * that could not be read.
 * @param {Parameters<typeof render>[1]} corpus
 * @returns {string[]} their lines
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
	if (corpus.unreadable.length > 0) {
		lines.push("");
		lines.push(`  ⚠ unreadable (${corpus.unreadable.length}):`);
		for (const f of corpus.unreadable.slice(0, 10)) lines.push(`      ${f}`);
	}
	return lines;
}

/**
 * Reads and parses one JSON file, folding a missing file or bad JSON into one
 * sentence rather than the stack trace an unguarded `JSON.parse` would print —
 * the same shape `--dir` and `--since` already refuse in.
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
 * @returns {number} exit code
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

	const dir = flagValue(flags, "--dir") ?? transcriptDir(HOST);

	const sources = hookSourcesOrNull(err);
	if (!sources) return 2;
	const settings = mergeHooks(sources);
	const scriptsDir = path.join(CORE, "scripts");
	/* HOST's settings.json is read above, so an adopter's own guard is
	 * registered here and must be found where the reporter finds it (#1815). */
	const dirs = guardDirs(CORE, HOST);
	const triggers = triggerTable(settings, dirs, {
		scope,
		event,
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

	const files = transcriptFiles(dir);
	if (files === null) {
		err(`cannot read the corpus directory: ${dir}`);
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
		dir,
		event,
		files: files.length,
		scanned,
		unreadable,
		window,
		undated: acc.undated,
		first: acc.first,
		last: acc.last,
		lostCalls: acc.lostCalls.size,
		unpinned: unpinned(triggers),
		skipped: acc.skipped,
		scope,
		guards: triggers.size,
	};

	if (flags["--json"]) {
		say(
			JSON.stringify(
				jsonReport(corpus, data, { acc, classify, unionReport }),
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
 * The `--since`/`--until` window, or null once a bad date has been reported.
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
 * The run's `--scope` and `--event`, or null once a refused combination has
 * been reported.
 * @param {import("./lib/cli-args").Parsed["flags"]} flags
 * @param {(s: string) => void} err
 * @returns {{scope: "deny" | "nondeny" | "all",
 *   event: "PreToolUse" | "PostToolUse"} | null}
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
	// `--scope` defaults to `deny`, which `triggerTable` refuses off
	// `PreToolUse`; taking `all` where the user named no scope keeps `--event
	// PostToolUse` usable on its own, and an explicit scope still refuses (mantahostels#3356).
	const scope = /** @type {"deny" | "nondeny" | "all"} */ (
		scopeArg ?? (event === DENY_EVENT ? "deny" : "all")
	);
	if (event !== DENY_EVENT && scope !== "all") {
		err(`--scope ${scope} is meaningless with --event ${event}:`);
		err("no hook on that event can deny a call, so every row is non-deny.");
		err("Drop --scope, or pass --scope all.");
		return null;
	}

	// A narrower scope would union a subset of the event's guards and print it
	// as "ANY" of them.
	if (flags["--union"] && scope !== "all") {
		err(
			`--union needs --scope all: --scope ${scope} unions only part of the ${event} guards.`,
		);
		return null;
	}
	return { scope, event };
}

/**
 * The files registering HOST's hooks (`hookSourcesOf`), read for
 * `mergeHooks`, or null once an unreadable file — or, at an adopter, the
 * absence of both — has been reported.
 * @param {(s: string) => void} err
 * @returns {ReturnType<typeof hookSourcesOf> | null}
 */
function hookSourcesOrNull(err) {
	let sources;
	try {
		sources = hookSourcesOf(HOST, { core: CORE });
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
 * The `--failures` split, built at `all` scope over EVERY tool-call event
 * whatever this run reports on, so the census is the same population every
 * time (mantahostels#3356).
 * @param {ReturnType<typeof mergeHooks>} settings
 * @param {string[]} dirs `lib/deny-capable.js` `guardDirs`
 * @returns {Map<string, Map<string, boolean>>}
 */
function failureClassifier(settings, dirs) {
	return new Map(
		[...EVENTS].map((e) => [
			e,
			new Map(
				[
					...triggerTable(settings, dirs, {
						scope: "all",
						event: /** @type {"PreToolUse" | "PostToolUse"} */ (e),
					}),
				].map(([guard, t]) => [guard, t.denyCapable]),
			),
		]),
	);
}

/**
 * @param {Parameters<typeof render>[1]} corpus
 * @param {ReturnType<typeof rows>} data
 * @param {{acc: ReturnType<typeof scan>["acc"],
 *   classify: Map<string, Map<string, boolean>> | null,
 *   unionReport: ReturnType<typeof unionShare> | null}} extras
 */
function jsonReport(corpus, data, { acc, classify, unionReport }) {
	return {
		corpus: { ...corpus, unreadable: corpus.unreadable.length },
		rows: data,
		...(classify ? { failures: failureShare(acc.failures) } : {}),
		...(unionReport ? { union: unionReport } : {}),
	};
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
