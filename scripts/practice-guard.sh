#!/usr/bin/env bash
# practice-guard.sh — the Leading practice rule's global hook (#2258).
#
# PreToolUse (Read, Glob, Write, Bash; #2324). **Enforced.** On a session's
# first call touching docs/practice/, it hands over the craft list
# and the evidence-tier ranking a note's entries follow (#2637); later touches
# hand over nothing. A Write to <work tree root>/docs/practice/<path>.md whose
# path is not a craft on the list is refused, the refusal printing both.
#
# Known misses: a Bash command writing an off-list note, as only the Write
# tool's path is judged; a Grep, which is not registered; a touch that never
# spells docs/practice, such as a cd into it then a relative path, or a Glob
# on **/practice.
#
# Stop, run as `practice-guard.sh stop` (#2326). **Enforced** for presence and
# form. Where the session wrote a file in a git work tree that git does not
# ignore, outside the job directory, it takes the latest **Practice:** line
# from the transcript's assistant text and tracker writes (a gh issue or pr
# write, resolve-ticket.js or file-issue.js: the command, each heredoc and
# each BODY_FLAGS value it holds read alone, a $'...' value's \n, \r, \t, \',
# \" and \\ decoded, any other escape kept, and any body file it names), the
# marker opening its line. It refuses the stop once a session,
# naming the fault and printing the list, where: there is no line; the line is
# none of the four forms; covered names a note that is missing at both the
# work tree root and the plugin (the machine copy: the root alone), or, as
# the first found, has no
# Researched: date, is 6 months old or more, or is off the list; ran names a
# note this session did not write; skipped names a kind off the exempt list,
# matched on its whole phrase, an article before any word but "or" optional,
# its last word singular or plural and no word before it but an article, or
# adds a second clause after it; none-fits names an off-list craft. After a
# skipped kind's phrase may come only an aside in brackets or one phrase
# opening with a word in PREPOSITIONS, its words each a TAIL_WORD, an allowlist
# of characters, and none a word in JOINS, alone or glued on by any mark but
# "-" (#3077, #3491, #3594); ODD_SPACES read as plain spaces first, and a
# second clause refused with U+200B deleted or read as a space (#3603). A
# qualifier before the kind, as in "biome version bump", and a bare range
# after it, as in "version bump 4.1 to 5.0", are refused, the reason naming the
# shape wanted; so is a skipped line holding a kept $'...' escape. A
# docs/research/<asset class>-precedent.md path, design-vault's, stands for a
# note in covered and ran. It refuses rather
# than warns because refusing once is the only Stop channel that reaches the
# model (#829, mantahostels#2319).
#
# Known misses: a task spanning sessions where an earlier one declared;
# subagent work, as Stop does not fire on subagents; a tracked-file write
# outside any task; a write made through Bash, as only Write, Edit and
# NotebookEdit calls are read; a note a subagent wrote, named in ran; a body
# file gone by the stop.
#
# Known false refusals: a real path or name whose part after a glue mark is a
# JOINS word, as in "version bump of libfoo.so", is refused as a second
# clause; so is a word a U+200B splits a JOINS word off, as in
# "so<U+200B>lar".
#
# **Unenforceable**: whether the craft a note is named for is the right one for
# the task; a false skipped on non-trivial work, with no diff-size cross-check
# since no source gives a threshold, nor what an exempt kind's aside or
# prepositional phrase says, so a second clause joined by no listed word or
# mark, as in "revert of one commit built a scheduler", passes; whether a
# plural is a word, so "typo fixs" passes; a JOINS word glued on by a hyphen,
# as in "x-and", since "so-called" passes; whether the practice was used;
# evidence quality.
#
# THE CRAFT LIST AND THE NOTES, FOUND TWO WAYS (#5344). Run from the plugin,
# the plugin root is this script's directory's parent, holding
# docs/practice-crafts.md: the list is that file, and a covered note is
# docs/practice/<craft>.md at the work tree root, else at the plugin root, its
# currency judged on whichever is found. Run as the founder's machine copy at
# ~/.claude/hooks/, whose parent holds no such file, the list is
# ~/.claude/practice-crafts.md and a note resolves at the work tree root alone.
# So at Stop the machine copy stands down, silent and latching nothing, where
# the session's project ($CLAUDE_PROJECT_DIR, else the payload's cwd) enables
# workflow-core@<marketplace> in enabledPlugins and that marketplace's
# extraKnownMarketplaces source.ref is a release tag at or above
# FIRST_GUARD_RELEASE, the first to ship this guard: there the plugin's copy
# judges the stop, and the machine copy, blind to the plugin's notes, would
# refuse one only the plugin holds, the latch they share letting it decide
# (#5394). The release is read from that documented settings field, never the
# undocumented plugin cache (#5410). Elsewhere, a branch, sha, older tag or no
# ref included, it judges as the only copy, keeping the rule's reach outside
# adopters (#2258 user story 6). Residual: managed settings and a --plugin-dir
# load are not read, so there the machine copy still judges and can refuse a
# plugin-only note.
# `npm run check:settings` holds both machine files to this repo's.
#
# Named for what it guards, not `guard-*`: the founder's machine copy under
# ~/.claude/hooks/ carries this name, and check:settings pairs the two by it.
#
# IMPLICIT:  on a session's first touch of docs/practice/ hands over the craft list, refuses a Write of an off-list note, and at Stop refuses once a session that wrote a tracked file with no **Practice:** line that holds up, the machine copy standing down at Stop where the session's project enables a plugin release pinned at or above the first to ship this guard.
# JUSTIFIED: fail-safe — refusing once is the only Stop channel that reaches the model (#829).
# DEFEAT:    none — each refusal fires once a session, and is cleared by declaring a line that holds up.
# TREE:      session — the work tree roots of the files the session wrote, the plugin root beside this script, and, for the machine copy, the user's and the session project's Claude Code settings.
#
# Self-contained: it also runs outside any adopter, so it sources nothing from
# workflow-core and writes its own envelopes. The latch is shared by path, so
# the shipped and machine copies running on one call latch once between them.
set -uo pipefail
shopt -s extglob

input=$(cat)
event=${1:-}
# Every Read, Glob, Write and Bash call on the machine runs this; most never
# name the directory, so they leave before any jq.
# A Glob may split it between its path and pattern.
[[ "$event" = stop ]] || [[ $input == *practice* ]] || exit 0

plugin_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P) || plugin_root=
if [[ -n $plugin_root && -f $plugin_root/docs/practice-crafts.md ]]; then
  list_file=$plugin_root/docs/practice-crafts.md
else
  plugin_root='' list_file=$HOME/.claude/practice-crafts.md
fi
note_where="docs/practice/<craft>.md at the work tree's root"
[[ -n $plugin_root ]] && note_where+=", else the plugin's copy"
list=$(cat "$list_file" 2>/dev/null)
if [[ -z "$list" ]]; then
  echo "practice-guard: no craft list at $list_file, so nothing is judged" >&2
  exit 0
fi

readonly RANKING="Each note entry names its sources and the tier each earns, its tag spelt exactly as one of: [standard or field body], [named expert], [survey or curated list] or [unverified]. The top tier is a standard or field body's free guidance, such as an IETF RFC or a W3C, NIST or OWASP publication. A format or convention spec written for others to adopt, such as SemVer, is a standard. A project's docs, open-source or company-run, earn the top tier only for how that project's own product behaves or is configured, its rules for its own contributors included; their reasoned guidance on a general practice is [named expert], and their docs cited as one adopter of a general practice are [unverified]. A tool's own docs earn the top tier for what the tool does, but a default to use it needs another source. A paper, peer-reviewed or not, is [named expert], its authors' verdict with reasons, or [survey or curated list] where it reports a questionnaire or interviews; a systematic review or meta-analysis outranks a single paper, so name it as one. An entry whose default rests on [unverified] sources alone says it sets no default."

if ! command -v jq >/dev/null; then
  echo "practice-guard: jq is not installed, so nothing is judged" >&2
  exit 0
fi
if ! jq -e 'type == "object"' <<<"$input" >/dev/null 2>&1; then
  echo "practice-guard: the hook payload is not a JSON object, so nothing is judged" >&2
  exit 0
fi

# The list is "- <slug>: <what it covers>".
on_list() {
  local line
  while IFS= read -r line; do
    [[ $line == "- $1: "* ]] && return 0
  done <<<"$list"
  return 1
}

# A latch file per session and agent, a subagent latching apart: set -C makes
# the create fail where the file exists, so two calls racing latch once.
# Returns 1 where it was already latched, and 2, saying why on stderr, where
# nothing latches (#2601).
latch() {
  local key dir
  key=$(jq -r '[.session_id // "", .agent_id // empty] | join("-")' <<<"$input")
  if ! [[ $key =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "practice-guard: the session id \"$key\" is no plain name, so nothing latches" >&2
    return 2
  fi
  dir="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/practice-guard-$(id -u)"
  mkdir -m 700 "$dir" 2>/dev/null
  # Another user could have made it first in a shared /tmp.
  if ! { [[ -d "$dir" ]] && [[ ! -L "$dir" ]] && [[ -O "$dir" ]]; }; then
    echo "practice-guard: $dir is no latch directory of this user's, so nothing latches" >&2
    return 2
  fi
  (set -C && : >"$dir/$1$key") 2>/dev/null && return 0
  [[ -e "$dir/$1$key" ]] && return 1
  echo "practice-guard: cannot create the latch $dir/$1$key, so nothing latches" >&2
  return 2
}

# The exempt kinds as the refusal spells them, which EXEMPT_PATTERN is built
# from: comma-separated, so no kind holds a comma.
readonly EXEMPT_KINDS="a typo or wording fix, a re-anchor or regeneration, a concision cut, propagating an already-settled fact, a revert, a version bump, a reply that only answers a question"

# The words that may open the one phrase after an exempt kind's, and those
# that join a second clause on, bare alternations a regex groups itself
# (#3077). The set is closed, so a scope a review finds refused is added here.
# Reviews found of, in, to and for (#2806), and on, over, after and from
# (#3077); the other 13 were chosen with no source.
readonly PREPOSITIONS='of|in|on|to|for|from|over|after|before|since|across|at|by|into|under|via|per|during|through|between|within'
# The English coordinating conjunctions bar "for", which opens a PREPOSITIONS
# phrase, and the other words reviews found joining a clause on (#3077, #3491).
# No word is in both lists, so a whole tail can be searched for a JOINS word.
readonly JOINS='and|but|or|nor|yet|so|plus|with|then|also|as well as'
# A word an exempt kind's tail may hold, its ASCII letters and digits spelt
# out as a range or [:alnum:] follows the locale (#3491).
readonly ASCII_ALNUM=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789
# The marks a tail word may hold anywhere, and those it may hold only inside
# it, the "-" first so a bracket reads it as itself. Each glues a JOINS word
# on but the "-", since "so-called" passes (#3594).
readonly TAIL_MARKS="#'@" TAIL_JOINERS="-./"
readonly TAIL_GLUE=$TAIL_MARKS${TAIL_JOINERS#-}
readonly TAIL_WORD="[$ASCII_ALNUM$TAIL_MARKS]+([$TAIL_JOINERS][$ASCII_ALNUM$TAIL_MARKS]+)*"
quoted_list() {
  local i last_sep=$2 out=\"${1:0:1}\"
  for ((i = 1; i < ${#1}; i++)); do
    ((i == ${#1} - 1)) && out+=$last_sep || out+=", "
    out+=\"${1:i:1}\"
  done
  echo "$out"
}
JOINERS_QUOTED=$(quoted_list "$TAIL_JOINERS" " or ")
ALLOWLIST_TEXT="ASCII letters and digits, spaces, $(quoted_list "$TAIL_MARKS" ", "), and a $JOINERS_QUOTED inside a word"
readonly JOINERS_QUOTED ALLOWLIST_TEXT
# Unicode's Zs spaces past U+0020 as UTF-8, read as plain spaces, and U+200B,
# deleted (#3491, #3594), or read as a space where skipped_fault re-judges a
# tail (#3603).
readonly ODD_SPACES=($'\xc2\xa0' $'\xe1\x9a\x80' $'\xe2\x81\x9f' $'\xe3\x80\x80' $'\xe2\x80\xaf' $'\xe2\x80\x80' $'\xe2\x80\x81' $'\xe2\x80\x82' $'\xe2\x80\x83' $'\xe2\x80\x84'
  $'\xe2\x80\x85' $'\xe2\x80\x86' $'\xe2\x80\x87' $'\xe2\x80\x88' $'\xe2\x80\x89' $'\xe2\x80\x8a')
readonly ZERO_WIDTH=$'\xe2\x80\x8b'
readonly ARTICLE='((a|an|the) )?'

# Each kind's whole phrase, an article before any word but "or" optional, its
# last word singular or plural, and each side of an "or" standing alone. The
# phrase is its third group and the words after it its last.
exempt_pattern() {
  local kind kinds pattern phrases=() IFS=,
  read -ra kinds <<<"$EXEMPT_KINDS"
  for kind in "${kinds[@]}"; do
    kind=" ${kind# } " kind=${kind// a / } kind=${kind// an / }
    kind=${kind# } kind=${kind% }
    phrases+=("$kind")
    [[ $kind =~ ^(.*\ )?([^ ]+)\ or\ ([^ ]+)(.*)$ ]] || continue
    phrases+=("${BASH_REMATCH[1]}${BASH_REMATCH[2]}${BASH_REMATCH[4]}" "${BASH_REMATCH[1]}${BASH_REMATCH[3]}${BASH_REMATCH[4]}")
  done
  pattern=$(printf '%s\n' "${phrases[@]}" | sed 's/[][\.^$*+?(){}|]/\\&/g' | paste -sd'|')
  pattern=${pattern// / $ARTICLE} pattern=${pattern//" ${ARTICLE}or "/ or }
  echo "^$ARTICLE(($pattern)(e?s)?)([^[:alnum:]'-].*)?$"
}

# The second-clause fault on the exempt kind's phrase "$1".
second_clause() { echo "adds a second clause to the exempt kind \"$1\""; }

# Whether "$1" holds a JOINS word, alone or glued on by a TAIL_GLUE mark.
has_joins_word() { [[ " ${1//[$TAIL_GLUE]/ } " =~ \ ($JOINS)\  ]]; }

# The fault in "$1", the words after the exempt kind's phrase "$2"; empty
# where it is nothing, an aside in brackets, or a phrase opening with a word in
# PREPOSITIONS, whose words are each a TAIL_WORD and none a JOINS word, alone
# or glued on by a TAIL_GLUE mark (#2806, #3077, #3491, #3594). Any other
# character, a range's dash in "pages 3–5" included, is refused.
tail_fault() {
  local words off
  [[ -z $1 ]] && return
  if [[ $1 =~ ^\ \(\ *(.*)$ ]]; then
    # fault_in strips the aside's closing bracket, so one left means words follow it.
    words=${BASH_REMATCH[1]}
  elif [[ $1 =~ ^\ ($PREPOSITIONS)\ (.*)$ ]]; then
    words=${BASH_REMATCH[-1]}
  elif [[ $1 =~ ^\ ($JOINS)\  || ! $1 =~ ^\ [[:alnum:]] ]]; then
    second_clause "$2"
    return
  else
    echo "follows the exempt kind \"$2\" with neither an aside in brackets nor a phrase opening with one of: ${PREPOSITIONS//|/, }; write it as \"$2 (<aside>)\" or \"$2 of <what>\""
    return
  fi
  off=${words//[$TAIL_JOINERS $TAIL_MARKS$ASCII_ALNUM]/}
  if [[ -n $off ]]; then
    echo "holds \"${off:0:1}\", off the tail's allowlist: $ALLOWLIST_TEXT"
  elif has_joins_word "$words"; then
    second_clause "$2"
  elif ! [[ " $words " =~ ^(\ $TAIL_WORD)+\ $ ]]; then
    echo "puts a $JOINERS_QUOTED outside a word"
  fi
}

# The fault in the skipped kind "$1", matched with U+200B deleted; empty where
# it is an exempt kind. Deleting U+200B joins "a<U+200B>nd" into a JOINS word,
# and reading it as a space parts one from "commit<U+200B>and", so the tail
# after the kind's phrase is judged with U+200B deleted, then searched for a
# JOINS word with it read as a space.
skipped_fault() {
  local named phrase tail end spaced reason i
  named=${1//"$ZERO_WIDTH"/} named=${named//+([[:space:]])/ }
  shopt -s nocasematch
  [[ $named =~ $EXEMPT_PATTERN ]] && phrase=${BASH_REMATCH[3]} tail=${BASH_REMATCH[-1]}
  if [[ -n "${phrase:-}" ]]; then
    reason=$(tail_fault "$tail" "$phrase")
    # The shortest end of "$1" that is the tail once U+200B is deleted.
    for ((i = ${#1}; i >= 0; i--)); do
      end=${1:i} end=${end//"$ZERO_WIDTH"/} end=${end//+([[:space:]])/ }
      [[ "$end" = "$tail" ]] && spaced=${1:i} && break
    done
    if [[ -z $reason && ${spaced:-} == *"$ZERO_WIDTH"* ]]; then
      spaced=${spaced//"$ZERO_WIDTH"/ } spaced=${spaced//+([[:space:]])/ }
      # Only a second clause found the spaced way refuses, named in that form.
      # Its JOINS word is sought directly, not through tail_fault, whose opener
      # check a U+200B in the preposition, as in "o<U+200B>f", would end first
      # (#3611).
      if has_joins_word "$spaced"; then
        named=${named%"$tail"}$spaced reason=$(second_clause "$phrase")
      fi
    fi
  fi
  shopt -u nocasematch
  if [[ -z "${phrase:-}" ]]; then
    echo "skipped names \"$named\", which is no exempt kind: the line opens with a kind's whole phrase, its last word singular or plural, and no word before it but \"a\", \"an\" or \"the\", as in \"version bump of biome\""
  elif [[ -n "${reason:-}" ]]; then
    echo "skipped names \"$named\", which $reason"
  fi
}

# PRACTICE_GUARD_TODAY is the seam scripts/practice-guard.test.ts fills.
# The first workflow-core release to ship this guard as a plugin hook.
readonly FIRST_GUARD_RELEASE=v3.0.0
readonly TODAY=${PRACTICE_GUARD_TODAY:-$(date +%F)}

# A declaration's marker opens its line past any list or quote marks, a
# command's heredocs and inline bodies read as lines of their own (#3077); a
# marker quoted mid-line is prose.
readonly MARKER='[[:space:]>*-]*\*\*Practice:\*\*'
readonly BODY_FLAGS='--body|--comment|-b|-c'
readonly BODY_FILE_FLAGS='--body-file|--comment-file|-F'

# The fault in the declaration "$1", judged against the work tree roots in
# $roots and the paths in $written; empty where it holds up.
fault_in() {
  local decl=$1 form rest note path root found date expiry space
  [[ -n "$decl" ]] || {
    echo "no **Practice:** line"
    return
  }
  if ! [[ $decl =~ ^${MARKER}[[:space:]]*(ran|covered|skipped|none-fits)[[:space:]]*(—|–|-)+[[:space:]]*(.*)$ ]]; then
    echo "\"$decl\" is none of the four forms"
    return
  fi
  form=${BASH_REMATCH[1]} rest=${BASH_REMATCH[3]//\`/}
  # A sentence's full stop, a stray closing quote, or an aside's closing bracket.
  rest=${rest%%+([\"\'.;)[:space:]])}
  case $form in
    skipped)
      for space in "${ODD_SPACES[@]}"; do rest=${rest//"$space"/ }; done
      skipped_fault "$rest"
      return
      ;;
    none-fits)
      rest=${rest#[Nn]earest } rest=${rest%%[.,; ]*}
      on_list "$rest" || echo "none-fits names \"$rest\", which is not a craft on the list"
      return
      ;;
  esac
  note=${rest%%[,[:space:]]*} note=${note%%+([\"\'.;)])}
  if [[ $note =~ (^|/)docs/practice/(.+)\.md$ ]]; then
    on_list "${BASH_REMATCH[2]}" || {
      echo "$form names $note, whose slug is not a craft on the list"
      return
    }
  elif ! [[ $note =~ (^|/)docs/research/[^/]+-precedent\.md$ ]]; then
    echo "$form names \"$note\", which is no docs/practice/<craft>.md note"
    return
  fi
  if [[ "$form" = ran ]]; then
    while IFS= read -r path; do
      [[ $path == "$note" || $path == */"$note" ]] && return
    done <<<"$written"
    echo "ran names $note, which this session did not write"
    return
  fi
  found=
  if [[ $note == /* ]]; then
    [[ -f "$note" ]] && found=$note
  else
    while IFS= read -r root; do
      [[ -n "$root" ]] && [[ -f "$root/$note" ]] && {
        found=$root/$note
        break
      }
    done <<<"$roots"
    [[ -z $found && -n $plugin_root && $note == docs/practice/* && -f $plugin_root/$note ]] && found=$plugin_root/$note
  fi
  [[ -n "$found" ]] || {
    echo "covered names $note, which does not exist"
    return
  }
  [[ $note == *-precedent.md ]] && return
  date=$(sed -n 's/^Researched:[[:space:]]*\([0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}\).*/\1/p' "$found" | head -n1)
  [[ -n "$date" ]] || {
    echo "covered names $note, which has no Researched: date"
    return
  }
  expiry=$(date -d "$date +6 months" +%F 2>/dev/null) || {
    echo "covered names $note, whose Researched: date $date is no date"
    return
  }
  [[ $expiry > $TODAY ]] || echo "covered names $note, researched $date, 6 months ago or more"
}

# Whether Claude Code's settings for the project at "$1" load a workflow-core
# plugin release that ships this guard. enabledPlugins and
# extraKnownMarketplaces each merge user, then project, then local, each key
# taking its highest file's value; some workflow-core@<marketplace> key must be
# left true, and that marketplace's source.ref a vX.Y.Z tag at or above
# FIRST_GUARD_RELEASE. A file missing, not one JSON object, or whose field is no
# object adds nothing to that field; one there but unreadable or not JSON says
# so on stderr.
plugin_guard_loaded_at() {
  local file merged='{"plugins":{},"markets":{}}' layer
  for file in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" "$1/.claude/settings.json" "$1/.claude/settings.local.json"; do
    [[ -e "$file" ]] || continue
    if ! layer=$(jq -cs 'def field($k): if (.[$k] | type) == "object" then .[$k] else {} end;
      if length == 1 and (.[0] | type) == "object" then .[0] else {} end
      | {plugins: field("enabledPlugins"), markets: field("extraKnownMarketplaces")}' "$file" 2>/dev/null); then
      echo "practice-guard: $file is unreadable or not JSON, so it enables no plugin" >&2
      continue
    fi
    merged=$(jq -c --argjson l "$layer" '{plugins: (.plugins + $l.plugins), markets: (.markets + $l.markets)}' <<<"$merged")
  done
  jq -e --arg first "$FIRST_GUARD_RELEASE" '
    def release: capture("^v(?<x>0|[1-9][0-9]*)\\.(?<y>0|[1-9][0-9]*)\\.(?<z>0|[1-9][0-9]*)$") | [.x, .y, .z | tonumber];
    ($first | release) as $floor | .markets as $markets
    | any(.plugins | to_entries[]; (.key | startswith("workflow-core@")) and .value == true
        and ([$markets[.key | ltrimstr("workflow-core@")] | objects | .source | objects | .ref | strings | release] | any(. >= $floor)))' <<<"$merged" >/dev/null 2>&1
}

if [[ "$event" = stop ]]; then
  EXEMPT_PATTERN=$(exempt_pattern)
  readonly EXEMPT_PATTERN
  transcript=$(jq -r '.transcript_path // empty' <<<"$input")
  if [[ ! -r "$transcript" ]]; then
    echo "practice-guard: no readable transcript, so nothing is judged" >&2
    exit 0
  fi
  # One line per file the main chain wrote, as "W<tab><path>"; per text that
  # carries a declaration, as "L<tab><its last **Practice:** line>"; and per
  # body file a tracker write names, as "F<tab><path>", in transcript order.
  # A line that is not JSON, such as one torn mid-write, is passed over.
  if ! scan=$(jq -rR --arg marker "^$MARKER" --arg flags "$BODY_FLAGS" --arg files "$BODY_FILE_FLAGS" '
    fromjson? | select(.type == "assistant" and (.isSidechain | not)) | .cwd as $cwd
    | .message.content[]? | select(type == "object")
    | def last_line: [splits("\n") | select(test($marker))] | last // empty;
      if .type == "text" then (.text // "" | last_line | "L\t\(.)")
      elif .type != "tool_use" then empty
      elif .name == "Write" or .name == "Edit" then "W\t\(.input.file_path // empty)"
      elif .name == "NotebookEdit" then "W\t\(.input.notebook_path // empty)"
      elif .name == "Bash" and (.input.command // "" | test("\\bgh +(issue|pr) +(comment|create|close|edit|review)\\b|resolve-ticket\\.js|file-issue\\.js")) then
        (.input.command
          | "<<-?[ \t]*(?<q>[\"\u0027]?)(?<t>[A-Za-z_][A-Za-z0-9_]*)\\k<q>[^\n]*\n(?<h>(?:[^\n]*\n)*?)[ \t]*\\k<t>(?=\n|$)" as $doc
          | [match($doc; "g") | .captures[] | select(.name == "h") | .string] as $docs
          | gsub($doc; "")
          | gsub("(?<at>^|\\s)(?:" + $flags + ")[ =]+(?:\"(?<d>(?:[^\"\\\\]|\\\\.)*)\"|\u0027(?<s>(?:[^\u0027]|\u0027\\\\\u0027\u0027)*)\u0027|\\$\u0027(?<a>(?:[^\u0027\\\\]|\\\\.)*)\u0027)";
            "\(.at)\n\(.d // .s // (.a | gsub("\\\\(?<c>.)"; {n: "\n", r: "\r", t: "\t", "\u0027": "\u0027", "\"": "\"", "\\": "\\"}[.c] // "\\\(.c)")))\n")
          | ., $docs[] | last_line | "L\t\(.)"),
        (.input.command | scan("(?:" + $files + ")[ =]+(\"[^\"]*\"|\u0027[^\u0027]*\u0027|[^ ;&|)]+)")[0]
          | gsub("^[\"\u0027]|[\"\u0027]$"; "") | select(. != "-")
          | if startswith("/") or $cwd == null then "F\t\(.)" else "F\t\($cwd)/\(.)" end)
      else empty end
  ' "$transcript"); then
    echo "practice-guard: the transcript scan failed, so nothing is judged" >&2
    exit 0
  fi

  written="" roots="" decl=""
  while IFS=$'\t' read -r kind value; do
    case $kind in
      W)
        [[ -n "${CLAUDE_JOB_DIR:-}" ]] && [[ $value == "$CLAUDE_JOB_DIR"/* ]] && continue
        at=$(dirname -- "$value")
        while [[ ! -d "$at" ]]; do at=$(dirname -- "$at"); done
        top=$(git -C "$at" rev-parse --show-toplevel 2>/dev/null) || continue
        git -C "$top" check-ignore -q -- "$value" 2>/dev/null && continue
        written+=$value$'\n' roots+=$top$'\n'
        ;;
      L) decl=$value ;;
      F)
        line=$(grep -E -- "^$MARKER" "$value" 2>/dev/null | tail -n1)
        [[ -n "$line" ]] && decl=$line
        ;;
    esac
  done <<<"$scan"
  [[ -n "$written" ]] || exit 0
  cwd=$(jq -r '.cwd // "."' <<<"$input")
  cwd_top=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)
  roots+=$cwd_top

  # The session's project decides whether the plugin loaded, not the trees it
  # wrote into.
  [[ -z $plugin_root ]] && plugin_guard_loaded_at "${CLAUDE_PROJECT_DIR:-${cwd_top:-$cwd}}" && exit 0

  fault=$(fault_in "$decl")
  [[ -n "$fault" ]] || exit 0
  latch stop-
  case $? in
    1) exit 0 ;;
    2) [[ "$(jq -r '.stop_hook_active // false' <<<"$input")" = true ]] && exit 0 ;;
  esac
  jq -n --arg r "Leading practice: this session wrote a tracked file, and its **Practice:** declaration does not hold up: $fault. Declare one line, in your reply or the close comment: \`**Practice:** ran — <note>\`, \`covered — <note>, <Researched date>\`, \`skipped — <exempt kind>\`, or \`none-fits — nearest <craft>\`. The exempt kinds: $EXEMPT_KINDS. A note is $note_where, current for 6 months from its Researched: date. This refuses once a session. The crafts:
$list" '{decision:"block",reason:$r}'
  exit 0
fi

tool=$(jq -r '.tool_name // empty' <<<"$input")
case "$tool" in
  Read | Write) touched=$(jq -r '.tool_input.file_path // empty' <<<"$input") ;;
  Glob) touched=$(jq -r '"\(.tool_input.path // "")/\(.tool_input.pattern // "")"' <<<"$input") ;;
  Bash) touched=$(jq -r '.tool_input.command // empty' <<<"$input") ;;
  *) exit 0 ;;
esac
# docs/practice as a whole path segment pair, so docs/practice-x and mydocs/practice miss.
[[ $touched =~ (^|[^[:alnum:]_.-])docs/practice($|[^[:alnum:]_.-]) ]] || exit 0

# The work tree whose root holds <dir>/docs/practice, judged from the nearest
# directory that exists, as a new note's directory may not.
is_tree_root() {
  local at="$1/docs/practice" top
  while [[ ! -d "$at" ]]; do at=$(dirname "$at"); done
  top=$(git -C "$at" rev-parse --show-toplevel 2>/dev/null) || return 1
  [[ -d "$1" ]] && [[ "$(cd "$1" && pwd -P)" = "$top" ]]
}

# The first touch hands the list over; an id latching nothing hands it over on
# every touch.
first_touch() {
  latch touch-
  [[ $? -ne 1 ]]
}

# A nested path names no craft, so it is held to the list as a whole.
if [[ "$tool" = Write ]] && [[ $touched =~ ^(.*)/docs/practice/(.+)\.md$ ]]; then
  root=${BASH_REMATCH[1]} slug=${BASH_REMATCH[2]}
  if ! on_list "$slug" && is_tree_root "$root"; then
    first_touch
    jq -n --arg r "docs/practice/$slug.md is not a practice note: \"$slug\" is not a craft on the list in $list_file, and a note is named for its craft. Pick the task's craft from the list below and write docs/practice/<craft>.md. Where no craft fits, research into a sub-section of the nearest craft's note and file a workflow-core ticket proposing the craft. The crafts:
$list

$RANKING" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
    exit 0
  fi
fi

first_touch || exit 0
jq -n --arg c "The practice craft list, $list_file. A practice note is $note_where, named for one of these crafts:
$list

$RANKING" '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$c}}'
exit 0
