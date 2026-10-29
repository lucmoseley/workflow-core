/*
 * hook-record.js — proof that a Stop guard ran, whatever it decided.
 *
 * A transcript-reading Stop guard writes exactly one file today: the
 * `.<guard>-nagged-<sid>` counter in `lib/hook-block.js`, and only when it
 * blocks. So a session in which the guard ran and read nothing is byte-for-byte
 * identical on disk to one in which the harness never fired Stop at all (mantahostels#872).
 *
 * This is the breadcrumb that separates them: one self-contained JSON line
 * APPENDED per invocation, so the file is a per-turn history rather than a
 * snapshot of the last turn (mantahostels#1004, mantahostels#1274).
 *
 * A line's ordinal in the file IS the invocation number, and `record()` never
 * reads before it writes, so one
 * `appendFileSync` of ~190 bytes is atomic under Linux's 4 KB PIPE_BUF bound.
 *
 * `source` names which route produced the message — `"payload"` is the healthy
 * path, `"transcript"` means `hook-message.js`'s fallback fired because
 * `last_assistant_message` was absent, empty, whitespace-only or not a string
 * (mantahostels#1273).
 *
 * ONE FILE IS SHARED: a payload carrying no session id has no key, so every such
 * invocation lands on `-unknown-session`, where lines from different sessions
 * interleave and stay individually readable. It matches no live session, so
 * arbiter-markers.js's pruneMarkers sweeps it a week after its last write (mantahostels#1278)
 * — which is correct only while it stays empty. If the harness ever starts
 * omitting `session_id`, this becomes one accumulating file deleted wholesale on
 * an mtime rule, and it needs an exemption then.
 *
 * EVERY FAILURE PATH IS SILENT AND RETURNS FALSE — a guard whose breadcrumb
 * cannot be written still does its real job.
 */

const fs = require("node:fs");
const path = require("node:path");
const { markersDir } = require("./marker-root.js");

/**
 * The slice of a `Stop` hook payload this file reads.
 * @typedef {{hook_event_name?: string, last_assistant_message?: unknown,
 *   stop_hook_active?: unknown}} HookPayload
 */

/** The filename stem (mantahostels#1004) — every matcher in the repo keys off
 * it. */
const PREFIX = ".hook-ran-";

/**
 * The directory holding them, one level below the repository root.
 *
 * They were at the root until mantahostels#3382, beside the `.<guard>-nagged-<sid>`
 * counters, where at ~186 invocations per guard per day against a 7-day
 * retention they came to 5,261 files — 89% of everything there. `recordsDir`
 * below is the single place that decides where they live.
 */
const DIR_NAME = ".hook-breadcrumbs";

/**
 * Where the records live.
 *
 * The one place the directory is named. `check-stop-guard-outcomes.js` and
 * `arbiter-markers.js` both call this rather than joining `DIR_NAME`
 * themselves, so the family can move again by editing one constant (mantahostels#3382).
 *
 * Nested under `.claude/tmp/markers` rather than the repository root since F8
 * (mantahostels#3515, #2) — it was a root-level directory,
 * `<root>/.hook-breadcrumbs`, before that.
 * @param {string} root repository root
 * @returns {string}
 */
function recordsDir(root) {
	return path.join(markersDir(root), DIR_NAME);
}

/** A session id arrives from a hook payload, so it is untrusted input on a
 * filesystem path. Anything but the id's own alphabet is refused. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

const NO_SESSION = "unknown-session";

/**
 * Bytes, not lines: a line count would cost a read of the whole file on every
 * invocation (mantahostels#1274).
 */
const CAP_BYTES = 32_768;

/**
 * The session id as it may appear in a filename.
 * @param {string|null|undefined} sessionId
 * @returns {string}
 */
function safeId(sessionId) {
	return sessionId && SAFE_ID.test(sessionId) ? sessionId : NO_SESSION;
}

/**
 * The outcomes that mean the guard reached a verdict;
 * `check-stop-guard-outcomes.js` counts every other outcome as a reason it
 * could not.
 *
 * `no-finding` belongs to a guard reaching the seam through `stop-guard.js`'s
 * `onPayload`, which judges session state rather than the turn's text: it
 * means the guard read what it judges and found nothing to raise. Spelled
 * apart from `empty-message`, which means there was no text to read
 * (mantahostels#2545).
 * `inventory-stand-down` is guard-session-ceiling.js's verdict that a band it
 * crossed let an ending already carrying the inventory through (#1786).
 */
const VERDICT_OUTCOMES = ["message", "no-finding", "inventory-stand-down"];

/**
 * Every outcome a guard may record; a spelling outside it is refused. All but
 * `no-finding` and `inventory-stand-down` are what `readMessageFrom()` can reach.
 */
const OUTCOMES = [
	...VERDICT_OUTCOMES,
	"empty-message",
	"no-transcript",
	"unreadable-transcript",
	"no-session-id",
	"no-payload",
];

/* Every route `readMessageFrom()` can judge; `null` where neither yielded text.
 * Named so the producing seam spells them by constant: `record()` coerces an
 * unrecognised spelling to `null`, which reads in the breadcrumb as "neither
 * arm answered". */
const SOURCE_PAYLOAD = "payload";
const SOURCE_TRANSCRIPT = "transcript";
const SOURCES = [SOURCE_PAYLOAD, SOURCE_TRANSCRIPT];

/**
 * The guard being recorded, taken from the script the harness actually ran.
 * Derived rather than passed so that no guard can forget to name itself — the
 * cost is that a guard reaching the seam from some other entry point (a test
 * runner, a REPL) is recorded under that entry point's name.
 * @param {string} [argv1] process.argv[1]
 * @returns {string}
 */
function guardName(argv1 = process.argv[1] || "") {
	const base = normaliseGuardName(path.basename(argv1));
	return /^[A-Za-z0-9._-]{1,64}$/.test(base) ? base : "unknown-guard";
}

/**
 * The canonical spelling of a guard name, with any script suffix removed.
 *
 * Applied at READ time as well as at write time: records on disk carry both
 * spellings of the same guard, `guardName` not having always stripped the
 * suffix (mantahostels#2545).
 * @param {string} name
 * @returns {string}
 */
function normaliseGuardName(name) {
	return String(name).replace(/\.(js|cjs|mjs)$/, "");
}

/**
 * @param {string} root repository root
 * @param {string} guard
 * @param {string|null|undefined} sessionId
 * @returns {string} the record's path
 */
function recordPath(root, guard, sessionId) {
	return path.join(recordsDir(root), `${PREFIX + guard}-${safeId(sessionId)}`);
}

/**
 * The file's size in bytes, 0 where it does not exist yet.
 *
 * FAILS OPEN: any `statSync` failure that is not "no such file" also answers 0,
 * which disables the cap rather than losing the invocation (mantahostels#1274).
 * @param {string} file
 * @returns {number}
 */
function sizeOf(file) {
	try {
		return fs.statSync(file).size;
	} catch {
		return 0;
	}
}

/**
 * Whether the file already ends in the sentinel, so nothing more is owed.
 *
 * FAILS OPEN: an unreadable file answers `false`, so a fresh sentinel is
 * appended on every invocation past the cap (mantahostels#1274).
 * @param {string} file
 * @returns {boolean}
 */
function isCapped(file) {
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return false;
	}
	const lines = raw.split("\n").filter((l) => l.trim());
	const last = lines.at(-1);
	if (!last) return false;
	try {
		return JSON.parse(last).capped === true;
	} catch {
		return false;
	}
}

/**
 * Record one invocation of a transcript-reading Stop guard.
 *
 * Any payload naming an event other than `Stop` is recorded nowhere (mantahostels#872).
 *
 * At the cap one `{"capped": true}` sentinel line is written and then nothing
 * ever again — without it a capped file reads as a session that stopped early.
 * The sentinel carries no `outcome`, so it does not grow `OUTCOMES`.
 *
 * @param {{root?: string, guard?: string, sessionId?: string|null,
 *   outcome: string, payload?: HookPayload|null, source?: string|null,
 *   transcriptLen?: number|null}} spec `source` and `transcriptLen` are the
 *   caller's to judge; `payloadLen` and `stopHookActive` are read off `payload`.
 * @returns {boolean} whether an invocation record was written.
 */
function record({
	root = process.cwd(),
	guard = guardName(),
	sessionId,
	outcome,
	payload,
	source = null,
	transcriptLen = null,
}) {
	if (!OUTCOMES.includes(outcome)) return false;
	const event = payload?.hook_event_name;
	if (event && event !== "Stop") return false;

	const file = recordPath(root, guard, sessionId);
	const session = safeId(sessionId);
	try {
		/* Inside the same try as the append: a directory that cannot be created
		 * is the append's failure too, and every failure path here is silent by
		 * design (mantahostels#3382). */
		fs.mkdirSync(recordsDir(root), { recursive: true });
		if (sizeOf(file) >= CAP_BYTES) {
			if (isCapped(file)) return false;
			const sentinel = { guard, session, capped: true, at: nowISO() };
			fs.appendFileSync(file, `${JSON.stringify(sentinel)}\n`);
			return false;
		}
		const fromPayload = payload?.last_assistant_message;
		const line = {
			guard,
			session,
			outcome,
			source: source !== null && SOURCES.includes(source) ? source : null,
			/* Lengths, never the text: these files are gitignored, so assistant
			 * prose here is a leak waiting for a pathspec-less commit (mantahostels#1274).
			 * Being a directory below the root rather than at it changes
			 * nothing — `git add -A` reaches both (mantahostels#3382). */
			payloadLen: typeof fromPayload === "string" ? fromPayload.length : null,
			transcriptLen: Number.isInteger(transcriptLen) ? transcriptLen : null,
			/* Without it a Stop re-firing because a previous Stop blocked is
			 * indistinguishable from a fresh turn. */
			stopHookActive: !!payload?.stop_hook_active,
			at: nowISO(),
		};
		fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
	} catch {
		return false;
	}
	return true;
}

/** @returns {string} */
function nowISO() {
	return new Date().toISOString();
}

module.exports = {
	record,
	guardName,
	normaliseGuardName,
	SOURCE_PAYLOAD,
	SOURCE_TRANSCRIPT,
	VERDICT_OUTCOMES,
	PREFIX,
	recordsDir,
};
