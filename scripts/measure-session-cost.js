#!/usr/bin/env node
/*
 * measure-session-cost.js — re-derive the per-session cost table the capped
 * launch reads (`docs/data/session-cost-table.json`, #371 items 1-2, #372).
 *
 * Usage: node scripts/measure-session-cost.js [--write] [--config-dir <dir>]...
 *
 * Every dispatch ledger entry is matched to its transcript by job-id prefix on
 * any seat, plus that session's subagent transcripts, and priced by
 * `lib/session-spend.js`. Only sessions whose dominant model is in its price
 * table are kept, both models pooled, as #371 ruled. Without
 * `--write` it prints the summary and writes nothing.
 *
 * Seats: `lib/seat-args.js`. Never run at launch.
 *
 * SHIPS IN THE PLUGIN (#1734): each host prices its own ledger, so an adopter
 * builds its own table — init and upgrade, where none exists or none this
 * version reads (#2925, `lib/core-owned-files.js`), and this command by hand
 * to refresh it.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ledgerPath } = require("./lib/dispatch-ledger");
const { oneCopyEach } = require("./lib/project-dirs");
const { slugForRepo } = require("./lib/project-slug");
const { seatsFrom } = require("./lib/seat-args");
const { parseOrCode } = require("./lib/cli-args");
const {
	priceFor,
	tablePath,
	readSessionSpendEvents,
} = require("./lib/session-spend");
const { requiredGroup } = require("./lib/regex-group");
const { scriptPath } = require("./lib/script-path.js");

/** 41 points, every 2.5%: a first guess at "small" (#371 item 2), not tuned. */
const QUANTILE_STEPS = 40;

/**
 * The job id: the last run of 6+ hex characters.
 * @param {unknown} raw
 */
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
	const project = slugForRepo();
	/** @type {string[]} */
	const hits = [];
	for (const seat of seats) {
		const dir = path.join(seat, "projects", project);
		let names;
		try {
			names = fs.readdirSync(dir);
		} catch {
			continue;
		}
		const hit = names.find((n) => n.startsWith(prefix) && n.endsWith(".jsonl"));
		if (hit) hits.push(path.join(dir, hit));
	}
	// A session resumed on another seat has a copy on each; the largest is whole.
	return oneCopyEach(hits)[0] ?? null;
}

const MODEL = /"model":"([^"]+)"/;

/**
 * The model most of a transcript's assistant records ran on.
 * @param {string} file
 */
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

/** Where the landed share is read, in hours from a session's first request:
 * a first guess, not tuned (#2925). `landedShare` holds the last mark's
 * share past it, out to a week. */
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
		// Under 40 sessions u is the maximum and no tail exists to measure: the
		// mean is a stated guess, where 0 would read a session past u as
		// finished (#370).
		tailRemainderUsd: round(
			tail.length === 0
				? totalUsd / n
				: tail.reduce((s, x) => s + (x - u), 0) / tail.length,
		),
		landedByHours: landedCurve(sessions, totalUsd),
	};
}

/**
 * Per `LANDED_HOURS` mark, the share of all sessions' spend that landed within
 * it of each session's first stamped request; an unstamped request counts as
 * landed at once.
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

/**
 * Written under this script's own arbiter claim: the claim guard sees Write
 * and Edit only, never a script's write.
 * @param {string} body
 */
function writeClaimed(body) {
	const arbiter = path.join(__dirname, "session-arbiter.js");
	const table = tablePath();
	const claim = spawnSync("node", [arbiter, "claim", table], {
		encoding: "utf8",
	});
	if (claim.status !== 0) {
		writeFd(2, `not written — claim refused:\n${claim.stdout}${claim.stderr}`);
		return 1;
	}
	try {
		fs.mkdirSync(path.dirname(table), { recursive: true });
		fs.writeFileSync(table, body);
	} finally {
		const release = spawnSync("node", [arbiter, "release", table], {
			encoding: "utf8",
		});
		if (release.status !== 0)
			writeFd(2, `claim not released:\n${release.stdout}${release.stderr}`);
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
	if (!fs.existsSync(ledger)) {
		writeFd(2, `no dispatch ledger yet at ${ledger} — nothing to table\n`);
		return 1;
	}
	const lines = fs.readFileSync(ledger, "utf8").split("\n");
	const sessions = [];
	for (const line of lines) {
		let rec;
		try {
			rec = JSON.parse(line);
		} catch {
			continue;
		}
		const prefix = jobPrefix(rec?.jobId);
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
