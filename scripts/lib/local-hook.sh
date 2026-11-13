# shellcheck shell=sh
# local-hook.sh — the check a core hook runs before it sources an adopter's own
# `.husky/<hook>.local` (#437, #5142). SOURCED, NEVER RUN, and POSIX sh.
#
# wfc_local_hook_refuse_missing <local file> <headline>: every `scripts/…` or `.claude/…`
# path the local file names ending .js/.cjs/.mjs/.sh/.py must exist from the repo top, or the
# hook exits 1 printing <headline>, then each missing path, so a gate whose script has gone
# missing refuses every commit rather than passing silently (#426). A path
# spelled through $WFC_PLUGIN_ROOT is a core script under the plugin, and
# skipped. The scan is lexical: a path built in a variable goes unseen, and one
# through an alias of $WFC_PLUGIN_ROOT is checked against the repo top.
#
# Word by word, split on blanks and on ; | & < >, so a $WFC_PLUGIN_ROOT path is
# dropped alone. A path counts only at the word's start or after a quote, `=`,
# `./`, a variable or a `$(…)`. Keep it in step with
# scripts/husky-script-refs.test.ts's SCRIPT_PATH; a grep pattern's `\.` stops
# the path short of its extension, so an arming pattern never matches.
#
# The headline is the caller's literal, so scripts/commit-gate-refusals.json
# finds each hook's own refusal in that hook's source.
wfc_local_hook_refuse_missing() {
  lh_missing="$(sed -e '/^[[:space:]]*#/d' -e 's/[[:space:]]#.*//' "$1" |
    tr -s ' \t;|&<>' '\n' |
    grep -v 'WFC_PLUGIN_ROOT' |
    sed -nE 's#^([^/]*[^/A-Za-z0-9_.-]|[^/]*(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?"?|[)"]+|\.)/)?((\.claude|scripts)/[A-Za-z0-9_./-]*).*$#\3#p' |
    grep -E '\.(c?js|mjs|sh|py)$' |
    sort -u |
    while IFS= read -r lh_path; do
      [ -e "$lh_path" ] || printf '%s\n' "$lh_path"
    done)"
  [ -z "$lh_missing" ] && return 0
  echo "$2" >&2
  printf '%s\n' "$lh_missing" | sed 's/^/  /' >&2
  echo "  Every commit is refused until it exists or the local file stops naming it (#437)." >&2
  exit 1
}
