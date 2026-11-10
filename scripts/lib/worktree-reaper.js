/*
 * worktree-reaper.js — REAP, below, apart from lib/session-checkout.js
 * (#4703) because it changes for the folder's upkeep, not a session's
 * lifecycle. It owns the holder record a cut writes (#4229), so a tree
 * handed to an in-process subagent, where no process's cwd lies, stands
 * while its session lives; and REAPED_RECORD, from which `reopen`
 * (lib/session-checkout.js) rebuilds a reaped tree (#4368).
 */

const fs = require("node:fs");
const path = require("node:path");
const { readLiveOrLog, readSessionEntries } = require("./arbiter-core.js");
const { holderAlive, readProcStartOf } = require("./arbiter-proc.js");
const { caught } = require("./caught.js");
const {
	adminDirOf,
	fetchShared,
	git,
	readProcesses,
	readWorktreesOrThrow,
	rootOf,
} = require("./checkout-repo.js");
const { ageOf, reapStores, removeTree, YOUNG_MS } = require("./dep-store.js");
const { deref } = require("./deref.js");
const { readText } = require("./file-read.js");
const {
	GIT_TIMEOUT_MS,
	gitCommonDirOrThrow,
	spawnGitSync,
} = require("./git.js");
const { readJsonl } = require("./jsonl.js");
const { pushedRef, VERIFIED_REF } = require("./landing-refs.js");
const {
	readWorktreeEdits,
	readWorktreeFiling,
} = require("./orphan-filings.js");
const { pidLock } = require("./pid-lock.js");
const { requiredGroup } = require("./regex-group.js");
const {
	readJobCwds,
	worktreeHolding,
	worktreeLabel,
} = require("./session-worktrees.js");
const { moduleOn } = require("./workflow-core-config.js");
const {
	isSessionWorktreeDir,
	STORES,
	WORKTREES,
} = require("./worktree-dirs.js");

/*
 * REAP, run on each refill-loop tick, clears what the worktrees folder no
 * longer needs and names what it may not clear:
 *   - a session worktree whose every `HEAD` commit is on a freshly fetched
 *     `origin/main` or its own queue ref, whose tree is clean, and whose session is neither live
 *     (a process's cwd lies in it), resumable (a job record whose cwd lies in
 *     it is in any state but `done` or `failed`), held (its `HOLDER_RECORD`
 *     names a live session) nor finished under `KEEP_MS` ago is removed, its path, `HEAD` sha, and each job's id and seat whose
 *     cwd lies in it appended first to `REAPED_RECORD` in git's common
 *     directory;
 *   - one dirty or unlanded, of a dead and non-resumable session, is reported
 *     with its idle time and last commit, never removed;
 *   - registrations whose directory is gone are pruned, and a directory there
 *     with no registration is removed, save one still carrying a `.git` file:
 *     git can no longer read its uncommitted work, so it is reported as an
 *     unregistered checkout;
 *   - a dependency store no registered worktree links is removed, and so is a
 *     dead build's lock and staging directory.
 * Left alone: a locked worktree (the harness's agent trees), the suite's
 * `isolated-*` trees, which lib/isolated-worktree.js sweeps, the queue
 * lander's own tree, which it checks out again in each suite slot, a live build's
 * lock, staging and store, and anything changed within `YOUNG_MS` — a cut
 * registers its directory, and a build renames its store into place, moments
 * before the link that names it.
 */

/* House: #4366. A finished job's own `updatedAt` is its finish clock, which
 * a resume that finishes again moves (#4368); a record without one holds its
 * tree. */
const KEEP_MS = 3 * 24 * 60 * 60_000;
const REAPED_RECORD = "wfc-reaped-worktrees.jsonl";
const HOLDER_RECORD = "wfc-holder.json";
const ISOLATED = /^isolated-/;
const ENDED = new Set(["done", "failed"]);
/* The script a reap pass runs as; a pidfile naming any other is stale. */
const REAP_HOLDERS = ["session-checkout.js"];
/* An edit state no marker records: an unread worktree defers to no issue. */
const UNREAD_EDITS = "\0unread";

/**
 * @typedef {{ dir: string, idleMs: number, last: string, dirty: number,
 *   unlanded: number, filed: string | null }} UnfinishedTree a dead
 *   session's tree holding uncommitted edits or unlanded commits; `filed` the
 *   orphaned-edit issue check-orphaned-edits.js filed for it while its dirt
 *   stood as it stands now, which carries its decision (#4439)
 * @typedef {{ removed: string[], unfinished: UnfinishedTree[], unregistered: string[],
 *   pruned: string[], strays: string[], stores: string[], failed: string[],
 *   fetchFailed: string | null }} Reaped
 * @typedef {{ now: number, cwds: string[], record: string, common: string }}
 *   Pass when the pass runs, every live process's cwd, the REAPED_RECORD
 *   path, and the git common dir
 * @typedef {{ job: string, seat: string, path: string, head: string,
 *   at: string }} ReapedTree one line of REAPED_RECORD
 */

/**
 * Name session `sessionId` the holder of the worktree whose git directory is
 * `admin`, with the pid and start token of its live registry entry where one
 * stands: a session id its process later trades for another, as `/clear`
 * does, still holds through that process.
 * @param {string} admin
 * @param {string} sessionId
 */
function writeHolder(admin, sessionId) {
	const own = (readSessionEntries("own") ?? []).find(
		({ entry }) =>
			entry.sessionId === sessionId &&
			entry.pid &&
			entry.procStart &&
			readProcStartOf(entry.pid) === String(entry.procStart),
	)?.entry;
	fs.writeFileSync(
		path.join(admin, HOLDER_RECORD),
		`${JSON.stringify({ sessionId, pid: own?.pid ?? null, procStart: own?.procStart ?? null })}\n`,
	);
}

/**
 * Whether the worktree whose git directory is `admin` names a holder session
 * `live` holds or whose recorded process still runs, or names one where `live`
 * is null: an unread registry proves no session dead (#4496). Residual: while
 * the registry stays unreadable, every held tree stands on every pass, the
 * read failure logged. A record naming no session throws, so its tree stands,
 * reported as one the pass could not reap.
 * @param {string} admin
 * @param {Set<string> | null} live
 */
function isHeldByLiveSession(admin, live) {
	const file = path.join(admin, HOLDER_RECORD);
	const read = readText(file);
	if (read.state === "absent") return false;
	let record;
	try {
		if (read.state === "unreadable") throw read.error;
		record = JSON.parse(read.data);
	} catch (err) {
		throw new Error(`${file} will not parse: ${caught(err).message}`, {
			cause: err,
		});
	}
	if (typeof record?.sessionId !== "string")
		throw new Error(`${file} names no holder session`);
	return live === null || live.has(record.sessionId) || holderAlive(record);
}

/**
 * A worktree's dirty paths, its commits on neither `origin/main` nor its queue
 * ref, its last commit, and how long since that commit or an index write, the
 * later. The status takes no optional lock, so it never rewrites the index
 * whose age it reads; it leaves out the store link, which an adopter's
 * `node_modules/` ignore, matching directories only, would show untracked.
 * @param {string} dir
 * @param {number} now
 * @param {string} root the main checkout
 * @returns {Omit<UnfinishedTree, "filed">}
 */
function readWorktreeState(dir, now, root) {
	const dirty = git(
		[
			"--no-optional-locks",
			"status",
			"--porcelain",
			"--",
			".",
			":(top,exclude)node_modules",
		],
		dir,
	);
	const unlanded = Number(
		git(
			[
				"rev-list",
				"--count",
				"HEAD",
				"--not",
				...new Set([VERIFIED_REF, pushedRef({ root, tree: dir })]),
			],
			dir,
		),
	);
	const [at = "0", ...subject] = git(
		["log", "-1", "--format=%ct %h %s"],
		dir,
	).split(" ");
	const index = path.join(adminDirOf(dir), "index");
	const written = fs.statSync(index, { throwIfNoEntry: false })?.mtimeMs ?? 0;
	return {
		dir,
		idleMs: now - Math.max(written, Number(at) * 1000),
		last: subject.join(" "),
		dirty: dirty ? dirty.split("\n").length : 0,
		unlanded,
	};
}

/**
 * Every job, each cwd a pass leaves its worktree standing for — a live
 * process's, or a job's not ended or ended under KEEP_MS ago — and each job
 * store or record that would not read, as readJobCwds names it.
 * @param {string[]} cwds every live process's cwd
 * @param {number} now
 */
function readOccupied(cwds, now) {
	const { jobs, unread } = readJobCwds();
	const occupied = [
		...cwds,
		...jobs
			.filter(
				(j) =>
					j.state === null ||
					!ENDED.has(j.state) ||
					j.at === 0 ||
					now - j.at < KEEP_MS,
			)
			.map((j) => j.cwd),
	];
	return { jobs, occupied, unread };
}

/**
 * Whether the pass removes no worktree: an unread job store or record may
 * hold a resumable job in any of them (#4704).
 * @param {string[]} unread readJobCwds' `unread`
 * @param {Reaped} out accumulator: each unread path is pushed onto `failed`
 */
function holdForUnread(unread, out) {
	for (const u of unread)
		out.failed.push(
			`${u} — a job it holds may be resumable, so no worktree is removed until it reads`,
		);
	return unread.length > 0;
}

/**
 * The session worktrees in `base`, judged by REAP's rules.
 * @param {string} root
 * @param {Pass} pass
 * @param {Reaped} out accumulator: what the pass removed, reported and failed on is pushed here
 * @returns {string[]} every registered worktree still standing
 */
function reapWorktrees(root, { cwds, now, record, common }, out) {
	const registered = readWorktreesOrThrow(root);
	const { jobs, occupied, unread } = readOccupied(cwds, now);
	const held = holdForUnread(unread, out);
	const live = readLiveOrLog("session-checkout reap");
	/** @type {string[]} */
	const standing = [];
	for (const dir of registered) {
		if (
			!isSessionWorktreeDir(root, dir) ||
			ISOLATED.test(path.basename(dir)) ||
			!fs.existsSync(dir) ||
			ageOf(dir, now) < YOUNG_MS ||
			occupied.some((cwd) => worktreeHolding(cwd, [dir]))
		) {
			standing.push(dir);
			continue;
		}
		try {
			const admin = adminDirOf(dir);
			if (
				fs.existsSync(path.join(admin, "locked")) ||
				isHeldByLiveSession(admin, live)
			) {
				standing.push(dir);
				continue;
			}
			const state = readWorktreeState(dir, now, root);
			if (state.dirty > 0 || state.unlanded > 0) {
				out.unfinished.push({
					...state,
					filed: readWorktreeFiling(
						common,
						worktreeLabel(root, dir),
						readWorktreeEdits(dir) ?? [UNREAD_EDITS],
					),
				});
				standing.push(dir);
				continue;
			}
			if (held) {
				standing.push(dir);
				continue;
			}
			removeWorktree(root, dir, { record, now }, jobs);
			out.removed.push(dir);
		} catch (err) {
			out.failed.push(`${dir}: ${caught(err).message.trim()}`);
			standing.push(dir);
		}
	}
	return standing;
}

/**
 * Remove `dir` and its store link, first recording each job whose cwd lies in
 * it, so `reopen` can rebuild it.
 * @param {string} root
 * @param {string} dir
 * @param {Pick<Pass, "record" | "now">} pass
 * @param {import("./session-worktrees.js").JobCwd[]} jobs
 */
function removeWorktree(root, dir, pass, jobs) {
	recordReaped(
		pass,
		dir,
		jobs.filter((j) => worktreeHolding(j.cwd, [dir])),
	);
	const link = path.join(dir, "node_modules");
	if (fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink())
		fs.unlinkSync(link);
	git(["worktree", "remove", dir], root);
}

/**
 * Append a line to REAPED_RECORD for each job whose cwd lies in `dir`, with
 * its `HEAD` sha.
 * @param {Pick<Pass, "record" | "now">} pass
 * @param {string} dir
 * @param {import("./session-worktrees.js").JobCwd[]} owners
 */
function recordReaped({ record, now }, dir, owners) {
	if (owners.length === 0) return;
	const head = git(["rev-parse", "HEAD"], dir);
	const at = new Date(now).toISOString();
	fs.appendFileSync(
		record,
		owners
			.map(
				(j) =>
					`${JSON.stringify(/** @type {ReapedTree} */ ({ job: j.id, seat: j.seat, path: dir, head, at }))}\n`,
			)
			.join(""),
	);
}

/**
 * The last REAPED_RECORD line for job `id`; null where none names it.
 * @param {string} record
 * @param {string} id
 * @returns {ReapedTree | null}
 */
function readReaped(record, id) {
	/** @type {ReapedTree | null} */
	let last = null;
	for (const r of readJsonl(record)?.rows ?? []) {
		const { job, seat, path: dir, head, at } = r;
		if (
			job === id &&
			typeof seat === "string" &&
			typeof dir === "string" &&
			typeof head === "string" &&
			typeof at === "string"
		)
			last = { job, seat, path: dir, head, at };
	}
	return last;
}

/**
 * Every directory in `base` git has no registration for and no live process
 * works in.
 * @param {string} base
 * @param {string[]} standing
 * @param {Pass} pass
 * @param {Reaped} out accumulator: what the pass removed, reported and failed on is pushed here
 */
function reapStrays(base, standing, { cwds, now }, out) {
	for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
		const dir = path.join(base, entry.name);
		if (
			!entry.isDirectory() ||
			dir === path.join(base, path.basename(STORES)) ||
			ISOLATED.test(entry.name) ||
			standing.includes(dir) ||
			ageOf(dir, now) < YOUNG_MS ||
			cwds.some((cwd) => worktreeHolding(cwd, [dir]))
		)
			continue;
		if (fs.existsSync(path.join(dir, ".git"))) {
			out.unregistered.push(dir);
			continue;
		}
		try {
			removeTree(dir);
			out.strays.push(dir);
		} catch (err) {
			out.failed.push(`${dir}: ${caught(err).message.trim()}`);
		}
	}
}

/**
 * Prune every registration whose directory is gone; the worktree name each
 * pruned, from git's report, which it writes on stderr.
 * @param {string} root
 * @returns {string[]}
 */
function prune(root) {
	const r = spawnGitSync(["worktree", "prune", "--verbose"], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: GIT_TIMEOUT_MS,
	});
	if (r.error) throw r.error;
	if (r.status !== 0)
		throw new Error(`git worktree prune exited ${r.status}: ${r.stderr}`);
	const removing = /^Removing worktrees\/([^:]+):/gm;
	return [...`${r.stdout}${r.stderr}`.matchAll(removing)].map((m) =>
		requiredGroup(m, 1, removing),
	);
}

/**
 * REAP, above. One pass runs at a time per repository; another finds it busy.
 * @param {string} cwd anywhere in the repository
 * @returns {Reaped | { busy: number | null }}
 */
function reap(cwd) {
	const now = Date.now();
	const root = rootOf(cwd);
	const common = gitCommonDirOrThrow(root, { timeout: GIT_TIMEOUT_MS });
	const lock = pidLock(path.join(common, "wfc-reap.pid"), REAP_HOLDERS);
	if (!lock.acquire()) return { busy: lock.holder() };
	try {
		/** @type {Reaped} */
		const out = {
			removed: [],
			unfinished: [],
			unregistered: [],
			pruned: [],
			strays: [],
			stores: [],
			failed: [],
			fetchFailed: null,
		};
		const record = path.join(common, REAPED_RECORD);
		/* With `landing` off no session worktree is cut, and none can be
		 * judged landed. */
		const judged = moduleOn("landing", { root });
		if (judged)
			try {
				fetchShared(root);
			} catch (err) {
				/* A stale `origin/main` only reads more work as unlanded. */
				out.fetchFailed = caught(err).message.trim();
			}
		out.pruned = prune(root);
		const base = path.join(root, WORKTREES);
		if (!fs.existsSync(base)) return out;
		const pass = {
			now,
			cwds: readProcesses().map((p) => deref(p.cwd)),
			record,
			common,
		};
		const standing = judged
			? reapWorktrees(root, pass, out)
			: readWorktreesOrThrow(root);
		reapStrays(base, standing, pass, out);
		reapStores(root, standing, { judged, now }, out);
		return out;
	} finally {
		lock.release();
	}
}

module.exports = {
	prune,
	reap,
	readReaped,
	REAPED_RECORD,
	writeHolder,
};
