#!/usr/bin/env node
/*
 * guard-uncommitted-work.js — Stop hook. Blocks a turn that ends with this
 * session's own tracked edits still uncommitted in its checkout — its own
 * worktree (#4229), or the main checkout where it still works there — and a
 * `result:` or `needs input:` turn that ends with this session still holding a
 * claim on a file whose changes are all committed (#3565).
 *
 * TWO TREES, ONE KEY. Dirt is read from the session's tree (`sessionTree`, the
 * payload's cwd); the write ledger, claims and observations are the host
 * root's shared stores, keyed host-relative (`lib/neighbour-dirt.js`'s
 * `keyPaths`). Each dirty path is matched on its key and named as git in the
 * session's tree spells it.
 *
 * The uncommitted-work half of the turn-end rule, which this guard enforces,
 * lives in docs/agents/guard-registry.md §Conventions (#2034); the
 * progress-report half is CLAUDE.md's, and nothing checks it (mantahostels#1555).
 *
 * It BLOCKS where mantahostels#908's push warning only warned. That ruling declined to
 * block on a red that may not be the session's own; here the ledger
 * intersection below bills only the session's own writes, and the remedy is
 * one always-available command.
 *
 * IT READS THE OUTGOING MESSAGE ON TWO PATHS: the `waiting:` stand-down below
 * (mantahostels#2567), reached only on a turn with dirt to name, and the
 * clean-claim limb's marker check (#3565). mantahostels#872 — Stop hooks not firing
 * at all in one background session — still reaches this guard.
 *
 * IT WRITES NO `.hook-ran-` BREADCRUMB, and both paths deliberately read the
 * message without minting one: `hookMessage.readMessageFrom` records on every
 * call, and a guard crumbing only the turns those paths reach would read as
 * SILENT in `check-stop-guard-outcomes.js` on every window it crumbed none.
 *
 * A NEIGHBOUR'S DIRT IS SUBTRACTED ON TWO SIGNALS, not one: their live claim
 * (`readClaimedElsewhere`) and their live observation (`readObservedElsewhere`, mantahostels#2282),
 * both in `lib/neighbour-dirt.js` (#615).
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
 *            unrecoverable-by-anyone-else for hours, and the fix is one command.
 * DEFEAT:    this file caps the block at six per session (`BLOCK_CAP`, mantahostels#2791),
 *            so a session that genuinely cannot commit — a red pre-commit
 *            gate — is taught and then released rather than
 *            trapped. The clean-claim
 *            limb takes the house cap of three, on a counter of its own.
 * TREE:      both — dirt from the session's tree, then the main checkout's;
 *            attribution from the host root's ledger, claims and observations.
 */

const path = require("node:path");

const {
	REFUSAL_NAMED_MAX,
	readDirtyTracked,
	gitRead,
} = require("./lib/dirty-tree.js");
const { shellQuote } = require("./lib/sh-quote.js");
const { sessionTree } = require("./lib/host-root.js");
const hookBlock = require("./lib/hook-block");
const store = require("./lib/arbiter-store");
const hookMessage = require("./lib/hook-message");
const {
	keyPaths,
	readClaimedElsewhere,
	readObservedElsewhere,
} = require("./lib/neighbour-dirt.js");
const { readPendingTasks } = require("./lib/pending-tasks");
const { buildArbiterCommand } = require("./lib/build-arbiter-command.js");
const { governingMarker } = require("./lib/status-marker");
const stopGuard = require("./lib/stop-guard");

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
 * transcript answers no message, logged rather than crumbed (#73).
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
	const written = store.readWritesBy(sid);
	if (written === null || written.length === 0) return false;

	const tracked = readDirtyTracked(tree);
	if (tracked === null) return false;
	const dirty = keyPaths(tree, tracked);

	const theirs = readClaimedElsewhere(sid);
	/* Already sorted, and unique by construction — see `readDirtyTracked`. */
	const claimFiltered = dirty.filter(
		({ key }) => written.includes(key) && !theirs.has(key),
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

	const observed = readObservedElsewhere(sid);
	const mine = claimFiltered
		.filter(({ key }) => !observed.paths.has(key))
		.map(({ rel }) => rel);
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
			"docs/agents/guard-registry.md §Conventions: a turn never ends with uncommitted work, and the next tool call after any Stop-hook detour is the commit, not the summary. " +
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

/** A host-relative key inside a linked worktree: `.claude/worktrees/<name>/<rel>`. */
const WORKTREE_KEY_RE = /^\.claude\/worktrees\/([^/]+)\/(.+)$/;

/**
 * Whether a subject the store judged clean is clean in its own worktree too.
 * The store asks the main checkout's git, which ignores everything under
 * `.claude/worktrees/`, so a dirty worktree file reads clean there; a subject
 * inside a linked worktree, this session's or another's, is asked of that
 * worktree's own `git status`, untracked files included. Unanswerable reads as
 * not clean, which keeps the claim.
 * @param {string} subject
 * @returns {boolean}
 */
function isCleanInTree(subject) {
	const [, name, rel] = WORKTREE_KEY_RE.exec(subject) ?? [];
	if (name === undefined || rel === undefined) return true;
	const tree = path.join(hookBlock.repoRoot(), ".claude", "worktrees", name);
	return gitRead(["status", "--porcelain", "--", rel], tree) === "";
}

/**
 * The second limb (#3565): a turn ending `result:` or `needs input:` while
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
	const held = store.readHeldClean(sid);
	if (held === null) return;
	const clean = held.filter(isCleanInTree);
	if (clean.length === 0) return;

	const named = clean.map(shellQuote).join(" ");
	hookBlock.blockStop({
		prefix: ".held-clean-nagged-",
		sessionId: sid,
		reason:
			`This turn ends \`${name}\` while this session holds ${String(clean.length)} claim(s) on files with no uncommitted change: ${named}. ` +
			"Its work on them is committed, so each claim guards nothing and refuses every neighbour who wants the file. " +
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
	/* The session's own tree first; then the main checkout, where a worktree
	 * session's ledgered write there is stranded work all the same. */
	const host = hookBlock.repoRoot();
	for (const t of tree === host ? [tree] : [tree, host])
		if (refuseUncommitted(payload, sid, t)) return;
	refuseHeldClean(payload, sid);
}

if (require.main === module) stopGuard.onPayload({ review: judge });
