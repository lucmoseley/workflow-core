#!/usr/bin/env node
/*
 * report-round-check-reading.js — the reading of the under-researched-round
 * check: whether sending a not-close round back once, when fewer than
 * MIN_CALLS tool calls ran since the founder last spoke (#1684, built at
 * #1710), has cut how often he sends rounds back for research or challenges
 * their premise. Built at #1711 from spec #1701, on #1691's rulings.
 *
 * EACH REPO AGAINST ITS OWN BASELINE, NEVER POOLED BLIND (#1691's captured
 * fact), because the below-10 send-back rate runs from 14% (workflow-core)
 * to 54% (mantahostels). A rate is pooled only over the repos that clear the
 * bar, against their baselines weighted to the window's mix of their rounds.
 *
 * FILES ONE ISSUE, ONCE. A plain run at the reading point files the reading
 * as TITLE, `takes:wayfinder`; before it, and on `--dry-run`, it prints the
 * figures so far and files nothing. Once its issue exists, open or closed, it
 * never files again (lib/log-reading.js's `buildFiler`).
 *
 * RUNS DETACHED AT EVERY SESSION START, from scripts/sweep-debts-detached.sh:
 * the logs and transcripts are machine-local. WORKFLOW-CORE ONLY: in an
 * adopter it prints a SKIP and exits 0, as one reading covers every repo.
 *
 * CORPUS. The round-check log (lib/round-check.js) of every repo the baseline
 * has rows for, each root found from the first `cwd` a transcript of it
 * records; every seat's transcripts, for the founder's replies; and the
 * baseline, BASELINE.
 *
 * ROUNDS, NOT QUESTIONS, because the baseline counts a round and his reply to
 * it. A reply counts once, under its round's kind: refused-then-answered where
 * any question in it passed after a refusal and was re-sent; at the cap where
 * any passed at the cap; unrefused where they passed at MIN_CALLS or more. A
 * question the passing send left out (`resent: false`) or whose count the
 * transcript could not give (`callsBefore: null`) makes no round of its own.
 * A refused question the close-rivals limb then took counts as refused, in
 * every line: this check refused it first, so research the close-rivals limb's
 * refusal then asked for is part of what this one set off, and it clears
 * only under this check's own rule (#2244).
 *
 * CLASSING (#1691). A bare accept, ACCEPT, is (a). Every other reply that
 * feeds a figure is listed to class with #1682's six classes; `--classes
 * <file>` reads them back, so a re-run decides the lines that waited on them.
 * The rate is (b)+(c) over (a)+(b)+(c). A line an unclassed reply could still
 * tip reads undecided, with the range its rate lies in.
 *
 * A REPO IS KEPT OUT OF A POOL, and named, where the baseline has no rows for
 * its side of the MIN_CALLS line, or the window holds fewer than MIN_REPO_ROUNDS
 * answered rounds of that kind from it.
 *
 * THE READING POINT, lib/log-reading.js's POINT_FIGURES, with its clock
 * started at the first log line in any repo and its answered count taken over
 * refused-then-answered rounds.
 *
 * Exit 0 whether or not it files, SKIP included; exit 2 for a log, baseline
 * or classes file that will not read, `gh` refusing, an unreadable WFC_NOW,
 * or a command line lib/cli-args.js refuses. Exit 2 fails no build, as no
 * build runs it: the launcher discards the code, and a hand run needs to see
 * a corpus it could not read. A transcript that will not read
 * leaves its rounds unanswered, and the run says how many.
 */

const fs = require("node:fs");
const path = require("node:path");
const { configDirs } = require("./lib/arbiter-store");
const { parseOrExit } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root");
const { logPath } = require("./lib/refusal-log");
const { errMessage } = require("./lib/check");
const {
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
	readRepoRoots,
	verdict,
} = require("./lib/log-reading");
const { isCoreHost } = require("./lib/plugin-state");
const {
	limbOf,
	ROUND_CHECK_LOG,
	ROUND_CHECK_PREFIX,
} = require("./lib/priced-options-limbs");
const { readSeatTranscripts } = require("./lib/project-dirs");
const { firstDrafts, MIN_CALLS } = require("./lib/round-check");
const { takesLabel } = require("./lib/takes-label");

const USAGE =
	'usage: node scripts/report-round-check-reading.js [--dry-run] [--classes <file>] [--config-dir <dir>]...\n  --dry-run  print the reading, and file nothing even at the reading point\n  --classes  a JSON object of listed replies\' classes, {"<session>@<reply time>": "<a-f>"}';

const TITLE =
	"Round-check reading: has sending under-researched rounds back once cut the founder's send-backs?";

const BASELINE = "docs/data/round-sendbacks-2026-10-14/rounds.json";

/* Untraced (#1701's Values): a repo with fewer answered rounds of a kind in
 * the window stays out of that kind's pool. */
const MIN_REPO_ROUNDS = 10;

/* #1691 Q1 (A)'s four failure lines. */
const NOT_WORKING_SHARE = 0.5;
const PADDED_LINE = 0.25;
const PADDED_MAX_CALLS = 2;
const THRESHOLD_LINE = 0.2;
const THRESHOLD_LOW = MIN_CALLS;
const THRESHOLD_HIGH = MIN_CALLS + 2;
const CAP_LINE = 0.2;
/* The limb's own cap of refusals a session (#1684). */
const CAP_SLOTS = limbOf(ROUND_CHECK_PREFIX).cap;
const CAP_MIN_ROUNDS = 10;

/* #1691: over the baseline fortnight, refusing every round as well would have
 * cost FLIP_REFUSALS refusals to save r of the FLIP_SENDBACKS send-backs at
 * MIN_CALLS or more, so FLIP_COST ÷ r refusals per send-back saved. */
const FLIP_REFUSALS = 432;
const FLIP_SENDBACKS = 40;
const FLIP_COST = FLIP_REFUSALS / FLIP_SENDBACKS;

/* A reply that is only "accept recommendation(s)", hand-classed (a) (#1691). */
const ACCEPT =
	/^\s*accept\s+(?:all\s+)?(?:the\s+)?recommendations?\s*[.!]?\s*$/i;

const CLASSES = ["a", "b", "c", "d", "e", "f"];

/* Printed under a file that will not read. */
const REMEDY =
	"Correct the file named above — `git restore` it where it is tracked, fix the line where it is a log or a --classes file — then re-run `node scripts/report-round-check-reading.js --dry-run`.";
const SENT_BACK = new Set(["b", "c"]);

/**
 * @typedef {import("./lib/log-reading").Reply} Reply
 * @typedef {import("./lib/round-check").RoundCheckLine &
 *   { at: string, session: string, repo: string }} RoundEvent
 *   a round-check log line
 * @typedef {"refused" | "cap" | "unrefused"} RoundKind
 * @typedef {{ key: string, kind: RoundKind, repo: string,
 *   callsBefore: number | null, reply: Reply, cls: string | null }} Round
 *   one answered round; `cls` its class, null while unclassed
 * @typedef {{ sent: number, rated: number, unclassed: number }} Rate
 *   (b)+(c), (a)+(b)+(c), and the replies not yet classed
 * @typedef {{ sent: number, rated: number }} Base
 * @typedef {{ below: Base, atOrAbove: Base }} RepoBase
 * @typedef {{ byRepo: Map<string, RepoBase>, firstDrafts: number,
 *   atThreshold: number }} Baseline
 * @typedef {import("./lib/log-reading").Verdict} Verdict
 */

/**
 * Each repo's send-back counts on either side of the MIN_CALLS line, over
 * not-close rounds classed (a)–(c), and the share of all not-close rounds
 * first asked from MIN_CALLS to THRESHOLD_HIGH calls.
 *
 * @returns {Baseline}
 * @throws where the dataset will not read
 */
function readBaseline() {
	const file = path.join(hostRoot(), BASELINE);
	const data = JSON.parse(fs.readFileSync(file, "utf8"));
	if (!Array.isArray(data?.rows)) throw new Error(`${file} has no rows`);
	/** @type {{ repo: string, tools_before: number, close: boolean, class: string }[]} */
	const rows = data.rows.filter(
		(/** @type {{ close: boolean }} */ r) => r.close === false,
	);
	/** @type {Map<string, RepoBase>} */
	const byRepo = new Map();
	for (const r of rows) {
		if (!["a", "b", "c"].includes(r.class)) continue;
		const base = byRepo.get(r.repo) ?? {
			below: { sent: 0, rated: 0 },
			atOrAbove: { sent: 0, rated: 0 },
		};
		const side = r.tools_before < MIN_CALLS ? base.below : base.atOrAbove;
		side.rated++;
		if (SENT_BACK.has(r.class)) side.sent++;
		byRepo.set(r.repo, base);
	}
	return {
		byRepo,
		firstDrafts: rows.length,
		atThreshold: rows.filter(
			(r) =>
				r.tools_before >= THRESHOLD_LOW && r.tools_before <= THRESHOLD_HIGH,
		).length,
	};
}

/**
 * The classes `--classes` names, keyed as the listing keys a reply.
 *
 * @param {string | undefined} file
 * @returns {Map<string, string>}
 * @throws where the file will not read or holds a class outside (a)–(f)
 */
function readClasses(file) {
	if (!file) return new Map();
	const data = JSON.parse(fs.readFileSync(file, "utf8"));
	if (!data || typeof data !== "object" || Array.isArray(data))
		throw new Error(`${file} is not a JSON object`);
	const entries = Object.entries(data).map(
		([k, v]) => /** @type {[string, string]} */ ([k, String(v).toLowerCase()]),
	);
	const bad = entries.find(([, v]) => !CLASSES.includes(v));
	if (bad)
		throw new Error(
			`${file}: ${JSON.stringify(bad[0])} has class ${JSON.stringify(bad[1])}, not one of a-f`,
		);
	return new Map(entries);
}

/**
 * Each repo's round-check log lines, and when each repo went live.
 *
 * @param {Map<string, string>} roots
 * @returns {{ events: RoundEvent[], live: Map<string, number> }}
 * @throws as readLogs does
 */
function readRoundLogs(roots) {
	const { events, live } = readLogs(roots, (r) => logPath(r, ROUND_CHECK_LOG));
	return { events: /** @type {RoundEvent[]} */ (events), live };
}

/** @param {RoundEvent} e */
const isResend = (e) => e.kind === "passed-after-refusal" && e.resent !== false;

/**
 * The kind of round one Stop's answered questions make, or null where none
 * of them counts.
 * @param {RoundEvent[]} events
 * @returns {RoundKind | null}
 */
function roundKind(events) {
	const sent = events.filter((e) => e.resent !== false);
	if (sent.some(isResend)) return "refused";
	if (sent.some((e) => e.kind === "passed-at-cap")) return "cap";
	if (
		sent.some(
			(e) =>
				e.kind === "passed-unrefused" &&
				typeof e.callsBefore === "number" &&
				e.callsBefore >= MIN_CALLS,
		)
	)
		return "unrefused";
	return null;
}

/**
 * The answered questions grouped into rounds, one per reply.
 * @param {{ event: RoundEvent, reply: Reply }[]} answered
 * @param {Map<string, string>} classes
 * @returns {Round[]}
 */
function roundsOf(answered, classes) {
	/** @type {Map<string, { reply: Reply, repo: string, events: RoundEvent[] }>} */
	const byReply = new Map();
	for (const { event, reply } of answered) {
		const key = `${event.session}@${reply.at}`;
		const round = byReply.get(key) ?? { reply, repo: event.repo, events: [] };
		round.events.push(event);
		byReply.set(key, round);
	}
	return [...byReply].flatMap(([key, { reply, repo, events }]) => {
		const kind = roundKind(events);
		if (!kind) return [];
		const counted = events.find((e) => typeof e.callsBefore === "number");
		return [
			{
				key,
				kind,
				repo,
				callsBefore: counted?.callsBefore ?? null,
				reply,
				cls: classes.get(key) ?? (ACCEPT.test(reply.text) ? "a" : null),
			},
		];
	});
}

/**
 * @param {Round[]} rounds
 * @returns {Rate}
 */
function rateOf(rounds) {
	let sent = 0;
	let rated = 0;
	let unclassed = 0;
	for (const r of rounds) {
		if (r.cls === null) unclassed++;
		else if (SENT_BACK.has(r.cls)) {
			sent++;
			rated++;
		} else if (r.cls === "a") rated++;
	}
	return { sent, rated, unclassed };
}

/**
 * The least and most the rate can be once every unclassed reply is classed:
 * all of them (a), or all (b) or (c). Null with nothing to rate.
 * @param {Rate} rate
 * @returns {[number, number] | null}
 */
function rateRange({ sent, rated, unclassed }) {
	const most = rated + unclassed;
	if (most === 0) return null;
	return [sent / most, (sent + unclassed) / most];
}

/** @param {number} x */
const pct = (x) => `${(x * 100).toFixed(1)}%`;

/**
 * @param {Rate} rate
 * @returns {string}
 */
function buildRateText(rate) {
	const range = rateRange(rate);
	if (!range) return "nothing to rate";
	if (!rate.unclassed) return ratio(rate.sent, rate.rated);
	return `${rate.sent} of ${rate.rated} classed, ${rate.unclassed} to class: between ${pct(range[0])} and ${pct(range[1])}`;
}

/**
 * A rate's verdict against a line it fires at or over.
 * @param {Rate} rate
 * @param {number} line
 * @param {string} fired the words for a fired line
 * @returns {Verdict}
 */
function lineVerdict(rate, line, fired) {
	const range = rateRange(rate);
	if (!range) return verdict("holds", "nothing answered yet");
	if (range[0] >= line) return verdict("fires", `FIRES — ${fired}`);
	if (range[1] < line) return verdict("holds", "holds");
	return verdict(
		"undecided",
		`undecided until the ${rate.unclassed} listed repl${rate.unclassed === 1 ? "y is" : "ies are"} classified`,
	);
}

/**
 * One side of the MIN_CALLS line, matched by repo: the repos in its pool, each
 * against its own baseline, and every other repo read named with why it is
 * out.
 *
 * @param {Round[]} rounds this kind's answered rounds in the window
 * @param {{ base: Baseline, repos: string[] }} read
 * @param {"below" | "atOrAbove"} side
 */
function repoPool(rounds, { base, repos }, side) {
	const sideName =
		side === "below"
			? `below ${MIN_CALLS} calls`
			: `at ${MIN_CALLS} or more calls`;
	/** @type {Round[]} */
	const pooled = [];
	/** @type {string[]} */
	const kept = [];
	let weighted = 0;
	let weights = 0;
	const lines = [];
	for (const repo of repos) {
		const own = rounds.filter((r) => r.repo === repo);
		const b = base.byRepo.get(repo)?.[side];
		if (!b?.rated) {
			lines.push(
				`   - ${repo}: kept out — ${own.length} round(s), and no baseline rows ${sideName}`,
			);
			continue;
		}
		const baseText = `baseline ${ratio(b.sent, b.rated)}`;
		if (own.length < MIN_REPO_ROUNDS) {
			lines.push(
				`   - ${repo}: kept out — ${own.length} round(s), under the ${MIN_REPO_ROUNDS} a repo needs; ${baseText}`,
			);
			continue;
		}
		const rate = rateOf(own);
		lines.push(
			`   - ${repo}: ${own.length} round(s), ${buildRateText(rate)}; ${baseText}`,
		);
		pooled.push(...own);
		kept.push(repo);
		/* Weighted as the pooled rate is counted: by replies (a)–(c), an
		 * unclassed one counting until it is classed (d)–(f). */
		const weight = rate.rated + rate.unclassed;
		weighted += weight * (b.sent / b.rated);
		weights += weight;
	}
	return {
		pooled,
		baseRate: weights > 0 ? weighted / weights : null,
		lines,
		kept,
	};
}

const { readFiledAs, publish } = buildFiler({
	title: TITLE,
	label: takesLabel("wayfinder"),
	/* Named outside every marker sweep family, as the round-check log is. */
	record: ".round-check-reading-filed",
	script: "node scripts/report-round-check-reading.js",
	buildIssueBody: (reading) =>
		[
			"The reading of the under-researched-round check, filed once by `scripts/report-round-check-reading.js` at its reading point (spec #1701; rulings #1684 and #1691). Closing this issue never re-files it.",
			"",
			reading,
			"",
			"## What the session that takes this does",
			"",
			'1. Class each listed reply with the six send-back classes (#1682): (a) answered; (b) asked for more checks or research; (c) challenged or overturned a premise; (d) asked for a clarification only; (e) other (admin, `/compact`, "resume", information, a new topic); (f) rejected or rewrote a draft on taste, with no premise disputed. A reply that answers some blocks and sends one back is (b) or (c), and a critique naming a wrong fact or rule is (c), not (f). Write them to a JSON file under `.claude/tmp/` as `{"<session>@<reply time>": "<class>"}`, and run `node scripts/report-round-check-reading.js --dry-run --classes <file>` for the decided lines, r and the flip.',
			"2. Put each ruling a fired line names back to the founder as a fresh question, saying so where the reading is THIN; nothing flips on its own (#1691 Q1 (A)).",
			"3. Where the flip reads PUT, put the flip — send every not-close round back once, whatever its tool calls (#1684) — to the founder as a fresh question, with r and its price; no price bar is set in advance (#1691 Q2 (A)).",
		].join("\n"),
});

/**
 * @param {import("./lib/log-reading").Point} point
 * @returns {string}
 */
const buildPointSentence = (point) =>
	point.fixed
		? `Reading point: ${minute(point.point)} — the later of ${POINT_FIGURES.clockDays} days after the first log line (${minute(point.clock)}) and the ${POINT_FIGURES.countTarget}th refused-then-answered round, capped at ${minute(point.ceiling)}.`
		: `Reading point: ${minute(point.ceiling)} at the latest (${POINT_FIGURES.ceilingDays} days after the first log line); earlier once ${POINT_FIGURES.countTarget} refused rounds are answered.`;

/**
 * The warnings that the reading is thin or partly unread.
 * @param {number} n refused-then-answered rounds
 * @param {number} unreadHeads
 * @param {number} unreadSessions
 * @param {number} strayClasses
 * @returns {string[]}
 */
function buildCaveatLines(n, unreadHeads, unreadSessions, strayClasses) {
	const lines = [];
	if (n < POINT_FIGURES.countTarget)
		lines.push(
			`THIN: ${n} refused-then-answered round(s), under the ${POINT_FIGURES.countTarget} a reading needs to separate the half-baseline line from the baseline.`,
		);
	if (unreadHeads)
		lines.push(
			`${unreadHeads} transcript head(s) would not read while finding the repos' roots.`,
		);
	if (unreadSessions)
		lines.push(
			`${unreadSessions} session(s)' transcript is not on this machine or will not read; their rounds count as unanswered.`,
		);
	if (strayClasses)
		lines.push(
			`${strayClasses} class(es) in --classes match no answered round in the window.`,
		);
	return lines.length > 0 ? [...lines, ""] : [];
}

/**
 * Line 1, the refusal not working, and what r it implies.
 * @param {ReturnType<typeof repoPool>} below
 */
function buildNotWorkingLine(below) {
	const head = `1. Refusal not working: refused-then-answered rounds against each repo's baseline below ${MIN_CALLS} calls.`;
	if (below.baseRate === null)
		return {
			verdict: verdict(
				"undecided",
				"no repo has enough refused-then-answered rounds to pool",
			),
			rate: null,
			text: [head, ...below.lines, "   No pool: no repo clears the bar."],
		};
	const rate = rateOf(below.pooled);
	const line = below.baseRate * NOT_WORKING_SHARE;
	const judged = lineVerdict(
		rate,
		line,
		`re-put the mechanism (send a not-close round back once below ${MIN_CALLS} tool calls, #1684)`,
	);
	return {
		verdict: judged,
		rate,
		text: [
			head,
			...below.lines,
			`   Pooled over ${below.kept.join(", ")}: ${buildRateText(rate)}. Repo-matched baseline ${pct(below.baseRate)}; line at half, ${pct(line)}: ${judged.text}.`,
		],
	};
}

/**
 * Line 2, gaming at the re-send: passing re-sends after only 1–2 tool calls.
 * @param {RoundEvent[]} counted
 */
function buildPaddedLine(counted) {
	/* One send per Stop: questions refused together share their count. */
	const sends = new Map();
	for (const e of counted)
		if (isResend(e) && typeof e.sinceRefusal === "number")
			sends.set(`${e.session} ${e.at}`, e.sinceRefusal);
	const n = sends.size;
	const padded = [...sends.values()].filter(
		(c) => c >= 1 && c <= PADDED_MAX_CALLS,
	).length;
	const judged = isOverLine(padded, n, PADDED_LINE)
		? verdict(
				"fires",
				"FIRES — re-put how the refusal clears (any tool call since it, #1684)",
			)
		: verdict("holds", "holds");
	return {
		verdict: judged,
		text: `2. Gaming at the re-send: ${ratio(padded, n)} passing re-sends came after only 1–${PADDED_MAX_CALLS} tool calls since the refusal. Close-rivals limb 6 of 83 (7%, #1691). Line ${pct(PADDED_LINE)}: ${judged.text}.`,
	};
}

/**
 * Line 3, gaming at the threshold: first drafts piling up from MIN_CALLS to
 * THRESHOLD_HIGH calls.
 * @param {RoundEvent[]} counted
 * @param {Baseline} base
 */
function buildThresholdLine(counted, base) {
	const drafts = firstDrafts(counted);
	const n = drafts.size;
	const at = [...drafts.values()].filter(
		(c) => c >= THRESHOLD_LOW && c <= THRESHOLD_HIGH,
	).length;
	const judged = isOverLine(at, n, THRESHOLD_LINE)
		? verdict("fires", `FIRES — re-put the ${MIN_CALLS}-call threshold (#1684)`)
		: verdict("holds", "holds");
	return {
		verdict: judged,
		text: `3. Gaming at the threshold: ${ratio(at, n)} not-close first drafts sat at ${THRESHOLD_LOW}–${THRESHOLD_HIGH} tool calls. Baseline, over answered rounds, ${ratio(base.atThreshold, base.firstDrafts)}. Line ${pct(THRESHOLD_LINE)}: ${judged.text}.`,
	};
}

/**
 * Line 4, the cap: rounds let through at the cap sent back.
 * @param {Round[]} capRounds
 */
function buildCapLine(capRounds) {
	const rate = rateOf(capRounds);
	const head = `4. Cap: rounds let through at the cap of ${CAP_SLOTS} sent back: ${buildRateText(rate)}. Baseline 14 of 40 4th-and-later rounds (35%, #1691). Line ${pct(CAP_LINE)}`;
	if (capRounds.length < CAP_MIN_ROUNDS)
		return {
			verdict: verdict("holds", "unread"),
			text: `${head}: unread — ${capRounds.length} answered, under the ${CAP_MIN_ROUNDS} it is read from.`,
		};
	const judged = lineVerdict(
		rate,
		CAP_LINE,
		`re-put the cap of ${CAP_SLOTS} a session (#1684)`,
	);
	return { verdict: judged, text: `${head}: ${judged.text}.` };
}

/**
 * r, the share of send-backs the limb removes, and the price of refusing
 * every round, FLIP_COST ÷ r refusals per send-back saved; each a range while
 * replies are unclassified.
 * @param {Rate | null} rate the below-threshold pool's
 * @param {number | null} baseRate its repo-matched baseline
 * @returns {string}
 */
function buildRLine(rate, baseRate) {
	const range = rate && rateRange(rate);
	if (!range || !baseRate)
		return `r: unread — no pool below ${MIN_CALLS} calls with a baseline above 0.`;
	const rLow = 1 - range[1] / baseRate;
	const rHigh = 1 - range[0] / baseRate;
	const price = (/** @type {number} */ r) =>
		r > 0 ? (FLIP_COST / r).toFixed(1) : "no send-back saved";
	if (rLow === rHigh)
		return `r, the share of send-backs the limb removes: ${rLow.toFixed(2)}. Price of refusing every round: ${FLIP_COST} ÷ r = ${price(rLow)} refusals per send-back saved.`;
	return `r, the share of send-backs the limb removes: between ${rLow.toFixed(2)} and ${rHigh.toFixed(2)} until the listed replies are classified. Price of refusing every round, ${FLIP_COST} ÷ r refusals per send-back saved: from ${price(rHigh)} to ${price(rLow)}.`;
}

/**
 * r, its price, and whether #1684's flip is put to the founder: where the
 * limb works and the rate at MIN_CALLS or more stays within its band.
 * @param {ReturnType<typeof buildNotWorkingLine>} notWorking
 * @param {ReturnType<typeof repoPool>} below
 * @param {ReturnType<typeof repoPool>} atOrAbove
 * @returns {string[]}
 */
function buildFlipLines(notWorking, below, atOrAbove) {
	const lines = [
		`The flip (#1691 Q2 (A)): unrefused rounds at ${MIN_CALLS} or more calls against each repo's baseline there.`,
		...atOrAbove.lines,
		`   ${buildRLine(notWorking.rate, below.baseRate)}`,
	];
	const notPut = (/** @type {string} */ why) => {
		lines.push(`   Flip: not put — ${why}.`);
		return lines;
	};
	if (!below.baseRate)
		return notPut(`no pool below ${MIN_CALLS} calls shows the limb working`);
	if (notWorking.verdict.state === "fires")
		return notPut("the limb is not working (line 1)");
	if (atOrAbove.baseRate === null)
		return notPut(`no repo clears the bar at ${MIN_CALLS} or more calls`);
	const rate = rateOf(atOrAbove.pooled);
	const p = atOrAbove.baseRate;
	const head = `   Pooled over ${atOrAbove.kept.join(", ")}: ${buildRateText(rate)}. Repo-matched baseline ${pct(p)}`;
	if (rate.unclassed > 0) {
		lines.push(
			`${head}. Flip: undecided until the listed replies are classified, which sets the band.`,
		);
		return lines;
	}
	if (!rate.rated)
		return notPut(
			`no reply at ${MIN_CALLS} or more calls was answered or sent back`,
		);
	const half = bandHalfWidth(p, rate.rated);
	const [lo, hi] = [Math.max(0, p - half), Math.min(1, p + half)];
	const within = rate.sent / rate.rated >= lo && rate.sent / rate.rated <= hi;
	const band = `band ${pct(lo)}–${pct(hi)} at ${rate.rated} rounds`;
	/** @type {string} */
	let flip;
	if (notWorking.verdict.state === "undecided")
		flip = "undecided until line 1 is decided";
	else if (within)
		flip = `PUT — the limb works and the rate at ${MIN_CALLS} or more calls is within its band: put the flip (send every not-close round back once, #1684) to the founder as a fresh question, with r and its price`;
	else
		flip = `not put — the rate at ${MIN_CALLS} or more calls is outside its band`;
	lines.push(`${head}, ${band}. Flip: ${flip}.`);
	return lines;
}

/**
 * The unclassed replies that feed a figure: the two pools' and the cap's.
 * @param {Round[]} rounds
 * @param {number} leftOut unclassed replies in repos kept out of a pool
 * @returns {string[]}
 */
function buildClassifyLines(rounds, leftOut) {
	const open = rounds.filter((r) => r.cls === null);
	if (open.length === 0) return [];
	const name = {
		refused: "refused-then-answered",
		cap: "at the cap",
		unrefused: "unrefused",
	};
	return [
		"",
		`To class — each reply after a counted round that is not a bare accept, keyed for --classes${leftOut ? `; ${leftOut} more in repos kept out of a pool are not listed` : ""}:`,
		...open.map(
			(r) =>
				`  - ${r.key} ${r.repo} (${name[r.kind]}, ${r.callsBefore ?? "?"} calls before): ${JSON.stringify(r.reply.text)}`,
		),
	];
}

function main() {
	const { flags, lists } = parseOrExit(process.argv.slice(2), {
		usage: USAGE,
		flags: {
			"--dry-run": "boolean",
			"--classes": "value",
			"--config-dir": "list",
		},
	});
	const dryRun = "--dry-run" in flags;
	if (!isCoreHost(hostRoot())) {
		process.stderr.write(
			"SKIP: the round-check reading is workflow-core's alone; it reads every repo from there.\n",
		);
		return;
	}
	const filed = readFiledAs();
	if (filed && !dryRun) {
		console.log(`The round-check reading is filed as ${filed}; nothing to do.`);
		return;
	}
	const nowMs = now();

	/** @type {Baseline} */
	let base;
	/** @type {Map<string, string>} */
	let classes;
	try {
		base = readBaseline();
		const file = flags["--classes"];
		classes = readClasses(typeof file === "string" ? file : undefined);
	} catch (e) {
		return broken(`${errMessage(e)}\n${REMEDY}`);
	}
	const repos = [...base.byRepo.keys()].sort();

	const seats = lists["--config-dir"] ?? configDirs();
	const { files } = readSeatTranscripts(seats);
	/** @type {Map<string, string>} session id → transcript */
	const transcripts = new Map(
		files.map((f) => [path.basename(f, ".jsonl"), f]),
	);
	const { roots, unreadHeads } = readRepoRoots(files, repos);

	/** @type {{ events: RoundEvent[], live: Map<string, number> }} */
	let logs;
	try {
		logs = readRoundLogs(roots);
	} catch (e) {
		return broken(`${errMessage(e)}\n${REMEDY}`);
	}
	const { events, live } = logs;

	const { answered, unreadSessions } = pairReplies(
		events,
		transcripts,
		(kind) => kind.startsWith("passed-"),
	);
	const allRounds = roundsOf(answered, classes);

	const point = readingPoint(
		live,
		allRounds
			.filter((r) => r.kind === "refused")
			.map((r) => Date.parse(r.reply.at))
			.sort((a, b) => a - b),
	);
	const at = readingAt(point, nowMs);
	const counted = events.filter((e) => isRead(at, e.at));
	const rounds = allRounds.filter((r) => isRead(at, r.reply.at));

	const out = [
		"Round-check reading (#1691, spec #1701)",
		"",
		...buildRepoLines(repos, live, roots, "round-check"),
	];
	if (!point) {
		out.push("", "Reading point: none yet — no repo is live.");
		console.log(out.join("\n"));
		return;
	}
	out.push(...buildPointLines(buildPointSentence(point), at));

	const ofKind = (/** @type {RoundKind} */ k) =>
		rounds.filter((r) => r.kind === k);
	const below = repoPool(ofKind("refused"), { base, repos }, "below");
	const atOrAbove = repoPool(ofKind("unrefused"), { base, repos }, "atOrAbove");
	const capRounds = ofKind("cap");
	const listed = [...below.pooled, ...atOrAbove.pooled, ...capRounds];
	const stray = [...classes.keys()].filter(
		(k) => !rounds.some((r) => r.key === k),
	).length;

	out.push(
		"",
		...buildCaveatLines(
			ofKind("refused").length,
			unreadHeads,
			unreadSessions,
			stray,
		),
	);
	const notWorking = buildNotWorkingLine(below);
	const lines = [
		notWorking,
		buildPaddedLine(counted),
		buildThresholdLine(counted, base),
		buildCapLine(capRounds),
	];
	for (const l of lines)
		out.push(...(Array.isArray(l.text) ? l.text : [l.text]));
	out.push("", buildFiredLine(lines.map((l) => l.verdict)));
	out.push("", ...buildFlipLines(notWorking, below, atOrAbove));
	out.push(
		...buildClassifyLines(
			listed,
			rounds.filter((r) => r.cls === null && !listed.includes(r)).length,
		),
	);
	publish(out.join("\n"), { reached: at.reached, dryRun, filed });
}

if (require.main === module) main();
