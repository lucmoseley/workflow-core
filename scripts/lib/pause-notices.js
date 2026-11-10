/*
 * pause-notices.js — a no-progress pause's phone notice (workflow-core#4222, ruling workflow-core#4200). Only
 * `set --resume` ends that pause, and only the founder runs it, so he is paged: one
 * notice the tick the pause is written, and one once it ends, only where a raise
 * went. Each pause is its own cause, keyed by when it was written. The dispatch, its
 * sent-means-seen check, retry and record-before-dispatch are
 * lib/repo-hold-notices.js's tendPhase, under the same one-page-a-cause budget.
 *
 * A founder-set pause sends nothing: he made it. Nor does the quiet bench's, which
 * ends by itself.
 *
 * The notice comments on the first of the pause's issues whose checkout sets a
 * `founderNotice` whose `repo` is that checkout's tracker.
 *
 * RESIDUAL: a pause none of whose issues lives in such a tracker sends nothing,
 * logged once.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { readText } = require("./file-read.js");
const {
	buildPauseIssueText,
	NO_PROGRESS_PAUSE,
} = require("./refill-decide.js");
const { refillPath } = require("./refill-dir.js");
const {
	buildNoticeBody,
	readNoticeConfig,
	tendPhase,
} = require("./repo-hold-notices.js");
const { isClearOwed, readNotice, writeNotice } = require("./repo-holds.js");
const { scriptPath } = require("./script-path.js");
const { resolveKey } = require("./workflow-core-config.js");

/**
 * @typedef {import("./refill-decide.js").Pause} Pause
 * @typedef {import("./refill-decide.js").PauseIssue} PauseIssue
 * @typedef {import("./repo-holds.js").Log} Log
 * @typedef {import("./repo-hold-notices.js").NoticeName} NoticeName
 *
 * @typedef {object} PauseRecord  what a pause's notice file keeps beside its phases
 * @property {number} pausedAt
 * @property {string[]} issues  the pause's issues, as its text names them
 * @property {PauseIssue|null} target  the issue its notice comments on
 */

const NOTICE_SUFFIX = ".notice";

const noticeDir = () => refillPath("pause-notices");

/** @param {number} pausedAt */
const buildNoticeFile = (pausedAt) =>
	path.join(noticeDir(), `${pausedAt}${NOTICE_SUFFIX}`);

/**
 * @param {PauseIssue[]} issues
 * @returns {PauseIssue|null}
 */
function findTarget(issues) {
	for (const issue of issues) {
		const config = readNoticeConfig(issue.root);
		const tracker = resolveKey("tracker", { root: issue.root });
		if (
			config !== null &&
			typeof tracker === "string" &&
			tracker.toLowerCase() === config.repo.toLowerCase()
		)
			return issue;
	}
	return null;
}

/**
 * The record a pause's notice file keeps, "absent" where there is none, and
 * "torn" where it will not read or parse.
 * @param {string} file
 * @returns {PauseRecord|"absent"|"torn"}
 */
function readPauseRecord(file) {
	const read = readText(file);
	if (read.state === "absent") return "absent";
	if (read.state === "unreadable") return "torn";
	try {
		const value = JSON.parse(read.data);
		const target = value?.target;
		return typeof value?.pausedAt === "number" &&
			Array.isArray(value.issues) &&
			(target === null ||
				(typeof target?.root === "string" && typeof target.number === "number"))
			? { pausedAt: value.pausedAt, issues: value.issues, target }
			: "torn";
	} catch (err) {
		if (err instanceof SyntaxError) return "torn";
		throw err;
	}
}

/** @param {number} pausedAt */
const buildPauseName = (pausedAt) =>
	`no-progress pause of ${new Date(pausedAt).toISOString()}`;

/**
 * @param {PauseRecord & {target: PauseIssue}} record
 * @returns {import("./repo-hold-notices.js").NoticeCause}
 */
function buildPauseCause({ pausedAt, issues, target }) {
	const name = buildPauseName(pausedAt);
	/** @param {NoticeName} phase */
	const marker = (phase) => `refill-pause-notice ${pausedAt} ${phase}`;
	return {
		name,
		ref: `${name} in ${target.root}`,
		issue: target.number,
		marker,
		message: (phase) =>
			buildNoticeBody(
				phase === "raise"
					? `The refill loop paused: no act from ${issues.join(", ")}. It launches nothing until \`node ${scriptPath("refill-loop.js")} set --resume\`.`
					: `The refill loop's ${name}, on no act from ${issues.join(", ")}, has ended: it launches again.`,
				marker(phase),
			),
	};
}

/**
 * A live no-progress pause's raise: its record written on first sight, then its
 * phase tended. A torn record cannot say whether a page went, so it is rewritten as one with
 * nowhere to page, logged: a second page is the worse fault (workflow-core#3871).
 * @param {Pause & {issues?: PauseIssue[]}} pause
 * @param {number} now
 * @param {Log} log
 */
function tendRaise(pause, now, log) {
	const file = buildNoticeFile(pause.at);
	let record = readPauseRecord(file);
	if (typeof record === "string") {
		const issues = pause.issues ?? [];
		const isTorn = record === "torn";
		record = {
			pausedAt: pause.at,
			issues: issues.map(buildPauseIssueText),
			target: isTorn ? null : findTarget(issues),
		};
		writeNotice(file, {
			...record,
			raise: null,
			clear: null,
			isUnsetLogged: record.target === null,
		});
		if (isTorn)
			log(
				`${buildPauseName(pause.at)}: notice record torn, read as sent: ${file}`,
			);
		else if (record.target === null)
			log(
				`${buildPauseName(pause.at)}: no phone notice, as none of ${
					record.issues.join(", ") || "its issues"
				} lives in a tracker its checkout's founderNotice pages from`,
			);
	}
	const { target } = record;
	if (target === null) return;
	const config = readNoticeConfig(target.root);
	if (config === null) return;
	tendPhase({
		cause: buildPauseCause({ ...record, target }),
		phase: "raise",
		file,
		config,
		paged: null,
		now,
		log,
	});
}

/**
 * An ended pause's clear, where its raise went; its file is removed once nothing
 * is owed. A torn record cannot name its issue, so its clear is given up, logged.
 * @param {string} file
 * @param {number} pausedAt
 * @param {number} now
 * @param {Log} log
 */
function tendClear(file, pausedAt, now, log) {
	const record = readPauseRecord(file);
	if (record === "torn")
		log(
			`${buildPauseName(pausedAt)}: clear notice lost: its record will not read: ${file}`,
		);
	const target = typeof record === "string" ? null : record.target;
	const config = target === null ? null : readNoticeConfig(target.root);
	if (
		typeof record === "string" ||
		target === null ||
		config === null ||
		!isClearOwed(readNotice(file))
	) {
		fs.rmSync(file, { force: true });
		return;
	}
	tendPhase({
		cause: buildPauseCause({ ...record, target }),
		phase: "clear",
		file,
		config,
		paged: null,
		now,
		log,
	});
}

/**
 * @param {Log} log
 * @returns {{file: string, pausedAt: number}[]}
 */
function readNoticeFiles(log) {
	try {
		return fs
			.readdirSync(noticeDir())
			.filter((name) => name.endsWith(NOTICE_SUFFIX))
			.map((name) => ({
				file: path.join(noticeDir(), name),
				pausedAt: Number(name.slice(0, -NOTICE_SUFFIX.length)),
			}));
	} catch (err) {
		if (caught(err).code !== "ENOENT")
			log(`pause notices unread: ${caught(err).message}`);
		return [];
	}
}

/**
 * The pause notices `paused` calls for: its raise where it is a no-progress pause,
 * and the clear of each pause before it. Any throw is logged and costs that pause
 * alone its tick, never the launches.
 * @param {Pause|undefined} paused  the control's
 * @param {number} now
 * @param {Log} log
 */
function tendPauseNotices(paused, now, log) {
	const live = paused?.by === NO_PROGRESS_PAUSE ? paused : null;
	/** @param {number} at @param {() => void} act */
	const guarded = (at, act) => {
		try {
			act();
		} catch (err) {
			log(`${buildPauseName(at)}: notice not tended: ${caught(err).message}`);
		}
	};
	for (const { file, pausedAt } of readNoticeFiles(log))
		if (pausedAt !== live?.at)
			guarded(pausedAt, () => tendClear(file, pausedAt, now, log));
	if (live !== null) guarded(live.at, () => tendRaise(live, now, log));
}

module.exports = { tendPauseNotices };
