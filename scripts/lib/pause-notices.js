/*
 * pause-notices.js — a no-progress pause's phone notice (#4222, ruling #4200). Only
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
 * logged once; here only workflow-core sets `founderNotice`, so a pause on other
 * checkouts' issues alone reaches only the panel.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
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
 * The first of `issues` in a checkout whose `founderNotice` goes to its own
 * tracker, or null.
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
 * The record a pause's notice file keeps, or null where it will not read.
 * @param {string} file
 * @returns {PauseRecord|null}
 */
function readRecord(file) {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		const target = value?.target;
		return typeof value?.pausedAt === "number" &&
			Array.isArray(value.issues) &&
			(target === null ||
				(typeof target?.root === "string" && typeof target.number === "number"))
			? { pausedAt: value.pausedAt, issues: value.issues, target }
			: null;
	} catch (err) {
		if (caught(err).code === "ENOENT" || err instanceof SyntaxError)
			return null;
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
					? `The refill loop paused: no act from ${issues.join(", ")}. It launches nothing until \`node scripts/refill-loop.js set --resume\`.`
					: `The refill loop's ${name} has ended: it launches again.`,
				marker(phase),
			),
	};
}

/**
 * A live no-progress pause's raise: its record written on first sight, then its
 * phase tended. A pause with nowhere to page logs so once, on that first sight.
 * @param {Pause & {issues?: PauseIssue[]}} pause
 * @param {number} now
 * @param {Log} log
 */
function tendRaise(pause, now, log) {
	const file = buildNoticeFile(pause.at);
	let record = readRecord(file);
	if (record === null) {
		const issues = pause.issues ?? [];
		record = {
			pausedAt: pause.at,
			issues: issues.map(buildPauseIssueText),
			target: findTarget(issues),
		};
		writeNotice(file, {
			...record,
			raise: null,
			clear: null,
			isUnsetLogged: record.target === null,
		});
		if (record.target === null)
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
 * is owed, a record that will not read owing nothing.
 * @param {string} file
 * @param {number} now
 * @param {Log} log
 */
function tendClear(file, now, log) {
	const record = readRecord(file);
	const target = record?.target ?? null;
	const config = target === null ? null : readNoticeConfig(target.root);
	if (
		record === null ||
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
 * The notice files of pauses, each by its name's time.
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
			guarded(pausedAt, () => tendClear(file, now, log));
	if (live !== null) guarded(live.at, () => tendRaise(live, now, log));
}

module.exports = { tendPauseNotices };
