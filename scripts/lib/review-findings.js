const { ghApiSlurp } = require("./gh.js");
const { readCommit } = require("./commit-sha.js");
const { gitOutcome, gitReader } = require("./git.js");
const { requiredGroup } = require("./regex-group.js");
const { rulePointer } = require("./rule-text.js");
const { scriptPath } = require("./script-path.js");
const { isUnder } = require("./is-under.js");

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
const KNOWN_TIERS = new Set([...COUNTED_TIERS, "standard"]);
const BULLET = /^\s*-\s/;
const KNOWN = /^\s*-\s*(?:FIXED|TICKETED)\b/;
const FIXED = /^\s*-\s*FIXED\b/;
const LIST_MARKER = "(?:[-*+–—•]|\\d+[.)])";
const LIST_LINE = new RegExp(`^\\s*${LIST_MARKER}`);
const SPELLING = "(?:FIX(?:E[DS]|ING)?|TICKET(?:ED|S|ING)?)(?![A-Za-z])";
const UPPER_WORD = new RegExp(`(?<![A-Za-z])${SPELLING}`);
const MARKED_SPELLING = new RegExp(
	`^\\s*${LIST_MARKER}[^A-Za-z]*${SPELLING}`,
	"i",
);
const BARE_SPELLING = new RegExp(`^\\s*[*_\`]*${SPELLING}`);
const DECLINED_SPELLING = /^[^A-Za-z]*declined(?![A-Za-z])/i;
const BLANK = /^\s*$/;
const INDENTED = /^\s+\S/;
const RECORD_START = new RegExp(RECORD_HEAD);
const RECORD_MENTION = new RegExp(RECORD_HEAD, "g");
const TIER_MENTION = new RegExp(TIER.source);
const FORM_HEAD = /\*\*(?:Review findings|Review tier|Escaped defect):\*\*/;
const FENCE_LINE = /^\s*(?:[-*+]\s+)?(`{3,}(?!`)|~{3,}(?!~))(.*)$/;
const QUOTE_LINE = /^ {0,3}>/;
const QUOTED_SPAN = new RegExp(
	// eslint-disable-next-line regexp/no-super-linear-move -- input is issue, comment, commit or reply text from the repo's own writers; a crafted one slows the hook, nothing worse (#4642)
	`(?<!\`)(\`+)(?!\`).*?(?<!\`)\\1(?!\`)|"[^"]*"|“[^”]*”|(?<!\\w)'[^']*'(?!\\w)|‘[^’]*’|\`+(?=${FORM_HEAD.source}).*`,
	"g",
);
const NOT_A_PATH = /[.;:!?)]$|^[a-z]+$/;
const REVIEWED = new RegExp(REVIEWED_TREE);
const BASE = new RegExp(`\\bbase\\s+${SHA}`);
const UNPARSED_PATHS = new RegExp(PATHS_CLAUSE);
const RULE_COMMAND = `\`${scriptPath("lib/rule-text.sh")} review-tier-records\``;
const ESCAPED = new RegExp(`\\*\\*Escaped defect:\\*\\*\\s*${SHA}`, "g");

/**
 * @typedef {{ body: string, createdAt: string }} Comment
 * @typedef {{ repo: string, issue: number | null, base: string,
 *   tree: string, landed: string, paths: string | null, posted: string,
 *   tier: string, fixed: number, fixes: number, cutOff: number,
 *   misspelt: number, escapes: string[], isTipReverted?: boolean }} ReviewRecord
 * @typedef {{ repo: string, issue: number, line: string }} Unparsed
 * @typedef {{ at: number, tier: string, line: string }
 *   | { at: number, record: RegExpExecArray }
 *   | { at: number, unparsed: string }} Mark
 * @typedef {{ tag: "NO TIER" | "CUT OFF" | "MISSPELT" | "NOT PATHS" | "UNJUDGED",
 *   what: string, fix: string, fixWhereUnowed?: string }} RecordFault
 */

/** @param {RegExpExecArray} m @param {number} n @param {RegExp} re */
const group = (m, n, re) => requiredGroup(m, n, re).toLowerCase();

/** @param {number} ms */
const day = (ms) => new Date(ms).toISOString().slice(0, 10);

/** @param {string} text */
const blanked = (text) => text.replace(/[^\n]/g, " ");

/** @param {string} line */
function parseFence(line) {
	const m = FENCE_LINE.exec(line.trimEnd());
	return m
		? {
				run: requiredGroup(m, 1, FENCE_LINE),
				rest: requiredGroup(m, 2, FENCE_LINE),
			}
		: null;
}

/**
 * @param {string} body
 * @param {RegExp} [head]
 */
function maskMentions(body, head = FORM_HEAD) {
	/** @type {string | null} */
	let fence = null;
	return body
		.split("\n")
		.map((line) => {
			const f = parseFence(line);
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
				head.test(span) ? blanked(span) : span,
			);
		})
		.join("\n");
}

/**
 * @param {string} after
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

/** @param {RegExpExecArray} m */
const pathsOf = (m) =>
	m[4] === undefined ? null : m[4].replace(/`/g, "").trim();

/**
 * @typedef {{ whole: string, words: string[] }} PathEntry
 */

/**
 * @param {string} paths
 * @returns {PathEntry[]}
 */
function pathEntriesOf(paths) {
	const bare = paths.replace(/`/g, "").trim();
	if (bare === "") return [];
	if (!bare.includes(",")) return [{ whole: bare, words: bare.split(/\s+/) }];
	return bare
		.split(",")
		.map((whole) => whole.trim())
		.filter(Boolean)
		.map((whole) => ({ whole, words: [whole] }));
}

/** @param {PathEntry[]} entries */
const pathspecsOf = (entries) => [
	...new Set(entries.flatMap((e) => [e.whole, ...e.words])),
];

/** @param {string} paths */
const pathListOf = (paths) => pathspecsOf(pathEntriesOf(paths));

/** @param {string} paths */
const pathSetOf = (paths) =>
	paths
		.replace(/`/g, "")
		.split(/[\s,]+/)
		.filter(Boolean)
		.sort()
		.join(",");

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

/** @param {string} draft */
const hasRecordMention = (draft) => {
	const body = maskMentions(draft);
	return body.search(RECORD_MENTION) !== -1 || TIER_MENTION.test(body);
};

/** @param {number} cutOff */
const describeCutOff = (cutOff) =>
	`${cutOff} - FIXED or - TICKETED line${cutOff === 1 ? "" : "s"} past a line that ends its list`;

/**
 * @param {ReviewRecord & { paths: string }} r
 * @param {string | null} root
 * @returns {string[]}
 */
function readStrayPaths(r, root) {
	const entries = pathEntriesOf(r.paths);
	const byShape = () =>
		entries.flatMap(({ whole, words }) => {
			const stray = whole.split(/\s+/).filter((w) => NOT_A_PATH.test(w));
			return stray.length === 0 || words.length > 1 ? stray : [whole];
		});
	const pathspecs = pathspecsOf(entries);
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
				...pathspecs,
			],
			[],
			root,
		);
		if (!diff.ok) return byShape();
		changed.push(...diff.out.split("\n"));
	}
	/** @param {string} e */
	const isChanged = (e) => {
		const entry = e.replace(/^\.\//, "").replace(/\/$/, "");
		return changed.some((c) => isUnder(c, [entry]));
	};
	return entries.flatMap(({ whole, words }) => {
		if (isChanged(whole)) return [];
		const stray = words.filter((w) => !isChanged(w));
		return stray.length === words.length ? [whole] : stray;
	});
}

/**
 * @param {ReviewRecord} r
 * @param {string | null} root
 * @returns {RecordFault[]}
 */
function readPathFaults(r, root) {
	if (r.paths === null) return [];
	const stray = readStrayPaths({ ...r, paths: r.paths }, root).map(
		(e) => `"${e}"`,
	);
	return stray.length === 0
		? []
		: [
				{
					tag: "NOT PATHS",
					what: `whose paths hold ${stray.join(", ")}, no path changed in its replay, so that replay would miss what the runs saw`,
					fix: `with the marker's paths= less any of ${stray.join(", ")} it names, as no file changes under them in its replay, and no note after them`,
				},
			];
}

/**
 * @param {ReviewRecord} r
 * @param {string | null} root
 * @returns {RecordFault[]}
 */
function readLostBaseFaults(r, root) {
	if (root === null) return [];
	const base = readCommit(gitReader(root), r.base);
	return base.ok && base.sha === null
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
 * @param {ReviewRecord} r
 * @param {string | null} root
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
			fix: "under a `**Review tier:**` line of escalated or mission-critical where the review ran at one",
			fixWhereUnowed: "a standard review owing no such record, as plain prose",
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
 * @param {number} n
 * @param {Comment[]} prior
 * @param {string} draft
 * @param {string | null} root
 */
function buildFindingsRefusal(n, prior, draft, root) {
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
						`#${n}'s comment holds a **Review findings:** record, landed ${r.landed}, ${f.what}. Correct it: write the record ${f.fix}${f.fixWhereUnowed ? `, or, ${f.fixWhereUnowed}` : ""}. ${rule}`,
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
	maskMentions,
	parseIssue,
	pathListOf,
	readTicketComments,
	readRecordFaults,
	RULE_COMMAND,
};
