/*
 * arbiter-issue-claims.js — which session is working which GitHub issue (mantahostels#645).
 *
 * One of arbiter-store.js's family modules — its header holds THE SPLIT RULE
 * (mantahostels#1795), which binds a require added here.
 */

const fs = require("node:fs");
const path = require("node:path");
const { isListedLive } = require("./agent-liveness.js");
const core = require("./arbiter-core.js");
const {
	readCurrentBootId,
	holderAlive,
	readProcStartOf,
} = require("./arbiter-proc.js");
const { sleepSync } = require("./sleep-sync.js");
const { caught } = require("./caught.js");

/** @typedef {import("./arbiter-records.js").IssueClaimRecord} IssueClaimRecord */
/** @typedef {import("./arbiter-records.js").Identity} Identity */
/** @typedef {import("./arbiter-records.js").LivenessOracle} LivenessOracle */

/*
 * WHY THIS EXISTS. Every GitHub assignee on this repo is the one founder
 * login (`login` in the config), whichever session set it, so no liveness read
 * can tell a live claim from a dead one and pick-next.js excluded on the bare
 * assignee — hiding the issue for good. mantahostels#633 ruled option (A),
 * record the claim where a session id lives; this is that record.
 *
 * IT ARBITRATES NOTHING. A file claim refuses a second writer; an issue claim
 * only says who is on the issue, so there is no contention verdict, no break and
 * no --force. Records are keyed by (issue, session) like observations, so two
 * sessions on one issue keep two records and neither erases the other — which
 * also means nothing ever wedges an issue behind a dead session's entry.
 * claimIssueExclusive is the one exception (#530): claim-issue.js's route
 * refuses a live holder, under a mutex of its own.
 *
 * IT FAILS OPEN, DELIBERATELY. A session that assigns itself but never records
 * leaves its issue in the shortlist. The GitHub assignee is untouched and
 * keeps its two jobs: the human-facing record of who did the work, and the
 * input to mantahostels#384's collision annotations. claimIssueExclusive fails
 * closed instead.
 */

/** A week, like the ledgers: long enough that a slow issue keeps its record. */
const ISSUE_CLAIM_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A claim's issue number, or null where the argument is not one.
 * @param {number|string|null} issue
 */
function issueNumber(issue) {
	const n = Number(issue);
	return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * An issue-claim record. Every field one has is named here and nowhere else.
 *
 * No pid and no procStart, unlike a lock: liveness here is the `claude agents
 * --json` oracle, which keys on the session id alone, so a /proc reading would
 * be a second answer nobody consults.
 *
 * @param {{issue: number} & Partial<IssueClaimRecord>} spec
 * @returns {IssueClaimRecord}
 */
function newIssueClaim({
	issue,
	sessionId = null,
	claimedAt = new Date().toISOString(),
}) {
	return { issue, sessionId, claimedAt };
}

/**
 * Every record file on issue `n`, as `{file, record}` — `record` null where
 * the file would not read. Throws where the store directory will not.
 * @param {number} n
 * @returns {{file: string, record: IssueClaimRecord|null}[]}
 */
function scanIssueClaims(n) {
	let files;
	try {
		files = fs.readdirSync(core.paths.issueClaimsDir());
	} catch (e) {
		if (caught(e).code === "ENOENT") return []; // no store yet
		throw e;
	}
	return files
		.filter((f) => f.startsWith(`${n}-`) && f.endsWith(".json"))
		.map((f) => {
			const file = path.join(core.paths.issueClaimsDir(), f);
			return { file, record: core.readRecordOrLog(file, `issue-claims ${n}`) };
		});
}

/**
 * Every record on one issue, whoever holds it. Torn entries are dropped.
 * @param {number|string} issue
 */
function readIssueClaims(issue) {
	const n = issueNumber(issue);
	return n === null ? [] : scanIssueClaims(n).filter((e) => e.record);
}

/**
 * Record that `me` is working issue `n`. Idempotent: re-claiming restamps the
 * session's own record rather than adding a second.
 *
 * A session with no id records nothing and says so — the fail-open case, which
 * leaves the issue selectable.
 * @param {number|string} issue
 * @param {{sessionId: string|null}} me
 */
function claimIssue(issue, me) {
	const n = issueNumber(issue);
	if (n === null) return { status: "invalid" };
	if (!me?.sessionId) return { status: "unidentified" };
	try {
		fs.mkdirSync(core.paths.issueClaimsDir(), { recursive: true });
		const file = core.paths.issueClaim(n, me.sessionId);
		const existing = core.readRecord(file);
		const record = newIssueClaim({
			issue: n,
			sessionId: me.sessionId,
			// The claim dates from when this session first took the issue, not from
			// the last restamp: its age is what a reader of a stale claim needs.
			claimedAt: existing?.claimedAt,
		});
		core.writeRecord(file, record);
		return { status: "claimed", record };
	} catch (e) {
		// Fail open: an unrecorded claim leaves the issue selectable, which is the
		// direction mantahostels#633 chose.
		core.logError(`claim-issue ${n}`, e);
		return { status: "failed", error: e };
	}
}

/**
 * Drop this session's own record on an issue. Another session's is left alone.
 * @param {number|string} issue
 * @param {{sessionId: string|null}} me
 */
function releaseIssue(issue, me) {
	const n = issueNumber(issue);
	if (n === null) return { status: "invalid" };
	if (!me?.sessionId) return { status: "unidentified" };
	try {
		fs.unlinkSync(core.paths.issueClaim(n, me.sessionId));
		return { status: "released" };
	} catch (e) {
		if (caught(e).code === "ENOENT") return { status: "none" };
		// Not "none": a refused unlink leaves the claim standing, and reporting it
		// as nothing-to-drop is mantahostels#174's failure — the reader believes it is gone.
		core.logError(`release-issue ${n}`, e);
		return { status: "failed", error: e };
	}
}

/*
 * The mutex is held for one directory read and one record write, milliseconds,
 * so the wait only ever queues. 5 s is a bound, not a measurement: hundreds of
 * claimants deep before a live holder reads as wedged. The poll is 10 ms, a
 * few holds' length. The wait is overridable so the suite reaches the timeout.
 */
const mutexWaitMs = () => Number(process.env.WFC_CLAIM_WAIT_MS) || 5000;
const MUTEX_POLL_MS = 10;

/**
 * Move a dead or unparseable mutex aside and re-judge it: one that changed
 * holder meanwhile — a fresh one taken in between — is linked back, and the
 * aside copy is dropped either way.
 * @param {string} file
 * @param {{pid?: number, procStart?: string|number}|null} held what was read before the move
 */
function breakStaleMutex(file, held) {
	const aside = `${file}.stale-${process.pid}`;
	try {
		fs.renameSync(file, aside);
		const moved = core.readRecord(aside);
		if (moved?.pid !== held?.pid || moved?.procStart !== held?.procStart)
			fs.linkSync(aside, file);
	} catch {
		/* another claimant broke or re-took it first; go round again */
	}
	fs.rmSync(aside, { force: true });
}

/**
 * Take issue `n`'s mutex and run `fn`, handing it `stillMine` — whether the
 * mutex is still this process's own. `{status: "busy"}` where it could not
 * be taken within mutexWaitMs.
 *
 * A mutex whose process has died, or which will not parse, is moved aside
 * and re-judged before it is dropped, so a fresh one taken in between is put
 * back. Where a third claimant has taken the path meanwhile, two processes
 * believe they hold it; `stillMine` is how the one that lost finds out.
 * @param {number} n
 * @param {(stillMine: () => boolean) => ExclusiveClaim} fn
 * @returns {ExclusiveClaim}
 */
function withIssueMutex(n, fn) {
	const dir = core.paths.issueClaimsDir();
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `.mutex-${n}`);
	const body = {
		pid: process.pid,
		procStart: readProcStartOf(process.pid),
		bootId: readCurrentBootId() || undefined,
	};
	const stillMine = () => {
		const now = core.readRecord(file);
		return now?.pid === body.pid && now?.procStart === body.procStart;
	};
	const deadline = Date.now() + mutexWaitMs();
	while (!core.createOnce(file, body)) {
		if (Date.now() > deadline) return { status: "busy" };
		const held = core.readRecord(file);
		if (held && holderAlive(held)) {
			sleepSync(MUTEX_POLL_MS);
			continue;
		}
		if (!held && !fs.existsSync(file)) continue; // released as we looked
		breakStaleMutex(file, held);
	}
	try {
		return fn(stillMine);
	} finally {
		if (stillMine()) fs.rmSync(file, { force: true });
	}
}

/**
 * Record that `me` is working issue `n` unless another live session already
 * is — the check and the record as one step under the issue's mutex, so two
 * sessions racing for one issue cannot both pass (#530).
 *
 * Unlike claimIssue this FAILS CLOSED: a store it cannot read in full, or a
 * `listed` carrying no ids, refuses rather than records, because a claim
 * taken on doubt may be a second session on work already in flight. That is
 * also why it reads liveness itself rather than through heldIssues, which
 * holds nothing on an unreadable store.
 *
 * `listed` is `listedSessionIds()`'s answer and `listedAt` the epoch ms it was
 * asked at. A holder in its `terminal` set is not live, though the daemon
 * still lists it (#619); an oracle offering no `terminal` set blocks on every
 * listed holder.
 * A record stamped after `listedAt` counts as live whatever `listed` says:
 * its session may have started after the oracle answered.
 *
 * A fresh record is kept only if the mutex is still this process's once it
 * is written; otherwise it is withdrawn as `busy`, so a mutex broken from
 * under it never lets two in.
 * @typedef {{status: "invalid"|"unidentified"|"busy"}
 *   | {status: "unreadable", why: string}
 *   | {status: "held", holder: IssueClaimRecord}
 *   | {status: "claimed"|"reclaimed", record: IssueClaimRecord}} ExclusiveClaim
 * @param {number|string} issue
 * @param {{sessionId: string|null}} me
 * @param {{ids?: Set<string>|null, terminal?: Set<string>, why?: string|null}} listed
 * @param {number} listedAt
 * @returns {ExclusiveClaim}
 */
function claimIssueExclusive(issue, me, listed, listedAt) {
	const n = issueNumber(issue);
	if (n === null) return { status: "invalid" };
	const sessionId = me?.sessionId;
	if (!sessionId) return { status: "unidentified" };
	const live = listed?.ids;
	const terminal = listed?.terminal;
	if (!live)
		return {
			status: "unreadable",
			why: `session liveness could not be read: ${listed?.why || "no answer"}`,
		};
	const dir = core.paths.issueClaimsDir();
	try {
		return withIssueMutex(n, (stillMine) => {
			const scanned = scanIssueClaims(n);
			const torn = scanned.find((e) => !e.record);
			if (torn)
				return {
					status: "unreadable",
					why: `the issue-claim record ${torn.file} could not be read`,
				};
			const records = scanned.map(
				(e) => /** @type {IssueClaimRecord} */ (e.record),
			);
			// The suite's seam: it widens the read-to-write window until a race
			// without the mutex is certain rather than lucky.
			const holdMs = Number(process.env.WFC_CLAIM_HOLD_MS);
			if (holdMs > 0) sleepSync(holdMs);
			const holder = records
				.filter(
					(r) =>
						r.sessionId !== sessionId &&
						(isListedLive(r.sessionId, live, terminal) ||
							Date.parse(r.claimedAt) >= listedAt),
				)
				.sort((a, b) => a.claimedAt.localeCompare(b.claimedAt))[0];
			if (holder) return { status: "held", holder };
			const own = records.find((r) => r.sessionId === sessionId);
			if (own) return { status: "reclaimed", record: own };
			const record = newIssueClaim({ issue: n, sessionId });
			const file = core.paths.issueClaim(n, sessionId);
			core.writeRecord(file, record);
			if (stillMine()) return { status: "claimed", record };
			fs.rmSync(file, { force: true });
			return { status: "busy" };
		});
	} catch (e) {
		const { code, message } = caught(e);
		core.logError(`claim-issue ${n}`, e);
		return {
			status: "unreadable",
			why: `the issue-claim store at ${dir} could not be read or written (${code || message})`,
		};
	}
}

/**
 * Every issue claim on the store, as `{claims, why}` — or `null` where the
 * store itself could not be read at all. `root` names another checkout's
 * store; the host's where absent.
 *
 * `why` is non-null where at least one record file existed but came back
 * empty — torn mid-write, or genuinely corrupt; `readRecordOrLog` cannot tell
 * the two apart (mantahostels#1186).
 * @param {string} [root]
 */
function listIssueClaims(root) {
	const dir = core.paths.issueClaimsDir(root);
	let files;
	try {
		files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch (e) {
		if (caught(e).code === "ENOENT") return { claims: [], why: null }; // no store yet
		core.logError("issue-claims list", e);
		return null;
	}
	const records = files.map((f) =>
		core.readRecordOrLog(path.join(dir, f), "issue-claims list"),
	);
	const dropped = records.filter((r) => !r).length;
	return {
		claims: records.filter(Boolean),
		why: dropped
			? `${dropped} issue-claim record${dropped === 1 ? "" : "s"} could not be read and ${dropped === 1 ? "was" : "were"} dropped, so what is claimed may be incomplete`
			: null,
	};
}

/**
 * `heldIssues`'s map of issue number to holder: every well-formed claim whose
 * session reads live, or every one where `live` is null.
 * @param {NonNullable<ReturnType<typeof listIssueClaims>>["claims"]} claims
 * @param {Set<string>|null} live
 * @param {Set<string>|undefined} terminal
 */
function standingClaims(claims, live, terminal) {
	const held = new Map();
	for (const c of claims) {
		if (!c || typeof c.issue !== "number") continue;
		if (live !== null && !isListedLive(c.sessionId, live, terminal)) continue;
		// First writer wins, so two sessions holding one issue give a stable
		// answer. Which of them is named changes nothing: the issue is excluded
		// either way.
		if (!held.has(c.issue)) held.set(c.issue, c.sessionId);
	}
	return held;
}

/**
 * The issues whose claim still stands, as `{held, why, kept}` — `held` mapping
 * issue number to the session id that recorded it, so a caller can name the
 * holder of a claim carrying no assignee (mantahostels#708).
 *
 * `listed` is what `agent-liveness.js` already answered — `{ids}` or `{why}` —
 * rather than the reader itself, because every caller needs the same oracle
 * for other reads (pick-next.js's admission block, the duplicate gate's live
 * limb) and the call costs ~465 ms.
 *
 * A CLAIM STANDS ON DOUBT. Where the oracle will not answer, every recorded
 * claim is held: narrowing the live set on a partial read is exactly the
 * "treated as unassigned" mistake that would dispatch a second session onto work
 * already in flight. `why` is non-null on any degraded read, so the caller can
 * say which of the two answers it got.
 *
 * An unreadable claim store is the other direction — nothing is held, so nothing
 * is excluded.
 *
 * `kept` is true only where every recorded claim was read and kept on doubt
 * about liveness alone. It reads false in two different situations a caller
 * must not conflate: nothing was read at all (`held` is empty), or something
 * was read but cannot be vouched for as complete (`held` may be non-empty but
 * short) — check `held.size` to tell them apart.
 *
 * A store that opened but dropped a record on the way (`listIssueClaims`'s own
 * `why`) is the second situation: `held` may be missing an entry
 * entirely, which no amount of "keep on doubt" can repair, so this refuses
 * the same way as a store that would not open — `kept: false` — rather than
 * reporting a held set it cannot vouch for as complete. Residual: where the
 * liveness oracle ALSO failed to answer, `kept: false` here means the
 * `claimHolder`-style ", liveness unread" caveat some callers append only on
 * `kept: true` goes unsaid — `why` still names both failures, just not that
 * suffix.
 * A holder in `listed.terminal` holds nothing, as in claimIssueExclusive.
 * `root` reads another checkout's store, as listIssueClaims does.
 * @param {{ids?: Set<string>|null, terminal?: Set<string>, why?: string|null}|null} listed
 * @param {string} [root]
 */
function heldIssues(listed, root) {
	const listedClaims = listIssueClaims(root);
	if (listedClaims === null)
		return {
			held: new Map(),
			kept: false,
			why: "the issue-claim store could not be read, so no assignment was checked against it",
		};
	const { claims, why: claimsWhy } = listedClaims;
	const live = listed?.ids ?? null;
	const terminal = listed?.terminal;
	const held = standingClaims(claims, live, terminal);
	if (claimsWhy) {
		const liveWhy =
			live === null ? listed?.why || "liveness was not read at all" : null;
		return {
			held,
			kept: false,
			why: liveWhy ? `${claimsWhy}; also, ${liveWhy}` : claimsWhy,
		};
	}
	return {
		held,
		kept: live === null,
		why: live === null ? listed?.why || "liveness was not read at all" : null,
	};
}

/**
 * Drop the claims of sessions that are both finished and old — the same shape as
 * pruneLedgers, and for the same reason: a resumed session keeps its id across a
 * quiet week, so age alone cannot stand in for finished.
 *
 * IT SPARES ON BOTH ORACLES, AND ON DOUBT FROM EITHER (mantahostels#704). `claude agents
 * --json` — passed in as `liveness`, the same reader heldIssues is handed — is
 * the one that gates the exclusion, so a claim it calls live must survive here
 * however old it is; a sweep on the registry alone would delete a live session's
 * claim out from under it, and selection would then dispatch a second session
 * onto work in flight. The registry reading is kept alongside it rather than
 * replaced: it re-resolves a session id across a resume, so it holds sessions
 * the oracle may have dropped.
 *
 * EITHER ORACLE REFUSING SWEEPS NOTHING — mantahostels#174 for the registry, and the same
 * keep-on-doubt rule heldIssues follows for the agents oracle. RESIDUAL: an
 * unreadable oracle lets records accumulate, which is affordable — pruning is
 * housekeeping only, and liveness is what gates the exclusion (mantahostels#704).
 * @param {LivenessOracle} liveness
 */
function pruneIssueClaims(liveness) {
	const live = core.readLiveOrLog("pruneIssueClaims");
	if (live === null) return; // cannot tell live from finished: delete nothing
	const byRegistry = (/** @type {string} */ f) =>
		[...live].some((id) => f.endsWith(core.pairSuffix(id)));

	/*
	 * The oracle is asked only once something would actually be deleted. It costs
	 * ~465 ms (mantahostels#317) and this runs at every session start, where nothing is
	 * usually old enough to sweep — so the common path must not pay for it.
	 */
	if (
		!core.agedUnspared(
			core.paths.issueClaimsDir(),
			ISSUE_CLAIM_AGE_MS,
			byRegistry,
		)
	)
		return;

	// Not a default argument: the oracle is injected the way forceRelease takes
	// it, so a caller that forgets it must not silently fall back to the registry
	// alone.
	const listed = typeof liveness === "function" ? liveness() : {};
	if (!listed?.ids) {
		core.logError(
			"pruneIssueClaims",
			new Error(listed?.why || "no liveness oracle was passed"),
		);
		return;
	}
	const spared = new Set(
		[...live, ...listed.ids].map((id) => core.pairSuffix(id)),
	);
	core.sweepAged(core.paths.issueClaimsDir(), ISSUE_CLAIM_AGE_MS, (f) =>
		[...spared].some((s) => f.endsWith(s)),
	);
}

module.exports = {
	claimIssue,
	claimIssueExclusive,
	heldIssues,
	listIssueClaims,
	pruneIssueClaims,
	readIssueClaims,
	releaseIssue,
};
