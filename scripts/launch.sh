#!/usr/bin/env bash
set -euo pipefail

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
here="$(cd "$here" && pwd)"
# shellcheck source=scripts/lib/launch-models.sh
source "$here/lib/launch-models.sh"

usage() {
  printf 'usage: %s [--dry-run] [--force] [--no-advisor] [--model <alias>] [--into <worktree>] <command> [args...]\n' "$0" >&2
}

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
    --into)
      [[ $# -ge 2 ]] || {
        usage
        exit 2
      }
      flags+=("$1" "$2")
      shift 2
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
    printf 'NOTE: %s is normally invoked as a skill inside an existing session, not launched standalone (mantahostels#1334: a skill inside a host cannot set the host'"'"'s model). Launching on plain Opus, same as any kind outside the Haiku table.\n' \
      "$command" >&2
    ;;
esac

if ! model="$(launch_model_for "$command")"; then
  printf 'NOTE: %s is not one of the Haiku-table kinds (mantahostels#1093, #4919) — launching on plain Opus, the default for ad-hoc or unclassified work.\n' \
    "$command" >&2
  model="$LAUNCH_MODEL_FALLBACK"
fi

[[ -n "$override_model" ]] && model="$override_model"

prompt="/$command"
[[ -n "$args" ]] && prompt="$prompt $args"

exec "$here/dispatch-sessions.js" "${flags[@]}" "$model" "$prompt"
