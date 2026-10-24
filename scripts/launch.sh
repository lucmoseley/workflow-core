#!/usr/bin/env bash
# One command -> model table for a hand-launched background session
# (mantahostels#1334: `/pick-next` had no launch route that could ever carry a model,
# so it silently inherited `~/.claude/settings.json`'s default model).
#
# Delegates the advisor attachment, the allowance ceiling and the duplicate
# check to scripts/dispatch-sessions.sh rather than re-implementing them.
#
# Usage:
#   scripts/launch.sh [--dry-run] [--force] [--no-advisor] [--model <alias>] \
#       <command> [args...]
#
# Examples:
#   scripts/launch.sh pick-next
#   scripts/launch.sh implement 1353
#   scripts/launch.sh --model opus pick-next
#   scripts/launch.sh --dry-run wayfinder 1114
#
# The table is scripts/lib/launch-models.sh (workflow-core#361). A kind it does not map —
# a future kind, ad-hoc work — launches on plain Opus, the safe default an
# unclassified session gets (mantahostels#1088's tie-break), not a silent miss.
#
# `--model <alias>` overrides the table for one launch, in either direction:
# the judgement to escalate one session stays with whoever is launching
# (mantahostels#1334's Q2), so this script must not foreclose it.
#
# Known residual (mantahostels#1334): the founder still has to remember to run this
# rather than launching from the agents view by hand.
#
# Exit codes: 2 usage error; otherwise whatever dispatch-sessions.sh returns,
# propagated verbatim (0 launched/dry-run, 3 refused on allowance, 4 refused
# as already dispatched).

set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/launch-models.sh
source "$here/lib/launch-models.sh"

usage() {
  printf 'usage: %s [--dry-run] [--force] [--no-advisor] [--model <alias>] <command> [args...]\n' "$0" >&2
}

# Flags ahead of <command> are either consumed here (--model) or forwarded
# verbatim to dispatch-sessions.sh, whose own flags must precede its
# <model> <prompt> pair — this script's <command> [args...] plays that role.
flags=()
override_model=""
while [[ $# -gt 0 && "$1" == --* ]]; do
  case "$1" in
    --model)
      [[ $# -ge 2 ]] || {
        usage
        exit 2
      }
      override_model="$2"
      shift 2
      ;;
    --model=*)
      override_model="${1#--model=}"
      shift
      ;;
    *)
      flags+=("$1")
      shift
      ;;
  esac
done

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

command="$1"
shift
args="$*"

case "$command" in
  card-close | roadmap-edit)
    printf 'NOTE: %s is normally invoked as a skill inside an existing session, not launched standalone (mantahostels#1334, which struck it from the Sonnet table because a skill inside a host cannot set the host'"'"'s model). Launching on plain Opus, same as any kind outside the Sonnet table.\n' \
      "$command" >&2
    ;;
esac

if ! model="$(launch_model_for "$command")"; then
  printf 'NOTE: %s is not one of the Sonnet-table kinds (mantahostels#1093) — launching on plain Opus, the default for ad-hoc or unclassified work.\n' \
    "$command" >&2
  model="$LAUNCH_MODEL_FALLBACK"
fi

[[ -n "$override_model" ]] && model="$override_model"

prompt="/$command"
[[ -n "$args" ]] && prompt="$prompt $args"

exec "$here/dispatch-sessions.sh" "${flags[@]}" "$model" "$prompt"
