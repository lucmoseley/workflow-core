#!/usr/bin/env node
/*
 * record-acts.js — PostToolUse recorder on Bash: a session's raw `gh` close,
 * question round, `takes:` relabel and blocked-by edge, each written to its
 * acts ledger as one line (workflow-core#2308, workflow-core#2464, spec workflow-core#2245), so the refill loop can
 * tell what a launched session itself did. The core is lib/gh-acts.js, its
 * ports lib/gh-recorder-host.js.
 *
 * The scripted routes record their own acts: resolve-ticket.js its close and
 * file-issue.js its filing (lib/tracker-ops.js's recordOwnAct). A commit is the
 * post-commit hook's commit ledger, which the reader takes as an act.
 *
 * RUNS ONLY AFTER A CALL THAT EXITED 0 (workflow-core#2308), so a call a sibling guard
 * denies, or one gh refuses, records nothing.
 *
 * IT ONLY EVER RECORDS. Nothing is refused or injected, and every failure path
 * exits 0 in silence.
 *
 * WHAT A LINE IS:
 *   close <owner/name>#<n>             gh issue close
 *   round <owner/name>#<n>             gh issue comment whose body opens a
 *                                      `❓ **Qn**` round (lib/round-marker.js)
 *   relabel <owner/name>#<n> takes:<x> gh issue edit adding a takes: label, one
 *                                      line per label and issue
 *   block <owner/name>#<n>             a blocked-by edge added to <n>: a gh api
 *                                      POST to its dependencies/blocked_by, or
 *                                      gh issue edit --add-blocked-by
 *
 * LIMITS
 *  - The repo is the call's `--repo`, an issue URL's own, or else the origin
 *    remote of the directory the call ran in. gh's own default may differ there
 *    (`gh repo set-default`, an `upstream` remote); such a line names the
 *    origin.
 *  - THE COMMENT BODY IS READ in four spellings, through lib/gh-body.js:
 *    `--body <text>`, `--body-file <path>`, and `--body-file -` fed by a
 *    single-quoted heredoc or by `cat <path> |`. NOT READ, so no round line: a
 *    body in a `$VAR` or `$(…)`, stdin fed any other way, an unquoted heredoc
 *    holding `$`, a backtick or a backslash, `--editor` and `--web`, and a
 *    body file the same command writes before the call.
 *  - `--edit-last` and `--delete-last` post no new comment, so record nothing.
 *  - Only an ADDED `takes:` label is a relabel; a removal alone records nothing.
 *    Adding one the issue already carries records a line too: gh exits 0 and
 *    says nothing that tells the two apart.
 *  - A close of an issue already closed records nothing.
 *  - A raw `gh issue create` records no `file` line; file-issue.js writes it.
 *  - A `gh api` blocked-by POST is read through lib/gh-api-call.js; one whose
 *    method or endpoint is not a literal, or whose endpoint names one of
 *    `{owner}`/`{repo}` without the other, records nothing.
 *  - Every other `gh api` and GraphQL spelling, a script's own gh call, and the
 *    web UI record nothing.
 *  - An issue number in a shell variable records nothing.
 *  - A compound command reads as a whole: one whose LAST step failed is a
 *    PostToolUseFailure and records nothing, though its gh step landed.
 *  - Wired with `if: Bash(gh *)`, so a path-spelled `/usr/bin/gh` is never
 *    judged. With no node on PATH the hook line exits 0, unrecorded.
 *
 * IMPLICIT:  after a `gh issue close`, a round-opening `gh issue comment`, a `takes:` label added by `gh issue edit` or a blocked-by edge added, appends one line per act to the session's acts ledger.
 * JUSTIFIED: convenience — the record is the session's own, into its own ledger, which only the refill loop's progress test reads; the act itself has already landed.
 * DEFEAT:    evadable by spelling — any `gh api` call but a blocked-by POST, a shell variable, an unread body or the web UI all miss the seam — but there is no switch.
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/gh-acts.js");
const { buildHostPorts } = require("./lib/gh-recorder-host.js");

run({
	field: "command",
	noun: "command",
	event: "PostToolUse",
	decide,
	ports: buildHostPorts,
});
