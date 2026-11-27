#!/usr/bin/env node

const { writeFd } = require("./lib/write-fd.js");
const { scriptPath } = require("./lib/script-path.js");
const { readJsonl } = require("./lib/jsonl.js");
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
const { buildStandaloneLine } = require("./lib/standalone-line.js");
const { RUN_RECORD } = require("./lib/retro-record");

const TITLE = "Weekly retro due";
const LABEL = takesLabel("implement");
const DUE_DAYS = 7;

/**
 * @param {import("./lib/jsonl.js").Jsonl} read
 * @returns {string | null}
 */
function newestWeekly(read) {
	const [bad] = read.bad;
	if (bad !== undefined)
		throw new Error(`${RUN_RECORD}:${bad} is not a JSON object`);
	const [zeroed] = read.zeroed;
	if (zeroed !== undefined)
		throw new Error(`${RUN_RECORD}:${zeroed} holds a record zeroed by a crash`);
	/** @type {string | null} */
	let newest = null;
	for (const { row, line } of read.entries) {
		const date = weeklyDate(row, line);
		if (date === null) continue;
		if (!newest || date > newest) newest = date;
	}
	return newest;
}

/**
 * @param {Record<string, unknown>} row
 * @param {number} line
 * @returns {string | null}
 */
function weeklyDate(row, line) {
	if (row.mode !== "weekly") return null;
	const date = typeof row.date === "string" ? row.date.slice(0, 10) : "";
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)))
		throw new Error(
			`${RUN_RECORD}:${line} is a weekly run with no readable "date" (YYYY-MM-DD)`,
		);
	return date;
}

/**
 * @param {string | null} newest
 * @param {string} todayIso
 * @returns {{ due: boolean, age: number | null }}
 */
function verdict(newest, todayIso) {
	if (!newest) return { due: true, age: null };
	const age = Math.floor((Date.parse(todayIso) - Date.parse(newest)) / 864e5);
	return { due: age >= DUE_DAYS, age };
}

/**
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
			? `The newest \`weekly\` run in \`${RUN_RECORD}\` is dated ${newest}, ${DUE_DAYS} or more days ago.`
			: `\`${RUN_RECORD}\` holds no \`weekly\` run yet; a \`calibrate\` line does not count.`,
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
		buildStandaloneLine(
			"a daily-run reporter's standing condition, under no spec (workflow-core#948 §Trigger).",
		),
	].join("\n");
}

/**
 * @param {string} todayIso
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
	const read = readJsonl(path.join(hostRoot(), RUN_RECORD));
	if (!read)
		throw new Error(
			`${RUN_RECORD} is missing. It is committed empty; restore it with \`git checkout -- ${RUN_RECORD}\`.`,
		);
	const newest = newestWeekly(read);
	return {
		skip: null,
		weeklyCount: c.retro.weeklyCount,
		newest,
		...verdict(newest, todayIso),
	};
}

const today = () =>
	(process.env.RETRO_TODAY || new Date().toISOString()).slice(0, 10);

function main() {
	parseOrExit(process.argv.slice(2), {
		usage: `usage: node ${scriptPath("report-retro-due.js")}`,
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
		writeFd(2, `${v.skip}\n`);
		return;
	}
	if (!v.due) {
		writeFd(
			1,
			`Last weekly retro ran ${v.newest}, ${v.age} day(s) before ${date} — nothing to file.\n`,
		);
		return;
	}

	const text = body(v.newest, v.weeklyCount);
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
	writeFd(1, `Weekly retro due. ${filed}\n`);
}

if (require.main === module) main();

module.exports = {
	TITLE,
	LABEL,
	today,
	condition,
};
