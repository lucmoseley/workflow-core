#!/usr/bin/env bash
# inject-review-tier.sh — PreToolUse hook: hand a session the review tier its
# change owes when it loads the code-review skill on a change touching a
# declared sensitive path, and tell an adopter that has declared none that no
# review can escalate (#1619, spec #1612 §Detection moments, §Skill-load lines
# for the rollout, §Staged-review mode).
#
# A SECOND HOOK ENTRY BESIDE scripts/guard-review-rules.sh, NOT A PART OF IT,
# for a 4,000 B cap of its own: that guard's envelope has no room (#1619).
#
# IMPLICIT: on a Skill call naming `code-review`, runs scripts/lib/sensitive-paths.js over the staged paths and the paths this session changed since its base, in the root and in the worktree of the root's repository the payload's `cwd` sits in; where an area matched or any globless area is declared, injects the tier owed, each area's focus, examples and `live` flag, the focus and attack Artefact paths, the escalated-review rules, the focused and attacker run briefs and the records to write (#1621); where `sensitivePaths` is absent, injects one line saying so.
# JUSTIFIED: fail-safe — a change to a sensitive path reviewed at the standard tier misses the defects that cost money or leak data, and the vendored skill cannot carry the tier (spec #1612).
# DEFEAT: any array value of `sensitivePaths`, `[]` included, silences the undeclared line; `scripts/clear-rule-latch.sh` clears the fragments' latch; listing this hook under the host's `disabled` silences it whole.
#
# THE AREAS RIDE IN THE PRELUDE, UNLATCHED, because they change with the diff:
# a second review in one session is told its own areas. The rules after them are
# fragments, latched once a session as guard-review-rules.sh's are.
#
# LIMITS
#  - Paths since the session base count only where this session wrote them,
#    scripts/lib/code-signal.sh's attribution (mantahostels#114). Staged paths
#    count whoever staged them: the staged state is what the commit carries.
#  - A worktree outside the root adds its staged paths only (#2386). The
#    declaration read is the root's in any worktree.
#  - It fires on the Skill TOOL only, as guard-review-rules.sh does. A typed
#    `/code-review` reaches it through scripts/inject-tracker-docs.sh, which
#    runs it on a Skill payload of its own making (#1697).
#  - It FAILS OPEN on anything it cannot resolve, and the fail-open is RECORDED
#    (mantahostels#147).

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — code-review loaded without its review tier"
  exit 0
}

gp_begin '.tool_input.skill' "skill call"

# The same names guard-review-rules.sh matches, and for its reasons (#201).
case "$(gp_subject)" in
  code-review:code-review) gp_allow ;;
  code-review | *:code-review) ;;
  *) gp_allow ;;
esac

root="$(gr_root)"
[[ -n "$root" ]] || gl_open "the repo root did not resolve — review tier not stated"
# guard-review-rules.sh refuses this call (#1165), so a tier here would ride a
# refusal; the namespaced retry is told.
[[ "$(gp_subject)" == code-review && ! -f "$root/.claude/skills/code-review/SKILL.md" ]] &&
  gp_allow
cd "$root" || gl_open "could not enter the repo root — review tier not stated"

# The trees whose paths are matched: the root, and the payload's cwd where it
# sits in another worktree of the root's repository, since a throwaway worktree
# keeps CLAUDE_PROJECT_DIR on the shared tree (#2386, spec #1612 §Detection
# moments).
trees=("$root")
git_bin="${WFC_GIT:-git}"
cwd="$(gp_payload_field '.cwd')" || cwd=""
if [[ -n "$cwd" ]] &&
  top="$("$git_bin" -C "$cwd" rev-parse --show-toplevel 2>/dev/null)" &&
  [[ "$top" != "$root" ]]; then
  # A git before 2.31 rejects --path-format (#2529).
  common="$("$git_bin" -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || common=""
  root_common="$("$git_bin" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || root_common=""
  if [[ -z "$common" || -z "$root_common" ]]; then
    gl_log "git rev-parse --git-common-dir failed in $cwd or $root — worktree paths left unmatched"
  elif [[ "$common" == "$root_common" ]]; then
    trees+=("$top")
  fi
fi

sid="$(gp_payload_field '.session_id')" || sid=""

# shellcheck source=scripts/lib/marker-root.sh
source "$here/lib/marker-root.sh" 2>/dev/null
# shellcheck source=scripts/lib/concision-marker.sh
source "$here/lib/concision-marker.sh" 2>/dev/null
# shellcheck source=scripts/lib/code-signal.sh
source "$here/lib/code-signal.sh" 2>/dev/null
# shellcheck source=scripts/lib/review-suffix.sh
source "$here/lib/review-suffix.sh" 2>/dev/null

# ledger_in_tree <tree> — the write ledger as <tree> names its paths. The ledger
# records a path from the root (lib/arbiter-ledger.js's recordWrite), so a
# worktree's file carries the worktree's place under the root, and a worktree
# outside the root has none.
ledger_in_tree() {
  local tree="$1"
  if [[ "$tree" == "$root" ]]; then
    cat
  elif [[ "$tree" == "$root"/* ]]; then
    local line prefix="${tree#"$root"/}/"
    while IFS= read -r line; do
      [[ "$line" == "$prefix"* ]] && printf '%s\n' "${line#"$prefix"}"
    done
    return 0
  else
    cat >/dev/null
  fi
}

# This session's own changes since its base in each tree, or nothing where the
# base or the write ledger will not read: unattributable, they are billed to
# nobody.
own_changes() {
  [[ -n "$sid" ]] || return 0
  if ! declare -F concision_session_base >/dev/null 2>&1 ||
    ! declare -F written_paths >/dev/null 2>&1; then
    gl_log "lib/concision-marker.sh or lib/code-signal.sh did not load — this session's unstaged changes left unmatched"
    return 0
  fi
  local base scratch t
  # No base yet is a session that has recorded none, not a fault.
  base="$(concision_session_base "$(gr_markers_dir)" "$sid")" || return 0
  scratch="$(mktemp -d 2>/dev/null)" || {
    gl_log "mktemp failed — this session's unstaged changes left unmatched"
    return 0
  }
  if node "$here/session-arbiter.js" writes "$sid" >"$scratch/ledger" 2>/dev/null; then
    for t in "${trees[@]}"; do
      ledger_in_tree "$t" <"$scratch/ledger" >"$scratch/mine"
      (
        cd "$t" || {
          gl_log "could not enter $t — this session's unstaged changes there left unmatched"
          exit 0
        }
        written_paths "$base" "$scratch/mine"
      )
    done
  else
    gl_log "session-arbiter.js writes failed — this session's unstaged changes left unmatched"
  fi
  rm -rf "$scratch"
}

# A config warning is the config reader's to report, not this hook's.
match="$(
  {
    for t in "${trees[@]}"; do
      "$git_bin" -c core.quotePath=false -C "$t" diff --cached --name-only 2>/dev/null
    done
    own_changes
  } |
    node "$here/lib/sensitive-paths.js" --stdin 2>/dev/null
)" || gl_open "lib/sensitive-paths.js did not run — review tier not stated"

state="$(jq -r '.state' <<<"$match" 2>/dev/null)" ||
  gl_open "the matcher's output did not parse — review tier not stated"

# Unlatched, so every review is told until the key exists (spec #1612 §Solution).
if [[ "$state" == absent ]]; then
  gp_context "$(gp_rule_text review-sensitive-undeclared "No sensitive paths are declared, so no review here can escalate: docs/agents/rules/review-sensitive-undeclared.txt.")"
  gp_allow
fi

matched="$(jq '.matched | length' <<<"$match")"
globless="$(jq '.globless | length' <<<"$match")"
((matched + globless > 0)) || gp_allow

# The paths listed per area are capped because the prelude is not: a long list
# would push the fragments after it off this call. 3 is a first guess, never
# measured against the cap.
PATHS_LISTED_MAX=3
areas="$(
  jq -r --argjson max "$PATHS_LISTED_MAX" '
    def area: "- `\(.name)`\(if .paths then " (\(.paths[:$max] | join(", "))\(if (.paths | length) > $max then ", and \(.paths | length - $max) more" else "" end))" else ": \(.description)" end), \(if .live then "live" else "not live" end). Focus: \(.focus).\(if (.examples | length) > 0 then " Examples: \(.examples | join("; "))." else "" end)";
    [ (if (.matched | length) > 0 then "Tier owed: escalated. Sensitive areas this change touches:", (.matched[] | area) else empty end),
      (if (.globless | length) > 0 then "Sensitive areas declared with no globs:", (.globless[] | area) else empty end)
    ] | join("\n")' <<<"$match"
)"
# Suffixed as guard-review-rules.sh suffixes the two axes' paths, so concurrent
# reviews write apart (mantahostels#3458). Residual: where the library will not
# load, two concurrent escalated reviews share the bare names.
if declare -F review_suffix >/dev/null 2>&1; then
  suffix="$(review_suffix "$sid")"
else
  gl_log "lib/review-suffix.sh did not load — focus and attack Artefact paths left unsuffixed"
  suffix=""
fi
gp_rule_prelude "Sensitive paths declared in \`.claude/workflow-core.json\`:
$areas
Focus and attack Artefact paths: \`.claude/tmp/review-focus${suffix}.md\`, \`.claude/tmp/review-attack${suffix}.md\`."

# Each branch spells its ids out because check-guard-registry.js counts a
# fragment as printed, and sums its bytes against the cap, only from a literal
# `gp_rule <id>...` call (scripts/lib/rule-emission.js): an id held in an array
# is invisible to it (#1699). Residual: each new optional fragment doubles the
# branches; inject-review-tier.test.ts pins that they agree.
if jq -e '[.matched[], .globless[]] | any(.live | not)' <<<"$match" >/dev/null; then
  if ((globless > 0)); then
    gp_rule review-tier-escalated review-focused-run review-attacker-run review-tier-records review-tier-globless review-tier-not-live
  else
    gp_rule review-tier-escalated review-focused-run review-attacker-run review-tier-records review-tier-not-live
  fi
elif ((globless > 0)); then
  gp_rule review-tier-escalated review-focused-run review-attacker-run review-tier-records review-tier-globless
else
  gp_rule review-tier-escalated review-focused-run review-attacker-run review-tier-records
fi

gp_allow
