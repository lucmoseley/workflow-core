const { isOrigin } = require("./issue-origin");

const OUTPUT_MAP = /** @type {const} */ ({
	"retro-sweep": "retro",
	"founder-raised": "founder",
	split: "follow-up",
});

const UNMARKED = "unmarked";

// guess, workflow-core#4627
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
 * @param {string} body
 * @returns {{ provLine: string, provText: string }}
 */
function provenance(body) {
	const m = /^(Standalone[:,][^\n]*|Part of [^\n]*)$/m.exec(body);
	const provLine = m?.[1] ?? "";
	const secs = body.split(/^#{1,3} /m);
	const pre = secs[0] ?? "";
	const rest = secs
		.slice(1, 1 + SECTIONS_READ)
		.map((x) => x.slice(0, SECTION_CHARS))
		.join(" ");
	return {
		provLine,
		provText:
			`${provLine} \n ${pre.slice(0, PRE_CHARS)} \n ${rest}`.toLowerCase(),
	};
}

/**
 * @param {string} pattern
 * @param {string} s
 */
const matches = (pattern, s) => new RegExp(pattern, "i").test(s);

/** @param {Label} l */
const labelName = (l) => (typeof l === "string" ? l : l.name);

/**
 * @typedef {{ title: string, labels: Set<string>, body: string, provLine: string, provText: string }} Read
 * @typedef {[string, (r: Read) => boolean]} Rule
 */

/** @type {Rule[]} */
const RULES = [
	[
		"morning-review-script",
		({ title }) => matches("^Morning review — ", title),
	],
	[
		"incident",
		({ title }) =>
			matches("^Suite queue wait is over|^Memory kill incident from", title),
	],
	[
		"code-review",
		({ title, labels }) =>
			isWayfinder(labels) &&
			matches("code-review findings|review findings", title),
	],
	["wayfinder", ({ labels }) => isWayfinder(labels)],
	[
		"to-spec",
		({ title, labels }) => labels.has("kind:spec") || title.startsWith("Spec:"),
	],
	["orphaned-edit-script", ({ title }) => title.startsWith("Orphaned edit")],
	[
		"lander-script",
		({ title }) =>
			matches("reverted by the lander|dropped by the (queue )?lander", title),
	],
	[
		"lander-script",
		({ title, provText }) =>
			title.startsWith("Landing queue held") ||
			title.startsWith("Landing queue stalled") ||
			provText.includes("held-queue issue") ||
			provText.includes("stall ticket tracks"),
	],
	[
		"ci-red",
		({ title, labels, provText }) =>
			labels.has("ci-red") ||
			matches("red (test on )?main|red ci|ci red|landing break", provText) ||
			title.startsWith("CI red"),
	],
	["release-bump", ({ title }) => title.startsWith("Bump workflow-core")],
	[
		"repo-checks-script",
		({ title, labels }) =>
			title.startsWith("Repo checks: standing findings") ||
			labels.has("manual-finding") ||
			matches("is stale against", title),
	],
	[
		"morning-review-script",
		({ body, provText }) =>
			matches("morning review", provText) &&
			matches(
				"^(## )?(closed tickets|clear delegated)",
				body.slice(0, MORNING_HEAD),
			),
	],
	[
		"found-in-passing",
		({ provText }) =>
			matches(
				"^found by #\\d+ \\(",
				(provText.split("\n").at(-1) ?? "").trim().slice(0, FOUND_BY_CHARS),
			) &&
			!matches(
				"review|concision|census|scan|audit",
				provText.slice(0, FOUND_BY_HEAD),
			),
	],
	[
		"concision-pass",
		({ title, provText }) =>
			matches(
				"concision pass|concision-pass|concision finding|concision follow|\\bpass\\b.{0,40}tenure|tenure|pre-existing (comment|text|prose)",
				provText,
			) || matches("concision|clear tenure|^cut or refuse|pre-existing", title),
	],
	[
		"architecture-scan",
		({ provText }) => matches("architecture.scan", provText),
	],
	["heresy-sweep", ({ provText }) => matches("heresy", provText)],
	[
		"retro-sweep",
		({ provText }) =>
			matches("retro.sweep|retro finding|\\bretro\\b", provText),
	],
	[
		"code-review",
		({ title, provText }) =>
			matches("code-review finding", provText) ||
			matches(
				"(whole-spec|spec-axis|spec|standards|code|security|test|axis|concurrency|fresh) review|review (of|found|follow)|review's|reviewer found|from (its|the) .{0,30}review",
				provText,
			) ||
			matches("review findings|review found", title),
	],
	[
		"ruling-impl",
		({ provText }) =>
			matches("\\bruled\\b|ruling", provText.slice(0, RULED_CHARS)) &&
			!matches("census row", provText),
	],
	[
		"measure-census",
		({ title, provText }) =>
			matches(
				"census row|census found|census re|re-measure (the|of)|re-anchor|found by .{0,20}(census|measurement)|measured by",
				provText,
			) || matches("^(re-measure|census|measure)", title),
	],
	[
		"incident",
		({ provText }) =>
			matches(
				"memory kill|incident|rcu stall|\\bstall\\b|freeze|oom",
				provText,
			),
	],
	["audit", ({ provText }) => matches("\\baudit\\b|screen the", provText)],
	[
		"code-review",
		({ provText }) => matches("whole-spec|spec review", provText),
	],
	[
		"triage",
		({ labels, provText }) =>
			matches("triage", provText) || labels.has("takes:triage"),
	],
	[
		"ruling-impl",
		({ provText }) =>
			matches("ruled at|ruling|ruled this|founder ruled|q\\d+ \\(", provText),
	],
	[
		"founder-raised",
		({ labels, provText }) =>
			matches(
				"founder (asked|raised|reported|wants|requires|said|noticed|saw)|founder's (request|report|question)|raised by|from luc|\\bluc (asked|said|wants)",
				provText,
			) || labels.has("takes:human"),
	],
	[
		"to-tickets-child",
		({ body, provLine }) =>
			/^## parent/im.test(body) || provLine.startsWith("Part of"),
	],
	["split", ({ provText }) => matches("split (out )?(of|from)", provText)],
	[
		"measure-census",
		({ provText }) =>
			matches("\\b(reading|readout) found|queue-wait reading", provText),
	],
	[
		"code-review",
		({ provText }) => matches("found reviewing|reviewing", provText),
	],
	[
		"found-in-passing",
		({ provText }) =>
			matches(
				"found (on|while|during|in passing|by|building|running)|met (in passing|while|carrying)|incidental|exposed|surfaced|fallout|left by|broken by|caused by|a corner|corner from|flake|seen once|a defect in|a gate gap",
				provText,
			),
	],
	[
		"follow-up",
		({ provText }) =>
			matches(
				"follow.?up|follow-on|companion|adopter half|stopgap|residue|left after",
				provText,
			),
	],
];

/** @param {Set<string>} labels */
const isWayfinder = (labels) =>
	labels.has("takes:wayfinder") ||
	[...labels].some((x) => x.startsWith("wayfinder:"));

/**
 * @param {IssueText} issue
 * @returns {string}
 */
function trialOrigin(issue) {
	const body = issue.body ?? "";
	/** @type {Read} */
	const read = {
		title: issue.title ?? "",
		labels: new Set((issue.labels ?? []).map(labelName)),
		body,
		...provenance(body),
	};
	return RULES.find(([, holds]) => holds(read))?.[0] ?? UNMARKED;
}

/**
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
