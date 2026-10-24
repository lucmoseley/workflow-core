#!/usr/bin/env bash
# PreToolUse guard: this Bash command writes over a file a live session holds
# (mantahostels#1818, split out of mantahostels#1772).
#
# Why: scripts/guard-file-claim.sh sees Write, Edit and NotebookEdit only, so a
# redirect, a `cp`, a `sed -i` reaches a claimed file with nothing said (mantahostels#1772).
#
# WARN, NEVER DENY — mantahostels#287 declined a Bash-route deny on price: the parser is
# outrunnable (mantahostels#201), so a parser miss must cost a missing reminder rather than
# a wrong refusal.
#
# TIER 1 ONLY, FOR THE WARNING — `docs/`, `.claude/`, `CLAUDE.md`, `AGENTS.md`.
# The `scripts/` tier is detect-only by mantahostels#287's own ruling and a prompt there buys
# the least; adding it is a separate call (mantahostels#1772).
#
# IT ALSO CREDITS, AND THAT HALF IS NOT TIER-BOUND (mantahostels#2778). Every literal write
# target matching lib/code-signal.sh's CODE globs is handed to the judge on a
# `--credit` flag, which appends it to THIS session's write ledger — but only
# where no OTHER live session holds a claim on it. The contention skip is the
# whole safety argument, and it is structural rather than a matter of parser
# accuracy: mantahostels#114 bars over-billing because a nag against a
# neighbour's file sends a session into the collision guard-file-claim.sh exists
# to refuse, and skipping a contended path removes exactly that harm.
#
# PreToolUse, so it credits INTENT, not an outcome — record-write.sh is POST for
# a reason, and that reason is that a write the claim guard DENIED must not be
# billed. Nothing denies a Bash write over a claimed file, so that case cannot
# arise here, and a command refused or failing for any other reason costs
# nothing: the backstop intersects the ledger with its own
# `git diff --name-only`, so a path that did not change is dropped before it is
# counted.
#
# The judge is scripts/warn-claimed-bash-write.js because the command line can
# only be read in bash, the claim store only in node.
#
# WHAT BOUNDS ITS PER-SESSION COST (mantahostels#2345). A SESSION LEDGER — one file per
# (agent, session) in gp_rule's marker family, named below — which the judge
# reads on every firing and writes whenever it has something new to say. Two
# limbs:
#
#   the (lock, holder, target)  a line already delivered this session is not
#   triple                      delivered again. Not the rule: a second command
#                               against a different held path, or the same path
#                               under a new holder, is news and arrives in full.
#                               The target is in the key because the LINE names
#                               it — one lock, two write targets, two facts.
#   2,000 B a session           SESSION_BUDGET_BYTES, across every firing and
#                               INCLUDING the pointer that replaces the payload
#                               once it is spent.
#
# THE 2,000 B PRICES A STATED CASE (mantahostels#2363, re-derived at mantahostels#3568):
# two deliveries of the fixed prose and the pointer that ends them, the first
# carrying two 129 B claim lines at `docs/doc-map.md` joined by a charged
# newline, the second one. The *prices the session budget* test in
# scripts/warn-claimed-bash-write.test.ts measures the fixed prose off real
# firings and holds that case under the constant, and a third delivery over it;
# the 129 B is this header's, which the test reads and never checks.
#
# WHAT IT OVERRUNS. check-context-budget.js cannot census this payload, so the
# 2,000 B sits ON TOP of whatever it measures for PreToolUse Bash against route
# (f)'s SESSION_CAP_BYTES, and the first hour overruns that cap. Read both
# figures with `npm run check:context`; check-context-budget.js's own docstring
# carries where the cap comes from and every seed it retired.
#
# THERE IS NO WORST CASE. Under the decay below each further hour adds another
# 212 B, and where no ledger can be built at all (below) nothing bounds the
# session. NO FIGURE FIXES THE OVERRUN EITHER: one payload's floor has exceeded
# route (f)'s headroom every time both were taken (mantahostels#2345,
# mantahostels#2363), so every budget that leaves this guard able to name a path
# overruns.
#
# THE POINTER DECAYS HOURLY (mantahostels#2364), on POINTER_DECAY_MS, and is said again on a
# contended pair this session has not already been handed — NOT on unchanging
# contention, which the pair filter drops before the decay is reached. Not a
# terminal latch: the house shape for a bounded repeat is the
# arbiter `request` marker's hourly decay, and what a latch silences is a
# clobber warning — the direction AGENTS.md §Supervision priors says to err away
# from.
#
# WHERE NO LEDGER CAN BE BUILT the bound does not apply at all — an unresolved
# repo root or a missing session key drops `--ledger`, and the judge then falls
# back to the 4,000 B per-delivery ceiling with nothing counting across firings.
# Both are logged.
#
# A compaction clears the ledger with every other rule latch.
#
# NO LOCK ON THE LEDGER, deliberately. Two hooks for one session can read-modify-
# write it at once; every way that race resolves errs toward SAYING a line again,
# never toward suppressing one unsaid. A lock would cost a fork on the hot path.
#
# REJECTED — making check-context-budget.js count it. That checker censuses
# `rule_text <id>` calls, so being counted means fetching a fragment, and route
# (f)'s Bash cap had 205 B of headroom against the 1,027 B that would take
# (mantahostels#2345). The bound above holds the line instead, and nothing gates it.
#
# It carries NO `if` narrowing: a redirect can head with any word at all, so no
# command-prefix pattern would reach the dominant form.
#
# THE ROUTES IT READS are lib/guard-parse.sh's gp_write_targets, every spelling
# the guard tier reads (#1827): nine write routes, three deletions.
#
# AND A TENTH ARM THAT RESOLVES NOTHING (mantahostels#2854). Where a command runs an INLINE
# INTERPRETER — `python`, `python3`, a versioned `python3.12`, `node` or
# `nodejs`, with `-c` (python) or `-e`/`--eval`/`-p`/`--print` (node), or with a
# heredoc or here-string — every tier-1 path the command QUOTES
# anywhere is handed to the judge as a candidate. Both limbs are required: a
# plain `grep 'docs/x.md'` has the path and not the interpreter, and says
# nothing.
#
# WHY IT CANNOT RESOLVE ONE. The destination is a string inside a program in
# another language, and this read-modify-write is the form the Bash route's
# unannounced share is made of (mantahostels#2833). The arm names candidates and the judge
# decides which of them a live neighbour holds, so a command quoting five paths
# of which one is held still produces one line. The credit half (mantahostels#2778)
# is not extended to it — add_target below carries why — but every path-shaped
# candidate, of ANY tier, goes on the SELECTION ledger instead (#1220), which
# test selection alone reads.
#
# AND THE PATHS AN `rm`, `git rm` OR `git mv` NAMES GO ON THAT LEDGER TOO, and
# nowhere else (#1791): a deletion through Bash mints no write, so an overlay
# test run kept HEAD's copy of a file the session had removed.
#
# WHAT IT COSTS is on mantahostels#2854: its firing and false-warn rates, and the
# per-session candidate distribution the budget rests on. Those rates
# OVER-COUNT by an unmeasured margin (mantahostels#2865): they predate the scan's
# stop at the script. Re-deriving means re-running
# scripts/measure-bash-write-firing/, never adjusting the numbers.
#
# THE SELECTION LEDGER COSTS A NODE START (#1220) on every inline-interpreter
# call quoting a path-shaped token, and on every deletion naming a TRACKED path
# (#1791); the measured figures are on #1220 and #1791. A deletion's paths cost
# one `git ls-files` first, so scratch under `.claude/tmp/` reaches no node. A host
# whose tests never read it skips the node start, every such call paying a
# grep to find out (#1245).
#
# THE SESSION BUDGET STAYS AT 2,000 B under this arm (mantahostels#2854): firings do not
# spend it, DELIVERIES do, and a delivery needs a live neighbour holding that
# exact path. THE POINTER IS REACHED SOONER all the same, since this arm puts
# more candidates in front of the judge — not silence, POINTER_DECAY_MS saying
# it again hourly on fresh contention.
#
# LIMITS
#  - The NINE ROUTES read the PARSED command form, never a substring, so a grep,
#    an echo or a heredoc MENTIONING a guarded path passes them. Quoted spans and
#    heredoc bodies are removed before parsing (lib/guard-parse.sh, mantahostels#123) — which
#    also means a heredoc's own redirect target IS read, but its body is not.
#  - THE TENTH ARM IS THE INVERSE, a mention being all it has. Its scan is over
#    the RAW command string and its scope is the WHOLE command rather than the
#    interpreter's own segment, because a heredoc body belongs to no segment at
#    all — so `node -e '…' && grep "docs/x.md" y` names the grep's path too. It
#    reads CWD_MOVED's final value, so a `cd` anywhere in the command drops every
#    relative candidate — a missed warn, the direction this guard errs. A quote
#    must be closed by its own kind and escapes are not read, so
#    `node -e "a(\"docs/z.md\")"` — a backslashed inner quote — is
#    the arm's largest miss class. CANDIDATE ORDER IS BY QUOTE KIND, never
#    source order — quoted_tokens makes one pass per quote character — so
#    nothing downstream may read the list positionally.
#  - AN INLINE PROGRAM ARRIVING BY PIPE is not read (mantahostels#2865): `echo '…' | python3`
#    is inline by every measure this arm cares about, and inline_interp needs a
#    flag or a heredoc opener on the interpreter's own word list to say so. The
#    heredoc route (`python3 - <<'PY'`) is the stdin spelling that IS read.
#  - A write by any other spelling — `dd of=`, `install`, `rsync`, a wrapper
#    script, `xargs` — is not seen, the first three having been measured as too
#    rare to read (mantahostels#2854 §Not in scope).
#  - What gp_write_targets leaves unread is unread here: `git checkout <path>`
#    without `--`, a git global option, a command word behind `sudo` or `env`.
#  - Relative paths resolve against the HOOK's cwd, never the command's, and they
#    need not exist; one is dropped wherever a `cd` has moved the two apart
#    (mantahostels#2807, CWD_MOVED below). The cwd is tracked textually and only as far
#    as it reads: an unresolvable target, a `pushd` or a bare `cd` all count as
#    moved, which costs a missed warning rather than a wrong one. A `cd` spelled
#    anywhere this walk does not see it — inside a script it runs, an
#    `env --chdir`, a `git -C` — leaves the walk believing it never moved, and
#    THAT is the direction that still over-bills. A SUBSHELL errs the other way: the
#    flattener splits `(` and `)` away, so `(cd /x && …); tee y.sh` is read as
#    moved for the rest of the command and the later write is dropped, a missed
#    credit.
#    The file need not EXIST: requiring it would go silent on
#    every redirect creating a new file, which is the dominant form here.
#  - A join mantahostels#287 named stays open: a write-shaped line swallowed into a
#    mis-paired multi-line string above it is invisible. `_gp_guarded_head`
#    is not widened to bound that join (mantahostels#1818): it
#    made `guard-npm-install.sh` deny a benign command whose prose named an
#    install (guard-parse.sh's own comment, and guard-wide-read.sh:56-61, which
#    rules the same trade out).
#  - The tier test in add_target is a SPAWN-SAVER, not the authority: node's
#    `store.isGuarded` decides, and this prefix list only avoids a node start on
#    the overwhelming majority of Bash calls. Drift makes it UNDER-fire — a
#    missed warning, never a wrong one.
#  - The credit half inherits EVERY limit above: a spelling not read, a target
#    behind a variable, a heredoc body. So it narrows the mantahostels#2778 gap rather than
#    closing it (mantahostels#296).
#  - It FAILS OPEN throughout, house style (mantahostels#103 §6), and records the fail-opens
#    that matter through lib/guard-log.sh (mantahostels#147). ONE LIMB FAILS CLOSED: a
#    rule-text store fault under the restore rule's gp_rule exits 2 and refuses
#    the command, gp_rule's own contract (mantahostels#1762).
#  - THE WHOLE-FILE RESTORE RULE (#2028) reads three of the nine routes — a `cp`
#    or `mv` destination, a `git restore` path, a `git checkout --` path — over
#    any tier, plus every word of a `git checkout` with no `--`, and fires only
#    where `git diff HEAD` finds the path changed. A `Write` putting a whole
#    file back and a `git -C` restore are never seen, and the rule lands with
#    the command's result, after the restore has run. It never denies: `git restore -- <your
#    paths>` is the sanctioned discard (#1953), and whose edits a changed file
#    holds cannot be read off the command — the inference mantahostels#103 warns on.
#
# IMPLICIT:  before a Bash command whose write target is a tier-1 guarded path — or, where it runs an inline interpreter, whose QUOTED tier-1 paths include one (mantahostels#2854) — injects the live claims standing on exactly those paths, each once a session within a 2,000 B session budget, then an hourly pointer; credits an uncontended code target to this session's write ledger (mantahostels#2778); and notes an inline interpreter's quoted paths, and the paths an `rm`, `git rm` or `git mv` names, on its selection ledger (#1220, #1791), in a host whose `test` script runs run-vitest.js (#1245); and hands over `rule:whole-file-restore` once a session where a `cp`, `mv`, `git restore` or `git checkout --` writes a tracked file holding uncommitted changes (#2028).
# JUSTIFIED: fail-safe — it refuses nothing but a rule-store fault, exits 0 on every other path, is silent unless another LIVE session holds a path this command writes or the command restores a file holding uncommitted changes, and credits nothing a live neighbour holds.
# DEFEAT:    write by a spelling the routes above do not name, or from a cwd moved by a `cd` this walk cannot see; neither is detected.

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

gp_begin '.tool_input.command' command

# shellcheck source=scripts/lib/guard-root.sh
source "$here/lib/guard-root.sh"
root="$(gr_root)"

# The write targets, absolute. Filled by the walk below, which runs in this scope.
TARGETS=()

# The paths this command writes that concision-backstop.sh would count as CODE,
# repo-relative (mantahostels#2778). A SEPARATE list from TARGETS on purpose: TARGETS is the
# tier-1 set the warning names, and mantahostels#1772 kept `scripts/` out of that
# deliberately. These are never warned about — they are handed to the judge to
# credit to this session's write ledger where no OTHER live session holds them.
CREDIT=()

# The paths an inline interpreter QUOTES, or a deletion arm names, repo-relative
# and of any tier (#1220, #1791), for the selection ledger only.
SELECT=()

# The paths a deletion arm names, repo-relative (#1791).
DELETED=()

# The paths a whole-file restore writes, repo-relative and of any tier (#2028).
RESTORED=()

# HAS THE COMMAND MOVED OFF THE TREE THIS HOOK IS READING? (mantahostels#2807) A relative
# write target resolves against the COMMAND's cwd; rel_path below resolves it
# against the hook's. Where a `cd` has moved the two apart, the two spellings
# name different files, and add_target drops the word rather than naming the
# shared tree's copy of a file the command never touches.
#
# REJECTED — dropping every target on any `cd` at all, because `cd <repo root>`
# and stay is the dominant idiom and compares equal here.
# Figures on mantahostels#2807. A `pushd` to the root is the one such idiom this guard still
# counts as moved.
#
# `gp_cwd` in lib/guard-parse.sh does the same job for gp_walk_commands (mantahostels#3453),
# and is NOT reused: the two are not equivalent — the lib harvests a segment's
# variable assignments first, so it resolves `WT=/x; cd "$WT"` where this arm
# reads that target as unknown and counts it moved.
CWD_MOVED=0

# Did any command here run an inline interpreter — a program given on the
# command line or on stdin rather than as a script file (mantahostels#2854)? Set by the
# walk, read once after it, because the candidate scan it gates reads the RAW
# command string and so belongs to no one segment.
INLINE_INTERP=0

# Collapse `.`, `..` and doubled slashes in an ABSOLUTE path:
# lib/guard-parse.sh's gp_norm_abs, which carries why it is textual, under the
# name this file's `cd` walk reads as.
norm_dir() { gp_norm_abs "$1"; }

# The hook's own cwd, normalised once, and the running cwd the walk tracks
# against it. Empty is UNKNOWN, never $PWD.
PWD_NORM="$(norm_dir "$PWD")"
WALK_CWD="$PWD_NORM"

# lib/code-signal.sh's CODE globs, spelled again here. A drift makes this
# guard credit a file the backstop does not count, or miss one it does — the
# first is inert (the backstop intersects with its own diff), the second is the
# gap mantahostels#2778 exists to close, reopened silently.
#
# TWO LIMBS, because that array has two: the extensions, and `.husky/` — the six
# Husky hooks carry no extension and the globs miss them (mantahostels#2779).
# guard-claimed-bash-write.test.ts reads the array off disk and holds the two in
# step.
CODE_EXT='js|mjs|cjs|ts|tsx|jsx|py|sh'
CODE_DIR='.husky/'

# Repo-relative spelling of a word, or non-zero where it is not inside the repo.
# Purely textual: a path need not exist to be a write target.
rel_path() {
  local p="$1"
  [[ "$p" == /* ]] || p="$PWD/$p"
  # No realpath: the file may not exist yet, and its parent directories may not
  # either. Two spellings of one path can therefore reach node separately, which
  # costs a duplicate line at worst.
  [[ "$p" == "$root/"* ]] || return 1
  p="${p#"$root/"}"
  # A `..` segment climbs back out of the repo, and the prefix test above cannot
  # see it — `$root/../elsewhere/x.ts` starts with `$root/` textually
  # (mantahostels#2778). Rejected rather than resolved: realpath would need
  # the file to exist, which a write target need not.
  case "$p" in
    ../* | */../* | */.. | ..) return 1 ;;
  esac
  printf '%s' "$p"
}

# One word, sorted into the two lists above. An unreadable word — an unexpanded
# $VAR, a command substitution — is dropped from BOTH rather than guessed at,
# which is what keeps the credit list from ever naming a path this command may
# not be writing.
#
# A path can land in both: `.claude/skills/x/run.sh` is tier-1 AND code.
#
# `$2` is `candidate` for the inline-interpreter arm (mantahostels#2854), whose paths are
# merely QUOTED somewhere in the command rather than resolved as its write
# destination. A candidate is warned about and never credited: crediting the
# write ledger needs a resolved target, and mantahostels#114 bars over-billing.
# It goes on SELECT instead where it is path-shaped — a `/` or a `.` and no
# byte a path here never carries — which keeps `'utf-8'` and `'\n'` off it;
# anything else that gets through is inert, the reader intersecting with git's
# dirty set. `delete` is the deletion arms' (#1791): DELETED alone, never warned.
add_target() {
  local word="$1" mode="${2:-write}" lit rel
  lit="$(gp_literal "$word")" || return 1
  [[ -n "$lit" && "$lit" != -* ]] || return 1
  lit="${lit#./}"
  # An ABSOLUTE target names the same file from any cwd; a relative one does not
  # (mantahostels#2807, and see CWD_MOVED above).
  [[ "$lit" == /* ]] || ((CWD_MOVED == 0)) || return 1
  rel="$(rel_path "$lit")" || return 1
  [[ "$mode" == delete ]] || case "$rel" in
    docs/* | .claude/* | CLAUDE.md | AGENTS.md)
      if [[ "$lit" == /* ]]; then
        TARGETS+=("$lit")
      else
        TARGETS+=("$PWD/$lit")
      fi
      ;;
  esac
  if [[ "$mode" == delete ]]; then
    DELETED+=("$rel")
    return 0
  fi
  if [[ "$mode" != "write" ]]; then
    [[ "$rel" =~ ^[A-Za-z0-9._@+/-]+$ && "$rel" =~ [./] ]] && SELECT+=("$rel")
    return 0
  fi
  # Repo-relative, because that is the spelling the write ledger holds and the
  # backstop's `grep -Fx` compares against.
  if [[ "$rel" =~ \.($CODE_EXT)$ || "$rel" == "$CODE_DIR"* ]]; then
    CREDIT+=("$rel")
  fi
  return 0
}

# Does this command run its program from the command line, or from a heredoc or
# here-string, rather than from a script file (mantahostels#2854)? `-c` for python,
# `-e`/`--eval`/`-p`/`--print` for node, and a heredoc or here-string opener for
# either, read off gp_redirects — only a heredoc's BODY is dropped as data.
#
# A PIPE IS NOT READ (mantahostels#2865): treating a bare `python3` as inline would fire on
# every `python3` in a pipeline.
#
# THE SCAN STOPS AT THE SCRIPT, and must: a flag past the module or file name
# belongs to the PROGRAM, not to the interpreter, so scanning the whole word
# list fired on `python3 -m pip install -c "docs/x.md"` and on
# `node scripts/foo.js -e "docs/x.md"`, neither of which runs an inline program.
# A bare `-` reads as a flag, which is what `python3 - <<'PY'` needs.
#
# TWO MISSED WARNS IT COSTS, both the safe direction: a bundled short option
# (`python3 -uc '…'` is valid and reads as no inline flag), and a separate-value
# flag before the inline one (`python3 -W ignore -c '…'` stops at `ignore`).
#
# THE HEREDOC TEST IS BOUNDED BY THAT STOP (mantahostels#2865), not unconditional:
# `node script.js <<'EOF'` stops at `script.js`, so a heredoc feeding DATA to a
# script file says nothing.
inline_interp() {
  local prog="$1" word kind
  shift
  for word in "$@"; do
    case "$prog" in
      node*) case "$word" in -e* | --eval* | -p* | --print*) return 0 ;; esac ;;
      *) case "$word" in -c*) return 0 ;; esac ;;
    esac
    [[ "$word" == -* ]] || return 1
  done
  gp_redirects
  for kind in ${_gp_redir_kind+"${_gp_redir_kind[@]}"}; do
    [[ "$kind" == heredoc || "$kind" == here-string ]] && return 0
  done
  return 1
}

# Every quoted whitespace-free token in $1, deduplicated, one per line.
#
# IT READS THE RAW COMMAND STRING, never the parsed words: the path this arm
# looks for is a string inside a program in another language, so it is either a
# heredoc body lib/guard-parse.sh has dropped as data or a span it has already
# blanked to a sentinel.
#
# THREE PASSES, NOT ONE CHARACTER CLASS, so an opening quote must be closed by
# its OWN kind — `"docs/a.md'` is not a token. Backticks are read because a node
# heredoc's template literal is the ordinary spelling there.
quoted_tokens() {
  local text="$1" tok q pat
  local -A seen=()
  for q in "'" '"' '`'; do
    pat="${q}[^${q}[:space:]]+${q}"
    while IFS= read -r tok; do
      tok="${tok:1:${#tok}-2}"
      [[ -n "$tok" && -z "${seen["$tok"]+set}" ]] || continue
      seen["$tok"]=1
      printf '%s\n' "$tok"
    done < <(printf '%s' "$text" | grep -oE "$pat")
  done
  return 0
}

# add_restores <word>... — note the whole-file restores among the rows
# gp_write_targets just answered for this command, picked by their route.
add_restores() {
  local i word base next=0
  for i in "${!_gp_wt_mode[@]}"; do
    [[ "${_gp_wt_mode[i]}" == write ]] || continue
    case "${_gp_wt_route[i]}" in
      cp | mv | 'git restore' | 'git checkout') note_restore "${_gp_wt_target[i]}" ;;
    esac
  done
  # `git checkout <path>` with no `--`, which gp_write_targets leaves unread
  # because the word is as often a revision, so answers no row to route: every
  # word is a candidate.
  base="$(gp_literal "${1-}")" || return 0
  [[ "${base##*/}" == git && "$(gp_literal "${2-}")" == checkout ]] || return 0
  [[ " ${*:3} " != *" -- "* ]] || return 0
  for word in "${@:3}"; do
    if ((next)); then
      next=0
      continue
    fi
    case "$word" in
      -b | -B | --orphan) next=1 ;;
      -*) ;;
      *) note_restore "$word" ;;
    esac
  done
  return 0
}

# note_restore <word> — RESTORED gains the word's repo-relative path, on the
# cwd rule add_target applies.
note_restore() {
  local lit rel
  lit="$(gp_literal "$1")" || return 0
  [[ -n "$lit" ]] || return 0
  [[ "$lit" == /* ]] || ((CWD_MOVED == 0)) || return 0
  rel="$(rel_path "$lit")" && RESTORED+=("$rel")
  return 0
}

# One command the string runs, its own words as $2 onward.
judge() {
  shift # the flattened segment; only the words are read here
  local base dest i
  local -a cdw=("$@")

  # A `cd`/`pushd` moves the cwd every LATER segment's relative paths resolve
  # against (mantahostels#2807). gp_walk_commands runs its callback in this scope and in
  # source order, no subshell anywhere, so the flag below carries across.
  #
  # A `cd` writes nothing itself, so this arm returns before the routes below.
  # `popd` and a bare `cd` are counted as MOVED rather than tracked: the
  # directory stack is not read here, and $HOME is not the repo. Being wrong in
  # that direction costs a missed credit, never a wrong one.
  #
  # THE HEAD IS FOUND PAST ANY GROUPING OR BUILTIN PREFIX, which the routes
  # below do NOT do: `_gp_flatten` splits on `;` but not on `{`, so a `cd` in
  # `{ cd /x; sed -i … y.sh; }` heads a segment beginning `{`. Widening the cd
  # arm alone is deliberate — reading MORE cds only ever moves a target from
  # credited to dropped, which is the safe direction, whereas widening the write
  # routes is a separate call this ticket does not carry.
  while ((${#cdw[@]})); do
    case "$(gp_literal "${cdw[0]}")" in
      '{' | '(' | do | then | else | elif | builtin | command | eval | time | '!')
        cdw=("${cdw[@]:1}")
        ;;
      *) break ;;
    esac
  done

  # `\cd` too — a leading backslash suppresses alias lookup and runs the same
  # builtin, and gp_literal hands the word back with the backslash on it.
  case "$(gp_literal "${cdw[0]-}")" in
    cd | \\cd)
      # An unreadable target — `cd "$WT"` — empties the running cwd rather than
      # leaving it stale, as _gp_parse_segment does for the git walk
      # (lib/guard-parse.sh:1335).
      if ((${#cdw[@]} >= 2)) && dest="$(gp_literal "${cdw[1]}")" && [[ -n "$dest" ]]; then
        if [[ "$dest" == /* ]]; then
          WALK_CWD="$(norm_dir "$dest")"
        elif [[ -n "$WALK_CWD" ]]; then
          WALK_CWD="$(norm_dir "$WALK_CWD/$dest")"
        fi # already unknown; a relative hop off nowhere is still nowhere
      else
        WALK_CWD=""
      fi
      [[ "$WALK_CWD" == "$PWD_NORM" ]] && CWD_MOVED=0 || CWD_MOVED=1
      return 0
      ;;
    pushd | popd)
      # The directory stack is not tracked: unknown from here on.
      WALK_CWD=""
      CWD_MOVED=1
      return 0
      ;;
  esac

  # Every route but the inline-interpreter arm, whatever word heads the command:
  # `foo bar > docs/x.md` is not named by its first word. Read as written, so
  # add_target resolves it against this guard's own cwd.
  gp_write_targets "$@"
  for i in "${!_gp_wt_mode[@]}"; do
    case "${_gp_wt_mode[i]}" in
      delete) add_target "${_gp_wt_target[i]}" delete ;;
      # `mv` destroys its sources, so a held one is clobbered as a write's is.
      write | move-source) add_target "${_gp_wt_target[i]}" ;;
    esac
  done
  add_restores "$@"

  base="$(gp_literal "${1-}")" || return 0
  base="${base##*/}"
  case "$base" in
    python | python[0-9]* | node | nodejs)
      shift
      inline_interp "$base" "$@" && INLINE_INTERP=1
      ;;
  esac
}

gp_walk_commands --bare-redirects judge

# The inline-interpreter arm's second limb (mantahostels#2854), the first being
# inline_interp above. Its scope is the WHOLE command string and CWD_MOVED's
# FINAL value, not the interpreter's own segment: a heredoc body belongs to no
# segment at all, so there is nothing narrower to scan. LIMITS at the head of
# this file has what both cost.
if ((INLINE_INTERP)); then
  while IFS= read -r cand; do
    add_target "$cand" candidate
  done < <(quoted_tokens "$(gp_subject)")
fi

# A deletion's paths, narrowed to the tracked files they are or hold — a
# directory `rm -r` names expanding to its files. Literal, so a `*` in a path is
# no glob. A git that will not answer notes none of them, and logs why. The
# NUL-split list fits no variable, so git's status rides in as the list's last
# record: `wait $!` on the process substitution would need bash 4.4, and below
# it an unset `$!` aborts the guard under `set -u` (#2075). The guard's floor
# is bash 4.3, set by lib/guard-parse.sh's `local -n` and `[-1]` subscripts.
if ((${#DELETED[@]})); then
  listed=()
  while IFS= read -r -d '' rel; do
    listed+=("$rel")
  done < <(
    git -C "$root" --literal-pathspecs ls-files -z -- "${DELETED[@]}" 2>/dev/null
    printf '%s\0' "$?"
  )
  ls_rc="${listed[-1]}"
  SELECT+=("${listed[@]:0:${#listed[@]}-1}")
  [[ $ls_rc -eq 0 ]] || { declare -F gl_log >/dev/null 2>&1 &&
    gl_log "git ls-files exited $ls_rc — a deletion's tracked files went unnoted in the selection ledger"; }
fi

# The selection ledger's one reader is run-vitest.js's overlay, so a host whose
# `test` script never runs it pays no node start for a note nothing reads
# (#1245). The match is lexical, on the script's text: mantahostels's
# resolve-core.js wrapper names run-vitest.js and matches, and a wrapper that
# does not name it drops the note. A host with no package.json is the expected
# non-reader, so a missing or unreadable file is no fault worth logging.
if ((${#SELECT[@]})) && ! grep -qE '"test": *"[^"]*run-vitest\.js' "$root/package.json" 2>/dev/null; then
  SELECT=()
fi

# A restore over a file with uncommitted changes discards them all (#2028).
# Against HEAD, so a staged edit counts; exit 1 alone means a difference, and a
# git that cannot answer stays silent on the restore, and logs why. HEAD is resolved first because outside a
# repository `git diff` falls back to --no-index, where exit 1 means nothing.
restore_owed=0
if ((${#RESTORED[@]})); then
  if git -C "$root" rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
    git -C "$root" --literal-pathspecs diff --quiet HEAD -- "${RESTORED[@]}" >/dev/null 2>&1 &&
      diff_rc=0 || diff_rc=$?
  else
    diff_rc=128
  fi
  if ((diff_rc == 1)); then
    restore_owed=1
  elif ((diff_rc > 1)); then
    declare -F gl_log >/dev/null 2>&1 &&
      gl_log "git diff exited $diff_rc — a whole-file restore went unjudged"
  fi
fi

if ! ((${#TARGETS[@]} + ${#CREDIT[@]} + ${#SELECT[@]})); then
  ((restore_owed)) || gp_allow
  gp_rule whole-file-restore
  gp_allow
fi

# The judge ships BESIDE this guard, so it is named from `$here` and not from
# the host root (#1): a plugin install keeps the pair together, and the host
# repo has no scripts/ of the core's at all.
judge_js="$here/warn-claimed-bash-write.js"
command -v node >/dev/null 2>&1 && [[ -f "$judge_js" ]] ||
  gl_open "warn-claimed-bash-write.js could not be run — a Bash-route write allowed unchecked"

# Without a session id the judge cannot tell a neighbour's claim from this
# session's own, and every warning it made would be about the reader's own work.
session="$(gp_payload_field '.session_id')"
[[ -n "$session" ]] ||
  gl_open "no session_id in payload — a Bash-route write allowed unchecked"

# The session ledger's path (mantahostels#2345). Spelled with gp_latch_path rather than
# rebuilt here: the marker must sit in clear-rule-latch.sh's glob byte for byte
# (mantahostels#1905) or it survives a compaction that has just thrown the payload it
# records away, and the session goes silent about a path it was never told.
#
# `led.` is a namespace of its own — a ledger is not a rule, and sharing
# gp_rule's marker name would make one write read as the other delivered.
#
# Code 1 is the unresolved root. This file's own `$root` is a DIFFERENT
# expression and does not stand in for that check.
#
# THE FINAL ARM IS NOT A TIDY-UP. The load gate at the top of this file asks for
# gp_begin alone, so a guard-parse.sh too old to carry gp_latch_path passes it
# and the substitution comes back 127 — which, folded into the key arm, would
# log a fault that never happened. Anything unrecognised names its own code.
#
# All four arms are covered only against a COPY of this file in a fixture tree
# (guard-claimed-bash-write.test.ts's withLatchRc): in place, gp_latch_path
# cannot be made to fail (mantahostels#2420).
ledger="$(gp_latch_path "led.claimed-bash-write")" && ledger_rc=0 || ledger_rc=$?
if [[ $ledger_rc -eq 1 ]]; then
  declare -F gl_log >/dev/null 2>&1 &&
    gl_log "repo root unresolved — the claimed-bash-write ledger is unwritable, so its payload repeats"
elif [[ $ledger_rc -eq 2 || $ledger_rc -eq 3 ]]; then
  declare -F gl_log >/dev/null 2>&1 &&
    gl_log "no session key — the claimed-bash-write ledger is unwritable, so its payload repeats"
elif [[ $ledger_rc -ne 0 ]]; then
  declare -F gl_log >/dev/null 2>&1 &&
    gl_log "gp_latch_path exited $ledger_rc — the claimed-bash-write ledger is unwritable, so its payload repeats"
fi

# One `--credit` per path rather than a delimited list: a repo path can hold
# any byte a delimiter could, and the argv array already carries the split.
judge_args=()
for rel in ${CREDIT+"${CREDIT[@]}"}; do judge_args+=(--credit "$rel"); done
for rel in ${SELECT+"${SELECT[@]}"}; do judge_args+=(--select "$rel"); done

warning="$(node "$judge_js" ${ledger:+--ledger "$ledger"} \
  ${judge_args+"${judge_args[@]}"} "$session" ${TARGETS+"${TARGETS[@]}"} 2>/dev/null)" ||
  gl_open "warn-claimed-bash-write.js exited non-zero — a Bash-route write allowed unchecked"

# Claude Code reads one hook object, so the claim warning rides ahead of the
# rule in gp_rule's envelope; once the rule is latched it goes out alone.
if ((restore_owed)); then
  [[ -z "$warning" ]] || gp_rule_prelude "$warning"
  gp_rule whole-file-restore
fi
[[ -n "$warning" ]] && gp_warn "$warning"
gp_allow
