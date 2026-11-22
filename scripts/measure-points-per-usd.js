#!/usr/bin/env node

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { readAllowance } = require("./lib/allowance");
const { caught } = require("./lib/caught.js");
const { readDeclaredOverflowLookup } = require("./lib/dispatch-ledger.js");
const { seatsFrom } = require("./lib/seat-args");
const { parseOrCode } = require("./lib/cli-args");
const { fileSpend, LIST_PRICES } = require("./lib/session-spend");

const HOUR_MS = 60 * 60 * 1000;
const SPANS = /** @type {const} */ ({
	session: 5 * HOUR_MS,
	weekly_all: 7 * 24 * HOUR_MS,
});

/** @typedef {import("./lib/dispatch-ledger.js").OverflowLookup} OverflowLookup */

/**
 * @param {string} dir
 * @returns {string[]}
 */
function readNamesIn(dir) {
	try {
		return fs.readdirSync(dir);
	} catch {
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
		return false;
	}
}

/**
 * @param {string} seat
 * @param {number} fromMs
 * @param {OverflowLookup} overflowLaunchOf
 * @returns {{ files: string[], linked: number } | null}
 */
function readTranscriptsSince(seat, fromMs, overflowLaunchOf) {
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
		for (const f of readProjectFiles(
			path.join(root, p.name),
			fromMs,
			overflowLaunchOf,
		))
			files.push(f);
	}
	return { files, linked };
}

/**
 * @param {string} dir
 * @param {number} fromMs
 * @param {OverflowLookup} overflowLaunchOf
 * @returns {string[]}
 */
function readProjectFiles(dir, fromMs, overflowLaunchOf) {
	/** @type {string[]} */
	const files = [];
	for (const n of readNamesIn(dir)) {
		if (!n.endsWith(".jsonl")) continue;
		const sessionId = n.replace(/\.jsonl$/, "");
		if (overflowLaunchOf({ sessionId })) continue;
		const mainFile = path.join(dir, n);
		if (writtenSince(mainFile, fromMs)) files.push(mainFile);
		const subDir = path.join(dir, sessionId, "subagents");
		for (const s of readNamesIn(subDir)) {
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
 * @param {{ seat: string, bar: keyof typeof SPANS, bars: ReturnType<typeof readAllowance>, now: number, overflowLaunchOf: OverflowLookup }} reading
 * @returns {boolean}
 */
function printBar({ seat, bar, bars, now, overflowLaunchOf }) {
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
	const found = readTranscriptsSince(seat, fromMs, overflowLaunchOf);
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
	let overflowLaunchOf;
	try {
		overflowLaunchOf = readDeclaredOverflowLookup();
	} catch (e) {
		writeFd(2, `measure-points-per-usd: ${caught(e).message}\n`);
		return 1;
	}
	const now = Date.now();
	let printed = 0;
	for (const seat of seats) {
		const bars = readAllowance({ configDir: seat, now });
		for (const bar of /** @type {(keyof typeof SPANS)[]} */ (
			Object.keys(SPANS)
		)) {
			if (printBar({ seat, bar, bars, now, overflowLaunchOf })) printed++;
		}
	}
	return printed ? 0 : 1;
}

if (require.main === module) process.exit(main());
