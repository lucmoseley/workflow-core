#!/usr/bin/env bash
# PreToolUse guard: a hand-fired sweep spends the same daily budget the
# automatic one already spends (mantahostels#2202, ruled at mantahostels#2188).
#
# THE HOLE IT CLOSES. `scripts/check-ci-status.js` fires a sweep for itself when
# the newest verdict has gone stale (mantahostels#1816), bounded at three a day against the
# `.sweep-autofire` marker in the git common dir. A session typing
# `gh workflow run scheduled-checks.yml` spent nothing at all.
#
# `ci.yml` IS THE SAME SPEND (mantahostels#3514). mantahostels#3502's gate makes a re-fire of
# scheduled-checks.yml a no-op on an already-swept sha, so the documented way to
# re-test a still tree is `gh workflow run ci.yml` — the same `Full suite` the
# counter prices. Chosen over a second, cheaper counter for `ci.yml`: mantahostels#3495's
# three is derived from ONE GitHub Free minute pool, and a second counter would
# be spend that arithmetic never priced. A `ci.yml` run buys check-ci-status.js
# no verdict — it reads scheduled-checks runs alone.
#
# ONE BUDGET, THREE A DAY, SPENT BY EVERY ROUTE. Three of one, three of another or
# any mix exhausts the day. The counter is `scripts/lib/sweep-budget.js`, which
# the autofire also reads and writes, so the two arithmetics cannot drift — the
# guard shells out to it rather than transcribing the marker's schema into jq.
#
# A DENY, NOT A WARN (mantahostels#2188 Q4).
#
# NO EXEMPTION FOR SCHEDULE REPAIR (mantahostels#2188 Q3). A fire made while the ledger shows
# a missed slot spends the cap like any other. The autofire already covers the
# stale-verdict-plus-moved-HEAD condition a dropped slot produces, inside this
# same budget, so an exemption would double-count it, and the miss rate would
# make it near-universal.
#
# WHAT IT CANNOT SEE — four routes, because a Bash `PreToolUse` hook reads the
# command string it is handed and nothing else: the GitHub web UI, `gh api …
# /dispatches`, a fire from inside a script, and the founder's own terminal. The
# deny names them, from docs/agents/rules/sweep-fire-budget.txt.
#
# AN UNMATCHED SPELLING FIRES AND SPENDS NOTHING, so the matcher is deliberately
# generous about spelling: the binary by BASENAME (`/usr/bin/gh`), after a
# wrapper gp_unwrap strips (`env VAR=x`, `nohup`, `timeout 60`, …), past `gh`'s
# own global flags (`gh -R owner/repo workflow run …`) — both gp_gh_words's,
# shared with guard-branch-publish.sh (#772) — and with the workflow
# argument read through `gp_literal`, so a quoted `"scheduled-checks.yml"`
# counts.
#
# THE DISPLAY NAME IS MATCHED TOO (mantahostels#3514's review): `gh workflow run` accepts
# it, and `ci.yml`'s is `CI`. THE NUMERIC ID STAYS UNMATCHED: nothing in this
# repo prints it.
#
# A `--help` is excluded the other way: it prints usage and dispatches nothing,
# so spending a unit on one would be a refusal bought with no sweep.
#
# FAILS OPEN on anything unreadable — no node, an unwritable marker, a git that
# will not name a common dir — same house style as every guard here (mantahostels#103 §6),
# recorded via lib/guard-log.sh. A budget that cannot be counted refuses nothing.
# The one exception is the rule fragment: a budget that IS out still denies when
# docs/agents/rules/sweep-fire-budget.txt will not read, the deny naming the
# file instead (mantahostels#3128). No pre-emptive `gp_rule` limb, unlike the sibling
# guards: route (f)'s Bash cap sits within 30 B of full (docs/doc-map.md
# §Capture and placement §3), so the rule reaches a session on the deny alone.
#
# IMPLICIT: it SPENDS one unit of the day's sweep budget on every matching
#   command it allows, writing the shared `.sweep-autofire` marker in the git
#   common dir before the command runs.
# JUSTIFIED: fail-safe — the spend has to happen before the dispatch or a fire that hangs,
#   403s or is denied downstream leaves the budget unspent and the day
#   uncapped — the same trade check-ci-status.js makes when it writes the marker
#   before its own dispatch. The cost is that an abandoned command still costs a
#   unit, of three.
# DEFEAT: the four routes above are all outside this hook, so any of them fires
#   a sweep without spending anything; deleting the registration from
#   self-plugin/hooks/hooks.json silences it entirely.

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

# The rule's text lives once, in docs/agents/rules/sweep-fire-budget.txt.
SWEEP_RULE_FALLBACK="A hand-fired sweep spends the same three-a-day budget the autofire spends; the rule could not be read from docs/agents/rules/sweep-fire-budget.txt. Read that file, or this guard's header, before doing anything else."

SWEEP_WORKFLOWS=(scheduled-checks.yml scheduled-checks ci.yml CI)
BUDGET_JS="$here/lib/sweep-budget.js"

# `gh workflow run`'s flags that TAKE A VALUE. Without them `--ref main` leaves
# `main` looking like the workflow argument, and the sweep in
# `gh workflow run --ref main scheduled-checks.yml` goes uncounted.
GH_VALUE_FLAGS="--ref -r --field -F --raw-field -f --input --repo -R"

# Whether this segment fires the sweep workflow. `gh workflow run <file>`, with
# the file as typed or as a path ending in it — flags may sit either side of it,
# so the workflow is the first true positional rather than a fixed position.
sweep_named=0
sweep_seen_positional=0
sweep_arg() {
  local kind="$1" value="$3"
  [[ "$kind" == arg ]] || return 0
  # The FIRST positional is the workflow; anything after it is `gh`'s own extra
  # argument and never a second workflow.
  ((sweep_seen_positional)) && return 0
  sweep_seen_positional=1
  # THROUGH gp_literal, NOT the raw word. The segment splitter masks every quoted
  # span to a sentinel, so `gh workflow run "scheduled-checks.yml"` — an ordinary
  # spelling — compares equal to nothing and spends nothing. gp_literal gives
  # back the text the shell would have passed; its non-zero exit means an
  # expansion it could not resolve, which cannot be this filename.
  value="$(gp_literal "$value")" || return 0
  local wf
  for wf in "${SWEEP_WORKFLOWS[@]}"; do
    [[ "$value" == "$wf" || "$value" == */"$wf" ]] && sweep_named=1
  done
  return 0
}

fires_sweep() {
  gp_gh_words "$@" || return 1
  set -- ${_gp_gh_args+"${_gp_gh_args[@]}"}
  [[ "$(gp_literal "${1-}" 2>/dev/null)" == workflow &&
  "$(gp_literal "${2-}" 2>/dev/null)" == run ]] || return 1
  shift 2

  sweep_named=0
  sweep_seen_positional=0
  gp_scan_flags "$GH_VALUE_FLAGS" sweep_arg -- "$@"
  ((sweep_named))
}

judge() {
  local segment="$1"
  shift
  fires_sweep "$@" || return 0

  [[ -r "$BUDGET_JS" ]] ||
    gl_open "lib/sweep-budget.js unreadable — a hand-fired sweep allowed uncounted"

  local out verdict
  out="$(WFC_REPO_DIR="$(gr_root)" node "$BUDGET_JS" spend 2>/dev/null)"
  verdict=$?

  # 2 is this guard being unable to count, which allows (mantahostels#103 §6).
  #
  # AN EXIT CODE IS NOT ENOUGH TO DENY ON: node exits **1** on a load-time fault
  # — a syntax error, a missing module, a half-written `sweep-budget.js`
  # mid-save, which `scripts/guard-stale-script.sh` warns is a live condition in
  # this shared tree — which is the same 1 the CLI uses for "the day is out".
  # So the refusal turns on the figures being THERE: `<spent> <cap> <day>`, and
  # a 1 carrying anything else is node failing to start, not a budget verdict.
  local spent cap day
  case "$verdict" in
    0) return 0 ;;
    1)
      read -r spent cap day <<<"$out"
      [[ "$spent" =~ ^[0-9]+$ && "$cap" =~ ^[0-9]+$ &&
        "$day" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] ||
        gl_open "sweep-budget.js exited 1 with no budget figures ($out) — a hand-fired sweep allowed uncounted"
      ;;
    *) gl_open "sweep-budget.js exited $verdict ($out) — a hand-fired sweep allowed uncounted" ;;
  esac

  gp_deny "Today's sweep budget is gone: ${spent} of ${cap} already fired on ${day} (UTC), so the next unit is available on the day after ${day}.

$(gp_rule_text sweep-fire-budget "$SWEEP_RULE_FALLBACK")

The command: $(gp_unmask "$segment")" "$segment"
}

gp_walk_commands judge

gp_allow
