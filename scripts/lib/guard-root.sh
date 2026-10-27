#!/usr/bin/env bash
# The repo root, in the one spelling every guard uses (mantahostels#1905), and
# the Claude Code config dir beside it (#2095).
#
# SOURCED, NEVER RUN. Three functions, no state, no dependencies.
#
# WHY ITS OWN FILE, rather than a function in guard-log.sh: that is a call
# site, so a helper there is unreachable from something below it, and a hook
# whose guard-log.sh is detached would fall back to a second copy of the expression.
# gr_config_dir is the one exception: guard-log.sh keeps a copy, since its
# detached fail-open log still needs a real config dir (#2095).
#
# BYTE-IDENTICAL OUTPUT IS THE CONSTRAINT, twice over. lib/guard-entry.js
# writes a latch path clear-rule-latch.sh globs for, and gl_log derives the error-log directory
# arbiter-core.js's stateDir() must agree with — so `scripts/lib/host-root.js`,
# the JS half of this seam, strips the same trailing slash and dereferences the
# same symlinks, and the two are changed together or not at all.
#
# SYMLINKS ARE DEREFERENCED (#1). `git rev-parse --show-toplevel` already
# answers with a physical path; CLAUDE_PROJECT_DIR does not, so a harness
# pointed at a symlink to the checkout would otherwise slug to a second state
# directory for one tree. `cd -P` in a subshell rather than `realpath`, because
# the builtin costs a fork and realpath costs a fork AND an exec, on a path
# every guard walks. A root that cannot be entered — not yet created, or
# unreadable — keeps the spelling it came in with.
#
# NOT MEMOISED. Every caller spells it `$(gr_root)`, so a cache would be written
# in the substitution's subshell and thrown away with it: the fork counted as
# saved would still happen. A memo needs the callers changed to an
# out-parameter first.
#
# THE GIT LIMB'S FAILURE IS SWALLOWED, and structurally must be: gl_log calls
# this to find the directory it logs to, so a gl_log from here would recurse.
# The fallback is $PWD, which is the repo root on every wired path — a hook runs
# from it — and wrong only for a guard hand-run from a subdirectory.
gr_root() {
  local root real
  root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")}"
  # Only a trailing slash, and never the last one: a repo rooted at / would
  # otherwise normalise to the empty string.
  [[ "$root" == / ]] || root="${root%/}"
  real="$(gr_physical "$root")" && root="$real"
  printf '%s' "$root"
}

# gr_physical <dir> — <dir> with its symlinks dereferenced by `cd -P`. Non-zero,
# printing nothing, where <dir> cannot be entered. Call it only as `$(gr_physical
# …)`: the substitution's subshell is what keeps the `cd` from moving the caller,
# so the root costs one fork rather than two.
#
# CDPATH='' because `cd` ECHOES the directory it resolved whenever it resolved
# through CDPATH, which applies to any non-absolute argument — and
# CLAUDE_PROJECT_DIR is taken verbatim and never required to be absolute. A
# session with CDPATH set would otherwise get the root back twice over, which
# guard-log.sh slugs into a directory name nothing else uses, breaking the
# byte-identity with hostRoot(), whose realpathSync ignores CDPATH, so this
# limb has no JS twin.
gr_physical() {
  CDPATH='' cd -P -- "$1" >/dev/null 2>&1 && printf '%s' "$PWD"
}

# gr_config_dir <var> — lib/config-dir.js's configDir() into <var>, no fork: an
# empty CLAUDE_CONFIG_DIR is set, as Claude Code reads it (config-dir.js says
# why). Empty answers `.`, since a shell join onto "" would make
# `/settings.json` where path.join makes `settings.json`. Home is os.homedir()'s:
# HOME where set, an empty one giving a relative `.claude`, and the password
# database through `~` where unset.
# No local: one would shadow a caller's <var> of the same name.
gr_config_dir() {
  if [[ -n "${CLAUDE_CONFIG_DIR+set}" ]]; then
    printf -v "$1" '%s' "${CLAUDE_CONFIG_DIR:-.}"
  elif [[ -n "${HOME+set}" ]]; then
    printf -v "$1" '%s' "${HOME:+$HOME/}.claude"
  else
    printf -v "$1" '%s' ~/.claude
  fi
}
