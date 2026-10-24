#!/usr/bin/env bash
# guard-anthropic-report.sh — PreToolUse guard: nothing is written to an
# Anthropic repo from a Bash call (#1967, which ruled that nothing is reported
# or requested to Anthropic; #1987, which gave the ruling one guard of its own).
#
# DENY, not warn (mantahostels#103): which repo a command writes to is a fact
# read off the command, its environment or its clone.
#
# WHAT IT JUDGES — a segment whose command word is `gh`, after the launcher
# wrappers gp_unwrap strips (`timeout`, `env`, `nohup`…):
#  - `gh issue <sub>` and `gh pr <sub>`, for every <sub> but the reads
#    (is_read). An unknown subcommand counts as a write, so a
#    verb gh adds later is refused rather than missed.
#  - `gh api` with a writing method — POST, PUT, PATCH or DELETE, or none at
#    all on a call carrying a payload, which gh sends as a POST — on a
#    `repos/<owner>/<repo>/…` endpoint.
#  - `gh api graphql` carrying a mutation, where the call names `anthropics`
#    anywhere it can read: a variable, a field, the query text.
#
# WHICH REPO, in gh's own order:
#  1. an issue or PR URL among the arguments, which gh acts on whatever else
#     the command says;
#  2. `-R`/`--repo`, or the endpoint's owner/repo on `gh api`;
#  3. `GH_REPO`, set on the command itself or in the environment;
#  4. the clone the command runs in: ANY of its remotes naming an `anthropics`
#     repo counts, gh choosing among them by rules the command does not show.
#
# LIMITS
#  - GraphQL names its target by opaque node id, so a mutation whose call
#    never spells `anthropics` — a `repositoryId` or `subjectId` looked up in an
#    earlier call — passes unseen. So does a query read from a file
#    (`-F query=@file`, `--input`).
#  - A `gh api` method it cannot read (`-X "$M"`) is judged as a write, so a
#    call to an Anthropic repo carrying one is REFUSED.
#  - A repo it cannot read — a `--repo "$R"` it cannot resolve, a placeholder
#    endpoint in a directory it cannot know — FAILS OPEN, recorded (mantahostels#147)
#    via lib/guard-log.sh for check-guard-errors.js to report under `npm run status`.
#  - Only `gh issue`, `gh pr` and `gh api` are judged: `gh release`, `gh label`
#    and the other groups write nothing a report travels by. A `gh` alias or
#    extension expands out of sight and passes.
#  - A PreToolUse hook sees Bash tool calls only. A script the call runs, a
#    `curl` to api.github.com, the web UI and a Chrome child's form submission
#    all escape it.
#  - Wired with `if: Bash(*gh *)`, the wrapper-tolerant spelling, because the
#    walker judges `timeout 60 gh …` (docs/agents/guard-authoring.md surface 4).

set -uo pipefail

# The issue and pr flags whose value is free text or a name, skipped.
TEXT_FLAGS=" -b --body -t --title -F --body-file -l --label --add-label \
--remove-label -a --assignee --add-assignee --remove-assignee -m --milestone \
-p --project --add-project --remove-project -B --base -H --head -r --reviewer \
--add-reviewer --remove-reviewer -T --template -c --comment --reason "

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every gh write allowed unchecked"
  exit 0
}

# shellcheck source=scripts/lib/guard-gh-api.sh
source "$here/lib/guard-gh-api.sh" 2>/dev/null
declare -F ga_scan_api >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-gh-api.sh did not load — every gh write allowed unchecked"
  exit 0
}

declare -F wfc_repo_slug >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "wfc-config.sh did not load — every gh write allowed unchecked"
  exit 0
}

gp_begin '.tool_input.command' command

RULE_FALLBACK="Nothing is reported or requested to Anthropic; the rule itself could not be read from docs/agents/rules/anthropic-report.txt. Read that file before doing anything else."

deny() {
  local reason
  IFS= read -r -d '' reason <<EOF || :
This writes to an Anthropic repo ($2): @CMD@

$(gp_rule_text anthropic-report "$RULE_FALLBACK")
EOF
  gp_deny "$reason" "$1"
}

# Is $1, a repo as gh reads it, a github.com repo owned by `anthropics`? A repo
# on another host keeps its host prefix in wfc_repo_slug, so never matches.
anthropic_repo() {
  [[ -n "$1" && "$(wfc_repo_slug "$1")" =~ ^anthropics/[^/]+$ ]]
}

# The anthropics/<repo> an issue or PR URL names, on stdout. Anchored at both
# ends, so a body citing an upstream issue in prose is no target.
url_repo() {
  [[ "${1,,}" =~ ^(https?://)?(www\.)?github\.com/(anthropics/[^/]+)/(issues|pull)/[0-9]+/?(#[^[:space:]]*)?$ ]] || return 1
  printf '%s' "${BASH_REMATCH[3]}"
}

# The GH_REPO the command runs with, on stdout: an assignment the command
# carries, by leading assignment or `env`, else the command string's own
# earlier assignments and the environment. Status 1 where it is set but cannot
# be read; empty where it is unset.
gh_repo_env() {
  local w
  for w in ${_gp_words+"${_gp_words[@]:0:_gp_assign_end}"} \
    ${_gp_wrapper_words+"${_gp_wrapper_words[@]}"}; do
    [[ "$w" == GH_REPO=* ]] || continue
    gp_literal "${w#GH_REPO=}" 2>/dev/null
    return
  done
  [[ "$exported_gh_repo" == "$UNREADABLE" ]] && return 1
  [[ -n "$exported_gh_repo" ]] && {
    printf '%s' "$exported_gh_repo"
    return
  }
  gp_resolve_word '$GH_REPO' 2>/dev/null || :
}

# The anthropics repo the clone the command runs in has a remote on, on
# stdout; status 1 where it has none.
clone_repo() {
  local cwd url
  cwd="$(gp_cwd)"
  [[ -n "$cwd" ]] || {
    gl_open "could not tell which directory a gh write runs in — its clone's remotes unchecked for an Anthropic repo"
    return 1
  }
  while read -r _ url _; do
    anthropic_repo "$url" && {
      wfc_repo_slug "$url"
      return 0
    }
  done < <(git -C "$cwd" remote -v 2>/dev/null)
  return 1
}

# Decide a write whose repo the command did not name: GH_REPO, then the clone.
judge_unnamed() {
  local segment="$1" env_repo
  if env_repo="$(gh_repo_env)"; then
    if [[ -n "$env_repo" ]]; then
      anthropic_repo "$env_repo" && deny "$segment" "$env_repo"
      return 0
    fi
  else
    gl_open "could not read GH_REPO on a gh write — allowed unchecked for an Anthropic repo"
    return 0
  fi
  local repo
  repo="$(clone_repo)" && deny "$segment" "$repo"
  return 0
}

# Is `gh $1 $2` a read? Every other subcommand is judged as a write.
is_read() {
  case "$1:$2" in
    issue:list | issue:view | issue:status) ;;
    pr:list | pr:view | pr:status | pr:checks | pr:diff | pr:checkout) ;;
    *) return 1 ;;
  esac
}

# `gh issue <sub> …` and `gh pr <sub> …`, from <sub> on.
judge_flag_form() {
  local segment="$1" group="$2" sub word next repo="" repo_hidden=0 named=0
  shift 2
  sub="$(gp_literal "${1-}" 2>/dev/null)" || return 0
  [[ -n "$sub" ]] || return 0
  is_read "$group" "$sub" && return 0
  shift

  while (($#)); do
    word="$(gp_literal "$1" 2>/dev/null)" || word=""
    case "$word" in
      --) break ;;
      -R | --repo)
        named=1
        next="$(gp_literal "${2-}" 2>/dev/null)" && repo="$next" || repo_hidden=1
        shift 2 || break
        continue
        ;;
      --repo=*) named=1 repo="${word#--repo=}" ;;
      -R?*) named=1 repo="${word#-R}" ;;
      -*)
        [[ "$TEXT_FLAGS" == *" $word "* ]] && {
          shift 2 || break
          continue
        }
        ;;
      *) next="$(url_repo "$word")" && deny "$segment" "$next" ;;
    esac
    shift
  done

  if ((named)); then
    if ((repo_hidden)) || [[ "$repo" == *'$'* ]]; then
      gl_open "could not read the --repo of a gh $group $sub — allowed unchecked for an Anthropic repo"
      return 0
    fi
    anthropic_repo "$repo" && deny "$segment" "$repo"
    return 0
  fi
  judge_unnamed "$segment"
}

# `gh api …`, from the words after `api`.
judge_api() {
  local segment="$1"
  shift
  local -a api_fields=()
  # shellcheck disable=SC2034 # api_opaque is set by ga_scan_api and read by no limb here.
  local api_method="" api_endpoint="" api_opaque=0 api_input=0
  local api_query="" api_query_hidden=0
  local method endpoint path owner name

  ga_scan_api "$@"

  # The method and endpoint are read back through gp_literal: the splitter blanks
  # every quoted span, so a quoted endpoint would otherwise walk past.
  if method="$(gp_literal "$api_method" 2>/dev/null)"; then
    if [[ -z "$method" ]]; then
      ga_defaults_to_post || return 0
    else
      case "${method^^}" in
        POST | PUT | PATCH | DELETE) ;;
        *) return 0 ;;
      esac
    fi
  fi

  endpoint="$(gp_literal "$api_endpoint" 2>/dev/null)" || {
    gl_open "could not read a gh api endpoint — allowed unchecked for an Anthropic repo"
    return 0
  }

  if ga_is_graphql_endpoint "$endpoint"; then
    judge_graphql "$segment" "$@"
    return 0
  fi

  path="$(ga_path "$endpoint")"
  [[ "$path" =~ ^repos/([^/]+)/([^/]+)(/|$) ]] || return 0
  owner="${BASH_REMATCH[1]}" name="${BASH_REMATCH[2]}"
  if [[ "$owner" =~ ^(\{owner\}|:owner)$ ]]; then
    judge_unnamed "$segment"
    return 0
  fi
  anthropic_repo "$owner/$name" && deny "$segment" "$owner/$name"
  return 0
}

# `gh api graphql …`: a mutation is a write, and its target is a node id the
# command cannot show, so the call is refused where it spells `anthropics`.
judge_graphql() {
  local segment="$1" word text=""
  shift
  ga_scan_graphql
  [[ "$api_query" == *mutation* ]] || ((api_query_hidden)) || return 0
  for word in "$@"; do
    text+=" $(gp_literal "$word" 2>/dev/null)"
  done
  [[ "${text,,}" =~ (^|[^a-z0-9-])(anthropics/[a-z0-9._-]+|anthropics) ]] || return 0
  [[ "$api_query" == *mutation* ]] && deny "$segment" "${BASH_REMATCH[2]}"
  # A query read from a file may or may not be a mutation.
  gl_open "a gh api graphql call naming anthropics carries a query the guard cannot read — allowed unchecked"
  return 0
}

# An earlier `export GH_REPO=…` in the same command, which the parser's own
# assignment harvest does not see.
exported_gh_repo=""
UNREADABLE=$'\x01'
note_export() {
  local w
  for w in "${@:2}"; do
    [[ "$w" == GH_REPO=* ]] || continue
    exported_gh_repo="$(gp_literal "${w#GH_REPO=}" 2>/dev/null)" || exported_gh_repo="$UNREADABLE"
  done
}

judge() {
  local segment="$1"
  shift
  [[ "${1-}" == export ]] && note_export "$@"
  gp_gh_words "$@" || return 0
  set -- ${_gp_gh_args+"${_gp_gh_args[@]}"}
  local group
  group="$(gp_literal "${1-}" 2>/dev/null)" || return 0
  case "$group" in
    issue | pr) judge_flag_form "$segment" "$group" "${@:2}" ;;
    api) judge_api "$segment" "${@:2}" ;;
  esac
}

gp_walk_commands judge
gp_allow
