/*
 * canary-remark.js — keeps every live session past a levelling fast-forward
 * that changes the self-plugin canary (#4711).
 *
 * Every session's canary and marker writer run from the main checkout
 * (#4701), so a fast-forward that changes them, or anything they source,
 * reaches every live session at its next call, against a marker the old
 * writer wrote. Before the fast-forward, each live session the current canary
 * passes is re-marked by the target commit's writer and checked by the
 * target's canary, both taken from `to` into a scratch tree, never the main
 * checkout's working tree. Where one would still be refused, the caller does
 * not move `main`. A session the current canary already refuses gets no
 * marker: one would vouch for a session whose self-plugin never loaded.
 *
 * A SESSION THAT STARTS, or clears to a new id, after that listing is marked
 * by the old writer, since the main checkout is still at `from` (#4734). So
 * after the fast-forward the sessions are listed again, and each one the first
 * pass did not re-mark that `to`'s canary, now the main checkout's, refuses
 * and `from`'s, taken into scratch, passes is re-marked by the main checkout's
 * writer. The residual is a session whose old writer was spawned before the
 * move but which that second listing does not show. Its window is how long a
 * session takes to appear in `claude agents --json` after its SessionStart
 * hooks spawn, unmeasured.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { readAgentsForLevelling } = require("./agent-liveness.js");
const { caught } = require("./caught.js");
const { selfPluginRoot } = require("./hook-env.js");
const { deref } = require("./deref.js");
const { gitRead } = require("./dirty-tree.js");
const { isUnder } = require("./is-under.js");
const { worktreePaths } = require("./worktree-paths.js");

const CANARY = "scripts/self-plugin-canary.sh";
const WRITER = "scripts/write-self-plugin-marker.sh";
/* `source "$here/lib/x.sh"`, `source "${BASH_SOURCE[0]%/*}/x.sh"`: every
 * variable a file sources through names that file's own directory. */
const SOURCE_ARG = /^"\$(?:\{[^}]*\}|\w+)\/([^"$]+\.sh)"$/;
/* Every `source <arg>` or `. <arg>` on a line that is no comment. */
const SOURCING = /(?:\bsource|(?:^|[;&|]|\bthen|\bdo)\s*\.)\s+(\S+)/g;
/* Untraced: a canary or writer is a few file reads and one jq. */
const HOOK_TIMEOUT_MS = 10_000;

/**
 * @typedef {{ sessionId: string, cwd: string }} LiveSession
 * @typedef {() => { sessions: LiveSession[] } | { why: string }} ListSessions
 * @typedef {{ sessionId: string, projectDir: string, refusal: string }} Stranded
 * @typedef {{ why: string } | { stranded: Stranded[] }} Stranding
 * @typedef {(
 *   | { status: "stranding", stranding: Stranding }
 *   | { status: "refused", why: string }
 *   | { status: "moved", late: Stranding | null }
 * )} Remarked `stranding` and `refused` leave `main` where it was
 */

/**
 * The files `file` sources, repo-relative, or a `why` where one is sourced in
 * a form this cannot follow: a file it missed would change unwatched.
 * @param {string} file
 * @param {string} text
 * @returns {{ sourced: string[] } | { why: string }}
 */
function parseSourced(file, text) {
	/** @type {string[]} */
	const sourced = [];
	for (const line of text.split("\n")) {
		if (/^\s*#/.test(line)) continue;
		for (const [, arg = ""] of line.matchAll(SOURCING)) {
			const rel = SOURCE_ARG.exec(arg)?.[1];
			if (rel === undefined)
				return {
					why: `${file} sources ${arg}, which the re-mark cannot follow`,
				};
			sourced.push(path.posix.join(path.posix.dirname(file), rel));
		}
	}
	return { sourced };
}

/**
 * The canary and its writer at `rev`, with every file they source, each with
 * its text — or a `why` where git faults or a source line will not parse.
 * @param {string} root
 * @param {string} rev
 * @returns {{ files: Map<string, string> } | { why: string }}
 */
function readClosure(root, rev) {
	/** @type {Map<string, string>} */
	const files = new Map();
	const queue = [CANARY, WRITER];
	for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
		if (files.has(file)) continue;
		const text = gitRead(["show", `${rev}:${file}`], root);
		if (text === null) {
			/* Absent at `rev` lists nothing; a git fault answers null. */
			if (gitRead(["ls-tree", "--name-only", rev, "--", file], root) === "")
				continue;
			return { why: `git could not read ${file} at ${rev}` };
		}
		files.set(file, text);
		const read = parseSourced(file, text);
		if ("why" in read) return read;
		queue.push(...read.sourced);
	}
	return { files };
}

/**
 * Every session `claude agents --json` lists, with the directory it started
 * in. The self-test is waived: a levelling pass runs detached from whichever
 * session started it, and acts only on the sessions listed.
 * @type {ListSessions}
 */
function listLiveSessions() {
	const listed = readAgentsForLevelling();
	if (listed.why !== undefined) return { why: listed.why };
	const blind = listed.agents.find((a) => !a.cwd);
	if (blind)
		return {
			why: `session ${blind.sessionId} is listed with no directory, so it cannot be re-marked`,
		};
	return {
		sessions: listed.agents.map((a) => ({
			sessionId: a.sessionId,
			cwd: a.cwd ?? "",
		})),
	};
}

/**
 * Run a canary or writer for one session, as its hook would.
 * @param {string} script
 * @param {LiveSession} s
 * @param {NodeJS.ProcessEnv} [env] added to the hook's environment
 * @returns {{ ok: boolean, said: string }}
 */
function runHook(script, s, env = {}) {
	const r = spawnSync("bash", [script], {
		cwd: s.cwd,
		input: JSON.stringify({ session_id: s.sessionId }),
		env: { ...process.env, CLAUDE_PROJECT_DIR: s.cwd, ...env },
		encoding: "utf8",
		timeout: HOOK_TIMEOUT_MS,
	});
	const said =
		(r.stderr ?? "").split("\n").find((l) => l.trim() !== "") ??
		r.error?.message ??
		`exit ${r.status}`;
	return { ok: r.status === 0, said: said.trim() };
}

/**
 * @param {Map<string, string>} files
 * @param {string} dir
 */
function writeTree(files, dir) {
	for (const [file, text] of files) {
		fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
		fs.writeFileSync(path.join(dir, file), text);
	}
}

/**
 * The sessions `listSessions` lists working in one of `root`'s worktrees, each
 * once and none in `skip`, whose verdict from `root`'s canary `keep` takes —
 * or a `why`.
 * @param {string} root
 * @param {{ listSessions: ListSessions, skip: Set<string>, keep: (passed: boolean) => boolean }} pick
 * @returns {{ sessions: LiveSession[] } | { why: string }}
 */
function readRepoSessions(root, { listSessions, skip, keep }) {
	const listed = listSessions();
	if ("why" in listed) return listed;
	const out = gitRead(["worktree", "list", "--porcelain", "-z"], root);
	if (out === null)
		return { why: `git would not list the worktrees of ${root}` };
	const trees = worktreePaths(() => out).map(deref);
	const canary = path.join(root, CANARY);
	const ids = new Set(skip);
	/** @type {LiveSession[]} */
	const sessions = [];
	for (const s of listed.sessions) {
		if (ids.has(s.sessionId) || !isUnder(deref(s.cwd), trees)) continue;
		ids.add(s.sessionId);
		if (keep(isPassedBy(canary, s))) sessions.push(s);
	}
	return { sessions };
}

/**
 * Whether `canary` passes `s`. No canary there: its hook cannot start, so it
 * refuses every session.
 * @param {string} canary
 * @param {LiveSession} s
 */
function isPassedBy(canary, s) {
	return fs.existsSync(canary) && runHook(canary, s).ok;
}

/**
 * Re-mark each session with the writer under `dir`, then check it with the
 * canary there: those it would still refuse. The writer records `root`'s
 * self-plugin as the plugin root: the only one the current canary vouches for
 * (#4712), so a re-mark records no root the session did not already have.
 * @param {string} root the main checkout
 * @param {string} dir
 * @param {LiveSession[]} sessions
 * @returns {Stranded[]}
 */
function remarkEach(root, dir, sessions) {
	/** @type {Stranded[]} */
	const stranded = [];
	for (const s of sessions) {
		runHook(path.join(dir, WRITER), s, {
			CLAUDE_PLUGIN_ROOT: selfPluginRoot(root),
		});
		const check = runHook(path.join(dir, CANARY), s);
		if (!check.ok)
			stranded.push({
				sessionId: s.sessionId,
				projectDir: s.cwd,
				refusal: check.said,
			});
	}
	return stranded;
}

/**
 * @template T
 * @param {Map<string, string>} files
 * @param {string} scratch
 * @param {() => T} run
 * @returns {T}
 */
function inScratch(files, scratch, run) {
	fs.rmSync(scratch, { recursive: true, force: true });
	try {
		writeTree(files, scratch);
		return run();
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * Fast-forward the main checkout by `move` where every live session of `root`'s
 * repository would pass `to`'s canary, re-marking each first where `from..to`
 * changes it, and each session that started meanwhile after.
 * @param {string} root the main checkout, at `from`
 * @param {{ from: string, to: string, changed: string[], scratch: string,
 *   listSessions?: ListSessions }} pass `scratch`, a directory this call may
 *   fill and remove
 * @param {() => string | null} move the fast-forward: git's refusal, or null
 * @returns {Remarked}
 */
function remarkAroundMove(
	root,
	{ from, to, changed, scratch, listSessions = listLiveSessions },
	move,
) {
	const before = readClosure(root, from);
	if ("why" in before) return { status: "stranding", stranding: before };
	const after = readClosure(root, to);
	if ("why" in after) return { status: "stranding", stranding: after };
	if (!changed.some((c) => before.files.has(c) || after.files.has(c))) {
		const why = move();
		return why === null
			? { status: "moved", late: null }
			: { status: "refused", why };
	}
	const vouched = readRepoSessions(root, {
		listSessions,
		skip: new Set(),
		keep: (passed) => passed,
	});
	if ("why" in vouched) return { status: "stranding", stranding: vouched };
	const stranded = inScratch(after.files, scratch, () =>
		remarkEach(root, scratch, vouched.sessions),
	);
	if (stranded.length > 0)
		return { status: "stranding", stranding: { stranded } };
	const why = move();
	if (why !== null) return { status: "refused", why };
	const remarked = new Set(vouched.sessions.map((s) => s.sessionId));
	try {
		return {
			status: "moved",
			late: remarkLatecomers(root, before.files, remarked, {
				scratch,
				listSessions,
			}),
		};
	} catch (err) {
		/* `main` has moved: the pass's install and report still owe it (#4734). */
		return { status: "moved", late: { why: caught(err).message } };
	}
}

/**
 * After the fast-forward, re-mark each live session not in `remarked` that the
 * main checkout's canary, now `to`'s, refuses and `from`'s passes. Null where
 * none is left refused.
 * @param {string} root the main checkout, now at `to`
 * @param {Map<string, string>} before `from`'s closure
 * @param {Set<string>} remarked
 * @param {{ scratch: string, listSessions: ListSessions }} pass
 * @returns {Stranding | null}
 */
function remarkLatecomers(root, before, remarked, { scratch, listSessions }) {
	const refused = readRepoSessions(root, {
		listSessions,
		skip: remarked,
		keep: (passed) => !passed,
	});
	if ("why" in refused) return refused;
	if (refused.sessions.length === 0) return null;
	const passedBefore = inScratch(before, scratch, () =>
		refused.sessions.filter((s) => isPassedBy(path.join(scratch, CANARY), s)),
	);
	const stranded = remarkEach(root, root, passedBefore);
	return stranded.length > 0 ? { stranded } : null;
}

module.exports = { remarkAroundMove };
