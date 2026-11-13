#!/usr/bin/env node
/*
 * review-hold-gate.js — the pre-commit hold on a declared sensitive path (#1622,
 * spec #1612 §The hold). Its core is lib/review-hold.js, its ports
 * lib/review-hold-host.js; this entry wires them, writes what the core
 * returns and exits.
 *
 * IMPLICIT:  refuses a session's commit whose staged paths match a glob `sensitivePaths` declares in `.claude/workflow-core.json`, or that removes an area from that declaration or a glob from one (#3905), until the session's `.codereview-pass-<sid>` marker records `tier=escalated` or `tier=mission-critical`, `areas=` naming every matched area, `tree=` equal to the tree the commit carries, and `paths=` naming every path it changes — on a merge, every path it holds (#4426); the refusal names the areas, the marker's fault and rule:review-hold. On a pass it leaves the marker's tier, areas, base, tree and paths in this session's own stamp lib/review-tier-stamp.js names, so a neighbour's commit neither clears nor consumes it (#3906), keyed to that tree, for scripts/review-tier-trailer.js to write as the commit's `Review-Tier:` trailer (#3664).
 * JUSTIFIED: fail-safe — a session's worktree commit reaches `main` once the queue lander takes its queue ref, and an adopter deploying every push of it ships it, so a review owed on sensitive code is a hold at commit.
 * DEFEAT:    writing the marker's four lines by hand with no review behind them; a merge naming as its side a commit pushed to a remote-tracking ref with no hold behind it; `HUSKY=0` and `core.hooksPath` off .husky/_ skip it with the rest of the stack.
 *
 *   node scripts/review-hold-gate.js                  from .husky/pre-commit
 *
 * The tree a session records ahead of a pathspec commit is
 * `node scripts/commit-paths.js --tree`'s, the one computation of it (#1695);
 * here, in the hook, `git write-tree` reads the index git built for the commit.
 *
 * SKIPPED, silently, with no CLAUDE_CODE_SESSION_ID: the founder's own terminal.
 * The main checkout's commits are the guard-main-checkout-write core's to
 * refuse; this gate holds them as it holds a worktree's.
 * A CHERRY-PICK counts only the paths whose staged change differs from the picked
 * commit's own (#3905). A MERGE counts only the paths whose staged bytes are no
 * merged-in side's, each side reachable from a remote-tracking ref (#4383): a
 * land's merge of `origin/main` carries neighbours' commits, each held at its
 * own commit. Any other replay route reaching this is held whole.
 * A session committing into a repo it did not start in is held: the
 * declaration read is the committing repo's, the marker the session's own.
 *
 * LIMITS
 *  - The declaration is read at HEAD and as staged, never from the working
 *    tree, and an area either names is held. A commit narrowing it is held under
 *    what it drops.
 *  - A replay reaching no pre-commit is unheld: `git am`; a `git rebase`,
 *    `--continue` included; and a `--no-verify` commit, which a guard refuses
 *    unwrapped, beside a hand-made `rebase-merge`.
 *  - A pick whose glob paths change as the picked commit changed them passes,
 *    conflict elsewhere or not, under a forged CHERRY_PICK_HEAD naming one that
 *    carries the same change too. A `git cherry-pick -m 2` reads against the
 *    first parent, so it is held.
 *  - A merge's glob path whose bytes are a pushed side's passes, whoever pushed
 *    it: the founder's terminal's unheld commit, or one a forged MERGE_HEAD or
 *    GIT_REFLOG_ACTION names, included. A path both sides changed and git
 *    combined cleanly is held. A merge is held whole where a side is not on a
 *    remote-tracking ref, a GIT_REFLOG_ACTION name is no commit, git will not
 *    locate MERGE_HEAD, or it is a pull's, whose sides this gate cannot read.
 *  - A HEAD whose declaration will not parse holds nothing: it fails open.
 *  - A staged declaration that will not parse fails closed where HEAD declares an
 *    area, not open as the gate's other faults do: dropping every area by a typo
 *    is the narrowing this hold exists for (#3905).
 *  - `areas=` and `paths=` are comma-separated, so an area or a path whose name
 *    holds a comma can never be named there.
 *  - A neighbour's commit moves HEAD and so the tree a pathspec commit carries:
 *    `tree=` is then recomputed, with no new review owed.
 *
 * FAILS OPEN on its own faults — git that will not answer, a declaration
 * read that will not judge, a markers directory that will not resolve — with
 * one stderr line, logged for check-guard-errors.js. A crash of the entry
 * itself exits non-zero, which pre-commit's `|| exit "$?"` turns into a
 * refusal: fail closed.
 *
 * EXIT: 0 pass, skip or fail-open · 1 refuse · 2 usage.
 */

const { runHold } = require("./lib/review-hold.js");
const { buildHoldPorts } = require("./lib/review-hold-host.js");
const { writeFd } = require("./lib/write-fd.js");

const { parseOrExit } = require("./lib/cli-args.js");
const { scriptPath } = require("./lib/script-path.js");

/**
 * The hold over the repo at `cwd`, as the pre-commit dispatcher runs it in
 * its own process (#5172).
 * @type {import("./lib/precommit-gates.js").Program}
 */
const PROGRAM = ({ cwd, env }) => {
	const { status, stderr } = runHold(buildHoldPorts({ cwd, env }));
	return { exit: status, stdout: "", stderr: stderr ?? "" };
};

module.exports = { PROGRAM };

if (require.main === module) {
	parseOrExit(process.argv.slice(2), {
		usage: `usage: review-hold-gate.js   (no arguments; the tree a commit carries is node ${scriptPath("commit-paths.js")} --tree's)\n`,
	});
	const { exit, stderr } = PROGRAM({ cwd: process.cwd(), env: process.env });
	if (stderr) writeFd(2, stderr);
	process.exit(exit);
}
