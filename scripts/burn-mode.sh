#!/usr/bin/env bash
# Toggle burn mode: spend allowance on purpose. Haiku work runs on Opus 5.5
# at medium, and Opus work on Fable 5.2 at low. Off by default;
# docs/effort-guide.md §Burn mode is the rule, lib/model-table.js the table, and lib/burn-mode.js the marker.
#
#   scripts/burn-mode.sh on | off | status
#
# Three writes. The marker at `~/.claude/.burn-mode` — one per machine, beside
# the settings files below (#127) — is what scripts/lib/dispatch-rewrite.js
# and scripts/dispatch-sessions.sh read. And the `model` key in EVERY plan's
# settings.json — ~/.claude and each ~/.claude<digits>, by lib/plan-dirs.js —
# because the plans are one machine: the model a session launched with no
# model flag runs, moved through the table's burn layer (Opus 5.5 to Fable
# 5.2). Claude Code reads it at startup, so a running session keeps its model;
# the dispatch remap applies to the next Agent call at once. So `off` also
# resumes each live background session still on Fable on Opus
# (scripts/burn-off-sessions.js, #4992). One effort is written: Fable 5.2's
# `modelSettings` level, lowered while burn mode is on (#5004); a dispatch's
# rides on the call (#4919).
#
# `on` records each plan's model and Fable effort in the marker, and `off`
# puts THAT back — a plan the founder set to something else by hand is not
# flattened to the standing default.
#
# `off` WITH NO RECORD STILL REVERTS (#126). Without a record it falls back to
# the standing default, and only for a plan reading the burn model exactly: a
# plan on anything else is the founder's own choice and is left alone.
#
# Whatever route it took, a plan still reading the burn model when `off`
# finishes is an error and exits 1, keeping the marker: its record is what a
# second `off` restores from (#3877). `on` writes that record before it moves a
# plan, so a failed `on` too leaves a marker reading on, for `off` to undo.

set -euo pipefail

usage() {
  echo "usage: $(basename "$0") on|off|status" >&2
  exit 2
}
[[ $# -eq 1 ]] || usage

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
here="$(cd "$here" && pwd)"
# shellcheck source=scripts/lib/atomic-write.sh
source "$here/lib/atomic-write.sh"
lib="$here/lib/burn-mode.js"
table="$here/lib/model-table.js"
# A person runs this script, so the one way the marker can fail to resolve
# says so rather than exiting on `set -e` with nothing printed.
marker="$(node "$lib" marker)" ||
  {
    echo "error: cannot place the burn-mode marker — HOME is unset or relative" >&2
    exit 2
  }
# The standing session model, and what burn mode moves it to.
off_model="$(node "$table" session "")"
on_model="$(node "$table" session "" --burn)"
# The model whose `modelSettings` effort burn mode moves, its burn level, and
# the standing level a plan with no record is restored to.
session_effort="$(node "$table" session-effort)"
{
  read -r effort_model
  read -r on_effort
  read -r off_effort
} <<<"$session_effort"

# The plans' settings files, ONE ENTRY PER REAL FILE (#187). `~/.claude2` and
# `~/.claude3` hold symlinks to `~/.claude/settings.json` on the machine this
# serves (docs/environment.md §Shared config is one copy, symlinked), so three
# paths are one file.
#
# lib/burn-mode.js's `plans` lists them, the one listing its readBurnState
# reads too. The plan dirs come from lib/plan-dirs.js, whose `readdirSync`
# follows a symlinked HOME: a scan that did not would list no plan at all, and
# `on` would write an empty record, exiting 0 either way.
#
# A settings.json symlinked to nothing is NAMED, once, by the check below, and
# skipped.
#
# NUL-separated so a HOME with a space survives; a scratch HOME in a test can
# hold one.
home_real="$(realpath -- "$HOME")" || home_real="$HOME"
# Checked once up front: `< <(settings_files)` below hides the listing's exit,
# so an unreadable HOME would otherwise read as no plans and `on` would write
# an empty record, exiting 0.
node "$lib" plans >/dev/null || exit 2
settings_files() { node "$lib" plans --quiet; }
# rel <file> — the file as the founder names it, `.claude/settings.json`. A
# file resolving outside HOME keeps its absolute path.
rel() { printf '%s' "${1#"$home_real"/}"; }

# model_of <file> — the plan's session model, or "" where the key is absent.
model_of() { jq -r '.model // ""' "$1"; }

# effort_of <file> — the plan's Fable effort, or "" where the key is absent.
effort_of() { jq -r --arg m "$effort_model" '.modelSettings[$m].effortLevel // ""' "$1"; }

# burned <model> — what the burn layer makes of a plan's model, "" meaning
# the default session model.
burned() { node "$table" session "$1" --burn; }

show_status() {
  local on=0 f model expect shown basis
  [[ -f "$marker" ]] && on=1
  if [[ $on -eq 1 ]]; then echo "burn mode: on"; else echo "burn mode: off"; fi
  while IFS= read -r -d '' f; do
    model="$(model_of "$f")"
    shown="${model:-absent}"
    if [[ $on -eq 1 ]]; then
      # Judged against what `on` found there, so a Haiku plan it moved to Opus reads in step.
      basis="$model"
      if jq -e --arg f "$f" '.model | has($f)' "$marker" >/dev/null 2>&1; then
        basis="$(jq -r --arg f "$f" '.model[$f]' "$marker")"
      fi
      expect="$(burned "$basis")"
      [[ "${model:-$off_model}" == "$expect" ]] && expect=""
    else
      expect=""
      [[ "$model" == "$on_model" ]] && expect="$off_model"
    fi
    if [[ -z "$expect" ]]; then
      printf '  %-32s model=%s' "$(rel "$f")" "$shown"
    else
      printf '  %-32s model=%s  (not the %s model, %s)' "$(rel "$f")" "$shown" \
        "$([[ $on -eq 1 ]] && echo burn || echo standing)" "$expect"
    fi
    if [[ $on -eq 1 && "$(effort_of "$f")" != "$on_effort" ]]; then
      printf '  (%s effortLevel=%s, not the burn effort, %s)' "$effort_model" \
        "$(effort_of "$f")" "$on_effort"
    fi
    printf '\n'
  done < <(settings_files)
}

# write_model <file> <model> — replaces the live file through aw_write, so a
# jq slip never installs unparseable settings and no session reads a torn one.
# An empty model REMOVES the key. Returns non-zero where any step fails.
write_model() {
  aw_write "$1" jq -e --arg v "$2" '
    if $v == "" then del(.model) else .model = $v end' "$1"
}

# write_effort <file> <level> — the same for the Fable effort. An empty level
# removes the key.
write_effort() {
  aw_write "$1" jq -e --arg m "$effort_model" --arg v "$2" '
    if $v != "" then .modelSettings[$m].effortLevel = $v
    elif (.modelSettings[$m] | type) != "object" then .
    else del(.modelSettings[$m].effortLevel)
      | if .modelSettings[$m] == {} then del(.modelSettings[$m]) else . end
      | if .modelSettings == {} then del(.modelSettings) else . end
    end' "$1"
}

# set_effort <file> — `on`'s effort write.
set_effort() {
  write_effort "$1" "$on_effort" || {
    echo "error: could not write $effort_model effortLevel=$on_effort into $(rel "$1")" >&2
    exit 1
  }
}

# set_model <file> <model> — `on`'s write: abort naming the file, with the
# record already holding every plan, so `off` undoes whatever moved. `off` does
# NOT use this — it warns and carries on, so its self-check below is the one
# place a failed revert is reported from.
set_model() {
  write_model "$1" "$2" || {
    echo "error: could not write model=$2 into $1" >&2
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
    # prior; rebuilding the record now would overwrite it with the on-model
    # itself, so off would restore that rather than the founder's setting
    # (mantahostels#3547).
    if [[ -f "$marker" ]] && jq -e 'has("effort")' "$marker" >/dev/null 2>&1; then
      echo "burn mode is already on — no settings file touched"
    elif [[ -f "$marker" ]]; then
      # On since before #5004: its record holds no Fable effort, so it is
      # recorded now and lowered, and the model record left as it is.
      efforts='{}'
      while IFS= read -r -d '' f; do
        prior_effort="$(effort_of "$f")"
        efforts="$(jq -c --arg f "$f" --arg e "$prior_effort" '.[$f] = $e' <<<"$efforts")"
      done < <(settings_files)
      aw_write "$marker" jq -e --argjson e "$efforts" '.effort = $e' "$marker"
      while IFS= read -r -d '' f; do
        [[ "$(effort_of "$f")" == "$on_effort" ]] || set_effort "$f"
      done < <(settings_files)
    else
      # The record goes down before a single plan is moved: a failure after any
      # move would otherwise strand it on the burn model with no record, and
      # `off` would then flatten a hand-set plan to the standing default.
      mkdir -p "$(dirname "$marker")"
      record='{}' efforts='{}'
      while IFS= read -r -d '' f; do
        prior="$(model_of "$f")"
        record="$(jq -c --arg f "$f" --arg m "$prior" '.[$f] = $m' <<<"$record")"
        prior_effort="$(effort_of "$f")"
        efforts="$(jq -c --arg f "$f" --arg e "$prior_effort" '.[$f] = $e' <<<"$efforts")"
      done < <(settings_files)
      jq -n --argjson r "$record" --argjson e "$efforts" '{model: $r, effort: $e}' >"$marker"
      while IFS= read -r -d '' f; do
        prior="$(model_of "$f")"
        target="$(burned "$prior")"
        if [[ "$target" != "${prior:-$off_model}" || -z "$prior" ]]; then
          set_model "$f" "$target"
        fi
        [[ "$(effort_of "$f")" == "$on_effort" ]] || set_effort "$f"
      done < <(settings_files)
    fi
    ;;
  off)
    # `kept` holds the plans the record says were ALREADY on the burn model
    # before `on` ran — a deliberate setting, restored as such, and so exempt
    # from the self-check below, which would otherwise read them as a failed
    # revert.
    declare -A kept=()
    reverted=0 effort_stuck=""
    while IFS= read -r -d '' f; do
      # `has` rather than a non-empty value: a plan with no model key is
      # recorded as "", and that IS a record — the key was absent and is
      # removed again, rather than being reported as unrecorded.
      recorded=0 prior=""
      was_burning=0
      [[ "$(model_of "$f")" == "$on_model" ]] && was_burning=1
      if [[ -f "$marker" ]] && jq -e --arg f "$f" '.model | has($f)' "$marker" >/dev/null 2>&1; then
        recorded=1
        prior="$(jq -r --arg f "$f" '.model[$f]' "$marker")"
      fi
      if [[ $recorded -eq 1 ]]; then
        write_model "$f" "$prior" || echo "error: could not write $(rel "$f")" >&2
        reverted=1
        [[ "$prior" == "$on_model" ]] && kept["$f"]=1
      elif [[ "$(model_of "$f")" == "$on_model" ]]; then
        # No record for this plan — a marker lost between the two calls, or a
        # plan added since `on`.
        echo "no record for $(rel "$f") — restoring the standing model, $off_model"
        write_model "$f" "$off_model" || echo "error: could not write $(rel "$f")" >&2
        reverted=1
      fi
      # The Fable effort: the record put back, else, only on a plan this off
      # found on the burn model, the burn effort lowered back to standing. A
      # plan off the burn model keeps whatever effort it has (#5004). A failed
      # write is stuck, for the self-check below.
      target_effort="" restore=0
      if [[ -f "$marker" ]] && jq -e --arg f "$f" '.effort | has($f)' "$marker" >/dev/null 2>&1; then
        target_effort="$(jq -r --arg f "$f" '.effort[$f]' "$marker")" restore=1
      elif [[ $was_burning -eq 1 && "$(effort_of "$f")" == "$on_effort" ]]; then
        echo "no record for $(rel "$f") — restoring the standing $effort_model effort, $off_effort"
        target_effort="$off_effort" restore=1
      fi
      if [[ $restore -eq 1 ]]; then
        reverted=1
        write_effort "$f" "$target_effort" ||
          effort_stuck+="  $(rel "$f") ($effort_model effortLevel=$(effort_of "$f"))"$'\n'
      fi
    done < <(settings_files)
    [[ $reverted -eq 1 ]] || echo "burn mode was already off — no settings file touched"
    # The self-check, and `off`'s failure exit for a plan left burning. Reached on every off,
    # including one that reverted nothing — that's why a no-op `off` can
    # still exit 1, on a plan the self-check finds stuck on the burn model.
    #
    # RESIDUAL: `model_of` inside `[[ ]]` is silent. A settings.json jq
    # cannot parse reads as "" here and passes — a file `on` would have
    # aborted on, since there the same jq sits on an assignment line `set -e`
    # can see.
    stuck="$effort_stuck"
    while IFS= read -r -d '' f; do
      [[ "$(model_of "$f")" == "$on_model" ]] || continue
      [[ -n "${kept["$f"]:-}" ]] && continue
      stuck+="  $(rel "$f")"$'\n'
    done < <(settings_files)
    if [[ -n "$stuck" ]]; then
      show_status
      printf 'error: still on the burn model or effort after off:\n%s' "$stuck" >&2
      exit 1
    fi
    rm -f "$marker"
    # A running session keeps the model it started on, so each live one still
    # on Fable is resumed on Opus under its own id (#4992).
    node "$here/burn-off-sessions.js" || sessions_failed=1
    ;;
  *) usage ;;
esac

show_status
if [[ -n "${sessions_failed:-}" ]]; then
  echo "error: a live session is still on Fable — scripts/burn-off-sessions.js named it above; rerun that once it is free" >&2
  exit 1
fi
echo "Restart the Claude Code session to pick up the model — a session launched with no model flag runs it; the dispatch remap applies from the next Agent call."
echo "A warm spare (\`claude bg-spare\`) booted before this keeps the old model — kill or claim it first (docs/effort-guide.md §Which model to launch each session on)."
# #568: inferred from session timestamps, not from Claude Code's documentation.
echo "So does the session the agents view already created for its launch line — launch one throwaway session from there first (/usage serves) so the next is created fresh."
exit 0
