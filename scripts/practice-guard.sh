#!/usr/bin/env bash
set -uo pipefail
shopt -s extglob

input=$(cat)
event=${1:-}
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

on_list() {
  local line
  while IFS= read -r line; do
    [[ $line == "- $1: "* ]] && return 0
  done <<<"$list"
  return 1
}

# #2601
latch() {
  local key dir
  key=$(jq -r '[.session_id // "", .agent_id // empty] | join("-")' <<<"$input")
  if ! [[ $key =~ ^[A-Za-z0-9_-]+$ ]]; then
    echo "practice-guard: the session id \"$key\" is no plain name, so nothing latches" >&2
    return 2
  fi
  dir="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/practice-guard-$(id -u)"
  mkdir -m 700 "$dir" 2>/dev/null
  if ! { [[ -d "$dir" ]] && [[ ! -L "$dir" ]] && [[ -O "$dir" ]]; }; then
    echo "practice-guard: $dir is no latch directory of this user's, so nothing latches" >&2
    return 2
  fi
  (set -C && : >"$dir/$1$key") 2>/dev/null && return 0
  [[ -e "$dir/$1$key" ]] && return 1
  echo "practice-guard: cannot create the latch $dir/$1$key, so nothing latches" >&2
  return 2
}

readonly EXEMPT_KINDS="a typo or wording fix, a re-anchor or regeneration, a concision cut, propagating an already-settled fact, a revert, a version bump, a reply that only answers a question"

# #2806, #3077
readonly PREPOSITIONS='of|in|on|to|for|from|over|after|before|since|across|at|by|into|under|via|per|during|through|between|within'
# #3077, #3491
readonly JOINS='and|but|or|nor|yet|so|plus|with|then|also|as well as'
# #3491
readonly ASCII_ALNUM=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789
# #3594
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
# #3491, #3594, #3603
readonly ODD_SPACES=($'\xc2\xa0' $'\xe1\x9a\x80' $'\xe2\x81\x9f' $'\xe3\x80\x80' $'\xe2\x80\xaf' $'\xe2\x80\x80' $'\xe2\x80\x81' $'\xe2\x80\x82' $'\xe2\x80\x83' $'\xe2\x80\x84'
  $'\xe2\x80\x85' $'\xe2\x80\x86' $'\xe2\x80\x87' $'\xe2\x80\x88' $'\xe2\x80\x89' $'\xe2\x80\x8a')
readonly ZERO_WIDTH=$'\xe2\x80\x8b'
readonly ARTICLE='((a|an|the) )?'

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

second_clause() { echo "adds a second clause to the exempt kind \"$1\""; }

has_joins_word() { [[ " ${1//[$TAIL_GLUE]/ } " =~ \ ($JOINS)\  ]]; }

# #2806, #3077, #3491, #3594
tail_fault() {
  local words off
  [[ -z $1 ]] && return
  if [[ $1 =~ ^\ \(\ *(.*)$ ]]; then
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

skipped_fault() {
  local named phrase tail end spaced reason i
  named=${1//"$ZERO_WIDTH"/} named=${named//+([[:space:]])/ }
  shopt -s nocasematch
  [[ $named =~ $EXEMPT_PATTERN ]] && phrase=${BASH_REMATCH[3]} tail=${BASH_REMATCH[-1]}
  if [[ -n "${phrase:-}" ]]; then
    reason=$(tail_fault "$tail" "$phrase")
    for ((i = ${#1}; i >= 0; i--)); do
      end=${1:i} end=${end//"$ZERO_WIDTH"/} end=${end//+([[:space:]])/ }
      [[ "$end" = "$tail" ]] && spaced=${1:i} && break
    done
    if [[ -z $reason && ${spaced:-} == *"$ZERO_WIDTH"* ]]; then
      spaced=${spaced//"$ZERO_WIDTH"/ } spaced=${spaced//+([[:space:]])/ }
      # #3611
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

readonly FIRST_GUARD_RELEASE=v3.0.0
readonly TODAY=${PRACTICE_GUARD_TODAY:-$(date +%F)}

# #3077
readonly MARKER='[[:space:]>*-]*\*\*Practice:\*\*'
readonly BODY_FLAGS='--body|--comment|-b|-c'
readonly BODY_FILE_FLAGS='--body-file|--comment-file|-F'

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

# #5410
plugin_guard_pinned_at() {
  local file merged='{"plugins":{},"markets":{}}' layer
  for file in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json" "$1/.claude/settings.json" "$1/.claude/settings.local.json"; do
    [[ -e "$file" ]] || continue
    if ! layer=$(jq -cs 'def field($k): if (.[$k] | type) == "object" then .[$k] else {} end;
      if length == 1 and (.[0] | type) == "object" then .[0] else {} end
      | {plugins: field("enabledPlugins"), markets: field("extraKnownMarketplaces")}' "$file" 2>/dev/null); then
      echo "practice-guard: $file is unreadable or not JSON, so it enables no plugin and pins no marketplace" >&2
      continue
    fi
    merged=$(jq -c --argjson l "$layer" '{plugins: (.plugins + $l.plugins), markets: (.markets + $l.markets)}' <<<"$merged")
  done
  jq -e --arg first "$FIRST_GUARD_RELEASE" '
    def release: capture("^v?(?<x>0|[1-9][0-9]*)\\.(?<y>0|[1-9][0-9]*)\\.(?<z>0|[1-9][0-9]*)$") | [.x, .y, .z | tonumber];
    ($first | release) as $floor | .markets as $markets
    | any(.plugins | to_entries[]; (.key | startswith("workflow-core@")) and .value == true
        and ([$markets[.key | ltrimstr("workflow-core@")] | objects | .source | objects | select(has("sha") | not) | .ref | strings | release] | any(. >= $floor)))' <<<"$merged" >/dev/null 2>&1
}

if [[ "$event" = stop ]]; then
  EXEMPT_PATTERN=$(exempt_pattern)
  readonly EXEMPT_PATTERN
  transcript=$(jq -r '.transcript_path // empty' <<<"$input")
  if [[ ! -r "$transcript" ]]; then
    echo "practice-guard: no readable transcript, so nothing is judged" >&2
    exit 0
  fi
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

  [[ -z $plugin_root ]] && plugin_guard_pinned_at "${CLAUDE_PROJECT_DIR:-${cwd_top:-$cwd}}" && exit 0

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
[[ $touched =~ (^|[^[:alnum:]_.-])docs/practice($|[^[:alnum:]_.-]) ]] || exit 0

is_tree_root() {
  local at="$1/docs/practice" top
  while [[ ! -d "$at" ]]; do at=$(dirname "$at"); done
  top=$(git -C "$at" rev-parse --show-toplevel 2>/dev/null) || return 1
  [[ -d "$1" ]] && [[ "$(cd "$1" && pwd -P)" = "$top" ]]
}

first_touch() {
  latch touch-
  [[ $? -ne 1 ]]
}

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
