# shellcheck shell=sh
wfc_relink_store() {
  [ -L "$1/node_modules" ] || return 0
  rs_script="${WFC_PLUGIN_ROOT:-$1}/scripts/session-checkout.js"
  [ -f "$rs_script" ] && command -v node >/dev/null 2>&1 || return 0
  (
    unset GIT_INDEX_FILE GIT_DIR GIT_WORK_TREE
    cd "$1" && node "$rs_script" relink
  ) || :
}
