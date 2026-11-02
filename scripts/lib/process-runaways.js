/*
 * process-runaways.js — memwatch's process-runaway firings, read from the line
 * ~/memwatch.sh appends for each (#3807): what the runaway filer tickets and the
 * morning review lists.
 *
 * AN EPISODE is the firings sharing a `since`, the pass the count first held
 * memwatch's line. A chain that respawns fires on every pass until the count
 * clears, so one episode can hold many lines. Two episodes cannot share a
 * minute: each holds the line for memwatch's 10-minute window before firing.
 *
 * A line torn by a kill mid-write is skipped. An absent log is no firings: the
 * file only exists once something has fired. WFC_RUNAWAY_LOG injects the path
 * (§N7).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
	localMinute,
	processSpan,
	readTicketsByPrefix,
	utcMinute,
} = require("./incident-tickets.js");
const { docPath } = require("./script-path.js");

const TITLE_PREFIX = "Process runaway from ";

/**
 * @typedef {object} Firing
 * @property {string} ts
 * @property {string} since
 * @property {number} procs
 * @property {string} argv the largest non-Claude group's, "" where none
 * @property {number} size
 * @property {{pid: number, kids: number, argv: string}[]} parents
 * @property {number[]} killed
 * @typedef {{since: string, firings: Firing[]}} Episode
 */

const logPath = () =>
	process.env.WFC_RUNAWAY_LOG ||
	path.join(os.homedir(), "memwatch-runaway.jsonl");

/** @param {string} line @returns {Firing|null} */
function parseFiring(line) {
	try {
		const f = JSON.parse(line);
		return Number.isNaN(Date.parse(f.since)) || Number.isNaN(Date.parse(f.ts))
			? null
			: f;
	} catch {
		return null;
	}
}

/**
 * The episodes with a firing after `sinceMs`, oldest first, each read whole.
 * @param {number} sinceMs
 * @returns {{episodes: Episode[], why: string|null}}
 */
function readEpisodes(sinceMs) {
	let text;
	try {
		text = fs.readFileSync(logPath(), "utf8");
	} catch (e) {
		const err = /** @type {NodeJS.ErrnoException} */ (e);
		return err.code === "ENOENT"
			? { episodes: [], why: null }
			: { episodes: [], why: `${logPath()}: ${err.message}` };
	}
	/** @type {Map<string, Episode>} */
	const bySince = new Map();
	for (const line of text.split("\n")) {
		const f = parseFiring(line);
		if (f === null) continue;
		const open = bySince.get(f.since);
		if (open) open.firings.push(f);
		else bySince.set(f.since, { since: f.since, firings: [f] });
	}
	return {
		episodes: [...bySince.values()].filter((e) =>
			e.firings.some((f) => Date.parse(f.ts) > sinceMs),
		),
		why: null,
	};
}

/** UTC, so a run under another TZ names the episode the same. */
const episodeTitle = (/** @type {Episode} */ e) =>
	`${TITLE_PREFIX}${utcMinute(new Date(e.since))} UTC`;

/** @param {Firing[]} firings */
const killedIn = (firings) =>
	firings.reduce((sum, f) => sum + f.killed.length, 0);

/**
 * What the episode's firings did, one row per argv.
 * @param {Episode} e
 */
function groupRows(e) {
	/** @type {Map<string, {size: number, killed: number}>} */
	const rows = new Map();
	for (const f of e.firings) {
		const row = rows.get(f.argv) ?? { size: 0, killed: 0 };
		row.size = Math.max(row.size, f.size);
		row.killed += f.killed.length;
		rows.set(f.argv, row);
	}
	return [...rows].map(
		([argv, r]) => `| ${r.size} | ${r.killed} | ${processSpan(argv)} |`,
	);
}

/**
 * The episode's ticket body, as far as the log has reached: the ticket is filed
 * while a chain may still be firing, so a person hears at once.
 * @param {Episode} e
 */
function buildEpisodeBody(e) {
	const killed = killedIn(e.firings);
	const first = /** @type {Firing} */ (e.firings[0]);
	return `## What happened

memwatch read ${first.procs} processes after the count had held its line since ${localMinute(new Date(e.since))} machine time (\`${docPath("environment.md")}\` §4).

${
	killed > 0
		? `It sent SIGKILL to ${killed} ${killed === 1 ? "process" : "processes"} sharing one argv, on ${e.firings.length} ${e.firings.length === 1 ? "pass" : "passes"}.`
		: "It killed nothing: no group of one argv reached its size line, so the count may still be high. Read the machine now."
}

| Largest group | Killed | Argv |
| --- | --- | --- |
${groupRows(e).join("\n")}

Parents at the first firing, by direct children:

| PID | Children | Argv |
| --- | --- | --- |
${first.parents.map((p) => `| ${p.pid} | ${p.kids} | ${processSpan(p.argv)} |`).join("\n")}

## What to find

What started this, and whether it could start again. The pids and any later firings are in \`~/memwatch-runaway.jsonl\` under \`"since":"${e.since}"\`; the process-count blocks are in \`~/memwatch.log\` and \`~/memwatch-archive.log\` around that time.

## Acceptance criteria

- [ ] The cause is named, and fixed or ticketed.
`;
}

/**
 * The episode tickets on `repo`, by title; throws where the tracker cannot be
 * read.
 * @param {string} repo
 */
const readEpisodeTickets = (repo) =>
	readTicketsByPrefix(repo, "process runaway tickets", TITLE_PREFIX);

module.exports = {
	buildEpisodeBody,
	episodeTitle,
	killedIn,
	readEpisodeTickets,
	readEpisodes,
};
