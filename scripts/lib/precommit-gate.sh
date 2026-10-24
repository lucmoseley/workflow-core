# shellcheck shell=sh
# The shape .husky/pre-commit's staged gates share (mantahostels#1793).
#
# SOURCED, NEVER RUN.
#
# Every gate that stages blobs out of the index, bar one, is a single
# staged_gate declaration. The doc-map gate (.husky/pre-commit) stays spelled
# out, using these pieces without staged_gate — it holds a `--map-dirty` flag,
# a temp index its baseline needs, and an untracked-entry replay that no other
# gate has, and folding those in would make them three more parameters nothing
# else turns.
#
# POSIX sh, not bash: every hook sourcing it runs as `sh`, under `set -e`.
#
# THREE PARAMETERS ARE DELIBERATELY NOT HERE — two of mantahostels#1793's five proposed,
# and one removed after it was built:
#
# - SEVERITY. Every gate using staged_gate today is hard-failing, and a
#   warn-severity one is two lines at the call site — read $sg_status and do not
#   exit. The exit CODE does vary between gates, so that one IS a parameter.
# - A `*-new-faults` PROFILE NAME. The whole-repo direction gate is
#   `--against <rev>` inside scripts/lib/check.js, which owns the profile, both
#   materialisations and the fail-closed rule (mantahostels#1801, mantahostels#1833); gate_direction
#   stays for its ONE remaining caller, the doc-map gate.
# - THE REVISION gate_stage_out STAGED FROM, so a gate could take a HEAD
#   baseline as well as the index. The hook's one HEAD read is the doc-map
#   gate's own `git cat-file -p HEAD:docs/doc-map.md`, spelled out where it is
#   used — so re-add it only for a SECOND such gate (mantahostels#2032).

# --- arming ------------------------------------------------------------------
#
# EVERY GATE ARMS THROUGH `armed` (#1504). The hook holds no `git diff --cached`
# of its own — scripts/precommit-gate-input-deletion.test.ts refuses one — so a
# rule about which staged paths arm a gate is changed here, once, for all of
# them.
#
# THE READ IS --no-renames (mantahostels#2903, widened to every gate at #1483).
# git's rename detection collapses a delete and an add into one `R` entry
# naming the NEW path alone, so a gate armed on the OLD path never fired. Under
# --no-renames the pair is a `D` plus an `A` and the old path is back. That
# adds paths and removes none, so an ordinary rename never disarms a gate, and
# every checker already meets an armed path absent, a `git rm` arming it too —
# PROVIDED a checker that re-reads the index takes the flag as well, or it meets
# an `R` where it looks for a `D`. check-roadmap-valid.js and
# check-injector-margin.sh do (#1483).
#
# AND -z, because git's default renders a path outside ASCII double-quoted and
# C-escaped, so it starts `"` and no prefix pattern matches it.
#
# The deletion probe in gate_stage_out needs neither — measured: its pathspec
# limits the diff to the old path, leaving git nothing to pair the rename with,
# so it reports `D` either way.

# staged_names — reads the commit's staged entries, ONCE per hook run, into
# $staged_entries (`<status><TAB><path>` lines) and $staged_paths (the paths).
#
# REFUSES THE COMMIT where git will not answer: every gate arms off this one
# read, so a failure here would otherwise pass the commit with none of them run.
#
# Through a file, not a pipe, so git's own status is the one read. mktemp, not
# gate_tmpdir, which would rebind a caller's $GATE_DIR.
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

# armed '<ERE>' | armed -F '<path>…' — true where a staged path matches, and
# sets $armed_paths to the ones that do, for armed_live and tool_gate.
#
# `-F` takes newline-separated literal paths, each matched whole: the context
# gate's always-loaded pool. An empty pattern arms nothing.
armed() {
  armed_flags=-E
  if [ "$1" = "-F" ]; then
    armed_flags=-xF
    shift
  fi
  staged_names
  armed_paths=""
  [ -n "$1" ] && [ -n "$staged_paths" ] || return 1
  armed_paths="$(printf '%s\n' "$staged_paths" | grep "$armed_flags" -e "$1")" || :
  [ -n "$armed_paths" ]
}

# armed_live [--index] — prints the $armed_paths this commit adds or modifies
# and the worktree still holds, one a line: what a linter reading the WORKTREE
# can be handed. It matches A and M alone: under --no-renames git reports no R
# or C.
#
# A path staged then deleted from the worktree fails a linter on "does not
# exist" rather than on a finding; one `git rm --cached` untracks stays on
# disk, and a finding in it would block its own removal.
#
# --index drops the worktree half, for a checker that reads the staged blobs:
# a path gone from disk is still in the commit.
armed_live() {
  printf '%s\n' "$armed_paths" | while IFS= read -r al_p; do
    [ -n "$al_p" ] || continue
    [ "${1:-}" = "--index" ] || [ -f "$al_p" ] || continue
    if printf '%s\n' "$staged_entries" | grep -qxF -e "A	$al_p" -e "M	$al_p"; then
      printf '%s\n' "$al_p"
    fi
  done
}

# The names a shell file can have: scripts/lib/formatters.js's SHELL_NAME or
# NO_EXTENSION, which scripts/lib/formatters.test.ts pins this to cover. The format gate arms
# on it; armed_shell narrows it to the shell files themselves.
GATE_SHELL_CANDIDATE='^\.husky/[^/.]+(\.local)?$|\.(sh|bash)$|(^|/)[^/.]+$'

# armed_shell — `armed` on the commit's staged shell files, as formatters.js's
# shellFiles() picks them from the staged blobs and .gitattributes (#1828): the
# file set check:sh lints. A lister that fails refuses the commit rather than
# arming nothing.
armed_shell() {
  armed "$GATE_SHELL_CANDIDATE" || return 1
  as_paths="$(printf '%s\n' "$armed_paths" | node "${WFC_PLUGIN_ROOT:-.}/scripts/lib/formatters.js" shell-files --index)" || {
    echo "pre-commit: scripts/lib/formatters.js could not list this commit's shell files, so the shell gate refused it." >&2
    exit 1
  }
  armed_paths="$as_paths"
  [ -n "$armed_paths" ]
}

# tool_gate <binary> <install hint> [--index] — for a staged-path linter armed
# on the pattern just passed to `armed`. Sets $tool_paths to armed_live's list,
# --index passed through, and
# returns 0 to run the tool; returns 1, the commit passing, where that list is
# empty — never call a linter with no paths, which reads stdin or the whole
# directory — or where <binary> is not on PATH, with the one SKIP wording.
#
# A missing binary warns and passes rather than refusing: none of these has an
# npm route, so blocking would leave a fresh checkout unable to commit the very
# fix that needs committing (mantahostels#1134, mantahostels#1137).
tool_gate() {
  tool_paths="$(armed_live "${3:-}")"
  [ -n "$tool_paths" ] || return 1
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "pre-commit: $1 is not on PATH — its gate is SKIPPED, this commit is NOT blocked." >&2
    echo "  npm install does not supply it; $2" >&2
    # Which workflows run it, from scripts/lib/ci-runs.js (#1629). Its exit 2
    # is a tool it does not know, which takes no CI line.
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

# --- declared commands -------------------------------------------------------

# declared_cmd <reader command>… — runs a reader of a command the adopter
# declares (#2, #740): `node scripts/lib/workflow-core-config.js command <key>`
# or `node scripts/lib/test-gate.js commit`. The reader's exit alphabet:
#
#   0  sets $declared_command to what it printed, and returns 0 to run it;
#   1  returns 1 — the reader has printed its own SKIP line;
#   2  a config it cannot read: EXITS 1, refusing the commit rather than
#      skipping.
#
# Severity stays at the call site: the typecheck gate only reports a red.
declared_cmd() {
  dc_status=0
  # shellcheck disable=SC2034 # read by the hook that sources this file.
  declared_command="$("$@")" || dc_status=$?
  if [ "$dc_status" -eq 2 ]; then
    exit 1
  fi
  return "$dc_status"
}

# --- temp-dir lifecycle ------------------------------------------------------
#
# ONE trap for the whole hook, registered here when this file is sourced, since
# a second `trap … EXIT` anywhere would replace it. A gate's directory therefore
# lives until the hook exits, not to the end of that gate.
#
# The list is NEWLINE-separated and read a line at a time, never split on
# whitespace: `mktemp -d` honours TMPDIR, so a TMPDIR holding a space would
# split one directory into two words — an `rm -rf` on an unrelated path, and the
# real directory leaked.
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

# Sets $GATE_DIR to a fresh temp directory, removed when the hook exits.
#
# SETS rather than prints: `d="$(gate_tmpdir)"` would run the body in a
# command-substitution subshell, where the append to GATE_TMPDIRS is lost and
# the directory then outlives the hook.
gate_tmpdir() {
  GATE_DIR="$(mktemp -d)"
  GATE_TMPDIRS="$GATE_TMPDIRS$GATE_DIR
"
}

# --- staging blobs out of git ------------------------------------------------

# gate_stage_out <dir> <path>...
#
# Copies each repo path to <dir>/<basename>, read from the INDEX (`:<path>`) and
# never from the worktree: the tree is repo-global, so reading a file in place
# judges a parallel session's half-written copy rather than this commit's bytes.
#
# A path prefixed `opt:` is OPTIONAL — unreadable, its copy is removed and the
# gate carries on. That is for a file whose absence the checker reads correctly:
# a truncated write must not reach it as corrupt JSON and report the wrong fault.
# `opt:` rather than a `?` sigil because the list is word-split unquoted, where
# a `?` is a glob character.
#
# Returns 1 if a REQUIRED path is not readable, and leaves the ones that failed
# in $GATE_MISSING — so the skip line names those and not the whole list, which
# would send a reader off to check files that are fine. The caller warns and
# passes.
#
# UNREADABLE HAS TWO CAUSES AND THEY ARE NOT THE SAME FAULT (mantahostels#2894). A path that
# was never in the index is apparatus missing. A path THIS COMMIT DELETES is the
# fault itself. The second kind is separated out into $GATE_DELETED, which
# staged_gate refuses on; $GATE_MISSING keeps both, for the skip line.
#
# An `opt:` path is exempt from that: its absence is what the checker is built to
# read correctly, so a deletion of one reaches the checker as an absence and is
# judged there rather than here.
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
        # --literal-pathspecs, because `--` takes a git PATHSPEC and
        # not a filename: `?`, `*` and `[` are wildcards there and a
        # leading `:` is magic, so a path holding one matches something
        # else or errors, and the deletion passes unseen.
        #
        # --diff-filter=D IS LOAD-BEARING MID-MERGE. An unmerged path
        # has no stage-0 blob, so `cat-file` above fails on it, and git
        # reports it as U rather than D. Drop the filter and a conflict
        # resolution is refused as a deletion — and the whole hook stack
        # runs on `git merge` here.
        #
        # Through a file rather than a pipe: a pipeline's status is the
        # LAST command's, so `git … | tr` would report tr's and hide
        # git's. `tr` still runs, because bash-as-/bin/sh warns on a NUL
        # inside a command substitution.
        gate_del_status=0
        git --literal-pathspecs diff --cached --diff-filter=D \
          --name-only -z -- "$gate_p" >"$gate_dir/.gate-deleted" \
          2>/dev/null || gate_del_status=$?
        gate_del="$(tr -d '\000' <"$gate_dir/.gate-deleted")"
        if [ "$gate_del_status" -ne 0 ]; then
          gate_del=""
          echo "pre-commit: could not ask git whether $gate_p is deleted by this commit — treating it as merely absent." >&2
        fi
        # Non-empty, not equal to $gate_p: under --literal-pathspecs a
        # directory path would answer with its children, and a deletion
        # inside one is still a deletion.
        if [ -n "$gate_del" ]; then
          GATE_DELETED="$GATE_DELETED, $gate_p"
        fi
      fi
    fi
  done
  return "$gate_missing"
}

# gate_skip <label> <paths> — the one wording for apparatus missing.
gate_skip() {
  echo "pre-commit: skipped the $1 check — not readable from the index: $2." >&2
}

# gate_skip_missing <label> — the same, over gate_stage_out's own failure list.
gate_skip_missing() {
  gate_skip "$1" "${GATE_MISSING#, }"
}

# gate_refuse_deleted <label> — a required input this commit deletes (mantahostels#2894).
#
# Prints; the caller exits. Separate from gate_skip because the two readings of
# "unreadable" want opposite verdicts.
gate_refuse_deleted() {
  echo "pre-commit: the $1 check reads ${GATE_DELETED#, }, and this commit DELETES it — refusing." >&2
  echo "  That is not apparatus missing: the file is a gate's own input, so removing it is the fault, not a reason to skip." >&2
  echo "  Keep it: leave the path out of the commit's pathspec, or restore it with 'git checkout HEAD -- <path>' — safe here, a deleted file holding no parallel session's edit." >&2
  echo "  Renaming it? git reports a rename as a deletion here, so this fires on one too — move the gate's path list in the same commit, behind the escape." >&2
  echo "  Retiring it deliberately? The escape is the founder's to set, never an agent's (#916): an agent stops and asks. The founder runs, from their own terminal, WFC_ALLOW_GATE_INPUT_DELETE=1 git commit -m '…' -- <paths>, retiring the gate reading it in the same commit." >&2
}

# gate_check_deleted <label> — the verdict on whatever gate_stage_out left in
# $GATE_DELETED. EXITS 1 on a deletion the escape does not cover; otherwise
# returns, and the caller goes on to skip and pass.
#
# The escape is named because retiring a gated document is legitimate if rare,
# and without one the only way through is HUSKY=0, which turns off gitleaks and
# the whole stack with it.
#
# Separate from staged_gate so the doc-map gate, which .husky/pre-commit spells
# out rather than declaring, reaches the refusal too (mantahostels#2902).
gate_check_deleted() {
  [ -n "$GATE_DELETED" ] || return 0
  if [ -z "${WFC_ALLOW_GATE_INPUT_DELETE:-}" ]; then
    gate_refuse_deleted "$1"
    exit 1
  fi
  echo "pre-commit: WFC_ALLOW_GATE_INPUT_DELETE is set — allowing this commit to delete ${GATE_DELETED#, }." >&2
}

# --- the whole staged gate ---------------------------------------------------

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

  # shellcheck disable=SC2086 # deliberate word-splitting: one path per word.
  if ! gate_stage_out "$sg_dir" $sg_paths; then
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

  # `if`, never a trailing `[ … ] && return 0`: the hook runs under
  # `set -e`, where an AND-OR list that is a function's LAST command and whose
  # test is false returns 1 and aborts the shell — refusing a commit every gate
  # had passed.
  if [ "$sg_status" -ne 0 ]; then
    [ -z "$sg_advice" ] || printf '%s\n' "$sg_advice" >&2
    if [ "$sg_exit" = "status" ]; then
      exit "$sg_status"
    fi
    exit "$sg_exit"
  fi
}

# --- the direction gate ------------------------------------------------------
#
# A fault already in HEAD warns and passes; one this commit adds refuses
# (mantahostels#1688, mantahostels#1753).

# gate_no_baseline <noun> — no readable HEAD to compare against. FAILS CLOSED.
gate_no_baseline() {
  echo "pre-commit: no readable HEAD baseline for the $1 check — refusing." >&2
}

# gate_diagnostics <noun> <stderr file> — replays what the comparison wrote to
# STDERR.
#
# A crash's stack trace is apparatus noise, not a finding, and merged into the
# indented fault list it read as one (mantahostels#2026).
gate_diagnostics() {
  if [ -s "$2" ]; then
    echo "" >&2
    echo "pre-commit: the $1 comparison also wrote to stderr — diagnostics, not findings:" >&2
    sed 's/^/  | /' "$2" >&2
  fi
}

# gate_direction <noun> <ticket> <comparison command>...
#
# Runs the comparison and turns its exit status into a verdict. Returns 0 to
# pass the commit, 1 to refuse it.
#
# THE VERDICT IS THE EXIT STATUS, NEVER THE TEXT ON A PASS: a *-new-faults
# script is free to print on a clean run — so a `-n` test on its stdout refuses
# every commit it should pass.
#
# EXIT 1 OBLIGES A FAULT LIST ON STDOUT: a 1 with nothing there has named
# nothing, and takes the same limb as a 2 (mantahostels#2026). That is where an absent
# script, a syntax error and a require-time throw land — the shell and node
# report those on stderr and exit 1.
#
# FAILS CLOSED. 0 is inherited; everything else is a failure to ANSWER, which
# must not read as inherited.
#
# NOTE: this REBINDS $GATE_DIR, taking a gate_tmpdir directory for the
# comparison's stderr — a caller wanting its own must call gate_tmpdir again.
#
# EXIT 1 OBLIGES A COMPLETE LIST, and that is the COMPARISON's half of the
# contract, unenforced here (mantahostels#2314). This gate cannot tell a crash mid-list from
# a comparison that legitimately printed faults and also wrote to stderr, so it
# does not try: a 1 with anything on stdout is read as an answer. The one caller
# holds up its end — lib/fault-diff.js composes the whole list before it writes,
# and routes an uncaught throw ONCE RUNNING to exit 2 rather than node's default
# 1. A throw at REQUIRE time is before that and still exits 1, but with an empty
# stdout, which the limb below already catches. A future caller that streams its
# list must install the same handler; a write catch alone is not enough.
gate_direction() {
  gd_noun="$1"
  gd_ticket="$2"
  shift 2

  gate_tmpdir
  gd_err="$GATE_DIR/stderr"

  gd_cmp=0
  gd_new="$("$@" 2>"$gd_err")" || gd_cmp=$?

  if [ "$gd_cmp" -eq 0 ]; then
    echo "pre-commit: every FAIL finding the $gd_noun check reported above is already in HEAD, so this commit did not cause one — passing ($gd_ticket)." >&2
    echo "  They still FAIL the scheduled sweeps, which run a clean checkout, and block nothing here only because they are inherited." >&2
    gate_diagnostics "$gd_noun" "$gd_err"
    return 0
  fi

  if [ "$gd_cmp" -eq 1 ] && [ -n "$gd_new" ]; then
    echo "pre-commit: the $gd_noun fault(s) below are NOT in HEAD — this commit adds them:" >&2
    printf '%s\n' "$gd_new" | sed 's/^/  /' >&2
  else
    echo "pre-commit: could not tell inherited $gd_noun faults from new ones — refusing." >&2
    if [ -n "$gd_new" ]; then
      printf '%s\n' "$gd_new" >&2
    fi
  fi
  gate_diagnostics "$gd_noun" "$gd_err"
  return 1
}
