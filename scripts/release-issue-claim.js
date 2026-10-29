#!/usr/bin/env node
/*
 * release-issue-claim.js — PostToolUse releaser on Bash: when a session closes
 * an issue, drop that session's arbiter claim on it (mantahostels#706). The
 * core is lib/issue-claim-hook.js, its ports lib/gh-recorder-host.js.
 *
 * IT ONLY EVER RELEASES. Nothing is refused, nothing is injected, and every
 * failure path exits 0 in silence. A release that fails to write leaves the
 * claim standing for pruneIssueClaims's 7-day sweep; it already stops
 * excluding the issue once this session dies.
 *
 * LIMITS
 *  - A PostToolUse hook sees Bash tool calls only, so A CLOSE MADE FROM THE
 *    GITHUB WEB UI, BY A SCRIPT, OR THROUGH `gh api` RELEASES NOTHING. The
 *    7-day prune is what carries those.
 *  - IT DROPS THIS SESSION'S CLAIM ONLY. A session closing an issue a
 *    DIFFERENT session claimed leaves that claim standing.
 *  - A `--repo`-qualified close releases nothing: the claim store is
 *    per-repository. That holds EVEN WHERE --repo NAMES THIS REPOSITORY,
 *    unlike an issue URL, which is matched against the host repo's origin
 *    remote. The flag's value is as often an alias or a variable as a
 *    literal, and the cost of reading one wrong is dropping a claim this
 *    session is still working.
 *  - AN ISSUE NUMBER ARRIVING AS A SHELL VARIABLE OR A COMMAND SUBSTITUTION
 *    RELEASES NOTHING — `n=123; gh issue close "$n"`.
 *  - It runs AFTER the command, and reads the command rather than its result,
 *    so a close that failed still drops the claim. The issue becomes
 *    selectable again while this session may still be working it
 *    (mantahostels#633).
 *  - Wired with `if: Bash(gh *)` (mantahostels#2127; best-effort:
 *    docs/agents/guard-authoring.md's surface 4, which fails toward running) —
 *    not started unless some segment of the command leads with `gh`. A
 *    path-spelled `/usr/bin/gh …` matches no `Bash(gh *)` pattern, so it is
 *    unjudged. With no node on PATH the hook line exits 0, unrecorded.
 *
 * IMPLICIT:  after a `gh issue close <n>`, drops this session's arbiter claim on that issue.
 * JUSTIFIED: convenience — the release was written down in two places and no close path ever called it; a claim outliving its issue costs a stale line in `issue-claims` and nothing else.
 * DEFEAT:    evadable by spelling — `--repo`, a shell variable, `gh api` or the web UI all miss the seam — but there is no switch.
 */

const { run } = require("./lib/guard-entry.js");
const { decideRelease } = require("./lib/issue-claim-hook.js");
const { buildHostPorts } = require("./lib/gh-recorder-host.js");

run({
	field: "command",
	noun: "command",
	event: "PostToolUse",
	byHand:
		"`node scripts/session-arbiter.js release-issue <n>` to release a claim by hand",
	decide: decideRelease,
	ports: buildHostPorts,
});
