#!/usr/bin/env bash
#
# bisect-step.sh — one step of the hand-fired bisect (mantahostels#947, the ticket that
# built it). `git bisect run` executes this at every commit it visits, and its
# EXIT CODE is the whole interface:
#
#   0        this commit is good
#   125      this commit is untestable — skip it, never judge it
#   1..124   this commit is bad
#   128..255 abort the bisect entirely
#
# WHICH CHECKS DECIDE THAT IS SELECTABLE, via BISECT_CHECK_SET (mantahostels#967, the ticket
# that added it). The scheduled sweep calls two workflows and three jobs; judging
# on one job's checks when the red lives in another does not produce an
# inconclusive run. git never re-tests either endpoint — `git bisect start BAD
# GOOD` asserts BAD is bad — so every commit returning good makes git name the
# BAD ENDPOINT as the first bad commit and exit 0. The reported culprit is then
# the tip of main, printed as a confident answer. bisect.yml pre-flights the bad
# endpoint to catch exactly that; this script's part is to offer the set that
# reproduces the red.
#
#   lint-and-tests  ci.yml's `Lint and tests` job — the default, and what this
#                   script did before the set existed.
#   python          ci.yml's `Python` job.
#   documents       roadmap-digest.yml's `Document guards` job.
#   all             the three in that order.
#
# Unset or empty reads as lint-and-tests, so a direct local run behaves exactly
# as it always has. An unrecognised value ABORTS (128) rather than falling back:
# a typo that silently judged on the wrong checks is the failure this ticket
# exists to close.
#
# Unlike the CI jobs, the first failure stops the step: this needs a verdict, not
# attributable signals. `documents` short-circuits too, though its job runs every
# step under `if: !cancelled()` — running the rest cannot change a verdict that is
# already bad.
#
# NO SET RUNS AN ISSUE-FILING REPORTER (scripts/report-*.js), which the
# document-guards job carried until #1557 and older commits in a range still
# hold. One files and refreshes a GitHub issue rather than failing, and
# bisect.yml grants no `issues: write` — so running it here would spam the
# tracker and fail for a reason having nothing to do with the commit under test.
#
# INSTALLS RUN INSIDE THE STEP because they change across the range: installing
# once at the top and reusing it would test every commit against the newest
# dependency tree. `npm ci` for lint-and-tests, the pinned pip requirements for
# python. A commit whose install cannot resolve is UNTESTABLE, not broken —
# calling it bad walks the search into the wrong half and names a commit merely
# adjacent to the real one.
#
# `documents` installs NOTHING, and that is most of what makes it cheap: its
# seven scripts import node builtins and relative paths only, and the
# `Document guards` job itself runs no install step.
#
# A check command's own 125 is folded back to 1 for the same reason in reverse:
# vitest and pytest do not use it today, but if either ever did, a bad commit
# would be silently stepped over. So 125 out of this script means the INSTALL
# failed and nothing else. Codes at or above 128 are left alone: those are
# signals, and aborting a bisect on a machine event is right.
#
# Run from a copy OUTSIDE the worktree: bisect checks out commits older than
# this file, where it does not exist.
set -euo pipefail

# Injected at their §N7 vars, never by PATH, because the tests feed each one
# chosen exit codes per subcommand (#2266).
npm_bin="${WFC_NPM:-npm}"
node_bin="${WFC_NODE:-node}"
python_bin="${WFC_PYTHON:-python3}"

# Runs one check, folding its own 125 back to 1 so that only an install failure
# can ever reach bisect as "skip this commit".
run_check() {
  local st=0
  "$@" || st=$?
  [[ "$st" -eq 125 ]] && st=1
  return "$st"
}

# ci.yml's `Lint and tests` job, in its order.
lint_and_tests() {
  if ! "$npm_bin" ci; then
    echo "bisect-step: npm ci failed — commit is untestable, skipping (125)" >&2
    return 125
  fi

  # By path, never `npx biome` — the bare name is an unrelated package that exits
  # 0 having checked nothing, which here marks a bad commit good (mantahostels#1538).
  #
  # Absent is UNTESTABLE, not bad. A path that does not exist exits 127, which
  # run_check does not fold, so bisect would read it as this commit's fault —
  # and it is reachable, every commit before Biome was adopted installing
  # cleanly without it. The bare name could not produce this: it always fetched
  # something.
  if [[ ! -x node_modules/.bin/biome ]]; then
    echo "bisect-step: node_modules/.bin/biome absent after a clean install — commit is untestable, skipping (125)" >&2
    return 125
  fi

  local st=0
  run_check node_modules/.bin/biome ci . || st=$?
  [[ "$st" -eq 0 ]] && { run_check "$npm_bin" run check:sh || st=$?; }
  # --full=coverage: a whole-suite run genuinely needed here, so this caller
  # keeps asking for it explicitly once mantahostels#3154 narrows the bare default
  # (mantahostels#3206). `coverage` (#182): the blast radius of a bisect step is
  # unknown by construction, so nothing narrower would do.
  [[ "$st" -eq 0 ]] && { run_check "$npm_bin" run test -- --full=coverage || st=$?; }
  return "$st"
}

# ci.yml's `Python` job. No npm ci: the pip install of the pinned requirements is
# this job's install step, and `npm run test:py` is `python3 -m pytest -n 2`,
# which reads nothing out of node_modules.
python_job() {
  if ! "$python_bin" -m pip install --require-hashes --only-binary :all: -r requirements-dev.txt; then
    echo "bisect-step: pip install failed — commit is untestable, skipping (125)" >&2
    return 125
  fi

  local st=0
  run_check "$npm_bin" run test:py || st=$?
  return "$st"
}

# Gates of roadmap-digest.yml's `Document guards` job, in its order. The
# report-only steps it carried until #1557 are gone from the job, so none of
# them can be the red being bisected.
documents() {
  local st=0
  run_check "$node_bin" scripts/check-digest-version.js || st=$?
  [[ "$st" -eq 0 ]] && { run_check "$node_bin" scripts/check-roadmap-valid.js --tree || st=$?; }
  [[ "$st" -eq 0 ]] && { run_check "$node_bin" scripts/check-doc-map.js || st=$?; }
  [[ "$st" -eq 0 ]] && { run_check "$node_bin" scripts/check-doc-map-markers.js || st=$?; }
  [[ "$st" -eq 0 ]] && { run_check "$node_bin" scripts/check-guard-registry.js || st=$?; }
  return "$st"
}

everything() {
  local st=0
  lint_and_tests || st=$?
  [[ "$st" -eq 0 ]] && { python_job || st=$?; }
  [[ "$st" -eq 0 ]] && { documents || st=$?; }
  return "$st"
}

check_set="${BISECT_CHECK_SET:-}"
[[ -n "$check_set" ]] || check_set="lint-and-tests"

status=0
case "$check_set" in
  lint-and-tests) lint_and_tests || status=$? ;;
  python) python_job || status=$? ;;
  documents) documents || status=$? ;;
  all) everything || status=$? ;;
  *)
    echo "bisect-step: unknown check set '$check_set' — aborting (128). Expected one of: lint-and-tests, python, documents, all." >&2
    exit 128
    ;;
esac

exit "$status"
