#!/usr/bin/env bash
# PreToolUse guard: warn on a recursive `grep`/`rg` rooted at the project
# directory — named as `.` or its path, or named not at all (`rg PAT`) —
# leading with the same command with that root expanded to the top-level
# entries that actually exist — minus the ones no search wants and the ones a
# `Read()` deny rule covers (mantahostels#2717).
#
# A SECOND LIMB, ON THE HEAVY TREES (workflow-core#2060): a recursive `grep` or `rg`, a
# `find`, or either under `watch`, whose root is `node_modules`, `.next`, `.git`
# or ignored build output, or a `find` or `grep` from the repo root, hands over
# `rule:heavy-tree-search` once a session, beside any warning below. It never
# refuses.
#
# WHY IT IS EXPENSIVE, TWICE. A recursive `grep` reads every tree git ignores
# or keeps to itself — `node_modules`, `.git`, build output — in any permission
# mode; `rg` skips those by default, so this cost is grep's alone. And Claude
# Code escalates a Bash command to a permission
# prompt whenever it cannot prove the command avoids a path covered by a
# `Read()` deny rule. A recursive search rooted at `.` traverses the whole tree,
# `.env` among it, so `Read(./.env)` in .claude/settings.json fires — even
# though no `.env` exists on this machine. That is shape 2 of mantahostels#2682.
#
# THE SESSION CANNOT SEE THE PROMPT IT CAUSED (mantahostels#2717). An escalated command
# returns normally and exits 0 whether it was allowed outright or approved at a
# prompt, so no session can measure this for itself, and the guard cannot be
# tuned by trying shapes and watching. The readings behind it were taken by the
# founder on Claude Code 2.1.259 and are recorded on mantahostels#2717.
#
# The discriminator they establish: whether the check can resolve the read set
# as excluding the denied path, not which tool does the reading.
#
# WHY THIS REWRITE AND NOT A SHORTER ONE. Both shorter rewrites lose files
# silently (mantahostels#2717):
#   - `*` alone drops every dot-directory, so `.claude/`, `.github/` and
#     `.husky/` — real search targets in this repo — vanish from the results
#     with no signal.
#   - `git grep` drops untracked files, so a hit in a file not yet committed
#     goes missing, which is the worst shape a search can fail in.
#
# WARN, NOT DENY (workflow-core#482): every measured session was in auto mode, where no
# prompt is shown, so the refusal spared none. The `Read(./.env)` rule that
# causes the prompt stays.
#
# THE PROMPT IS NAMED ONLY WHERE THE PAYLOAD'S `.permission_mode` CAN SHOW ONE
# (workflow-core#1731): never in `auto` or `bypassPermissions`, so there an `rg` search,
# whose only cost is the prompt, passes unwarned. A payload with no mode is
# read as `default`.
#
# LIMITS
#  - It never stops the command, so in default permission mode the prompt it
#    names can happen; the warning spares only a search the session re-spells.
#  - It judges a root spelled `.`, `./`, or the project directory's absolute
#    path, and a recursive search naming no path (mantahostels#2723, workflow-core#1731), whose
#    rewrite appends the expansion to that search's own text in the command.
#    A path-less `rg` fed by a pipe, a `<` or a heredoc reads that instead,
#    and passes; so does any search behind `xargs`, and one whose text,
#    quotes and all, is not found exactly once in the command. grep's `-r`
#    ignores stdin. Where the Bash tool's stdin is a socket, as in a subagent, a
#    path-less `rg` reads it too; the rewrite, naming paths, still runs right.
#  - A root QUOTED — `grep -rn PAT "."` — is allowed. The pre-test and the
#    substitution both read the raw string, where `"."` is not a standalone `.`.
#  - Any other spelling of the same directory is unjudged: `$PWD` and
#    `$CLAUDE_PROJECT_DIR`, which only the shell can expand and which this guard
#    must not evaluate, and a path reaching the root by `..` or through a
#    symlink, which matches no literal it compares against.
#  - The dot limb fires only where the shell already stands in the project
#    directory, read from the payload's `.cwd` as mantahostels#2682 established. A `.`
#    somewhere else is a different tree, which this guard knows nothing about.
#  - A command carrying MORE THAN ONE standalone root spelling is allowed. The
#    substitution is textual, and a second one — inside a quoted pattern, say —
#    gives it no way to tell which is the search root. A root WELDED to what
#    follows it is not standalone and is allowed too: `grep -rn PAT .|head`
#    reaches the pre-test as the single word `.|head`.
#  - A `cd`, `pushd` or `popd` ANYWHERE in the command stands the guard down for
#    every segment after it. The `.cwd` gate above reads where the shell stood
#    BEFORE the command ran, so after a `cd` the expansion would name a tree the
#    search is no longer in — a rewrite that fails outright rather than reading
#    widely, which is the one failure worth refusing to hand over.
#  - Recursion is read from `-r`, `-R` and `--recursive` only. `grep -d recurse`
#    is the same search and is not seen.
#  - The command word must be `grep`, `egrep`, `fgrep` or `rg` exactly. A path
#    spelling — `/usr/bin/grep` — is unjudged.
#  - A top-level name outside `[A-Za-z0-9._-]` stands the guard down rather than
#    building a rewrite: the name reaches sed's replacement text and then a
#    shell command line, unescaped in both.
#  - The expansion is computed from the tree at call time, so a top-level file
#    added since is included, and one `git ls-files` still lists but the working
#    tree no longer holds is dropped. It is NOT re-derived from the deny rules in .claude/settings.json: the exclusion list below is a
#    literal that must be updated by hand if a `Read()` rule ever names
#    something else at the top level.
#  - `--exclude-dir=node_modules` is not added for the caller. `node_modules` is
#    simply absent from the expansion, which is stronger: grep never descends
#    into a directory it was not given.
#  - It reads `grep`, `egrep`, `fgrep` and `rg`. `ag`, `ack` and a recursive
#    `find … -exec grep` are unjudged.
#  - For `rg` the rewrite WIDENS the search. `rg PAT .` skips hidden directories
#    by default, so naming `.claude` and `.github` explicitly makes rg read them.
#    That is the same set grep already had.
#  - The heavy-tree limb reads a root's last component, so a search inside one
#    — `grep -rn PAT node_modules/vitest` — passes, as does a `find` from the
#    repo root bounded by `-prune` or `-maxdepth`. `dist`, `build`, `out` and
#    `coverage` count only where git ignores them. A watcher other than `watch`
#    — `inotifywait`, a bundler's `--watch` — is unjudged, and a single-word
#    `watch` command is split on blanks, its own quoting unread.
#  - It FAILS OPEN throughout, house style (mantahostels#103 §6), recording through
#    lib/guard-log.sh (mantahostels#147).

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

gp_begin '.tool_input.command' command

raw="$(gp_subject)"

root="$(gr_root)"
[[ -n "$root" ]] ||
  gl_open "the repo root did not resolve — a recursive dot search was allowed unjudged"

# The root, escaped one character at a time so it can go into an ERE: in bash,
# not a `sed` whose bracket expression would have to hold that sed's delimiter.
# `\/` doubles as the escape the rewrite's `sed` below needs for its delimiter.
#
# Four characters this escapes INTO a GNU extension rather than out of one: a
# backslash before `'`, a backtick, `<` or `>` is an anchor, so a root holding
# one matches nothing and the search is allowed. Unreachable from an unquoted
# shell word anyway.
root_re=""
for ((_i = 0; _i < ${#root}; _i++)); do
  _c="${root:_i:1}"
  case "$_c" in
    [A-Za-z0-9_-]) root_re+="$_c" ;;
    *) root_re+="\\$_c" ;;
  esac
done

# Cheap pre-test before any of the machinery below: a command naming no
# search cannot be one. An explicit root must stand exactly once — see LIMITS.
[[ "$raw" == *grep* || "$raw" == *rg* || "$raw" == *find* ]] || gp_allow

# Split by `tr` rather than by an unquoted expansion: a word like `--include=*.js`
# would glob against the hook's own directory on the way through a `for` loop.
# shellcheck disable=SC2020 # tr maps each blank to a newline, char for char, on purpose.
roots="$(printf '%s' "$raw" | tr ' \t\n' '\n\n\n' |
  grep -cxE "\\.|\\./|${root_re}|${root_re}/")"

mode="$(gp_payload_field '.permission_mode')"
shows_prompt=1
case "$mode" in auto | bypassPermissions) shows_prompt=0 ;; esac

cwd="$(gp_payload_field '.cwd')" ||
  gl_open "the payload's .cwd did not read — a recursive dot search was allowed unjudged"
[[ -n "$cwd" ]] ||
  gl_open "the payload carried no .cwd — every recursive dot search is allowed unjudged"

command -v realpath >/dev/null 2>&1 ||
  gl_open "realpath is missing — a recursive dot search was compared unresolved and allowed"

# The heavy-tree limb judges wherever the shell stands.
root_real="$(realpath -m -- "$root" 2>/dev/null)"
at_root=0
[[ "$(realpath -m -- "$cwd" 2>/dev/null)" == "$root_real" ]] && at_root=1

# --------------------------------------------------------------------------
# Decide, through the shared parser rather than the raw string: a `grep`
# mentioned in an echo or a heredoc body is not a search.

# Flags taking a value, short and long together. Leave one out and its value is
# read as a bare word — which for `-e PAT .` would make the pattern a path.
#
# ONE SPEC PER COMMAND, because the two grammars disagree and a shared list gets
# both wrong (lib/guard-parse.sh names this hazard). `-T` is grep's no-value
# --initial-tab and rg's --type-not VALUE; `-r` is grep's --recursive and rg's
# --replace VALUE. Listing either wrongly makes the scan eat the pattern, read
# `.` as the pattern, and ALLOW in silence.
#
# An OPTIONAL-value flag is absent from both: `--color` takes its value joined
# or not at all, so listing it would eat the next word. The `--flag=value`
# spelling is read as name and value whatever the spec says.
GREP_VALUE_FLAGS="-e --regexp -f --file -m --max-count -A --after-context -B --before-context -C --context -d --directories -D --devices --include --exclude --exclude-dir --exclude-from --binary-files --label --group-separator"
# Flags that print and search nothing. grep's `-h` is --no-filename, not help.
GREP_INERT_FLAGS="--help -V --version"
RG_INERT_FLAGS="-h --help -V --version --type-list"
RG_VALUE_FLAGS="-e --regexp -f --file -m --max-count -A --after-context -B --before-context -C --context -g --glob --iglob -t --type -T --type-not --type-add -M --max-columns -r --replace -d --max-depth --max-filesize --sort --sortr --pre --colors"

# What fired: `root` for a named root, `bare` for no path, with the searching
# command in `tool` and, for `bare`, the search as typed in `typed`.
fires=""
tool=""
typed=""
# Set by a `cd`, `pushd` or `popd` — see LIMITS.
moved=0
# Whether any search's root names a heavy tree (workflow-core#2060), and whether the search
# being judged runs under `watch`, where no rewrite is offered.
heavy_tree=0
in_watch=0

# names_tree <word> — whether a search root is node_modules, .next or .git by its
# last component, or dist, build, out or coverage where git ignores it.
names_tree() {
  local lit
  lit="$(gp_literal "$1")" || return 1
  while [[ "$lit" == */ && "$lit" != / ]]; do lit="${lit%/}"; done
  case "${lit##*/}" in
    node_modules | .next | .git) return 0 ;;
    dist | build | out | coverage)
      local rc=0
      git -C "$(gp_cwd)" check-ignore -q -- "$lit/" 2>/dev/null || rc=$?
      ((rc <= 1)) ||
        gl_log "git check-ignore exited $rc — a recursive search of $lit was judged not build output"
      return "$rc"
      ;;
    *) return 1 ;;
  esac
}

# is_project_root <word> — whether a start point, resolved against the walker's
# cwd, is the repo root, which holds every heavy tree.
is_project_root() {
  local lit
  lit="$(gp_literal "$1")" || return 1
  [[ "$lit" == /* ]] || lit="$(gp_cwd)/$lit"
  [[ -n "$root_real" && "$(realpath -m -- "$lit" 2>/dev/null)" == "$root_real" ]]
}

# A `find` reads every tree it is given, ignored or not. From the repo root it
# is let off only by a `-prune` or a `-maxdepth`.
judge_find() {
  local word start bounded=0
  for word in "$@"; do
    case "$(gp_literal "$word")" in -prune | -maxdepth) bounded=1 ;; esac
  done
  gp_find_starts "$@"
  for start in "${_gp_find_starts[@]:-.}"; do
    names_tree "$start" && heavy_tree=1
    ((bounded)) || ! is_project_root "$start" || heavy_tree=1
  done
  return 0
}

# `watch` runs its command through `sh -c`, so a single word is split back into
# the command it holds.
judge_watch() {
  local segment="$1" lit
  local -a inner
  shift
  while (($#)); do
    lit="$(gp_literal "$1")"
    case "$lit" in
      -n | --interval | -q | --equexit) shift ;;
      --)
        shift
        break
        ;;
      -*) ;;
      *) break ;;
    esac
    shift || return 0
  done
  (($#)) || return 0
  in_watch=1
  if (($# == 1)); then
    read -ra inner <<<"$(gp_literal "$1")"
    judge "$segment" ${inner+"${inner[@]}"}
  else
    judge "$segment" "$@"
  fi
  in_watch=0
}

judge_word() {
  case "$1" in
    flag)
      case "$2" in
        -r | -R | --recursive | --dereference-recursive) _recursive=1 ;;
        --files) _files=1 ;;
      esac
      [[ " $inert_flags " == *" $2 "* ]] && _inert=1
      ;;
    opt)
      # A pattern given by flag means every bare word is a path.
      case "$2" in
        -e | --regexp | -f | --file) _pattern_by_flag=1 ;;
      esac
      ;;
    arg)
      _args=$((_args + 1))
      # The first bare word is the pattern, unless a flag already supplied one.
      [[ "$_args" -gt 1 || "$_pattern_by_flag" -eq 1 ]] || return 0
      names_tree "$3" && _heavy_tree=1
      ((grep_like)) && is_project_root "$3" && _heavy_tree=1
      if ((dot_ok)) && [[ "$roots" -eq 1 ]] &&
        [[ "$3" == "." || "$3" == "./" || "$3" == "$root" || "$3" == "$root/" ]]; then
        _dot_root=1
      fi
      ;;
  esac
  return 0
}

judge() {
  local segment="$1" w text before spec inert_flags dot_ok=1 grep_like=0
  shift
  gp_unwrap "$@"
  [[ "${#_gp_unwrapped[@]}" -gt 0 ]] || return 0

  # `rg` is recursive with no flag at all; the greps need one.
  case "${_gp_unwrapped[0]}" in
    grep | egrep | fgrep)
      grep_like=1
      _recursive=0
      spec="$GREP_VALUE_FLAGS" inert_flags="$GREP_INERT_FLAGS"
      ;;
    rg)
      # Named a heavy tree, `rg` reads it.
      ((shows_prompt)) || dot_ok=0
      _recursive=1
      spec="$RG_VALUE_FLAGS" inert_flags="$RG_INERT_FLAGS"
      ;;
    cd | pushd | popd)
      moved=1
      return 0
      ;;
    find)
      judge_find "${_gp_unwrapped[@]:1}"
      return 0
      ;;
    watch)
      ((in_watch)) || judge_watch "$segment" "${_gp_unwrapped[@]:1}"
      return 0
      ;;
    *) return 0 ;;
  esac

  [[ -z "$fires" && "$moved" -eq 0 && "$at_root" -eq 1 && "$in_watch" -eq 0 ]] || dot_ok=0

  _args=0
  _heavy_tree=0
  _dot_root=0
  _pattern_by_flag=0
  _files=0
  _inert=0
  gp_scan_flags "$spec" judge_word -- "${_gp_unwrapped[@]:1}"
  [[ "$_recursive" -eq 1 && "$_inert" -eq 0 ]] || return 0
  # A grep naming no path searches where it stands, the repo root included.
  ((grep_like)) && [[ "$_args" -eq $((1 - _pattern_by_flag)) ]] && is_project_root . && _heavy_tree=1
  ((_heavy_tree)) && heavy_tree=1
  ((dot_ok)) || return 0

  if [[ "$_dot_root" -eq 1 ]]; then
    fires=root tool="${_gp_unwrapped[0]}"
    return 0
  fi

  # No path: the bare words are the pattern alone, if any.
  [[ "$_args" -eq $((1 - _pattern_by_flag - _files)) ]] || return 0
  for w in "$@"; do
    [[ "$w" == "${_gp_unwrapped[0]}" ]] && break
    [[ "${w##*/}" == xargs ]] && return 0
  done
  [[ "${_gp_unwrapped[0]}" == rg && "$segment" == *"<"* ]] && return 0
  _gp_as_written "$segment"
  text="${_gp_written#"${_gp_written%%[![:space:]]*}"}"
  text="${text%"${text##*[![:space:]]}"}"
  [[ -n "$text" && "$raw" == *"$text"* ]] || return 0
  # Twice in the command, and which one is this search is unreadable.
  before="${raw#*"$text"}"
  [[ "$before" == *"$text"* ]] && return 0
  before="${raw%%"$text"*}"
  before="${before%"${before##*[![:space:]]}"}"
  [[ "${_gp_unwrapped[0]}" == rg && "$before" == *"|" && "$before" != *"||" ]] && return 0
  fires=bare tool="${_gp_unwrapped[0]}" typed="$text"
  return 0
}

gp_walk_commands judge

# A heavy-tree root with nothing to rewrite gets the rule alone.
if [[ -z "$fires" ]]; then
  ((heavy_tree)) && gp_rule heavy-tree-search
  gp_allow
fi

# --------------------------------------------------------------------------
# Build the replacement out of GIT'S OWN VIEW of the top level, which needs no
# maintained exclusion list: .git, node_modules, .next and every cache directory
# are gitignored already, and stay out for that reason rather than by name.
#
# Two lists, unioned:
#   ls-files                              tracked content — its first path
#                                         component is a directory worth
#                                         searching, or a root file
#   ls-files --others --exclude-standard  a directory that exists but holds
#             --directory                 nothing tracked yet, so a new one is
#                                         not silently dropped
#
# The second is filtered to DIRECTORIES, and to NON-DOT ones. Taking untracked
# root files too would re-admit the hundreds of `.<name>.out` scratch files this
# repo's root carries, which overflow sed's argument limit. And an untracked
# DOT-directory at this root is tooling state that nobody ignored — searching a
# cache on every rewritten command is a cost with no return. The price of that line is a new source directory named with a
# leading dot, which would be dropped silently; no such directory exists here,
# and a tracked one — `.claude`, `.github` — comes through the first list.

expansion=""
seen=""
while IFS= read -r path; do
  # The first path component: the directory to search, or the file itself.
  name="${path%%/*}"
  case "$name" in
    "" | .env | .env.* | *.pem) continue ;;
  esac
  # The name reaches sed's replacement text and then a shell command line, both
  # unescaped. Every top-level name in this repo is in the class below; one
  # outside it — a space, a `&`, a glob character, a leading dash — would be
  # mangled by the first and misread by the second, so stand down instead.
  case "$name" in
    *[!A-Za-z0-9._-]* | -*)
      gl_open "a top-level name outside [A-Za-z0-9._-] — a recursive dot search was allowed unrewritten"
      ;;
  esac
  # Tracked but not on disk: `ls-files` still lists a file deleted from the
  # working tree, and naming it would make the corrected grep warn `No such
  # file` and exit 2 even where it matched. `-e` follows a symlink, so a broken
  # one is dropped for the same reason — grep exits 2 on it too.
  [[ -e "$root/$name" ]] || continue
  case " $seen " in *" $name "*) continue ;; esac
  seen+=" $name"
  expansion+="${expansion:+ }$name"
done < <(
  {
    git -C "$root" ls-files
    git -C "$root" ls-files --others --exclude-standard --directory |
      grep -E '^[^.].*/$'
  } 2>/dev/null
)

[[ -n "$expansion" ]] ||
  gl_open "the project directory listed no usable entry — a recursive dot search was allowed unrewritten"

# Textual substitution on the raw string, so quoting everywhere else survives
# untouched. For a named root, exactly one standalone root is present — the
# pre-test above required it — so the first match is the search root. For no
# path, the search's own text gains the expansion after it; a redirection it
# carries may stand before a path, as shell reads it.
if [[ "$fires" == bare ]]; then
  rewritten="${raw/"$typed"/"$typed $expansion"}"
else
  rewritten="$(printf '%s' "$raw" |
    sed -E "0,/(^|[[:space:]])(\.|${root_re})\/?([[:space:]]|\$)/s//\1${expansion}\3/")" ||
    gl_open "the rewrite did not render — a recursive dot search was allowed unrewritten"
fi

[[ "$rewritten" != "$raw" ]] ||
  gl_open "the standalone root did not substitute — a recursive dot search was allowed unrewritten"

why=""
[[ "$tool" == rg ]] || {
  heavy_tree=1
  why="
Yours also reads what git ignores: node_modules, .git, build output."
}
((shows_prompt)) && why+="
It covers $root/.env, named by the \`Read(./.env)\` deny rule in
.claude/settings.json, so this session's \`${mode:-default}\` permission mode
shows a permission prompt whether or not a .env exists (mantahostels#2717).
Auto mode shows none (workflow-core#482)."

# The command goes first and is spliced in as a value, never through the
# heredoc, so nothing in it is expanded.
warning="$(gp_unmask "$rewritten")

That is your search with its root expanded; yours runs as written.$why

$(
  cat <<EOF
The expansion is git's view of the top level: it keeps .claude/, .github/
and untracked directories, and misses gitignored paths and untracked root
files. For \`rg\` it WIDENS the search to the hidden directories \`rg PAT .\` skips.
EOF
)"

if ((heavy_tree)); then
  gp_rule_prelude "$warning"
  gp_rule heavy-tree-search
fi
gp_warn "$warning"
