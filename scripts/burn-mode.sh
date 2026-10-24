#!/usr/bin/env bash
# Toggle burn mode: spend allowance on purpose. Sonnet work runs on Opus 5.5,
# and Opus 5.5 runs at high effort rather than medium. Off by default;
# docs/effort-guide.md §Burn mode is the rule, and lib/burn-mode.js the table.
#
#   scripts/burn-mode.sh on | off | status
#
# Two writes. The marker at `~/.claude/.burn-mode` — one per machine, beside
# the settings files below (#127) — is what
# scripts/guard-dispatch-rewrite.sh and scripts/dispatch-sessions.sh read. And
# `modelSettings["claude-opus-5-5"].effortLevel` in EVERY plan's settings.json
# — ~/.claude and each ~/.claude<digits>, by lib/plan-dirs.js — because the
# plans are one machine. Claude Code reads it at startup, so a running session
# keeps its effort; the dispatch remap applies to the next Agent call at once.
# The `model` key is never touched: Opus stays Opus under burn mode (#355).
#
# `on` records each plan's effort in the marker, and `off` puts THAT back — a
# plan the founder set to something else by hand is not flattened to the
# standing default. A plan that had no effort key has it removed again.
#
# `off` WITH NO RECORD STILL REVERTS (#126). Without a record it falls back to
# the standing default, and only for a plan reading the burn effort exactly: a
# plan on anything else is the founder's own choice and is left alone.
#
# Whatever route it took, a plan still reading the burn effort when `off`
# finishes is an error and exits 1.

set -euo pipefail

usage() {
  echo "usage: $(basename "$0") on|off|status" >&2
  exit 2
}
[[ $# -eq 1 ]] || usage

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/atomic-write.sh
source "$here/lib/atomic-write.sh"
lib="$here/lib/burn-mode.js"
# A person runs this script, so the one way the marker can fail to resolve
# says so rather than exiting on `set -e` with nothing printed.
marker="$(node "$lib" marker)" ||
  {
    echo "error: cannot place the burn-mode marker — HOME is unset or relative" >&2
    exit 2
  }
effort_model="$(node -p 'require(process.argv[1]).EFFORT_MODEL' "$lib")"
on_effort="$(node -p 'require(process.argv[1]).EFFORT_ON' "$lib")"
off_effort="$(node -p 'require(process.argv[1]).EFFORT_OFF' "$lib")"

# The plans' settings files, ONE ENTRY PER REAL FILE (#187). `~/.claude2` and
# `~/.claude3` hold symlinks to `~/.claude/settings.json` on the machine this
# serves (docs/environment.md §Shared config is one copy, symlinked), so three
# paths are one file.
#
# The plan dirs come from lib/plan-dirs.js, whose `readdirSync` follows a
# symlinked HOME: a scan that did not would list no plan at all, and `on` would
# write an empty record, exiting 0 either way.
#
# A path `realpath` cannot resolve — a settings.json symlinked to nothing — is
# NAMED and skipped.
#
# NUL-separated so a HOME with a space survives; a scratch HOME in a test can
# hold one.
home_real="$(realpath -- "$HOME")" || home_real="$HOME"
plan_dirs="$here/lib/plan-dirs.js"
# Checked once up front: `< <(settings_files)` below hides the scan's exit, so
# an unreadable HOME would otherwise read as no plans and `on` would write an
# empty record, exiting 0.
node "$plan_dirs" "$HOME" >/dev/null || exit 2
settings_files() {
  node "$plan_dirs" "$HOME" |
    while IFS= read -r -d '' d; do
      f="$d/settings.json"
      [[ -e "$f" || -L "$f" ]] || continue
      real="$(realpath -e -- "$f" 2>/dev/null)" ||
        {
          echo "warning: skipping ${f#"$HOME"/} — it resolves to nothing" >&2
          continue
        }
      printf '%s\0' "$real"
    done | sort -zu
}
# rel <file> — the file as the founder names it, `.claude/settings.json`. A
# file resolving outside HOME keeps its absolute path.
rel() { printf '%s' "${1#"$home_real"/}"; }

# effort_of <file> — the plan's Opus 5.5 effort, or "" where the key is absent.
effort_of() { jq -r --arg k "$effort_model" '.modelSettings[$k].effortLevel // ""' "$1"; }

show_status() {
  local on=0 f effort expect
  [[ -f "$marker" ]] && on=1
  if [[ $on -eq 1 ]]; then echo "burn mode: on"; else echo "burn mode: off"; fi
  if [[ $on -eq 1 ]]; then expect="$on_effort"; else expect="$off_effort"; fi
  while IFS= read -r -d '' f; do
    effort="$(effort_of "$f")"
    if [[ "$effort" == "$expect" ]]; then
      printf '  %-32s %s effort=%s\n' "$(rel "$f")" "$effort_model" "$effort"
    else
      printf '  %-32s %s effort=%s  (not the %s default, %s)\n' "$(rel "$f")" "$effort_model" \
        "${effort:-absent}" "$([[ $on -eq 1 ]] && echo burn || echo standing)" "$expect"
    fi
  done < <(settings_files)
}

# write_effort <file> <level> — replaces the live file through aw_write, so a
# jq slip never installs unparseable settings and no session reads a torn one.
# An empty level REMOVES the key, and any object it leaves empty — one
# already empty before `on` included, since the record cannot tell the two
# apart. Returns non-zero where any
# step fails.
write_effort() {
  aw_write "$1" jq -e --arg k "$effort_model" --arg v "$2" '
    if $v == "" then
      del(.modelSettings[$k].effortLevel)
      | if .modelSettings[$k] == {} then del(.modelSettings[$k]) else . end
      | if .modelSettings == {} then del(.modelSettings) else . end
    else .modelSettings[$k].effortLevel = $v end' "$1"
}

# set_effort <file> <level> — `on`'s write: abort naming the file, because a
# record written over a half-applied on would tell `off` to restore efforts
# that were never replaced. `off` does NOT use this — it warns and carries on,
# so its self-check below is the one place a failed revert is reported from.
set_effort() {
  write_effort "$1" "$2" || {
    echo "error: could not write effortLevel=$2 into $1" >&2
    exit 1
  }
}

case "$1" in
  status)
    show_status
    exit 0
    ;;
  on)
    # A marker already present means some earlier on already holds the real
    # prior; rebuilding the record now would overwrite it with the on-effort
    # itself, so off would restore that rather than the founder's setting
    # (mantahostels#3547).
    if [[ -f "$marker" ]]; then
      echo "burn mode is already on — no settings file touched"
    else
      # Before a single plan is moved: a mkdir that fails after the loop would
      # strand every plan on the burn effort with no record to restore from,
      # and `off` would then flatten a hand-set plan to the standing default.
      mkdir -p "$(dirname "$marker")"
      record='{}'
      while IFS= read -r -d '' f; do
        prior="$(effort_of "$f")"
        record="$(jq -c --arg f "$f" --arg e "$prior" '.[$f] = $e' <<<"$record")"
        set_effort "$f" "$on_effort"
      done < <(settings_files)
      # The record is written only once every plan is moved, so a marker that
      # exists always holds what off needs.
      jq -n --argjson r "$record" '{effort: $r}' >"$marker"
    fi
    ;;
  off)
    # `kept` holds the plans the record says were ALREADY at the burn effort
    # before `on` ran — a deliberate setting, restored as such, and so exempt
    # from the self-check below, which would otherwise read them as a failed
    # revert.
    declare -A kept=()
    reverted=0
    while IFS= read -r -d '' f; do
      # `has` rather than a non-empty value: a plan with no effort key is
      # recorded as "", and that IS a record — the key was absent and is
      # removed again, rather than being reported as unrecorded.
      recorded=0 prior=""
      if [[ -f "$marker" ]] && jq -e --arg f "$f" '.effort | has($f)' "$marker" >/dev/null 2>&1; then
        recorded=1
        prior="$(jq -r --arg f "$f" '.effort[$f]' "$marker")"
      fi
      if [[ $recorded -eq 1 ]]; then
        write_effort "$f" "$prior" || echo "error: could not write $(rel "$f")" >&2
        reverted=1
        [[ "$prior" == "$on_effort" ]] && kept["$f"]=1
      elif [[ "$(effort_of "$f")" == "$on_effort" ]]; then
        # No record for this plan — a marker lost between the two calls, or a
        # plan added since `on`.
        echo "no record for $(rel "$f") — restoring the standing effort, $off_effort"
        write_effort "$f" "$off_effort" || echo "error: could not write $(rel "$f")" >&2
        reverted=1
      fi
    done < <(settings_files)
    rm -f "$marker"
    [[ $reverted -eq 1 ]] || echo "burn mode was already off — no settings file touched"
    # The self-check, and `off`'s only failure exit. Reached on every off,
    # including one that reverted nothing — that's why a no-op `off` can
    # still exit 1, on a plan the self-check finds stuck on the burn effort.
    #
    # RESIDUAL: `effort_of` inside `[[ ]]` is silent. A settings.json jq
    # cannot parse reads as "" here and passes — a file `on` would have
    # aborted on, since there the same jq sits on an assignment line `set -e`
    # can see.
    stuck=""
    while IFS= read -r -d '' f; do
      [[ "$(effort_of "$f")" == "$on_effort" ]] || continue
      [[ -n "${kept["$f"]:-}" ]] && continue
      stuck+="  $(rel "$f")"$'\n'
    done < <(settings_files)
    if [[ -n "$stuck" ]]; then
      show_status
      printf 'error: still on the burn effort after off:\n%s' "$stuck" >&2
      exit 1
    fi
    ;;
  *) usage ;;
esac

show_status
echo "Restart the Claude Code session to pick up the effort — it reaches that session's subagents too; the dispatch remap applies from the next Agent call."
echo "A warm spare (\`claude bg-spare\`) booted before this keeps the old effort — kill or claim it first (docs/effort-guide.md §Which model to launch each session on)."
# #568: inferred from session timestamps, not from Claude Code's documentation.
echo "So does the session the agents view already created for its launch line — launch one throwaway session from there first (/usage serves) so the next is created fresh."
exit 0
