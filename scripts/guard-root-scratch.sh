#!/usr/bin/env bash
# PreToolUse guard: no scratch file at the repo root (mantahostels#2340, ruled at mantahostels#2323;
# made a deny at mantahostels#2436).
#
# `docs/environment.md` §12 names `.claude/tmp/` as the one sanctioned in-repo
# scratch directory (mantahostels#2089). This is the first thing behind that rule that
# anything delivers: the `Stop`-hook warn it replaces went out as a
# `systemMessage`, which mantahostels#2319 measured reaching the model on zero of 598
# firings, while the `PreToolUse` `additionalContext` channel used here is the
# one that ticket proved live.
#
# WHAT IT REFUSES: one predicate, reached by two routes.
#
#   A Bash write by any spelling lib/guard-parse.sh's gp_write_targets reads
#   (#1827), or a Write, Edit or NotebookEdit `file_path` (mantahostels#3380), whose
#   target resolves to a DOT-PREFIXED path sitting DIRECTLY at the repo root,
#   and which is neither gitignored nor tracked.
#
#   - dot-prefixed and directly at the root: `.claim2340.tmp`, `.i2340.out`,
#     `.rev2216.out`. A target with a slash in it — `.claude/tmp/x`,
#     `docs/research/y` — is a considered location and never this guard's
#     business.
#   - NOT GITIGNORED, because `.gitignore` is the line between a sanctioned
#     root dotfile (`.env*`, `.pnp.*`, an adopter's own markers) and a stray.
#     This repo's guard tier writes no root marker: its markers sit under
#     `.claude/tmp/markers`, and `.sweep-autofire` in the git common dir.
#   - NOT TRACKED, because `.gitignore` and `.mcp.json` are root dotfiles that
#     are neither ignored nor scratch. This limb is mantahostels#2340's own; mantahostels#2323's ruled
#     scope stopped at the gitignore one.
#
# mantahostels#2323 RULED A DENY AND MADE A ZERO-FALSE-POSITIVE MEASUREMENT THE GATE ON
# BUILDING ONE; mantahostels#2340 found two and landed the `gp_warn` that ruling pre-agreed.
# mantahostels#2436 RE-MEASURED AGAINST THE WIDENED MATCHER AND THE DENY WENT IN — figures,
# method and the correction to both on that issue.
#
# TWO LEGITIMATE ROOT WRITES ARE REFUSED BY IT, and the escape below is what
# carries them: a mutation arm breaking the declined-Markdown-tooling guarantee,
# across every name `markdown-tooling-declined.test.ts` enumerates (`.remarkrc`,
# `.prettierrc`, `.textlintrc`, `.prettierignore`, `.lycheeignore`), and a temp
# `tsconfig` whose `extends` globs resolve relative to itself. GITIGNORING THEM
# IS NOT THE FIX: the gitignore limb above means "sanctioned root dotfile", and
# these are its opposite. NOR IS AN IN-GUARD ALLOWLIST of those six names: it
# would have to be kept in step with a test file by hand, and it would silently
# permit a real stray that happens to be called `.prettierrc`.
#
# NO LATCH. mantahostels#2401 (ruled at mantahostels#2377) bounded the WARN to one delivery per
# `(agent, session)`; a
# latched DENY would allow every stray after the first, so each refusal fires on
# its own.
#
# LIMITS
#  - The Bash limb reads gp_write_targets' spellings and no others, so `dd of=`,
#    a heredoc body and a script that writes on the session's behalf are
#    unread. The escape below is `dd` for that reason.
#  - mantahostels#2436 measured the deny over redirects alone; #1827 widened the
#    spellings and left the predicate as measured. A word the reader takes for a
#    file and is not — a `sed` script, a bundled `perl -pe`'s code — is refused
#    only where it is itself a bare dot-prefixed name.
#  - A file-tool path is not normalised beyond `./` and `/./`, so
#    `docs/../.x` or `//.x` passes. The tools hand over canonical paths.
#  - A target it cannot read literally is judged as a SYNTHETIC WHOLE NAME
#    (mantahostels#2372): every `${…}`, `$(…)`, `$VAR` and backtick span becomes a single
#    `X`, and that name goes through the same two git reads. So `.a2357.$c.json`
#    is refused, while `.env.$SID` is claimed by `.gitignore`'s `.env*` and
#    stays silent. The TRACKED limb is asked as a
#    pathspec with each span as `*` instead, a placeholder being a name no file
#    can carry — so a tracked `.envrc.$e` is seen, at the cost of any tracked
#    sibling matching the glob silencing it.
#    WHAT IS STILL NOT READ: a `.gitignore` pattern constraining the VARIABLE
#    span rather than the suffix — `.mut-[0-9]*.out` claims the real name and
#    not `.mut-X.out`, so a sanctioned file is refused. Nor an UNQUOTED `$(…)`
#    or backtick: the flattener splits it into a segment of its own, leaving the
#    redirect a fragment (`.a$`) no synthetic name can be built from. Quoted,
#    the span survives the split and is read.
#  - A `cd` earlier in the same command string is not read, so `$PWD` is the
#    session's directory and not the one the write really lands in. It costs
#    a miss where the `cd` leaves the repo and a false refusal where it enters it.
#  - A REFUSAL WHOSE STDOUT IS DISCARDED IS AN ALLOW. `gp_deny` prints its
#    envelope and exits 0 without reading jq's status, and a `PreToolUse` hook
#    that prints nothing at exit 0 permits the call — so a hook cancelled at its
#    10 s ceiling lets the write land, unrefused and unreported. No exit code
#    says "refuse" without stdout, so it is pinned rather than fixed.
#  - A command run outside Claude Code sees no hook.
#  - A `git` that cannot answer `check-ignore` or `ls-files` allows the write,
#    recorded — the house fail-open (mantahostels#103 §6).
#
# `post-write.sh` runs at PostToolUse, so a write this refuses never reaches it
# and the two need no ordering.

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every command allowed unchecked"
  exit 0
}

# One alternation covers both payload shapes; `.tool_name` picks the limb below.
gp_begin '.tool_input.command // .tool_input.file_path // .tool_input.notebook_path' \
  write "command or path"

TOOL="$(gp_payload_field '.tool_name')" || {
  TOOL=""
  gl_open ".tool_name unreadable — a file-tool write allowed unchecked"
}

# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"
root="$(gr_root)"

# The stray as written, and the same target repo-root-relative. Both, because
# the refusal quotes the first and builds its suggested spelling from the
# second: `${STRAY#.}` on `./.i.out` or on an absolute path does not resolve.
STRAY=""
STRAY_NAME=""

# Is $1 a repo-root dot-prefixed path that git treats as neither ignored nor
# tracked? Purely textual up to the two git reads: the file does not exist yet.
# $2 and $3 come with a SYNTHETIC $1 and are the same target twice over: $2 as
# the caller wrote it, which is what the refusal quotes back so a placeholder
# never reaches the page, and $3 with each span as `*` for the tracked limb.
is_stray() {
  local p="$1" orig="${2:-$1}" glob="${3-}" name tracked
  # `./.foo` and `.foo` are the same target; nothing else is normalised, since a
  # `..` segment climbing back to the root is not a spelling anyone writes.
  [[ "$p" == /* ]] || {
    p="$PWD/${p#./}"
    orig="$PWD/${orig#./}"
    [[ -z "$glob" ]] || glob="$PWD/${glob#./}"
  }
  p="${p/\/.\///}"
  # The same fold on the ORIGINAL could land inside a span the placeholder
  # stands for, deleting a `.` the session wrote, so it runs only where the two
  # are one string.
  [[ -n "${2-}" ]] || orig="$p"
  [[ "$p" == "$root/"* ]] || return 1
  name="${p#"$root/"}"
  # A slash left means it sits in a subdirectory, which is a chosen location.
  case "$name" in
    */* | . | .. | '') return 1 ;;
    .?*) ;;
    *) return 1 ;;
  esac
  git -C "$root" check-ignore -q -- "$name" 2>/dev/null && return 1
  # `check-ignore` exits 1 for "not ignored" and 128 for a git that could not
  # answer at all, and the two must not land on the same verdict.
  (($? == 1)) || {
    gl_open "git check-ignore could not answer for $name — write allowed unchecked"
  }
  # ASKED AS A GLOB where the name is synthetic: `$name` carries a placeholder
  # no tracked file can hold, so a tracked sibling matching the glob silences it.
  if [[ -n "$glob" ]]; then
    tracked="$(git -C "$root" ls-files -- "${glob#"$root/"}" 2>/dev/null)" || {
      gl_open "git ls-files could not answer for ${glob#"$root/"} — write allowed unchecked"
    }
    [[ -z "$tracked" ]] || return 1
  else
    git -C "$root" ls-files --error-unmatch -- "$name" >/dev/null 2>&1 && return 1
    # 1 is "git answered, and does not track it". Anything else is git failing to
    # answer, which must not read as a stray.
    (($? == 1)) || {
      gl_open "git ls-files could not answer for $name — write allowed unchecked"
    }
  fi
  STRAY_NAME="${orig#"$root/"}"
  return 0
}

# The span shapes gp_literal cannot resolve: `${…}`, `$(…)`, a backtick
# substitution, `$VAR`, a special parameter (`$$`, `$1`, `$?`, `$!`, `$@`, `$#`,
# `$*`, `$-`) and the index-plus-\x01 tail a sentinel naming an unrecorded span
# leaves behind.
#
# The two bracketed forms exclude their OWN opening bracket, so a nested span
# matches innermost-first and the outer one matches on the next pass.
RE_SPAN='\$\{[^{}]*\}|\$\([^()]*\)|`[^`]*`|\$[A-Za-z_][A-Za-z0-9_]*|\$[-0-9*@#?$!]|[0-9]*'$'\x01'

# Every unreadable span of $1 replaced by $2, so a name that is literal APART
# from an expansion can still be judged whole. `X` for the name `.gitignore` is
# asked about, an ordinary character so a glob there claims the synthetic name as
# it claims the real one; `*` for the pathspec the tracked limb is asked with.
#
# Non-zero where something unreadable survives — an unterminated `${`, say.
synthesise() {
  local s="$1" ph="$2"
  while [[ "$s" =~ $RE_SPAN ]]; do
    s="${s/"${BASH_REMATCH[0]}"/"$ph"}"
  done
  case "$s" in
    *'$'* | *'`'* | *$'\x01'*) return 1 ;;
  esac
  printf '%s' "$s"
}

# One word the command writes.
consider_target() {
  local word="$1" lit syn glob
  [[ -z "$STRAY" ]] || return 0
  if lit="$(gp_literal "$word")"; then
    [[ -n "$lit" ]] || return 0
    is_stray "$lit" && STRAY="$lit"
    return 0
  fi
  [[ -n "$lit" ]] || return 0
  syn="$(synthesise "$lit" X)" || return 0
  glob="$(synthesise "$lit" '*')" || return 0
  is_stray "$syn" "$lit" "$glob" && STRAY="$lit"
  return 0
}

# One command the string runs, its writes read whatever word heads it: `for i
# in 1 2 3; do … > .c2226.out; done` is flattened on its `;` into a segment
# headed by `do` (mantahostels#2321). An `mv`'s source and a deletion take a
# file away, so only a write is judged — `mv .x .claude/tmp/x` is the remedy.
judge() {
  shift
  local i
  gp_write_targets "$@"
  for i in "${!_gp_wt_mode[@]}"; do
    [[ "${_gp_wt_mode[i]}" == write ]] && consider_target "${_gp_wt_target[i]}"
  done
  return 0
}

case "$TOOL" in
  # A file tool's path is already one literal word, so it skips the walker and
  # goes straight to the predicate.
  Write | Edit | NotebookEdit) is_stray "$(gp_subject)" && STRAY="$(gp_subject)" ;;
  *) gp_walk_commands --bare-redirects judge ;;
esac

[[ -n "$STRAY" ]] || gp_allow

# An inline code span must be fenced by MORE backticks than its longest inner
# run, or it closes early and takes the rest of the refusal with it. The two
# recipe lines below take the other route: four spaces makes each a code BLOCK,
# where a backtick is literal and
# needs no fence — and where nothing a session copies carries a fence away with
# it, which an inline span around a whole command line would (mantahostels#2436).
md_span() {
  local s="$1" run=0 longest=0 i fence pad
  for ((i = 0; i < ${#s}; i++)); do
    if [[ "${s:i:1}" == '`' ]]; then
      ((run++))
      ((run > longest)) && longest=$run
    else
      run=0
    fi
  done
  fence='`'
  pad=''
  for ((i = 0; i < longest; i++)); do
    fence+='`'
    pad=' '
  done
  printf '%s' "$fence$pad$s$pad$fence"
}

# A path as ONE shell word, so a recipe the session copies writes one file
# whatever the name holds — a space, a `$`, a quote. Single quotes take
# everything but a single quote, which is closed, escaped and reopened.
shell_word() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
}

stray_md="$(md_span "$STRAY")"
escape_target="$(shell_word "$STRAY_NAME")"

case "$TOOL" in
  Write)
    same="Same write, sanctioned path"
    sanctioned="$root/.claude/tmp/${STRAY_NAME#.}"
    ;;
  # An edit needs the file to exist where it is aimed, so move it first.
  Edit | NotebookEdit)
    same="Move it into the sanctioned directory, then edit it there"
    sanctioned="mv $escape_target .claude/tmp/$(shell_word "${STRAY_NAME#.}")"
    ;;
  *)
    # The target alone: the command may write it by any spelling, not only `>`.
    same="Same command, sanctioned spelling"
    sanctioned=".claude/tmp/${STRAY_NAME#.}"
    ;;
esac

IFS= read -r -d '' refusal <<EOF || :
Refused: $stray_md is a dot-prefixed file directly at the repo root, which git neither ignores nor tracks. \`docs/environment.md\` §12 puts in-repo scratch in \`.claude/tmp/\` and nowhere else — gitignored, out of Biome's scope and out of vitest's, and swept at 24 hours. $same:

    $sanctioned

IF THIS REALLY IS A ROOT CONFIG FILE RATHER THAN SCRATCH — a mutation arm breaking \`scripts/markdown-tooling-declined.test.ts\`, or a temp \`tsconfig\` whose \`extends\` globs resolve relative to itself — this reads no \`dd\`, so write it through one and it is not seen:

    printf '%s' '{}' | dd of=$escape_target

There is no flag, and none is wanted: an escape a session can spell for itself is not a deny (mantahostels#109).
EOF

gp_deny "$refusal"
