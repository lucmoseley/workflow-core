/*
 * session-spend.js — what a session has spent so far, from its own transcript,
 * and what it is expected to spend yet, from the committed cost table (#371
 * items 1-2, #372).
 *
 * The capped launch (`lib/allowance.js#capSet`) projects the warned bar forward
 * by the remaining spend of every session already running. The table is
 * refreshed by `scripts/measure-session-cost.js`, never at launch.
 *
 * Pricing dedupes assistant records on requestId per file, keeping the MAX of
 * each token field (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/burn-measurement-method-correction.md), priced at
 * `docs/effort-guide.md`'s table, which gives no cache-write rate: a 5-minute
 * write is 1.25x fresh input and a 1-hour write 2x, each priced from the
 * record's `cache_creation` split. Write tokens the split does not cover, a
 * record with no split among them, price at the 5-minute rate. A model outside
 * the table prices at zero, so a session run on one reads as fresh and is
 * charged the full mean remainder.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./host-root");
const { findTranscript, subagentDirOf } = require("./transcript");

/**
 * $/Mtok: fresh input, output, 5-minute cache write, 1-hour cache write, cache
 * read.
 * @typedef {readonly [number, number, number, number, number]} Price
 */

/** @type {Readonly<Record<string, Price>>} */
const PRICES = {
	"claude-opus-5-5": [4, 20, 5, 8, 0.2],
	"claude-sonnet-5": [2, 10, 2.5, 4, 0.2],
};

/**
 * Every model a seat's bar meters, for pricing a whole window rather than a
 * dispatched session (#380). Fable and Haiku from `docs/effort-guide.md`;
 * Opus 5 from https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/opusplan-model-switch-cache.md. Opus 5 last:
 * a prefix match would otherwise take Opus 5.5 too.
 * @type {Readonly<Record<string, Price>>}
 */
const LIST_PRICES = {
	...PRICES,
	"claude-fable-5-1": [10, 50, 12.5, 20, 0.25],
	"claude-haiku-4-5": [1, 5, 1.25, 2, 0.1],
	"claude-opus-5": [5, 25, 6.25, 10, 0.5],
};

const TOKEN_FIELDS = [
	"input_tokens",
	"output_tokens",
	"cache_creation_input_tokens",
	"cache_read_input_tokens",
	"ephemeral_5m_input_tokens",
	"ephemeral_1h_input_tokens",
];

/**
 * A record's usage with the `cache_creation` split lifted to the top level, so
 * the requestId dedupe takes the max of each TTL as it does of every other
 * field. A top-level field wins over its nested one, even at 0.
 * @param {Record<string, unknown> & { cache_creation?: Record<string, unknown> }} usage
 * @returns {Record<string, number>}
 */
function flatUsage(usage) {
	/** @type {Record<string, number>} */
	const out = {};
	for (const k of TOKEN_FIELDS) {
		const v = usage[k] ?? usage.cache_creation?.[k];
		if (typeof v === "number") out[k] = v;
	}
	return out;
}

/**
 * @typedef {{ usage: Record<string, number>, model: string | null | undefined }} RequestUsage
 */

/**
 * Folds one record's `flatUsage` into its request's entry, creating it on the
 * first record, with each field the maximum across the request's records. The
 * entry's `model` is the caller's to set: check-pick-next-model.js takes none
 * from a record that billed nothing.
 * @param {Map<string, RequestUsage>} requests accumulator: the request's entry is created or folded here
 * @param {string} id
 * @param {Record<string, number>} usage
 * @returns {RequestUsage}
 */
function mergeRequest(requests, id, usage) {
	let cur = requests.get(id);
	if (!cur) {
		cur = { usage: {}, model: undefined };
		requests.set(id, cur);
	}
	for (const k of TOKEN_FIELDS)
		cur.usage[k] = Math.max(cur.usage[k] || 0, usage[k] || 0);
	return cur;
}

/**
 * Whether a usage bought any tokens at all.
 * @param {Record<string, number>} usage  a `flatUsage` or `mergeRequest` result
 */
const hasUsage = (usage) =>
	TOKEN_FIELDS.some((k) => {
		const n = usage[k];
		return n !== undefined && n > 0;
	});

/**
 * A request's cache-write tokens at each TTL's price. The 5-minute share also
 * takes whatever the `cache_creation` split does not cover — all of a write
 * from a record with no split.
 * @param {number} total  `cache_creation_input_tokens`
 * @param {number} w5m  `ephemeral_5m_input_tokens`
 * @param {number} w1h  `ephemeral_1h_input_tokens`
 * @returns {{ w5m: number, w1h: number }}
 */
const writesByTtl = (total, w5m, w1h) => ({
	w5m: w5m + Math.max(0, total - w5m - w1h),
	w1h,
});

/**
 * A merged request's token counts in `Price` order: fresh input, output,
 * 5-minute write, 1-hour write, cache read.
 * @param {Record<string, number>} usage  a `mergeRequest` entry's usage
 * @returns {[number, number, number, number, number]}
 */
function pricedTokens(usage) {
	/** @param {string} k */
	const field = (k) => {
		const n = usage[k];
		// mergeRequest sets every TOKEN_FIELDS entry, at 0 where none was billed.
		if (n === undefined)
			throw new Error(`usage carries no ${k}: not a mergeRequest entry's`);
		return n;
	};
	const { w5m, w1h } = writesByTtl(
		field("cache_creation_input_tokens"),
		field("ephemeral_5m_input_tokens"),
		field("ephemeral_1h_input_tokens"),
	);
	return [
		field("input_tokens"),
		field("output_tokens"),
		w5m,
		w1h,
		field("cache_read_input_tokens"),
	];
}

/** The committed table, in the HOST repo: it is derived from that repo's own
 * dispatch ledger. */
const SESSION_COST_TABLE = "docs/data/session-cost-table.json";
const tablePath = () => path.join(hostRoot(), SESSION_COST_TABLE);

/**
 * A listed session with no transcript yet started within this window is a
 * just-launched one and counts at the full mean (#371 item 6). Ten minutes is
 * a first guess, not a measurement. Older and still absent,
 * it is a session another seat's transcript holds — listed only through the
 * multi-seat union wrapper — and spends that seat, not this one.
 */
const FRESH_LAUNCH_MS = 10 * 60 * 1000;

/**
 * @param {string | null | undefined} model
 * @param {Readonly<Record<string, Price>>} [prices]
 * @returns {Price | null}
 */
function priceFor(model, prices = PRICES) {
	if (!model) return null;
	for (const [prefix, p] of Object.entries(prices))
		if (model.startsWith(prefix)) return p;
	return null;
}

/**
 * One transcript file's list-price cost in dollars, and how many deduped
 * requests ran on a model outside the price table. With `window`, only
 * records timestamped inside `[fromMs, toMs]` count.
 * @param {string} file
 * @param {{ window?: { fromMs: number, toMs: number }, prices?: Readonly<Record<string, Price>> }} [opts]
 * @returns {{ usd: number, unpriced: number }}
 */
function fileSpend(file, { window, prices = PRICES } = {}) {
	return spendOf(fileRequests(file, window).values(), prices);
}

/**
 * One transcript file's requests, each deduped to its fullest usage; empty
 * where the file cannot be read.
 * @param {string} file
 * @param {{ fromMs: number, toMs: number }} [window]
 * @returns {Map<string, RequestUsage>}
 */
function fileRequests(file, window) {
	/** @type {Map<string, RequestUsage>} */
	const best = new Map();
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return best;
	}
	let n = 0;
	for (const line of text.split("\n")) {
		const r = usageRecordOf(line, window);
		if (r === null) continue;
		const rid = r.requestId || `__norid__${n++}`;
		const cur = mergeRequest(best, rid, flatUsage(r.message.usage));
		cur.model = r.message.model || cur.model;
	}
	return best;
}

/**
 * An assistant transcript record carrying usage. Parsed JSON, checked only for
 * its `type` and `message.usage`, so every other field may be absent.
 * @typedef {{ requestId?: string, message: { model?: string | null,
 *   usage: Record<string, unknown> & { cache_creation?: Record<string, unknown> } } }} UsageRecord
 */

/**
 * The record on one transcript line where it is an assistant turn carrying
 * usage, timestamped inside `window` where one is given; else `null`.
 * @param {string} line
 * @param {{ fromMs: number, toMs: number }} [window]
 * @returns {UsageRecord | null}
 */
function usageRecordOf(line, window) {
	if (!line.includes('"assistant"')) return null;
	let r;
	try {
		r = JSON.parse(line);
	} catch {
		return null;
	}
	if (r?.type !== "assistant" || !r.message?.usage) return null;
	if (window) {
		const at = Date.parse(r.timestamp);
		if (!(at >= window.fromMs && at <= window.toMs)) return null;
	}
	return r;
}

/**
 * @param {Iterable<RequestUsage>} requests
 * @param {Readonly<Record<string, Price>>} prices
 * @returns {{ usd: number, unpriced: number }}
 */
function spendOf(requests, prices) {
	let usd = 0;
	let unpriced = 0;
	for (const { usage, model } of requests) {
		const p = priceFor(model, prices);
		if (!p) {
			if (hasUsage(usage)) unpriced++;
			continue;
		}
		const tokens = pricedTokens(usage);
		usd +=
			p.reduce((sum, rate, i) => {
				const n = tokens[i];
				if (n === undefined) throw new Error(`no token count for price ${i}`);
				return sum + n * rate;
			}, 0) / 1e6;
	}
	return { usd, unpriced };
}

/** @param {string} file */
const fileCostUsd = (file) => fileSpend(file).usd;

/**
 * A session's cost so far.
 * @param {string} mainFile
 * @returns {number}
 */
function sessionSpendUsd(mainFile) {
	return sessionFiles(mainFile).reduce((t, f) => t + fileCostUsd(f), 0);
}

/** The token fields a session's total counts: the 5m/1h fields split cache writes, so they would count twice. */
const TOTAL_TOKEN_FIELDS = [
	"input_tokens",
	"output_tokens",
	"cache_creation_input_tokens",
	"cache_read_input_tokens",
];

/**
 * A session's tokens so far, over `sessionFiles`, as `sessionSpendUsd` is (#2241).
 * @param {string} mainFile
 * @returns {number}
 */
function sessionTokens(mainFile) {
	let total = 0;
	for (const f of sessionFiles(mainFile))
		for (const { usage } of fileRequests(f).values())
			for (const k of TOTAL_TOKEN_FIELDS) total += usage[k] || 0;
	return total;
}

/**
 * A session's main transcript and every `<session>/subagents/agent-*.jsonl`
 * beside it.
 * @param {string} mainFile
 */
function sessionFiles(mainFile) {
	const subDir = subagentDirOf(mainFile);
	/** @type {string[]} */
	let subs = [];
	try {
		subs = fs.readdirSync(subDir);
	} catch {
		// No subagents directory: the session dispatched none.
	}
	return [
		mainFile,
		...subs
			.filter((f) => /^agent-.*\.jsonl$/.test(f))
			.map((f) => path.join(subDir, f)),
	];
}

/**
 * @typedef {{ meanUsd: number, quantilesUsd: number[] }} CostTable
 */

/**
 * The committed table, or null where it is missing or malformed.
 * `WFC_SESSION_COST_TABLE` points it elsewhere, so a test fixes the figures a
 * refresh would otherwise move.
 * @param {string} [file]
 * @returns {CostTable | null}
 */
function readCostTable(
	file = process.env.WFC_SESSION_COST_TABLE || tablePath(),
) {
	try {
		const t = JSON.parse(fs.readFileSync(file, "utf8"));
		if (
			typeof t?.meanUsd === "number" &&
			Array.isArray(t.quantilesUsd) &&
			t.quantilesUsd.length >= 2 &&
			t.quantilesUsd.every((/** @type {unknown} */ q) => typeof q === "number")
		)
			return t;
	} catch {
		/* unreadable or malformed: falls through to null */
	}
	return null;
}

/**
 * E[cost − spent | cost > spent], with the table's equally weighted quantiles
 * standing in for the distribution — never floored at zero, which reads a
 * session past the median as finished (#370).
 * Past the table's top there is no data: keeping the top step's gap as the
 * remainder is a guess, and stated as one.
 * @param {number} spentUsd
 * @param {CostTable} table
 * @returns {number}
 */
function expectedRemainderUsd(spentUsd, table) {
	if (spentUsd <= 0) return table.meanUsd;
	const q = table.quantilesUsd;
	const above = q.filter((x) => x > spentUsd);
	if (above.length === 0) {
		const [belowTop, top] = q.slice(-2);
		if (belowTop === undefined || top === undefined)
			throw new Error("cost table holds fewer than two quantiles");
		return top - belowTop;
	}
	return above.reduce((s, x) => s + (x - spentUsd), 0) / above.length;
}

/**
 * @typedef {{ sessionId: string, spentUsd: number | null, remainderUsd: number }} Running
 */

/**
 * Each still-working listed session's expected remaining spend on THIS seat.
 * `agents` is the oracle's listing; terminal ones (done, failed, stopped) are
 * skipped.
 * @param {{ agents: Array<{ sessionId: string, kind?: string, state?: string, startedAt?: number }>, table: CostTable, configDir: string, now?: number }} opts
 * @returns {Running[]}
 */
function runningRemainders({ agents, table, configDir, now = Date.now() }) {
	/** @type {Running[]} */
	const out = [];
	for (const a of agents) {
		if (!a?.sessionId) continue;
		if (["done", "failed", "stopped"].includes(a.state ?? "")) continue;
		const file = findTranscript(configDir, a.sessionId);
		if (file) {
			const spentUsd = sessionSpendUsd(file);
			out.push({
				sessionId: a.sessionId,
				spentUsd,
				remainderUsd: expectedRemainderUsd(spentUsd, table),
			});
			continue;
		}
		const fresh =
			typeof a.startedAt !== "number" || now - a.startedAt <= FRESH_LAUNCH_MS;
		if (fresh)
			out.push({
				sessionId: a.sessionId,
				spentUsd: null,
				remainderUsd: table.meanUsd,
			});
	}
	return out;
}

module.exports = {
	LIST_PRICES,
	priceFor,
	SESSION_COST_TABLE,
	tablePath,
	fileSpend,
	flatUsage,
	hasUsage,
	mergeRequest,
	pricedTokens,
	writesByTtl,
	sessionSpendUsd,
	sessionTokens,
	readCostTable,
	expectedRemainderUsd,
	runningRemainders,
};
