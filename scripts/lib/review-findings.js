/*
 * review-findings.js — the `**Review findings:**` record's form: what
 * report-remeasure-due.js counts and reports, and what resolve-ticket.js
 * refuses to post, read one way so a close and the report cannot disagree
 * (#3846). The form is docs/agents/rules/review-tier-records.txt's.
 */

const { ghApiSlurp } = require("./gh.js");
const { requiredGroup } = require("./regex-group.js");
const { rulePointer } = require("./rule-text.js");

const HEX_RUN = "[0-9a-f]{7,40}";
const SHA = `\`?(${HEX_RUN})(?![0-9a-z])\`?`;
const RECORD_HEAD = "\\*\\*Review findings:\\*\\*";
const REVIEWED_TREE = `reviewed\\s+${SHA}`;
const PATHS_CLAUSE = ",[ \\t]*paths[ \\t]+([^\\n]+)";
const FINDINGS = new RegExp(
	`${RECORD_HEAD}\\s*base\\s+${SHA},\\s*${REVIEWED_TREE},\\s*landed\\s+${SHA}(?:${PATHS_CLAUSE}|[ \\t\\r]*(?=\\n|$))`,
	"g",
);
const TIER = /\*\*Review tier:\*\*\s*`?([A-Za-z-]+)/g;
const COUNTED_TIERS = new Set(["escalated", "mission-critical"]);
const BULLET = /^\s*-\s/;
const KNOWN = /^\s*-\s*(?:FIXED|TICKETED)\b/;
const FIXED = /^\s*-\s*FIXED\b/;
const BLANK = /^\s*$/;
const INDENTED = /^\s+\S/;
/* A list ends at the next record, even one bulleted or indented, so its
 * defects are never counted under this one too. */
const RECORD_START = new RegExp(RECORD_HEAD);
/* A backticked one names the format, as a review comment quoting it does.
 * Residual: an unbackticked mention in bold prose under a counted tier is
 * reported, and a record backticked whole is skipped unreported. */
const RECORD_MENTION = new RegExp(`(?<!\`)${RECORD_HEAD}`, "g");
const REVIEWED = new RegExp(REVIEWED_TREE);
const BASE = new RegExp(`\\bbase\\s+${SHA}`);
/* Read from an unparsed mention, which `parseMarks` cuts at its first `\n`, so
 * the run reaches its end unanchored (#3383). */
const UNPARSED_PATHS = new RegExp(PATHS_CLAUSE);
const ESCAPED = new RegExp(`\\*\\*Escaped defect:\\*\\*\\s*${SHA}`, "g");

/**
 * @typedef {{ body: string, createdAt: string }} Comment
 * @typedef {{ repo: string, issue: number | null, base: string,
 *   tree: string, landed: string, paths: string | null, posted: string,
 *   tier: string, fixed: number, fixes: number, cutOff: number,
 *   escapes: string[], isTipReverted?: boolean }} ReviewRecord
 *   `issue` null on a commit known by its trailer alone
 * @typedef {{ repo: string, issue: number, line: string }} Unparsed
 * @typedef {{ at: number, tier: string } | { at: number, record: RegExpExecArray }
 *   | { at: number, unparsed: string }} Mark
 */

/** @param {RegExpExecArray} m @param {number} n @param {RegExp} re */
const group = (m, n, re) => requiredGroup(m, n, re).toLowerCase();

/** @param {number} ms */
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The lines under a record: those its list holds, running past blank and
 * indented continuation lines (#1698), and those after the first other line,
 * up to the next record, which no count reads.
 *
 * @param {string} after the text following the record's own line
 * @returns {{ listed: string[], past: string[] }}
 */
function parseDispositions(after) {
	/** @type {string[]} */
	const listed = [];
	/** @type {string[]} */
	const past = [];
	let inList = true;
	for (const line of after.split("\n").slice(1)) {
		if (RECORD_START.test(line)) break;
		if (!inList) past.push(line);
		else if (
			KNOWN.test(line) ||
			BULLET.test(line) ||
			BLANK.test(line) ||
			INDENTED.test(line)
		)
			listed.push(line);
		else inList = false;
	}
	return { listed, past };
}

/**
 * A record's reviewed paths, null on one written before #1926.
 *
 * @param {RegExpExecArray} m
 */
const pathsOf = (m) =>
	m[4] === undefined ? null : m[4].replace(/`/g, "").trim();

/** @param {string} paths */
const pathListOf = (paths) =>
	paths
		.replace(/`/g, "")
		.split(/[\s,]+/)
		.filter(Boolean);

/** @param {string} paths */
const pathSetOf = (paths) => pathListOf(paths).sort().join(",");

/**
 * @param {string} body
 * @returns {Mark[]}
 */
function parseMarks(body) {
	const found = [...body.matchAll(FINDINGS)];
	const parsed = new Set(found.map((m) => m.index));
	return [
		...[...body.matchAll(TIER)].map((m) => ({
			at: m.index,
			tier: group(m, 1, TIER),
		})),
		...found.map((m) => ({ at: m.index, record: m })),
		...[...body.matchAll(RECORD_MENTION)]
			.filter((m) => !parsed.has(m.index))
			.map((m) => ({
				at: m.index,
				unparsed: body.slice(m.index).replace(/\n[\s\S]*/, ""),
			})),
	].sort((x, y) => x.at - y.at);
}

/**
 * The records, escaped-defect shas and unparseable records under a counted
 * tier in one ticket's comments, read in order so each record takes the tier
 * last declared above it.
 *
 * @param {string} repo
 * @param {number} issue
 * @param {Comment[]} comments
 * @returns {{ records: ReviewRecord[], escaped: string[], unparsed: Unparsed[] }}
 */
function parseIssue(repo, issue, comments) {
	/** @type {ReviewRecord[]} */
	const records = [];
	/** @type {string[]} */
	const escaped = [];
	/** @type {Unparsed[]} */
	const unparsed = [];
	let tier = "";
	for (const { body, createdAt } of comments) {
		for (const m of body.matchAll(ESCAPED)) escaped.push(group(m, 1, ESCAPED));
		const marks = parseMarks(body);
		for (const mark of marks) {
			if ("tier" in mark) {
				tier = mark.tier;
				continue;
			}
			if ("unparsed" in mark) {
				if (COUNTED_TIERS.has(tier))
					unparsed.push({ repo, issue, line: mark.unparsed });
				continue;
			}
			const m = mark.record;
			const { listed, past } = parseDispositions(body.slice(m.index));
			records.push({
				repo,
				issue,
				base: group(m, 1, FINDINGS),
				tree: group(m, 2, FINDINGS),
				landed: group(m, 3, FINDINGS),
				paths: pathsOf(m),
				posted: day(Date.parse(createdAt)),
				tier,
				fixed: listed.filter((l) => KNOWN.test(l)).length,
				fixes: listed.filter((l) => FIXED.test(l)).length,
				cutOff: past.filter((l) => KNOWN.test(l)).length,
				escapes: [],
			});
		}
	}
	return {
		records,
		escaped,
		unparsed: unparsed.filter((u) => !isSuperseded(u, records)),
	};
}

/** @param {string} a @param {string} b */
const isSameSha = (a, b) => a.startsWith(b) || b.startsWith(a);

/**
 * Whether two records, or a record and what an unparseable one still names,
 * are one review: by reviewed tree, or by base and paths.
 *
 * @typedef {{ tree: string | null, base: string | null, paths: string | null }} ReviewNames
 * @param {ReviewNames} a
 * @param {ReviewNames} b
 */
function isSameReview(a, b) {
	return (
		(a.tree !== null && b.tree !== null && isSameSha(a.tree, b.tree)) ||
		(a.base !== null &&
			b.base !== null &&
			a.paths !== null &&
			b.paths !== null &&
			isSameSha(a.base, b.base) &&
			pathSetOf(a.paths) === pathSetOf(b.paths))
	);
}

/**
 * Whether a parsed record on its ticket supersedes `u`.
 *
 * @param {Unparsed} u
 * @param {ReviewRecord[]} records
 */
function isSuperseded(u, records) {
	const tree = REVIEWED.exec(u.line);
	const base = BASE.exec(u.line);
	const paths = UNPARSED_PATHS.exec(u.line);
	const names = {
		tree: tree && group(tree, 1, REVIEWED),
		base: base && group(base, 1, BASE),
		paths: paths && requiredGroup(paths, 1, UNPARSED_PATHS),
	};
	return records.some((r) => isSameReview(r, names));
}

/**
 * Every comment on `n`, any account's.
 *
 * @param {string} repo
 * @param {number} n
 * @returns {Comment[]}
 */
function readTicketComments(repo, n) {
	return ghApiSlurp([`repos/${repo}/issues/${n}/comments`]).map(
		(/** @type {{ body: string | null, created_at: string }} */ c) => ({
			body: c.body ?? "",
			createdAt: c.created_at,
		}),
	);
}

/**
 * Whether `draft` holds anything the record's parse would read as a record,
 * so a close with none reads no comments.
 *
 * @param {string} draft
 */
const hasRecordMention = (draft) => draft.search(RECORD_MENTION) !== -1;

/**
 * What a record's cut-off lines are, as a close's refusal and the report name them.
 *
 * @param {number} cutOff
 */
const describeCutOff = (cutOff) =>
	`${cutOff} - FIXED or - TICKETED line${cutOff === 1 ? "" : "s"} past a line that ends its list`;

/**
 * The refusal a close comment owes where, posted on a ticket holding `prior`,
 * it would hold a record the report calls UNPARSEABLE, or a counted-tier record
 * whose `- FIXED` or `- TICKETED` lines sit past a line that ends its list, so
 * count 0; "" where it owes none.
 *
 * @param {number} n
 * @param {Comment[]} prior
 * @param {string} draft
 */
function buildFindingsRefusal(n, prior, draft) {
	/* The repo and the date go into nothing read here. */
	const all = parseIssue("", n, [
		...prior,
		{ body: draft, createdAt: new Date(0).toISOString() },
	]);
	const malformed = all.unparsed.filter((u) => draft.includes(u.line));
	const cut = all.records
		.slice(parseIssue("", n, prior).records.length)
		.filter((r) => COUNTED_TIERS.has(r.tier) && r.cutOff > 0);
	return [
		...malformed.map(
			(u) =>
				`#${n}'s comment holds a **Review findings:** record not in the form, so its commit would not be counted:
  ${u.line}
Correct it to the rule's form, nothing after the landed sha but the paths. Name the sha as pushed: it need not have reached main yet. No pushed sha yet: push, then close. Only naming the form: put it in backticks. ${rulePointer("review-tier-records")}`,
		),
		...cut.map(
			(r) =>
				`#${n}'s comment holds a **Review findings:** record, landed ${r.landed}, with ${describeCutOff(r.cutOff)}, so they would count 0. Put the disposition lines straight under the record, the prose after them.`,
		),
	].join("\n");
}

module.exports = {
	COUNTED_TIERS,
	day,
	buildFindingsRefusal,
	describeCutOff,
	group,
	hasRecordMention,
	HEX_RUN,
	isSameReview,
	isSameSha,
	parseIssue,
	pathListOf,
	readTicketComments,
};
