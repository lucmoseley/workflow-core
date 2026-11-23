#!/usr/bin/env node

const {
	describeAge: describeAgeText,
	HOUR_MS,
	NEVER,
} = require("./lib/age-text.js");
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

const { readLocks, paths } = require("./lib/arbiter-store");

/** @param {number | null} hours */
function ageOf(hours) {
	if (hours === null) return "an unreadable time";
	return describeAgeText(hours * HOUR_MS, { minutesUnder: NEVER });
}

/** @param {number | null} hours */
const describeAge = (hours) =>
	hours === null ? "held since an unreadable time" : `held ${ageOf(hours)}`;

/** @typedef {import("./lib/check").Ctx} Ctx */
/** @typedef {import("./lib/arbiter-store").ReadLock} Lock */
/** @typedef {import("./lib/stranded-count").WorktreeDirt} WorktreeDirt */
/**
 * @typedef {{path: string, tree?: string, sessionId: string,
 *   pid: number | null, claimedAt: string | null,
 *   hoursHeld: number | null}} Stranded
 * @typedef {{file?: string, path?: string, reason: string}} Unreadable
 */

/**
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

/** @param {Stranded[]} stranded */
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
 * @param {Ctx} ctx
 * @param {{locks: Lock[], listed: number, stranded: Stranded[],
 *   unreadable: Unreadable[], itemised: Stranded[]}} opts
 */
function warnFindings(ctx, { locks, listed, stranded, unreadable, itemised }) {
	if (!ctx.notify && (stranded.length > 0 || unreadable.length > 0))
		ctx.say(
			`Checked ${locks.length} file claim(s) against ${listed} listed session(s).\n`,
		);

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
	for (const s of itemised) ctx.say(buildItemLine(ctx, s, isDirty));
}

/**
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

/** @param {import("./lib/stranded-count").DirtyWorktrees["unreadable"]} unreadable */
function unreadWorktrees(unreadable) {
	if (unreadable === null)
		return " git would not list the worktrees, so whether one carries a finished session's work is unknown.";
	if (unreadable.length === 0) return "";
	return ` ${unreadable.length} registered worktree(s) git would not read went unjudged: ${unreadable.join(", ")}.`;
}

/** @param {string[]} unread */
function unreadJobs(unread) {
	if (unread.length === 0) return "";
	return ` ${unread.length} job store(s) or record(s) would not read, so a dirty worktree's owner may be unknown and the stranded-worktree count short: ${unread.join("; ")}.`;
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

		const locks = readLocks();
		if (locks === null) {
			ctx.skip(
				`the file-claim store at ${paths.locksDir()} could not be read, so what is held is unknown — not nothing. See: node ${scriptPath("check-guard-errors.js")}`,
			);
		}
		const dirtyTrees = readDirtyWorktrees();
		if (locks.length === 0 && dirtyTrees.found.length === 0) {
			return {
				okLine: `no files are claimed, and no worktree carries uncommitted work.${unreadWorktrees(dirtyTrees.unreadable)}`,
				data: { claims: 0 },
			};
		}

		// #1390
		const { ids, why, names, terminal, cwds } = listedSessionIds();
		if (!ids) {
			ctx.skip(
				`${why}. ${locks.filter((l) => !l.unreadable).length} file claim(s) and ${dirtyTrees.found.length} dirty worktree(s) went unjudged — none of them is being called stranded on an oracle this run could not read.`,
			);
		}
		const nameOf = (/** @type {string} */ id) => names?.get(id) || id;

		const buckets = classifyClaims(locks, ids, { hours, terminal });

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

		const dirty = readDirtyPaths();
		const attributed = attributeWorktreeDirt(dirtyTrees.found, {
			cwds,
			names,
		});
		const dirt = dirtByTree(dirty, dirtyTrees.found);
		const isDirty = (/** @type {Stranded} */ s) => isDirtyClaim(dirt, s);
		const carrying = dirty ? stranded.filter(isDirty) : [];
		const trees = classifyWorktrees(attributed.worktrees, ids, {
			hours,
			terminal,
		});
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
			okLine: `${okLineFor({ stranded, dirty, locks, hours })}${unreadWorktrees(dirtyTrees.unreadable)}${unreadJobs(attributed.unread)}`,
			noun: "possibly-stranded file claim(s) or worktree(s)",
			data: {
				stranded,
				strandedCount: stranded.length,
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
