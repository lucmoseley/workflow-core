#!/usr/bin/env bash
# PreToolUse guard: this command reads a whole file, a wide slice or an
# uncounted glob back into the context window (mantahostels#1562).
#
# WHY. Tool output is the largest single share of a long session's context here,
# and mantahostels#1553 declined every capping setting the CLI offers — the figures, and what
# each setting would have cost, are on mantahostels#1553 and in
# https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/tool-output-profile.md. That leaves reducing the output at
# source, which is what this guard nudges.
#
# WARN, NEVER DENY — the decision at mantahostels#1562, not a first step toward denying. A
# session often has a real reason to read widely, and mantahostels#103's rule splits on the
# signal: deny on a structured fact where the action has no legitimate use, warn
# where the guard is inferring. Reading a whole file is always legitimate; only
# the caller knows whether it needed the whole of it.
#
# The four shapes it matches, and what to do instead of each, are owned by
# docs/agents/tool-output.md; each limb below states its own. Three are Bash
# commands; the fourth is a `Read` tool call (mantahostels#2595).
#
# BOUNDED MEANS THE OUTPUT GOES SOMEWHERE ELSE. A command carrying a pipe or a
# redirect anywhere in it is left alone: `cat x | head`, `sed -n … > out.txt` and
# `grep … | wc -l` are the cheaper forms this guard is asking for, and warning on
# them would be warning on the fix.
#
# Its Bash narrowings, `if: Bash(*cat *)`, `if: Bash(*sed *)` and
# `if: Bash(*awk *)`, name the only three commands `is_dumper` judges across
# limbs 1-3. The Read limb (mantahostels#2595) has its own unnarrowed
# registration (mantahostels#2811): an `if` naming one tool never matches
# another (hooks.md:123), so a Bash rule on a "Bash|Read" entry would have
# silenced it.
#
# LIMITS
#  - The bounded test reads the RAW command string for `|` and `>`, so one
#    inside a quoted span silences the guard. Fail-silent, which is the right
#    direction for a warn: a missed nudge costs bytes, a wrong one costs trust.
#  - It reads the PARSED command form for everything else, so a `cat` mentioned
#    in an echo, a grep pattern or a heredoc body is not a read (lib/guard-parse.sh).
#  - Relative paths resolve against the hook's cwd, so a `cd elsewhere && cat big`
#    resolves to nothing and passes unwarned. The file must EXIST to be measured,
#    which is what makes that failure silent rather than a false warning.
#  - `sed` is judged on its LINE span, never on the bytes those lines hold, so a
#    150-line slice of a minified file passes.
#  - A word gp_literal cannot fully read — `cat "$doc"`, a command substitution —
#    is DROPPED, not judged on its visible part, which gp_literal's contract
#    offers. A partial path cannot be measured on disk.
#  - Only `cat`, `sed` and `awk` are judged at all. `grep`, `rg`, `head` and
#    `tail` bound their output in LINES — by pattern or by line count — so
#    warning on a glob they were given would warn on `grep -n '<pattern>'
#    <glob>`, the very cheaper form limb 1 recommends. `grep` therefore goes
#    unwarned whatever it reads, though it is the corpus's second-largest
#    bucket. Lines are not bytes: one matching single-line file returns whole
#    (#1026).
#  - It is DELIBERATELY ABSENT from lib/guard-parse.sh's _gp_guarded_head list,
#    whose comment invites a third command name. That list decides when the
#    multi-line join abandons, and widening it to `cat`/`sed`/`grep` would make
#    the deny guards read a mis-paired multi-line string as commands — a wrong
#    DENY, to spare this guard a missed WARN.
#    A GATE holds this (mantahostels#2346), not this paragraph: guard-parse-head-widening.test.ts.
#  - The Read limb judges only a call carrying NO `limit`. A `limit` bounds the
#    output the way a pipe bounds a Bash read, and warning on one would be
#    warning on the fix. It costs coverage: a call bounded by a `limit` and
#    wide anyway goes unwarned (mantahostels#2595).
#  - The Read limb measures the lines the call will RETURN, not the file: `Read`
#    stops at 2,000 lines, so a 200,000-line file returns a small fraction of
#    itself and measuring the file would warn on almost every long file wrongly.
#    An image, a PDF and a notebook are skipped by extension — `Read` renders
#    those rather than returning their bytes, so a byte count says nothing.
#  - The Read limb warns once per (agent, session, file), latched as gp_rule_told
#    latches, so a compaction — which clears those latches — lets it warn again
#    (#1034). The Bash limbs are not latched.
#  - Limbs 1 and 3 compare BYTES with the 30,000-character cap, so a file of
#    multibyte text just over 30 KB can draw the cut-off sentence while under
#    the cap — hence "may be cut", never "will be".
#  - The 2,000-line cap is the only one it models. A separate token cap can page
#    a large result (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/microcompact-and-tool-result-caps.md), so the
#    figure the warning names is an upper bound on what the window actually
#    takes, not a measurement of it.
#  - It FAILS OPEN throughout, house style (mantahostels#103 §6), recording through
#    lib/guard-log.sh (mantahostels#147).

set -uo pipefail

# The shared parser (mantahostels#123), resolved from this file's own location because a
# hook runs with an arbitrary cwd. The gate is ONE name, gp_begin — never
# `source`'s exit status (mantahostels#157). guard-log.sh is sourced first and separately so
# the one fault that disarms this guard entirely is itself recordable (mantahostels#147).
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

# Overridable so the sibling test can fire the limbs on fixtures small
# enough to write, rather than on a file of the shipped size per case.
#
# 20,000 characters is the break-even between what a wide read carries and what
# the remedy in limb 1 below costs — grep-then-sed, TWO extra tool calls, each a
# turn at full context (mantahostels#2571, which carries the derivation).
#
# The figure is a rough centre, NOT a bound in either direction. mantahostels#2571 carries
# the terms the model leaves out and which way each pushes — re-tune from
# there, not from this comment.
#
# The other two are the same judgement in units the corpus does not measure —
# UNMEASURED, chosen wide enough that an ordinary targeted read passes
# untouched, and the first to move if this warns too often.
WIDE_BYTES="${WFC_WIDE_READ_BYTES:-20000}"
WIDE_LINES="${WFC_WIDE_READ_LINES:-200}"
WIDE_MATCHES="${WFC_WIDE_READ_MATCHES:-5}"

# HALF the figure above, by construction rather than by a second measurement:
# the model is the same and only the remedy's call count differs — two for
# grep-then-sed, one for a `Read` carrying `offset`/`limit`. Derivation, the
# turns-remaining check behind it and what it costs in firing rate:
# mantahostels#2595. Re-tune from there, not from this comment.
WIDE_READ_BYTES="${WFC_WIDE_READ_TOOL_BYTES:-10000}"

# What `Read` itself stops at. Measuring past it would warn on a long file for
# lines the call was never going to return.
READ_LINE_CAP=2000

# The CLI's default BASH_MAX_OUTPUT_LENGTH. Past it a Bash result has two fates
# and nothing found predicts which (#1029): saved to a file behind a 2 KB
# preview, or cut at ~30,000 with no notice.
CUT_BYTES="${WFC_WIDE_READ_CUT_BYTES:-30000}"

# One field for both tools, on guard-job-dir-scratch.sh's shape: a Bash payload
# carries `.tool_input.command` and a Read payload carries `.tool_input.file_path`,
# and gp_begin fails open on a subject it cannot find. Which limb runs is decided
# from `.tool_name` below.
gp_begin '.tool_input.command // .tool_input.file_path' 'read' 'command or file_path'

TOOL="$(gp_payload_field '.tool_name')" || TOOL=""

# The commands whose whole job is to put file text on stdout, unbounded. A
# command that bounds its own output — grep by pattern, head and tail by line
# count, wc by summarising — is deliberately absent; see LIMITS.
is_dumper() {
  case "$1" in cat | sed | awk) return 0 ;; esac
  return 1
}

# Findings, one per matched shape, in the order matched. Accumulated rather than
# emitted, because gp_warn exits and a command can match twice.
FINDINGS=()
# The Read limb's latch id, set by judge_read. Empty means nothing to latch.
READ_LATCH=""

# The sentence limbs 1 and 3 add at or past CUT_BYTES, or nothing under it.
cut_note() {
  (($1 >= CUT_BYTES)) || return 0
  printf ' Past ~%s characters Bash may cut this off with no notice, or save it to a file behind a 2 KB preview, so the tail may never be seen (#1029) — use `Read` with `offset` and `limit`, or redirect to a file and slice it.' "$CUT_BYTES"
}

# Bytes on disk for a path, or nothing if it is not a readable regular file.
# The digits are re-tested rather than trusted: a pipeline returns its LAST
# command's status, so a failed `wc` would come back empty and exit 0, and the
# arithmetic downstream would be a syntax error on the hook's stderr.
file_bytes() {
  local n
  [[ -f "$1" && -r "$1" ]] || return 1
  n="$(wc -c <"$1" 2>/dev/null | tr -d ' ')"
  [[ "$n" =~ ^[0-9]+$ ]] || return 1
  printf '%s' "$n"
}

# LIMB 1 — a `cat` whose file arguments are large. Only bare words that name an
# existing file count, so `cat` on stdin, on a flag, or on a path this file
# cannot resolve produces nothing.
judge_cat() {
  local word lit bytes total=0 name
  local -a named=()
  for word in "$@"; do
    lit="$(gp_literal "$word")" || continue
    [[ -n "$lit" && "$lit" != -* ]] || continue
    bytes="$(file_bytes "$lit")" || continue
    total=$((total + bytes))
    named+=("$lit")
  done
  ((${#named[@]} && total >= WIDE_BYTES)) || return 0
  name="${named[0]}"
  ((${#named[@]} > 1)) && name="${named[0]} and ${#named[@]} files in all"
  FINDINGS+=("Reading a whole file into context: $name is ${total} characters, and every one of them stays in the window for the rest of the session.$(cut_note "$total") Read the part you need instead — \`grep -n '<pattern>' $name\` to find it, then \`sed -n '<start>,<end>p' $name\` — or send the whole thing to a file (\`… > .claude/tmp/out.txt\`) and slice that.")
}

# LIMB 2 — a wide `sed -n '<a>,<b>p'`. The range is read from any word shaped
# like one; `-n` is required, because without it sed prints everything anyway
# and the range is not what makes the output large.
judge_sed() {
  local word lit quiet=0 start end span
  for word in "$@"; do
    lit="$(gp_literal "$word")" || continue
    case "$lit" in --quiet | --silent | -*n*) quiet=1 ;; esac
  done
  ((quiet)) || return 0
  for word in "$@"; do
    lit="$(gp_literal "$word")" || continue
    [[ "$lit" =~ ^([0-9]+),([0-9]+|\$)p ]] || continue
    start="${BASH_REMATCH[1]}"
    end="${BASH_REMATCH[2]}"
    if [[ "$end" == '$' ]]; then
      FINDINGS+=("This \`sed -n\` range is wide: \`${lit}\` runs open-ended to the end of the file, so its size is whatever the file's size is. Name a last line, or send the output to a file and read the slice that matters.")
      return 0
    fi
    span=$((end - start + 1))
    ((span >= WIDE_LINES)) || continue
    FINDINGS+=("This \`sed -n\` range is wide: \`${lit}\` prints ${span} lines. Narrow it — \`grep -n '<pattern>' <file>\` first to find the lines worth printing — or send the output to a file and read the slice that matters.")
    return 0
  done
}

# LIMB 3 — a glob argument to a reading command. The count is known to this
# guard and not to the session.
judge_glob() {
  local word lit bytes total=0 n=0 match
  local -a hits=()
  shopt -s nullglob
  for word in "$@"; do
    lit="$(gp_literal "$word")" || continue
    [[ -n "$lit" && "$lit" != -* ]] || continue
    case "$lit" in *'*'* | *'?'* | *'['*) ;; *) continue ;; esac
    # Word-splitting is deliberate: this is the expansion being measured.
    # shellcheck disable=SC2206
    hits=($lit)
    # Broken the moment the threshold is crossed: file_bytes forks twice per
    # match, and a glob over node_modules would otherwise spend that inside a
    # hook the session is waiting on. The count reported is the count reached.
    for match in "${hits[@]}"; do
      bytes="$(file_bytes "$match")" || continue
      total=$((total + bytes))
      n=$((n + 1))
      ((n >= WIDE_MATCHES || total >= WIDE_BYTES)) && break
    done
    if ((n >= WIDE_MATCHES || total >= WIDE_BYTES)); then
      shopt -u nullglob
      FINDINGS+=("This glob's match count is unknown to you but not to the shell: \`${lit}\` matches at least ${n} files, ${total} characters or more — the count stops at the threshold rather than walking the whole expansion.$(cut_note "$total") Count first (\`ls ${lit} | wc -l\`), narrow the pattern, or send the output to a file and read the slice that matters.")
      return 0
    fi
    total=0
    n=0
  done
  shopt -u nullglob
}

# One command the string runs, its own words as $2 onward.
judge() {
  shift # the flattened segment; only the words are read here
  local base
  base="$(gp_literal "$1")" || return 0
  base="${base##*/}"
  is_dumper "$base" || return 0
  shift
  case "$base" in
    cat) judge_cat "$@" ;;
    sed) judge_sed "$@" ;;
  esac
  judge_glob "$@"
}

# LIMB 4 — a `Read` tool call with no `limit`, whose returned lines are large.
#
# Measured on what the call RETURNS: from `offset` (1-based, defaulting to the
# first line) for at most READ_LINE_CAP lines.
judge_read() {
  local file="$1" offset="$2" first last bytes status
  # A `limit` is this tool's pipe: the caller has already bounded the output.
  # `offset` alone does not bound anything — it moves the window, and the window
  # still runs to the 2,000-line cap.
  [[ -z "$3" ]] || return 0
  [[ -f "$file" && -r "$file" ]] || return 0
  # Rendered rather than returned as bytes, so a byte count measures nothing a
  # session pays for.
  case "${file,,}" in
    *.png | *.jpg | *.jpeg | *.gif | *.webp | *.bmp | *.svg | *.pdf | *.ipynb) return 0 ;;
  esac
  # No leading zero (bash reads 08 as octal and errors), and narrow enough that
  # first + READ_LINE_CAP cannot overflow into a range sed rejects.
  first=1
  [[ "$offset" =~ ^[1-9][0-9]{0,8}$ ]] && first="$offset"
  last=$((first + READ_LINE_CAP - 1))
  # `q` AFTER `p`, and both are load-bearing. Without the quit sed reads to EOF,
  # which on a 400 MB file is over a second inside a hook the session waits on
  # and whose timeout is 10s; with the quit it is immediate. The order matters
  # too — quitting first would drop line `last` from the count.
  # RESIDUAL: no test pins the quit. A test file small enough to run fast reads
  # to EOF in milliseconds without it, and timing a large one is §X9's wall-time
  # assertion (#1916).
  #
  # `--` because a Read of a relative path beginning with a dash reaches here
  # before the tool itself rejects it, and sed would read it as options.
  bytes="$(sed -n "${first},${last}p;${last}q" -- "$file" 2>/dev/null | wc -c | tr -d ' ')"
  status="${PIPESTATUS[0]}"
  # `wc` prints 0 for a sed that failed, so without this a broken measurement is
  # indistinguishable from an empty file and reaches check-guard-errors.js as
  # nothing at all. Recorded, then dropped — a measure that failed is not a
  # finding (mantahostels#147).
  if ((status != 0)) || [[ ! "$bytes" =~ ^[0-9]+$ ]]; then
    gl_log "could not measure $file for the Read limb — this call judged unchecked"
    return 0
  fi
  ((bytes >= WIDE_READ_BYTES)) || return 0
  # Once per agent and file (#1034): a second warning on a file the agent
  # chose to read whole a first time changes nothing. The latch is gp_latch_path's, keyed on (agent, session), so a
  # subagent's first wide read of a file the parent already read still warns.
  # The path is hashed because gp_latch_path maps `/` to `_`, which would let
  # `a/b.md` and `a_b.md` share a latch, and a long path outgrow a filename.
  READ_LATCH="$(printf '%s' "$file" | sha1sum 2>/dev/null | cut -c1-16)"
  if [[ "$READ_LATCH" =~ ^[0-9a-f]{16}$ ]]; then
    READ_LATCH="wide-read.$READ_LATCH"
    gp_rule_told "$READ_LATCH" && return 0
  else
    # Unhashed, every file would share one latch and the first warning would
    # silence the rest.
    gl_log "could not hash $file for the Read limb's latch — warned unlatched"
    READ_LATCH=""
  fi
  # Deliberately NOT limb 1's opening words. scripts/guard-fire-needles.json
  # attributes a fire by matching the text, and a shared opening would count
  # every Read fire as a `cat` one.
  FINDINGS+=("This \`Read\` pours a whole file into context: $file returns ${bytes} characters, and every one of them stays in the window for the rest of the session. Read the part you need instead — one call, \`Read\` with \`offset\` and \`limit\` — after \`grep -n '<pattern>' $file\` to find the line to start at.")
}

FOOTER="Why this fires and what the convention asks for: docs/agents/tool-output.md. It only ever warns."

if [[ "$TOOL" == "Read" ]]; then
  judge_read "$(gp_subject)" \
    "$(gp_payload_field '.tool_input.offset')" \
    "$(gp_payload_field '.tool_input.limit')"
else
  # BOUNDED, read off the raw subject: see LIMITS above for what that costs.
  case "$(gp_subject)" in *'|'* | *'>'*) gp_allow ;; esac

  gp_walk_commands judge
fi

((${#FINDINGS[@]})) || gp_allow

printf -v joined '%s\n\n' "${FINDINGS[@]}"
# Emit, THEN latch (mantahostels#2261): a hook cancelled at its timeout has its
# stdout discarded, and a latch written first would never let it retry.
gp_context "${joined%$'\n\n'}

$FOOTER" || {
  gl_log "the warning did not render — this call allowed unwarned"
  exit 0
}
[[ -z "$READ_LATCH" ]] || gp_rule_mark_told "$READ_LATCH"
exit 0
