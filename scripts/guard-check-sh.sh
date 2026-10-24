#!/usr/bin/env bash
# PreToolUse guard: hand a session the two shellcheck rules BEFORE it runs the
# shell gate (mantahostels#1805, spec mantahostels#1762), and, before the full run, the
# changed-paths route that costs seconds rather than minutes (workflow-core#1015).
#
# INJECTION ONLY — it never denies and never warns. Both rules it carries are
# **Unenforceable**: nothing can check that a session read `npm run check:sh`'s
# output rather than trusting its exit code, and nothing can check that a new
# `source` line carries its directive before shellcheck is run on it. The third
# text, the changed-paths route, is advice, not a rule.
#
# Cost of its `if` narrowings, `Bash(*shellcheck *)` and `Bash(*npm *)`
# (mantahostels#2811): a bare `shellcheck` or `npm` with no further word never
# execs this guard, and neither spelling runs the gate.
#
# IMPLICIT: on a shell-gate command it injects two rules as additionalContext
#   (three texts before the full run) and writes a `.rule-injected-*` latch per
#   text under .claude/tmp/markers.
# JUSTIFIED: fail-safe — a `check:sh` that never found the binary prints no
#   findings, only `shellcheck: not found` and exit 127, which a session
#   skimming for findings misreads as a clean gate, so the moment before the
#   run is the moment to say so. The latch keeps that from costing a session
#   bytes on every later run.
# DEFEAT: `scripts/clear-rule-latch.sh` clears the latch and the rules are said
#   again; deleting this registration from self-plugin/hooks/hooks.json silences both.
#
# THE IDS ARE NAMED, NOT REQUESTED WHOLESALE, as on every other trigger: the
# ceiling is per call. Priority order is `shellcheck-not-installed` first — it
# is about whether this run means anything at all — then the directive rule,
# `shellcheck-source-directive`, which is about reading what it found.
# (Neither id opens a line here: a comment beginning `# shellcheck` is read as a
# directive by the tool this guard is about, and SC1073 fails the gate on it.)
#
# LIMITS
#  - SCOPE is `npm run check:sh` and `npm run check:sh:changed` (and their
#    `npm check:sh…` shorthands) and a direct `shellcheck` invocation. Only the
#    full run is told about `check:sh:changed`. `npm run lint` is deliberately out: it
#    never sees a `.sh` file (CLAUDE.md §Commands), so neither rule bears on it.
#  - It fires on a segment's own first word. A run reached through `xargs`,
#    `env`, `sudo` or a wrapper script states nothing.
#  - It does NOT check whether shellcheck is actually installed. Doing so would
#    make the injection conditional on a machine state that changes between the
#    hook and the run, and the rule is about how to read the output either way.
#  - It FAILS OPEN on anything it cannot resolve, and the fail-open is RECORDED
#    (mantahostels#147). The one exception is gp_rule's store side, which exits 2 on a
#    fragment it cannot read (mantahostels#1762).
#  - It guards the Bash tool. A gate run outside Claude Code sees no hook.

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every command allowed unchecked"
  exit 0
}

gp_begin '.tool_input.command' command

# Prints the npm script a segment runs, empty where it is not npm. `npm
# check:sh` — no `run` — is npm's own shorthand and runs the same script.
# `set -u` above turns a short segment — a bare `npm` — into a crash mid-hook
# rather than a miss, hence :- on every word.
npm_script() {
  [[ "${1:-}" == npm ]] || return 0
  if [[ "${2:-}" == run ]]; then printf '%s' "${3:-}"; else printf '%s' "${2:-}"; fi
}

# Called once per command segment. It judges nothing; it records that the
# trigger fired, and the emission happens once at the foot of the file so a
# command carrying two runs is not told twice.
judge() {
  shift
  local script
  script="$(npm_script "$@")"
  if [[ "${1:-}" == shellcheck || "$script" == "check:sh:changed" ]]; then
    rule_subject=1
  elif [[ "$script" == "check:sh" ]]; then
    rule_subject=1
    full_run=1
  fi
}

# Not local; see judge.
rule_subject=0
full_run=0

gp_walk_commands judge

((rule_subject)) || gp_allow
if ((full_run)); then
  gp_rule shellcheck-not-installed shellcheck-source-directive shellcheck-changed-scope
else
  gp_rule shellcheck-not-installed shellcheck-source-directive
fi

gp_allow
