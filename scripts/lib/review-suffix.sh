#!/usr/bin/env bash
# The session suffix on the two review-axis Artefact paths (mantahostels#2220, mantahostels#3458).
#
# SOURCED, NEVER RUN.
#
# Three routes name those paths — guard-review-rules.sh, inject-tracker-docs.sh
# and concision-backstop.sh — and a review whose routes disagree dispatches its
# axes to one file name and reads them back from another. review-suffix.test.ts
# runs all three on one id and holds them to one answer. A fourth,
# inject-review-tier.sh, names the focus and attack paths on the same suffix
# (#1621).
#
# Prints `-` and the first 8 characters of the id, anything outside
# [A-Za-z0-9_-] replaced by `_` first because the id becomes part of a path.
# Prints nothing for an empty id, so the caller falls back to the bare name.
#
# 8, never the full uuid: a full id at both paths costs ~56 chars of the
# injector's payload budget (scripts/check-injector-margin.sh).
#
# guard-scratch-overwrite.sh suggests the same suffix for any `.claude/tmp/`
# scratch name (#1167), so a session told one convention meets one spelling.
#
# A caller whose source of this file failed gets the bare name too, because the
# substitution comes back empty — mantahostels#2220's collision, for every session at once.
review_suffix() {
  local sid="${1//[^A-Za-z0-9_-]/_}"
  sid="${sid:0:8}"
  printf '%s' "${sid:+-$sid}"
}
