#!/usr/bin/env node
const { REFUSAL_NAMED_MAX, readDirtyTracked } = require("./lib/dirty-tree.js");
const { shellQuote } = require("./lib/sh-quote.js");
const { sessionTree } = require("./lib/host-root.js");
const hookBlock = require("./lib/hook-block");
const store = require("./lib/arbiter-store");
const hookMessage = require("./lib/hook-message");
const {
	readClaimedElsewhere,
	readObservedElsewhere,
} = require("./lib/neighbour-dirt.js");
const { readPendingTasks } = require("./lib/pending-tasks");
const { buildArbiterCommand } = require("./lib/build-arbiter-command.js");
const { governingMarker } = require("./lib/status-marker");
const stopGuard = require("./lib/stop-guard");
const { startEntryClock } = require("./lib/hook-deadline.js");

// lucmoseley/mantahostels#2791 measured 55% of 139 capped sessions still changing paths at cap 3
const BLOCK_CAP = 6;

/**
 * @param {import('./lib/stop-guard.js').StopPayload} payload
 * @param {string} sid
 */
function readEnding(payload, sid) {
	const transcript = hookMessage.transcriptPath(payload, sid);
	const message = hookMessage.readMessageText(payload, transcript, (err) =>
		require("./lib/arbiter-core").logError(
			"guard-uncommitted-work message",
			err,
		),
	);
	return { transcript, message };
}

/**
 * lucmoseley/mantahostels#2567
 * @param {import('./lib/stop-guard.js').StopPayload} payload
 * @param {string} sid
 * @returns {{down: boolean, why: string|null}}
 */
function waitingHandoff(payload, sid) {
	const { transcript, message } = readEnding(payload, sid);
	if (!message) return { down: false, why: null };

	const { name, payload: said } = governingMarker(message);
	if (name !== "waiting:") return { down: false, why: null };
	if (!said.trim())
		return {
			down: false,
			why: "its `waiting:` line carries nothing after the colon, so it names nothing to wait for",
		};

	let seen;
	try {
		seen = readPendingTasks(transcript);
	} catch {
		return {
			down: false,
			why: "this session's transcript could not be read, so the launch it rests on could not be confirmed",
		};
	}
	if (seen.pending.length > 0) return { down: true, why: null };
	return {
		down: false,
		why: `nothing this session launched is still running — its transcript holds ${String(seen.launches.length)} launch(es), every one already settled`,
	};
}

/**
 * @param {import('./lib/stop-guard.js').StopPayload} payload
 * @param {string} sid
 * @param {string} tree
 * @returns {boolean}
 */
function refuseUncommitted(payload, sid, tree) {
	// lucmoseley/mantahostels#114 lucmoseley/mantahostels#1555
	const written = store.readWritesBy(sid, tree);
	if (written === null || written.length === 0) return false;

	const dirty = readDirtyTracked(tree);
	if (dirty === null) return false;

	const theirs = readClaimedElsewhere(sid, { tree });
	const claimFiltered = dirty.filter(
		(rel) => written.includes(rel) && !theirs.has(rel),
	);
	if (claimFiltered.length === 0) return false;

	// lucmoseley/mantahostels#2383
	if (
		hookBlock.capSpent({
			prefix: ".uncommitted-nagged-",
			sessionId: sid,
			max: BLOCK_CAP,
		})
	)
		return false;

	const handoff = waitingHandoff(payload, sid);
	if (handoff.down) return false;

	const observed = readObservedElsewhere(sid, tree);
	const mine = claimFiltered.filter((rel) => !observed.paths.has(rel));
	if (mine.length === 0) return false;

	const truncated = mine.length > REFUSAL_NAMED_MAX;
	const named = mine.slice(0, REFUSAL_NAMED_MAX).map(shellQuote);
	const list = truncated
		? `${named.join(" ")} (and ${String(mine.length - named.length)} more)`
		: named.join(" ");
	const recipe = truncated
		? 'Commit them by pathspec — `git commit -m "<why, in plain language>" -- <paths>` — reading the full set off `git status --porcelain -uno` first, because there are too many to name here. '
		: `Commit by pathspec — \`git commit -m "<why, in plain language>" -- ${named.join(" ")}\`. `;

	return hookBlock.blockStop({
		prefix: ".uncommitted-nagged-",
		sessionId: sid,
		reason:
			`This turn ends with ${String(mine.length)} tracked file(s) this session wrote still uncommitted in ${tree}: ${list}. ` +
			"A turn never ends with uncommitted work (docs/agents/guard-registry.md §Conventions). Your next tool call is the commit, not the summary. " +
			recipe +
			(tree === hookBlock.repoRoot()
				? "Never `git add` first, because the main checkout's index is every session's. "
				: "") +
			"Read `git diff` over those paths before you commit: this guard knows only that YOU wrote them at some point, so anything in there you did not write is somebody else's, and committing it puts their bytes under your message. " +
			(observed.why
				? `The check that subtracts a live neighbour's own writes could not run (${observed.why}), so read that diff especially carefully — a file a neighbour wrote from Bash may be named above. `
				: "") +
			(handoff.why
				? `The one exception to this rule is the \`waiting:\` hand-off, and this turn did not earn it: ${handoff.why}. Re-sending it unchanged will block again. `
				: "") +
			"If a pre-commit gate refuses the commit, say so plainly in your report, naming each path and the gate's refusal; do not silently leave the tree dirty. " +
			"Then re-send the message this turn was going to end on, its status marker (`result:` / `needs input:` / `waiting:`) and any priced question included — this block discarded it.",
		max: BLOCK_CAP,
	});
}

/**
 * #3565 lucmoseley/mantahostels#66
 * @param {import('./lib/stop-guard.js').StopPayload} payload
 * @param {string} sid
 */
function refuseHeldClean(payload, sid) {
	if (hookBlock.capSpent({ prefix: ".held-clean-nagged-", sessionId: sid }))
		return;
	const { message } = readEnding(payload, sid);
	if (!message) return;
	const { name } = governingMarker(message);
	if (name !== "result:" && name !== "needs input:") return;
	const clean = store.readHeldClean(sid);
	if (clean === null || clean.length === 0) return;

	const named = clean.map(shellQuote).join(" ");
	hookBlock.blockStop({
		prefix: ".held-clean-nagged-",
		sessionId: sid,
		reason:
			`This turn ends \`${name}\` while this session holds ${String(clean.length)} claim(s) on files with no uncommitted change: ${named}. ` +
			"Its work on them is committed, so each claim guards nothing, yet on a file under docs/ or .claude/, or CLAUDE.md or AGENTS.md, it still warns a neighbour who writes it of a likely merge conflict. " +
			`Release them: \`${buildArbiterCommand`release-committed ${clean}`}\` — a later write of yours re-takes the claim. ` +
			"Then re-send the message this turn was going to end on, its status marker and any priced question included — this block discarded it.",
	});
}

/** @param {{sessionId: string, payload: import('./lib/stop-guard.js').StopPayload}} ctx */
function judge({ sessionId: sid, payload }) {
	const tree = sessionTree(payload);
	if (tree === null) return;
	if (refuseUncommitted(payload, sid, tree)) return;
	refuseHeldClean(payload, sid);
}

if (require.main === module) {
	// #4115
	startEntryClock("Stop");
	stopGuard.onPayload({ review: judge });
}
