# shellcheck shell=sh
hr_mine=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || hr_mine=""
hr_theirs=""
if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
  hr_theirs=$(env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE \
    git -C "$CLAUDE_PROJECT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || hr_theirs=""
fi
if [ -z "$hr_theirs" ] || [ "$hr_theirs" != "$hr_mine" ]; then
  if hr_top=$(git rev-parse --show-toplevel 2>/dev/null); then
    if [ "$(git rev-parse --absolute-git-dir 2>/dev/null)" != "$hr_mine" ]; then
      case "$hr_mine" in */.git) hr_top=${hr_mine%/.git} ;; esac
    fi
    CLAUDE_PROJECT_DIR=$hr_top
    export CLAUDE_PROJECT_DIR
  else
    unset CLAUDE_PROJECT_DIR
  fi
fi
unset hr_top hr_mine hr_theirs
