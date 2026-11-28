#!/usr/bin/env node

const fs = require("node:fs");
const { scriptPath } = require("./lib/script-path.js");
const path = require("node:path");
const { writeFd } = require("./lib/write-fd.js");
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
const LABEL = takesLabel("wayfinder");
const AREA = "Strategy & Brand";

/** @typedef {{ n: number, start: string, end: string, status: string, heading: string }} Cycle */

const HEADING =
	/^## Cycle (\d+) — (\d{4}-\d{2}-\d{2}) (?:→|->) (\d{4}-\d{2}-\d{2})\s*$/;
const STATUS = /^\*\*Status:\*\*\s*(open|closed)\b/m;

/**
 * @param {string} text
 * @param {string} logPath
 * @returns {Cycle[]}
 */
function parseCycles(text, logPath) {
	const lines = text.split("\n");
	/** @type {Cycle[]} */
	const cycles = [];
	let fenced = false;
	for (const [i, line] of lines.entries()) {
		if (line.startsWith("```")) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;
		const m = HEADING.exec(line);
		if (!m) {
			if (/^## Cycle\b/.test(line))
				throw new Error(
					`${logPath}: "${line.trim()}" is not a readable cycle heading. Spell it "## Cycle <n> — YYYY-MM-DD → YYYY-MM-DD".`,
				);
			continue;
		}
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

/** @param {ReturnType<typeof verdict>["kind"]} kind */
const filesNothing = (kind) => kind === "current" || kind === "empty";

/** @type {Record<string, string>} */
const HEADLINE = {
	due: "Cycle review due",
	ambiguous: "Cycle log is ambiguous",
	undeclared: "No cycle declared",
};

function main() {
	parseOrExit(process.argv.slice(2), {
		usage: `usage: node ${scriptPath("report-cycle-review-due.js")}`,
	});
	exitUnlessModule("governance");
	const logPath = cycleLogPath();
	const file = path.join(hostRoot(), logPath);
	if (!fs.existsSync(file)) {
		writeFd(2, `SKIP: no cycle log at ${logPath} yet — nothing to be due.\n`);
		return;
	}

	const today = (process.env.CYCLE_TODAY || new Date().toISOString()).slice(
		0,
		10,
	);
	const v = verdict(parseCycles(fs.readFileSync(file, "utf8"), logPath), today);

	if (v.kind === "empty") {
		writeFd(2, `SKIP: ${logPath} declares no cycle yet — nothing to be due.\n`);
		return;
	}

	if (v.kind === "current") {
		const c = soleOpen(v);
		writeFd(
			1,
			`Cycle ${c.n} runs to ${c.end} — nothing to file (today ${today}).\n`,
		);
		return;
	}

	writeFd(
		1,
		`${HEADLINE[v.kind]}. ${
			fileOrRefresh({
				title: TITLE,
				label: LABEL,
				labels: [LABEL, AREA],
				body: body(v, today, logPath),
			}).text
		}\n`,
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
