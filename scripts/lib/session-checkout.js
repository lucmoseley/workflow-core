const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const {
	adminDirOf,
	CheckoutError,
	fetchShared,
	git,
	readProcesses,
	readWorktreesOrThrow,
	rootOf,
} = require("./checkout-repo.js");
const { buildCutCommand } = require("./cutover.js");
const { attach } = require("./dep-store.js");
const { deref } = require("./deref.js");
const {
	GIT_TIMEOUT_MS,
	gitCommonDirOrThrow,
	spawnGitSync,
} = require("./git.js");
const { gitTopLevel } = require("./host-root.js");
const { relativeUnder } = require("./is-under.js");
const { MOVED, MOVED_LINE } = require("./land-refusal.js");
const { runStartLander } = require("./lander-start.js");
const {
	ownQueueRef,
	pushedRef,
	REMOTE,
	VERIFIED_REF,
} = require("./landing-refs.js");
const {
	isPushFaultText,
	REMOTE_TRIES,
	remoteBackoffMs,
} = require("./network-fault.js");
const { scriptPath } = require("./script-path.js");
const { settingsLockout } = require("./settings-lockout.js");
const { readJobCwds, worktreeHolding } = require("./session-worktrees.js");
const { sleepSync } = require("./sleep-sync.js");
const { trimRun } = require("./trim-run.js");
const { isSessionWorktreeDir, WORKTREES } = require("./worktree-dirs.js");
const {
	prune,
	readReaped,
	REAPED_RECORD,
	writeHolder,
} = require("./worktree-reaper.js");
const { writeFd } = require("./write-fd.js");

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// #4245 guess
const SLUG_MAX = 40;
// #4245 guess
const SUFFIX_BYTES = 3;

/**
 * @param {string} cwd
 * @param {string} name
 * @param {{ noBuild?: boolean, holder?: string | null }} [how]
 * @returns {{ dir: string, head: string, store: string | null, built: boolean }}
 */
function cut(cwd, name, how = {}) {
	if (!NAME.test(name))
		throw new CheckoutError(
			`${JSON.stringify(name)} is no session name: letters, digits, '.', '_' and '-', starting with a letter or digit`,
		);
	const root = rootOf(cwd);
	const dir = path.join(root, WORKTREES, name);
	if (fs.existsSync(dir))
		throw new CheckoutError(
			`${dir} already exists — pick another session name, or resume the session that worktree belongs to`,
		);
	fetchShared(root);
	return addWorktree(root, dir, VERIFIED_REF, how);
}

/**
 * @param {string} root
 * @param {string} dir
 * @param {string} rev
 * @param {{ noBuild?: boolean, holder?: string | null }} [how]
 * @returns {{ dir: string, head: string, store: string | null, built: boolean }}
 */
function addWorktree(root, dir, rev, how = {}) {
	const { holder, ...build } = how;
	fs.mkdirSync(path.dirname(dir), { recursive: true });
	git(["worktree", "add", "--quiet", "--detach", dir, rev], root);
	try {
		if (holder) writeHolder(adminDirOf(dir), holder);
		const head = git(["rev-parse", "HEAD"], dir);
		const { store, built } = attach(dir, build);
		return { dir, head, store, built };
	} catch (err) {
		try {
			git(["worktree", "remove", "--force", dir], root);
		} catch (removeErr) {
			throw new Error(
				`${caught(err).message}; and the half-cut worktree would not go (${caught(removeErr).message}) — remove it with \`git worktree remove --force ${dir}\``,
				{ cause: removeErr },
			);
		}
		throw err;
	}
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {{ ok: boolean, output: string }}
 */
function gitShown(args, cwd) {
	const r = spawnGitSync(args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (r.error) throw r.error;
	const output = `${r.stdout}${r.stderr}`;
	if (output) writeFd(2, output);
	return { ok: r.status === 0, output };
}

/**
 * @param {string} a
 * @param {string} b
 * @param {string} cwd
 */
const isAncestor = (a, b, cwd) =>
	spawnGitSync(["merge-base", "--is-ancestor", a, b], {
		cwd,
		stdio: "ignore",
		timeout: GIT_TIMEOUT_MS,
	}).status === 0;

/**
 * @param {string} root
 * @param {string} dir
 * @returns {string}
 */
function startLanderFor(root, dir) {
	const own = path.join(__dirname, "..", "start-lander.js");
	const inTree = relativeUnder(dir, own);
	const script = inTree === null ? own : path.join(root, inTree);
	try {
		const r = runStartLander(root, { script });
		return r.ok
			? r.line
			: `the lander did not start (${r.line}) — run \`node ${script}\``;
	} catch (err) {
		return `the lander did not start (${caught(err).message}) — run \`node ${script}\``;
	}
}

/**
 * @param {string} dir
 * @param {string} root
 */
function refuseUnlandable(dir, root) {
	if (dir === root)
		throw new CheckoutError(
			`the main checkout is never landed from — land from your session worktree, or cut one with ${buildCutCommand()}`,
		);
	if (isMerging(dir))
		throw new CheckoutError(
			"a merge is in progress in this worktree — resolve it and `git commit`, or `git merge --abort`, then land again",
		);
	const dirty = git(["diff", "--name-only", "HEAD"], dir);
	if (dirty)
		throw new CheckoutError(
			`uncommitted changes to ${dirty.split("\n").join(", ")} would not land — commit them, or set them aside, then land again`,
		);
}

/** @param {string} dir */
const isMerging = (dir) =>
	fs.existsSync(git(["rev-parse", "--git-path", "MERGE_HEAD"], dir));

/** @param {string} dir */
// #3106
function mergeMain(dir) {
	if (gitShown(["merge", "--no-edit", VERIFIED_REF], dir).ok) return;
	if (!isMerging(dir))
		throw new CheckoutError(
			`git did not start the merge of ${VERIFIED_REF}, its output above — clear what it names, then land again`,
		);
	const conflicted = git(["diff", "--name-only", "--diff-filter=U"], dir);
	throw new CheckoutError(
		conflicted
			? `merging ${VERIFIED_REF} conflicts in ${conflicted.split("\n").join(", ")} — resolve them and \`git commit\` (it runs the pre-commit gates), or \`git merge --abort\`, then land again`
			: `the merge of ${VERIFIED_REF} was refused, its output above — fix the finding and \`git commit\` (it runs the same gates), or \`git merge --abort\`, then land again`,
	);
}

/**
 * @param {string} dir
 * @param {string} root
 * @returns {string}
 */
function queueRefOrRefuse(dir, root) {
	const queue = ownQueueRef(dir, root);
	if (queue === null)
		throw new CheckoutError(
			`${dir} is no session worktree under ${path.join(root, WORKTREES)}/, so it has no queue ref to land through — land from a worktree ${buildCutCommand()} cuts`,
		);
	return queue;
}

/**
 * @param {string} cwd
 * @returns {{ dir: string, queue: string, head: string, merged: boolean, pushed: boolean, lander: string | null,
 *   coverage: import("./push-coverage.js").Coverage | null }}
 */
function land(cwd) {
	const dir = gitTopLevel(cwd, GIT_TIMEOUT_MS);
	const root = rootOf(dir);
	refuseUnlandable(dir, root);
	const queue = queueRefOrRefuse(dir, root);
	fetchShared(root);
	const pushed = pushedRef({ tree: dir });
	if (isAncestor("HEAD", VERIFIED_REF, dir) || isAncestor("HEAD", pushed, dir))
		return {
			dir,
			queue,
			head: git(["rev-parse", "HEAD"], dir),
			merged: false,
			pushed: false,
			lander: null,
			coverage: null,
		};
	const { readUncovered } = require("./push-coverage.js");
	const coverage = readUncovered(dir);
	const merged = !isAncestor(VERIFIED_REF, "HEAD", dir);
	if (merged) mergeMain(dir);
	const head = git(["rev-parse", "HEAD"], dir);
	const push = pushQueueRef(dir, queue);
	if (!push.ok && MOVED.test(push.output)) {
		recordMoved(root, dir, push.output);
		throw new CheckoutError(
			`${MOVED_LINE} — merge \`${REMOTE}/${queue}\` into HEAD, then land again`,
		);
	}
	if (push.faulted)
		throw new CheckoutError(
			`the push to ${queue} met a remote fault on all ${REMOTE_TRIES} tries, its output above — nothing in the worktree causes it, so land again later`,
		);
	if (!push.ok)
		throw new CheckoutError(
			`the push to ${queue} was refused, its output above — fix the finding, then land again`,
		);
	return {
		dir,
		queue,
		head,
		merged,
		pushed: true,
		lander: startLanderFor(root, dir),
		coverage,
	};
}

/**
 * @param {string} dir
 * @param {string} queue
 * @returns {{ ok: boolean, output: string, faulted: boolean }}
 */
function pushQueueRef(dir, queue) {
	for (let attempt = 1; ; attempt++) {
		const push = gitShown(["push", REMOTE, `HEAD:refs/heads/${queue}`], dir);
		const faulted = !push.ok && isPushFaultText(push.output);
		if (!faulted || attempt >= REMOTE_TRIES) return { ...push, faulted };
		const ms = remoteBackoffMs(attempt);
		writeFd(
			2,
			`session checkout: the push to ${queue} met a remote fault, retrying in ${Math.round(ms / 1000)} s\n`,
		);
		sleepSync(ms);
	}
}

/**
 * @param {string} root
 * @param {string} dir
 * @param {string} output
 */
function recordMoved(root, dir, output) {
	try {
		fetchShared(root);
	} catch (err) {
		writeFd(
			2,
			`session checkout: queue refs not re-fetched, so the divergence row's behind is a lower bound (${caught(err).message})\n`,
		);
	}
	try {
		const { landRow } = require("./divergence-row.js");
		const { appendRow, buildHostPorts } = require("./divergence-row-host.js");
		appendRow(landRow(dir, output, buildHostPorts(process.env)));
	} catch (err) {
		writeFd(
			2,
			`session checkout: divergence row not recorded (${caught(err).message})\n`,
		);
	}
}

/**
 * @param {string} prompt
 * @returns {string}
 */
function buildSessionName(prompt) {
	const dashed = prompt
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, SLUG_MAX);
	const slug = trimRun(dashed, "-");
	return `${slug || "session"}-${crypto.randomBytes(SUFFIX_BYTES).toString("hex")}`;
}

/**
 * @param {string} cwd
 * @param {string} prompt
 * @param {{ noBuild?: boolean, into?: string }} [how]
 * @returns {string}
 */
function launchDir(cwd, prompt, how = {}) {
	const root = rootOf(cwd);
	const { into, ...build } = how;
	if (into !== undefined) return launchInto(root, into, build);
	return cut(root, buildSessionName(prompt), build).dir;
}

/**
 * @param {string} root
 * @param {string} into
 * @param {{ noBuild?: boolean }} how
 * @returns {string}
 */
function launchInto(root, into, how) {
	const dir = deref(path.resolve(into));
	if (
		!isSessionWorktreeDir(root, dir) ||
		!readWorktreesOrThrow(root).includes(dir)
	)
		throw new CheckoutError(
			`${dir} is no session worktree of ${root} — name a directory \`git worktree list\` shows under ${path.join(root, WORKTREES)}`,
		);
	if (!fs.existsSync(dir))
		throw new CheckoutError(
			`${dir} is registered but gone — \`node ${scriptPath("session-checkout.js")} reopen <job-id>\` rebuilds a reaped one`,
		);
	const holders = readProcesses().filter((p) =>
		worktreeHolding(deref(p.cwd), [dir]),
	);
	if (holders.length > 0)
		throw new CheckoutError(
			`a live process still works in ${dir} (pid ${holders.map((p) => p.pid).join(", ")}) — stop the session that holds it first, or launch from outside it`,
		);
	refuseLockout(dir);
	attach(dir, how);
	return dir;
}

/** @param {string} dir */
function refuseLockout(dir) {
	const why = settingsLockout(dir);
	if (why !== null) throw new CheckoutError(why);
}

/**
 * @param {string} cwd
 * @param {string} id
 * @returns {{ dir: string, seat: string, restored: boolean }}
 */
function reopen(cwd, id) {
	const root = rootOf(cwd);
	const common = gitCommonDirOrThrow(root, { timeout: GIT_TIMEOUT_MS });
	const reaped = readReaped(path.join(common, REAPED_RECORD), id);
	const { jobs, unread } = readJobCwds();
	const job = jobs
		.filter((j) => j.id === id)
		.sort((a, b) => b.at - a.at)
		.at(0);
	/** @type {{ seat: string, dir: string } | null} */
	let found = null;
	if (reaped) found = { seat: job?.seat ?? reaped.seat, dir: reaped.path };
	else if (job) found = { seat: job.seat, dir: job.cwd };
	if (found === null)
		throw new CheckoutError(
			unread.length > 0
				? `no readable seat holds job ${id} and the reaper recorded no worktree for it, but these would not read: ${unread.join("; ")} — fix their access and retry`
				: `no seat holds job ${id} and the reaper recorded no worktree for it — check the id against \`claude agents\``,
		);
	const { seat, dir } = found;
	if (fs.existsSync(dir)) {
		refuseLockout(dir);
		return { dir, seat, restored: false };
	}
	if (!reaped)
		throw new CheckoutError(
			`job ${id}'s directory ${dir} is gone and the reaper recorded no sha for it, so nothing can rebuild it`,
		);
	prune(root);
	addWorktree(root, dir, reaped.head);
	refuseLockout(dir);
	return { dir, seat, restored: true };
}

module.exports = { cut, land, launchDir, reopen };
