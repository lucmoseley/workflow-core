#!/usr/bin/env node
/*
 * review-tier-trailer.js — writes a held commit's `Review-Tier:` trailer, the
 * commit's own record of its sensitive-path review (#3664, spec #1612
 * §Disposition and records, Reach). Its core is lib/review-tier-trailer.js,
 * its ports lib/review-tier-trailer-host.js; PROGRAM wires them and returns
 * what the core says, and the CLI below writes it and exits.
 *
 * IMPLICIT:  removes every `Review-Tier:` line from the message but one a cherry-pick's picked commit carries or, on an unchanged tree, HEAD's, saying so on stderr where the commit then goes on with none (#3906). Consumes this session's stamp scripts/review-hold-gate.js leaves on a pass (lib/review-tier-stamp.js names it). Where its tree is not the one this commit carries, a neighbour's `git add` moved the index under the later gates (#3905), so it runs the hold again, in-process, on what the commit now carries and refuses as the hold does. A stamp naming a review then writes `Review-Tier: <tier>; areas=<a,b>; base=<sha>; tree=<sha>; paths=<p,q>` into the message file.
 * JUSTIFIED: reach — scripts/report-remeasure-due.js counts a commit by it where no `**Review findings:**` comment names it.
 * DEFEAT:    any route that skips the hold skips the trailer with it: the founder's own terminal and `HUSKY=0`.
 *
 *   node scripts/review-tier-trailer.js <message file>
 *
 * .husky/prepare-commit-msg runs PROGRAM in-process, through
 * scripts/prepare-commit-msg-dispatch.js.
 *
 * FAILS OPEN on its own faults, with one stderr line logged for
 * check-guard-errors.js. A crash of PROGRAM itself is a refusal: the
 * dispatcher's row fails closed, and the CLI exits non-zero. An empty
 * message path consumes no stamp and logs nothing.
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

const { CliExit, parse } = require("./lib/cli-args.js");
const { runTrailer } = require("./lib/review-tier-trailer.js");
const { buildTrailerPorts } = require("./lib/review-tier-trailer-host.js");
const { writeFd } = require("./lib/write-fd.js");

const USAGE = "usage: review-tier-trailer.js <message file>\n";

/**
 * The trailer over the repo at `cwd`, as .husky/prepare-commit-msg's
 * dispatcher runs it in its own process (#5207): `args` is the CLI's.
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, args: string[] }} io
 * @returns {import("./lib/precommit-dispatch.js").RowResult}
 */
const PROGRAM = ({ cwd, env, args }) => {
	let positionals;
	try {
		({ positionals } = parse(args, { usage: USAGE, min: 1, max: 1 }));
	} catch (e) {
		if (!(e instanceof CliExit)) throw e;
		return e.code === 0
			? { exit: 0, stdout: e.text, stderr: "" }
			: { exit: e.code, stdout: "", stderr: e.text };
	}
	const { status, stderr } = runTrailer(
		positionals[0] ?? "",
		buildTrailerPorts({ cwd, env }),
	);
	return { exit: status, stdout: "", stderr };
};

module.exports = { PROGRAM };

if (require.main === module) {
	const { exit, stdout, stderr } = PROGRAM({
		cwd: process.cwd(),
		env: process.env,
		args: process.argv.slice(2),
	});
	if (stdout) writeFd(1, stdout);
	if (stderr) writeFd(2, stderr);
	process.exit(exit);
}
