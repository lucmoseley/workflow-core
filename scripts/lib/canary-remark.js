/*
 * canary-remark.js — keeps every live session past a levelling fast-forward
 * that changes the self-plugin canary (workflow-core#4711).
 *
 * Every session's canary and marker writer run from the main checkout
 * (workflow-core#4701), so a fast-forward that changes them, or anything they source,
 * reaches every live session at its next call, against a marker the old
 * writer wrote. Before the fast-forward, each live session the current canary
 * passes is re-marked by the target commit's writer and checked by the
 * target's canary, both taken from `to` into a scratch tree, never the main
 * checkout's working tree. Where one would still be refused, the caller does
 * not move `main`. A session the current canary already refuses gets no
 * marker: one would vouch for a session whose self-plugin never loaded.
 *
 * A SESSION THAT STARTS, or clears to a new id, after that listing is marked
 * by the old writer, since the main checkout is still at `from` (workflow-core#4734). So
 * after the fast-forward the sessions are listed again, and each one the first
 * pass did not re-mark that `to`'s canary, now the main checkout's, refuses
 * and `from`'s, taken into scratch, passes is re-marked by the main checkout's
 * writer. The residual is a session whose old writer was spawned before the
 * move but which that second listing does not show. Its window is how long a
 * session takes to appear in `claude agents --json` after its SessionStart
 * hooks spawn, unmeasured.
 *
 * The core: it decides, and lib/canary-remark-host.js's adapters do every
 * read, hook run and scratch write.
 */

const path = require("node:path");
const { caught } = require("./caught.js");
const { isUnder } = require("./is-under.js");

const CANARY = "scripts/self-plugin-canary.sh";
const WRITER = "scripts/write-self-plugin-marker.sh";
/* `source "$here/lib/x.sh"`, `source "${BASH_SOURCE[0]%/*}/x.sh"`: every
 * variable a file sources through names that file's own directory. */
const SOURCE_ARG = /^"\$(?:\{[^}]*\}|\w+)\/([^"$]+\.sh)"$/;
/* Every `source <arg>` or `. <arg>` on a line that is no comment. */
const SOURCING = /(?:\bsource|(?:^|[;&|]|\bthen|\bdo)\s*\.)\s+(\S+)/g;

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
 * @typedef {{ text: string } | { absent: true } | { why: string }} ReadAt
 * @typedef {{
 *   root: string,
 *   readAt: (rev: string, file: string) => ReadAt,
 *   listSessions: ListSessions,
 *   worktrees: () => string[] | null,
 *   deref: (p: string) => string,
 *   exists: (p: string) => boolean,
 *   hook: (script: string, s: LiveSession) => { ok: boolean, said: string },
 *   mark: (writer: string, s: LiveSession) => void,
 *   inScratch: <T>(files: Map<string, string>, run: (dir: string) => T) => T,
 * }} RemarkPorts `root` the main checkout; `inScratch`, `run` over a
 *   scratch directory it fills with `files` and removes after; `worktrees`,
 *   each of `root`'s repository's worktrees dereferenced, null where git will
 *   not list them; `hook`, a canary run for one session as its hook would;
 *   `mark`, a writer run that records `root`'s self-plugin as the plugin root
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
 * @param {Pick<RemarkPorts, "readAt">} ports
 * @param {string} rev
 * @returns {{ files: Map<string, string> } | { why: string }}
 */
function readClosure({ readAt }, rev) {
	/** @type {Map<string, string>} */
	const files = new Map();
	const queue = [CANARY, WRITER];
	for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
		if (files.has(file)) continue;
		const at = readAt(rev, file);
		if ("absent" in at) continue;
		if ("why" in at) return at;
		files.set(file, at.text);
		const read = parseSourced(file, at.text);
		if ("why" in read) return read;
		queue.push(...read.sourced);
	}
	return { files };
}

/**
 * The sessions `listSessions` lists working in one of `root`'s worktrees, each
 * once and none in `skip`, whose verdict from `root`'s canary `keep` takes —
 * or a `why`.
 * @param {RemarkPorts} ports
 * @param {{ skip: Set<string>, keep: (passed: boolean) => boolean }} pick
 * @returns {{ sessions: LiveSession[] } | { why: string }}
 */
function readRepoSessions(ports, { skip, keep }) {
	const listed = ports.listSessions();
	if ("why" in listed) return listed;
	const trees = ports.worktrees();
	if (trees === null)
		return { why: `git would not list the worktrees of ${ports.root}` };
	const canary = path.join(ports.root, CANARY);
	const ids = new Set(skip);
	/** @type {LiveSession[]} */
	const sessions = [];
	for (const s of listed.sessions) {
		if (ids.has(s.sessionId) || !isUnder(ports.deref(s.cwd), trees)) continue;
		ids.add(s.sessionId);
		if (keep(isPassedBy(ports, canary, s))) sessions.push(s);
	}
	return { sessions };
}

/**
 * Whether `canary` passes `s`. No canary there: its hook cannot start, so it
 * refuses every session.
 * @param {Pick<RemarkPorts, "exists" | "hook">} ports
 * @param {string} canary
 * @param {LiveSession} s
 */
function isPassedBy({ exists, hook }, canary, s) {
	return exists(canary) && hook(canary, s).ok;
}

/**
 * Re-mark each session with the writer under `dir`, then check it with the
 * canary there: those it would still refuse. The writer records `root`'s
 * self-plugin as the plugin root: the only one the current canary vouches for
 * (workflow-core#4712), so a re-mark records no root the session did not already have.
 * @param {Pick<RemarkPorts, "hook" | "mark">} ports
 * @param {string} dir
 * @param {LiveSession[]} sessions
 * @returns {Stranded[]}
 */
function remarkEach({ hook, mark }, dir, sessions) {
	/** @type {Stranded[]} */
	const stranded = [];
	for (const s of sessions) {
		mark(path.join(dir, WRITER), s);
		const check = hook(path.join(dir, CANARY), s);
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
 * Fast-forward the main checkout by `move` where every live session of `root`'s
 * repository would pass `to`'s canary, re-marking each first where `from..to`
 * changes it, and each session that started meanwhile after.
 * @param {RemarkPorts} ports `root` at `from`
 * @param {{ from: string, to: string, changed: string[] }} pass
 * @param {() => string | null} move the fast-forward: git's refusal, or null
 * @returns {Remarked}
 */
function remarkAroundMove(ports, { from, to, changed }, move) {
	const before = readClosure(ports, from);
	if ("why" in before) return { status: "stranding", stranding: before };
	const after = readClosure(ports, to);
	if ("why" in after) return { status: "stranding", stranding: after };
	if (!changed.some((c) => before.files.has(c) || after.files.has(c))) {
		const why = move();
		return why === null
			? { status: "moved", late: null }
			: { status: "refused", why };
	}
	const vouched = readRepoSessions(ports, {
		skip: new Set(),
		keep: (passed) => passed,
	});
	if ("why" in vouched) return { status: "stranding", stranding: vouched };
	const stranded = ports.inScratch(after.files, (dir) =>
		remarkEach(ports, dir, vouched.sessions),
	);
	if (stranded.length > 0)
		return { status: "stranding", stranding: { stranded } };
	const why = move();
	if (why !== null) return { status: "refused", why };
	const remarked = new Set(vouched.sessions.map((s) => s.sessionId));
	try {
		return {
			status: "moved",
			late: remarkLatecomers(ports, before.files, remarked),
		};
	} catch (err) {
		/* `main` has moved: the pass's install and report still owe it (workflow-core#4734). */
		return { status: "moved", late: { why: caught(err).message } };
	}
}

/**
 * After the fast-forward, re-mark each live session not in `remarked` that the
 * main checkout's canary, now `to`'s, refuses and `from`'s passes. Null where
 * none is left refused.
 * @param {RemarkPorts} ports `root` now at `to`
 * @param {Map<string, string>} before `from`'s closure
 * @param {Set<string>} remarked
 * @returns {Stranding | null}
 */
function remarkLatecomers(ports, before, remarked) {
	const refused = readRepoSessions(ports, {
		skip: remarked,
		keep: (passed) => !passed,
	});
	if ("why" in refused) return refused;
	if (refused.sessions.length === 0) return null;
	const passedBefore = ports.inScratch(before, (dir) =>
		refused.sessions.filter((s) =>
			isPassedBy(ports, path.join(dir, CANARY), s),
		),
	);
	const stranded = remarkEach(ports, ports.root, passedBefore);
	return stranded.length > 0 ? { stranded } : null;
}

module.exports = { remarkAroundMove };
