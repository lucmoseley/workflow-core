const fs = require("node:fs");
const path = require("node:path");
const {
	entryPid,
	entryProcStart,
	readLiveOrLog,
	readSessionEntries,
} = require("./arbiter-core.js");
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
const {
	ageOf,
	reapStores,
	removeTree,
	unlinkDepLink,
	YOUNG_MS,
} = require("./dep-store.js");
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
const {
	isSessionWorktreeDir,
	STORES,
	WORKTREES,
} = require("./worktree-dirs.js");

// workflow-core#4366 guess
const KEEP_MS = 3 * 24 * 60 * 60_000;
const REAPED_RECORD = "wfc-reaped-worktrees.jsonl";
const HOLDER_RECORD = "wfc-holder.json";
const ISOLATED = /^isolated-/;
const ENDED = new Set(["done", "failed"]);
const REAP_HOLDERS = ["session-checkout.js"];
const UNREAD_EDITS = "\0unread";

/**
 * @typedef {{ dir: string, idleMs: number, last: string, dirty: number,
 *   unlanded: number, filed: string | null }} UnfinishedTree
 * @typedef {{ removed: string[], unfinished: UnfinishedTree[], unregistered: string[],
 *   pruned: string[], strays: string[], stores: string[], failed: string[],
 *   fetchFailed: string | null }} Reaped
 * @typedef {{ now: number, cwds: string[], record: string, common: string }}
 *   Pass
 * @typedef {{ job: string, seat: string, path: string, head: string,
 *   at: string }} ReapedTree
 */

/** @param {string} admin @param {string} sessionId */
function writeHolder(admin, sessionId) {
	const own = (readSessionEntries("own") ?? [])
		.filter(({ entry }) => entry.sessionId === sessionId)
		.map(({ entry }) => ({
			pid: entryPid(entry),
			procStart: entryProcStart(entry),
		}))
		.find(
			({ pid, procStart }) =>
				pid !== null &&
				procStart !== null &&
				readProcStartOf(pid) === String(procStart),
		);
	fs.writeFileSync(
		path.join(admin, HOLDER_RECORD),
		`${JSON.stringify({ sessionId, pid: own?.pid ?? null, procStart: own?.procStart ?? null })}\n`,
	);
}

/** @param {string} admin @param {Set<string> | null} live */
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
 * @param {string} dir
 * @param {number} now
 * @returns {Omit<UnfinishedTree, "filed">}
 */
function readWorktreeState(dir, now) {
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
				...new Set([VERIFIED_REF, pushedRef({ tree: dir })]),
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

/** @param {string[]} cwds @param {number} now */
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

/** @param {string[]} unread @param {Reaped} out */
function holdForUnread(unread, out) {
	for (const u of unread)
		out.failed.push(
			`${u} — a job it holds may be resumable, so no worktree is removed until it reads`,
		);
	return unread.length > 0;
}

/**
 * @param {string} root
 * @param {Pass} pass
 * @param {Reaped} out
 * @returns {string[]}
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
			const state = readWorktreeState(dir, now);
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
	unlinkDepLink(dir);
	git(["worktree", "remove", dir], root);
}

/**
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

/** @param {string} record @param {string} id @returns {ReapedTree | null} */
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
 * @param {string} base
 * @param {string[]} standing
 * @param {Pass} pass
 * @param {Reaped} out
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

/** @param {string} root @returns {string[]} */
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

/** @param {string} cwd @returns {Reaped | { busy: number | null }} */
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
		try {
			fetchShared(root);
		} catch (err) {
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
		const standing = reapWorktrees(root, pass, out);
		reapStrays(base, standing, pass, out);
		reapStores(root, standing, now, out);
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
