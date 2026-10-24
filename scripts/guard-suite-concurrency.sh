#!/usr/bin/env bash
# PreToolUse guard: refuse a test suite launched under the headroom
# docs/environment.md §6 says it needs resting, sending it to the queue, warn
# before a build launches under it — and before a watcher launches
# (mantahostels#1927).
#
# Why: admission.js prices a NEW session at dispatch time and holds no memory
# back for the suites it may run (workflow-core#2305); this covers a test suite or build
# inside an ALREADY-admitted one. Judged against docs/environment.md §6's
# suite-concurrency ladder, its dips hand-copied into SUITE_DIP_MB below — never
# read from admission.js.
#
# THE MEMORY LADDER QUEUES (workflow-core#2305): a test launch short of its rung is refused,
# its first line the same launch through the queue, which polls this guard
# until the rung is free. A `--queue` launch and a build are warned, never
# refused.
#
# THE COUNT CAP (workflow-core#155) refuses a FOURTH concurrent suite the same way, as
# territory no bench has ever priced. The count comes from `ps`, so a dead
# process leaves no line: there is no lock or latch to clear, and a deny you
# cannot reproduce has already lifted.
#
# THAT COUNT IS READ FROM `ps` AT PreToolUse TIME, SO TWO LAUNCHES INSIDE THE
# SAME WINDOW EACH SEE THEMSELVES AS FIRST and both are allowed — neither has a
# runner line for the other to find yet. LEFT OPEN DELIBERATELY (mantahostels#2186, workflow-core#159):
# a race can land an unmeasured fourth — rarer, three having to be going
# already — which risks a kill rather than a wait.
#
# THE DENY OPENS WITH THE COMMAND TO RUN INSTEAD (workflow-core#482, workflow-core#519): 86% of refused
# sessions re-issued with `--queue`, but the fix sat inside up to 2,113 bytes.
# Line one is the denied launch as typed, with `--queue` appended — `-- --queue`
# on an npm launch carrying no `--`. It is the SEGMENT, not a compound command's
# whole, so there line one says to keep the rest. Bash takes arguments after a
# redirection, so the flag lands behind one, and the walker hands the `--queue`
# and `--` checks the words either side of it (workflow-core#1007, workflow-core#1488) — so line one,
# re-submitted, passes; a quoted `--queue` is not the flag. A non-vitest
# runner (workflow-core#330), and an npm script that does not run run-vitest.js, is queued
# by scripts/queue-run.js instead (workflow-core#1776), so its line one is that launch
# through it. A watcher, which is vitest direct, has no queue:
# its line one is the wait and then the same launch.
#
# ITS ESCAPE IS `WFC_SUITE_CONCURRENT=1` prefixed on the command (mantahostels#2486,
# `gp_carries_var`). Every use of it is
# recorded (mantahostels#2183) — one JSON line per command stood down, at
# `.claude/tmp/markers/.suite-standdowns.jsonl`. Only the stand-down is
# written: a launch allowed for any other reason — a suite inside the cap, a
# `--queue` — leaves nothing, or the count would measure
# launches rather than overrides.
#
# TWO RESIDUALS OF ITS OWN. An open watcher counts as the suite already running,
# so a session holding one can launch nothing until it closes it — the refusal
# says so. And a build is never counted as a suite, being off the ladder.
# Its worker count carries lib/suite-bounded.sh's residuals besides.
#
# A BUILD BESIDE A RUNNING `next build`, AND A DEV SERVER BESIDE A RUNNING
# `next dev`, ARE DENIED (workflow-core#1733, workflow-core#1759), printing
# docs/agents/rules/build-concurrency.txt. No escape: nothing has measured two,
# and the rule says never. A build is `npm run build`, `next build`, `npx
# next build` or a path ending `/next` then `build`, and a dev server the same
# with `dev`, npm's own flags read as npm reads them. It counts
# `next build` and `next dev` runners alone, so a script running another tool
# passes unseen, and a build beside a dev server is not the rule's to refuse;
# the same-window race above applies.
#
# SCOPE: `npm run test`, `npm run test:changed`, `npm run test:watch`,
# `node scripts/run-vitest.js` (mantahostels#2015 — the wrapper guard-vitest-wrapper.sh
# sends every one-shot to, and so a one-line bypass of the count cap if
# left out), a build (`npm run build` or `next build`) and a dev server
# (`npm run dev` or `next dev`). Also (workflow-core#330)
# `node --test`, `pytest` and a Python test file run bare, plus the host's
# declared `suiteRunners`. lib/suite-launch.sh recognises each, quoted words
# read as typed (workflow-core#1528). `npm run test:py` is still not
# judged at launch, its runner being a script, but its `pytest` counts once
# running; a whole run of it still draws the memory figure (workflow-core#2024).
#
# A RUN NAMING ITS TEST FILES IS CHARGED BY THE VITEST WORKERS IT CAN OCCUPY
# (workflow-core#2558, ruled at workflow-core#2557), on the wrapper or the npm route: min(files named,
# SUITE_WORKERS), as lib/suite-bounded.sh reads them. A run of SUITE_WORKERS
# files or more is a whole suite, refused at the count cap and under its rung. A smaller one is refused under its own, lower
# rung alone, never at the count cap. One naming no test-file-shaped word
# (workflow-core#1196) is a whole suite too, a bare `test:changed` and a bare `npm run test`
# among them: a diff's selection has no ceiling. Only the worker count touches
# the denies.
#
# A `nohup`/`setsid`/`env`/`timeout`/`time`/`command`/`stdbuf`/`nice`/`ionice`/
# `xargs`/`sudo`/`bg-run.sh run <name>` WRAPPER IS STRIPPED before the scope test
# (mantahostels#2511, mantahostels#2552, `gp_unwrap`) — otherwise it stands where the command word is
# looked for and the whole launch is unseen. THE CLASS IS NOT CLOSED: a
# `sh -c "…"` and a heredoc are unstripped and walk past unjudged, for the two
# reasons `gp_unwrap`'s own header gives (mantahostels#2629) — `sh` is not a wrapper it
# strips and its payload is a blanked span, and a heredoc's body is dropped as
# data before segmentation. Neither is out of reach of this hook: both arrive in
# the command string it is handed.
#
# A bare `npx vitest` is COUNTED once running but never JUDGED on the way in:
# the scope test reads npm script names and that is not one. An
# `npm test -- --watch` IS judged, on the `test` script name — but only as a
# one-shot: the watcher limb is decided on the script name alone, so it opens a
# watcher and draws none. The flags after `--` ARE read, by `carries_full` and
# `carries_queue`, and `--watch` is simply not among what they look for.
#
# A COMPOUND COMMAND GETS ONE WARNING, NOT ONE PER SEGMENT: gp_warn exits at the
# first. So the watcher limb is decided by a PRE-PASS over every segment before
# any is judged (mantahostels#1978), and rides on whichever warning fires — in
# `npm run build && npm run test:watch` under the floor, on the build's.
# The limb names the watcher's own segment when that is not the warning's.
#
# A RUN NARROWED BY A DIFF IS JUDGED ON THE FULL-SUITE LADDER, an UPPER BOUND on
# what it will actually cost (mantahostels#1906): its size depends on the diff,
# so it has no rung of its own, and a warning on one can be over-strict.
#
# A BARE `npm run test` IS ONE OF THOSE (mantahostels#3208): the whole
# suite is `--full`, and everything else is the diff's selection. So the guard
# reads argv for `--full` and calls the launch full only where it finds
# it — the rungs are untouched (mantahostels#3209). `test:watch` is off this: a watcher runs
# everything and takes no such flag.
#
# IT COUNTS CONCURRENT SUITES (mantahostels#1906), and picks the ladder rung the launch
# would reach rather than always reading the one-suite floor.
#
# AN OPEN WATCHER (`npm run test:watch`) COSTS A FULL RUNG FOR AS LONG AS IT IS
# OPEN (mantahostels#1927) — not a rung only while a re-run is in flight. The runner line
# this guard counts on cannot tell the two apart: a watcher's argv is fixed at
# spawn and identical idle or running. A fork-count heuristic might separate
# them; nobody has measured whether the pool empties at idle. What an IDLE
# watcher actually dips is UNMEASURED — no bench row has ever held one open.
#
# FAILS OPEN on anything unreadable — no jq, no MemAvailable line — per mantahostels#103 §6,
# recorded via lib/guard-log.sh.
#
# It is narrowed to `if: Bash(*npm *)`, `if: Bash(*node *)`, `if: Bash(*next *)`
# (mantahostels#2811), `if: Bash(*python*)` and `if: Bash(*pytest*)` (workflow-core#330),
# and `if: Bash(*npx *)`, `if: Bash(*yarn *)`, `if: Bash(*pnpm *)`,
# `if: Bash(*bun *)`, `if: Bash(*make *)`, `if: Bash(*cargo *)` and
# `if: Bash(*go test*)`, for a host's declared `commands.test` (workflow-core#2303).
# The narrowing is best-effort (hooks.md:448), so the count-cap deny does not
# rest on it: the scope test below re-reads the command itself.
#
# IMPLICIT: it denies a FOURTH concurrent suite launch (workflow-core#155), and one under
#   its ladder rung (workflow-core#2305), unless the launch carries `--queue` or runs
#   through scripts/queue-run.js (mantahostels#2024, workflow-core#1776), and a run naming
#   fewer test files than SUITE_WORKERS under its own rung (workflow-core#2558); on a
#   test launch it warns about nothing, it injects the
#   suite-tree-dirty rule as additionalContext and writes a
#   `.rule-injected-*` latch under .claude/tmp/markers (mantahostels#1805). On a PLAIN `--full`
#   launch over a tree whose read graph renders it adds a second notice in
#   that same envelope, under a latch of its own: a bare `npm run test` would
#   be admissible here and would meet the push gate alone (workflow-core#181).
#   A LADDER WARN ON THE SAME LAUNCH OUTRANKS IT, gp_warn exiting before the
#   foot is reached, deliberately: a session told to wait for memory is not
#   also handed a rule about a result it has not got yet. The limb is left
#   unlatched and lands on the NEXT `--full`, after this one's wait has
#   already been spent. On a build or a
#   whole-suite launch it injects rule:memory-figure once a session, behind
#   the MemAvailable reading it judged (workflow-core#2024). On the host's declared
#   `commands.test` typed bare, with `suites` on, it injects
#   rule:targeted-runs once a session (workflow-core#2237). It also denies a
#   build beside a running `next build`, and a dev server beside a running
#   `next dev` (workflow-core#1733, workflow-core#1759), with no escape.
# JUSTIFIED: fail-safe — a session that cannot tell a neighbour's half-written
#   file from its own breakage debugs the wrong thing, and the launch is the
#   last moment before the verdict it will misread. The latch keeps it from
#   costing bytes on every later run.
# DEFEAT: `WFC_SUITE_CONCURRENT=1` prefixed on the command stands both denies down
#   for the whole command, as does the same name exported into the hook's
#   environment, and either is recorded when it does (mantahostels#2183);
#   `scripts/clear-rule-latch.sh` clears the latch and it is said again;
#   deleting the registration from self-plugin/hooks/hooks.json silences it. And the
#   deny reads the command it is handed, so a suite launched from INSIDE a
#   script never reaches this hook — which is why vitest's queue is a flag on
#   the launch (mantahostels#2024).

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/wfc-config.sh
source "$here/lib/wfc-config.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null

# shellcheck source=scripts/lib/suite-bounded.sh
source "$here/lib/suite-bounded.sh" 2>/dev/null
declare -F launch_test_file_count >/dev/null || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/suite-bounded.sh did not load — every command allowed unchecked"
  exit 0
}

# shellcheck source=scripts/lib/suite-launch.sh
source "$here/lib/suite-launch.sh" 2>/dev/null

# shellcheck source=scripts/lib/npm-options.sh
source "$here/lib/npm-options.sh" 2>/dev/null
# A failed source reads no `npm run` as a build or a dev server.
declare -F npm_canon >/dev/null || {
  declare -F gl_log >/dev/null 2>&1 &&
    gl_log "lib/npm-options.sh did not load — an \`npm run\` build or dev server launched uncounted"
  npm_canon() { canon=(); }
}

declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every command allowed unchecked"
  exit 0
}
declare -F suite_launch_kind >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/suite-launch.sh did not load — every command allowed unchecked"
  exit 0
}

gp_begin '.tool_input.command' command

MEMINFO="${WFC_MEMINFO:-/proc/meminfo}"
PS_BIN="${WFC_PS:-ps}"
# The suite ladder (docs/environment.md §6): MB of MemAvailable that must be
# resting before launching that many concurrent vitest workers (workflow-core#2558).
#
# A rung is earlyoom's 794 MB line + the dip those workers make + a ~300 MB
# margin that is FITTED, NOT MEASURED (mantahostels#463), rounded up to the next
# 50 MB. SUITE_DIP_MB is §6's dip for 0-3 whole suites, all measured at
# maxWorkers: 3 (workflow-core#1603); a part-suite of w workers adds w/SUITE_WORKERS of the
# next suite's increment. Past SUITE_MAX suites each worker adds the one-suite
# dip's share of one worker — EXTRAPOLATED, no fourth suite having been
# measured.
# SUITE_MAX is 3 because a fourth has never been measured (mantahostels#462,
# mantahostels#954). It is also the DENY line (workflow-core#155).
# SUITE_RESTING_MB and SUITE_MAX in scripts/lib/admission.js are the rungs at
# 1-3 whole suites, which guard-suite-concurrency.test.ts holds equal to these;
# EARLYOOM_MB and MARGIN_MB are its EARLYOOM_FLOOR_MB and DRAW_MARGIN_MB, which
# the same test pins one by one — bash cannot require it. Move both, or neither.

STANDDOWN_LOG=".suite-standdowns.jsonl"

EARLYOOM_MB=794
MARGIN_MB=300
SUITE_DIP_MB=(0 1046 2124 2546)
SUITE_MAX=3

# rung_mb <workers> — the rung for that many concurrent vitest workers,
# SUITE_WORKERS being lib/suite-bounded.sh's.
rung_mb() {
  local w="$1" n part dip
  n=$((w / SUITE_WORKERS))
  part=$((w % SUITE_WORKERS))
  if ((n >= SUITE_MAX)); then
    part=$((w - SUITE_MAX * SUITE_WORKERS))
    dip=$((SUITE_DIP_MB[SUITE_MAX] + (part * SUITE_DIP_MB[1] + SUITE_WORKERS - 1) / SUITE_WORKERS))
  else
    dip=$((SUITE_DIP_MB[n] + (part * (SUITE_DIP_MB[n + 1] - SUITE_DIP_MB[n]) + SUITE_WORKERS - 1) / SUITE_WORKERS))
  fi
  echo $(((EARLYOOM_MB + dip + MARGIN_MB + 49) / 50 * 50))
}

available_mb() {
  local line
  line="$(grep -m1 '^MemAvailable:' "$MEMINFO" 2>/dev/null)" || return 1
  [[ "$line" =~ ([0-9]+)\ kB ]] || return 1
  echo $((BASH_REMATCH[1] / 1024))
}

# The test runs already going, on one line: how many, how many of those are
# watchers (mantahostels#1906; watchers added mantahostels#1927), how many are
# whole, and the vitest workers they can occupy between them (workflow-core#2560).
#
# A RUN WEIGHS THE WORKERS ITS RUNNER LINE NAMES, as a launch does (workflow-core#2559):
# `w = min(test files named, SUITE_WORKERS)`, read off the words after the
# binary and its `run` by lib/suite-bounded.sh's `vitest_line_workers`. A line
# reads whole — `w = SUITE_WORKERS` — where it names no test file, is a
# watcher, or carries a bare word that is no flag's value. Only a whole run
# counts toward SUITE_MAX; a 1–2-file run adds to the memory rung alone. Residual: `ps` drops the quoting,
# so a `-t "a b"` value's second word reads as a filter and the run as whole.
#
# MATCHES THE RUNNER PATH, NOT THE WORDS. One suite puts THREE kinds of line in
# `ps -eo args`, and only the middle one is one-per-suite:
#
#   sh -c NODE_OPTIONS=... vitest run          the npm wrapper — same suite again
#   node .../node_modules/.bin/vitest run      the runner, one per suite
#   node .../vitest/dist/workers/forks.js      one per worker, so maxWorkers of them
#
# A bare `vitest run` therefore counts a `npm run test` twice, which is why the
# pattern is anchored on `.bin/`.
#
# A LAUNCH SPELLED WITH THE PATH ADDS ITS WRAPPERS (workflow-core#1127): the Bash tool's own
# `bash -c …` line and a `timeout 300 node_modules/.bin/vitest run` line both
# carry `.bin/vitest`, so one run read as three. A line whose argv[0] is a shell
# or one of `gp_unwrap`'s wrappers is skipped — WRAPPER_ARGV0. That costs no
# under-count: an exec'ing wrapper (`nohup`, `env`) leaves no line of its own,
# and a forking one (`timeout`, `sudo`) leaves the runner's. A shell or wrapper
# off the list (`fish`, `flock`, `taskset`) still adds a line.
#
# THE `run` IS NOT PART OF THE ANCHOR (mantahostels#1927): `test:watch` is `vitest` with no
# subcommand at all, so an open watcher's runner line ENDS at the binary and a
# `.bin/vitest run` pattern misses it entirely. The trailing `( |$)` is what
# keeps the relaxed anchor off a `.bin/vitest-<something>` that is not vitest.
#
# A WATCHER IS ANY `.bin/vitest` LINE CARRYING NEITHER `run` NOR `--run` — which
# is how `vitest watch` and `vitest --watch` are caught alongside the bare form.
# The subcommand is looked for ANYWHERE in the tail, not just first (mantahostels#1927):
# vitest's CLI is cac-parsed, so `vitest --silent --run` is a legal one-shot.
# An explicit `--watch` then WINS over it, or `vitest --watch -t run` would read
# as a one-shot and be told to wait for something that never ends.
# BOTH SPELLINGS OF THE ONE-SHOT ARE EXCLUDED deliberately: misfiling a
# one-shot as a watcher tells a session to close a neighbour's run that was
# going to finish on its own.
#
# `vitest bench`, `vitest related` and `vitest --watch=false` read as watchers,
# wrong only in the close-it advice. Any command line that merely NAMES the
# binary — `less .../.bin/vitest` — is COUNTED AS A SUITE as well, and filed as
# watcher or one-shot on whatever flags happen to follow it, so it can carry a
# launch over the cap on its own.
#
# Tightening the anchor to the runner alone (requiring a leading `(^|/)node `)
# would remove that class and buy an UNDER-count in exchange: a runner spelled
# some other way would go uncounted, which is the direction §6's asymmetry says
# costs an earlyoom kill rather than a false warning.
#
# A `vitest list` IS NO SUITE (workflow-core#1180): it is run-vitest.js's selection probe
# and runs no tests. Only `list` as the first word after the binary is
# skipped; one later in the tail may be a `-t list` filter on a real run.
#
# THE VITEST READING IS DUPLICATED BY HAND as `runningVitestSuites()` in
# `scripts/lib/admission.js`, for workflow-core#627's pre-suite reap. Move both, or neither
# (workflow-core#630). That copy leaves the
# non-vitest runners below uncounted.
#
# FAILS OPEN on an unreadable `ps` alone. A count of ZERO IS A SUCCESSFUL READ
# and must reach the caller as one.

# Hand-copied as VITEST_LIST in scripts/lib/admission.js. Move both (workflow-core#630).
VITEST_LIST='[.]bin/vitest list( |$)'

# Hand-copied as WRAPPER_ARGV0 in scripts/lib/admission.js. Move both (workflow-core#630).
WRAPPER_ARGV0='^ *-?([^ ]*/)?(bash|sh|dash|zsh|nohup|setsid|env|timeout|time|command|stdbuf|nice|ionice|xargs|sudo)( |$)'

VITEST_RUNNER='[.]bin/vitest( |$)'

running_suites() {
  local out line w total=0 watchers=0 whole=0 workers=0
  local -a words
  out="$("$PS_BIN" -eo args 2>/dev/null)" || return 1
  [[ -n "$out" ]] || return 1
  while IFS= read -r line; do
    [[ "$line" =~ $VITEST_RUNNER ]] || continue
    [[ "$line" =~ $WRAPPER_ARGV0 || "$line" =~ $VITEST_LIST ]] && continue
    ((++total))
    vitest_line_watches "$line" && ((++watchers))
    w="$(vitest_line_workers "$line")"
    ((workers += w))
    ((w < SUITE_WORKERS)) || ((++whole))
  done <<<"$out"
  # Every other runner is a whole one-shot, never a watcher.
  while IFS= read -r line; do
    read -ra words <<<"$line"
    ((${#words[@]})) && other_runner "${words[@]}" &&
      ((++total, ++whole, workers += SUITE_WORKERS))
  done <<<"$out"
  echo "$total $watchers $whole $workers"
}

# The `next <sub>` runners `ps` shows, <sub> being `build` or `dev`: the
# binary's path, anchored as running_suites anchors on `.bin/vitest`, so npm's
# `sh -c next build` and a line merely quoting the words are not counted. A
# build also counts by the `next-build (v…)` title it sets on itself
# (next/dist/cli/next-build.js); a dev server's parent keeps its path for its
# life, and the `next-server (v…)` title its child takes
# (next/dist/cli/next-dev.js) is `next start`'s too, so it is not read.
# FAILS OPEN on an unreadable `ps`, as running_suites does.
running_next() {
  local sub="$1" title="" out n
  [[ "$sub" == build ]] && title='^ *next-build \(v|'
  out="$("$PS_BIN" -eo args 2>/dev/null)" || return 1
  [[ -n "$out" ]] || return 1
  n="$(grep -E "${title}([.]bin|/dist/bin)/next ${sub}( |\$)" <<<"$out" |
    grep -cvE "$WRAPPER_ARGV0")" || n=0
  echo "$n"
}

BUILD_RULE_FALLBACK="Never run two builds or two dev servers at once; the rule could not be read from docs/agents/rules/build-concurrency.txt. Read that file before doing anything else."

# The wrapper strip lives in lib/guard-parse.sh as `gp_unwrap` (mantahostels#2511, mantahostels#2524,
# mantahostels#2552).
# `$_gp_unwrapped` is what is left to judge; `gp_carries_var` reads the escape
# an `env` carried.

# `npm-py` is deliberately absent — see SCOPE above.
is_test() {
  suite_launch_kind "$@" && [[ "$_sl_kind" != npm-py ]]
}

# Whether the launch asks for the WHOLE suite (mantahostels#3209). Read off every word,
# `npm run test -- --full` putting it after the `--` that npm eats.
# TWO RESIDUALS, both harmless and both `carries_queue`'s
# too: a flag VALUE spelled `--full` reads as the flag, matching how
# run-vitest.js reads its own argv; and a `--full` BEFORE the `--` is read here
# though npm drops it, so the guard withholds the narrow-the-run advice from a
# run that will in fact be narrow — over-advising in the safe direction.
carries_full() {
  local word
  for word in "$@"; do
    # `--full=<cause>` (workflow-core#182): a bare `--full` does not run at all, so every
    # real launch this guard sees carries a cause. Matched by prefix, not
    # by the six values themselves — a launch refused on a bad cause never
    # reaches vitest, so there is nothing here for that refusal to cost.
    [[ "$word" == --full || "$word" == --full=* ]] && return 0
  done
  return 1
}

# The id the foot's plain-`--full` limb latches under (workflow-core#181), in
# gp_rule_told's `warn.<id>` namespace and never a rule-text id: the limb
# composes its own wording, so there is no fragment to fetch.
FULL_LIMB_ID=full-suite-admissible

# THE RENDER SEAM, as WFC_MEMINFO and WFC_PS are for the ladder. `1` or `0`
# stands in for the read-graph render; unset, the render runs for real, and on a
# healthy tree it always succeeds, so the limb could never be shown silent.
RENDER_SEAM="${WFC_READ_GRAPH_RENDERS:-}"

# is_plain_full_launch <the launch's argv after its runner prefix> — whether the foot should
# fire the limb for this `--full` launch (workflow-core#181).
#
# BOTH HALVES ARE run-vitest.js's OWN, resolved through node rather than
# re-parsed here: `isFullRunArgv` for whether anything narrows the run past the
# whole suite, `render` for whether the read graph renders from this tree (workflow-core#998). A second
# parse in bash would drift from the one that actually decides what runs.
#
# `--project` IS THE ONE THING isFullRunArgv DOES NOT READ — its value is not
# test-file-shaped, so a project filter passes it — and the limb must be silent
# on one, so it is tested here alongside.
#
# IT COSTS A NODE START AND A READ-GRAPH RENDER, which is why the foot
# tests the latch BEFORE calling it: the price is paid once a session, on the
# first plain `--full`, and never again.
#
# A FAULT LEAVES THE LIMB UNSAID, and is RECORDED. No node, an unrequirable
# module, a render that throws: each exits 2 and is logged via gl_log, like
# every other drop point in this file. The session keeps the full run it asked
# for — the slow answer, not a wrong one — but a limb silent because it is
# broken must not read the same as a limb silent because it decided to be.
is_plain_full_launch() {
  local -a words=()
  # A `--` npm would have eaten is dropped.
  local word
  for word in "$@"; do
    [[ "$word" == -- ]] && continue
    words+=("$word")
  done
  # Exit 0 plain, 1 not plain, 2 faulted — the third is what separates a
  # decision from a breakage. A missing node exits 127 and lands in the same
  # arm.
  local why rc
  why="$(node -e '
const path = require("node:path");
const [runner, edges, root, seam, ...argv] = process.argv.slice(1);
try {
  // The strip is the one run-vitest.js runs (workflow-core#188), so a fifth wrapper flag
  // added there is stripped here unedited. NO APOSTROPHE IN THIS SNIPPET: it
  // is single-quoted bash.
  const { isFullRunArgv, stripWrapperFlags } = require(path.resolve(runner));
  const rest = stripWrapperFlags(argv);
  const project = rest.some((w) => w === "--project" || w.startsWith("--project="));
  if (project || !isFullRunArgv(rest)) process.exit(1);
  // An unreadable manifest or a render that throws lands in the catch below:
  // the bare run would escalate, and the fault is logged.
  if (seam === "") {
    const { render, OUT } = require(path.resolve(edges));
    JSON.parse(require("node:fs").readFileSync(path.join(root, OUT), "utf8"));
    render(root);
  }
  process.exit(seam === "" || seam === "1" ? 0 : 1);
} catch (e) {
  process.stderr.write(String(e && e.message ? e.message : e));
  process.exit(2);
}
' "$here/run-vitest.js" "$here/generate-test-read-edges.js" "$here/.." \
    "$RENDER_SEAM" ${words+"${words[@]}"} 2>&1 >/dev/null)"
  rc=$?
  ((rc == 0 || rc == 1)) ||
    gl_log "the plain-\`--full\` check did not run (exit $rc) — limb unsaid: ${why:-no message}"
  return "$rc"
}

# What the limb says, composed here rather than fetched from the rule store: it
# is this guard's own notice about the launch in hand, not a standing rule.
#
# Its fire needle (scripts/guard-fire-needles.json, `full-suite-admissible`,
# workflow-core#188) keys on `WOULD MEET THE PUSH GATE HERE` rather than the opening words:
# the backticks before them are escaped in this source, so a needle spanning
# them fails count-guard-fires.test.ts's corpus check. Reword that clause and
# move the needle with it.
full_limb_text() {
  printf '%s' "A BARE \`npm run test\` WOULD MEET THE PUSH GATE HERE, AND THIS \`--full\` BUYS NOTHING MORE (workflow-core#181). The read graph renders from this tree, so the diff's selection widened by its readers is ADMISSIBLE — and an admissible green IS the whole push gate: no whole-suite run is owed (mantahostels#2207). A full run costs ~373 s here (workflow-core#149). Want the whole suite for its own sake? Run it — this is advice, not a refusal."
}

# Whether the launch is asking to QUEUE rather than to run now (mantahostels#2024).
# `--queue` makes run-vitest.js wait for this same guard to stop denying before
# it spawns vitest, so the launch is not concurrent — it is the deny obeyed, not
# escaped, and it is allowed through the count cap for exactly that reason.
#
# WHY A FLAG AND NOT A SEPARATE WAITER SCRIPT. A waiter that runs the suite from
# inside itself never reaches this hook at all: the guard reads the command
# string it is handed, so `bash my-waiter.sh` is invisible and the gate is a
# one-line bypass for anyone who writes one. Routing the wait through a flag on
# the launch keeps every launch passing through here. scripts/queue-run.js, the
# non-vitest queue, is that waiter made visible: lib/suite-launch.sh reads the
# command behind it, and it runs no other kind (workflow-core#1776).
carries_queue() {
  local word
  for word in "$@"; do
    [[ "$word" == --queue ]] && return 0
  done
  return 1
}

# log_standdown <segment> <running> <nth> <limb> — record one deliberate
# override of a deny (mantahostels#2183), `limb` naming which: `count`, the
# count cap, or `memory`, the ladder (workflow-core#2305).
#
# THE STORE IS APPEND-ONLY JSONL under .claude/tmp/markers, alongside
# `.test-pass-markers.jsonl` — which is what the record joins against. Unlike
# that store it is never pruned: dropping the oldest would erase the measurement
# mantahostels#2162 is waiting on.
#
# THE JOIN IS BY TIME AND IT RUNS FORWARD, there being no shared key. The record
# is written at `PreToolUse`, so it always PRECEDES its own run's `startedAt`: it
# belongs to the NEXT marker that session writes, never to a `startedAt`..`at`
# window containing it. Two things follow. A run that went red left no line in
# the pass store at all — its marker is in `.test-fail-markers.jsonl` — and a
# stand-down whose run was killed joins nothing. Whole seconds is the resolution,
# gl_when's.
#
# `command` is the segment as the PARSER rendered it, not as typed: gp_unmask
# restores what was masked but leaves each quoted span as a literal `"…"`, so
# `-t "a name"` records `-t "…"`. Enough to tell one launch shape from another,
# not enough to replay one.
#
# `session` tells two sessions' overrides apart where several ran the same
# minute.
#
# ONE RECORD PER COMMAND, NOT PER SEGMENT. A compound command is judged segment
# by segment but the hook fires once, before any of it runs — so a second
# stand-down in the same command reads the same `ps` as the first and would
# record an `nth` for a machine state that never existed. The first is kept and
# the rest dropped, which undercounts a command standing down twice.
#
# FAILS OPEN, and SAYS SO: every branch that drops a record calls gl_log, an
# undercount here reading as compliance. The launch always proceeds.
log_standdown() {
  local segment="$1" running="$2" nth="$3" limb="$4" session line cmd
  ((standdown_logged)) && return 0
  standdown_logged=1
  session="$(gp_payload_field '.session_id')" || session=""
  # Trailing whitespace trimmed: the segment splitter leaves a space on every
  # segment but the last, so an untrimmed `npm run test ` would group apart from
  # the same launch typed on its own.
  cmd="$(gp_unmask "$segment")"
  cmd="${cmd%"${cmd##*[![:space:]]}"}"
  line="$(jq -cn \
    --arg at "$(gl_when)" \
    --arg session "$session" \
    --argjson running "$running" \
    --argjson nth "$nth" \
    --arg command "$cmd" \
    --arg limb "$limb" \
    '{at: $at, session: $session, running: $running, nth: $nth, limb: $limb, command: $command}' \
    2>/dev/null)" || line=""
  [[ -n "$line" ]] || {
    gl_log "jq could not build a stand-down record — one override of the suite deny went uncounted"
    return 0
  }
  # `2>/dev/null` FIRST, and that ordering is load-bearing: bash applies
  # redirections left to right and reports a failed one on the stderr standing at
  # that moment, so the trailing form leaks "Is a directory" to a hook's stderr
  # — which Claude Code reads as the hook itself being broken.
  printf '%s\n' "$line" 2>/dev/null >>"$(gr_markers_dir)/$STANDDOWN_LOG" ||
    gl_log "could not append to $STANDDOWN_LOG — one override of the suite deny went uncounted"
  return 0
}

# The raw command, trimmed as read_typed_launch trims a launch. Its comment cut
# is unmasked, so a quoted `#` misreads it as compound — the safe direction.
trimmed_command() {
  local raw
  raw="$(gp_payload_field '.tool_input.command')" || raw=""
  raw="${raw%%[[:space:]]#*}"
  raw="${raw#"${raw%%[![:space:]]*}"}"
  printf '%s' "${raw%"${raw##*[![:space:]]}"}"
}

# read_typed_launch <segment> — the launch as typed, into $typed_launch, which
# the deny's first line re-issues. A trailing `#` comment is dropped, or the
# flag appended after it is inert.
typed_launch=""
read_typed_launch() {
  typed_launch="$(gp_as_written "${1%%[[:space:]]#*}")"
  typed_launch="${typed_launch#"${typed_launch%%[![:space:]]*}"}"
  typed_launch="${typed_launch%"${typed_launch##*[![:space:]]}"}"
}

# queued_launch <segment> — the typed launch with scripts/queue-run.js put in
# front of it (workflow-core#1776), behind the segment's leading assignments, which a spawn
# cannot take as a command, and ahead of any wrapper, so a `timeout` bounds the
# run and not the wait. A shell keyword the segment opens with — the `do` of a
# loop — is dropped, the launch being only what follows it. So is a `--queue`.
queued_launch() {
  local rest="${1%%[[:space:]]#*}" lead="" ws word out
  while :; do
    ws="${rest%%[![:space:]]*}"
    word="${rest#"$ws"}"
    word="${word%%[[:space:]]*}"
    case "$word" in
      do | then | else | elif | if | while | until | '{' | '!') ;;
      *)
        [[ "$word" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || break
        lead+="$ws$word"
        ;;
    esac
    rest="${rest#"$ws$word"}"
  done
  rest="${rest#"${rest%%[![:space:]]*}"}"
  lead="$(gp_as_written "$lead")"
  lead="${lead#"${lead%%[![:space:]]*}"}"
  out="$(gp_as_written "$rest")"
  out="${out%"${out##*[![:space:]]}"}"
  out="${out/ --queue/}"
  printf '%snode %s -- %s' "${lead:+$lead }" "$(gp_script_path queue-run.js)" "${out% --}"
}

# 0 where <word> is npm's `run` command as npm 11.16.0's cmd-list derefs it:
# `run`, its aliases `rum`, `urn` and `run-script`, or an abbreviation of one.
# A camelCase spelling (`runScript`) is not read.
is_npm_run() {
  case "$1" in
    run | rum | urn | ur) return 0 ;;
    run-*) [[ run-script == "$1"* ]] ;;
    *) return 1 ;;
  esac
}

# 0 where the words launch `next <sub>`: `npm run <sub>`, its flags read by
# lib/npm-options.sh wherever they stand; `npx next <sub>`; or `next` by name
# or path.
launches_next() {
  local sub="$1" w
  local -a canon positional=()
  shift
  case "$1" in
    npx) [[ "${2-}" == next && "${3-}" == "$sub" ]] ;;
    next | */next) [[ "${2-}" == "$sub" ]] ;;
    npm)
      shift
      npm_canon "$@"
      set -- "${canon[@]}"
      while (($#)); do
        w="$1"
        shift
        if [[ "$w" == -- ]]; then
          positional+=("$@")
          break
        fi
        [[ "$w" == --* ]] || positional+=("$w")
      done
      is_npm_run "${positional[0]-}" && [[ "${positional[1]-}" == "$sub" ]]
      ;;
    *) return 1 ;;
  esac
}

# Deny <segment> where a `next <sub>` is already running, <what> naming it in
# the refusal. Neither is on the ladder or measured, so the count alone judges.
deny_second_next() {
  local sub="$1" what="$2" segment="$3" running
  if ! running="$(running_next "$sub")"; then
    gl_log "ps unreadable — a \`next $sub\` launched without counting running ones"
  elif ((running > 0)); then
    gp_deny "A \`next $sub\`${what} is already running, so this would be a second: @CMD@

$(gp_rule_text build-concurrency "$BUILD_RULE_FALLBACK")" "$segment"
  fi
}

# note_pytest_figure <the words after `npm run test:py`> — sets the memory
# figure for a run naming no path (workflow-core#2024). Any
# word not opening with `-` is read as a path, so a flag's value narrows it:
# the rule is then left for the next build or full run, never over-told.
note_pytest_figure() {
  local word mb
  [[ -z "$memory_kind" ]] || return 0
  for word in "$@"; do
    [[ "$word" == -- || "$word" == -* ]] || return 0
  done
  mb="$(available_mb)" || return 0
  memory_kind="full test"
  memory_mb="$mb"
}

# deny_to_queue <limb> <segment> <watch_lever> <why> <waiter> <escape_lead> <word>… — refuse a
# refusable launch, line one being the command that waits instead: the launch
# with `--queue`, or through scripts/queue-run.js (workflow-core#1776). A watcher is tested
# first, whatever its script body: no queue takes one (workflow-core#1927), so a `--queue`
# it carries is dropped and line one is <watch_lever>, then the launch. Reads
# judge's locals: typed_launch, launch_kind, other, plain, running, watching,
# wait_lever and watch_limb, and on the memory <limb> mb and floor.
#
# WFC_SUITE_GATE_LIMB, set by the queue's poll alone (lib/suite-queue.js's
# gateDenies), adds `suiteGate` naming <limb> to the envelope, so a waiter
# timing out on memory refuses where one on <limb> count runs (workflow-core#2421). A
# session's envelope carries no key Claude Code does not document.
deny_to_queue() {
  local limb="$1" segment="$2" watch_lever="$3" why="$4" waiter="$5" escape_lead="$6"
  shift 6
  local launch="$typed_launch" fix more="" word
  if [[ "$launch_kind" == npm-watch ]]; then
    launch="${launch/ --queue/}"
    launch="${launch% --}"
    fix="re-run"
    [[ "$typed_launch" == "$(trimmed_command)" ]] ||
      fix="re-run the command with this launch in place of its own"
    fix="${watch_lever}, then ${fix}: ${launch} — a watcher never finishes, so no queue takes it."
  else
    if ((other || plain)); then
      launch="$(queued_launch "$segment")"
      more=" \`queue-run.js\` waits for this gate to open, then runs that command."
    else
      fix=" --queue"
      if [[ "$1" == npm ]]; then
        fix=" -- --queue"
        for word in "$@"; do
          [[ "$word" == -- ]] && fix=" --queue" && break
        done
      fi
      launch+="$fix"
      more=" \`--queue\` waits for this gate to open, then runs that command."
    fi
    # A compound command's other parts — a `cd` first — still matter.
    if [[ "$typed_launch" == "$(trimmed_command)" ]]; then
      fix="Run instead: ${launch}"
    else
      fix="Run the command with this launch in place of its own: ${launch}"
    fi
    ((watching > 0 && watching == running)) &&
      more+=" ${wait_lever}, or the queue waits for good."
  fi
  local reason="${fix}
${why}${more} ${waiter} ${escape_lead} Prefix the command with WFC_SUITE_CONCURRENT=1, which is recorded.${watch_limb:+ ${watch_limb}}"
  [[ -n "${WFC_SUITE_GATE_LIMB-}" ]] || gp_deny "$reason"
  local envelope
  if ! envelope="$(gp_deny_context "$reason")" ||
    ! jq -c --arg limb "$limb" --argjson mb "${mb:-null}" --argjson rung "${floor:-null}" \
      '. + {suiteGate: ({limb: $limb} + (if $limb == "memory" then {mb: $mb, rungMb: $rung} else {} end))}' <<<"$envelope"; then
    gl_log "the queue poll's ${limb} deny did not render — the poll reads the gate as open"
  fi
  exit 0
}

judge() {
  local segment="$1"
  shift
  gp_unwrap "$@"
  set -- "${_gp_unwrapped[@]}"
  (($#)) || return 0
  # `reaps`: whether THIS command reaps for itself on the way in. npm runs a
  # pre-script for `test` and `test:changed` (workflow-core#633) and for no other script
  # name this guard judges, so a build or a watcher starts with the pool still
  # resident (mantahostels#1930).
  local kind="" narrowed=0 reaps=0 workers=$SUITE_WORKERS part=0 files queued=0 other=0 plain=0 script="" launch_kind=""
  if suite_launch_kind "$@" && [[ "$_sl_kind" == npm-py ]]; then
    note_pytest_figure "${@:_sl_taken+1}"
    return 0
  fi
  is_test "$@" && launch_kind="$_sl_kind"
  if [[ "$launch_kind" == other ]]; then
    # Not vitest (workflow-core#330): no `pretest` reap, no `--full`, and its queue is
    # scripts/queue-run.js rather than `--queue` (workflow-core#1776), as is a plain npm
    # script's below.
    other=1
    queued="$_sl_queued"
    kind="test"
    rule_subject=1
  elif [[ -n "$launch_kind" ]]; then
    kind="test"
    if files="$(launch_test_file_count "$@")"; then
      narrowed=1
      ((files < SUITE_WORKERS)) && workers=$files part=1
    fi
    # The §Gotchas rule this guard hands over is about reading a suite's
    # VERDICT, so a build earns none — it is set here rather than below the
    # branch (mantahostels#1805).
    rule_subject=1
    script="$_sl_script"
    [[ "$launch_kind" == npm-vitest ]] && reaps=1
    # `test:watch` is the exception to the flag: a watcher runs the whole suite
    # and takes no `--full`.
    [[ "$launch_kind" == npm-watch ]] || carries_full "$@" || narrowed=1
    [[ -n "$script" ]] && ! script_runs_runner "$script" && plain=1
    # The FIRST `--full` launch in the command, kept for the limb at the foot
    # (workflow-core#181). A compound command gets one notice like every other message
    # here, and the advice is the same for each of its segments.
    if [[ "$launch_kind" != npm-watch ]] && ((!${#full_launch_words[@]})) &&
      carries_full "$@"; then
      full_launch_words=("${@:_sl_taken+1}")
    fi
  elif launches_next build "$@"; then
    kind="build"
    deny_second_next build "" "$segment"
  elif launches_next dev "$@"; then
    deny_second_next dev " server" "$segment"
    return 0
  else
    return 0
  fi

  # Telling a narrowed launcher to narrow the run is a no-op — it already did,
  # so both warnings below leave it only the wait.
  local lever="or narrow the run"
  ((narrowed)) && lever="since this run is already narrowed as far as it goes"

  local mb
  mb="$(available_mb)" || {
    gl_open "MemAvailable unreadable — a $kind launch allowed unchecked"
    return 0
  }

  # A build or a whole-suite run owes a before-and-after reading (workflow-core#2024). A
  # non-vitest runner is left out: nothing here tells its whole suite from one
  # file. So is a watcher, which has no end to read after. The first such
  # launch in the command is the one the foot reports.
  if [[ -z "$memory_kind" ]] && ((!narrowed && !other)) &&
    [[ "$launch_kind" != npm-watch ]]; then
    memory_kind="full test"
    [[ "$kind" == build ]] && memory_kind="build"
    memory_mb="$mb"
  fi

  # A build is not on the ladder — §6 measured vitest — so it keeps the
  # one-suite floor and is never counted as a concurrent suite.
  local counts="" running="" watching=0 whole=0 busy=0 floor nth=1
  if [[ "$kind" == "test" ]]; then
    # gl_log, NOT gl_open: gl_open exits 0 on the spot, which would drop the
    # headroom check this branch is falling back TO.
    if ! counts="$(running_suites)"; then
      gl_log "ps unreadable — a suite launch judged as if no suite were running"
      counts=""
    fi
    [[ -n "$counts" ]] && read -r running watching whole busy <<<"$counts"
  fi
  floor="$(rung_mb $((busy + workers)))"

  # gp_warn EXITS, so the guard emits at most one message per command — a
  # watcher's cost cannot be a second warning and is carried as a limb on
  # whichever of the three below fires (mantahostels#1927).
  local watch_limb="" opener=""
  if [[ -n "$watcher_segment" ]]; then
    opener="This opens a WATCHER"
    [[ "$watcher_segment" == "$segment" ]] ||
      opener="Another segment of this command opens a WATCHER (\`$(gp_unmask "$watcher_segment")\`)"
    watch_limb="${opener}, which runs the whole suite now AND holds a full rung for as long as it stays open — it re-runs on any file save, and \`ps\` cannot tell an idle watcher from a running one, so it is counted the whole time. Close it (\`q\` in its terminal) when you stop iterating."
  fi

  # Every warning in this file ends with the command it is about, so the limb
  # goes BEFORE it rather than trailing off the end of a bare command string.
  local tail
  tail=": $(gp_unmask "$segment")"
  [[ -n "$watch_limb" ]] && tail=". ${watch_limb} The command: ${tail#: }"

  # An open watcher does not end on its own, so "wait for one to finish" is
  # advice a session cannot take when the neighbours are all watchers (mantahostels#1927).
  local wait_lever="Wait for one to finish"
  if ((watching > 0 && watching == running)); then
    wait_lever="Every one of them is an open watcher, and a watcher never finishes on its own — close one"
  elif ((watching > 0)); then
    wait_lever="Wait for a one-shot run to finish, or close one of the ${watching} open watchers, which never finish on their own"
  fi

  # REFUSABLE: a test launch not queued, the one both denies below may fall on.
  # A part-suite — fewer named files than SUITE_WORKERS — falls only on the
  # memory one, under its own rung (workflow-core#2558).
  local refusable=0
  if [[ "$kind" == test ]]; then
    read_typed_launch "$segment"
    ((other || plain)) || [[ "$launch_kind" == npm-watch ]] ||
      ! carries_queue "$@" || queued=1
    ((queued)) || refusable=1
  fi

  if [[ -n "$running" ]]; then
    nth=$((whole + 1))

    # THE COUNT CAP (workflow-core#155). Past SUITE_MAX the ladder has no rung: nothing has
    # ever been measured there, and what the ladder guards is an earlyoom
    # freeze rather than a slow suite.
    if ((nth > SUITE_MAX && refusable && !part)); then
      if ((command_escaped)); then
        log_standdown "$segment" "$whole" "$nth" count
      else
        local waiter="Do not write your own waiter: one grepping \`ps\` for \`vitest\` counts the npm wrapper and every worker as suites, so it can wait for a gap that never comes."
        ((other || plain)) && waiter="Do not write your own waiter."
        deny_to_queue count "$segment" "$wait_lever" "${whole} suites are already running, and a ${nth}th is past the last rung anything has ever been measured on — docs/environment.md §6's ladder stops at ${SUITE_MAX}." \
          "$waiter" "Genuinely need a ${nth}th?" "$@"
        return 0
      fi
    fi

    # REACHED ONLY BY WHAT THE DENY LET THROUGH — a part-suite, a `--queue`,
    # and a launch that stood the deny down with the escape, which logs its
    # record and falls through rather than returning (workflow-core#159). Everything else
    # past the cap was refused above. A refusable part-suite short of its own
    # rung goes on to the memory deny instead.
    if ((nth > SUITE_MAX)) && ! ((refusable && part && mb < floor)); then
      local joins="This would be suite ${nth}"
      ((part)) &&
        joins="This run's ${workers} vitest worker(s) would join ${whole} suites"
      gp_warn "${joins} on a machine measured to ${SUITE_MAX} (docs/environment.md §6) — ${whole} suite(s) are already going. Past the ladder's last rung nothing has been measured, and neighbour load is what actually sets a suite's wall-clock (mantahostels#1906). ${wait_lever}, ${lever}${tail}"
      return 0
    fi
  fi

  if ((mb < floor)); then
    local rung=""
    ((nth > 1)) && rung=" as suite ${nth} of ${SUITE_MAX}"
    ((busy > whole * SUITE_WORKERS)) &&
      rung=" for $((busy + workers)) vitest workers, ${busy} of them already running"
    ((part)) &&
      rung=" for the ${workers} vitest worker(s) its named files can occupy, beside ${busy} running"
    # THIS READING IS NOT THE THING TO STOP ON (mantahostels#1930). A finished-but-resident
    # session holds 330-450 MB it is about to give back, so the message names
    # the reap rather than leaving `free -m` and "wait" as the only levers. No
    # `--dry-run` prices it here: that runs `claude agents --json` on a
    # PreToolUse path, which mantahostels#1920 has timing out at session start.
    local reap_cmd reap_lever
    reap_cmd="node $(gp_script_path reap-finished-sessions.js)"
    reap_lever="Reap the finished-but-resident sessions first (\`${reap_cmd}\`) and re-read — a stopped session gives back 330-450 MB, though a shortfall held by LIVE neighbours is reaped by nothing"
    # pretest-reap.js judges the rung for the suite being started (workflow-core#627), so
    # the lever holds at every rung, and it runs before run-vitest.js's queue
    # wait. Residual: it counts vitest suites alone, so beside a non-vitest
    # runner this count includes it judges a rung low (pretest-reap.js's header).
    if ((reaps)); then
      reap_lever="This command reaps finished sessions before vitest starts (\`pretest-reap.js\`, mantahostels#1840), so this reading does not say what the run will get — launch it and read what the reap prints, remembering it reclaims nothing from a LIVE neighbour"
    fi
    if ((refusable)); then
      if ((command_escaped)); then
        log_standdown "$segment" "$whole" "$nth" memory
      else
        local reap_note="Reaping finished-but-resident sessions (\`${reap_cmd}\`) gives back 330-450 MB each, and may open the gate at once."
        ((reaps)) && reap_note="Its \`pretest\` reaps finished sessions before the wait (\`pretest-reap.js\`, mantahostels#1840)."
        deny_to_queue memory "$segment" "Reap finished sessions (\`${reap_cmd}\`) or wait for MemAvailable to reach ~${floor} MB" \
          "MemAvailable is ${mb} MB, under the ~${floor} MB docs/environment.md §6 says a test run needs resting${rung}, and earlyoom's SIGTERM line is 8% of the cap." \
          "${reap_note} Do not write your own waiter." "Genuinely need it now?" "$@"
        return 0
      fi
    fi
    gp_warn "MemAvailable is ${mb} MB, under the ~${floor} MB docs/environment.md §6 says a $kind run needs resting${rung} — earlyoom's SIGTERM line is 8% of the cap. ${reap_lever}. Only a machine still short after that is a §Machine limits refusal, ${lever}${tail}"
  fi

  # Reached only where the headroom and the count were both fine: the watcher
  # still took a rung. Emitted on the watcher's OWN segment alone — a clean
  # earlier segment carrying the limb here would warn about a rung ahead of the
  # headroom read that might yet warn about the watcher itself.
  if [[ "$watcher_segment" == "$segment" ]]; then
    gp_warn "${watch_limb} The command: $(gp_unmask "$segment")"
  fi
}

# Not local; see judge. Read by the pre-emptive injection at the foot of the
# file (mantahostels#1805).
rule_subject=0

# The first `--full` launch judge saw, as its unwrapped words (workflow-core#181). Empty
# where the command held none. Not local, for `rule_subject`'s reason.
full_launch_words=()

# The first build or whole-suite launch judge saw, as the run's name for the
# memory figure, and the MemAvailable it read for it (workflow-core#2024). Not local, for
# `rule_subject`'s reason.
memory_kind=""
memory_mb=""

# Whether this command has already recorded a stand-down (mantahostels#2183). Not local, and
# for the same reason as `watcher_segment` below: gp_walk_commands runs no
# subshell, so the flag set on one segment is seen by the next.
standdown_logged=0

# THE WATCHER IS FOUND BEFORE ANY SEGMENT IS JUDGED (mantahostels#1978). The first watcher
# wins: a command opening two holds one rung per watcher, but the limb's advice
# is the same for both.
#
# THE COST OF DECIDING THE LIMB COMMAND-WIDE RATHER THAN SEGMENT-BY-SEGMENT:
# `_gp_split_segments` flattens `||` like any other separator, so
# `npm run build || npm run test:watch` under the floor hangs the limb off the
# build's warning for a segment that runs only if the build FAILS. Accepted.
#
# THE ESCAPE IS DECIDED IN THE SAME PRE-PASS, and command-wide: a `PreToolUse`
# deny stops the whole command, so the escape's unit must be the command too
# (mantahostels#2486).
#
# THE PREFIX IS THE ROUTE THAT MATTERS. This hook runs BEFORE the command, so
# `WFC_SUITE_CONCURRENT=1 npm run test` never reaches the hook's own
# environment. That environment is read as a fallback, for the callers with no
# command to prefix: a script, a benchmark, CI.
#
# ITS RESIDUAL IS guard-suite-background.sh's: a command holding one escaped
# launch and one unescaped is exempted whole, failure direction `allow`.
#
# gp_walk_commands runs no subshell, so these assignments survive the loop.
watcher_segment=""
command_escaped=0
note_watcher() {
  local segment="$1" carried=0
  shift
  gp_carries_var WFC_SUITE_CONCURRENT "$@" && carried=1
  gp_unwrap "$@"
  set -- "${_gp_unwrapped[@]}"
  (($#)) || return 0
  is_test "$@" || return 0
  ((carried)) && command_escaped=1
  [[ "$_sl_kind" == npm-watch && -z "$watcher_segment" ]] && watcher_segment="$segment"
  return 0
}
gp_walk_commands note_watcher
[[ -n "${WFC_SUITE_CONCURRENT:-}" ]] && command_escaped=1

# THE HOST'S WHOLE-SUITE LAUNCH (workflow-core#2237): its declared `commands.test` typed
# with nothing after it but a lone `--`, which earns rule:targeted-runs at the
# foot. `npm test`, `npm t` and `npm run test` are one launch. Not local, for
# `rule_subject`'s reason.
#
# A COMMAND RUNNING run-vitest.js IS NO WHOLE SUITE, bare: that runner selects
# from the diff, as the core's own `npm run test` does. Its `--full` has the
# limb below.
#
# RESIDUALS. Any further word reads as narrowing, a flag such as `--silent`
# included, so that launch goes untold; so does a script running run-vitest.js
# with `--full` written into it. A declared command holding a quoted word never
# matches, the typed one arriving masked. A host declaring no `commands.test`
# is never told. A ladder warn on the launch outranks the rule, as it does
# suite-tree-dirty's. And a declared command naming none of the words the
# header's `if` narrowings name never reaches it: `bundle exec rspec`, say.
whole_suite_launch=0
declared_test=()
declared_key=""

# launch_key <word>... — the words as one string, an npm script launch spelt
# with `run` whatever its spelling and a trailing lone `--` dropped.
launch_key() {
  local -a words=("$@")
  [[ "${words[-1]}" == -- ]] && unset 'words[-1]'
  # npm's own aliases, which suite_launch_kind does not read.
  [[ "${words[0]##*/}" == npm && "${words[1]-}" == t ]] && words[1]="test"
  [[ "${words[0]##*/}" == npm && "${words[1]-}" == run-script ]] && words[1]=run
  if suite_launch_kind "${words[@]}" && [[ -n "$_sl_script" ]]; then
    words=("${words[0]##*/}" run "$_sl_script" "${words[@]:_sl_taken}")
  fi
  printf '%s' "${words[*]}"
}

if declare -F wfc_command >/dev/null && declared="$(wfc_command test)"; then
  read -ra declared_test <<<"$declared"
  declared_key="$(launch_key "${declared_test[@]}")"
fi

note_whole_suite() {
  shift
  ((!whole_suite_launch)) || return 0
  gp_unwrap "$@"
  set -- "${_gp_unwrapped[@]}"
  (($#)) || return 0
  [[ "$(launch_key "$@")" == "$declared_key" ]] || return 0
  if suite_launch_kind "$@"; then
    [[ "$_sl_kind" != wrapper ]] || return 0
    [[ -z "$_sl_script" ]] || ! script_runs_runner "$_sl_script" || return 0
  fi
  whole_suite_launch=1
}
((!${#declared_test[@]})) || gp_walk_commands note_whole_suite

gp_walk_commands judge

# PRE-EMPTIVE INJECTION (mantahostels#1805, spec mantahostels#1762). Reached only where nothing above
# warned, gp_warn exiting: a session told to wait is handed no rule about a
# run it has not started.
#
# ONE LAUNCH NEVER REACHES IT: `npm run test:watch` draws the watcher warning
# (mantahostels#1927), and gp_warn exits — and where MemAvailable is unreadable the
# fail-open exits earlier still. The rule is not spent — the same session's
# next one-shot run gets it — but a session that only ever opens watchers is
# never told.
#
# The memory figure (workflow-core#2024) shares that blind spot: a launch the headroom warn
# stops is handed no rule:memory-figure until an unwarned build or full run.
((rule_subject || whole_suite_launch)) || [[ -n "$memory_kind" ]] || gp_allow

# Claude Code reads one hook object per hook, so every notice of this guard's
# own travels as gp_rule's prelude, ahead of the rules.
prelude=""

# THE PLAIN-`--full` LIMB (workflow-core#181).
#
# THE LATCH IS TESTED FIRST AND IS ITS OWN, not suite-tree-dirty's: a session
# whose first launch was a `test:changed` has spent that rule's latch already,
# and the `--full` it types an hour later is exactly the launch this limb
# exists for. gp_rule marks it after the envelope renders (mantahostels#2528), which is why
# nothing here calls gp_rule_mark_told.
if ((${#full_launch_words[@]})) && ! gp_rule_told "$FULL_LIMB_ID" &&
  is_plain_full_launch "${full_launch_words[@]}"; then
  prelude="$(full_limb_text)"
  gp_rule_latch_after "$FULL_LIMB_ID"
fi

# THE FIGURE GOES OUT ONLY WITH THE RULE'S FIRST TELLING, which says the later
# readings are the session's own to take.
((rule_subject)) || gp_rule_skip suite-tree-dirty
if [[ -z "$memory_kind" ]]; then
  gp_rule_skip memory-figure
elif ! gp_rule_given memory-figure; then
  prelude+="${prelude:+$'\n\n'}BEFORE THIS ${memory_kind^^} RUN, MemAvailable reads ${memory_mb} MB."
fi
((whole_suite_launch)) || gp_rule_skip targeted-runs
gp_rule_module suites targeted-runs
[[ -z "$prelude" ]] || gp_rule_prelude "$prelude"

gp_rule targeted-runs suite-tree-dirty memory-figure

gp_allow
