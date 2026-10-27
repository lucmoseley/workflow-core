#!/usr/bin/env node
/*
 * guard-unpushed-commits.js — Stop hook. Warns a session that its own commits
 * sit on HEAD and not on the ref it pushes to (lib/landing-refs.js), while it can
 * still push them (#766).
 *
 * WHY. A push sends every unpushed commit, whoever made it, so a session that
 * leaves its commits for another to push is relying on a later session that
 * may never come. `.husky/post-commit`'s unpushed count speaks
 * mid-session, when a non-zero count is expected (mantahostels#316); this
 * speaks at the end.
 *
 * WARN, NEVER REFUSE, AND IT STILL BLOCKS. An automatic push would publish
 * past a neighbour's red, which `rule:push-green-suite` lets hold a push back. So the
 * guard only speaks, and a Stop hook has no other channel to the model than a
 * block's `reason` (docs/agents/guard-authoring.md §Which channel reaches the
 * model). The block says it is a warning, and the re-stop passes: each commit
 * is warned about once for ever, in `.unpushed-seen-`, with `.unpushed-nagged-`
 * as the loop bound.
 *
 * ATTRIBUTION is the commit ledger `.husky/post-commit` writes
 * (`lib/arbiter-ledger.js`'s `recordCommit`): git records no session on a
 * commit, and every session commits as the same author. A neighbour's
 * unpushed commit is in no ledger of this session's, so it is never named.
 * A commit made with no session id, or mid-replay, is in none at all.
 *
 * THE LEDGER IS READ AT THE MAIN WORKTREE, where post-commit writes it, and
 * not at this session's project directory: a session started in a linked
 * worktree would otherwise read a store nothing writes.
 *
 * ONLY COMMITS ON HEAD COUNT. One not reachable from HEAD — a worktree commit
 * never fast-forwarded, or a rewound one — is not what a push would send.
 *
 * A `waiting:` TURN IS PASSED OVER, and marks nothing seen, so the warning
 * lands on the turn that ends the work rather than on the hand-off before it —
 * but only where a launch in the transcript is still out, as
 * guard-uncommitted-work.js rules it (mantahostels#2567): the word alone would
 * be an exemption a session could type.
 *
 * IMPLICIT:  reads this session's commit ledger and git at every Stop, and
 *            blocks one turn when a commit it made is on HEAD but not on the
 *            pushed ref and has not been warned about before.
 * JUSTIFIED: fail-safe — committed work is safe, but GitHub and the deploy lag
 *            until someone pushes, and the session that made the commits is the
 *            one that knows whether its suite is green.
 * DEFEAT:    once per commit and at most three blocks a session; silent where
 *            the pushed ref does not resolve, with no ledger, and on every
 *            failure path.
 */

const fs = require("node:fs");
const path = require("node:path");

const { logError } = require("./lib/arbiter-core");
const { gitRead } = require("./lib/dirty-tree.js");
const hookBlock = require("./lib/hook-block");
const hookMessage = require("./lib/hook-message");
const { markersDir } = require("./lib/marker-root.js");
const {
	readCommandOrDefault,
	moduleReader,
} = require("./lib/workflow-core-config.js");
const { readPendingTasks } = require("./lib/pending-tasks");
const { ledgerRoot } = require("./lib/arbiter-ledger.js");
const { readUnpushedRef } = require("./lib/landing-refs.js");
const { landingTwin } = require("./lib/rule-gates.js");
const { pushGateState } = require("./lib/test-gate.js");
const store = require("./lib/arbiter-store");
const { governingMarker } = require("./lib/status-marker");
const stopGuard = require("./lib/stop-guard");

const REPO_ROOT = hookBlock.repoRoot();

const MODULE_CTX = {
	moduleOn: moduleReader(REPO_ROOT, (what, detail) =>
		logError(`guard-unpushed-commits ${what}`, detail),
	),
};

const SEEN_PREFIX = ".unpushed-seen-";

/* How many commits the warning names; the rest are counted. A first guess,
 * unmeasured: 30 Sep's backlog, the case that raised #766, was 8. */
const NAMED_MAX = 10;

/**
 * @param {string[]} args
 * @returns {string|null}
 */
function git(args) {
	return gitRead(args, REPO_ROOT);
}

/** @param {string} sid */
function seenPath(sid) {
	return path.join(markersDir(REPO_ROOT), SEEN_PREFIX + sid);
}

/**
 * The commits already warned about. Unreadable reads as none, so a commit is
 * warned about again rather than never.
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
	try {
		fs.writeFileSync(seenPath(sid), `${[...seen].join("\n")}\n`);
	} catch {
		/* The block has gone out; the cost is one repeat, bounded by the counter. */
	}
}

/**
 * This session's commit ledger, read under the main worktree.
 * @param {string} sid
 * @returns {string[]|null}
 */
function readCommitLedger(sid) {
	const root = ledgerRoot();
	return root ? store.readCommitsBy(sid, root) : null;
}

/**
 * This session's commits on HEAD and not on the ref it pushes to, newest first, and
 * the ref's name — or null where there is nothing to say or git would not
 * answer.
 * @param {string} sid
 * @returns {{ref: string, commits: string[]}|null}
 */
function readUnpushedMine(sid) {
	const mine = readCommitLedger(sid);
	if (mine === null || mine.length === 0) return null;
	const ref = readUnpushedRef({ root: REPO_ROOT });
	const ahead = git(["rev-list", `${ref}..HEAD`]);
	if (ahead === null) return null;
	const own = new Set(mine);
	const commits = ahead.split("\n").filter((c) => own.has(c));
	return commits.length > 0 ? { ref, commits } : null;
}

/**
 * Is the turn a `waiting:` hand-off resting on a launch still out? Anything
 * unreadable answers no, so the warning goes out rather than being deferred.
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

/* Each id cited whole, so the registry's citation scan reads it. */
const CADENCE_CITATION = {
	"push-cadence": "`rule:push-cadence`",
	"push-cadence-landing": "`rule:push-cadence-landing`",
};

/**
 * The push, with `push_check` before it only where a push still owes a
 * certificate — `pushGateState` decides (#2933). A config it cannot read
 * keeps the check, which prints the fault itself. The rule named is the
 * route's: `landing` swaps in its twin, as guard-push-rules.js does (#2409).
 * @param {string} ref
 */
function buildPushStep(ref) {
	const rule = CADENCE_CITATION[landingTwin(MODULE_CTX, "push-cadence")];
	const gate = pushGateState({ root: REPO_ROOT });
	return gate.state === "skip"
		? `The push is your own act (${rule}): push to \`${ref}\` — ${gate.line}.`
		: `The push is your own act (${rule}): run \`${readCommandOrDefault("push_check")}\`, then push.`;
}

/**
 * @param {{sessionId: string, payload: import('./lib/stop-guard.js').StopPayload}} ctx
 */
function judge({ sessionId: sid, payload }) {
	const found = readUnpushedMine(sid);
	if (!found) return;
	const seen = readSeen(sid);
	if (found.commits.every((c) => seen.has(c))) return;
	if (hookBlock.capSpent({ prefix: ".unpushed-nagged-", sessionId: sid }))
		return;
	if (handingOff(payload, sid)) return;

	const { ref, commits } = found;
	const named = commits.slice(0, NAMED_MAX);
	const lines =
		git(["show", "-s", "--format=%h %s", ...named])
			?.split("\n")
			.filter(Boolean) ?? named.map((c) => c.slice(0, 8));
	const more =
		commits.length > named.length
			? `\n  (and ${String(commits.length - named.length)} more)`
			: "";

	const emitted = hookBlock.blockStop({
		prefix: ".unpushed-nagged-",
		sessionId: sid,
		reason:
			`A warning, not a refusal — the next stop passes. ${String(commits.length)} commit(s) this session made are not on ${ref}:\n` +
			`${lines.map((l) => `  ${l}`).join("\n")}${more}\n` +
			`${buildPushStep(ref)} ` +
			"If you are holding it back — a neighbour's red suite, say — end with a message that says so and names the failing test, so the founder sees that the branch is ahead of GitHub. " +
			"Then re-send the message this turn was going to end on, its status marker included — this block discarded it.",
	});
	if (!emitted) return;
	for (const c of commits) seen.add(c);
	writeSeen(sid, seen);
}

if (require.main === module) stopGuard.onPayload({ review: judge });
