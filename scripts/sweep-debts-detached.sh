#!/usr/bin/env bash
# The session start's detached launcher: drain the debt register (mantahostels#1251), and
# RECORD deliberate self-throttling off a once-daily cached sweep (mantahostels#1404).
#
# THIRTEEN JOBS, ONE HOOK ENTRY, and the filename names only the first. mantahostels#1362
# admitted the throttling detector as a piggyback on an existing hook — mantahostels#1130
# having rejected a fifteenth `SessionStart` entry on CPU grounds. A further
# hook entry, or a compound `A; B` command string, are both ruled out:
# `scripts/lib/guard-fires.js` keys the fire counter one key per registration, so
# a compound command leaves one of the scripts unkeyed.
#
# WHY DETACHED. `debt sweep` asks GitHub for every closed issue in one call:
# 12.3-12.6s measured (mantahostels#1111), against the 10s this hook is registered with.
# Nothing waits on it — THIS session's sweep drains the register for the NEXT.
#
# WHY setsid: lib/detach.sh. Without it a harness group kill takes the sweep
# mid-call and the register never drains.
#
# IN NO SCRIPT FAMILY (§N3): one hook's launcher, and `debt sweep` owns the work.
#
# WHY SILENT. Every debt-sweep fault logs to the arbiter's error log, which
# `npm run check:guard-errors` reports under `npm run status`. The one thing
# discarding stdout would otherwise lose is an uncompletable stub the sweep
# DELETED (mantahostels#1302) — irreversible, and the printed line is the only place its path
# and denial date appear — so the store writes each drop to `dropped-debts.log`
# beside the error log, independently of what this launcher does with stdout.
# The gc job (below) has no such log: an aborted repack — a stale `gc.log`, a
# `gc.pid` held by a concurrent session, an earlyoom kill — is swallowed with
# nothing anywhere reporting it.
#
# IMPLICIT:  at every session start, launches `debt sweep` detached, which asks GitHub for closed issues, deletes the debt entries they own, and deletes any entry that is unowned, has no gist and is over 24h old; kicks a once-daily transcript sweep whose reading is appended to `~/.claude/.self-throttling-history.jsonl`, injecting nothing into the session while `NOTICE_ON_SESSION_START` is off (mantahostels#1404); and — unless `VITEST` is set — clears a stale `.git/gc.log` and launches `git gc --auto` detached, repacking and, past git's default 2-week grace, pruning objects nothing references, launches `retire-stale-containers.js` detached, which asks GitHub for the open issues — and for the sub-issues of each open `takes:to-tickets` one — and moves any `takes:children` with no open child left to `takes:triage`, and any `takes:to-tickets` that already has tickets to `takes:children` or `takes:triage`; and launches `lib/scratch-sweep.js` detached, which deletes from `.claude/tmp/` every file over 24 hours old — 7 days for one named with `research` or under `agents/` — that no live session predates, and nothing at all if it cannot read which sessions are live; and launches `report-close-check-reading.js` detached, which reads the close-check log of every workflow-core adopter on this laptop and every seat's transcripts and — only once the week-one reading point is reached — files one `takes:wayfinder` issue on GitHub, and never again once it exists, open or closed; and launches `report-round-check-reading.js` detached, which does the same for the round-check log of every repo its baseline has rows for; and launches `report-flip-line-reading.js` detached, which does the same for the low-top test's flip line, reading the close-check logs; and launches `report-suite-queue-wait.js` detached, which — where the `suites` module is on — at most hourly sums the last 24 h of suite queue wait from the local queue-exit log and — only at 2 h or more — files or refreshes one `takes:wayfinder` issue in the host repo's own tracker, filing again after a close only for a window that starts after it; and launches `report-arch-scan-due.js` detached, which at most daily counts the net growth of the host repo's ten busiest code files since its last architecture scan and — at or over the threshold, and while no scan is in flight — files or refreshes one `takes:implement` *Architecture scan due* issue in the host repo's own tracker; and launches `repo-checks.js` detached, which at most daily runs the host repo's own state checks as the main checkout, even from a linked worktree — reporters among them filing or refreshing their own issue — writes its result to the git common directory and a notify report naming any check that gained a finding, broke or went missing, and files or refreshes one `takes:triage` *Repo checks: standing findings* issue in the host repo's own tracker; and launches `start-lander.js` detached, which — where the `landing` module is on, no lander runs and the remote's `landing` is ahead of `main` — starts the lander, which tests `landing`'s tip and pushes it to `main` on green; and launches `check-landing-stall.js --notify` detached, which — where the `landing` module is on — reads the same two branches and the lander's heartbeat and writes its notify report, warning where `landing` holds commits `main` lacks and `main` has not moved for 2 h, or is ahead with no lander running — named as held where the lander's last run held that tip.
# JUSTIFIED: fail-safe — nothing else drains the register, so a dead entry warns every later session off a path that is free (mantahostels#1251). Deliberate self-throttling leaves no limit record anywhere, so nothing else on this machine can see it — the readings are collected against the day a seat is cut, the transcripts behind them ageing off at ~30 days (mantahostels#1404). The container sweep is fail-safe both ways: `takes:children` routes to no command, so a container whose last child has closed is offered to nobody and sits on the frontier indefinitely (mantahostels#1632), and a `takes:to-tickets` left on an already-ticketed spec routes to a command that duplicates those tickets (mantahostels#1663) — every value it moves to is fixed by `docs/agents/triage-labels.md`, not chosen by the script. And the gc job is what keeps `.git` from growing without bound (mantahostels#1175): `git gc` (no `--aggressive`, no `--prune=now`) only deletes objects both unreachable AND past the 2-week `gc.pruneExpire` default, which is worktree-aware (a live worktree's HEAD counts as reachable) and is the arbiter's own stated assumption for when a superseded `priorBlobs` entry stops being recoverable (arbiter-store.js's `claimVersions`). And the close-check reading would otherwise reach the founder only when someone thought to ask for it, which spec workflow-core#1091 rules out (workflow-core#1104), and so would the round-check reading (workflow-core#1711), and the flip-line reading (workflow-core#2331). And the suite's queue wait decays as the suite grows, unseen until a backlog is bad enough for the founder to open another cut-map (workflow-core#1147, workflow-core#1157). And the architecture scan has no other trigger in any repo (workflow-core#1348, workflow-core#1320 Q2 (A)). And a repo's own tracker, roadmap, manual and doc-map checks run nowhere else in an adopter, so drift there goes unseen (workflow-core#1510, workflow-core#1407 Q2 (A)). And a push to `landing` the push hook never saw, or a lander that died mid-batch, would otherwise hold every landing back until the next push (workflow-core#2405). And the lander runs outside any session, so nothing else reports it stalling or dying (workflow-core#2406).
# DEFEAT:    the launcher takes no flags; nothing waits on any of its twelve detached children — the debt, gc, container, scratch, close-check-reading, round-check-reading, flip-line-reading, queue-wait, architecture-scan, repo-checks, lander-start and landing-stall jobs; the throttling half is silent unconditionally while the notice is off; and the gc, container, scratch, close-check-reading, round-check-reading, flip-line-reading, queue-wait, architecture-scan, repo-checks, lander-start and landing-stall halves are silent unconditionally under `VITEST`.
set -uo pipefail

command -v node >/dev/null 2>&1 || exit 0

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
arbiter="$here/session-arbiter.js"
# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"
# shellcheck source=scripts/lib/marker-root.sh
source "$here/lib/marker-root.sh"
# shellcheck source=scripts/lib/detach.sh
source "$here/lib/detach.sh"

# detach, but never under VITEST, which Vitest sets in every process it spawns.
# Each job launched this way writes to the live tracker or deletes from the
# founder's real scratch directory, and has no test redirection here.
detach_live() {
  [ -n "${VITEST:-}" ] || detach "$@"
}

detach node "$arbiter" debt sweep

# THIRD JOB, SAME HOOK ENTRY (mantahostels#1175). refs/arbiter/<uuid> content pins — one per
# live lock/break/observation the arbiter above sweeps — pin loose objects that
# `git gc`'s reachability walk cannot drop until the pin itself is gone.
# `git gc --auto` is a no-op below git's own thresholds, so this costs nothing
# on a quiet repo and only fires the day it is actually needed.
#
# SKIPPED UNDER VITEST. gr_root() answers the real host repo, never this
# script's own location (workflow-core#1) and never a sandbox path — the arbiter jobs above
# are redirected into a sandbox by env vars the test harness sets, but git has
# no such redirection, so an unguarded call here would run a real gc against
# the founder's live repo every time this file's test suite runs. Vitest sets
# `VITEST` in every process it spawns.
#
# CLEAR gc.log FIRST. `git gc --auto` refuses outright — a complete no-op,
# nothing packed or pruned — while a `.git/gc.log` from a prior run survives
# (git's own `gc.logExpiry`, a day by default), and this job is what retries a
# failed gc (mantahostels#1175).
if command -v git >/dev/null 2>&1 && [ -z "${VITEST:-}" ]; then
  gc_root="$(gr_root)"
  rm -f "$gc_root/.git/gc.log"
  detach git -C "$gc_root" gc --auto
fi

# FOURTH JOB, SAME HOOK ENTRY (mantahostels#1632).
#
# WHY DETACHED. One paginated GitHub call plus one edit per stranded container,
# and nothing in THIS session waits on the result — the retag is for whichever
# session next runs /pick-next.
detach_live node "$here/retire-stale-containers.js"

# FIFTH JOB, SAME HOOK ENTRY (mantahostels#2214). The reaper for `.claude/tmp/`, to the gate
# mantahostels#2090 designed.
#
# WHY DETACHED. The liveness oracle costs ~465 ms
# (`scripts/lib/agent-liveness.js:5-8`), and nothing in THIS session waits on a
# directory being tidied.
detach_live node "$here/lib/scratch-sweep.js"

# SIXTH JOB, SAME HOOK ENTRY (workflow-core#1104). The week-one reading of the close-rivals
# check (spec workflow-core#1091), filed once, at its reading point, without anyone asking.
#
# WHY HERE AND NOT ON THE SCHEDULED SWEEP. The close-check logs and the
# transcripts it reads are machine-local, so CI has no file to read at all.
#
# WHY DETACHED. Until the reading is filed it reads every seat's transcripts,
# about 2 s; once filed it returns on one local file read.
detach_live node "$here/report-close-check-reading.js"

# SEVENTH JOB, SAME HOOK ENTRY (workflow-core#1219). The daily queue-wait alarm (workflow-core#1157).
#
# WHY HERE AND NOT ON THE SCHEDULED SWEEP, for report-close-check-reading's
# reason: the queue-exit log is machine-local.
#
# WHY DETACHED. Within the hour of its last reading it returns on one local
# file read; past it and over the limit, it makes up to four GitHub calls.
detach_live node "$here/report-suite-queue-wait.js"

# EIGHTH JOB, SAME HOOK ENTRY (workflow-core#1378). The architecture-scan counter's daily
# filing run (spec workflow-core#1348). It runs in every repo, workflow-core included, and
# spends none of the sweep budget.
#
# WHY HERE AND NOT ON THE SCHEDULED SWEEP. workflow-core#1320 Q2 (A) ruled it: every
# adopter has a session start, and not every adopter runs the sweep.
#
# WHY DETACHED. Within the day of its last reading it returns on one git call
# and one file read; past it, a `git log --numstat` over the window and up to
# four GitHub calls.
detach_live node "$here/report-arch-scan-due.js"

# NINTH JOB, SAME HOOK ENTRY (workflow-core#1555). The daily run of the repo's own state
# checks (spec workflow-core#1510).
#
# WHY HERE AND NOT ON THE SCHEDULED SWEEP. workflow-core#1407 Q2 (A) ruled it: the checks
# run on activity, and no adopter's CI runs them.
#
# WHY DETACHED. Within the day of its last reading it returns on one stamp
# read; past it, it runs every adopted check in turn, for up to 30 minutes.
detach_live node "$here/repo-checks.js"

# TENTH JOB, SAME HOOK ENTRY (workflow-core#1711). The reading of the under-researched-round
# check (spec workflow-core#1701), filed once, at its reading point, for the sixth job's
# reasons.
detach_live node "$here/report-round-check-reading.js"

# ELEVENTH JOB, SAME HOOK ENTRY (workflow-core#2405). The lander's second start route (spec
# workflow-core#2261), beside start-lander-on-push.js.
#
# WHY DETACHED. It reads the remote: one `git ls-remote`, and a `git fetch`
# where either branch's commit is not yet local. Nothing in THIS session waits
# on the lander. Its output joins the lander's log, so a start that failed is
# on record beside the runs.
detach_live --log "$(gr_markers_dir)/.lander.log" node "$here/start-lander.js"

# TWELFTH JOB, SAME HOOK ENTRY (workflow-core#2406). The landing queue's stall, dead-lander
# and held warnings (spec workflow-core#2261), in persist mode, so its report reaches the
# session through replay-notify-reports.js. New SessionStart entries are ruled
# out (mantahostels#1130).
#
# WHY DETACHED. It reads the remote as the eleventh job does, and waits out a
# lander that job may be starting before it names none running.
detach_live env WFC_NOTIFY_PERSIST=1 node "$here/check-landing-stall.js" --notify

# THIRTEENTH JOB, SAME HOOK ENTRY (workflow-core#2331). The reading of the low-top test's
# flip line (spec workflow-core#2260), filed once, at its reading point, for the sixth
# job's reasons.
detach_live node "$here/report-flip-line-reading.js"

# The throttling sweep, on the state file only — a file read and, once a day, a
# detached sweep of its own, whose reading is appended to the history. It prints
# nothing while the notice is off; turn it back on the day a seat is cut, and
# stdout here is what a SessionStart hook injects.
node "$here/check-self-throttling.js" --notify || true

# Always green: a session start must never go red on a drain nobody is waiting
# for, nor on a report.
exit 0
