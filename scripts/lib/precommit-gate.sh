# shellcheck shell=sh
# Usage: . scripts/lib/precommit-gate.sh, then one staged_gate call per gate.
# Sourced, never run, by a POSIX sh hook under `set -e`.

staged_read=""
staged_names() {
  [ -z "$staged_read" ] || return 0
  sn_file="$(mktemp)" || sn_file=""
  sn_status=0
  if [ -n "$sn_file" ]; then
    git diff --cached --name-status --no-renames -z >"$sn_file" || sn_status=$?
  else
    sn_status=1
  fi
  if [ "$sn_status" -ne 0 ]; then
    [ -z "$sn_file" ] || rm -f "$sn_file"
    echo "pre-commit: could not read this commit's staged paths from git — refusing, since no gate could arm." >&2
    exit 1
  fi
  staged_entries="$(tr '\000' '\n' <"$sn_file" | paste - -)"
  rm -f "$sn_file"
  staged_paths="$(printf '%s\n' "$staged_entries" | cut -f2-)"
  staged_read=1
}

armed() {
  staged_names
  armed_paths=""
  [ -n "$1" ] && [ -n "$staged_paths" ] || return 1
  armed_paths="$(printf '%s\n' "$staged_paths" | grep -E -e "$1")" || :
  [ -n "$armed_paths" ]
}

armed_live() {
  printf '%s\n' "$armed_paths" | while IFS= read -r al_p; do
    [ -n "$al_p" ] || continue
    [ "${1:-}" = "--index" ] || [ -f "$al_p" ] || continue
    if printf '%s\n' "$staged_entries" | grep -qxF -e "A	$al_p" -e "M	$al_p"; then
      printf '%s\n' "$al_p"
    fi
  done
}

GATE_SHELL_CANDIDATE='^\.husky/[^/.]+(\.local)?$|\.(sh|bash)$|(^|/)[^/.]+$'

armed_shell() {
  armed "$GATE_SHELL_CANDIDATE" || return 1
  as_paths="$(printf '%s\n' "$armed_paths" | node "${WFC_PLUGIN_ROOT:-.}/scripts/lib/formatters.js" shell-files --index)" || {
    echo "pre-commit: scripts/lib/formatters.js could not list this commit's shell files, so the shell gate refused it." >&2
    exit 1
  }
  armed_paths="$as_paths"
  [ -n "$armed_paths" ]
}

tool_gate() {
  tool_paths="$(armed_live "${3:-}")"
  [ -n "$tool_paths" ] || return 1
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "pre-commit: $1 is not on PATH — its gate is SKIPPED, this commit is NOT blocked." >&2
    echo "  npm install does not supply it; $2" >&2
    tg_status=0
    tg_ci="$(node "${WFC_PLUGIN_ROOT:-.}/scripts/lib/ci-runs.js" "$1" 2>/dev/null)" || tg_status=$?
    case "$tg_status:$tg_ci" in
      0:ci:) echo "  No workflow under .github/workflows/ runs $1, so nothing catches what this lets through." >&2 ;;
      0:ci:*) echo "  $1 runs in ${tg_ci#ci:}, which can catch what this lets through when it next runs." >&2 ;;
      2:*) ;;
      *) echo "  Could not read which workflows run $1: scripts/lib/ci-runs.js failed." >&2 ;;
    esac
    return 1
  fi
}

with_lines() {
  wl_list="$1"
  shift
  while IFS= read -r wl_line; do
    [ -z "$wl_line" ] || set -- "$@" "$wl_line"
  done <<WL_EOF
$wl_list
WL_EOF
  "$@"
}

skip_undeclared() {
  su_status=$?
  if [ "$su_status" -ge 2 ]; then
    exit 1
  fi
  return "$su_status"
}

GATE_TMPDIRS=""

gate_cleanup() {
  gate_list="$GATE_TMPDIRS"
  GATE_TMPDIRS=""
  printf '%s' "$gate_list" | while IFS= read -r gate_t; do
    if [ -n "$gate_t" ]; then
      rm -rf "$gate_t"
    fi
  done
}

trap 'gate_cleanup' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

gate_tmpdir() {
  GATE_DIR="$(mktemp -d)"
  GATE_TMPDIRS="$GATE_TMPDIRS$GATE_DIR
"
}

gate_stage_out() {
  gate_dir="$1"
  shift
  gate_missing=0
  GATE_MISSING=""
  GATE_DELETED=""
  for gate_spec in "$@"; do
    gate_opt=0
    gate_p="$gate_spec"
    case "$gate_p" in
      opt:*)
        gate_opt=1
        gate_p="${gate_p#opt:}"
        ;;
    esac
    gate_out="$gate_dir/$(basename "$gate_p")"
    if ! git cat-file -p ":$gate_p" >"$gate_out" 2>/dev/null; then
      if [ "$gate_opt" -eq 1 ]; then
        rm -f "$gate_out"
      else
        gate_missing=1
        GATE_MISSING="$GATE_MISSING, $gate_p"
        gate_del_status=0
        git --literal-pathspecs diff --cached --diff-filter=D \
          --name-only -z -- "$gate_p" >"$gate_dir/.gate-deleted" \
          2>/dev/null || gate_del_status=$?
        gate_del="$(tr -d '\000' <"$gate_dir/.gate-deleted")"
        if [ "$gate_del_status" -ne 0 ]; then
          gate_del=""
          echo "pre-commit: could not ask git whether $gate_p is deleted by this commit — treating it as merely absent." >&2
        fi
        if [ -n "$gate_del" ]; then
          GATE_DELETED="$GATE_DELETED, $gate_p"
        fi
      fi
    fi
  done
  return "$gate_missing"
}

gate_skip() {
  echo "pre-commit: skipped the $1 check — not readable from the index: $2." >&2
}

gate_skip_missing() {
  gate_skip "$1" "${GATE_MISSING#, }"
}

gate_refuse_deleted() {
  echo "pre-commit: the $1 check reads ${GATE_DELETED#, }, and this commit DELETES it — refusing." >&2
  echo "  That is not apparatus missing: the file is a gate's own input, so removing it is the fault, not a reason to skip." >&2
  echo "  Keep it: leave the path out of the commit's pathspec, or restore it with 'git checkout HEAD -- <path>' — safe here, a deleted file holding no parallel session's edit." >&2
  echo "  Renaming it? git reports a rename as a deletion here, so this fires on one too — move the gate's path list in the same commit, behind the escape." >&2
  echo "  Retiring it deliberately? The escape is the founder's to set, never an agent's (#916): an agent stops and asks. The founder runs, from their own terminal, WFC_ALLOW_GATE_INPUT_DELETE=1 git commit -m '…' -- <paths>, retiring the gate reading it in the same commit." >&2
}

gate_check_deleted() {
  [ -n "$GATE_DELETED" ] || return 0
  if [ -z "${WFC_ALLOW_GATE_INPUT_DELETE:-}" ]; then
    gate_refuse_deleted "$1"
    exit 1
  fi
  echo "pre-commit: WFC_ALLOW_GATE_INPUT_DELETE is set — allowing this commit to delete ${GATE_DELETED#, }." >&2
}

# #5405
drops_module() {
  node "${WFC_PLUGIN_ROOT:-.}/scripts/lib/module-retirement.js" "$1" || return 1
  echo "pre-commit: this commit drops the $1 module from .claude/workflow-core.json — the $2 check stands down." >&2
}

# staged_gate <label> <mode> <exit> <paths> <command> <advice>
#
#   <label>    the noun in the skip line: "digest-version", "superseded-needle".
#   <mode>     live — the checker's output goes straight through;
#              hold — it is captured and replayed on failure only, for a checker
#                     that prints an OK line on every run.
#   <exit>     status — refuse with the checker's own code, so BROKEN (2) stays
#                       distinguishable from a finding (1);
#              a literal number — refuse with that, for a gate where the
#                       checker's BROKEN *is* the finding.
#   <paths>    space-separated repo paths to stage out, `opt:`-prefixed for optional.
#   <command>  eval'd with $sg_dir bound to the staged copies' directory.
#   <advice>   printed to stderr after a failure; "" for none.
#
# HARD-FAILING, always: apparatus missing is not a finding, so an unreadable
# blob warns and passes, but any checker verdict short of 0 refuses the commit.
# A required path THIS COMMIT DELETES is not apparatus missing and refuses with
# 1 — never the checker's own status, no checker having run (mantahostels#2894).
#
# Sets $sg_status and, in hold mode, $sg_out.
staged_gate() {
  sg_label="$1"
  sg_mode="$2"
  sg_exit="$3"
  sg_paths="$4"
  sg_cmd="$5"
  sg_advice="$6"

  gate_tmpdir
  sg_dir="$GATE_DIR"
  sg_status=0
  sg_out=""

  if ! with_lines "$(printf '%s\n' "$sg_paths" | tr '[:blank:]' '[\n*]')" gate_stage_out "$sg_dir"; then
    gate_check_deleted "$sg_label"
    gate_skip_missing "$sg_label"
    return 0
  fi

  if [ "$sg_mode" = "hold" ]; then
    sg_out="$(eval "$sg_cmd" 2>&1)" || sg_status=$?
    [ "$sg_status" -eq 0 ] || printf '%s\n' "$sg_out" >&2
  else
    eval "$sg_cmd" || sg_status=$?
  fi

  if [ "$sg_status" -ne 0 ]; then
    [ -z "$sg_advice" ] || printf '%s\n' "$sg_advice" >&2
    if [ "$sg_exit" = "status" ]; then
      exit "$sg_status"
    fi
    exit "$sg_exit"
  fi
}

lander_batch() { [ "${wfc_gates:-all}" = batch ]; }

lander_tested() { [ "${wfc_gates:-all}" = tested ]; }

index_tree() {
  git write-tree && return 0
  echo "pre-commit: git could not write this commit's tree, so no gate's verdict can be held to it and the commit is refused." >&2
  return 2
}

# #5889
index_held() {
  ih_now="$(index_tree)" || return "$?"
  [ "$ih_now" != "$1" ] || return 0
  echo "pre-commit: a step after the gates changed what this commit stages, so it is refused:" >&2
  git diff-tree -r --no-renames --name-status "$1" "$ih_now" |
    while IFS= read -r ih_line; do printf '  %s\n' "$ih_line"; done >&2
  echo "  No gate judged those paths. Unstage what you did not mean to commit (\`git restore --staged -- <path>\`), then commit again." >&2
  return 1
}
