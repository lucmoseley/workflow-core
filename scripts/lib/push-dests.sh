# shellcheck shell=bash
# push-dests.sh — where a `git push` sends each ref, read once for every hook
# that judges or follows a push (#2405).
#
# SOURCED, never run, after lib/guard-parse.sh, whose gp_scan_flags and
# gp_literal it calls.
#
# Each refspec's destination is resolved against the pushing tree: `src:dst`
# takes `dst` (in `refs/tags/` where `src` is a tag, else `refs/heads/`); a
# bare `src` takes `git rev-parse --symbolic-full-name`, so `HEAD` is the
# current branch and `v1.2.3` is a tag only where that tag exists locally. A bare `git push` or `git push <remote>`
# is read as the tree's current branch, as push.default=simple would push it;
# a `remote.<name>.push` refspec or push.default=matching pushes something
# else, unseen.

# 0 where <word> is git's abbreviation of <long option>: at least <n> letters
# of it.
pd_abbrev_of() {
  local word="$1" long="$2" n="$3"
  ((${#word} >= n)) && [[ "$long" == "$word"* ]]
}

# The full ref a bare push source names in <tree>, or refs/heads/<src> where
# git cannot name one, a push git refuses.
pd_full_src() {
  local tree="$1" src="$2" full
  case "$src" in refs/*)
    printf '%s' "$src"
    return
    ;;
  esac
  full="$(git -C "$tree" rev-parse --symbolic-full-name "$src" 2>/dev/null)"
  if [[ "$full" == refs/* ]]; then
    printf '%s' "$full"
  elif [[ "$full" == HEAD ]]; then
    printf 'HEAD' # detached: git refuses a bare HEAD push with no destination
  else
    printf 'refs/heads/%s' "$src"
  fi
}

# `git push`'s value-taking flags, from `git push -h` on git 2.43.0.
PD_PUSH_VALUE_FLAGS="-o --push-option --repo --receive-pack --exec"

_pd_positional=()
_pd_force=0
_pd_lease=0
_pd_tags=0
_pd_arg() {
  local kind="$1" name="$2"
  case "$kind" in
    arg) _pd_positional+=("$3") ;;
    flag)
      case "$name" in
        --all | --branches | --mirror) pd_all=1 ;;
        -d) pd_delete=1 ;;
        --tags) _pd_tags=1 ;;
        -h | --help | -n | --dry-run) pd_inert=1 ;;
        -f | --force) _pd_force=1 ;;
        *)
          pd_abbrev_of "$name" --delete 4 && pd_delete=1
          pd_abbrev_of "$name" --force-with-lease 9 && _pd_lease=1
          pd_abbrev_of "$name" --no-force-with-lease 12 && _pd_lease=0
          ;;
      esac
      ;;
    opt) pd_abbrev_of "$name" --force-with-lease 9 && _pd_lease=1 ;;
  esac
  return 0
}

# _pd_row <kind> <ref> <forced> <bare>
_pd_row() {
  pd_kind+=("$1")
  pd_ref+=("$2")
  pd_forced+=("$3")
  pd_bare+=("$4")
}

# pd_read <tree> <words after `push`>… — fills, never in a command
# substitution (gp_literal's spans would be lost):
#   pd_inert   1 on --help or --dry-run, which push nothing
#   pd_all     1 on --all, --branches or --mirror
#   pd_delete  1 on -d or --delete, every row then a deletion
#   one row per destination, in four parallel arrays:
#     pd_kind    push | delete | unread-push | unread-delete — unread being a
#                refspec gp_literal cannot read (`git push origin "$B"`)
#     pd_ref     push: the full destination ref; delete: the word as written
#     pd_forced  1 where `-f`, `--force`, `--force-with-lease` or a `+`
#                refspec forces it
#     pd_bare    1 where no refspec was given and the row is the current branch
# A detached HEAD's bare push, which git refuses, and `tag <name>` give no row;
# so does `--tags` with no refspec.
pd_read() {
  local tree="$1" spec src dst full plus forced i=0
  shift
  # shellcheck disable=SC2034  # the caller's to read
  pd_inert=0 pd_all=0 pd_delete=0
  pd_kind=() pd_ref=() pd_forced=() pd_bare=()
  _pd_positional=() _pd_force=0 _pd_lease=0 _pd_tags=0
  gp_scan_flags "$PD_PUSH_VALUE_FLAGS" _pd_arg -- "$@"
  forced=$((_pd_force || _pd_lease))

  local -a specs=("${_pd_positional[@]:1}")
  if ((pd_delete)); then
    for spec in ${specs+"${specs[@]}"}; do
      if spec="$(gp_literal "$spec")"; then
        _pd_row delete "$spec" 0 0
      else
        _pd_row unread-delete "" 0 0
      fi
    done
    return 0
  fi

  if ((${#specs[@]} == 0)); then
    ((_pd_tags)) && return 0
    full="$(pd_full_src "$tree" HEAD)"
    [[ "$full" == HEAD ]] || _pd_row push "$full" "$forced" 1
    return 0
  fi

  while ((i < ${#specs[@]})); do
    spec="$(gp_literal "${specs[i]}")" || {
      _pd_row unread-push "" 0 0
      ((i++))
      continue
    }
    # `tag <name>` is git's spelling of refs/tags/<name>:refs/tags/<name>.
    if [[ "$spec" == tag ]] && ((i + 1 < ${#specs[@]})); then
      ((i += 2))
      continue
    fi
    ((i++))
    plus=0
    [[ "$spec" == +* ]] && plus=1
    spec="${spec#+}"
    if [[ "$spec" == *:* ]]; then
      src="${spec%%:*}"
      dst="${spec#*:}"
      if [[ -z "$src" ]]; then
        _pd_row delete "$dst" 0 0
        continue
      fi
      [[ "$dst" == heads/* ]] && dst="refs/$dst"
      if [[ "$dst" != refs/* ]]; then
        if [[ "$(pd_full_src "$tree" "$src")" == refs/tags/* ]]; then
          dst="refs/tags/$dst"
        else
          dst="refs/heads/$dst"
        fi
      fi
      full="$dst"
    else
      full="$(pd_full_src "$tree" "$spec")"
      [[ "$full" == HEAD ]] && continue
    fi
    _pd_row push "$full" $((forced || plus)) 0
  done
  return 0
}
