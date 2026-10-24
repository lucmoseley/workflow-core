#!/usr/bin/env bash
# PreToolUse guard: a commit that lands a member of a repo-wide registry
# without the wiring that registers it (mantahostels#2671).
#
# Why: several of this repo's tests assert over the WHOLE repository rather than
# over one module — "every scripts/check-*.js is run by a hook, a workflow or
# another script", "every scripts/guard-*.{sh,js} is registered on a hook",
# "gives every registered hook an entry, so a new hook cannot arrive uncounted".
# An invariant of that shape is FALSE between the commit that adds the member
# and the commit that wires it, and it is false for everyone.
#
# So the member and its wiring land in ONE commit, and this judges that commit.
#
# FOUR CLASSES, each the exact predicate of the test it protects:
#
#   a new scripts/check-*.js      needs a sibling scripts/check-<name>.test.ts
#                                 and a caller — one of the four surfaces
#                                 checker-registrations.test.ts reads. Escape:
#                                 a CALLED_ELSEWHERE entry in the same commit.
#
#   a new scripts/guard-*.{sh,js} needs a sibling test, a registration in
#                                 self-plugin/hooks/hooks.json, a REGISTRATIONS
#                                 entry in hook-registrations.test.ts and a
#                                 guard-fire-needles.json entry. Escape: a
#                                 REGISTERED_ELSEWHERE entry in the same commit.
#
#   a self-plugin/hooks/hooks.json
#   hook added or removed         needs the needle registry and the
#                                 REGISTRATIONS table to move with it, in the
#                                 same direction — count-guard-fires.test.ts
#                                 fails on drift EITHER way.
#
#   an edit to text a             needs guard-fire-needles.json's `text` to
#   guard-fire-needles.json       move with it, and a needle ARRIVING keyed on
#   needle is keyed on            text nothing prints is the same fault written
#                                 backwards (mantahostels#2708). Both judged on the
#                                 containment count-guard-fires.test.ts asserts,
#                                 through scripts/lib/needle-corpus.js.
#
# A REPO WITHOUT THE CORE'S REGISTRIES IS JUDGED AGAINST ITS OWN (#1456).
# The files named above are the core's. Where the tree after the commit lacks
# the self-plugin file, a host's .claude/settings.json registers its hooks;
# where it lacks a registry, its demands move to the host-side file every
# adopter is seeded with: .claude/registrations.json — a `hooks` row for the
# REGISTRATIONS entry, a `registeredElsewhere` or `calledElsewhere` key for the
# two allowlists — and .claude/guard-fire-needles.json. A host sibling test may
# be any of SIBLING_SUFFIXES, and node <plugin>/scripts/check-registrations.js
# holds the whole-repo form (scripts/lib/registrations.js). A host file that
# does not exist yet is judged as empty.
#
# THE ONE TEMPORARY SPLIT THIS REPO PRODUCES, and what to do about it: a live
# session holds self-plugin/hooks/hooks.json or
# scripts/hook-registrations.test.ts, so guard-file-claim.sh denies the wiring
# edit and the commit cannot be atomic today. DO NOT take the allowlist for
# it — the allowlist says "nothing will ever wire this", which is a lie that
# outlives the claim. Ask for the file
# (`node scripts/session-arbiter.js request <path> "<why>"`), leave the new file
# UNCOMMITTED, and say so in the turn; guard-uncommitted-work.js caps at six
# blocks and a debt is registered either way.
#
# DENY, NOT WARN (mantahostels#103): every input is a structured fact — what the commit
# names, what HEAD holds, what the wiring files say — and the escapes are named
# in the refusal. It binds in a LINKED WORKTREE too: this guards no index, only
# the commit's own contents.
#
# WHAT SATISFIES A REQUIREMENT is judged against the tree AS IT WILL BE AFTER
# THE COMMIT, never the working tree: a wiring line sitting uncommitted in a
# file this commit does not name is exactly the split being refused.
#
# LIMITS
#  - Wired twice: `if: Bash(git *)`, as its neighbour guard-commit-form.sh is
#    (mantahostels#2127), and `if: Bash(*commit-paths.js*)` for the form CLAUDE.md
#    requires (#1727). Any other command never execs this script.
#  - A commit-paths.js `--patch` commit lands only its patch's hunks of each
#    file it carries, but each is judged whole from the working tree, so a
#    neighbour's uncommitted lines in one count as landing. A path holding
#    ` b/` is misread from the patch's `diff --git` line.
#  - Suppressed mid-merge, mid-rebase, mid-cherry-pick, mid-revert and mid-am.
#    A replay commit's contents were chosen by an earlier session, and refusing
#    it strands the sequence.
#  - The caller scan reads the DISK to find candidates and HEAD to judge them,
#    so a caller line that HEAD carries but an uncommitted edit has deleted is
#    never a candidate at all — a denial the suite would not make. On a bare
#    commit the same read misses a caller line staged and then deleted on disk.
#  - The caller scan is a plain substring search where the test strips
#    whole-line comments first. So a caller surface that merely MENTIONS the
#    checker in a comment reads here as a caller and the commit is allowed —
#    the test then fails on it. Deliberately the allowing direction.
#  - A landing path is read from the copy the commit will take: the INDEX for a
#    bare `git commit`, the working tree for a pathspec one and for `-a`, which
#    re-stages every tracked file on its way in (mantahostels#2734).
#  - `--pathspec-from-file` contributes no words, so a commit spelled that way
#    is judged on nothing and allowed.
#  - It sees the Bash tool only. A commit from the founder's own terminal, or
#    from inside a script, reaches no hook.
#  - A member REMOVED without its wiring is judged on ONE limb (mantahostels#2685): a
#    deleted scripts/check-*.js whose CALLED_ELSEWHERE entry stays behind reds
#    checker-registrations.test.ts, so that is refused. A deleted GUARD is not,
#    because nothing asserts a REGISTERED_ELSEWHERE entry still names a file
#    that exists — no test goes red, so there is no window to close.
#  - A deletion is read as "in HEAD, absent from the tree after this commit". A
#    `git rm --cached` leaves the file on disk, and a bare commit lands that
#    removal, which the index read sees. A PATHSPEC commit naming the
#    same path does not: git re-stages the working-tree copy, so the removal
#    never lands and there is nothing to judge (mantahostels#2734).
#  - judge_hook_list diffs (event, matcher, guardKey) TRIPLES, read through
#    scripts/lib/guard-fires.js so that this guard and count-guard-fires.test.ts
#    key a registration identically (mantahostels#2685). A registration this commit only
#    MOVES is therefore judged — but where ONLY the event or the matcher moved,
#    the demand is that scripts/hook-registrations.test.ts either lands in the
#    same commit or already spells the new event and the new matcher. The table
#    pins the matcher against the id positionally and no substring test here can
#    see that pairing, so both limbs are loose: a commit landing that file with
#    an unrelated edit passes, and so does one whose new matcher string appears
#    against some other registration.
#  - That extractor spawns node, twice, and only on a commit landing the
#    registration file. Anything it cannot parse — a mid-edit one included —
#    fails open, logged.
#  - A host's .claude/registrations.json is parsed by node with the
#    .claude/settings.json beside it, once per commit and only where a judgement
#    reaches it (#1670); a copy it cannot read or parse fails open, logged. A
#    moved hook needs only some row on its new event and matcher, not the row
#    pinning it.
#  - The needle-text limb reads guard-fire-needles.json from the tree AS IT WILL
#    BE — HEAD's copy wherever the commit does not land it — and the CORPUS from
#    the WORKING TREE for every file the commit does not land. So a literal a
#    neighbour's uncommitted edit still prints reads as printed here and the
#    commit is allowed.
#  - Containment is a plain substring search over every corpus byte, so a
#    literal quoted in a fixture, a rule fragment or a comment counts as
#    printed. TEST FILES are the exception, excluded from the corpus since
#    mantahostels#3288: a test asserting on a guard's wording carries its own copy, so a
#    needle keyed on it would pass while measuring nothing.
#  - The needle-text limb reads scripts/guard-fire-needles.json alone, so a
#    host's .claude/guard-fire-needles.json `text` drifting is unjudged.
#  - It judges the needle registry's `text` literals ONLY. A `routes`, a `kind`
#    or a `span` drifting is nothing it can see.
#  - It walks the corpus once and scans it per needle, on any commit landing a
#    file under one of scripts/lib/needle-corpus.js's CORPUS_DIRS. Only HEAD
#    copies of the LANDING files are fetched — a `git ls-tree` and a `git show`
#    each, so a directory pathspec naming hundreds of files spawns hundreds of
#    processes.
#  - It FAILS OPEN on anything it cannot resolve (mantahostels#103 §6) — a `cd`/`git -C`
#    target among it: a `$(…)`, a name assigned from one or after the command's
#    first `||` (#328), `${W:-x}`, an unset or empty-assigned name in a command
#    carrying `||`, `source`, `.` or `eval` — and every fail-open is RECORDED
#    (mantahostels#147) via lib/guard-log.sh.
#  - An UNSET variable in that target is read as empty (#313, #310's narrow
#    form): shell state does not carry between Bash calls, so `cd "$W"` with `W`
#    from an earlier call runs in the cwd, and is judged there. The refusal names
#    the variable. The reach and the hook-environment residual are
#    guard-branch.sh's LIMITS, the same opt-in (residual probed at #327).
#  - "Could not resolve the top level" is reachable only from a cwd inside a
#    repo's `.git` directory, which git classifies as the shared tree while
#    `--show-toplevel` fails. That fail-open lands nothing unjudged: `git commit`
#    there fails too, `must be run in a work tree` (exit 128, #313).

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — every commit allowed unchecked"
  exit 0
}

gp_begin '.tool_input.command' commit

git_bin="${WFC_GIT:-git}"

# The value-taking flags of `git commit`, so a message or an author never reads
# as a pathspec word. NOT a copy of guard-commit-form.sh's list, which judges a
# different set: `--trailer` is missing here and `-S`/`--gpg-sign` is added.
COMMIT_VALUE_FLAGS="-m --message -F --file -c --reedit-message -C --reuse-message \
--fixup --squash --author --date --cleanup -t --template -S --gpg-sign \
--pathspec-from-file"

# The paths this commit will land, repo-root-relative, one per line.
landing=""
# The pathspec words of the commit being judged.
pathspec_words=()
has_pathspec=0
# Did the commit carry -a/--all? It stages every tracked file's working-tree
# copy on its way in, so that copy is the one it lands and the index read below
# would judge stale bytes — in the DENYING direction (mantahostels#2734).
has_all=0

# gp_scan_flags's callback: it fills has_pathspec and pathspec_words in place.
commit_arg() {
  case "$1:$2" in
    # A file of paths is a pathspec this guard cannot read — see LIMITS.
    opt:--pathspec-from-file | dangling:--pathspec-from-file) has_pathspec=1 ;;
    flag:-) has_pathspec=1 ;;
    flag:-a | flag:--all) has_all=1 ;;
    arg:*)
      has_pathspec=1
      pathspec_words+=("$3")
      ;;
  esac
  return 0
}

# Is a sequence in progress in tree $1? Every verdict here stands down inside
# one — see LIMITS.
mid_sequence() {
  local gitdir
  gitdir="$("$git_bin" -C "$1" rev-parse --git-dir 2>/dev/null)" || return 1
  [[ "$gitdir" == /* ]] || gitdir="$1/$gitdir"
  [[ -e "$gitdir/MERGE_HEAD" || -d "$gitdir/rebase-merge" ||
    -d "$gitdir/rebase-apply" || -e "$gitdir/CHERRY_PICK_HEAD" ||
    -e "$gitdir/REVERT_HEAD" ]]
}

# Does the commit land $1?
in_landing() {
  [[ $'\n'"$landing"$'\n' == *$'\n'"$1"$'\n'* ]]
}

# Set in judge(): 1 where the commit names no pathspec, so it takes the INDEX
# copy of every landing path rather than the working-tree one (mantahostels#2734). Every
# accessor below reads the copy this commit will actually land, and each answers
# 0 yes, 1 no, 2 git could not tell — the callers below choose which way an
# unknown falls, because that differs limb by limb.
bare_commit=0

# Is $1 in the index? A `git ls-files` failure is not an absence, for the same
# reason head_names's is not.
index_names() {
  local out
  out="$("$git_bin" -C "$tree" ls-files --full-name --cached -- "$root/$1" 2>/dev/null)" ||
    return 2
  [[ -n "$out" ]]
}

# Will the file $1 exist after this commit lands it?
landing_exists() {
  ((bare_commit)) && {
    index_names "$1"
    return
  }
  [[ -e "$root/$1" ]]
}

# Does the copy of $1 this commit lands hold the literal $2?
landing_holds() {
  local body rc
  if ((bare_commit)); then
    index_names "$1"
    rc=$?
    ((rc == 0)) || return "$rc"
    # `:<path>` is the index entry at stage 0, and its path is read from the top
    # of the working tree — so a repo-root-relative path is right even when the
    # commit runs from a subdirectory.
    body="$("$git_bin" -C "$tree" show ":$1" 2>/dev/null)" || return 2
    [[ "$body" == *"$2"* ]]
    return
  fi
  [[ -e "$root/$1" ]] || return 1
  grep -qF -- "$2" "$root/$1" && return 0
  [[ -r "$root/$1" ]] || return 2
  return 1
}

# The INDEX bytes of $1, on stdout — for a caller that needs a FILE rather than
# a containment answer. The working-tree copy needs no accessor: it is already a
# file, at $root/$1.
index_bytes() {
  local rc
  index_names "$1"
  rc=$?
  ((rc == 0)) || return "$rc"
  "$git_bin" -C "$tree" show ":$1" 2>/dev/null || return 2
}

# Is $1 in HEAD's tree? 0 present, 1 genuinely absent, 2 git could not tell.
#
# A git FAILURE is not an absence (mantahostels#2671 review): an unborn HEAD, a corrupt tree
# or an unreadable object store would otherwise read as "the wiring is not
# there" and DENY — the one direction this guard must never fail in.
#
# DO NOT REACH FOR `cat-file -e "HEAD:$path"` HERE. It cannot make the split
# (mantahostels#2702): exit 128 is the ORDINARY ABSENCE — a path HEAD's tree does not name —
# and 128 again for every break, while its exit 1 is a break of its own, a tree
# entry whose object is gone.
#
# `ls-tree` mostly separates them: absence is an exit 0 naming nothing, and a
# corrupt commit or tree exits non-zero. NOT ALWAYS — a break can exit 0 naming
# nothing too, reading here as absence (mantahostels#2702). That shape reaches no judgement:
# `git ls-files` answers the same way, so `landing` comes back empty and judge()
# returns before any of this.
#
# --full-tree: ls-tree's pathspec is CWD-relative, and every path here is
# repo-root-relative while $tree is the commit's own directory. Without it a
# commit run from a subdirectory reads every HEAD path as absent (mantahostels#2702) —
# the denying direction on two of the four callers.
#
# A blob present but CORRUPT still reads present here — the `git show` in
# head_holds is what catches that one.
head_names() {
  local out
  out="$("$git_bin" -C "$tree" ls-tree --full-tree --name-only HEAD -- "$1" 2>/dev/null)" ||
    return 2
  [[ -n "$out" ]]
}

# Does HEAD's copy of $1 hold the literal $2? A break answers YES, which allows.
head_holds() {
  local body rc
  head_names "$1"
  rc=$?
  ((rc == 1)) && return 1
  ((rc == 0)) || {
    gl_log "git could not read HEAD's tree for $1 in $tree — that wiring requirement was treated as met and the commit allowed unchecked"
    return 0
  }
  body="$("$git_bin" -C "$tree" show "HEAD:$1" 2>/dev/null)" || {
    gl_log "git could not show HEAD:$1 in $tree — that wiring requirement was treated as met and the commit allowed unchecked"
    return 0
  }
  [[ "$body" == *"$2"* ]]
}

# Will the tree AFTER this commit hold the literal $2 in the file $1? A landing
# path is read from the copy the commit takes; any other path is read from HEAD,
# because this commit does not touch it.
will_hold() {
  local rc
  if in_landing "$1"; then
    # A path this commit lands but cannot be read is a fail-open, not an
    # absence — the same asymmetry head_holds fixes on the HEAD side.
    landing_holds "$1" "$2"
    rc=$?
    ((rc == 2)) || return "$rc"
    gl_log "could not read the copy of $1 this commit lands in $tree — that wiring requirement was treated as met and the commit allowed unchecked"
    return 0
  else
    head_holds "$1" "$2"
  fi
}

# Will the file $1 exist at all after this commit? A landing path is read from
# the copy the commit takes, so one this commit DELETES reads as absent rather
# than as present (mantahostels#2685).
#
# Absence here is what DENIES ("no sibling test"), so a break answers YES.
will_exist() {
  local rc
  if in_landing "$1"; then
    landing_exists "$1"
    rc=$?
    ((rc == 2)) || return "$rc"
    gl_log "git could not read the index entry for $1 in $tree — that sibling test was treated as present and the commit allowed unchecked"
    return 0
  else
    head_names "$1"
    rc=$?
    ((rc == 2)) || return "$rc"
    gl_log "git could not read HEAD's tree for $1 in $tree — that sibling test was treated as present and the commit allowed unchecked"
    return 0
  fi
}

# Like will_hold, but its UNKNOWN answer is NO rather than YES.
#
# will_hold answers YES on a git break because on the ADDED limbs that reads as
# "the wiring is there, allow". On a limb where holding the literal is what
# DENIES — a stale allowlist entry, a stale needle — that same YES refuses the
# commit on an unreadable file, which is the one direction this guard may not
# take (mantahostels#2685). So every failure here reads as absent.
will_surely_hold() {
  local body rc
  if in_landing "$1"; then
    landing_holds "$1" "$2"
    rc=$?
    ((rc == 2)) || return "$rc"
    gl_log "could not read the copy of $1 this commit lands in $tree — that registry was read as no longer naming the member, and the commit allowed unchecked"
    return 1
  fi
  head_names "$1"
  rc=$?
  ((rc == 2)) &&
    gl_log "git could not read HEAD's tree for $1 in $tree — that registry was read as no longer naming the member, and the commit allowed unchecked"
  ((rc == 0)) || return 1
  body="$("$git_bin" -C "$tree" show "HEAD:$1" 2>/dev/null)" || return 1
  [[ "$body" == *"$2"* ]]
}

# The host-side registries and what a host takes as a sibling test, owned by
# scripts/lib/registrations.js and spelt again here rather than read through
# node, which would start a process on every commit (#1456); the test pins
# the paths and a .test.py sibling.
HOST_REGISTRATIONS=".claude/registrations.json"
HOST_NEEDLES=".claude/guard-fire-needles.json"
# The core's own hook registration, owned by scripts/lib/core-hooks.js.
SELF_PLUGIN_HOOKS="self-plugin/hooks/hooks.json"
SIBLING_SUFFIXES=".test.ts .test.js .test.mjs .test.cjs .test.py"

# The file each registry is judged against in this commit, set by registries();
# judge() resets them per commit by emptying hook_reg. reg_file is the file
# that registers the repo's hooks: the core's self-plugin file, else a host's
# .claude/settings.json.
hook_reg=""
reg_file=""
checker_reg=""
needle_reg=""

# Will the repo carry $1 after this commit? A git break reads as carried,
# leaving the fail-open to will_hold.
will_carry() {
  local rc
  if in_landing "$1"; then
    landing_exists "$1"
  else
    head_names "$1"
  fi
  rc=$?
  ((rc != 1))
}

# Resolve the three registries and the registration file once per commit: the
# core's own file where the tree after the commit carries it, else the host's.
registries() {
  [[ -n "$hook_reg" ]] && return 0
  hook_reg="scripts/hook-registrations.test.ts"
  checker_reg="scripts/checker-registrations.test.ts"
  needle_reg="scripts/guard-fire-needles.json"
  # Carried before the commit counts too, so a commit deleting it is still
  # judged against it.
  reg_file="$SELF_PLUGIN_HOOKS"
  if ! will_carry "$reg_file"; then
    head_names "$reg_file"
    (($? == 1)) && reg_file=".claude/settings.json"
  fi
  will_carry "$hook_reg" || hook_reg="$HOST_REGISTRATIONS"
  will_carry "$checker_reg" || checker_reg="$HOST_REGISTRATIONS"
  will_carry "$needle_reg" || needle_reg="$HOST_NEEDLES"
}

# The bytes of $1 the tree after this commit holds, on stdout: 0 read, 1 absent,
# 2 git or the disk could not tell.
will_body() {
  local rc
  if in_landing "$1"; then
    ((bare_commit)) && {
      index_bytes "$1"
      return
    }
    [[ -e "$root/$1" ]] || return 1
    cat -- "$root/$1" 2>/dev/null || return 2
    return 0
  fi
  head_names "$1"
  rc=$?
  ((rc == 0)) || return "$rc"
  "$git_bin" -C "$tree" show "HEAD:$1" 2>/dev/null || return 2
}

# The host registry after this commit, parsed once per commit and read by key
# as check-registrations.js reads it — a substring search took a file name in a
# reason, or under the other allowlist, for an entry (#1670). One line per fact:
#   R<US><key>              a registeredElsewhere key
#   C<US><key>              a calledElsewhere key
#   I<US><id>               a hooks row's id
#   E<US><event><US><matcher> a hooks row's event and matcher, empty for none
#   P<US><file> / U<US><file> scripts/<file> run by the settings.json this
#                           commit leaves, every registration pinned (P) or not (U),
#                           by lib/registrations.js's own isPinnedBy
# host_state is `ok`, or `unknown` where either file could not be read or
# parsed; judge() empties it.
host_state=""
host_lines=""
host_read() {
  [[ -n "$host_state" ]] && return 0
  host_state=unknown
  host_lines=""
  local f copy rc copies=()
  for f in "$HOST_REGISTRATIONS" .claude/settings.json; do
    copy="$(mktemp 2>/dev/null)" || {
      gl_log "could not make a temporary file for $f — every $HOST_REGISTRATIONS entry was judged unknown"
      rm -f ${copies+"${copies[@]}"}
      return 0
    }
    copies+=("$copy")
    will_body "$f" >"$copy"
    rc=$?
    ((rc == 1)) && : >"$copy"
    ((rc == 2)) && {
      gl_log "could not read the $f this commit leaves in $tree — every $HOST_REGISTRATIONS entry was judged unknown"
      rm -f "${copies[@]}"
      return 0
    }
  done
  host_lines="$(node -e '
    const fs = require("node:fs");
    const R = require(require("node:path").resolve(process.argv[1]));
    const read = (p) => JSON.parse(fs.readFileSync(p, "utf8") || "{}");
    const j = read(process.argv[2]);
    const keys = (o) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o) : []);
    const rows = (Array.isArray(j.hooks) ? j.hooks : []).filter((r) => typeof r?.id === "string");
    const out = [];
    for (const k of keys(j.registeredElsewhere)) out.push(["R", k]);
    for (const k of keys(j.calledElsewhere)) out.push(["C", k]);
    for (const r of rows) out.push(["I", r.id], ["E", r.event, r.matcher ?? ""]);
    const pinned = new Map();
    for (const reg of R.allRegistrations(read(process.argv[3])))
      for (const [, file] of R.commandLine(reg).matchAll(/scripts\/([\w.-]+)/g))
        pinned.set(file, (pinned.get(file) ?? true) && rows.some((row) => R.isPinnedBy(row, reg)));
    for (const [file, yes] of pinned) out.push([yes ? "P" : "U", file]);
    const ok = (s) => typeof s === "string" && !/[\n\x1f]/.test(s);
    process.stdout.write(out.filter((f) => f.every(ok)).map((f) => f.join("\x1f")).join("\n"));
  ' "$here/lib/registrations.js" "${copies[@]}" 2>/dev/null)"
  rc=$?
  rm -f "${copies[@]}"
  ((rc == 0)) || {
    host_lines=""
    gl_log "could not parse the $HOST_REGISTRATIONS or .claude/settings.json this commit leaves in $tree — every $HOST_REGISTRATIONS entry was judged unknown"
    return 0
  }
  host_state=ok
}

# Does host_read hold the fact made of its arguments, joined as above? 0 yes,
# 1 no, 2 unknown — the caller picks which way an unknown falls.
host_has() {
  host_read
  [[ "$host_state" == ok ]] || return 2
  local IFS=$'\x1f'
  in_set "$host_lines" "$*"
}

# Does a host `hooks` row pin scripts/$1? Where settings.json runs it, exactly
# as the checker judges. Where nothing runs it the checker asks for no row, and
# the refusal already says it is not registered, so any row whose id names the
# file is taken as the one meant.
host_pins() {
  local rc line
  host_has P "$1"
  rc=$?
  ((rc == 1)) || return "$rc"
  host_has U "$1" && return 1
  while IFS= read -r line; do
    [[ "$line" == I$'\x1f'*"$1"* ]] && return 0
  done <<<"$host_lines"
  return 1
}

# Does the registry $1 allowlist $3 after this commit — a host one in
# registeredElsewhere ($2 R) or calledElsewhere ($2 C), the core's test file by
# its quoted name? Unknown reads as yes.
allowlisted() {
  if is_host "$1"; then
    host_has "$2" "$3"
    (($? != 1))
  else
    will_hold "$1" "\"$3\""
  fi
}

# Does the registry $1 pin scripts/$2 after this commit? Every row of the core's
# table spells its id `id: "scripts/…`. Unknown reads as yes.
pinned() {
  if is_host "$1"; then
    host_pins "$2"
    (($? != 1))
  else
    will_hold "$1" "\"scripts/$2"
  fi
}

# Does the plugin's own needles file key $1? An unreadable file reads as yes,
# logged, so a broken plugin copy never refuses a host's core guard.
core_needle_holds() {
  local file="$here/guard-fire-needles.json"
  if [[ ! -r "$file" ]]; then
    gl_log "could not read $file — the core needle for $1 was treated as present and the commit allowed unchecked"
    return 0
  fi
  grep -qF -- "\"$1\"" "$file"
}

is_host() {
  [[ "$1" == .claude/* ]]
}

# Does scripts/$1 have a sibling test after this commit? $2 is the registry
# judging it: the core's tests take .test.ts alone.
has_sibling() {
  local s suffixes=".test.ts"
  is_host "$2" && suffixes="$SIBLING_SUFFIXES"
  for s in $suffixes; do
    will_exist "scripts/$1$s" && return 0
  done
  return 1
}

# The sibling test a refusal asks for, spelt for the registry $2.
sibling_name() {
  if is_host "$2"; then
    local exts="${SIBLING_SUFFIXES//.test./}"
    printf 'scripts/%s.test.{%s}' "$1" "${exts// /,}"
  else
    printf 'scripts/%s.test.ts' "$1"
  fi
}

# The four surfaces checker-registrations.test.ts accepts as a caller, mirrored
# exactly — a wider list here would clear a checker the test still fails.
# The hooks one is registries()'s reg_file.
caller_surfaces=()
fill_caller_surfaces() {
  local h f
  caller_surfaces=()
  for h in pre-commit prepare-commit-msg commit-msg pre-merge-commit post-commit pre-push; do
    [[ -f "$root/.husky/$h" ]] && caller_surfaces+=(".husky/$h")
  done
  for f in "$root"/.github/workflows/*.yml "$root"/.github/workflows/*.yaml; do
    [[ -f "$f" ]] && caller_surfaces+=(".github/workflows/${f##*/}")
  done
  registries
  [[ -f "$root/$reg_file" ]] && caller_surfaces+=("$reg_file")
  for f in "$root"/scripts/*.js "$root"/scripts/*.sh \
    "$root"/scripts/lib/*.js "$root"/scripts/lib/*.sh; do
    [[ -f "$f" ]] && caller_surfaces+=("${f#"$root"/}")
  done
  return 0
}

# Every registration in the settings.json file $1, one line each, as
# `<event><US><matcher><US><key>` where <US> is \x1f and key is
# scripts/lib/guard-fires.js's own guardKey: the script's basename plus
# whatever arguments tell two registrations of it apart.
#
# Read through that module rather than by a regex here, so this guard and
# count-guard-fires.test.ts key a registration identically (mantahostels#2685). A regex over
# names saw neither an argument nor a script outside the .sh/.js pair.
settings_registrations() {
  node -e '
    // resolve(): a bare relative path reads to require() as a MODULE NAME, so
    // an invocation of this guard by a relative path would fail open (mantahostels#2685).
    const { registeredGuards } = require(require("node:path").resolve(process.argv[1]));
    const s = JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8"));
    for (const r of registeredGuards(s))
      process.stdout.write(`${r.event}\x1f${r.matcher ?? ""}\x1f${r.key}\n`);
  ' "$here/lib/guard-fires.js" "$1" 2>/dev/null
}

# Is the whole line $2 one of the newline-separated lines in $1?
in_set() {
  [[ $'\n'"$1"$'\n' == *$'\n'"$2"$'\n'* ]]
}

# The refusal being built, one member per paragraph. Not local: it is held
# across the segments of a compound command.
refusal=""
# gp_unset_text's output, refilled per judged segment.
unset_text=""

# Judge one new scripts/check-*.js. $1 is its basename.
judge_checker() {
  local file="$1" stem="${1%.js}" wired=0 cand
  registries

  # The allowlist escape, taken first: with it, the checker needs no caller.
  if allowlisted "$checker_reg" C "$file"; then
    wired=1
  else
    # One grep over every surface at once, then the after-commit test on each
    # hit — a per-file grep would be ~250 forks inside a hook's budget.
    while IFS= read -r cand; do
      [[ -n "$cand" ]] || continue
      [[ "$cand" == "scripts/$file" ]] && continue
      will_hold "$cand" "$file" && {
        wired=1
        break
      }
    done < <(
      cd "$root" && grep -lF -- "$file" "${caller_surfaces[@]}" 2>/dev/null
    )
  fi

  local missing=""
  ((wired)) || missing+="  - no caller: nothing in .husky/, .github/workflows/, $reg_file or another scripts/ file names it after this commit
"
  has_sibling "$stem" "$checker_reg" ||
    missing+="  - no sibling test: no $(sibling_name "$stem" "$checker_reg") in this commit or in HEAD
"
  [[ -n "$missing" ]] || return 0

  local escape="a commented CALLED_ELSEWHERE entry to scripts/checker-registrations.test.ts"
  is_host "$checker_reg" &&
    escape="a \`calledElsewhere\` entry to $checker_reg, keyed by the file name with its reason,"
  refusal+="scripts/$file is a new checker, and this commit does not carry its wiring:

$missing
$(whole_repo "$checker_reg" "scripts/checker-registrations.test.ts asserts")

Name the wiring in the same commit — the hook, workflow or script that calls it, and the sibling test. If it is deliberately hand-only, add $escape in THIS commit instead.

"
}

# Judge one new scripts/guard-*.{sh,js}. $1 is its basename.
judge_guard() {
  local file="$1" stem="${1%.*}" missing="" pin="REGISTRATIONS entry"
  local escape="a commented REGISTERED_ELSEWHERE entry to scripts/hook-registrations.test.ts"
  registries
  is_host "$hook_reg" && {
    pin="\`hooks\` row"
    escape="a \`registeredElsewhere\` entry to $hook_reg, keyed by the file name with its reason,"
  }

  # The allowlist escape covers the registration limb alone: a guard another
  # script invokes still needs its sibling test.
  if ! allowlisted "$hook_reg" R "$file"; then
    will_hold "$reg_file" "scripts/$file" ||
      missing+="  - not registered: $reg_file does not run it after this commit
"
    pinned "$hook_reg" "$file" ||
      missing+="  - not pinned: $hook_reg has no $pin for it after this commit
"
    will_hold "$needle_reg" "\"$file" ||
      missing+="  - not counted: $needle_reg has no entry for it after this commit
"
  fi
  has_sibling "$stem" "$hook_reg" ||
    missing+="  - no sibling test: no $(sibling_name "$stem" "$hook_reg") in this commit or in HEAD
"
  [[ -n "$missing" ]] || return 0

  refusal+="scripts/$file is a new guard, and this commit does not carry its wiring:

$missing
$(whole_repo "$hook_reg" "scripts/hook-registrations.test.ts and scripts/count-guard-fires.test.ts assert")

Land the registration, the $pin, the needle entry and the sibling test in the SAME commit. If nothing will ever register it — a guard another script invokes directly — add $escape in this commit instead.

"
}

# The sentence saying what asserts a refusal's demands, for the registry $1;
# $2 is the core's tests and their verb.
whole_repo() {
  if is_host "$1"; then
    printf '%s' "check-registrations.js asserts the same over the whole repository, and .husky/pre-commit runs it, so the commit would be refused there too, after the rest of the stack."
  else
    printf '%s' "$2 the same over the whole repository, so from this commit until the wiring one every session's full suite goes red on a file it never touched."
  fi
}

# Judge one scripts/check-*.js this commit DELETES. $1 is its basename.
judge_checker_removal() {
  local file="$1"
  registries
  # The object-key spelling, not a bare quoted name: a prose mention of the
  # checker in that file must not read as an allowlist entry (mantahostels#2685).
  if is_host "$checker_reg"; then
    host_has C "$file" || return 0
  else
    will_surely_hold "$checker_reg" "\"$file\":" || return 0
  fi

  local entry="CALLED_ELSEWHERE" why="scripts/checker-registrations.test.ts asserts over the whole repository that every CALLED_ELSEWHERE entry names a checker that still exists, so from this commit until the entry goes every session's full suite goes red on a file it never touched."
  is_host "$checker_reg" && {
    entry="\`calledElsewhere\`"
    why="check-registrations.js asserts over the whole repository that every \`calledElsewhere\` entry names a checker that still exists, and .husky/pre-commit runs it."
  }
  refusal+="scripts/$file is deleted by this commit, and its $entry entry stays behind:

  - $checker_reg still names \"$file\" after this commit

$why

Drop that entry in the SAME commit as the deletion.

"
}

# Judge a $reg_file whose hook list moved. $1 is the set of script
# names already reported by judge_guard, so a new guard is not named twice.
judge_hook_list() {
  local reported="$1" now before landing_copy head_copy rc event matcher key base
  local added="" removed="" moved=""
  registries

  # settings_registrations parses a FILE. A pathspec commit takes the one on
  # disk; a bare one takes the index's, which lives in no file, so those bytes
  # are materialised first (mantahostels#2734).
  if ((bare_commit)); then
    landing_copy="$(mktemp 2>/dev/null)" || {
      gl_log "could not make a temporary file for the staged $reg_file — its hook-list change was allowed unchecked"
      return 0
    }
    index_bytes "$reg_file" >"$landing_copy" 2>/dev/null
    rc=$?
    ((rc == 0)) || {
      rm -f "$landing_copy"
      # rc 1 is this commit DELETING the file, which judge_hook_list has no
      # after-copy to diff: nothing here can say which hooks survive it.
      ((rc == 1)) ||
        gl_log "could not read the staged $reg_file in $tree — its hook-list change was allowed unchecked"
      return 0
    }
    now="$(settings_registrations "$landing_copy")"
    rc=$?
    rm -f "$landing_copy"
  else
    now="$(settings_registrations "$root/$reg_file")"
    rc=$?
  fi
  ((rc == 0)) || {
    gl_log "could not read the hook registrations out of the $reg_file this commit lands (exit $rc) — its hook-list change was allowed unchecked"
    return 0
  }

  head_copy="$(mktemp 2>/dev/null)" || {
    gl_log "could not make a temporary file for HEAD's $reg_file — its hook-list change was allowed unchecked"
    return 0
  }
  "$git_bin" -C "$tree" show "HEAD:$reg_file" >"$head_copy" 2>/dev/null || {
    rm -f "$head_copy"
    gl_log "could not read HEAD's $reg_file in $tree — its hook-list change was allowed unchecked"
    return 0
  }
  before="$(settings_registrations "$head_copy")"
  rc=$?
  rm -f "$head_copy"
  ((rc == 0)) || {
    gl_log "could not read the hook registrations out of HEAD's $reg_file in $tree (exit $rc) — its hook-list change was allowed unchecked"
    return 0
  }
  [[ -n "$before" ]] || {
    gl_log "HEAD's $reg_file in $tree registers no hook at all — its hook-list change was allowed unchecked"
    return 0
  }

  local now_keys before_keys
  now_keys="$(cut -d$'\x1f' -f3 <<<"$now" | sort -u)"
  before_keys="$(cut -d$'\x1f' -f3 <<<"$before" | sort -u)"

  while IFS=$'\x1f' read -r event matcher key; do
    [[ -n "$key" ]] || continue
    base="${key%% *}"
    in_set "$reported" "$base" && continue
    # Unchanged, event, matcher and arguments together.
    in_set "$before" "$event"$'\x1f'"$matcher"$'\x1f'"$key" && continue
    if in_set "$before_keys" "$key"; then
      # Both registries already key this script and these arguments, so neither
      # drifts — but the event or the matcher moved, and the table pins both.
      #
      # The table lands, or it already SPELLS the new event and the new matcher
      # somewhere. The second limb is loose on purpose: a table updated in an
      # earlier commit leaves the suite green, and denying that is the one
      # direction this guard may not take (mantahostels#2685).
      in_landing "$hook_reg" && continue
      if is_host "$hook_reg"; then
        host_has E "$event" "$matcher"
        (($? != 1)) && continue
      else
        local want_matcher="matcher: null"
        [[ -n "$matcher" ]] && want_matcher="matcher: \"$matcher\""
        will_hold "$hook_reg" "event: \"$event\"" &&
          will_hold "$hook_reg" "$want_matcher" && continue
      fi
      moved+="  - scripts/$key, now on $event with matcher ${matcher:-<none>}
"
    else
      # `"scripts/<name>` open-ended, not the whole key quoted: the test matches
      # an id that is any SUBSTRING of the command line, so a table row naming
      # the script alone already pins a registration carrying arguments
      # (mantahostels#2685).
      #
      # A host may register a core guard, whose needles stay the plugin's own:
      # count-guard-fires.js refuses a host key the core already holds.
      {
        will_hold "$needle_reg" "\"$key\"" || {
          is_host "$needle_reg" && core_needle_holds "$key"
        }
      } && pinned "$hook_reg" "$base" && continue
      added+="  - scripts/$key
"
    fi
  done <<<"$now"

  while IFS=$'\x1f' read -r event matcher key; do
    [[ -n "$key" ]] || continue
    base="${key%% *}"
    in_set "$reported" "$base" && continue
    # Still registered somewhere, so nothing has gone stale: an event or matcher
    # move is the added limb's to report, once.
    in_set "$now_keys" "$key" && continue
    will_surely_hold "$needle_reg" "\"$key\"" || {
      if is_host "$hook_reg"; then
        host_has I "scripts/$key"
      else
        will_surely_hold "$hook_reg" "\"scripts/$key\""
      fi
    } || continue
    removed+="  - scripts/$key
"
  done <<<"$before"

  # A script registered on two events reaches a limb twice; the reader wants it
  # once.
  [[ -n "$added" ]] && added="$(sort -u <<<"${added%$'\n'}")"$'\n'
  [[ -n "$removed" ]] && removed="$(sort -u <<<"${removed%$'\n'}")"$'\n'
  [[ -n "$moved" ]] && moved="$(sort -u <<<"${moved%$'\n'}")"$'\n'

  [[ -n "$added$removed$moved" ]] || return 0

  local pin="REGISTRATIONS entry" why
  is_host "$hook_reg" && pin="\`hooks\` row"
  why="scripts/count-guard-fires.test.ts fails on drift in EITHER direction — a hook run with no needle entry arrives uncounted, and a needle entry for a hook nothing runs reads as a guard that never fires. scripts/hook-registrations.test.ts pins the whole registration list, event, matcher and arguments together, so a moved one fails too."
  is_host "$hook_reg" &&
    why="A hook run with no needle entry arrives uncounted, a needle entry for a hook nothing runs reads as a guard that never fires, and $hook_reg pins the whole registration list, event, matcher and arguments together — check-registrations.js refuses each in .husky/pre-commit too."

  refusal+="This commit changes which hooks $reg_file runs, and the registries that track them do not move with it:
"
  [[ -n "$added" ]] && refusal+="
Newly run, with no $needle_reg entry or no $pin in $hook_reg after this commit:

$added"
  [[ -n "$removed" ]] && refusal+="
No longer run, but still carried by $needle_reg or $hook_reg after this commit:

$removed"
  [[ -n "$moved" ]] && refusal+="
Moved to another event or matcher, with $hook_reg left out of this commit:

$moved"
  refusal+="
$why

Move $reg_file, $needle_reg and $hook_reg in the same commit.

"
  return 0
}

# Judge a commit that edits text scripts/guard-fire-needles.json keys a needle
# on, without moving the needle (mantahostels#2708).
#
# Nothing above sees it — judge_hook_list diffs REGISTRATIONS, and a guard's
# printed words are not one.
#
# The predicate is count-guard-fires.test.ts's own, read through
# scripts/lib/needle-corpus.js so the two cannot drift, and narrowed to the
# literals THIS commit breaks: keyed text the tree printed before it and prints
# nowhere after. A literal already missing beforehand belongs to whoever broke
# it.
judge_needle_text() {
  local path corpus_touched=0 out err rc key id text

  # A third spelling of needle-corpus.js's CORPUS_DIRS, kept so that the common
  # case — a commit landing nothing the corpus reads — never spawns node.
  # needle-corpus.test.ts asserts the two lists agree.
  while IFS= read -r path; do
    case "$path" in
      "") ;;
      scripts/* | .husky/* | .claude/skills/* | docs/agents/rules/*)
        corpus_touched=1
        break
        ;;
    esac
  done <<<"$landing"
  ((corpus_touched)) || return 0

  err="$(mktemp 2>/dev/null)" || {
    gl_log "could not make a temporary file for the needle-drift scan — this commit's needle text was allowed unchecked"
    return 0
  }
  out="$(printf '%s\n' "$landing" | node -e '
    // resolve(): a bare relative path reads to require() as a MODULE NAME.
    const path = require("node:path");
    const { needleDrift } = require(path.resolve(process.argv[1]));
    const { gitBinary } = require(path.resolve(process.argv[1], "../git-binary.js"));
    const { execFileSync } = require("node:child_process");
    const root = process.argv[2];
    const tree = process.argv[3];
    const bare = process.argv[4] === "1";
    const landing = require("node:fs")
      .readFileSync(0, "utf8")
      .split("\n")
      .filter(Boolean);
    // ls-tree first, and its exit 0 naming nothing is the ordinary absence:
    // `show` cannot make that split, exiting 128 for an absent path and 128
    // again for a broken object store (mantahostels#2702).
    const readHead = (rel) => {
      const named = execFileSync(
        gitBinary(),
        ["-C", tree, "ls-tree", "--full-tree", "--name-only", "HEAD", "--", rel],
        { encoding: "utf8" },
      );
      if (!named.trim()) return null;
      return execFileSync(gitBinary(), ["-C", tree, "show", `HEAD:${rel}`], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    };
    // A bare `git commit` takes the INDEX copy, so that is the corpus to judge
    // for every file it lands (mantahostels#2734). `ls-files` first for the same reason
    // ls-tree comes first above: `show` cannot tell absence from a break.
    const readIndex = (rel) => {
      const named = execFileSync(
        gitBinary(),
        ["-C", tree, "ls-files", "--full-name", "--cached", "--", `${root}/${rel}`],
        { encoding: "utf8" },
      );
      if (!named.trim()) return null;
      return execFileSync(gitBinary(), ["-C", tree, "show", `:${rel}`], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
    };
    const { broken, failOpen } = needleDrift({
      root,
      landing,
      readHead,
      readLanding: bare ? readIndex : null,
    });
    if (failOpen) {
      process.stderr.write(failOpen);
      process.exit(3);
    }
    for (const n of broken)
      process.stdout.write(
        `${n.arriving ? "arriving" : "reworded"}\x1f${n.key}\x1f${n.id}\x1f` +
          `${n.text.replace(/\s+/g, " ")}\n`,
      );
  ' "$here/lib/needle-corpus.js" "$root" "$tree" "$bare_commit" 2>"$err")"
  rc=$?
  if ((rc != 0)); then
    gl_log "the needle-drift scan failed (exit $rc: $(tr '\n' ' ' <"$err")) — this commit's needle text was allowed unchecked"
    rm -f "$err"
    return 0
  fi
  rm -f "$err"
  [[ -n "$out" ]] || return 0

  local reworded="" arriving="" limb
  while IFS=$'\x1f' read -r limb key id text; do
    [[ -n "$id" ]] || continue
    if [[ "$limb" == arriving ]]; then
      arriving+="  - $key / $id, keyed on: $text
"
    else
      reworded+="  - $key / $id, keyed on: $text
"
    fi
  done <<<"$out"
  [[ -n "$reworded$arriving" ]] || return 0

  refusal+="This commit changes wording that scripts/guard-fire-needles.json keys a needle on, and the needle does not move with it:
"
  [[ -n "$reworded" ]] && refusal+="
Printed somewhere before this commit and printed nowhere after it:

$reworded
Move each needle's \`text\` to the new wording in the same commit, or put the old wording back."
  [[ -n "$arriving" ]] && refusal+="
Keyed by a needle this commit ADDS, on wording nothing in the tree prints:

$arriving
Key each on text the guard actually prints — or land the printer in the same commit."
  refusal+="

scripts/count-guard-fires.test.ts asserts every needle is text this repo still prints, so the suite goes red on the mismatch for everyone until the two agree.

"
  return 0
}

# Appended where a registry refusal named a host file.
host_tail() {
  local f plugin absent=""
  is_host "$hook_reg" || is_host "$checker_reg" || is_host "$needle_reg" ||
    return 0
  plugin="$(cd "$here" 2>/dev/null && pwd -P)" || plugin="<plugin root>/scripts"
  for f in "$HOST_REGISTRATIONS" "$HOST_NEEDLES"; do
    will_carry "$f" || absent+="$f "
  done
  refusal+="This repo keeps its registries in $HOST_REGISTRATIONS and $HOST_NEEDLES (#1456). \`node $plugin/check-registrations.js\` lists every hook, guard and checker either is missing.

"
  [[ -n "$absent" ]] && refusal+="Not in this repo yet: ${absent% }. \`node $plugin/upgrade.js\` seeds each empty; or write $HOST_REGISTRATIONS as {\"hooks\": [], \"registeredElsewhere\": {}, \"calledElsewhere\": {}} and $HOST_NEEDLES as {\"guards\": {}}, and land them in this commit.

"
  return 0
}

# Called once per `git commit` running against any working tree of this repo.
judge() {
  # $1 the flattened segment and $2 the subcommand are gp_walk_repo_git's, and
  # neither is judged here: this guard reads the commit's paths, not its form.
  local target_dir="$3"
  shift 3

  has_pathspec=0
  has_all=0
  pathspec_words=()
  literal_paths=0
  gp_scan_flags "$COMMIT_VALUE_FLAGS" commit_arg -- "$@"
  gp_unset_text unset_text
  judge_commit_in "$target_dir"
}

# 1 where the commit is a commit-paths.js one: each word is a literal path, and
# an untracked file it names lands too, intent-added on the way in.
literal_paths=0

# Judge the commit the globals above describe, running in the tree $1.
judge_commit_in() {
  local target_dir="$1"
  local path base member_rc reported=""
  hook_reg=""
  host_state=""

  mid_sequence "$target_dir" && return 0

  tree="$target_dir"
  root="$("$git_bin" -C "$tree" rev-parse --show-toplevel 2>/dev/null)" || {
    gl_log "could not resolve the top level of $tree — that commit was allowed unchecked"
    return 0
  }

  # What this commit lands. A pathspec commit takes the paths it names; a bare
  # one takes whatever the index holds.
  landing=""
  bare_commit=$(((1 - has_pathspec) & (1 - has_all)))
  if ((has_pathspec)); then
    local word lit abs spec listed staged_del rc
    for word in ${pathspec_words+"${pathspec_words[@]}"}; do
      # An unexpanded $VAR or a command substitution is dropped rather than
      # guessed at (mantahostels#103 §6).
      lit="$(gp_literal "$word")" || continue
      [[ -n "$lit" ]] || continue
      abs="$lit"
      [[ "$abs" == /* ]] || abs="$tree/$abs"
      spec="$abs"
      ((literal_paths)) && spec=":(literal)$abs"
      listed="$("$git_bin" -C "$tree" ls-files --full-name --cached -- "$spec" 2>/dev/null)"
      rc=$?
      ((rc == 0)) || {
        gl_log "git could not list tracked files under $abs in $tree (exit $rc) — that pathspec word was left unjudged for mantahostels#2671"
        continue
      }
      # commit-paths.js intent-adds an untracked, unignored FILE and refuses a
      # directory holding one, so only a file's name is added here.
      if ((literal_paths)) && [[ -z "$listed" && -f "$abs" ]]; then
        listed="$("$git_bin" -C "$tree" ls-files --full-name --others --exclude-standard -- "$spec" 2>/dev/null)" ||
          gl_log "git could not list untracked files under $abs in $tree — that commit-paths.js path was left unjudged"
      fi
      # A path already `git rm`d is out of the index, so ls-files never names
      # it — while the commit still lands its removal (mantahostels#2685).
      staged_del="$("$git_bin" -C "$tree" diff --cached --name-only --no-renames --diff-filter=D -- "$spec" 2>/dev/null)"
      rc=$?
      ((rc == 0)) ||
        gl_log "git could not read the staged deletions under $abs in $tree (exit $rc) — a member this commit removes may have gone unjudged"
      [[ -n "$listed" ]] && landing+="$listed
"
      [[ -n "$staged_del" ]] && landing+="$staged_del
"
    done
  else
    local staged rc
    # --no-renames: a rename is one R entry naming the new path only, which
    # hides the old member's disappearance (mantahostels#2685).
    staged="$("$git_bin" -C "$tree" diff --cached --name-only --no-renames 2>/dev/null)"
    rc=$?
    ((rc == 0)) || {
      gl_log "git could not read the staged path list in $tree (exit $rc) — that commit was allowed unchecked"
      return 0
    }
    landing="$staged"
  fi
  landing="${landing%$'\n'}"
  [[ -n "$landing" ]] || return 0

  fill_caller_surfaces
  # Where this commit's paragraphs start, so the unset line leads them alone.
  local before="${#refusal}"

  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    base="${path#scripts/}"
    # A member already in HEAD was wired, or was already failing, before this
    # commit — so only its REMOVAL is judged here (mantahostels#2685).
    head_names "$path"
    member_rc=$?
    # A break must not read as "new", which is the branch that can REFUSE
    # (mantahostels#2702): an unreadable HEAD leaves the path unjudged instead.
    if ((member_rc == 2)); then
      gl_log "git could not read HEAD's tree for $path in $tree — that path was left unjudged and the commit allowed unchecked"
      continue
    fi
    if ((member_rc == 0)); then
      landing_exists "$path"
      member_rc=$?
      ((member_rc == 0)) && continue
      # Absence is what DENIES on the removal limb, so a git break reads as
      # still present.
      ((member_rc == 2)) && {
        gl_log "git could not read the index entry for $path in $tree — that path was left unjudged and the commit allowed unchecked"
        continue
      }
      case "$path" in
        scripts/*.test.*) ;;
        scripts/check-*.js) judge_checker_removal "$base" ;;
      esac
      continue
    fi
    # A host names its tests check-<name>.test.js: none is a member.
    case "$path" in
      scripts/*.test.*) ;;
      scripts/check-*.js)
        judge_checker "$base"
        ;;
      scripts/guard-*.sh | scripts/guard-*.js)
        judge_guard "$base"
        reported+="$base
"
        ;;
    esac
  done <<<"$landing"

  if in_landing "$SELF_PLUGIN_HOOKS" || in_landing .claude/settings.json; then
    registries
    in_landing "$reg_file" && judge_hook_list "${reported%$'\n'}"
  fi
  local judged="${#refusal}"
  ((judged > before)) && host_tail
  judge_needle_text
  ((${#refusal} > before)) && {
    refusal="${refusal:0:before}$unset_text${refusal:before}"
  }
  return 0
}

gp_walk_repo_git --empty-unset judge commit commit

# A `node …/commit-paths.js … -- <paths>` call, the commit form CLAUDE.md
# requires: it runs no `git` the walk above sees, so it is read here and judged
# as the pathspec commit it makes (#1727). `--tree` commits nothing, and an
# option commit-paths.js would refuse leaves the call unjudged.
commit_paths_call() {
  shift
  gp_commit_paths_args "$@" && gp_commit_paths_parse || return 0
  ((_gp_cp_tree)) && return 0
  local dir
  local -a paths=(${_gp_cp_paths+"${_gp_cp_paths[@]}"})
  local patch="$_gp_cp_patch"
  ((${#paths[@]})) || [[ -n "$patch" ]] || return 0

  # gp_walk_repo_git above has resolved the repo gp_tree_scope reads.
  dir="$(gp_cwd)"
  [[ -n "$dir" ]] || {
    gl_log "could not resolve the directory a commit-paths.js call runs in — that commit was allowed unchecked"
    return 0
  }
  case "$(gp_tree_scope "$dir")" in
    shared | linked) ;;
    unknown)
      gl_log "git could not say which tree $dir is — that commit-paths.js commit was allowed unchecked"
      return 0
      ;;
    *) return 0 ;;
  esac

  if [[ -n "$patch" ]]; then
    if gp_patch_files "$dir" "$patch"; then
      paths+=("${_gp_patch_files[@]}")
    else
      gl_log "could not read the --patch file of a commit-paths.js call in $dir — the files it carries were left unjudged"
    fi
  fi

  has_pathspec=1
  has_all=0
  pathspec_words=(${paths+"${paths[@]}"})
  literal_paths=1
  unset_text=""
  judge_commit_in "$dir"
}
gp_walk_commands commit_paths_call

[[ -n "$refusal" ]] && gp_deny "${refusal%$'\n\n'}

Why this is a refusal and not a warning: a repo-wide registry invariant is false for EVERY session while the split is open, not just for yours, so no session can obtain a whole-suite certificate at any price until it closes (mantahostels#2664, mantahostels#2671)."

gp_allow
