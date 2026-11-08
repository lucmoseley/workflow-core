/*
 * repo-holds.js — the repo hold's record and lifecycle (#3857, spec #3597): a
 * per-checkout record that one founder-only act blocks shared state.
 * scripts/repo-hold.js is its CLI; lib/refill-tick.js runs tendHolds each
 * tick. It is the adapter behind that tick's I/O (#3857's "behind the loop's
 * port"), so it holds fs, gh and the clear checks' runs together, tested through
 * the real tick and the CLI as that ticket asks, with no core split out.
 *
 * THE STORE is one file a hold, under the loop's machine-wide directory
 * (lib/refill-dir.js), in a directory keyed on git's common dir. So every
 * worktree of a checkout and the loop read one store, a raise overwrites no
 * other hold, and lib/scratch-sweep.js, which reaps `.claude/tmp/`, cannot age
 * out a hold the founder has yet to answer. Where git will not name the common
 * dir, a linked worktree keys on the one its `.git` file points at (#4402).
 * RESIDUAL: a `.git` file that points nowhere keys on its own path, so its
 * holds split from the checkout's until it is repaired.
 *
 * A LIFT IS A RENAME out of the open store, under `lifted/`, so a tick and a hand
 * lift racing get one winner and one log line, and the sessions parked on the hold
 * outlast it, however it ended, until the tick's resume step has taken each up
 * (#3863). Each lift has a directory of its own, as a fixed id can be lifted twice.
 *
 * THE PROBE (#3860): each tick, each served checkout's shared `.git` must fetch
 * origin and resolve `main`. A checkout that fails holds the one `probe` hold
 * its store can hold, under a fixed id, so a raise never makes a second and a
 * torn one is written over. The failing roots are also returned to the tick, which stops launches on them even
 * where no record could be written (#3860). A ref git says will not resolve
 * raises the hold on its tick. A failed fetch, or a git that never answered, is
 * an outage: it reads the same as a network blip or a failed fork, so it stops
 * launches on its tick and raises the hold only once it has lasted
 * OUTAGE_HOLD_AFTER_MS, on a file of its own beside the holds (#3899). A probe
 * hold's issue is filed once its record stands, and the filing retried each tick;
 * a hand lift of one still failing is raised anew, with a new issue, on the next
 * tick, unless it now fails as an outage younger than the window.
 *
 * THE GUARD-LOAD PROBE (#4226): a self-plugin host's sessions run the guard hook
 * line its `self-plugin/hooks/hooks.json` registers, so the probe also runs that
 * line on a benign `Read`, as a session would, whatever code it runs. A failure is run once more after
 * GUARD_PROBE_RETRY_MS; a second raises the hold on its tick, with no outage
 * window. While it stands, each loop session that parks there is attached to it
 * (attachProbeParks). An adopter loads its guards from its pinned plugin
 * release, so runs no step.
 *
 * A LOCKED-OUT SESSION (#4228), one every call of which its guards refused for
 * want of a guard that could judge it, raises the probe hold where none stands
 * and attaches to it (holdLockedOut). Its first refused call is kept in a
 * replay file beside the hold, written before the hold's issue files, and the
 * hold's clear check replays each kept call through the hook line beside the
 * benign `Read`, so a fault that `Read` does not touch keeps the hold.
 *
 * RESIDUAL: during an outage's window launches are withheld with no hold to show
 * for it, so `status` reads no hold open, only the log says why, and no notice is
 * sent. A hold rises on the first tick past the window, so a tick's gap later.
 *
 * RESIDUAL: a close that fails on a clear is logged and not retried, there being
 * no hold left to retry it from. The issue's body says what to do, and the fetch
 * that just passed makes `gh` likely to answer.
 *
 * AN ATTACH IS A FILE OF ITS OWN beside the hold's (#3858), never a rewrite of
 * it: a rewrite could resurrect a hold a lift has just unlinked, or lose a
 * neighbour's attach. Its order against removeHold's leaves no stray: an attach
 * writes, then reads the hold; a lift renames the hold, then moves the attach
 * files after it. So either the lift's list finds the file or the attach's read
 * finds no hold and takes its file back. A lift gathers these in a directory
 * beside the store's holds and renames it under `lifted/` whole, so a tick reads
 * only finished lifts. RESIDUAL: a lift that dies part-way leaves its directory
 * there unread, its sessions stranded on the `parked` label as any other park.
 *
 * A HOLD'S NOTICE STATE (#3871; lib/repo-hold-notices.js sends) is a file of its own
 * beside the hold's, as an attach is and for the same reason, and goes under
 * `lifted/` with it, the record outliving the lift until the clear notice is done.
 * When a checkout's probe hold last paged is a file beside its holds that no raise
 * or lift touches, as a probe hold that comes back is a new hold (#4148).
 */

const { AsyncLocalStorage } = require("node:async_hooks");
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomBytes } = require("node:crypto");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { isLockoutText } = require("./core-fault.js");
const { readText } = require("./file-read.js");
const { parseFirstLine } = require("./first-line.js");
const { readCommit } = require("./commit-sha.js");
const { spawnChild } = require("./child-spawn.js");
const { deref } = require("./deref.js");
const { gitFileCommonDir } = require("./git-file.js");
const { fileThrough } = require("./file-through.js");
const { findFiledLine } = require("./filed-line.js");
const { gh, ghJson, parseErrLine } = require("./gh.js");
const { gitCommonDir, gitOutcome, gitReader } = require("./git.js");
const { hostRoot } = require("./host-root.js");
const { parseJobDir } = require("./job-paths.js");
const { mainCheckout } = require("./main-checkout.js");
const { FETCH_TIMEOUT_MS } = require("./pinned-code.js");
const { refillPath } = require("./refill-dir.js");
const { buildCheckoutEnv } = require("./refill-repos.js");
const { sleepSync } = require("./sleep-sync.js");
const {
	KILLED_EXIT,
	RUN_BUDGETED,
	TIMEOUT_EXIT,
} = require("./run-budgeted.js");
const { takesLabel } = require("./takes-label.js");
const { resolveKey } = require("./workflow-core-config.js");

/**
 * @typedef {{command: string} | {issueClosed: number} | {probe: true}} ClearCheck
 *
 * @typedef {object} RepoHold
 * @property {string} id
 * @property {string} checkout  the main checkout's root
 * @property {"probe"|"park"} kind  a `probe` hold alone stops launches
 * @property {string} act  the founder act, in plain words
 * @property {number|null} issue  the issue holding the question, null on a
 *   probe hold whose filing has yet to land
 * @property {ClearCheck} clearCheck
 * @property {number} raisedAt
 * @property {string[]} sessions  the job ids of the sessions parked on it: the
 *   raiser's in the record, each attached session's in its own file
 * @property {HoldNotice} notice  off its own file
 *
 * @typedef {object} NoticePhase
 * @property {number} at  when its last dispatch went
 * @property {number} tries  its dispatches
 * @property {"dispatched"|"seen"|"lost"} outcome
 *
 * @typedef {object} HoldNotice
 * @property {NoticePhase|null} raise
 * @property {NoticePhase|null} clear
 * @property {boolean} isUnsetLogged  the log has said the notice is unconfigured
 *
 * @typedef {(line: string) => void} Log
 *
 * @typedef {object} LiftedHold
 * @property {string} root
 * @property {string} dir  its directory under `lifted/`
 * @property {string} id
 * @property {string[]} recordJobs  the job ids its record names
 * @property {string[]} jobs  those and its attach files', the sessions parked on it
 * @property {boolean} isClearNoticeOwed  a raise notice went and its clear is not done
 *
 * @typedef {{text: string, isOutage: boolean}} ProbeFailure
 * @typedef {import("./block-cause.js").RefusedCall} RefusedCall
 */

/* Untraced: the budget of one call a tick makes for a hold or its notice, a clear
 * check's command, which may run a slow `git fetch`, and each `gh` the holds and
 * lib/repo-hold-notices.js run, each of which must not hold the tick for long. */
const TICK_CALL_TIMEOUT_MS = 30_000;

/* How long the runner waits after its TERM before its KILL; a guess, as
 * lib/gate-check.js's is. */
const CLEAR_CHECK_KILL_AFTER_MS = 5000;

/* The runner itself ends by the budget plus one KILL_AFTER; a second is headroom for
 * its own start and reap, a guess, past which the runner is the one wedged. */
const CLEAR_CHECK_SPAWN_TIMEOUT_MS =
	TICK_CALL_TIMEOUT_MS + 2 * CLEAR_CHECK_KILL_AFTER_MS;

/* A guess: few holds open at once, and short enough to type at `lift`. A
 * repeat would overwrite the hold it repeats. */
const ID_BYTES = 3;

const PROBE_ID = "probe";

const LIFTED_DIR = "lifted";

const HOLD_FILE_REMEDY = "lift its id or remove the file";

const LIFTING_PREFIX = "lifting-";

/* How long an outage lasts before it raises a hold, and how long it may go unseen
 * by any tick and still be one outage. Past the longest in the loop's log, about 7
 * minutes across two ticks on 29 Oct 2026 (#3899); the margin, about double, is a
 * guess. */
const OUTAGE_HOLD_AFTER_MS = 15 * 60_000;

/** @type {HoldNotice} */
const NO_NOTICE = { raise: null, clear: null, isUnsetLogged: false };

/* A file that will not read cannot say what went, so it sends nothing and owes no
 * clear: a page the founder has had already is the worse fault (#3871). */
/** @type {NoticePhase} */
const UNREAD_PHASE = { at: 0, tries: 0, outcome: "lost" };

/** @type {HoldNotice} */
const UNREAD_NOTICE = {
	raise: UNREAD_PHASE,
	clear: UNREAD_PHASE,
	isUnsetLogged: true,
};

const ID_PATTERN = new RegExp(`^(?:[0-9a-f]+|${PROBE_ID})$`);

/* A job id, as a file name's tail: no dot, so an attach file never reads as a
 * hold's `.json`. */
const JOB_PATTERN = /^[0-9A-Za-z_-]+$/;

const PROBE_FILED_WHY =
	"a probe hold is raised by the refill loop, with no asking session to hold its question (#3860)";

/* A guess: 48 bits of the key's hash, in a directory holding a few checkouts. */
const STORE_KEY_LENGTH = 12;

/* Untraced: under the hook's own 60 s, and about 200 times a healthy run's
 * 0.05 s, measured on this repo's tree. */
const GUARD_PROBE_TIMEOUT_MS = 10_000;

/* Untraced: long enough for a write in progress to land. */
const GUARD_PROBE_RETRY_MS = 2000;

/**
 * The wait, ms, before the guard-load probe's re-run: `WFC_GUARD_PROBE_RETRY_MS`,
 * which a sandboxed tick sets to 0 (#4282), else GUARD_PROBE_RETRY_MS. Unset,
 * empty, negative or unreadable is the default, as a NaN would never wake
 * sleepSync.
 */
function guardProbeRetryMs() {
	const ms = Number(
		process.env.WFC_GUARD_PROBE_RETRY_MS || GUARD_PROBE_RETRY_MS,
	);
	return Number.isNaN(ms) || ms < 0 ? GUARD_PROBE_RETRY_MS : ms;
}

/* The probe's own, so it leaves no latch on a real session. */
const GUARD_PROBE_SESSION = "refill-loop-guard-probe";

/* The probe's `Read` names it, as it is tracked wherever the step runs, and
 * the step runs the guard hook line it registers. */
const SELF_PLUGIN_HOOKS = path.join("self-plugin", "hooks", "hooks.json");

/* What a lockout's hold asks repaired. */
const LOCKOUT_REPAIR = "the guard code the hook line runs, as its refusal says";

/* The entry the guard hook line runs, whatever runs it. */
const GUARD_ENTRY = "guard-dispatch.js";

/**
 * The checkout a command run from `cwd` holds holds in.
 * @param {string} cwd
 */
const readCheckout = (cwd) => mainCheckout(cwd) ?? cwd;

/** @type {AsyncLocalStorage<Map<string, string>>} */
const tickStores = new AsyncLocalStorage();

/**
 * The checkout's store: named for a reader, and hashed because two paths can
 * flatten to one name. A broken `.git` that git will not name keys on the
 * common dir it points at, or else on its own path, as a probe hold raised on
 * one must be found once it is repaired (#4402).
 * @param {string} root
 */
function holdsDir(root) {
	const stores = tickStores.getStore();
	const known = stores?.get(root);
	if (known !== undefined) return known;
	const common =
		gitCommonDir(root) ?? gitFileCommonDir(root) ?? path.join(root, ".git");
	const key = deref(common);
	const hash = createHash("sha256").update(key).digest("hex");
	const dir = refillPath(
		path.join(
			"repo-holds",
			`${path.basename(root)}-${hash.slice(0, STORE_KEY_LENGTH)}`,
		),
	);
	stores?.set(root, dir);
	return dir;
}

/**
 * Run `fn` with each checkout's store resolved once, so a tick's many hold
 * calls fork git for each checkout's common dir once (#4398). A `.git` git will
 * not name keys on its path for the rest of the tick, so one tick's calls all
 * read one store; its repair keys anew on the next tick (#4609).
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
const withTickStores = (fn) => tickStores.run(new Map(), fn);

/**
 * @param {string} id
 */
const buildHoldFileName = (id) => `${id}.json`;

/**
 * A lift's directory name, off the hold's id; parseLiftedId reads the id back.
 * @param {string} id
 */
const buildLiftedName = (id) =>
	`${id}-${randomBytes(ID_BYTES).toString("hex")}`;

/**
 * @param {string} name  buildLiftedName's
 */
const parseLiftedId = (name) => name.slice(0, name.lastIndexOf("-"));

/**
 * @param {string} root
 * @param {string} id
 */
const holdFile = (root, id) => path.join(holdsDir(root), buildHoldFileName(id));

/**
 * What an attach file's name starts with.
 * @param {string} id
 */
const buildAttachPrefix = (id) => `${id}.attached.`;

/**
 * @param {string} id
 */
const buildReplayPrefix = (id) => `${id}.replay.`;

/**
 * Remove open hold `id`'s replay files from `dir`, its store.
 * @param {string} dir
 * @param {string} id
 */
function removeReplays(dir, id) {
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (err) {
		if (caught(err).code === "ENOENT") return;
		throw err;
	}
	for (const name of parseReplayNames(names, id))
		fs.rmSync(path.join(dir, name), { force: true });
}

/**
 * Hold `id`'s replay files, off the store's listing.
 * @param {string[]} names  the store's file names
 * @param {string} id
 */
const parseReplayNames = (names, id) =>
	names.filter((n) => n.startsWith(buildReplayPrefix(id)));

/**
 * The job ids attached to hold `id`, off the store's listing.
 * @param {string[]} names  the store's file names
 * @param {string} id
 */
const parseAttachedJobs = (names, id) =>
	names
		.filter((n) => n.startsWith(buildAttachPrefix(id)))
		.map((n) => n.slice(buildAttachPrefix(id).length));

/**
 * A hold's notice file's name; no `.json`, so it never reads as a hold.
 * @param {string} id
 */
const buildNoticeName = (id) => `${id}.notice`;

/**
 * The file naming when `root`'s probe hold last paged; neither a hold's name nor an
 * attach's.
 * @param {string} root
 */
const buildProbePagedFile = (root) =>
	path.join(holdsDir(root), `${PROBE_ID}.paged`);

/** @param {unknown} value */
const isNoticePhase = (value) => {
	const phase = /** @type {Partial<NoticePhase>|null} */ (value);
	return (
		value === null ||
		(typeof phase?.at === "number" &&
			typeof phase.tries === "number" &&
			["dispatched", "seen", "lost"].includes(phase.outcome ?? ""))
	);
};

/**
 * The notice state in `file`: none where it is gone, UNREAD_NOTICE where it will not
 * read, which readHolds reports.
 * @param {string} file
 * @returns {HoldNotice}
 */
function readNotice(file) {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		return isNoticePhase(value?.raise) &&
			isNoticePhase(value?.clear) &&
			typeof value?.isUnsetLogged === "boolean"
			? value
			: UNREAD_NOTICE;
	} catch (err) {
		return caught(err).code === "ENOENT" ? NO_NOTICE : UNREAD_NOTICE;
	}
}

/**
 * @param {string} file
 * @param {HoldNotice} notice
 */
const writeNotice = (file, notice) =>
	writeFileAtomic(file, JSON.stringify(notice), { mkdir: true });

/**
 * Whether `value` is a hold, and the one its file is named for: an id off the
 * pattern would make a path out of the store.
 * @param {unknown} value
 * @param {string} name  the file's name
 * @returns {value is RepoHold}
 */
function isHold(value, name) {
	const hold = /** @type {Partial<RepoHold>|null} */ (value);
	const check =
		/** @type {Partial<{command: unknown, issueClosed: unknown, probe: unknown}>} */ (
			hold?.clearCheck ?? {}
		);
	return (
		typeof hold?.id === "string" &&
		ID_PATTERN.test(hold.id) &&
		name === `${hold.id}.json` &&
		typeof hold.checkout === "string" &&
		(hold.kind === "probe" || hold.kind === "park") &&
		typeof hold.act === "string" &&
		(typeof hold.issue === "number" ||
			(hold.kind === "probe" && hold.issue === null)) &&
		typeof hold.raisedAt === "number" &&
		Array.isArray(hold.sessions) &&
		(typeof check.command === "string" ||
			typeof check.issueClosed === "number" ||
			(hold.kind === "probe" && check.probe === true))
	);
}

/**
 * The checkout's open holds, oldest first, and why any of them would not read,
 * each line ending on what clears it.
 * @param {string} root
 * @returns {{holds: RepoHold[], unread: string[]}}
 */
function readHolds(root) {
	const dir = holdsDir(root);
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch (err) {
		const { code, message } = caught(err);
		return code === "ENOENT"
			? { holds: [], unread: [] }
			: {
					holds: [],
					unread: [
						`${dir}: ${message}; repair the directory, as no hold in it reads`,
					],
				};
	}
	/** @type {RepoHold[]} */
	const holds = [];
	/** @type {string[]} */
	const unread = [];
	for (const name of names.filter((n) => n.endsWith(".json"))) {
		const file = path.join(dir, name);
		try {
			/* Null: lifted between the listing and this read. */
			const read = readHoldFile(file, name);
			if (read === null) continue;
			if ("torn" in read) {
				unread.push(`${file}: ${read.torn}; ${HOLD_FILE_REMEDY}`);
				continue;
			}
			const { hold } = read;
			const noticeFile = path.join(dir, buildNoticeName(hold.id));
			const notice = readNotice(noticeFile);
			if (notice === UNREAD_NOTICE)
				unread.push(
					`${noticeFile}: not its notice state, so it sends none; remove the file`,
				);
			holds.push({
				...hold,
				notice,
				sessions: [
					...new Set([...hold.sessions, ...parseAttachedJobs(names, hold.id)]),
				],
			});
		} catch (err) {
			unread.push(`${file}: ${caught(err).message}; ${HOLD_FILE_REMEDY}`);
		}
	}
	return { holds: holds.sort((a, b) => a.raisedAt - b.raisedAt), unread };
}

/**
 * The hold a record file holds; `{torn}`, why, where it will not parse or is no hold;
 * null where the file is gone. Any other failure throws. Its notice is not read.
 * @param {string} file
 * @param {string} name  the file's name, which the hold's id must match
 * @returns {{hold: RepoHold}|{torn: string}|null}
 */
function readHoldFile(file, name) {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8"));
		return isHold(value, name) ? { hold: value } : { torn: "not a hold" };
	} catch (err) {
		if (err instanceof SyntaxError) return { torn: err.message };
		if (caught(err).code === "ENOENT") return null;
		throw err;
	}
}

/** @param {ClearCheck} check */
function buildCheckText(check) {
	if ("probe" in check) return "the shared .git probe";
	return "command" in check
		? `command: ${check.command.replace(/\s+/g, " ").trim()}`
		: `issue #${check.issueClosed} closed`;
}

/** @param {RepoHold} hold */
const buildHoldRef = (hold) => `${hold.id} in ${hold.checkout}: ${hold.act}`;

/** @param {RepoHold} hold */
const buildIssueText = (hold) =>
	hold.issue === null ? "no issue filed yet" : `issue #${hold.issue}`;

/**
 * @param {string} root
 * @param {Omit<RepoHold, "notice"> & {notice?: HoldNotice}} hold
 */
const writeHold = (root, { notice: _, ...record }) =>
	writeFileAtomic(
		holdFile(root, record.id),
		`${JSON.stringify(record, null, "\t")}\n`,
		{ mkdir: true },
	);

/**
 * Record a new hold and return it.
 * @param {string} root
 * @param {{id?: string, kind: RepoHold["kind"], act: string,
 *   issue: number|null, clearCheck: ClearCheck, session: string|null,
 *   now: number}} raised  `id`, a fixed one in place of a fresh one
 * @returns {RepoHold}
 */
function raiseHold(
	root,
	{
		id = randomBytes(ID_BYTES).toString("hex"),
		kind,
		act,
		issue,
		clearCheck,
		session,
		now,
	},
) {
	/* A lift that raced a notice's or a replay's write can leave one behind, for
	 * a fixed id. */
	fs.rmSync(path.join(holdsDir(root), buildNoticeName(id)), { force: true });
	removeReplays(holdsDir(root), id);
	/** @type {Omit<RepoHold, "notice">} */
	const record = {
		id,
		checkout: root,
		kind,
		/* One line, as the log and status print it. */
		act: act.replace(/\s+/g, " ").trim(),
		issue,
		clearCheck,
		raisedAt: now,
		sessions: session === null ? [] : [session],
	};
	writeHold(root, record);
	return { ...record, notice: NO_NOTICE };
}

/** @param {RepoHold} hold */
const buildRaisedLine = (hold) =>
	`repo hold raised: ${buildHoldRef(hold)}; ${buildIssueText(hold)}; clears on ${buildCheckText(hold.clearCheck)}`;

/**
 * Attach job `job` to open hold `id`, however often it asks: the hold as it now
 * reads and whether this call attached it, or null where no hold is open under
 * that id. A hold with no issue yet comes back with no attach made, as a park
 * would have none to name.
 * @param {string} root
 * @param {string} id
 * @param {string} job
 * @returns {{hold: RepoHold, isNew: boolean}|null}
 */
function attachHold(root, id, job) {
	if (!ID_PATTERN.test(id)) return null;
	if (!JOB_PATTERN.test(job)) throw new Error(`not a job id: ${job}`);
	const file = path.join(holdsDir(root), `${buildAttachPrefix(id)}${job}`);
	let isNew = true;
	try {
		fs.writeFileSync(file, "", { flag: "wx" });
	} catch (err) {
		const { code } = caught(err);
		/* ENOENT: no store, so no hold. */
		if (code === "ENOENT") return null;
		if (code !== "EEXIST") throw err;
		isNew = false;
	}
	const hold = readHolds(root).holds.find((h) => h.id === id);
	if (hold?.issue !== null) {
		if (hold) return { hold, isNew };
		fs.rmSync(file, { force: true });
		return null;
	}
	fs.rmSync(file, { force: true });
	return { hold, isNew: false };
}

/**
 * @param {RepoHold} hold
 * @param {string} job
 */
const buildAttachedLine = (hold, job) =>
	`repo hold attached: ${buildHoldRef(hold)}; session ${job}; ${hold.sessions.length} attached`;

/**
 * The open hold this background job attached to that `text` names: `hold <id>`
 * and that hold's `#issue`, the attached park's status line (#3858). A raiser is
 * not attached: it parks on its round. Null where it names none, or this is no
 * background job.
 * @param {string} text
 * @returns {RepoHold|null}
 */
function findOwnHold(text) {
	const job = parseJobDir(process.env.CLAUDE_JOB_DIR)?.jobId;
	if (!job) return null;
	const root = readCheckout(hostRoot());
	return (
		readHolds(root).holds.find(
			(h) =>
				fs.existsSync(
					path.join(holdsDir(root), `${buildAttachPrefix(h.id)}${job}`),
				) &&
				new RegExp(`\\bhold ${h.id}\\b`).test(text) &&
				new RegExp(`#${h.issue}\\b`).test(text),
		) ?? null
	);
}

/**
 * End a hold, moving it and its attach files under `lifted/`; false where it was
 * already gone.
 * @param {string} root
 * @param {string} id
 */
function removeHold(root, id) {
	const dir = holdsDir(root);
	const name = buildLiftedName(id);
	const lifting = path.join(dir, `${LIFTING_PREFIX}${name}`);
	fs.mkdirSync(lifting, { recursive: true });
	try {
		fs.renameSync(
			holdFile(root, id),
			path.join(lifting, buildHoldFileName(id)),
		);
	} catch (err) {
		fs.rmdirSync(lifting);
		if (caught(err).code === "ENOENT") return false;
		throw err;
	}
	const beside = [
		buildNoticeName(id),
		...parseAttachedJobs(fs.readdirSync(dir), id).map(
			(job) => `${buildAttachPrefix(id)}${job}`,
		),
	];
	for (const file of beside) {
		try {
			fs.renameSync(path.join(dir, file), path.join(lifting, file));
		} catch (err) {
			/* No notice yet, or the attach took its file back (#3858). */
			if (caught(err).code !== "ENOENT") throw err;
		}
	}
	removeReplays(dir, id);
	fs.mkdirSync(path.join(dir, LIFTED_DIR), { recursive: true });
	fs.renameSync(lifting, path.join(dir, LIFTED_DIR, name));
	return true;
}

/**
 * The job ids a lifted hold's record names: none where it is gone or torn, as a
 * damaged record lifts too (#3857), its attach files still naming theirs; null,
 * logged, where it will not read, for a later tick to read again (#3863).
 * @param {string} file
 * @param {Log} log
 * @returns {string[]|null}
 */
function readLiftedRecordJobs(file, log) {
	try {
		const { sessions } = JSON.parse(fs.readFileSync(file, "utf8"));
		return Array.isArray(sessions)
			? sessions.filter((s) => typeof s === "string")
			: [];
	} catch (err) {
		if (caught(err).code === "ENOENT") return [];
		log(`lifted repo hold unread: ${file}: ${caught(err).message}`);
		return err instanceof SyntaxError ? [] : null;
	}
}

/**
 * The names in `dir`: none where it is gone, or is no directory, as an open store
 * then logs; none, logged, on any other fault, the lift waiting for a later tick
 * (#3863).
 * @param {string} dir
 * @param {Log} log
 */
function readLiftedNames(dir, log) {
	try {
		return fs.readdirSync(dir);
	} catch (err) {
		const { code, message } = caught(err);
		if (code !== "ENOENT" && code !== "ENOTDIR")
			log(`lifted repo holds unread: ${dir}: ${message}`);
		return [];
	}
}

/**
 * @param {HoldNotice} notice
 */
const isClearOwed = ({ raise, clear }) =>
	raise !== null &&
	raise.outcome !== "lost" &&
	(clear === null || clear.outcome === "dispatched");

/**
 * Every lifted hold in `roots`' stores whose sessions the tick has yet to take up
 * or whose clear notice it has yet to finish.
 * @param {string[]} roots
 * @param {Log} log
 * @returns {LiftedHold[]}
 */
function readLiftedHolds(roots, log) {
	return readStoreRoots(roots).flatMap((root) => {
		const base = path.join(holdsDir(root), LIFTED_DIR);
		return readLiftedNames(base, log).flatMap((name) => {
			const dir = path.join(base, name);
			const id = parseLiftedId(name);
			const recordJobs = readLiftedRecordJobs(
				path.join(dir, buildHoldFileName(id)),
				log,
			);
			if (recordJobs === null) return [];
			const attached = parseAttachedJobs(readLiftedNames(dir, log), id);
			return [
				{
					root,
					dir,
					id,
					recordJobs,
					jobs: [...new Set([...recordJobs, ...attached])],
					isClearNoticeOwed: isClearOwed(
						readNotice(path.join(dir, buildNoticeName(id))),
					),
				},
			];
		});
	});
}

/**
 * Take `settled` off a lifted record kept for its clear notice, so that no later
 * tick judges those sessions again.
 * @param {string} file
 * @param {string[]} settled
 */
function dropRecordJobs(file, settled) {
	if (settled.length === 0) return;
	const record = JSON.parse(fs.readFileSync(file, "utf8"));
	writeFileAtomic(
		file,
		JSON.stringify({
			...record,
			sessions: record.sessions.filter(
				(/** @type {string} */ job) => !settled.includes(job),
			),
		}),
	);
}

/**
 * The hold a lifted directory's record holds, or null where it is gone or torn. Any
 * other failure throws.
 * @param {LiftedHold} lifted
 * @returns {RepoHold|null}
 */
function readLiftedRecord({ dir, id }) {
	const name = buildHoldFileName(id);
	const read = readHoldFile(path.join(dir, name), name);
	return read && "hold" in read
		? { ...read.hold, notice: readNotice(path.join(dir, buildNoticeName(id))) }
		: null;
}

/**
 * Drop what `settled` names of a lifted hold, and the hold once nothing of it is
 * left and its clear notice is done, which needs the record. A failure is logged
 * and the record kept for the next tick's resume step to read again (#3863), which
 * takes up no session twice (lib/refill-blocks.js's queueLifted).
 * @param {LiftedHold} hold
 * @param {string[]} settled  its job ids the tick has taken up
 * @param {Log} log
 */
function dropLiftedJobs(
	{ dir, id, recordJobs, jobs, isClearNoticeOwed },
	settled,
	log,
) {
	try {
		for (const job of settled)
			fs.rmSync(path.join(dir, `${buildAttachPrefix(id)}${job}`), {
				force: true,
			});
		if (!jobs.every((job) => settled.includes(job))) return;
		if (isClearNoticeOwed) {
			dropRecordJobs(path.join(dir, buildHoldFileName(id)), settled);
			return;
		}
		fs.rmSync(path.join(dir, buildNoticeName(id)), { force: true });
		if (recordJobs.every((job) => settled.includes(job)))
			fs.rmSync(path.join(dir, buildHoldFileName(id)), { force: true });
		fs.rmdirSync(dir);
	} catch (err) {
		log(`repo hold ${id}: lifted record kept: ${caught(err).message}`);
	}
}

/**
 * Lift a hold by hand, whatever its clear check reads: its log line, or null
 * where no file has that id. A record too damaged to read lifts too, by its bare
 * id, as nothing else could end it (#3857). A probe hold's filed issue closes
 * with it.
 * @param {string} root
 * @param {string} id
 * @returns {string|null}
 */
function liftHold(root, id) {
	if (!ID_PATTERN.test(id)) return null;
	const hold = readHolds(root).holds.find((h) => h.id === id);
	if (!removeHold(root, id)) return null;
	const line = `repo hold lifted by hand: ${hold ? buildHoldRef(hold) : id}`;
	const closeFailure =
		hold && closeProbeIssue(hold, "Its hold was lifted by hand.");
	return closeFailure ? `${line}; ${closeFailure}` : line;
}

/**
 * Whether a command check passes. Run under run-budgeted.js, which reaps its
 * whole group, as a straggler would outlive a plain spawn's timeout. One that
 * will not start or outlives its time reads as not passing, logged (#3857), so
 * the hold stands and the next tick tries again.
 * @param {RepoHold} hold
 * @param {string} command
 * @param {Log} log
 */
function isCommandPassed(hold, command, log) {
	const run = spawnChild(
		process.execPath,
		[
			RUN_BUDGETED,
			String(TICK_CALL_TIMEOUT_MS),
			String(CLEAR_CHECK_KILL_AFTER_MS),
			"sh",
			"-c",
			command,
		],
		{
			cwd: hold.checkout,
			env: buildCheckoutEnv(hold.checkout),
			timeout: CLEAR_CHECK_SPAWN_TIMEOUT_MS,
		},
	);
	if (run.error) {
		log(
			`repo hold ${hold.id}: clear check did not finish: ${run.error.message}`,
		);
		return false;
	}
	if (run.status === TIMEOUT_EXIT || run.status === KILLED_EXIT)
		log(
			`repo hold ${hold.id}: clear check outlived ${TICK_CALL_TIMEOUT_MS} ms`,
		);
	return run.status === 0;
}

/**
 * The checkout's tracker, or a throw.
 * @param {string} root
 */
function readTracker(root) {
	const tracker = resolveKey("tracker", { root });
	if (typeof tracker !== "string") throw new Error("no tracker configured");
	return tracker;
}

/**
 * Whether the issue reads closed; an unread issue reads as not closed, logged
 * (#3857).
 * @param {RepoHold} hold
 * @param {number} issue
 * @param {Log} log
 */
function isIssueClosed(hold, issue, log) {
	try {
		const state = gh(
			[
				"issue",
				"view",
				String(issue),
				"--repo",
				readTracker(hold.checkout),
				"--json",
				"state",
				"--jq",
				".state",
			],
			{ timeout: TICK_CALL_TIMEOUT_MS },
		);
		return state.trim() === "CLOSED";
	} catch (e) {
		log(`repo hold ${hold.id}: could not read #${issue}: ${parseErrLine(e)}`);
		return false;
	}
}

/**
 * The guard hook line `root`'s `self-plugin/hooks/hooks.json` registers for a
 * PreToolUse call of `tool`, else why there is none to run: a self-plugin host
 * with none runs no guard on the call, which is a fault of its own.
 * @param {string} root
 * @param {string} tool
 * @returns {{line: string}|{why: string}}
 */
function readGuardHookLine(root, tool) {
	const read = readText(path.join(root, SELF_PLUGIN_HOOKS));
	if (read.state === "absent") return { why: `no ${SELF_PLUGIN_HOOKS}` };
	if (read.state === "unreadable")
		return { why: `${SELF_PLUGIN_HOOKS} unread: ${read.message}` };
	let config;
	try {
		config = JSON.parse(read.data);
	} catch (err) {
		return { why: `${SELF_PLUGIN_HOOKS} unparsed: ${caught(err).message}` };
	}
	const groups = config?.hooks?.PreToolUse;
	for (const group of Array.isArray(groups) ? groups : []) {
		const matcher = String(group?.matcher ?? "");
		if (
			matcher !== "" &&
			matcher !== "*" &&
			!new RegExp(`^(?:${matcher})$`).test(tool)
		)
			continue;
		const line = (Array.isArray(group?.hooks) ? group.hooks : []).find(
			(/** @type {{command?: unknown}} */ h) =>
				typeof h?.command === "string" && h.command.includes(GUARD_ENTRY),
		)?.command;
		if (line) return { line };
	}
	return { why: `${SELF_PLUGIN_HOOKS} registers no guard line for ${tool}` };
}

/**
 * The benign `Read` the probe runs in `root`.
 * @param {string} root
 * @returns {RefusedCall}
 */
const buildBenignRead = (root) => ({
	tool_name: "Read",
	tool_input: { file_path: path.join(root, SELF_PLUGIN_HOOKS), limit: 1 },
});

/**
 * What one run of `root`'s guard hook line on `call` fails on, or null where it
 * lets the call through, run from the main checkout's files, never the loop's code
 * copy, under the probe's own session id. `isAnyDeny`, whether any deny fails
 * it, as for the benign `Read`; else only one for want of a guard that could
 * judge the call, as a replayed call may be refused on its merits.
 * @param {string} root
 * @param {RefusedCall} call
 * @param {boolean} isAnyDeny
 * @returns {string|null}
 */
function readGuardRunFailure(root, call, isAnyDeny) {
	const hookLine = readGuardHookLine(root, String(call.tool_name));
	if ("why" in hookLine) return hookLine.why;
	/* Not under RUN_BUDGETED, which closes stdin, and the payload goes on it. */
	const run = spawnChild("sh", ["-c", hookLine.line], {
		cwd: root,
		env: buildCheckoutEnv(root),
		input: JSON.stringify({
			session_id: GUARD_PROBE_SESSION,
			hook_event_name: "PreToolUse",
			cwd: root,
			...call,
		}),
		timeout: GUARD_PROBE_TIMEOUT_MS,
	});
	if (run.error)
		return caught(run.error).code === "ETIMEDOUT"
			? `outlived ${GUARD_PROBE_TIMEOUT_MS} ms`
			: run.error.message;
	if (run.status !== 0)
		return parseFirstLine(String(run.stderr)) || `exited ${run.status}`;
	const out = readHookOutput(String(run.stdout));
	if (out?.permissionDecision !== "deny") return null;
	const reason = String(out.permissionDecisionReason ?? "");
	if (!isAnyDeny && !isLockoutText(reason)) return null;
	const first = parseFirstLine(reason);
	return `refused a ${isAnyDeny ? "benign " : "replayed "}${call.tool_name}${first ? `: ${first}` : ""}`;
}

/**
 * A hook run's `hookSpecificOutput`, or null where its stdout carries none: plain
 * text on exit 0 refuses nothing.
 * @param {string} stdout
 * @returns {{permissionDecision?: unknown, permissionDecisionReason?: unknown}|null}
 */
function readHookOutput(stdout) {
	try {
		return JSON.parse(stdout)?.hookSpecificOutput ?? null;
	} catch {
		/* Not JSON: no decision, so no refusal (#4226). */
		return null;
	}
}

/**
 * The guard-load probe's failure in `root`, or null where it passes or `root` is
 * no self-plugin host.
 * @param {string} root
 * @returns {ProbeFailure|null}
 */
function readGuardLoadFailure(root) {
	if (!fs.existsSync(path.join(root, "self-plugin"))) return null;
	const read = buildBenignRead(root);
	if (readGuardRunFailure(root, read, true) === null) return null;
	sleepSync(guardProbeRetryMs());
	const failure = readGuardRunFailure(root, read, true);
	return failure === null
		? null
		: { text: `guard entry: ${failure}`, isOutage: false };
}

/**
 * What fails of `root`'s shared `.git` and guard entry, or null where the probe
 * passes. `origin` and `main` are the main checkout's.
 * @param {string} root
 * @returns {ProbeFailure|null}
 */
function readProbeFailure(root) {
	const fetched = gitOutcome(
		["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin"],
		[],
		root,
		FETCH_TIMEOUT_MS,
	);
	const refs = [{ name: "main", rev: "refs/heads/main" }];
	const unresolved = refs.flatMap(({ name, rev }) => {
		const read = readCommit(gitReader(root), rev);
		if (!read.ok)
			return [
				{
					text: `resolve ${name}: ${read.why}`,
					isOutage: read.isUnrun === true,
				},
			];
		return read.sha === null
			? [{ text: `resolve ${name}: names no commit`, isOutage: false }]
			: [];
	});
	const failed = [
		...(fetched.ok
			? []
			: [{ text: `fetch origin: ${fetched.why}`, isOutage: true }]),
		...unresolved,
		...[readGuardLoadFailure(root)].filter((f) => f !== null),
	];
	return failed.length > 0
		? {
				text: failed.map((f) => f.text).join("; "),
				isOutage: failed.every((f) => f.isOutage),
			}
		: null;
}

/**
 * Close a probe hold's filed issue, with `why`: null once closed or where there
 * is none to close, else what failed.
 * @param {RepoHold} hold
 * @param {string} why
 */
function closeProbeIssue(hold, why) {
	if (hold.kind !== "probe" || hold.issue === null) return null;
	try {
		gh(
			[
				"issue",
				"close",
				String(hold.issue),
				"--repo",
				readTracker(hold.checkout),
				"--comment",
				`${why} The refill loop launches into ${hold.checkout} again unless it reads another failure.`,
			],
			{ timeout: TICK_CALL_TIMEOUT_MS },
		);
		return null;
	} catch (e) {
		return `could not close #${hold.issue}: ${parseErrLine(e)}`;
	}
}

/**
 * @param {RepoHold} hold
 * @param {(root: string) => ProbeFailure|null} readFailure  the tick's one probe of a
 *   checkout, shared with its failing-tick raise
 * @param {Log} log
 */
function isCheckPassed(hold, readFailure, log) {
	if ("probe" in hold.clearCheck)
		return (
			readFailure(hold.checkout) === null &&
			isEveryReplayPassed(hold, readHoldReplays(hold.checkout, hold.id), log)
		);
	return "command" in hold.clearCheck
		? isCommandPassed(hold, hold.clearCheck.command, log)
		: isIssueClosed(hold, hold.clearCheck.issueClosed, log);
}

/**
 * The refused calls kept in open hold `id`'s replay files: none where one is
 * gone since the listing, or torn, which keeps no call to replay.
 * @param {string} root
 * @param {string} id
 * @returns {RefusedCall[]}
 */
function readHoldReplays(root, id) {
	const dir = holdsDir(root);
	return parseReplayNames(fs.readdirSync(dir), id).flatMap((name) => {
		const read = readText(path.join(dir, name));
		if (read.state === "absent") return [];
		if (read.state === "unreadable") throw read.error;
		try {
			const call = JSON.parse(read.data);
			return typeof call?.tool_name === "string" ? [call] : [];
		} catch {
			/* Torn: no call to replay (#4228). */
			return [];
		}
	});
}

/**
 * Keep `call` beside `root`'s probe hold for its clear check's replay, under
 * job `job`, the first a job asks kept.
 * @param {string} root
 * @param {string} job
 * @param {RefusedCall} call
 */
function keepProbeReplay(root, job, call) {
	if (!JOB_PATTERN.test(job)) throw new Error(`not a job id: ${job}`);
	try {
		fs.writeFileSync(
			path.join(holdsDir(root), `${buildReplayPrefix(PROBE_ID)}${job}`),
			JSON.stringify(call),
			{ flag: "wx" },
		);
	} catch (err) {
		if (caught(err).code !== "EEXIST") throw err;
	}
}

/**
 * Whether each of `replays` runs through `hold`'s checkout's guard hook line
 * with no refusal for want of a guard that could judge it; each that does not
 * is logged.
 * @param {RepoHold} hold
 * @param {RefusedCall[]} replays
 * @param {Log} log
 */
function isEveryReplayPassed(hold, replays, log) {
	return replays.every((call) => {
		const failure = readGuardRunFailure(hold.checkout, call, false);
		if (failure !== null)
			log(`repo hold ${hold.id}: a kept call still fails: ${failure}`);
		return failure === null;
	});
}

/**
 * Each distinct store's root among `roots`: two can be one checkout's.
 * @param {string[]} roots
 */
const readStoreRoots = (roots) => [
	...new Map(roots.map((root) => [holdsDir(root), root])).values(),
];

/**
 * Re-run one hold's clear check, lifting it where it passes. Any throw is logged
 * and costs this hold alone its tick, never the launches (#3857).
 * @param {string} root
 * @param {RepoHold} hold
 * @param {(root: string) => ProbeFailure|null} readFailure  as isCheckPassed's
 * @param {Log} log
 */
function settleHold(root, hold, readFailure, log) {
	try {
		if (!isCheckPassed(hold, readFailure, log) || !removeHold(root, hold.id))
			return;
		log(
			`repo hold cleared: ${buildHoldRef(hold)}; passed ${buildCheckText(hold.clearCheck)}`,
		);
		const closeFailure = closeProbeIssue(
			hold,
			"The probe of the main checkout passes again, so its hold has cleared.",
		);
		if (closeFailure) log(`repo hold ${hold.id}: ${closeFailure}`);
	} catch (err) {
		log(`repo hold ${hold.id}: not settled: ${caught(err).message}`);
	}
}

/**
 * The checkout's probe hold, read by its fixed name so that a store that will not
 * list still shows it; null where none is there or its record is torn, which the
 * listing logs and a raise writes over (#3860). Any other failure throws.
 * @param {string} root
 * @returns {RepoHold|null}
 */
function readProbeHold(root) {
	const read = readHoldFile(holdFile(root, PROBE_ID), `${PROBE_ID}.json`);
	return read && "hold" in read ? read.hold : null;
}

/**
 * @param {string} root
 * @param {string} failure
 */
const buildProbeIssueBody = (root, failure) =>
	`The refill loop's probe of the main checkout \`${root}\` failed, so the loop launches nothing into that checkout until it passes.

**Failure:** ${failure}

**To clear:** repair the checkout. The loop re-runs the probe each tick, lifts its hold the tick it passes and closes this issue. Where \`node scripts/repo-hold.js list\` shows no \`probe\` hold for this checkout and this issue is still open, its close failed: close it.`;

/**
 * The open issue already carrying `title`, or null: a record torn since its
 * filing, or a tick that died between filing and recording, has lost its number,
 * and a second issue would leave this one open for good. Throws where it cannot
 * tell. RESIDUAL: search lags a filing by moments, and only these two rare paths
 * read it, so a second can still slip through.
 * @param {string} root
 * @param {string} title
 * @returns {number|null}
 */
function readOpenProbeIssue(root, title) {
	const rows = /** @type {{number: number, title: string}[]} */ (
		ghJson(
			[
				"issue",
				"list",
				"--repo",
				readTracker(root),
				"--state",
				"open",
				"--search",
				`"${title}" in:title`,
				"--json",
				"number,title",
			],
			{ timeout: TICK_CALL_TIMEOUT_MS },
		)
	);
	return rows.find((r) => r.title === title)?.number ?? null;
}

/**
 * File the probe hold's issue, or take up the one already open, recording it on
 * the hold. A failure is logged and the hold stands with no issue, for the next
 * tick to retry (#3860).
 * @param {string} root
 * @param {RepoHold} hold
 * @param {string} failure
 * @param {Log} log
 */
function fileProbeIssue(root, hold, failure, log) {
	const title = `Refill loop probe: shared .git failing in ${path.basename(root)}`;
	let open;
	try {
		open = readOpenProbeIssue(root, title);
	} catch (e) {
		log(
			`repo hold ${hold.id} in ${root}: issue not filed, the next tick retries: could not look for an open one: ${parseErrLine(e)}`,
		);
		return;
	}
	if (open !== null) {
		writeHold(root, { ...hold, issue: open });
		log(`repo hold ${hold.id} in ${root}: took up open #${open}`);
		return;
	}
	const filed = fileThrough(
		[
			"--title",
			title,
			"--label",
			takesLabel("triage"),
			"--standalone",
			PROBE_FILED_WHY,
			"--body-file",
			"-",
		],
		buildProbeIssueBody(root, failure),
		root,
	);
	const number = findFiledLine(filed.stdout ?? "")?.n;
	if (number === undefined) {
		log(
			`repo hold ${hold.id} in ${root}: issue not filed, the next tick retries: ${(filed.stderr || filed.error?.message || "no reason given").trim()}`,
		);
		return;
	}
	writeHold(root, { ...hold, issue: number });
	log(`repo hold ${hold.id} in ${root}: filed #${number}`);
}

/* The outage window's decision stays beside its fs, with no core, by #3857's ruling
 * for this file: the real tick and the CLI test it. */

/**
 * An outage's start off its file; `now` where none is there or no tick has seen it
 * for the window, so a loop stopped for a day does not raise on one blip (#3899). A
 * torn record, logged, begins it anew, the next tick's write mending it. Any other
 * failure throws.
 * @param {string} file
 * @param {number} now
 * @param {Log} log
 */
function readOutageSince(file, now, log) {
	try {
		const { since, last } = JSON.parse(fs.readFileSync(file, "utf8"));
		return typeof since === "number" &&
			typeof last === "number" &&
			now - last <= OUTAGE_HOLD_AFTER_MS
			? since
			: now;
	} catch (err) {
		if (caught(err).code === "ENOENT") return now;
		if (!(err instanceof SyntaxError)) throw err;
		log(`outage record torn, begun anew: ${file}`);
		return now;
	}
}

/**
 * When `root`'s outage began, advanced to this tick, or dropped where the tick reads
 * anything else. Its file's name is neither a hold's nor an attach's. A throw is
 * logged and reads as just begun, the tick stopping launches whatever the store took
 * (#3899).
 * @param {string} root
 * @param {ProbeFailure|null} failure
 * @param {number} now
 * @param {Log} log
 * @returns {number} the outage's start, `now` where there is none
 */
function tendOutage(root, failure, now, log) {
	const file = path.join(holdsDir(root), `${PROBE_ID}.outage`);
	try {
		if (!failure?.isOutage) {
			fs.rmSync(file, { force: true });
			return now;
		}
		const since = readOutageSince(file, now, log);
		writeFileAtomic(file, JSON.stringify({ since, last: now }), {
			mkdir: true,
		});
		return since;
	} catch (err) {
		log(`probe of ${root}: outage record unkept: ${caught(err).message}`);
		return now;
	}
}

/**
 * Raise or keep `root`'s probe hold, and file its issue where it has none. Any
 * throw is logged and fails open on the record alone, the caller stopping
 * launches whatever the store took (#3860).
 * @param {string} root
 * @param {{failureText: string, isRaiseDue: boolean, repair?: string}} probed
 *   `isRaiseDue`, whether a hold not yet open may be raised; `repair`, what
 *   the founder repairs, which a raise names
 * @param {number} now
 * @param {Log} log
 */
function keepProbeHold(
	root,
	{ failureText, isRaiseDue, repair = "the main checkout" },
	now,
	log,
) {
	try {
		let hold = readProbeHold(root);
		if (hold === null) {
			if (!isRaiseDue) return;
			hold = raiseHold(root, {
				id: PROBE_ID,
				kind: "probe",
				act: `repair ${repair}: ${failureText}`,
				issue: null,
				clearCheck: { probe: true },
				session: null,
				now,
			});
			log(buildRaisedLine(hold));
		}
		if (hold.issue === null) fileProbeIssue(root, hold, failureText, log);
	} catch (err) {
		log(`repo hold ${PROBE_ID} in ${root}: not kept: ${caught(err).message}`);
	}
}

/**
 * Attach to each of `broken`'s probe holds every loop session there that has
 * blocked since the hold rose, stopped for its park or not, for the clear's
 * resume step to take up: none can attach itself while its guards refuse every
 * call (#4226). A hold with no issue yet takes none, and the next tick retries.
 * A throw is logged and costs that checkout's attaches.
 * @param {string[]} broken  tendHolds's answer
 * @param {import("./refill-loop.js").LoopLaunch[]} launches
 * @param {Log} log
 */
function attachProbeParks(broken, launches, log) {
	for (const root of broken) {
		try {
			const hold = readProbeHold(root);
			if (hold === null) continue;
			for (const l of launches) {
				if (l.jobId === null || !isBlockedSinceRaise(l, hold)) continue;
				const attached = attachHold(root, PROBE_ID, l.jobId);
				if (attached?.isNew) log(buildAttachedLine(attached.hold, l.jobId));
			}
		} catch (err) {
			log(
				`repo hold ${PROBE_ID} in ${root}: parks not attached: ${caught(err).message}`,
			);
		}
	}
}

/**
 * Whether live launch `l` in `hold`'s checkout has blocked since the hold rose.
 * A stop for a park keeps its block, so a park-stop reads the same.
 * @param {import("./refill-loop.js").LoopLaunch} l
 * @param {RepoHold} hold
 */
function isBlockedSinceRaise(l, hold) {
	const since = l.block?.since;
	return (
		l.root === hold.checkout &&
		l.finishedAt === null &&
		since !== undefined &&
		since >= hold.raisedAt
	);
}

/**
 * Raise `root`'s probe hold where none stands, its step `guard lockout:
 * <refusal>`, file its issue where it has none, and attach job `job`, locked out
 * by its guards, keeping `call` for the clear check's replay (#4228). The hold
 * once attached, else why not, which a later tick retries.
 * @param {string} root
 * @param {{job: string, refusal: string, call: RefusedCall|null}} lockout
 * @param {number} now
 * @param {Log} log
 * @returns {{hold: RepoHold}|{why: string}}
 */
function holdLockedOut(root, { job, refusal, call }, now, log) {
	keepProbeHold(
		root,
		{
			failureText: `guard lockout: ${refusal}`,
			isRaiseDue: true,
			repair: LOCKOUT_REPAIR,
		},
		now,
		log,
	);
	try {
		if (readProbeHold(root) === null) return { why: "no probe hold stands" };
		if (call) keepProbeReplay(root, job, call);
		const attached = attachHold(root, PROBE_ID, job);
		if (attached === null) return { why: "no probe hold stands" };
		if (attached.hold.issue === null)
			return { why: "its probe hold has no issue filed yet" };
		if (attached.isNew) log(buildAttachedLine(attached.hold, job));
		return { hold: attached.hold };
	} catch (err) {
		return { why: caught(err).message };
	}
}

/**
 * One tick's holds: every open hold's clear check re-run, each that passes
 * lifted, then each served checkout probed. An unreadable store is logged and
 * read as holding no open hold, the tick carrying on (#3857), but for the probe,
 * whose failing roots it returns whatever the store took (#3860).
 * @param {string[]} roots  every checkout whose holds are settled
 * @param {string[]} served  the checkouts probed
 * @param {number} now
 * @param {Log} log  passed, as lib/refill-tick.js, which owns the loop's, requires this
 * @returns {string[]} the served checkouts whose probe failed
 */
function tendHolds(roots, served, now, log) {
	/** @type {Map<string, ProbeFailure|null>} */
	const probed = new Map();
	/** One fetch a checkout a tick, for its hold's check and its probe alike.
	 * @param {string} root */
	const readFailure = (root) => {
		const known = probed.get(root);
		if (known !== undefined) return known;
		const failure = readProbeFailure(root);
		probed.set(root, failure);
		return failure;
	};
	for (const root of readStoreRoots(roots)) {
		const { holds, unread } = readHolds(root);
		for (const why of unread)
			log(`repo holds unread, read as not open this tick: ${why}`);
		for (const hold of holds) settleHold(root, hold, readFailure, log);
	}
	return served.filter((root) => {
		const failure = readFailure(root);
		const lasted = now - tendOutage(root, failure, now, log);
		if (failure === null) return false;
		const isRaiseDue = !failure.isOutage || lasted >= OUTAGE_HOLD_AFTER_MS;
		log(
			`probe failed in ${root}: ${failure.text}${isRaiseDue ? "" : `; an outage for ${buildAgeText(lasted)}, a hold rises at ${buildAgeText(OUTAGE_HOLD_AFTER_MS)}`}`,
		);
		keepProbeHold(root, { failureText: failure.text, isRaiseDue }, now, log);
		return true;
	});
}

/**
 * The open holds a tick decides on: `broken`'s probe, whatever its store took,
 * and each checkout's stored holds; beside them, each checkout whose store would
 * not read, whole or in part, with its lines.
 * @param {string[]} roots
 * @param {string[]} broken  tendHolds's answer
 * @returns {{holds: {root: string, kind: RepoHold["kind"]}[],
 *   unread: {root: string, lines: string[]}[]}}
 */
const readTickHolds = (roots, broken) => {
	const reads = roots.map((root) => ({ root, ...readHolds(root) }));
	return {
		holds: [
			...broken.map((root) => ({ root, kind: /** @type {const} */ ("probe") })),
			...reads.flatMap(({ root, holds }) =>
				holds.map(({ kind }) => ({ root, kind })),
			),
		],
		unread: reads
			.filter((r) => r.unread.length > 0)
			.map(({ root, unread }) => ({ root, lines: unread })),
	};
};

/**
 * @param {NoticePhase|null} phase
 */
function buildPhaseText(phase) {
	if (phase === null) return "not sent";
	return phase.outcome === "seen" ? "sent" : phase.outcome;
}

/**
 * A hold's notice state, for `status` and the morning review.
 * @param {HoldNotice} notice
 */
const buildNoticeText = ({ raise, clear }) =>
	`raise ${buildPhaseText(raise)}, clear ${buildPhaseText(clear)}`;

/**
 * @param {number} ms
 */
function buildAgeText(ms) {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	return minutes < 60
		? `${minutes}m`
		: `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * What the founder reads of each open hold, and of any store that would not read.
 * @param {string[]} roots
 * @param {number} now
 * @returns {string[]}
 */
function buildHoldLines(roots, now) {
	const reads = readStoreRoots(roots).map(readHolds);
	const holds = reads.flatMap((r) => r.holds);
	return [
		holds.length === 0
			? "holds:     none open"
			: `holds:     ${holds.length} open`,
		...holds.map(
			(h) =>
				`  ${h.id} ${path.basename(h.checkout)}: ${h.act} — ${buildIssueText(h)}, age ${buildAgeText(now - h.raisedAt)}, sessions: ${h.sessions.join(", ") || "none"}, stops launches: ${h.kind === "probe" ? "yes" : "no"}, notice: ${buildNoticeText(h.notice)}`,
		),
		...reads.flatMap((r) => r.unread).map((why) => `  unread: ${why}`),
	];
}

module.exports = {
	buildAgeText,
	attachHold,
	attachProbeParks,
	buildNoticeName,
	buildAttachedLine,
	buildHoldLines,
	buildNoticeText,
	buildProbePagedFile,
	buildRaisedLine,
	dropLiftedJobs,
	findOwnHold,
	holdLockedOut,
	holdsDir,
	isClearOwed,
	liftHold,
	raiseHold,
	readCheckout,
	readHolds,
	readLiftedHolds,
	readLiftedRecord,
	readNotice,
	readStoreRoots,
	readTickHolds,
	tendHolds,
	TICK_CALL_TIMEOUT_MS,
	withTickStores,
	writeNotice,
};
