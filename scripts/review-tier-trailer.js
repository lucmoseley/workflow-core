#!/usr/bin/env node
/*
 * review-tier-trailer.js — writes a held commit's `Review-Tier:` trailer, the
 * commit's own record of its sensitive-path review (#3664, spec #1612
 * §Disposition and records, Reach). Its core is lib/review-tier-trailer.js,
 * its ports lib/review-tier-trailer-host.js; this entry wires them, writes
 * what the core returns and exits.
 *
 * IMPLICIT:  removes every `Review-Tier:` line from the message but one a cherry-pick's picked commit carries or, on an unchanged tree, HEAD's, saying so on stderr where the commit then goes on with none (#3906). Consumes this session's stamp scripts/review-hold-gate.js leaves on a pass (lib/review-tier-stamp.js names it). Where its tree is not the one this commit carries, a neighbour's `git add` moved the index under the later gates (#3905), so it runs the hold again, in-process, on what the commit now carries and refuses as the hold does. A stamp naming a review then writes `Review-Tier: <tier>; areas=<a,b>; base=<sha>; tree=<sha>; paths=<p,q>` into the message file.
 * JUSTIFIED: reach — scripts/report-remeasure-due.js counts a commit by it where no `**Review findings:**` comment names it.
 * DEFEAT:    any route that skips the hold skips the trailer with it: the founder's own terminal and `HUSKY=0`.
 *
 *   node scripts/review-tier-trailer.js <message file>     from .husky/prepare-commit-msg
 *
 * FAILS OPEN on its own faults, with one stderr line logged for
 * check-guard-errors.js. An empty message path, which a direct `sh -e` run of
 * the hook hands, consumes no stamp and logs nothing.
 *
 * LIMITS
 *  - A `git add` after git built the commit's tree and before this hook reads the
 *    index refuses a commit that carried the reviewed tree: fail closed.
 *  - A `Review-Tier:` line typed into $EDITOR survives, as this hook runs before
 *    the editor opens. A session commits with a message given.
 *  - `--no-verify` by hand mid-rebase reaches the replay path, never this script.
 *  - One session's two simultaneous commits share a stamp.
 *  - A message still to be typed into $EDITOR takes the trailer on its second
 *    line, which the subject then joins, so git reads no trailer there. The
 *    hold runs in a session alone, which commits with a message given.
 *
 * EXIT: 0 pass or fail-open · 1 the hold refused the moved tree · 2 usage.
 */

const { parseOrExit } = require("./lib/cli-args.js");
const { runTrailer } = require("./lib/review-tier-trailer.js");
const { buildTrailerPorts } = require("./lib/review-tier-trailer-host.js");
const { writeFd } = require("./lib/write-fd.js");

const { positionals } = parseOrExit(process.argv.slice(2), {
	usage: "usage: review-tier-trailer.js <message file>\n",
	min: 1,
	max: 1,
});
const { status, stderr } = runTrailer(
	positionals[0] ?? "",
	buildTrailerPorts({ cwd: process.cwd(), env: process.env }),
);
if (stderr) writeFd(2, stderr);
process.exit(status);
