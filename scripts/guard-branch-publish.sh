#!/usr/bin/env bash
# PreToolUse guard: work lands on `main` directly — no branch on the remote, and
# never a pull request (workflow-core#764) — and a Dependabot PR is never merged
# (mantahostels#3351). One guard, because both limbs read the same `gh pr` walk.
#
# DENY, not warn (mantahostels#103): a push's destination ref, a `gh pr create` and a
# merge of a PR whose author is Dependabot are structured facts, and none has a
# legitimate use under its rule.
#
# WHAT IS DENIED
#  - `gh pr create` / `gh pr new`, wherever `-R` points.
#  - `gh api` creating a pull request: a POST to `repos/<o>/<r>/pulls` — explicit
#    `-X POST`, or no method and a field or `--input`, which gh sends as POST —
#    or a `graphql` call whose fields carry `createPullRequest`.
#  - `git push` whose destination is a branch other than `main` or `spike/*`,
#    each destination read by lib/push-dests.sh. `--all`, `--branches` and
#    `--mirror` are denied outright.
#  - A FORCED push or a deletion whose destination is `main` (workflow-core#1733): `-f`,
#    `--force`, `--force-with-lease` or a `+` refspec, and `--delete main` or
#    `:main` — `heads/main` and git's abbreviations of the two long flags
#    read the same. It prints docs/agents/rules/main-rewind.txt.
#  - `gh pr merge` of a Dependabot PR (workflow-core#2020): a `dependabot/` branch named on
#    the command, or a PR whose head branch or author `gh pr view` reads as
#    Dependabot's.
#
# WHAT PASSES: a destination of `main` or under `spike/` — the workflow-core#174 precedent, a
#   data branch kept off `main` on purpose — or outside `refs/heads/` (a tag, a
#   note); `--tags` with no refspec; any deletion but `main`'s; a
#   detached HEAD's bare push, which git itself refuses; `--help`, `--dry-run`.
#
# WITH THE `landing` MODULE ON (workflow-core#2409, spec workflow-core#2261), sessions push to `landing`
#   and only the lander moves `main`: a push to `main` is denied, `landing`
#   passes in its place, and a forced push or a deletion of `landing` is denied
#   as one of `main` is.
#
# LIMITS
#  - A bare `git push` is judged by the current branch (lib/push-dests.sh). A
#    `remote.<name>.push` refspec or push.default=matching pushes something
#    else, unseen — and a `+` refspec there forces it.
#  - It walks every working tree of THIS repo, a linked worktree included
#    (gp_walk_repo_git). A push in another repo is not judged; a `gh pr create` is,
#    whatever repo it targets — a session wanting one elsewhere runs it outside
#    Claude Code.
#  - A push whose tree it cannot resolve (`git -C "$W"`, W unset) FAILS OPEN,
#    recorded by the walker (mantahostels#147). So does a missing jq or parser, as every
#    guard here (mantahostels#103). A `graphql` query it cannot read back (`$(cat q)`, a
#    `@file` field) is allowed unrecorded: nothing says it creates anything.
#    A refspec it cannot read (`git push origin "$B"`) is allowed and recorded:
#    Bash calls share no shell state, so the name is unknowable here.
#    An unloadable lib/main-rewind.sh FAILS CLOSED: a forced push or deletion
#    of `main` is known bad, so it is still refused, with neither the rule nor
#    the file's name, and no main-rewind needle counts that refusal (workflow-core#1777).
#  - A `gh pr merge` naming no `dependabot/` branch costs one `gh pr view`,
#    under `timeout 8`: 0.95–1.45 s over five measured calls, leaving 2 s of
#    the 10 s ceiling for the rest. Where the
#    lookup fails — or cannot be aimed: an unreadable PR or repo word, a
#    `GH_REPO` override, an unknown directory — the merge is allowed and
#    recorded. The lookup runs in the segment's own directory (gp_cwd). A merge
#    through `gh api` is not read. Adopters get the limb too (workflow-core#2020).
#  - Only a segment's own command word is read, after gp_unwrap's wrappers
#    (`env`, `timeout`, `command`, …), a push included (workflow-core#1731). A wrapper's
#    own `-C DIR` is swept, so `env -C /x git push` is judged against the
#    cwd. `sh -c "…"`, a script, the GitHub web UI
#    and the founder's terminal are not seen, and Dependabot's PRs are opened by
#    GitHub itself (docs/agents/dependabot.md governs those).
#  - Registered with no `if`: the walker reads `git` and `gh` both, behind
#    wrappers, and one `if` field names one tool.
#
# The rules it prints are docs/agents/rules/branch-publish.txt, main-rewind.txt
# and dependabot-merge.txt, and with `landing` on branch-publish-landing.txt in
# place of the first and landing-rewind.txt. A refusal whose fragment cannot be read still
# refuses, naming the file (mantahostels#1648's store rule).

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every command allowed unchecked"
  exit 0
}

# shellcheck source=scripts/lib/push-dests.sh
source "$here/lib/push-dests.sh" 2>/dev/null
declare -F pd_read >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/push-dests.sh did not load — every command allowed unchecked"
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

PUBLISH_RULE_FALLBACK="Work lands on \`main\` directly — no branch on the remote, and never a pull request; the rule could not be read from docs/agents/rules/branch-publish.txt. Read that file before doing anything else."

LANDING_PUBLISH_RULE_FALLBACK="Work lands through \`landing\` — never a push to \`main\`, no other branch on the remote, and never a pull request; the rule could not be read from docs/agents/rules/branch-publish-landing.txt. Read that file before doing anything else."
LANDING_REWIND_RULE_FALLBACK="Never force-push or delete \`landing\`; the rule could not be read from docs/agents/rules/landing-rewind.txt. Read that file before doing anything else."

landing_on() { gp_module_on landing; }

# Each id spelt whole, so check-guard-registry.js's emitter scan reads it.
publish_rule_text() {
  if landing_on; then
    gp_rule_text branch-publish-landing "$LANDING_PUBLISH_RULE_FALLBACK"
  else
    gp_rule_text branch-publish "$PUBLISH_RULE_FALLBACK"
  fi
}

# refuse <what> <segment>
refuse() {
  local reason
  IFS= read -r -d '' reason <<EOF || :
$1: @CMD@

$(publish_rule_text)
EOF
  gp_deny "$reason" "$2"
}

# landing_rewind_deny <segment> <what the command does, completing "This …">
landing_rewind_deny() {
  local reason
  IFS= read -r -d '' reason <<EOF || :
This $2: @CMD@

$(gp_rule_text landing-rewind "$LANDING_REWIND_RULE_FALLBACK")
EOF
  gp_deny "$reason" "$1"
}

DEPENDABOT_RULE_FALLBACK="Never merge a Dependabot pull request — take its fix locally and commit it direct to \`main\`; the rule could not be read from docs/agents/rules/dependabot-merge.txt. Read that file before doing anything else."

# `gh pr merge`'s value-taking flags, from `gh pr merge --help` on gh 2.95.0.
MERGE_VALUE_FLAGS="-b --body -F --body-file -t --subject -A --author-email --match-head-commit -R --repo"

merge_selector=""
merge_repo=""
merge_disable=0
merge_arg() {
  local kind="$1" name="$2" value="$3"
  case "$kind" in
    arg) [[ -z "$merge_selector" ]] && merge_selector="$value" ;;
    opt) [[ "$name" == -R || "$name" == --repo ]] && merge_repo="$value" ;;
    flag) [[ "$name" == --disable-auto ]] && merge_disable=1 ;;
  esac
  return 0
}

unchecked() {
  gl_log "$1 — merge allowed unchecked" "$(gp_unmask "$2")"
}

# judge_merge <segment> <repo word, or empty> <1 where GH_REPO is set> <words after `merge`>
judge_merge() {
  local segment="$1" repo="$2" repo_env="$3" selector="" cwd found
  shift 3
  merge_selector="" merge_repo="" merge_disable=0
  gp_scan_flags "$MERGE_VALUE_FLAGS" merge_arg -- "$@"
  ((merge_disable)) && return 0
  [[ -n "$merge_repo" ]] && repo="$merge_repo"
  if [[ -n "$merge_selector" ]]; then
    selector="$(gp_literal "$merge_selector")" || {
      unchecked "unreadable pr merge selector" "$segment"
      return 0
    }
  fi
  if [[ "$selector" != dependabot/* ]]; then
    local -a view=(pr view)
    [[ -n "$selector" ]] && view+=("$selector")
    if [[ -n "$repo" ]]; then
      repo="$(gp_literal "$repo")" || {
        unchecked "unreadable pr merge repo" "$segment"
        return 0
      }
      view+=(-R "$repo")
    elif ((repo_env)); then
      unchecked "pr merge under a GH_REPO override" "$segment"
      return 0
    fi
    cwd="$(gp_cwd)"
    [[ -n "$cwd" ]] || {
      unchecked "pr merge in an unknown directory" "$segment"
      return 0
    }
    found="$(cd "$cwd" 2>/dev/null && timeout 8 "${WFC_GH:-gh}" "${view[@]}" --json headRefName,author \
      --jq '(.headRefName | startswith("dependabot/")) or (.author.login | test("^(app/)?dependabot(\\[bot\\])?$"))' 2>/dev/null)" || {
      unchecked "pr merge's PR could not be looked up" "$segment"
      return 0
    }
    [[ "$found" == true ]] || return 0
  fi
  local reason
  IFS= read -r -d '' reason <<EOF || :
This merges a Dependabot pull request: @CMD@

$(gp_rule_text dependabot-merge "$DEPENDABOT_RULE_FALLBACK")
EOF
  gp_deny "$reason" "$segment"
}

# 0 where <word> names `main` as a push destination does.
is_main() {
  [[ "$1" == main || "$1" == heads/main || "$1" == refs/heads/main ]]
}

# 0 where <word> names `landing` as a push destination does.
is_landing() {
  [[ "$1" == landing || "$1" == heads/landing || "$1" == refs/heads/landing ]]
}

# 0 where publishing <full ref> is allowed.
is_allowed_dst() {
  case "$1" in
    refs/heads/spike/*) return 0 ;;
    refs/heads/main) ! landing_on ;;
    refs/heads/landing) landing_on ;;
    refs/heads/*) return 1 ;;
    *) return 0 ;;
  esac
}

judge_push() {
  local segment="$1" tree="$3" i ref
  shift 3
  pd_read "$tree" "$@"
  ((pd_inert)) && return 0
  ((pd_delete)) || ((!pd_all)) || refuse "This pushes every local branch" "$segment"
  for i in ${pd_kind[@]+"${!pd_kind[@]}"}; do
    ref="${pd_ref[i]}"
    case "${pd_kind[i]}" in
      unread-delete) gl_log "unreadable push deletion — push allowed unchecked" "$(gp_unmask "$segment")" ;;
      unread-push) gl_log "unreadable push refspec — push allowed unchecked" "$(gp_unmask "$segment")" ;;
      delete)
        is_main "$ref" && rewind_deny "$segment" "deletes \`main\` on the remote"
        is_landing "$ref" && landing_on &&
          landing_rewind_deny "$segment" "deletes \`landing\` on the remote"
        ;;
      push)
        ((pd_forced[i])) && [[ "$ref" == refs/heads/main ]] &&
          rewind_deny "$segment" "force-pushes \`main\`"
        ((pd_forced[i])) && [[ "$ref" == refs/heads/landing ]] && landing_on &&
          landing_rewind_deny "$segment" "force-pushes \`landing\`"
        is_allowed_dst "$ref" && continue
        if [[ "$ref" == refs/heads/main ]]; then
          refuse "This pushes to main, which only the lander moves" "$segment"
        elif ((pd_bare[i])); then
          refuse "This pushes the branch the tree is on, ${ref#refs/heads/}" "$segment"
        else
          refuse "This publishes a branch other than main, ${ref#refs/heads/}" "$segment"
        fi
        ;;
    esac
  done
  return 0
}

gp_walk_repo_git --unwrap judge_push "branch publish" push

# gh api's value-taking flags, from `gh api --help` on gh 2.95.0.
API_VALUE_FLAGS="-X --method -f --raw-field -F --field -H --header --input -q --jq -t --template --cache --hostname -p --preview"

api_endpoint=""
api_method=""
api_body=0
api_mutation=0
api_arg() {
  local kind="$1" name="$2" value="$3" text
  case "$kind" in
    arg) [[ -z "$api_endpoint" ]] && api_endpoint="$(gp_literal "$value")" ;;
    opt)
      case "$name" in
        -X | --method) api_method="$(gp_literal "$value")" ;;
        -f | --raw-field | -F | --field | --input)
          api_body=1
          text="$(gp_literal "$value")"
          [[ "$text" == *createPullRequest* ]] && api_mutation=1
          ;;
      esac
      ;;
  esac
  return 0
}

# The word as the shell would pass it, so a quoted `"create"` still reads as
# `create`; an expansion it cannot read stays masked and matches nothing.
lit() { gp_literal "$1" 2>/dev/null; }

judge_gh() {
  local segment="$1" repo_env=0
  shift
  gp_carries_var GH_REPO "$@" && repo_env=1
  gp_gh_words "$@" || return 0
  local repo="$_gp_gh_repo"
  set -- ${_gp_gh_args+"${_gp_gh_args[@]}"}

  if [[ "$(lit "${1-}")" == pr ]]; then
    shift
    # `-R` may also sit between `pr` and its verb.
    while [[ "$(lit "${1-}")" == -* ]]; do
      case "$(lit "$1")" in
        -R | --repo)
          repo="${2-}"
          shift 2 || return 0
          ;;
        --repo=*)
          repo="${1#--repo=}"
          shift
          ;;
        -R?*)
          repo="${1#-R}"
          shift
          ;;
        *) shift ;;
      esac
    done
    case "$(lit "${1-}")" in
      create | new) refuse "This opens a pull request" "$segment" ;;
      merge)
        shift
        judge_merge "$segment" "$repo" "$repo_env" "$@"
        ;;
    esac
    return 0
  fi
  [[ "$(lit "${1-}")" == api ]] || return 0
  shift
  api_endpoint="" api_method="" api_body=0 api_mutation=0
  gp_scan_flags "$API_VALUE_FLAGS" api_arg -- "$@"
  if [[ "$api_endpoint" == graphql ]]; then
    ((api_mutation)) && refuse "This opens a pull request through the GraphQL API" "$segment"
    return 0
  fi
  [[ "${api_endpoint#/}" =~ ^repos/[^/]+/[^/]+/pulls/?(\?.*)?$ ]] || return 0
  local method="${api_method^^}"
  if [[ "$method" == POST || (-z "$method" && "$api_body" == 1) ]]; then
    refuse "This opens a pull request through the REST API" "$segment"
  fi
  return 0
}

gp_walk_commands judge_gh

gp_allow
