/*
 * notify-report.js — the on-disk half of persist-and-replay for a slow
 * SessionStart checker (mantahostels#1973, the library mantahostels#1949 specifies).
 *
 * A producer calls openRun()/closeRun() around its work and writeReport() once
 * it finishes; the synchronous reader, `scripts/replay-notify-reports.js`
 * (mantahostels#1976), calls list(), readReport(), readRun(), isCancelled(), ageMs() and
 * isStale().
 *
 * TOTAL DEGRADATION TO A NO-OP, ALWAYS. Every write returns a boolean rather
 * than throwing; every read returns null rather than throwing, on an
 * unwritable directory, a corrupt file or a missing one.
 *
 * ONE DIRECTORY FOR THE MACHINE: the arbiter's pinned store (`stateDir()`,
 * the first seat's, #383), whichever seat the process runs on — or, where it
 * cannot be written, the sorted-first config dir that can (#385).
 */

const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { configDir } = require("./config-dir.js");
// Called as `store.stateDir()`, never destructured: a test forcing the
// fallback spies on this live property.
const store = require("./arbiter-store.js");
const {
	currentBootId,
	holderAlive,
	procStartOf,
} = require("./arbiter-proc.js");
const { hostRoot } = require("./host-root.js");
const { projectSlug } = require("./project-slug.js");
const { pinnedOrFirstUsable } = require("./can-hold-state.js");

/** @typedef {"OK"|"SKIP"|"WARN"|"FAIL"|"BROKEN"} Outcome */
/**
 * @typedef {{checker: string, outcome: Outcome, text: string, at: string,
 *   durationMs: number|null, stamp: string|null,
 *   stamps: Record<string, string>, owner: string|null,
 *   maxAgeMs: number|null}} Report `stamps`
 *   carries a stamp-name to signature map for a producer whose findings do not
 *   reduce to the single `stamp` field. `owner` is the id of the session whose
 *   start launched the producer (#853), null where none was known. `maxAgeMs`
 *   is how long the replay may still show it, null for DEFAULT_STALE_MS (#1553)
 * @typedef {{checker: string, startedAt: string, pid: number,
 *   procStart: string|null, bootId: string|null}} RunRecord
 */

/**
 * The directory every checker's report and run-record files live under. Never
 * throws: a failure resolving it falls back to the running config dir's project
 * directory, keyed on CLAUDE_CONFIG_DIR rather than a bare HOME guess — the
 * arbiter suites re-point it at a sandbox and leave HOME alone.
 *
 * Unmemoised, unlike check-hook-liveness.js's statePath: a long-lived reader
 * then follows a store that becomes writable mid-process.
 */
function base() {
	try {
		const slug = projectSlug(hostRoot());
		return pinnedOrFirstUsable(
			path.join(store.stateDir(), "notify-reports"),
			store
				.configDirs()
				.map((cfg) => path.join(cfg, "projects", slug, "notify-reports")),
		);
	} catch {
		return path.join(
			configDir(),
			"projects",
			projectSlug(hostRoot()),
			"notify-reports",
		);
	}
}

/**
 * A checker name spelled safely as part of a filename.
 * @param {string} id
 */
const slug = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, "-");

/** @param {string} checker */
const reportFile = (checker) =>
	path.join(base(), `${slug(checker)}.report.json`);

/** @param {string} checker */
const runFile = (checker) => path.join(base(), `${slug(checker)}.run.json`);

/**
 * Every checker with a report or an open run record on disk, sorted.
 *
 * THE FILENAME IS THE KEY, not the `checker` field inside the document: the
 * reader needs the name before it can read either file, and `slug` is what
 * put it there. Display the report's own `checker` field rather than this,
 * which carries `slug`'s rewriting of any character a filename could not.
 * @returns {string[]}
 */
function list() {
	let names;
	try {
		names = fs.readdirSync(base());
	} catch {
		return [];
	}
	const keys = new Set();
	for (const name of names) {
		const m = name.match(/^(.+)\.(?:report|run)\.json$/);
		if (m) keys.add(m[1]);
	}
	return [...keys].sort();
}

/**
 * Write `obj` to `file` atomically: a temp file in the same directory, then a
 * rename, so a reader never observes a truncated or half-written record.
 * Never throws. Returns whether it landed.
 * @param {string} file
 * @param {object} obj
 */
function atomicWriteJSON(file, obj) {
	try {
		writeFileAtomic(file, `${JSON.stringify(obj)}\n`, { mkdir: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * Read one JSON record. `null` for absent, unreadable or torn — a reader mid
 * write, or a directory this process cannot enter — never a throw.
 * @param {string} file
 */
function readJSON(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
	try {
		const obj = JSON.parse(text);
		return obj && typeof obj === "object" ? obj : null;
	} catch {
		return null; // torn: another writer is mid-record, or the file is hand-mangled
	}
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/**
 * Persist one finished run. An `OK` outcome with empty `text` still writes a
 * file — the reader needs to tell "ran and had nothing to say" apart from
 * "never ran", and only a present file can say the first.
 * `stamp` and `stamps` are carried, not applied: the reader stamps with them
 * (lib/delivery-stamp.js `recordDelivery`) once it has shown the report.
 * `owner` is what lets `scripts/deliver-to-session.js` hand the report to the
 * session it belongs to (#853); the replay reader ignores it.
 *
 * @param {string} checker
 * @param {{outcome: Outcome, text?: string, finishedAt?: Date|string,
 *   durationMs?: number|null, stamp?: string|null,
 *   stamps?: Record<string, string>, owner?: string|null,
 *   maxAgeMs?: number|null}} entry
 * @returns {boolean} whether the write landed
 */
function writeReport(
	checker,
	{
		outcome,
		text = "",
		finishedAt = new Date(),
		durationMs = null,
		stamp = null,
		stamps = {},
		owner = null,
		maxAgeMs = null,
	},
) {
	const at =
		finishedAt instanceof Date ? finishedAt.toISOString() : String(finishedAt);
	return atomicWriteJSON(reportFile(checker), {
		checker,
		outcome,
		text,
		at,
		durationMs,
		stamp,
		stamps,
		owner,
		maxAgeMs,
	});
}

/**
 * The last report a checker persisted, or null where there is none — never
 * written, unreadable, or too mangled to trust.
 * @param {string} checker
 * @returns {Report|null}
 */
function readReport(checker) {
	const record = readJSON(reportFile(checker));
	if (
		!record ||
		typeof record.checker !== "string" ||
		typeof record.outcome !== "string" ||
		typeof record.text !== "string" ||
		typeof record.at !== "string"
	)
		return null;
	return {
		checker: record.checker,
		outcome: /** @type {Outcome} */ (record.outcome),
		text: record.text,
		at: record.at,
		durationMs:
			typeof record.durationMs === "number" ? record.durationMs : null,
		stamp: typeof record.stamp === "string" ? record.stamp : null,
		// SANITISED HERE, not at the reader: `covers()` (lib/delivery-stamp.js)
		// calls `.startsWith` on a signature with no further check, so a mangled
		// report's `stamps` — an array, a non-string value — would throw there and
		// take the whole session-start replay down with it.
		stamps:
			record.stamps &&
			typeof record.stamps === "object" &&
			!Array.isArray(record.stamps)
				? Object.fromEntries(
						Object.entries(record.stamps).filter(
							([, v]) => typeof v === "string" && v !== "",
						),
					)
				: {},
		owner:
			typeof record.owner === "string" && record.owner ? record.owner : null,
		maxAgeMs:
			Number.isFinite(record.maxAgeMs) && record.maxAgeMs > 0
				? record.maxAgeMs
				: null,
	};
}

/**
 * How old `report` is against `now`, in milliseconds — null where its
 * timestamp cannot be parsed at all.
 * @param {Report|null} report
 * @param {number} [now]
 */
function ageMs(report, now = Date.now()) {
	if (!report) return null;
	const t = Date.parse(report.at);
	return Number.isNaN(t) ? null : Math.max(0, now - t);
}

/*
 * A first guess, not a measurement. Long enough that an ordinary gap between
 * session starts still shows the last real reading; short enough that a CI
 * verdict from a stale morning is not shown as current in the evening.
 */
const DEFAULT_STALE_MS = 4 * 60 * 60 * 1000;

/**
 * Whether `report` is too old to show as current. An unparseable timestamp is
 * treated as stale rather than fresh: never show a bad reading as though it
 * were live.
 * @param {Report|null} report
 * @param {number} [maxAgeMs]
 * @param {number} [now]
 */
function isStale(report, maxAgeMs = DEFAULT_STALE_MS, now = Date.now()) {
	const age = ageMs(report, now);
	return age === null ? true : age > maxAgeMs;
}

// ---------------------------------------------------------------------------
// Open-run records
// ---------------------------------------------------------------------------

/**
 * Mark a checker's run as started, before any slow work. Never throws; a
 * failed open costs a missed cancellation report, never a broken producer.
 * @param {string} checker
 */
function openRun(checker) {
	const pid = process.pid;
	atomicWriteJSON(runFile(checker), {
		checker,
		startedAt: new Date().toISOString(),
		pid,
		procStart: procStartOf(pid),
		bootId: currentBootId(),
	});
}

/**
 * Close a checker's run record on normal completion. Idempotent: closing one
 * never opened, or already closed, is not an error.
 * @param {string} checker
 */
function closeRun(checker) {
	try {
		fs.unlinkSync(runFile(checker));
	} catch {
		/* already gone, or never opened */
	}
}

/**
 * The open run record for `checker`, or null where none is open.
 * @param {string} checker
 * @returns {RunRecord|null}
 */
function readRun(checker) {
	const record = readJSON(runFile(checker));
	if (
		!record ||
		typeof record.pid !== "number" ||
		typeof record.checker !== "string" ||
		typeof record.startedAt !== "string"
	)
		return null;
	return {
		checker: record.checker,
		startedAt: record.startedAt,
		pid: record.pid,
		procStart:
			typeof record.procStart === "string" ||
			typeof record.procStart === "number"
				? record.procStart
				: null,
		bootId: typeof record.bootId === "string" ? record.bootId : null,
	};
}

/**
 * Whether an open run record describes a producer that is no longer running.
 * `null` (nothing open) is not a cancellation — there is no run to have been
 * cut off. Liveness is judged exactly as the arbiter judges a lock's holder
 * (`holderAlive`): the recorded pid must still match a live process carrying
 * the same kernel start-time token AND the same boot, so neither a recycled
 * pid nor a coincident pid/procStart pair surviving a reboot is mistaken for
 * the producer that opened the record — a run file lives under `~/.claude*`
 * and outlives a reboot, unlike the arbiter's own stale-lock sweep.
 * @param {RunRecord|null} run
 */
function isCancelled(run) {
	if (!run) return false;
	return !holderAlive({
		pid: run.pid,
		procStart: run.procStart,
		bootId: run.bootId ?? undefined,
	});
}

module.exports = {
	// Consumed by mantahostels#1949's synchronous reader, scripts/replay-notify-reports.js
	// — exported rather than inlined so the bound is set in one place.
	DEFAULT_STALE_MS,
	// The two file primitives, exported for that same reader: its own
	// shown-records sit in this directory and are written the same way, and a
	// second spelling of an atomic write there would be one more thing to keep
	// in step (mantahostels#1976).
	atomicWriteJSON,
	readJSON,
	base,
	slug,
	list,
	reportFile,
	writeReport,
	readReport,
	ageMs,
	isStale,
	openRun,
	closeRun,
	readRun,
	isCancelled,
};
