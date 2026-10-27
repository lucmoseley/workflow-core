#!/usr/bin/env node
/*
 * report-flip-line-reading.js — the one-shot reading of workflow-core#2228's flip line:
 * whether the close-rivals limb's low-top test, refusing a round whose top
 * option is `LOW_TOP` or less, should move down a step (workflow-core#2331, spec workflow-core#2260,
 * as workflow-core#2519 leaves it).
 *
 * FILES ONE ISSUE, ONCE. A plain run at the reading point files the reading
 * as TITLE, `takes:wayfinder`; before it, and on `--dry-run`, it prints the
 * figures so far and files nothing. Once its issue exists, open or closed, it
 * never files again (lib/log-reading.js's `buildFiler`).
 *
 * RUNS DETACHED AT EVERY SESSION START, from scripts/sweep-debts-detached.sh,
 * WORKFLOW-CORE ONLY, over every adopter's close-check log.
 *
 * THE READING POINT, lib/log-reading.js's point rule with FIGURES. A repo is
 * live from its first low-top refusal (`trigger` `low-top` or `both`). The
 * clock starts when the QUORUMth repo is; the point is 7 days after that or
 * the 60th low-top re-send, whichever is later, and at most 21 days after the
 * first repo went live. The 60 is untraced (workflow-core#2260 §Values). The spec's "all
 * three repos" is QUORUM, three of however many adopters this laptop holds.
 *
 * A LOW-TOP RE-SEND is a `passed-after-refusal` the passing send carried,
 * whose question's last `refused` line before it was low-top alone: one both
 * tests caught is a close refusal too, which workflow-core#2227 F7's 30% already reads.
 * Line 1 counts low-top-alone refusals likewise, as workflow-core#2229's forecast counts
 * rounds no other limb catches.
 *
 * THE TWO READINGS, from workflow-core#2228's flip line as workflow-core#2519 leaves it:
 *   1. low-top refusals a day, against workflow-core#2229's forecast at 65 or less; it
 *      moves nothing;
 *   2. the share of low-top re-sends whose top option changed, against workflow-core#2227
 *      F7's 30% after a close refusal; under it, move the line down to
 *      `LOW_TOP` - 5.
 *
 * Exit 0 whether or not it files, SKIP included; exit 2 for a log that will
 * not read, `gh` refusing, an unreadable WFC_NOW, or a command line
 * lib/cli-args.js refuses. Exit 2 fails no build, as no build runs it: the
 * launcher discards the code, and a hand run needs to see a log it could not
 * read.
 */

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

const USAGE =
	"usage: node scripts/report-flip-line-reading.js [--dry-run]\n  --dry-run  print the reading, and file nothing even at the reading point";

const DAY_MS = 86_400_000;
const QUORUM = 3;
/** @type {import("./lib/log-reading").PointFigures} */
const FIGURES = {
	clockDays: 7,
	countTarget: 60,
	ceilingDays: 21,
	quorum: QUORUM,
};

/* workflow-core#2229's forecast at 65 or less (its X = 70 row), and workflow-core#2227 F7's flip share
 * after a close refusal. */
const FORECAST_PER_DAY = 15.5;
const FLIP_LINE = 0.3;
const FLIP_PCT = Math.round(FLIP_LINE * 100);
/* The line workflow-core#2228's flip line moves the test down to. */
const LOWER_LINE = LOW_TOP - 5;

const TITLE = `Flip-line reading: should the low-top line of ${LOW_TOP} move to ${LOWER_LINE}?`;

/**
 * @typedef {import("./lib/close-check-log").CloseCheckEvent & { at: string, repo: string }} LoggedEvent
 * @typedef {import("./lib/log-reading").Verdict} Verdict
 */

const { readFiledAs, publish } = buildFiler({
	title: TITLE,
	label: takesLabel("wayfinder"),
	/* Named outside every marker sweep family, as the close-check log is. */
	record: ".flip-line-reading-filed",
	script: "node scripts/report-flip-line-reading.js",
	buildIssueBody: (reading) =>
		[
			`The reading of the low-top test's flip line (workflow-core#2228), filed once by \`scripts/report-flip-line-reading.js\` at its reading point (workflow-core#2331, spec workflow-core#2260). Closing this issue never re-files it.`,
			"",
			reading,
			"",
			"## What the session that takes this does",
			"",
			"Put each move a fired line names back to the founder as a fresh question, saying so where the reading is THIN; nothing moves on its own (workflow-core#2260, Out of Scope).",
		].join("\n"),
});

/** @param {{ trigger?: import("./lib/close-check-log").Trigger }} e */
const isLowTop = (e) => e.trigger === "low-top" || e.trigger === "both";

/** @param {{ trigger?: import("./lib/close-check-log").Trigger }} e */
const isLowTopAlone = (e) => e.trigger === "low-top";

/** @param {LoggedEvent} e */
const questionKey = (e) => `${e.repo} ${e.session} ${e.round}`;

/**
 * Each repo's first low-top refusal.
 * @param {LoggedEvent[]} refusals the low-top `refused` lines
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
 * The re-sends of questions last refused low-top alone, oldest first.
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
			/* Null where the passing send left the question out (close-check-log.js). */
			typeof e.stillClose === "boolean"
		) {
			const refused = lastRefused.get(questionKey(e));
			if (refused && isLowTopAlone(refused)) resends.push(e);
		}
	}
	return resends;
}

/**
 * @param {LoggedEvent[]} refusals every low-top refusal in the window
 * @param {number} days
 */
function buildRateLine(refusals, days) {
	const alone = refusals.filter(isLowTopAlone).length;
	const both = refusals.length - alone;
	const rate = days > 0 ? (alone / days).toFixed(1) : "—";
	return {
		verdict: verdict("holds", "moves nothing"),
		text: `1. Low-top refusals: ${alone} over ${days.toFixed(1)} days, ${rate} a day, and ${both} the close test caught too. Forecast ${FORECAST_PER_DAY} a day of rounds no other limb catches (workflow-core#2229), counting only rounds sent after 10 tool calls; this counts every send. It moves nothing.`,
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
			`FIRES — move the line down to ${LOWER_LINE} (workflow-core#2228's flip line)`,
		);
	return {
		verdict: line,
		text: `2. Top option changed: ${ratio(flips, known.length)} low-top re-sends${resends.length > known.length ? ` (${resends.length - known.length} more with no reading)` : ""}. Baseline ${FLIP_PCT}% after a close refusal (workflow-core#2227 F7). Under ${FLIP_PCT}%: ${line.text}.`,
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
		process.stderr.write(
			"SKIP: the flip-line reading is workflow-core's alone; it reads every adopter from there.\n",
		);
		return;
	}
	const filed = readFiledAs();
	if (filed && !dryRun) {
		console.log(`The flip-line reading is filed as ${filed}; nothing to file.`);
		return;
	}
	const nowMs = now();
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
		`Flip-line reading (workflow-core#2228, spec workflow-core#2260): the low-top line at ${LOW_TOP}`,
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
		console.log(out.join("\n"));
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
			`THIN: ${counted.length} low-top re-send(s), under the ${FIGURES.countTarget} a reading needs to tell a flip share near 20% from ${FLIP_PCT}% (workflow-core#2260's gate basis).`,
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
