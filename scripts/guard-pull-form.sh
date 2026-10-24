#!/usr/bin/env bash
# PreToolUse guard: divergence on the shared `main` is reconciled by
# fast-forward or not at all, and `main` is never moved backwards (#765).
#
# Why: the working tree is repo-global, so a `git pull`, `git merge` or
# `git rebase` that does anything but fast-forward rewrites or re-parents
# commits every parallel session can already be holding.
# On mantahostels#245 a `git pull --rebase` rebased and re-picked a
# commit in the shared tree — the same failure as mantahostels#63 (one session's roadmap
# correction landing inside another's commit) and mantahostels#87 (the wrong-branch
# commit) — incidents struck while each was worked; their titles name other work —
# reached through the one shared resource those two guards do not cover: the
# ref. `--ff-only` is the only spelling that cannot rewrite a neighbour's
# commit.
#
# DENY, not warn. mantahostels#103 set the rule for both Bash guards: deny on a structured
# fact where the action has no legitimate use, warn where the hook is inferring.
# The flag is read off the command, and every legitimate reconciliation has a
# route that passes — `--ff-only`, a repo configured `pull.ff=only`, or, for a
# divergence that needs a real merge, the throwaway worktree the rule's own
# recipe gives (#290) — so a deny cannot wedge ordinary work.
#
# LIMITS
#  - The rule it prints is docs/agents/rules/pull-fast-forward.txt, not text of
#    its own (mantahostels#1648). It prints it TWICE OVER, on two exclusive limbs (spec
#    mantahostels#1762): inside the refusal below, and — where nothing was refused, through
#    gp_rule at the foot of this file — before an allowed `git pull --ff-only`,
#    a bare pull the repo's `pull.ff=only` has already made safe, or, since
#    #301, a bare pull whose tree could not be resolved (#308). gp_rule
#    latches per session, so it is said once. `git pull --help` is handed
#    nothing; it reconciles nothing.
#  - It guards `git pull`, `git merge` and `git rebase`. `git fetch` is always
#    safe — it moves no local ref. The rewrite reached directly after a fetch,
#    as `git merge origin/main` or `git rebase origin/main`, is denied
#    (mantahostels#245, #290): a diverged session reconciles in a throwaway
#    worktree and fast-forwards the shared tree onto the result, which is
#    the route the deny names.
#  - It also refuses REWINDING `main` (#765), a second rule with its own
#    fragment, docs/agents/rules/main-rewind.txt: a `git reset` naming a
#    commit other than HEAD in the shared tree, and — from ANY tree of the
#    repo, `main` being one ref for all of them — `git update-ref
#    refs/heads/main`, `git branch` forcing, deleting, renaming or copying
#    onto `main`, and `git checkout -B main`/`git switch -C main`. A reset
#    FORWARD is refused too: the guard never compares the commit with `main`,
#    and the refusal names `git merge --ff-only` for that case. `git branch
#    -f`/`-D`/`-M` and `checkout -B` naming `main` are refused by git itself
#    while any tree has it checked out, so in a linked worktree a branch word
#    it cannot read passes on those — unless `--ignore-other-worktrees` lifts
#    git's own refusal. `git update-ref HEAD` is refused in the shared tree
#    only, and `--stdin` everywhere, because what it updates is unread.
#    Pathspec resets pass, as does a `git reset --soft` or `--mixed` naming
#    HEAD or nothing: they move no branch. Still unseen: `git fetch
#    --update-head-ok . +<commit>:main`, `git symbolic-ref`, `git cherry-pick`
#    and `git am` (which add commits rather than drop them), and `git revert`,
#    which the pre-commit stack gates. Any other unreadable commit, ref or
#    branch word, or an unresolved tree where the verdict needs one, FAILS
#    CLOSED, as a merge does (#301).
#  - It also refuses DISCARDING the shared tree's uncommitted work (#768), a
#    third rule, docs/agents/rules/shared-tree-discard.txt: in the shared tree
#    only, a `git reset --hard`/`--merge`/`--keep` naming HEAD, the checked-out
#    branch or nothing; a `git checkout` or `git restore` whose pathspec covers
#    the whole tree, or is file-fed; a forced `git clean` naming no path or the
#    whole tree, or an unforced one where `clean.requireForce` is false or
#    `-i` is spelled; a `git stash` push or save naming no path or the whole
#    tree; and a forced `git checkout`/`git switch` onto a branch. A pathspec
#    covers the whole tree when it resolves to the root or above — `.` from
#    the top, `..` from a subdirectory, `:/`, `:`, `:(top)`, `*`, `**/*.md` —
#    or is excludes alone; a bare `-p` covers it too. A glob after a partial
#    name (`src/a*`) and a directory short of the root pass, though each can
#    discard a neighbour's edits under it. `git restore --staged` without
#    `--worktree` writes only the index, and passes. `git reset --keep`
#    naming HEAD discards nothing (measured on git 2.43.0) and is refused
#    anyway: `git reset` does the same thing. A word before `--` it cannot
#    read, or an unresolved tree under a whole-tree form, FAILS CLOSED; a
#    named path passes in any tree. `git -c clean.requireForce=false clean`
#    passes, the parser consuming the `-c` as it does `pull.ff`'s below.
#  - What passes on the two direct subcommands: `git merge --ff-only`, which is
#    the worktree recipe's own last step, and `--abort`, `--continue`, `--quit`,
#    `--skip`, `--edit-todo` and `--show-current-patch` on either, which finish
#    or unwind something already under way rather than starting a
#    reconciliation. Refusing those would strand a tree mid-merge with no way
#    out. A rebase has no fast-forward-only spelling, so `--ff-only` excuses
#    nothing there, and `pull.ff=only` is not consulted for either: it governs
#    `git pull` alone, and `git merge origin/main` under it merges exactly as it
#    does without it.
#  - A bundled `-r` IS read, via the shared flag reader below. It has to be:
#    `pull.ff=only` does not stop an explicit `--rebase` — measured on git
#    2.43.0, where it rebased and rewrote the local commit — so a `git pull -qr`
#    in a repo carrying that config would take the config exception and rewrite
#    the shared tree. `pull.ff=only` does beat a configured `pull.rebase=true`,
#    which is what makes the exception sound for a bare pull.
#  - `git pull --ff-only -s -r` is ALLOWED, where the hand-rolled walk this
#    guard used before mantahostels#477 denied it. (Without the `--ff-only` it is denied
#    either way, as a bare pull.) The shared reader gives a value-taking short option
#    the next word even when that word begins with `-`, which is what git itself
#    does: `git merge -s -r` answers "Could not find merge strategy '-r'"
#    (measured on git 2.43.0). So the `-r` there is a strategy name, git refuses
#    the command, and nothing is rebased — the old deny was the wrong verdict.
#  - `git -c pull.ff=only pull` is denied, a false deny: the parser consumes
#    git's global `-c` before this guard sees the arguments, so the probe reads
#    repo config only and cannot see the override. Left alone — spelling
#    `--ff-only` is shorter than the form that trips it.
#  - It matches the *parsed command form* — a segment whose first word is `git`
#    and whose subcommand is one of the three — never a substring, so a grep, an
#    echo or a heredoc mentioning `git pull` passes. Quoted spans and heredoc
#    bodies are removed before parsing. The parser is shared with guard-branch.sh and
#    guard-commit-form.sh, in lib/guard-parse.sh (mantahostels#123).
#  - It FAILS OPEN on anything it cannot resolve — an unparseable git
#    invocation, a missing `jq`, or the shared parser itself being unreadable.
#    House style (mantahostels#103). Every fail-open is RECORDED (mantahostels#147) via
#    lib/guard-log.sh and reported by check-guard-errors.js under `npm run status`.
#    THE UNRESOLVED TARGET TREE IS NOT AMONG THEM FOR `merge` AND
#    `rebase` (#301). An unexpanded `-C`, or a `cd` to a path the parser cannot
#    expand, is DENIED on those two: the command reconciles wherever it lands,
#    and the shared tree is one of the candidates, so the missing fact is one
#    that cannot make the command safe. `git pull` is judged on its flags
#    alone (#308), with the ordinary refusal: `--ff-only` passes, a rebase or
#    a `--no-ff`/`--ff`/`--no-rebase`/`--rebase=false` is DENIED, and only a
#    bare pull — whose verdict hangs on the tree's `pull.ff` — keeps the
#    fail-open and its record. The recipe runs no pull through a variable, so
#    none of it is wedged. A LITERALLY empty `-C` or `cd` is not
#    this case at all: git and bash both stay in the cwd, so the parser
#    resolves it and the command is judged where it really lands.
#    The `pull.ff` config probe is the second exception, and it fails CLOSED: an
#    unreadable config withholds the exception rather than granting it.
#    A store fault is the third and it fails CLOSED too, for the
#    reason given in guard-branch.sh: the command is resolved and known bad,
#    and only the rule fragment could not be read (mantahostels#1648).
#    An unloadable lib/main-rewind.sh is the fourth, for the same reason: the
#    rewind is still refused, with neither the rule nor the file's name, and
#    no main-rewind needle counts that refusal (#1777).
#  - A pull, merge or rebase reached through a wrapper is not seen, because only
#    a segment's own first word is read — `xargs git pull`, `env` and `sudo` are
#    all silent, and so, measured directly against this guard's own probe
#    command, are
#    `timeout 5 git pull --rebase` and `sh -c "git pull --rebase"`
#    (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/hook-if-bash-matching.md §1).
#    The `if` field below does not exec the guard on either (mantahostels#2127),
#    and the walker would not see past them if it did.
#  - Wired with `if: Bash(git *)` (mantahostels#2127; best-effort:
#    docs/agents/guard-authoring.md's surface 4,
#    which fails toward running) — not exec'd unless some segment of
#    the command leads with `git`.
#  - It guards the Bash tool. A command run outside Claude Code sees no hook,
#    and there is no override: this binds agent sessions only, and an escape a
#    session can spell for itself is not a deny (mantahostels#109).

set -uo pipefail

# The shared parser (mantahostels#123). Resolved from this file's own location, because a
# hook runs with an arbitrary cwd. If it cannot be loaded the guard disarms
# itself rather than blocking every Bash call — mantahostels#103 §6's fail-open rule.
#
# The gate is ONE name, `gp_begin` — never `source`'s own exit status (mantahostels#157).
#
# lib/guard-log.sh is sourced FIRST and separately, so the one fault that
# disarms this guard entirely — the parser failing to load — is itself
# recordable (mantahostels#147).
here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  # Both libraries gone is the one fail-open nothing can record; the checker
  # probes both files' readability to close it from the other end.
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every command allowed unchecked"
  exit 0
}

# shellcheck source=scripts/lib/main-rewind.sh
source "$here/lib/main-rewind.sh" 2>/dev/null
declare -F rewind_deny >/dev/null 2>&1 || {
  declare -F gl_log >/dev/null 2>&1 &&
    gl_log "lib/main-rewind.sh did not load — a rewind of \`main\` refused without its rule"
  rewind_deny() { gp_deny "This $2: @CMD@" "$1"; }
}

gp_begin '.tool_input.command' command

# The refusal's rule where docs/agents/rules/pull-fast-forward.txt is
# unreadable; see this file's LIMITS for why that still refuses. Fire count:
# mantahostels#2140.
PULL_RULE_FALLBACK="Reconcile the shared \`main\` by fast-forward or not at all; the rule could not be read from docs/agents/rules/pull-fast-forward.txt. Read that file before doing anything else."
PULL_LANDING_RULE_FALLBACK="Reconcile the shared \`main\` with \`landing\` by fast-forward or not at all; the rule could not be read from docs/agents/rules/pull-fast-forward-landing.txt. Read that file before doing anything else."

# The tree's upstream is lib/landing-refs.js's pushed ref, where the branch
# names live alone (#2536), and with `landing` on the recipe is the fragment's
# `-landing` twin (#2409). A config fault reads off in both readers and is
# logged by gp_module_on in pull_rule_text, on the same refusal.
# Read on a refusal alone, so an allowed call reads no config.
pull_upstream() {
  local ref
  if ref="$(node "$here/lib/landing-refs.js" pushed 2>&1)"; then
    printf %s "$ref"
  elif declare -F gl_log >/dev/null 2>&1; then
    gl_log "lib/landing-refs.js did not name the pushed ref — the recipe names none" "$ref"
  fi
}
# Each id spelt whole, so check-guard-registry.js's emitter scan reads it.
pull_rule_text() {
  if gp_module_on landing; then
    gp_rule_text pull-fast-forward-landing "$PULL_LANDING_RULE_FALLBACK"
  else
    gp_rule_text pull-fast-forward "$PULL_RULE_FALLBACK"
  fi
}

# git pull's value-taking short options. The shared reader (mantahostels#477) walks a bundle
# letter by letter and lets a value-taking letter take the rest of it, so `git
# pull -qr` is -q then -r — a rebase — while the r inside `-Xtheirs` is that
# option's value and never read as one. -S and -j take a value only stuck on,
# so `git pull -j --rebase` is still a rebase (#302).
#
# The long options are deliberately NOT listed. Adding them would make the
# reader take the next word as a value, and `git pull --strategy --rebase` would
# stop being a rebase this guard can see.
PULL_VALUE_FLAGS="-s -X -S? -j? -o"

# One argument of a `git pull`, as <kind> <name> <value>. Sets $rebase,
# $ff_only, $override and $helping, all of them judge's locals — a callback runs
# inside its caller's scope.
pull_arg() {
  case "$1:$2" in
    # `git pull --help` opens documentation and touches no ref. Returning
    # non-zero stops the scan.
    flag:--help | flag:-h)
      helping=1
      return 1
      ;;
    flag:--ff-only) ff_only=1 ;;
    # These spell "not a rebase", so they leave $rebase clear and only
    # countermand a configured pull.ff=only. `--ff` and `--no-ff` also
    # countermand an earlier `--ff-only`, git taking the last of the three:
    # `git pull --ff-only --no-ff` writes a merge commit (measured, #308).
    flag:--no-rebase) override=1 ;;
    flag:--ff | flag:--no-ff)
      override=1
      ff_only=0
      ;;
    flag:--rebase | flag:-r) rebase=1 ;;
    opt:--rebase) case "$3" in
      false | no | 0) override=1 ;;
      *) rebase=1 ;;
    esac ;;
  esac
  return 0
}

# One argument of a `git merge` or `git rebase`, same contract as pull_arg.
# Sets $ff_only, $resuming and $helping.
direct_arg() {
  case "$1:$2" in
    flag:--help | flag:-h)
      helping=1
      return 1
      ;;
    # A merge that can only fast-forward moves the shared `main` the one way
    # the rule allows — it is the recipe's own last step. `--ff` and `--no-ff`
    # countermand it, and git takes the LAST of them, which is what the scan
    # order here reproduces: `git merge --ff-only --no-ff` writes a real merge
    # commit and is refused.
    flag:--ff-only) ff_only=1 ;;
    flag:--ff | flag:--no-ff) ff_only=0 ;;
    # Finishing or unwinding something already under way — LIMITS says why.
    flag:--abort | flag:--continue | flag:--quit | flag:--skip | \
      flag:--edit-todo | flag:--show-current-patch) resuming=1 ;;
  esac
  return 0
}

# Called once per `git pull`, `git merge` or `git rebase` running against the
# shared working tree — or against a tree the parser could not resolve, which
# arrives here with $target_dir EMPTY rather than being skipped (#301).
# Another repo, a linked worktree and every other subcommand were filtered out
# by gp_walk_shared_git_strict, which also recorded the fail-opens among them
# (mantahostels#147). The unresolved tree's own record is this function's, below.
judge() {
  # shellcheck disable=SC2034  # sub binds $2 positionally so target_dir binds $3
  local segment="$1" sub="$2" target_dir="$3"
  shift 3
  local ff_only rebase override helping resuming reason ff_config

  ff_only=0  # --ff-only was spelled on the command
  rebase=0   # --rebase / -r: rewrites commits outright
  override=0 # a flag that countermands a configured pull.ff=only
  helping=0  # --help: documentation, not a reconciliation
  resuming=0 # --abort / --continue and friends: no new reconciliation

  if [[ "$sub" == pull ]]; then
    gp_scan_flags "$PULL_VALUE_FLAGS" pull_arg -- "$@"
  else
    gp_scan_flags "$(gp_git_value_flags "$sub")" direct_arg -- "$@"
  fi
  ((helping)) && return 0
  # Only direct_arg ever sets this: a merge or rebase being finished or unwound
  # starts no reconciliation.
  ((resuming)) && return 0
  # Every other spelling reconciles the shared `main`, so it is the rule's
  # subject whether it is refused below or allowed.
  rule_subject=1

  # An unresolved target tree (#301). gp_walk_shared_git_strict hands it here
  # with $target_dir empty instead of logging and skipping, so the split below
  # is this guard's to make — and with it the fail-open record, which is
  # written for a bare pull alone. `merge --ff-only`, the --abort/--continue
  # family and `pull --ff-only` are JUDGED allows rather than fail-opens, so
  # they are deliberately unrecorded.
  if [[ -z "$target_dir" ]]; then
    # A merge that can only fast-forward rewrites nothing wherever it lands, so
    # the unknown tree does not matter.
    [[ "$sub" == merge ]] && ((ff_only)) && return 0
    # Only a bare pull's verdict hangs on the tree — the pull.ff probe below —
    # so only it keeps the fail-open. Every other pull falls through to be
    # judged on its flags, which never read $target_dir (#308).
    if [[ "$sub" == pull ]]; then
      if ((!rebase && !ff_only && !override)); then
        gl_log "could not resolve the working tree for a git pull — the reconciliation allowed unchecked"
        return 0
      fi
    else
      # merge and rebase fail CLOSED, as the pull.ff probe below already does.
      IFS= read -r -d '' reason <<EOF || :
I cannot tell which working tree this \`git $sub\` lands in — an empty or
unexpanded \`-C\`, or a \`cd\` to a path I cannot resolve: @CMD@

An unset variable there is not a different tree — it expands to nothing, and
both \`git -C ""\` and \`cd ""\` stay in the current directory.

Spell the worktree as a LITERAL path in a plain \`cd\` or \`-C\` in the same
command — \`git -C .claude/worktrees/reconcile merge $(pull_upstream)\` — or assign
it literally in the same Bash call, as the recipe below does. A \`pushd\`, a
\`cd -P\` or a \`builtin cd\` is unreadable here whatever path it carries.

$(pull_rule_text)
EOF
      gp_deny "$reason" "$segment"
    fi
  fi

  if [[ "$sub" == pull ]]; then
    ((rebase)) || {
      ((ff_only)) && return 0
      # A repo configured `pull.ff=only` makes a bare `git pull` fast-forward-only
      # already, so denying it would be denying the safe thing for its spelling.
      if ((!override)); then
        ff_config="$(git -C "$target_dir" config --get pull.ff 2>/dev/null)" || ff_config=""
        [[ "$ff_config" == "only" ]] && return 0
      fi
    }
  else
    # merge and rebase, reached directly rather than through a pull (#290). Only
    # `merge --ff-only` passes; LIMITS says why `pull.ff=only` is not consulted.
    [[ "$sub" == merge ]] && ((ff_only)) && return 0
  fi

  # The envelope is gp_deny's (mantahostels#138) and the rule is the store's (mantahostels#1648); only
  # the framing line below is this guard's. @CMD@ is
  # where gp_deny splices the segment in, rendered for a human — it still
  # carries the quoted-span sentinel byte at this point.
  IFS= read -r -d '' reason <<EOF || :
This reconciles the shared \`main\` by rewriting or merging, not by fast-forward: @CMD@

$(pull_rule_text)
EOF
  gp_deny "$reason" "$segment"
}

# ── REWINDING `main` (#765) ─────────────────────────────────────────────────
# Every refusal below is lib/main-rewind.sh's rewind_deny.

# One argument of a `git reset`. Sets judge_reset's $helping, $pathspec, $ddash,
# $discarding and $positional.
reset_arg() {
  case "$1:$2" in
    flag:--help | flag:-h)
      helping=1
      return 1
      ;;
    # git takes the last mode spelled.
    flag:--hard | flag:--merge | flag:--keep) discarding=1 ;;
    flag:--soft | flag:--mixed) discarding=0 ;;
    # Interactive or file-fed paths: an unstage whatever commit it names.
    flag:-p | flag:--patch | opt:--pathspec-from-file) pathspec=1 ;;
    flag:--) ddash=1 ;;
    # A word after `--` is a path.
    arg:*) if ((ddash)); then pathspec=1; else positional+=("$3"); fi ;;
  esac
  return 0
}

# A `git reset` in the shared tree — or an unresolved one, $target_dir empty.
# It moves the branch the tree has checked out, which here is `main`, to the
# ONE commit it names; a reset with paths only unstages them. `git reset HEAD~1
# --`, a commit with no paths after the `--`, moves the branch (measured).
judge_reset() {
  local segment="$1" target_dir="$3"
  shift 3
  local helping=0 pathspec=0 ddash=0 discarding=0 commit branch
  local -a positional=()

  gp_scan_flags "--pathspec-from-file" reset_arg -- "$@"
  # git refuses `--hard`, `--merge` and `--keep` with paths.
  ((helping || pathspec)) && return 0
  # None names HEAD, which moves no branch but can still discard; two or more
  # are a tree-ish and paths.
  ((${#positional[@]})) || {
    ((discarding)) && reset_discard_deny "$segment"
    return 0
  }
  if ((${#positional[@]} > 1)); then
    # A word I cannot read could be `--hard`.
    for commit in "${positional[@]}"; do
      gp_literal "$commit" >/dev/null || reset_discard_deny "$segment"
    done
    return 0
  fi

  commit="$(gp_literal "${positional[0]}")" ||
    rewind_deny "$segment" "resets the shared tree to a commit I cannot read — spell it literally, or use \`git reset -- <path>\` to unstage"
  case "$commit" in HEAD | @)
    ((discarding)) && reset_discard_deny "$segment"
    return 0
    ;;
  esac
  if [[ -n "$target_dir" ]]; then
    branch="$(git -C "$target_dir" symbolic-ref --quiet --short HEAD 2>/dev/null)" || branch=""
    if [[ -n "$branch" && ("$commit" == "$branch" || "$commit" == "refs/heads/$branch") ]]; then
      ((discarding)) && reset_discard_deny "$segment"
      return 0
    fi
    # No `--` and no such commit: git reads the word as a path.
    ((ddash)) || git -C "$target_dir" rev-parse --verify --quiet "$commit^{commit}" >/dev/null 2>&1 ||
      return 0
  fi
  rewind_deny "$segment" "moves the shared \`main\` to another commit, dropping whatever came after it if that commit is behind — to move \`main\` forward, \`git merge --ff-only <commit>\`"
}

# The value-taking options of `git checkout` and `git switch`, read by both the
# rewind and the discard judges; one left out makes its value read as a branch
# or a path.
CHECKOUT_VALUE_FLAGS="-b -B --orphan --conflict --pathspec-from-file"
SWITCH_VALUE_FLAGS="-c -C --create --force-create --orphan --conflict"

# One argument of a `git branch`, `git update-ref`, `git checkout` or `git
# switch`. Sets judge_ref's $helping, $force, $mode, $stdin, $created and
# $positional.
ref_arg() {
  case "$1:$2" in
    flag:--help | flag:-h)
      helping=1
      return 1
      ;;
    flag:-f | flag:--force) force=1 ;;
    flag:-d | flag:--delete) mode=delete ;;
    flag:-D) mode=delete force=1 ;;
    flag:-m | flag:--move) mode=move ;;
    flag:-M) mode=move force=1 ;;
    # `-c`/`-C` copy under `git branch` and create under `git switch`, whose
    # force form is caught as an opt below.
    flag:-c | flag:--copy) mode=copy ;;
    flag:-C) mode=copy force=1 ;;
    flag:--stdin) stdin=1 ;;
    flag:--ignore-other-worktrees) ignore_other=1 ;;
    opt:-B | opt:--force-create | opt:-C) created+=("$3") ;;
    arg:*) positional+=("$3") ;;
  esac
  return 0
}

# ref_is <word> <name>… — is the word, read literally, one of the names? An
# unreadable word answers $unread_verdict: 0 (yes, it could be) unless
# judge_ref has found git itself refuses the name wherever it is unreadable.
ref_is() {
  local word name
  word="$(gp_literal "$1")" || return "$unread_verdict"
  shift
  for name in "$@"; do
    [[ "$word" == "$name" ]] && return 0
  done
  return 1
}

# A `git branch`, `git update-ref`, `git checkout` or `git switch` in ANY tree
# of this repo, or an unresolved one.
judge_ref() {
  local segment="$1" sub="$2" target_dir="$3"
  shift 3
  local helping=0 force=0 stdin=0 ignore_other=0 mode="" scope word spec
  local unread_verdict=0
  local -a positional=() created=()

  scope="$(gp_tree_scope "$target_dir")"
  case "$sub" in
    branch) spec="-u --set-upstream-to --contains --no-contains --merged --no-merged --points-at --format --sort" ;;
    update-ref) spec="-m" ;;
    checkout) spec="$CHECKOUT_VALUE_FLAGS" ;;
    switch) spec="$SWITCH_VALUE_FLAGS" ;;
  esac
  gp_scan_flags "$spec" ref_arg -- "$@"
  ((helping)) && return 0
  # A branch word in a linked worktree may be read as not-`main`: git refuses
  # to force, delete or recreate `main` while the shared tree has it out.
  [[ "$scope" == linked && "$sub" != update-ref ]] && ((!ignore_other)) &&
    unread_verdict=1

  case "$sub" in
    update-ref)
      ((stdin)) && rewind_deny "$segment" "updates refs from a list I cannot read, \`main\` possibly among them"
      ((${#positional[@]})) || return 0
      ref_is "${positional[0]}" refs/heads/main &&
        rewind_deny "$segment" "writes \`main\` directly, dropping whatever came after the commit it names"
      # HEAD is `main` only where `main` is checked out.
      [[ "$scope" == linked ]] && return 0
      ref_is "${positional[0]}" HEAD &&
        rewind_deny "$segment" "writes the shared tree's HEAD, and so \`main\`, directly"
      ;;
    branch)
      case "$mode" in
        delete)
          for word in ${positional+"${positional[@]}"}; do
            ref_is "$word" main && rewind_deny "$segment" "deletes \`main\`"
          done
          ;;
        move)
          # A rename or copy ONTO `main` replaces it.
          ((${#positional[@]})) && ref_is "${positional[-1]}" main &&
            rewind_deny "$segment" "replaces \`main\` with another branch"
          # `-m <old> <new>` renames `main` away; `-m <new>` renames the tree's
          # own branch, which in the shared tree is `main`.
          if ((${#positional[@]} >= 2)); then
            ref_is "${positional[0]}" main && rewind_deny "$segment" "renames \`main\` away"
          elif [[ "$scope" != linked ]]; then
            rewind_deny "$segment" "renames the shared tree's branch, \`main\`, away"
          fi
          ;;
        copy)
          ((${#positional[@]})) && ref_is "${positional[-1]}" main &&
            rewind_deny "$segment" "replaces \`main\` with a copy of another branch"
          ;;
        *)
          ((force)) && ((${#positional[@]})) && ref_is "${positional[0]}" main &&
            rewind_deny "$segment" "forces \`main\` to another commit, dropping whatever came after it"
          ;;
      esac
      ;;
    checkout | switch)
      for word in ${created+"${created[@]}"}; do
        ref_is "$word" main &&
          rewind_deny "$segment" "recreates \`main\` at another commit, dropping whatever came after it"
      done
      ;;
  esac
  return 0
}

# ── DISCARDING THE SHARED TREE'S UNCOMMITTED WORK (#768) ────────────────────
DISCARD_RULE_FALLBACK="Never discard work across the whole shared tree; the rule could not be read from docs/agents/rules/shared-tree-discard.txt. Read that file before doing anything else."

# discard_deny <segment> <what the command does, completing "This …">
# <the safe per-path form>
discard_deny() {
  local reason
  IFS= read -r -d '' reason <<EOF || :
This $2: @CMD@

Name your own paths instead — \`$3\`.

$(gp_rule_text shared-tree-discard "$DISCARD_RULE_FALLBACK")
EOF
  gp_deny "$reason" "$1"
}

reset_discard_deny() {
  discard_deny "$1" "resets every working file in the shared tree to HEAD" "git restore --staged --worktree -- <your paths>"
}

# covers_tree <word> — does this one pathspec name the whole working tree? 0
# yes, 1 no, 2 an exclude, which names nothing on its own. Reads the caller's
# $top and $prefix, both empty where the tree is unknown — which reads the cwd
# as the root, so only a word staying below its own directory passes. An
# unreadable word is a yes: it could be `.`.
covers_tree() {
  local w rel="$prefix" magic n
  w="$(gp_literal "$1")" || return 0
  # Pathspec magic, long or short: `top` or `/` anchors at the root.
  if [[ "$w" == ':('*')'* ]]; then
    magic="${w%%)*}"
    w="${w#*)}"
    [[ "$magic" == *exclude* ]] && return 2
    [[ "$magic" == *top* ]] && rel=""
  elif [[ "$w" == :* ]]; then
    w="${w#:}"
    while [[ "$w" == [/!^]* ]]; do
      [[ "$w" == /* ]] || return 2
      rel=""
      w="${w:1}"
    done
    w="${w#:}"
  fi
  # A glob starting a path component reaches everything under the directory
  # before it; one after a partial name matches only that name's paths.
  if [[ "$w" == *[*?[]* ]]; then
    w="${w%%[*?[]*}"
    case "$w" in
      '') ;;
      */) w="${w%/}" ;;
      *) return 1 ;;
    esac
  fi
  [[ -n "$w" ]] || w=.
  if [[ "$w" == /* ]]; then
    [[ -n "$top" ]] || return 0
    n="$(gp_norm_abs "$w")"
    [[ "$top/" == "${n%/}/"* ]]
    return
  fi
  # git's own prefix, not a path compare, so a symlinked spelling of the root
  # still reads as the root.
  n="$(gp_norm_abs "/q/$rel$w")"
  [[ "$n" != /q/* ]]
}

# paths_cover_tree <word>... — does this pathspec list name the whole tree?
# Any one word naming it does, and so does a list of excludes alone, which git
# reads as everything but them.
paths_cover_tree() {
  local w positive=0 rc
  (($#)) || return 1
  for w in "$@"; do
    covers_tree "$w"
    rc=$?
    ((rc == 0)) && return 0
    ((rc == 1)) && positive=1
  done
  ((!positive))
}

# One argument of a `git checkout`, `git switch`, `git restore`, `git clean` or
# `git stash push`. Sets judge_discard's $helping, $fromfile, $force, $dryrun,
# $patch, $staged, $worktree, $ddash, $pre and $post.
discard_arg() {
  case "$1:$2" in
    flag:--help | flag:-h)
      helping=1
      return 1
      ;;
    opt:--pathspec-from-file | dangling:--pathspec-from-file) fromfile=1 ;;
    # `git clean -i` deletes without `-f`.
    flag:-f | flag:--force | flag:--discard-changes | flag:-i | flag:--interactive) force=1 ;;
    flag:-n | flag:--dry-run) dryrun=1 ;;
    flag:-p | flag:--patch) patch=1 ;;
    flag:-S | flag:--staged) staged=1 ;;
    flag:-W | flag:--worktree) worktree=1 ;;
    flag:--) ddash=1 ;;
    arg:*) if ((ddash)); then post+=("$3"); else pre+=("$3"); fi ;;
  esac
  return 0
}

# A `git checkout`, `git switch`, `git restore`, `git clean` or `git stash` in
# the shared tree — or an unresolved one, $target_dir empty. Each can write
# every working file at once; judged here is whether this spelling does.
judge_discard() {
  local segment="$1" sub="$2" target_dir="$3"
  shift 3
  local helping=0 fromfile=0 force=0 dryrun=0 patch=0 staged=0 worktree=0 ddash=0
  local top="" prefix="" spec="" safe verb require word
  local -a pre=() post=() paths=()

  if [[ -n "$target_dir" ]]; then
    top="$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null)" || top=""
    prefix="$(git -C "$target_dir" rev-parse --show-prefix 2>/dev/null)" || prefix=""
  fi
  case "$sub" in
    checkout) safe="git checkout -- <your paths>" spec="$CHECKOUT_VALUE_FLAGS" ;;
    switch) safe="git restore -- <your paths>" spec="$SWITCH_VALUE_FLAGS" ;;
    restore) safe="git restore -- <your paths>" spec="-s --source --conflict --pathspec-from-file" ;;
    clean) safe="git clean -f -- <your paths>" spec="-e --exclude" ;;
    stash) safe="git stash push -- <your paths>" spec="-m --message --pathspec-from-file" ;;
  esac

  if [[ "$sub" == stash ]]; then
    # A first word that is no option names the stash command; none is a push.
    verb=push
    if (($#)) && [[ "$1" != -* ]]; then
      verb="$(gp_literal "$1")" ||
        discard_deny "$segment" "runs a stash command I cannot read, which could stash every edit in the shared tree" "$safe"
      shift
    fi
    case "$verb" in
      push) ;;
      save)
        gp_scan_flags "-m --message" discard_arg -- "$@"
        ((helping)) && return 0
        discard_deny "$segment" "stashes every uncommitted edit in the shared tree" "$safe"
        ;;
      *) return 0 ;;
    esac
  fi
  gp_scan_flags "$spec" discard_arg -- "$@"
  ((helping)) && return 0

  # Before a `--`, a word I cannot read could be `-f`, `-W` or `.` alike.
  for word in ${pre+"${pre[@]}"}; do
    gp_literal "$word" >/dev/null ||
      discard_deny "$segment" "carries a word I cannot read, which could be an option or pathspec that discards every edit in the shared tree" "$safe"
  done

  case "$sub" in
    checkout)
      # The first word is a tree-ish before a `--`, and without one where it
      # names a tree — as git decides. It is never a whole-tree word.
      paths=(${pre+"${pre[@]}"})
      if ((${#pre[@]})); then
        covers_tree "${pre[0]}"
        if (($? == 1)) && { ((ddash)) || [[ -z "$target_dir" ]] ||
          git -C "$target_dir" rev-parse --verify --quiet "$(gp_literal "${pre[0]}")^{tree}" >/dev/null 2>&1; }; then
          paths=("${pre[@]:1}")
        fi
      fi
      paths+=(${post+"${post[@]}"})
      if ((fromfile)) || { ((patch)) && ((!${#paths[@]})); } || paths_cover_tree ${paths+"${paths[@]}"}; then
        discard_deny "$segment" "overwrites every working file in the shared tree" "$safe"
      fi
      # A forced switch resets every working file to the branch.
      ((force && !${#paths[@]})) &&
        discard_deny "$segment" "forces the shared tree onto a branch, dropping every uncommitted edit" "git restore -- <your paths>"
      ;;
    switch)
      ((force)) &&
        discard_deny "$segment" "forces the shared tree onto a branch, dropping every uncommitted edit" "$safe"
      ;;
    restore)
      ((staged && !worktree)) && return 0
      paths=(${pre+"${pre[@]}"} ${post+"${post[@]}"})
      if ((fromfile)) || { ((patch)) && ((!${#paths[@]})); } || paths_cover_tree ${paths+"${paths[@]}"}; then
        discard_deny "$segment" "overwrites every working file in the shared tree" "$safe"
      fi
      ;;
    clean)
      ((dryrun)) && return 0
      # clean.requireForce=false deletes unforced; an unknown tree's config is
      # unreadable, so it counts as forced.
      if ((!force)) && [[ -n "$target_dir" ]]; then
        require="$(git -C "$target_dir" config --type=bool --get clean.requireForce 2>/dev/null)" || require=""
        [[ "$require" == false ]] && force=1
      elif [[ -z "$target_dir" ]]; then
        force=1
      fi
      ((force)) || return 0
      # With no path it cleans the directory it runs in.
      paths=(${pre+"${pre[@]}"} ${post+"${post[@]}"})
      ((${#paths[@]})) || paths=(.)
      paths_cover_tree "${paths[@]}" &&
        discard_deny "$segment" "deletes every untracked file in the shared tree" "$safe"
      ;;
    stash)
      paths=(${pre+"${pre[@]}"} ${post+"${post[@]}"})
      if ((fromfile || !${#paths[@]})) || paths_cover_tree ${paths+"${paths[@]}"}; then
        discard_deny "$segment" "stashes every uncommitted edit in the shared tree" "$safe"
      fi
      ;;
  esac
  return 0
}

gp_walk_shared_git_strict judge_reset "the reset" reset
gp_walk_repo_git_strict judge_ref "the ref write" branch update-ref checkout switch
gp_walk_shared_git_strict judge_discard "the discard" checkout switch restore clean stash

# Not local; see judge.
rule_subject=0

# The STRICT walk (#301): judge takes the unresolved-tree case rather than the
# walker logging and skipping it, and keeps the fail-open — and the record —
# for a bare pull alone (#308).
gp_walk_shared_git_strict judge "the reconciliation" pull merge rebase

# PRE-EMPTIVE INJECTION (mantahostels#1648, spec mantahostels#1762) — the second limb this file's LIMITS
# describe. It emits additionalContext and never a permissionDecision, so an
# allow stays an allow.
((rule_subject)) || gp_allow
gp_rule_module landing pull-fast-forward-landing
gp_rule_unless_module landing pull-fast-forward
gp_rule pull-fast-forward pull-fast-forward-landing

gp_allow
