#!/usr/bin/env bash
# Toggle burn mode: spend allowance on purpose. Off by default;
# docs/effort-guide.md §Burn mode is the rule, lib/model-routing.json the
# values, lib/model-table.js the table, and lib/burn-mode.js the marker.
#
#   scripts/burn-mode.sh on | off | status
#
# The marker at `~/.claude/.burn-mode` — one per machine, beside the settings
# files below (workflow-core#127) — is what scripts/lib/dispatch-rewrite.js and
# scripts/dispatch-sessions.sh read; its presence is the state. And EVERY
# plan's settings.json — ~/.claude and each ~/.claude<digits>, by
# lib/plan-dirs.js, because the plans are one machine — takes the mode's
# writes from the model table's `settings` mode: its `model`, and the effort
# under each `modelSettings` id the mode names. Every other key is left alone,
# and a hand-set `model` or effort is overwritten: the routing file is the one
# route to a standing value (#5005).
#
# Both directions always write, so `on` while on and `off` while off re-apply
# the mode — the way an edited routing file is applied. A routing file that
# will not load stops the switch, exit 2, before any write.
#
# Claude Code reads settings at startup, so a running session keeps its model;
# the dispatch remap applies to the next Agent call at once. So `off` also
# resumes each live background session still on a model only burn mode uses
# (scripts/burn-off-sessions.js, workflow-core#4992).
#
# `off` self-checks: a plan whose settings still depart from the standard
# writes when it finishes is an error and exits 1, keeping the marker, so a
# second `off` retries it (workflow-core#3877).

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

# The plans' settings files, ONE ENTRY PER REAL FILE (workflow-core#187). `~/.claude2` and
# `~/.claude3` hold symlinks to `~/.claude/settings.json` on the machine this
# serves (docs/environment.md §Shared config is one copy, symlinked), so three
# paths are one file.
#
# lib/burn-mode.js's `plans` lists them, the one listing its readBurnState
# reads too. The plan dirs come from lib/plan-dirs.js, whose `readdirSync`
# follows a symlinked HOME: a scan that did not would list no plan at all.
#
# A settings.json symlinked to nothing is NAMED, once, by the check below, and
# skipped.
#
# NUL-separated so a HOME with a space survives; a scratch HOME in a test can
# hold one.
home_real="$(realpath -- "$HOME")" || home_real="$HOME"
# Checked once up front: `< <(settings_files)` below hides the listing's exit,
# so an unreadable HOME would otherwise read as no plans.
node "$lib" plans >/dev/null || exit 2
settings_files() { node "$lib" plans --quiet; }
# rel <file> — the file as the founder names it, `.claude/settings.json`. A
# file resolving outside HOME keeps its absolute path.
rel() { printf '%s' "${1#"$home_real"/}"; }

# show_status — the mode, then each plan and how it departs from the mode's
# writes. A report that cannot run (exit 2) stops the script.
show_status() {
  local flag=() rc=0
  if [[ -f "$marker" ]]; then
    echo "burn mode: on"
    flag=(--burn)
  else
    echo "burn mode: off"
  fi
  node "$lib" report "${flag[@]}" || rc=$?
  [[ $rc -le 1 ]] || exit 2
}

# apply <file> <settings-json> — the mode's writes merged into the live file
# through aw_write, so a jq slip never installs unparseable settings and no
# session reads a torn one. Returns non-zero where any step fails.
apply() {
  aw_write "$1" jq -e --argjson s "$2" '
    .model = $s.model
    | .modelSettings = ((.modelSettings // {}) * $s.modelSettings)' "$1"
}

# writes <flag…> — the mode's settings writes, or exit 2 naming the routing
# file's fault, before anything is written.
writes() {
  node "$table" settings "$@" || {
    echo "error: the routing file will not load — no settings file touched" >&2
    exit 2
  }
}

case "$1" in
  status)
    show_status
    exit 0
    ;;
  on)
    settings="$(writes --burn)"
    mkdir -p "$(dirname "$marker")"
    : >"$marker"
    while IFS= read -r -d '' f; do
      apply "$f" "$settings" || {
        echo "error: could not write the burn settings into $(rel "$f")" >&2
        exit 1
      }
    done < <(settings_files)
    ;;
  off)
    settings="$(writes)"
    while IFS= read -r -d '' f; do
      apply "$f" "$settings" || echo "error: could not write $(rel "$f")" >&2
    done < <(settings_files)
    # The self-check, and `off`'s failure exit for a plan left out of step;
    # the marker stays, so a second `off` retries it.
    rc=0
    node "$lib" report >/dev/null || rc=$?
    if [[ $rc -ne 0 ]]; then
      show_status
      echo "error: a plan above still departs from the standard settings after off — burn mode stays on" >&2
      exit 1
    fi
    rm -f "$marker"
    # A running session keeps the model it started on, so each live one still
    # on a model only burn mode uses is resumed under its own id (workflow-core#4992).
    node "$here/burn-off-sessions.js" || sessions_failed=1
    ;;
  *) usage ;;
esac

show_status
if [[ -n "${sessions_failed:-}" ]]; then
  echo "error: a live session is still on a model only burn mode uses — scripts/burn-off-sessions.js named it above; rerun that once it is free" >&2
  exit 1
fi
echo "Restart the Claude Code session to pick up the model — a session launched with no model flag runs it; the dispatch remap applies from the next Agent call."
echo "A warm spare (\`claude bg-spare\`) booted before this keeps the old model — kill or claim it first (docs/effort-guide.md §Which model to launch each session on)."
# workflow-core#568: inferred from session timestamps, not from Claude Code's documentation.
echo "So does the session the agents view already created for its launch line — launch one throwaway session from there first (/usage serves) so the next is created fresh."
exit 0
