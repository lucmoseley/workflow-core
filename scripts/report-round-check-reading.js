#!/usr/bin/env node

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const path = require("node:path");
const { writeFd } = require("./lib/write-fd.js");
const { configDirs } = require("./lib/arbiter-store");
const { parseOrExit } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root");
const { logPath } = require("./lib/refusal-log");
const { errMessage } = require("./lib/check");
const {
	broken,
	buildFiler,
	DAY_MS,
	buildFiredLine,
	founderReplies,
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

const USAGE = `usage: node ${scriptPath("report-round-check-reading.js")} [--dry-run] [--classes <file>] [--config-dir <dir>]...\n  --dry-run  print the reading, and file nothing even at the reading point\n  --classes  a JSON object of listed replies' classes, {"<session>@<reply time>": "<a-f>"}`;

const TITLE =
	"Round-check reading: has sending under-researched rounds back once cut the founder's send-backs?";

const BASELINE = "docs/data/round-sendbacks-2026-10-14/rounds.json";

const CLASSED = "docs/data/round-check-reading-2026-11-02/classes.json";

// #3978 guess: a power calculation's 131 rated rounds, to tell 6.9% from 13.7% at 80% power, rounded
const SECOND_TARGET = 130;

const SECOND_TITLE = `Round-check second reading, at ${SECOND_TARGET} rated rounds: keep the refusal of under-researched rounds, or drop it?`;

// #1701 guess
const MIN_REPO_ROUNDS = 10;

const NOT_WORKING_SHARE = 0.5;
const PADDED_LINE = 0.25;
const PADDED_MAX_CALLS = 2;
const THRESHOLD_LINE = 0.2;
const THRESHOLD_LOW = MIN_CALLS;
const THRESHOLD_HIGH = MIN_CALLS + 2;
const CAP_LINE = 0.2;
const CAP_SLOTS = limbOf(ROUND_CHECK_PREFIX).cap;
const CAP_MIN_ROUNDS = 10;

// #1691 measured 432 refusals and 40 send-backs over the baseline fortnight
const FLIP_REFUSALS = 432;
const FLIP_SENDBACKS = 40;
const FLIP_COST = FLIP_REFUSALS / FLIP_SENDBACKS;

const ACCEPT =
	/^\s*accept\s+(?:all\s+)?(?:the\s+)?recommendations?\s*(?:[.!]\s*)?$/i;

const CLASSES = ["a", "b", "c", "d", "e", "f"];

const REMEDY =
	"Correct the file named above — `git restore` it where it is tracked, fix the line where it is a log or a --classes file — then re-run `node " +
	scriptPath("report-round-check-reading.js") +
	" --dry-run`.";
const SENT_BACK = new Set(["b", "c"]);

/**
 * @typedef {import("./lib/log-reading").Reply} Reply
 * @typedef {import("./lib/round-check").RoundCheckLine & { at: string, session: string, repo: string }} RoundEvent
 * @typedef {"refused" | "cap" | "unrefused"} RoundKind
 * @typedef {{ key: string, kind: RoundKind, repo: string, callsBefore: number | null, reply: Reply, cls: string | null }} Round
 * @typedef {{ sent: number, rated: number, unclassed: number }} Rate
 * @typedef {{ sent: number, rated: number }} Base
 * @typedef {{ below: Base, atOrAbove: Base }} RepoBase
 * @typedef {{ byRepo: Map<string, RepoBase>, firstDrafts: number, atThreshold: number }} Baseline
 * @typedef {import("./lib/log-reading").Verdict} Verdict
 */

/** @returns {Baseline} */
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
 * @param {string} file
 * @returns {Map<string, string>}
 */
function readClasses(file) {
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
 * @param {Map<string, string>} roots
 * @returns {{ events: RoundEvent[], live: Map<string, number> }}
 */
function readRoundLogs(roots) {
	const { events, live } = readLogs(roots, (r) => logPath(r, ROUND_CHECK_LOG));
	return { events: /** @type {RoundEvent[]} */ (events), live };
}

/** @param {RoundEvent} e */
const isResend = (e) => e.kind === "passed-after-refusal" && e.resent !== false;

/**
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

/** @typedef {{ session: string, at: string, repo: string, questions: string[], sent: boolean }} Stopped */

/**
 * @param {RoundEvent} e
 * @param {{ session: string, refusedAt: Map<string, number>, upTo: number }} s
 */
function isPassIn(e, s) {
	const t = Date.parse(e.at);
	const refusedAt = s.refusedAt.get(e.round);
	return (
		e.session === s.session &&
		e.kind === "passed-after-refusal" &&
		refusedAt !== undefined &&
		t > refusedAt &&
		t < s.upTo
	);
}

/**
 * @param {RoundEvent[]} events
 * @param {Map<string, string>} transcripts
 * @param {{ at: import("./lib/log-reading").ReadingAt, repos: string[] }} scope
 * @returns {{ stopped: Stopped[], refused: number, unread: number }}
 */
function stoppedRounds(events, transcripts, { at, repos }) {
	/** @type {Map<string, { session: string, at: string, repo: string,
	 *   refusedAt: Map<string, number>, upTo: number }>} */
	const byStretch = new Map();
	/** @type {Map<string, number[] | null>} */
	const spoke = new Map();
	const timesOf = (/** @type {string} */ id) => {
		if (!spoke.has(id))
			spoke.set(
				id,
				founderReplies(transcripts.get(id))?.map((r) => Date.parse(r.at)) ??
					null,
			);
		return spoke.get(id);
	};
	const refusals = events.filter(
		(e) =>
			e.kind.startsWith("refused") &&
			isRead(at, e.at) &&
			repos.includes(e.repo),
	);
	for (const e of refusals) {
		const times = timesOf(e.session);
		if (!times) continue;
		const t = Date.parse(e.at);
		const upTo = times.find((s) => s > t) ?? Number.POSITIVE_INFINITY;
		const key = `${e.session} ${upTo}`;
		const stretch = byStretch.get(key) ?? {
			session: e.session,
			at: e.at,
			repo: e.repo,
			refusedAt: new Map(),
			upTo,
		};
		if (!stretch.refusedAt.has(e.round)) stretch.refusedAt.set(e.round, t);
		byStretch.set(key, stretch);
	}
	/** @type {Stopped[]} */
	const stopped = [];
	for (const s of byStretch.values()) {
		const passes = events.filter((e) => isPassIn(e, s));
		if (passes.some((e) => e.resent !== false)) continue;
		stopped.push({
			session: s.session,
			at: s.at,
			repo: s.repo,
			questions: [...s.refusedAt.keys()],
			sent: passes.length > 0,
		});
	}
	const unread = [...spoke.values()].filter((v) => v === null).length;
	return { stopped, refused: byStretch.size, unread };
}

/**
 * @param {ReturnType<typeof stoppedRounds>} counted
 * @param {number} days
 * @returns {string}
 */
const buildStoppedLine = ({ stopped, refused, unread }, days) =>
	`   Stopped, which this line cannot see: ${ratio(stopped.length, refused)} refused rounds in the pooled repos sent the founder none of their questions — ${(stopped.length / days).toFixed(2)} a day over ${days.toFixed(1)} days. A raw count, each listed below to read by hand.${unread ? ` ${unread} session(s) whose transcript will not read are left out.` : ""}`;

/**
 * @param {Stopped[]} stopped
 * @returns {string[]}
 */
function buildStoppedList(stopped) {
	if (stopped.length === 0) return [];
	return [
		"",
		"Stopped rounds — read each from the session's next message (session@first refusal):",
		...stopped.map(
			(s) =>
				`  - ${s.session}@${s.at} ${s.repo}, question(s) ${s.questions.join(", ")}: ${s.sent ? "left out of the next send" : "no send before his next message"}`,
		),
	];
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
 * @param {Rate} rate
 * @param {number} line
 * @param {string} fired
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
 * @param {Round[]} rounds
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

const CLASS_STEP =
	'1. Class each listed reply with the six send-back classes (#1682): (a) answered; (b) asked for more checks or research; (c) challenged or overturned a premise; (d) asked for a clarification only; (e) other (admin, `/compact`, "resume", information, a new topic); (f) rejected or rewrote a draft on taste, with no premise disputed. A reply that answers some blocks and sends one back is (b) or (c), and a critique naming a wrong fact or rule is (c), not (f). Write them to a JSON file under `.claude/tmp/` as `{"<session>@<reply time>": "<class>"}`, and run `node ' +
	scriptPath("report-round-check-reading.js") +
	" --dry-run --classes <file>` for the decided lines, r and the flip.";

/**
 * @param {string} intro
 * @param {string[]} steps
 * @returns {(reading: string) => string}
 */
const buildReadingBody = (intro, steps) => (reading) =>
	[
		intro,
		"",
		reading,
		"",
		"## What the session that takes this does",
		"",
		...steps,
	].join("\n");

/**
 * @typedef {import("./lib/log-reading").Point} Point
 * @typedef {{ heading: string, filer: ReturnType<typeof buildFiler>, place: (live: Map<string, number>, rounds: Round[], base: Baseline) => { point: Point, sentence: string } | null, thin: (rounds: Round[], pooled: Round[]) => string | null, skewed: boolean }} Reading
 */

/** @param {Round[]} rounds */
const refusedTimes = (rounds) =>
	rounds
		.filter((r) => r.kind === "refused")
		.map((r) => Date.parse(r.reply.at))
		.sort((a, b) => a - b);

/** @param {Round} r */
const isRatedOrOpen = (r) =>
	r.cls === null || r.cls === "a" || SENT_BACK.has(r.cls);

/**
 * @param {Round[]} rounds
 * @param {Baseline} base
 */
function towardSecond(rounds, base) {
	const refused = rounds.filter((r) => r.kind === "refused");
	const pooled = new Set(
		[...base.byRepo]
			.filter(
				([repo, b]) =>
					b.below.rated > 0 &&
					refused.filter((r) => r.repo === repo).length >= MIN_REPO_ROUNDS,
			)
			.map(([repo]) => repo),
	);
	return refused.filter((r) => pooled.has(r.repo) && isRatedOrOpen(r));
}

/** @type {Reading[]} */
const READINGS = [
	{
		heading: "Round-check reading (#1691, spec #1701)",
		filer: buildFiler({
			title: TITLE,
			label: takesLabel("wayfinder"),
			record: ".round-check-reading-filed",
			script: "report-round-check-reading.js",
			buildIssueBody: buildReadingBody(
				"The reading of the under-researched-round check, filed once by `scripts/report-round-check-reading.js` at its reading point (spec #1701; rulings #1684 and #1691). Closing this issue never re-files it.",
				[
					CLASS_STEP,
					"2. Put each ruling a fired line names back to the founder as a fresh question, saying so where the reading is THIN; nothing flips on its own (#1691 Q1 (A)).",
					"3. Where the flip reads PUT, put the flip — send every not-close round back once, whatever its tool calls (#1684) — to the founder as a fresh question, with r and its price; no price bar is set in advance (#1691 Q2 (A)).",
				],
			),
		}),
		place: (live, rounds) => {
			const point = readingPoint(live, refusedTimes(rounds));
			if (!point) return null;
			return {
				point,
				sentence: point.fixed
					? `Reading point: ${minute(point.point)} — the later of ${POINT_FIGURES.clockDays} days after the first log line (${minute(point.clock)}) and the ${POINT_FIGURES.countTarget}th refused-then-answered round, capped at ${minute(point.ceiling)}.`
					: `Reading point: ${minute(point.ceiling)} at the latest (${POINT_FIGURES.ceilingDays} days after the first log line); earlier once ${POINT_FIGURES.countTarget} refused rounds are answered.`,
			};
		},
		thin: (rounds) => {
			const n = rounds.filter((r) => r.kind === "refused").length;
			return n < POINT_FIGURES.countTarget
				? `THIN: ${n} refused-then-answered round(s), under the ${POINT_FIGURES.countTarget} a reading needs to separate the half-baseline line from the baseline.`
				: null;
		},
		skewed: false,
	},
	{
		heading: "Round-check second reading (#3978 Q1 (A), #3995)",
		filer: buildFiler({
			title: SECOND_TITLE,
			label: takesLabel("wayfinder"),
			record: ".round-check-reading-2-filed",
			script: "report-round-check-reading.js",
			buildIssueBody: buildReadingBody(
				`The second reading of the under-researched-round check, filed once by \`scripts/report-round-check-reading.js\` at ${SECOND_TARGET} rated refused-then-answered rounds (ruled at #3978 Q1 (A); the first reading is #3978). Closing this issue never re-files it.`,
				[
					`${CLASS_STEP} Where replies classed (d)–(f) leave fewer than ${SECOND_TARGET} rated, the re-run's point moves later: class the replies it then lists too.`,
					"2. Read each listed stopped round from the session's next message, and say which are real stops (the session decided or withdrew the question itself, or went on without asking) and which are not (recording an answer, a test session, a reworded hand-over). Judge a sample of the real ones, saying how many: was the session right to decide it itself?",
					"3. Put line 1 back to the founder as a fresh question, whatever it reads (#3978 Q1 (A)), with the stopped rounds a day and step 2's findings beside it, and the baseline's skew beside every rate set against a baseline. Put each ruling another fired line names back as a fresh question too, and the flip where it reads PUT (#1691).",
				],
			),
		}),
		place: (live, rounds, base) => {
			const first = Math.min(...live.values());
			if (!Number.isFinite(first)) return null;
			const times = refusedTimes(towardSecond(rounds, base));
			const target = times[SECOND_TARGET - 1];
			const what = `the ${SECOND_TARGET}th refused-then-answered round classed (a)–(c) or still to class (#3978 Q1 (A))`;
			if (target === undefined)
				return {
					point: {
						point: Number.POSITIVE_INFINITY,
						ceiling: Number.POSITIVE_INFINITY,
						fixed: false,
						clock: first,
					},
					sentence: `Reading point: ${what}; ${times.length} so far.`,
				};
			return {
				point: { point: target, ceiling: target, fixed: true, clock: first },
				sentence: `Reading point: ${minute(target)} — ${what}; classing one of them (d)–(f) moves it later.`,
			};
		},
		thin: (_rounds, pooled) => {
			const { rated } = rateOf(pooled);
			return rated < SECOND_TARGET
				? `THIN: ${rated} refused-then-answered round(s) classed (a)–(c), under the ${SECOND_TARGET} that tell half the baseline from the baseline at 80% power.`
				: null;
		},
		skewed: true,
	},
];

const SKEW_LINE =
	"Every baseline below is skewed: rounds reaching the founder fell 72% between the baseline fortnight and the first reading (#3978), when the refusal and the written rule shipped together, so a rate set against one is confounded by which rounds still reach him.";

/**
 * @param {string | null} thin
 * @param {number} unreadHeads
 * @param {number} unreadSessions
 * @param {number} strayClasses
 * @returns {string[]}
 */
function buildCaveatLines(thin, unreadHeads, unreadSessions, strayClasses) {
	const lines = thin ? [thin] : [];
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

/** @param {ReturnType<typeof repoPool>} below */
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

/** @param {RoundEvent[]} counted */
function buildPaddedLine(counted) {
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

/** @param {Round[]} capRounds */
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
 * @param {Rate | null} rate
 * @param {number | null} baseRate
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
 * @param {Round[]} rounds
 * @param {number} leftOut
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
		writeFd(
			2,
			"SKIP: the round-check reading is workflow-core's alone; it reads every repo from there.\n",
		);
		return;
	}
	const filings = READINGS.map((r) => ({
		reading: r,
		filed: r.filer.readFiledAs(),
	}));
	const due = filings.find((f) => !f.filed);
	if (!due && !dryRun) {
		writeFd(
			1,
			`The round-check readings are filed as ${filings.map((f) => f.filed).join(" and ")}; nothing to do.\n`,
		);
		return;
	}
	const { reading, filed } =
		due ?? /** @type {(typeof filings)[number]} */ (filings.at(-1));
	const nowMs = now();
	const file = flags["--classes"];
	const run = {
		reading,
		nowMs,
		dryRun,
		filed,
		seats: lists["--config-dir"] ?? configDirs(),
		classesFile: typeof file === "string" ? file : undefined,
	};
	reading.filer.readDaily(run, () => readAndPublish(run));
}

/** @param {{ reading: Reading, nowMs: number, dryRun: boolean, filed: string | null, seats: string[], classesFile: string | undefined }} run */
function readAndPublish({ reading, nowMs, dryRun, filed, seats, classesFile }) {
	/** @type {Baseline} */
	let base;
	/** @type {Map<string, string>} */
	let given;
	/** @type {Map<string, string>} */
	let classes;
	try {
		base = readBaseline();
		given = classesFile ? readClasses(classesFile) : new Map();
		classes = new Map([
			...readClasses(path.join(hostRoot(), CLASSED)),
			...given,
		]);
	} catch (e) {
		return broken(`${errMessage(e)}\n${REMEDY}`);
	}
	const repos = [...base.byRepo.keys()].sort();

	const { files } = readSeatTranscripts(seats);
	/** @type {Map<string, string>} */
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

	const placed = reading.place(live, allRounds, base);
	const at = readingAt(placed?.point ?? null, nowMs);
	const counted = events.filter((e) => isRead(at, e.at));
	const rounds = allRounds.filter((r) => isRead(at, r.reply.at));

	const out = [
		reading.heading,
		"",
		...buildRepoLines(repos, live, roots, "round-check"),
	];
	if (!placed) {
		out.push("", "Reading point: none yet — no repo is live.");
		writeFd(1, `${out.join("\n")}\n`);
		return;
	}
	out.push(...buildPointLines(placed.sentence, at));

	const ofKind = (/** @type {RoundKind} */ k) =>
		rounds.filter((r) => r.kind === k);
	const below = repoPool(ofKind("refused"), { base, repos }, "below");
	const atOrAbove = repoPool(ofKind("unrefused"), { base, repos }, "atOrAbove");
	const capRounds = ofKind("cap");
	const listed = [...below.pooled, ...atOrAbove.pooled, ...capRounds];
	const stray = [...given.keys()].filter(
		(k) => !rounds.some((r) => r.key === k),
	).length;

	out.push(
		"",
		...buildCaveatLines(
			reading.thin(rounds, below.pooled),
			unreadHeads,
			unreadSessions,
			stray,
		),
	);
	if (reading.skewed) out.push(SKEW_LINE, "");
	const notWorking = buildNotWorkingLine(below);
	const stopped = stoppedRounds(events, transcripts, {
		at,
		repos: below.kept,
	});
	notWorking.text.push(
		buildStoppedLine(stopped, (at.cutoff - placed.point.clock) / DAY_MS),
	);
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
		...buildStoppedList(stopped.stopped),
	);
	reading.filer.publish(out.join("\n"), { reached: at.reached, dryRun, filed });
}

if (require.main === module) main();
