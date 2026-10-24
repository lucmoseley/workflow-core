/*
 * round-check.js — the priced-options guard's under-researched-round limb
 * (workflow-core#1710, ruled at workflow-core#1684). The rule it applies is written in
 * guard-priced-options.js's header (the paragraph after the close-check log's).
 *
 * THE LOG, `ROUND_CHECK_LOG` in the markers directory, written through
 * refusal-log.js's writer: one line per question the close-rivals limb does
 * not catch, or refused one that limb then took (workflow-core#2076), at the Stop that
 * decides it, for the reading workflow-core#1691 specifies. A refused question that comes
 * back caught, close or low-top, also takes a line at each re-send this limb
 * refuses where neither the close limb's refusal nor the ladder's goes out:
 * `refused` when bare, `refused-misshapen` when still misshapen (workflow-core#2244).
 * Kinds:
 *   refused               refused, on first sight or re-sent with no tool call
 *   refused-misshapen     a refused question re-sent after a tool call, or
 *                         where the transcript cannot say, with its shape
 *                         still wrong while the shape limb is silent (workflow-core#1730)
 *   passed-after-refusal  a refused question let through on a later send
 *   passed-at-cap         a question never refused, let through because the
 *                         limb's cap of 3 is spent
 *   passed-unrefused      a question asked after 10 or more tool calls, or
 *                         whose count the transcript could not give
 * Every line carries `callsBefore` (tool calls since the founder last spoke,
 * at the question's first send; null where the transcript cannot say) and
 * `slot` (the limb's counter: after this block's charge on a refusal, as it
 * stands on a pass). A line after a refusal adds `sinceRefusal` and `tools`,
 * the tool calls since it and their names, and a pass of a question an
 * earlier, blocked send carried adds `resent`, false where the passing send
 * left it out, and `firstSent`, its first send's time, where that was an
 * earlier Stop's (workflow-core#1949).
 *
 * A PASS IS KEPT IN THE RECORD WHILE ANOTHER STOP HOOK REFUSES ITS TURN
 * (workflow-core#1799), since this limb cannot see a sibling's block: the re-send is the
 * same question, neither judged nor logged again, by this limb or, re-priced
 * into the close-rivals limb's tests, close or low-top, by that limb (workflow-core#1949).
 * Once anything starts a new turn (`tool-calls-since.js`'s
 * `isTurnRefusedSince`), a round reusing the number is a new question.
 */

const {
	ROUND_CHECK_LOG,
	ROUND_CHECK_PREFIX,
	ROUND_CHECK_RECORD_PREFIX,
} = require("./priced-options-limbs");
const { caughtBy } = require("./close-rivals");
const {
	RESEND_ONLY,
	isPassed,
	passedNumbers,
	lastRefusal,
	refusalLimb,
} = require("./refusal-limb");
const { splitQuestions } = require("./round-marker");
const {
	SHAPE_HELD,
	isMisshapen,
	buildMisshapenFlag,
	buildRuleFlag,
	shapeOnlyReason,
} = require("./shape-hold");

/* Tool calls since the founder's last message below which a round is sent
 * back (workflow-core#1684). */
const MIN_CALLS = 10;

/** @param {number | null} callsBefore */
const isUnderResearched = (callsBefore) =>
	callsBefore !== null && callsBefore < MIN_CALLS;

/**
 * A question a blocked send carried this session, so it keeps the count from
 * its first send (workflow-core#1751): its round number, the tool calls before that send,
 * when that send was (workflow-core#1949) and, where this limb refused it, when. The record
 * holds these beside the questions a passing send carried (`Passed`, workflow-core#1799);
 * `at`, when it was written.
 * @typedef {{ number: string, callsBefore: number, sentAt?: number,
 *   refusedAt?: number }} Held
 * @typedef {Held & { refusedAt: number }} Refused
 * @typedef {import("./refusal-limb").Passed} Passed
 * @typedef {{ at: number, questions: (Held | Passed)[] }} RefusalRecord
 */

/** @type {(q: Held) => q is Refused} */
const isRefused = (q) => q.refusedAt !== undefined;

/**
 * One recorded question, or null where it is malformed.
 * @param {Record<string, unknown>} question
 * @returns {Held | null}
 */
function parseHeld({ number, callsBefore, sentAt, refusedAt }) {
	if (typeof number !== "string" || typeof callsBefore !== "number")
		return null;
	if (sentAt !== undefined && typeof sentAt !== "number") return null;
	if (refusedAt !== undefined && typeof refusedAt !== "number") return null;
	return {
		number,
		callsBefore,
		...(typeof sentAt === "number" ? { sentAt } : {}),
		...(typeof refusedAt === "number" ? { refusedAt } : {}),
	};
}

const limb = refusalLimb({
	prefix: ROUND_CHECK_RECORD_PREFIX,
	limb: "round-check",
	skipped: "limb skipped this turn",
	parseQuestion: parseHeld,
	log: ROUND_CHECK_LOG,
});

/**
 * One question as this limb judged it this Stop. `shape`, its shape
 * faults where the shape limb is silent this turn, and empty otherwise.
 * @typedef {{ round: string, refuse: boolean, callsBefore: number | null,
 *   shape: string[], prior?: Refused, sinceRefusal?: number | null,
 *   tools?: string[] | null, resent?: boolean, sentAt?: number }} Check
 * @typedef {"refused" | "refused-misshapen" | "passed-after-refusal" | "passed-at-cap" | "passed-unrefused"} RoundLogKind
 * @typedef {Omit<Check, "refuse" | "prior" | "shape" | "sentAt"> &
 *   { kind: RoundLogKind, slot: number, firstSent?: string }} RoundCheckLine
 */

/** @typedef {import("./shape-hold").Flag} Flag */

/**
 * A refused check's line in the refusal: on shape alone where it is re-sent
 * after a tool call, or where the transcript cannot say.
 * @param {Check} check a refused one
 * @returns {Flag}
 */
function flagOf({ round, prior, callsBefore, shape, sinceRefusal }) {
	if (prior !== undefined && sinceRefusal !== 0)
		return buildMisshapenFlag(round, shape);
	return buildRuleFlag(
		prior
			? `Q${round}: re-sent with no tool call since this check refused it.`
			: `Q${round}: ${callsBefore} tool call${callsBefore === 1 ? "" : "s"} ` +
					`since the founder last spoke, under the ${MIN_CALLS} this check ` +
					"asks for before a round.",
		shape,
	);
}

/**
 * @param {Flag[]} flags the refused checks' lines
 * @param {string} houseDecision the house-decision rule's text (workflow-core#1683)
 * @param {boolean} isLastRefusal whether this refusal spends the limb's cap
 */
function reasonOf(flags, houseDecision, isLastRefusal) {
	const misshapen = isMisshapen(flags);
	return (
		shapeOnlyReason(flags, isLastRefusal) ??
		[
			"This turn puts a question to the founder before the session has " +
				"researched it:",
			flags.map((flag) => flag.line).join("\n"),
			houseDecision,
			isLastRefusal
				? lastRefusal("research it", misshapen)
				: "It passes on its next send once any tool call has run since this " +
					"refusal; a re-send with none is refused again.",
			!isLastRefusal && misshapen ? SHAPE_HELD : "",
			RESEND_ONLY,
		]
			.filter(Boolean)
			.join("\n\n")
	);
}

/**
 * A question this limb already refused: refused again where no tool call has
 * run since, or where its shape is still wrong, and passed otherwise — or
 * where it was left out of this send or the close-rivals or research-ladder
 * limb refuses it.
 * @param {Refused} prior
 * @param {string | undefined} transcript
 * @param {string[] | undefined} shape its shape faults; undefined where this
 *   send left it out
 * @param {boolean} closeRefuses whether the close-rivals or research-ladder
 *   limb refuses it this send, which takes that refusal and never this one's
 *   (workflow-core#2076)
 * @returns {Check}
 */
function judgeRefused(prior, transcript, shape, closeRefuses) {
	const tools = limb.fromTranscript(transcript, "passed", (since, file) =>
		since.toolNamesSince(file, prior.refusedAt),
	);
	const resent = shape !== undefined;
	return {
		round: prior.number,
		refuse:
			!closeRefuses &&
			resent &&
			((tools !== null && tools.length === 0) || shape.length > 0),
		callsBefore: prior.callsBefore,
		shape: closeRefuses ? [] : (shape ?? []),
		prior,
		sinceRefusal: tools?.length ?? null,
		tools,
		resent,
	};
}

/** @typedef {import("./shape-hold").ShapeFaults} ShapeFaults */

/**
 * Judge every question in `message` the close-rivals limb does not catch
 * (`caughtBy`), and every question this limb refused, against the record.
 * @param {string} message
 * @param {{ transcript?: string, record: RefusalRecord | null,
 *   close: { judged: Set<string>, refusing: Set<string> },
 *   silencedShape: ShapeFaults | null }} turn
 * @returns {Check[]}
 */
function judgeQuestions(message, { transcript, record, close, silencedShape }) {
	const blocks = splitQuestions(message);
	const shapeOf = new Map(
		blocks.map((block) => [block.number, silencedShape?.(block) ?? []]),
	);
	const passed = new Set(passedNumbers(record));
	/** @type {Refused[]} */
	const priors = [];
	/** @type {Map<string, Held>} */
	const firstSends = new Map();
	for (const q of record?.questions ?? []) {
		if (isPassed(q)) continue;
		if (isRefused(q)) priors.push(q);
		else if (!close.judged.has(q.number)) firstSends.set(q.number, q);
	}
	const sent = blocks
		.filter(
			(block) =>
				!close.judged.has(block.number) &&
				!caughtBy(block) &&
				!passed.has(block.number),
		)
		.map((block) => block.number);
	const fresh = sent.filter((n) => !priors.some((q) => q.number === n));
	const callsNow = fresh.some((n) => !firstSends.has(n))
		? limb.fromTranscript(transcript, "passed", (since, file) =>
				since.sinceFounder(file),
			)
		: null;
	return [
		/* Where the close-rivals or research-ladder limb's refusal goes out
		 * this send, judged only so a pass pairs this limb's refusal in the
		 * log (workflow-core#2076); where it will not, its cap spent or its rule passing
		 * the question, judged on this limb's own, so a bare re-send cannot
		 * clear it (workflow-core#2244). The close-rivals and research-ladder limbs refuse
		 * only rounds the close-rivals limb judged, so a question it never
		 * judged is always judged on this limb's own. Checks follow record
		 * order, and the refusal and log lines with them (workflow-core#2576). */
		...priors.map((q) =>
			judgeRefused(
				q,
				transcript,
				shapeOf.get(q.number),
				close.refusing.has(q.number),
			),
		),
		/* A held question this send leaves out reached the founder on an
		 * earlier, blocked send, so it passes with this turn, if this turn
		 * passes. */
		...[...firstSends.values()]
			.filter((q) => !sent.includes(q.number))
			.map(({ number, callsBefore, sentAt }) => ({
				round: number,
				refuse: false,
				callsBefore,
				shape: [],
				resent: false,
				sentAt,
			})),
		...fresh.map((round) => {
			const held = firstSends.get(round);
			const callsBefore = held ? held.callsBefore : callsNow;
			return {
				round,
				refuse: isUnderResearched(callsBefore),
				callsBefore,
				shape: shapeOf.get(round) ?? [],
				sentAt: held?.sentAt,
			};
		}),
	];
}

/**
 * @param {Check} check
 * @param {RoundLogKind} kind
 * @param {number} slot
 * @returns {RoundCheckLine}
 */
function lineOf(
	{ refuse: _r, prior: _p, resent, shape: _s, sentAt, ...rest },
	kind,
	slot,
) {
	/** @type {RoundCheckLine} */
	const line = {
		...rest,
		kind,
		slot,
		...(sentAt === undefined
			? {}
			: { firstSent: new Date(sentAt).toISOString() }),
	};
	return resent !== undefined && kind.startsWith("passed")
		? { ...line, resent }
		: line;
}

/**
 * @param {Check} check
 * @param {boolean} capSpent
 * @returns {RoundLogKind | null} its kind on a passing Stop
 */
function passKind({ prior, callsBefore }, capSpent) {
	if (prior) return "passed-after-refusal";
	if (!isUnderResearched(callsBefore)) return "passed-unrefused";
	/* A refusal let through with the cap unspent — an unwritable counter — is
	 * logged as nothing, as the close limb does. */
	return capSpent ? "passed-at-cap" : null;
}

/**
 * This limb's verdict on one turn, for the guard to batch with its others, in
 * the shape of close-rivals.js's `closeRivalsTurn`: `onBlocked` once a block
 * carrying this limb has gone out, with its counter after that block's
 * charge; `onBlockedElsewhere` once a block without it has; `onPassed` once
 * the turn is let through, with its counter and whether that is spent.
 * @param {string} message the outgoing assistant message
 * @param {{ sessionId: string, transcript?: string,
 *   stored: RefusalRecord | null | "unreadable",
 *   houseDecision: () => string,
 *   close: { judged: string[], refusing: string[] },
 *   silencedShape: ShapeFaults | null, isLastRefusal: boolean }} turn
 *   `close.judged`, the questions the close-rivals limb judged this send;
 *   `close.refusing`, those of them whose close-rivals or research-ladder
 *   refusal goes out this send, which alone keep a question this limb refused
 *   from its own rule (workflow-core#2244);
 *   `silencedShape`, the guard's
 *   own shape check, passed in since a lib cannot require the guard program,
 *   and given only where the shape limb will not speak this turn (workflow-core#1730);
 *   `isLastRefusal`, whether a block refusing here would spend this limb's cap
 * @returns {{ prefix: string, reason: string,
 *   onBlocked: (slot: number) => void, onBlockedElsewhere: () => void,
 *   onPassed: (capSpent: boolean, slot: number) => void }}
 */
function roundCheckTurn(
	message,
	{
		sessionId,
		transcript,
		stored,
		houseDecision,
		close,
		silencedShape,
		isLastRefusal,
	},
) {
	const record = stored === "unreadable" ? null : stored;
	const checks =
		stored === "unreadable" || (!record && splitQuestions(message).length === 0)
			? []
			: judgeQuestions(message, {
					transcript,
					record,
					close: {
						judged: new Set(close.judged),
						refusing: new Set(close.refusing),
					},
					silencedShape,
				});
	const refusals = checks
		.filter((c) => c.refuse)
		.map((check) => ({ check, flag: flagOf(check) }));
	/**
	 * Hold this send's new questions with their counts and first sends,
	 * `refusedAt` stamped on those this block refuses, beside what the record
	 * already holds.
	 * @param {{ refusing: boolean }} block whether it carries this limb
	 */
	const hold = ({ refusing }) => {
		const now = Date.now();
		const toHold = checks.filter(
			(c) => !c.prior && typeof c.callsBefore === "number",
		);
		limb.write(sessionId, [
			...toHold.map((c) => ({
				number: c.round,
				callsBefore: /** @type {number} */ (c.callsBefore),
				sentAt: c.sentAt ?? now,
				...(c.refuse && refusing ? { refusedAt: now } : {}),
			})),
			...(record?.questions ?? []).filter(
				(q) => !toHold.some((c) => c.round === q.number),
			),
		]);
	};
	return {
		prefix: ROUND_CHECK_PREFIX,
		reason:
			refusals.length > 0
				? reasonOf(
						refusals.map((refusal) => refusal.flag),
						houseDecision(),
						isLastRefusal,
					)
				: "",
		onBlocked: (slot) => {
			hold({ refusing: true });
			limb.appendLog(sessionId, () =>
				refusals.map(({ check, flag }) =>
					lineOf(check, flag.shapeOnly ? "refused-misshapen" : "refused", slot),
				),
			);
		},
		onBlockedElsewhere: () => hold({ refusing: false }),
		onPassed: (capSpent, slot) => {
			limb.writePasses(
				sessionId,
				record,
				checks.map((c) => c.round),
			);
			limb.appendLog(sessionId, () => {
				/** @type {RoundCheckLine[]} */
				const lines = [];
				for (const c of checks) {
					const kind = passKind(c, capSpent);
					if (kind) lines.push(lineOf(c, kind, slot));
				}
				return lines;
			});
		},
	};
}

/**
 * A question's first send, with its count: a refusal that is not a re-send's,
 * or a pass that never followed a refusal. One per Stop, keyed by session and
 * the time of that send — a line's own, or its `firstSent` where it is a
 * question held from an earlier Stop (workflow-core#1949).
 * @param {{ session: string, at: string, kind: RoundLogKind,
 *   callsBefore?: number | null, firstSent?: string }[]} events  the log's lines
 * @returns {Map<string, number>}
 */
function firstDrafts(events) {
	/** @type {Map<string, number>} */
	const drafts = new Map();
	for (const e of events) {
		const first =
			(e.kind === "refused" && !("sinceRefusal" in e)) ||
			e.kind === "passed-unrefused" ||
			e.kind === "passed-at-cap";
		if (first && typeof e.callsBefore === "number")
			drafts.set(`${e.session} ${e.firstSent ?? e.at}`, e.callsBefore);
	}
	return drafts;
}

/**
 * This limb's record, read once a Stop for `roundCheckTurn` and the
 * close-rivals limb, which leaves this one the questions it holds as passed
 * (workflow-core#1949).
 * @param {string} sessionId
 * @param {string | undefined} transcript
 * @returns {RefusalRecord | null | "unreadable"}
 */
const readRoundRecord = (sessionId, transcript) =>
	limb.readLive(sessionId, transcript);

module.exports = {
	roundCheckTurn,
	readRoundRecord,
	firstDrafts,
	MIN_CALLS,
};
