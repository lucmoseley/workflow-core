#!/usr/bin/env bash
# PreToolUse guard: the shared working tree stays on `main`.
#
# Why: the working tree is repo-global, so a `git checkout` in one session moves
# every parallel session's branch at once. On mantahostels#87 (an incident struck while it
# was worked, recorded on mantahostels#100 — its title names other work) a commit landed on
# `manual-sync-2026-08-03` because a parallel run switched the tree mid-session,
# and the gates that ran afterwards silently read the other branch's files.
# mantahostels#100 answered that by pinning the shared tree to `main`: work that needs a
# branch does it in a throwaway worktree (`git worktree add`).
#
# DENY, not warn. mantahostels#103 set the rule for both Bash guards: deny on a structured
# fact where the action has no legitimate use, warn where the hook is inferring.
# A shared-tree branch move has one legitimate use and no more — `git checkout
# main`, the repair, handled below — so a deny cannot wedge ordinary work.
#
# LIMITS
#  - It also refuses `git worktree add` carrying neither `-b`/`-B` nor
#    `--detach` (mantahostels#1648) — the route a session takes to a worktree WITHOUT first
#    running a branch move, so the recipe below reached nobody on it. `-b`,
#    `--detach` and every other worktree verb stay allowed. It DELIBERATELY
#    over-fires: only `add <path> <branch checked out elsewhere>` actually
#    fails, and the two shapes below succeed and are refused anyway, because
#    the guard cannot tell which of the three it is holding without resolving
#    the commit-ish against every worktree's HEAD. Measured on git 2.43.0:
#      git worktree add <path>          exit 0 — DWIMs a branch off the basename
#      git worktree add <path> HEAD     exit 0 — detached
#      git worktree add <path> main     exit 128 — main is checked out here
#    The first is refused for the surprise branch name and the second for
#    spelling detachment in a way the recipe does not; mantahostels#301 measured only the
#    third. Both are false denies against git, not against the house rule.
#  - Walking `worktree` widens the fail-open record, and this is undeclared
#    nowhere else: gp_walk_shared_git logs an unresolvable tree under the noun
#    it was given ("branch move") for EVERY worktree verb, `list` and `prune`
#    included, though the guard judges only `add`. lib/guard-parse.sh warns
#    against exactly that — "logging it would bury the ones that matter" — and
#    the noun is per-walk, not per-subcommand, so splitting it needs a second
#    walk this ticket did not buy.
#  - The rule it prints is docs/agents/rules/branch-shared-tree.txt, not text of
#    its own (mantahostels#1648). It prints it TWICE OVER, on two exclusive limbs (mantahostels#1647,
#    which holds why the refusal alone could not reach R3): inside the refusal
#    above, and — on the clean branch, through gp_rule at the foot of this file
#    — before an allowed `git worktree add -b/--detach/--orphan` or `git
#    checkout main`. gp_rule latches per session, so it is said once. Every
#    other `worktree` verb, and every file restore, is handed nothing — they
#    move no branch.
#  - It matches the *parsed command form* — a segment whose first word is `git`
#    and whose subcommand is `checkout`/`switch`/`worktree` — never a substring,
#    so a grep, an echo or a heredoc mentioning `git checkout` passes. Quoted spans and
#    heredoc bodies are removed before parsing. A multi-line `git commit -m`
#    message is kept joined to its command (mantahostels#232), so the message is
#    one argument rather than lines of prose read as commands. False positives
#    remain: a command with an
#    escaped quote inside a double-quoted string can still mis-split, and mantahostels#232
#    measured a residual 6 denials per 144 generated commit payloads that run no
#    branch move. The parser is shared with guard-commit-form.sh, in
#    lib/guard-parse.sh (mantahostels#123).
#  - It FAILS OPEN. Anything it cannot resolve — a `$(…)` or `${VAR:-x}` in a
#    `cd` or `git -C` target, a git invocation it cannot parse, a missing `jq`, or the
#    shared parser itself being unreadable — is allowed through. House style
#    (mantahostels#103), and defensible here only because the `.husky/pre-commit` branch
#    assertion is a second layer that inspects state rather than a command string
#    and so has nothing to fail open on. Every fail-open is RECORDED (mantahostels#147) via
#    lib/guard-log.sh, and reported by check-guard-errors.js under `npm run status`.
#    A store fault is the one exception, and it fails CLOSED: a refusal whose
#    rule fragment cannot be read still refuses, naming the fragment, because
#    the COMMAND was resolved and only the rule was not (mantahostels#1648).
#  - An UNSET variable in that target is read as empty (workflow-core#310, landed workflow-core#325): shell
#    state does not carry between Bash calls, so `cd "$W"` with `W` from an
#    earlier call is `cd ""`, the cwd, and is judged there. Only where every `$`
#    is a bare name the command neither assigns elsewhere nor carries a `||`,
#    `source`, `.` or `eval` around; the hook's environment decides "unset",
#    and a name the Bash tool's shell holds unexported is unset here too — a
#    false deny if it happens, measured only lexically (lib/guard-parse.sh's
#    _gp_provably_empty). A `$(…)` target keeps the logged fail-open above (workflow-core#310).
#  - A branch move reached through a wrapper is not seen, because only a
#    segment's own first word is read — `xargs git checkout -b`, `env` and
#    `sudo` are all silent, and so, measured directly against this guard's
#    own probe command, are `timeout 5 git checkout -q some-other-branch` and
#    `sh -c "git checkout -q some-other-branch"`
#    (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/hook-if-bash-matching.md §1).
#    The `if` field below does not exec the guard on either (mantahostels#2127),
#    and the walker would not see past them if it did.
#  - Wired with `if: Bash(git *)` (mantahostels#2127; best-effort:
#    docs/agents/guard-authoring.md's surface 4,
#    which fails toward running) — not exec'd unless some segment of
#    the command leads with `git`.
#  - It guards the Bash tool. A command run outside Claude Code sees no hook at
#    all, which is also why there is no override here: unlike the pre-commit
#    block, this binds agent sessions only, and an escape a session can spell
#    for itself is not a deny (mantahostels#109 ruled the same for its own guard).

set -uo pipefail

# The shared parser (mantahostels#123). Resolved from this file's own location, because a
# hook runs with an arbitrary cwd. If it cannot be loaded the guard disarms
# itself rather than blocking every Bash call — mantahostels#103 §6's fail-open rule, which
# now has to cover the library's absence as well as an unparseable command.
#
# The gate is ONE name, `gp_begin` — never `source`'s own exit status. Why that
# is enough is on gp_begin in lib/guard-parse.sh (mantahostels#157).
#
# lib/guard-log.sh is sourced FIRST and separately, so the one fault that
# disarms this guard entirely — the parser failing to load — is itself
# recordable (mantahostels#147). Sourcing them together would leave that case unloggable.
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

gp_begin '.tool_input.command' command

# The refusal's rule where its fragment is unreadable; see this file's LIMITS
# for why that still refuses and is not logged.
BRANCH_RULE_FALLBACK="The shared working tree stays on \`main\`; the rule could not be read from docs/agents/rules/branch-shared-tree.txt. Read that file before doing anything else."

# Called once per `git checkout`/`git switch`/`git worktree` running against the
# shared working tree. Another repo, a linked worktree, an unresolvable cwd and
# every other subcommand were filtered out by gp_walk_shared_git, which also
# recorded the fail-opens among them (mantahostels#147).
judge() {
  local segment="$1" sub="$2" target_dir="$3"
  shift 3
  local -a args=("$@")
  local arg p branch_move saw_ddash reason
  local -a positional

  # `git worktree` is here for ONE shape: `git worktree add` carrying neither a
  # branch to create nor `--detach`. A session that goes straight to a worktree
  # runs no branch move, so the deny below was the one place the recipe could
  # not reach it (mantahostels#1648, reviving R3 in Register II — the candidate refused
  # because this guard fired only on a checkout). The over-fire is deliberate
  # and measured in this file's LIMITS.
  #
  # Every other `git worktree` verb — list, remove, prune, move, lock, unlock,
  # repair — moves no branch and is allowed, as is `add` with `-b`/`-B`, with
  # `--detach` or with `--orphan`.
  if [[ "$sub" == "worktree" ]]; then
    [[ "${args[0]:-}" == "add" ]] || return 0
    # `--help` opens no worktree, so it is filtered in a pass of its own before
    # the rule is claimed — `list`, `remove` and the rest returned above.
    for arg in ${args+"${args[@]}"}; do
      case "$arg" in
        -h | --help) return 0 ;;
      esac
    done
    rule_subject=1
    for arg in ${args+"${args[@]}"}; do
      case "$arg" in
        # -b/-B take a value, which git accepts joined (`-bfoo`) or separate.
        -b* | -B* | --detach | --orphan) return 0 ;;
      esac
    done
    gp_unset_text unset_text
    IFS= read -r -d '' reason <<EOF || :
This opens a worktree with neither a branch of its own nor a detached HEAD: @CMD@

${unset_text}$(gp_rule_text branch-shared-tree "$BRANCH_RULE_FALLBACK")
EOF
    gp_deny "$reason" "$segment"
  fi

  # `git checkout -- <file>`, `git checkout <sha> -- <file>` and the interactive
  # `-p` form restore file content and move no branch. `git checkout <file>`
  # does too, when the argument names something that exists on disk.
  branch_move=0
  saw_ddash=0
  positional=()
  for arg in ${args+"${args[@]}"}; do
    case "$arg" in
      --) saw_ddash=1 ;;
      -p | --patch) saw_ddash=1 ;;
      # -c/-C are `git switch`'s create flags; git's own -c <k>=<v> was already
      # consumed as a global option by the parser.
      -b | -B | -c | -C | --create | --force-create | --orphan | --detach) branch_move=1 ;;
      # `-` is `@{-1}`, the previously-checked-out branch — always a branch move,
      # never a path. It must stay above the catch-all arm below, which left
      # `positional` empty so the command read as a bare `git checkout` and
      # passed (mantahostels#134). Its target is only knowable at run time, so it gets no
      # `main` exception: the repair is spelled `git checkout main`.
      -) branch_move=1 ;;
      -*) ;;
      *) ((saw_ddash)) || positional+=("$arg") ;;
    esac
  done

  # The guard protects an invariant — shared tree on main — not the absence of
  # checkouts, so the one command that RESTORES the invariant must pass. mantahostels#100
  # called a shared-tree branch move unconditionally illegitimate; that is wrong
  # for `git checkout main`, which is also the recovery this repo's pre-commit
  # failure tells you to run. Denying it would leave a session that reached a
  # branch by any other route unable to get back.
  if ((!branch_move)) && ((${#positional[@]} == 1)) && [[ "${positional[0]}" == "main" ]]; then
    # The repair is still branch work, and a session running it has just been
    # somewhere it should not have been — so it gets the rule (mantahostels#1647). The
    # pathspec restores below reach this line having returned already, and get
    # nothing: they move no branch.
    rule_subject=1
    return 0
  fi

  if [[ "$sub" == "checkout" ]] && ((!branch_move)); then
    ((saw_ddash)) && return 0
    # Bare `git checkout` reports; it moves nothing.
    ((${#positional[@]})) || return 0
    if ((${#positional[@]} == 1)); then
      p="${positional[0]}"
      # A name that is also a branch is a branch move whatever else it names:
      # given `git checkout scripts` with a branch called `scripts`, git prefers
      # the ref, so an on-disk match alone must not buy a pass.
      if ! git -C "$target_dir" rev-parse --verify --quiet "refs/heads/$p" >/dev/null 2>&1; then
        [[ "$p" == "." || -e "$target_dir/$p" || -e "$p" ]] && return 0
      fi
    fi
  fi

  # The envelope is gp_deny's (mantahostels#138) and the rule is the store's (mantahostels#1648); only
  # the framing line below is this guard's. @CMD@ is
  # where gp_deny splices the segment in, rendered for a human — it still carries
  # the quoted-span sentinel byte at this point.
  gp_unset_text unset_text
  IFS= read -r -d '' reason <<EOF || :
This moves the shared working tree off its branch: @CMD@

${unset_text}$(gp_rule_text branch-shared-tree "$BRANCH_RULE_FALLBACK")

To restore a file rather than move a branch, use the pathspec form: git checkout -- <file>, or git restore <file>.
EOF
  gp_deny "$reason" "$segment"
}

# Not local; see judge.
rule_subject=0
unset_text=""

gp_walk_shared_git --empty-unset judge "branch move" checkout switch worktree

# PRE-EMPTIVE INJECTION (mantahostels#1647, spec mantahostels#1762) — the second limb this file's LIMITS
# describe. It emits additionalContext and never a permissionDecision, so an
# allow stays an allow.
# With `landing` on, the shared tree's upstream line rides with it (workflow-core#2409).
((rule_subject)) || gp_allow
gp_rule_module landing branch-shared-tree-landing
gp_rule branch-shared-tree branch-shared-tree-landing

gp_allow
