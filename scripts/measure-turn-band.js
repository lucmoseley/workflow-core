#!/usr/bin/env node
/*
 * measure-turn-band.js — where does the 100-turn band sit on the instrument it
 * actually counts on, and how does that scale relate to the two the corpus
 * figures were written on?
 *
 *   node scripts/measure-turn-band.js
 *   node scripts/measure-turn-band.js --threshold 200000 --band 100
 *
 * `scripts/guard-session-ceiling.js`'s turn band counts API RESPONSES,
 * deduplicated by `requestId` (`lib/transcript.js` `countTurns`). Run at
 * mantahostels#2618, 200,000 tokens is first reached at a median of the 104th response,
 * which is what 100 rests on.
 *
 * THREE SCALES, ALL COMPUTED HERE: RESPONSES (the band's own), ASSISTANT
 * RECORDS (what https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/session-ceiling-firing-rates.md counts), and
 * TOOL CALLS. Records read ~2x responses; tool calls ~1x.
 *
 * IT SHARES THE DEDUPE KEY WITH THE GUARD rather than restating it —
 * `turnRecords` is exported from `lib/transcript.js` for this, so the rule
 * under calibration cannot drift from the rule in force. The aggregation on
 * top of it is this file's own; `measure-turn-band.test.ts` pins it to
 * `countTurns` by running this file over a fixture corpus.
 *
 * MAIN-TIER ONLY, and `sdk-py` sessions excluded by requiring a user turn:
 * `readdirSync` never descends into a `subagents/` directory, and pooling
 * hook-started runs corrupts every per-session statistic (mantahostels#830).
 *
 * TWO BOUNDS ON EVERY FIGURE. This reads each transcript whole, where the guard
 * reads only the tail of one over 16 MB (`lib/session-transcript.js`), so on a
 * corpus holding a larger file the guard's count is the lower. And a crossing
 * ordinal is a floor on where the notice actually fires: the guard reads a
 * transcript one turn stale, so it speaks at or after the response named here.
 *
 * NOT IN A PREFIX FAMILY: it gates nothing and files nothing. It borrows only
 * exit 2 for BROKEN.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { configDir } = require("./lib/config-dir.js");
const { errMessage } = require("./lib/check.js");
const { flagValue, parseOrCode } = require("./lib/cli-args");
const { slugForRepo } = require("./lib/project-slug.js");
const {
	mainChainRecords,
	standingContext,
	turnRecords,
} = require("./lib/transcript.js");

/** Human-readable output, written so it survives `process.exit` (§N6). */
const out = (/** @type {string} */ text) => writeFd(1, `${text}\n`);
const fail = (/** @type {string} */ text) => writeFd(2, `${text}\n`);

/**
 * One session on all three scales.
 *
 * `responses` counts distinct keys exactly as `countTurns` does, and
 * `crossedAt` is the response ordinal that first reached `threshold`, so the
 * band can be read straight off the pair.
 * `records` and `toolCalls` are the same session on the scales the older
 * figures were written on, and `crossedAtRecord` / `crossedAtToolCall` are the
 * crossing counted on each: measured where it happened rather than converted
 * from `crossedAt` at the session's average ratio, which is close but not the
 * same number.
 *
 * @param {string} text
 * @param {number} threshold
 */
function sessionRow(text, threshold) {
	let hasUser = false;
	const seen = new Set();
	let unkeyed = 0;
	let records = 0;
	let toolCalls = 0;
	/** @type {number | null} */
	let crossedAt = null;
	/** @type {number | null} */
	let crossedAtRecord = null;
	/** @type {number | null} */
	let crossedAtToolCall = null;

	for (const record of mainChainRecords(text, "main")) {
		if (record.type === "user") hasUser = true;
	}

	for (const { record, usage, key } of turnRecords(text, "main")) {
		records += 1;
		toolCalls += toolUses(record);
		if (key) {
			/* An already-seen key is the same API response written out again. It
			 * repeats the same usage, so skipping it moves no reading — only the
			 * ordinal, which must not advance. */
			if (seen.has(key)) continue;
			seen.add(key);
		} else unkeyed += 1;
		const ctx = standingContext(usage);
		if (crossedAt === null && ctx >= threshold) {
			crossedAt = seen.size + unkeyed;
			crossedAtRecord = records;
			crossedAtToolCall = toolCalls;
		}
	}

	return {
		hasUser,
		responses: seen.size + unkeyed,
		records,
		toolCalls,
		crossedAt,
		crossedAtRecord,
		crossedAtToolCall,
	};
}

/**
 * How many tool calls one assistant record makes.
 * @param {Record<string, any>} record one parsed transcript line; `any`
 *   because JSON.parse types nothing, and `message.content` is checked to be an
 *   array before it is read
 * @returns {number}
 */
function toolUses(record) {
	const content = record.message?.content;
	if (!Array.isArray(content)) return 0;
	let calls = 0;
	for (const block of content) if (block?.type === "tool_use") calls += 1;
	return calls;
}

/**
 * The value at `p` of a population, nearest-rank. `0` on an empty one, which
 * every caller guards before printing.
 * @param {number[]} xs
 * @param {number} p
 */
function percentile(xs, p) {
	const s = [...xs].sort((a, b) => a - b);
	const at =
		s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
	return at === undefined ? 0 : at;
}

/** A count as the report prints it. */
const num = (/** @type {number} */ v) => v.toLocaleString("en-GB");

/**
 * `--threshold` and `--band`, defaulted; NaN where one was given but is not a
 * number.
 * @param {import("./lib/cli-args").Parsed["flags"]} flags
 */
function readNumbers(flags) {
	const arg = (/** @type {string} */ name, /** @type {number} */ fallback) => {
		const value = flagValue(flags, name);
		if (value === undefined) return fallback;
		const n = Number(value);
		return Number.isFinite(n) ? n : Number.NaN;
	};
	/* The defaults mirror `guard-session-ceiling.js`'s `WIND_UP` and `TURN_BAND`,
	 * which export nothing. Move either there and this measures the old one
	 * silently, so re-price both. */
	const threshold = arg("--threshold", 200_000);
	const band = arg("--band", 100);
	return { threshold, band };
}

/**
 * One row per `cli` session that made at least one API response, and the
 * transcripts that would not open.
 * @param {string} dir
 * @param {string[]} files
 * @param {number} threshold
 */
function readRows(dir, files, threshold) {
	/** @type {ReturnType<typeof sessionRow>[]} */
	const rows = [];
	/** @type {string[]} */
	const unread = [];
	for (const f of files) {
		let text;
		try {
			text = fs.readFileSync(path.join(dir, f), "utf8");
		} catch (e) {
			/* Never silent: a transcript that would not open is a session missing
			 * from the denominator, and a calibration whose `n` is quietly short
			 * misreports it. */
			unread.push(`${f}: ${errMessage(e)}`);
			continue;
		}
		const r = sessionRow(text, threshold);
		if (!r.hasUser || !r.responses) continue;
		rows.push(r);
	}
	return { rows, unread };
}

/**
 * The share of `total` that `part` is, as a percentage to one place.
 * @param {number} part
 * @param {number} total
 */
const share = (part, total) => ((100 * part) / total).toFixed(1);

/**
 * The crossing section: where `threshold` tokens is first reached, on all
 * three scales.
 * @param {ReturnType<typeof sessionRow>[]} rows
 * @param {number} threshold
 */
function printCrossings(rows, threshold) {
	const crossers = rows.filter((r) => r.crossedAt !== null);
	const crossedAt = crossers.map((r) => /** @type {number} */ (r.crossedAt));
	out(`WHERE ${num(threshold)} TOKENS IS CROSSED`);
	if (crossers.length === 0) {
		out("  no session crosses it");
		return;
	}
	const crossedOn = (/** @type {"Record" | "ToolCall"} */ scale) =>
		crossers.map((r) => Number(r[`crossedAt${scale}`]));
	out("  percentile   responses   records   tool calls");
	for (const p of [10, 25, 50, 75, 90])
		out(
			[
				`  p${String(p).padEnd(11)}`,
				num(percentile(crossedAt, p)).padStart(9),
				num(percentile(crossedOn("Record"), p)).padStart(10),
				num(percentile(crossedOn("ToolCall"), p)).padStart(13),
			].join(""),
		);
	out(
		`  ${num(crossers.length)} of ${num(rows.length)} sessions (${share(crossers.length, rows.length)}%) cross it at all\n`,
	);
}

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
	const parsed = parseOrCode(argv, {
		usage:
			"usage: node scripts/measure-turn-band.js [--threshold <tokens>] [--band <percent>]",
		flags: { "--threshold": "value", "--band": "value" },
	});
	if (typeof parsed === "number") return parsed;
	const { threshold, band } = readNumbers(parsed.flags);
	if (Number.isNaN(threshold) || Number.isNaN(band)) {
		fail("--threshold and --band each need a number.");
		return 2;
	}

	/* Derived from THIS CHECKOUT, never a literal and never the cwd (mantahostels#1982). */
	const dir =
		process.env.WFC_TRANSCRIPT_DIR ||
		path.join(configDir(), "projects", slugForRepo());

	let files;
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	} catch (e) {
		fail(`Cannot read the transcript corpus at ${dir}: ${errMessage(e)}`);
		return 2;
	}

	const { rows, unread } = readRows(dir, files, threshold);
	if (rows.length === 0) {
		fail(`No \`cli\` session with a usage record in ${dir}.`);
		return 2;
	}

	const responses = rows.map((r) => r.responses);
	const reaching = rows.filter((r) => r.responses >= band).length;

	out(`Corpus: ${num(files.length)} transcripts in ${dir}`);
	if (unread.length > 0) {
		out(`${num(unread.length)} could not be read and are excluded:`);
		for (const line of unread) out(`  ${line}`);
	}
	out(`${num(rows.length)} \`cli\` sessions with at least one API response\n`);

	out("RESPONSES PER SESSION (the band's own instrument)");
	for (const p of [50, 75, 90, 95, 99])
		out(
			`  p${String(p).padEnd(3)} ${num(percentile(responses, p)).padStart(8)}`,
		);
	out(`  max  ${num(Math.max(...responses)).padStart(8)}`);
	out(
		`  ${num(reaching)} sessions (${share(reaching, rows.length)}%) reach the ${num(band)}-response band\n`,
	);

	printCrossings(rows, threshold);

	out("PER RESPONSE, over whole sessions — what the older figures were on");
	for (const p of [50, 90]) {
		const rec = percentile(
			rows.map((r) => r.records / r.responses),
			p,
		);
		const tc = percentile(
			rows.map((r) => r.toolCalls / r.responses),
			p,
		);
		out(
			`  p${String(p).padEnd(3)} ${rec.toFixed(2)} assistant records   ${tc.toFixed(2)} tool calls`,
		);
	}

	out(
		`\nThe calibration figure is the median crossing RESPONSE above: a band set there\nfires alongside the ${num(threshold)}-token notice on a median crossing session. The\nrecord and tool-call columns are the same crossing counted on those scales, for\ncomparison with figures written on them. Read this file's header for what the\nfigures exclude and what they are a floor on.`,
	);
	return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
