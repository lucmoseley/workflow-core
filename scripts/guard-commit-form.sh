#!/usr/bin/env bash
# PreToolUse guard: the commit forms that sweep the shared index (mantahostels#117).
#
# Why: the index is repo-global, so between one session's `git add` and its
# commit, a parallel session's commit takes the staged files in under its own
# message — mantahostels#63, where a roadmap correction landed inside an unrelated commit
# (an incident in its closing comment — its title names other work).
#
# NINE VERDICTS, split by command form (mantahostels#109). mantahostels#103's rule is deny on a
# structured fact where the action has no legitimate use, warn where the hook is
# inferring:
#
#   git add (not -N)        warn   Two legitimate uses on record: staging
#                                  through a merge conflict, and `git add -N`
#                                  for a new file, which a pathspec commit
#                                  rejects. A deny would wedge ordinary work.
#   commit -a/-am/-i/--include
#                           deny   Zero legitimate uses. `-a` sweeps a parallel
#                                  session's files that are merely dirty and
#                                  unstaged — the normal state of a live session.
#   bare commit, no pathspec
#                           warn   Harm depends on whether another session has
#                                  staged something at that instant: a fact
#                                  about the world, not about the command.
#   commit --no-verify/-n   deny   Zero legitimate uses (mantahostels#975). Since
#   merge/rebase/cherry-pick/      mantahostels#1705-1707 the flag buys nothing
#   revert/am --no-verify          on a plain commit or merge, where
#                                  `.husky/prepare-commit-msg` runs the stack
#                                  anyway; mid-replay it cuts the stack to the
#                                  secrets scan, and on a `git am` it skips
#                                  `.husky/pre-applypatch`, that route's only
#                                  gate. First
#                                  of the nine that is not an anti-contention
#                                  rule, so first of the nine to bind in a
#                                  worktree too (mantahostels#1213).
#   commit --amend          deny   Zero legitimate uses in the shared tree
#                                  (mantahostels#2540). The amend rewrites whatever `main`
#                                  points at NOW, and with four sessions
#                                  committing every few minutes a neighbour's
#                                  commit routinely lands between this session's
#                                  own commit and its amend — so the amend takes
#                                  the NEIGHBOUR's commit under this session's
#                                  message, reports success and prints the
#                                  neighbour's diffstat. Shared-tree-only and
#                                  stood down mid-sequence; LIMITS below has why.
#   commit -m "…Fixes #n"   deny   Zero legitimate uses (#129). GitHub closes
#                                  the issue server-side the moment the commit
#                                  is pushed, so guard-issue-close.sh — a hook
#                                  on `gh issue close` — never fires, and the
#                                  close carries no resolution comment and no
#                                  `**Outstanding:**` line. Where the issue
#                                  stood for more than one fault, every fault
#                                  but the one being fixed goes untracked with
#                                  nothing recording that it happened (#118).
#                                  Unrecoverable once pushed and barely
#                                  recoverable before — the `--amend` that
#                                  would rewrite the message is itself denied
#                                  above. It binds in every tree and stands
#                                  down for nothing: a mid-rebase commit closes
#                                  the issue just the same.
#   commit -- <pathspec>    warn   A pathspec takes the working-tree copy of
#                                  every path it names (mantahostels#1539). Harm depends on
#                                  whether a live neighbour holds a claim on one
#                                  of them with unsaved edits — a fact about the
#                                  world, not about the command. Like the three
#                                  index verdicts it is shared-tree-only and
#                                  stood down mid-sequence — where it could not
#                                  have fired anyway, git itself refusing a
#                                  partial commit during a merge.
#   commit -- <untracked>   warn   A pathspec cannot reach a path git does not
#                                  track (mantahostels#1612), so the very form the headline
#                                  rule prescribes is unsatisfiable for a new
#                                  file: git prints `error: pathspec … did not
#                                  match any file(s) known to git`, exits 1 and
#                                  commits nothing. Warn, not deny — nothing
#                                  destructive happens; the harm is a session
#                                  reading that exit as "nothing to do" and
#                                  leaving its ticket looking finished with the
#                                  file uncommitted. Second of the nine that is
#                                  not an anti-contention rule, so second of the
#                                  nine to bind in a worktree too — git rejects
#                                  an unmatchable pathspec byte-identically
#                                  there. Stood down mid-sequence, where git
#                                  refuses a partial commit on other grounds.
#                                  It OUTRANKS the pathspec-sweep warn, on the
#                                  ground that git rejects the whole commit so
#                                  the sweep never happens — and it is silent
#                                  (mantahostels#3280) on a word an EARLIER SEGMENT of the
#                                  same command intent-adds (`git add -N x &&
#                                  git commit … -- x …`, the very escape it
#                                  prints), which is the one shape where that
#                                  ground is false: there the commit succeeds
#                                  and the sweep does reach the tree.
#   commit -- <directory>   warn   The residual mantahostels#1612 leaves (mantahostels#1651). A word
#                                  naming a directory holding one tracked and
#                                  one untracked file is ACCEPTED: git commits
#                                  the tracked file, exits 0 and leaves the new
#                                  one behind, with no error to read. Same harm
#                                  as the verdict above, arriving with no signal
#                                  at all. Ignored files are excluded, and it
#                                  binds in a worktree too, for the same reason:
#                                  it guards no index. It is the LOWEST-RANKED
#                                  of the warns (mantahostels#3280): it is decided early but
#                                  its text is DEFERRED to the emission foot, so
#                                  every verdict decided later — the sweep warn,
#                                  the `git add` index warn, the bare-commit
#                                  warn — takes the slot ahead of it. All three
#                                  describe a commit that takes a neighbour's
#                                  work; this one leaves scratch behind.
#
# EVERY VERDICT BUT `--no-verify` is suppressed while a merge, rebase,
# cherry-pick, revert or am is in progress. That is the one place staging is unavoidable, and finishing a merge
# is a bare `git commit` — git commits the already-staged resolution.
#
# `--no-verify` IS NOT. It is judged first and denied mid-sequence too: a merge
# makes staging unavoidable, never hook-skipping (mantahostels#975).
#
# ATTRIBUTION (mantahostels#118). The bare-commit warn names the FOREIGN staged path — one
# this session never wrote — and is silent when the index holds nothing but the
# session's own work.
#
# "This session wrote it" comes from the write ledger (mantahostels#114),
# `session-arbiter.js commit-check <session> [<path>...]`, whose W lines are the
# ledger and whose S lines are the pathspec warn's findings, in one spawn (mantahostels#1561)
# — not the lock registry, for the reasons
# on writesDir() in session-arbiter.js. The ledger is fed by record-write.sh on
# every Edit/Write and by the arbiter's `claim` for a doc written from a script.
# That second path is what keeps docs/roadmap-digest.md quiet: it is generated by
# gen-roadmap-digest.js, never edited, so without it the warn would fire on every
# roadmap edit.
#
# It FALLS BACK to mantahostels#117's index-wide warn whenever attribution is unavailable:
# no session id, no node, a ledger read that errors (mantahostels#103 §6, fail open).
#
# mantahostels#107's proving run arms its mantahostels#63 after-half on this file's mere existence, so
# deleting or renaming it turns a skipped test into a failing one.
#
# A TENTH OUTPUT, WHICH IS NOT A VERDICT (mantahostels#1647, spec mantahostels#1762). On the clean
# branch — nothing denied, nothing warned — a `git add`/`stage`/`commit` is
# handed docs/agents/rules/commit-pathspec.txt, commit-show-diff.txt and
# commit-message.txt (#2022) and push-cadence.txt (#2285) through gp_rule at
# the foot of this file, before the mistake rather than on it; a
# `node …/commit-paths.js` call is handed the last three, and the §Gotchas gate
# rules its paths earn (#2147). Each id is
# latched per session, so the second commit costs nothing, and the guard emits
# additionalContext and never a permissionDecision: an allow stays an allow. A
# warn suppresses it and leaves it unlatched, so the specific hazard is not
# buried under the general rule and the rule arrives on the next clean commit.
# The merge family is handed nothing: none of them stages a pathspec.
#
# LIMITS
#  - Scope is THIS repository. The three index verdicts, the pathspec warn and
#    the `--amend` deny are narrower still — the shared working tree alone, a
#    linked worktree keeping its own index — but `--no-verify` binds in every
#    tree of this repo (mantahostels#1213), because the gates it stands down are the ones a
#    worktree runs too (mantahostels#344), and so does the closing-keyword deny (#129):
#    GitHub reads the pushed message, not the tree it was written in. Any
#    other repository is exempt from all nine.
#  - It matches the *parsed command form*, never a substring, so a grep, an echo
#    or a heredoc mentioning `git add` passes. The parser is shared with
#    guard-branch.sh, in lib/guard-parse.sh (mantahostels#123).
#  - It FAILS OPEN, house style (mantahostels#103 §6): a `cd`/`git -C` target it
#    cannot resolve — a `$(…)`, a name assigned from one or after the command's
#    first `||` (#328), `${W:-x}`, an unset or empty-assigned name in a command
#    carrying `||`, `source`, `.` or `eval` — a git invocation it cannot parse,
#    a missing jq, or the shared parser itself being unreadable — all allowed
#    through, and all RECORDED (mantahostels#147) via lib/guard-log.sh for
#    check-guard-errors.js to report. No verdict refuses on an unknown tree
#    (#312). The attribution fallback above is not one of these: it still
#    warns, index-wide.
#  - An UNSET variable in that target is read as empty (#312, #310's narrow
#    form): shell state does not carry between Bash calls, so `git -C "$W"`
#    with `W` from an earlier call runs in the cwd, and all nine verdicts judge
#    it there. The four refusals name the variable. The reach and the
#    hook-environment residual are guard-branch.sh's LIMITS, the same opt-in.
#    A `$(…)` target stays open; a real `--no-verify` or closing-keyword
#    commit through one is what re-opens #312.
#  - THE CLOSING-KEYWORD RULE MATCHES ALL THREE REFERENCE SPELLINGS GITHUB
#    HONOURS (mantahostels#2652): the bare `#12`, the cross-repo `owner/repo#12`, and the
#    full `https://github.com/owner/repo/issues/12`.
#    What it still does not read: a reference with an owner but no repo
#    (`closes hostels#12`), which GitHub does not honour either; a pull-request
#    URL, likewise; and a number arriving as a shell expansion, the message
#    being matched as text.
#    IT OVERMATCHES ON THE GLUED SPELLING: `fixes#12` fires although GitHub
#    does not honour that form (measured at mantahostels#2660). The separator
#    stays wide anyway (mantahostels#2668, #129), though the overmatch REFUSES a
#    commit GitHub would not have closed: the session retypes one word, against
#    a rule whose whole point is catching the spelling a session actually types.
#  - THE CLOSING-KEYWORD RULE READS `-m`/`--message` VALUES ONLY (mantahostels#2592). A
#    message written into a file and passed with `-F`, one taken off another
#    commit with `-c`/`-C`, a `--trailer`, and the whole editor route — `git
#    commit` with no message flag at all — carry the keyword unseen, and since
#    #129 that silence is an ALLOWED commit rather than a missing advisory. Nor is
#    `--message` abbreviated: `--mes` down to `--m` all resolve under git, and
#    each shorter spelling would have to be listed in gp_git_value_flags to be
#    read as taking a value at all, which is a change with a blast radius (an
#    unlisted value flag's value reads as a pathspec) larger than the rule.
#  - Long-option abbreviation is honoured only for `--include`, from `--inc`
#    down: anything shorter also matches `--interactive`, a different flag.
#    `--all` has no unambiguous abbreviation — every shorter prefix also matches
#    `--allow-empty` — so only the exact spelling is matched. `--no-verify`
#    abbreviates to `--no-veri`; `--no-ver` and shorter also match
#    `--no-verbose`, so git rejects them outright and nothing commits.
#  - `--amend` abbreviates to `--am`: no other `git commit` long option begins
#    `am` (`--all`, `--allow-empty` and `--author` all diverge at the second
#    letter), and `--a` alone is ambiguous, so git rejects it (mantahostels#2540). There is
#    no short form to read.
#  - The `--amend` deny is anti-contention, so it is shared-tree-only and stood
#    down mid-sequence, exactly as the index verdicts are: a linked worktree's
#    HEAD is nobody else's tip, and neither is a rebase's, which is detached at
#    the commit being replayed. THE OTHER THREE STAND DOWN FOR NOTHING — a
#    conflicted merge's HEAD in the shared tree IS `main`'s tip — but git
#    refuses an amend mid-merge, mid-cherry-pick and mid-revert of its own
#    accord (`fatal: You are in the middle of a merge -- cannot amend`), so the
#    gap is unreachable. Its known residual is an amend the session makes while
#    ANOTHER session is not committing, which is harmless and refused all the
#    same: the guard cannot see the future of `main`.
#  - `-n` is read as `--no-verify` under `git commit` ONLY. Under `git add` the
#    same letter is `--dry-run`, which stages nothing and is already allowed;
#    under `git merge` and `git rebase` it is `--no-stat`, which turns off a
#    diffstat; under `git cherry-pick` and `git revert` it is `--no-commit`,
#    which leaves an ordinary gated commit to finish the replay (mantahostels#1705, mantahostels#1706);
#    under `git am` it is `--no-scissors`, which changes how the patch's message
#    is cut and skips no hook at all (mantahostels#1707). Read as `--no-verify` anywhere but
#    `git commit` and the guard denies a command carrying no such flag.
#  - How far `--no-verify` abbreviates differs per subcommand, and nv_spellings
#    carries the measured floor for each, plus which arms are prospective.
#  - `merge`, `rebase`, `cherry-pick`, `revert` and `am` are walked for the
#    `--no-verify` deny ALONE. Nothing else about them is judged: none stages a
#    pathspec, so the index verdicts and the pathspec warns have no subject.
#  - THIS IS THE HOOK-DEFEAT LIST'S ONE HOME (#800): the .husky headers point
#    here. TWO ROUTES TO THE SAME HARM ARE LEFT OPEN
#    (mantahostels#975, #792): `HUSKY=0` in the command's environment, which
#    .husky/_/h exits on before any hook runs, and `core.hooksPath` pointed
#    anywhere but .husky/_ — by `-c`, `--config-env`, the `GIT_CONFIG_*`
#    variables, or a persistent `git config` that disarms every other session
#    in the tree too. Each skips every hook
#    while spelling no flag this reads, and on every subcommand walked above,
#    not `commit` alone. `git am --no-verify` is denied here, so it stays open
#    from a terminal and through a wrapper (both LIMITS below).
#  - mantahostels#1651's verdict is scoped to a pathspec word that IS a directory. A glob
#    git expands itself — `git commit -m "…" -- 'docs/*'` — has the same silent
#    harm and is its known residual.
#  - Attribution errs toward warning. A file this session wrote by a route the
#    ledger cannot see — a shell redirect, a script that takes no claim — reads
#    foreign and warns.
#  - A commit reached through a wrapper is not seen, because only a segment's
#    own first word is read. Measured directly against this guard's own probe
#    command, `timeout 5 git commit -a -m probe -- README.md` and `sh -c "git
#    commit -a -m probe -- README.md"` are both silent
#    (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/hook-if-bash-matching.md §1). Those two wrappers, `env`
#    and `command`, carry `git am --no-verify x.patch` past it too (#800),
#    and `git am` runs no gate but the one that flag skips, so the patch
#    lands wholly unscanned.
#  - Wired with `if: Bash(git *)` (mantahostels#2127; best-effort:
#    docs/agents/guard-authoring.md's surface 4, which fails toward running)
#    — not exec'd unless some segment of the
#    command leads with `git`. This does not widen the wrapper blind spot
#    above: the anchored field does not exec the guard on a `timeout`-wrapped
#    or `sh -c`-quoted commit, and the walker would not see past either if it
#    did.
#    Wired a second time with `if: Bash(*commit-paths.js*)` (#2022),
#    unanchored because the call leads with `node`, so it also execs on a `cat`
#    or `grep` naming the file, where the walker finds no call and the guard
#    allows.
#  - It guards the Bash tool, so it binds agent sessions and not the founder's
#    own terminal. That is why the deny carries no override: an escape a session
#    can spell for itself is not a deny (mantahostels#109, agreeing with mantahostels#110).

set -uo pipefail

# The ledger scratch file is removed on the spot, but every verdict below exits
# from wherever it stands, and a hook timeout or an earlyoom kill can land
# between the mktemp and the rm.
ledger=""
trap 'rm -f "$ledger" 2>/dev/null' EXIT

here="$(dirname "${BASH_SOURCE[0]}")"

# The shared parser (mantahostels#123). Resolved from this file's own location, because a
# hook runs with an arbitrary cwd. If it cannot be loaded the guard disarms
# itself rather than blocking every Bash call — mantahostels#103 §6's fail-open rule, which
# now has to cover the library's absence as well as an unparseable command.
#
# The gate is ONE name, `gp_begin` — never `source`'s own exit status. Why that
# is enough is on gp_begin in lib/guard-parse.sh (mantahostels#157).
#
# lib/guard-log.sh is sourced FIRST and separately, so the one fault that disarms
# this guard entirely — the parser failing to load — is itself recordable (mantahostels#147).
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

# For gp_rule_module, which skips the module-gated rules without it.
# shellcheck source=scripts/lib/wfc-config.sh
source "$here/lib/wfc-config.sh" 2>/dev/null ||
  gl_log "lib/wfc-config.sh did not load — the module-gated commit rules are skipped"

# Claude Code sends session_id on every hook payload; the env var is the fallback
# (guard-file-claim.sh's pairing, kept identical).
session="$(gp_payload_field '.session_id')" || session=""
[[ -n "$session" ]] || session="${CLAUDE_CODE_SESSION_ID:-}"

# A merge, rebase, cherry-pick or revert in progress. Resolved through
# `rev-parse --git-dir` rather than a literal .git/, because in a worktree .git
# is a file and every one of these paths would miss.
mid_sequence() {
  local dir="$1" gitdir
  gitdir="$(git -C "$dir" rev-parse --path-format=absolute --git-dir 2>/dev/null)" || return 1
  [[ -e "$gitdir/MERGE_HEAD" ||
    -d "$gitdir/rebase-merge" ||
    -d "$gitdir/rebase-apply" ||
    -e "$gitdir/CHERRY_PICK_HEAD" ||
    -e "$gitdir/REVERT_HEAD" ]]
}

# What the index holds, against HEAD — or against the empty tree before the
# first commit, where `diff --cached HEAD` has no HEAD to resolve and errors.
#
# core.quotePath=false so a non-ASCII path comes out raw rather than
# octal-escaped, which is what the ledger holds and what an exact-line match
# below needs.
staged_files() {
  local dir="$1"
  if git -C "$dir" rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
    git -C "$dir" -c core.quotePath=false diff --cached --name-only 2>/dev/null
  else
    git -C "$dir" -c core.quotePath=false diff --cached --name-only \
      4b825dc642cb6eb9a060e54bf8d69288fbee4904 2>/dev/null
  fi
}

# BOTH arbiter answers about this commit, in ONE spawn (mantahostels#1561): the write ledger
# as `W<US><path>` lines, and the pathspec's sweep risks as
# `S<US><path><US><region><US><holder>` lines, where <US> is \x1f — a tab would
# be collapsed by `read` where the region is empty. Written into the file named
# by $1; every argument after it is a pathspec word, absolute.
#
# Non-zero means the LEDGER was unavailable and its caller must fall back to the
# index-wide warn — never that the session wrote nothing, which is a legitimate
# empty answer that exits 0 with no W lines. The S lines do not ride on it: the
# pathspec branch reads no ledger.
#
# $2 names, for the fail-open log, what this read was feeding: a non-answer is
# byte-identical to a clean one in both callers (mantahostels#3278).
read_arbiter() {
  local out="$1" what="$2" rc note="" bound=5
  shift 2
  # The one exit here that logs nothing: a commit with no session id is a
  # defined state of the harness, not a fault.
  [[ -n "$session" ]] || return 1
  command -v node >/dev/null 2>&1 ||
    {
      gl_log "node is not on PATH — $what"
      return 1
    }
  # Bounded like guard-file-claim.sh's arbiter call: fail-open-on-exception
  # cannot catch a hang, and this runs ahead of a commit the session is waiting on.
  if command -v timeout >/dev/null 2>&1; then
    timeout "$bound" node "$here/session-arbiter.js" commit-check "$session" "$@" >"$out" 2>/dev/null
  else
    node "$here/session-arbiter.js" commit-check "$session" "$@" >"$out" 2>/dev/null
  fi
  rc=$?
  # Non-zero arrives two ways, and the fallback is right for both. The arbiter
  # exits 1 itself when it cannot read the ledger (mantahostels#135); anything else is a
  # fault it never saw, since it catches its own exceptions and exits 0 — 124 is
  # timeout's kill, 137 earlyoom at the WSL memory cap.
  ((rc == 0)) && return 0
  ((rc == 124)) && note=" (killed at the ${bound}s bound)"
  gl_log "session-arbiter.js commit-check exited $rc$note — $what"
  return 1
}

# gp_deny, with $unset_text spliced in after the refusal's framing paragraph
# (#312). A reason with no blank line has no such paragraph, and gets the line
# appended rather than its text doubled.
deny_naming_unset() {
  local reason="$1"
  [[ -n "$unset_text" && "$reason" != *$'\n\n'* ]] && reason+=$'\n\n'
  [[ -n "$unset_text" ]] &&
    reason="${reason%%$'\n\n'*}"$'\n\n'"$unset_text${reason#*$'\n\n'}"
  gp_deny "$reason" "$2"
}

# The envelope is gp_deny's (mantahostels#138); the words below are this guard's. The
# heredoc is quoted, so backticks, apostrophes and § need no escaping — @CMD@ is
# the one substitution, and it carries the offending segment unmasked;
# deny_sweeping splices @ESCAPE@ too.
deny_sweeping() {
  local reason
  IFS= read -r -d '' reason <<'EOF' || :
This commit form sweeps the shared index: @CMD@

`git commit -a`/`-am` commits every dirty TRACKED file, so it takes a parallel session's uncommitted edits — they need not have staged anything, only have a file open. `-i`/`--include` commits the shared index plus your paths. docs/agents/guard-registry.md §Conventions bars both outright.

Commit by pathspec instead, naming only the files you changed:
  git commit -m "…" -- <paths>

@ESCAPE@ Then commit by pathspec as normal.
EOF
  deny_naming_unset "${reason//@ESCAPE@/$UNTRACKED_ESCAPE}" "$1"
}

# The `--no-verify` deny (mantahostels#975).
deny_no_verify() {
  local reason
  IFS= read -r -d '' reason <<'EOF' || :
This flag skips none of the pre-commit gates on a plain commit or merge, and cuts them everywhere else: @CMD@

On `git commit` and `git merge` the flag skips `.husky/pre-commit` or `.husky/pre-merge-commit`, but `.husky/prepare-commit-msg`, which no flag skips, runs that same whole stack anyway — the secrets scan, the Biome staged-paths format check, check-doc-map.js, check-digest-version.js, check-guard-registry.js and check-roadmap-valid.js — and a finding refuses the operation (mantahostels#1705). On a commit made mid-rebase or mid-cherry-pick, where `pre-commit` would run that whole stack, the flag leaves the secrets scan alone (mantahostels#1706). On `git am` it skips `.husky/pre-applypatch`, that route's only gate and its secrets scan (mantahostels#1707): a credential applied past it is public the moment anyone pushes. Today's git refuses it on `git revert` and `git cherry-pick` outright.

Drop the flag: on a plain commit or merge it buys nothing, and everywhere else it turns gates off.

There is no override, deliberately — an escape a session can spell for itself is not a deny (mantahostels#109). The git-hook escapes, `WFC_ALLOW_BRANCH` among them, each stand down one gate alone, and are the founder's to set, never yours: stop and ask (#916).
EOF
  deny_naming_unset "$reason" "$1"
}

# The `--amend` deny (mantahostels#2540).
deny_amend() {
  local reason
  IFS= read -r -d '' reason <<'EOF' || :
This amend rewrites whichever commit is `main`'s tip right now, which may not be yours: @CMD@

The shared working tree holds `main`, and four or more sessions commit to it every few minutes. Between your own `git commit` and this `git commit --amend`, a neighbouring session's commit routinely lands — and `--amend` targets the tip as it stands at that instant, so the amend takes THEIR commit under YOUR message.

It fails silently in the direction that matters: the amend reports success and prints a diffstat, and the diffstat is of the neighbour's change (observed on mantahostels#2507; account at mantahostels#2540).

Make a follow-up commit instead:
  git commit -m "…" -- <paths>

Where the history really must be rewritten, do it in a throwaway worktree, where no neighbour commits:
  git worktree add --detach <dir>

A `git commit --amend` there is allowed.
EOF
  deny_naming_unset "$reason" "$1"
}

# The closing-keyword deny (mantahostels#2592, #129).
#
# THE PATTERN ITSELF, and $closing_match, live in scripts/lib/closing-keyword.sh
# (#138) — shared with scripts/check-commit-message-closes.sh, the git-hook
# scanner that catches the routes this PreToolUse guard cannot see (`-F`, a
# `-c`/`-C` reuse, $EDITOR, the founder's own terminal). Two copies of the
# keyword list would drift; one is the point of the file.
# shellcheck source=scripts/lib/closing-keyword.sh
source "$here/lib/closing-keyword.sh"

# Does the commit's message close an issue? Sets $closing_match on a hit.
closes_keyword() {
  closes_keyword_match "$commit_message"
}

# The rule text is closing_rule_text(), in the shared lib above (#138) — one
# copy of the fallback across both refusals.
closes_rule() {
  closing_rule_text
}

# UNQUOTED heredoc, so the match and the rule text splice in — every backtick
# and dollar below is escaped for that reason. @CMD@ is gp_deny's own
# substitution and carries the offending segment.
deny_closes_keyword() {
  local reason
  IFS= read -r -d '' reason <<EOF || :
This commit message closes an issue server-side the moment it is pushed: @CMD@

What matched: \`$closing_match\`

$(closes_rule)

Rewrite the message with a non-closing reference and commit again.
EOF
  deny_naming_unset "$reason" "$1"
}

# The one copy of the escape, in every message that offers it; the script comes
# first (#587).
UNTRACKED_ESCAPE="Commit with \`node $(gp_script_path commit-paths.js) -m \"…\" -- <paths>\` (Bash \`timeout: 600000\`): it intent-adds a file git does not know yet, and waits out a neighbour's index lock. By hand, \`git add -N <path>\` is the exception — intent-to-add stages a name and no content."

warning="" # the first warn found; held back in case a later segment denies

# mantahostels#1651's left-behind text, held OUT of $warning so every verdict decided later
# outranks it (mantahostels#3280 D2). A plain line-move was not available: mantahostels#1651 is judged
# above the shared-tree gate because it binds in a linked worktree too, while
# the sweep warn is judged below it, so moving either would change its tree
# scope.
left_behind_text=""

# The paths an earlier segment of THIS command intent-adds — `git add -N <path>
# && git commit … -- <path>`, the escape untracked_warn itself prints. Absolute,
# resolved against the segment's own cwd. mantahostels#1612's warn skips them: the guard
# judges PreToolUse, so the path is untracked here and tracked by the time git's
# commit runs, which made that warn a false positive and cost the sweep verdict
# its slot (mantahostels#3280 D1). Normalised through gp_norm_abs, so the two segments need
# not spell the path the same way (mantahostels#3315). Each add ARGUMENT is recorded
# alongside the untracked files git says it covers, so a directory argument and
# a file word under it match too (mantahostels#3321). NOT local, for the same reason
# $warning is not.
intent_added=()

# Did any segment name a subcommand the pathspec rule is about? Set by judge,
# read by the pre-emptive injection at the foot of the file (mantahostels#1647). NOT local,
# for the same reason $warning is not.
rule_subject=0

# The cwd that segment ran in, for the path-scoped selection at the foot (mantahostels#1805).
rule_dir=""

# The pathspec words of the commit being judged, refilled by every scan_commit.
pathspec_words=()

# Every `-m`/`--message` value of the commit being judged, joined; refilled by
# every scan_commit, so a second commit segment overwrites the first exactly as
# rule_dir does and the emission reads the last. Empty where no segment was a
# commit at all.
commit_message=""

# gp_scan_flags's callback: one event per word. It sets scan_commit's `sweeps`,
# `no_verify` and `has_pathspec` in place, so it is only ever called from there.
commit_arg() {
  case "$1:$2" in
    # The message text, for the closing-keyword rule at the foot of this file.
    # `-m`/`--message` only: `-F`/`--file` and `-t`/`--template` name a FILE,
    # and `-c`/`-C`/`--fixup`/`--squash` name a COMMIT, so reading any of them
    # as text would test the wrong string. A message written into a file, or
    # reused off another commit, is therefore unseen (LIMITS above).
    # gp_literal yields the text even where it cannot resolve the span, which
    # is all the keyword test needs; the raw word may be a masked placeholder.
    opt:-m | opt:--message) commit_message+=" $(gp_literal "$3" || :)" ;;
    # `-n` is `--no-verify` under commit (mantahostels#975); LIMITS above has the
    # abbreviations.
    flag:-n | flag:--no-veri | flag:--no-verif | flag:--no-verify)
      no_verify=1
      ;;
    # `--amend` rewrites `main`'s tip (mantahostels#2540); LIMITS above has the
    # abbreviation floor.
    flag:--am | flag:--ame | flag:--amen | flag:--amend)
      amend=1
      ;;
    # `-a` sweeps every dirty tracked file; `-i`/`--include` the whole index.
    flag:-a | flag:-i | flag:--all | \
      flag:--inc | flag:--incl | flag:--inclu | flag:--includ | flag:--include)
      sweeps=1
      ;;
    # The file naming the paths is itself a pathspec. `dangling` is the same
    # flag with no value left to take: git rejects that outright, so reading it
    # as a pathspec keeps the warn down on a command that commits nothing —
    # the fail-open reading (mantahostels#103 §6), and what this guard did before mantahostels#495.
    opt:--pathspec-from-file | dangling:--pathspec-from-file) has_pathspec=1 ;;
    # A lone `-` is no option git knows either, and reads the same way.
    flag:-) has_pathspec=1 ;;
    # A `--pathspec-from-file` list is counted above and never collected, so
    # that form sets the branch and finds nothing to check.
    arg:*)
      has_pathspec=1
      pathspec_words+=("$3")
      ;;
  esac
  return 0
}

# Read `git commit`'s arguments: does it carry a sweeping flag, does it skip the
# hooks, does it name a pathspec, and what does its message say? Sets `sweeps`,
# `no_verify`, `amend`, `has_pathspec`, `pathspec_words` and `commit_message`.
scan_commit() {
  sweeps=0
  no_verify=0
  amend=0
  has_pathspec=0
  pathspec_words=()
  commit_message=""
  gp_scan_flags "$(gp_git_value_flags commit)" commit_arg -- "$@"
}

# The flags each hook-skipping subcommand gives a value in a separate word.
# Only `--no-verify` is judged for these four, so each list exists for one
# reason: without it `git merge -m --no-verify` would read its own message as a
# flag and deny a merge that runs every hook.
#
# merge and rebase read the table guard-pull-form.sh shares (#302). The other
# three stay here, as no other guard reads them. List only a flag measured to
# swallow the next word: one listed wrongly lets `--no-verify` through as its
# value.
nv_value_flags() {
  case "$1" in
    merge | rebase) gp_git_value_flags "$1" ;;
    # `-m` under cherry-pick and revert is the MAINLINE number, not a message.
    cherry-pick | revert) echo "-m --mainline --cleanup" ;;
    # Measured the same way at mantahostels#1707, which lists what `am` does and does not
    # swallow.
    am) echo "--directory --exclude --include --whitespace --patch-format --quoted-cr -p -C" ;;
  esac
}

# The `--no-verify` spellings each subcommand accepts (mantahostels#1705 for merge, mantahostels#1706
# for the replay routes). Anything shorter git rejects itself as ambiguous, so
# nothing commits: `--no-ver` and shorter are `--no-verbose` under both merge
# and rebase.
#
# `git cherry-pick` and `git revert` accept NO spelling of the flag on git
# 2.43.0. Their arm is PROSPECTIVE, denying a command today's git rejects
# anyway. Re-measure it with a RESOLVABLE revision: given a ref git cannot
# resolve, it dies on the revision before it reports the flag (mantahostels#1706).
nv_spellings() {
  case "$1" in
    merge | cherry-pick | revert) echo "--no-verify" ;;
    rebase) echo "--no-veri --no-verif --no-verify" ;;
    # `git am` abbreviates furthest of the five — measured at mantahostels#1707, `--no-v`
    # already resolves, `am` having no other `--no-v…` option to be ambiguous
    # with. `-n` is DELIBERATELY absent: under `am` it is `--no-scissors`.
    am) echo "--no-v --no-ve --no-ver --no-veri --no-verif --no-verify" ;;
  esac
}

# gp_scan_flags's callback for the four. `NV_SPELLINGS` is set by scan_no_verify
# immediately before the walk, so it is only ever called from there.
NV_SPELLINGS=""
nv_arg() {
  [[ "$1" == "flag" ]] && case " $NV_SPELLINGS " in
    *" $2 "*) no_verify=1 ;;
  esac
  return 0
}

# Read a `git merge`/`rebase`/`cherry-pick`/`revert`/`am`'s arguments: does it
# skip the hooks? Sets `no_verify` alone.
scan_no_verify() {
  local sub="$1"
  shift
  no_verify=0
  NV_SPELLINGS="$(nv_spellings "$sub")"
  gp_scan_flags "$(nv_value_flags "$sub")" nv_arg -- "$@"
}

# The pathspec-sweep warn (mantahostels#1539): a pathspec takes the WORKING-TREE copy of
# every path it names, so a live neighbour's unsaved edits to one of them land
# under this session's message. mantahostels#1560 ruled it warn-only and whole-file.
#
# $1 is the cwd the commit runs in — `git -C` included — because a pathspec is
# cwd-relative and the arbiter resolves against the repo root.
sweep_warn() {
  local dir="$1" word abs kind rel region holder subject body="" swept=""
  local root relword crel hit shown=0 omitted=0 others=0 hidden=0
  local -a resolved=() collided=()
  for word in ${pathspec_words+"${pathspec_words[@]}"}; do
    # A word whose text cannot be read — an unexpanded $VAR, a command
    # substitution — is dropped rather than guessed at (mantahostels#103 §6).
    abs="$(gp_literal "$word")" || {
      hidden=1
      continue
    }
    [[ -n "$abs" ]] || {
      hidden=1
      continue
    }
    [[ "$abs" == /* ]] || abs="$dir/$abs"
    # Normalised, so the foot below compares the same spelling the arbiter
    # answers in (mantahostels#3315).
    resolved+=("$(gp_norm_abs "$abs")")
  done
  ((${#resolved[@]})) || return 0

  ledger="$(mktemp 2>/dev/null)" || return 0
  read_arbiter "$ledger" "the mantahostels#1539 sweep check was skipped for this pathspec commit" "${resolved[@]}" || :
  while IFS=$'\x1f' read -r kind rel region holder; do
    [[ "$kind" == "S" ]] || continue
    [[ -n "$rel" ]] || continue
    # Every collision is remembered, capped or not: the foot below asks whether
    # the pathspec names anything BEYOND the colliding files, and a path dropped
    # from the message is still one of them.
    collided+=("$rel")
    # CAPPED AT $LEFT_BEHIND_CAP (mantahostels#3272), against mantahostels#1762's 10,000-character
    # hook-output ceiling, which this warn shares with any rule injection on the
    # same event. The number is borrowed from the neighbour verdict below rather
    # than derived.
    if ((shown >= LEFT_BEHIND_CAP)); then
      omitted=$((omitted + 1))
      continue
    fi
    shown=$((shown + 1))
    # A session name is a whole ticket title, long enough to push the act off
    # the bottom of the message. 60 is a chosen width, derived from nothing.
    ((${#holder} > 60)) && holder="${holder:0:60}…"
    subject="a claim on it"
    [[ -n "$region" ]] && subject="a claim on §$region of it"
    body+="This commit names $rel, and a live session ($holder) holds $subject with unsaved edits in the working tree. A pathspec commit takes the whole working-tree file, "
    [[ -n "$region" ]] && body+="their region included, "
    body+="so their work would be swept in under your message — that is mantahostels#1539.

"
    # The declared-sweep line mantahostels#3270 prescribes, composed LITERALLY from the same
    # three fields the sentence above used rather than left as a template the
    # session has to fill in — advice it must translate before it can act is the
    # defect mantahostels#3272 exists to fix. A whole-file claim carries no region, and takes
    # the path instead, matching the warn's own "a claim on it".
    if [[ -n "$region" ]]; then
      swept+="  Swept: §$region ($holder)
"
    else
      swept+="  Swept: $rel ($holder)
"
    fi
  done <"$ledger"
  rm -f "$ledger"
  ledger=""

  [[ -n "$body" ]] || return 0
  # One list rendered twice, so one cap governs both (mantahostels#3272).
  ((omitted)) && {
    body+="… and $omitted more claimed path(s) this commit names.

"
    swept+="  … and $omitted more
"
  }

  # Does the pathspec name anything beyond the colliding files? Where it does
  # not, "commit your own paths instead" offers no move at all (mantahostels#3272).
  #
  # BOTH SIDES ARE NORMALISED THE SAME WAY (mantahostels#3315). The words go through
  # gp_norm_abs above; $root is gr_root, the arbiter's own repoRoot() spelled in bash and
  # kept byte-for-byte identical to it (mantahostels#1905, guard-root.sh) — so the strip
  # yields exactly the `rel` session-arbiter.js derived from the same word.
  # `git rev-parse --show-toplevel` was the old root and cannot be: it resolves
  # symlinks where the words and the arbiter are both lexical, so on a
  # symlinked checkout the strip never matched.
  #
  # It FAILS OPEN to "there are other paths", which is the unchanged foot: a
  # word dropped above because its text could not be read lands there. The cost
  # is the old advice on a commit that deserved the new — never the reverse,
  # which would tell a session there is nothing else to commit when there is one
  # it cannot see.
  #
  # A LINKED WORKTREE never reaches this. The arbiter drops a path outside
  # CLAUDE_PROJECT_DIR (relativeToRepo returns null), so a worktree commit
  # collides with nothing and the warn has already returned above.
  others=1
  if ((hidden)); then
    :
  else
    root="$(gr_root)"
    others=0
    for word in "${resolved[@]}"; do
      relword="${word#"$root"/}"
      hit=0
      for crel in "${collided[@]}"; do
        [[ "$relword" == "$crel" ]] && {
          hit=1
          break
        }
      done
      ((hit)) || {
        others=1
        break
      }
    done
  fi

  if ((others)); then
    warning="${body}Commit your own paths instead:
  git commit -m \"…\" -- <your other paths>"
    return 0
  fi
  warning="${body}This file is the whole pathspec, so there are no other paths to commit instead.
Commit anyway and declare the sweep — put these lines in the commit message body (mantahostels#3270):
$swept"
}

# The untracked-pathspec warn (mantahostels#1612). docs/agents/guard-registry.md §Conventions' headline rule —
# commit by pathspec, never `git add` first — has no route for a file git does
# not track yet. This puts the `git add -N` escape in front of the session that
# followed the rule exactly; deny_sweeping and the `git add` warn already carry
# it for the session that staged first.
#
# A word is called out only where git tracks NOTHING it matches AND something
# untracked is there under it. A word matching nothing at all — a typo, or the
# flag-shaped path at mantahostels#495 — gets no warn: `git add -N` is no advice for a file
# that is not there.
#
# An IGNORED file is deliberately in scope (no --exclude-standard): git rejects
# the pathspec for it just the same, and the message carries the `-f` it needs.
#
# $1 is the cwd the commit runs in, as sweep_warn's is, and for the same reason.
untracked_warn() {
  local dir="$1" word lit abs tracked others rc list="" ia staged_here
  for word in ${pathspec_words+"${pathspec_words[@]}"}; do
    # An unexpanded $VAR or a command substitution is dropped rather than
    # guessed at (mantahostels#103 §6).
    lit="$(gp_literal "$word")" || continue
    [[ -n "$lit" ]] || continue
    abs="$lit"
    [[ "$abs" == /* ]] || abs="$dir/$abs"
    # Normalised, so the intent-add comparison below is spelling-independent
    # (mantahostels#3315); ia_arg normalises its own side the same way.
    abs="$(gp_norm_abs "$abs")"
    # An earlier segment of this same command intent-adds it, so git tracks it
    # by the time the commit runs and this verdict would be a false positive
    # (mantahostels#3280 D1). Segments are walked left to right, so `git commit … ; git add
    # -N x` suppresses nothing — that commit really does fail.
    #
    # CONTAINMENT, not equality, on two normalised absolute paths (mantahostels#3318): a
    # file intent-added INSIDE a directory word clears that word too, because
    # `git add -N src/new.md && git commit -m "x" -- src` commits src/new.md
    # and exits 0. The `/` in the second test is what keeps /repo/srcx out of
    # /repo/src; the `%/` strips it back off for a word normalising to a bare
    # `/`, which gp_norm_abs is alone in ending in one.
    #
    # The other direction — `git add -N src && git commit … -- src/new.md` —
    # needs no second branch here: ia_arg asks git what a directory argument
    # covers and records the files themselves, so the file word matches the
    # equality test above (mantahostels#3321).
    #
    # Residual: four `--pathspec-from-file` shapes record nothing — a list taken
    # from STDIN (the `-` spelling), the hook payload carrying none; a list file
    # the hook cannot read, which an earlier segment of the same command may not
    # have written yet; a C-quoted line inside one; and a list an earlier
    # segment REDIRECTS into, whose bytes at hook time are not the bytes git
    # will read (mantahostels#3324, mantahostels#3327). All four fail towards the warn, the safe
    # direction. The rewrite that is not a redirect — a `tee`, a `sed -i`, a
    # script — still fails the other way.
    staged_here=0
    for ia in ${intent_added+"${intent_added[@]}"}; do
      [[ "$ia" == "$abs" || "$ia" == "${abs%/}"/* ]] && {
        staged_here=1
        break
      }
    done
    ((staged_here)) && continue
    # Both reads fail open and both are RECORDED (mantahostels#147, §S3): a path outside the
    # repo, or any other git refusal, leaves the word unjudged — which is
    # otherwise indistinguishable from a word this verdict cleared.
    tracked="$(git -C "$dir" ls-files --cached -- "$abs" 2>/dev/null)"
    rc=$?
    ((rc == 0)) || {
      gl_log "git could not list tracked files under $abs in $dir (exit $rc) — that pathspec word was left unjudged for mantahostels#1612"
      continue
    }
    [[ -n "$tracked" ]] && continue
    others="$(git -C "$dir" ls-files --others -- "$abs" 2>/dev/null)"
    rc=$?
    ((rc == 0)) || {
      gl_log "git could not list untracked files under $abs in $dir (exit $rc) — that pathspec word was left unjudged for mantahostels#1612"
      continue
    }
    [[ -n "$others" ]] || continue
    list+="  $lit
"
  done
  [[ -n "$list" ]] || return 0

  warning="This commit names path(s) git does not track yet:

$list
A pathspec commit cannot reach an untracked path. git answers \`error: pathspec '<path>' did not match any file(s) known to git\`, exits 1 and commits NOTHING — read that exit as \"nothing to do\" and the ticket looks finished with the file uncommitted (mantahostels#1612).

$UNTRACKED_ESCAPE Then commit by pathspec as normal. A path your .gitignore covers needs \`git add -f -N <path>\` by hand — the script refuses it — or it does not belong in this commit at all."
}

# The left-behind warn (mantahostels#1651), the verdict table above having the behaviour.
#
# mantahostels#1612's own loop cannot reach it: it clears any word matching something git
# tracks, which is what keeps `git commit -- .` quiet in a repo that always has
# untracked scratch files. So this is a second verdict, not a widened one, and
# mantahostels#1612's message and trigger are untouched.
#
# IGNORED files are EXCLUDED here (--exclude-standard), unlike mantahostels#1612's branch,
# which includes them so its message can carry the `-f`. Under a directory word
# they would list node_modules and every build artefact.
#
# The write ledger is deliberately NOT consulted to narrow this. It does hold
# some Bash-route writes (mantahostels#2778): a code path — the CODE globs in
# lib/code-signal.sh — that guard-claimed-bash-write.sh resolved literally
# and no live neighbour held — a new `cat > scripts/x.sh` among them, so the
# overlap with this verdict's case is partial rather than nil. It holds none of
# the rest, and the rest is most of that case: in an auto-mode session new files
# arrive by `cat >`, and a doc, a fixture or a target the parser could not read
# is still credited to nobody (scripts/record-write.sh), so scoping to the
# ledger would go silent on those.
#
# A pathspec of ordinary file names cannot trigger it at all, which is what
# keeps the false-positive rate down. `.` IS in scope.
#
# $1 is the cwd the commit runs in, as the two warns above.

# How many paths the message names before it falls back to a count. A first
# guess, and stated as one: nothing has measured what a session stops reading
# at. The budget is the WHOLE message's, not each word's, so a commit naming
# five directories still prints ten lines.
#
# READ BY sweep_warn TOO, which is defined ABOVE this line and borrows the
# number (mantahostels#3272). That is safe only because both are called from the walk at the
# foot of the file, long after this assignment runs — relocate it below the walk
# and `((shown >= LEFT_BEHIND_CAP))` aborts the whole guard under `set -u`.
LEFT_BEHIND_CAP=10
left_behind_warn() {
  local dir="$1" word lit abs tracked others rc list="" count shown
  local budget="$LEFT_BEHIND_CAP" omitted=0
  for word in ${pathspec_words+"${pathspec_words[@]}"}; do
    # An unexpanded $VAR or a command substitution is dropped rather than
    # guessed at (mantahostels#103 §6).
    lit="$(gp_literal "$word")" || continue
    [[ -n "$lit" ]] || continue
    abs="$lit"
    [[ "$abs" == /* ]] || abs="$dir/$abs"
    # A word that is not a directory on disk is mantahostels#1612's business or nobody's.
    [[ -d "$abs" ]] || continue
    # Both reads fail open and both are RECORDED (mantahostels#147, §S3): an unjudged word
    # must not read like a cleared one.
    tracked="$(git -C "$dir" ls-files --cached -- "$abs" 2>/dev/null)"
    rc=$?
    ((rc == 0)) || {
      gl_log "git could not list tracked files under $abs in $dir (exit $rc) — that pathspec word was left unjudged for mantahostels#1651"
      continue
    }
    # Nothing tracked under it is mantahostels#1612's case, already judged above.
    [[ -n "$tracked" ]] || continue
    others="$(git -C "$dir" ls-files --others --exclude-standard -- "$abs" 2>/dev/null)"
    rc=$?
    ((rc == 0)) || {
      gl_log "git could not list untracked files under $abs in $dir (exit $rc) — that pathspec word was left unjudged for mantahostels#1651"
      continue
    }
    [[ -n "$others" ]] || continue
    count="$(printf '%s\n' "$others" | wc -l)"
    shown=$((count < budget ? count : budget))
    budget=$((budget - shown))
    omitted=$((omitted + count - shown))
    list+="  $lit
"
    ((shown)) && list+="$(printf '%s\n' "$others" | head -n "$shown" | sed 's/^/    /')
"
  done
  [[ -n "$list" ]] || return 0
  ((omitted)) && list+="  … and $omitted more
"

  # $left_behind_text, not $warning: the emission foot takes this up only where
  # nothing decided later claimed the slot (mantahostels#3280 D2).
  left_behind_text="This commit names director(ies) holding file(s) git does not track yet:

$list
git ACCEPTS a directory pathspec: it commits the tracked files under it, exits 0 and leaves the untracked ones behind — no error, nothing to notice (mantahostels#1651). Read that exit as done and the ticket looks finished with the new file uncommitted.

Name the files you changed, rather than the directory holding them — the script refuses such a directory too. $UNTRACKED_ESCAPE"
}

# Record one path a `git add -N` segment intent-adds, and the files under it
# where it names a directory. Called from ia_arg for a bare word and from
# ia_from_file for each line of a `--pathspec-from-file` list, so both routes
# normalise and expand identically (mantahostels#3324).
ia_record() {
  local lit="$1" expanded rel rc
  local -a excl=(--exclude-standard)
  [[ -n "$lit" ]] || return 0
  [[ "$lit" == /* ]] || lit="$IA_DIR/$lit"
  # Normalised, as untracked_warn normalises the word it compares against
  # (mantahostels#3315).
  lit="$(gp_norm_abs "$lit")"
  intent_added+=("$lit")

  # The argument as written is not what git stages: `git add -N src` walks the
  # directory and intent-adds every untracked file under it, so a later `git
  # commit … -- src/new.md` names a path git tracks by then. untracked_warn
  # compares PATHS, so the walk has to happen here — the argument alone leaves
  # that commit warned (mantahostels#3321).
  #
  # `--exclude-standard` matches `git add`'s own behaviour under a DIRECTORY
  # argument: an ignored file there is skipped, and only `-f` reaches it.
  # Recording more than git would stage would suppress a warn the commit still
  # earns. The parity is the walk's alone — the argument recorded above is
  # unconditional, so a `git add -N <ignored file>` git refuses is credited
  # anyway.
  #
  # One fork per argument, and `git add -N .` records every untracked file in
  # the tree, which the loop in untracked_warn then walks per pathspec word.
  # Batching the arguments into one call would spare the forks and lose the
  # per-argument fail-open: a 128 on one word would void the rest.
  ((IA_FORCE)) && excl=()
  expanded="$(git -C "$IA_DIR" ls-files --others ${excl+"${excl[@]}"} -- "$lit" 2>/dev/null)"
  rc=$?
  ((rc == 0)) || {
    gl_log "git could not list what \`git add -N $lit\` covers in $IA_DIR (exit $rc) — only the argument itself was recorded for mantahostels#3321"
    return 0
  }
  # Newline-separated, not `-z`: bash drops NUL bytes out of a command
  # substitution. A path holding a newline comes back C-quoted by ls-files and
  # so matches nothing here, leaving that word warned — the safe direction, and
  # the same line git's own quoting draws.
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    [[ "$rel" == /* ]] || rel="$IA_DIR/$rel"
    intent_added+=("$(gp_norm_abs "$rel")")
  done <<<"$expanded"
  return 0
}

# Does any segment of this command redirect into the pathspec list at $1 (mantahostels#3327)?
#
# ia_from_file opens the list when the HOOK runs; git opens it when the COMMAND
# runs. Where an earlier segment rewrites it in between — `printf 'other.md\n' >
# p.txt && git add -N --pathspec-from-file p.txt && git commit -m "x" -- new.md`
# against a pre-existing p.txt naming new.md — the stale bytes credit an
# intent-add git never makes, and mantahostels#1612's warn is suppressed on the commit that
# earns it. So a redirect into the list records NOTHING.
#
# REDIRECTS ONLY. `tee p.txt`, `sed -i p.txt`, `cp`/`mv` onto it, a script that
# writes it, and a redirect inside a quoted span — `git commit -m "$(printf x >
# p.txt)"`, blanked before this walk ever runs — all pass unseen.
IA_LIST_TARGET=""
IA_LIST_HIT=0
ia_redirect_hits_list() {
  local i lit
  gp_redirects
  for i in "${!_gp_redir_kind[@]}"; do
    # TRUNCATING redirects only, any descriptor, and `<>`, which rewrites in
    # place. `>>` APPENDS, so git reads the stale lines and more: what this
    # guard recorded is a subset of what git stages, and a subset only ever
    # fails towards the warn. A descriptor that writes no list — `2> log` —
    # costs a false warn at worst.
    case "${_gp_redir_kind[i]}" in
      truncate | clobber | read-write) ;;
      *) continue ;;
    esac
    # A target that will not resolve — an unexpanded $VAR, a command
    # substitution, an unknown cwd — is treated as the list rather than dropped,
    # unlike every other path reader here: dropping it is the direction that
    # loses the warn.
    [[ -z "${_gp_redir_path[i]}" || "${_gp_redir_path[i]}" == "$IA_LIST_TARGET" ]] && {
      IA_LIST_HIT=1
      return 0
    }
    # The list was resolved against the `git add` segment's cwd, which a `git
    # -C` moves and the redirect's does not, so a relative target's basename is
    # compared too — at the price of a false warn where two directories hold a
    # same-named list.
    lit="$(gp_literal "${_gp_redir_target[i]}")" || continue
    [[ "$lit" != /* && "${lit##*/}" == "${IA_LIST_TARGET##*/}" ]] && {
      IA_LIST_HIT=1
      return 0
    }
  done
  return 0
}

# ia_list_rewritten <normalised absolute path> — true where this command
# redirects into that file. ia_redirect_hits_list does the reading, once per segment.
ia_list_rewritten() {
  IA_LIST_TARGET="$1"
  IA_LIST_HIT=0
  # Re-entered from inside gp_walk_repo_git's own segment loop. Safe: both
  # loops read $_gp_segments over a here-string of their own, _gp_split_segments
  # is memoised, and the globals _gp_command_words sets are re-set per outer
  # iteration before anything reads them.
  gp_walk_commands --bare-redirects ia_redirect_hits_list
  ((IA_LIST_HIT))
}

# Read the list a `git add -N --pathspec-from-file <file>` names, and record each
# pathspec in it (mantahostels#3324). $1 is the flag's value as gp_scan_flags handed it over.
#
# The file is resolved against the SEGMENT's cwd, not the repo root: `git add -N
# --pathspec-from-file p.txt` run from a subdirectory reads that subdirectory's
# p.txt, and the paths inside it are cwd-relative too, which is what ia_record
# already assumes of a bare word.
ia_from_file() {
  local spec file line
  # An unexpanded $VAR or a command substitution is dropped rather than guessed
  # at, as every other path reader in this file drops it (mantahostels#103 §6).
  spec="$(gp_literal "$1")" || return 0
  [[ -n "$spec" ]] || return 0
  if [[ "$spec" == "-" ]]; then
    # git reads the list off stdin, which the hook payload does not carry. The
    # commit stays warned, which is the safe direction.
    gl_log "\`git add -N --pathspec-from-file -\` takes its paths from stdin, which this guard cannot read — nothing recorded for mantahostels#3324"
    return 0
  fi
  file="$spec"
  [[ "$file" == /* ]] || file="$IA_DIR/$file"
  file="$(gp_norm_abs "$file")"
  # Above the read, not after it: the stale bytes are readable, and reading them
  # is the failure (mantahostels#3327).
  if ia_list_rewritten "$file"; then
    gl_log "the pathspec list $file is rewritten by a redirect in the same command — nothing recorded for mantahostels#3327"
    return 0
  fi
  # A directory passes `-r`, and the read below then fails per line rather than
  # up front, so both land on the same log line.
  [[ -r "$file" && -f "$file" ]] || {
    # Written by an earlier segment of the same command, most likely — the file
    # does not exist yet when the hook runs.
    gl_log "could not read the pathspec list $file for mantahostels#3324 — nothing recorded"
    return 0
  }
  # `|| [[ -n "$line" ]]` on both loops: `read` returns non-zero on a FINAL
  # record with no terminator after it, and git stages that element all the
  # same, so without this the last path of an unterminated list is dropped.
  if ((IA_NUL)); then
    # `--pathspec-file-nul` takes every other character literally, newlines and
    # quotes included, so no unquoting is owed here.
    while IFS= read -r -d '' line || [[ -n "$line" ]]; do
      ia_record "$line"
    done <"$file"
  else
    while IFS= read -r line || [[ -n "$line" ]]; do
      line="${line%$'\r'}"
      [[ -n "$line" ]] || continue
      # A C-quoted line is git's escape for a path holding a newline or a quote.
      # Unquoting it here would mean re-implementing core.quotePath's decoder, so
      # it is skipped and that path left warned — the same line ia_record's own
      # walk draws on a C-quoted `ls-files` row.
      [[ "$line" == '"'* ]] && continue
      ia_record "$line"
    done <"$file"
  fi
  return 0
}

# gp_scan_flags's callback for the `git add -N` word walk (mantahostels#3280 D1). $IA_DIR,
# $IA_FORCE and $IA_NUL are set by scan_intent_added immediately before the
# walk, so this is only ever called from there.
IA_DIR=""
IA_FORCE=0
IA_NUL=0
ia_arg() {
  local lit
  case "$1:$2" in
    # An unexpanded $VAR or a command substitution is dropped rather than
    # guessed at, as every other path reader in this file drops it (mantahostels#103 §6).
    arg:*)
      lit="$(gp_literal "$3")" || return 0
      ia_record "$lit"
      ;;
    # The list file is not itself a pathspec: the paths it NAMES are, and
    # gp_scan_flags hands it over as a value rather than as words, which is why
    # the `arg` branch never sees them (mantahostels#3324). `dangling` is the same flag with
    # no value left to take, which git rejects outright — nothing to read.
    opt:--pathspec-from-file) ia_from_file "$3" ;;
  esac
  return 0
}

# Record what a `git add -N` segment intent-adds, for untracked_warn's word loop
# (mantahostels#3280 D1). $1 is the segment's own cwd — `git -C` can differ per segment.
#
# -N ONLY, NEVER -n. The `no_stage` test in judge deliberately lumps
# --intent-to-add with --dry-run; here the two letters are read apart and
# case-sensitively, because -N leaves the path TRACKED when a later segment's
# commit runs and -n leaves it untracked. A bundle carrying both (`-nN`) is a
# dry run and records nothing.
scan_intent_added() {
  local arg intent_add=0 dry_run=0 force=0 nul=0
  IA_DIR="$1"
  shift
  for arg in "$@"; do
    case "$arg" in
      -N | --intent-to-add) intent_add=1 ;;
      -n | --dry-run) dry_run=1 ;;
      # -f widens what a directory argument covers to the ignored files under
      # it, which ia_arg's walk has to match (mantahostels#3321).
      -f | --force) force=1 ;;
      # Read here rather than in ia_arg because it can be spelled AFTER
      # `--pathspec-from-file`, and ia_from_file needs it already set (mantahostels#3324).
      --pathspec-file-nul) nul=1 ;;
      # All three bundle, e.g. `git add -vN`. No other `git add` short flag
      # carries an n, an N or an f, and none takes a value in the same word, so
      # the character alone is a safe test.
      --*) ;;
      -*[Nnf]*)
        [[ "$arg" == *N* ]] && intent_add=1
        [[ "$arg" == *n* ]] && dry_run=1
        [[ "$arg" == *f* ]] && force=1
        ;;
    esac
  done
  ((intent_add)) || return 0
  ((dry_run)) && return 0
  IA_FORCE="$force"
  IA_NUL="$nul"
  gp_scan_flags "--pathspec-from-file --chmod" ia_arg -- "$@"
}

# Called once per `git add`/`stage`/`commit` running against ANY working tree of
# this repo. Another repo, an unresolvable cwd and every other subcommand were
# filtered out by gp_walk_repo_git, which also recorded the fail-opens among
# them (mantahostels#147). The linked worktree it now lets through is filtered here instead,
# below the `--no-verify` deny and above the other four verdicts (mantahostels#1213).
#
# $warning is deliberately NOT local: the first warn found is held back across
# segments in case a later one denies.
judge() {
  local segment="$1" sub="$2" target_dir="$3"
  shift 3
  local -a args=("$@")
  # $ledger stays global on purpose: the EXIT trap above removes it, and a trap
  # fires after a local has gone out of scope.
  local arg no_stage staged_out staged_rc unmatched list advice attributed
  local -a staged foreign
  # Read by the refusals judge calls, through dynamic scope. Filled here, before
  # a nested walk can reset the names it reads.
  local unset_text
  gp_unset_text unset_text

  # The three subcommands the pathspec rule is about. The merge family below
  # stages nothing by pathspec, so it earns no injection (mantahostels#1647).
  case "$sub" in
    add | stage | commit) rule_subject=1 ;;
  esac
  # `commit` ALONE, not the whole pathspec trio (mantahostels#1805). Every §Gotchas rule on
  # this trigger is about a gate that fires at COMMIT time, and `git add` reads
  # a pre-add index while contributing no pathspec words — scan_commit fills
  # those for `commit` only — so scoping an `add` would judge the wrong file set
  # and hand a stager rules about gates it is not about to meet. A `git add`
  # still gets the pathspec rule, which is unscoped.
  #
  # A second commit segment overwrites this; the emission happens once, so the
  # last one is what the scoping reads.
  [[ "$sub" == commit ]] && rule_dir="$target_dir"

  # Read the commit's flags BEFORE the mid-sequence stand-down below: the
  # `--no-verify` deny fires through one (mantahostels#975).
  case "$sub" in
    merge | rebase | cherry-pick | revert | am)
      # `git merge --no-verify` skips `.husky/pre-merge-commit` (mantahostels#1705); rebase,
      # cherry-pick and revert skip `.husky/pre-commit` on the resolution commit
      # that finishes them (mantahostels#1706); `git am --no-verify` skips
      # `.husky/pre-applypatch` (mantahostels#1707). Nothing else about these five is judged
      # here — none of them stages a pathspec — so this returns rather than
      # falling through to the index verdicts.
      scan_no_verify "$sub" ${args+"${args[@]}"}
      ((no_verify)) && deny_no_verify "$segment"
      return 0
      ;;
  esac

  # Taken ABOVE the shared-tree gate, unlike everything else the add branch
  # does: the verdict it feeds is untracked_warn, which is judged above the gate
  # too and binds in a linked worktree (mantahostels#1612, mantahostels#1213). Recording it below would
  # leave the false positive mantahostels#3280 D1 removed standing in exactly that tree.
  # It records only; it reaches no verdict of its own.
  if [[ "$sub" == "add" || "$sub" == "stage" ]]; then
    scan_intent_added "$target_dir" ${args+"${args[@]}"}
  fi

  if [[ "$sub" == "commit" ]]; then
    scan_commit ${args+"${args[@]}"}
    ((no_verify)) && deny_no_verify "$segment"
    # Judged HERE, alongside the `--no-verify` deny and above both the
    # shared-tree gate and the mid-sequence stand-down, for the reason LIMITS
    # gives (#129).
    closes_keyword && deny_closes_keyword "$segment"
    # Judged HERE, above the shared-tree gate, because git rejects an
    # unmatchable pathspec in every tree — this verdict guards no index (mantahostels#1612).
    # Mid-sequence it stands down: git refuses a partial commit outright there,
    # with an error of its own.
    if ((has_pathspec)) && [[ -z "$warning" ]] && ! mid_sequence "$target_dir"; then
      untracked_warn "$target_dir"
      # mantahostels#1651's directory case, judged here for the same reason and stood down
      # by the same two conditions. It runs second so mantahostels#1612's message and
      # trigger are untouched: where one command triggers both, git rejects the
      # whole commit anyway and mantahostels#1612's advice is the one that applies.
      [[ -n "$warning" ]] || left_behind_warn "$target_dir"
    fi
  fi

  # Everything past here protects the SHARED index, which a linked worktree does
  # not have (mantahostels#1213) — so the walk reaches this tree but the three index
  # verdicts and the pathspec warn do not fire in it. `unknown` is git failing
  # to answer for a tree the walker already classified, or an EMPTY tree, which
  # gp_tree_scope also calls `unknown` (#321) and only a strict walk hands over
  # — this guard's is not one (#312), so the log line is worded for both. It is
  # recorded rather than folded into the silent case: mantahostels#147's rule is
  # that every fail-open is logged.
  case "$(gp_tree_scope "$target_dir")" in
    shared) ;;
    unknown)
      gl_log "could not tell whether ${target_dir:-an unknown tree} is the shared tree — the index verdicts on a git $sub there were skipped"
      return 0
      ;;
    *) return 0 ;;
  esac

  # The one place staging is unavoidable, and where a bare commit is the
  # sanctioned way to finish.
  mid_sequence "$target_dir" && return 0

  if [[ "$sub" == "add" || "$sub" == "stage" ]]; then
    # -N stages a name and no content, the sanctioned first step for a new file;
    # -n stages nothing at all. scan_intent_added above reads the two apart, for
    # a purpose this test does not share.
    no_stage=0
    for arg in ${args+"${args[@]}"}; do
      case "$arg" in
        -N | --intent-to-add | -n | --dry-run) no_stage=1 ;;
        # Both bundle, e.g. `git add -vN`. No other `git add` short flag carries
        # an n or an N, so the character alone is a safe test.
        --*) ;;
        -*[Nn]*) no_stage=1 ;;
      esac
    done
    ((no_stage)) && return 0
    [[ -n "$warning" ]] || warning="Staging before committing hands the shared index to whichever session commits next — that is mantahostels#63, where one session's roadmap correction landed inside another session's unrelated commit under its message.

Commit by pathspec instead, with no staging step:
  git commit -m \"…\" -- <paths>

$UNTRACKED_ESCAPE"
    return 0
  fi

  ((sweeps)) && deny_sweeping "$segment"
  # Below the shared-tree gate and the mid-sequence stand-down above, both of
  # which this verdict wants: the race is with a neighbour's commit landing on
  # `main`, and neither a linked worktree's HEAD nor a rebase's is one (mantahostels#2540).
  ((amend)) && deny_amend "$segment"

  if ((has_pathspec)); then
    # An earlier segment's warn is already held; a second would replace it. The
    # untracked verdict above is one such holder, and it outranks this one
    # because git rejects the whole commit, so the sweep never happens (mantahostels#1612)
    # — sound because the one shape where it would be false is silenced
    # (mantahostels#3280), which the header table has.
    [[ -n "$warning" ]] || sweep_warn "$target_dir"
    return 0
  fi

  # No pathspec: this commit takes whatever the shared index holds.
  #
  # Taken through a variable and not `mapfile < <(…)`, which discards the exit
  # status: a git that ERRORS produces no lines, reads as "the index is empty"
  # and the guard says nothing at all about a commit that sweeps it (mantahostels#147). Same
  # shape as the grep status below.
  staged_out="$(staged_files "$target_dir")"
  staged_rc=$?
  ((staged_rc == 0)) ||
    {
      gl_log "git could not read the index in $target_dir (exit $staged_rc) — pathspec-less commit allowed unchecked"
      return 0
    }
  mapfile -t staged < <(printf '%s' "$staged_out")
  ((${#staged[@]})) || return 0

  [[ -n "$warning" ]] && return 0

  # Which of those did this session not write? (mantahostels#118)
  #
  # `attributed` stays 0 wherever the ledger could not be read, and only the two
  # readings below set it: "these are foreign" and "there are none".
  attributed=0
  foreign=()
  ledger="$(mktemp 2>/dev/null)" || ledger=""
  # No pathspec, so the combined read carries no S lines; the W prefix is
  # stripped here so the grep below still matches whole lines against paths.
  if [[ -n "$ledger" ]] &&
    read_arbiter "$ledger" "the write ledger was unread, so this bare commit's warn stays index-wide" &&
    sed -i -n "s/^W$(printf '\037')//p" "$ledger" 2>/dev/null; then
    # -F -x: whole line, literal — a substring match would let docs/a.md in the
    # ledger claim credit for another session's docs/a.md.bak. An empty ledger
    # matches nothing, so every staged path reads foreign.
    unmatched="$(printf '%s\n' "${staged[@]}" | grep -Fxv -f "$ledger")"
    case "$?" in
      # grep: 0 lines selected, 1 none selected, >1 ITS OWN failure — a missing
      # binary is 127. Taken through a variable and not `mapfile < <(…)`, which
      # discards the pipeline's status: a broken grep then reads as "no foreign
      # paths" and the guard says nothing at all.
      0)
        mapfile -t foreign <<<"$unmatched"
        attributed=1
        ;;
      1) attributed=1 ;;
      *) attributed=0 ;;
    esac
  fi
  [[ -n "$ledger" ]] && rm -f "$ledger"

  advice="Name your own files instead:
  git commit -m \"…\" -- <paths>"

  if ((attributed)); then
    # Every staged path is this session's own work.
    ((${#foreign[@]})) || return 0

    list="$(printf '  %s\n' "${foreign[@]}")"
    warning="This commit names no pathspec, so it takes the whole index — and the index holds ${#foreign[@]} path(s) this session never wrote:

$list
The index is repo-global, so this commit would land someone else's staged work under your message (mantahostels#63). If you did write one of those from a shell redirect or a script, the ledger cannot see it and it is listed anyway.

$advice"
  else
    # Attribution unavailable — fall back to the index-wide warn (mantahostels#117).
    list="$(printf '  %s\n' "${staged[@]}")"
    warning="This commit names no pathspec, so it will take everything in the index:

$list
The index is repo-global — any of those files may be a parallel session's staged work, which this commit would land under your message (mantahostels#63). This session's writes could not be read, so the guard cannot tell whose they are; check before proceeding.

$advice"
  fi
}

gp_walk_repo_git --empty-unset judge "commit form" add stage commit merge rebase cherry-pick revert am

# repo_relative <dir> <word>... — each masked path word, joined to <dir> where
# relative, printed relative to <dir>'s repo root, so one set of patterns
# judges every source.
repo_relative() {
  local dir="$1" root word lit
  shift
  root="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" || {
    gl_log "the repo root did not resolve in $dir — the scoped §Gotchas rules were not selected"
    return 0
  }
  for word in "$@"; do
    # An unexpanded $VAR or a command substitution is dropped rather than
    # guessed at, as every other pathspec reader in this file drops it.
    lit="$(gp_literal "$word")" || continue
    [[ -n "$lit" ]] || continue
    [[ "$lit" == /* ]] || lit="$dir/$lit"
    printf '%s\n' "${lit#"$root"/}"
  done
}

# A `node …/commit-paths.js` call runs no git the walk above sees, and already
# commits by pathspec (#2022). The paths it would land — the words after `--`,
# and the files a `--patch` names — feed the §Gotchas scoping below as a
# `git commit` pathspec does (#2147).
commit_paths_subject=0
cp_gotchas_paths=()
read_commit_paths_call() {
  shift
  gp_commit_paths_args "$@" || return 0
  commit_paths_subject=1
  gp_commit_paths_parse || return 0
  local dir
  local -a words=(${_gp_cp_paths+"${_gp_cp_paths[@]}"})
  dir="$(gp_cwd)"
  [[ -n "$dir" ]] || {
    gl_log "a commit-paths.js call's directory is unknown — the scoped §Gotchas rules were not selected"
    return 0
  }
  if [[ -n "$_gp_cp_patch" ]]; then
    if gp_patch_files "$dir" "$_gp_cp_patch"; then
      words+=("${_gp_patch_files[@]}")
    else
      gl_log "could not read the --patch file of a commit-paths.js call in $dir — the scoped §Gotchas rules did not see its files"
    fi
  fi
  mapfile -t -O "${#cp_gotchas_paths[@]}" cp_gotchas_paths < <(repo_relative "$dir" ${words+"${words[@]}"})
  return 0
}
gp_walk_commands read_commit_paths_call

# mantahostels#1651's verdict claims the slot last, and only where nothing decided later
# took it (mantahostels#3280 D2). Every warn that can co-occur with it — the sweep verdict,
# the `git add` index warn, the bare-commit warn — describes a commit that takes
# a NEIGHBOUR's work; this one describes scratch left behind by a commit that
# otherwise succeeds. Deferring here rather than moving the call keeps mantahostels#1651
# binding in a linked worktree, where the walk returns at the shared-tree gate
# but this line is still reached.
[[ -n "$warning" ]] || warning="$left_behind_text"

[[ -n "$warning" ]] && gp_warn "$warning"

# PRE-EMPTIVE INJECTION (mantahostels#1647, mantahostels#1805; spec mantahostels#1762) — the tenth output this
# file's header describes, reached only when nothing above denied or warned.
#
# ONE CALL, NOT TWO. gp_rule's 4,000-byte ceiling is per call, so a second call
# on the same trigger would take a fresh ceiling and blow the budget the first
# was scoped against.
#
# SCOPED BY WHAT THE COMMIT ACTUALLY NAMES (mantahostels#1805's acceptance criterion). A
# blanket per-subcommand request spends the ceiling on rules that will not fire
# and defers the ones that will; each `if` below states its own condition.

# Every repo-relative path this commit would land: the pathspec words where it
# names any, plus whatever the index already holds. The union, not either alone:
# `git commit -m … -- <paths>` can name a file the index does not hold yet, and a
# pathspec-less commit names none.
#
# It FAILS OPEN to the empty list. An unreadable index costs a session the
# scoped rules and nothing else — the house style (mantahostels#103 §6) — and the pathspec
# rule itself is unscoped and goes out regardless.
commit_paths() {
  repo_relative "$1" ${pathspec_words+"${pathspec_words[@]}"}
  staged_files "$1" 2>/dev/null
}

# Does any path in $2… match the extended regex $1?
paths_match() {
  local re="$1"
  shift
  local path
  for path in "$@"; do
    [[ "$path" =~ $re ]] && return 0
  done
  return 1
}

((rule_subject || commit_paths_subject)) || gp_allow
((rule_subject)) || gp_rule_skip commit-pathspec

# EVERY ID THIS TRIGGER CAN CARRY, IN PRIORITY ORDER, highest first, because the
# ceiling defers the tail rather than truncating it. commit-pathspec,
# commit-show-diff and commit-message lead: they are the only three about the
# act being performed rather than about a gate that will judge it. The six
# behind them are
# ordered by what a session loses to each — a gate that FAILs this commit
# locally first, the sweep-only WARN last. push-cadence closes the list: it
# binds after the commit, so on a commit whose gate rules fill the ceiling it
# defers to the next commit rather than displacing one (#2285). Residual: a
# session whose only commit fills the ceiling meets the push rule at Stop
# instead, from guard-unpushed-commits.js.
#
# THE SCOPING IS AN EXCLUSION, NOT A SELECTION, and that is forced — see
# gp_rule_skip's header in lib/guard-parse.sh for why.
gotchas_paths=(${cp_gotchas_paths+"${cp_gotchas_paths[@]}"})
[[ -n "$rule_dir" ]] && mapfile -t -O "${#gotchas_paths[@]}" gotchas_paths < <(commit_paths "$rule_dir")

# The three rules about documents a module owns reach only a host with that
# module on (#449): the digest is roadmap's, the doc map governance's.
gp_rule_module roadmap digest-version-drift
gp_rule_module governance doc-map-precommit superseded-values-gate
# With `landing` on, a push goes to `landing`, so the push rule is its twin.
gp_rule_module landing push-cadence-landing
gp_rule_unless_module landing push-cadence

# The six-member mapped scope, CLAUDE.md §Ground truth. check-doc-map.js runs in
# .husky/pre-commit on exactly this set (mantahostels#390).
if ! paths_match '^(docs/|\.claude/|AGENTS\.md$|CLAUDE\.md$|PRODUCT\.md$|DESIGN\.md$)' ${gotchas_paths+"${gotchas_paths[@]}"}; then
  gp_rule_skip doc-map-precommit
fi

# The two files check-digest-version.js compares. Either one alone IS the drift,
# so either one alone earns the rule.
if ! paths_match '^docs/(reference-roadmap\.html|roadmap-digest\.md)$' ${gotchas_paths+"${gotchas_paths[@]}"}; then
  gp_rule_skip digest-version-drift
fi

# A guard-registry region lives in CLAUDE.md, AGENTS.md or a Markdown file under
# docs/ or .claude/; the guards a region names, and the fragments they print,
# live under scripts/ and docs/agents/rules/. A commit reaching none of those
# cannot move the registry.
if ! paths_match '^(CLAUDE\.md$|AGENTS\.md$|(docs|\.claude)/.*\.md$|scripts/.*\.sh$|docs/agents/rules/)' ${gotchas_paths+"${gotchas_paths[@]}"}; then
  gp_rule_skip guard-registry-gate
fi

# A commit stages something the Biome gate actually reads: a file in one of the
# languages Biome parses, outside biome.json's `includes` exclusions. A commit of
# nothing but Markdown, or nothing but docs/, gives that gate no work and earns
# no rule.
#
# The extension list and the exclusions MIRROR biome.json rather than reading it
# — a hook must not parse config to decide whether to say something, and being
# wrong here costs a rule that did or did not need saying, never a wrong verdict.
# An EMPTY path list also skips: nothing was read, so nothing is asserted.
gotchas_biome=0
for gotchas_path in ${gotchas_paths+"${gotchas_paths[@]}"}; do
  [[ "$gotchas_path" =~ \.(js|jsx|mjs|cjs|ts|tsx|mts|cts|json|jsonc|css|graphql|gql|vue|svelte|astro|html)$ ]] || continue
  case "$gotchas_path" in
    public/* | docs/* | .claude/worktrees/* | scripts/fixtures/* | skills-lock.json) continue ;;
    .claude/settings*.json) continue ;;
  esac
  gotchas_biome=1
  break
done
((gotchas_biome)) || gp_rule_skip biome-staged-gate

# doc-map §B owns both superseded registers, and both checkers read tracked
# documents. A commit touching no docs/ path moves neither.
if ! paths_match '^docs/' ${gotchas_paths+"${gotchas_paths[@]}"}; then
  gp_rule_skip superseded-values-gate machinery-superseded
fi

gp_rule commit-pathspec commit-show-diff commit-message doc-map-precommit digest-version-drift guard-registry-gate biome-staged-gate superseded-values-gate machinery-superseded push-cadence push-cadence-landing

gp_allow
