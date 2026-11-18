#!/usr/bin/env node
/*
 * guard-uncommitted-work.js — Stop hook. Blocks a turn that ends with this
 * session's own tracked edits still uncommitted in its checkout — its own
 * worktree (workflow-core#4229), or the main checkout where it still works there — and a
 * `result:` or `needs input:` turn that ends with this session still holding a
 * claim on a file whose changes are all committed (workflow-core#3565).
 *
 * TWO TREES, ONE KEY. Dirt is read from the session's tree (`sessionTree`, the
 * payload's cwd); the write ledger, claims and observations are the host
 * root's shared stores, keyed by the path in the session's tree
 * (`lib/arbiter-core.js`'s `treeRoot`), so git's spelling is the key. The two
 * trees agree because the harness runs the hook in the payload's cwd, which
 * `treeRoot` reads as the process's own.
 *
 * The uncommitted-work half of the turn-end rule, which this guard enforces,
 * lives in docs/agents/guard-registry.md §Conventions (workflow-core#2034); the
 * progress-report half is CLAUDE.md's, and nothing checks it (mantahostels#1555).
 * The commit-next order lives only in this guard's refusal (always-loaded
 * shed register R1, workflow-core#4113).
 *
 * It BLOCKS where mantahostels#908's push warning only warned. That ruling declined to
 * block on a red that may not be the session's own; here the ledger
 * intersection below bills only the session's own writes, and the remedy is
 * one always-available command.
 *
 * IT READS THE OUTGOING MESSAGE ON TWO PATHS: the `waiting:` stand-down below
 * (mantahostels#2567), reached only on a turn with dirt to name, and the
 * clean-claim limb's marker check (workflow-core#3565). mantahostels#872 — Stop hooks not firing
 * at all in one background session — still reaches this guard.
 *
 * IT WRITES NO `.hook-ran-` BREADCRUMB, and both paths deliberately read the
 * message without minting one: `hookMessage.readMessageFrom` records on every
 * call, and a guard crumbing only the turns those paths reach would read as
 * SILENT in `check-stop-guard-outcomes.js` on every window it crumbed none.
 *
 * A NEIGHBOUR'S DIRT IS SUBTRACTED ON TWO SIGNALS, not one: their live claim
 * (`readClaimedElsewhere`) and their live observation (`readObservedElsewhere`, mantahostels#2282),
 * both in `lib/neighbour-dirt.js` (workflow-core#615).
 *
 * WHAT IT DOES NOT COVER. The ledger is filled by a `PostToolUse` hook on
 * `Write`/`Edit`/`NotebookEdit`, so a file written from Bash — a `>` redirect,
 * a heredoc, `sed -i`, a generator — mints no entry there (mantahostels#296).
 *
 * ONE SLICE OF THAT IS CREDITED, AND THIS GUARD REFUSES ON IT (mantahostels#2778).
 * lib/claimed-bash-write.js, a dispatcher core, runs at `PreToolUse` on a Bash command,
 * and every write target it resolves LITERALLY that matches
 * lib/code-signal.sh's CODE globs — a `.js/.mjs/.cjs/.ts/.tsx/.jsx/.py/.sh`
 * extension, or anything under `.husky/` — is credited to this session, unless
 * another LIVE session holds a READABLE claim on it. That glob list is OWNED by
 * lib/claimed-bash-write.js's `CODE_EXT`/`CODE_DIR`, whose comment carries
 * the drift cost; read it there rather than trusting this copy.
 *
 * Everything else mints nothing and stays invisible here: a non-code path
 * (`docs/`, a `.md`, a fixture), a target the parser cannot resolve (a `$VAR`,
 * a command substitution, a heredoc body, a write spelling outside the nine it
 * reads), a path a live neighbour holds readably, every path at all where the
 * WHOLE lock store will not read, and every path where the hook payload carried
 * no session id.
 *
 * A neighbour's lock whose own record will not parse is not counted as
 * contention (lib/claim-warning.js's `creditable`), so their file can be
 * billed to you here. And the credit is INTENT, taken at `PreToolUse` before the
 * command runs, so an entry outlives a command a sibling guard denied or that
 * simply failed — after which a neighbour's later UNCLAIMED edit to that path
 * is refused here as your own dirt. concision-backstop.sh drops both by
 * intersecting with `git diff`; this guard intersects with `git status`, which
 * does not.
 *
 * Widening to unattributed dirt is refused: a change attributable to nobody is
 * billed to nobody, because over-billing sends a session to edit files a live
 * neighbour is holding.
 *
 * IMPLICIT:  reads git state at Stop and refuses the turn while this session's
 *            own tracked edits sit uncommitted in its checkout — unless the
 *            turn is the `waiting:` hand-off docs/agents/guard-registry.md §Conventions makes the
 *            one exception, and a launch in this transcript is still out; and
 *            refuses a `result:` or `needs input:` turn while this session
 *            holds a whole-file claim on a clean file.
 * JUSTIFIED: fail-safe — an unattended job that stops mid-edit leaves the work
 *            unrecoverable-by-anyone-else for hours.
 * DEFEAT:    this file caps the block at six per session (`BLOCK_CAP`, mantahostels#2791),
 *            so a session that genuinely cannot commit — a red pre-commit
 *            gate — is taught and then released rather than
 *            trapped. The clean-claim
 *            limb takes the house cap of three, on a counter of its own.
 * TREE:      both — dirt from the session's tree; attribution from the host
 *            root's ledger, claims and observations.
 */

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

/* Six, not the house default of three (mantahostels#2791). 139 of 385 blocked sessions
 * reached the old cap, and 55% of those were still seeing a CHANGING path set
 * when the counter silenced them — three was too few for this guard
 * specifically.
 *
 * SPELLED OUT RATHER THAN TAKEN FROM `hookBlock.MAX_BLOCKS`: this 6 rests on
 * that measurement, so a future change to the house default must not silently
 * move it. `capSpent` below takes it too, or the early stand-down would silence
 * the guard at three and the raise would do nothing. */
const BLOCK_CAP = 6;

/**
 * Read through `hookMessage.readMessageText` for the header's reason. An unreadable
 * transcript answers no message, logged rather than crumbed (workflow-core#73).
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
 * The `waiting:` STAND-DOWN (mantahostels#2567). docs/agents/guard-registry.md §Conventions makes the one-line
 * `waiting:` hand-off "the exception and the only one" to the rule this guard
 * enforces, and the guard had no exemption for it: most of what it ever
 * blocked was a correct hand-off (censused on mantahostels#2567).
 *
 * IT IS THE LIVE CLAIM THAT EXEMPTS, NOT THE SPELLING (ruled at mantahostels#2567 over an
 * unconditional exemption). A `waiting:` a session merely types is an escape
 * hatch it can learn: write the word, stop, leave the tree dirty. So the
 * stand-down rests on the artefact `lib/pending-tasks.js` reads — a launch in
 * this transcript that nothing has settled — which a session cannot produce
 * without actually backgrounding work. A `waiting:` resting on nothing keeps
 * its block here, and in a background job draws `guard-priced-options.js`'s own
 * mantahostels#2487 refusal naming the real fault; outside one, this is the only thing that
 * catches it.
 *
 * EVERY THROWN PATH DECLINES THE STAND-DOWN, which is the opposite direction
 * to `pending-tasks.js`'s own consumer and deliberate: there the unproven claim
 * costs a missed refusal, here it would cost a session's work left
 * uncommitted.
 *
 * ONE PATH FAILS THE OTHER WAY, and it is `pending-tasks.js`'s own asymmetry
 * reaching through: a launch whose settlement that file cannot recognise stays
 * pending for the rest of the session, and here that is a standing exemption
 * rather than a missed refusal. Nothing detects it.
 *
 * THE MESSAGE IS READ THROUGH `hookMessage.readMessageText`, never `readMessageFrom`, whose
 * breadcrumb this guard must not mint — see the header.
 *
 * @param {import('./lib/stop-guard.js').StopPayload} payload
 * @param {string} sid
 * @returns {{down: boolean, why: string|null}} `why` is the sentence the block
 *   message carries, and is null unless the turn tried to hand off and failed.
 */
function waitingHandoff(payload, sid) {
	const { transcript, message } = readEnding(payload, sid);
	if (!message) return { down: false, why: null };

	const { name, payload: said } = governingMarker(message);
	/* A turn governed by another marker was never claiming to hand off, so there
	 * is nothing to explain. */
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
 * The refusal limb: this session's own tracked edits, still uncommitted.
 * @param {import('./lib/stop-guard.js').StopPayload} payload
 * @param {string} sid
 * @param {string} tree the checkout whose dirt is read
 * @returns {boolean} whether a block was emitted, and so whether stdout is spent
 */
function refuseUncommitted(payload, sid, tree) {
	/* ATTRIBUTION (mantahostels#114, mantahostels#1555). null is "the ledger could not be read", never
	 * "wrote nothing" — and both land on silence, because a change attributable
	 * to nobody is billed to nobody. Without this filter the guard would order a
	 * session to commit a file it never wrote. */
	const written = store.readWritesBy(sid, tree);
	if (written === null || written.length === 0) return false;

	const dirty = readDirtyTracked(tree);
	if (dirty === null) return false;

	const theirs = readClaimedElsewhere(sid, { tree });
	/* Already sorted, and unique by construction — see `readDirtyTracked`. */
	const claimFiltered = dirty.filter(
		(rel) => written.includes(rel) && !theirs.has(rel),
	);
	/* Nothing to name, so nothing `readObservedElsewhere` reads could change the
	 * answer — and this is what keeps its ~465 ms oracle off the ordinary clean
	 * turn. */
	if (claimFiltered.length === 0) return false;

	/* Everything below only assembles a reason `blockStop` would refuse to print
	 * once the cap is spent (mantahostels#2383). The prefix is written out twice
	 * deliberately: `hook-block.test.ts` reads it as a literal out of the
	 * `blockStop` call below, and a shared const would make it unreadable
	 * there. */
	if (
		hookBlock.capSpent({
			prefix: ".uncommitted-nagged-",
			sessionId: sid,
			max: BLOCK_CAP,
		})
	)
		return false;

	/* Below the cap check and above the ~465 ms oracle: this costs one transcript
	 * read, and only on a turn already carrying something to name. */
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
 * The second limb (workflow-core#3565): a turn ending `result:` or `needs input:` while
 * this session holds a whole-file claim on a file with no uncommitted change.
 * A `waiting:` turn or one with no marker is passed over: a session between
 * its own writes holds a clean file legitimately (mantahostels#66).
 * @param {import('./lib/stop-guard.js').StopPayload} payload
 * @param {string} sid
 */
function refuseHeldClean(payload, sid) {
	/* The cheap checks first: the claim read costs one `git status` a claim. */
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

/**
 * The whole of this guard's judgement on one turn; `lib/stop-guard.js` owns
 * everything around it.
 * @param {{sessionId: string, payload: import('./lib/stop-guard.js').StopPayload}} ctx
 */
function judge({ sessionId: sid, payload }) {
	const tree = sessionTree(payload);
	if (tree === null) return;
	if (refuseUncommitted(payload, sid, tree)) return;
	refuseHeldClean(payload, sid);
}

if (require.main === module) {
	/* The oracle read in `readObservedElsewhere` ends inside this hook's 15 s
	 * timeout, where the harness's kill would end the turn unjudged (workflow-core#4115). */
	startEntryClock("Stop");
	stopGuard.onPayload({ review: judge });
}
