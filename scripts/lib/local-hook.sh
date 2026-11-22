# shellcheck shell=sh
wfc_local_hook_refuse_missing() {
  lh_missing="$(sed -e '/^[[:space:]]*#/d' -e 's/[[:space:]]#.*//' "$1" |
    tr -s ' \t;|&<>' '\n' |
    grep -v 'WFC_PLUGIN_ROOT' |
    sed -nE 's#^([^/]*[^/A-Za-z0-9_.-]|[^/]*(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?"?|[)"]+|\.)/)?((\.claude|scripts)/[A-Za-z0-9_./-]*).*$#\3#p' |
    grep -E '\.(c?js|mjs|sh|py)$' |
    sort -u |
    while IFS= read -r lh_path; do
      [ -e "$lh_path" ] || printf '%s\n' "$lh_path"
    done)"
  [ -z "$lh_missing" ] && return 0
  echo "$2" >&2
  printf '%s\n' "$lh_missing" | sed 's/^/  /' >&2
  echo "  Every commit is refused until it exists or the local file stops naming it (#437)." >&2
  exit 1
}
