/*
 * typecheck-red-host.js — the store lib/typecheck-red.js reads: one JSON file
 * per session, `.typecheck-red-<session>`, in the canonical checkout's markers
 * directory, so a commit in a worktree reaches a session rooted elsewhere
 * (#3824).
 *
 * A TAKE IS A RENAME, so of two calls answering at once only one reports it.
 * A session's leftover is pruned by lib/arbiter-markers.js's prefix list.
 */

const fs = require("node:fs");
const path = require("node:path");
const { writeFileAtomic } = require("./atomic-write.js");
const { caught } = require("./caught.js");
const { markersDir } = require("./marker-root.js");
const { repoRoot } = require("./test-pass-marker.js");

const PREFIX = ".typecheck-red-";
/* A judgement: room for about twenty `tsc` errors, and little context spent where
 * a neighbour's half-written file is what is RED. */
const OUTPUT_CAP = 2000;

/**
 * @param {string} root
 * @param {string} sid
 * @returns {string|null}
 */
function recordPath(root, sid) {
	const canonical = repoRoot(root);
	return canonical ? path.join(markersDir(canonical), `${PREFIX}${sid}`) : null;
}

/**
 * @param {string} root
 * @param {string} sid
 * @param {{ command: string, output: string }} attempt
 */
function recordRed(root, sid, { command, output }) {
	const file = recordPath(root, sid);
	if (!file) throw new Error("git names no canonical checkout");
	writeFileAtomic(
		file,
		JSON.stringify({
			at: new Date().toISOString(),
			command,
			output: output.slice(0, OUTPUT_CAP),
			cut: output.length > OUTPUT_CAP,
		}),
	);
}

/**
 * @param {string} root
 * @param {string} sid
 * @param {(what: string) => void} log
 * @returns {import("./typecheck-red.js").RedTry | null}
 */
function takeRed(root, sid, log) {
	const file = recordPath(root, sid);
	if (!file) return null;
	const taken = `${file}.${process.pid}`;
	try {
		fs.renameSync(file, taken);
		return JSON.parse(fs.readFileSync(taken, "utf8"));
	} catch (e) {
		/* Fails open (mantahostels#103 §6): no record is the ordinary answer on
		 * every call, and any other fault costs this one report. */
		if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT")
			log(`a RED record went unread: ${caught(e).message}`);
		return null;
	} finally {
		fs.rmSync(taken, { force: true });
	}
}

/**
 * @param {string} root
 * @param {(what: string) => void} log
 */
function buildHostPorts(root, log) {
	return { takeRed: (/** @type {string} */ sid) => takeRed(root, sid, log) };
}

module.exports = { buildHostPorts, recordRed, takeRed };
