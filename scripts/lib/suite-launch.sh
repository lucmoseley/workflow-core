# shellcheck shell=bash
# suite-launch.sh — the one copy of "does this unwrapped command launch a
# suite, and which kind?" (#1528). Each caller picks the kinds it judges:
#
#   scripts/guard-suite-concurrency.sh  every kind but `npm-py`
#   scripts/guard-suite-background.sh   every kind
#   scripts/guard-unasked-rerun.sh      `npm-vitest` only
#
# SOURCED, never run, after lib/guard-parse.sh: a quoted word is read back
# through its `gp_literal`, and a host's `suiteRunners` through the
# `wfc_suite_runners` it sources, and an npm script's body through its
# `gr_root`. Without them, a quoted word and a declared runner go unrecognised.
#
# THE KINDS, in `_sl_kind`:
#   npm-vitest  `npm test`, `npm run test|test:changed`
#   npm-watch   `npm run test:watch`
#   npm-py      `npm test:py`, `npm run test:py`
#   wrapper     `node <path>/run-vitest.js`
#   other       a runner other than vitest — see `other_runner` — run bare,
#               or anything run through scripts/queue-run.js, `_sl_queued`
#               telling which
# `_sl_script` is the npm script's name, empty for the last two kinds, and
# `_sl_taken` counts the words naming the launch, so the script's own argv
# starts at word `_sl_taken + 1`.
#
# Process counting from `ps` is a different question and stays in
# guard-suite-concurrency.sh's `running_suites`, which calls `other_runner`
# alone.

_sl_kind=""
_sl_script=""
_sl_taken=0
_sl_queued=0
_sl_lit=""

# A word as typed: a quoted span put back where `gp_literal` can read it whole,
# else the masked word, which no launch spelling matches. A word holding no
# span is read as it stands, sparing a fork per word.
_sl_literal() {
  _sl_lit="$1"
  [[ -n "${QUOTED-}" && "$1" == *"$QUOTED"* ]] || return 0
  declare -F gp_literal >/dev/null || return 0
  local lit
  lit="$(gp_literal "$1" 2>/dev/null)" && _sl_lit="$lit"
  return 0
}

# suite_launch_kind <word>... — 0 where the words, wrappers already taken off
# by `gp_unwrap`, launch a suite; the kind is then in `_sl_kind`.
suite_launch_kind() {
  _sl_kind=""
  _sl_script=""
  _sl_taken=0
  _sl_queued=0
  (($#)) || return 1
  local -a words=()
  local word
  for word in "$@"; do
    _sl_literal "$word"
    words+=("$_sl_lit")
  done
  if other_runner "${words[@]}"; then
    _sl_kind=other
    return 0
  fi
  case "${words[0]##*/}" in
    node)
      if [[ "${words[1]-}" == queue-run.js || "${words[1]-}" == */queue-run.js ]]; then
        queued_other "${words[@]:2}" || return 1
        _sl_kind=other
        _sl_script=""
        _sl_taken=0
        _sl_queued=1
        return 0
      fi
      [[ "${words[1]-}" == */run-vitest.js ]] || return 1
      _sl_kind=wrapper
      _sl_taken=2
      return 0
      ;;
    npm) ;;
    *) return 1 ;;
  esac
  case "${words[1]-}" in
    test | test:py)
      _sl_script="${words[1]}"
      _sl_taken=2
      ;;
    run)
      case "${words[2]-}" in
        test | test:changed | test:watch | test:py) ;;
        *) return 1 ;;
      esac
      _sl_script="${words[2]}"
      _sl_taken=3
      ;;
    *) return 1 ;;
  esac
  case "$_sl_script" in
    test:py) _sl_kind=npm-py ;;
    test:watch) _sl_kind=npm-watch ;;
    *) _sl_kind=npm-vitest ;;
  esac
  return 0
}

# queued_other <word>... — 0 where the words after `node <path>/queue-run.js`
# are a launch it takes (#1776). Its `--` is optional, and a wrapper behind it
# is taken off, as queue-run.js reads the command. Any path ending
# `queue-run.js` is taken for the core's, so a host script of that name passes
# as queued.
queued_other() {
  [[ "${1-}" == -- ]] && shift
  (($#)) || return 1
  # gp_unwrap's arrays are its caller's, already read but restored all the same.
  local -a keep_unwrapped=(${_gp_unwrapped[@]+"${_gp_unwrapped[@]}"})
  local -a keep_wrappers=(${_gp_wrapper_words[@]+"${_gp_wrapper_words[@]}"})
  local rc=1
  if declare -F gp_unwrap >/dev/null; then
    gp_unwrap "$@"
    set -- ${_gp_unwrapped[@]+"${_gp_unwrapped[@]}"}
  fi
  (($#)) && queueable "$@" && rc=0
  _gp_unwrapped=(${keep_unwrapped[@]+"${keep_unwrapped[@]}"})
  _gp_wrapper_words=(${keep_wrappers[@]+"${keep_wrappers[@]}"})
  return "$rc"
}

# queueable <word>... — 0 where scripts/queue-run.js takes the launch (#1776):
# an `other` runner not already queued, or an npm `test`/`test:changed` whose
# script does not run run-vitest.js. Leaves the `_sl_*` reading of the words
# set.
queueable() {
  suite_launch_kind "$@" || return 1
  case "$_sl_kind" in
    other) ((!_sl_queued)) ;;
    npm-vitest) ! script_runs_runner "$_sl_script" ;;
    *) return 1 ;;
  esac
}

# script_runs_runner <npm script name> — whether the host's npm script runs
# run-vitest.js, the one runner `--queue` belongs to. An adopter's may be plain
# vitest, which refuses the flag outright (#552). A package.json or script it
# cannot read answers yes; an unparseable one is logged.
script_runs_runner() {
  local body pkg
  declare -F gr_root >/dev/null || return 0
  pkg="$(gr_root)/package.json"
  [[ -e "$pkg" ]] || return 0
  body="$(jq -r --arg s "$1" '.scripts[$s] // ""' "$pkg" 2>/dev/null)" || {
    ! declare -F gl_log >/dev/null ||
      gl_log "package.json unreadable — \`--queue\` offered without knowing whether \`$1\` runs run-vitest.js"
    return 0
  }
  [[ -z "$body" || "$body" == *run-vitest.js* ]]
}

# A SUITE RUN BY SOMETHING OTHER THAN VITEST (#330): `node --test`, `pytest`,
# `python3 -m pytest|unittest` and a bare `python3 <x>.test.py`. Judged on
# argv[0] and the flags BEFORE the script, where
# `node --test` puts its own: a script taking a `--test` argument is no suite,
# and `node --test`'s per-file children carry no `--test` of their own, so one
# run counts once.
#
# A HOST'S OWN RUNNER SCRIPTS COUNT TOO, declared under `suiteRunners` in its
# `.claude/workflow-core.json` as repo-relative paths, matched as a path suffix
# of the script word. Only the host running this guard is read, so another
# repo's declared runner stays invisible here.
#
# A FLAG THAT TAKES A VALUE ENDS THE READ: its value is taken for the script,
# so `node --import x --test` and `python3 -W ignore -m pytest` go uncounted.
#
# THE LADDER WAS MEASURED ON VITEST (docs/environment.md §6), so each of these
# costing one full vitest suite is an assumption, not a reading.
_sl_declared_runners=()
_sl_declared_read=0
other_runner() {
  local a0="${1##*/}" word base r
  shift
  case "$a0" in
    pytest | py.test) return 0 ;;
    node | nodejs | python | python[0-9]*) ;;
    *) return 1 ;;
  esac
  while (($#)); do
    word="$1"
    shift
    if [[ "$word" == -* ]]; then
      [[ "$a0" == node* && "$word" == --test ]] && return 0
      [[ "$a0" == python* && "$word" == -m ]] &&
        [[ "${1:-}" == pytest || "${1:-}" == unittest ]] && return 0
      # Inline code: no script follows.
      [[ "$word" == -c || "$word" == -e || "$word" == --eval || "$word" == -p ]] && return 1
      continue
    fi
    base="${word##*/}"
    if [[ "$a0" == python* ]]; then
      [[ "$base" == *.test.py || "$base" == test_*.py || "$base" == *_test.py || "$base" == pytest ]] && return 0
    fi
    if ((!_sl_declared_read)); then
      _sl_declared_read=1
      if declare -F wfc_suite_runners >/dev/null 2>&1; then
        mapfile -t _sl_declared_runners < <(wfc_suite_runners 2>/dev/null)
      fi
    fi
    for r in ${_sl_declared_runners[@]+"${_sl_declared_runners[@]}"}; do
      [[ -n "$r" ]] && [[ "$word" == "$r" || "$word" == */"$r" ]] && return 0
    done
    return 1
  done
  return 1
}
