/*
 * review-carry.js — what a morning review hands the next one (workflow-core#3831, spec workflow-core#1995
 * §The morning review issue). Pure: scripts/file-morning-review.js does every
 * read.
 *
 * A repo that does not read keeps its closes and decisions (workflow-core#3831): the review
 * prints where its events went unread from, and the next starts that repo there
 * (buildRepoStart), so each lands in the first review to read the repo. Each kind
 * carries alone (workflow-core#3928): a repo whose closes will not read lists its decisions
 * and prints a `Closes unread` line, so the next review repeats none of them. An
 * `Events unread` line is both kinds from one start. The line
 * outlives the checkout's absence from discovery, to the end buildAbsentRepos
 * gives it (workflow-core#3835). Each review's closing comment also names the checkouts it
 * read, so one's first absence is carried from that review's window end (workflow-core#3844).
 *
 * The lines are the only record of a carry, so a filed review's lines must go on
 * reading: their print and their parse both live here.
 */

const { requiredGroup } = require("./regex-group.js");
const { DAY_MS } = require("./retained-jsonl.js");

const UNREAD_LINE =
	/^(Events|Closes|Decisions) unread since (\S+) in (.+)\.$/gm;
const READ_LINE = /^Events read in (.+)\.$/gm;
/* How old a start may grow on a checkout discovery no longer lists. Untraced, a
 * guess: past any repair, and a repo that left workflow-core stops being named. */
const ABSENT_CARRY_DAYS = 30;

/**
 * @typedef {import("./morning-review.js").RepoReading} RepoReading
 * @typedef {import("./morning-review.js").Unread} Unread
 * @typedef {{closes: boolean, decisions: boolean}} EventKinds which kinds a
 *   carry or its end covers
 * @typedef {{closes: string, decisions: string, why: string | null}} RepoStart
 *   where each kind of a checkout's events starts, and what of its line would
 *   not read
 * @typedef {{kind: "Events" | "Closes" | "Decisions", checkout: string,
 *   since: string}} UnreadEvents what of a checkout did not read, and where it
 *   starts; `Events` is both kinds
 * @typedef {{reading: RepoReading | null, unread: Unread[],
 *   unreadEvents: UnreadEvents[]}} RepoRead one checkout's part of a review
 */

/**
 * The line the next review reads a carry back from.
 * @param {UnreadEvents} unread
 * @returns {string}
 */
const renderUnreadLine = ({ kind, since, checkout }) =>
	`${kind} unread since ${since} in ${checkout}.`;

/**
 * The line naming a checkout this review read, for the next to notice its absence.
 * @param {string} checkout
 * @returns {string}
 */
const renderReadLine = (checkout) => `Events read in ${checkout}.`;

/**
 * Where a review's body says each kind of a checkout's events went unread from.
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
 * Where each kind of a checkout's events starts: where the previous review says
 * it went unread from, else the window's start. Residual: a line whose time will
 * not read, as after a hand edit, starts at the window's start, and `why` says so.
 * @param {{number: number, body: string} | undefined} previous
 * @param {string} checkout its directory name, which a read of no config still has
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
 * Where a checkout's table history went unread from, its commit-time fallback: a
 * review reading either kind read the history too, so the later start (workflow-core#3928).
 * Residual: a history that failed in such a review, with no cursor before it,
 * starts after what that review missed.
 * @param {RepoStart} start
 * @returns {string}
 */
const buildHistoryStart = ({ closes, decisions }) =>
	Date.parse(closes) < Date.parse(decisions) ? decisions : closes;

/**
 * Whether `kinds` are both kinds, from one start, which one line can name.
 * @param {RepoStart} start
 * @param {EventKinds} kinds
 */
const isOneStart = (start, kinds) =>
	kinds.closes && kinds.decisions && start.closes === start.decisions;

/**
 * The lines carrying what of a checkout's events this review did not read.
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
 * A buildRepoStart's own fault, as what the review could not read.
 * @param {string} checkout
 * @param {{why: string | null}} start
 * @returns {Unread[]}
 */
const buildStartFaults = (checkout, { why }) =>
	why === null ? [] : [{ repo: checkout, why }];

/**
 * A checkout that gave this review nothing: named, with its events carried.
 * @param {string} checkout
 * @param {RepoStart} start
 * @param {string} repo what to name it, its tracker where that read
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
 * A checkout whose carry ends, for the kinds `ended` names, naming what that gives
 * up; any other kind stays carried.
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
 * The review's parts for the checkouts the previous review read or carried and
 * discovery no longer lists (workflow-core#3835, workflow-core#3844): each named and carried until its
 * directory is gone or its start is ABSENT_CARRY_DAYS old.
 * @param {object} reading
 * @param {{number: number, body: string} | undefined} reading.previous
 * @param {Set<string>} reading.listed the checkouts discovery answers for
 * @param {string} reading.since the window's start
 * @param {number} reading.nowMs
 * @param {(checkout: string) => {carried: boolean, why: string} | null} reading.readAbsence
 *   null for a checkout that stays out unnamed
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
