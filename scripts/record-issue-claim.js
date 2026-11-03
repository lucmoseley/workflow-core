#!/usr/bin/env node
/*
 * record-issue-claim.js — PostToolUse recorder on Bash: when a session assigns
 * itself to an issue, record that claim in the session arbiter
 * (mantahostels#646). The core is lib/issue-claim-hook.js, its ports
 * lib/gh-recorder-host.js.
 *
 * WHY THE ASSIGNEE ALONE IS NOT THE CLAIM. It survives the session that set
 * it, so a dead session's assignee hid its issue from /pick-next's frontier
 * for good (mantahostels#633). The arbiter record carries the session id,
 * which liveness can be tested against.
 *
 * IT ONLY EVER RECORDS. Nothing is refused, nothing is injected, and every
 * failure path exits 0 in silence. A claim that fails to write leaves the
 * issue selectable.
 *
 * LIMITS
 *  - A PostToolUse hook sees Bash tool calls only, so AN ASSIGNMENT MADE FROM
 *    THE GITHUB WEB UI, BY A SCRIPT, OR THROUGH `gh api` RECORDS NOTHING. That
 *    fails open — the issue stays selectable.
 *  - `gh issue create --assignee @me` RECORDS NOTHING, and that one cannot be
 *    fixed here: the number the issue gets is in gh's output, not in the
 *    command. /to-spec assigns on creation, so a session on that route still
 *    runs `claim-issue <n>` itself.
 *  - `@me` only. An assignment spelled with the account's own login records
 *    nothing: knowing the login would cost a network call per Bash command.
 *  - A `--repo`-qualified edit records nothing: the arbiter's claim store is
 *    per-repository, so a number from another repository would be filed under
 *    this one. That holds EVEN WHERE --repo NAMES THIS REPOSITORY, unlike an
 *    issue URL, which is matched against the host repo's origin remote.
 *  - AN ISSUE NUMBER ARRIVING AS A SHELL VARIABLE OR A COMMAND SUBSTITUTION
 *    RECORDS NOTHING — `n=123; gh issue edit "$n" --add-assignee @me`. This
 *    reads the command text and never a shell that could expand it.
 *  - It runs AFTER the command, and reads the command rather than its result,
 *    so an assignment that failed still records a claim. It expires with the
 *    session either way.
 *  - Wired with `if: Bash(gh *)` (mantahostels#2127; best-effort:
 *    docs/agents/guard-authoring.md's surface 4, which fails toward running) —
 *    not started unless some segment of the command leads with `gh`. NEARLY
 *    the same test as the core's own basename check: `/usr/bin/gh …` passes
 *    the basename but matches no `Bash(gh *)` pattern, so a path-spelled call
 *    is unjudged. With no node on PATH the hook line exits 0, unrecorded.
 *
 * IMPLICIT:  after a `gh issue edit <n> --add-assignee @me`, records that issue claim in the session arbiter without the session asking.
 * JUSTIFIED: convenience — the rule it automates is written down and still spellable by hand (`session-arbiter.js claim-issue <n>`); left as prose it was a second thing to remember.
 * DEFEAT:    evadable by spelling — `--repo`, a shell variable, `gh api` or the web UI all miss the seam — but there is no switch.
 */

const { run } = require("./lib/guard-entry.js");
const { decideClaim } = require("./lib/issue-claim-hook.js");
const { buildHostPorts } = require("./lib/gh-recorder-host.js");

run({
	field: "command",
	noun: "command",
	event: "PostToolUse",
	byHand: "`node scripts/claim-issue.js <n>` to claim an issue by hand",
	decide: decideClaim,
	ports: buildHostPorts,
});
