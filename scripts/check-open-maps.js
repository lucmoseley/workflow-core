#!/usr/bin/env node

const { runCheck } = require("./lib/check");
const { scriptPath } = require("./lib/script-path.js");
const {
	ghApiSlurp,
	ghOpenIssuesWithLabel,
	parseErrLine,
	parseGhFailureReason,
	raiseGhFailure,
} = require("./lib/gh");
const { takesLabel } = require("./lib/takes-label");

// GitHub refuses a 101st sub-issue: https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/adding-sub-issues
const GITHUB_SUB_ISSUE_CAP = 100;
// guess, #76
const NEAR_CAP = GITHUB_SUB_ISSUE_CAP - 10;

const ROUTED_LABELS = ["to-spec", "wayfinder", "triage"].map(takesLabel);

const LINE_BREAK = /[\n\r\u2028\u2029]/;

/**
 * @param {string} line
 */
function sectionHeadName(line) {
	if (!/^##\s/.test(line)) return null;
	const rest = line.slice("## ".length);
	const name = rest.trim();
	if (LINE_BREAK.test(name)) return null;
	if (name === "" && !/[^\n\r\u2028\u2029]/.test(rest)) return null;
	return name.toLowerCase();
}

/** @typedef {Partial<import("./lib/gh.js").IssueRow> & {number: number}} GhIssue */

/**
 * @param {string} body
 * @returns {Map<string, string>}
 */
function sections(body) {
	/** @type {Map<string, string>} */
	const out = new Map();
	const lines = (body || "").split("\n");
	let name = null;
	/** @type {string[]} */
	let buf = [];
	for (const line of lines) {
		const head = sectionHeadName(line);
		if (head !== null) {
			if (name !== null) out.set(name, buf.join("\n"));
			name = head;
			buf = [];
		} else if (name !== null) {
			buf.push(line);
		}
	}
	if (name !== null) out.set(name, buf.join("\n"));
	return out;
}

/**
 * @param {string} body
 * @param {number} number
 */
function hasPointer(body, number) {
	const secs = sections(body);
	const text = `${secs.get("decisions so far") || ""}\n${secs.get("out of scope") || ""}`;
	return new RegExp(`#${number}(?!\\d)`).test(text);
}

/**
 * @typedef {{ number: number, title?: string, url?: string, reason: string }} UnreadableMap
 * @typedef {{ map: number, mapTitle?: string, mapUrl?: string, child: number }} MissingPointer
 * @typedef {{
 *   undischarged: { number: number, title?: string, url?: string }[],
 *   routed: { number: number, title?: string, url?: string }[],
 *   unreadable: UnreadableMap[],
 *   missingPointers: MissingPointer[],
 *   nearCap: { number: number, title?: string, url?: string, count: number }[],
 * }} Findings
 */

/**
 * @returns {GhIssue[]}
 */
function openMaps() {
	/** @type {GhIssue[]} */
	let maps = [];
	try {
		maps = ghOpenIssuesWithLabel("wayfinder:map").filter(
			(/** @type {GhIssue} */ i) => !i.pull_request,
		);
	} catch (e) {
		raiseGhFailure(e, "No open-map conclusion drawn.");
	}
	return maps;
}

/**
 * @param {GhIssue} m
 * @returns {{kids: GhIssue[], unreadable?: undefined} | {unreadable: UnreadableMap, kids?: undefined}}
 */
function readMapChildren(m) {
	try {
		return {
			kids: ghApiSlurp([`repos/{owner}/{repo}/issues/${m.number}/sub_issues`]),
		};
	} catch (e) {
		if (parseGhFailureReason(e) === "unreachable")
			raiseGhFailure(e, "No open-map conclusion drawn.");
		return {
			unreadable: {
				number: m.number,
				title: m.title,
				url: m.html_url,
				reason: parseErrLine(e),
			},
		};
	}
}

/**
 * @param {GhIssue} m
 */
function isRouted(m) {
	return (m.labels || []).some((l) => ROUTED_LABELS.includes(l.name || ""));
}

/**
 * @param {GhIssue} m
 * @param {GhIssue[]} kids
 * @param {Findings} findings
 */
function recordMapFindings(m, kids, findings) {
	const open = kids.filter(
		(/** @type {GhIssue} */ k) => k.state === "open" && !k.pull_request,
	);
	if (kids.length === 0) {
		findings.unreadable.push({
			number: m.number,
			title: m.title,
			url: m.html_url,
			reason: "no sub-issues at all — likely never linked",
		});
		return;
	}
	if (open.length === 0)
		(isRouted(m) ? findings.routed : findings.undischarged).push({
			number: m.number,
			title: m.title,
			url: m.html_url,
		});

	const closed = kids.filter(
		(/** @type {GhIssue} */ k) => k.state === "closed" && !k.pull_request,
	);
	for (const child of closed) {
		if (!hasPointer(m.body || "", child.number))
			findings.missingPointers.push({
				map: m.number,
				mapTitle: m.title,
				mapUrl: m.html_url,
				child: child.number,
			});
	}

	if (kids.length >= NEAR_CAP)
		findings.nearCap.push({
			number: m.number,
			title: m.title,
			url: m.html_url,
			count: kids.length,
		});
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {Findings} findings
 */
function reportChildlessMaps(ctx, { undischarged, unreadable }) {
	for (const m of undischarged)
		ctx.warn(
			"UNDISCHARGED-MAP",
			`#${m.number} ${m.title} — no open children left, but the map is still open`,
			m,
			`UNDISCHARGED-MAP\t#${m.number}`,
		);
	for (const m of unreadable)
		ctx.warn(
			"UNREADABLE-MAP",
			`#${m.number} ${m.title} — children unreadable (${m.reason})`,
			m,
			`UNREADABLE-MAP\t#${m.number}`,
		);

	if (undischarged.length > 0) {
		ctx.say(
			`UNDISCHARGED-MAP (${undischarged.length}) — no ticket stands open toward the map's destination:`,
		);
		for (const m of undischarged)
			ctx.say(`  #${m.number} ${m.title}\n    ${m.url}`);
		ctx.say(
			"\n  Not in-flight work: a scoping decision. Route with takes:triage\n" +
				"  (docs/agents/triage-labels.md) — never close by hand (docs/agents/issue-tracker.md §Closing an issue).",
		);
	}
	if (unreadable.length > 0) {
		ctx.say(`\nUNREADABLE-MAP (${unreadable.length}):`);
		for (const m of unreadable)
			ctx.say(`  #${m.number} ${m.title}\n    ${m.reason}`);
	}
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {MissingPointer[]} missingPointers
 */
function reportMissingPointers(ctx, missingPointers) {
	for (const p of missingPointers)
		ctx.warn(
			"MISSING-DECISION",
			`#${p.child} closed with no Decisions-so-far/Out-of-scope pointer on map #${p.map} ${p.mapTitle}`,
			p,
			`MISSING-DECISION\t#${p.child}\t#${p.map}`,
		);
	if (missingPointers.length > 0) {
		ctx.say(`\nMISSING-DECISION (${missingPointers.length}):`);
		for (const p of missingPointers)
			ctx.say(
				`  #${p.child} — closed, no pointer on map #${p.map} ${p.mapTitle}\n    ${p.mapUrl}`,
			);
		ctx.say(
			`\n  Add the pointer: node ${scriptPath("issue-body.js")} append-section <map> --heading "Decisions so far" --text "- #<child> — …"\n` +
				"  (docs/agents/issue-tracker.md — only appends into a heading that already exists).",
		);
	}
}

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {Findings["nearCap"]} nearCap
 */
function reportNearCap(ctx, nearCap) {
	for (const m of nearCap)
		ctx.warn(
			"MAP-NEAR-CAP",
			`#${m.number} ${m.title} — ${m.count} sub-issue(s), approaching GitHub's 100-child cap`,
			m,
			`MAP-NEAR-CAP\t#${m.number}`,
		);
	if (nearCap.length > 0) {
		ctx.say(`\nMAP-NEAR-CAP (${nearCap.length}):`);
		for (const m of nearCap)
			ctx.say(
				`  #${m.number} ${m.title} — ${m.count} sub-issue(s)\n    ${m.url}`,
			);
		ctx.say(
			`\n  Run: node ${scriptPath("archive-closed-children.js")} <map>\n` +
				"  (docs/agents/issue-tracker.md §Placing a new issue).",
		);
	}
}

runCheck({
	name: "open-maps",
	usage: "node check-open-maps.js [--json]",
	run(/** @type {import("./lib/check").Ctx} */ ctx) {
		const maps = openMaps();

		/** @type {Findings} */
		const findings = {
			undischarged: [],
			routed: [],
			unreadable: [],
			missingPointers: [],
			nearCap: [],
		};
		const { undischarged, routed, unreadable, missingPointers, nearCap } =
			findings;

		for (const m of maps) {
			const read = readMapChildren(m);
			if (read.unreadable) {
				unreadable.push(read.unreadable);
				continue;
			}
			recordMapFindings(m, read.kids, findings);
		}

		ctx.say(`Checked ${maps.length} open wayfinder:map issue(s).\n`);

		reportChildlessMaps(ctx, findings);
		reportMissingPointers(ctx, missingPointers);
		reportNearCap(ctx, nearCap);

		return {
			okLine: `every one of ${maps.length} open map(s) has an open child or a takes: label that moves it, every closed child has a Decisions-so-far or Out-of-scope pointer, and none has reached ${NEAR_CAP} sub-issues.`,
			noun: "finding(s) across open maps",
			data: {
				maps: maps.length,
				undischarged,
				undischargedCount: undischarged.length,
				routed,
				routedCount: routed.length,
				nearCap,
				nearCapCount: nearCap.length,
				unreadable,
				missingPointers,
				missingPointersCount: missingPointers.length,
			},
		};
	},
});
