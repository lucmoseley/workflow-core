const { requiredGroup } = require("./regex-group.js");
const { DAY_MS } = require("./retained-jsonl.js");

const UNREAD_LINE =
	/^(Events|Closes|Decisions) unread since (\S+) in (.+)\.$/gm;
const READ_LINE = /^Events read in (.+)\.$/gm;
// guess, #3835
const ABSENT_CARRY_DAYS = 30;

/**
 * @typedef {import("./morning-review.js").RepoReading} RepoReading
 * @typedef {import("./morning-review.js").Unread} Unread
 * @typedef {{closes: boolean, decisions: boolean}} EventKinds
 * @typedef {{closes: string, decisions: string, why: string | null}} RepoStart
 * @typedef {{kind: "Events" | "Closes" | "Decisions", checkout: string,
 *   since: string}} UnreadEvents
 * @typedef {{reading: RepoReading | null, unread: Unread[],
 *   unreadEvents: UnreadEvents[]}} RepoRead
 */

/**
 * @param {UnreadEvents} unread
 * @returns {string}
 */
const renderUnreadLine = ({ kind, since, checkout }) =>
	`${kind} unread since ${since} in ${checkout}.`;

/**
 * @param {string} checkout
 * @returns {string}
 */
const renderReadLine = (checkout) => `Events read in ${checkout}.`;

/**
 * @param {string} body
 * @param {string} checkout
 * @returns {{closes?: string, decisions?: string}}
 */
function parseUnreadStarts(body, checkout) {
	/** @type {{closes?: string, decisions?: string}} */
	const at = {};
	for (const m of body.matchAll(UNREAD_LINE)) {
		if (requiredGroup(m, 3, UNREAD_LINE) !== checkout) continue;
		const kind = requiredGroup(m, 1, UNREAD_LINE);
		const time = requiredGroup(m, 2, UNREAD_LINE);
		if (kind !== "Decisions") at.closes ??= time;
		if (kind !== "Closes") at.decisions ??= time;
	}
	return at;
}

/**
 * @param {{body: string} | undefined} previous
 * @returns {string[]}
 */
const parseKnownCheckouts = (previous) => {
	const body = previous?.body ?? "";
	return [
		...new Set([
			...[...body.matchAll(UNREAD_LINE)].map((m) =>
				requiredGroup(m, 3, UNREAD_LINE),
			),
			...[...body.matchAll(READ_LINE)].map((m) =>
				requiredGroup(m, 1, READ_LINE),
			),
		]),
	];
};

/**
 * @param {{number: number, body: string} | undefined} previous
 * @param {string} checkout
 * @param {string} since
 * @returns {RepoStart}
 */
function buildRepoStart(previous, checkout, since) {
	const at = previous ? parseUnreadStarts(previous.body, checkout) : {};
	/** @param {string | undefined} time */
	const isBad = (time) => time !== undefined && Number.isNaN(Date.parse(time));
	/** @param {string | undefined} time */
	const usable = (time) => (time === undefined || isBad(time) ? since : time);
	return {
		closes: usable(at.closes),
		decisions: usable(at.decisions),
		why:
			isBad(at.closes) || isBad(at.decisions)
				? `#${previous?.number}'s unread line, so events before ${since}`
				: null,
	};
}

/**
 * @param {RepoStart} start
 * @returns {string}
 */
const buildHistoryStart = ({ closes, decisions }) =>
	Date.parse(closes) < Date.parse(decisions) ? decisions : closes;

/**
 * @param {RepoStart} start
 * @param {EventKinds} kinds
 */
const isOneStart = (start, kinds) =>
	kinds.closes && kinds.decisions && start.closes === start.decisions;

/**
 * @param {string} checkout
 * @param {RepoStart} start
 * @param {EventKinds} unread
 * @returns {UnreadEvents[]}
 */
function buildCarryLines(checkout, start, unread) {
	if (isOneStart(start, unread))
		return [{ kind: "Events", checkout, since: start.closes }];
	/** @type {UnreadEvents[]} */
	const lines = [];
	if (unread.closes)
		lines.push({ kind: "Closes", checkout, since: start.closes });
	if (unread.decisions)
		lines.push({ kind: "Decisions", checkout, since: start.decisions });
	return lines;
}

/**
 * @param {string} checkout
 * @param {{why: string | null}} start
 * @returns {Unread[]}
 */
const buildStartFaults = (checkout, { why }) =>
	why === null ? [] : [{ repo: checkout, why }];

/**
 * @param {string} checkout
 * @param {RepoStart} start
 * @param {string} repo
 * @param {string} why
 * @returns {RepoRead}
 */
const buildUnreadRepo = (checkout, start, repo, why) => ({
	reading: null,
	unread: [...buildStartFaults(checkout, start), { repo, why }],
	unreadEvents: buildCarryLines(checkout, start, {
		closes: true,
		decisions: true,
	}),
});

/**
 * @param {string} checkout
 * @param {RepoStart} start
 * @param {string} why
 * @param {EventKinds} ended
 * @returns {RepoRead}
 */
function buildEndedRepo(checkout, start, why, ended) {
	const givenUp = isOneStart(start, ended)
		? [`its events since ${start.closes}`]
		: [
				...(ended.closes ? [`its closes since ${start.closes}`] : []),
				...(ended.decisions ? [`its decisions since ${start.decisions}`] : []),
			];
	return {
		reading: null,
		unread: [
			...buildStartFaults(checkout, start),
			{
				repo: checkout,
				why: `${why}, so ${givenUp.join(" and ")} reach no review`,
			},
		],
		unreadEvents: buildCarryLines(checkout, start, {
			closes: !ended.closes,
			decisions: !ended.decisions,
		}),
	};
}

/**
 * @param {object} reading
 * @param {{number: number, body: string} | undefined} reading.previous
 * @param {Set<string>} reading.listed
 * @param {string} reading.since
 * @param {number} reading.nowMs
 * @param {(checkout: string) => {carried: boolean, why: string} | null} reading.readAbsence
 * @returns {RepoRead[]}
 */
function buildAbsentRepos({ previous, listed, since, nowMs, readAbsence }) {
	return parseKnownCheckouts(previous).flatMap((checkout) => {
		if (listed.has(checkout)) return [];
		const absence = readAbsence(checkout);
		if (absence === null) return [];
		const { carried, why } = absence;
		const start = buildRepoStart(previous, checkout, since);
		if (!carried)
			return [
				buildEndedRepo(checkout, start, why, { closes: true, decisions: true }),
			];
		/** @param {string} at */
		const isOverLimit = (at) =>
			nowMs - Date.parse(at) > ABSENT_CARRY_DAYS * DAY_MS;
		const ended = {
			closes: isOverLimit(start.closes),
			decisions: isOverLimit(start.decisions),
		};
		return ended.closes || ended.decisions
			? [
					buildEndedRepo(
						checkout,
						start,
						`${why} and carried over ${ABSENT_CARRY_DAYS} days`,
						ended,
					),
				]
			: [buildUnreadRepo(checkout, start, checkout, why)];
	});
}

module.exports = {
	buildAbsentRepos,
	buildCarryLines,
	buildStartFaults,
	buildUnreadRepo,
	buildHistoryStart,
	renderReadLine,
	renderUnreadLine,
	buildRepoStart,
};
