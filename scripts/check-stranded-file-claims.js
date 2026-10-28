#!/usr/bin/env node
/*
 * check-stranded-file-claims.js — report a FILE claim whose holder has plausibly
 * finished. It never breaks one.
 *
 * Usage:  npm run check:file-claims  [--hours <n>] [--notify] [--json]
 *
 * NOT check-stale-claims.js, which reports a GitHub issue ASSIGNEE held over 14
 * days — an unrelated sense of "claim".
 *
 * WHAT IT IS FOR (mantahostels#254 — a claim outliving its session on a pooled host cannot
 * be released). A claim runs from a session's first write until the holder
 * releases it, its own commit lands all its hunks (#2058, #2148), or its process ends. A host that outlives its job leaves the claim
 * standing with nobody behind it, and nothing tells anyone.
 *
 * REPORT-ONLY IS THE WHOLE DESIGN (mantahostels#318 — whether the no-timeout ruling survives
 * the pooled-host finding), not a first phase. mantahostels#318 refused expiry outright: no
 * TTL, no heartbeat, mantahostels#104 stands. This sweep is what bounds the wedge instead.
 *
 * THE ORACLE IS `claude agents --json`, read through lib/agent-liveness.js.
 * Deliberately NOT the arbiter's own liveness test, which `list` uses: that
 * reads pid and procStart frozen into the lock at claim time.
 *
 * DEGRADES TO SILENCE, NEVER TO "DEAD". Every doubt the reader returns as a
 * `why` exits through ctx.skip(), which raises no finding at all.
 *
 * IT REPORTS; A HUMAN DECIDES. Same rule as check-stale-claims.js: a claim held
 * across a slow decision looks identical from the outside to an abandoned one.
 * So WARN, never FAIL — and under --notify every outcome exits 0, as a
 * SessionStart hook must: Claude Code reads a non-zero one as the hook itself
 * being broken (mantahostels#155, the checker family's exit-code and severity model). No
 * hook runs this one now.
 *
 * LOCAL ONLY. It reads the claim store under ~/.claude and asks the local daemon
 * what is running; a CI runner would find neither and report all-clear forever.
 *
 * WHAT --notify SAYS (mantahostels#1747: a notice given
 * once goes silent on a pile that never drains). It prints a STANDING count on
 * every run, and itemises only the claims that carry UNCOMMITTED WORK.
 *
 * A HAND RUN itemises everything standing, annotating which paths are dirty.
 *
 * IT ALSO REPORTS AN UNANSWERED RELEASE REQUEST (mantahostels#1784, spec mantahostels#1702's story
 * 18) — the one route to a holder that stays idle forever, since the in-band
 * notice at `claim`/`release` only fires when the holder next does something.
 * A request past the same threshold, not declined, names the path, requester,
 * holder and age, in both modes: this is the founder's own escape hatch, so a
 * hand run has to see it exactly as a --notify run does. This script only
 * ever reads the request register — nothing here answers, declines or drops
 * a request.
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), reports the standing count of file claims whose holder has plausibly finished, itemising those that carry uncommitted work; and any release request nobody has answered past the threshold. It never breaks a claim and never answers a request.
 * JUSTIFIED: fail-safe — a claim outliving its host blocks every later session's write to that path and nothing else notices; a request nobody answers reaches no holder that stays idle forever except through the founder acting on this line. A run that cannot tell live from finished reports nothing rather than calling a claim dead.
 * DEFEAT:    none; --hours <n> moves both reporting thresholds on a hand run.
 */

const { runCheck } = require("./lib/check");
const { scriptPath } = require("./lib/script-path.js");
const { claudeBin, listedSessionIds } = require("./lib/agent-liveness");
const {
	STRANDED_AFTER_HOURS,
	hoursHeld,
	readDirtyPaths,
	isDirtyClaim,
	classifyClaims,
} = require("./lib/stranded-count");

// The arbiter's module, not its CLI: session-arbiter.js exports nothing (mantahostels#158).
const { readLocks, readRequests, paths } = require("./lib/arbiter-store");

/**
 * An age with no verb — "11d", "18h" — for a sentence that supplies its own.
 * @param {number | null} hours
 */
function ageOf(hours) {
	if (hours === null) return "an unreadable time";
	return hours < 48 ? `${Math.floor(hours)}h` : `${Math.floor(hours / 24)}d`;
}

/** @param {number | null} hours */
const describeAge = (hours) =>
	hours === null ? "held since an unreadable time" : `held ${ageOf(hours)}`;

/** @typedef {import("./lib/check").Ctx} Ctx */
/** @typedef {import("./lib/arbiter-store").RequestRecord} RequestRecord */
/** @typedef {import("./lib/arbiter-store").ListedLock} Lock */
/**
 * @typedef {{path: string, sessionId: string, pid: number | null,
 *   claimedAt: string | null, hoursHeld: number | null}} Stranded
 * @typedef {{file?: string, path?: string, reason: string}} Unreadable
 */

/**
 * @param {RequestRecord[] | null} requests
 * @param {number} hours
 */
function unansweredRequests(requests, hours) {
	return (requests || []).filter((r) => {
		if (r.declined) return false;
		const held = hoursHeld(r.since);
		// An unreadable `since` is reported, not suppressed: the threshold
		// only exists to keep noise down.
		return held === null || held >= hours;
	});
}

/**
 * @param {RequestRecord} r
 * @param {(id: string) => string} nameOf
 */
const holderName = (r, nameOf) =>
	r.holder ? nameOf(r.holder) : "an unknown holder";

/**
 * Warn + say the unanswered-request findings. Called exactly once.
 * @param {Ctx} ctx
 * @param {{requests: RequestRecord[] | null, unanswered: RequestRecord[],
 *   hours: number, nameOf: (id: string) => string}} opts
 */
function reportUnanswered(ctx, { requests, unanswered, hours, nameOf }) {
	if (requests === null) {
		const msg = `the release-request register could not be read, so whether anyone is waiting on a held file is unknown — not nothing. See: node ${scriptPath("check-guard-errors.js")}`;
		ctx.warn("UNREADABLE-REQUESTS", msg);
		ctx.say(`\nUNREADABLE-REQUESTS: ${msg}`);
	}
	for (const r of unanswered)
		ctx.warn(
			"UNANSWERED-REQUEST",
			`${r.subject} — ${nameOf(r.requester)} asks ${holderName(r, nameOf)} to release, unanswered for ${ageOf(hoursHeld(r.since))}`,
			r,
		);
	if (unanswered.length === 0) return;
	// Said in both modes, unlike the claims sections below.
	ctx.say(
		`\nUNANSWERED-REQUEST (${unanswered.length}) standing — a release request nobody has answered past ${hours}h. This sweep cannot deliver it; go to the holder's terminal yourself.`,
	);
	for (const r of unanswered)
		ctx.say(
			`  ${r.subject} — ${nameOf(r.requester)} asks ${holderName(r, nameOf)}, unanswered for ${ageOf(hoursHeld(r.since))}${r.why ? `: "${r.why}"` : ""}`,
		);
}

/**
 * `lock.unreadable` distinguishes the two reasons classifyClaims folds
 * into one verdict: a lock file that would not parse at all, or one that
 * parsed but names no session.
 * @param {Lock} lock
 * @returns {Unreadable}
 */
function unreadableEntry(lock) {
	if (!lock.unreadable)
		return {
			path: lock.path,
			reason:
				"the lock names no session, so nothing can be asked about its holder",
		};
	return {
		file: lock.file,
		reason:
			lock.reason === "refused"
				? "the lock file could not be read at all"
				: "the lock file itself would not parse",
	};
}

/**
 * The longest a stranded claim has been held, or null where none is readable.
 * @param {Stranded[]} stranded
 */
function oldestHours(stranded) {
	return stranded.reduce(
		(/** @type {number | null} */ max, s) =>
			s.hoursHeld === null || (max !== null && max >= s.hoursHeld)
				? max
				: s.hoursHeld,
		null,
	);
}

/**
 * The hand run's header, then a WARN per itemised claim and unreadable lock.
 * @param {Ctx} ctx
 * @param {{locks: Lock[], listed: number, stranded: Stranded[],
 *   unreadable: Unreadable[], itemised: Stranded[]}} opts
 */
function warnFindings(ctx, { locks, listed, stranded, unreadable, itemised }) {
	// The header rides the findings rather than printing unconditionally: under
	// --notify say() goes to the session's context, so a clean sweep must be
	// silent or every run carries a line nobody reads. Dropped there
	// entirely: the standing-count line below carries the same facts in one.
	if (!ctx.notify && (stranded.length > 0 || unreadable.length > 0))
		ctx.say(
			`Checked ${locks.length} file claim(s) against ${listed} listed session(s).\n`,
		);

	// WARN only on what is actionable under --notify: the inert majority is a
	// count, not an alarm — a STALE claim is retaken on sight and wedges
	// nothing (lib/arbiter-locks.js, breakStale).
	for (const s of itemised)
		ctx.warn(
			"STRANDED-CLAIM",
			`${s.path} — ${describeAge(s.hoursHeld)} by session ${s.sessionId}, which is no longer listed or which the oracle has marked done, failed or stopped`,
			s,
		);
	for (const u of unreadable)
		ctx.warn("UNREADABLE-LOCK", `${u.path || u.file} — ${u.reason}`, u);
}

/**
 * @param {Ctx} ctx
 * @param {Unreadable[]} unreadable
 */
function sayUnreadableLocks(ctx, unreadable) {
	if (unreadable.length === 0) return;
	ctx.say(`\nUNREADABLE-LOCK (${unreadable.length}):`);
	for (const u of unreadable) ctx.say(`  ${u.path || u.file}\n    ${u.reason}`);
}

/**
 * The STRANDED-CLAIM headline and what is known of the tree under it.
 * @param {Ctx} ctx
 * @param {{stranded: Stranded[], hours: number, oldest: number | null,
 *   dirty: Set<string> | null, carrying: Stranded[]}} opts
 */
function sayStrandedHeadline(
	ctx,
	{ stranded, hours, oldest, dirty, carrying },
) {
	if (stranded.length === 0) return;
	ctx.say(
		`STRANDED-CLAIM (${stranded.length}) standing — holder not listed by ${claudeBin()} agents, or listed but no longer working, claim standing over ${hours}h${
			oldest === null ? "" : `, oldest ${ageOf(oldest)}`
		}.`,
	);
	// Said in BOTH modes: a hand run that stayed quiet here would print its
	// list with every `[uncommitted work]` annotation missing, which reads
	// exactly like a clean tree.
	if (dirty === null)
		ctx.say(
			"  `git status` would not answer, so which of them carry uncommitted work\n" +
				"  is unknown — none is being called clean on it.\n",
		);
	if (ctx.notify && dirty !== null && carrying.length === 0)
		ctx.say(
			"  None carries uncommitted work — nothing to recover, and each is retaken\n" +
				"  automatically by the next session that writes the file.\n",
		);
}

/**
 * One itemised claim: one line under --notify, two on a hand run.
 * @param {Ctx} ctx
 * @param {Stranded} s
 * @param {(p: string) => boolean} isDirty
 */
function buildItemLine(ctx, s, isDirty) {
	if (ctx.notify)
		return `  ${s.path} — ${describeAge(s.hoursHeld)} by ${s.sessionId.slice(0, 8)}`;
	return `  ${s.path}${isDirty(s.path) ? "  [uncommitted work]" : ""}\n    ${s.sessionId} (pid ${s.pid ?? "unknown"}), ${describeAge(s.hoursHeld)}, since ${s.claimedAt || "unknown"}`;
}

/**
 * @param {Ctx} ctx
 * @param {{itemised: Stranded[], carrying: Stranded[],
 *   isDirty: (p: string) => boolean}} opts
 */
function sayItemised(ctx, { itemised, carrying, isDirty }) {
	if (itemised.length === 0) return;
	if (ctx.notify)
		ctx.say(
			`\n  ${carrying.length} of them carr${carrying.length === 1 ? "ies" : "y"} UNCOMMITTED WORK — left by a session that is not coming back:`,
		);
	// One line each under --notify: this lands in every session's context,
	// where a dozen two-line entries is most of a screen.
	for (const s of itemised) ctx.say(buildItemLine(ctx, s, isDirty));
}

/**
 * @param {Ctx} ctx
 * @param {{itemised: Stranded[], unreadable: Unreadable[]}} opts
 */
function sayClosingAdvice(ctx, { itemised, unreadable }) {
	if (ctx.notify && itemised.length > 0)
		ctx.say(
			"\n  Read the diff, then commit or revert it. Nothing was released, and this\n" +
				"  sweep has no way to release anything; the claim itself needs no action.\n",
		);
	if (!ctx.notify && (itemised.length > 0 || unreadable.length > 0))
		ctx.say(
			"\n  Nothing was released, and this sweep has no way to release anything.\n" +
				"  What to do: if such a file carries an uncommitted edit, it is the work of\n" +
				"  a session that is not coming back — read the diff, then commit or revert it.\n" +
				"  The claim itself needs no action: it is retaken automatically by the next\n" +
				"  session that writes the file, once the holder's process is genuinely gone.\n" +
				// --all, not a bare `list`: the default view prints LIVE claims only
				// (mantahostels#1814), and a stranded claim is by definition a dead one.
				"  See what is held: node scripts/session-arbiter.js list --all\n",
		);
}

/**
 * @param {{stranded: Stranded[], dirty: Set<string> | null, locks: Lock[],
 *   hours: number}} opts
 */
function okLineFor({ stranded, dirty, locks, hours }) {
	if (stranded.length === 0)
		return `every one of ${locks.length} file claim(s) is held by a listed session or younger than ${hours}h.`;
	return `${stranded.length} stranded file claim(s) standing, ${dirty === null ? "and whether any carries uncommitted work could not be read." : "none of them carrying uncommitted work."}`;
}

runCheck({
	name: "stranded-file-claims",
	usage: "node check-stranded-file-claims.js [--hours <n>] [--notify] [--json]",
	valueFlags: ["--hours"],
	/** @param {import("./lib/check").Ctx} ctx */
	run(ctx) {
		const hours = ctx.has("--hours")
			? Number(ctx.value("--hours"))
			: STRANDED_AFTER_HOURS;
		if (!Number.isFinite(hours) || hours < 0)
			ctx.usageError("--hours must be a non-negative number.");

		/*
		 * Release requests nobody has answered past the threshold. Read and
		 * reported FIRST, before any of the claim-store/oracle machinery below:
		 * the register is a separate directory that a request can stand in even
		 * where a lock cannot be read, and this escape hatch must not go silent
		 * exactly when the rest of the sweep is degraded.
		 *
		 * readRequests() already drops what this report must never show: a
		 * request whose requester is no longer live, and — by construction, since
		 * cmdClaim/cmdRelease unlink the record on each — one the requester has
		 * since claimed or the holder has since released. `null` here means the
		 * register would not read, which costs this section alone, reported as
		 * UNREADABLE-REQUESTS rather than folded into "no requests standing".
		 */
		const requests = readRequests();
		const unanswered = unansweredRequests(requests, hours);

		// `nameOf` starts as the identity function and is upgraded below once the
		// oracle has been read for the claims loop — reportUnanswered() may fire
		// before that point, on any of the three early exits, and prints the raw
		// session id rather than delay the founder's escape hatch on a call this
		// section does not itself need.
		let nameOf = (/** @type {string} */ id) => id;

		const sayUnanswered = () =>
			reportUnanswered(ctx, { requests, unanswered, hours, nameOf });

		// null is a store that would not open, never an empty one (mantahostels#174) — and the
		// store lives outside the repo, so it is SKIP, not BROKEN (lib/check.js's
		// subject/apparatus split).
		const locks = readLocks();
		if (locks === null) {
			sayUnanswered();
			ctx.skip(
				`the file-claim store at ${paths.locksDir()} could not be read, so what is held is unknown — not nothing. See: node ${scriptPath("check-guard-errors.js")}`,
			);
		}
		if (locks.length === 0) {
			sayUnanswered();
			return {
				okLine: "no files are claimed.",
				data: {
					claims: 0,
					unanswered,
					unansweredCount: unanswered.length,
					requestsReadable: requests !== null,
				},
			};
		}

		/*
		 * THE STRICT READER, NOT THE SWEEP'S WAIVER (#1390). mantahostels#1924 waived the
		 * self-test while this was a SessionStart hook, whose starting session the
		 * daemon had not registered yet (mantahostels#535). Its callers now — `npm run
		 * status`, `check:file-claims` — run mid-session, where the oracle lists
		 * its caller, interactive or background (docs/environment.md §Counting live
		 * sessions), or from a plain terminal, where there is no session to test.
		 * A caller it omits now means a short list, and
		 * on a short list a live neighbour's claim would read stranded and, under
		 * --notify, its dirty file be put to the founder to commit or revert —
		 * mantahostels#250's hazard. So the self-test refuses, and the claims go unjudged.
		 * pick-next.js's headline reads the same strict answer.
		 */
		const { ids, why, names, terminal } = listedSessionIds();
		// Counted over the records that PARSE. An unreadable one did not go
		// unjudged for want of the oracle, and readLocks() surfaces those rather
		// than dropping them (mantahostels#1692), so `locks.length` would fold them in.
		if (!ids) {
			sayUnanswered();
			ctx.skip(
				`${why}. ${locks.filter((l) => !l.unreadable).length} file claim(s) went unjudged — none of them is being called stranded on an oracle this run could not read.`,
			);
		}
		nameOf = (/** @type {string} */ id) => names?.get(id) || id;

		// The classification loop itself lives in lib/stranded-count.js, shared
		// with pick-next.js's headline count (mantahostels#1800) — this reader keeps only its
		// own presentation shapes and the dirty-file annotation below.
		const buckets = classifyClaims(locks, ids, { hours, terminal });

		// Reported by filename and skipped, never allowed to end the run (mantahostels#1692).
		const unreadable = buckets.unreadable.map(unreadableEntry);

		const stranded = buckets.stranded.map((lock) => ({
			path: lock.path,
			sessionId: lock.sessionId,
			pid: lock.pid ?? null,
			claimedAt: lock.claimedAt ?? null,
			hoursHeld: hoursHeld(lock.claimedAt),
		}));

		const young = buckets.young.length;

		/*
		 * Which of the standing claims sit on a file carrying uncommitted work —
		 * the only ones a reader can act on. `null` is a working tree git would not
		 * report on, which is NOT the same as none of them being dirty, and the
		 * report below says so rather than implying a clean tree. The subject
		 * matching and its region caveat belong to lib/stranded-count.js (mantahostels#1780).
		 */
		const dirty = readDirtyPaths();
		const isDirty = (/** @type {string} */ p) => isDirtyClaim(dirty, p);
		const carrying = dirty ? stranded.filter((s) => isDirty(s.path)) : [];
		const oldest = oldestHours(stranded);

		const itemised = ctx.notify ? carrying : stranded;

		warnFindings(ctx, {
			locks,
			listed: ids.size,
			stranded,
			unreadable,
			itemised,
		});

		sayStrandedHeadline(ctx, { stranded, hours, oldest, dirty, carrying });
		sayItemised(ctx, { itemised, carrying, isDirty });
		sayUnreadableLocks(ctx, unreadable);
		sayUnanswered();
		sayClosingAdvice(ctx, { itemised, unreadable });

		return {
			okLine: okLineFor({ stranded, dirty, locks, hours }),
			noun:
				unanswered.length > 0
					? "possibly-stranded file claim(s) or unanswered release request(s)"
					: "possibly-stranded file claim(s)",
			data: {
				stranded,
				strandedCount: stranded.length,
				// The actionable subset: standing claims on a path with uncommitted
				// work. Empty where the tree could not be read — `dirtyReadable` is
				// what tells those two cases apart.
				carrying,
				carryingCount: carrying.length,
				dirtyReadable: dirty !== null,
				unreadable,
				young,
				claims: locks.length,
				listed: ids.size,
				thresholdHours: hours,
				unanswered,
				unansweredCount: unanswered.length,
				requestsReadable: requests !== null,
			},
		};
	},
});
