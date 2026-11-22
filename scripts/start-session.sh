#!/usr/bin/env bash
set -uo pipefail

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
here="$(cd "$here" && pwd)"
# lucmoseley/mantahostels#3111
# shellcheck source=scripts/lib/interop-probe.sh
source "$here/lib/interop-probe.sh" 2>/dev/null
# shellcheck source=scripts/lib/bg-launch-id.sh
source "$here/lib/bg-launch-id.sh" || exit 1

if [[ $# -gt 0 && "$1" != -* ]]; then
  name="$1"
  shift
else
  name="hand-$(date -u +%Y%m%d-%H%M%S)"
fi

if command -v claude_interop_wedged >/dev/null 2>&1 && claude_interop_wedged; then
  printf 'REFUSED: the WSL interop bridge is wedged, so `claude` would hang rather than start.\n' >&2
  claude_interop_recovery_text
  exit 5
fi

dir="$(node "$here/session-checkout.js" cut "$name")" || exit 1
cd "$dir" || exit 1
# #4595
roots="$(node "$here/lib/inherited-roots.js")" || {
  printf 'start session: the root variables to clear would not read; %s stays cut for a retry.\n' "$dir" >&2
  exit 1
}
read -ra roots <<<"$roots"
unset "${roots[@]}"
launched="$("${WFC_CLAUDE_BIN:-claude}" --bg --agent claude --name "$name" "$@")" || {
  # claude-route-exempt: only text
  printf 'start session: `claude --bg` failed in %s, which stays cut for a retry:\n%s\n' "$dir" "$launched" >&2
  exit 1
}
id="$(printf '%s\n' "$launched" | bg_launch_id)"
if [[ -z "$id" ]]; then
  # claude-route-exempt: only text
  printf 'start session: no job id in what `claude --bg` printed; attach from `claude agents`:\n%s\n' "$launched" >&2
  exit 1
fi
exec "${WFC_CLAUDE_BIN:-claude}" attach "$id"
