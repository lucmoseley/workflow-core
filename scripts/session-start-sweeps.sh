#!/usr/bin/env bash
set -uo pipefail

command -v node >/dev/null 2>&1 || exit 0

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
here="$(cd "$here" && pwd)"
# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"
# shellcheck source=scripts/lib/marker-root.sh
source "$here/lib/marker-root.sh"
# shellcheck source=scripts/lib/detach.sh
source "$here/lib/detach.sh"

[[ -n "${VITEST:-}" ]] || detach node "$here/session-scope.js"

outlive_live() {
  [[ -z "${VITEST:-}" ]] || return 0
  outlive "${CLAUDE_CODE_SESSION_ID:-}" "$OUTLIVE_CEILING_S" "$@"
}

if command -v git >/dev/null 2>&1 && [[ -z "${VITEST:-}" ]]; then
  gc_root="$(gr_root)"
  rm -f "$gc_root/.git/gc.log"
  outlive_live git -C "$gc_root" gc --auto
fi

outlive_live node "$here/retire-stale-containers.js"

outlive_live node "$here/lib/scratch-sweep.js"

outlive_live node "$here/report-close-check-reading.js"

outlive_live node "$here/report-suite-queue-wait.js"

outlive_live node "$here/report-arch-scan-due.js"

outlive_live node "$here/repo-checks.js"

outlive_live node "$here/report-round-check-reading.js"

outlive_live --log "$(gr_markers_dir)/.lander.log" node "$here/start-lander.js"

outlive_live env WFC_NOTIFY_PERSIST=1 node "$here/check-landing-stall.js" --notify

outlive_live node "$here/report-flip-line-reading.js"

outlive_live node "$here/report-heresy-sweep-due.js"

outlive_live node "$here/start-orphan-sweep-timer.js"

outlive_live node "$here/claude-child.js" chrome-close --sweep

WFC_USER_MANAGER="${OUTLIVE_MANAGER-}" node "$here/check-self-throttling.js" --notify || true

exit 0
