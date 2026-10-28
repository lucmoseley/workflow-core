#!/usr/bin/env node
/*
 * record-divergence.js — PostToolUse recorder: every ff-only refusal and every
 * rejected push, with the divergence that caused it (#289). The core is
 * lib/divergence-row.js, its ports lib/divergence-row-host.js (#2797).
 *
 * IMPLICIT:  appends one row per refused `git pull` and per rejected `git push`
 *            to a per-repo log under the Claude config directory. Records only;
 *            it reaches no verdict and refuses nothing.
 * JUSTIFIED: convenience — #289 holds the counts. The measurement that looked
 *            like the cause sees only pushes that SUCCEEDED, and this file is
 *            the population it cannot reach; until the refusals are on record,
 *            any reconcile recipe (#290) is aimed at a cause nobody has
 *            established.
 * DEFEAT:    WFC_NO_DIVERGENCE_LOG=1 — recording stops entirely. There is no
 *            partial setting.
 * Overrides (test seams): WFC_PS, WFC_NOW.
 *
 * In no §N3 family: it refuses nothing, and `guard-*` names a hook that can
 * deny. Its exits are that family's all the same — always 0.
 *
 * IT REACHES THE OTHER REPO THROUGH THE PLUGIN, and needs no install of its own:
 * fantasy-books enables `workflow-core@workflow-core` in its .claude/settings.json
 * and pins it by tag, and the plugin ships this whole `scripts/` directory with
 * hooks/hooks.json's own registration of this file. So the second side of the
 * comparison arrives with the next release the adopter's pin is moved to —
 * nothing is copied by hand, and there is no second install route to drift.
 *
 * THE ROW, one line, tab-separated, append-only:
 *
 *   <ISO 8601 UTC>  <repo>  pull|push  <ahead>  <behind>  <state>  <sessions>  <ref>  <marker>
 *
 *   repo      the REPOSITORY's name, from the common git dir, so a linked
 *             worktree is filed under the repository and not under itself
 *   ahead     commits on HEAD and not on <ref>, at the moment of refusal
 *   behind    commits on <ref> and not on HEAD
 *   state     diverged | behind | ahead | level | unknown, read off those two
 *             counts — see the `ahead` LIMIT below for what it can and cannot say
 *   sessions  live Claude sessions on the machine, or `-` where unreadable
 *   ref       what ahead/behind were counted against, normally the pushed ref
 *   marker    the refusal string that matched, so a row can be traced to its cause
 *
 * WHERE IT LANDS: <first seat's config dir>/projects/<repo root, non-alphanumerics
 * to dashes>, beside guard-errors.log (#383), by arbiter-core.js's stateDirFor,
 * which takes the root as an argument where stateDir() takes the HOOK's own
 * repo: this file needs the repo the COMMAND ran in, which a `git -C` makes a
 * different one. One directory per repo is what makes the comparison readable:
 * scripts/divergence-report.js reads several.
 *
 * THE ORIGIN-TRACKING REF IS READ, NEVER REFRESHED. A `git pull` has already
 * fetched by the time it refuses, so its ahead/behind are current. A REJECTED
 * PUSH has fetched nothing, so its `behind` is a LOWER BOUND — the true figure
 * is at least that. Fetching here would be a network call on a hook, and it
 * would move a ref every parallel session can be reading. The report states the
 * bound; this file does not paper over it.
 *
 * LIMITS
 *  - Wired with `if: Bash(git *)`, so it is not run unless the command leads
 *    with `git` — which is why the wrapper blind spot below costs nothing extra:
 *    a `timeout git pull` reaches neither the narrowing nor the walk.
 *  - The command's own cwd is the payload's `.cwd`. A CROSS-REPO `git -C` IS
 *    FOLLOWED, as is a `cd` before the git call, because unfollowed it does not
 *    fail visibly: the row lands under the SESSION's repo with that repo's
 *    counts, so a refusal elsewhere reads as `level` — a state at which a
 *    fast-forward cannot be refused at all. A `-C` or `cd` path that does not
 *    resolve to a directory — a `~`, a `$VAR` — drops the row rather than
 *    filing it under the cwd, so a repo using those spellings is counted to a
 *    LOWER BOUND. THE ROW IS THEREFORE KEYED ON THE REPO REFUSED IN, WHERE
 *    #289's 20x baseline counted the SESSION's; the session's repo is not on
 *    the row to tell the two apart.
 *  - Command-position matching, by lib/shell-parse.js's git walk: a grep, an
 *    echo, a quoted string or a heredoc mentioning `git pull` is not a pull. A
 *    pull reached through a wrapper (`xargs`, `timeout`, `sh -c`) is not seen,
 *    the same blind spot the guard-pull-form core carries.
 *  - It records what the Bash TOOL ran. A pull typed in a terminal sees no hook,
 *    so the rate this measures is the agent-session rate, which is the rate #289
 *    counted in transcripts.
 *  - `ahead` IS THE TREE'S UNPUSHED COMMITS, NOT THIS SESSION'S. Every session
 *    here commits to one shared `main` (docs/agents/guard-registry.md §Conventions), so `diverged`
 *    means "somebody in this tree has committed" and cannot separate a session
 *    refused over its OWN commits from one refused over a neighbour's. #289 asks
 *    for that separation and this row does not carry it; attributing a commit to
 *    a session needs the arbiter's base records, which is a second instrument.
 *  - `sessions` counts `bg-pty-host` PROCESSES wearing a Claude argv[0], less
 *    the daemon's unclaimed spare — the reporting unit docs/environment.md §5
 *    names, counted by lib/claude-sessions.js. Rows before 17 Oct 2026 00:54
 *    UTC (#1798) count the spare too, one high. NOT the `claude agents --json`
 *    oracle, which admission uses: the oracle starts a Claude process of its own
 *    to answer and can block, and a hook that blocks costs every git call on the
 *    machine. So it over-counts a host outliving its session and misses a
 *    session driven interactively in a terminal, which spawns no host at all.
 *    argv[0] and never `comm` (mantahostels#481): a backgrounded session's
 *    `comm` is its version number.
 *  - It never writes to stdout or stderr. A PostToolUse hook's stdout is context
 *    handed to the session, and this one has nothing to say.
 *  - Every fault allows, and it always exits 0: there is nothing to fail closed
 *    to, since a row not written loses one observation and a hook that errors on
 *    a refused pull piles a second failure on the one being studied. A payload
 *    that is not JSON and a throw are logged to guard-errors.log, being the
 *    faults that silently produce the empty log the report calls a finding. An
 *    unwritable log directory and an unresolvable toplevel are not: both are
 *    visible in the row count against the other repo's.
 */

const path = require("node:path");

function main() {
	/** @type {(what: string, detail?: string) => void} */
	let log = () => undefined;
	try {
		const { logger, readPayload } = require("./lib/entry-input.js");
		log = logger(path.basename(__filename));
		const { divergenceRow } = require("./lib/divergence-row.js");
		const {
			appendRow,
			buildHostPorts,
		} = require("./lib/divergence-row-host.js");
		appendRow(
			divergenceRow(
				readPayload("a refused pull or push", log),
				buildHostPorts(process.env),
			),
		);
	} catch (e) {
		/* A checkout that has lost a lib records nothing, and says so where it
		 * can: a recorder that crashes on a refused pull is a second failure
		 * (#289). */
		log(`recorder threw — no divergence row written: ${String(e)}`);
	}
}

main();
