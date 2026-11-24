#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const { logError } = require("./lib/arbiter-core");
const { ignoreFailure } = require("./lib/caught.js");
const { gitRead } = require("./lib/dirty-tree.js");
const hookBlock = require("./lib/hook-block");
const hookMessage = require("./lib/hook-message");
const { markersDir } = require("./lib/marker-root.js");
const { readPendingTasks } = require("./lib/pending-tasks");
const { scriptPath } = require("./lib/script-path.js");
const { ledgerRoot } = require("./lib/arbiter-ledger.js");
const { readUnpushedRef } = require("./lib/landing-refs.js");
const store = require("./lib/arbiter-store");
const { governingMarker } = require("./lib/status-marker");
const stopGuard = require("./lib/stop-guard");
const { sessionTree } = require("./lib/host-root.js");

const REPO_ROOT = hookBlock.repoRoot();

const SEEN_PREFIX = ".unpushed-seen-";

// workflow-core#766 guess
const NAMED_MAX = 10;

/** @param {string} sid */
function seenPath(sid) {
	return path.join(markersDir(REPO_ROOT), SEEN_PREFIX + sid);
}

/**
 * @param {string} sid
 * @returns {Set<string>}
 */
function readSeen(sid) {
	try {
		return new Set(
			fs.readFileSync(seenPath(sid), "utf8").split("\n").filter(Boolean),
		);
	} catch {
		return new Set();
	}
}

/**
 * @param {string} sid
 * @param {Set<string>} seen
 */
function writeSeen(sid, seen) {
	ignoreFailure(() =>
		fs.writeFileSync(seenPath(sid), `${[...seen].join("\n")}\n`),
	);
}

/**
 * @param {string} sid
 * @returns {string[]|null}
 */
function readCommitLedger(sid) {
	const root = ledgerRoot();
	return root ? store.readCommitsBy(sid, root) : null;
}

/**
 * @param {string} sid
 * @param {string} tree
 * @param {string[]} [pushedElsewhere]
 * @returns {{ref: string, commits: string[]}|null}
 */
function readUnpushedMine(sid, tree, pushedElsewhere = []) {
	const mine = readCommitLedger(sid);
	if (mine === null || mine.length === 0) return null;
	const ref = readUnpushedRef({ root: REPO_ROOT, tree });
	const ahead = gitRead(
		["rev-list", "HEAD", "--not", ref, ...pushedElsewhere],
		tree,
	);
	if (ahead === null) return null;
	const own = new Set(mine);
	const commits = ahead.split("\n").filter((c) => own.has(c));
	return commits.length > 0 ? { ref, commits } : null;
}

/**
 * @param {import('./lib/stop-guard.js').StopPayload} payload
 * @param {string} sid
 */
function handingOff(payload, sid) {
	const transcript = hookMessage.transcriptPath(payload, sid);
	const message = hookMessage.readMessageText(payload, transcript, (err) =>
		logError("guard-unpushed-commits message", err),
	);
	if (!message) return false;
	const { name, payload: said } = governingMarker(message);
	if (name !== "waiting:" || !said.trim()) return false;
	try {
		return readPendingTasks(transcript).pending.length > 0;
	} catch (err) {
		logError("guard-unpushed-commits transcript", err);
		return false;
	}
}

const PUSH_STEP = `The push is your own act (\`rule:push-cadence\`): land it with \`node ${scriptPath("session-checkout.js")} land\`, which pushes your queue ref.`;

/** @param {string} dir */
function resolved(dir) {
	try {
		return fs.realpathSync(dir);
	} catch {
		return dir;
	}
}

/**
 * @param {{tree: string, ref: string, commits: string[]}} found
 * @param {boolean} own
 */
function describeUnpushed({ tree, ref, commits }, own) {
	const where = own ? "" : ` in the main checkout (${tree})`;
	const named = commits.slice(0, NAMED_MAX);
	const lines =
		gitRead(["show", "-s", "--format=%h %s", ...named], tree)
			?.split("\n")
			.filter(Boolean) ?? named.map((c) => c.slice(0, 8));
	const more =
		commits.length > named.length
			? `\n  (and ${String(commits.length - named.length)} more)`
			: "";
	return (
		`${String(commits.length)} commit(s) this session made${where} are not on ${ref}:\n` +
		`${lines.map((l) => `  ${l}`).join("\n")}${more}\n`
	);
}

/**
 * @param {string} sid
 * @param {string} tree
 * @returns {{tree: string, ref: string, commits: string[]}[]}
 */
function readUnpushedEach(sid, tree) {
	const host = resolved(REPO_ROOT);
	const sessionRef = readUnpushedRef({ root: REPO_ROOT, tree });
	const found = [];
	const named = new Set();
	for (const t of tree === host ? [tree] : [tree, host]) {
		const f = readUnpushedMine(sid, t, t === tree ? [] : [sessionRef]);
		const fresh = f?.commits.filter((c) => !named.has(c)) ?? [];
		for (const c of fresh) named.add(c);
		if (f && fresh.length > 0)
			found.push({ tree: t, ref: f.ref, commits: fresh });
	}
	return found;
}

/**
 * @param {{sessionId: string, payload: import('./lib/stop-guard.js').StopPayload}} ctx
 */
function judge({ sessionId: sid, payload }) {
	const tree = sessionTree(payload);
	if (tree === null) return;
	const found = readUnpushedEach(sid, tree);
	const commits = found.flatMap((f) => f.commits);
	if (commits.length === 0) return;
	const seen = readSeen(sid);
	if (commits.every((c) => seen.has(c))) return;
	if (hookBlock.capSpent({ prefix: ".unpushed-nagged-", sessionId: sid }))
		return;
	if (handingOff(payload, sid)) return;

	const emitted = hookBlock.blockStop({
		prefix: ".unpushed-nagged-",
		sessionId: sid,
		reason:
			"A warning, not a refusal — the next stop passes. " +
			found.map((f) => describeUnpushed(f, f.tree === tree)).join("") +
			`${PUSH_STEP} ` +
			"If you are holding it back — a neighbour's red suite, say — end with a message that says so and names the failing test, so the founder sees that the branch is ahead of GitHub. " +
			"Then re-send the message this turn was going to end on, its status marker included — this block discarded it.",
	});
	if (!emitted) return;
	for (const c of commits) seen.add(c);
	writeSeen(sid, seen);
}

if (require.main === module) stopGuard.onPayload({ review: judge });
