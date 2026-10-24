#!/usr/bin/env bash
# PostToolUse recorder: every ff-only refusal and every rejected push, with the
# divergence that caused it (#289).
#
# IMPLICIT:  appends one row per refused `git pull` and per rejected `git push`
#            to a per-repo log under the Claude config directory. Records only;
#            it reaches no verdict and refuses nothing.
# JUSTIFIED: convenience — #289 holds the counts. The measurement that looked
#            like the cause sees only pushes that SUCCEEDED, and this file is
#            the population it cannot reach; until the refusals are on record,
#            any reconcile recipe (#290) is aimed at a cause nobody has
#            established.
# DEFEAT:    WFC_NO_DIVERGENCE_LOG=1 — recording stops entirely. There is no
#            partial setting.
# Overrides (test seam): WFC_PS.
#
# IT REACHES THE OTHER REPO THROUGH THE PLUGIN, and needs no install of its own:
# fantasy-books enables `workflow-core@workflow-core` in its .claude/settings.json
# and pins it by tag, and the plugin ships this whole `scripts/` directory with
# hooks/hooks.json's own registration of this file. So the second side of the
# comparison arrives with the next release the adopter's pin is moved to —
# nothing is copied by hand, and there is no second install route to drift.
#
# THE ROW, one line, tab-separated, append-only:
#
#   <ISO 8601 UTC>  <repo>  pull|push  <ahead>  <behind>  <state>  <sessions>  <ref>  <marker>
#
#   repo      the REPOSITORY's name, from the common git dir, so a linked
#             worktree is filed under the repository and not under itself
#   ahead     commits on HEAD and not on <ref>, at the moment of refusal
#   behind    commits on <ref> and not on HEAD
#   state     diverged | behind | ahead | level | unknown, read off those two
#             counts — see the `ahead` LIMIT below for what it can and cannot say
#   sessions  live Claude sessions on the machine, or `-` where unreadable
#   ref       what ahead/behind were counted against, normally the pushed ref
#   marker    the refusal string that matched, so a row can be traced to its cause
#
# WHERE IT LANDS: <first seat's config dir>/projects/<repo root, non-alphanumerics
# to dashes>, beside guard-errors.log (#383). The slug comes from lib/guard-log.sh's gl_project_dir,
# which takes the root as an argument because gl_log slugs `gr_root`, the HOOK's
# own repo, where this file needs the repo the COMMAND ran in, which a `git -C`
# makes a different one.
# One directory per repo is what makes the comparison readable:
# scripts/divergence-report.js reads several.
#
# THE ORIGIN-TRACKING REF IS READ, NEVER REFRESHED. A `git pull` has already
# fetched by the time it refuses, so its ahead/behind are current. A REJECTED
# PUSH has fetched nothing, so its `behind` is a LOWER BOUND — the true figure
# is at least that. Fetching here would be a network call on a hook, and it
# would move a ref every parallel session can be reading. The report states the
# bound; this file does not paper over it.
#
# LIMITS
#  - Wired with `if: Bash(git *)`, so it is not exec'd unless the command leads
#    with `git` — which is why the wrapper blind spot below costs nothing extra:
#    a `timeout git pull` reaches neither the narrowing nor the walk.
#  - The command's own cwd is the payload's `.cwd`. A CROSS-REPO `git -C` IS
#    FOLLOWED, because unfollowed it does not fail visibly: the row lands under
#    the SESSION's repo with that repo's counts, so a refusal elsewhere reads
#    as `level` — a state at which a fast-forward cannot be refused at all. A
#    `-C` path that does not resolve to a directory — a `~`, a `$VAR`, a quoted
#    path with a space, one holding a segment separator — drops the row rather
#    than filing it under the cwd, so a repo using those spellings is counted
#    to a LOWER BOUND. THE ROW IS THEREFORE KEYED ON THE REPO REFUSED IN, WHERE
#    #289's 20x baseline counted the SESSION's; the session's repo is not on
#    the row to tell the two apart.
#    A `cd` inside the command is not followed, and costs little: the `if:
#    Bash(git *)` narrowing means a command LEADING with one never reaches this
#    file at all, leaving only the mid-command shape.
#  - Command-position matching, as place-new-issue.sh does it: a grep, an echo
#    or a heredoc mentioning `git pull` is not a pull. A pull reached through a
#    wrapper (`xargs`, `timeout`, `sh -c`) is not seen, the same blind spot
#    guard-pull-form.sh carries.
#  - THE SEGMENT SPLIT IS NOT QUOTE-AWARE, where lib/guard-parse.sh's is: a
#    `git commit -m "a && b" && git pull` splits inside the message too. That
#    only ever manufactures extra segments to test, and a fragment of a commit
#    message is not a git call, so it costs a wasted comparison and never a
#    wrong row. lib/guard-parse.sh resolves a `-C` already and this file walks
#    its own — one copy of that class too many, which #302 is open on.
#  - It records what the Bash TOOL ran. A pull typed in a terminal sees no hook,
#    so the rate this measures is the agent-session rate, which is the rate #289
#    counted in transcripts.
#  - `ahead` IS THE TREE'S UNPUSHED COMMITS, NOT THIS SESSION'S. Every session
#    here commits to one shared `main` (docs/agents/guard-registry.md §Conventions), so `diverged`
#    means "somebody in this tree has committed" and cannot separate a session
#    refused over its OWN commits from one refused over a neighbour's. #289 asks
#    for that separation and this row does not carry it; attributing a commit to
#    a session needs the arbiter's base records, which is a second instrument.
#  - `sessions` counts `bg-pty-host` PROCESSES wearing a Claude argv[0], less
#    the daemon's unclaimed spare — the reporting unit docs/environment.md §5
#    names, counted by lib/claude-sessions.sh. Rows before 17 Oct 2026 00:54
#    UTC (#1798) count the spare too, one high. NOT the `claude agents --json`
#    oracle, which admission uses: the oracle starts a Claude process of its own
#    to answer and can block, and a hook that blocks costs every git call on the
#    machine. So it over-counts a host outliving its session and misses a
#    session driven interactively in a terminal, which spawns no host at all.
#    argv[0] and never `comm` (mantahostels#481): a backgrounded session's
#    `comm` is its version number.
#  - It never writes to stdout or stderr. A PostToolUse hook's stdout is context
#    handed to the session, and this one has nothing to say.
#  - Every fault allows, and all but one are silent: there is nothing to fail
#    closed to, since a row not written loses one observation and a hook that
#    errors on a refused pull piles a second failure on the one being studied.
#    A MISSING `jq` IS THE EXCEPTION and is logged, because it is the only fault
#    that silently produces the empty log the report calls a finding. An
#    unwritable log directory and an unresolvable toplevel are not: both are
#    visible in the row count against the other repo's.

set -uo pipefail

[[ "${WFC_NO_DIVERGENCE_LOG:-}" == "1" ]] && exit 0

# Sourced for gl_project_dir, shell's one site for the slug transform, and for
# gl_log, the shared fail-open record check-guard-errors.js reports at session
# start. REQUIRED, not optional: without gl_project_dir there is nowhere to
# write, and restating the transform here is what lib/project-slug-scan.test.ts
# refuses. A checkout that has lost the lib records nothing and says nothing —
# it is a recorder, and a silent one beats a guard that crashes.
# shellcheck source=scripts/lib/guard-log.sh
source "${BASH_SOURCE[0]%/*}/lib/guard-log.sh" 2>/dev/null
declare -F gl_project_dir >/dev/null 2>&1 || exit 0

if ! command -v jq >/dev/null 2>&1; then
  declare -F gl_log >/dev/null 2>&1 &&
    gl_log "jq not found — no pull refusal or rejected push is being recorded (#289)"
  exit 0
fi

payload="$(cat)"
jqr() { printf '%s' "$payload" | jq -r "$1" 2>/dev/null || true; }

[[ "$(jqr '.tool_name // ""')" == "Bash" ]] || exit 0

cmd="$(jqr '.tool_input.command // ""')"
[[ -n "$cmd" ]] || exit 0

# One segment walked once: `<subcommand><TAB><-C path>`, or nothing where the
# segment is not a git call. Git's own value-taking global options are stepped
# over, so `git -C /x pull` reads as a pull and `git -c foo=pull status` does
# not. Repeated `-C` compose, each resolved against the last, which is git's own
# rule; an absolute one resets. Not quote-aware, the same limit the segment
# split carries.
git_call() {
  local -a words
  read -ra words <<<"$1"
  ((${#words[@]})) || return 1
  [[ "${words[0]##*/}" == "git" ]] || return 1
  local i=1 w v cd_path=""
  while ((i < ${#words[@]})); do
    w="${words[i]}"
    case "$w" in
      -C)
        v="${words[i + 1]:-}"
        [[ -n "$v" ]] || return 1
        case "$v" in
          /*) cd_path="$v" ;;
          *) cd_path="${cd_path:+$cd_path/}$v" ;;
        esac
        ((i += 2))
        ;;
      -c | --git-dir | --work-tree | --namespace | --exec-path)
        ((i += 2))
        ;;
      -*) ((i++)) ;;
      *)
        printf '%s\t%s' "$w" "$cd_path"
        return 0
        ;;
    esac
  done
  return 1
}

# Every separator to a newline, so each segment can be read as its own command.
# A newline in the command itself is already one.
kind=""
cd_opt=""
while IFS= read -r segment; do
  call="$(git_call "$segment")" || continue
  case "${call%%$'\t'*}" in
    pull | push)
      kind="${call%%$'\t'*}"
      cd_opt="${call#*$'\t'}"
      break
      ;;
  esac
done <<<"$(printf '%s' "$cmd" | sed 's/&&/\n/g; s/||/\n/g; s/[;&|(){}]/\n/g')"
[[ -n "$kind" ]] || exit 0

# Field name has changed across harness versions; accept either, and fall back
# to the whole payload — all that is wanted is the text git printed.
out="$(jqr '(.tool_output // .tool_response // .) | tostring')"
[[ -n "$out" ]] || exit 0

# The refusal strings, in git's own words. A pull that merely printed
# "Already up to date" matches none of them and is not a row.
#
# "Need to specify how to reconcile" is git's message when the branches have
# diverged and no pull strategy is configured — the same divergence, refused one
# step earlier, so it belongs in the same population.
marker=""
for probe in \
  "Not possible to fast-forward" \
  "Need to specify how to reconcile divergent branches" \
  "Updates were rejected because" \
  "non-fast-forward" \
  "! [rejected]" \
  "fetch first"; do
  case "$out" in
    *"$probe"*)
      marker="$probe"
      break
      ;;
  esac
done
[[ -n "$marker" ]] || exit 0

cwd="$(jqr '.cwd // ""')"
[[ -n "$cwd" && -d "$cwd" ]] || cwd="$PWD"

# A `git -C` moved the command to another repo; the payload's cwd did not
# follow it. A `~`, a `$VAR` or a quoted path survives the walk as text and
# resolves to no directory — the row is dropped there, per this file's LIMITS.
if [[ -n "$cd_opt" ]]; then
  case "$cd_opt" in
    /*) cwd="$cd_opt" ;;
    *) cwd="$cwd/$cd_opt" ;;
  esac
  [[ -d "$cwd" ]] || exit 0
fi

top="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)" || top=""
[[ -n "$top" ]] || exit 0

# The REPOSITORY's name, not this checkout's. `--show-toplevel` in a linked
# worktree gives the worktree directory, so a refusal inside
# `.claude/worktrees/plugin-v1.1.6` would read as a third repo beside
# workflow-core and fantasy-books, splitting the comparison #289 is asking for.
# The common git dir's parent is the repository either way.
common="$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || common=""
repo="${common%/.git}"
repo="${repo%/}"
repo="${repo##*/}"
[[ -n "$repo" ]] || repo="${top##*/}"

# Counted against the pushed ref, lib/landing-refs.js's answer for the repo
# refused in (#2408). Where a repo has no such ref — an adopter on another
# default branch — the configured upstream stands in, and the row says which was
# used rather than reporting counts against an unnamed ref.
ref="$(node "${BASH_SOURCE[0]%/*}/lib/landing-refs.js" pushed "$top" 2>/dev/null)" || ref=""
if [[ -z "$ref" ]] || ! git -C "$top" rev-parse --verify --quiet "$ref" >/dev/null 2>&1; then
  ref="$(git -C "$top" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null)" || ref=""
fi

ahead="-"
behind="-"
state="unknown"
if [[ -n "$ref" ]]; then
  counts="$(git -C "$top" rev-list --left-right --count "HEAD...$ref" 2>/dev/null)" || counts=""
  if [[ "$counts" =~ ^([0-9]+)[[:space:]]+([0-9]+)$ ]]; then
    ahead="${BASH_REMATCH[1]}"
    behind="${BASH_REMATCH[2]}"
    if ((ahead > 0 && behind > 0)); then
      state="diverged"
    elif ((behind > 0)); then
      state="behind"
    elif ((ahead > 0)); then
      state="ahead"
    else
      state="level"
    fi
  fi
fi
[[ -n "$ref" ]] || ref="-"

# Live Claude sessions, by lib/claude-sessions.sh — see this file's LIMITS for
# what that unit costs.
sessions="-"
ps_bin="${WFC_PS:-ps}"
# shellcheck source=scripts/lib/claude-sessions.sh
if source "${BASH_SOURCE[0]%/*}/lib/claude-sessions.sh" 2>/dev/null &&
  command -v "$ps_bin" >/dev/null 2>&1; then
  count="$("$ps_bin" -eo pid=,ppid=,args= 2>/dev/null | wfc_session_count 2>/dev/null)" || count=""
  [[ "$count" =~ ^[0-9]+$ ]] && sessions="$count"
fi

# printf's %()T is a builtin, so the timestamp forks nothing. The `.000Z` is
# SHAPE, not precision: whole seconds is all this reads, and the millis are
# there so a row sorts and parses beside lib/guard-log.sh's, which pads the same
# three zeroes for the same reason. divergence-report.js's deduplication comment
# says what the second resolution costs.
when=""
TZ=UTC printf -v when '%(%Y-%m-%dT%H:%M:%S)T' -1 2>/dev/null
case "$when" in
  [0-9][0-9][0-9][0-9]-*) when="${when}.000Z" ;;
  *) when="$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null)" ;;
esac

# Tab and newline are the row's own delimiters, and `repo` and `ref` come off
# the filesystem and the ref namespace. Collapsed to spaces, as lib/guard-log.sh
# does for the same reason.
flat() { printf '%s' "${1//[$'\t\r\n']/ }"; }

dir="$(gl_project_dir "$top")"
mkdir -p "$dir" 2>/dev/null
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$when" "$(flat "$repo")" "$kind" "$ahead" "$behind" "$state" \
  "$sessions" "$(flat "$ref")" "$(flat "$marker")" \
  >>"$dir/divergence.log" 2>/dev/null

exit 0
