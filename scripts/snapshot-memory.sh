#!/usr/bin/env bash
set -euo pipefail

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
here="$(cd "$here" && pwd)"
# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"

default_src() {
  command -v node >/dev/null 2>&1 || {
    echo "snapshot-memory: node not found; cannot derive the default store path" >&2
    exit 1
  }
  node -e '
		const path = require("node:path");
		const { slugForRepo } = require(process.argv[1]);
		const { configDir } = require(process.argv[2]);
		console.log(path.join(configDir(), "projects", slugForRepo(), "memory"));
	' "$here/lib/project-slug.js" "$here/lib/config-dir.js"
}

src="${1:-$(default_src)}"
[[ -d "$src" ]] || {
  echo "snapshot-memory: no such store: $src" >&2
  exit 1
}

repo="$(gr_worktree_root)"
out="$repo/snapshots/claude-memory-$(date -u +%Y-%m-%d).tar.gz"
mkdir -p "$(dirname "$out")"

# lucmoseley/mantahostels#636
if [[ -e "$out" ]] && [[ -z "${WFC_SNAPSHOT_FORCE:-}" ]]; then
  have="$(tar -tzf "$out" | grep -c '[^/]$')"
  want="$(find "$src" -type f | wc -l)"
  if [[ "$want" -lt "$have" ]]; then
    echo "snapshot-memory: store has $want files, today's snapshot has $have." >&2
    echo "  Refusing to overwrite it. Deliberate? WFC_SNAPSHOT_FORCE=1 $0" >&2
    exit 1
  fi
fi

tar -cf - --sort=name --numeric-owner -C "$(dirname "$src")" "$(basename "$src")" |
  gzip -n9 >"$out"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$out" -C "$tmp"
diff -r "$src" "$tmp/$(basename "$src")"

echo "snapshot: $out"
echo "  files:   $(find "$src" -type f | wc -l)"
echo "  bytes:   $(wc -c <"$out") compressed"
echo "  sha256:  $(sha256sum "$out" | cut -d' ' -f1)"
echo "  restore: tar -xzf $(basename "$out") -C <dest>"
