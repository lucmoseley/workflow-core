const { CLAUSE_REACH, CODE_SPAN } = require("./secret-ask.js");

// guess, workflow-core#5529
const MIN_NUMBERED_STEPS = 2;

const ISSUE = String.raw`(?:(?:the|that|this|its|my)\s+)?(?:(?:issue|ticket)(?:['’]s)?(?:\s+(?:body|comments?))?|(?:issue|ticket)\s+#\d+|#\d+|https?://\S*/(?:issues|pull)/\d+)`;
const STEP = "(?:steps?|instructions?|walk-?through|walk|hand-?over)";
const HANDED = `(?:${STEP}|commands?|lines?)`;
const LEAD = String.raw`(?:^|\b(?:then|please|just|now|you (?:can|should|could|may|must|need to))\s+)`;
const NEAR = `[^.\\n]{0,${CLAUSE_REACH}}?`;
const AWAY = "(?:in|on|under|at|from)";

const TO_ISSUE = new RegExp(
	[
		String.raw`${LEAD}(?:read|see|follow|consult|look at|go to|head to)\s+(?:${NEAR}\b${AWAY}\s+)?${ISSUE}(?![\w-])`,
		String.raw`${LEAD}(?:use|open|check|review|run|apply|do|work through|walk through)\s+${NEAR}\b${STEP}\s+${NEAR}\b${AWAY}\s+${ISSUE}(?![\w-])`,
		String.raw`\b${ISSUE}\s+(?:has|holds|lists|carries)\s+(?:the\s+|its\s+)?${STEP}\b`,
	].join("|"),
	"i",
);
const STEPS_LIVE_THERE = new RegExp(
	String.raw`\b${STEP}\s+(?:are|is|live|lives|sit|sits)\s+(?:(\w+)\s+)?${AWAY}\s+${ISSUE}(?![\w-])`,
	"i",
);
const NAMED_EARLIER = new RegExp(
	[
		String.raw`\b(?:shorter|longer|full)\s+version\b${NEAR}\b(?:above|earlier)\b`,
		String.raw`\bI(?:['’]ve| have)\s+(?:already\s+)?(?:given|posted|sent|written)\b${NEAR}\b${STEP}\b`,
	].join("|"),
	"i",
);
const EARLIER = new RegExp(
	String.raw`\b${HANDED}\b${NEAR}\b(?:above|earlier|previously|I (?:gave|posted|sent|wrote))\b`,
	"i",
);

const SENTENCE_BREAK = /(?<=[.!?;])\s+|\n+/;
const SENTENCE_MARKUP = /^\s*(?:[-*+]\s+|\d+[.)]\s+|\([A-Z]\)\s+)?(?:\*\*)?/;
const OWN_REPORT = /^(?:I|we)\b/i;
const NUMBERED_STEP = /^\s{0,3}\d+[.)]\s/gm;
const BANG_LINE = /^\s{0,3}`?!\s*\S/m;
const ROUND_MARKER = /\u2753 \*\*Q\d/;
const CITED_ISSUE = /^`(#\d+)`$/;

/**
 * @param {string} message
 */
function maskCode(message) {
	return String(message).replace(CODE_SPAN, (span) =>
		span.startsWith("`") && !span.startsWith("```")
			? (span.match(CITED_ISSUE)?.[1] ?? "code")
			: "\n",
	);
}

/**
 * @param {string} message
 * @param {string} prose
 */
function hasSteps(message, prose) {
	const numbered = prose.match(NUMBERED_STEP) ?? [];
	return (
		numbered.length >= MIN_NUMBERED_STEPS ||
		BANG_LINE.test(message) ||
		ROUND_MARKER.test(message) ||
		/^[^\S\n\r\u2028\u2029]*(?:`{3,}|~{3,})/m.test(message)
	);
}

/**
 * @param {string} sentence
 * @param {boolean} held
 * @returns {string | undefined}
 */
function pointerIn(sentence, held) {
	const named = sentence.match(NAMED_EARLIER)?.[0];
	if (named) return named;
	if (OWN_REPORT.test(sentence)) return;
	const pointer = sentence.match(TO_ISSUE)?.[0];
	if (pointer) return pointer.trim();
	const lives = sentence.match(STEPS_LIVE_THERE);
	if (lives && !(held && /^also$/i.test(lives[1] ?? ""))) return lives[0];
	return held ? undefined : sentence.match(EARLIER)?.[0];
}

/**
 * @param {string} message
 * @returns {string | undefined}
 */
function founderPointer(message) {
	const prose = maskCode(message);
	const held = hasSteps(message, prose);
	return prose
		.split(SENTENCE_BREAK)
		.map((raw) => pointerIn(raw.replace(SENTENCE_MARKUP, ""), held))
		.find(Boolean);
}

module.exports = { founderPointer };
