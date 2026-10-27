/*
 * issue-phase-scope.js — guard-issue-phase-scope.js's core (#2798, programme
 * #2733): does an issue a Bash call creates name, in its title prefix, a
 * roadmap card outside Phase 0 that the founder has not called?
 *
 * A CORE: it does no I/O. The roadmap and the register arrive through two
 * file-read ports, and the core-path spelling through a third;
 * lib/issue-phase-scope-host.js builds the real ones.
 *
 * THE FIRST VERDICT ENDS THE CALL. A deny stops the walk, and so does a
 * fail-open, which is logged and lets the whole call through unjudged.
 */

const {
	defaultsToPost,
	isIssueCollection,
	scanApi,
} = require("./gh-api-call.js");
const { deny, open, walkVerdict } = require("./guard-verdict.js");
const { ISSUE_VALUE_FLAGS } = require("./gh-issue-ref.js");
const { parseCommand } = require("./shell-parse.js");
const { requiredGroup } = require("./regex-group.js");
const {
	commandName,
	isGhCommand,
	literal,
	scanFlags,
} = require("./shell-words.js");

/**
 * @typedef {object} PhasePorts
 * @property {(rel: string) => boolean} readable whether the file at `rel`,
 *   relative to the host root, can be opened for reading
 * @property {(rel: string) => string} readFile its text; throws where it
 *   cannot be read
 * @typedef {import("./kit-context.js").KitContext & PhasePorts} PhaseContext
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {import("./shell-parse.js").Parsed} Parsed
 * @typedef {import("./guard-entry.js").Decision} Decision
 */

const ROADMAP = "docs/reference-roadmap.html";
const REGISTER = "docs/called-cards.md";

/* Wrappers that run their argument as a command, followed only in their
 * no-argument forms: `env FOO=1 gh …` and `timeout --signal=X …` stop the
 * walk, which leaves the create unjudged rather than misjudged. */
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

/* A card id is lower-case, digits and hyphens. Anything else — a sentence, a
 * capital, a slash — is prose that happens to contain a dash. THIS REGEX IS
 * ALSO WHAT MAKES A CARD SAFE to build the roadmap's pattern from: it admits
 * no metacharacter. Relaxing it arms phaseOf — re-check it before you widen
 * it. */
const CARD_ID = /^[a-z0-9][a-z0-9-]*$/;

/**
 * @typedef {object} Run one call's judging
 * @property {Parsed} parsed
 * @property {PhaseContext} ctx
 * @property {string | null} [roadmap] the roadmap's text, read once a call
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

/**
 * The words past every no-argument wrapper: `timeout` takes its duration with
 * it and `nice` its `-n <adjustment>`, which is what makes `timeout 60 gh
 * issue create …` reach the judge rather than stopping on the digits.
 * @param {string[]} words
 */
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
 * One command the call runs: `gh issue create` and `gh api` are judged.
 * @param {Run} run
 * @param {Command} cmd
 */
function judge(run, cmd) {
	const words = unwrapped(cmd.words);
	const [head, sub, verb] = words;
	if (head === undefined || !isGhCommand(head)) return;
	if (sub === "issue") {
		if (verb !== "create") return;
	} else if (sub !== "api") return;
	/* The roadmap is what says a card's phase, and a guard that cannot read
	 * its own authority allows the work. Checked HERE, once the command is
	 * known to be a creation. */
	if (!run.ctx.readable(ROADMAP))
		open(
			run.ctx,
			`${ROADMAP} is unreadable — issue creation allowed unchecked`,
		);
	if (sub === "issue") judgeCreate(run, cmd, words.slice(3));
	else judgeApi(run, cmd, words.slice(2));
}

/**
 * `gh issue create …` — the flag form.
 * @param {Run} run
 * @param {Command} cmd
 * @param {string[]} args
 */
function judgeCreate(run, cmd, args) {
	/** @type {CreateScan} */
	const scan = { spans: run.parsed.spans, title: "", unreadable: "" };
	/* Stopped, the scan met --help: a command that prints documentation and
	 * files nothing. */
	const scanned = scanFlags(
		ISSUE_VALUE_FLAGS.create,
		args,
		(kind, name, value) => createWord(scan, kind, name, value),
	);
	if (!scanned) return;
	/* THE TITLE IS JUDGED FIRST, even where some other argument was
	 * unreadable. The title is the guard's only input: if it read cleanly and
	 * names an uncalled card, failing open would let `--title "search-core —
	 * x" $_` walk a deniable creation through on an irrelevant expansion. */
	if (scan.title) judgeTitle(run, cmd.segment, scan.title);
	if (scan.unreadable)
		open(run.ctx, `${scan.unreadable} — create allowed unchecked`);
}

/**
 * @typedef {{ spans: string[], title: string, unreadable: string }}
 *   CreateScan one create's flag scan: the title it read, and in
 *   `unreadable` the last thing it could not
 */

/**
 * One event of a create's flag scan; false stops the scan, on --help.
 * @param {CreateScan} scan accumulator: title and unreadable are set
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
 * `gh api … repos/<o>/<r>/issues` — the same creation through REST. GraphQL
 * is a documented residual (LIMITS).
 * @param {Run} run
 * @param {Command} cmd
 * @param {string[]} args
 */
function judgeApi(run, cmd, args) {
	const call = scanApi(args);
	const { spans } = run.parsed;
	const method = literal(call.method, spans);
	const endpoint = literal(call.endpoint, spans);
	if (method.known && !isPost(method.text, call)) return;
	/* GraphQL is no issue collection, so it leaves here (LIMITS). */
	if (endpoint.known && !isIssueCollection(endpoint.text)) return;
	if (!method.known || !endpoint.known || call.input)
		open(
			run.ctx,
			"could not read a gh api issue creation — create allowed unchecked",
		);
	/* THE FIELD NAME DECIDES WHETHER THE VALUE MATTERS, so a field whose own
	 * NAME is masked — `-f "$FIELD"` — could be the title and cannot be told
	 * from any other. */
	if (call.opaque)
		open(
			run.ctx,
			"a gh api issue creation carried a masked field word — create allowed unchecked",
		);
	const title = apiTitle(run, call.fields);
	if (title) judgeTitle(run, cmd.segment, title);
}

/**
 * Whether a read method is a POST, gh's own default where none was given.
 * @param {string} method
 * @param {import("./gh-api-call.js").ApiCall} call
 */
const isPost = (method, call) =>
	method ? method.toUpperCase() === "POST" : defaultsToPost(call);

/**
 * The last `title=` field's value, "" where none; a field name or a title
 * value it cannot read fails open.
 * @param {Run} run
 * @param {string[]} fields
 */
function apiTitle(run, fields) {
	let title = "";
	for (const field of fields) {
		const { text } = literal(field, run.parsed.spans);
		const eq = text.indexOf("=");
		if (/[$`]/.test(eq < 0 ? text : text.slice(0, eq)))
			open(
				run.ctx,
				"could not read a field name on a gh api issue creation — create allowed unchecked",
			);
		if (!text.startsWith("title=")) continue;
		title = text.slice("title=".length);
		/* The name read but the VALUE did not, so the card cannot be known. */
		if (/[$`]/.test(title))
			open(
				run.ctx,
				"could not read the title field on a gh api issue creation — create allowed unchecked",
			);
	}
	return title;
}

/**
 * The card id a title names, or null. The convention is `<card-id> —
 * <subject>` with an EM DASH or an EN DASH; a hyphen is not accepted, because
 * card ids contain hyphens and `seed-listings - x` cannot be split without
 * guessing where the id ends. The prefix is TRIMMED before it is judged.
 * @param {string} title
 */
function cardOf(title) {
	let at = -1;
	for (const dash of [" — ", " – ", "—"]) {
		at = title.indexOf(dash);
		if (at >= 0) break;
	}
	if (at < 0) return null;
	const prefix = title
		.slice(0, at)
		.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");
	return CARD_ID.test(prefix) ? prefix : null;
}

/**
 * A card's phase digit, null where the roadmap names no such card — the
 * prefix was never a card reference. A roadmap that will not read is
 * recorded, never collapsed into "no such card".
 * @param {Run} run accumulator: roadmap is read into it once a call
 * @param {string} card
 */
function phaseOf(run, card) {
	if (run.roadmap === undefined) {
		try {
			run.roadmap = run.ctx.readFile(ROADMAP);
		} catch {
			run.roadmap = null;
		}
	}
	if (run.roadmap === null)
		open(
			run.ctx,
			`${ROADMAP} would not read — issue creation for ${card} allowed unchecked`,
		);
	const re = new RegExp(`id:"${card}",p:([0-9])`);
	const hit = re.exec(run.roadmap);
	return hit ? requiredGroup(hit, 1, re) : null;
}

/**
 * Whether the founder has called a card. Only rows BETWEEN the two markers
 * are read, so the format example in the register's own prose is not a live
 * row. A register that passes the readable check and still will not read is
 * read as holding no rows.
 * @param {Run} run
 * @param {string} card
 */
function isCalled(run, card) {
	let text = "";
	try {
		text = run.ctx.readFile(REGISTER);
	} catch {
		/* no rows */
	}
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
 * Given a title, decide.
 * @param {Run} run
 * @param {string} segment
 * @param {string} title
 */
function judgeTitle(run, segment, title) {
	const card = cardOf(title);
	if (card === null) return;
	const phase = phaseOf(run, card);
	if (phase === null || phase === "0") return;
	if (!run.ctx.readable(REGISTER))
		open(
			run.ctx,
			`${REGISTER} is unreadable — issue creation for ${card} allowed unchecked`,
		);
	if (isCalled(run, card)) return;
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

**What to do instead: write the question onto the \`${card}\` card** in \`docs/reference-roadmap.html\`, through the \`roadmap-edit\` skill, as a parked question to re-file when the card is taken. That is where all 33 went, and it loses nothing.

**Re-titling to get past this guard is the one thing you must not do.** This hook reads the \`${card} — \` prefix and nothing else, so removing it files the issue unchallenged — which makes the prefix an honesty marker, not a syntax rule. If you genuinely believe this is repo machinery rather than the adopter's product, business, catalogue or legal decision, that is a judgement the founder gets to check: say so to him in plain words and let him answer, rather than editing the title and proceeding.

Rule: docs/called-cards.md; mantahostels#1613.`;

module.exports = { decide, unwrapped };
