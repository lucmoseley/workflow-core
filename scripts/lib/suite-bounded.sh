# shellcheck shell=bash
# suite-bounded.sh — "which test files does this `run-vitest.js` launch, or
# this running vitest runner line, name, and does it run only those?", for the
# guards.
#
# SOURCED, never run, its `launch_test_file_count`, `launch_is_bounded` and
# `vitest_line_workers` after lib/suite-launch.sh. Its callers (workflow-core#1186):
#
#   scripts/guard-suite-concurrency.sh  charges a launch and each running run
#                                       by the vitest workers its named files
#                                       can occupy (workflow-core#2558, workflow-core#2560)
#   scripts/guard-suite-background.sh   exempts a bounded launch from the
#                                       shell-timeout refusal
#
# and lib/suite-queue.js's `isPartSuite`.

# vitest.config.ts's maxWorkers, held equal to it by
# guard-suite-concurrency.test.ts: a run naming fewer test files than this is a
# part-suite (workflow-core#2558).
# shellcheck disable=SC2034  # read by guard-suite-concurrency.sh and isPartSuite
SUITE_WORKERS=3

# lib/test-kind.js's `JS_TEST_FILE` in bash's ERE, pinned equal to it by
# guard-suite-background.test.ts. Only a word of this shape bounds the run.
SUITE_TEST_FILE_RE='\.(test|spec)\.[cm]?[jt]sx?$'

# The flags whose next word, where it opens with no `-`, is their value rather
# than a path or filter: vitest's own valued flags, and `--changed`, whose next
# word run-vitest.js takes as its ref (workflow-core#2454). Residual: a valued flag off this
# list leaves its value read as a filter, so the run reads unbounded — the
# over-charging direction.
SUITE_VALUED_FLAGS=' --changed -t --testNamePattern --project --reporter -c --config -r --root --dir --shard --pool --environment --outputFile --maxWorkers --minWorkers --retry --bail --testTimeout '

# runner_test_file_count <word> <word> <run-vitest.js argv>… — prints how many
# test-file-shaped words the argv names, and returns 0, where the run is bounded
# to them; returns 1 where it is not. The two words skipped are
# `node <path>/run-vitest.js`, or an npm script's name.
#
# Not bounded: an `--adopt` run, which selects every reader of the paths it
# names, test files among them (workflow-core#1213); a run naming no test file (workflow-core#1196); and
# one carrying any other bare word that is no flag's value, which vitest reads
# as a substring filter over paths (workflow-core#2559). Residual: a directory filter
# (`-- scripts/lib/`) therefore reads as unbounded.
runner_test_file_count() {
  local word prev="" files=0
  shift 2
  for word in "$@"; do
    [[ "$word" == --adopt ]] && return 1
  done
  for word in "$@"; do
    if [[ -n "$prev" && "$SUITE_VALUED_FLAGS" == *" $prev "* && "$word" != -* ]]; then
      prev=""
      continue
    fi
    prev="$word"
    [[ "$word" == -* ]] && continue
    # guard-parse.sh blanks a quoted span; read the path back from it.
    declare -F gp_literal >/dev/null && word=$(gp_literal "$word")
    [[ "$word" =~ $SUITE_TEST_FILE_RE ]] || return 1
    ((files++))
  done
  ((files)) || return 1
  echo "$files"
}

# launch_test_file_count <word>… — runner_test_file_count over a wrapper or npm vitest
# launch's own argv; 1 for any other launch. Reads the `_sl_kind`, `_sl_script`
# and `_sl_taken` lib/suite-launch.sh's `suite_launch_kind` left set on the same
# words: the words after the script name are run-vitest.js's argv,
# `test:changed`'s behind the `--changed` its script bakes in, npm taking the
# first `--` (workflow-core#2454).
launch_test_file_count() {
  [[ "${_sl_kind-}" == wrapper || "${_sl_kind-}" == npm-vitest ]] || return 1
  [[ "${_sl_script-}" == test:changed ]] || {
    runner_test_file_count "${@:_sl_taken-1}"
    return
  }
  local -a argv=("${@:_sl_taken+1}")
  [[ "${argv[0]-}" == -- ]] && argv=("${argv[@]:1}")
  runner_test_file_count npm test:changed --changed ${argv[@]+"${argv[@]}"}
}

# launch_is_bounded <word>… — 0 where the launch runs only the test files it
# names.
launch_is_bounded() {
  launch_test_file_count "$@" >/dev/null
}

# Hand-copied as VITEST_ONESHOT and VITEST_WATCH in scripts/lib/admission.js.
# Move both (workflow-core#630).
VITEST_ONESHOT='[.]bin/vitest( .*)? (run|--run)( |$)'
VITEST_WATCH=' (--watch|watch)( |=|$)'

# vitest_line_watches <runner line> — 0 where a `.bin/vitest` runner line is a
# watcher: no `run` or `--run`, or an explicit `--watch` beside one.
vitest_line_watches() {
  ! [[ "$1" =~ $VITEST_ONESHOT ]] || [[ "$1" =~ $VITEST_WATCH ]]
}

# vitest_line_workers <runner line> — the vitest workers a running run can
# occupy (workflow-core#2560): runner_test_file_count over the words after the binary and
# its `run`, capped at SUITE_WORKERS. Hand-copied as `runningVitestSuites`'s weight in
# scripts/lib/admission.js; guard-suite-concurrency.test.ts reads both over one
# fixture set.
vitest_line_workers() {
  local -a words
  local i n
  vitest_line_watches "$1" && {
    echo "$SUITE_WORKERS"
    return
  }
  read -ra words <<<"$1"
  for ((i = 0; i < ${#words[@]}; i++)); do
    [[ "${words[i]}" =~ [.]bin/vitest$ ]] && break
  done
  words=("${words[@]:i+1}")
  [[ "${words[0]-}" == run ]] && words=("${words[@]:1}")
  if n="$(runner_test_file_count vitest run ${words[@]+"${words[@]}"})" && ((n < SUITE_WORKERS)); then
    echo "$n"
  else
    echo "$SUITE_WORKERS"
  fi
}
