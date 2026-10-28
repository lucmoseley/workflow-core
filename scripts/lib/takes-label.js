/*
 * takes-label.js — the `takes:` vocabulary, the four `takes:human`
 * Outside-line tests and its `**Close when:**` test, for the scripts that
 * write or audit a `takes:` value (#533, #983, #1095).
 *
 * The guard half is lib/issue-create-label.js, the guard-issue-create-label
 * core, which requires this file (#2796). file-issue.test.ts asserts
 * TAKES_VALUES against docs/agents/triage-labels.md, and every Outside-line
 * verdict against scripts/fixtures/takes-human-bodies.json;
 * lib/issue-create-label.test.ts runs the same table through that core.
 *
 * The Node scripts naming one value spell it through takesValue or
 * takesLabel, which throw on a value outside the set (#2193); file-issue.test.ts
 * asserts scripts/place-new-issue.sh's takes_values too, and
 * adopter-skeleton.test.ts the label plan's takes: rows. The one copy left
 * unasserted: the labels as they stand on GitHub.
 */

const { requiredGroup } = require("./regex-group.js");
const { docPath, scriptPath } = require("./script-path");

/* The closed set, from docs/agents/triage-labels.md §`takes:`. */
const TAKES_VALUES = [
	"wayfinder",
	"to-spec",
	"to-tickets",
	"implement",
	"triage",
	"human",
	"children",
];

const TAKES_PREFIX = "takes:";

/* No `/`-command opens these two: human is founder work, children a container. */
const NO_COMMAND_VALUES = ["human", "children"];
/* The values a `/`-command opens: every value but those two. */
const COMMAND_VALUES = TAKES_VALUES.filter(
	(v) => !NO_COMMAND_VALUES.includes(v),
);

/**
 * `value`, refused where it is not one of the seven, so a script naming a
 * value the set has dropped fails at load rather than matching nothing.
 * @param {string} value
 * @returns {string}
 */
function takesValue(value) {
	if (!TAKES_VALUES.includes(value))
		throw new Error(
			`${value} is not a takes: value (${TAKES_VALUES.join(", ")})`,
		);
	return value;
}

/**
 * @param {string} value
 * @returns {string}
 */
const takesLabel = (value) => `${TAKES_PREFIX}${takesValue(value)}`;

/* A bare marker naming no act fails. */
const OUTSIDE_MARKER = "Outside Claude Code:";
const OUTSIDE_LINE = /Outside Claude Code:[ \t*]*[^\s*]/;
const OUTSIDE_TEXT = /Outside Claude Code:[^\n]*/;

/* An act whose product is a file in this repository is never an outside act,
 * whatever tool a document names as the owner's (mantahostels#3555). No wider
 * than mantahostels#3555 item 4 lists: a line naming the act without the path
 * passes. */
const REPO_FILE_ACT =
	/`(docs|app|scripts|components|lib|public)\/[^`]*`|(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+\.(svg|png|md|js|ts)($|[^A-Za-z0-9_])|[Ii]nkscape|[Ff]igma|[Pp]hotoshop|[Ss]preadsheet/;

/* A real outside act names an ACTION; an Outside line naming a PROHIBITION is
 * the barred-is-not-impossible mistake (mantahostels#2775). Every alternative
 * names an AGENT or a SESSION as the barred subject: a prohibition about the
 * world is often part of a real errand ("once submitted it may not be
 * edited"), so only a claim that no agent may do the thing is caught (#140). */
const BARRED_ACT =
	/[Nn]o (agent|session) (may|can)|[Aa]n agent (may not|cannot|is not permitted|is barred)|[Aa]gents? (are|is) (barred|not permitted)|(may not|cannot) be [a-z]+ by (an agent|a session)|[Nn]o agent is (allowed|permitted)/;

/* Ruling 1's closed list of the founder's own acts (#1077 Q1 (A)). */
const FOUNDER_ACTS = [
	"pay, buy or subscribe",
	"sign or accept terms",
	"delete",
	"install an app",
	"accept an invite",
	"grant access",
	"OAuth Authorize",
	"a CAPTCHA guarding an act he is taking",
	"card entry",
	"a one-time code",
	"phone verification",
	"signing a site in for the first time",
	"an act Claude Code's automatic permission check refused (never the same act by another path)",
	"a phone call, an in-person act, or an act in a desktop or phone app",
	"sending anything a person outside reads",
];

/* The vocabulary that names one of them (#1092 §The check), whole-word and
 * case-insensitive on the Outside line alone. The suffix, and the irregular
 * forms listed whole, let the list's own wording pass ("signing", "sending");
 * a word used in a non-act sense passes too, the accepted escape. */
const FOUNDER_ACT_WORD =
	/(^|[^a-z0-9])(pay|payment|buy|purchase|subscribe|sign|signature|accept|terms|delete|install|invite|grant|authorise|authorize|oauth|captcha|card|one-time code|otp|verification|phone|call|in[ -]person|desktop app|phone app|iphone|refused|send|email|e-mail|message|reply|post|submit|apply|application|register|registration|linkedin|profile|form)(s|es|d|ed|ing|ted|ting)?($|[^a-z0-9])|(^|[^a-z0-9])(paid|bought|purchasing|subscribing|deleting|inviting|authorising|authorizing|phoning|messaging|replied|replies|applied|applies)($|[^a-z0-9])/i;

/* A website job no list act covers reaches the founder with methods tried
 * (#1077 Q3 (A)): a `Tried:` line, bold or plain, then the items on the
 * very next lines. A blank line or prose ends the count, and a sub-item,
 * indented past the first item, is one method's detail and never counted.
 * Whether the methods differed or were run, no lexical test sees. */
const TRIED_LINE = /^[ \t]*(\*\*)?Tried(:\*\*|\*\*:|:)/;
const LIST_ITEM = /^([ \t]*)([-*+]|[0-9]+[.)])[ \t]+\S/;
const TRIED_MIN = 3;

/**
 * How many items the list opening `following` holds at its first item's
 * indent; 0 where the first line is no list item.
 * @param {string[]} following
 * @returns {number}
 */
function topLevelItems(following) {
	const [first] = following;
	const head = first === undefined ? null : LIST_ITEM.exec(first);
	if (!head) return 0;
	const indent = requiredGroup(head, 1, LIST_ITEM).length;
	let n = 0;
	for (const next of following) {
		const item = LIST_ITEM.exec(next);
		if (!item) break;
		const depth = requiredGroup(item, 1, LIST_ITEM).length;
		if (depth < indent) break;
		if (depth === indent) n++;
	}
	return n;
}

/**
 * @param {string} body
 * @returns {number}
 */
function triedCount(body) {
	const lines = body.split("\n");
	let best = 0;
	for (const [i, line] of lines.entries()) {
		if (!TRIED_LINE.test(line)) continue;
		best = Math.max(best, topLevelItems(lines.slice(i + 1)));
	}
	return best;
}

/* What finishes a `takes:human` errand (#983). Presence only: no lexical test
 * tells a real finishing condition from a stub. */
const CLOSE_WHEN_MARKER = "Close when:";
const CLOSE_WHEN_LINE = /Close when:[ \t*]*[^\s*]/;

/**
 * Which of the four Outside-line tests a `takes:human` body fails, in the
 * create guard's order, with the line it read — or null where it passes. The
 * fault is check-issue-labels.js's finding tag.
 * @param {string} body
 * @returns {{fault: "NO-OUTSIDE-ACT"|"BARRED-NOT-IMPOSSIBLE"|"REPO-FILE-ACT"|"NOT-A-FOUNDER-ACT", line: string}|null}
 */
function outsideLineFault(body) {
	const line = OUTSIDE_TEXT.exec(body)?.[0] ?? "";
	if (!OUTSIDE_LINE.test(body)) return { fault: "NO-OUTSIDE-ACT", line };
	if (BARRED_ACT.test(line)) return { fault: "BARRED-NOT-IMPOSSIBLE", line };
	if (REPO_FILE_ACT.test(line)) return { fault: "REPO-FILE-ACT", line };
	if (!FOUNDER_ACT_WORD.test(line) && triedCount(body) < TRIED_MIN)
		return { fault: "NOT-A-FOUNDER-ACT", line };
	return null;
}

/**
 * Why `labels` and `body` may not be filed as they stand, or null. Exactly
 * one `takes:` value from the seven, and a `takes:human` body passing the
 * four Outside-line tests, then carrying a Close-when line.
 * @param {string[]} labels
 * @param {string} body
 * @returns {string|null}
 */
function takesRefusal(labels, body) {
	const seven = TAKES_VALUES.map(takesLabel).join(", ");
	const takes = labels.filter((l) => l.startsWith(TAKES_PREFIX));
	const [label, ...extra] = takes;
	if (label === undefined)
		return `no takes: label — an issue carries exactly one, naming the command that opens it. Add one of: ${seven}.`;
	if (extra.length > 0)
		return `${takes.length} takes: labels (${takes.join(", ")}) — an issue carries exactly one. Keep the one naming the command that opens it.`;
	if (!TAKES_VALUES.includes(label.slice(TAKES_PREFIX.length)))
		return `${label} is not a takes: value. Use one of the seven: ${seven}.`;
	if (label !== takesLabel("human")) return null;

	const rule = `Rule: ${docPath("agents/triage-labels.md")} §\`takes:\`, the nuances block.`;
	const acts = FOUNDER_ACTS.join("; ");
	const triedWayOut = `for a website job no act on that list covers, add a **Tried:** line followed directly by at least ${TRIED_MIN} list items, one per different method you actually ran and what it showed`;
	const found = outsideLineFault(body);
	if (!found)
		return CLOSE_WHEN_LINE.test(body)
			? null
			: `takes:human, but the body has no **${CLOSE_WHEN_MARKER}** line. Add it — **${CLOSE_WHEN_MARKER}** <what finishes it>, plus what the closing comment records, naming any issue that waits on the result. Template: ${scriptPath("lib/rule-text.sh")} founder-deliverable.`;
	if (found.fault === "NO-OUTSIDE-ACT")
		return `takes:human, but the body names no act performed outside Claude Code. Add it on its own line — **${OUTSIDE_MARKER}** <the act, in plain words>, one of the founder's own (#1077): ${acts}. Or, ${triedWayOut}. If you can honestly write neither, the label is wrong. ${rule}`;
	if (found.fault === "NOT-A-FOUNDER-ACT")
		return `takes:human, but the Outside line names none of the founder's own acts: "${found.line}". The acts are: ${acts} (#1077). Two ways out: name the act from that list on the Outside line, or, ${triedWayOut}. Neither true means an agent can do it, and the label is wrong. ${rule}`;
	if (found.fault === "BARRED-NOT-IMPOSSIBLE")
		return `takes:human, but the Outside line names a prohibition rather than an act: "${found.line}". Being barred is not being impossible — a real bar is takes:wayfinder, to rule on it; an unreal one is takes:implement. The line names what the founder does, one of his own acts (#1077): ${acts}. ${rule}`;
	return `takes:human, but the Outside line's act produces a file in this repository: "${found.line}". The file is takes:implement; the founder's review of it is takes:wayfinder. ${rule}`;
}

module.exports = {
	CLOSE_WHEN_LINE,
	CLOSE_WHEN_MARKER,
	COMMAND_VALUES,
	FOUNDER_ACTS,
	NO_COMMAND_VALUES,
	OUTSIDE_MARKER,
	TAKES_PREFIX,
	TAKES_VALUES,
	TRIED_MIN,
	outsideLineFault,
	takesLabel,
	takesRefusal,
	takesValue,
};
