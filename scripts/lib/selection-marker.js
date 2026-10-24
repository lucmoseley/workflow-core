/*
 * selection-marker.js — what tells a Stop hook that this session is picking work.
 *
 * `scripts/guard-selection-sum.js` refuses a selection session's dispatch
 * message unless it states §5's arithmetic. To do that it must first know a
 * selection session when it sees one, and nothing in an outgoing message says
 * so reliably: `CLAUDE_JOB_DIR` (what guard-priced-options.js keys off) is set
 * in every background job, and a message shape alone would fire on any session
 * that happened to list issue numbers.
 *
 * So the run itself says so. `scripts/pick-next.js` writes one marker per
 * session as it finishes, carrying the frontier size that run measured, and the
 * guard reads the marker for the session id its hook payload hands it. Nothing
 * but a real `pick-next.js` run mints one, so no other session is ever examined
 * (mantahostels#844, which built this after the written rule failed twice).
 *
 * A RUN MADE TO EXERCISE THE TOOLING MINTS NOTHING. `--no-log` already means
 * exactly that (mantahostels#628, which kept such runs out of the warm-fraction sample), so
 * the marker rides the same flag rather than inventing a second opt-out.
 *
 * The marker carries the frontier size so the guard can check the sum against
 * the run that produced it, not merely against itself, and the admission slot
 * count so it can tell a set that filled the machine from one that ran out of
 * candidates (mantahostels#1321). The slot figure is the run's own, and §5 sends the reader
 * to `node scripts/admission.js` for a fresh one immediately before dispatch —
 * so the marker's is a floor, which is why the guard fires on `>=` and never on
 * equality alone.
 *
 * It also carries `noCommand` (mantahostels#1626): the frontier issues no command opens —
 * `takes:human`, plus a `takes:children` container rotted to zero open children.
 * That is the accounting line's third term, and unlike the disqualified count it
 * is measurable, so the guard pins it exactly as it pins `frontier`. An older
 * marker, minted before this field existed, reads it back as null and the guard
 * leaves that term unpinned rather than calling it zero.
 *
 * THE TWO SIDES KEY ON DIFFERENT SOURCES FOR THE SAME ID, and the guard arms
 * only where they agree: the mint reads `CLAUDE_CODE_SESSION_ID` from the Bash
 * tool's environment, the guard reads `session_id` off its Stop payload — both
 * through `lib/session-id.js` (mantahostels#1774), which is this round trip's only spelling
 * of either lookup, not the repo's: a shell guard reads the env var direct.
 * Decoupled, no marker would ever match and the guard would silently never arm.
 * Re-check by comparing the env var against an artefact written from the
 * payload alone — an arbiter file claim, or `concision-backstop.sh`'s marker
 * file (mantahostels#844, which found them equal).
 *
 * EVERY FAILURE PATH IS SILENT — a marker that cannot be written or read leaves
 * the session unarmed.
 */

const fs = require("node:fs");
const { MARKERS_REL } = require("./marker-root.js");
const path = require("node:path");
const idSeam = require("./session-id");

/** Beside the write-set cache and the warm-fraction log, under `.claude/tmp/markers/.pick-next/`. */
const MARKER_SUBDIR = path.join(
	MARKERS_REL,
	".pick-next",
	"selection-sessions",
);

/* Markers are per-session state with nothing to pin, so they are swept on age
 * alone by whichever run comes next. A week outlives any session that could
 * still be dispatching against its own run. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** A session id reaches this from a hook payload or an env var, so it is untrusted
 * input on a filesystem path. Anything but the id's own alphabet is refused. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * @param {string} root repository root
 * @param {string|null|undefined} sessionId
 * @returns {string|null} the marker's path, or null where the id is unusable
 */
function markerPath(root, sessionId) {
	if (!sessionId || !SAFE_ID.test(sessionId)) return null;
	return path.join(root, MARKER_SUBDIR, `${sessionId}.json`);
}

/**
 * Delete markers older than MAX_AGE_MS. Best-effort: a sweep that cannot read
 * the directory leaves it alone.
 * @param {string} root
 */
function prune(root) {
	const dir = path.join(root, MARKER_SUBDIR);
	let names;
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	const cutoff = Date.now() - MAX_AGE_MS;
	for (const name of names) {
		const file = path.join(dir, name);
		try {
			if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
		} catch {
			/* a marker another run swept between the readdir and the stat */
		}
	}
}

/**
 * Record that this session has just picked work.
 * @param {string} root repository root
 * @param {{sessionId: string|null|undefined, frontier: number, slots?: number|null,
 *   noCommand?: number|null}} run
 * @returns {boolean} whether a marker was written
 */
function record(root, { sessionId, frontier, slots, noCommand }) {
	const file = markerPath(root, sessionId);
	if (!file) return false;
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			`${JSON.stringify({
				sessionId,
				frontier: Number.isInteger(frontier) ? frontier : null,
				slots: Number.isInteger(slots) ? slots : null,
				noCommand: Number.isInteger(noCommand) ? noCommand : null,
				at: new Date().toISOString(),
			})}\n`,
		);
	} catch {
		return false;
	}
	prune(root);
	return true;
}

/**
 * `record`, keyed on the id the environment gives — the minting side of the
 * round trip this module's header describes, taking its environment as an
 * argument so a test can drive the mint without one (mantahostels#1774).
 * @param {string} root repository root
 * @param {{frontier: number, slots?: number|null, noCommand?: number|null}} run
 * @param {Record<string, string|undefined>} [env] defaults to this process's environment
 * @returns {boolean} whether a marker was written
 */
function recordFromEnv(root, run, env = process.env) {
	return record(root, { ...run, sessionId: idSeam.fromEnv(env) });
}

/**
 * Record that this session has dispatched a wave but not yet closed the set —
 * the state that lets `guard-selection-sum.js` accept a partial sum now and
 * still demand the full one later, both against this one run (mantahostels#1486). `keys`
 * are the dispatch lines already launched, so a closing wave that restates one
 * is not counted twice.
 * @param {string} root repository root
 * @param {string} sessionId
 * @param {string[]} keys one per session dispatched so far, `sessionKeys()`' spelling
 * @returns {boolean} whether the marker was updated
 */
function openWave(root, sessionId, keys) {
	return patch(root, sessionId, {
		wave: { keys: [...new Set(keys)], at: new Date().toISOString() },
	});
}

/**
 * Record that the closing wave has stated the full sum, so a later turn is no
 * longer owed one.
 * @param {string} root repository root
 * @param {string} sessionId
 * @returns {boolean} whether the marker was updated
 */
function closeWave(root, sessionId) {
	return patch(root, sessionId, { wave: null });
}

/**
 * Merge fields into an existing marker. Never mints one: a session with no
 * marker is unarmed, and a wave written for it would arm nothing.
 * @param {string} root
 * @param {string} sessionId
 * @param {object} fields
 * @returns {boolean}
 */
function patch(root, sessionId, fields) {
	const file = markerPath(root, sessionId);
	if (!file) return false;
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object") return false;
		fs.writeFileSync(file, `${JSON.stringify({ ...parsed, ...fields })}\n`);
	} catch {
		return false;
	}
	return true;
}

/**
 * @param {string} root repository root
 * @param {string} sessionId
 * @returns {{frontier: number|null, slots: number|null, noCommand: number|null,
 *   at: string|null, wave: {keys: string[]}|null}|null} null where this
 *   session has run no selection — including where the marker is unreadable or
 *   malformed, which disarms rather than guessing.
 */
function read(root, sessionId) {
	const file = markerPath(root, sessionId);
	if (!file) return null;
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return null;
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const keys = parsed.wave?.keys;
	return {
		frontier: Number.isInteger(parsed.frontier) ? parsed.frontier : null,
		slots: Number.isInteger(parsed.slots) ? parsed.slots : null,
		noCommand: Number.isInteger(parsed.noCommand) ? parsed.noCommand : null,
		at: typeof parsed.at === "string" ? parsed.at : null,
		wave: Array.isArray(keys)
			? { keys: keys.filter((k) => typeof k === "string") }
			: null,
	};
}

module.exports = {
	record,
	recordFromEnv,
	read,
	prune,
	openWave,
	closeWave,
};
