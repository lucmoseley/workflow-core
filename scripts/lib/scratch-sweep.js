/*
 * scratch-sweep.js — the reaper for `.claude/tmp/`, the one sanctioned in-repo
 * scratch directory (`docs/environment.md` §12, mantahostels#2089). Founder ruling on
 * mantahostels#2090.
 *
 * THE GATE IS TWO LIMBS, AND BOTH MUST HOLD BEFORE ANYTHING IS DELETED:
 *
 *   1. the file's write time is older than its floor — 24 h, or 7 days for a
 *      research or dispatched-agent artefact; and
 *   2. no session `claude agents --json` currently lists STARTED BEFORE that
 *      write time.
 *
 * LIMB 2 IS THE SAFETY PROOF, NOT LIMB 1. A session that started after a file
 * was last written has never written it, so limb 2 is a proof rather than a
 * statistical bet, which is what decided the design against an age-only rule.
 *
 * THE PROOF RESTS ON A WRITE TIME USERLAND CANNOT REWIND, so both limbs read
 * the later of mtime and ctime (`writtenAtMs`, workflow-core#1003). mtime alone is not one:
 * `tar -x`, `cp -p`, `rsync -a`, `unzip` and `touch -r` all set it into the
 * past. ctime is set by the kernel on every write, and no call sets it back.
 * Limb 1 is a retention floor and the cover for limb 2's one hole: a detached
 * child outliving its session and still writing. The frequency of that hole is
 * unmeasured (mantahostels#2090), so 24 h is a floor chosen against session length and is
 * not calibrated against the thing limb 1 is there for.
 *
 * A DISPATCHED AGENT'S EVIDENCE IS EXEMPT UNTIL 7 DAYS: any entry whose name
 * contains `research`, and the top-level `agents/` directory with everything
 * in it, where `guard-dispatch-rewrite.sh` supplies a dispatch's artefact. The
 * path is the only signal there is — the `research-<name>` convention reaches
 * tracker-skill dispatches alone (workflow-core#1009). A research file named without the
 * word still gets 24 h, accepted at workflow-core#1009's ruling. Seven days rather than exemption outright, so they clear eventually
 * instead of accumulating for good.
 *
 * ON AN UNREADABLE ORACLE, DELETE NOTHING AND LOG. A missing or garbled
 * `startedAt` counts as unreadable in the same direction — `agent-liveness.js`
 * degrades to doubt, never to "dead", so a record whose start time cannot be
 * read spares EVERY file rather than being dropped from the live set — so if
 * the oracle ever stops emitting `startedAt`, this sweep goes quiet rather than
 * wrong.
 *
 * WHY NOT `arbiter-core.js`'s `sweepAged` (mantahostels#2090).
 * `sweepAged` at `:1171` is FLAT — one `readdirSync`, `unlinkSync` only, with
 * every error swallowed at `:1179-1181`. `.claude/tmp/` has subdirectories, so
 * reusing it unchanged would fail SILENTLY, `unlinkSync` on a directory
 * throwing EISDIR straight into that catch.
 *
 * THE CHEAP TEST RUNS FIRST, the pattern at
 * `arbiter-issue-claims.js:288-297`: the oracle costs ~465 ms
 * (`agent-liveness.js:5-8`), and this runs at every session start, where
 * usually nothing is old enough to sweep. So the walk for an aged candidate —
 * pure `stat`, no liveness — decides whether the oracle is read at all.
 *
 * IN NO §N3 FAMILY, DELIBERATELY. It is neither a `check-*` gate, a `guard-*`
 * hook, a `generate-*` writer nor a `report-*`: it deletes, and answers to none
 * of those four contracts. It sits in `scripts/lib/` with a `require.main` tail
 * rather than at `scripts/` top level, the arrangement `lib/sweep-budget.js`
 * uses — the sweeping is a module the suite drives against a fixture, and the
 * launcher runs the same bytes through the tail.
 *
 * Limb 2's proof is read at the `stat`, and
 * the `unlink` follows it, so a session that is live, absent from a short list
 * AND writing in that window loses the write — the 24 h floor is what prices
 * that out, not the proof. And the CLI tail's outer catch swallows a failure to
 * load `arbiter-core` or a throwing `logError`: in that one case the reaper is
 * dead and nothing anywhere records it.
 *
 * THE SELF-TEST IS WAIVED, for `agent-liveness.js`'s `sweepSessionIds` reason
 * (mantahostels#710): the one wiring is SessionStart, where the starting session is not yet
 * registered, so a strict read would refuse on every run. The residual is a
 * live session missing from a short list whose scratch is already past its
 * floor; the 24 h floor is what covers it.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");

/** The floor under ordinary scratch (mantahostels#2090). */
const SCRATCH_AGE_MS = 24 * 60 * 60 * 1000;
/** The floor under a research or `agents/` artefact, which may await landing. */
const RESEARCH_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A name containing this, prefix or not, marks a research artefact. */
const RESEARCH_WORD = "research";
/** The top-level directory `guard-dispatch-rewrite.sh` supplies artefacts under. */
const AGENTS_DIR = "agents";

/**
 * Top-level entries this sweep never touches — not condemned, not recursed
 * into, at any age.
 *
 * `markers` (and its sibling `state`) hold `scripts/lib/marker-root.js`'s
 * per-session hook markers, moved here from the repository root at F8
 * (mantahostels#3515, issue workflow-core#2 build-order step 4). That family already owns
 * its own liveness-aware retention — `arbiter-markers.js`'s `pruneMarkers`,
 * called at SessionStart — with floors this generic 24 h rule does not
 * agree with: the `.hook-ran-*` breadcrumbs are kept 7 days on purpose
 * (mantahostels#1278), and a 24 h scratch sweep would delete a live one
 * whose writing session had merely gone quiet since.
 */
const EXEMPT_TOP_LEVEL = new Set(["markers"]);

/**
 * The floor a given entry answers to, a directory included: 7 days where its
 * name contains `research` or it sits under top-level `agents/`, else 24 h.
 * @param {string} rel the entry's path relative to the scratch directory
 * @returns {number}
 */
const floorFor = (rel) =>
	rel.split(path.sep)[0] === AGENTS_DIR ||
	path.basename(rel).includes(RESEARCH_WORD)
		? RESEARCH_AGE_MS
		: SCRATCH_AGE_MS;

/**
 * Every entry in `dir`, or `null` where it cannot be read.
 *
 * `withFileTypes` classifies each entry off the `lstat` the directory read
 * already did, so a symlink reads as neither a file nor a directory and the
 * walk never follows one out of the scratch directory.
 *
 * A directory that is simply not there yet is not a fault and names none.
 * Anything else — a permission, an I/O error — is a `fault`, because a
 * directory this reaper can never read is retried at every session start
 * forever.
 * @param {string} dir
 * @returns {{ entries: import("node:fs").Dirent[]|null, fault: string|null }}
 */
function entriesOf(dir) {
	try {
		return {
			entries: fs.readdirSync(dir, { withFileTypes: true }),
			fault: null,
		};
	} catch (e) {
		const { code, message } = caught(e);
		const fault = code === "ENOENT" ? null : `${dir}: ${code || message}`;
		return { entries: null, fault };
	}
}

/**
 * An entry's write time in ms — the later of its mtime and ctime — or `null`
 * where it cannot be read. Both callers age a scratch path by it: this sweep and
 * `check-stray-scratch.js`.
 *
 * `follow: false` is `lstatSync`, a symlink's own times: `statSync` reads the
 * TARGET's, a file outside the scratch directory and none of the sweep's
 * business. The report follows, so a dangling link reads unreadable there.
 *
 * `WFC_SCRATCH_AGE_MTIME_ONLY=1` drops ctime, for a suite that backdates a
 * fixture with `utimesSync` — which sets mtime only — and drives a subprocess
 * no reader can be injected into. Set anywhere else, it brings back workflow-core#1003.
 * @param {string} full
 * @param {{follow?: boolean}} [opts]
 * @returns {number|null}
 */
function writtenAtMs(full, { follow = false } = {}) {
	let st;
	try {
		st = follow ? fs.statSync(full) : fs.lstatSync(full);
	} catch {
		return null;
	}
	if (process.env.WFC_SCRATCH_AGE_MTIME_ONLY === "1") return st.mtimeMs;
	return Math.max(st.mtimeMs, st.ctimeMs);
}

/**
 * Whether anything under `dir` is past its floor — the cheap test that decides
 * whether the ~465 ms oracle read is paid at all.
 *
 * Short-circuits on the first hit, and says nothing about whether that
 * candidate would survive limb 2.
 * @param {string} dir
 * @param {number} now
 * @param {(full: string) => number|null} [timeOf] the entry's write time
 * @param {string} [rel] `dir` relative to the scratch directory
 * @returns {boolean}
 */
function hasAgedCandidate(dir, now, timeOf = writtenAtMs, rel = "") {
	const { entries } = entriesOf(dir);
	if (!entries) return false;
	for (const e of entries) {
		const full = path.join(dir, e.name);
		const relOf = path.join(rel, e.name);
		if (e.isDirectory()) {
			if (isAgedDirectory(full, now, timeOf, relOf)) return true;
		} else if (
			(e.isFile() || e.isSymbolicLink()) &&
			isPastFloor(full, now, timeOf, relOf)
		)
			return true;
	}
	return false;
}

/**
 * Whether a directory holds an aged candidate.
 * @param {string} full
 * @param {number} now
 * @param {(full: string) => number|null} timeOf
 * @param {string} relOf `full` relative to the scratch directory
 * @returns {boolean}
 */
function isAgedDirectory(full, now, timeOf, relOf) {
	if (hasAgedCandidate(full, now, timeOf, relOf)) return true;
	/* An aged EMPTY directory is a candidate in its own right. Counting
	 * files alone would leave one waiting on some unrelated aged file to
	 * trigger the oracle read, so a directory whose last file has gone
	 * would sit there for good on an otherwise quiet scratch directory. */
	const inside = entriesOf(full).entries;
	if (inside === null || inside.length > 0) return false;
	return isPastFloor(full, now, timeOf, relOf);
}

/**
 * @param {string} full
 * @param {number} now
 * @param {(full: string) => number|null} timeOf
 * @param {string} relOf `full` relative to the scratch directory
 * @returns {boolean}
 */
function isPastFloor(full, now, timeOf, relOf) {
	const writtenMs = timeOf(full);
	return writtenMs !== null && now - writtenMs > floorFor(relOf);
}

/**
 * The earliest `startedAt` among the live sessions, in ms — the one number
 * limb 2 needs, since a file is spared exactly where SOME live session predates
 * it.
 *
 * `-Infinity` where any record's start time cannot be read, and on an EMPTY
 * list: both spare every file, the doubt direction `agent-liveness.js`'s
 * contract requires. The empty case does not arise through `listedAgents`,
 * which refuses a list naming no agent at all — but the bare `+Infinity` a
 * fold over nothing produces condemns the whole directory, so it is not left to
 * a neighbour's guard.
 * @param {{startedAt?: unknown}[]} agents
 * @returns {number}
 */
function earliestStart(agents) {
	if (agents.length === 0) return Number.NEGATIVE_INFINITY;
	let earliest = Number.POSITIVE_INFINITY;
	for (const a of agents) {
		const t = Number(a?.startedAt);
		if (!Number.isFinite(t)) return Number.NEGATIVE_INFINITY;
		if (t < earliest) earliest = t;
	}
	return earliest;
}

/**
 * @typedef {object} SweepState the whole walk's state, handed down unchanged
 * @property {number} now
 * @property {number} earliest the earliest live `startedAt`, in ms
 * @property {string[]} deleted paths removed, appended in place
 * @property {string[]} failed paths that could not be, appended in place
 * @property {(full: string) => number|null} timeOf the entry's write time
 */

/**
 * Deletes everything under `dir` that both limbs condemn, depth first, and
 * removes a directory the walk has emptied.
 *
 * Best-effort per entry, like `sweepAged`: housekeeping must not abort partway
 * and leave the rest of the directory unswept. Unlike `sweepAged` it does not
 * do that silently — anything but an already-gone entry goes to `failed`.
 *
 * A SYMLINK IS DELETED LIKE ANY OTHER ENTRY. `unlinkSync` removes the link and
 * never the target, so this stays inside the directory; and a link left behind
 * would make `rmdirSync` on its parent throw ENOTEMPTY for good, immortalising
 * both.
 * @param {string} dir
 * @param {SweepState} sweep accumulator: the walk's state; what is removed and what fails are added
 * @param {object} [level]
 * @param {Set<string>} [level.exemptNames] entry names spared entirely,
 *   checked only at THIS level — never passed to the recursive call, so it
 *   names top-level scratch entries (`EXEMPT_TOP_LEVEL`) rather than anything
 *   nested under them.
 * @param {string} [level.rel] `dir` relative to the scratch directory
 */
function sweepDir(dir, sweep, { exemptNames, rel = "" } = {}) {
	const { entries, fault } = entriesOf(dir);
	if (fault) sweep.failed.push(fault);
	if (!entries) return;
	for (const e of entries) {
		if (exemptNames?.has(e.name)) continue;
		if (!e.isDirectory() && !e.isFile() && !e.isSymbolicLink()) continue;
		sweepEntry(
			path.join(dir, e.name),
			path.join(rel, e.name),
			e.isDirectory(),
			sweep,
		);
	}
}

/**
 * Deletes one entry where both limbs condemn it, sweeping a directory's
 * contents first.
 * @param {string} full
 * @param {string} relOf `full` relative to the scratch directory
 * @param {boolean} isDir
 * @param {SweepState} sweep
 * @returns {void}
 */
function sweepEntry(full, relOf, isDir, sweep) {
	const { now, earliest, timeOf } = sweep;
	/* Read BEFORE the recursion. Deleting a child bumps the parent's mtime and
	 * ctime, so a directory statted afterwards always looks freshly written
	 * and would never clear. */
	const writtenMs = timeOf(full);
	if (writtenMs === null) return;
	const condemned = now - writtenMs > floorFor(relOf) && earliest >= writtenMs;
	if (!isDir) {
		if (condemned) removeFile(full, sweep);
		return;
	}
	sweepDir(full, sweep, { rel: relOf });
	/* `rmdirSync` refuses a non-empty directory, so a survivor inside is
	 * what keeps its directory — no second emptiness test is needed, and a
	 * still-populated one is not a fault. */
	if (condemned) removeDirectory(full, sweep);
}

/**
 * @param {string} full
 * @param {SweepState} sweep accumulator: the entry goes to deleted, or its refusal to failed
 * @returns {void}
 */
function removeDirectory(full, { deleted, failed }) {
	try {
		fs.rmdirSync(full);
		deleted.push(full);
	} catch (e2) {
		const { code, message } = caught(e2);
		if (code !== "ENOENT" && code !== "ENOTEMPTY")
			failed.push(`${full}: ${code || message}`);
	}
}

/**
 * @param {string} full
 * @param {SweepState} sweep accumulator: the entry goes to deleted, or its refusal to failed
 * @returns {void}
 */
function removeFile(full, { deleted, failed }) {
	try {
		fs.unlinkSync(full);
		deleted.push(full);
	} catch (e2) {
		const { code, message } = caught(e2);
		if (code !== "ENOENT") failed.push(`${full}: ${code || message}`);
	}
}

/**
 * Sweeps the scratch directory to mantahostels#2090's gate.
 *
 * @param {object} opts
 * @param {string} opts.dir the scratch directory
 * @param {number} [opts.now] the clock, for the suite
 * @param {() => {agents?: {startedAt?: unknown}[], why?: string}} opts.readAgents
 *   the liveness oracle, injected rather than defaulted so a caller that forgets
 *   it cannot silently sweep with no second opinion at all — the reason
 *   `pruneIssueClaims` takes its own the same way.
 * @param {(where: string, err: Error) => void} opts.logError
 * @param {(full: string) => number|null} [opts.timeOf] an entry's write time,
 *   for the suite.
 * @returns {{deleted: string[], failed: string[], readOracle: boolean,
 *   why?: string}}
 */
function sweepScratch({
	dir,
	now = Date.now(),
	readAgents,
	logError,
	timeOf = writtenAtMs,
}) {
	if (!hasAgedCandidate(dir, now, timeOf))
		return { deleted: [], failed: [], readOracle: false };

	/* Wrapped, though `listedAgents` never throws (`agent-liveness.js`'s
	 * `refuseOnThrow`): that is a neighbour's contract, and an injected oracle
	 * that throws would otherwise reach the CLI's blanket catch and log
	 * nowhere. */
	let listed;
	try {
		listed = typeof readAgents === "function" ? readAgents() : undefined;
	} catch (e) {
		listed = { why: `the liveness oracle threw: ${caught(e).message || e}` };
	}
	if (!listed?.agents) {
		const why = listed?.why || "no liveness oracle was passed";
		logError?.("sweepScratch", new Error(why));
		return { deleted: [], failed: [], readOracle: true, why };
	}

	/** @type {string[]} */
	const deleted = [];
	/** @type {string[]} */
	const failed = [];
	sweepDir(
		dir,
		{ now, earliest: earliestStart(listed.agents), deleted, failed, timeOf },
		{ exemptNames: EXEMPT_TOP_LEVEL },
	);
	/* ONE log line however many entries failed. A directory the reaper cannot
	 * read or a file it cannot remove recurs at every session start, so one
	 * entry per failure per run would bury the log it is reported in. */
	if (failed.length > 0)
		logError?.(
			"sweepScratch",
			new Error(`could not sweep ${failed.length}: ${failed.join("; ")}`),
		);
	return { deleted, failed, readOracle: true };
}

module.exports = {
	earliestStart,
	sweepScratch,
	writtenAtMs,
};

/*
 * THE CLI, which is how the SessionStart launcher runs it
 * (`scripts/sweep-debts-detached.sh`, fifth job). Silent and always 0: nothing
 * waits on it, and its faults go to the arbiter's error log, which
 * `npm run check:guard-errors` reports under `npm run status`.
 *
 * `WFC_SCRATCH_DIR` re-points the directory, for a run against a fixture.
 */
if (require.main === module) {
	try {
		const core = require("./arbiter-core");
		const { listedAgents } = require("./agent-liveness");
		const { hostRoot } = require("./host-root.js");
		sweepScratch({
			dir:
				process.env.WFC_SCRATCH_DIR || path.join(hostRoot(), ".claude", "tmp"),
			/* The self-test waived, per the header. */
			readAgents: () => listedAgents({ requireSelf: false }),
			logError: core.logError,
		});
	} catch {
		/* Housekeeping nobody waits on never fails a session start. */
	}
	process.exit(0);
}
