const {
	execProgram,
	gitBinary,
	gitSpawnOptions,
	GIT_TIMEOUT_MS,
} = require("./git.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const arbiterStore = require("./arbiter-store");
const { readClaimedElsewhere } = require("./neighbour-dirt.js");
const idSeam = require("./session-id.js");
const { readOwnPaths } = require("./own-work.js");
const {
	gitRead,
	readTrackedStatus,
	readUntrackedFiles,
} = require("./dirty-tree.js");
const {
	readDefaultChangedBase,
	readDiffNames,
} = require("./changed-selection.js");

/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */

/** @typedef {{ paths: string[], dropped: string[], carriesUntracked?: boolean }} OwnSet */

/** @typedef {{ path: string, at: number }} Quote */
/**
 * @typedef {{ readWritesBy: (id: string, tree?: string) => string[]|null,
 *   readSelectsBy?: (id: string) => Quote[]|null,
 *   readLandedBy?: (id: string) => Set<string>|null }
 *   & import("./neighbour-dirt.js").LockSource} Ledger
 */

/**
 * @param {string[]} dirty
 * @param {{ sessionId?: string|null, ledger?: Ledger, untracked?: string[],
 *   renames?: { path: string, source: string }[], tree?: string,
 *   committedAt?: (p: string) => number, ownTree?: boolean }} [options]
 * @returns {{ mine: string[], theirs: string[], quoted: string[] }}
 */
function attributeDirty(
	dirty,
	{
		sessionId = idSeam.fromEnv(),
		ledger = arbiterStore,
		untracked = [],
		renames = [],
		tree = arbiterStore.treeRoot(),
		committedAt,
		ownTree = false,
	} = {},
) {
	const byLedger = attributeByLedger(dirty, {
		sessionId,
		ledger,
		untracked,
		renames,
		tree,
		committedAt,
	});
	if (!ownTree || !sessionId) return byLedger;
	return {
		mine: [...new Set([...byLedger.mine, ...dirty, ...untracked])].sort(),
		theirs: [],
		quoted: byLedger.quoted,
	};
}

/**
 * @param {string[]} dirty
 * @param {{ sessionId: string|null|undefined, ledger: Ledger, untracked: string[],
 *   renames: { path: string, source: string }[], tree: string,
 *   committedAt: ((p: string) => number)|undefined }} options
 * @returns {{ mine: string[], theirs: string[], quoted: string[] }}
 */
function attributeByLedger(
	dirty,
	{ sessionId, ledger, untracked, renames, tree, committedAt },
) {
	// lucmoseley/mantahostels#2169
	/** @type {string[]|null} */
	let written = null;
	/** @type {string[]} */
	let quoted = [];
	/** @type {Set<string>} */
	let held = new Set();
	try {
		if (sessionId) written = ledger.readWritesBy(sessionId, tree);
	} catch {
		written = null;
	}
	try {
		if (sessionId && committedAt && written) {
			const wrote = new Set(written);
			quoted = freshQuotes(
				ledger.readSelectsBy?.(sessionId) ?? [],
				new Set([...dirty, ...untracked].filter((p) => !wrote.has(p))),
				committedAt,
			);
		}
	} catch {
		quoted = [];
	}
	try {
		if (sessionId && ((written && written.length > 0) || quoted.length > 0))
			held = readClaimedElsewhere(sessionId, { tree, source: ledger });
	} catch {
		written = null;
	}
	written = withoutLanded(sessionId, written, ledger);
	if (written && quoted.length > 0) written = [...written, ...quoted];
	if (!written || written.length === 0)
		return { mine: [], theirs: [...dirty].sort(), quoted: [] };
	const own = ownOf([...dirty, ...untracked], written, held, renames);
	return {
		mine: [...own].sort(),
		theirs: dirty.filter((p) => !own.has(p)).sort(),
		quoted: quoted.filter((p) => own.has(p)).sort(),
	};
}

/**
 * @param {string|null|undefined} sessionId
 * @param {string[]|null} written
 * @param {Ledger} ledger
 * @returns {string[]|null}
 */
function withoutLanded(sessionId, written, ledger) {
	if (!sessionId || !written || written.length === 0 || !ledger.readLandedBy)
		return written;
	try {
		const landed = ledger.readLandedBy(sessionId);
		return landed ? written.filter((p) => !landed.has(p)) : written;
	} catch {
		return written;
	}
}

/**
 * @param {string[]} paths
 * @param {string[]} written
 * @param {Set<string>} held
 * @param {{ path: string, source: string }[]} renames
 * @returns {Set<string>}
 */
function ownOf(paths, written, held, renames) {
	const own = new Set(paths.filter((p) => written.includes(p) && !held.has(p)));
	for (const { path: to, source } of renames) {
		if (own.has(to) && !held.has(source)) own.add(source);
		else if (own.has(source) && !held.has(to)) own.add(to);
	}
	return own;
}

/**
 * @param {Quote[]} entries
 * @param {Set<string>} candidates
 * @param {(p: string) => number} committedAt
 * @returns {string[]}
 */
function freshQuotes(entries, candidates, committedAt) {
	return entries
		.filter((e) => candidates.has(e.path) && e.at > committedAt(e.path))
		.map((e) => e.path);
}

/**
 * @param {string} root
 * @param {ExecFn} [execFn]
 * @returns {(rel: string) => number}
 */
const lastCommitAt = (root, execFn) => (rel) =>
	Number(gitRead(["log", "-1", "--format=%ct", "--", rel], root, execFn)) *
		1000 || 0;

/**
 * @param {string} root
 * @param {string} head
 * @param {string[]} mine
 * @param {ExecFn} [execFn]
 * @returns {string|null}
 */
function overlayCommit(root, head, mine, execFn = execProgram) {
	if (mine.length === 0) return head;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-commit-"));
	const env = {
		...process.env,
		GIT_INDEX_FILE: path.join(dir, "index"),
		GIT_AUTHOR_NAME: "overlay-commit",
		GIT_AUTHOR_EMAIL: "overlay-commit@localhost",
		GIT_COMMITTER_NAME: "overlay-commit",
		GIT_COMMITTER_EMAIL: "overlay-commit@localhost",
	};
	/** @param {string[]} args */
	const run = (args) =>
		String(
			execFn(
				gitBinary(),
				args,
				gitSpawnOptions({
					cwd: root,
					env,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
					timeout: GIT_TIMEOUT_MS,
				}),
			) ?? "",
		).trim();
	try {
		run(["read-tree", head]);
		run(["add", "-A", "--", ...mine]);
		return run([
			"commit-tree",
			run(["write-tree"]),
			"-p",
			head,
			"-m",
			"overlay",
		]);
	} catch {
		return null;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * @param {string} root
 * @param {string} sessionId
 * @param {{ ledger?: Ledger, execFn?: ExecFn,
 *   commitLedger?: import("./own-work.js").CommitLedger }} [seams]
 * @returns {{ base: string, tip: string, mine: string[],
 *   uncommitted: string[]|null, net: string[]|null,
 *   scoped: { paths: string[], dropped: string[] }|null, unread: string|null }|null}
 */
function ownSelection(
	root,
	sessionId,
	{ ledger, commitLedger, execFn = execProgram } = {},
) {
	const status = readTrackedStatus(root, execFn);
	const head = gitRead(["rev-parse", "HEAD"], root, execFn)?.trim();
	if (status === null || !head) return null;
	const untracked = readUntrackedFiles(root, execFn) ?? [];
	const { mine } = attributeDirty(status.dirty, {
		sessionId,
		untracked,
		renames: status.renames,
		ledger,
		tree: root,
		committedAt: lastCommitAt(root, execFn),
	});
	const tip = overlayCommit(root, head, mine, execFn);
	if (tip === null) return null;
	const base = readDefaultChangedBase(root, execFn);
	const resolved = readOwnPaths(root, base, {
		sessionId,
		tip,
		execFn,
		ledger: commitLedger,
	});
	return {
		base,
		tip,
		mine,
		uncommitted:
			mine.length > 0 ? readDiffNames(root, "HEAD", tip, execFn) : [],
		net: readDiffNames(root, base, tip, execFn),
		scoped:
			resolved && resolved.dropped.length > 0
				? { paths: resolved.paths, dropped: resolved.dropped }
				: null,
		unread: resolved
			? null
			: "this session's own commits could not be told from a neighbour's (commit ledger or git unreadable), so attestation was judged on the whole range",
	};
}

/**
 * @param {string} root
 * @param {string} sessionId
 * @param {Parameters<typeof ownSelection>[2]} [seams]
 * @returns {(OwnSet & { base: string })|null}
 */
function ownDefaultWork(root, sessionId, seams) {
	const own = ownSelection(root, sessionId, seams);
	const paths = own?.scoped?.paths ?? own?.net;
	if (!own || !paths) return null;
	return {
		base: own.base,
		paths,
		dropped: own.scoped?.dropped ?? [],
		carriesUntracked: true,
	};
}

module.exports = {
	attributeDirty,
	lastCommitAt,
	ownDefaultWork,
	ownSelection,
};
