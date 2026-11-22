const { requiredGroup } = require("./regex-group.js");
const { docPath, scriptPath } = require("./script-path");

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

const NO_COMMAND_VALUES = ["human", "children"];
const COMMAND_VALUES = TAKES_VALUES.filter(
	(v) => !NO_COMMAND_VALUES.includes(v),
);

/**
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
 * @param {string[]} takes
 * @returns {string|null}
 */
function loneCommandOf(takes) {
	const [kind, ...more] = takes;
	return kind !== undefined &&
		more.length === 0 &&
		COMMAND_VALUES.includes(kind)
		? kind
		: null;
}

/**
 * @param {string[]} labels
 * @returns {string[]}
 */
const takesOf = (labels) =>
	labels
		.filter((l) => l.startsWith(TAKES_PREFIX))
		.map((l) => l.slice(TAKES_PREFIX.length));

/**
 * @param {string} value
 * @returns {string}
 */
const takesLabel = (value) => `${TAKES_PREFIX}${takesValue(value)}`;

const OUTSIDE_MARKER = "Outside Claude Code:";
const OUTSIDE_LINE = new RegExp(`${OUTSIDE_MARKER}[ \\t*]*[^\\s*]`);
const OUTSIDE_TEXT = new RegExp(`(?:\\*\\*)?${OUTSIDE_MARKER}[^\\n]*`);

// lucmoseley/mantahostels#3555
const REPO_FILE_ACT =
	/`(docs|app|scripts|components|lib|public)\/[^`]*`|(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+\.(svg|png|md|js|ts)($|[^A-Za-z0-9_])|[Ii]nkscape|[Ff]igma|[Pp]hotoshop|[Ss]preadsheet/;

const BARRED_ACT =
	/[Nn]o (agent|session) (may|can)|[Aa]n agent (may not|cannot|is not permitted|is barred)|[Aa]gents? (are|is) (barred|not permitted)|(may not|cannot) be [a-z]+ by (an agent|a session)|[Nn]o agent is (allowed|permitted)/;

/** @returns {string} */
const readFounderActs = () =>
	require("./rule-text.js").readRuleTextOr(
		"founder-acts",
		"one of the founder's own acts",
		"takes-label",
	);

const PLACE_WORDS = "phone|in[ -]person|phone app|iphone";
const DEED_WORDS =
	"pay|payment|buy|purchase|subscribe|sign|signature|accept|terms|delete|install|invite|grant|authorise|authorize|oauth|captcha|card|one-time code|two-factor|2fa|otp|verification|call|refused|send|email|e-mail|message|reply|post|submit|apply|application|register|registration|linkedin|profile|form";
const DEED_IRREGULAR =
	"paid|bought|purchasing|subscribing|deleting|inviting|authorising|authorizing|phoning|messaging|replied|replies|applied|applies";
/** @param {string} words */
const buildWholeWordSource = (words) =>
	`(?<![a-z0-9])(?:${words})(?:s|es|d|ed|ing|ted|ting)?(?![a-z0-9])`;
const FOUNDER_DEED_WORD = new RegExp(
	`${buildWholeWordSource(DEED_WORDS)}|(?<![a-z0-9])(?:${DEED_IRREGULAR})(?![a-z0-9])`,
	"i",
);
const FOUNDER_ACT_WORD = new RegExp(
	`${FOUNDER_DEED_WORD.source}|${buildWholeWordSource(PLACE_WORDS)}`,
	"gi",
);
const REFUSED_WORD = /^refused$/i;

const OBSERVE_WORD = new RegExp(
	`${buildWholeWordSource("look|listen|hear|see|watch|observe|notice|confirm|check|read|verify|view|inspect|ensure|make sure")}|(?<![a-z0-9])(?:heard|seen|saw|verified|verifies|verifying)(?![a-z0-9])`,
	"i",
);

const SESSION_SURFACE =
	/(?<![a-z0-9])(agents? view|wc[1-3]|sessions?|terminals?|desktop app(?:lication)?s?)(?![a-z0-9])/i;
const SCREEN_DOABLE =
	/^(?:send|email|e-mail|message|messaging|reply|replied|replies|post|submit|form|call|phone|phoning|refused)/i;

const CLAUSE_BREAK =
	/(?:[,;—]\s*|(?<!\s)\s+(?=(?:and|then)\s))(?:(?:and|then)\s+)*/gi;
const REPORT_BACK =
	/^(?:reply|replies|report|post|comment|log|record|paste|message|note|send|share|tell)\b(?:\s+with\b(?![^,;—]*\bto\b)|[^,;—]*\bme\b|[^,;—]*\b(?:here|(?:this|the) (?:issue|ticket|session|thread))[\s.]*$)/i;

/**
 * @param {string} line
 * @returns {string}
 */
function actPart(line) {
	const breaks = [...line.matchAll(CLAUSE_BREAK)];
	for (const [k, brk] of breaks.entries()) {
		const start = brk.index + brk[0].length;
		const end = breaks[k + 1]?.index ?? line.length;
		if (REPORT_BACK.test(line.slice(start, end)))
			return line.slice(0, brk.index);
	}
	return line;
}

const TRIED_LINE = /^[ \t]*(\*\*)?Tried(:\*\*|\*\*:|:)/;
const LIST_ITEM = /^([ \t]*)([-*+]|[0-9]+[.)])[ \t]+\S/;
const TRIED_MIN = 3;
const TRIED_MIN_ROUTES = 2;
const TRIED_WAY = `add a **Tried:** line followed directly by at least ${TRIED_MIN} list items, one per different method you actually ran and what it showed`;

/**
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

const CLOSE_WHEN_MARKER = "Close when:";
const CLOSE_WHEN_LINE = /Close when:[ \t*]*[^\s*]/;

/**
 * @param {string} body
 * @returns {{fault: "NO-OUTSIDE-ACT"|"BARRED-NOT-IMPOSSIBLE"|"REPO-FILE-ACT"|"SURFACE-UNTRIED"|"NOT-A-FOUNDER-ACT"|"OBSERVE-ONLY"|"REFUSED-UNTRIED", line: string}|null}
 */
function outsideLineFault(body) {
	const line = OUTSIDE_TEXT.exec(body)?.[0] ?? "";
	if (!OUTSIDE_LINE.test(body)) return { fault: "NO-OUTSIDE-ACT", line };
	if (BARRED_ACT.test(line)) return { fault: "BARRED-NOT-IMPOSSIBLE", line };
	if (REPO_FILE_ACT.test(line)) return { fault: "REPO-FILE-ACT", line };
	const fault = actFault(actPart(line), triedCount(body));
	return fault ? { fault, line } : null;
}

/**
 * @param {string} act
 * @param {number} tried
 * @returns {"SURFACE-UNTRIED"|"NOT-A-FOUNDER-ACT"|"OBSERVE-ONLY"|"REFUSED-UNTRIED"|null}
 */
function actFault(act, tried) {
	const words = [
		...act
			.replace(new RegExp(SESSION_SURFACE.source, "gi"), " ")
			.matchAll(FOUNDER_ACT_WORD),
	].map((m) => m[0]);
	const observeOnly = OBSERVE_WORD.test(act) && !FOUNDER_DEED_WORD.test(act);
	if (SESSION_SURFACE.test(act) && words.every((w) => SCREEN_DOABLE.test(w))) {
		if (tried < TRIED_MIN_ROUTES) return "SURFACE-UNTRIED";
		return observeOnly && tried < TRIED_MIN ? "OBSERVE-ONLY" : null;
	}
	if (tried >= TRIED_MIN) return null;
	if (words.length === 0) return "NOT-A-FOUNDER-ACT";
	if (observeOnly) return "OBSERVE-ONLY";
	if (words.every((w) => REFUSED_WORD.test(w)) && tried < TRIED_MIN_ROUTES)
		return "REFUSED-UNTRIED";
	return null;
}

/**
 * @param {string} body
 * @returns {boolean}
 */
const hasRefusedOutsideAct = (body) =>
	[...(OUTSIDE_TEXT.exec(body)?.[0] ?? "").matchAll(FOUNDER_ACT_WORD)].some(
		(m) => REFUSED_WORD.test(m[0]),
	);

const TRIED_LIST = `a **Tried:** line followed directly by at least ${TRIED_MIN_ROUTES} list items`;
const UNTRIED_FAULTS = {
	"SURFACE-UNTRIED": {
		says: "names a screen a session can drive — a terminal, the agents view, a session or a desktop app — and no act a session cannot do there",
		fix: `Run the browser-ladder skill's routes for that screen; where they fail, add ${TRIED_LIST}, one per route and what it showed (\`rule:takes-label-nuances\`).`,
	},
	"REFUSED-UNTRIED": {
		says: "names a refused act as its only founder act",
		fix: `Add ${TRIED_LIST}, one per call and what the permission check said (\`rule:founder-handover\`, its auto-mode paragraph).`,
	},
};

/**
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
	const acts = readFounderActs();
	const triedWayOut = `for a website job no act on that list covers, ${TRIED_WAY}`;
	const found = outsideLineFault(body);
	if (!found)
		return CLOSE_WHEN_LINE.test(body)
			? null
			: `takes:human, but the body has no **${CLOSE_WHEN_MARKER}** line. Add it — ${require("./rule-text.js").readRuleTextOr("close-when-line", "**Close when:** <what finishes it>", "takes-label")} Template: ${scriptPath("lib/rule-text.sh")} founder-deliverable.`;
	if (found.fault === "NO-OUTSIDE-ACT")
		return `takes:human, but the body names no act performed outside Claude Code. Add it on its own line — **${OUTSIDE_MARKER}** <the act, in plain words>, one of the founder's own acts this message closes on. Or, ${triedWayOut}. If you can honestly write neither, the label is wrong. ${rule} The founder's own acts (#1077): ${acts}`;
	if (found.fault === "NOT-A-FOUNDER-ACT")
		return `takes:human, but the Outside line names none of the founder's own acts: "${found.line}". Two ways out: name the act from that list, which this message closes on, on the Outside line, or, ${triedWayOut}. Neither true means an agent can do it, and the label is wrong. ${rule} The acts are (#1077): ${acts}`;
	if (found.fault === "SURFACE-UNTRIED" || found.fault === "REFUSED-UNTRIED") {
		const { says, fix } = UNTRIED_FAULTS[found.fault];
		return `takes:human, but the Outside line ${says}: "${found.line}". ${fix} ${rule}`;
	}
	if (found.fault === "OBSERVE-ONLY")
		return `takes:human, but the Outside line's only founder part is to observe a result: "${found.line}". Try what ${scriptPath("lib/rule-text.sh")} observe-first names; only where every route failed, ${TRIED_WAY}.`;
	if (found.fault === "BARRED-NOT-IMPOSSIBLE")
		return `takes:human, but the Outside line names a prohibition rather than an act: "${found.line}". Being barred is not being impossible — a real bar is takes:wayfinder, to rule on it; an unreal one is takes:implement. The line names what the founder does, one of his own acts. ${rule} The founder's own acts (#1077): ${acts}`;
	return `takes:human, but the Outside line's act produces a file in this repository: "${found.line}". The file is takes:implement; the founder's review of it is takes:wayfinder. ${rule}`;
}

module.exports = {
	CLOSE_WHEN_LINE,
	CLOSE_WHEN_MARKER,
	COMMAND_VALUES,
	NO_COMMAND_VALUES,
	OUTSIDE_MARKER,
	TAKES_PREFIX,
	TAKES_VALUES,
	TRIED_MIN,
	TRIED_MIN_ROUTES,
	TRIED_WAY,
	outsideLineFault,
	hasRefusedOutsideAct,
	loneCommandOf,
	takesLabel,
	takesOf,
	takesRefusal,
	takesValue,
	UNTRIED_FAULTS,
};
