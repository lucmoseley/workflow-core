#!/usr/bin/env node
/*
 * guard-uncommitted-work.js — Stop hook. Blocks a turn that ends with this
 * session's own tracked edits still uncommitted in the shared working tree.
 *
 * The uncommitted-work half of the turn-end rule, which this guard enforces,
 * lives in docs/agents/guard-registry.md §Conventions (workflow-core#2034); the
 * progress-report half is CLAUDE.md's (mantahostels#1555).
 *
 * It BLOCKS where mantahostels#908's push warning only warned. That ruling declined to
 * block on a red that may be a neighbour's half-written file; here the ledger
 * intersection below removes a neighbour's dirt outright, and the remedy is one
 * always-available command.
 *
 * IT READS THE OUTGOING MESSAGE ON ONE PATH ONLY (mantahostels#2567): the `waiting:`
 * stand-down below, reached only on a turn that would otherwise block. mantahostels#872 —
 * Stop hooks not firing at all in one background session — still reaches this
 * guard.
 *
 * IT WRITES NO `.hook-ran-` BREADCRUMB, and the stand-down deliberately reads
 * the message without minting one: `hookMessage.readMessageFrom` records on every
 * call, and a guard crumbing only the rare turns it nearly blocks would read as
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
 * A SECOND LIMB WAS HERE AND IS GONE (mantahostels#2340, ruled at mantahostels#2338). It warned about
 * untracked in-repo scratch outside `.claude/tmp/` on the `systemMessage`
 * channel. mantahostels#2319 measured that text reaching the model on ZERO of 598 firings
 * and mantahostels#2338 measured every one of 1,004,194 `sessionKind` values across the
 * whole 3,915-transcript corpus as `"bg"`, so it had no reader on either side
 * and relabelling it founder-only would have documented an audience that does
 * not exist. `scripts/lib/root-scratch.js` now carries the same rule at
 * `PreToolUse`, which mantahostels#2319 proved live. `blockStop`'s own `reason` is
 * unaffected: mantahostels#2335 measured it reaching the model on all 3,631 firings.
 *
 * IMPLICIT:  reads git state at Stop and refuses the turn while this session's
 *            own tracked edits sit uncommitted in the shared tree — unless the
 *            turn is the `waiting:` hand-off docs/agents/guard-registry.md §Conventions makes the
 *            one exception, and a launch in this transcript is still out.
 * JUSTIFIED: fail-safe — an unattended job that stops mid-edit leaves the work
 *            unrecoverable-by-anyone-else for hours, and the fix is one command.
 * DEFEAT:    this file caps the block at six per session (`BLOCK_CAP`, mantahostels#2791),
 *            so a session that genuinely cannot commit — a denied file claim, a
 *            red pre-commit gate — is taught and then released rather than
 *            trapped. Before the cap, a path carrying an owned debt this
 *            session recorded is released at once (workflow-core#1170) — so a session can
 *            also release its own dirt by declaring it, which leaves a debt
 *            standing in the store until its issue closes.
 */

const {
	REFUSAL_NAMED_MAX,
	readDirtyTracked,
	gitRead,
	shellWord,
} = require("./lib/dirty-tree.js");
const { gitCommonDir, GIT_TIMEOUT_MS } = require("./lib/git.js");
const hookBlock = require("./lib/hook-block");
const store = require("./lib/arbiter-store");
const hookMessage = require("./lib/hook-message");
const {
	readClaimedElsewhere,
	readObservedElsewhere,
} = require("./lib/neighbour-dirt.js");
const { readPendingTasks } = require("./lib/pending-tasks");
const { scriptPath } = require("./lib/script-path.js");
const { governingMarker } = require("./lib/status-marker");
const stopGuard = require("./lib/stop-guard");

/* The git commands below run here, and the block counter lands here too. */
const REPO_ROOT = hookBlock.repoRoot();

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

/*
 * NO STAND-DOWN FOR THE CONCISION BACKSTOP. Its demand and this one do not
 * conflict — docs/agents/guard-registry.md §Conventions puts them in order, "satisfy the demand,
 * then the next tool call is the commit" — and honouring it would be unbounded:
 * `scripts/concision-backstop.sh` writes `.<kind>-nagged-<sid>` once and never
 * clears it, so a session that never ran the pass would be exempt for the rest
 * of its life (mantahostels#1555).
 */

/**
 * One git read against this repo, bounded by `lib/dirty-tree.js`'s ceiling.
 * @param {string[]} args
 * @returns {string|null} stdout, or null where git could not answer
 */
function git(args) {
	return gitRead(args, REPO_ROOT);
}

/**
 * Is REPO_ROOT this repo's shared working tree rather than a linked worktree?
 * The same test `scripts/lib/git-tree.js`'s treeClassifier makes: a linked
 * worktree's `--git-dir` is its own, the shared tree's equals `--git-common-dir`.
 * A directory git cannot answer for is treated as NOT the shared tree, so the
 * guard falls silent.
 * @returns {boolean}
 */
function inSharedTree() {
	const dir = git(["rev-parse", "--path-format=absolute", "--git-dir"]);
	const common = gitCommonDir(REPO_ROOT, { timeout: GIT_TIMEOUT_MS });
	if (dir === null || common === null) return false;
	return dir.trim() === common;
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
 * A SESSION CAN STILL MINT THE ARTEFACT, in two calls rather than one — a
 * backgrounded `sleep`, then the hand-off. That is not refusable and not worth
 * refusing: backgrounding real work is what CLAUDE.md asks for, and the cost of
 * the dodge is a session that has to keep launching to keep dodging.
 *
 * IT SAYS WHY IT DECLINED. A silent decline leaves the block naming dirt and
 * not the hand-off, and the remedy it prints — re-send the message — reproduces
 * the same input, so the session blocks again on a fault nothing named.
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
	const transcript = hookMessage.transcriptPath(payload, sid);
	/* An unreadable transcript fails open to blocking, logged rather than
	 * crumbed (workflow-core#73). */
	const message = hookMessage.readMessageText(payload, transcript, (err) =>
		require("./lib/arbiter-core").logError(
			"guard-uncommitted-work message",
			err,
		),
	);
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
 * @returns {boolean} whether a block was emitted, and so whether stdout is spent
 */
function refuseUncommitted(payload, sid) {
	/* ATTRIBUTION (mantahostels#114, mantahostels#1555). null is "the ledger could not be read", never
	 * "wrote nothing" — and both land on silence, because a change attributable
	 * to nobody is billed to nobody. Without this filter the guard would order a
	 * session to commit a live neighbour's half-written file. */
	const written = store.readWritesBy(sid);
	if (written === null || written.length === 0) return false;

	const dirty = readDirtyTracked(REPO_ROOT);
	if (dirty === null) return false;

	const theirs = readClaimedElsewhere(sid);
	/* An owned debt this session recorded is the remedy the refusal below
	 * prints, so its path is released (workflow-core#1170). */
	const declared = store.debtsOwnedBy(sid);
	/* Already sorted, and unique by construction — see `readDirtyTracked`. */
	const claimFiltered = dirty.filter(
		(p) => written.includes(p) && !theirs.has(p) && !declared.has(p),
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
	const mine = claimFiltered.filter((p) => !observed.paths.has(p));
	if (mine.length === 0) return false;

	const truncated = mine.length > REFUSAL_NAMED_MAX;
	const named = mine.slice(0, REFUSAL_NAMED_MAX).map(shellWord);
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
			`This turn ends with ${String(mine.length)} tracked file(s) this session wrote still uncommitted in the shared working tree: ${list}. ` +
			"docs/agents/guard-registry.md §Conventions: a turn never ends with uncommitted work in the shared tree, and the next tool call after any Stop-hook detour is the commit, not the summary. " +
			recipe +
			"Never `git add` first, because the index is repo-global. " +
			"Read `git diff` over those paths before you commit: this guard knows only that YOU wrote them at some point, so anything in there you did not write is somebody else's, and committing it puts their bytes under your message. " +
			(observed.why
				? `The check that subtracts a live neighbour's own writes could not run (${observed.why}), so read that diff especially carefully — a file a neighbour wrote from Bash may be named above. `
				: "") +
			(handoff.why
				? `The one exception to this rule is the \`waiting:\` hand-off, and this turn did not earn it: ${handoff.why}. Re-sending it unchanged will block again. `
				: "") +
			"If a pre-commit gate refuses the commit or a file claim is denied, say so plainly in your report and record the blocked edit as a visible debt — " +
			`\`node ${scriptPath("session-arbiter.js")} debt own <path> <issue> "<one line>"\` — which releases that path from this check; do not silently leave the tree dirty. ` +
			"Then re-send the message this turn was going to end on, its status marker (`result:` / `needs input:` / `waiting:`) and any priced question included — this block discarded it.",
		max: BLOCK_CAP,
	});
}

/**
 * The whole of this guard's judgement on one turn; `lib/stop-guard.js` owns
 * everything around it.
 * @param {{sessionId: string, payload: import('./lib/stop-guard.js').StopPayload}} ctx
 */
function judge({ sessionId: sid, payload }) {
	if (!inSharedTree()) return;
	refuseUncommitted(payload, sid);
}

if (require.main === module) stopGuard.onPayload({ review: judge });
