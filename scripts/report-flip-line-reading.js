#!/usr/bin/env node

const { writeFd } = require("./lib/write-fd.js");
const { scriptPath } = require("./lib/script-path.js");
const { LOW_TOP } = require("./lib/close-rivals");
const { parseOrExit } = require("./lib/cli-args");
const { errMessage } = require("./lib/check");
const { hostRoot } = require("./lib/host-root");
const {
	readAdopterRoots,
	broken,
	buildFiler,
	buildFiredLine,
	minute,
	now,
	ratio,
	buildPointLines,
	readingAt,
	isRead,
	readingPoint,
	readLogs,
	buildRepoLines,
	verdict,
} = require("./lib/log-reading");
const { isCoreHost } = require("./lib/plugin-state");
const { CLOSE_CHECK_LOG } = require("./lib/priced-options-limbs");
const { logPath } = require("./lib/refusal-log");
const { takesLabel } = require("./lib/takes-label");

const USAGE = `usage: node ${scriptPath("report-flip-line-reading.js")} [--dry-run]\n  --dry-run  print the reading, and file nothing even at the reading point`;

const DAY_MS = 86_400_000;
const QUORUM = 3;
/** @type {import("./lib/log-reading").PointFigures} */
const FIGURES = {
	clockDays: 7,
	countTarget: 60,
	ceilingDays: 21,
	quorum: QUORUM,
};

// #2229 guess: its forecast at a low-top line of 65 or less
const FORECAST_PER_DAY = 15.5;
// #2227 measured F7 flip share 30% after a close refusal
const FLIP_LINE = 0.3;
const FLIP_PCT = Math.round(FLIP_LINE * 100);
const LOWER_LINE = LOW_TOP - 5;

const TITLE = `Flip-line reading: should the low-top line of ${LOW_TOP} move to ${LOWER_LINE}?`;

/**
 * @typedef {import("./lib/close-check-log").CloseCheckEvent & { at: string, repo: string }} LoggedEvent
 * @typedef {import("./lib/log-reading").Verdict} Verdict
 */

const { readFiledAs, publish, readDaily } = buildFiler({
	title: TITLE,
	label: takesLabel("wayfinder"),
	record: ".flip-line-reading-filed",
	script: "report-flip-line-reading.js",
	buildIssueBody: (reading) =>
		[
			`The reading of the low-top test's flip line (#2228), filed once by \`scripts/report-flip-line-reading.js\` at its reading point (#2331, spec #2260). Closing this issue never re-files it.`,
			"",
			reading,
			"",
			"## What the session that takes this does",
			"",
			"Put each move a fired line names back to the founder as a fresh question, saying so where the reading is THIN; nothing moves on its own (#2260, Out of Scope).",
		].join("\n"),
});

/** @param {{ trigger?: import("./lib/close-check-log").Trigger }} e */
const isLowTop = (e) => e.trigger === "low-top" || e.trigger === "both";

/** @param {{ trigger?: import("./lib/close-check-log").Trigger }} e */
const isLowTopAlone = (e) => e.trigger === "low-top";

/** @param {LoggedEvent} e */
const questionKey = (e) => `${e.repo} ${e.session} ${e.round}`;

/**
 * @param {LoggedEvent[]} refusals
 * @returns {Map<string, number>}
 */
function lowTopLive(refusals) {
	/** @type {Map<string, number>} */
	const live = new Map();
	for (const e of refusals) {
		const t = Date.parse(e.at);
		if (!(Number(live.get(e.repo)) <= t)) live.set(e.repo, t);
	}
	return live;
}

/**
 * @param {LoggedEvent[]} events
 * @returns {LoggedEvent[]}
 */
function lowTopResends(events) {
	/** @type {Map<string, LoggedEvent>} */
	const lastRefused = new Map();
	/** @type {LoggedEvent[]} */
	const resends = [];
	const ordered = [...events].sort(
		(a, b) => Date.parse(a.at) - Date.parse(b.at),
	);
	for (const e of ordered) {
		if (e.kind === "refused") lastRefused.set(questionKey(e), e);
		else if (
			e.kind === "passed-after-refusal" &&
			typeof e.stillClose === "boolean"
		) {
			const refused = lastRefused.get(questionKey(e));
			if (refused && isLowTopAlone(refused)) resends.push(e);
		}
	}
	return resends;
}

/**
 * @param {LoggedEvent[]} refusals
 * @param {number} days
 */
function buildRateLine(refusals, days) {
	const alone = refusals.filter(isLowTopAlone).length;
	const both = refusals.length - alone;
	const rate = days > 0 ? (alone / days).toFixed(1) : "—";
	return {
		verdict: verdict("holds", "moves nothing"),
		text: `1. Low-top refusals: ${alone} over ${days.toFixed(1)} days, ${rate} a day, and ${both} the close test caught too. Forecast ${FORECAST_PER_DAY} a day of rounds no other limb catches (#2229), counting only rounds sent after 10 tool calls; this counts every send. It moves nothing.`,
	};
}

/** @param {LoggedEvent[]} resends */
function buildFlipLine(resends) {
	const known = resends.filter((e) => typeof e.flipped === "boolean");
	const flips = known.filter((e) => e.flipped).length;
	/** @type {Verdict} */
	let line = verdict("holds", "holds");
	if (known.length === 0) line = verdict("holds", "nothing re-sent yet");
	else if (flips / known.length < FLIP_LINE)
		line = verdict(
			"fires",
			`FIRES — move the line down to ${LOWER_LINE} (#2228's flip line)`,
		);
	return {
		verdict: line,
		text: `2. Top option changed: ${ratio(flips, known.length)} low-top re-sends${resends.length > known.length ? ` (${resends.length - known.length} more with no reading)` : ""}. Baseline ${FLIP_PCT}% after a close refusal (#2227 F7). Under ${FLIP_PCT}%: ${line.text}.`,
	};
}

/**
 * @param {import("./lib/log-reading").Point} point
 * @returns {string}
 */
const buildPointSentence = (point) =>
	point.fixed
		? `Reading point: ${minute(point.point)} — the later of ${FIGURES.clockDays} days after ${QUORUM} repos had logged a low-top refusal (${minute(point.clock)}) and the ${FIGURES.countTarget}th low-top re-send, capped at ${minute(point.ceiling)}.`
		: `Reading point: ${minute(point.ceiling)} at the latest (${FIGURES.ceilingDays} days after the first low-top refusal); earlier once ${QUORUM} repos have logged one and ${FIGURES.countTarget} low-top questions are re-sent.`;

function main() {
	const { flags } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: { "--dry-run": "boolean" },
	});
	const dryRun = "--dry-run" in flags;
	if (!isCoreHost(hostRoot())) {
		writeFd(
			2,
			"SKIP: the flip-line reading is workflow-core's alone; it reads every adopter from there.\n",
		);
		return;
	}
	const filed = readFiledAs();
	if (filed && !dryRun) {
		writeFd(
			1,
			`The flip-line reading is filed as ${filed}; nothing to file.\n`,
		);
		return;
	}
	const nowMs = now();
	const run = { nowMs, dryRun, filed };
	readDaily(run, () => readAndPublish(run));
}

/** @param {{ nowMs: number, dryRun: boolean, filed: string | null }} run */
function readAndPublish({ nowMs, dryRun, filed }) {
	const roots = readAdopterRoots();

	let events;
	try {
		events = /** @type {LoggedEvent[]} */ (
			readLogs(roots, (root) => logPath(root, CLOSE_CHECK_LOG)).events
		);
	} catch (e) {
		return broken(errMessage(e));
	}
	const refusals = events.filter((e) => e.kind === "refused" && isLowTop(e));
	const live = lowTopLive(refusals);
	const resends = lowTopResends(events);

	const out = [
		`Flip-line reading (#2228, spec #2260): the low-top line at ${LOW_TOP}`,
		"",
		...buildRepoLines([...roots.keys()], live, roots, "low-top refusal"),
	];
	const point = readingPoint(
		live,
		resends.map((e) => Date.parse(e.at)),
		FIGURES,
	);
	if (!point) {
		out.push(
			"",
			"Reading point: none yet — no repo has logged a low-top refusal.",
		);
		writeFd(1, `${out.join("\n")}\n`);
		return;
	}
	const at = readingAt(point, nowMs);
	const start = Math.min(...live.values());
	const days = (at.cutoff - start) / DAY_MS;
	out.push(...buildPointLines(buildPointSentence(point), at));

	const counted = resends.filter((e) => isRead(at, e.at));
	if (counted.length < FIGURES.countTarget)
		out.push(
			"",
			`THIN: ${counted.length} low-top re-send(s), under the ${FIGURES.countTarget} a reading needs to tell a flip share near 20% from ${FLIP_PCT}% (#2260's gate basis).`,
		);
	const lines = [
		buildRateLine(
			refusals.filter((e) => isRead(at, e.at)),
			days,
		),
		buildFlipLine(counted),
	];
	out.push("", ...lines.map((l) => l.text));
	out.push("", buildFiredLine(lines.map((l) => l.verdict)));
	publish(out.join("\n"), { reached: at.reached, dryRun, filed });
}

if (require.main === module) main();
