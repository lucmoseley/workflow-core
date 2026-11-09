/*
 * origin-fallback.js — the origin of an issue that carries no `origin:*`
 * label, by #4627's keyword rules (its §1.1, first match wins), for the
 * weekly ticket-mix review (#4796, #4797). A hand `gh issue create` bypasses
 * file-issue.js's `--origin`, and every issue filed before it has none.
 *
 * A PORT of the trial's `bin/classify.py` `origin()`: the same tests in the
 * same order, the same regexes and the same provenance text (`prov()`). Its outputs are mapped onto
 * lib/issue-origin.js's fixed list by OUTPUT_MAP below; `unmarked` is no
 * signal at all. Two departures, both outside any regex: the trial's
 * `daily-report-script` is split by its title (a morning review is
 * `morning-review-script`, the other two daily reports are `incident`), and
 * the provenance line's `.` is `[^\n]`, because Python's `.` takes a `\r`
 * and JavaScript's does not.
 */

const { isOrigin } = require("./issue-origin");

const OUTPUT_MAP = /** @type {const} */ ({
	"retro-sweep": "retro",
	"founder-raised": "founder",
	split: "follow-up",
});

const UNMARKED = "unmarked";

const PRE_CHARS = 600;
const SECTION_CHARS = 260;
const SECTIONS_READ = 2;
const RULED_CHARS = 400;
const FOUND_BY_CHARS = 40;
const FOUND_BY_HEAD = 200;
const MORNING_HEAD = 60;

/**
 * @typedef {{ name: string } | string} Label
 * @typedef {{ title?: string | null, body?: string | null,
 *   labels?: Label[] | null }} IssueText
 */

/**
 * The provenance line and the lowered provenance text.
 * @param {string} b
 * @returns {{ sl: string, p: string }}
 */
function prov(b) {
	const m = /^(Standalone[:,][^\n]*|Part of [^\n]*)$/m.exec(b);
	const sl = m?.[1] ?? "";
	const secs = b.split(/^#{1,3} /m);
	const pre = secs[0] ?? "";
	const rest = secs
		.slice(1, 1 + SECTIONS_READ)
		.map((x) => x.slice(0, SECTION_CHARS))
		.join(" ");
	return {
		sl,
		p: `${sl} \n ${pre.slice(0, PRE_CHARS)} \n ${rest}`.toLowerCase(),
	};
}

/**
 * @param {string} pattern
 * @param {string} s
 */
const R = (pattern, s) => new RegExp(pattern, "i").test(s);

/** @param {Label} l */
const labelName = (l) => (typeof l === "string" ? l : l.name);

/**
 * @typedef {{ t: string, L: Set<string>, b: string, sl: string, p: string }} Read
 * @typedef {[string, (r: Read) => boolean]} Rule
 */

/** @type {Rule[]} */
const RULES = [
	["morning-review-script", ({ t }) => R("^Morning review — ", t)],
	[
		"incident",
		({ t }) => R("^Suite queue wait is over|^Memory kill incident from", t),
	],
	[
		"code-review",
		({ t, L }) =>
			isWayfinder(L) && R("code-review findings|review findings", t),
	],
	["wayfinder", ({ L }) => isWayfinder(L)],
	["to-spec", ({ t, L }) => L.has("kind:spec") || t.startsWith("Spec:")],
	["orphaned-edit-script", ({ t }) => t.startsWith("Orphaned edit")],
	[
		"lander-script",
		({ t }) => R("reverted by the lander|dropped by the (queue )?lander", t),
	],
	[
		"lander-script",
		({ t, p }) =>
			t.startsWith("Landing queue held") ||
			t.startsWith("Landing queue stalled") ||
			p.includes("held-queue issue") ||
			p.includes("stall ticket tracks"),
	],
	[
		"ci-red",
		({ t, L, p }) =>
			L.has("ci-red") ||
			R("red (test on )?main|red ci|ci red|landing break", p) ||
			t.startsWith("CI red"),
	],
	["release-bump", ({ t }) => t.startsWith("Bump workflow-core")],
	[
		"repo-checks-script",
		({ t, L }) =>
			t.startsWith("Repo checks: standing findings") ||
			L.has("manual-finding") ||
			R("is stale against", t),
	],
	[
		"morning-review-script",
		({ b, p }) =>
			R("morning review", p) &&
			R("^(## )?(closed tickets|clear delegated)", b.slice(0, MORNING_HEAD)),
	],
	[
		"found-in-passing",
		({ p }) =>
			R(
				"^found by #\\d+ \\(",
				(p.split("\n").at(-1) ?? "").trim().slice(0, FOUND_BY_CHARS),
			) && !R("review|concision|census|scan|audit", p.slice(0, FOUND_BY_HEAD)),
	],
	[
		"concision-pass",
		({ t, p }) =>
			R(
				"concision pass|concision-pass|concision finding|concision follow|\\bpass\\b.{0,40}tenure|tenure|pre-existing (comment|text|prose)",
				p,
			) || R("concision|clear tenure|^cut or refuse|pre-existing", t),
	],
	["architecture-scan", ({ p }) => R("architecture.scan", p)],
	["heresy-sweep", ({ p }) => R("heresy", p)],
	["retro-sweep", ({ p }) => R("retro.sweep|retro finding|\\bretro\\b", p)],
	[
		"code-review",
		({ t, p }) =>
			R("code-review finding", p) ||
			R(
				"(whole-spec|spec-axis|spec|standards|code|security|test|axis|concurrency|fresh) review|review (of|found|follow)|review's|reviewer found|from (its|the) .{0,30}review",
				p,
			) ||
			R("review findings|review found", t),
	],
	[
		"ruling-impl",
		({ p }) =>
			R("\\bruled\\b|ruling", p.slice(0, RULED_CHARS)) && !R("census row", p),
	],
	[
		"measure-census",
		({ t, p }) =>
			R(
				"census row|census found|census re|re-measure (the|of)|re-anchor|found by .{0,20}(census|measurement)|measured by",
				p,
			) || R("^(re-measure|census|measure)", t),
	],
	[
		"incident",
		({ p }) => R("memory kill|incident|rcu stall|\\bstall\\b|freeze|oom", p),
	],
	["audit", ({ p }) => R("\\baudit\\b|screen the", p)],
	["code-review", ({ p }) => R("whole-spec|spec review", p)],
	["triage", ({ L, p }) => R("triage", p) || L.has("takes:triage")],
	[
		"ruling-impl",
		({ p }) => R("ruled at|ruling|ruled this|founder ruled|q\\d+ \\(", p),
	],
	[
		"founder-raised",
		({ L, p }) =>
			R(
				"founder (asked|raised|reported|wants|requires|said|noticed|saw)|founder's (request|report|question)|raised by|from luc|\\bluc (asked|said|wants)",
				p,
			) || L.has("takes:human"),
	],
	[
		"to-tickets-child",
		({ b, sl }) => /^## parent/im.test(b) || sl.startsWith("Part of"),
	],
	["split", ({ p }) => R("split (out )?(of|from)", p)],
	[
		"measure-census",
		({ p }) => R("\\b(reading|readout) found|queue-wait reading", p),
	],
	["code-review", ({ p }) => R("found reviewing|reviewing", p)],
	[
		"found-in-passing",
		({ p }) =>
			R(
				"found (on|while|during|in passing|by|building|running)|met (in passing|while|carrying)|incidental|exposed|surfaced|fallout|left by|broken by|caused by|a corner|corner from|flake|seen once|a defect in|a gate gap",
				p,
			),
	],
	[
		"follow-up",
		({ p }) =>
			R(
				"follow.?up|follow-on|companion|adopter half|stopgap|residue|left after",
				p,
			),
	],
];

/** @param {Set<string>} L */
const isWayfinder = (L) =>
	L.has("takes:wayfinder") || [...L].some((x) => x.startsWith("wayfinder:"));

/**
 * The trial's own class for one issue, before mapping.
 * @param {IssueText} issue
 * @returns {string}
 */
function trialOrigin(issue) {
	const b = issue.body ?? "";
	/** @type {Read} */
	const read = {
		t: issue.title ?? "",
		L: new Set((issue.labels ?? []).map(labelName)),
		b,
		...prov(b),
	};
	return RULES.find(([, holds]) => holds(read))?.[0] ?? UNMARKED;
}

/**
 * The origin #4627's keyword rules give an issue, as one of lib/issue-origin.js's
 * ORIGINS, or `unmarked` where no rule matches.
 * @param {IssueText} issue
 * @returns {string}
 */
function classifyOrigin(issue) {
	const raw = trialOrigin(issue);
	const mapped = Object.hasOwn(OUTPUT_MAP, raw)
		? OUTPUT_MAP[/** @type {keyof typeof OUTPUT_MAP} */ (raw)]
		: raw;
	if (mapped !== UNMARKED && !isOrigin(mapped))
		throw new Error(`origin-fallback: ${mapped} is off the fixed list`);
	return mapped;
}

module.exports = { classifyOrigin, UNMARKED };
