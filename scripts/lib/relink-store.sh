# shellcheck shell=sh
# relink-store.sh — re-points a session worktree's node_modules at the
# dependency store for the lockfile a merge, pull or checkout just gave it
# (#4702), through `session-checkout.js relink`, which says what it did or
# names the attach command where no store stands yet.
#
# SOURCED, NEVER RUN, by .husky/post-merge, post-checkout and post-commit, and
# POSIX sh. `wfc_relink_store <toplevel>` returns 0 whatever relink says: git
# ignores each of the three hooks' exits. A tree whose node_modules is no
# symlink, the main checkout's or the lander's, starts no node.
#
# GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE are unset for relink: git exports
# them to a hook, and they would answer for its own reads.
wfc_relink_store() {
  [ -L "$1/node_modules" ] || return 0
  rs_script="${WFC_PLUGIN_ROOT:-$1}/scripts/session-checkout.js"
  [ -f "$rs_script" ] && command -v node >/dev/null 2>&1 || return 0
  (
    unset GIT_INDEX_FILE GIT_DIR GIT_WORK_TREE
    cd "$1" && node "$rs_script" relink
  ) || :
}
