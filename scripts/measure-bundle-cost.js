#!/usr/bin/env node
/*
 * measure-bundle-cost.js — what does a dispatch bundle cost, by member count?
 *
 * mantahostels#1094's measurement, behind the figures
 * `.claude/skills/pick-next/references/measured-figures.md` cites.
 *
 *   node scripts/measure-bundle-cost.js --since 2026-08-18
 *
 * METHOD, and where it can be wrong.
 *
 * A session's MEMBERS are counted as the distinct issue numbers it ran
 * `gh issue close` on. That both over- and under-counts: a bundle whose last
 * member was left open closes fewer, and a session closing a duplicate it never
 * worked closes more. Nothing records bundle membership at dispatch.
 *
 * STANDING CONTEXT is fresh input + cache write + cache read on each assistant
 * turn — what the model was sent. MAIN-TIER ONLY, deliberately: the corpus
 * scan here (`fs.readdirSync`, unlike `lib/guard-fires.js` `readTranscriptFiles`)
 * never descends into a `subagents/` directory, so a dispatched subagent's own
 * billed turns are excluded from every figure below, not merged into the
 * dispatching session's. A `gh issue close` a subagent ran itself would also
 * be missed by the MEMBERS count above, for the same reason.
 *
 * COST is weighted at the Opus 5 API list ratios, the same weighting mantahostels#830 used,
 * and is a cost-EQUIVALENT: a Max plan does not meter this way (mantahostels#829).
 * A cache write is weighted at its own TTL's rate (#1203). The dollar figures
 * `measured-figures.md` cites were measured at the flat 5-minute rate, before
 * this.
 *
 * `sdk-py` sessions are excluded by requiring a user turn — pooling them
 * corrupts every per-session statistic (mantahostels#830).
 *
 * ⚠ THE HEADLINE IS CONFOUNDED. Only issues judged `small` may be merged, so a
 * bundled issue is a cheap issue by construction and this cannot separate the
 * size band from the merging. Read it for the negative it does establish: the
 * marginal cost of member N does not visibly rise with N.
 *
 * NOT IN A PREFIX FAMILY, per §N3. It gates nothing and files nothing; it is an
 * ad-hoc measurement kept for re-derivation, so no family's contract fits. It
 * borrows only exit 2 for BROKEN.
 *
 * REPORTS ONLY. Exit 0 on a reading; exit 2 only where the corpus cannot be read
 * at all.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { configDir } = require("./lib/config-dir.js");
const { mainChainRecords, standingContext } = require("./lib/transcript.js");
const { errMessage } = require("./lib/check.js");
const { flagValue, parseOrExit } = require("./lib/cli-args.js");
const { writesByTtl } = require("./lib/session-spend.js");
const { slugForRepo } = require("./lib/project-slug.js");

/** Human-readable output, written so it survives `process.exit` (§N6). */
const out = (/** @type {string} */ text) => writeFd(1, `${text}\n`);
const fail = (/** @type {string} */ text) => writeFd(2, `${text}\n`);

/* Per Mtok: fresh input, output, 5-minute and 1-hour cache write, cache read. */
const RATES = { input: 15, output: 75, write: 18.75, write1h: 30, read: 1.5 };

const USAGE =
	"Usage: node scripts/measure-bundle-cost.js [--since <YYYY-MM-DD>]";

const CLOSE = /gh\s+issue\s+close\s+(?:--\S+\s+\S+\s+)*?#?(\d{2,5})/g;

/**
 * One session's cost, turns, context and member count.
 * @param {string} text
 */
function sessionRow(text) {
	/** @type {number | null} */
	let firstAt = null;
	let hasUser = false;
	/** @type {Bill} */
	const bill = {
		/* A transcript repeats one message across its content blocks, so bill each
		 * message once (mantahostels#830's de-duplication key). */
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

/**
 * A session's running bill: the message keys already billed, the weighted
 * cost, the billed turns, and the standing context's sum, count and peak.
 * @typedef {{ billed: Set<string>, cost: number, turns: number, ctxSum: number, ctxN: number, peak: number }} Bill
 */

/**
 * @typedef {Record<string, any>} TranscriptPart One object from a parsed
 * transcript line — an assistant message, its `usage`, or a content block.
 * `any` because JSON.parse types nothing and each field is read with a
 * fallback or a type check where it is used.
 */

/**
 * Bill one assistant message, unless its key was billed already.
 * @param {Bill} bill accumulator: the turn's key, cost and context are added
 * @param {TranscriptPart} message one carrying `usage`
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
 * One turn's cost-equivalent in dollars, at RATES.
 * @param {TranscriptPart} usage
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
 * Add every issue number a Bash `gh issue close` in `content` names.
 * @param {Set<string | undefined>} closed accumulator: each closed issue number is added
 * @param {TranscriptPart[]} content
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
	/* Derived from THIS CHECKOUT, never a literal and never the cwd: the slug
	 * was hard-coded to the founder's own path until mantahostels#1982, so the corpus read
	 * as unreadable on any other machine. */
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

	/** @type {ReturnType<typeof sessionRow>[]} */
	const rows = [];
	for (const f of files) {
		let text;
		try {
			text = fs.readFileSync(path.join(dir, f), "utf8");
		} catch {
			continue;
		}
		const r = sessionRow(text);
		if (!r.hasUser || !r.members || !r.firstAt || r.firstAt < since) continue;
		rows.push(r);
	}
	if (rows.length === 0) {
		fail(`No issue-closing session in ${dir} since the window opened.`);
		return 2;
	}

	out(`Corpus: ${files.length} transcripts in ${dir}`);
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
