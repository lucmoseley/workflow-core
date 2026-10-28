#!/usr/bin/env node
/*
 * report-close-check-reading.js — the week-one reading of the close-rivals
 * check: whether refusing every close rival question once (#1061), outside
 * the session ceiling (#1067), has stopped the founder typing his own
 * separation prompt (spec #1091).
 *
 * FILES ONE ISSUE, ONCE (#1104). A plain run at the reading point files the
 * reading as TITLE, `takes:wayfinder`; before it, and on `--dry-run`, it
 * prints the figures so far and files nothing. Once its issue exists, open or
 * closed, it never files again (lib/log-reading.js's `buildFiler`), and a
 * plain run returns on reading its record, before any log or transcript
 * (#3326): it then prints no ladder line and exits 0 on a log or baseline
 * that will not read, which only `--dry-run` still reports.
 *
 * RUNS DETACHED AT EVERY SESSION START, from scripts/sweep-debts-detached.sh,
 * because the log and the transcripts are machine-local and no CI runner can
 * read them. A plain run walks them at most daily, and never beside another
 * run's walk (#3220, buildFiler's `readDaily`).
 *
 * WORKFLOW-CORE ONLY. In an adopter it prints a SKIP and exits 0, as
 * scripts/report-retro-due.js does: one reading covers every adopter.
 *
 * CORPUS. The close-check log (`lib/close-check-log.js`) in the markers
 * directory of every adopter on this laptop (lib/refill-repos.js's
 * readAdopterCheckouts, refillLoop ignored: the guard is not module-gated, #2115);
 * and every seat's transcripts, for the founder's replies.
 *
 * THE READING POINT, lib/log-reading.js's POINT_FIGURES. A repo is live from
 * its first log line, and the clock starts when the first one is (#2115). The
 * point is the clock's days after that or the target's refused-then-answered
 * question, whichever is later, and at most the ceiling's days after the
 * clock, whatever the count. Under the target the reading is thin; a repo
 * with no log line at the ceiling is named unread.
 *
 * REFUSED-THEN-ANSWERED: a `passed-after-refusal` event followed in its
 * session's transcript by a founder message, which is its reply. That is the
 * denominator, not the close rounds that reach him as at baseline, because a
 * separated question is no longer close when it does (#1068's captured fact).
 * Counted per question, as the spec has it.
 *
 * THE STOCK PROMPT is matched by STOCK_PROMPT. Every other reply after a
 * counted question is listed for the session that takes the reading to
 * classify, so the stock-only rate is a floor on the prompt rate.
 *
 * THE RESEARCH LADDER (#2010; spec #1995 §The research ladder) is read in its
 * own window: LADDER_DAYS from its first refusal or the first re-send
 * logging its `rungs`, whichever is sooner. Its success line is the
 * founder's prompts after a still-caught re-send falling to LADDER_LINE or
 * less; it is printed with the reading, on `--dry-run` after the reading has
 * filed too, never filed, and fires nothing above.
 *
 * Exit 0 whether or not it files, SKIP included; exit 2 for a log or baseline
 * that will not read, `gh` refusing, an unreadable WFC_NOW, or a command line
 * lib/cli-args.js refuses. A transcript that will not read leaves its
 * questions unanswered, and the run says how many.
 */

const fs = require("node:fs");
const path = require("node:path");
const { configDirs } = require("./lib/arbiter-store");
const { isRefusal } = require("./lib/close-rivals");
const { RUNGS } = require("./lib/research-ladder");
const { parseOrExit } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root");
const { CLOSE_CHECK_LOG } = require("./lib/priced-options-limbs");
const { logPath } = require("./lib/refusal-log");
const { errMessage } = require("./lib/check");
const {
	readAdopterRoots,
	broken,
	buildFiler,
	buildFiredLine,
	isOverLine,
	minute,
	now,
	pairReplies,
	ratio,
	POINT_FIGURES,
	bandHalfWidth,
	buildPointLines,
	readingAt,
	isRead,
	readingPoint,
	readLogs,
	buildRepoLines,
	verdict,
} = require("./lib/log-reading");
const { isCoreHost } = require("./lib/plugin-state");
const { CLOSE_RIVALS_PREFIX, limbOf } = require("./lib/priced-options-limbs");
const { readSeatTranscripts } = require("./lib/project-dirs");
const { takesLabel } = require("./lib/takes-label");

const USAGE =
	"usage: node scripts/report-close-check-reading.js [--dry-run] [--config-dir <dir>]...\n  --dry-run  print the reading, and file nothing even at the reading point";

const TITLE =
	"Close-check reading: has refusing close questions once stopped the separation prompts?";

/* #1068 Q4's four failure lines. */
const UNTOOLED_LINE = 0.3;
const PROMPT_LINE = 0.16;
const CAP_SPENT_LINE = 0.1;
const HARMFUL_FOURTH_LINE = 2;

/* The close limb's own per-session cap of blocks (#1067). */
const CAP_SLOTS = limbOf(CLOSE_RIVALS_PREFIX).cap;

/* The stock prompt is a family of wordings ("are there any checks or research
 * you can do", "are there really no checks or research"), not #1091's one
 * sentence (#1096). Words may be split by any punctuation. A "no" just ahead
 * of the family, outside "really no", turns checks down ("No more checks or
 * research — go with A"). Lexical, so a decline worded otherwise ("I do not
 * want any more checks or research") still matches and a request opening "are
 * there no more…" does not. */
const STOCK_PROMPT =
	/(?<!(?<!\b(?:really|truly)\W+)\bno\W+)\b(?:further|more|any|(?:really|truly)\W+no)\W+(?:checks?\W+(?:and|or)\W+research|research\W+(?:and|or)\W+checks?)\b/i;

const BASELINE = "docs/data/close-rounds-2026-10-09/answered-close-rounds.json";

/* #1905's two weeks and its 10% line, against #1894's rate. Both were taken
 * on close re-sends alone, but the success line counts every still-caught
 * re-send, low-top ones included (#2328), so it leaves unmeasured whether a
 * low-top re-send draws the prompt at the close rate: a pooled share under the
 * line can hide a low-top share over it, and the reverse. A window that
 * straddles #2328 also mixes lines that log a low-top-only re-send as not
 * still caught (`close-check-log.js`). */
const LADDER_DAYS = 14;
const LADDER_LINE = 0.1;
const LADDER_BASELINE =
	"about 19% of still-close re-sends (7 of the 8 traced prompts followed one, #1894), close re-sends alone, so low-top re-sends have none";

/* Floating-point slack on a line's share times a count, which can land just
 * either side of a whole number and move the line by a whole reply. */
const FLOAT_SLACK = 1e-9;

/** @type {Record<import("./lib/research-ladder").Rung, string>} */
const RUNG_LABEL = {
	rulings: "past rulings",
	web: "web",
	subagent: "subagent",
};

/**
 * @typedef {import("./lib/close-check-log").CloseCheckEvent & { at: string, repo: string }} LoggedEvent
 * @typedef {import("./lib/log-reading").Reply} Reply
 * @typedef {{ event: LoggedEvent, reply: Reply }} Answered
 * @typedef {import("./lib/log-reading").Verdict} Verdict
 * @typedef {{ prompts: number, rounds: number }} Baseline
 */

/**
 * The baseline prompt rate: rounds the founder answered, and those his next
 * message was a separation prompt after (#1096).
 *
 * @returns {Baseline}
 * @throws where the dataset will not read
 */
function readBaseline() {
	const data = JSON.parse(
		fs.readFileSync(path.join(hostRoot(), BASELINE), "utf8"),
	);
	const rows = /** @type {{ separation_prompt?: unknown }[]} */ (data.rows);
	return {
		rounds: rows.length,
		prompts: rows.filter((r) => r.separation_prompt != null).length,
	};
}

/**
 * @param {Answered} a
 * @param {string} kind
 */
const listed = (a, kind) => {
	/* A question left out of the passing send logs no pair of its own. */
	const pair = a.event.pair ?? a.event.refusedPair;
	const priced = pair
		? `, ${[pair.top, pair.runnerUp].map((b) => `(${b.letter}) ${b.figure}% (${b.low}% - ${b.high}%)`).join(" against ")}`
		: "";
	return `  - ${a.event.repo} ${a.event.session} Q${a.event.round} (${kind}${priced}), reply ${a.reply.at}: ${JSON.stringify(a.reply.text)}`;
};

const { readFiledAs, publish, readDaily } = buildFiler({
	title: TITLE,
	label: takesLabel("wayfinder"),
	/* Named outside every marker sweep family, as the close-check log is. */
	record: ".close-check-reading-filed",
	script: "node scripts/report-close-check-reading.js",
	buildIssueBody: (reading) =>
		[
			"The week-one reading of the close-rivals check, filed once by `scripts/report-close-check-reading.js` at its reading point (spec #1091; rulings #1061, #1067 and #1068). Closing this issue never re-files it.",
			"",
			reading,
			"",
			"## What the session that takes this does",
			"",
			"1. Where line 2 or 4 is undecided, classify each listed reply against the definition above, and settle the line.",
			"2. Put each ruling a fired line names back to the founder as a fresh question, saying so where the reading is THIN; nothing flips on its own (spec #1091, Out of Scope).",
		].join("\n"),
});

/** @param {Answered} a */
const afterRefusal = (a) => a.event.kind === "passed-after-refusal";

/** @param {Answered} a */
const isStock = (a) => STOCK_PROMPT.test(a.reply.text);

/**
 * Reads each live repo's close-check log, then the baseline.
 * @param {Map<string, string>} roots repo name → working directory
 * @returns {{ events: LoggedEvent[], live: Map<string, number>,
 *   base: Baseline } | string} the logs, or the
 *   message the read failed with
 */
function readCloseLogs(roots) {
	try {
		const { events, live } = readLogs(roots, (root) =>
			logPath(root, CLOSE_CHECK_LOG),
		);
		return {
			events: /** @type {LoggedEvent[]} */ (events),
			live,
			base: readBaseline(),
		};
	} catch (e) {
		return errMessage(e);
	}
}

/**
 * @param {import("./lib/log-reading").Point} point
 * @returns {string}
 */
const buildPointSentence = (point) =>
	point.fixed
		? `Reading point: ${minute(point.point)} — the later of ${POINT_FIGURES.clockDays} days after ${minute(point.clock)} and the ${POINT_FIGURES.countTarget}th answered question, capped at ${minute(point.ceiling)}.`
		: `Reading point: ${minute(point.ceiling)} at the latest (${POINT_FIGURES.ceilingDays} days after the first repo went live); earlier once ${POINT_FIGURES.countTarget} refused questions are answered.`;

/**
 * The repos with no log line by the ceiling, once it has passed.
 * @param {import("./lib/log-reading").Point} point
 * @param {{ nowMs: number, live: Map<string, number>, repos: string[] }} at
 * @returns {string[]}
 */
function buildUnreadLines(point, { nowMs, live, repos }) {
	if (nowMs < point.ceiling) return [];
	const unread = repos.filter((r) => !(Number(live.get(r)) <= point.ceiling));
	return unread.length > 0
		? [
				`Unread: ${unread.join(", ")} had no close-check log line by the ${POINT_FIGURES.ceilingDays}-day ceiling.`,
			]
		: [];
}

/**
 * The counts the four failure lines read, over the counted window.
 * @param {LoggedEvent[]} counted
 * @param {Answered[]} replied
 */
function tally(counted, replied) {
	/* A refused question the passing send left out logs `stillClose` null: it
	 * counts as answered (line 2) but was never re-sent (line 1). */
	const resends = counted.filter(
		(e) =>
			e.kind === "passed-after-refusal" && typeof e.stillClose === "boolean",
	);
	const toolKnown = resends.filter((e) => typeof e.toolCalls === "number");
	const untooled = toolKnown.filter((e) => e.toolCalls === 0).length;
	const parReplies = replied.filter(afterRefusal);
	const atCapReplies = replied.filter((a) => !afterRefusal(a));
	const stock = parReplies.filter(isStock).length;
	const others = parReplies.filter((a) => !isStock(a));
	const refusals = counted.filter((e) => isRefusal(e.kind));
	const refusedSessions = new Set(refusals.map((e) => e.session));
	const capSpent = new Set(
		refusals.filter((e) => e.slot === CAP_SLOTS).map((e) => e.session),
	).size;
	const harmful = atCapReplies.filter(isStock).length;
	const atCapOthers = atCapReplies.filter((a) => !isStock(a));
	return {
		counted,
		resends,
		toolKnown,
		untooled,
		atCapReplies,
		stock,
		others,
		refusedSessions,
		capSpent,
		harmful,
		atCapOthers,
		n: parReplies.length,
	};
}

/** @typedef {ReturnType<typeof tally>} Tally */

/**
 * The warnings that the reading is thin or partly unread.
 * @param {number} n refused-then-answered questions
 * @param {Baseline} base
 * @param {number} unreadSessions
 * @returns {string[]}
 */
function buildCaveatLines(n, base, unreadSessions) {
	const lines = [];
	const targetBand = Math.round(
		100 * bandHalfWidth(base.prompts / base.rounds, POINT_FIGURES.countTarget),
	);
	if (n < POINT_FIGURES.countTarget)
		lines.push(
			`THIN: ${n} refused-then-answered question(s), under the ${POINT_FIGURES.countTarget} a reading needs for a band of about ±${targetBand} points about the baseline.`,
			"",
		);
	if (unreadSessions)
		lines.push(
			`${unreadSessions} session(s)' transcript is not on this machine or will not read; their questions count as unanswered.`,
			"",
		);
	return lines;
}

/**
 * @param {Tally} t
 * @returns {{ verdict: Verdict, text: string }}
 */
function buildUntooledLine({ untooled, toolKnown, resends }) {
	const line1 = isOverLine(untooled, toolKnown.length, UNTOOLED_LINE)
		? verdict(
				"fires",
				"FIRES — re-put the refuse-once trigger (#1061): refuse only a bare `Unmeasured:` or an untooled `Checked:`",
			)
		: verdict("holds", "holds");
	return {
		verdict: line1,
		text: `1. Untooled re-sends: ${ratio(untooled, toolKnown.length)} re-sent questions had no tool call since the refusal${resends.length > toolKnown.length ? ` (${resends.length - toolKnown.length} more with no count)` : ""}. Baseline 0 of 9 under the earlier refusal text (#671), 14 of 22 under the texts before it. Line 30%: ${line1.text}.`,
	};
}

/**
 * @param {Tally} t
 * @param {Baseline} base
 * @returns {{ verdict: Verdict, text: string }}
 */
function buildPromptRateLine({ n, stock, others }, base) {
	const needed = Math.ceil(PROMPT_LINE * n - FLOAT_SLACK) - stock;
	/** @type {Verdict} */
	let line2;
	if (!n) line2 = verdict("holds", "nothing answered yet");
	else if (needed <= 0)
		line2 = verdict(
			"fires",
			"FIRES on the stock floor alone — re-put the mechanism question and its `/separate` question (#1061)",
		);
	else
		line2 = verdict(
			"undecided",
			`undecided — fires if ${needed} of the ${others.length} listed repl(ies) are prompts`,
		);
	return {
		verdict: line2,
		text: `2. Separation-prompt rate: stock floor ${ratio(stock, n)} refused-then-answered questions. Baseline ${ratio(base.prompts, base.rounds)} close rounds. Line 16%: ${line2.text}.`,
	};
}

/**
 * @param {Tally} t
 * @returns {{ verdict: Verdict, text: string }}
 */
function buildCapSpentLine({ capSpent, refusedSessions }) {
	const line3 = isOverLine(capSpent, refusedSessions.size, CAP_SPENT_LINE)
		? verdict("fires", "FIRES — re-put the ceiling ruling (#1067)")
		: verdict("holds", "holds");
	return {
		verdict: line3,
		text: `3. Cap spent: ${ratio(capSpent, refusedSessions.size)} sessions with a close refusal used cap slot ${CAP_SLOTS}. Baseline floor: 3 of 69 close sessions asked a 4th close question, so spent all ${CAP_SLOTS} (#1067). Line 10%: ${line3.text}.`,
	};
}

/**
 * @param {Tally} t
 * @returns {{ verdict: Verdict, text: string }}
 */
function buildHarmfulFourthLine({
	harmful,
	atCapOthers,
	atCapReplies,
	counted,
}) {
	/** @type {Verdict} */
	let line4;
	if (harmful >= HARMFUL_FOURTH_LINE)
		line4 = verdict(
			"fires",
			`FIRES on the stock floor alone — raise the cap of ${CAP_SLOTS} (#1067)`,
		);
	else if (harmful + atCapOthers.length >= HARMFUL_FOURTH_LINE)
		line4 = verdict(
			"undecided",
			`undecided — fires if ${HARMFUL_FOURTH_LINE - harmful} of the ${atCapOthers.length} listed repl(ies) are prompts`,
		);
	else line4 = verdict("holds", "holds");
	return {
		verdict: line4,
		text: `4. Harmful 4th questions: ${harmful} passed-at-cap question(s) drew a stock prompt, of ${atCapReplies.length} answered (${counted.filter((e) => e.kind === "passed-at-cap").length} passed at cap). No baseline. Line 2: ${line4.text}.`,
	};
}

/**
 * @param {Tally} t
 * @returns {string[]}
 */
function buildClassifyLines({ others, atCapOthers }) {
	if (others.length === 0 && atCapOthers.length === 0) return [];
	return [
		"",
		'To classify — each reply after a counted question that is not the stock prompt. A separation prompt is "a message that tells the agent to check, research or analyse more before the founder picks an option":',
		...others.map((a) => listed(a, "passed-after-refusal")),
		...atCapOthers.map((a) => listed(a, "passed-at-cap")),
	];
}

/**
 * @param {LoggedEvent[]} events every logged event, unwindowed
 * @param {Answered[]} answers every refused-then-answered question, unwindowed
 * @param {number} nowMs
 * @returns {string[]}
 */
function buildLadderReadingLines(events, answers, nowMs) {
	const starts = events
		.filter((e) => e.kind === "refused-ladder" || "rungs" in e)
		.map((e) => Date.parse(e.at));
	if (starts.length === 0)
		return ["", "Research ladder (#2010): nothing logged on it yet."];
	const start = Math.min(...starts);
	const end = Math.min(start + LADDER_DAYS * 86_400_000, nowMs);
	const inLadder = (/** @type {string} */ stamp) => {
		const t = Date.parse(stamp);
		return t >= start && t <= end;
	};
	const logged = events.filter((e) => inLadder(e.at));
	const resends = logged.filter((e) => typeof e.stillClose === "boolean");
	const stillCaught = resends.filter((e) => e.stillClose === true);
	const rungsKnown = stillCaught.filter((e) => e.rungs);
	const tried = (/** @type {import("./lib/research-ladder").Rung} */ rung) =>
		rungsKnown.filter((e) => Number(e.rungs?.[rung]) > 0).length;
	const climbed = rungsKnown.filter((e) =>
		RUNGS.every((rung) => Number(e.rungs?.[rung]) > 0),
	).length;
	const ladderRefusals = events.filter(
		(e) => inLadder(e.at) && e.kind === "refused-ladder",
	);
	const refusedQuestions = new Set(
		ladderRefusals.map((e) => `${e.repo} ${e.session} ${e.round}`),
	).size;
	const flipKnown = resends.filter((e) => typeof e.flipped === "boolean");
	const flips = flipKnown.filter((e) => e.flipped);
	const citeKnown = resends.filter((e) => typeof e.citesNewFact === "boolean");
	const replied = answers.filter(
		(a) =>
			a.event.kind === "passed-after-refusal" &&
			a.event.stillClose === true &&
			inLadder(a.event.at),
	);
	const stock = replied.filter(isStock).length;
	const others = replied.filter((a) => !isStock(a));
	/* "10% or less": missed only above the line, so the first count past it. */
	const needed =
		Math.floor(LADDER_LINE * replied.length + FLOAT_SLACK) + 1 - stock;
	/** @type {Verdict} */
	let success;
	if (replied.length === 0) success = verdict("holds", "nothing answered yet");
	else if (needed <= 0)
		success = verdict(
			"fires",
			"MISSED on the stock floor alone — the next step is a K=3 independent vote (#1894's mechanism 3)",
		);
	else
		success = verdict(
			"undecided",
			`undecided — missed if ${needed} of the ${others.length} listed repl(ies) are prompts`,
		);
	const reached = end < nowMs;
	return [
		"",
		`Research ladder (#2006, #2010), read from ${minute(start)} for ${LADDER_DAYS} days: ${reached ? `ended ${minute(end)}` : `figures so far at ${minute(nowMs)}`}.`,
		`- Refused on the ladder: ${ladderRefusals.length} refusal(s) of ${refusedQuestions} question(s); ${stillCaught.filter((e) => e.missing?.length).length} still-caught re-send(s) let through at its cap with rungs missing.`,
		`- Still-caught re-sends passed: ${stillCaught.length}, of ${resends.length} re-sends. Rungs tried, of ${rungsKnown.length} with a readable transcript: ${RUNGS.map((rung) => `${RUNG_LABEL[rung]} ${tried(rung)}`).join(", ")}; all three ${climbed}.`,
		`- Flipped top option: ${ratio(flips.length, flipKnown.length)} re-sends; ${flips.filter((e) => e.citesNewFact === true).length} of those flips cite a new fact. A new citation in the option lines: ${ratio(citeKnown.filter((e) => e.citesNewFact).length, citeKnown.length)}.`,
		`- Success line: stock floor ${ratio(stock, replied.length)} answered still-caught re-sends drew a research prompt. Baseline ${LADDER_BASELINE}. Line ${Math.round(LADDER_LINE * 100)}% or less: ${success.text}.`,
		...(success.state === "undecided"
			? [
					"",
					"To classify for the success line — each reply after a still-caught re-send that is not the stock prompt:",
					...others.map((a) => listed(a, "still-caught re-send")),
				]
			: []),
	];
}

function main() {
	const { flags, lists } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: { "--dry-run": "boolean", "--config-dir": "list" },
	});
	const dryRun = "--dry-run" in flags;
	if (!isCoreHost(hostRoot())) {
		process.stderr.write(
			"SKIP: the close-check reading is workflow-core's alone; it reads every adopter from there.\n",
		);
		return;
	}
	const filed = readFiledAs();
	if (filed && !dryRun) {
		console.log(
			`The close-check reading is filed as ${filed}; nothing to file.`,
		);
		return;
	}
	const nowMs = now();
	const run = {
		nowMs,
		dryRun,
		filed,
		seats: lists["--config-dir"] ?? configDirs(),
	};
	readDaily(run, () => readAndPublish(run));
}

/**
 * Walk the corpus and publish the reading.
 *
 * @param {{ nowMs: number, dryRun: boolean, filed: string | null,
 *   seats: string[] }} run
 */
function readAndPublish({ nowMs, dryRun, filed, seats }) {
	const { files } = readSeatTranscripts(seats);
	/** @type {Map<string, string>} session id → transcript */
	const transcripts = new Map(
		files.map((f) => [path.basename(f, ".jsonl"), f]),
	);
	const roots = readAdopterRoots();
	const repos = [...roots.keys()];

	const logs = readCloseLogs(roots);
	if (typeof logs === "string") return broken(logs);
	const { events, live, base } = logs;

	const { answered: lastTurnAnswers, unreadSessions } = pairReplies(
		events,
		transcripts,
		(kind) => kind === "passed-after-refusal" || kind === "passed-at-cap",
	);

	const point = readingPoint(
		live,
		lastTurnAnswers
			.filter(afterRefusal)
			.map((a) => Date.parse(a.reply.at))
			.sort((a, b) => a - b),
	);
	const at = readingAt(point, nowMs);
	const counted = events.filter((e) => isRead(at, e.at));
	const replied = lastTurnAnswers.filter((a) => isRead(at, a.reply.at));

	const out = [
		"Close-check reading (#1068, spec #1091)",
		"",
		...buildRepoLines(repos, live, roots, "close-check"),
	];
	if (!point) {
		out.push("", "Reading point: none yet — no repo is live.");
		console.log(out.join("\n"));
		return;
	}
	out.push(
		...buildPointLines(buildPointSentence(point), at),
		...buildUnreadLines(point, { nowMs, live, repos }),
	);

	const t = tally(counted, replied);
	out.push("", ...buildCaveatLines(t.n, base, unreadSessions));
	const lines = [
		buildUntooledLine(t),
		buildPromptRateLine(t, base),
		buildCapSpentLine(t),
		buildHarmfulFourthLine(t),
	];
	out.push(...lines.map((l) => l.text));
	out.push("", buildFiredLine(lines.map((l) => l.verdict)));
	out.push(...buildClassifyLines(t));
	out.push(...buildLadderReadingLines(events, lastTurnAnswers, nowMs));
	publish(out.join("\n"), { reached: at.reached, dryRun, filed });
}

if (require.main === module) main();
