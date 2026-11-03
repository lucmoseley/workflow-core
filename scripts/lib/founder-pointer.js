/*
 * founder-pointer.js — reads a final message for a pointer that sends the founder
 * away for his steps (#4058): to an issue, ticket or comment, or back to steps the
 * session says it already gave. Text between tool calls need not reach him, so the
 * final message is the only place that certainly does.
 *
 * Lexical, on the prose alone: fences and code spans are never read, so a prompt
 * handed to a fresh session passes. Imperatives only on the tracker side, so "I
 * record your answer on the ticket" and a bare citation pass. Residual: a pointer
 * to a file or an outside page is `rule:founder-handover`'s alone, since an act
 * that happens outside Claude Code has to name its page.
 */

const TRACKER_PLACE = String.raw`(?:(?:the|that|this|its|my)\s+)?(?:(?:issue|ticket)(?:['’]s)?(?:\s+(?:body|comments?))?|comments?|#\d+|https?://\S*/(?:issues|pull)/\d+)`;
const IMPERATIVE_OPENING = String.raw`(?:^|[.!?:;]\s+|\b(?:then|please|just|and|you (?:can|should|could|may|must|need to))\s+)`;
const READ_VERB =
	"(?:follow|read|see|open|check|use|consult|review|look at|go to|head to|work through|visit)";
const STEP_NOUN = "(?:steps?|instructions?|walk-?through|walk|hand-?over)";

const TRACKER_POINTER = new RegExp(
	[
		String.raw`${IMPERATIVE_OPENING}${READ_VERB}\s+(?:[^.\n]{0,40}?\b(?:in|on|under|at|from)\s+)?${TRACKER_PLACE}(?![\w-])`,
		String.raw`\b${STEP_NOUN}\s+(?:are|is|live|lives|sit|sits)\s+(?:\w+\s+)?(?:in|on|under|at)\s+${TRACKER_PLACE}(?![\w-])`,
	].join("|"),
	"im",
);

const EARLIER_POINTER = new RegExp(
	[
		String.raw`\b(?:${STEP_NOUN}|version)\b[^.\n]{0,30}?\b(?:above|earlier|previously|I (?:gave|posted|sent|wrote))\b`,
		String.raw`\bI(?:['’]ve| have)\s+(?:already\s+)?(?:given|posted|sent|written)\b[^.\n]{0,20}?\b${STEP_NOUN}\b`,
	].join("|"),
	"i",
);

const NUMBERED_STEP = /^\s{0,3}\d+[.)]\s/gm;
const BANG_LINE = /^\s{0,3}`?!\s*\S/m;

/** @param {string} message @returns {string} the message's prose */
function readProse(message) {
	const prose = [];
	let inFence = false;
	for (const line of String(message).split("\n")) {
		if (/^\s{0,3}```/.test(line)) inFence = !inFence;
		else if (!inFence) prose.push(line.replace(/`[^`\n]*`/g, "code"));
	}
	return prose.join("\n");
}

/**
 * Whether the message carries the steps themselves: two numbered lines or a `!`
 * paste, so that "the steps above" points within it.
 * @param {string} message
 */
function holdsSteps(message) {
	const numbered = String(message).match(NUMBERED_STEP) ?? [];
	return numbered.length >= 2 || BANG_LINE.test(message);
}

/**
 * The phrase sending the founder away for his steps, or undefined.
 * @param {string} message the outgoing assistant message
 * @returns {string | undefined}
 */
function founderPointer(message) {
	const prose = readProse(message);
	const tracker = prose.match(TRACKER_POINTER)?.[0];
	if (tracker) return tracker.trim();
	if (holdsSteps(message)) return;
	return prose.match(EARLIER_POINTER)?.[0];
}

module.exports = { founderPointer };
