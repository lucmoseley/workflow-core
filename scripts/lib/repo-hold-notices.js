const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { gh, ghJson, parseErrLine } = require("./gh.js");
const { refillPath } = require("./refill-dir.js");
const {
	buildNoticeName,
	buildProbePagedFile,
	holdsDir,
	readHolds,
	readLiftedHolds,
	readLiftedRecord,
	readNotice,
	readStoreRoots,
	TICK_CALL_TIMEOUT_MS,
	writeNotice,
} = require("./repo-holds.js");
const { readConfig } = require("./workflow-core-config.js");

/**
 * @typedef {import("./repo-holds.js").RepoHold} RepoHold
 * @typedef {import("./repo-holds.js").HoldNotice} HoldNotice
 * @typedef {import("./repo-holds.js").NoticePhase} NoticePhase
 * @typedef {import("./repo-holds.js").LiftedHold} LiftedHold
 * @typedef {import("./repo-holds.js").Log} Log
 * @typedef {"raise"|"clear"} NoticeName
 * @typedef {object} NoticeCause
 * @property {string} name
 * @property {string} ref
 * @property {number} issue
 * @property {(phase: NoticeName) => string} marker
 * @property {(phase: NoticeName) => string} message
 * @typedef {object} NoticeStep
 * @property {NoticeCause} cause
 * @property {NoticeName} phase
 * @property {string} file
 * @property {import("./workflow-core-config.js").FounderNotice} config
 * @property {{file: string, raisedAt: number}|null} paged
 * @property {number} now
 * @property {Log} log
 * @typedef {{raisedAt: number|null, at: number}} ProbePage
 */

// guess, workflow-core#3597
const NOTICE_NO_WORK_MS = 30 * 60_000;

// guess, workflow-core#3869
const NOTICE_UNSEEN_MS = 15 * 60_000;

// guess, workflow-core#3871
const NOTICE_GIVE_UP_MS = 24 * 60 * 60_000;

// guess, workflow-core#4148
const PROBE_COOL_DOWN_MS = 6 * 60 * 60_000;

// guess, workflow-core#3871
const NOTICE_MAX_TRIES = 2;

const BROKEN_MENTION = "@​";

/**
 * @param {{agents: {state?: string, kind?: string}[]|null, isPaused: boolean}} seen
 * @param {number} now
 * @param {Log} log
 * @returns {number|null}
 */
function tendLastWorked({ agents, isPaused }, now, log) {
	if (agents === null) return null;
	const file = refillPath("last-slot-worked.json");
	try {
		const isWorking =
			isPaused ||
			agents.some((a) => a.state === "working" && a.kind !== "interactive");
		const workedAt = (isWorking ? null : readLastWorked(file, now, log)) ?? now;
		writeFileAtomic(file, JSON.stringify({ workedAt, tickedAt: now }), {
			mkdir: true,
		});
		return workedAt;
	} catch (err) {
		log(`last slot worked unkept: ${caught(err).message}`);
		return now;
	}
}

/**
 * @param {string} file
 * @param {number} now
 * @param {Log} log
 * @returns {number|null}
 */
function readLastWorked(file, now, log) {
	try {
		const { workedAt, tickedAt } = JSON.parse(fs.readFileSync(file, "utf8"));
		return typeof workedAt === "number" &&
			typeof tickedAt === "number" &&
			now - tickedAt < NOTICE_NO_WORK_MS
			? workedAt
			: null;
	} catch (err) {
		if (caught(err).code === "ENOENT") return null;
		if (!(err instanceof SyntaxError)) throw err;
		log(`last slot worked torn, begun anew: ${file}`);
		return null;
	}
}

/** @param {string} root */
const readNoticeConfig = (root) =>
	readConfig({ root, quiet: true }).founderNotice ?? null;

/**
 * @param {RepoHold} hold
 * @param {NoticeName} phase
 */
const buildNoticeMarker = (hold, phase) =>
	`repo-hold-notice ${hold.id} ${hold.raisedAt} ${phase}`;

/**
 * @param {string} text
 * @param {string} marker
 */
const buildNoticeBody = (text, marker) =>
	`${text.replaceAll("@", BROKEN_MENTION)}\n\n<!-- ${marker} -->`;

/**
 * @param {RepoHold} hold
 * @param {number} issue
 * @returns {NoticeCause}
 */
function buildHoldCause(hold, issue) {
	/** @param {NoticeName} phase */
	const marker = (phase) => buildNoticeMarker(hold, phase);
	return {
		name: `repo hold ${hold.id}`,
		ref: `repo hold ${hold.id} in ${hold.checkout}`,
		issue,
		marker,
		message: (phase) =>
			buildNoticeBody(
				`Repo hold in ${path.basename(hold.checkout)} ${
					phase === "raise" ? "has halted work" : "has cleared"
				}: ${hold.act}`,
				marker(phase),
			),
	};
}

/**
 * @param {string} file
 * @param {Log} log
 * @returns {ProbePage|null}
 */
function readProbePage(file, log) {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		if (
			(typeof value?.raisedAt === "number" || value?.raisedAt === null) &&
			typeof value.at === "number"
		)
			return { raisedAt: value.raisedAt, at: value.at };
	} catch (err) {
		if (caught(err).code === "ENOENT") return null;
		if (!(err instanceof SyntaxError)) throw err;
	}
	log(`probe page record torn, read as none: ${file}`);
	return null;
}

/**
 * @param {string} file
 * @param {ProbePage|null} page
 */
const writeProbePage = (file, page) =>
	page === null
		? fs.rmSync(file, { force: true })
		: writeFileAtomic(file, JSON.stringify(page), { mkdir: true });

/**
 * @param {RepoHold} hold
 * @param {string} root
 * @returns {NoticeStep["paged"]}
 */
const findPaged = (hold, root) =>
	hold.kind === "probe"
		? { file: buildProbePagedFile(root), raisedAt: hold.raisedAt }
		: null;

/**
 * @param {RepoHold} hold
 * @param {string} file
 * @param {number} now
 * @param {Log} log
 */
function isProbeCoolingDown(hold, file, now, log) {
	const page = readProbePage(file, log);
	return (
		page !== null &&
		page.raisedAt !== hold.raisedAt &&
		now - page.at < PROBE_COOL_DOWN_MS
	);
}

/**
 * @param {NoticeStep} step
 * @param {HoldNotice} notice
 * @param {number} tries
 */
function dispatchNotice(
	{ cause, phase, file, config, paged, now, log },
	notice,
	tries,
) {
	writeNotice(file, {
		...notice,
		[phase]: { at: now, tries, outcome: "dispatched" },
	});
	const lastPage = paged === null ? null : readProbePage(paged.file, log);
	if (paged !== null)
		writeProbePage(paged.file, { raisedAt: paged.raisedAt, at: now });
	const ref = `${cause.ref}: ${phase} notice`;
	try {
		gh(
			[
				"workflow",
				"run",
				config.workflow,
				"--repo",
				config.repo,
				"-f",
				`issue=${cause.issue}`,
				"-f",
				`mention=${config.mention}`,
				"-f",
				`message=${cause.message(phase)}`,
			],
			{ timeout: TICK_CALL_TIMEOUT_MS },
		);
		log(`${ref} dispatched on #${cause.issue}, try ${tries}`);
	} catch (e) {
		if (!(e instanceof Error) || caught(e).status !== undefined) {
			writeNotice(file, notice);
			if (paged !== null) writeProbePage(paged.file, lastPage);
			log(`${ref} not dispatched, the next tick retries: ${parseErrLine(e)}`);
		} else
			log(`${ref}: gh never exited, so it may have gone: ${parseErrLine(e)}`);
	}
}

/**
 * @param {NoticeStep} step
 * @returns {boolean|null}
 */
function readNoticeSeen({ cause, phase, config, log }) {
	try {
		const { comments } = /** @type {{comments: {body: string}[]}} */ (
			ghJson(
				[
					"issue",
					"view",
					String(cause.issue),
					"--repo",
					config.repo,
					"--json",
					"comments",
				],
				{ timeout: TICK_CALL_TIMEOUT_MS },
			)
		);
		const marker = cause.marker(phase);
		return comments.some((c) => c.body.includes(marker));
	} catch (e) {
		log(`${cause.name}: ${phase} notice unconfirmed: ${parseErrLine(e)}`);
		return null;
	}
}

/** @param {NoticeStep} step */
function isNoticeRunInFlight({ cause, phase, config, log }) {
	try {
		const runs = /** @type {{status: string}[]} */ (
			ghJson(
				[
					"run",
					"list",
					"--workflow",
					config.workflow,
					"--repo",
					config.repo,
					"--json",
					"status",
				],
				{ timeout: TICK_CALL_TIMEOUT_MS },
			)
		);
		return runs.some((r) => r.status !== "completed");
	} catch (e) {
		log(`${cause.name}: ${phase} notice's runs unread: ${parseErrLine(e)}`);
		return true;
	}
}

/**
 * @param {NoticeStep} step
 * @param {NoticePhase} sent
 * @param {"seen"|"lost"} outcome
 * @param {string} line
 */
function settlePhase({ cause, phase, file, log }, sent, outcome, line) {
	writeNotice(file, { ...readNotice(file), [phase]: { ...sent, outcome } });
	log(`${cause.name}: ${phase} notice ${outcome}${line}`);
}

/** @param {NoticeStep} step */
function tendPhase(step) {
	const { cause, file, phase, now } = step;
	const notice = readNotice(file);
	const sent = notice[phase];
	if (sent === null) {
		dispatchNotice(step, notice, 1);
		return;
	}
	if (sent.outcome !== "dispatched") return;
	const seen = readNoticeSeen(step);
	if (seen === true) {
		settlePhase(step, sent, "seen", ` on #${cause.issue}`);
		return;
	}
	if (now - sent.at >= NOTICE_GIVE_UP_MS) {
		settlePhase(step, sent, "lost", ": unread for a day, none further");
		return;
	}
	if (seen === null || now - sent.at < NOTICE_UNSEEN_MS) return;
	if (sent.tries >= NOTICE_MAX_TRIES) {
		settlePhase(
			step,
			sent,
			"lost",
			`: no comment on #${cause.issue} after ${sent.tries} dispatches, none further`,
		);
		return;
	}
	if (!isNoticeRunInFlight(step) && readNoticeSeen(step) === false)
		dispatchNotice(step, notice, sent.tries + 1);
}

/**
 * @param {RepoHold} hold
 * @param {NoticeName} phase
 * @param {{file: string, now: number, log: Log}} at
 */
function noteNoticeUnset(hold, phase, { file, now, log }) {
	const notice = readNotice(file);
	if (!notice.isUnsetLogged)
		log(
			`repo hold ${hold.id} in ${hold.checkout}: no phone notice, as founderNotice is unset in its config`,
		);
	writeNotice(file, {
		...notice,
		isUnsetLogged: true,
		...(phase === "clear"
			? { clear: { at: now, tries: 0, outcome: "lost" } }
			: {}),
	});
}

/**
 * @param {RepoHold} hold
 * @param {string} root
 * @param {{workedAt: number|null, now: number, log: Log}} tick
 */
function tendRaise(hold, root, { workedAt, now, log }) {
	const isDue =
		hold.notice.raise !== null ||
		hold.kind === "probe" ||
		(workedAt !== null && now - workedAt >= NOTICE_NO_WORK_MS);
	if (hold.issue === null || !isDue) return;
	const file = path.join(holdsDir(root), buildNoticeName(hold.id));
	const paged = findPaged(hold, root);
	const config = readNoticeConfig(hold.checkout);
	if (config !== null) {
		if (
			paged === null ||
			hold.notice.raise !== null ||
			!isProbeCoolingDown(hold, paged.file, now, log)
		)
			tendPhase({
				cause: buildHoldCause(hold, hold.issue),
				phase: "raise",
				file,
				config,
				paged,
				now,
				log,
			});
	} else if (!hold.notice.isUnsetLogged)
		noteNoticeUnset(hold, "raise", { file, now, log });
}

/**
 * @param {string} file
 * @param {number} now
 */
const giveUpClear = (file, now) =>
	writeNotice(file, {
		...readNotice(file),
		clear: { at: now, tries: 0, outcome: "lost" },
	});

/**
 * @param {LiftedHold} lifted
 * @param {{now: number, log: Log}} tick
 */
function tendClear(lifted, { now, log }) {
	if (!lifted.isClearNoticeOwed) return;
	const file = path.join(lifted.dir, buildNoticeName(lifted.id));
	const hold = readLiftedRecord(lifted);
	if (hold === null) {
		giveUpClear(file, now);
		log(
			`repo hold ${lifted.id}: clear notice lost: its lifted record will not read`,
		);
		return;
	}
	if (hold.issue === null) {
		giveUpClear(file, now);
		log(`repo hold ${lifted.id}: clear notice lost: its record names no issue`);
		return;
	}
	const config = readNoticeConfig(hold.checkout);
	if (config === null) noteNoticeUnset(hold, "clear", { file, now, log });
	else
		tendPhase({
			cause: buildHoldCause(hold, hold.issue),
			phase: "clear",
			file,
			config,
			paged: findPaged(hold, lifted.root),
			now,
			log,
		});
}

/**
 * @param {string[]} roots
 * @param {Parameters<typeof tendLastWorked>[0]} seen
 * @param {number} now
 * @param {Log} log
 */
function tendHoldNotices(roots, seen, now, log) {
	const workedAt = tendLastWorked(seen, now, log);
	/** @param {string} id @param {() => void} act */
	const guarded = (id, act) => {
		try {
			act();
		} catch (err) {
			log(`repo hold ${id}: notice not tended: ${caught(err).message}`);
		}
	};
	for (const root of readStoreRoots(roots))
		for (const hold of readHolds(root).holds)
			guarded(hold.id, () => tendRaise(hold, root, { workedAt, now, log }));
	for (const lifted of readLiftedHolds(roots, log))
		guarded(lifted.id, () => tendClear(lifted, { now, log }));
}

module.exports = {
	buildNoticeBody,
	readNoticeConfig,
	tendHoldNotices,
	tendPhase,
};
