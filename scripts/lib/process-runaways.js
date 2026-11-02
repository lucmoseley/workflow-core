/*
 * process-runaways.js — memwatch's process-runaway firings, read from the line
 * ~/memwatch.sh appends for each (#3807): what the runaway filer tickets and the
 * morning review lists.
 *
 * AN EPISODE is the firings sharing a `since`, the pass the count first held
 * memwatch's line, and an `argv`. A group that respawns fires on every pass until
 * the count clears, so one episode can hold many lines; a second group fired on
 * under the same `since` is a second episode, so its argv reaches a ticket.
 *
 * A line torn by a kill mid-write is skipped. An absent log is no firings: the
 * file only exists once something has fired. WFC_RUNAWAY_LOG injects the path
 * (§N7).
 */

const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { caught } = require("./caught.js");
const {
	buildProcessSpan,
	localMinute,
	readTicketsByPrefix,
	utcMinute,
} = require("./incident-tickets.js");
const { readJsonl } = require("./jsonl.js");
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
 * @typedef {{since: string, argv: string, firings: Firing[]}} Episode
 */

const readLogPath = () =>
	process.env.WFC_RUNAWAY_LOG ||
	path.join(os.homedir(), "memwatch-runaway.jsonl");

/**
 * @param {Record<string, unknown>} r
 * @returns {r is Firing}
 */
const isFiring = (r) =>
	typeof r.since === "string" &&
	typeof r.ts === "string" &&
	typeof r.argv === "string" &&
	Array.isArray(r.killed) &&
	Array.isArray(r.parents) &&
	!Number.isNaN(Date.parse(r.since)) &&
	!Number.isNaN(Date.parse(r.ts));

/**
 * The episodes with a firing after `sinceMs`, oldest first, each read whole.
 * @param {number} sinceMs
 * @returns {{episodes: Episode[], why: string|null}}
 */
function readEpisodes(sinceMs) {
	let log;
	try {
		log = readJsonl(readLogPath());
	} catch (e) {
		return {
			episodes: [],
			why: `${readLogPath()}: ${caught(e).message}`,
		};
	}
	/** @type {Map<string, Episode>} */
	const byKey = new Map();
	for (const f of (log?.rows ?? []).filter(isFiring)) {
		const key = `${f.since}\0${f.argv}`;
		const open = byKey.get(key);
		if (open) open.firings.push(f);
		else byKey.set(key, { since: f.since, argv: f.argv, firings: [f] });
	}
	return {
		episodes: [...byKey.values()].filter((e) =>
			e.firings.some((f) => Date.parse(f.ts) > sinceMs),
		),
		why: null,
	};
}

/**
 * UTC, so a run under another TZ names the episode the same; the hash tells two
 * groups fired on under one `since` apart.
 * @param {Episode} e
 */
const buildEpisodeTitle = (e) =>
	`${TITLE_PREFIX}${utcMinute(new Date(e.since))} UTC (${crypto
		.createHash("sha1")
		.update(e.argv)
		.digest("hex")
		.slice(0, 8)})`;

/** @param {Firing[]} firings */
const countKilled = (firings) =>
	firings.reduce((sum, f) => sum + f.killed.length, 0);

/**
 * The episode's ticket body, as far as the log has reached: the ticket is filed
 * while a group may still be firing, so a person hears at once.
 * @param {Episode} e
 */
function buildEpisodeBody(e) {
	const killed = countKilled(e.firings);
	const [first] = e.firings;
	return `## What happened

memwatch read ${first?.procs} processes after the count had held its line since ${localMinute(new Date(e.since))} machine time (\`${docPath("environment.md")}\` §4).

${
	killed > 0
		? `It sent SIGKILL to ${killed} ${killed === 1 ? "process" : "processes"} sharing one argv, on ${e.firings.length} ${e.firings.length === 1 ? "pass" : "passes"}.`
		: "It killed nothing: no group of one argv reached its size line, so the count may still be high. Read the machine now."
}

Largest group, ${Math.max(...e.firings.map((f) => f.size))} processes: ${buildProcessSpan(e.argv)}

Parents at the first firing, by direct children:

| PID | Children | Argv |
| --- | --- | --- |
${(first?.parents ?? []).map((p) => `| ${p.pid} | ${p.kids} | ${buildProcessSpan(p.argv)} |`).join("\n")}

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
	buildEpisodeTitle,
	countKilled,
	readEpisodeTickets,
	readEpisodes,
};
