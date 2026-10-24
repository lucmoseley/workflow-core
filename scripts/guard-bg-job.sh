#!/usr/bin/env bash
# PreToolUse guard: hand a session the killed-background-job rule BEFORE it
# backgrounds anything (mantahostels#1904, under mantahostels#1900).
#
# INJECTION ONLY — it never denies. The rule it carries is **Unenforced**: no
# guard can tell a killed job from a finished one on the session's behalf, which
# is the whole reason scripts/bg-run.sh exists.
#
# WHY HERE RATHER THAN IN THE POOL. `docs/doc-map.md` §Capture and placement §3
# step 2 admits a rule to the always-loaded pool only where no trigger can be
# named, and this one has a trigger: a Bash call carrying `run_in_background`.
# A pointer in `docs/agents/guard-registry.md` §Subagent dispatch reaches only
# a session that happens to read the timed-watch rule; route (f) reaches the
# session that reaches for the flag without having read anything.
#
# IMPLICIT: on an ALLOWED backgrounded Bash call it injects the rule as
#   additionalContext and writes a `.rule-injected-*` latch file under
#   .claude/tmp/markers.
# JUSTIFIED: fail-safe — the rule has no enforcing guard, so the moment the flag
#   is set is the only moment it can be stated. The latch keeps that from
#   costing a session bytes on every background job.
# DEFEAT: `scripts/clear-rule-latch.sh` clears the latch and the rule is said
#   again; deleting this registration from self-plugin/hooks/hooks.json silences it.
#
# LIMITS
#  - It reads the Bash tool's own flag and nothing else. A job backgrounded any
#    other way sets no flag and is not seen: a `&` inside the command, `nohup`,
#    a script that daemonises, and — deliberately — the harness backgrounding a
#    foreground call itself after its 600 s timeout, which mantahostels#1900 measured as the
#    one route that survived.
#    That limit bounds the wake-never-arrives half of the rule (mantahostels#2550) harder
#    than the killed-job half: workflow-core#845's stall forensics (§8) put 8 of the 13
#    genuine waiting-on-nothing stalls on a self-backgrounded job, which sets no
#    flag, so the sessions likeliest to need that half are the ones this trigger
#    cannot reach. Nothing else reaches them either.
#  - The timer the rule prescribes is itself a background job, so its own
#    notification is dropped at the same rate the rule cites.
#  - The rule is stated ONCE PER SESSION, by gp_rule's latch.
#  - IT IS NOT THE ONLY EMITTER ON ITS OWN TRIGGER. A `git push` carrying the
#    flag fires guard-push-rules.sh on the same PreToolUse event, so one
#    delivery can carry four ids. GP_RULE_CAP is applied per guard AND per hook
#    entry, which is also the harness's own persistence boundary, so it is the
#    whole truncation guarantee. What the cap on this surface bounds is CONTEXT
#    COST over a session — check-context-budget.js's OVER-SESSION assertion,
#    which unions the distinct ids every guard wired on the tool can reach and
#    refuses a commit that raises an over-cap group (mantahostels#2004, mantahostels#2046).
#  - It FAILS OPEN on anything it cannot resolve, and the fail-open is RECORDED
#    (mantahostels#147). The one exception is gp_rule's store side, which exits 2 on a
#    fragment it cannot read (mantahostels#1762): a rule that cannot be stated is worth a
#    refused tool call.
#  - It guards the Bash tool. A background job started outside Claude Code sees
#    no hook.

set -uo pipefail

# The shared parser (mantahostels#123), resolved from this file's own location because a
# hook runs with an arbitrary cwd. The gate is ONE name, gp_begin, never
# `source`'s exit status (mantahostels#157). lib/guard-log.sh is sourced first and
# separately so the parser's own absence is recordable (mantahostels#147).
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every background job allowed unstated"
  exit 0
}

# The field every Bash payload carries, so the three fail-open checks inside
# gp_begin only ever fire on a payload that is genuinely malformed. NOT the flag
# and NOT `.session_id`: an absent flag is the ordinary case rather than a
# fault, and a missing session id matters only once a real background job has
# been identified — where gp_rule's own payload side records it. Either would
# write a fail-open line on every foreground Bash call in the repo, burying the
# records that mean something.
gp_begin '.tool_input.command' command

# jq renders `true` literally. `false` and an absent field both come back as the
# empty string — gp_payload_field appends `// ""`, and jq's `//` takes that
# branch on `false` as well as on null — so the test is on the string `true`
# alone and must stay positive; `!= "false"` would fire on every Bash call.
# A command whose text merely mentions the flag is not one: the field is read,
# never the command.
[[ "$(gp_payload_field '.tool_input.run_in_background')" == "true" ]] || gp_allow

gp_rule killed-background-job

gp_allow
