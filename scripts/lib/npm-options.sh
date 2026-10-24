# shellcheck shell=bash
# npm-options.sh — the one copy of npm's option parser, `npm_canon`, read
# against npm 11.16.0's config list (workflow-core#563, workflow-core#571), and of the exact-match
# lookups npx makes instead, `_npm_bool_exact` and `_npm_shorthand_exact`
# (workflow-core#1972).
#
# SOURCED, never run. Two callers (workflow-core#1778):
#
#   scripts/guard-npm-install.sh        the install it judges, and npx's argv
#                                       once _npx_preparse has rewritten it
#   scripts/guard-suite-concurrency.sh  whether `npm … run <name>` launches a
#                                       build or a dev server
#
# A config a later npm adds is read as a name npm does not know.

# Every npm config that takes the next word as its value. One left out has its
# value read as a package spec, and the deny names it (workflow-core#544). Derived from npm
# 11.16.0's `@npmcli/config` definitions — each config whose type lacks
# Boolean, plus `--browser`, which also takes a String — and the `--no-` form
# of each whose type is a list holding String, which npm still hands a word.
NPM_VALUE_FLAGS="
--_auth --access --allow-directory
--allow-file --allow-git --allow-remote --allow-scripts --also --audit-level
--auth-type --before --browser --ca --cache --cache-max --cache-min --cafile
--call --cert --cidr --cpu --depth --diff --diff-dst-prefix --diff-src-prefix
--diff-unified --editor --expect-result-count --expires --fetch-retries
--fetch-retry-factor --fetch-retry-maxtimeout --fetch-retry-mintimeout
--fetch-timeout --git --globalconfig --heading --https-proxy --include
--init-author-email --init-author-name --init-author-url --init-license
--init-module --init-type --init-version --init.author.email
--init.author.name --init.author.url --init.license --init.module
--init.version --install-strategy --key --libc --local-address --location
--lockfile-version --loglevel --logs-dir --logs-max --maxsockets --message
--min-release-age --name --node-gyp --node-options --noproxy --omit --only
--orgs --orgs-permission --os --otp --pack-destination --package --packages
--packages-and-scopes-permission --password --prefix --preid --provenance-file
--proxy --registry --replace-registry-host --save-prefix --sbom-format
--sbom-type --scope --scopes --script-shell --searchexclude --searchlimit
--searchopts --searchstaleness --shell --tag --tag-version-prefix
--token-description --umask --user-agent --userconfig --viewer --which
--workspace --no-_auth --no-allow-scripts --no-browser --no-ca --no-cert
--no-cidr --no-cpu --no-diff --no-key --no-libc --no-name --no-node-options
--no-noproxy --no-orgs --no-os --no-otp --no-package --no-packages
--no-password --no-replace-registry-host --no-scopes --no-script-shell
--no-token-description --no-workspace
"
NPM_VALUE_FLAGS="${NPM_VALUE_FLAGS//$'\n'/ }"

# npm 11.16.0's Boolean configs, which npm_arg alone reads.
NPM_BOOL_FLAGS="
--all --allow-same-version --allow-scripts-pending --allow-scripts-pin --audit
--bin-links --bypass-2fa --color --commit-hooks
--dangerously-allow-all-scripts --description --dev --diff-ignore-all-space
--diff-name-only --diff-no-prefix --diff-text --dry-run --engine-strict
--expect-results --force --foreground-scripts --format-package-lock --fund
--git-tag-version --global --global-style --if-present --ignore-scripts
--include-attestations --include-staged --include-workspace-root
--init-private --install-links --json --legacy-bundling --legacy-peer-deps
--link --long --offline --omit-lockfile-registry-resolved --optional
--package-lock --package-lock-only --packages-all --parseable --prefer-dedupe
--prefer-offline --prefer-online --production --progress --provenance
--read-only --rebuild-bundle --save --save-bundle --save-dev --save-exact
--save-optional --save-peer --save-prod --shrinkwrap --sign-git-commit
--sign-git-tag --strict-allow-scripts --strict-peer-deps --strict-ssl --timing
--unicode --update-notifier --usage --version --versions --workspaces
--workspaces-update --yes
"
NPM_BOOL_FLAGS="${NPM_BOOL_FLAGS//$'\n'/ }"
# _npm_bool_exact matches <flag> whole, as npx does; _npm_is_bool reads a
# `--no-` form as its config, as npm does.
_npm_bool_exact() { [[ -n "$1" && " $NPM_BOOL_FLAGS " == *" $1 "* ]]; }
_npm_is_bool() { _npm_bool_exact "${1/#--no-/--}"; }

# Every config name, which an abbreviation resolves against.
read -ra NPM_CONFIG_LIST <<<"$NPM_VALUE_FLAGS $NPM_BOOL_FLAGS"
NPM_CONFIG_LIST=("${NPM_CONFIG_LIST[@]/#--no-*/}")
NPM_CONFIG_LIST=("${NPM_CONFIG_LIST[@]#--}")
read -ra NPM_CONFIG_LIST <<<"${NPM_CONFIG_LIST[*]}"
NPM_CONFIGS=" ${NPM_CONFIG_LIST[*]} "

# npm 11.16.0's String configs, which refuse a next word that looks like an
# option — `--tag --no-ignore-scripts` leaves the flag an option. Every other
# value config takes any word but a bare `--`, except `--browser` and the
# `--no-` forms, which take `--` too but never a single-dash word.
NPM_STRING_FLAGS="
--call --diff-dst-prefix --diff-src-prefix --editor --git --heading
--init-author-email --init-author-name --init-license --init-type
--init.author.email --init.author.name --init.license --message
--pack-destination --preid --save-prefix --scope --searchexclude --searchopts
--shell --tag --tag-version-prefix --user-agent --viewer
"

# npm 11.16.0's configs whose list type takes `null` but no String, which npm
# reads as their value after `--no-<config>` and, for the Boolean ones, after
# `--<config>` too. Those taking a String as well are NPM_VALUE_FLAGS' `--no-`
# forms, which take any word.
NPM_NULLABLE="
access also audit-level before depth expect-result-count expect-results
expires https-proxy local-address lockfile-version logs-dir min-release-age
only optional orgs-permission packages-and-scopes-permission production proxy
which workspaces yes
"

# npm 11.16.0's configs whose list type takes a Number, read the same way.
NPM_NUMERIC="depth expect-result-count expires min-release-age which"

# npm 11.16.0's literal list-type values, as <config>:<value>, read the same
# way. `local-address` lists this machine's interfaces and is left out.
NPM_LITERALS="
access:restricted access:public access:private allow-directory:all
allow-directory:none allow-directory:root allow-file:all allow-file:none
allow-file:root allow-git:all allow-git:none allow-git:root allow-remote:all
allow-remote:none allow-remote:root also:dev also:development audit-level:info
audit-level:low audit-level:moderate audit-level:high audit-level:critical
audit-level:none auth-type:legacy auth-type:web color:always include:prod
include:dev include:optional include:peer install-strategy:hoisted
install-strategy:nested install-strategy:shallow install-strategy:linked
location:global location:user location:project lockfile-version:1
lockfile-version:2 lockfile-version:3 loglevel:silent loglevel:error
loglevel:warn loglevel:notice loglevel:http loglevel:info loglevel:verbose
loglevel:silly omit:dev omit:optional omit:peer only:prod only:production
replace-registry-host:npmjs replace-registry-host:never
replace-registry-host:always sbom-format:cyclonedx sbom-format:spdx
sbom-type:library sbom-type:application sbom-type:framework
packages-and-scopes-permission:read-only packages-and-scopes-permission:read-write
packages-and-scopes-permission:no-access orgs-permission:read-only
orgs-permission:read-write orgs-permission:no-access
"

# npm 11.16.0's CLI shorthands and what each expands to (`@npmcli/config`'s
# definitions). A one-letter key may also be glued into a run, as `-DE`.
declare -A NPM_SHORTHANDS=(
  ["enjoy-by"]="--before" [d]="--loglevel info" [dd]="--loglevel verbose"
  [ddd]="--loglevel silly" [quiet]="--loglevel warn" [q]="--loglevel warn"
  [s]="--loglevel silent" [silent]="--loglevel silent"
  [verbose]="--loglevel verbose" [desc]="--description" [help]="--usage"
  [local]="--no-global" [n]="--no-yes" [no]="--no-yes"
  [porcelain]="--parseable" [readonly]="--read-only" [reg]="--registry"
  [iwr]="--include-workspace-root" [ws]="--workspaces" [a]="--all"
  [c]="--call" [f]="--force" [g]="--global" [L]="--location" [l]="--long"
  [m]="--message" [p]="--parseable" [C]="--prefix" [S]="--save"
  [B]="--save-bundle" [D]="--save-dev" [E]="--save-exact"
  [O]="--save-optional" [P]="--save-prod" ["?"]="--usage" [H]="--usage"
  [h]="--usage" [v]="--version" [w]="--workspace" [y]="--yes"
)

# The one word in <candidates> that <key> names, into $_npm_hit: itself where
# it is one, else the only candidate it prefixes — npm's `abbrev`.
_npm_unique_prefix() {
  local key="$1" c
  shift
  _npm_hit=""
  [[ -n "$key" ]] || return 1
  for c in "$@"; do
    [[ "$c" == "$key" ]] && {
      _npm_hit="$c"
      return 0
    }
  done
  for c in "$@"; do
    [[ "$c" == "$key"* ]] || continue
    [[ -z "$_npm_hit" ]] || {
      _npm_hit=""
      return 1
    }
    _npm_hit="$c"
  done
  [[ -n "$_npm_hit" ]]
}

# What a dash-stripped <key> expands to where it is itself a shorthand, into
# $_npm_exp — the only lookup npx makes.
_npm_shorthand_exact() {
  [[ -n "$1" && "$1" != *[!A-Za-z0-9?.-]* && -n "${NPM_SHORTHANDS[$1]+x}" ]] || return 1
  _npm_exp="${NPM_SHORTHANDS[$1]}"
}

# What a dash-stripped option <key> expands to where npm reads it as a
# shorthand, into $_npm_exp — nopt's resolveShort, in its order. An exact config
# name, and an abbreviation of one, are never shorthands.
_npm_shorthand() {
  local key="$1" i
  [[ -n "$key" && " $NPM_CONFIGS " == *" $key "* ]] && return 1
  _npm_shorthand_exact "$key" && return 0
  _npm_exp=""
  for ((i = 0; i < ${#key}; i++)); do
    [[ "${key:i:1}" == [A-Za-z?] && -n "${NPM_SHORTHANDS[${key:i:1}]+x}" ]] || break
    _npm_exp+=" ${NPM_SHORTHANDS[${key:i:1}]}"
  done
  ((i == ${#key})) && return 0
  _npm_unique_prefix "$key" "${NPM_CONFIG_LIST[@]}" && return 1
  _npm_unique_prefix "$key" "${!NPM_SHORTHANDS[@]}" || return 1
  _npm_exp="${NPM_SHORTHANDS[$_npm_hit]}"
}

# Whether npm takes <next> as the value of <flag>, read as a <kind> option:
# `value` for a config that needs one, `bool` for a Boolean, a `--no-` form or
# a name npm does not know — nopt's look-ahead, in its order.
_npm_takes() {
  local kind="$1" flag="$2" next="$3" base="${2#--}"
  base="${base#no-}"
  if [[ "$kind" == value ]]; then
    [[ "$next" =~ ^--+$ ]] && return 1
    [[ " $NPM_STRING_FLAGS " == *[[:space:]]"$flag"[[:space:]]* ]] || return 0
    [[ ! "$next" =~ ^--?[^-] ]]
    return
  fi
  [[ "$next" == true || "$next" == false ]] && return 0
  [[ "$NPM_LITERALS" == *[[:space:]]"$base:$next"[[:space:]]* ]] && return 0
  [[ "$next" == null && "$NPM_NULLABLE" == *[[:space:]]"$base"[[:space:]]* ]] && return 0
  if [[ " $NPM_NUMERIC " == *" $base "* && ! "$next" =~ ^--+[^-] ]] && _npm_is_number "$next"; then
    return 0
  fi
  # A list type holding String, whose `--no-` form NPM_VALUE_FLAGS names.
  [[ " $NPM_VALUE_FLAGS " == *" --no-$base "* && ! "$next" =~ ^-[^-] ]]
}

# Whether <word> is a number to JavaScript's `isNaN`, which nopt asks.
_npm_is_number() {
  local w="$1"
  w="${w#"${w%%[![:space:]]*}"}"
  w="${w%"${w##*[![:space:]]}"}"
  [[ -z "$w" || "$w" =~ ^[+-]?(Infinity|([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?)$ ||
    "$w" =~ ^0([xX][0-9a-fA-F]+|[bB][01]+|[oO][0-7]+)$ ]]
}

# npm's argv rewritten as nopt reads it, into $canon, so the scan sees only
# full `--<config>` spellings, each value joined to its option by `=`:
# `-cafile ca.pem` and `--cafi ca.pem` are `--cafile=ca.pem`, `-y null` is
# `--yes=null`, `-d` is `--loglevel=info` (workflow-core#563). Words after `--` are untouched.
npm_canon() {
  local w key val flag eq no kind
  local -a exp
  canon=()
  while (($#)); do
    w="$1"
    shift
    if [[ "$w" =~ ^--+$ ]]; then
      canon+=(-- "$@")
      return 0
    fi
    [[ "$w" == -?* ]] || {
      canon+=("$w")
      continue
    }
    eq=0
    [[ "$w" == *=* ]] && {
      eq=1
      val="${w#*=}"
      w="${w%%=*}"
    }
    key="$w"
    while [[ "$key" == -* ]]; do key="${key#-}"; done
    if _npm_shorthand "$key"; then
      read -ra exp <<<"$_npm_exp"
      if ((eq)); then set -- "${exp[@]}" "$val" "$@"; else set -- "${exp[@]}" "$@"; fi
      continue
    fi
    no=0
    while [[ "${key,,}" == no-* ]]; do
      no=$((no + 1))
      key="${key:3}"
    done
    _npm_unique_prefix "$key" "${NPM_CONFIG_LIST[@]}" && key="$_npm_hit"
    # Each `no-` flips a Boolean, and any makes a value config one.
    flag="--$key"
    if ((no % 2)) || { ((no)) && ! _npm_is_bool "$flag"; }; then
      flag="--no-$key"
    fi
    kind=value
    if ((no)) || _npm_is_bool "$flag" || [[ "$flag" == --browser ]] ||
      { ((!eq)) && [[ "$NPM_CONFIGS" != *" $key "* ]]; }; then
      kind=bool
    fi
    # nopt reads an `=` word as the next argument, under the same look-ahead:
    # `--save-dev=pkg` installs `pkg` (workflow-core#559), and `--tag=--x` leaves `--x` an
    # option.
    ((eq)) && set -- "$val" "$@"
    if (($#)) && _npm_takes "$kind" "$flag" "$1"; then
      canon+=("$flag=$1")
      shift
    elif [[ "$kind" == value ]]; then
      canon+=("$flag=")
    else
      canon+=("$flag")
    fi
  done
}
