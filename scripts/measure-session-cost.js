#!/usr/bin/env node

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const { claimByArbiter, releaseByArbiter } = require("./lib/script-claim.js");
const path = require("node:path");
const { ledgerPath } = require("./lib/dispatch-ledger");
const { readJsonl } = require("./lib/jsonl.js");
const { oneCopyEach, projectDirs } = require("./lib/project-dirs");
const { seatsFrom } = require("./lib/seat-args");
const { parseOrCode } = require("./lib/cli-args");
const {
	priceFor,
	tablePath,
	readSessionSpendEvents,
} = require("./lib/session-spend");
const { requiredGroup } = require("./lib/regex-group");
const { scriptPath } = require("./lib/script-path.js");
const { worktreeRoot } = require("./lib/host-root.js");

/** 41 points, every 2.5%: a first guess at "small" (workflow-core#371 item 2), not tuned. */
const QUANTILE_STEPS = 40;

/** @param {unknown} raw */
function jobPrefix(raw) {
	if (typeof raw !== "string") return null;
	const m = raw.match(/[0-9a-f]{6,}/g);
	return m ? m.at(-1) : null;
}

/**
 * @param {string[]} seats
 * @param {string} prefix
 */
function findByPrefix(seats, prefix) {
	/** @type {string[]} */
	const hits = [];
	for (const dir of projectDirs(seats)) {
		let names;
		try {
			names = fs.readdirSync(dir);
		} catch {
			continue;
		}
		const hit = names.find((n) => n.startsWith(prefix) && n.endsWith(".jsonl"));
		if (hit) hits.push(path.join(dir, hit));
	}
	return oneCopyEach(hits)[0] ?? null;
}

const MODEL = /"model":"([^"]+)"/;

/** @param {string} file */
function readDominantModel(file) {
	/** @type {Record<string, number>} */
	const counts = {};
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		const m = line.match(MODEL);
		if (m && line.includes('"type":"assistant"')) {
			const model = requiredGroup(m, 1, MODEL);
			counts[model] = (counts[model] || 0) + 1;
		}
	}
	const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
	return top ? top[0] : null;
}

const LANDED_HOURS = [0.25, 0.5, 1, 2, 3, 4, 6, 8, 12, 24];

const round = (/** @type {number} */ x) => Math.round(x * 100) / 100;

/**
 * @param {import("./lib/session-spend").SpendEvent[][]} sessions
 */
function buildTable(sessions) {
	const costs = sessions.map((ev) => ev.reduce((s, e) => s + e.usd, 0));
	const sorted = [...costs].sort((a, b) => a - b);
	const n = sorted.length;
	const totalUsd = sorted.reduce((s, x) => s + x, 0);
	const quantilesUsd = [];
	for (let i = 0; i <= QUANTILE_STEPS; i++) {
		const cost = sorted[Math.min(n - 1, Math.floor((n * i) / QUANTILE_STEPS))];
		if (cost === undefined)
			throw new Error("buildTable needs at least one cost");
		quantilesUsd.push(round(cost));
	}
	const u = quantilesUsd.at(-2);
	if (u === undefined) throw new Error("QUANTILE_STEPS must be at least 1");
	const tail = sorted.filter((x) => x > u);
	return {
		n,
		meanUsd: round(totalUsd / n),
		quantilesUsd,
		tailRemainderUsd: round(
			tail.length === 0
				? totalUsd / n
				: tail.reduce((s, x) => s + (x - u), 0) / tail.length,
		),
		landedByHours: landedCurve(sessions, totalUsd),
	};
}

/**
 * @param {import("./lib/session-spend").SpendEvent[][]} sessions
 * @param {number} totalUsd
 * @returns {Array<[number, number]>}
 */
function landedCurve(sessions, totalUsd) {
	return LANDED_HOURS.map((h) => {
		let landed = 0;
		for (const ev of sessions) {
			const start = ev.find((e) => !Number.isNaN(e.atMs))?.atMs ?? 0;
			for (const e of ev)
				if (!(e.atMs > start + h * 3_600_000)) landed += e.usd;
		}
		return [h, totalUsd > 0 ? round(landed / totalUsd) : 1];
	});
}

/** @param {string} body */
function writeClaimed(body) {
	const table = tablePath(worktreeRoot());
	const claim = claimByArbiter(table);
	if (!claim.claimed) {
		writeFd(2, `not written — the arbiter's claim failed:\n${claim.why}\n`);
		return 1;
	}
	if (claim.warning) writeFd(2, `${claim.warning}\n`);
	try {
		fs.mkdirSync(path.dirname(table), { recursive: true });
		fs.writeFileSync(table, body);
	} finally {
		const release = releaseByArbiter(table);
		if (!release.released) writeFd(2, `claim not released:\n${release.why}\n`);
	}
	return 0;
}

function main() {
	const parsed = parseOrCode(process.argv.slice(2), {
		usage: `usage: node ${scriptPath("measure-session-cost.js")} [--write] [--config-dir <dir>]...`,
		flags: { "--write": "boolean", "--config-dir": "list" },
	});
	if (typeof parsed === "number") return parsed;
	const { flags, lists } = parsed;
	const seats = seatsFrom(lists["--config-dir"]);
	const ledger = ledgerPath();
	const read = readJsonl(ledger);
	if (!read) {
		writeFd(2, `no dispatch ledger yet at ${ledger} — nothing to table\n`);
		return 1;
	}
	const sessions = [];
	for (const rec of read.rows) {
		const prefix = jobPrefix(rec.jobId);
		if (!prefix) continue;
		const file = findByPrefix(seats, prefix);
		if (!file) continue;
		const model = readDominantModel(file);
		if (!priceFor(model ?? undefined)) continue;
		sessions.push(readSessionSpendEvents(file));
	}
	if (sessions.length === 0) {
		writeFd(2, "no ledger entry matched a transcript — nothing to table\n");
		return 1;
	}
	const table = buildTable(sessions);
	const q = table.quantilesUsd;
	writeFd(
		1,
		`n=${table.n} mean=$${table.meanUsd} median=$${q[QUANTILE_STEPS / 2]} p90=$${q[(QUANTILE_STEPS * 9) / 10]} max=$${q[QUANTILE_STEPS]}\ntail remainder=$${table.tailRemainderUsd} landed=${table.landedByHours.map(([h, s]) => `${h}h:${s}`).join(" ")}\n`,
	);
	if (flags["--write"] !== true) return 0;
	return writeClaimed(`${JSON.stringify(table, null, "\t")}\n`);
}

if (require.main === module) process.exit(main());
