/*
 * repo-holds.js — the repo hold's record and lifecycle (#3857, spec #3597): a
 * per-checkout record that one founder-only act blocks shared state.
 * scripts/repo-hold.js is its CLI; lib/refill-tick.js runs settleHolds each
 * tick. It is the adapter behind that tick's I/O (#3857's "behind the loop's
 * port"), so it holds fs, gh and the clear checks' runs together, tested through
 * the real tick and the CLI as that ticket asks, with no core split out.
 *
 * THE STORE is one file a hold, under the loop's machine-wide directory
 * (lib/refill-dir.js), in a directory keyed on git's common dir. So every
 * worktree of a checkout and the loop read one store, a raise overwrites no
 * other hold, and lib/scratch-sweep.js, which reaps `.claude/tmp/`, cannot age
 * out a hold the founder has yet to answer. RESIDUAL: where git will not name
 * the common dir at all, a worktree keys on its own root, so its holds split
 * from the checkout's until git answers again.
 *
 * A LIFT IS THE UNLINK, so a tick and a hand lift racing get one winner and one
 * log line.
 */

const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomBytes } = require("node:crypto");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { spawnChild } = require("./child-spawn.js");
const { deref } = require("./deref.js");
const { gh, parseErrLine } = require("./gh.js");
const { gitCommonDir } = require("./git.js");
const { mainCheckout } = require("./main-checkout.js");
const { refillPath } = require("./refill-dir.js");
const { checkoutEnv } = require("./refill-repos.js");
const {
	KILLED_EXIT,
	RUN_BUDGETED,
	TIMEOUT_EXIT,
} = require("./run-budgeted.js");
const { resolveKey } = require("./workflow-core-config.js");

/**
 * @typedef {{command: string} | {issueClosed: number}} ClearCheck
 *
 * @typedef {object} RepoHold
 * @property {string} id
 * @property {string} checkout  the main checkout's root
 * @property {"probe"|"park"} kind  a `probe` hold alone stops launches. Only
 *   #3860's probe will raise one and read the kind to withhold launches; until
 *   then every hold is a `park` and withholds nothing.
 * @property {string} act  the founder act, in plain words
 * @property {number} issue  the issue holding the question
 * @property {ClearCheck} clearCheck
 * @property {number} raisedAt
 * @property {string[]} sessions  the job ids of the sessions parked on it
 * @property {{raiseSent: boolean, clearSent: boolean}} notice  #3871's to read
 *   and write, the morning review's to read; nothing writes it yet
 *
 * @typedef {(line: string) => void} Log
 */

/* Untraced: a clear check runs inside a tick, which it must not hold for long,
 * and has to span a slow `git fetch`. */
const CLEAR_CHECK_TIMEOUT_MS = 30_000;

/* How long the runner waits after its TERM before its KILL; a guess, as
 * lib/gate-check.js's is. */
const CLEAR_CHECK_KILL_AFTER_MS = 5000;

/* A guess: few holds open at once, and short enough to type at `lift`. A
 * repeat would overwrite the hold it repeats. */
const ID_BYTES = 3;

const ID_PATTERN = /^[0-9a-f]+$/;

/* A guess: 48 bits of the key's hash, in a directory holding a few checkouts. */
const STORE_KEY_LENGTH = 12;

/**
 * The checkout a command run from `cwd` holds holds in.
 * @param {string} cwd
 */
const readCheckout = (cwd) => mainCheckout(cwd) ?? cwd;

/**
 * The checkout's store: named for a reader, and hashed because two paths can
 * flatten to one name.
 * @param {string} root
 */
function holdsDir(root) {
	const key = deref(gitCommonDir(root) ?? root);
	const hash = createHash("sha256").update(key).digest("hex");
	return refillPath(
		path.join(
			"repo-holds",
			`${path.basename(root)}-${hash.slice(0, STORE_KEY_LENGTH)}`,
		),
	);
}

/**
 * @param {string} root
 * @param {string} id
 */
const holdFile = (root, id) => path.join(holdsDir(root), `${id}.json`);

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
		/** @type {Partial<{command: unknown, issueClosed: unknown}>} */ (
			hold?.clearCheck ?? {}
		);
	return (
		typeof hold?.id === "string" &&
		ID_PATTERN.test(hold.id) &&
		name === `${hold.id}.json` &&
		typeof hold.checkout === "string" &&
		(hold.kind === "probe" || hold.kind === "park") &&
		typeof hold.act === "string" &&
		typeof hold.issue === "number" &&
		typeof hold.raisedAt === "number" &&
		typeof hold.notice?.raiseSent === "boolean" &&
		typeof hold.notice?.clearSent === "boolean" &&
		Array.isArray(hold.sessions) &&
		(typeof check.command === "string" || typeof check.issueClosed === "number")
	);
}

/**
 * The checkout's open holds, oldest first, and why any of them would not read.
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
			: { holds: [], unread: [`${dir}: ${message}`] };
	}
	/** @type {RepoHold[]} */
	const holds = [];
	/** @type {string[]} */
	const unread = [];
	for (const name of names.filter((n) => n.endsWith(".json"))) {
		const file = path.join(dir, name);
		try {
			const value = JSON.parse(fs.readFileSync(file, "utf8"));
			if (isHold(value, name)) holds.push(value);
			else unread.push(`${file}: not a hold`);
		} catch (err) {
			/* ENOENT: lifted between the listing and this read. */
			if (caught(err).code !== "ENOENT")
				unread.push(`${file}: ${caught(err).message}`);
		}
	}
	return { holds: holds.sort((a, b) => a.raisedAt - b.raisedAt), unread };
}

/** @param {ClearCheck} check */
const buildCheckText = (check) =>
	"command" in check
		? `command: ${check.command.replace(/\s+/g, " ").trim()}`
		: `issue #${check.issueClosed} closed`;

/** @param {RepoHold} hold */
const buildHoldRef = (hold) => `${hold.id} in ${hold.checkout}: ${hold.act}`;

/**
 * Record a new hold and return it.
 * @param {string} root
 * @param {{kind: RepoHold["kind"], act: string, issue: number,
 *   clearCheck: ClearCheck, session: string|null, now: number}} raised
 * @returns {RepoHold}
 */
function raiseHold(root, { kind, act, issue, clearCheck, session, now }) {
	/** @type {RepoHold} */
	const hold = {
		id: randomBytes(ID_BYTES).toString("hex"),
		checkout: root,
		kind,
		/* One line, as the log and status print it. */
		act: act.replace(/\s+/g, " ").trim(),
		issue,
		clearCheck,
		raisedAt: now,
		sessions: session === null ? [] : [session],
		notice: { raiseSent: false, clearSent: false },
	};
	writeFileAtomic(
		holdFile(root, hold.id),
		`${JSON.stringify(hold, null, "\t")}\n`,
		{ mkdir: true },
	);
	return hold;
}

/** @param {RepoHold} hold */
const buildRaisedLine = (hold) =>
	`repo hold raised: ${buildHoldRef(hold)}; issue #${hold.issue}; clears on ${buildCheckText(hold.clearCheck)}`;

/**
 * End a hold; false where it was already gone.
 * @param {string} root
 * @param {string} id
 */
function removeHold(root, id) {
	try {
		fs.unlinkSync(holdFile(root, id));
		return true;
	} catch (err) {
		if (caught(err).code === "ENOENT") return false;
		throw err;
	}
}

/**
 * Lift a hold by hand, whatever its clear check reads: its log line, or null
 * where no file has that id. A record too damaged to read lifts too, by its bare
 * id, as nothing else could end it (#3857).
 * @param {string} root
 * @param {string} id
 * @returns {string|null}
 */
function liftHold(root, id) {
	if (!ID_PATTERN.test(id)) return null;
	const hold = readHolds(root).holds.find((h) => h.id === id);
	if (!removeHold(root, id)) return null;
	return `repo hold lifted by hand: ${hold ? buildHoldRef(hold) : id}`;
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
			String(CLEAR_CHECK_TIMEOUT_MS),
			String(CLEAR_CHECK_KILL_AFTER_MS),
			"sh",
			"-c",
			command,
		],
		{
			cwd: hold.checkout,
			env: checkoutEnv(hold.checkout),
			timeout: CLEAR_CHECK_TIMEOUT_MS + 2 * CLEAR_CHECK_KILL_AFTER_MS,
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
			`repo hold ${hold.id}: clear check outlived ${CLEAR_CHECK_TIMEOUT_MS} ms`,
		);
	return run.status === 0;
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
		const tracker = resolveKey("tracker", { root: hold.checkout });
		if (typeof tracker !== "string") throw new Error("no tracker configured");
		const state = gh(
			[
				"issue",
				"view",
				String(issue),
				"--repo",
				tracker,
				"--json",
				"state",
				"--jq",
				".state",
			],
			{ timeout: CLEAR_CHECK_TIMEOUT_MS },
		);
		return state.trim() === "CLOSED";
	} catch (e) {
		log(`repo hold ${hold.id}: could not read #${issue}: ${parseErrLine(e)}`);
		return false;
	}
}

/**
 * @param {RepoHold} hold
 * @param {Log} log
 */
const isCheckPassed = (hold, log) =>
	"command" in hold.clearCheck
		? isCommandPassed(hold, hold.clearCheck.command, log)
		: isIssueClosed(hold, hold.clearCheck.issueClosed, log);

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
 * @param {Log} log
 */
function settleHold(root, hold, log) {
	try {
		if (isCheckPassed(hold, log) && removeHold(root, hold.id))
			log(
				`repo hold cleared: ${buildHoldRef(hold)}; passed ${buildCheckText(hold.clearCheck)}`,
			);
	} catch (err) {
		log(`repo hold ${hold.id}: not settled: ${caught(err).message}`);
	}
}

/**
 * One tick's holds: every open hold's clear check re-run, each that passes
 * lifted. An unreadable store is logged and read as holding no open hold, the
 * tick carrying on (#3857).
 * @param {string[]} roots
 * @param {Log} log  passed, as lib/refill-tick.js, which owns the loop's, requires this
 */
function settleHolds(roots, log) {
	for (const root of readStoreRoots(roots)) {
		const { holds, unread } = readHolds(root);
		for (const why of unread)
			log(`repo holds unread, read as not open this tick: ${why}`);
		for (const hold of holds) settleHold(root, hold, log);
	}
}

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
				`  ${h.id} ${path.basename(h.checkout)}: ${h.act} — issue #${h.issue}, age ${buildAgeText(now - h.raisedAt)}, sessions: ${h.sessions.join(", ") || "none"}, stops launches: ${h.kind === "probe" ? "yes" : "no"}`,
		),
		...reads
			.flatMap((r) => r.unread)
			.map((why) => `  unread: ${why}; lift its id or remove the file`),
	];
}

module.exports = {
	buildAgeText,
	buildHoldLines,
	buildRaisedLine,
	liftHold,
	raiseHold,
	readCheckout,
	readHolds,
	settleHolds,
};
