#!/usr/bin/env bash
# lib/gh-body.sh — gb_body, gb_body_file: the text a `gh` call's --body or --body-file word
# hands gh, read off the command and, for a file, off disk.
#
# The one reader for guard-issue-create-label.sh, guard-tracker-rules.sh and
# record-acts.sh, so they never disagree about which spellings are readable.
#
# Sourced, never run, after lib/guard-parse.sh, whose gp_literal, gp_subject
# and gp_cwd it calls; inside gp_walk_commands, for gp_cwd.
#
# THE CALLER SETS, before the first call:
#   GB_SUBCMD  the subcommand as an ERE fragment after `gh`, e.g.
#              'issue[[:space:]]+create'
#   GB_WHAT    the call as a fault message names it, e.g. 'gh issue create'
# and declares, as locals of its own judge, the answers these write:
#   body         the text read, appended to
#   body_given   1 once any body word is seen
#   body_hidden  1 where the text cannot be recovered
#   body_missing a --body-file path absent at hook time
#   body_fault   why a body file could not be read

# One --body word. Appends its text to $body; sets $body_hidden where the text
# cannot be recovered, which is a fail-open rather than a verdict.
gb_body() {
  local text
  body_given=1
  text="$(gp_literal "$1")" || {
    body_hidden=1
    return 0
  }
  body+="$text"
}

# One --body-file word. The path is read off the command and the FILE off disk.
gb_body_file() {
  local at sub tilde=0
  # shellcheck disable=SC2034 # the caller's answer, read after this returns.
  body_given=1
  at="$(gp_literal "$1")" || {
    body_hidden=1
    return 0
  }
  if [[ "$at" == "-" ]]; then
    gb_stdin_heredoc
    ((body_hidden)) && gb_stdin_cat
    return 0
  fi
  # A quoted span is masked on the raw word, so a leading `~` there is unquoted
  # and the shell expands it.
  [[ "$1" == \~* ]] && tilde=1
  sub="$(gp_subject)"
  [[ "$sub" =~ gh[[:space:]]+$GB_SUBCMD ]] &&
    sub="${sub%%"${BASH_REMATCH[0]}"*}"
  gb_disk_body "$at" "$sub" "$tilde"
}

# A body file read off disk: $1 the path, $2 the command text before the read,
# $3 1 where a leading `~` expands. One absent at hook time sets $body_missing:
# gh files a blank issue from it at exit 0 (mantahostels#3443).
#
# UNLESS THE COMMAND WRITES IT FIRST — `cat > f <<'X'`, `tee f`, `> f`, a script
# given the path. That is read as the file's NAME appearing in the text before
# the read, deliberately loose: every miss fails open. On that exemption the
# bytes on disk are not what gh will read, so the body is hidden.
gb_disk_body() {
  local at="$1" file text
  [[ "$2" == *"${at##*/}"* ]] && {
    body_hidden=1
    return 0
  }
  body_hidden=1
  # A fault here is held, not failed open at once, so a caller may still judge
  # the call on its unread body (#668); the caller logs it otherwise.
  file="$(gb_resolve_path "$at" "$3")" || {
    body_fault="could not tell which directory a $GB_WHAT body file resolves in"
    return 0
  }
  [[ -e "$file" ]] || {
    # shellcheck disable=SC2034 # the caller's answer, read after this returns.
    body_missing="$at"
    return 0
  }
  text="$(cat -- "$file" 2>/dev/null)" || {
    # shellcheck disable=SC2034 # the caller's answer, read after this returns.
    body_fault="could not read the body file of a $GB_WHAT"
    return 0
  }
  body_hidden=0
  body+="$text"
}

# A body path, made absolute against the directory the call runs in. Non-zero
# where that directory is unknown. $2 is 1 where a leading `~` expands.
gb_resolve_path() {
  if [[ "$2" == 1 ]]; then
    case "$1" in
      '~') printf '%s' "$HOME" && return 0 ;;
      \~/*) printf '%s' "$HOME/${1#\~/}" && return 0 ;;
      '~'*) return 1 ;;
    esac
  fi
  case "$1" in
    /*) printf '%s' "$1" ;;
    *)
      local cwd
      cwd="$(gp_cwd)"
      [[ -n "$cwd" ]] || return 1
      printf '%s/%s' "$cwd" "$1"
      ;;
  esac
}

# `cat <path> | gh <subcommand> … --body-file -` (mantahostels#3443). Read only where the subject holds exactly one line running the
# subcommand, and that line pipes a `cat` of one plain path straight into it;
# the path is then judged as a --body-file path is.
gb_stdin_cat() {
  local -a lines
  local line hit="" read="" calls=0 at tilde=0
  local call="gh[[:space:]]+$GB_SUBCMD"
  local plain='[^-[:space:]'\''"$`\\|;&<>()][^[:space:]'\''"$`\\|;&<>()]*'
  local word="('[^']+'|\"[^\"\$\`\\\\]+\"|$plain)"
  local piped="(^|[;&|(])[[:space:]]*cat[[:space:]]+(--[[:space:]]+)?${word}[[:space:]]*\|[[:space:]]*$call"

  mapfile -t lines < <(gp_subject)
  for line in ${lines+"${lines[@]}"}; do
    [[ "$line" =~ $call ]] || continue
    ((calls++))
    [[ "$line" =~ $piped ]] && hit="${BASH_REMATCH[3]}" read="${BASH_REMATCH[0]}"
  done
  ((calls == 1)) && [[ -n "$hit" ]] || return 0
  [[ "$hit" == \~* ]] && tilde=1
  at="${hit#[\'\"]}"
  at="${at%[\'\"]}"
  local sub
  sub="$(gp_subject)"
  gb_disk_body "$at" "${sub%%"$read"*}" "$tilde"
}

# `--body-file -`: stdin, which a hook cannot see — except where stdin is a
# heredoc, whose text sits on the command string itself. That is the form
# docs/agents/triage-labels.md mandates for every create (mantahostels#3439).
#
# Read only where the association is certain: the subject holds exactly ONE
# line running the subcommand, outside any heredoc body, and that line carries
# exactly one `<<`, either `cat <<'X' | gh <subcommand> …` or `gh <subcommand> …
# <<'X'`. Anything else — two such calls, `grep <<X |`, a separator or `<` between
# the heredoc and gh, `<<-`, a `\`-continued call line, mismatched delimiter
# quotes, an unterminated body — sets $body_hidden. An unquoted delimiter
# expands its body, so a body holding `$`, a backtick or a backslash is hidden
# there too.
#
# It rescans the raw subject rather than reusing lib/guard-parse.sh's heredoc
# pass, which discards each body rather than keeping it. The one way
# the two disagree — a quoted `<<` on an earlier line, which this reads as an
# opener — swallows the call and fails open.
gb_stdin_heredoc() {
  local -a lines
  local line term="" quoted="" collecting=0 calls=0 text="" pairs
  local delim='[[:space:]]*(['\''"]?)([A-Za-z_][A-Za-z0-9_]*)['\''"]?'
  local call="gh[[:space:]]+$GB_SUBCMD"
  local piped="(^|[;&|(])[[:space:]]*cat[[:space:]]+<<${delim}[^<|;&]*\|[[:space:]]*$call"
  local attached="${call}[^<|;&]*<<$delim"
  # `(^|[^<])` keeps a `<<<` herestring from reading as an opener.
  local opener="(^|[^<])<<-?$delim"

  body_hidden=1
  mapfile -t lines < <(gp_subject)
  for line in ${lines+"${lines[@]}"}; do
    if [[ -n "$term" ]]; then
      if [[ "$line" == "$term" || "$line" == "$term;" ]]; then
        ((collecting)) && collecting=2
        term=""
      elif ((collecting == 1)); then
        text+="$line"$'\n'
      fi
      continue
    fi
    [[ "$line" =~ $call ]] || {
      [[ "$line" =~ $opener ]] && term="${BASH_REMATCH[3]}"
      continue
    }
    ((calls++))
    # Count `<<` by swapping each for one byte no command line carries; \x02
    # stays clear of lib/guard-parse.sh's \x01 sentinel.
    pairs="${line//<</$'\x02'}"
    pairs="${pairs//[^$'\x02']/}"
    ((${#pairs} == 1)) || return 0
    # shellcheck disable=SC1003 # '\' is a literal backslash.
    [[ "$line" != *'<<-'* && "$line" != *'\' ]] || return 0
    if [[ "$line" =~ $piped ]]; then
      quoted="${BASH_REMATCH[2]}" term="${BASH_REMATCH[3]}"
    elif [[ "$line" =~ $attached ]]; then
      quoted="${BASH_REMATCH[1]}" term="${BASH_REMATCH[2]}"
    else
      return 0
    fi
    [[ "$line" == *"$quoted$term$quoted"* ]] || return 0
    collecting=1
  done
  ((calls == 1 && collecting == 2)) || return 0
  [[ -z "$quoted" && "$text" == *[\$\`\\]* ]] && return 0
  body_hidden=0
  body+="$text"
}
