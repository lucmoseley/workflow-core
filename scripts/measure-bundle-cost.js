#!/usr/bin/env node

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const { writeFd } = require("./lib/write-fd.js");
const { mainChainRecords, standingContext } = require("./lib/transcript.js");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const { writesByTtl } = require("./lib/session-spend.js");
const { corpusDirs, listTranscripts } = require("./lib/project-dirs.js");

const out = (/** @type {string} */ text) => writeFd(1, `${text}\n`);
const fail = (/** @type {string} */ text) => writeFd(2, `${text}\n`);

const RATES = { input: 15, output: 75, write: 18.75, write1h: 30, read: 1.5 };

const USAGE = `Usage: node ${scriptPath("measure-bundle-cost.js")} [--since <YYYY-MM-DD>]`;

const CLOSE = /gh\s+issue\s+close\s+(?:--\S+\s+\S+\s+)*?#?(\d{2,5})/g;

/** @param {string} text */
function sessionRow(text) {
	/** @type {number | null} */
	let firstAt = null;
	let hasUser = false;
	/** @type {Bill} */
	const bill = {
		billed: new Set(),
		cost: 0,
		turns: 0,
		ctxSum: 0,
		ctxN: 0,
		peak: 0,
	};
	/** @type {Set<string | undefined>} */
	const closed = new Set();

	for (const record of mainChainRecords(text, "main")) {
		if (record.type === "user") hasUser = true;
		if (!firstAt && record.timestamp) firstAt = Date.parse(record.timestamp);
		const message = record.message;
		if (record.type !== "assistant" || !message) continue;
		if (message.usage) billTurn(bill, message);
		if (!Array.isArray(message.content)) continue;
		addClosures(closed, message.content);
	}

	return {
		firstAt,
		hasUser,
		cost: bill.cost,
		turns: bill.turns,
		peak: bill.peak,
		meanCtx: bill.ctxN ? bill.ctxSum / bill.ctxN : 0,
		members: closed.size,
	};
}

/** @typedef {{ billed: Set<string>, cost: number, turns: number, ctxSum: number, ctxN: number, peak: number }} Bill */

/**
 * @typedef {import("./lib/transcript.js").TranscriptRecord} TranscriptRecord
 * @typedef {import("./lib/transcript.js").TranscriptBlock} TranscriptBlock
 */

/**
 * @param {Bill} bill
 * @param {TranscriptRecord["message"]} message
 */
function billTurn(bill, message) {
	const usage = message.usage;
	const key = `${message.id}|${usage.output_tokens}|${usage.cache_creation_input_tokens}`;
	if (bill.billed.has(key)) return;
	bill.billed.add(key);
	bill.cost += turnCost(usage);
	bill.turns++;
	const ctx = standingContext(usage);
	if (ctx > 0) {
		bill.ctxSum += ctx;
		bill.ctxN++;
		bill.peak = Math.max(bill.peak, ctx);
	}
}

/**
 * @param {TranscriptRecord["message"]["usage"]} usage
 * @returns {number}
 */
function turnCost(usage) {
	const { w5m, w1h } = writesByTtl(
		usage.cache_creation_input_tokens || 0,
		usage.cache_creation?.ephemeral_5m_input_tokens || 0,
		usage.cache_creation?.ephemeral_1h_input_tokens || 0,
	);
	return (
		((usage.input_tokens || 0) * RATES.input +
			(usage.output_tokens || 0) * RATES.output +
			w5m * RATES.write +
			w1h * RATES.write1h +
			(usage.cache_read_input_tokens || 0) * RATES.read) /
		1e6
	);
}

/**
 * @param {Set<string | undefined>} closed
 * @param {TranscriptBlock[]} content
 */
function addClosures(closed, content) {
	for (const block of content) {
		if (block.type !== "tool_use" || block.name !== "Bash") continue;
		const cmd = String(block.input?.command || "");
		for (const hit of cmd.matchAll(CLOSE)) closed.add(hit[1]);
	}
}

const median = (/** @type {number[]} */ xs) => {
	const s = [...xs].sort((a, b) => a - b);
	const mid = s[Math.floor(s.length / 2)];
	return mid === undefined ? 0 : mid;
};
const kTokens = (/** @type {number} */ n) => `${Math.round(n / 1000)}k`;

/**
 * @param {string[]} argv
 * @returns {number}
 */
function main(argv) {
	const given = flagValue(
		parseOrExit(argv, { usage: USAGE, flags: { "--since": "value" } }).flags,
		"--since",
	);
	const since = given === undefined ? 0 : Date.parse(`${given}T00:00:00Z`);
	if (Number.isNaN(since)) {
		fail("--since needs an ISO date, e.g. 2026-08-18.");
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

	/** @type {ReturnType<typeof sessionRow>[]} */
	const rows = [];
	for (const f of files) {
		let text;
		try {
			text = fs.readFileSync(f, "utf8");
		} catch {
			continue;
		}
		const r = sessionRow(text);
		if (!r.hasUser || !r.members || !r.firstAt || r.firstAt < since) continue;
		rows.push(r);
	}
	if (rows.length === 0) {
		fail(`No issue-closing session in ${where} since the window opened.`);
		return 2;
	}

	out(`Corpus: ${files.length} transcripts in ${where}`);
	out(
		`${rows.length} issue-closing \`cli\` sessions, ${rows.reduce((a, r) => a + r.members, 0)} issues closed\n`,
	);
	out(
		"members   n   med $/session   med $/issue   med turns/issue   med ctx/turn   med peak ctx",
	);
	for (const band of [1, 2, 3, 4, 5, "6+"]) {
		const g = rows.filter((r) =>
			band === "6+" ? r.members >= 6 : r.members === band,
		);
		if (g.length === 0) continue;
		out(
			[
				String(band).padEnd(7),
				String(g.length).padStart(3),
				`$${median(g.map((r) => r.cost)).toFixed(2)}`.padStart(14),
				`$${median(g.map((r) => r.cost / r.members)).toFixed(2)}`.padStart(13),
				median(g.map((r) => r.turns / r.members))
					.toFixed(1)
					.padStart(17),
				kTokens(median(g.map((r) => r.meanCtx))).padStart(14),
				kTokens(median(g.map((r) => r.peak))).padStart(14),
			].join(""),
		);
	}
	out(
		"\nCost is a weighted equivalent, not a bill; the per-issue column is confounded by\nthe merge rule admitting only `small` members. See this file's header.",
	);
	return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
