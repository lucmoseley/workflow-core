#!/usr/bin/env node
/*
 * warn-stale-script.js — is this run about to execute a neighbour's half-written
 * script? (mantahostels#1035)
 *
 * Usage:
 *   node scripts/warn-stale-script.js <session-id> <candidate>…
 *
 * Prints one warning per script that is BOTH dirty in the shared working tree
 * AND claimed by another live session, and nothing at all otherwise. It ALWAYS
 * exits 0 and never blocks anything: guard-stale-script.sh, the PreToolUse hook
 * that drives it, turns whatever comes back into `additionalContext`.
 *
 * cli-args-exempt: its argv is the hook's session id and candidate paths, never a caller's flags, and a refusal would break the always-0.
 *
 * THE FAILURE (mantahostels#1035). The working tree is repo-global, so `node scripts/x.js`
 * runs whatever bytes are on disk — a neighbour's mid-save file included.
 *
 * WARN, NEVER DENY. mantahostels#103 sets the line — deny on a structured fact where the
 * action has no legitimate use, warn where the guard is inferring. A dirty
 * neighbour file may be a finished-but-uncommitted edit, and a session must
 * never be blocked from running the repo's own tooling.
 *
 * WHY A CLAIM AND NOT DIRTINESS ALONE. `scripts/` is the busiest directory in
 * the repo and its writes are unrefused (mantahostels#287's detect-only tier), so warning on
 * every dirty script would fire on the session's own work-in-progress. The claim
 * is what names a live neighbour. The cost is the residual every warning states:
 * a dirty script under NO claim is invisible here, because a Bash-route write
 * mints no claim (mantahostels#364).
 *
 * A CANDIDATE is a path, or `npm-script:<name>` for an `npm run <name>` whose
 * package.json body names scripts/ files — the dominant invocation route here,
 * and the one a path-only reader would miss.
 *
 * THE HOLDER IS NAMED BY SESSION ID, not by the name `claude agents --json`
 * would give: that oracle costs ~465 ms (mantahostels#317) and this runs ahead of ordinary
 * Bash calls. Liveness comes from the sessions registry instead, which is a
 * filesystem read.
 */

const fs = require("node:fs");
const path = require("node:path");

const store = require("./lib/arbiter-store.js");
const { hostRoot } = require("./lib/host-root.js");
const { requiredGroup } = require("./lib/regex-group.js");

const ROOT = hostRoot();
/** A `scripts/` path in an npm script body, after a start, space or quote. */
const SCRIPT_PATH = /(?:^|[\s'"])(scripts\/[\w./-]+)/g;

/** @typedef {import("./lib/arbiter-store").ListedLock} Lock */
/** @typedef {Exclude<Lock, { unreadable: true }>} LiveLock */

/**
 * The scripts/ paths an `npm run <name>` body mentions. Text, not a shell parse:
 * a body naming a path it does not run buys a false warning, and a false warning
 * costs a sentence where a missed one costs the hang this guard exists for.
 * @param {string} name
 */
function npmScriptPaths(name) {
	let pkg;
	try {
		pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
	} catch {
		return [];
	}
	const body = pkg?.scripts?.[name];
	if (typeof body !== "string") return [];
	return [...body.matchAll(SCRIPT_PATH)].map((m) =>
		requiredGroup(m, 1, SCRIPT_PATH),
	);
}

/**
 * Every candidate resolved to a repo-relative watched path, de-duplicated.
 * @param {string[]} candidates
 */
function resolveCandidates(candidates) {
	/** @type {string[]} */
	const out = [];
	for (const raw of candidates) {
		const paths = raw.startsWith("npm-script:")
			? npmScriptPaths(raw.slice("npm-script:".length))
			: [raw];
		for (const p of paths) {
			const rel = store.relativeToRepo(p);
			if (rel !== null && store.isWatched(rel) && !out.includes(rel))
				out.push(rel);
		}
	}
	return out;
}

/**
 * How a warning names the session whose edit this run may be executing.
 *
 * session-arbiter.js has a near-twin for its DENIALS. Left unshared: four lines
 * of formatting, and the two say different things — a denial names who to go and
 * ask, this names whose edit you may be running.
 * @param {LiveLock} lock
 */
function describeHolder(lock) {
	const who = lock.sessionId || "an unidentified session";
	const when = lock.claimedAt ? `, holding it since ${lock.claimedAt}` : "";
	return `${who} (pid ${lock.pid ?? "unknown"})${when}`;
}

/**
 * @param {string} rel
 * @param {LiveLock} lock
 */
function warning(rel, lock) {
	return (
		`${rel} is uncommitted in the shared working tree and claimed by session ${describeHolder(lock)}, which is still running — so this run may be executing an unfinished edit (mantahostels#1035).\n\n` +
		"Nothing is blocked. But if the command hangs, errors strangely or answers implausibly, re-run it once the file is committed before believing the output or debugging the script.\n\n" +
		"What is held: node scripts/session-arbiter.js list\n\n" +
		"Residual: a script dirty under NO claim is invisible here — a Bash-route write mints none (mantahostels#364) — so silence is not proof the file is settled."
	);
}

/**
 * The warnings for `candidates`, newline-separated. Empty where there is nothing
 * to say AND where the answer is unavailable: an unreadable lock store must not
 * manufacture a warning, and mantahostels#103 §6 allows unchecked rather than guessing.
 * @param {string[]} candidates
 * @param {string | null} sessionId
 */
function warnings(candidates, sessionId) {
	const locks = store.listLocks();
	if (locks === null) return "";
	const out = [];
	for (const rel of resolveCandidates(candidates)) {
		const lock = locks.find((l) => "path" in l && l.path === rel);
		if (!lock || lock.unreadable || !lock.alive) continue;
		// The session's own work-in-progress is not news to it.
		if (!lock.sessionId || lock.sessionId === sessionId) continue;
		// null is "git could not say", which is not "dirty".
		if (store.gitDirty(rel) !== true) continue;
		out.push(warning(rel, lock));
	}
	return out.join("\n\n");
}

/** @param {string[]} argv */
function main(argv) {
	const [sessionId, ...candidates] = argv;
	if (candidates.length === 0) return 0;
	let text = "";
	try {
		text = warnings(candidates, sessionId || null);
	} catch (e) {
		// Fail open, and leave a record: a judge that silently stops judging is
		// what mantahostels#147 exists to surface.
		store.logError("stale-script", e);
		return 0;
	}
	if (text) process.stdout.write(`${text}\n`);
	return 0;
}

/* Before the require.main guard, not after: scripts/lib/run-in-process.js's
 * runInProcess patches process.exit to throw, so the guard below never
 * returns here to reach a later export line — a test's own
 * createRequire(SCRIPT) would find an empty exports object (mantahostels#2413). */
module.exports = { main, warnings };

if (require.main === module) process.exit(main(process.argv.slice(2)));
