#!/usr/bin/env node
/*
 * check-open-maps.js — reports an open `wayfinder:map` issue with zero open
 * children (mantahostels#1206), a closed child of an open map whose number is missing
 * from the map's Decisions-so-far / Out-of-scope record (mantahostels#1862), and a map
 * whose sub-issue total (closed ones counted, since that is what GitHub's
 * 100-child cap counts) has reached 90 (#92).
 *
 * An undischarged map's destination is not reached, but no ticket is open
 * toward it — a scoping decision, not in-flight work. Route with
 * `takes:triage` (docs/agents/triage-labels.md). A map whose `takes:` already
 * routes it to a command that moves it is not reported (#2267): it waits on
 * that command, not on a routing decision, and `--json` lists it as `routed`.
 *
 * A missing pointer is a decision that has left the map (mantahostels#1819's instance on
 * mantahostels#1763). Presence of `#<number>` in either section is the whole test —
 * grading the pointer's content is out of scope.
 *
 * WHY THE WEEKLY SWEEP, NOT pick-next.js. Reading a map's children costs one
 * `/sub_issues` call per open map, and selection runs on every invocation, so
 * paying that cost there would tax a command run many times a day. The
 * pointer check adds no further API cost: the maps list call already returns
 * each map's `body`.
 *
 * Deliberately sequential, not fanned out with mapLimit: a weekly,
 * report-only job over a handful of open maps need not rush.
 *
 * WARN, never FAIL: world state, not a commit property (same reasoning as
 * check-stale-claims.js).
 *
 * Usage: node check-open-maps.js [--json]
 */

const { runCheck } = require("./lib/check");
const {
	ghApiSlurp,
	ghOpenIssuesWithLabel,
	parseErrLine,
	parseGhFailureReason,
	raiseGhFailure,
} = require("./lib/gh");
const { takesLabel } = require("./lib/takes-label");

// GitHub refuses a 101st sub-issue (docs/agents/issue-tracker.md, "Placing a
// new issue"); 90 leaves room to archive before the map is ever blocked.
const NEAR_CAP = 90;

// `/to-spec` files the map's spec, `/wayfinder` works the map itself, and
// `/triage` is the routing this finding asks for (#2267). Residual: a map
// under one of these that its command never picks up is never reported.
const ROUTED_LABELS = ["to-spec", "wayfinder", "triage"].map(takesLabel);

/* A line break, which no section name holds. */
const LINE_BREAK = /[\n\r\u2028\u2029]/;

/**
 * The lowercased name a `## ` heading gives its section, or null where `line`
 * is no such heading: the text after `##` and a blank, less its outer blanks.
 * A name holding a line break is none, and a heading of blanks alone names ""
 * only where a blank other than a line break follows its first.
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

/** @typedef {{ number: number, title?: string, html_url?: string, body?: string, pull_request?: object, state?: string, labels?: { name?: string }[] }} GhIssue */

/**
 * Text of a level-2 (`## `) markdown section by lowercased, trimmed header.
 *
 * Residual: an exact, lowercased `## ` header only — a map that spells its
 * record `### Decisions so far`, or whose `body` is empty, yields no section
 * text, so every closed child reports missing. Accepted per mantahostels#1862: every
 * live map today uses the exact `## ` heading.
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
 * Whether `#<number>` appears in the map body's Decisions-so-far or
 * Out-of-scope section, as a whole reference (not a prefix of a longer one).
 *
 * Residual: any `#<n>` in-section counts, so an incidental mention
 * ("supersedes mantahostels#9") reads as a pointer. Accepted per mantahostels#1862: presence is the
 * whole test — grading the pointer's content is out of scope.
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
 * Every open `wayfinder:map` issue, pull requests filtered out.
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
 * The map's sub-issues, or the unreadable row saying why they cannot be read.
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
 * Whether the map's `takes:` already names a command that moves it.
 * @param {GhIssue} m
 */
function isRouted(m) {
	return (m.labels || []).some((l) => ROUTED_LABELS.includes(l.name || ""));
}

/**
 * Records what one map's children say about it.
 * @param {GhIssue} m
 * @param {GhIssue[]} kids
 * @param {Findings} findings accumulator: each fault the children show is
 *   pushed onto its list
 */
function recordMapFindings(m, kids, findings) {
	// Same filter as wayfinder-frontier.js's openChildren: open, non-PR.
	const open = kids.filter(
		(/** @type {GhIssue} */ k) => k.state === "open" && !k.pull_request,
	);
	// No sub-issues at all is a different fault — unlinked children, not a
	// worked-through map — so it goes to `unreadable`, never `undischarged`.
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

	// The cap counts every sub-issue, closed ones included — kids.length,
	// not open.length.
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
			// Titles move; the map does not (mantahostels#2490).
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
			'\n  Add the pointer: node scripts/issue-body.js append-section <map> --heading "Decisions so far" --text "- #<child> — …"\n' +
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
			"\n  Run: node scripts/archive-closed-children.js <map>\n" +
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
