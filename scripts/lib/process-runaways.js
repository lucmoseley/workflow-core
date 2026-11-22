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
 * @property {string} argv
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

/** @param {Episode} e */
const buildEpisodeTitle = (e) =>
	`${TITLE_PREFIX}${utcMinute(new Date(e.since))} UTC (${crypto
		.createHash("sha1")
		.update(e.argv)
		.digest("hex")
		.slice(0, 8)})`;

/** @param {Firing[]} firings */
const countKilled = (firings) =>
	firings.reduce((sum, f) => sum + f.killed.length, 0);

/** @param {Episode} e */
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
 * @param {string} repo
 * @param {Parameters<typeof readTicketsByPrefix>[3]} [run]
 */
const readEpisodeTickets = (repo, run) =>
	readTicketsByPrefix(repo, "process runaway tickets", TITLE_PREFIX, run);

module.exports = {
	buildEpisodeBody,
	buildEpisodeTitle,
	countKilled,
	readEpisodeTickets,
	readEpisodes,
};
