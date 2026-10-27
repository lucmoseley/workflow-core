#!/usr/bin/env node
/*
 * report-cycle-review-due.js — the trigger half of mantahostels#942 (the ticket that
 * adopted the 90-day operating rhythm as a document plus a scheduled job),
 * built at mantahostels#1034, and run by the daily repo-checks run (workflow-core#1557).
 *
 * mantahostels#942 chose a scheduled job over a roadmap card on evidence: a card records
 * that something ought to happen, and the `simplify-review` card proves one can
 * sit unfired indefinitely. A workflow that files an issue is the only trigger
 * in this repo with a track record of reaching the founder unprompted.
 *
 * Same shape as scripts/report-manual-staleness.js, deliberately: ONE tracked
 * issue per standing condition, its body rewritten while the condition stands,
 * so a debt taking days to clear never mails twice.
 *
 * Two conditions file, not one. An overdue cycle is the obvious trigger; an
 * UNDECLARED cycle is the failure mode the ritual exists to catch, so silence
 * there would hide exactly the thing worth catching (mantahostels#1034).
 *
 * A log with no cycle in it yet, or no log at all, files nothing: an adopter
 * that has never declared one has nothing overdue, so it is a named SKIP
 * (workflow-core#395 Q1). "Undeclared" means a log whose every cycle is closed.
 *
 * Exit code is 0 whether or not a review is due — the issue is the signal. It
 * exits non-zero only when it cannot do its job: an unparseable heading, gh
 * refusing, a command line lib/cli-args.js refuses.
 */

const fs = require("node:fs");
const path = require("node:path");
const { parseOrExit } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root");
const { requiredGroup } = require("./lib/regex-group");
const { fileOrRefresh } = require("./lib/tracking-issue");
const {
	cycleLogPath,
	exitUnlessModule,
} = require("./lib/workflow-core-config");
const { takesLabel } = require("./lib/takes-label");

const TITLE = "90-day cycle review due";
/* Matched on label AND exact title, so the label only has to be one this issue
 * genuinely carries. `takes:wayfinder` is that label and the routing both,
 * reversing mantahostels#942 §3's `takes:human` on mantahostels#3439: a founder
 * conversation happens INSIDE Claude Code, in a /wayfinder session. An automatic
 * filer can name no outside act, so the old value made every issue it files a
 * NO-OUTSIDE-ACT by construction (workflow-core#140). */
const LABEL = takesLabel("wayfinder");
const AREA = "Strategy & Brand";

/** @typedef {{ n: number, start: string, end: string, status: string, heading: string }} Cycle */

/** `## Cycle 3 — 2026-08-24 → 2026-11-22`, with `->` accepted for the arrow. */
const HEADING =
	/^## Cycle (\d+) — (\d{4}-\d{2}-\d{2}) (?:→|->) (\d{4}-\d{2}-\d{2})\s*$/;
const STATUS = /^\*\*Status:\*\*\s*(open|closed)\b/m;

/**
 * Every cycle section in the log, in file order (newest first by convention).
 *
 * @param {string} text
 * @param {string} logPath repo-relative, for the error messages
 * @returns {Cycle[]}
 */
function parseCycles(text, logPath) {
	const lines = text.split("\n");
	/** @type {Cycle[]} */
	const cycles = [];
	let fenced = false;
	for (const [i, line] of lines.entries()) {
		// The log carries a fenced declaration TEMPLATE whose heading is
		// deliberately unreadable (`## Cycle N — YYYY-MM-DD → ...`). Skipping
		// fences keeps it from reading as either a cycle or a malformed one.
		if (line.startsWith("```")) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
		const m = HEADING.exec(line);
		if (!m) {
			/* A near-miss heading would otherwise vanish into the "no cycle
			 * declared" branch — a real declaration reported as an absent one. */
			if (/^## Cycle\b/.test(line))
				throw new Error(
					`${logPath}: "${line.trim()}" is not a readable cycle heading. Spell it "## Cycle <n> — YYYY-MM-DD → YYYY-MM-DD".`,
				);
			continue;
		}
		// The section runs to the next `## ` heading of any kind.
		const next = lines.findIndex((l, j) => j > i && l.startsWith("## "));
		const section = lines
			.slice(i + 1, next === -1 ? lines.length : next)
			.join("\n");
		const status = STATUS.exec(section);
		if (!status)
			throw new Error(
				`${logPath}: "${line.trim()}" carries no "**Status:** open" or "**Status:** closed" line.`,
			);
		cycles.push({
			n: Number(requiredGroup(m, 1, HEADING)),
			start: requiredGroup(m, 2, HEADING),
			end: requiredGroup(m, 3, HEADING),
			status: requiredGroup(status, 1, STATUS),
			heading: line.trim(),
		});
	}
	return cycles;
}

/**
 * What the log says today. `today` is an ISO date string, so the comparison is
 * a string compare and carries no timezone of its own.
 *
 * @param {Cycle[]} cycles
 * @param {string} today
 * @returns {{ kind: "empty" | "undeclared" | "ambiguous" | "due" | "current", open: Cycle[] }}
 */
function verdict(cycles, today) {
	if (cycles.length === 0) return { kind: "empty", open: [] };
	const open = cycles.filter((c) => c.status === "open");
	const [only, ...more] = open;
	if (only === undefined) return { kind: "undeclared", open };
	if (more.length > 0) return { kind: "ambiguous", open };
	return { kind: only.end < today ? "due" : "current", open };
}

/**
 * The one open cycle a `due` or `current` verdict was reached on.
 * @param {ReturnType<typeof verdict>} v
 * @returns {Cycle}
 */
function soleOpen(v) {
	const [c] = v.open;
	if (c === undefined)
		throw new Error(`a ${v.kind} verdict carries no open cycle`);
	return c;
}

/**
 * @param {ReturnType<typeof verdict>} v
 * @param {string} today
 * @param {string} logPath
 */
function body(v, today, logPath) {
	const head = [
		"Filed automatically by `scripts/report-cycle-review-due.js`, from the",
		"daily repo-checks run at session start, which rewrites this body each day the condition still stands.",
		"**Edit it by hand and the next run silently overwrites it** —",
		"`issue-body.js replace` only refuses a write landing during the call itself,",
		"not a hand edit sitting between runs — so put anything you want kept in a",
		"comment.",
		"",
	];

	/** @type {string[]} */
	let what;
	if (v.kind === "undeclared") {
		what = [
			"## No 90-day cycle is declared",
			"",
			`As of ${today}, \`${logPath}\` carries no section marked \`**Status:** open\`.`,
			"",
			"An undeclared cycle is the failure mode the ritual exists to catch, so this",
			"files rather than staying silent. Declare one: copy the template in",
			`\`${logPath}\` §Declaring a cycle, fill in the single traction goal and the`,
			"predictions with their confidence bands, and commit it **before** the start date.",
			"The commit is the pre-registration; that is the whole mechanism.",
		];
	} else if (v.kind === "ambiguous") {
		what = [
			"## More than one cycle is marked open",
			"",
			`\`${logPath}\` has ${v.open.length} sections marked \`**Status:** open\`:`,
			"",
			...v.open.map((c) => `- ${c.heading}`),
			"",
			"Exactly one cycle runs at a time. Close the finished one — set its",
			"`**Status:** closed` and fill its review — so the trigger can read an end date.",
		];
	} else {
		const c = soleOpen(v);
		what = [
			`## Cycle ${c.n} ended ${c.end}`,
			"",
			`Declared ${c.start} → ${c.end}; today is ${today}.`,
			"",
			"## What to do",
			"",
			"Hold the review against the **committed** declaration, at the 20/80 split mantahostels#942",
			"(the ticket that adopted the rhythm) set: 20% reporting progress, 80%",
			"interrogating the persevere / pivot / repeat call.",
			"",
			"1. Print predicted against actual, per outcome. The gap is the learning.",
			"2. State the persevere / pivot / repeat call and why.",
			"3. Check mantahostels#939's trigger (the ticket that settled the traction ramp): two",
			"   consecutive missed rungs oblige a recorded persevere / pivot / revise-MSC",
			"   decision. This ritual adds no second trigger.",
			`4. Write the review into cycle ${c.n}'s section, set \`**Status:** closed\`, and`,
			"   declare the next cycle before it starts.",
			"",
			"Do not retro-edit the declaration. It is worth reading only because it was fixed",
			"before the data arrived.",
		];
	}

	return [
		...head,
		...what,
		"",
		"This issue stays open until the condition clears. While it is open the daily",
		"repo-checks run at session start refreshes this body and files nothing new, so",
		"there is one issue however long the debt runs.",
	].join("\n");
}

/** The verdicts that file nothing; check-cleared-trackers.js reads them as
 * cleared. @param {ReturnType<typeof verdict>["kind"]} kind */
const filesNothing = (kind) => kind === "current" || kind === "empty";

/**
 * What the run prints before the filing outcome, one per FILING verdict —
 * `current` and `empty` file nothing and return earlier.
 *
 * @type {Record<string, string>}
 */
const HEADLINE = {
	due: "Cycle review due",
	ambiguous: "Cycle log is ambiguous",
	undeclared: "No cycle declared",
};

function main() {
	parseOrExit(process.argv.slice(2), {
		usage: "usage: node scripts/report-cycle-review-due.js",
	});
	exitUnlessModule("governance");
	const logPath = cycleLogPath();
	const file = path.join(hostRoot(), logPath);
	if (!fs.existsSync(file)) {
		process.stderr.write(
			`SKIP: no cycle log at ${logPath} yet — nothing to be due.\n`,
		);
		return;
	}

	const today = (process.env.CYCLE_TODAY || new Date().toISOString()).slice(
		0,
		10,
	);
	const v = verdict(parseCycles(fs.readFileSync(file, "utf8"), logPath), today);

	if (v.kind === "empty") {
		process.stderr.write(
			`SKIP: ${logPath} declares no cycle yet — nothing to be due.\n`,
		);
		return;
	}

	if (v.kind === "current") {
		const c = soleOpen(v);
		console.log(
			`Cycle ${c.n} runs to ${c.end} — nothing to file (today ${today}).`,
		);
		return;
	}

	console.log(
		`${HEADLINE[v.kind]}. ${fileOrRefresh({
			title: TITLE,
			label: LABEL,
			labels: [LABEL, AREA],
			body: body(v, today, logPath),
		})}`,
	);
}

if (require.main === module) main();

module.exports = {
	TITLE,
	LABEL,
	parseCycles,
	verdict,
	filesNothing,
};
