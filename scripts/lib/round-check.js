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
	buildShapeOnlyReason,
} = require("./shape-hold");

const since = () => require("./tool-calls-since");

// guess, #1684
const MIN_CALLS = 10;

/** @param {number | null} callsBefore */
const isUnderResearched = (callsBefore) =>
	callsBefore !== null && callsBefore < MIN_CALLS;

/**
 * @typedef {{ number: string, callsBefore: number, sentAt?: number,
 *   refusedAt?: number }} Held
 * @typedef {Held & { refusedAt: number }} Refused
 * @typedef {import("./refusal-limb").Passed} Passed
 * @typedef {{ at: number, questions: (Held | Passed)[] }} RefusalRecord
 */

/**
 * @param {Held} q
 * @returns {q is Refused}
 */
function isRefused(q) {
	return q.refusedAt !== undefined;
}

/**
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
 * @typedef {{ round: string, refuse: boolean, callsBefore: number | null,
 *   shape: string[], prior?: Refused, sinceRefusal?: number | null,
 *   tools?: string[] | null, resent?: boolean, sentAt?: number }} Check
 * @typedef {"refused" | "refused-misshapen" | "passed-after-refusal" | "passed-at-cap" | "passed-unrefused"} RoundLogKind
 * @typedef {Omit<Check, "refuse" | "prior" | "shape" | "sentAt"> &
 *   { kind: RoundLogKind, slot: number, firstSent?: string }} RoundCheckLine
 */

/** @typedef {import("./shape-hold").Flag} Flag */

/**
 * @param {Check} check
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
 * @param {Flag[]} flags
 * @param {string} houseDecision
 * @param {boolean} isLastRefusal
 */
function reasonOf(flags, houseDecision, isLastRefusal) {
	const misshapen = isMisshapen(flags);
	return (
		buildShapeOnlyReason(flags, isLastRefusal) ??
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
 * @param {Refused} prior
 * @param {string | undefined} transcript
 * @param {string[] | undefined} shape
 * @param {boolean} rivalLimbsRefuse
 * @returns {Check}
 */
function judgeRefused(prior, transcript, shape, rivalLimbsRefuse) {
	const tools = limb.fromTranscript(transcript, "passed", (file) =>
		since().toolNamesSince(file, prior.refusedAt),
	);
	const resent = shape !== undefined;
	return {
		round: prior.number,
		refuse:
			!rivalLimbsRefuse &&
			resent &&
			((tools !== null && tools.length === 0) || shape.length > 0),
		callsBefore: prior.callsBefore,
		shape: rivalLimbsRefuse ? [] : (shape ?? []),
		prior,
		sinceRefusal: tools?.length ?? null,
		tools,
		resent,
	};
}

/** @typedef {import("./shape-hold").ShapeFaults} ShapeFaults */

/**
 * @param {string} message
 * @param {{ transcript?: string, record: RefusalRecord | null,
 *   closeJudged: Set<string>, rivalLimbsRefusing: Set<string>,
 *   silencedShape: ShapeFaults | null }} turn
 * @returns {Check[]}
 */
function judgeQuestions(
	message,
	{ transcript, record, closeJudged, rivalLimbsRefusing, silencedShape },
) {
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
		else if (!closeJudged.has(q.number)) firstSends.set(q.number, q);
	}
	const sent = blocks
		.filter(
			(block) =>
				!closeJudged.has(block.number) &&
				!caughtBy(block) &&
				!passed.has(block.number),
		)
		.map((block) => block.number);
	const fresh = sent.filter((n) => !priors.some((q) => q.number === n));
	const callsNow = fresh.some((n) => !firstSends.has(n))
		? limb.fromTranscript(transcript, "passed", (file) =>
				since().sinceFounder(file),
			)
		: null;
	return [
		...priors.map((q) =>
			judgeRefused(
				q,
				transcript,
				shapeOf.get(q.number),
				rivalLimbsRefusing.has(q.number),
			),
		),
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
 * @returns {RoundLogKind | null}
 */
function passKind({ prior, callsBefore }, capSpent) {
	if (prior) return "passed-after-refusal";
	if (!isUnderResearched(callsBefore)) return "passed-unrefused";
	return capSpent ? "passed-at-cap" : null;
}

/**
 * @param {string} message
 * @param {{ sessionId: string, transcript?: string,
 *   stored: RefusalRecord | null | "unreadable",
 *   houseDecision: () => string,
 *   closeJudged: string[], rivalLimbsRefusing: string[],
 *   silencedShape: ShapeFaults | null, isLastRefusal: boolean }} turn
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
		closeJudged,
		rivalLimbsRefusing,
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
					closeJudged: new Set(closeJudged),
					rivalLimbsRefusing: new Set(rivalLimbsRefusing),
					silencedShape,
				});
	const refusals = checks
		.filter((c) => c.refuse)
		.map((check) => ({ check, flag: flagOf(check) }));
	/** @param {{ refusing: boolean }} block */
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
 * @param {{ session: string, at: string, kind: RoundLogKind,
 *   callsBefore?: number | null, firstSent?: string }[]} events
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
