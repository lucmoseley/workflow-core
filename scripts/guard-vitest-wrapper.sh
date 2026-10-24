#!/usr/bin/env bash
# PreToolUse guard: a vitest run that skips scripts/run-vitest.js has no stall
# watchdog (mantahostels#2002, the follow-on to mantahostels#1910's).
#
# THE FAILURE IT POINTS AT. A synchronous call that never returns parks a vitest
# worker for good. vitest cannot time one out — `testTimeout` is enforced on the
# event loop that call never yields to — so the parent waits on the worker with
# no output and no limit.
#
# scripts/run-vitest.js kills that run after five minutes of silence and names
# the file it parked in. `npm run test` and `npm run test:changed` go through it.
# A direct `vitest` invocation does not, and the single-file form
# (`node_modules/.bin/vitest run <file>`) is the one sessions reach for most.
#
# WARN, never deny. The command is not unsafe; it is unprotected, and the
# unprotected form is still the right one for a watcher or a bench. mantahostels#908/mantahostels#987's
# precedent for this class covers it. There is therefore no escape to spell: a
# session that means it re-runs the same command and reads past the warning.
#
# ONCE A SESSION FOR THE RULE, EVERY TIME FOR THE SUGGESTION (mantahostels#2275). The
# fragment is latched through gp_rule_told / gp_rule_mark_told; the wrapped
# command, which is different every time, is not.
#
# SCOPE — a ONE-SHOT vitest invocation the wrapper could have served:
#
#   vitest run …                 npx vitest run …
#   node_modules/.bin/vitest …   ./node_modules/.bin/vitest run …
#
# DELIBERATELY OUT OF SCOPE, because run-vitest.js hardcodes `run` and cannot
# serve them:
#
#   --watch / watch    an idle watcher is silent by design, so a silence
#                      watchdog would kill it between runs. `npm run test:watch`
#                      is uncovered by the watchdog for this reason and no
#                      other.
#   bench, list, related, init, typecheck, dev
#                      a different subcommand entirely; the wrapper would run
#                      `vitest run <that>`.
#
# BLIND SPOTS. It reads the command word, so a runner spelled some other way is
# invisible: `node node_modules/vitest/vitest.mjs`, a shell function, a script
# that invokes vitest for you, anything behind `sh -c`, and any launcher but
# `npx` — `pnpm vitest`, `yarn vitest` and `npm exec vitest` all pass unseen.
# Neither pnpm nor yarn is installed here, so supporting them would be coverage
# of a form nobody can type. `npm test -- …` is already wrapped and is not a
# case. CI is not a Bash tool call and is never seen; the watchdog covers it
# there through `npm run test` alone.
#
# FAILS OPEN on an unreadable command, recorded via lib/guard-log.sh — mantahostels#103 §6.
#
# Cost of its `if` narrowings, `Bash(*vitest *)` and `Bash(*npx *)`
# (mantahostels#2811): a vitest invocation carrying no argument at all —
# `vitest`, `node_modules/.bin/vitest` — matches neither pattern and never execs
# this guard, though judge() below would have warned on it.

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

# The fragment carries the operative rule; this is what a session gets when the
# store cannot be read, so it must still name the file to open.
WRAPPER_RULE_FALLBACK="A vitest run outside \`scripts/run-vitest.js\` has no stall watchdog; the rule could not be read from docs/agents/rules/vitest-wrapper.txt. Read that file before doing anything else."

# Does this word name the vitest binary? Either the bare name on PATH or a path
# whose LAST segment is exactly `vitest` — so `node_modules/.bin/vitest` matches
# and `scripts/run-vitest.js`, `vitest-foo` and `my-vitest` do not.
is_vitest_word() {
  [[ "$1" == vitest || "$1" == */vitest ]]
}

# The subcommands the wrapper cannot serve, because run-vitest.js hardcodes
# `run` and would turn any of them into `vitest run <that>`.
#
# A SUBCOMMAND IS READ IN THE FIRST POSITION ONLY, which is where vitest's cac
# parser takes one, so a flag's VALUE cannot silence the guard. `--watch` is
# still looked for anywhere, being a flag rather than a subcommand.
#
# THE RESIDUAL RUNS THE OTHER WAY: a subcommand behind a leading flag
# (`vitest --silent bench`) is read as a one-shot and warned about, telling a
# bench run to use a wrapper that cannot serve it.
#
# `--watch=false` reads as a watcher and is wrong only in staying silent — the
# same direction guard-suite-concurrency.sh chose, and for the same reason: a
# guard that mis-files a one-shot as a watcher gives advice, while one that
# mis-files a watcher as a one-shot gives WRONG advice.
is_unservable() {
  local word first="${1:-}"
  for word in "$@"; do
    case "$word" in
      --watch | --watch=*)
        return 0
        ;;
    esac
  done
  case "$first" in
    watch | bench | list | related | init | typecheck | dev)
      return 0
      ;;
  esac
  return 1
}

# `npx` flags, so `npx --no-install vitest run x` finds vitest. -p/--package take
# a value; the rest are switches. An unknown flag is skipped as a switch, which
# can swallow vitest's own name where that flag took it as a value — a miss, and
# the safe direction for a warn.
after_npx() {
  while (($#)); do
    case "$1" in
      -p | --package | -c | --call)
        shift 2 || return 1
        ;;
      -*)
        shift
        ;;
      *)
        printf '%s' "$1"
        return 0
        ;;
    esac
  done
  return 1
}

judge() {
  local segment="$1"
  shift
  local head="${1-}" name=""

  if is_vitest_word "$head"; then
    name="$head"
    shift
  elif [[ "$head" == npx || "$head" == */npx ]]; then
    shift
    name="$(after_npx "$@")" || return 0
    is_vitest_word "$name" || return 0
    # Drop everything up to and including the binary, so the tail below is
    # vitest's own arguments rather than npx's.
    while (($#)) && [[ "$1" != "$name" ]]; do shift; done
    shift || true
  else
    return 0
  fi

  is_unservable "$@" && return 0

  # The wrapper prepends `run` itself, so a `run` the session typed must not be
  # passed on — `vitest run run` runs a file called `run`.
  [[ "${1-}" == run || "${1-}" == --run ]] && shift

  # The heap cap comes with it: package.json's test scripts set it and
  # ~/.bashrc's default is double.
  local suggestion
  suggestion="NODE_OPTIONS=--max-old-space-size=2048 node $(gp_script_path run-vitest.js)"
  # Unmasked, so a quoted `-t "some name"` reads back as the session typed it
  # rather than as the splitter's sentinel.
  (($#)) && suggestion+=" $(gp_unmask "$*")"

  local body
  body="This command: $(gp_unmask "$segment")
Wrapped:      ${suggestion}"

  # The standing line names the failure and the id, so a session that has lost
  # the first delivery to a compaction knows what to reopen. It repeats
  # docs/agents/rules/vitest-wrapper.txt's own first sentence, and a test pins
  # the two together — an unpinned copy goes stale in the state where a session
  # is relying on it.
  #
  # gp_warn exits, which is what keeps the emission below from putting a second
  # additionalContext envelope on one hook's stdout.
  if gp_rule_told vitest-wrapper; then
    gp_warn "A vitest run outside \`scripts/run-vitest.js\` has no stall watchdog (\`rule:vitest-wrapper\`).

$body"
  fi

  # Emit, THEN latch: a hook cancelled at its timeout has its stdout discarded,
  # and marking first would leave a session told and never tell it (mantahostels#2261).
  # It shrinks that window rather than closing it, exactly as gp_rule's own
  # header admits: jq exiting 0 says the bytes reached the pipe, never that the
  # harness read them.
  gp_context "$(gp_rule_text vitest-wrapper "$WRAPPER_RULE_FALLBACK")

$body" ||
    gl_open "the warning did not render — vitest-wrapper left unlatched"
  gp_rule_mark_told vitest-wrapper
  exit 0
}

gp_walk_commands judge

gp_allow
