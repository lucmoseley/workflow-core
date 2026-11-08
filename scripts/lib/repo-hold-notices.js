/*
 * repo-hold-notices.js — a repo hold's phone notice (#3871, spec #3597). The hold and
 * its notice state are lib/repo-holds.js's; lib/refill-tick.js runs tendHoldNotices
 * each tick.
 *
 * It goes out when a `probe` hold exists, or any hold is open while no slot has worked
 * for NOTICE_NO_WORK_MS: one `gh workflow run` on `founderNotice`'s workflow on the
 * raise, and one on the clear only where a raise went. The founder holds this to one
 * page a cause (#3871's comment of 3 Nov). A no-progress pause joins it by his ruling
 * (#4200): lib/pause-notices.js sends its pair through tendPhase.
 *
 * SENT MEANS THE BOT'S COMMENT SEEN ON THE ISSUE: an accepted dispatch can still lose
 * its run. A comment unseen for
 * NOTICE_UNSEEN_MS, with no run of the workflow in flight, earns one more dispatch,
 * then the phase reads lost. Each dispatch is recorded before it runs, so a store that
 * will not write sends nothing rather than a page each tick. Only a `gh` that exited
 * with a status rolls that back for the next tick's retry: one that never exited may
 * have been taken, so it waits on the comment like any other.
 *
 * RESIDUAL: a `gh` exiting non-zero after GitHub took the dispatch retries as refused,
 * and a run that starts between the last read and a second dispatch is not seen; each
 * can page twice.
 *
 * RESIDUAL: a checkout whose config sets no `founderNotice` sends nothing, and here
 * only workflow-core sets it.
 *
 * A PROBE HOLD THAT LIFTS AND COMES BACK is a new hold, as is one raised over a torn
 * record, so the checkout keeps when its probe hold last paged, and a new one's raise
 * waits out PROBE_COOL_DOWN_MS from that page before it goes, if the hold still
 * stands (#4148).
 */

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
 *
 * @typedef {object} NoticeCause  what a notice is about: a hold, or a pause
 * @property {string} name  how the log names it
 * @property {string} ref  its name with its place, for a dispatch's log line
 * @property {number} issue  the issue to comment on
 * @property {(phase: NoticeName) => string} marker  identifies its comment
 * @property {(phase: NoticeName) => string} message  the comment, marker included
 *
 * @typedef {object} NoticeStep
 * @property {NoticeCause} cause
 * @property {NoticeName} phase
 * @property {string} file  the cause's notice file
 * @property {import("./workflow-core-config.js").FounderNotice} config
 * @property {{file: string, raisedAt: number}|null} paged  a probe hold's
 *   checkout's buildProbePagedFile, with the hold's raise
 * @property {number} now
 * @property {Log} log
 *
 * @typedef {{raisedAt: number|null, at: number}} ProbePage  the hold that paged,
 *   null where unknown
 */

/* From spec #3597, which marks it untraced. */
const NOTICE_NO_WORK_MS = 30 * 60_000;

/* A guess: the test runs on #3869 commented within 10 s of their dispatch, so this
 * is a run lost or badly late. */
const NOTICE_UNSEEN_MS = 15 * 60_000;

/* A guess: the loop's own run window, past which a `gh` that still will not read
 * (a deleted issue, say) is no outage, and a lifted record must not wait on it. */
const NOTICE_GIVE_UP_MS = 24 * 60 * 60_000;

/* Under the shortest gap between two outages in the loop's log, about 7 h (#4148);
 * where it sits under the gap is a guess. */
const PROBE_COOL_DOWN_MS = 6 * 60 * 60_000;

/* The founder's limit is one page a cause, so one more try and no further. */
const NOTICE_MAX_TRIES = 2;

/* Untraced, as lib/repo-holds.js's clear check is: each call runs inside a tick. */
const NOTICE_GH_TIMEOUT_MS = 30_000;

/* A zero-width space after the `@`, which GitHub then reads as no mention. */
const BROKEN_MENTION = "@​";

/**
 * When a slot last worked, kept for the next tick; null where nothing read, as that
 * says nothing either way. A paused loop's slots are quiet by intent, and a loop that
 * has not ticked for the window has not seen them go quiet, so each starts the count
 * again. A store that will not read or write reads as working now, so a fault pages
 * nobody.
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
 * The stored time a slot last worked, or null where there is none to trust. A torn
 * record, logged, begins the count anew, the caller's write mending it.
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

/**
 * The checkout's notice configuration, or null where it is unset. The reader warns
 * of a malformed value, which reads as unset.
 * @param {string} root
 */
const readNoticeConfig = (root) =>
	readConfig({ root, quiet: true }).founderNotice ?? null;

/**
 * What identifies this hold's notice among the issue's comments. `raisedAt`, as a
 * probe hold's fixed id comes back on the same issue.
 * @param {RepoHold} hold
 * @param {NoticeName} phase
 */
const buildNoticeMarker = (hold, phase) =>
	`repo-hold-notice ${hold.id} ${hold.raisedAt} ${phase}`;

/**
 * What the phone shows, with the marker out of sight. A mention in the text would
 * page whoever it names, so it is broken.
 * @param {string} text
 * @param {string} marker
 */
const buildNoticeBody = (text, marker) =>
	`${text.replaceAll("@", BROKEN_MENTION)}\n\n<!-- ${marker} -->`;

/**
 * A hold as its notice's cause.
 * @param {RepoHold & {issue: number}} hold
 * @returns {NoticeCause}
 */
const buildHoldCause = (hold) => ({
	name: `repo hold ${hold.id}`,
	ref: `repo hold ${hold.id} in ${hold.checkout}`,
	issue: hold.issue,
	marker: (phase) => buildNoticeMarker(hold, phase),
	message: (phase) =>
		buildNoticeBody(
			`Repo hold in ${path.basename(hold.checkout)} ${
				phase === "raise" ? "has halted work" : "has cleared"
			}: ${hold.act}`,
			buildNoticeMarker(hold, phase),
		),
});

/**
 * The checkout's last probe page, or null where there is none. A torn record, logged,
 * reads as none, as a hold that stops launches unannounced for the window is the
 * worse fault (#4148).
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
 * Record a probe page, or remove the record where `page` is null.
 * @param {string} file
 * @param {ProbePage|null} page
 */
const writeProbePage = (file, page) =>
	page === null
		? fs.rmSync(file, { force: true })
		: writeFileAtomic(file, JSON.stringify(page), { mkdir: true });

/**
 * @param {RepoHold} hold
 * @param {string} root  its store's
 * @returns {NoticeStep["paged"]}
 */
const findPaged = (hold, root) =>
	hold.kind === "probe"
		? { file: buildProbePagedFile(root), raisedAt: hold.raisedAt }
		: null;

/**
 * Whether this probe hold's raise waits out the cool-down: another hold of the
 * checkout paged inside it.
 * @param {RepoHold} hold
 * @param {string} file  buildProbePagedFile's
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
 * Dispatch this phase's notice, recorded first, with a probe hold's page; a refusal
 * takes both back.
 * @param {NoticeStep} step
 * @param {HoldNotice} notice  as it stands
 * @param {number} tries  including this one
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
			{ timeout: NOTICE_GH_TIMEOUT_MS },
		);
		log(`${ref} dispatched on #${cause.issue}, try ${tries}`);
	} catch (e) {
		if (typeof (/** @type {{status?: unknown}} */ (e).status) === "number") {
			writeNotice(file, notice);
			if (paged !== null) writeProbePage(paged.file, lastPage);
			log(`${ref} not dispatched, the next tick retries: ${parseErrLine(e)}`);
		} else
			log(`${ref}: gh never exited, so it may have gone: ${parseErrLine(e)}`);
	}
}

/**
 * Whether the issue carries this phase's comment; null, logged, where it will not
 * read, for the next tick to read again.
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
				{ timeout: NOTICE_GH_TIMEOUT_MS },
			)
		);
		const marker = cause.marker(phase);
		return comments.some((c) => c.body.includes(marker));
	} catch (e) {
		log(`${cause.name}: ${phase} notice unconfirmed: ${parseErrLine(e)}`);
		return null;
	}
}

/**
 * Whether a run of the notice workflow is queued or going, so that a late comment
 * may yet land; true where that will not read, as a second page is the worse fault.
 * @param {NoticeStep} step
 */
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
				{ timeout: NOTICE_GH_TIMEOUT_MS },
			)
		);
		return runs.some((r) => r.status !== "completed");
	} catch (e) {
		log(`${cause.name}: ${phase} notice's runs unread: ${parseErrLine(e)}`);
		return true;
	}
}

/**
 * Close this phase with `outcome`, logged.
 * @param {NoticeStep} step
 * @param {NoticePhase} sent
 * @param {"seen"|"lost"} outcome
 * @param {string} line
 */
function settlePhase({ cause, phase, file, log }, sent, outcome, line) {
	writeNotice(file, { ...readNotice(file), [phase]: { ...sent, outcome } });
	log(`${cause.name}: ${phase} notice ${outcome}${line}`);
}

/**
 * One phase's next act: its first dispatch, else its check on the last.
 * @param {NoticeStep} step
 */
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
	/* Read again, as a run that finished after the read above reads as not in flight. */
	if (!isNoticeRunInFlight(step) && readNoticeSeen(step) === false)
		dispatchNotice(step, notice, sent.tries + 1);
}

/**
 * Log, once a hold, that its notice is off. A clear with nowhere to go is done, or
 * its record would wait on configuration for good.
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
 * An open hold's raise notice. An issue must stand first: a probe hold whose filing
 * has yet to land retries with it.
 * @param {RepoHold} hold
 * @param {string} root  its store's
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
				cause: buildHoldCause({ ...hold, issue: hold.issue }),
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
 * A lifted hold's clear notice, where one is owed. A record torn since cannot name
 * its issue, so its clear is given up, logged.
 * @param {LiftedHold} lifted
 * @param {{now: number, log: Log}} tick
 */
function tendClear(lifted, { now, log }) {
	if (!lifted.isClearNoticeOwed) return;
	const file = path.join(lifted.dir, buildNoticeName(lifted.id));
	const hold = readLiftedRecord(lifted);
	if (hold === null) {
		writeNotice(file, {
			...readNotice(file),
			clear: { at: now, tries: 0, outcome: "lost" },
		});
		log(
			`repo hold ${lifted.id}: clear notice lost: its lifted record will not read`,
		);
		return;
	}
	const config = readNoticeConfig(hold.checkout);
	if (config === null) noteNoticeUnset(hold, "clear", { file, now, log });
	else if (hold.issue !== null)
		tendPhase({
			cause: buildHoldCause({ ...hold, issue: hold.issue }),
			phase: "clear",
			file,
			config,
			paged: findPaged(hold, lifted.root),
			now,
			log,
		});
}

/**
 * One tick's phone notices, off the holds as tendHolds left them, so a clear goes the
 * tick its hold lifts. Any throw is logged and costs that hold alone its tick, never
 * the launches.
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
