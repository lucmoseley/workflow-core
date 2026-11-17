#!/bin/sh
# Starts watched binaries in a fixed order for call-cost.test.ts: one in a
# command substitution, and a node child whose own git start is that child's.
set -e
git --version >/dev/null
here="$(git rev-parse --is-inside-work-tree 2>/dev/null || echo outside)"
node -e "require('node:child_process').execFileSync('git', ['--version'])"
cat </dev/null
case "${1-}" in
  fail) exit 4 ;;
  noisy) echo stray >&2 ;;
esac
: "$here"
