const {
	defaultsToPost,
	isIssueCollection,
	scanApi,
} = require("./gh-api-call.js");
const { deny, open, walkVerdict } = require("./guard-verdict.js");
const { ISSUE_VALUE_FLAGS } = require("./gh-issue-ref.js");
const { BASH_SPACE, parseCommand } = require("./shell-parse.js");
const { requiredGroup } = require("./regex-group.js");
const { trimRun } = require("./trim-run.js");
const {
	commandName,
	isGhCommand,
	literal,
	scanFlags,
} = require("./shell-words.js");

/**
 * @typedef {import("./kit-context.js").KitContext
 *   & Pick<import("./core-contract.js").CoreContext, "tree">} PhaseContext
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {import("./shell-parse.js").Parsed} Parsed
 * @typedef {import("./guard-entry.js").Decision} Decision
 */

const ROADMAP = "docs/reference-roadmap.html";
const REGISTER = "docs/called-cards.md";

const WRAPPERS = [
	"env",
	"command",
	"exec",
	"nohup",
	"nice",
	"timeout",
	"stdbuf",
	"setsid",
];

const CARD_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * @typedef {object} Run
 * @property {Parsed} parsed
 * @property {PhaseContext} ctx
 * @property {string | null} [roadmap]
 */

/**
 * @param {string} command
 * @param {PhaseContext} ctx
 * @returns {Decision}
 */
function decide(command, ctx) {
	/** @type {Run} */
	const run = { parsed: parseCommand(command), ctx };
	return walkVerdict(run.parsed, (cmd) => judge(run, cmd), ctx) ?? null;
}

/** @param {string[]} words */
function unwrapped(words) {
	let ws = words;
	while (ws.length > 0 && WRAPPERS.includes(commandName(ws[0] ?? ""))) {
		const was = commandName(ws[0] ?? "");
		ws = ws.slice(1);
		if (was === "timeout" && /^[0-9]+([.][0-9]+)?[smhd]?$/.test(ws[0] ?? ""))
			ws = ws.slice(1);
		else if (was === "nice" && ws[0] === "-n") ws = ws.slice(2);
	}
	return ws;
}

/**
 * @param {Run} run
 * @param {Command} cmd
 */
function judge(run, cmd) {
	const words = unwrapped(cmd.words);
	const [head, sub, verb] = words;
	if (head === undefined || !isGhCommand(head)) return;
	if (sub === "issue") {
		if (verb !== "create") return;
		if (readRoadmapOrOpen(run) === null) return;
		judgeCreate(run, cmd, words.slice(3));
	} else if (sub === "api") judgeApi(run, cmd, words.slice(2));
}

/**
 * @param {Run} run
 * @returns {string | null}
 */
function readRoadmapOrOpen(run) {
	if (run.roadmap !== undefined) return run.roadmap;
	const got = run.ctx.tree().read(ROADMAP);
	if (got.state === "unreadable")
		return open(
			run.ctx,
			`${ROADMAP} is unreadable — issue creation allowed unchecked`,
		);
	run.roadmap = got.state === "read" ? got.data : null;
	return run.roadmap;
}

/**
 * @param {Run} run
 * @param {Command} cmd
 * @param {string[]} args
 */
function judgeCreate(run, cmd, args) {
	/** @type {CreateScan} */
	const scan = { spans: run.parsed.spans, title: "", unreadable: "" };
	const scanned = scanFlags(
		ISSUE_VALUE_FLAGS.create,
		args,
		(kind, name, value) => createWord(scan, kind, name, value),
	);
	if (!scanned) return;
	if (scan.title) judgeTitle(run, cmd.segment, scan.title);
	if (scan.unreadable)
		open(run.ctx, `${scan.unreadable} — create allowed unchecked`);
}

/** @typedef {{ spans: string[], title: string, unreadable: string }} CreateScan */

/**
 * @param {CreateScan} scan
 * @param {import("./shell-words.js").FlagKind} kind
 * @param {string} name
 * @param {string} value
 */
function createWord(scan, kind, name, value) {
	if (name === "--help" || name === "-h") return false;
	const isTitle = name === "--title" || name === "-t";
	if (kind === "opt" && isTitle) {
		const read = literal(value, scan.spans);
		scan.title = read.known ? read.text : "";
		if (!read.known)
			scan.unreadable = "could not read the --title of a gh issue create";
	} else if (kind === "dangling" && isTitle)
		scan.unreadable = "a gh issue create ends in a --title with no value";
	else if (kind === "arg" && /[$`]/.test(value))
		scan.unreadable = "could not read the arguments of a gh issue create";
	return true;
}

/**
 * @param {Run} run
 * @param {Command} cmd
 * @param {string[]} args
 */
function judgeApi(run, cmd, args) {
	const call = scanApi(args, run.parsed.spans);
	const { spans } = run.parsed;
	const method = literal(call.method, spans);
	const endpoint = literal(call.endpoint, spans);
	if (method.known && !isPost(method.text, call)) return;
	if (endpoint.known && !isIssueCollection(endpoint.text)) return;
	if (readRoadmapOrOpen(run) === null) return;
	if (!method.known || !endpoint.known || call.input)
		open(
			run.ctx,
			"could not read a gh api issue creation — create allowed unchecked",
		);
	if (call.opaque)
		open(
			run.ctx,
			"could not read a field name on a gh api issue creation — create allowed unchecked",
		);
	const title = apiTitle(run, call.fields);
	if (title) judgeTitle(run, cmd.segment, title);
}

/**
 * @param {string} method
 * @param {import("./gh-api-call.js").ApiCall} call
 */
const isPost = (method, call) =>
	method ? method.toUpperCase() === "POST" : defaultsToPost(call);

/**
 * @param {Run} run
 * @param {string[]} fields
 */
function apiTitle(run, fields) {
	let title = "";
	for (const field of fields) {
		const { text } = literal(field, run.parsed.spans);
		if (!text.startsWith("title=")) continue;
		title = text.slice("title=".length);
		if (/[$`]/.test(title))
			open(
				run.ctx,
				"could not read the title field on a gh api issue creation — create allowed unchecked",
			);
	}
	return title;
}

/** @param {string} title */
function cardOf(title) {
	let at = -1;
	for (const dash of [" — ", " – ", "—"]) {
		at = title.indexOf(dash);
		if (at >= 0) break;
	}
	if (at < 0) return null;
	const prefix = trimRun(title.slice(0, at), BASH_SPACE);
	return CARD_ID.test(prefix) ? prefix : null;
}

/**
 * @param {Run} run
 * @param {string} card
 */
function phaseOf(run, card) {
	const roadmap = readRoadmapOrOpen(run);
	if (roadmap === null) return null;
	const re = new RegExp(`id:"${card}",p:([0-9])`);
	const hit = re.exec(roadmap);
	return hit ? requiredGroup(hit, 1, re) : null;
}

/**
 * @param {string} text
 * @param {string} card
 */
function isCalled(text, card) {
	let inside = false;
	for (const line of text.split("\n")) {
		if (line.includes("called-cards:begin")) {
			inside = true;
			continue;
		}
		if (line.includes("called-cards:end")) inside = false;
		if (inside && line.startsWith(`- \`${card}\``)) return true;
	}
	return false;
}

/**
 * @param {Run} run
 * @param {string} segment
 * @param {string} title
 */
function judgeTitle(run, segment, title) {
	const card = cardOf(title);
	if (card === null) return;
	const phase = phaseOf(run, card);
	if (phase === null || phase === "0") return;
	const register = run.ctx.tree().read(REGISTER);
	if (register.state !== "read")
		return open(
			run.ctx,
			`${REGISTER} is ${register.state} — issue creation for ${card} allowed unchecked`,
		);
	if (isCalled(register.data, card)) return;
	deny(run.ctx, segment, uncalledReason(card, phase));
}

/**
 * @param {string} card
 * @param {string} phase
 */
const uncalledReason = (
	card,
	phase,
) => `This opens an issue for \`${card}\`, a **Phase ${phase}** roadmap card the founder has not called: @CMD@

The project is still validating Phase 0. On 27 August 2026, 33 issues that had been opened this way — decision map mantahostels#1489 (\`search-core\`) alone spun up nine in a day — were retired back onto their cards, because work was accumulating on a frontier nobody had asked for.

**A card becomes workable when the founder calls it, and only then — then any session adds its row to \`docs/called-cards.md\`. Never add the row to unblock yourself** — a session that can call its own card is under no constraint at all. Ask him, naming the card and what you want to open on it.

**What to do instead: write the question onto the \`${card}\` card** in \`docs/reference-roadmap.html\`, through the \`roadmap-edit\` skill, as a parked question to re-file when the card is taken.

**Re-titling to get past this guard is the one thing you must not do.** This hook reads the \`${card} — \` prefix and nothing else, so removing it files the issue unchallenged — which makes the prefix an honesty marker, not a syntax rule. If you genuinely believe this is repo machinery rather than the adopter's product, business, catalogue or legal decision, that is a judgement the founder gets to check: say so to him in plain words and let him answer, rather than editing the title and proceeding.

Rule: docs/called-cards.md; mantahostels#1613.`;

module.exports = { field: "command", noun: "command", decide, unwrapped };
