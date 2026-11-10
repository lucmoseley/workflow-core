/*
 * session-checkout.js — the one owner of a session worktree's lifecycle
 * (#4229): every launcher and session goes through it, and no caller runs
 * `git worktree` itself. Its dependency stores are lib/dep-store.js's, and
 * the pass that clears landed trees is lib/worktree-reaper.js's.
 *
 * CUT fetches `main`, adds a worktree detached at `origin/main` under
 * the main checkout's worktrees folder (lib/worktree-dirs.js), named for the
 * session, and attaches its dependencies. A session that cuts one names
 * itself its holder (lib/worktree-reaper.js `writeHolder`), so a tree it
 * hands to an in-process subagent, where no process's cwd lies, stands while
 * it lives.
 *
 * LAUNCH-DIR is the directory a launcher starts a session in (#4245): a
 * worktree cut for it where the repository has the `landing` module, else the
 * main checkout, since without it no session pushes a queue ref of its own. Its name is the prompt's words and a random
 * suffix, so a session's worktree reads as its task. A resume runs in
 * the directory its job recorded, so it reopens the same worktree.
 *
 * LAUNCH-INTO is the directory a successor starts in to finish a dead
 * session's orphaned edits: that session's own worktree, named by the
 * caller, refused where git does not list it under the worktrees folder or
 * any live process still has its cwd inside it (#4385).
 *
 * LAUNCH-INTO and REOPEN both refuse a worktree whose own unlanded
 * `.claude/settings.json` would refuse or stall every tool call of the session
 * started there, naming the line and the fix (lib/settings-lockout.js,
 * #4752): a cut is from `origin/main`, whose lines the lander's suite passed.
 *
 * LAND merges a freshly fetched `origin/main` into the worktree's `HEAD` and
 * pushes `HEAD:refs/heads/queue/<worktree name>`, the session's own queue ref
 * (#4458), then starts the queue lander, which tests it with every other
 * waiting ref and moves `main` on green. The merge keeps a conflict with
 * `main` in the session's hands, where the lander would drop the ref for it.
 * A merge, never a rebase: git runs `pre-merge-commit`, and so the whole
 * pre-commit stack, on a merge commit, and no hook at all on a rebase (#3106),
 * which would skip the re-anchor the merge owes. A registry-anchor conflict is
 * settled by the per-row merge driver git config names (#4171). Neither the
 * merge nor the push carries a timeout of its own: every checker their hooks
 * run is bounded already (#4187). A push refused as no fast-forward is filed
 * as a `land` row in the divergence log (#4446), the push running here where
 * no Bash hook sees it. One failing on a network or remote fault is retried
 * with backoff (#4497).
 *
 * REOPEN gives a finished background job its worktree back so `claude attach`
 * can wake it: an open from the agents view fails before any hook runs where
 * the tree is gone (#4368).
 */

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
const { buildModuleOffLine, moduleOn } = require("./workflow-core-config.js");
const { isSessionWorktreeDir, WORKTREES } = require("./worktree-dirs.js");
const {
	prune,
	readReaped,
	REAPED_RECORD,
	writeHolder,
} = require("./worktree-reaper.js");
const { writeFd } = require("./write-fd.js");

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/* Untraced: enough of a prompt to name its task in a directory listing. */
const SLUG_MAX = 40;
/* 24 bits: two live worktrees for one prompt collide ~6e-8 of the time, and a
 * collision costs one refused member, which the next tick launches again. */
const SUFFIX_BYTES = 3;

/**
 * Cut the session worktree for `name`: detached at a freshly fetched
 * `origin/main`, its dependencies attached. A worktree whose attach fails
 * is removed.
 * @param {string} cwd anywhere in the repository
 * @param {string} name the session's name
 * @param {{ noBuild?: boolean, holder?: string | null }} [how] `holder` the
 *   id of the session the worktree is held for
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
 * Add a worktree at `dir` detached at `rev`, its holder named before its
 * dependencies are attached, since a cold build can outlast `YOUNG_MS`; one
 * whose attach fails is removed.
 * @param {string} root the main checkout
 * @param {string} dir
 * @param {string} rev
 * @param {{ noBuild?: boolean, holder?: string | null }} [how] `noBuild`
 *   passed to the attach
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
 * A git command whose output the session reads — hook output included — on
 * stderr, so a caller's stdout stays clean.
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
 * Whether `a` is an ancestor of `b`, or the same commit.
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
 * Start the queue lander after a push: the post-push hook sees no push made
 * inside a script. The main checkout's start-lander.js where this code runs from a
 * linked worktree of it, so no lander runs from a tree the reaper may remove.
 * @param {string} root the main checkout
 * @param {string} dir the worktree
 * @returns {string} start-lander.js's line, or why it did not start
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
	if (!moduleOn("landing", { root }))
		throw new CheckoutError(
			`${buildModuleOffLine("landing")}, so nothing lands through it — push to main as \`rule:branch-publish\` says`,
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

/**
 * Whether a merge is in progress in the worktree `dir`.
 * @param {string} dir
 */
const isMerging = (dir) =>
	fs.existsSync(git(["rev-parse", "--git-path", "MERGE_HEAD"], dir));

/**
 * Merge `origin/main` into `HEAD`.
 * @param {string} dir
 */
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
 * The session worktree `dir`'s queue ref, refused where it is none.
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
 * @param {string} cwd anywhere in the worktree
 * @returns {{ dir: string, queue: string, head: string, merged: boolean, pushed: boolean, lander: string | null }}
 */
function land(cwd) {
	const dir = gitTopLevel(cwd, GIT_TIMEOUT_MS);
	const root = rootOf(dir);
	refuseUnlandable(dir, root);
	const queue = queueRefOrRefuse(dir, root);
	fetchShared(root);
	const pushed = pushedRef({ root, tree: dir });
	if (isAncestor("HEAD", VERIFIED_REF, dir) || isAncestor("HEAD", pushed, dir))
		return {
			dir,
			queue,
			head: git(["rev-parse", "HEAD"], dir),
			merged: false,
			pushed: false,
			lander: null,
		};
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
	};
}

/**
 * The push of `HEAD` to the queue ref, retried with lib/network-fault.js's
 * backoff while git's own words name a fault it names, GitHub's own among
 * them; `faulted` where the last try failed so.
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
 * Files the refused push's divergence row, counted against freshly fetched
 * refs.
 * @param {string} root
 * @param {string} dir
 * @param {string} output the refused push's output
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
		/* Loaded here, so a divergence lib that will not load costs the row
		 * and never the land. */
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
 * The worktree name for a session launched on `prompt`: its words joined by
 * `-`, then random hex, as `/implement 4245` → `implement-4245-3fa9c1`.
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
 * LAUNCH-DIR, above; with `into`, LAUNCH-INTO.
 * @param {string} cwd anywhere in the repository
 * @param {string} prompt
 * @param {{ noBuild?: boolean, into?: string }} [how] `noBuild` passed to
 *   the cut or attach
 * @returns {string}
 */
function launchDir(cwd, prompt, how = {}) {
	const root = rootOf(cwd);
	const { into, ...build } = how;
	if (into !== undefined) return launchInto(root, into, build);
	return moduleOn("landing", { root })
		? cut(root, buildSessionName(prompt), build).dir
		: root;
}

/**
 * LAUNCH-INTO, above: `into`, dereferenced, where it is a registered session
 * worktree of `root` no process works in, its dependencies re-attached.
 * @param {string} root the main checkout
 * @param {string} into
 * @param {{ noBuild?: boolean }} how passed to the attach
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

/**
 * Throw where a session started in `dir` would be refused every tool call by
 * the worktree's own settings (lib/settings-lockout.js).
 * @param {string} dir
 */
function refuseLockout(dir) {
	const why = settingsLockout(dir);
	if (why !== null) throw new CheckoutError(why);
}

/**
 * Job `id`'s worktree, re-added at the sha REAPED_RECORD holds
 * for it where the reaper removed it, and the seat to attach the job on.
 * @param {string} cwd anywhere in the repository
 * @param {string} id the job id, as `claude attach` takes it
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
	/* A registration whose directory went by hand would refuse the add. */
	prune(root);
	addWorktree(root, dir, reaped.head);
	refuseLockout(dir);
	return { dir, seat, restored: true };
}

module.exports = { cut, land, launchDir, reopen };
