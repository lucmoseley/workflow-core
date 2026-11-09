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
 * The markers are written before the fast-forward, so the new canary never
 * meets a session without one. The old ones stay for pruneMarkers's age sweep.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { listedAgents } = require("./agent-liveness.js");
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
 */

/**
 * The files `file` sources, repo-relative, or a `why` where one is sourced in
 * a form this cannot follow: a file it missed would change unwatched.
 * @param {string} file
 * @param {string} text
 * @returns {{ sourced: string[] } | { why: string }}
 */
function readSourced(file, text) {
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
	while (queue.length > 0) {
		const file = /** @type {string} */ (queue.pop());
		if (files.has(file)) continue;
		const text = gitRead(["show", `${rev}:${file}`], root);
		if (text === null) {
			/* Absent at `rev` lists nothing; a git fault answers null. */
			if (gitRead(["ls-tree", "--name-only", rev, "--", file], root) === "")
				continue;
			return { why: `git could not read ${file} at ${rev}` };
		}
		files.set(file, text);
		const read = readSourced(file, text);
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
	const listed = listedAgents({ requireSelf: false });
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
 * Run a canary or writer for one session, as its hook would. The plugin root
 * is the main checkout's self-plugin: the only one the current canary vouches
 * for (#4712), so a re-mark records no root the session did not already have.
 * @param {string} script
 * @param {LiveSession} s
 * @param {string} root the main checkout
 * @returns {{ ok: boolean, said: string }}
 */
function runHook(script, s, root) {
	const r = spawnSync("bash", [script], {
		cwd: s.cwd,
		input: JSON.stringify({ session_id: s.sessionId }),
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: s.cwd,
			CLAUDE_PLUGIN_ROOT: path.join(root, "self-plugin"),
		},
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
 * The listed sessions working in one of `root`'s worktrees that the main
 * checkout's canary passes, each once — or a `why`.
 * @param {string} root
 * @param {LiveSession[]} listed
 * @returns {{ sessions: LiveSession[] } | { why: string }}
 */
function vouchedSessions(root, listed) {
	const out = gitRead(["worktree", "list", "--porcelain", "-z"], root);
	if (out === null)
		return { why: `git would not list the worktrees of ${root}` };
	const trees = worktreePaths(() => out).map(deref);
	const current = path.join(root, CANARY);
	const ids = new Set();
	/** @type {LiveSession[]} */
	const sessions = [];
	/* No canary there: its hook cannot start, so it refuses every session. */
	if (!fs.existsSync(current)) return { sessions };
	for (const s of listed) {
		if (ids.has(s.sessionId) || !isUnder(deref(s.cwd), trees)) continue;
		ids.add(s.sessionId);
		if (runHook(current, s, root).ok) sessions.push(s);
	}
	return { sessions };
}

/**
 * Re-mark each session with the writer under `scratch`, then check it with the
 * canary there: those it would still refuse.
 * @param {string} root
 * @param {string} scratch
 * @param {LiveSession[]} sessions
 * @returns {Stranded[]}
 */
function remarkEach(root, scratch, sessions) {
	/** @type {Stranded[]} */
	const stranded = [];
	for (const s of sessions) {
		runHook(path.join(scratch, WRITER), s, root);
		const check = runHook(path.join(scratch, CANARY), s, root);
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
 * Re-mark the live sessions of `root`'s repository for `to`'s canary, where
 * `from..to` changes it. Null where the fast-forward may go ahead.
 * @param {string} root the main checkout, at `from`
 * @param {{ from: string, to: string, changed: string[], scratch: string,
 *   listSessions?: ListSessions }} pass `scratch`, a directory this call may
 *   fill and remove
 * @returns {Stranding | null}
 */
function remarkForCanary(
	root,
	{ from, to, changed, scratch, listSessions = listLiveSessions },
) {
	const before = readClosure(root, from);
	if ("why" in before) return before;
	const after = readClosure(root, to);
	if ("why" in after) return after;
	if (!changed.some((c) => before.files.has(c) || after.files.has(c)))
		return null;
	const listed = listSessions();
	if ("why" in listed) return listed;
	const vouched = vouchedSessions(root, listed.sessions);
	if ("why" in vouched) return vouched;
	if (vouched.sessions.length === 0) return null;
	fs.rmSync(scratch, { recursive: true, force: true });
	try {
		writeTree(after.files, scratch);
		const stranded = remarkEach(root, scratch, vouched.sessions);
		return stranded.length > 0 ? { stranded } : null;
	} finally {
		fs.rmSync(scratch, { recursive: true, force: true });
	}
}

module.exports = { remarkForCanary };
