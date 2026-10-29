#!/usr/bin/env bash
# The review hold's stamp: the file in the git directory through which
# scripts/review-hold-gate.sh hands a passed commit's `Review-Tier:` value to
# scripts/review-tier-trailer.sh (#3664). This is its one name.
#
# SOURCED, NEVER RUN.

# review_tier_stamp <gitdir> — print the stamp's path in <gitdir>.
review_tier_stamp() { printf '%s/wfc-review-tier\n' "$1"; }
