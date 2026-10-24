/*
 * close-rivals.js — the priced-options guard's close-rivals limb (workflow-core#488, workflow-core#489,
 * workflow-core#1061, workflow-core#1101, workflow-core#1474), and the research-ladder limb on its still-caught
 * re-sends (workflow-core#2006). The rule each applies, their record and their log are
 * written in guard-priced-options.js's header (its sixteenth refusal and the
 * three paragraphs after it).
 *
 * `closeRivalsTurn` reads and writes the refusal record itself. `rivalPair`
 * and `CLOSE_GAP` are the closeness test check-band-drift.js and
 * audit-escape-lines.js apply to past rounds, and `topOf` the top figure
 * check-band-drift.js watches for bunching above `LOW_TOP`; `caughtBy` is
 * what this limb judges a first send and a re-send by, and the
 * under-researched limb a first send.
 */

const {
	CLOSE_CHECK_LOG,
	CLOSE_RIVALS_PREFIX,
	CLOSE_RIVALS_RECORD_PREFIX,
	RESEARCH_LADDER_PREFIX,
} = require("./priced-options-limbs");
const {
	RUNGS,
	rungCounts,
	missingRungs,
	ladderLine,
	ladderReason,
} = require("./research-ladder");
const {
	PRICED,
	isRivalSet,
	optionBody,
	optionSpans,
	splitQuestions,
} = require("./round-marker");
const {
	isObject,
	RESEND_ONLY,
	isPassed,
	lastRefusal,
	refusalLimb,
} = require("./refusal-limb");
const {
	SHAPE_HELD,
	isMisshapen,
	buildMisshapenFlag,
	buildRuleFlag,
	shapeOnlyReason,
} = require("./shape-hold");

/** @typedef {import("./round-marker").QuestionBlock} QuestionBlock */

/* A rival pair is close when its bands overlap, or when its headline figures
 * sit this many points apart or fewer whatever the bands say (workflow-core#472). */
const CLOSE_GAP = 25;
/* A question whose highest headline figure is this or less has no option
 * likely right, whatever its shape (workflow-core#2228, re-ruled at workflow-core#2519). */
const LOW_TOP = 65;

/**
 * @typedef {import("./close-check-log").Band} Band
 * @typedef {{ top: Band, runnerUp: Band, gap: number, overlap: boolean, close: boolean }} RivalPair
 */

/**
 * Every option in a block carrying a full priced line, in the order written.
 * @param {QuestionBlock} block
 * @returns {Band[]}
 */
function bandsOf(block) {
	/** @type {Band[]} */
	const bands = [];
	for (const o of optionSpans(block.lines)) {
		const m = o.span.match(PRICED);
		if (!m) continue;
		const [a, b] = [Number(m[2]), Number(m[3])];
		bands.push({
			letter: o.letter,
			figure: Number(m[1]),
			low: Math.min(a, b),
			high: Math.max(a, b),
		});
	}
	return bands;
}

/* What a re-send's option lines may cite that its refused send did not: a
 * URL less its sentence-ending punctuation, an issue number (`#12`,
 * `mantahostels#12`, `acme/core#12`) or a `path:line[:col]` whose path has a
 * lettered extension or a `/`. Lexical, a reading for the log and never a
 * gate (workflow-core#2010). */
const URL_CITE = /https?:\/\/[^\s)>\]`"']*[^\s)>\]`"'.,;:]/g;
const ISSUE_CITE = /(?<![\w&{$])(?:[\w.-]+\/[\w.-]+|[\w-]+)?#\d+(?!\w)/g;
const PATH_LINE_CITE =
	/(?<![\w/.-])(?:[\w.-]*(?:\/[\w.-]+)*\.[A-Za-z]\w*|[\w.-]+(?:\/[\w.-]+)+):\d+(?::\d+)?(?![\d:])/g;

/**
 * The citations in a block's option lines, each once, in the order found.
 * @param {QuestionBlock} block
 * @returns {string[]}
 */
function citesOf(block) {
	const text = optionSpans(block.lines)
		.map((o) => optionBody(o.span))
		.join("\n");
	const withoutUrls = text.replace(URL_CITE, " ");
	return [
		...new Set([
			...(text.match(URL_CITE) ?? []),
			...(withoutUrls.match(ISSUE_CITE) ?? []),
			...(withoutUrls.match(PATH_LINE_CITE) ?? []),
		]),
	];
}

/**
 * Orders bands by headline figure, highest first, ties in letter order.
 * @param {Band} x
 * @param {Band} y
 */
const byFigure = (x, y) =>
	y.figure - x.figure || x.letter.localeCompare(y.letter);

/**
 * The top two of `bands` by headline figure, ties in letter order; null under
 * two.
 * @param {Band[]} bands
 * @returns {{ top: Band, runnerUp: Band } | null}
 */
function topTwo(bands) {
	const [top, runnerUp] = [...bands].sort(byFigure);
	if (top === undefined || runnerUp === undefined) return null;
	return { top, runnerUp };
}

/**
 * The top two rivals of one question block, and whether they sit close. Null
 * where the `Relation:` line declares no rivals or also names a combinable
 * pair, or where fewer than two options carry a full priced line — an option
 * declared unknowable or subjective carries none, so drops out.
 *
 * @param {QuestionBlock} block
 * @returns {RivalPair | null}
 */
function rivalPair(block) {
	if (!isRivalSet(block.lines)) return null;

	const pair = topTwo(bandsOf(block));
	if (!pair) return null;

	const { top, runnerUp } = pair;
	const gap = top.figure - runnerUp.figure;
	const overlap = top.low <= runnerUp.high;
	return { top, runnerUp, gap, overlap, close: overlap || gap <= CLOSE_GAP };
}

/**
 * The highest-priced option of one question block, whatever its `Relation:`
 * says, ties in letter order; undefined where none is priced.
 * @param {QuestionBlock} block
 * @returns {Band | undefined}
 */
const topOf = (block) => bandsOf(block).sort(byFigure)[0];

/**
 * Which of this limb's tests a question block fails, and its highest-priced
 * option: `close`, its top two rivals by `rivalPair`; `low-top`, that option
 * at `LOW_TOP` or under, whatever its `Relation:` says. Null where neither
 * fires.
 * @param {QuestionBlock} block
 * @returns {{ trigger: import("./close-check-log").Trigger, top: Band,
 *   pair: RivalPair | null } | null}
 */
function caughtBy(block) {
	const pair = rivalPair(block);
	const top = topOf(block);
	if (top === undefined) return null;
	const close = Boolean(pair?.close);
	const lowTop = top.figure <= LOW_TOP;
	if (close && lowTop) return { trigger: "both", top, pair };
	if (close) return { trigger: "close", top, pair };
	return lowTop ? { trigger: "low-top", top, pair } : null;
}

/**
 * What the close-rivals limb last refused or passed this session: each refused
 * question's round number, priced options and `refusedAt` (workflow-core#489) — a record
 * written before workflow-core#1098 carries only its own `at`, which reading fills in —
 * and `cites`, its option lines' citations, absent on one written before
 * workflow-core#2010;
 * and each passed one's `Passed` (workflow-core#1844); `at`, when the record was written;
 * `unreadable` where a record exists that would not read, which empties it.
 * @typedef {{ number: string, bands: Band[], refusedAt: number, cites?: string[] }} Refused
 * @typedef {import("./refusal-limb").Passed} Passed
 * @typedef {{ at: number, questions: (Refused | Passed)[], unreadable?: boolean }} RefusalRecord
 */

/* Stands in for a record that exists but would not read: no question to
 * judge as a re-price, and every caught question taken as already refused
 * (workflow-core#1061). */
/** @type {RefusalRecord} */
const UNREADABLE_RECORD = { at: 0, questions: [], unreadable: true };

/**
 * @param {unknown} b
 * @returns {b is Band}
 */
const isBand = (b) =>
	isObject(b) &&
	typeof b.letter === "string" &&
	["figure", "low", "high"].every((k) => typeof b[k] === "number");

/**
 * One recorded question in its current shape, `refusedAt` filled in from the
 * record's `at` on a record written before workflow-core#1098; null where it is malformed.
 * @param {Record<string, unknown>} question
 * @param {number} at
 * @returns {Refused | null}
 */
function parseRefused({ number, bands, refusedAt: recorded, cites }, at) {
	const refusedAt = recorded === undefined ? at : recorded;
	if (
		typeof number !== "string" ||
		typeof refusedAt !== "number" ||
		!Array.isArray(bands) ||
		!bands.every(isBand)
	)
		return null;
	const citesRead =
		Array.isArray(cites) && cites.every((c) => typeof c === "string");
	return { number, bands, refusedAt, ...(citesRead && { cites }) };
}

const limb = refusalLimb({
	prefix: CLOSE_RIVALS_RECORD_PREFIX,
	limb: "close-rivals",
	skipped: "re-price allowed, caught question passed",
	parseQuestion: parseRefused,
	log: CLOSE_CHECK_LOG,
});

/**
 * The session's refusal record, as `readLive` gives it, or
 * `UNREADABLE_RECORD` where it will not read — logged, the re-price check
 * skipped and a caught question passed.
 * @param {string} sessionId
 * @param {string | undefined} transcript
 * @returns {RefusalRecord | null}
 */
function readRefusalRecord(sessionId, transcript) {
	const record = limb.readLive(sessionId, transcript);
	return record === "unreadable" ? UNREADABLE_RECORD : record;
}

/** @param {Band} b */
const bandText = (b) => `(${b.letter}) ${b.figure}% (${b.low}% - ${b.high}%)`;

/**
 * One question's prices, order-free, for telling a re-price from a re-send.
 * @param {Band[]} bands
 */
const priceKey = (bands) => bands.map(bandText).sort().join("; ");

/**
 * One question as the close check judged it this Stop, for the close-check
 * log (workflow-core#1101).
 * `pair` is its top two at this send, null for a refused question this send
 * left out; `prior`, `toolCalls`, `stillClose`, `rungs`, `flipped` and
 * `citesNewFact` are on a question already refused, and `missing`, its untried rungs, on a `refused-ladder` one;
 * `trigger`, the test that caught it, on one judged on first sight.
 * @typedef {{ round: string,
 *   kind: Exclude<import("./close-check-log").Kind, "passed-at-cap">,
 *   pair: import("./close-check-log").Pair | null,
 *   prior?: Refused }
 *   & Pick<import("./close-check-log").CloseCheckEvent,
 *     "toolCalls" | "stillClose" | "rungs" | "flipped" | "citesNewFact" | "missing" | "trigger">
 * } CloseCheck
 */

/**
 * @typedef {import("./shape-hold").ShapeFaults} ShapeFaults
 * @typedef {import("./shape-hold").Flag} Flag
 * @typedef {import("./research-ladder").Rung} Rung
 * @typedef {import("./research-ladder").RungCounts} RungCounts
 * @typedef {import("./research-ladder").Corpus} Corpus
 */

/**
 * The close check's working state for one send: the questions it refused
 * earlier, whether the record would not read, the memoised tool-call count
 * and ladder rungs since a refusal, the shape check where the shape limb is
 * silent, and what it gathers — `ladderLines`, one line per question the
 * research-ladder limb refuses.
 * @typedef {{ priors: Refused[], unreadable: boolean,
 *   callsAfter: (at: number) => number | null,
 *   rungsAfter: (at: number) => RungCounts | null,
 *   silencedShape: ShapeFaults | null, flagged: Flag[], ladderLines: string[],
 *   refused: Refused[], checks: CloseCheck[] }} CloseState
 */

/**
 * Tool calls since a refusal time.
 * @param {string | undefined} transcript
 * @returns {(at: number) => number | null}
 */
function callsAfterFor(transcript) {
	/** @type {Map<number, number | null>} each refusal time read once */
	const callsSince = new Map();
	return (at) => {
		if (!callsSince.has(at))
			callsSince.set(
				at,
				limb.fromTranscript(
					transcript,
					"re-price allowed, tool calls logged as null",
					(since, file) => since.sinceTime(file, at),
				),
			);
		return /** @type {number | null} */ (callsSince.get(at));
	};
}

/**
 * Qualifying calls per ladder rung since a refusal time.
 * @param {string | undefined} transcript
 * @param {() => Corpus} corpus
 * @returns {(at: number) => RungCounts | null}
 */
function rungsAfterFor(transcript, corpus) {
	/** @type {Map<number, RungCounts | null>} each refusal time read once */
	const rungsSince = new Map();
	return (at) => {
		if (!rungsSince.has(at)) {
			const calls = limb.fromTranscript(
				transcript,
				"rungs logged as null, a still-caught re-send passed unladdered",
				(since, file) => since.toolCallsSince(file, at),
			);
			rungsSince.set(at, calls && rungCounts(calls, corpus()));
		}
		return /** @type {RungCounts | null} */ (rungsSince.get(at));
	};
}

/**
 * @param {QuestionBlock} block
 * @param {Refused} prior
 * @param {import("./close-check-log").Pair | null} sent its top two at this send
 * @returns {{ flipped: boolean | null, citesNewFact: boolean | null }}
 */
function resendChange(block, prior, sent) {
	const refusedTop = topTwo(prior.bands)?.top.letter;
	const cites = new Set(prior.cites);
	return {
		flipped: sent && refusedTop ? sent.top.letter !== refusedTop : null,
		citesNewFact: prior.cites
			? citesOf(block).some((c) => !cites.has(c))
			: null,
	};
}

/**
 * Judge a question this check already refused: a re-price with no tool call
 * since is refused again, and so, where the shape limb is silent, is a
 * re-send still misshapen (workflow-core#1742); a re-send still caught (`caughtBy`) with
 * a ladder rung untried since is the research-ladder limb's to refuse (workflow-core#2006).
 * @param {{ block: QuestionBlock, bands: Band[],
 *   prior: Refused,
 *   check: Pick<CloseCheck, "round" | "pair">, shape: string[] }} question
 * @param {CloseState} state accumulator: checks, refused, flagged and ladderLines are filled; the rest is read
 */
function judgeRefusedAgain({ block, bands, prior, check, shape }, state) {
	const stillCaught = caughtBy(block) !== null;
	const toolCalls = state.callsAfter(prior.refusedAt);
	const reprice = priceKey(prior.bands) !== priceKey(bands) && toolCalls === 0;
	/** @type {CloseCheck["kind"]} */
	let kind = "passed-after-refusal";
	/** @type {Rung[]} */
	let missing = [];
	const rungs = state.rungsAfter(prior.refusedAt);
	if (reprice) kind = "refused-reprice";
	else if (shape.length > 0) kind = "refused-misshapen";
	else if (stillCaught) {
		missing = rungs ? missingRungs(rungs) : [];
		if (missing.length > 0) kind = "refused-ladder";
	}
	state.checks.push({
		...check,
		kind,
		prior,
		toolCalls,
		stillClose: stillCaught,
		rungs,
		...resendChange(block, prior, check.pair),
		...(missing.length > 0 && { missing }),
	});
	state.refused.push(prior);
	if (kind === "refused-ladder") {
		state.ladderLines.push(ladderLine(block.number, missing));
		return;
	}
	if (kind === "refused-misshapen") {
		state.flagged.push(buildMisshapenFlag(block.number, shape));
		return;
	}
	/* The guard's header: refused once, whatever its line (workflow-core#1061). */
	if (!reprice) return;
	state.flagged.push(
		buildRuleFlag(
			`Q${block.number}: re-priced from ${prior.bands.map(bandText).join(", ")} ` +
				`to ${bands.map(bandText).join(", ") || "no priced options"} with no ` +
				"tool call since this check refused it.",
			shape,
		),
	);
}

/**
 * @param {QuestionBlock} block
 * @param {CloseState} state accumulator: checks, refused, flagged and ladderLines are filled; the rest is read
 */
function judgeCloseBlock(block, state) {
	const bands = bandsOf(block);
	const prior = state.priors.find((q) => q.number === block.number);
	const check = { round: block.number, pair: topTwo(bands) };
	const shape = state.silencedShape?.(block) ?? [];
	if (prior) {
		judgeRefusedAgain({ block, bands, prior, check, shape }, state);
		return;
	}
	const caught = caughtBy(block);
	if (!caught) return;
	const { trigger } = caught;
	if (state.unreadable) {
		state.checks.push({ ...check, kind: "passed-unreadable", trigger });
		return;
	}
	state.checks.push({ ...check, kind: "refused", trigger });
	state.refused.push({
		number: block.number,
		bands,
		refusedAt: Date.now(),
		cites: citesOf(block),
	});
	state.flagged.push(buildRuleFlag(caughtLine(block.number, caught), shape));
}

const NONE_LIKELY = `no option is priced above ${LOW_TOP}, so none is likely right`;

/**
 * The flag line for a question caught on first sight.
 * @param {string} number
 * @param {NonNullable<ReturnType<typeof caughtBy>>} caught
 */
function caughtLine(number, { trigger, top, pair }) {
	if (trigger === "low-top" || !pair)
		return (
			`Q${number}: top option ${bandText(top)} — ${NONE_LIKELY}. ` +
			"What fact would make one option likely right, or show none is? Go and look for it."
		);
	const tests = [
		pair.overlap ? "their bands overlap" : "",
		pair.gap <= CLOSE_GAP ? `their figures sit ${pair.gap} points apart` : "",
	].filter(Boolean);
	const rivals = `(${pair.runnerUp.letter}) beat (${pair.top.letter})`;
	return (
		`Q${number}: ${bandText(pair.top)} against ${bandText(pair.runnerUp)} — ` +
		`${tests.join(" and ")}, so the recommendation could flip` +
		(trigger === "both"
			? `, and ${NONE_LIKELY}. What fact would make ${rivals}, or make one option likely right?`
			: `. What fact would make ${rivals}?`) +
		" Go and look for it."
	);
}

/**
 * @param {Flag[]} flagged
 * @param {string} houseDecision the house-decision rule (workflow-core#1683), whose stop replaced the
 *   look's 10-call budget (workflow-core#1705): the look is unbounded, and a re-price with
 *   no tool call since is still refused
 * @param {boolean} isLastRefusal whether this refusal spends the limb's cap
 * @returns {string}
 */
function closeRivalsReason(flagged, houseDecision, isLastRefusal) {
	const misshapen = isMisshapen(flagged);
	const resentMisshapen = flagged.some((flag) => flag.shapeOnly);
	return (
		"This turn puts a choice to the founder whose top two rivals sit close, " +
		`or whose top option is priced ${LOW_TOP} or less, ` +
		`or re-prices one this check refused${resentMisshapen ? ", or re-sends one still misshapen" : ""}:\n\n` +
		flagged.map((flag) => flag.line).join("\n") +
		"\n\nTwo tests make a pair close, and both apply: the top option's band " +
		"reaching down to the runner-up's, or headline figures " +
		CLOSE_GAP +
		" points apart or fewer whatever the bands say — so narrowing the bands " +
		"does not take a pair out of scope. A third test catches any round, " +
		`rivals, yes/no or combinable: a top figure of ${LOW_TOP} or less, so ` +
		"no option is likely right (workflow-core#2228, workflow-core#2519).\n\n" +
		"A close pair means the founder is being asked to settle something you " +
		'may be able to settle yourself — he would otherwise reply "are there ' +
		'further checks or research you can do". Name the fact that decides it, ' +
		"then look: a local read, `git`, a `gh` read, a throwaway script — " +
		"anything reachable without the founder and without a paid source. " +
		"Re-price from what it " +
		"showed, and say what you ran and what it showed on a `Checked:` line. " +
		"A past ruling, or what the code or a tool does today, separates only " +
		"rivals that are otherwise equal, so a search of precedent is no " +
		"`Checked:` line on its own (workflow-core#1457). Where precedent and merit conflict, " +
		"look deeper before changing path: the precedent's reason and whether it " +
		"still holds, and the gain, per use times how often and widely it " +
		"repeats, against the cost of undoing the old way. Merit wins once that " +
		"look is done: only a gain small in total keeps the old way. Where the deciding " +
		"fact is still out of reach, say which fact and why no cheap check " +
		"reaches it on an `Unmeasured:` line.\n\n" +
		"Every question a test catches is sent back once, whatever its `Checked:` or " +
		"`Unmeasured:` line, so the line does not clear it: the corrected question " +
		"passes on its next send if no test still catches it (workflow-core#1061). Still caught, it " +
		"passes only once each rung of the research ladder — the founder's past " +
		"rulings, the web or vendor docs, a fresh subagent — shows a tool call " +
		"since this refusal (workflow-core#2006). The line reports the look; it does not " +
		"replace it. Lines that pass are judged later, in batch, on whether they " +
		"bore on the fact separating the pair (workflow-core#671).\n\n" +
		(isLastRefusal
			? `Re-pricing is not a check. ${lastRefusal("do the look", misshapen)}\n\n`
			: (misshapen ? `${SHAPE_HELD}\n\n` : "") +
				"Re-pricing is not a check: a question this check refused, re-sent with " +
				"different figures or bands and no tool call since the refusal, is refused " +
				"again, escape line or not.\n\n") +
		`${houseDecision}\n\n` +
		RESEND_ONLY
	);
}

/**
 * THE SIXTEENTH REFUSAL (workflow-core#488): a question whose top two rivals sit close, or
 * whose top option is priced `LOW_TOP` or under (workflow-core#2228), and that this check
 * has not yet refused, whatever its escape line (workflow-core#1061) — or
 * (workflow-core#489) a question it refused, re-priced with no tool call since — or (workflow-core#1742),
 * where the shape limb is silent, one it refused re-sent still misshapen.
 * @param {QuestionBlock[]} blocks the outgoing message's questions, less
 *   those passed earlier in a turn another Stop hook refused, which are
 *   neither judged nor logged again (workflow-core#1844)
 * @param {{ transcript?: string, record: RefusalRecord | null,
 *   houseDecision: () => string, silencedShape: ShapeFaults | null,
 *   isLastRefusal: boolean, corpus: () => Corpus }} turn
 *   `record`, what it last refused or passed in this turn; `houseDecision`
 *   reads the house-decision rule, called only on a refusal; `isLastRefusal`,
 *   whether a block refusing here would spend this limb's cap; `corpus`, the
 *   trackers a rulings search must reach, read only to judge a still-caught
 *   re-send
 * @returns {{reason: string, refused: Refused[],
 *   checks: CloseCheck[], ladderLines: string[]}} the block reason, or '' if
 *   nothing is owed, what to record if it is sent, what to log, and the
 *   research-ladder limb's lines
 */
function closeRivals(
	blocks,
	{ transcript, record, houseDecision, silencedShape, isLastRefusal, corpus },
) {
	/** @type {CloseState} */
	const state = {
		priors: (record?.questions ?? []).filter(
			/** @returns {q is Refused} */ (q) => !isPassed(q),
		),
		unreadable: Boolean(record?.unreadable),
		callsAfter: callsAfterFor(transcript),
		rungsAfter: rungsAfterFor(transcript, corpus),
		silencedShape,
		flagged: [],
		ladderLines: [],
		refused: [],
		checks: [],
	};
	const { flagged, ladderLines, refused, checks, callsAfter, priors } = state;
	const sent = new Set(blocks.map((block) => block.number));
	for (const block of blocks) judgeCloseBlock(block, state);
	/* A refused question this send leaves out reached the founder on an
	 * earlier, blocked send, so it passes with this turn, if this turn passes. */
	for (const prior of priors)
		if (!sent.has(prior.number))
			checks.push({
				round: prior.number,
				kind: "passed-after-refusal",
				pair: null,
				prior,
				toolCalls: callsAfter(prior.refusedAt),
				stillClose: null,
				rungs: state.rungsAfter(prior.refusedAt),
				flipped: null,
				citesNewFact: null,
			});
	if (flagged.length === 0) return { reason: "", refused, checks, ladderLines };

	refused.push(...priors.filter((q) => !sent.has(q.number)));

	return {
		/* A re-send held on shape alone owes no look, so carries none of the
		 * close rule (workflow-core#1742). */
		reason:
			shapeOnlyReason(flagged, isLastRefusal) ??
			closeRivalsReason(flagged, houseDecision(), isLastRefusal),
		refused,
		checks,
		ladderLines,
	};
}

/** @typedef {Omit<import("./close-check-log").CloseCheckEvent, "session">} CloseCheckLine */

/**
 * Whether a check's kind is one a sent block refuses. Kept out of
 * close-check-log.js, which the guard never loads, so a broken log module
 * cannot take the guard down (workflow-core#1747).
 * @param {import("./close-check-log").Kind} kind
 * @returns {boolean}
 */
const isRefusal = (kind) => kind.startsWith("refused");

/**
 * Whether `kind` is a refusal of the limb `ofLadder` picks: the research
 * ladder's if true, else this one's.
 * @param {import("./close-check-log").Kind} kind
 * @param {boolean} ofLadder whether the research-ladder limb's
 * @returns {boolean}
 */
const isLimbRefusal = (kind, ofLadder) =>
	isRefusal(kind) && (kind === "refused-ladder") === ofLadder;

/**
 * The log lines for the caught questions a sent block refuses (workflow-core#1101).
 * @param {CloseCheck[]} checks
 * @param {number} slot the refusing limb's counter after this block's charge
 * @param {boolean} ofLadder whether the research-ladder limb's
 * @returns {CloseCheckLine[]}
 */
function refusedChecks(checks, slot, ofLadder) {
	/** @type {CloseCheckLine[]} */
	const events = [];
	for (const { round, kind, pair, missing, trigger } of checks)
		if (isLimbRefusal(kind, ofLadder))
			events.push({
				round,
				kind,
				pair,
				slot,
				...(missing && { missing }),
				...(trigger && { trigger }),
			});
	return events;
}

/**
 * The rounds a sent block of this limb, or the research-ladder limb's,
 * refuses.
 * @param {CloseCheck[]} checks
 * @param {boolean} ofLadder whether the research-ladder limb's
 */
const refusingRounds = (checks, ofLadder) =>
	checks
		.filter(({ kind }) => isLimbRefusal(kind, ofLadder))
		.map((check) => check.round);

/**
 * The log lines for the caught questions a Stop lets through (workflow-core#1101). A
 * refusal standing only because the cap is spent passes at cap, or, already
 * refused, after refusal — a research-ladder one carrying its untried rungs
 * (workflow-core#2006); a first refusal let through with the cap unspent (an unwritable
 * counter) is logged as nothing.
 * @param {CloseCheck[]} checks
 * @param {boolean} capSpent
 * @returns {CloseCheckLine[]}
 */
function passedChecks(checks, capSpent) {
	/** @type {CloseCheckLine[]} */
	const events = [];
	for (const {
		round,
		kind,
		pair,
		prior,
		toolCalls,
		stillClose,
		rungs,
		flipped,
		citesNewFact,
		missing,
		trigger,
	} of checks)
		switch (kind) {
			case "refused":
				if (capSpent)
					events.push({ round, kind: "passed-at-cap", pair, trigger });
				break;
			case "passed-unreadable":
				events.push({ round, kind, pair, trigger });
				break;
			default:
				events.push({
					round,
					kind: "passed-after-refusal",
					pair,
					toolCalls,
					refusedPair: prior ? topTwo(prior.bands) : null,
					stillClose,
					rungs,
					flipped,
					citesNewFact,
					...(missing && { missing }),
				});
		}
	return events;
}

/**
 * The close-rivals limb's verdict on one turn and the research-ladder limb's,
 * for the guard to batch with its others. The guard calls a limb's
 * `onBlocked` once a block carrying it has gone out, with its counter after
 * that block's charge, and the close limb's `onPassed` once the turn is let
 * through, saying whether its counter is spent — so the record and the log
 * are untouched when another limb blocks and this one does not. A ladder
 * refusal leaves the record as it stands, so its question keeps the time of
 * its first refusal.
 * @param {string} message the outgoing assistant message
 * @param {{ sessionId: string, transcript?: string,
 *   houseDecision: () => string, silencedShape: ShapeFaults | null,
 *   isLastRefusal: boolean, isLastLadder: boolean, corpus: () => Corpus,
 *   roundPasses: string[] }} turn
 *   `roundPasses`, the questions the under-researched-round limb passed in
 *   this turn, which this limb leaves to it (workflow-core#1949);
 *   `silencedShape`, the guard's shape check, given only where the shape limb
 *   will not speak this turn, as round-check.js takes it (workflow-core#1742); `isLastRefusal`
 *   and `corpus`, as `closeRivals` takes them; `isLastLadder`, whether a block
 *   refusing on the ladder would spend its cap
 * @returns {{ prefix: string, reason: string, rounds: string[],
 *   refusing: string[], onBlocked: (slot: number) => void,
 *   onPassed: (capSpent: boolean) => void,
 *   ladder: { prefix: string, reason: string, refusing: string[],
 *     onBlocked: (slot: number) => void } }}
 *   `rounds`, the questions it judged or re-sent after its pass, which the
 *   under-researched-round limb leaves to it (workflow-core#1710); `refusing`, those its
 *   refusal, or the ladder's, carries, which that limb's own refusal stays
 *   off where the block goes out (workflow-core#2244)
 */
function closeRivalsTurn(
	message,
	{
		sessionId,
		transcript,
		houseDecision,
		silencedShape,
		isLastRefusal,
		isLastLadder,
		corpus,
		roundPasses,
	},
) {
	const record = readRefusalRecord(sessionId, transcript);
	const passes = record?.questions.filter(isPassed) ?? [];
	const passed = new Set(passes.map((q) => q.number));
	const blocks = splitQuestions(message);
	const skipped = new Set([...passed, ...roundPasses]);
	/** @type {Corpus | undefined} */
	let trackers;
	const readCorpus = () => {
		if (trackers === undefined) trackers = corpus();
		return trackers;
	};
	const { reason, refused, checks, ladderLines } =
		blocks.length > 0
			? closeRivals(
					blocks.filter((b) => !skipped.has(b.number)),
					{
						transcript,
						record,
						houseDecision,
						silencedShape,
						isLastRefusal,
						corpus: readCorpus,
					},
				)
			: { reason: "", refused: [], checks: [], ladderLines: [] };
	const missing = RUNGS.filter((rung) =>
		checks.some((check) => check.missing?.includes(rung)),
	);
	return {
		prefix: CLOSE_RIVALS_PREFIX,
		reason,
		rounds: [
			...checks.map((check) => check.round),
			...blocks.map((b) => b.number).filter((n) => passed.has(n)),
		],
		refusing: refusingRounds(checks, false),
		onBlocked: (slot) => {
			limb.write(sessionId, [...refused, ...passes]);
			limb.appendLog(sessionId, () => refusedChecks(checks, slot, false));
		},
		onPassed: (capSpent) => {
			/* Its questions reach the founder, so a round reusing a number once
			 * a new turn starts is a new question, not a re-price (workflow-core#489). */
			limb.writePasses(
				sessionId,
				record,
				checks.map((c) => c.round),
			);
			limb.appendLog(sessionId, () => passedChecks(checks, capSpent));
		},
		ladder: {
			prefix: RESEARCH_LADDER_PREFIX,
			reason:
				ladderLines.length > 0
					? ladderReason(ladderLines, {
							missing,
							corpus: readCorpus(),
							last: isLastLadder
								? lastRefusal("climb the missing rungs", false)
								: null,
						})
					: "",
			refusing: refusingRounds(checks, true),
			onBlocked: (slot) =>
				limb.appendLog(sessionId, () => refusedChecks(checks, slot, true)),
		},
	};
}

module.exports = {
	CLOSE_GAP,
	LOW_TOP,
	rivalPair,
	topOf,
	caughtBy,
	isRefusal,
	closeRivalsTurn,
};
