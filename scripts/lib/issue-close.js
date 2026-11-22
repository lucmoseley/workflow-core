// #2798
const {
	deny,
	open,
	ruleOrFallback,
	walkVerdict,
} = require("./guard-verdict.js");
const { ISSUE_VALUE_FLAGS } = require("./gh-issue-ref.js");
const { parseCommand } = require("./shell-parse.js");
const { isGhCommand, literal, scanFlags } = require("./shell-words.js");
const { requiredGroup } = require("./regex-group.js");
const { repoSlug } = require("./workflow-core-config.js");
const { ENTRY_BUDGET_MS } = require("./hook-deadline.js");
const { trimEndRun } = require("./trim-run.js");
const { readTreeText } = require("./file-read.js");

/**
 * @typedef {{ refusal: string } | { outOfBudget: true }} RefusalRead
 * @typedef {object} ClosePorts
 * @property {(args: string[], timeoutMs: number) => string} gh
 * @property {() => number} now
 * @property {() => string | undefined} tracker
 * @property {(n: number, timeoutMs: number, tree: string) => RefusalRead} census
 * @property {(n: number, comment: string, timeoutMs: number,
 *  tree: string) => RefusalRead} landing
 * @typedef {import("./kit-context.js").KitContext & ClosePorts
 *  & Pick<import("./core-contract.js").CoreContext, "tree">} CloseContext
 * @typedef {import("./shell-parse.js").Command} Command
 * @typedef {import("./shell-parse.js").Parsed} Parsed
 * @typedef {import("./guard-entry.js").Decision} Decision
 */

const BUDGET_MS = ENTRY_BUDGET_MS.PreToolUse;
// guess, #2798
const CALL_MS = 4000;
// guess, #2798
const MIN_CALL_MS = 1000;

const ROADMAP = "docs/reference-roadmap.html";

// guess, #2798
const TITLE_EXCERPT_CHARS = 40;

const SPACE = "[ \\t\\n\\v\\f\\r]";

// lucmoseley/mantahostels#220
const CARD_TITLE_RE = /^([a-z0-9][a-z0-9-]*) — /;
const LOOSE_CARD_TITLE_RE = new RegExp(
	`^${SPACE}*[A-Za-z0-9._-]+${SPACE}+[—–-]${SPACE}`,
);

const CRITERIA_HEADING_RE = new RegExp(
	`(^|\\n)${SPACE}{0,3}#+${SPACE}+acceptance`,
);

/**
 * @typedef {object} Issue
 * @property {Record<string, unknown> | undefined} data
 * @typedef {object} Run
 * @property {Parsed} parsed
 * @property {CloseContext} ctx
 * @property {number} start
 * @property {string} fetched
 * @property {Issue | null} issue
 * @typedef {object} Close
 * @property {string} segment
 * @property {string} issue
 * @property {boolean} hasReason
 * @property {string} reason
 * @property {boolean} reasonHidden
 * @property {string} repo
 * @property {boolean} repoHidden
 * @property {string} comment
 * @property {boolean} commentHidden
 */

/**
 * @param {string} command
 * @param {CloseContext} ctx
 * @returns {Decision}
 */
function decide(command, ctx) {
	/** @type {Run} */
	const run = {
		parsed: parseCommand(command),
		ctx,
		start: ctx.now(),
		fetched: "",
		issue: null,
	};
	return walkVerdict(run.parsed, (cmd) => judge(run, cmd), ctx) ?? null;
}

/** @param {Run} run */
const callBudget = (run) =>
	Math.min(CALL_MS, BUDGET_MS - (run.ctx.now() - run.start));

/**
 * @param {Run} run
 * @param {Command} cmd
 */
function judge(run, cmd) {
	const [head = "", sub, verb] = cmd.words;
	if (!isGhCommand(head)) return;
	if (sub !== "issue" || verb !== "close") return;
	const close = scanClose(run, cmd.segment, cmd.words.slice(3));
	const notPlanned = abandoned(run, close);

	if (!close.issue) return;
	if (!/^[0-9]+$/.test(close.issue))
		open(
			run.ctx,
			"could not read the issue number from a gh issue close — close allowed unchecked",
		);
	if (close.repoHidden)
		open(
			run.ctx,
			"could not read the --repo value of a gh issue close — close allowed unchecked",
		);

	if (!notPlanned && !elsewhere(run, close)) judgeCard(run, close);
	judgeTicketedTags(run, close);
	judgeChildren(run, close, notPlanned);
	if (notPlanned) return;
	const criteriaRead = judgeCriteria(run, close);
	judgeOutstanding(run, close);
	judgeLanding(run, close);
	judgeCensus(run, close);
	if (!criteriaRead)
		run.ctx.log(
			`could not read ${close.repo}#${close.issue} — acceptance criteria unchecked`,
		);
}

/**
 * @param {Run} run
 * @param {Close} close
 */
function abandoned(run, close) {
	if (!close.hasReason) return false;
	return close.reasonHidden
		? /not[\s\S]planned/.test(run.parsed.subject.toLowerCase())
		: /^not[\s\S]planned$/.test(close.reason.toLowerCase());
}

/**
 * @param {Close} close
 * @param {string} text
 */
function readIssue(close, text) {
	if (!close.issue) close.issue = text.replace(/^\\/, "").replace(/^#/, "");
}

/**
 * @param {Close} close
 * @param {string} text
 * @param {boolean} known
 */
const readReason = (close, text, known) => {
	close.hasReason = true;
	close.reason = text;
	close.reasonHidden = !known;
};

/**
 * @param {Close} close
 * @param {string} text
 * @param {boolean} known
 */
const readRepo = (close, text, known) => {
	close.repo = text;
	if (!known) close.repoHidden = true;
};

/**
 * @param {Close} close
 * @param {string} text
 * @param {boolean} known
 */
const readComment = (close, text, known) => {
	close.comment = text;
	close.commentHidden = !known;
};

const CLOSE_READS = new Map([
	["-r", readReason],
	["--reason", readReason],
	["-R", readRepo],
	["--repo", readRepo],
	["-c", readComment],
	["--comment", readComment],
]);

/**
 * @param {Run} run
 * @param {string} segment
 * @param {string[]} words
 * @returns {Close}
 */
function scanClose(run, segment, words) {
	/** @type {Close} */
	const close = {
		segment,
		issue: "",
		hasReason: false,
		reason: "",
		reasonHidden: false,
		repo: "",
		repoHidden: false,
		comment: "",
		commentHidden: false,
	};
	scanFlags(ISSUE_VALUE_FLAGS.close, words, (kind, name, value) => {
		const { text, known } = literal(value, run.parsed.spans);
		if (kind === "arg") readIssue(close, text);
		else if (kind === "opt") CLOSE_READS.get(name)?.(close, text, known);
		else if (kind === "dangling" && (name === "-r" || name === "--reason")) {
			close.hasReason = true;
			close.reasonHidden = true;
		}
	});
	return close;
}

/**
 * @param {Run} run
 * @param {Close} close
 */
function elsewhere(run, close) {
	if (!close.repo) return false;
	const tracker = run.ctx.tracker();
	if (!tracker) return false;
	return repoSlug(close.repo) !== repoSlug(tracker);
}

/**
 * @param {Run} run
 * @param {Close} close
 * @returns {Issue | null}
 */
function fetchIssue(run, close) {
	const key = `${close.repo}#${close.issue}`;
	if (run.fetched === key) return run.issue;
	run.issue = null;
	run.fetched = key;
	const left = callBudget(run);
	if (left < MIN_CALL_MS) return null;
	let out;
	try {
		out = run.ctx.gh(
			[
				"issue",
				"view",
				close.issue,
				"--json",
				"comments,title,parent,labels,body,subIssues,url",
				...(close.repo ? ["--repo", close.repo] : []),
			],
			left,
		);
	} catch {
		return null;
	}
	if (!out) return null;
	/** @type {Record<string, unknown> | undefined} */
	let data;
	try {
		/** @type {unknown} */
		const parsed = JSON.parse(out);
		data = parsed === null ? {} : record(parsed);
	} catch {
		data = undefined;
	}
	run.issue = { data };
	return run.issue;
}

/**
 * @param {unknown} v
 * @returns {Record<string, unknown> | undefined}
 */
const record = (v) =>
	typeof v === "object" && v !== null && !Array.isArray(v)
		? /** @type {Record<string, unknown>} */ (v)
		: undefined;

/** @param {unknown} v */
const field = (v) =>
	v === null || v === undefined || v === false ? "" : String(v);

/** @param {Record<string, unknown>} data */
const newestComment = (data) =>
	field(
		Array.isArray(data.comments)
			? record(data.comments.at(-1))?.body
			: undefined,
	);

/**
 * @param {Run} run
 * @param {Close} close
 */
function judgeCard(run, close) {
	const fault = cardFault(run, close);
	if (fault) run.ctx.log(`${fault} — card state unchecked`);
}

/**
 * @param {Run} run
 * @param {Close} close
 * @returns {string}
 */
function cardFault(run, close) {
	const data = fetchIssue(run, close)?.data;
	if (!data) return "";
	const title = field(data.title);
	const m = CARD_TITLE_RE.exec(title);
	if (!m)
		return LOOSE_CARD_TITLE_RE.test(title)
			? `title "${[...title].slice(0, TITLE_EXCERPT_CHARS).join("")}" looks like a card id this guard will not parse, so it`
			: "";
	const id = requiredGroup(m, 1, CARD_TITLE_RE);
	if (field(record(data.parent)?.number)) return "";
	const labels = Array.isArray(data.labels)
		? data.labels
				.map((/** @type {unknown} */ l) => field(record(l)?.name))
				.join(" ")
		: "";
	if (` ${labels} `.includes(" wayfinder:map ")) return "";
	const got = readTreeText(run.ctx.tree(), ROADMAP);
	if (got.state === "unreadable")
		return `could not read the roadmap, so card ${id}`;
	// #5576
	if (got.state === "absent") return "";
	const roadmap = got.data;
	const count = roadmap.split(`id:"${id}",`).length - 1;
	if (count !== 1) return `${id} names ${count} cards on the roadmap, so it`;
	// guess, #2798
	const window =
		new RegExp(`id:"${id}",[^\\n]{0,200}`, "u").exec(roadmap)?.[0] ?? "";
	const state = /state:"([a-z]*)"/.exec(window)?.[1] ?? "";
	if (!state) return `card ${id} has no readable state, so it`;
	if (state !== "done") denyCard(run, close, id, state);
	return "";
}

/**
 * @param {Run} run
 * @param {Close} close
 * @param {string} id
 * @param {string} state
 * @returns {never}
 */
function denyCard(run, close, id, state) {
	return deny(
		run.ctx,
		close.segment,
		`This closes the issue for roadmap card \`${id}\`, and that card is still \`${state}\`, not \`done\`: @CMD@

Close it with **/card-close ${close.issue}** instead.

${ruleOrFallback(run.ctx, "card-close-by-hand", "A roadmap card's own issue is closed by /card-close, never by hand")}`,
	);
}

/**
 * @param {Run} run
 * @param {Close} close
 * @param {boolean} notPlanned
 */
function judgeChildren(run, close, notPlanned) {
	const data = fetchIssue(run, close)?.data;
	if (!data) {
		if (notPlanned)
			run.ctx.log(
				`could not read ${close.repo}#${close.issue} — open sub-issues unchecked`,
			);
		return;
	}
	const nodes = record(data.subIssues)?.nodes;
	if (!Array.isArray(nodes)) {
		run.ctx.log(
			`no subIssues in ${close.repo}#${close.issue}'s payload — open sub-issues unchecked`,
		);
		return;
	}
	if (!nodes.some((k) => field(record(k)?.state) === "OPEN")) return;
	const { openChildrenRefusal } = require("./open-children.js");
	const refusal = openChildrenRefusal(
		close.issue,
		field(data.url).replace(/(?<![0-9])[0-9]+$/, ""),
		nodes.map((/** @type {unknown} */ k) => {
			const kid = record(k);
			return {
				number: field(kid?.number),
				title: field(kid?.title),
				url: field(kid?.url),
				open: field(kid?.state) === "OPEN",
			};
		}),
	);
	deny(
		run.ctx,
		close.segment,
		`This close leaves a sub-issue open: @CMD@

${refusal}`,
	);
}

/**
 * @param {Run} run
 * @param {Close} close
 */
function judgeCriteria(run, close) {
	const issue = fetchIssue(run, close);
	if (!issue) return false;
	const body = field(issue.data?.body);
	if (!CRITERIA_HEADING_RE.test(body.toLowerCase())) return true;
	const { unmetCriteria } = require("./ticket-criteria.js");
	const unmet = trimEndRun(
		unmetCriteria(body)
			.map((i) => i.text)
			.join("\n"),
		"\n",
	);
	if (!unmet) return true;
	return deny(
		run.ctx,
		close.segment,
		`This closes #${close.issue} over acceptance criteria neither ticked nor waived: @CMD@

${unmet
	.split("\n")
	.map((l) => `  - [ ] ${l}`)
	.join("\n")}

Re-run the close once each is ticked or waived — or, abandoning the issue, with --reason "not planned".

${ruleOrFallback(run.ctx, "ticket-criteria-unticked", "Tick each acceptance criterion this session verified, or annotate it **waived:** <why>, before closing")}`,
	);
}

/**
 * @param {Run} run
 * @param {Close} close
 */
function judgeTicketedTags(run, close) {
	if (close.commentHidden) return;
	const { ticketedRefusal } = require("./ticketed-tags.js");
	const refusal = ticketedRefusal(close.comment);
	if (refusal)
		deny(
			run.ctx,
			close.segment,
			`This close posts a whole-spec review that tickets a finding naming no exception: @CMD@

${refusal}`,
		);
}

/**
 * @param {Run} run
 * @param {Close} close
 */
function judgeOutstanding(run, close) {
	const at = `${close.repo}#${close.issue}`;
	if (close.commentHidden) {
		run.ctx.log(
			`could not read the --comment of a gh issue close on ${at} — close allowed unchecked`,
		);
		return;
	}
	const {
		buildRefusalText,
		hasOutstandingLine,
		judge: judgeLine,
	} = require("./outstanding-line.js");
	let said;
	let from;
	if (hasOutstandingLine(close.comment)) {
		said = close.comment;
		from = "this close's own --comment";
	} else {
		const data = fetchIssue(run, close)?.data;
		if (!data)
			return open(
				run.ctx,
				`could not read comments on ${at} — close allowed unchecked`,
			);
		said = newestComment(data);
		from = `#${close.issue}'s newest comment — an older one does not count`;
	}
	const left = callBudget(run);
	if (left < MIN_CALL_MS)
		open(
			run.ctx,
			`no time left in the guard's budget to judge ${at}'s Outstanding line — close allowed unchecked`,
		);
	const verdict = judgeLine(said, {
		grammar: "outstanding",
		self: close.issue,
		tracker: close.repo ? repoSlug(close.repo) : (run.ctx.tracker() ?? null),
		timeoutMs: left,
		log: null,
		gh: (args, { timeout }) => run.ctx.gh(args, timeout),
	});
	if (verdict.ok) {
		for (const line of verdict.unchecked)
			if (line) run.ctx.log(`Outstanding open-check on ${at}: ${line}`);
		return;
	}
	deny(
		run.ctx,
		close.segment,
		`This close does not say what is still outstanding in the form this guard reads: @CMD@

Read: ${from}.
${trimEndRun(buildRefusalText(verdict), "\n")}

${ruleOrFallback(run.ctx, "close-outstanding", "Every close says what is still outstanding, on a line beginning **Outstanding:**")}

In one call, with the comment checked before anything is written: node ${run.ctx.scriptPath("resolve-ticket.js")} <n> --comment-file <file>. It refuses a comment without a passing **Outstanding:** line, a **Bound:** line, a **Values:** line (**Values:** none where nothing is house or untraced) or a **Practice:** line, and one naming a commit sha without a **Door:** line.`,
	);
}

/**
 * @typedef {object} RefusalRule
 * @property {string} reader
 * @property {string} unchecked
 * @property {(at: string) => string} reading
 * @property {string} line
 * @property {(text: string) => boolean} hasLine
 * @property {(ctx: CloseContext, n: number, comment: string, timeoutMs: number) => RefusalRead} read
 * @property {string} opening
 * @property {string} remedy
 */

/** @type {RefusalRule} */
const CENSUS_RULE = {
	reader: "the census reader",
	unchecked: "census rows unchecked",
	reading: (at) => `${at}'s census rows`,
	line: "a Census line",
	hasLine: (text) => require("./census-digest.js").hasCensusLine(text),
	read: (ctx, n, _comment, ms) => ctx.census(n, ms, ctx.tree().root),
	opening: "This close leaves census rows its commits expired",
	remedy: "each row is re-anchored",
};

/** @type {RefusalRule} */
const LANDING_RULE = {
	reader: "the landing reader",
	unchecked: "landing unchecked",
	reading: (at) => `whether ${at}'s commits landed`,
	line: "an Unlanded line",
	hasLine: (text) => require("./unlanded-commits.js").hasUnlandedLine(text),
	read: (ctx, n, comment, ms) => ctx.landing(n, comment, ms, ctx.tree().root),
	opening: "This close reports work that has not landed",
	remedy: "they are pushed",
};

/**
 * @param {Run} run
 * @param {Close} close
 */
const judgeCensus = (run, close) => judgeRefusalRule(run, close, CENSUS_RULE);

/**
 * @param {Run} run
 * @param {Close} close
 */
const judgeLanding = (run, close) => judgeRefusalRule(run, close, LANDING_RULE);

/**
 * @param {Run} run
 * @param {Close} close
 * @param {RefusalRule} rule
 */
function judgeRefusalRule(run, close, rule) {
	const at = `${close.repo}#${close.issue}`;
	if (close.commentHidden) return;
	if (elsewhere(run, close)) return;
	const issue = fetchIssue(run, close);
	const newest = issue?.data ? newestComment(issue.data) : "";
	const left = callBudget(run);
	if (left < MIN_CALL_MS) {
		run.ctx.log(
			`no time left in the guard's budget to read ${rule.reading(at)} — unchecked`,
		);
		return;
	}
	const noVerdict = () =>
		run.ctx.log(`${rule.reader} gave no verdict on ${at} — ${rule.unchecked}`);
	const n = Number(close.issue);
	if (n < 1) return noVerdict();
	const said = `${close.comment}\n\n${newest}`;
	if (rule.hasLine(said)) return;
	/** @type {RefusalRead} */
	let read;
	try {
		read = rule.read(run.ctx, n, close.comment || newest, left);
	} catch {
		return noVerdict();
	}
	if ("outOfBudget" in read) {
		run.ctx.log(
			`${rule.reader} ran out of the guard's time budget on ${at} — ${rule.unchecked}`,
		);
		return;
	}
	if (!read.refusal) return;
	if (!issue) {
		run.ctx.log(
			`could not read ${at}'s newest comment for ${rule.line} — ${rule.unchecked}`,
		);
		return;
	}
	deny(
		run.ctx,
		close.segment,
		`${rule.opening}: @CMD@

${read.refusal} Where it goes: ${ruleOrFallback(run.ctx, "close-outstanding-where", "the close's own --comment, else the newest comment")}

Re-run the close once ${rule.remedy} or the line is written — or, abandoning the issue, with --reason "not planned".`,
	);
}

module.exports = { field: "command", noun: "command", decide };
