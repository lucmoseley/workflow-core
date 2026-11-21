#!/usr/bin/env bash
# The session start's housekeeping launcher: RECORD deliberate self-throttling off a
# once-daily cached sweep (mantahostels#1404), and start the host repo's detached sweeps.
#
# SIXTEEN JOBS, ONE HOOK ENTRY. mantahostels#1362
# admitted the throttling detector as a piggyback on an existing hook — mantahostels#1130
# having rejected a fifteenth `SessionStart` entry on CPU grounds. A further
# hook entry, or a compound `A; B` command string, are both ruled out:
# `scripts/lib/guard-fires.js` keys the fire counter one key per registration, so
# a compound command leaves one of the scripts unkeyed.
#
# WHY DETACHED. Each job's reason is beside it below; together they would
# overrun the 10s this hook is registered with, and nothing in THIS session
# waits on any of them.
#
# WHY setsid: lib/detach.sh. Without it a harness group kill takes a detached
# job mid-call.
#
# WHY OUTSIDE THE SESSION (#4706). Born in the session's scope under its id, a
# job still running when a short session ends is killed by the scope's watcher
# or the ended-session sweep, its work lost until a later start retries it.
#
# IN NO SCRIPT FAMILY (§N3): one hook's launcher, and each job's own script
# owns its work.
#
# WHY SILENT. stdout here is what a SessionStart hook injects, so every
# detached job's output is discarded, the lander starter's excepted, which
# joins the lander's log. The gc job has no log of its own: an aborted
# repack — a stale `gc.log`, a `gc.pid` held by a concurrent session, an
# earlyoom kill — is swallowed with nothing anywhere reporting it.
set -uo pipefail

command -v node >/dev/null 2>&1 || exit 0

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
here="$(cd "$here" && pwd)"
# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"
# shellcheck source=scripts/lib/marker-root.sh
source "$here/lib/marker-root.sh"
# shellcheck source=scripts/lib/detach.sh
source "$here/lib/detach.sh"

# THE SESSION'S SCOPE, FIRST (#4341), and the one job left in it: it must run
# in the session's own cgroup to move the session into its scope. Never under
# VITEST.
[[ -n "${VITEST:-}" ]] || detach node "$here/session-scope.js"

# outlive_live [--log <file>] <command> [<args>…] — every other job: the
# outliving launch (lib/detach.sh), owned by this session, at the one ceiling
# (#4706). Never under VITEST: each job
# writes to the live tracker or deletes from the founder's real scratch
# directory, and has no test redirection here.
outlive_live() {
  [[ -z "${VITEST:-}" ]] || return 0
  outlive "${CLAUDE_CODE_SESSION_ID:-}" "$OUTLIVE_CEILING_S" "$@"
}

# SECOND JOB, SAME HOOK ENTRY (mantahostels#1175). refs/arbiter/<uuid> content pins — one per
# live lock/break/observation the arbiter sweeps — pin loose objects that
# `git gc`'s reachability walk cannot drop until the pin itself is gone.
# `git gc --auto` is a no-op below git's own thresholds, so this costs nothing
# on a quiet repo and only fires the day it is actually needed.
#
# SKIPPED UNDER VITEST. gr_root() answers the real host repo, never this
# script's own location (#1) and never a sandbox path, and git has no test
# redirection, so an unguarded call here would run a real gc against
# the founder's live repo every time this file's test suite runs. Vitest sets
# `VITEST` in every process it spawns.
#
# CLEAR gc.log FIRST. `git gc --auto` refuses outright — a complete no-op,
# nothing packed or pruned — while a `.git/gc.log` from a prior run survives
# (git's own `gc.logExpiry`, a day by default), and this job is what retries a
# failed gc (mantahostels#1175).
if command -v git >/dev/null 2>&1 && [[ -z "${VITEST:-}" ]]; then
  gc_root="$(gr_root)"
  rm -f "$gc_root/.git/gc.log"
  outlive_live git -C "$gc_root" gc --auto
fi

# THIRD JOB, SAME HOOK ENTRY (mantahostels#1632).
#
# WHY DETACHED. One paginated GitHub call plus one edit per stranded container,
# and nothing in THIS session waits on the result — the retag is for whichever
# session next runs /pick-next.
outlive_live node "$here/retire-stale-containers.js"

# FOURTH JOB, SAME HOOK ENTRY (mantahostels#2214). The reaper for `.claude/tmp/`, to the gate
# mantahostels#2090 designed.
#
# WHY DETACHED. The liveness oracle costs ~465 ms
# (`scripts/lib/agent-liveness.js:5-8`), and nothing in THIS session waits on a
# directory being tidied.
outlive_live node "$here/lib/scratch-sweep.js"

# FIFTH JOB, SAME HOOK ENTRY (#1104). The week-one reading of the close-rivals
# check (spec #1091), filed once, at its reading point, without anyone asking.
#
# WHY HERE AND NOT ON THE SCHEDULED SWEEP. The close-check logs and the
# transcripts it reads are machine-local, so CI has no file to read at all.
#
# WHY DETACHED. Until the reading is filed it reads every seat's transcripts,
# at most daily and never two at once (#3220): 4.2-5.6 s and ~350 MB RSS over
# 34 GB of them, at load ~27 on 28 Oct 2026; once filed it returns on one local
# file read, 0.06-0.08 s and ~60 MB (#3326).
outlive_live node "$here/report-close-check-reading.js"

# SIXTH JOB, SAME HOOK ENTRY (#1219). The daily queue-wait alarm (#1157).
#
# WHY HERE AND NOT ON THE SCHEDULED SWEEP, for report-close-check-reading's
# reason: the queue-exit log is machine-local.
#
# WHY DETACHED. Within the hour of its last reading it returns on one local
# file read; past it and over the limit, it makes up to four GitHub calls.
outlive_live node "$here/report-suite-queue-wait.js"

# SEVENTH JOB, SAME HOOK ENTRY (#1378). The architecture-scan counter's daily
# filing run (spec #1348). It runs in every repo, workflow-core included, and
# spends none of the sweep budget.
#
# WHY HERE AND NOT ON THE SCHEDULED SWEEP. #1320 Q2 (A) ruled it: every
# adopter has a session start, and not every adopter runs the sweep.
#
# WHY DETACHED. Within the day of its last reading it returns on one git call
# and one file read; past it, a `git log --numstat` over the window and up to
# four GitHub calls.
outlive_live node "$here/report-arch-scan-due.js"

# EIGHTH JOB, SAME HOOK ENTRY (#1555). The daily run of the repo's own state
# checks (spec #1510).
#
# WHY HERE AND NOT ON THE SCHEDULED SWEEP. #1407 Q2 (A) ruled it: the checks
# run on activity, and no adopter's CI runs them.
#
# WHY DETACHED. Within the day of its last reading it returns on one stamp
# read; past it, it runs every adopted check in turn, for up to 30 minutes.
outlive_live node "$here/repo-checks.js"

# NINTH JOB, SAME HOOK ENTRY (#1711). The reading of the under-researched-round
# check (spec #1701), filed once, at its reading point, for the fifth job's
# reasons. Its walk is the costly one: 51-55 s and ~370 MB RSS at load ~27 on
# 28 Oct 2026, under the same daily gate (#3220).
outlive_live node "$here/report-round-check-reading.js"

# TENTH JOB, SAME HOOK ENTRY (#2405). The queue lander's second start route
# (spec #4458), beside start-lander-on-push.js.
#
# WHY DETACHED. It reads the remote: one `git ls-remote` of the queue refs,
# and a `git fetch` where a ref's commit is not yet local. Nothing in THIS
# session waits on the lander. Its output joins the lander's
# log, so a start that failed is on record beside the runs.
outlive_live --log "$(gr_markers_dir)/.lander.log" node "$here/start-lander.js"

# ELEVENTH JOB, SAME HOOK ENTRY (#2406). The landing queue's stall and
# dead-lander warnings (#4458), in persist mode, so its report reaches the
# session through replay-notify-reports.js. New SessionStart entries are ruled
# out (mantahostels#1130).
#
# WHY DETACHED. It reads the remote as the tenth job does, and waits out a
# lander that job may be starting before it names none running.
outlive_live env WFC_NOTIFY_PERSIST=1 node "$here/check-landing-stall.js" --notify

# TWELFTH JOB, SAME HOOK ENTRY (#2331). The reading of the low-top test's
# flip line (spec #2260), filed once, at its reading point, for the fifth
# job's reasons.
outlive_live node "$here/report-flip-line-reading.js"

# THIRTEENTH JOB, SAME HOOK ENTRY (#3464). The monthly heresy sweep's daily
# filing run (spec #3365), in every repo with no module switch, for the seventh
# job's reason: every adopter has a session start.
#
# WHY DETACHED. Within the day of its last reading it returns on one stamp
# read; past it, up to four GitHub calls.
outlive_live node "$here/report-heresy-sweep-due.js"

# FOURTEENTH JOB, SAME HOOK ENTRY (#4342). The timer that runs the orphan
# reaper with no session open; the hook's own run covers each start.
#
# WHY DETACHED. Up to four systemctl calls, and nothing in THIS session waits
# on a timer whose first firing is minutes away.
outlive_live node "$here/start-orphan-sweep-timer.js"

# FIFTEENTH JOB, SAME HOOK ENTRY (#5385). The Chrome child closer's sweep,
# the backstop behind the launcher's own trap and the founder's "done": not
# the orphan timer nor the next Chrome launch (#5368, #5385).
#
# WHY DETACHED. Each record it takes waits up to 5 s for its child and runs
# one resumed `claude -p` turn of up to 70 s.
outlive_live node "$here/claude-child.js" chrome-close --sweep

# FIRST JOB, SAME HOOK ENTRY (mantahostels#1362), run in the foreground after
# the detached ones. The throttling sweep, on the state file only — a file read and, once a day, a
# detached sweep of its own, whose reading is appended to the history. It prints
# nothing while the notice is off; turn it back on the day a seat is cut, and
# stdout here is what a SessionStart hook injects. It is handed the launcher's
# probe answer, so its daily kick does not probe again (#4706): the variable is
# lib/user-scope.js's USER_MANAGER_ENV.
WFC_USER_MANAGER="${OUTLIVE_MANAGER-}" node "$here/check-self-throttling.js" --notify || true

# Always green: a session start must never go red on a sweep nobody is waiting
# for, nor on a report.
exit 0
