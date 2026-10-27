#!/usr/bin/env bash
# Snapshot Claude Code's auto-memory store into snapshots/ as one gzipped tarball.
#
# The store (~/.claude/projects/<project>/memory/) is not a git repository and
# Claude Code syncs it nowhere, so a WSL reset loses every memory (mantahostels#636). This
# is the off-machine copy: committed and pushed, it survives the machine.
#
# Re-runnable on purpose, but not routine: "autoMemoryEnabled": false in
# .claude/settings.json (mantahostels#642) keeps the store from growing, so
# snapshots/claude-memory-2026-08-22.tar.gz (156 files) is the permanent copy. Run this again only before a step that deletes store files.
#
# One tarball rather than the files verbatim: this repo's agents grep the tree
# constantly, and mantahostels#637 found 34 of the 115 memories redundant with the repo and
# 3 outright stale-wrong. Committed as markdown they would answer every future
# `grep -r` with a frozen copy of a project fact. A tarball is inert to grep.
set -euo pipefail

here="${BASH_SOURCE[0]%/*}"
[[ "$here" == "${BASH_SOURCE[0]}" ]] && here=.
here="$(cd "$here" && pwd)"
# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"

# Shell cannot `require` lib/project-slug.js, so this shells out to it rather
# than restating the slugging rule in sed/parameter expansion (mantahostels#2008),
# and takes the config root from lib/config-dir.js in the same call (#2095).
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
[ -d "$src" ] || {
  echo "snapshot-memory: no such store: $src" >&2
  exit 1
}

# The HOST repo, never this file's own location — in a plugin install this
# script ships in the plugin cache, not the host repo (#1).
repo="$(gr_root)"
out="$repo/snapshots/claude-memory-$(date -u +%Y-%m-%d).tar.gz"
mkdir -p "$(dirname "$out")"

# Refuse to shrink today's snapshot. Re-running after a deletion would otherwise
# overwrite the copy taken before it — the one failure this whole file exists to
# prevent, and silent, since the run reads as a success either way.
if [ -e "$out" ] && [ -z "${WFC_SNAPSHOT_FORCE:-}" ]; then
  have="$(tar -tzf "$out" | grep -c '[^/]$')"
  want="$(find "$src" -type f | wc -l)"
  if [ "$want" -lt "$have" ]; then
    echo "snapshot-memory: store has $want files, today's snapshot has $have." >&2
    echo "  Refusing to overwrite it. Deliberate? WFC_SNAPSHOT_FORCE=1 $0" >&2
    exit 1
  fi
fi

# gzip -n drops the header timestamp, so re-running on an unchanged store
# reproduces the same bytes instead of showing a spurious diff.
tar -cf - --sort=name --numeric-owner -C "$(dirname "$src")" "$(basename "$src")" |
  gzip -n9 >"$out"

# Verify by restoring: an archive nobody has unpacked is not yet insurance.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$out" -C "$tmp"
diff -r "$src" "$tmp/$(basename "$src")"

echo "snapshot: $out"
echo "  files:   $(find "$src" -type f | wc -l)"
echo "  bytes:   $(wc -c <"$out") compressed"
echo "  sha256:  $(sha256sum "$out" | cut -d' ' -f1)"
echo "  restore: tar -xzf $(basename "$out") -C <dest>"
