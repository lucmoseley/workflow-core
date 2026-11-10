#!/usr/bin/env node
/*
 * time-to-land.js — where the landing queue's time goes (#4951): each
 * queue ref's take-to-land time off the queue log, and each batch's steps
 * off the lander's log, replayed batch by batch (lib/time-to-land.js).
 *
 *   node scripts/time-to-land.js [--since <ISO time>] [--until <ISO time>]
 *
 * The window is the last 7 days where `--since` is absent. A batch counts
 * where it was taken in the window, a queue ref where it landed or dropped
 * in it. Times are seconds; `sum` is minutes.
 *
 * In no family: it reads two machine-local logs and prints, gating nothing
 * and writing no file (§N3).
 *
 * Exit codes: 0 printed; 2 on a command line it refuses.
 */

const { now } = require("./lib/check.js");
const { parseOrCode } = require("./lib/cli-args.js");
const { landerLog } = require("./lib/lander-start.js");
const {
	BASELINE_MS,
	percentile,
	queueLogFile,
	readQueueRows,
} = require("./lib/queue-log.js");
const { scriptPath } = require("./lib/script-path.js");
const { repoRoot } = require("./lib/test-pass-marker.js");
const {
	TARGET_MULTIPLE,
	greenSuiteSpans,
	memberStays,
	parseLanderLog,
	readLogSince,
	replayBatches,
	secs,
} = require("./lib/time-to-land.js");
const { writeFd } = require("./lib/write-fd.js");

/** @typedef {import("./lib/time-to-land.js").ReplayedBatch} ReplayedBatch */

/**
 * One table row: the count, p50, p90, max and sum of `spans`, in ms.
 * @param {string} label
 * @param {number[]} spans
 */
const buildRow = (label, spans) =>
	`${label.padEnd(46)} n=${String(spans.length).padStart(4)}  p50=${secs(percentile(spans, 50)).padStart(5)}  p90=${secs(percentile(spans, 90)).padStart(6)}  max=${secs(percentile(spans, 100)).padStart(6)}  sum=${Math.round(spans.reduce((a, b) => a + b, 0) / 60_000)} min`;

/**
 * @param {readonly string[]} keys
 * @returns {string} each key's count, the commonest first
 */
function buildTally(keys) {
	/** @type {Map<string, number>} */
	const counts = new Map();
	for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
	return [...counts]
		.sort((a, b) => b[1] - a[1])
		.map(([k, n]) => `${k} ${n}`)
		.join(", ");
}

/**
 * @param {ReplayedBatch[]} batches those taken in the window
 * @returns {string[]}
 */
function buildBatchLines(batches) {
	const ended = batches.filter((b) => b.end !== null);
	const green = ended.filter((b) => b.outcome === "green");
	const red = ended.filter((b) => b.detach !== null);
	/** @param {ReplayedBatch} b */
	const span = (b) => (b.end ?? b.take) - b.take;
	/** @param {ReplayedBatch} b */
	const path = (b) => (b.end ?? b.take) - (b.detach ?? b.take);
	/** @type {Map<string, number[]>} */
	const steps = new Map();
	for (const b of red)
		for (const st of b.steps)
			if (st.end !== null)
				steps.set(st.kind, [...(steps.get(st.kind) ?? []), st.end - st.t]);
	/** @param {ReplayedBatch[]} of */
	const first = (of) =>
		of.flatMap((b) => (b.tests[0] ? [b.tests[0].t - b.take] : []));
	return [
		`batches taken ${batches.length}: green ${green.length}, red path ${red.length}, other ${ended.length - green.length - red.length}, not ended ${batches.length - ended.length}`,
		`  every outcome: ${buildTally(ended.map((b) => String(b.outcome)))}`,
		`  red batches by size: ${buildTally(red.map((b) => `${b.members.length}-member`))}`,
		"",
		"whole batch",
		buildRow("green: take -> fast-forward", green.map(span)),
		buildRow("green: take -> first test-sha (merge, gates)", first(green)),
		buildRow(
			"green: last test-sha -> fast-forward",
			green.flatMap((b) => {
				const last = b.tests.at(-1);
				return last && b.end !== null ? [b.end - last.t] : [];
			}),
		),
		buildRow("red: take -> end", red.map(span)),
		buildRow("red: take -> first test-sha (merge, gates)", first(red)),
		buildRow(
			"red: last test-sha -> detach (the red run)",
			red.flatMap((b) => {
				const last = b.tests.at(-1);
				return last && b.detach !== null && b.detach >= last.t
					? [b.detach - last.t]
					: [];
			}),
		),
		buildRow("red: detach -> end (the red path)", red.map(path)),
		"",
		"red path, each step to the search's next line",
		...[...steps].map(([kind, spans]) => buildRow(kind, spans)),
		"",
		"red path by batch size",
		...[1, 2, 3].flatMap((n) => {
			const of = red.filter((b) =>
				n === 3 ? b.members.length >= 3 : b.members.length === n,
			);
			return [
				buildRow(`${n === 3 ? "3+" : n}-member: detach -> end`, of.map(path)),
				`  outcomes: ${buildTally(of.map((b) => String(b.outcome))) || "none"}; drops ${of.reduce((a, b) => a + b.drops.length, 0)}`,
			];
		}),
	];
}

/**
 * @param {import("./lib/time-to-land.js").Stay[]} stays those ended in the
 *   window
 * @param {number[]} greens green run times in the window, ms
 * @returns {string[]}
 */
function buildMemberLines(stays, greens) {
	/** @param {typeof stays} of */
	const spans = (of) => of.map((x) => x.at - x.take);
	const landed = stays.filter((x) => x.event === "land");
	const p50 = percentile(greens, 50);
	return [
		`queue refs landed or dropped ${stays.length}, dropped ${stays.length - landed.length}`,
		buildRow("first take -> land or drop", spans(stays)),
		buildRow("first take -> land", spans(landed)),
		buildRow(
			"first take -> land, taken once",
			spans(landed.filter((x) => x.takes === 1)),
		),
		buildRow(
			"first take -> land, taken again",
			spans(landed.filter((x) => x.takes > 1)),
		),
		buildRow(
			"first take -> drop",
			spans(stays.filter((x) => x.event === "drop")),
		),
		"",
		buildRow("green suite: test-sha -> fast-forward", greens),
		`target: p90 first take -> land or drop at or under ${TARGET_MULTIPLE} x the green suite's p50 = ${p50 === null ? "no reading" : `${secs(TARGET_MULTIPLE * p50)} s`}`,
	];
}

/** @param {string[]} [argv] @returns {number} */
function main(argv = process.argv.slice(2)) {
	const usage = `usage: node ${scriptPath("time-to-land.js")} [--since <ISO time>] [--until <ISO time>]`;
	const parsed = parseOrCode(argv, {
		usage,
		flags: { "--since": "value", "--until": "value" },
	});
	if (typeof parsed === "number") return parsed;
	const until = Date.parse(
		String(parsed.flags["--until"] ?? new Date(now()).toISOString()),
	);
	const since = Date.parse(
		String(
			parsed.flags["--since"] ?? new Date(until - BASELINE_MS).toISOString(),
		),
	);
	if (!Number.isFinite(since) || !Number.isFinite(until)) {
		writeFd(2, `--since and --until take an ISO time\n${usage}\n`);
		return 2;
	}
	const root = repoRoot() ?? process.cwd();
	/** @param {number} t */
	const inWindow = (t) => t >= since && t < until;
	/* A day of lead, so a batch taken before the window that ends in it is
	 * replayed from its take. */
	const events = parseLanderLog(
		readLogSince(landerLog(root), since - 24 * 60 * 60 * 1000),
	).filter((e) => e.t < until);
	const lines = [
		`window ${new Date(since).toISOString()} to ${new Date(until).toISOString()}`,
		"",
		...buildBatchLines(replayBatches(events).filter((b) => inWindow(b.take))),
		"",
		...buildMemberLines(
			memberStays(readQueueRows(queueLogFile(root))).filter((x) =>
				inWindow(x.at),
			),
			greenSuiteSpans(events)
				.filter((g) => inWindow(g.at))
				.map((g) => g.at - g.from),
		),
	];
	writeFd(1, `${lines.join("\n")}\n`);
	return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { main };
