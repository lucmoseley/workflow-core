const path = require("node:path");
const { caught } = require("./caught.js");
const { isUnder } = require("./is-under.js");

const CANARY = "scripts/self-plugin-canary.sh";
const WRITER = "scripts/write-self-plugin-marker.sh";
const SOURCE_ARG = /^"\$(?:\{[^}]*\}|\w+)\/([^"$]+\.sh)"$/;
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
 * )} Remarked
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
 * }} RemarkPorts
 */

/**
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
 * @param {Pick<RemarkPorts, "exists" | "hook">} ports
 * @param {string} canary
 * @param {LiveSession} s
 */
function isPassedBy({ exists, hook }, canary, s) {
	return exists(canary) && hook(canary, s).ok;
}

/**
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
 * @param {RemarkPorts} ports
 * @param {{ from: string, to: string, changed: string[] }} pass
 * @param {() => string | null} move
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
		return { status: "moved", late: { why: caught(err).message } };
	}
}

/**
 * @param {RemarkPorts} ports
 * @param {Map<string, string>} before
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
