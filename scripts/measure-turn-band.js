#!/usr/bin/env node

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");
const { errMessage } = require("./lib/check.js");
const { flagValue, parseOrCode } = require("./lib/cli-args");
const { corpusDirs, listTranscripts } = require("./lib/project-dirs.js");
const {
	mainChainRecords,
	standingContext,
	turnRecords,
} = require("./lib/transcript.js");

const out = (/** @type {string} */ text) => writeFd(1, `${text}\n`);
const fail = (/** @type {string} */ text) => writeFd(2, `${text}\n`);

/**
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
 * @param {import("./lib/transcript.js").TranscriptRecord} record
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
 * @param {number[]} xs
 * @param {number} p
 */
function percentile(xs, p) {
	const s = [...xs].sort((a, b) => a - b);
	const at =
		s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
	return at === undefined ? 0 : at;
}

const num = (/** @type {number} */ v) => v.toLocaleString("en-GB");

/** @param {import("./lib/cli-args").Parsed["flags"]} flags */
function readNumbers(flags) {
	const arg = (/** @type {string} */ name, /** @type {number} */ fallback) => {
		const value = flagValue(flags, name);
		if (value === undefined) return fallback;
		const n = Number(value);
		return Number.isFinite(n) ? n : Number.NaN;
	};
	const threshold = arg("--threshold", 200_000);
	const band = arg("--band", 100);
	return { threshold, band };
}

/**
 * @param {string[]} files
 * @param {number} threshold
 */
function readRows(files, threshold) {
	/** @type {ReturnType<typeof sessionRow>[]} */
	const rows = [];
	/** @type {string[]} */
	const unread = [];
	for (const f of files) {
		let text;
		try {
			text = fs.readFileSync(f, "utf8");
		} catch (e) {
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
 * @param {number} part
 * @param {number} total
 */
const share = (part, total) => ((100 * part) / total).toFixed(1);

/**
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
		usage: `usage: node ${scriptPath("measure-turn-band.js")} [--threshold <tokens>] [--band <percent>]`,
		flags: { "--threshold": "value", "--band": "value" },
	});
	if (typeof parsed === "number") return parsed;
	const { threshold, band } = readNumbers(parsed.flags);
	if (Number.isNaN(threshold) || Number.isNaN(band)) {
		fail("--threshold and --band each need a number.");
		return 2;
	}

	const dirs = corpusDirs(process.env.WFC_TRANSCRIPT_DIR);
	const where = dirs.join(", ");

	const listing = listTranscripts(dirs);
	const missed = [...listing.absent, ...listing.unreadable];
	if (missed.length > 0) {
		fail(`Cannot read the transcript corpus at ${missed.join(", ")}.`);
		return 2;
	}
	const files = listing.found;

	const { rows, unread } = readRows(files, threshold);
	if (rows.length === 0) {
		fail(`No \`cli\` session with a usage record in ${where}.`);
		return 2;
	}

	const responses = rows.map((r) => r.responses);
	const reaching = rows.filter((r) => r.responses >= band).length;

	out(`Corpus: ${num(files.length)} transcripts in ${where}`);
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
