#!/usr/bin/env node

// #2645
const disarmLoadFailure =
	require.main === module
		? require("./lib/load-failure-stop").armLoadFailureStop(
				"the lettered priced round, the founder hand-over, a credential " +
					"asked by any route but `write-secret.js`, the status marker",
			)
		: require("./lib/noop.js").noop;

const hookMessage = require("./lib/hook-message");
const hookBlock = require("./lib/hook-block");
const { founderPointer } = require("./lib/founder-pointer.js");
const { beforeMatch } = require("./lib/cut-at.js");
const {
	groupByPrefix,
	isLive,
	liveGroups,
	ceilingPlan,
	blockOn,
	limbCounter,
} = require("./lib/priced-options-ceiling");
const stopGuard = require("./lib/stop-guard");
const { parseStatus } = require("./lib/status-marker");
const { isBackgroundJob } = require("./lib/job-paths");
const { INVENTORY } = require("./lib/inventory-format");
/** @typedef {import("./lib/status-marker").StatusReading} StatusReading */
const { escapeRe, requiredGroup } = require("./lib/regex-group");
const {
	OPTION_LABEL_PREFIX,
	OPTION_LABEL,
	PRICED,
	CONFIDENCE_ANY,
	RELATION_LINE,
	COMBINABLE,
	splitQuestions,
	optionSpans,
	parseOptionBody,
	parseRelationLine,
	isRivalSet,
} = require("./lib/round-marker");
const {
	CODE_SPAN,
	CLAUSE_REACH,
	hasSecretRoute,
	hasBangSecretRoute,
	ROUTE_SHAPE,
	withoutConfidence,
	askPhrase,
	proseAsk,
} = require("./lib/secret-ask");
const {
	readOutputStylePath,
	resolveKey,
} = require("./lib/workflow-core-config");
const { failOpenLogger } = require("./lib/fail-open-logger");
const {
	BANG,
	NAMES_A_LETTER,
	parkKind,
	shareChecklist,
} = require("./lib/needs-input-shape");

const {
	SESSION_PREFIX,
	SHAPE_PREFIX,
	NEEDS_INPUT_ROUND_PREFIX,
	FOUNDER_ACT_PREFIX,
	ACTOR_ONLY_PREFIX,
	COMPLETED_WHILE_WAITING_PREFIX,
	NEEDS_INPUT_UNDERCUT_PREFIX,
	NEEDS_INPUT_MISPLACED_PREFIX,
	RESULT_MISPLACED_PREFIX,
	UNMARKED_STOP_PREFIX,
	MISSING_NEEDS_INPUT_PREFIX,
	EMPTY_MARKER_PREFIX,
	WAITING_IN_JOB_PREFIX,
	CLOSE_RIVALS_PREFIX,
	ROUND_CHECK_PREFIX,
	RESEARCH_LADDER_PREFIX,
} = require("./lib/priced-options-limbs");
const { closeRivalsTurn } = require("./lib/close-rivals");
const { readRoundRecord, roundCheckTurn } = require("./lib/round-check");
const { passedNumbers } = require("./lib/refusal-limb");

const OPTION_TITLE_BOLD = /^\s{0,3}\([A-Z]\)\s+\*\*/;
const OPENER_CHARS = 40;

const UNPRICEABLE_WORDS = [
	"unknowable",
	"ungroundable",
	"unquantifiable",
	"not quantifiable",
	"subjective",
];
const UNPRICEABLE = new RegExp(`\\b(${UNPRICEABLE_WORDS.join("|")})\\b`, "i");

const CLASSIFIER_TAIL_CHARS = 4000;

const FORWARD_WORK =
	/\bI(?:'ll|'d| will| can| could)\s+(?:then\s+|also\s+)?(build|write|draft|set|apply|implement|create|add|make|run|do|open|file|commit|push|start|wire|land|finish|carry)\b/i;

/**
 * @param {StatusReading} status
 * @param {string[]} [names]
 * @returns {string}
 */
function decoratedMarker(
	status,
	names = ["result:", "waiting:", "needs input:"],
) {
	const { decorated } = status;
	if (!decorated || !names.includes(decorated.name)) return "";
	const { name, lead } = decorated;
	return (
		"This turn ends a background job on a decorated status marker — `" +
		name +
		"` led by `" +
		lead +
		"` — and no bare one. The job-status classifier files a decorated " +
		"marker less reliably than a bare one, so the job may be filed as if it " +
		"carried none. Rewrite the same marker bare, with no backtick, bold, " +
		"italic or quote around it, as the last line:\n\n" +
		name +
		" <what the marker is for>"
	);
}

const APPROVAL_SEEKING = [
	{ gist: "say the word", re: /\bsay the word\b/i },
	{ gist: "shall i", re: /\bshall I\b/i },
	{ gist: "want me to", re: /\bwant me to\b/i },
	{ gist: "would you like me to", re: /\bwould you like me to\b/i },
	{ gist: "let me know if", re: /\blet me know if\b/i },
	{
		gist: "i'll \u2026 if you",
		re: /\bI(?:'ll|'d| will| can| could)\b[^.\n]{0,80}\bif you\b/i,
	},
	{
		gist: "pending approval",
		re: /\b(?:pending|awaiting|subject to)\s+(?:your\s+)?(?:approval|sign-?off|the go-ahead)\b/i,
	},
	{
		gist: "i'm ready to",
		re: /\b(?:I(?:'m| am)|we(?:'re| are))\s+ready to\b/i,
	},
	{ gist: "if you'd like", re: /\bif you(?:'d| would)? like\b/i },
];

const SUM_SLACK = 5;

const TABLE_ROW = /^\s{0,3}\|.*\|/;
const HORIZONTAL_RULE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const NUMBERED_ITEM = /^\s{0,3}\d+[.)]\s+\S/;
const RECOMMENDATION = /^\s{0,3}\u27a1/u;
const BULLET_ITEM = /^\s{0,3}[-*+]\s+\S/;

/**
 * @typedef {{ letter: string, confidence: number | null }} Option
 * @typedef {{ letter: string, confidence: number }} PricedOption
 */

/**
 * @param {Option} o
 * @returns {o is PricedOption}
 */
function isPriced(o) {
	return o.confidence !== null;
}

/**
 * @param {string[]} lines
 * @returns {string[]}
 */
function unletteredDefects(lines) {
	const body = lines.join("\n");
	const numbered = lines.filter((l) => NUMBERED_ITEM.test(l)).length;
	const bulleted = lines.filter((l) => BULLET_ITEM.test(l)).length;
	if (numbered >= 2 || bulleted >= 2) {
		return [
			"its options are listed as a " +
				(numbered >= 2 ? "numbered" : "bulleted") +
				" list instead of lettered (A)/(B)/(C) options, so none of them is priced",
		];
	}
	if (!UNPRICEABLE.test(body)) {
		return [
			"it offers no lettered options at all. A question put to the founder " +
				"enumerates its answers as priced options — a yes/no is (A) yes and " +
				"(B) no, both priced. Obviousness is not an exemption and there is no " +
				"stakes threshold",
		];
	}
	return [];
}

/** @param {{ letter: string, span: string }[]} labelled */
function unpricedLetters(labelled) {
	const unpriced = [];
	const unbanded = [];
	for (const { letter, span } of labelled) {
		if (PRICED.test(span)) continue;
		if (CONFIDENCE_ANY.test(span)) unbanded.push(letter);
		else if (!UNPRICEABLE.test(span)) unpriced.push(letter);
	}
	return { unpriced, unbanded };
}

/**
 * @param {{ letter: string, span: string }[]} labelled
 * @returns {string[]}
 */
function pricingDefects(labelled) {
	/** @type {string[]} */
	const defects = [];
	const { unpriced, unbanded } = unpricedLetters(labelled);
	if (unpriced.length > 0) {
		defects.push(
			"option" +
				(unpriced.length > 1 ? "s " : " ") +
				unpriced.map((l) => `(${l})`).join(", ") +
				" carr" +
				(unpriced.length > 1 ? "y" : "ies") +
				" no Confidence line",
		);
	}
	if (unbanded.length > 0) {
		defects.push(
			"option" +
				(unbanded.length > 1 ? "s " : " ") +
				unbanded.map((l) => `(${l})`).join(", ") +
				" give" +
				(unbanded.length > 1 ? "" : "s") +
				" a bare percentage with no error band in brackets",
		);
	}
	return defects;
}

/**
 * @param {{ letter: string, line: string }[]} labelled
 * @returns {string[]}
 */
function boldTitleDefects(labelled) {
	const bolded = labelled.filter((o) => OPTION_TITLE_BOLD.test(o.line));
	if (bolded.length === 0) return [];
	return [
		"option" +
			(bolded.length > 1 ? "s " : " ") +
			bolded.map((o) => `(${o.letter})`).join(", ") +
			" give" +
			(bolded.length > 1 ? "" : "s") +
			" the option a bold or titled name, which this guard bans — " +
			bolded
				.map(
					(o) =>
						`(${o.letter}) opens \`${o.line.slice(0, OPENER_CHARS).trim()}…\``,
				)
				.join("; ") +
			". Only bold in the title slot is read; bold later is prose",
	];
}

/**
 * @param {string[]} lines
 * @param {{ span: string }[]} labelled
 * @returns {string[]}
 */
function letteredDefects(lines, labelled) {
	/** @type {string[]} */
	const defects = [];
	const rec = lines.filter((l) => RECOMMENDATION.test(l));
	if (rec.length > 0 && !rec.some((l) => NAMES_A_LETTER.test(l))) {
		defects.push(
			"its recommendation does not name an option by its letter, which is what " +
				"the founder replies with",
		);
	}

	const declared = lines.some((l) => RELATION_LINE.test(l));
	if (!declared) {
		defects.push(
			"it states no relation between its options. Lettered options read as " +
				"rivals for one slot, so a set that could be taken together is " +
				"answered by picking one of them. Add a line of its own, opening " +
				"`Relation:`, saying which pairs actually conflict and on what \u2014 " +
				"or that the options are independent",
		);
	}

	const sum = rivalFigureSum(lines, labelled);
	if (sum !== null && Math.abs(sum - 100) > SUM_SLACK) {
		defects.push(
			`its \`Relation:\` line declares the options rivals, but their figures sum to ${sum}%. ` +
				"Rivals' figures are the probability each option is the right choice, so " +
				"they sum to 100% — re-derive them as one split, or, where two options " +
				"can in fact be taken together, say so on the `Relation:` line",
		);
	}
	return defects;
}

/**
 * @param {string[]} lines
 * @param {{ span: string }[]} labelled
 * @returns {number | null}
 */
function rivalFigureSum(lines, labelled) {
	const figures = labelled.map((o) => {
		const m = o.span.match(CONFIDENCE_FIGURE);
		return m ? Number(m[1]) : null;
	});
	if (!isRivalSet(lines) || !figures.every((f) => f !== null)) return null;
	return figures.reduce((a, f) => a + Number(f), 0);
}

/**
 * @param {string[]} lines
 * @returns {string[]}
 */
function layoutDefects(lines) {
	/** @type {string[]} */
	const defects = [];
	if (lines.some((l) => TABLE_ROW.test(l))) {
		defects.push("it lays the options out as a table, which the format bans");
	}
	if (lines.some((l) => HORIZONTAL_RULE.test(l))) {
		defects.push(
			"it separates the options with a horizontal rule, which the format bans",
		);
	}
	return defects;
}

/**
 * @param {{number: string, lines: string[]}} block
 * @returns {string[]}
 */
function defectsIn(block) {
	const lines = block.lines;
	const labelled = optionSpans(lines);
	const lettered = labelled.length >= 2;
	return [
		...(lettered ? pricingDefects(labelled) : unletteredDefects(lines)),
		...boldTitleDefects(labelled),
		...(lettered ? letteredDefects(lines, labelled) : []),
		...layoutDefects(lines),
	];
}

const FENCED_BANG = String.raw`\x60{3}[^\n]*\n\s*${BANG}`;

const FOUNDER_ACT_CUES = [
	new RegExp(String.raw`\x60${BANG}[^\x60]*\x60|${FENCED_BANG}`),
	/\byou(?:'d| would| will|'ll| can| could)?\s+(?:then\s+|just\s+)?(?:paste|type|run|click|open|apply|edit)\b/i,
	/\bpaste\b/i,
	/\byourself\b/i,
	/\b(?:in|from)\s+a\s+(?:normal|separate|regular|plain)\s+terminal\b/i,
	/\bopen\s+(?:this|that|the)\s+(?:URL|link)\b/i,
	/\b(?:in|from|into)\s+your\s+(?:own\s+)?(?:terminal|shell|browser|session|dashboard)\b/i,
	/\bother repo(?:sitory)?'s session\b/i,
];
const PLACEHOLDER = /<[A-Za-z][^<>\n]*>|(?<!\S)\.\.\.|…/;
const BANG_LINE = new RegExp(String.raw`^\x60${BANG}|^${FENCED_BANG}`);
const HANDED_NOUNS = [
	"command",
	"line",
	"prompt",
	"step",
	"text",
	"snippet",
	"one-liner",
];
const nounGroup = (/** @type {string[]} */ nouns) => `(?:${nouns.join("|")})s?`;
const HANDED_TEXT = nounGroup(HANDED_NOUNS);
const POINTED_NOUNS = ["block", "code", "patch", "diff", "script"];
const TICKET_HELD_TEXT = nounGroup([...HANDED_NOUNS, ...POINTED_NOUNS]);
const ISSUE_HELD_TEXT = nounGroup(
	[...HANDED_NOUNS, ...POINTED_NOUNS].filter((noun) => noun !== "prompt"),
);
const BACK_REFERENCE = new RegExp(
	[
		String.raw`\b${HANDED_TEXT}\b[^.\n\x60]{0,${CLAUSE_REACH}}?\b(?:above|earlier|previous(?:ly)?|as before|I (?:gave|posted|sent))\b`,
		String.raw`\b(?:above|earlier|previous|prior)\s+(?:\w+\s+)?${HANDED_TEXT}\b`,
		String.raw`(?<![#\w-])issuecomment-\d+`,
		String.raw`\b${TICKET_HELD_TEXT}\s+(?:in|at|from|on)\s+(?:(?:my|the|that|this|your)\s+)?(?:\S+\s+)?comment\b`,
		String.raw`\b(?:in|from|at)\s+my\s+(?:\w+\s+)?comment\s+on\b`,
		String.raw`\b(?:${ISSUE_HELD_TEXT}|I (?:gave|posted|sent|wrote))\s+(?:in|at|from|on)\s+\x60?(?:(?:issue\s+)?#\d+|https?://\S*/(?:issues|pull)/\d+)`,
	].join("|"),
	"i",
);

const LETTER_REF = /\(([A-Z])\)/g;

/**
 * @param {string} body
 * @param {Map<string, string>} siblings
 * @returns {{ phrase: string, bang: boolean } | undefined}
 */
function secretAsk(body, siblings) {
	const text = withoutConfidence(body);
	const read = [
		text,
		...[...text.matchAll(LETTER_REF)]
			.slice(1)
			.map((m) => siblings.get(requiredGroup(m, 1, LETTER_REF)) ?? ""),
	];
	if (read.some(hasSecretRoute)) return;
	const phrase = askPhrase(text);
	if (!phrase) return;
	return { phrase, bang: read.some(hasBangSecretRoute) };
}

/** @param {string} phrase */
const quoted = (phrase) => `“${phrase.replace(/\s+/g, " ").slice(0, 80)}”`;

/**
 * @param {string} number
 * @param {string} letter
 * @param {string} phrase
 * @param {string} [kind]
 */
const buildFlaggedLine = (number, letter, phrase, kind) =>
	`Q${number} (${letter}): ${kind ? `${kind} ` : ""}${quoted(phrase)}`;

/**
 * @param {string} number
 * @param {string} letter
 * @param {{ phrase: string, bang: boolean }} secret
 */
const secretFlag = (number, letter, secret) =>
	buildFlaggedLine(number, letter, secret.phrase) +
	(secret.bang ? " — its `write-secret.js` line follows `!`" : "");

/**
 * @param {string} number
 * @param {string} letter
 * @param {string} span
 * @returns {string | undefined}
 */
function handedTextFlag(number, letter, span) {
	if (!FOUNDER_ACT_CUES.some((cue) => cue.test(span))) return;
	const codes = span.match(CODE_SPAN) ?? [];
	const placeholder = codes.find((code) => PLACEHOLDER.test(code));
	const literal = codes.some((code) => BANG_LINE.test(code));
	const phrase =
		placeholder ?? (literal ? undefined : span.match(BACK_REFERENCE)?.[0]);
	if (!phrase) return;
	return buildFlaggedLine(
		number,
		letter,
		phrase,
		placeholder ? "placeholder" : "back-reference",
	);
}

/**
 * @param {string[]} flagged
 * @param {string[]} secrets
 * @param {{ prose: string | undefined, bang: boolean, pointer: string | undefined }} found
 * @returns {string}
 */
function buildFounderActReason(flagged, secrets, { prose, bang, pointer }) {
	/** @type {string[]} */
	const leads = [];
	if (pointer)
		leads.push(
			"This turn sends the founder away for his steps — to the tracker, or " +
				"back to something given earlier:\n\n" +
				`${quoted(pointer)}\n\n` +
				"Write every step into this message instead (#4058).",
		);
	if (flagged.length > 0)
		leads.push(
			"This turn puts a founder act in a question option without the literal " +
				"text he would paste, type, run, click or open:\n\n" +
				flagged.join("\n"),
		);
	if (secrets.length > 0)
		leads.push(
			"This turn has the founder supply a credential in a question option by " +
				"a route other than `write-secret.js`, so its value can land in the " +
				"chat, a command line or this session's log — follow the SECRET " +
				"paragraph below:\n\n" +
				secrets.join("\n"),
		);
	if (prose)
		leads.push(
			"This turn's prose has the founder supply a credential, and no code " +
				"span in it is the `write-secret.js` route alone — `" +
				ROUTE_SHAPE +
				"`, " +
				"nothing beside it, and no line anywhere piping into it, exporting " +
				"a credential or copying `.env` — so its value can " +
				"land in the chat, a command line or this session's log — follow " +
				"the SECRET paragraph below:\n\n" +
				`${quoted(prose)}\n\n` +
				"Where that sentence asks for no credential, reword it so it does " +
				"not read as one.",
		);
	if (bang)
		leads.push(
			"A `write-secret.js` line after `!` runs on a stdin that is no " +
				"terminal, so no hidden prompt can show (#2554): a secret's line " +
				"goes in a normal terminal, never after `!`.",
		);
	return (
		leads.join("\n\n") +
		"\n\n" +
		readHandoverRule() +
		(prose || pointer
			? "\n\nRE-SEND THE CORRECTED MESSAGE."
			: "\n\nRE-SEND ONLY THE CORRECTED QUESTION, not the whole round.")
	);
}

/**
 * @param {string} message
 * @returns {string}
 */
function founderActRefusal(message) {
	/** @type {string[]} */
	const flagged = [];
	/** @type {string[]} */
	const secrets = [];
	let bang = false;
	for (const block of splitQuestions(message)) {
		const options = optionSpans(block.lines);
		const bodies = new Map(
			options.map((o) => [o.letter, parseOptionBody(o.span)]),
		);
		for (const option of options) {
			const span = parseOptionBody(option.span);
			const secret = secretAsk(span, bodies);
			if (secret) {
				secrets.push(secretFlag(block.number, option.letter, secret));
				bang ||= secret.bang;
			}
			const handed = handedTextFlag(block.number, option.letter, span);
			if (handed) flagged.push(handed);
		}
	}
	const prose = proseAsk(message);
	const pointer = founderPointer(message);
	if (flagged.length === 0 && secrets.length === 0 && !prose && !pointer)
		return "";
	if (prose) bang ||= hasBangSecretRoute(message);
	return buildFounderActReason(flagged, secrets, { prose, bang, pointer });
}

/** @returns {string} */
function readHouseDecisionRule() {
	return require("./lib/rule-text").readRuleTextOr(
		"house-decision",
		"Only a house decision reaches the founder: ask only what research " +
			"leaves open, and name that gap",
		"guard-priced-options house-decision",
	);
}

/** @returns {string} */
function readHandoverRule() {
	return require("./lib/rule-text").readRuleTextOr(
		"founder-handover",
		"Give the founder the exact literal text of each step, where to paste " +
			"it and what he should see. Where nothing stops you, act and report " +
			"rather than asking who does it, and name what does stop you on a " +
			"line of its own: `Blocked: <the refusal you hit, quoted, or the act " +
			"only a person can do>`",
		"guard-priced-options founder-hand-over",
	);
}

const FOUNDER_LEADS = ["You", "Founder"];
const AGENT_LEAD =
	/^(?:I(?:'ll|'d|'m)?|Me|Let me|The agent|This session)(?![\w'])/;
const AGENT_ABANDONS =
	/^(?:I(?:'ll|'d)?|Let me)\s+(?:revert|discard|undo|drop|leave|stop|skip|defer|abandon|file)\b/;
const BLOCKED_LINE =
	/^\s{0,3}(?:\*\*)?Blocked(?:\*\*)?:(?:\*\*)?\s*(?!\*\*\s*$)\S/i;

/** @returns {string[] | null} */
function corpusTrackers() {
	try {
		const corpus = resolveKey("corpus");
		return Array.isArray(corpus) ? corpus : null;
	} catch (e) {
		failOpenLogger("guard-priced-options research-ladder")?.(
			`corpus unreadable: ${e} — any tracker counts`,
		);
		return null;
	}
}

/** @returns {RegExp} */
function buildFounderLead() {
	const names = [...FOUNDER_LEADS];
	try {
		const declared = resolveKey("founder");
		if (typeof declared === "string" && declared.trim()) {
			const name = declared.trim();
			names.push(name, beforeMatch(name, /\s/));
		}
	} catch (e) {
		failOpenLogger("guard-priced-options actor-only")?.(
			`founder name unreadable: ${e} — You/Founder only`,
		);
	}
	return new RegExp(`^(?:${names.map(escapeRe).join("|")})(?![\\w])`);
}

/**
 * @param {string} message
 * @param {{ruleShown?: boolean}} [opts]
 * @returns {string}
 */
function actorOnlyRound(message, { ruleShown = false } = {}) {
	/** @type {string[]} */
	const flagged = [];
	const founder = buildFounderLead();
	for (const block of splitQuestions(message)) {
		if (block.lines.some((l) => BLOCKED_LINE.test(l))) continue;
		if (COMBINABLE.test(parseRelationLine(block.lines))) continue;
		const leads = optionSpans(block.lines).map((option) => ({
			letter: option.letter,
			head: option.line
				.replace(OPTION_LABEL_PREFIX, "")
				.replace(/^[*_]+/, "")
				.replace(/\u2019/g, "'"),
		}));
		if (leads.length < 2) continue;
		const theirs = leads.find((o) => founder.test(o.head));
		const ours = leads.find(
			(o) => AGENT_LEAD.test(o.head) && !AGENT_ABANDONS.test(o.head),
		);
		if (!theirs || !ours) continue;
		const quote = (/** @type {{letter: string, head: string}} */ o) =>
			`(${o.letter}) “${o.head.replace(/\s+/g, " ").slice(0, 60)}”`;
		flagged.push(`Q${block.number}: ${quote(theirs)} against ${quote(ours)}`);
	}
	if (flagged.length === 0) return "";
	return (
		"This turn asks the founder who performs an act — one option has him do " +
		"it, another has you do it — and says nothing about what stops you:\n\n" +
		flagged.join("\n") +
		"\n\nWhere nothing stops you, do not ask: act, then report what you " +
		"did. Where something does, keep the question and add the `Blocked:` " +
		"line the founder hand-over in this block states." +
		(ruleShown ? "" : `\n\n${readHandoverRule()}`) +
		"\n\nRE-SEND ONLY THE CORRECTED QUESTION, not the whole round."
	);
}

const shapePointer = () => `\`${readOutputStylePath()}\``;

const STANDING_ROUND_POINTER =
	"where a round you posted in an earlier turn still stands — the founder " +
	"has not replied since, and no Stop hook sent that turn back — point at it " +
	"by number instead of re-printing it: " +
	`\`needs input: Q1 above — <the decision> ${INVENTORY.refsTail}\` (#924).`;

/**
 * @param {StatusReading} status
 * @param {number} count
 * @returns {string}
 */
function missingNeedsInput(status, count) {
	if (status.last["needs input:"]) return "";
	const decorated = decoratedMarker(status, ["needs input:"]);
	if (decorated) return decorated;

	return (
		"This turn ends on " +
		count +
		" question(s) to the founder, so nothing but a human will wake this " +
		"session. The job-status classifier reads this message text alone, so a " +
		"round that ends by recommending an answer is filed Completed and the " +
		"founder is never told you are waiting. Two shapes pass.\n\n" +
		"First, re-send every round in one message with the marker below them, " +
		"as that message's last line:\n\n" +
		"<every round, in full>\n\n" +
		INVENTORY.needsInputLine +
		"\n\n" +
		"A marker sent alone, with the rounds left in this refused turn, has no " +
		"round above it and is refused again.\n\n" +
		`Second, ${STANDING_ROUND_POINTER}\n\n` +
		"A grilling round is human-in-the-loop, so you may not answer it yourself " +
		"and the marker is always owed."
	);
}

const FURTHER_WORK_OFFER =
	/(?:^|[\s(["'])#\d{1,5}\b|(?:^|[\s(["'])\/(?:implement|wayfinder|to-spec|to-tickets|triage|pick-next|card-close)\b|\bnext (?:ticket|issue|card|task|command)\b/i;

const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/;

/**
 * @param {string} message
 * @returns {string[]}
 */
function furtherWorkGists(message) {
	const gists = new Set();
	for (const span of message.split(SENTENCE_SPLIT)) {
		const offers = APPROVAL_SEEKING.filter((p) => p.re.test(span));
		if (offers.length === 0) continue;
		if (!FURTHER_WORK_OFFER.test(span)) return [];
		for (const offer of offers) gists.add(offer.gist);
	}
	return [...gists];
}

/**
 * @param {string} message
 * @param {StatusReading} status
 * @returns {string}
 */
function completedWhileWaiting(message, status) {
	if (!status.last["result:"]) return "";

	const found = APPROVAL_SEEKING.filter((p) => p.re.test(message)).map(
		(p) => p.gist,
	);
	if (found.length === 0) return "";

	const furtherWork = furtherWorkGists(message);
	if (furtherWork.length > 0) {
		return (
			"This turn writes `result:` and offers to take on the next ticket — " +
			furtherWork.map((g) => `"${g}"`).join(", ") +
			". The delivered task is done, so the founder is not blocked: what to " +
			"pick up next is `/pick-next`'s call, not a decision this session puts " +
			"to him. Do NOT switch to `needs input:` — that files a finished job as " +
			"blocked. Name the next task as a statement and delete the " +
			"approval-seeking phrase, keeping the `result:` line as the last line:\n\n" +
			"Next: <the ticket and its command>.\n\n" +
			INVENTORY.resultLine +
			"\n\n" +
			"Switch to `needs input:`, dropping the `result:` line, only if the " +
			"DELIVERED task is itself blocked on his decision."
		);
	}

	return (
		"This turn writes `result:` and still asks the founder for approval — " +
		found.map((g) => `"${g}"`).join(", ") +
		". The job-status classifier reads this message text alone, so `result:` " +
		"files the job Completed and a Completed job gets abandoned with its work " +
		"undone. Pick one:\n\n" +
		INVENTORY.needsInputLine +
		"\n\n" +
		"and drop the `result:` line — or, if the work really is done and the " +
		"offer is optional follow-up nobody need answer, say so without the " +
		"approval-seeking phrase."
	);
}

/**
 * @param {StatusReading} status
 * @returns {string}
 */
function needsInputUndercut(status) {
	const m = status.last["needs input:"];
	if (!m) return "";

	// #228
	if (m.below.trim()) return "";

	const { fromEnd } = m;
	if (fromEnd > CLASSIFIER_TAIL_CHARS) {
		return (
			"This turn's `needs input:` line is " +
			fromEnd +
			" characters from the end, and the job-status classifier is given only " +
			"the last " +
			CLASSIFIER_TAIL_CHARS +
			", so it cannot see the marker at all. Keep the marker's own line " +
			`short, naming the decision and its \`${INVENTORY.refsTail}\` tail, nothing ` +
			"else, and put what it " +
			"summarises above it."
		);
	}

	const found = FORWARD_WORK.exec(m.line);
	if (!found) return "";

	return (
		'This turn writes `needs input:` and then promises to keep working — "' +
		found[0] +
		'". The job-status classifier reads this message text alone and takes the ' +
		"strongest signal in it, so a marker trailed by work you are about to do " +
		"reads as a session still running and the job stays Working while it " +
		"waits on the founder. State the promise above the marker, in the past or " +
		"conditional, and end on the marker asking only for the decision:\n\n" +
		INVENTORY.needsInputLine
	);
}

/**
 * @param {StatusReading} status
 * @returns {string}
 */
function needsInputMisplaced(status) {
	const m = status.last["needs input:"];
	if (!m) return "";

	if (status.hasLaterMarker("needs input:")) return "";

	const below = m.below;
	if (!below.trim()) return "";

	return (
		"This turn writes `needs input:` and then keeps going — " +
		below.trim().length +
		" characters sit below it. The job-status classifier reads this message " +
		"text alone and takes the strongest signal in it, so a marker with the " +
		"round written underneath reads as a delivered conclusion and the job is " +
		"filed Completed while it waits on the founder. Put the round above and " +
		"end on the marker, as the last line:\n\n" +
		INVENTORY.needsInputLine
	);
}

/**
 * @param {StatusReading} status
 * @returns {string}
 */
function resultMisplaced(status) {
	const m = status.last["result:"];
	if (!m) return "";

	if (status.hasLaterMarker("result:")) return "";

	const below = m.below;
	if (below.trim()) {
		return (
			"This turn writes `result:` and then keeps going — " +
			below.trim().length +
			" characters of report sit below it. The job-status classifier reads " +
			"this message text alone and takes the strongest signal in it, so a " +
			"marker with the work written underneath reads as a session still " +
			"running and the job stays Working with nobody told it finished. Move " +
			"everything above the marker and end on it, as the last line:\n\n" +
			INVENTORY.resultLine
		);
	}

	const { fromEnd } = m;
	if (fromEnd > CLASSIFIER_TAIL_CHARS) {
		return (
			"This turn's `result:` line is " +
			fromEnd +
			" characters from the end, and the job-status classifier is given only " +
			"the last " +
			CLASSIFIER_TAIL_CHARS +
			", so it cannot see the marker at all. Keep the marker's own line short " +
			"and put what it summarises above it:\n\n" +
			INVENTORY.resultLine
		);
	}

	return "";
}

/**
 * @param {StatusReading} status
 * @returns {string}
 */
function unmarkedStop(status) {
	if (status.governing) return "";

	const decorated = decoratedMarker(status);
	if (decorated) return decorated;

	return (
		"This turn ends a background job carrying neither status marker. The " +
		"job-status classifier reads this message text alone and files the job on " +
		"the marker it finds, so a turn with none leaves the job sitting where it " +
		"stopped — its work committed and nobody told it finished. End on " +
		"whichever of these two is true, as the last line, holding the turn while " +
		"anything you launched still runs, waiting in the foreground only once " +
		"no other work is left:\n\n" +
		INVENTORY.resultLine +
		"\n" +
		INVENTORY.needsInputLine
	);
}

const RECOMMENDS_IN_PROSE = /\brecommend(?:s|ation|ations|ing|ed)?\b/i;

const OPTION_REF = /(?<!\d)(\d+)?(?<!\s)\s*\*{0,2}\(([A-Z])\)/g;

const CONFIDENCE_FIGURE = /Confidence:\s*(\d{1,3})\s*%/;

const WHY_NOT_LINE = /\bwhy not\s*\*{0,2}\(([A-Z])\)/gi;

/**
 * @param {string} message
 * @returns {Set<string>}
 */
function explainedLetters(message) {
	const out = new Set();
	WHY_NOT_LINE.lastIndex = 0;
	for (let m = WHY_NOT_LINE.exec(message); m; m = WHY_NOT_LINE.exec(message))
		out.add(requiredGroup(m, 1, WHY_NOT_LINE).toUpperCase());
	return out;
}

/**
 * @param {string} message
 * @returns {Option[][]}
 */
function optionGroups(message) {
	const lines = message.split("\n");
	/** @type {{ letter: string, at: number }[]} */
	const found = [];
	lines.forEach((line, i) => {
		const m = line.match(OPTION_LABEL);
		if (m) found.push({ letter: requiredGroup(m, 1, OPTION_LABEL), at: i });
	});

	/** @type {Option[][]} */
	const groups = [];
	/** @type {Option[]} */
	let current = [];
	found.forEach((opt, k) => {
		const prev = current.length > 0 ? current.at(-1) : null;
		if (!prev || opt.letter <= prev.letter) {
			current = [];
			groups.push(current);
		}
		const next = found[k + 1];
		const to = next ? next.at : lines.length;
		const span = lines.slice(opt.at, to).join("\n");
		const fig = span.match(CONFIDENCE_FIGURE);
		current.push({
			letter: opt.letter,
			confidence: fig ? Number(fig[1]) : null,
		});
	});
	return groups.filter((g) => g.some((o) => o.confidence !== null));
}

/**
 * @typedef {{ qn: number | null, letters: Set<string>, group: Option[] }} PickedQuestion
 * @typedef {{ label: string, picked: PricedOption, top: PricedOption, others: number }} PriceFault
 */

/**
 * @param {string} message
 * @returns {string[]}
 */
function parseRecommendationLines(message) {
	const lines = message.split("\n");
	/** @type {string[]} */
	const recLines = [];
	lines.forEach((line, i) => {
		if (!RECOMMENDS_IN_PROSE.test(line) && !RECOMMENDATION.test(line)) return;
		OPTION_REF.lastIndex = 0;
		if (OPTION_REF.test(line)) {
			recLines.push(line);
			return;
		}
		if (!line.trim().endsWith(":")) return;
		const next = lines.slice(i + 1).find((l) => l.trim());
		if (next && OPTION_LABEL.test(next)) recLines.push(next);
	});
	return recLines;
}

/**
 * @param {number | null} qn
 * @param {Option[][]} groups
 * @returns {number | null}
 */
function questionIndex(qn, groups) {
	if (qn) return qn - 1;
	if (groups.length === 1) return 0;
	return null;
}

/**
 * @param {string[]} recLines
 * @param {Option[][]} groups
 * @returns {Map<number, PickedQuestion>}
 */
function pickedLetters(recLines, groups) {
	/** @type {Map<number, PickedQuestion>} */
	const picked = new Map();
	for (const line of recLines) {
		OPTION_REF.lastIndex = 0;
		for (let m = OPTION_REF.exec(line); m; m = OPTION_REF.exec(line)) {
			const qn = m[1] ? Number(m[1]) : null;
			const index = questionIndex(qn, groups);
			const group = index === null ? undefined : groups[index];
			if (index === null || group === undefined) continue;
			const seen = picked.get(index) ?? { qn, letters: new Set(), group };
			picked.set(index, seen);
			seen.letters.add(requiredGroup(m, 2, OPTION_REF));
		}
	}
	return picked;
}

/**
 * @param {PickedQuestion} question
 * @param {Set<string>} explained
 * @returns {PriceFault | null}
 */
function priceFault({ qn, letters, group }, explained) {
	const priced = group.filter(isPriced);
	if (priced.length < 2) return null;

	const chosen = priced.filter((o) => letters.has(o.letter));
	if (chosen.length === 0) return null;
	const best = chosen.reduce((a, b) => (b.confidence > a.confidence ? b : a));

	const unexplained = priced.filter(
		(o) => o.confidence > best.confidence && !explained.has(o.letter),
	);
	if (unexplained.length === 0) return null;

	const top = unexplained.reduce((a, b) =>
		b.confidence > a.confidence ? b : a,
	);
	return {
		label: `${qn ? `Q${qn} ` : ""}(${best.letter})`,
		picked: best,
		top,
		others: unexplained.length - 1,
	};
}

/**
 * @param {PriceFault} f
 * @returns {string}
 */
function buildBelowPriceReason(f) {
	return (
		"This turn recommends " +
		f.label +
		", priced " +
		f.picked.confidence +
		"%, over (" +
		f.top.letter +
		"), which the same message priced " +
		f.top.confidence +
		"%" +
		(f.others ? ` (and ${f.others} other(s) priced above it)` : "") +
		" — and says nothing about why the lower figure wins. The founder can " +
		"only read one price per option as answering one question, so a " +
		"recommendation that goes the other way reads as a contradiction (mantahostels#1344).\n\n" +
		"Before rewriting, check the likelier fault: that the two figures price " +
		"DIFFERENT propositions. Pricing (" +
		f.top.letter +
		") on *is this right* while recommending " +
		f.label +
		" on *should we act now* is exactly the defect this exists to catch. If " +
		"that is what happened, re-price every option in that question on one " +
		"stated axis and let the recommendation follow.\n\n" +
		"Otherwise, keep the recommendation and add a line naming what you passed " +
		"over:\n\n" +
		"**Why not (" +
		f.top.letter +
		"):** <the cost or risk the price does not capture>\n\n" +
		"Then end the turn again."
	);
}

/**
 * @param {string} message
 * @returns {string}
 */
function recommendationBelowPrice(message) {
	const groups = optionGroups(message);
	if (groups.length === 0) return "";

	const recLines = parseRecommendationLines(message);
	if (recLines.length === 0) return "";

	const picked = pickedLetters(recLines, groups);
	const explained = explainedLetters(message);
	/** @type {PriceFault[]} */
	const faults = [];
	for (const question of picked.values()) {
		const fault = priceFault(question, explained);
		if (fault) faults.push(fault);
	}
	const [f] = faults;
	if (!f) return "";

	return buildBelowPriceReason(f);
}

/** @type {Partial<Record<import("./lib/status-marker").MarkerName, string>>} */
const TAUGHT_LINE = {
	"needs input:": INVENTORY.needsInputLine,
	"result:": INVENTORY.resultLine,
};

/**
 * @param {StatusReading} status
 * @returns {string}
 */
function emptyStatusMarker(status) {
	if (!status.governing) return "";
	const { name, payload } = status.governing;

	if (!payload.trim()) {
		return (
			"This turn ends on a bare `" +
			name +
			"` carrying nothing after the colon. The job-status classifier is a " +
			"model reading the message text, not a regex over the marker, so an " +
			"empty marker is a dangling fragment to it and the strongest signal " +
			"left is whatever sits above — a recommendation reads as a delivered " +
			"conclusion and the job files Completed while it waits on the " +
			"founder. Say what the marker is for, on the marker's own line:\n\n" +
			(TAUGHT_LINE[name] ?? `${name} <what will wake this session>`)
		);
	}
	return "";
}

/**
 * @param {string} message
 * @param {StatusReading} status
 * @param {string} [transcript]
 * @returns {string}
 */
function needsInputWithoutRound(message, status, transcript) {
	if (splitQuestions(message).length > 0) return "";

	const marker = status.governing;
	if (marker?.name !== "needs input:") return "";

	if (parkKind(message, marker.payload, transcript) !== "prose") return "";

	return (
		"This turn ends a background job on `needs input:` with no `\u2753 **Qn**` " +
		"round above it. The founder opens the job at exactly this text, and a " +
		"decision put as prose is one he cannot answer with a letter. Put it as a " +
		"round instead:\n\n" +
		"\u2753 **Q1** \u2014 <the decision, in one line>\n\n" +
		"Relation: <how the options relate \u2014 rivals for one slot, or combinable>\n\n" +
		"(A) <option>\n" +
		"Confidence: 70% (60% - 80%). <what drives it, one clause>\n\n" +
		"(B) <option>\n" +
		"Confidence: 30% (20% - 40%). <what drives it, one clause>\n\n" +
		"Then one recommendation, then the `needs input:` line last, naming the " +
		"decision and the issue the round is posted on, nothing else:\n\n" +
		INVENTORY.needsInputLine +
		"\n\nA yes/no is lettered too \u2014 (A) do it, (B) do " +
		"not \u2014 the round has no exemption for an obvious choice.\n\n" +
		"Three exceptions. First, a single founder act is not a decision: hand it over " +
		"instead \u2014 its literal `!` line or fenced text, then what to send back \u2014 with no " +
		"round and no lettered options (#926).\n\n" +
		`Second, ${STANDING_ROUND_POINTER}\n\n` +
		"Third, a job attached to an open repo hold (`repo-hold.js attach`): " +
		"its line names `hold <id>` and that hold's `#<issue>`.\n\n" +
		"If you are not blocked on a decision at all, the marker is the wrong one: " +
		"`result:` where nothing waits on the founder; while something you " +
		"launched runs, hold the turn until it reports, waiting in the foreground " +
		"only once no other work is left."
	);
}

/**
 * @param {StatusReading} status
 * @returns {string}
 */
function waitingInJob(status) {
	if (status.governing?.name !== "waiting:") return "";
	return (
		"This turn ends a background job on `waiting:`.\n\n" +
		require("./lib/rule-text").readRuleTextOr(
			"job-holds-turn",
			"A background job never ends its turn on `waiting:`: it holds the turn " +
				"until what it launched reports, waiting in the foreground only once " +
				"no other work is left",
			"guard-priced-options waiting",
		) +
		"\n\nThen end on what is true:\n\n" +
		INVENTORY.resultLine +
		"\n" +
		INVENTORY.needsInputLine
	);
}

/**
 * @param {number} count
 * @param {string[]} bad
 * @returns {string}
 */
function formatReason(count, bad) {
	const pointer = shapePointer();
	return (
		"This turn puts " +
		count +
		" question(s) to the founder and " +
		bad.length +
		" of them break the priced-options format that " +
		pointer +
		" requires and `scripts/inject-tracker-docs.js` pasted into this session " +
		"at start. Defective:\n\n" +
		bad.join("\n") +
		"\n\nThe lettered priced form is written out in " +
		pointer +
		" — read it there; each defect above states its own fix. Every option the " +
		"founder is asked to choose between is lettered and priced; the grilling " +
		"skill's round template governs WHICH questions you ask, this governs the " +
		"options INSIDE each one, and they compose — the round marker and the " +
		"recommendation arrow both stay.\n\n" +
		"RE-SEND ONLY THE CORRECTED QUESTION, not the whole round: the founder has " +
		"already read the rest. End the turn with the mandatory `needs input:` " +
		"line enumerating EVERY open question in the round, a few words each, " +
		`then its \`${INVENTORY.refsTail}\` tail.\n\n` +
		"The only escape is declaring a figure genuinely ungroundable: in place " +
		"of the option's figure, write one of these words and say why — " +
		UNPRICEABLE_WORDS.map((w) => `\`${w}\``).join(", ") +
		". Omitting the price is never the escape, and neither is a figure you " +
		"made up to satisfy this check."
	);
}

/**
 * @param {string} message
 * @returns {StatusReading | null}
 */
function jobStatus(message) {
	return isBackgroundJob(process.env) ? parseStatus(message) : null;
}

/**
 * @param {ReturnType<typeof splitQuestions>} blocks
 * @returns {string}
 */
function buildShapeReason(blocks) {
	const bad = [];
	for (const block of blocks) {
		const defects = defectsIn(block);
		if (defects.length > 0)
			bad.push(`Q${block.number}: ${defects.join("; ")}.`);
	}
	return bad.length > 0 ? formatReason(blocks.length, bad) : "";
}

/**
 * @param {string} message
 * @param {{transcript?: string, verdicts?: Part[]}} [evidence]
 * @param {StatusReading | null} [status]
 * @returns {Part[]}
 */
function reviewParts(message, evidence = {}, status = jobStatus(message)) {
	/** @type {Part[]} */
	const parts = [];
	/** @type {(prefix: string, reason: string) => void} */
	const push = (prefix, reason) => {
		if (reason) parts.push({ prefix, reason });
	};

	const blocks = splitQuestions(message);
	const founderAct = founderActRefusal(message);
	if (blocks.length > 0) {
		push(SHAPE_PREFIX, buildShapeReason(blocks));
		for (const { prefix, reason } of evidence.verdicts ?? [])
			push(prefix, reason);
		push(FOUNDER_ACT_PREFIX, founderAct);
		push(
			ACTOR_ONLY_PREFIX,
			actorOnlyRound(message, { ruleShown: Boolean(founderAct) }),
		);
	} else push(FOUNDER_ACT_PREFIX, founderAct);

	if (status) {
		if (blocks.length > 0)
			push(
				MISSING_NEEDS_INPUT_PREFIX,
				missingNeedsInput(status, blocks.length),
			);
		else push(UNMARKED_STOP_PREFIX, unmarkedStop(status));
		push(
			COMPLETED_WHILE_WAITING_PREFIX,
			completedWhileWaiting(message, status),
		);
		push(EMPTY_MARKER_PREFIX, emptyStatusMarker(status));
		push(WAITING_IN_JOB_PREFIX, waitingInJob(status));
		push(NEEDS_INPUT_UNDERCUT_PREFIX, needsInputUndercut(status));
		push(NEEDS_INPUT_MISPLACED_PREFIX, needsInputMisplaced(status));
		push(RESULT_MISPLACED_PREFIX, resultMisplaced(status));
	}
	push(SHAPE_PREFIX, recommendationBelowPrice(message));
	return parts;
}

/** @typedef {import("./lib/priced-options-ceiling").Part} Part */

/** @type {Record<string, "research" | "round" | "status">} */
const PIECE_OF = {
	[CLOSE_RIVALS_PREFIX]: "research",
	[ROUND_CHECK_PREFIX]: "research",
	[RESEARCH_LADDER_PREFIX]: "research",
	[SHAPE_PREFIX]: "round",
	[NEEDS_INPUT_ROUND_PREFIX]: "round",
	[FOUNDER_ACT_PREFIX]: "round",
	[ACTOR_ONLY_PREFIX]: "round",
	[MISSING_NEEDS_INPUT_PREFIX]: "status",
	[EMPTY_MARKER_PREFIX]: "status",
	[COMPLETED_WHILE_WAITING_PREFIX]: "status",
	[NEEDS_INPUT_UNDERCUT_PREFIX]: "status",
	[NEEDS_INPUT_MISPLACED_PREFIX]: "status",
};

/**
 * @param {{ sessionId: string, message: string, status: StatusReading | null,
  transcript?: string }} turn
 * @param {Part[]} parts
 * @returns {string}
 */
function checklistTail({ sessionId, message, status, transcript }, parts) {
	const marker = status?.governing;
	if (marker?.name !== "needs input:") return "";
	/** @type {import("./lib/needs-input-shape").Judgement} */
	const judged =
		splitQuestions(message).length > 0 ? { research: "met", round: "met" } : {};
	for (const { prefix } of parts) {
		const piece = PIECE_OF[prefix];
		if (piece) judged[piece] = "missing";
	}
	return shareChecklist({
		sessionId,
		message,
		payload: marker.payload,
		transcript,
		judged,
	});
}

/** @param {{sessionId: string, message: string,
  payload?: {transcript_path?: string}|null}} ctx */
function judge({ sessionId, message, payload }) {
	const transcript = hookMessage.transcriptPath(payload, sessionId);
	const status = jobStatus(message);
	const unlettered = status
		? needsInputWithoutRound(message, status, transcript)
		: "";
	/** @param {Part[]} verdicts */
	const partsWith = (verdicts) => {
		const parts = reviewParts(message, { transcript, verdicts }, status);
		if (unlettered)
			parts.push({ prefix: NEEDS_INPUT_ROUND_PREFIX, reason: unlettered });
		return parts;
	};

	/** @type {(max: number) => boolean} */
	const ceilingAt = (max) =>
		hookBlock.capSpent({ prefix: SESSION_PREFIX, sessionId, max });

	const shapeHeard = ceilingPlan(
		liveGroups(groupByPrefix(partsWith([])), sessionId),
		ceilingAt,
	).blocking.some((group) => group.prefix === SHAPE_PREFIX);
	const silencedShape = shapeHeard ? null : defectsIn;
	/** @param {string} prefix */
	const isLastRefusal = (prefix) =>
		hookBlock.isLastBlock(limbCounter(prefix, sessionId));
	const roundRecord = readRoundRecord(sessionId, transcript);
	const close = closeRivalsTurn(message, {
		sessionId,
		transcript,
		houseDecision: readHouseDecisionRule,
		silencedShape,
		isLastRefusal: isLastRefusal(CLOSE_RIVALS_PREFIX),
		isLastLadder: isLastRefusal(RESEARCH_LADDER_PREFIX),
		corpus: corpusTrackers,
		roundPasses: passedNumbers(roundRecord),
	});
	/** @param {{ prefix: string, refusing: string[] }} limbTurn */
	const refusingOf = (limbTurn) =>
		isLive(limbTurn.prefix, sessionId) ? limbTurn.refusing : [];
	const roundCheck = roundCheckTurn(message, {
		sessionId,
		transcript,
		stored: roundRecord,
		houseDecision: readHouseDecisionRule,
		closeJudged: close.rounds,
		rivalLimbsRefusing: [...refusingOf(close), ...refusingOf(close.ladder)],
		silencedShape,
		isLastRefusal: isLastRefusal(ROUND_CHECK_PREFIX),
	});
	const parts = partsWith([close, close.ladder, roundCheck]);

	// lucmoseley/mantahostels#2786
	const live = liveGroups(groupByPrefix(parts), sessionId);
	if (
		blockOn(ceilingPlan(live, ceilingAt), {
			sessionId,
			recorders: [close, close.ladder, roundCheck],
			tail: () =>
				checklistTail({ sessionId, message, status, transcript }, parts),
		})
	)
		return;

	close.onPassed(!isLive(close.prefix, sessionId));
	roundCheck.onPassed(
		!isLive(roundCheck.prefix, sessionId),
		hookBlock.readCount(roundCheck.prefix, sessionId),
	);
}

if (require.main === module) {
	disarmLoadFailure();
	stopGuard.onMessage({ review: judge });
}
