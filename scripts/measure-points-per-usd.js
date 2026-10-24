#!/usr/bin/env node
/*
 * measure-points-per-usd.js — re-derive the bar points per dollar behind the
 * capped launch (`lib/allowance.js#POINTS_PER_USD`, #370, #380).
 *
 * Usage: node scripts/measure-points-per-usd.js [--config-dir <dir>]...
 *
 * Per seat and bar, the `cachedUsageUtilization` percent divided by that
 * seat's list-price spend across EVERY project inside the bar's window: from
 * `resets_at` minus 5 hours or 7 days, to the reading's own `fetchedAtMs`.
 * Priced at `lib/session-spend.js#LIST_PRICES`; requests on a model outside
 * it are counted, not priced, and overstate the rate.
 *
 * A project directory symlinked into another seat's is skipped and counted:
 * its transcripts cannot be told apart by seat, so they are charged once, to
 * the seat that holds them.
 *
 * Prints only: the rates are updated by hand. Exits 0 where at least one rate
 * printed, 1 where none could. Seats: `lib/seat-args.js`.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { readAllowance } = require("./lib/allowance");
const { seatsFrom } = require("./lib/seat-args");
const { parseOrCode } = require("./lib/cli-args");
const { fileSpend, LIST_PRICES } = require("./lib/session-spend");

const HOUR_MS = 60 * 60 * 1000;
/** The 5-hour and weekly all-models windows `docs/effort-guide.md` names per seat. */
const SPANS = /** @type {const} */ ({
	session: 5 * HOUR_MS,
	weekly_all: 7 * 24 * HOUR_MS,
});

/**
 * @param {string} dir
 * @returns {string[]}
 */
function namesIn(dir) {
	try {
		return fs.readdirSync(dir);
	} catch {
		// Absent: a session with no subagents has no `subagents/` directory.
		return [];
	}
}

/**
 * @param {string} file
 * @param {number} fromMs
 */
function writtenSince(file, fromMs) {
	try {
		return fs.statSync(file).mtimeMs >= fromMs;
	} catch {
		// Deleted between the listing and the stat: nothing left to price.
		return false;
	}
}

/**
 * Every main and subagent transcript the seat itself holds, last written at or
 * after `fromMs` (an older file cannot hold a record inside the window), and
 * how many project directories were links into another seat's.
 * @param {string} seat
 * @param {number} fromMs
 * @returns {{ files: string[], linked: number } | null} null where the seat's
 *   `projects/` cannot be read
 */
function transcriptsSince(seat, fromMs) {
	const root = path.join(seat, "projects");
	let projects;
	try {
		projects = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return null;
	}
	/** @type {string[]} */
	const files = [];
	let linked = 0;
	for (const p of projects) {
		if (p.isSymbolicLink()) {
			linked++;
			continue;
		}
		if (!p.isDirectory()) continue;
		for (const f of projectFiles(path.join(root, p.name), fromMs))
			files.push(f);
	}
	return { files, linked };
}

/**
 * One project directory's main transcripts, each followed by its subagents',
 * last written at or after `fromMs`.
 * @param {string} dir
 * @param {number} fromMs
 * @returns {string[]}
 */
function projectFiles(dir, fromMs) {
	/** @type {string[]} */
	const files = [];
	for (const n of namesIn(dir)) {
		if (!n.endsWith(".jsonl")) continue;
		const mainFile = path.join(dir, n);
		if (writtenSince(mainFile, fromMs)) files.push(mainFile);
		const subDir = path.join(dir, n.replace(/\.jsonl$/, ""), "subagents");
		for (const s of namesIn(subDir)) {
			const sub = path.join(subDir, s);
			if (/^agent-.*\.jsonl$/.test(s) && writtenSince(sub, fromMs))
				files.push(sub);
		}
	}
	return files;
}

/** @param {number} ms */
const formatAge = (ms) =>
	ms < HOUR_MS
		? `${Math.round(ms / 60_000)} min`
		: `${Math.round(ms / HOUR_MS)} h`;

/**
 * List-price spend across `files` inside the window, and the requests on a
 * model with no list price.
 * @param {string[]} files
 * @param {{ fromMs: number, toMs: number }} window
 */
function spendIn(files, window) {
	let usd = 0;
	let unpriced = 0;
	for (const f of files) {
		const s = fileSpend(f, { window, prices: LIST_PRICES });
		usd += s.usd;
		unpriced += s.unpriced;
	}
	return { usd, unpriced };
}

/**
 * Print one seat's rate for one bar.
 * @param {{ seat: string, bar: keyof SPANS, bars: ReturnType<typeof readAllowance>, now: number }} reading
 * @returns {boolean} whether a rate printed — spend above zero
 */
function printBar({ seat, bar, bars, now }) {
	const { percent, resetsAt, fetchedAtMs } = bars[bar];
	const resetsMs = Date.parse(String(resetsAt));
	if (percent === null || fetchedAtMs === null || !Number.isFinite(resetsMs)) {
		writeFd(
			1,
			`${seat} ${bar}: no reading in .claude.json — run /usage in a session on this seat, then re-run\n`,
		);
		return false;
	}
	const fromMs = resetsMs - SPANS[bar];
	const toMs = Math.min(fetchedAtMs, resetsMs);
	const found = transcriptsSince(seat, fromMs);
	if (!found) {
		writeFd(1, `${seat} ${bar}: ${seat}/projects is unreadable\n`);
		return false;
	}
	const { usd, unpriced } = spendIn(found.files, { fromMs, toMs });
	const rate = usd > 0 ? (percent / usd).toPrecision(3) : "n/a";
	writeFd(
		1,
		`${seat} ${bar}: ${percent}% on $${usd.toFixed(2)} = ${rate} pts/$ (reading ${formatAge(now - fetchedAtMs)} old, ${unpriced} unpriced requests, ${found.linked} linked project dirs skipped)\n`,
	);
	return usd > 0;
}

function main() {
	const parsed = parseOrCode(process.argv.slice(2), {
		usage:
			"usage: node scripts/measure-points-per-usd.js [--config-dir <dir>]...",
		flags: { "--config-dir": "list" },
	});
	if (typeof parsed === "number") return parsed;
	const seats = seatsFrom(parsed.lists["--config-dir"]);
	const now = Date.now();
	let printed = 0;
	for (const seat of seats) {
		const bars = readAllowance({ configDir: seat, now });
		for (const bar of /** @type {(keyof SPANS)[]} */ (Object.keys(SPANS))) {
			if (printBar({ seat, bar, bars, now })) printed++;
		}
	}
	return printed ? 0 : 1;
}

if (require.main === module) process.exit(main());
