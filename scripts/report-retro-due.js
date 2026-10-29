#!/usr/bin/env node
/*
 * report-retro-due.js — the weekly trigger for the retro-sweep skill (#969,
 * from #948 §Trigger: a due issue dispatched through /pick-next,
 * never a session-start launch).
 *
 * Same shape as scripts/report-cycle-review-due.js: ONE tracked issue,
 * "Weekly retro due", filed or refreshed through lib/tracking-issue.js, never
 * duplicated across daily runs. The run it asks for closes it
 * (retro-sweep step 8), and the next due week files a fresh one.
 *
 * Due where `retro.weeklyCount` is set and the newest `weekly` line in
 * docs/data/retro-runs.jsonl is 7 or more days old, or there is none. A
 * `calibrate` line never counts. Unset — and an adopter has no `retro` key —
 * is a named SKIP.
 *
 * Exit 0 whether or not a run is due. Exit 2 only where it cannot do its job:
 * the record unreadable, the config unreadable or its `retro` key malformed
 * (BROKEN, so a typo never reads as "not yet calibrated"), its own `takes:`
 * value refused, the file or refresh failing, or a command line
 * lib/cli-args.js refuses.
 */

const fs = require("node:fs");
const { writeFd } = require("./lib/write-fd.js");
const path = require("node:path");
const { parseOrExit } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root");
const { takesLabel, takesRefusal } = require("./lib/takes-label");
const { fileOrRefresh } = require("./lib/tracking-issue");
const {
	parseErrLine,
	parseGhFailureReason,
	unreachableRemedy,
} = require("./lib/gh");
const { readConfig, retroFault } = require("./lib/workflow-core-config");

const TITLE = "Weekly retro due";
const LABEL = takesLabel("implement");
const RECORD = "docs/data/retro-runs.jsonl";
const DUE_DAYS = 7;

/**
 * The date of the newest `weekly` run in the record, or null where it holds
 * none. Throws on a line it cannot read: a corrupt record must not read as
 * "never run", which would file on every run.
 *
 * @param {string} text
 * @returns {string | null} YYYY-MM-DD
 */
function newestWeekly(text) {
	/** @type {string | null} */
	let newest = null;
	const lines = text.split("\n");
	for (const [i, line] of lines.entries()) {
		const date = weeklyDate(line, i);
		if (date === null) continue;
		if (!newest || date > newest) newest = date;
	}
	return newest;
}

/**
 * The date of one record line's `weekly` run, or null for a blank line or a
 * run of another mode. Throws as newestWeekly documents.
 *
 * @param {string} line
 * @param {number} i zero-based line index
 * @returns {string | null} YYYY-MM-DD
 */
function weeklyDate(line, i) {
	if (!line.trim()) return null;
	let row;
	try {
		row = JSON.parse(line);
	} catch (e) {
		throw new Error(
			`${RECORD}:${i + 1} is not JSON — ${e instanceof Error ? e.message : String(e)}`,
			{ cause: e },
		);
	}
	if (row?.mode !== "weekly") return null;
	const date = typeof row.date === "string" ? row.date.slice(0, 10) : "";
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))
		throw new Error(
			`${RECORD}:${i + 1} is a weekly run with no readable "date" (YYYY-MM-DD)`,
		);
	return date;
}

/**
 * @param {string | null} newest
 * @param {string} todayIso YYYY-MM-DD
 * @returns {{ due: boolean, age: number | null }} age in whole days
 */
function verdict(newest, todayIso) {
	if (!newest) return { due: true, age: null };
	const age = Math.floor((Date.parse(todayIso) - Date.parse(newest)) / 864e5);
	return { due: age >= DUE_DAYS, age };
}

/**
 * Carries no date of today's, so an unchanged condition leaves the body
 * current and a run refreshes nothing.
 *
 * @param {string | null} newest
 * @param {number} weeklyCount
 */
function body(newest, weeklyCount) {
	return [
		"Filed automatically by `scripts/report-retro-due.js`, from the",
		"daily repo-checks run at session start, which rewrites this body each day the condition still stands.",
		"**Edit it by hand and the next run silently overwrites it** — put anything",
		"you want kept in a comment.",
		"",
		"## A weekly retro is due",
		"",
		newest
			? `The newest \`weekly\` run in \`${RECORD}\` is dated ${newest}, ${DUE_DAYS} or more days ago.`
			: `\`${RECORD}\` holds no \`weekly\` run yet; a \`calibrate\` line does not count.`,
		"",
		"## What to do",
		"",
		"Run the `retro-sweep` skill in `weekly` mode with this issue's number:",
		"`weekly <this issue>`. It reviews the week's top",
		`${weeklyCount} sessions (\`retro.weeklyCount\` in \`.claude/workflow-core.json\`)`,
		"and closes this issue.",
		"",
		"Launch the session on plain Opus (`docs/effort-guide.md` §Which model to launch",
		"each session on, `/implement`).",
		"",
		"Standalone: a daily-run reporter's standing condition, under no spec (#948 §Trigger).",
	].join("\n");
}

/**
 * The verdict this reporter files on, for scripts/check-cleared-trackers.js
 * too.
 *
 * @param {string} todayIso YYYY-MM-DD
 * @returns {{ skip: string } | { skip: null, weeklyCount: number, newest: string | null, due: boolean, age: number | null }}
 */
function condition(todayIso) {
	const c = readConfig({ quiet: true });
	const fault = retroFault(c);
	if (fault) throw new Error(`${c.file}: ${fault}`);
	if (!c.retro)
		return {
			skip: `SKIP: no "retro" key in ${c.file}; calibration sets retro.weeklyCount where the practice runs.`,
		};
	if (!c.retro.weeklyCount)
		return {
			skip: `SKIP: retro.weeklyCount is unset in ${c.file}; the calibration batch sets it.`,
		};
	const file = path.join(hostRoot(), RECORD);
	if (!fs.existsSync(file))
		throw new Error(
			`${RECORD} is missing. It is committed empty; restore it with \`git checkout -- ${RECORD}\`.`,
		);
	const newest = newestWeekly(fs.readFileSync(file, "utf8"));
	return {
		skip: null,
		weeklyCount: c.retro.weeklyCount,
		newest,
		...verdict(newest, todayIso),
	};
}

/** RETRO_TODAY pins the date for tests. */
const today = () =>
	(process.env.RETRO_TODAY || new Date().toISOString()).slice(0, 10);

function main() {
	parseOrExit(process.argv.slice(2), {
		usage: "usage: node scripts/report-retro-due.js",
	});
	const date = today();
	let v;
	try {
		v = condition(date);
	} catch (e) {
		const why = e instanceof Error ? e.message : String(e);
		writeFd(2, `BROKEN: ${why}\n`);
		process.exit(2);
	}
	if (v.skip !== null) {
		process.stderr.write(`${v.skip}\n`);
		return;
	}
	if (!v.due) {
		console.log(
			`Last weekly retro ran ${v.newest}, ${v.age} day(s) before ${date} — nothing to file.`,
		);
		return;
	}

	const text = body(v.newest, v.weeklyCount);
	/* No PreToolUse hook sees a script's own gh call, so the create guard's
	 * takes: check is made here (#969). */
	const refused = takesRefusal([LABEL], text);
	if (refused) {
		writeFd(2, `BROKEN: ${refused}\n`);
		process.exit(2);
	}
	let filed;
	try {
		filed = fileOrRefresh({
			title: TITLE,
			label: LABEL,
			labels: [LABEL],
			body: text,
		});
	} catch (e) {
		/* Not e.message: a failed gh call's holds its whole argv, the body
		 * included. */
		const hint =
			parseGhFailureReason(e) === "unreachable"
				? unreachableRemedy(e)
				: "A gh 403 is a token missing a permission: the gh token needs `issues: write`.";
		writeFd(
			2,
			`BROKEN: could not file or refresh "${TITLE}" — ${parseErrLine(e)}\n${hint} The run is still due: re-run once that is cleared, or the next day's run retries.\n`,
		);
		process.exit(2);
	}
	console.log(`Weekly retro due. ${filed}`);
}

if (require.main === module) main();

module.exports = {
	TITLE,
	LABEL,
	today,
	condition,
};
