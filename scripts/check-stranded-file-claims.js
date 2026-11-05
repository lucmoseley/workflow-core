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
 * IT ALSO REPORTS A STRANDED WORKTREE (#4244): a linked worktree carrying
 * uncommitted work whose owning session (lib/session-worktrees.js) is not
 * listed live, untouched past the same threshold, its files listed under that
 * session in both modes. A claim's file counts as carrying work where it is
 * dirty in the main checkout or in a worktree its holder owns.
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), reports the standing count of file claims whose holder has plausibly finished, itemising those that carry uncommitted work; and each finished session's worktree that carries uncommitted work. It never breaks a claim.
 * JUSTIFIED: fail-safe — a claim outliving its host warns every later writer of that path of a merge conflict that is not there, and nothing else notices. A run that cannot tell live from finished reports nothing rather than calling a claim dead.
 * DEFEAT:    none; --hours <n> moves both reporting thresholds on a hand run.
 */

const { buildArbiterCommand } = require("./lib/build-arbiter-command.js");
const { runCheck } = require("./lib/check");
const { scriptPath } = require("./lib/script-path.js");
const { claudeBin, listedSessionIds } = require("./lib/agent-liveness");
const {
	STRANDED_AFTER_HOURS,
	hoursHeld,
	readDirtyPaths,
	readDirtyWorktrees,
	attributeWorktreeDirt,
	dirtByTree,
	classifyWorktrees,
	isDirtyClaim,
	classifyClaims,
} = require("./lib/stranded-count");
const { worktreeLabel } = require("./lib/session-worktrees.js");

// The arbiter's module, not its CLI: session-arbiter.js exports nothing (mantahostels#158).
const { readLocks, paths } = require("./lib/arbiter-store");

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
/** @typedef {import("./lib/arbiter-store").ListedLock} Lock */
/** @typedef {import("./lib/stranded-count").WorktreeDirt} WorktreeDirt */
/**
 * @typedef {{path: string, tree?: string, sessionId: string,
 *   pid: number | null, claimedAt: string | null,
 *   hoursHeld: number | null}} Stranded
 *   `tree` the holder's worktree, absent for the main checkout (#4457)
 * @typedef {{file?: string, path?: string, reason: string}} Unreadable
 */

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
 * @param {(s: Stranded) => boolean} isDirty
 */
function buildItemLine(ctx, s, isDirty) {
	if (ctx.notify)
		return `  ${s.path} — ${describeAge(s.hoursHeld)} by ${s.sessionId.slice(0, 8)}`;
	const where = s.tree
		? ` (in ${worktreeLabel(paths.repoRoot(), s.tree)})`
		: "";
	return `  ${s.path}${where}${isDirty(s) ? "  [uncommitted work]" : ""}\n    ${s.sessionId} (pid ${s.pid ?? "unknown"}), ${describeAge(s.hoursHeld)}, since ${s.claimedAt || "unknown"}`;
}

/**
 * @param {Ctx} ctx
 * @param {{itemised: Stranded[], carrying: Stranded[],
 *   isDirty: (s: Stranded) => boolean}} opts
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
 * A finished session's worktree carrying uncommitted work, listed under that
 * session in both modes: every one is work to recover (#4244).
 * @param {Ctx} ctx
 * @param {{trees: WorktreeDirt[], hours: number, root: string,
 *   nameOf: (id: string) => string}} opts
 */
function sayStrandedWorktrees(ctx, { trees, hours, root, nameOf }) {
	for (const t of trees)
		ctx.warn(
			"STRANDED-WORKTREE",
			`${worktreeLabel(root, t.worktree)} — ${t.dirty.size} uncommitted file(s) of ${ownerName(t, nameOf)}, which is no longer listed or which the oracle has marked done, failed or stopped`,
			strandedWorktreeData(t),
		);
	if (trees.length === 0) return;
	ctx.say(
		`\nSTRANDED-WORKTREE (${trees.length}) — a worktree carrying uncommitted work whose session is not listed by ${claudeBin()} agents, or listed but no longer working, untouched over ${hours}h:`,
	);
	for (const t of trees) {
		const label = worktreeLabel(root, t.worktree);
		ctx.say(
			`  ${ownerName(t, nameOf)} — ${label}, last written ${t.writtenMs === null ? "at an unreadable time" : `${ageOf((Date.now() - t.writtenMs) / 3_600_000)} ago`}`,
		);
		for (const p of [...t.dirty].sort()) ctx.say(`    ${p}`);
	}
	ctx.say(
		"\n  Read each diff in its worktree (`git -C <worktree> diff HEAD`, and\n" +
			"  `git -C <worktree> status` for new files), then commit and land it or\n" +
			"  discard it. Nothing was touched.\n",
	);
}

/**
 * @param {WorktreeDirt} t
 * @param {(id: string) => string} nameOf
 */
const ownerName = (t, nameOf) =>
	`${t.owner.name || nameOf(t.owner.sessionId)} (${t.owner.sessionId.slice(0, 8)})`;

/** @param {WorktreeDirt} t */
const strandedWorktreeData = (t) => ({
	worktree: t.worktree,
	sessionId: t.owner.sessionId,
	name: t.owner.name,
	files: [...t.dirty].sort(),
	writtenAt: t.writtenMs === null ? null : new Date(t.writtenMs).toISOString(),
});

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
				`  See what is held: ${buildArbiterCommand`list --all`}\n`,
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

/**
 * What the run could not read of the worktrees, as a clause for the okLine:
 * empty where it read them all (#4244). Never a finding: a registration whose
 * directory has gone is the usual cause, and the reaper prunes it (#4247).
 * @param {import("./lib/stranded-count").DirtyWorktrees["unreadable"]} unreadable
 */
function unreadWorktrees(unreadable) {
	if (unreadable === null)
		return " git would not list the worktrees, so whether one carries a finished session's work is unknown.";
	if (unreadable.length === 0) return "";
	return ` ${unreadable.length} registered worktree(s) git would not read went unjudged: ${unreadable.join(", ")}.`;
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

		// null is a store that would not open, never an empty one (mantahostels#174) — and the
		// store lives outside the repo, so it is SKIP, not BROKEN (lib/check.js's
		// subject/apparatus split).
		const locks = readLocks();
		if (locks === null) {
			ctx.skip(
				`the file-claim store at ${paths.locksDir()} could not be read, so what is held is unknown — not nothing. See: node ${scriptPath("check-guard-errors.js")}`,
			);
		}
		/* Read before the oracle, so a run with no claim and no dirty worktree
		 * still spends no oracle call. */
		const dirtyTrees = readDirtyWorktrees();
		if (locks.length === 0 && dirtyTrees.found.length === 0) {
			return {
				okLine: `no files are claimed, and no worktree carries uncommitted work.${unreadWorktrees(dirtyTrees.unreadable)}`,
				data: { claims: 0 },
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
		const { ids, why, names, terminal, cwds } = listedSessionIds();
		// Counted over the records that PARSE. An unreadable one did not go
		// unjudged for want of the oracle, and readLocks() surfaces those rather
		// than dropping them (mantahostels#1692), so `locks.length` would fold them in.
		if (!ids) {
			ctx.skip(
				`${why}. ${locks.filter((l) => !l.unreadable).length} file claim(s) and ${dirtyTrees.found.length} dirty worktree(s) went unjudged — none of them is being called stranded on an oracle this run could not read.`,
			);
		}
		const nameOf = (/** @type {string} */ id) => names?.get(id) || id;

		// The classification loop itself lives in lib/stranded-count.js, shared
		// with pick-next.js's headline count (mantahostels#1800) — this reader keeps only its
		// own presentation shapes and the dirty-file annotation below.
		const buckets = classifyClaims(locks, ids, { hours, terminal });

		// Reported by filename and skipped, never allowed to end the run (mantahostels#1692).
		const unreadable = buckets.unreadable.map(unreadableEntry);

		const stranded = buckets.stranded.map((lock) => ({
			path: lock.path,
			...(lock.tree ? { tree: lock.tree } : {}),
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
		const worktrees = attributeWorktreeDirt(dirtyTrees.found, { cwds, names });
		const dirt = dirtByTree(dirty, dirtyTrees.found);
		const isDirty = (/** @type {Stranded} */ s) => isDirtyClaim(dirt, s);
		const carrying = dirty ? stranded.filter(isDirty) : [];
		const trees = classifyWorktrees(worktrees, ids, { hours, terminal });
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
		sayStrandedWorktrees(ctx, {
			trees: trees.stranded,
			hours,
			root: paths.repoRoot(),
			nameOf,
		});
		sayClosingAdvice(ctx, { itemised, unreadable });

		return {
			okLine: `${okLineFor({ stranded, dirty, locks, hours })}${unreadWorktrees(dirtyTrees.unreadable)}`,
			noun: "possibly-stranded file claim(s) or worktree(s)",
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
				strandedWorktrees: trees.stranded.map(strandedWorktreeData),
				strandedWorktreeCount: trees.stranded.length,
				youngWorktrees: trees.young,
			},
		};
	},
});
