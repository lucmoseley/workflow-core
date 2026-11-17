#!/bin/sh
# Starts watched binaries in a fixed order for call-cost-harness.test.ts: one in a
# command substitution, and a node child whose own cat start is that child's.
set -e
git --version >/dev/null
here="$(git rev-parse --is-inside-work-tree 2>/dev/null || echo outside)"
node -e "require('node:child_process').execFileSync('cat', [], { input: '' })"
cat </dev/null
case "${1-}" in
  fail) exit 4 ;;
  noisy) echo stray >&2 ;;
esac
: "$here"
