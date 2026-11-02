/*
 * review-findings.js — the `**Review findings:**` record's form: what
 * report-remeasure-due.js counts and reports, and what resolve-ticket.js
 * refuses to post, read one way so a close and the report cannot disagree
 * (#3846). The form is docs/agents/rules/review-tier-records.txt's.
 */

const { ghApiSlurp } = require("./gh.js");
const { gitOutcome } = require("./git.js");
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
const TIER = /\*\*Review tier:\*\*\s*[`(]*([^\s`.,;:()\u2013\u2014]*)/g;
const COUNTED_TIERS = new Set(["escalated", "mission-critical"]);
/* What the rule lets a session declare, so any other word is reported. */
const KNOWN_TIERS = new Set([...COUNTED_TIERS, "standard"]);
const BULLET = /^\s*-\s/;
const KNOWN = /^\s*-\s*(?:FIXED|TICKETED)\b/;
const FIXED = /^\s*-\s*FIXED\b/;
/* A FIXED or TICKETED line in another spelling (#3907): any case right after a
 * list marker, upper case anywhere on a list line or opening a bare one, as
 * "Fixed by the next commit." is prose. A declined line counts 0 however spelt. */
const LIST_MARKER = "(?:[-*+–—•]|\\d+[.)])";
const LIST_LINE = new RegExp(`^\\s*${LIST_MARKER}`);
const UPPER_WORD = /(?<![A-Za-z])(?:FIXED|TICKETED)(?![A-Za-z])/;
const MARKED_SPELLING = new RegExp(
	`^\\s*${LIST_MARKER}\\s*[^A-Za-z]*(?:fixed|ticketed)(?![A-Za-z])`,
	"i",
);
const BARE_SPELLING = /^\s*[*_`]*(?:FIXED|TICKETED)(?![A-Za-z])/;
const DECLINED_SPELLING = new RegExp(
	`^\\s*(?:${LIST_MARKER})?\\s*[^A-Za-z]*declined(?![A-Za-z])`,
	"i",
);
const BLANK = /^\s*$/;
const INDENTED = /^\s+\S/;
/* A list ends at the next record, even one bulleted or indented, so its
 * defects are never counted under this one too. */
const RECORD_START = new RegExp(RECORD_HEAD);
/* Residual: an unbackticked mention in bold prose under a counted tier is
 * reported, and a record backticked whole is skipped unreported. */
const RECORD_MENTION = new RegExp(RECORD_HEAD, "g");
const TIER_MENTION = new RegExp(TIER.source);
const FORM_HEAD = /\*\*(?:Review findings|Review tier|Escaped defect):\*\*/;
/* At any indent or behind a list marker, as a fence under a bullet is. Residual:
 * a block indented four spaces with no fence reads as text, a record indented
 * under a list being one. */
const FENCE_LINE = /^\s*(?:[-*+]\s+)?(`{3,}|~{3,})(.*)$/;
const QUOTE_LINE = /^ {0,3}>/;
/* A closed backtick span, a closed quoted one, its single quote touching no
 * word so an apostrophe opens none, or a backtick opening straight onto a head
 * and never closed. */
const QUOTED_SPAN = new RegExp(
	`(?<!\`)(\`+)(?!\`).*?(?<!\`)\\1(?!\`)|"[^"]*"|“[^”]*”|(?<!\\w)'[^']*'(?!\\w)|‘[^’]*’|\`+(?=${FORM_HEAD.source}).*`,
	"g",
);
/* What can end a sentence but no path, or a bare lower-case word: read only
 * where git cannot judge the entry, so `Makefile` and a `run.` git names pass.
 * Residual: there, a path-shaped or capitalised stray passes too (#3907). */
const NOT_A_PATH = /[.;:!?)]$|^[a-z]+$/;
const REVIEWED = new RegExp(REVIEWED_TREE);
const BASE = new RegExp(`\\bbase\\s+${SHA}`);
/* Read from an unparsed mention, which `parseMarks` cuts at its first `\n`, so
 * the run reaches its end unanchored (#3383). */
const UNPARSED_PATHS = new RegExp(PATHS_CLAUSE);
const RULE_COMMAND = "`scripts/lib/rule-text.sh review-tier-records`";
const ESCAPED = new RegExp(`\\*\\*Escaped defect:\\*\\*\\s*${SHA}`, "g");

/**
 * @typedef {{ body: string, createdAt: string }} Comment
 * @typedef {{ repo: string, issue: number | null, base: string,
 *   tree: string, landed: string, paths: string | null, posted: string,
 *   tier: string, fixed: number, fixes: number, cutOff: number,
 *   misspelt: number, escapes: string[], isTipReverted?: boolean }} ReviewRecord
 *   `issue` null on a commit known by its trailer alone
 * @typedef {{ repo: string, issue: number, line: string }} Unparsed
 * @typedef {{ at: number, tier: string, line: string }
 *   | { at: number, record: RegExpExecArray }
 *   | { at: number, unparsed: string }} Mark
 * @typedef {{ tag: "NO TIER" | "CUT OFF" | "MISSPELT" | "NOT PATHS" | "UNJUDGED",
 *   what: string, fix: string }} RecordFault
 *   what follows "has a record, landed <sha>,"; what a record of the same review
 *   must be posted with
 */

/** @param {RegExpExecArray} m @param {number} n @param {RegExp} re */
const group = (m, n, re) => requiredGroup(m, n, re).toLowerCase();

/** @param {number} ms */
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** @param {string} text */
const blanked = (text) => text.replace(/[^\n]/g, " ");

/** @param {string} line */
function readFence(line) {
	const m = FENCE_LINE.exec(line.trimEnd());
	return m
		? {
				run: requiredGroup(m, 1, FENCE_LINE),
				rest: requiredGroup(m, 2, FENCE_LINE),
			}
		: null;
}

/**
 * `body` with every mention of the record forms blanked, length kept: a fenced
 * block, a quoted line, and a backtick or double-quote span holding a form's
 * head. A sha or path backticked in a real record is no mention. Every reading
 * of a comment goes through this one rule.
 *
 * @param {string} body
 */
function maskMentions(body) {
	/** @type {string | null} */
	let fence = null;
	return body
		.split("\n")
		.map((line) => {
			const f = readFence(line);
			if (fence !== null) {
				if (f?.run.startsWith(fence) && f.rest === "") fence = null;
				return blanked(line);
			}
			if (f && !(f.run.startsWith("`") && f.rest.includes("`"))) {
				fence = f.run;
				return blanked(line);
			}
			if (QUOTE_LINE.test(line)) return blanked(line);
			return line.replace(QUOTED_SPAN, (span) =>
				FORM_HEAD.test(span) ? blanked(span) : span,
			);
		})
		.join("\n");
}

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
		else {
			inList = false;
			past.push(line);
		}
	}
	return { listed, past };
}

/** @param {string} line */
const isMisspelt = (line) =>
	!KNOWN.test(line) &&
	!DECLINED_SPELLING.test(line) &&
	(MARKED_SPELLING.test(line) ||
		BARE_SPELLING.test(line) ||
		(LIST_LINE.test(line) && UPPER_WORD.test(line)));

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

/** @param {string} body @param {number} at */
const lineAt = (body, at) => body.slice(at).replace(/\n[\s\S]*/, "");

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
			line: lineAt(body, m.index),
		})),
		...found.map((m) => ({ at: m.index, record: m })),
		...[...body.matchAll(RECORD_MENTION)]
			.filter((m) => !parsed.has(m.index))
			.map((m) => ({
				at: m.index,
				unparsed: lineAt(body, m.index),
			})),
	].sort((x, y) => x.at - y.at);
}

/**
 * The record `m` matched in a masked comment, under `tier`.
 *
 * @param {{ repo: string, issue: number }} where
 * @param {RegExpExecArray} m
 * @param {string} tier
 * @param {string} createdAt
 * @returns {ReviewRecord}
 */
function buildRecord(where, m, tier, createdAt) {
	const { listed, past } = parseDispositions(m.input.slice(m.index));
	return {
		...where,
		base: group(m, 1, FINDINGS),
		tree: group(m, 2, FINDINGS),
		landed: group(m, 3, FINDINGS),
		paths: pathsOf(m),
		posted: day(Date.parse(createdAt)),
		tier,
		fixed: listed.filter((l) => KNOWN.test(l)).length,
		fixes: listed.filter((l) => FIXED.test(l)).length,
		cutOff: past.filter((l) => KNOWN.test(l)).length,
		misspelt: [...listed, ...past].filter(isMisspelt).length,
		escapes: [],
	};
}

/**
 * The records, escaped-defect shas, unparseable records under a counted tier
 * and tier lines in no known word, none known after them, in one ticket's
 * comments, read in order so each record takes the tier last declared above it.
 *
 * @param {string} repo
 * @param {number} issue
 * @param {Comment[]} comments
 * @returns {{ records: ReviewRecord[], escaped: string[], unparsed: Unparsed[],
 *   unknownTiers: Unparsed[] }}
 */
function parseIssue(repo, issue, comments) {
	const where = { repo, issue };
	const masked = comments.map(({ body, createdAt }) => ({
		body: maskMentions(body),
		createdAt,
	}));
	/** @type {ReviewRecord[]} */
	const records = [];
	/** @type {Unparsed[]} */
	const unparsed = [];
	/** @type {Unparsed[]} */
	let unknownTiers = [];
	let tier = "";
	const marks = masked.flatMap((c) =>
		parseMarks(c.body).map((mark) => ({ mark, posted: c.createdAt })),
	);
	for (const { mark, posted } of marks) {
		if ("tier" in mark) {
			tier = mark.tier;
			unknownTiers = KNOWN_TIERS.has(tier)
				? []
				: [...unknownTiers, { ...where, line: mark.line }];
		} else if ("record" in mark)
			records.push(buildRecord(where, mark.record, tier, posted));
		else if (COUNTED_TIERS.has(tier))
			unparsed.push({ ...where, line: mark.unparsed });
	}
	return {
		records,
		escaped: masked.flatMap(({ body }) =>
			[...body.matchAll(ESCAPED)].map((m) => group(m, 1, ESCAPED)),
		),
		unparsed: unparsed.filter((u) => !isSuperseded(u, records)),
		unknownTiers,
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
 * Whether `draft` holds anything the parse would read as a record or a tier, so
 * a close with neither reads no comments.
 *
 * @param {string} draft
 */
const hasRecordMention = (draft) => {
	const body = maskMentions(draft);
	return body.search(RECORD_MENTION) !== -1 || TIER_MENTION.test(body);
};

/**
 * What a record's cut-off lines are, as a close's refusal and the report name them.
 *
 * @param {number} cutOff
 */
const describeCutOff = (cutOff) =>
	`${cutOff} - FIXED or - TICKETED line${cutOff === 1 ? "" : "s"} past a line that ends its list`;

/**
 * The entries of `r`'s paths that no replay of it could read as a path: each
 * one, a file or a directory, under which neither `base..reviewed` nor
 * `base..landed` changes anything in the checkout at `root`, the second as `paths`
 * also names a file that joined with the fixes. Where git cannot read those, with
 * no checkout or a sha it does not hold, those shaped as a sentence's words: the
 * failure itself is the close's lost-base refusal's and the report's UNJUDGED and
 * UNREAD lines to name (#3907).
 *
 * @param {ReviewRecord & { paths: string }} r
 * @param {string | null} root
 * @returns {string[]}
 */
function readStrayPaths(r, root) {
	const entries = pathListOf(r.paths);
	const byShape = () => entries.filter((e) => NOT_A_PATH.test(e));
	if (root === null) return byShape();
	/** @type {string[]} */
	const changed = [];
	for (const to of [r.tree, r.landed]) {
		const diff = gitOutcome(
			[
				"-c",
				"core.quotePath=false",
				"--literal-pathspecs",
				"diff",
				"--name-only",
				"--no-renames",
				r.base,
				to,
				"--",
				...entries,
			],
			[],
			root,
		);
		if (!diff.ok) return byShape();
		changed.push(...diff.out.split("\n"));
	}
	return entries.filter((e) => {
		const entry = e.replace(/^\.\//, "").replace(/\/$/, "");
		return !changed.some((c) => c === entry || c.startsWith(`${entry}/`));
	});
}

/**
 * The fault `r`'s paths owe where no replay reads one as a path.
 *
 * @param {ReviewRecord} r
 * @param {string | null} root
 * @returns {RecordFault[]}
 */
function readPathFaults(r, root) {
	if (r.paths === null) return [];
	const stray = readStrayPaths({ ...r, paths: r.paths }, root);
	return stray.length === 0
		? []
		: [
				{
					tag: "NOT PATHS",
					what: `whose paths hold ${stray.map((e) => `"${e}"`).join(", ")}, no path changed in its replay, so that replay would miss what the runs saw`,
					fix: "with the marker's paths= and no note after them",
				},
			];
}

/**
 * The fault a record being closed owes on a base the checkout it was reviewed in
 * lacks, mistyped. Not the report's: its other checkout may never have fetched it,
 * and its UNREAD line names a range it walks (#3907).
 *
 * @param {ReviewRecord} r
 * @param {string | null} root
 * @returns {RecordFault[]}
 */
function readLostBaseFaults(r, root) {
	if (root === null) return [];
	const base = gitOutcome(
		["rev-parse", "--verify", "--quiet", `${r.base}^{commit}`],
		[1],
		root,
	);
	return base.ok && base.out === ""
		? [
				{
					tag: "UNJUDGED",
					what: `whose base ${r.base} this checkout does not hold, so no replay of it can run`,
					fix: "naming the base its review ran from",
				},
			]
		: [];
}

/**
 * What loses `r`'s defects or a replay of it, read one way for a close's refusal
 * and the report. `unknownTiers` reports the tier line itself, this the record
 * under it.
 *
 * @param {ReviewRecord} r
 * @param {string | null} root the checkout that tracks its repo, if any
 * @returns {RecordFault[]}
 */
function readRecordFaults(r, root) {
	/** @type {RecordFault[]} */
	const faults = [];
	const counted = COUNTED_TIERS.has(r.tier);
	if (!counted)
		faults.push({
			tag: "NO TIER",
			what: `under ${r.tier === "" ? "no tier line" : `the tier ${r.tier}`}, so its defects count nowhere`,
			fix: "under a `**Review tier:**` line of escalated or mission-critical where the review ran at one, or, a standard review owing no such record, as plain prose",
		});
	if (counted && r.cutOff > 0)
		faults.push({
			tag: "CUT OFF",
			what: `with ${describeCutOff(r.cutOff)}, so they count 0`,
			fix: "with its whole list straight under it and the prose after",
		});
	if (counted && r.misspelt > 0)
		faults.push({
			tag: "MISSPELT",
			what: `with ${r.misspelt} disposition line${r.misspelt === 1 ? "" : "s"} not spelt - FIXED or - TICKETED, so they count 0`,
			fix: "with each line spelt - FIXED or - TICKETED",
		});
	return [...faults, ...readPathFaults(r, root)];
}

/**
 * The refusal a close comment owes where, posted on a ticket holding `prior`,
 * it would hold a record the report calls UNPARSEABLE, a tier in no known word,
 * or a record readRecordFaults faults; "" where it owes none.
 *
 * @param {number} n
 * @param {Comment[]} prior
 * @param {string} draft
 * @param {string | null} root
 */
function buildFindingsRefusal(n, prior, draft, root) {
	/* The repo and the date go into nothing read here. */
	const all = parseIssue("", n, [
		...prior,
		{ body: draft, createdAt: new Date(0).toISOString() },
	]);
	const masked = maskMentions(draft);
	const rule = rulePointer("review-tier-records");
	return [
		...all.unparsed
			.filter((u) => masked.includes(u.line))
			.map(
				(u) =>
					`#${n}'s comment holds a **Review findings:** record not in the form, so its commit would not be counted:
  ${u.line}
Correct it to the rule's form, nothing after the landed sha but the paths. Name the sha as pushed: it need not have reached main yet. No pushed sha yet: push, then close. Only naming the form: put it in backticks. ${rule}`,
			),
		...all.unknownTiers
			.filter((u) => masked.includes(u.line))
			.map(
				(u) =>
					`#${n}'s comment holds a tier in no known word, so no record under it would be counted:
  ${u.line}
Write standard, escalated or mission-critical. Only naming the form: put it in backticks. ${rule}`,
			),
		...all.records
			.slice(parseIssue("", n, prior).records.length)
			.flatMap((r) =>
				[...readRecordFaults(r, root), ...readLostBaseFaults(r, root)].map(
					(f) =>
						`#${n}'s comment holds a **Review findings:** record, landed ${r.landed}, ${f.what}. Correct it: write the record ${f.fix}. ${rule}`,
				),
			),
	].join("\n");
}

module.exports = {
	COUNTED_TIERS,
	day,
	buildFindingsRefusal,
	group,
	hasRecordMention,
	HEX_RUN,
	isSameReview,
	isSameSha,
	parseIssue,
	pathListOf,
	readTicketComments,
	readRecordFaults,
	RULE_COMMAND,
};
