#!/usr/bin/env bash
# PreToolUse guard: the npm install boundary (mantahostels#1803, ruled at mantahostels#1767).
#
# The gate on a new dependency: three refusals on one hook, all of them denies,
# because a package name on a command line is a structured fact and
# mantahostels#103 puts a structured fact on the deny side.
#
# THREE CHECKS, in the order they run.
#
#   1. THE EXECUTION WINDOW. An install naming a package `package.json` does not
#      already list must carry `--ignore-scripts`. Between `npm install` fetching
#      a tarball and anything reading it, that tarball's `preinstall` runs as the
#      founder. This runs FIRST because it is local and certain: a command that is
#      malformed AND names a hallucinated package is refused before any network
#      call, and the retry then collects the legitimacy verdict below.
#
#      Per-invocation, deliberately. mantahostels#1767 rejected a repo-wide `.npmrc`
#      `ignore-scripts=true`: it would silently disable husky's `prepare`
#      bootstrap on a fresh clone, which is the machinery every gate in this repo
#      hangs off. A plain `npm install` naming no package is untouched for the
#      same reason.
#
#   2. NEW-PACKAGE LEGITIMACY. For each named package absent from
#      `package.json`, three registry facts, keyless (`docs/working-contract.md`
#      §No paid research or data APIs):
#
#        - the name exists            `npm view <pkg> time.created --json`
#        - it is at least MIN_AGE_DAYS old              (the same call)
#        - last month's downloads clear MIN_DOWNLOADS
#                                     `api.npmjs.org/downloads/point/last-month`
#
#   3. BARE `npx`. `npx <name>` where <name> is unscoped and not among
#      `package.json`'s dependencies — check 2's failure with a name that
#      resolves (mantahostels#1538), which is why it rides on this guard rather
#      than its own.
#
# THE THRESHOLDS, and what in them is a judgement.
#
#   MIN_AGE_DAYS=180, MIN_DOWNLOADS=1000 per month.
#
# Neither is a measurement; both are chosen for margin. The mechanism they
# defend against is a squat pre-registered on a hallucinated name (Spracklen et
# al., *We Have a Package for You!*, USENIX Security 2025; figures at
# mantahostels#1767), which is days old and has no organic download history; both
# thresholds bite there. The margin over mantahostels' own dependencies is on
# mantahostels#1803.
#
# THE ESCAPE, and why it is not spellable on the command line.
#
#   WFC_ALLOW_NEW_PACKAGE=1, read from the HOOK's environment only.
#
# mantahostels#1767 required a named escape rather than silence. mantahostels#109 requires that an escape
# a session can spell for itself is not a deny — so a leading
# `WFC_ALLOW_NEW_PACKAGE=1 npm install …` on the command string is NOT read.
# It stands down check 2 alone; nothing stands down check 1 or check 3. The
# ordinary escape is the founder running the install from their own terminal,
# which sees no hook at all.
#
# WHAT THIS DOES NOT COVER — binding, from mantahostels#1767's scope statement.
#
# A legitimate package LATER COMPROMISED. Age and download history are evidence
# about a name's provenance, never about the bytes a given version ships.
# Nothing here is a substitute for a committed lockfile.
#
# Its `if` narrowings, `Bash(*npm *)` and `Bash(*npx *)` (mantahostels#2811),
# reach every command all three checks judge. They are best-effort
# (hooks.md:448), so never the whole of the boundary: the checks below still
# re-read the command themselves.
#
# LIMITS
#  - npm only. `pnpm add`, `yarn add` and `bun add` are not read; the repo uses
#    npm and its lockfile is npm's.
#  - Only a registry spec is vetted. `npm i ./local`, `github:user/repo`, a
#    tarball URL and a `file:` spec cannot be asked of the registry, so they are
#    DENIED as unvettable rather than waved through.
#  - A wrapper hides the install: `xargs npm install`, `env`, `sudo`, a script
#    that installs on the session's behalf. Only a segment's own first word is
#    read.
#  - It guards the Bash tool. A command run outside Claude Code sees no hook.
#  - Check 3 judges the PACKAGE name, not the bin name, so `npx tsc` is denied
#    even though `typescript` is a dependency. That is the intended verdict —
#    the refusal names the dependency whose installed `bin` carries it,
#    `npx -p typescript tsc` (workflow-core#1806). Only direct dependencies are read, and
#    only from `gr_root`'s `node_modules`.
#  - `npm` and `npx` options are read as npm's parser (nopt) reads them —
#    abbreviations, single-dash long forms and shorthands included (workflow-core#563,
#    workflow-core#571) — by lib/npm-options.sh, against npm 11.16.0's config list. A
#    config a later npm adds is read as a name npm does not know. `npx`
#    words are read with their quoted spans put back; `npm` words are not, so
#    `npm i --reg"istry" <url> x` reads the URL as a spec, and refuses it as
#    unvettable.
#  - `npm exec` and `npm x` run a package the way `npx` does and are NOT read;
#    check 3 covers the `npx` spelling alone.
#  - A missing `timeout` makes the registry call fail, which reads as an
#    unreachable registry and so denies, with no record of its own.
#  - A missing `npm` or `curl` DENIES rather than failing open, and records the
#    fault. This is a deliberate departure from mantahostels#103 §6 on mantahostels#1767's wording:
#    "an unreachable registry denies — the escape is a named env var, never
#    silence". Everything upstream of a verdict — the payload, jq, the parser —
#    still fails open in the house style.

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

# shellcheck source=scripts/lib/npm-options.sh
source "$here/lib/npm-options.sh" 2>/dev/null
declare -F npm_canon >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/npm-options.sh did not load — every command allowed unchecked"
  exit 0
}

gp_begin '.tool_input.command' command

MIN_AGE_DAYS=180
MIN_DOWNLOADS=1000

# Injected at their §N7 vars, never by PATH, because the tests feed them
# chosen output per case (workflow-core#2266, workflow-core#2422).
npm_bin="${WFC_NPM:-npm}"
curl_bin="${WFC_CURL:-curl}"

# npm's install aliases, as npm itself accepts them.
NPM_INSTALL_SUBS=" install i in ins inst insta instal add isnt isnta isntal isntall "

# npx rewrites its argv before npm's parser sees it (npm 11.16.0's
# `bin/npx-cli.js`): it matches each option's key exactly, never as an
# abbreviation, and puts a `--` before the first word it reads as positional,
# which ends npm's options there (workflow-core#491). Every other word is then read by nopt, so the
# bin is nopt's first positional (workflow-core#571). Its switches are lib/npm-options.sh's
# Boolean configs plus `browser`, a Boolean that also takes a String.
NPX_SWITCHES=" browser always-spawn ignore-existing shell-auto-fallback no-install quiet q version v help h "
NPX_OPTS=" package p cache userconfig call c shell npm node-arg n "
NPX_REMOVED=" always-spawn ignore-existing shell-auto-fallback npm node-arg n "

# npx's argv as it hands it to npm, into $npx_argv. A removed option is dropped,
# and a removed one taking a value drops its value too.
_npx_preparse() {
  local w key v has_v
  npx_argv=()
  while (($#)); do
    w="$1"
    shift
    [[ "$w" == -- ]] && {
      npx_argv+=(-- "$@")
      return 0
    }
    [[ "$w" == -* ]] || {
      npx_argv+=(-- "$w" "$@")
      return 0
    }
    key="${w#"${w%%[!-]*}"}"
    has_v=0
    [[ "$key" == *=* ]] && {
      has_v=1
      v="${key#*=}"
      key="${key%%=*}"
    }
    case "$key" in
      p) w="--package${w#"${w%%=*}"}" ;;
      shell) w="--script-shell${w#"${w%%=*}"}" ;;
      no-install) w="--yes=false" ;;
      *)
        # npx looks a shorthand up by its whole key, so `-DE` is never split
        # and takes the next word below (workflow-core#1972).
        if _npm_shorthand_exact "$key" && [[ "$NPX_REMOVED" != *" $key "* ]]; then
          local -a exp
          read -ra exp <<<"$_npm_exp"
          if ((has_v)); then set -- "${exp[@]}" "$v" "$@"; else set -- "${exp[@]}" "$@"; fi
          continue
        fi
        ;;
    esac
    if [[ "$NPX_REMOVED" == *" $key "* ]]; then
      [[ "$NPX_OPTS" == *" $key "* ]] && ((!has_v && $#)) && shift
      continue
    fi
    npx_argv+=("$w")
    ((has_v || !$#)) && continue
    # Matched whole, so `--no-audit` takes the next word (workflow-core#1972).
    if [[ "$NPX_SWITCHES" == *" $key "* ]] || _npm_bool_exact "--$key"; then continue; fi
    if [[ "$NPX_OPTS" == *" $key "* || "$1" != -* ]]; then
      npx_argv+=("$1")
      shift
    fi
  done
}

# ---------------------------------------------------------------------------
# package.json — the set of names this repo already depends on.
#
# Unreadable is the one thing here that fails OPEN: every package would read as
# new, and the guard would deny an ordinary reinstall.
# ---------------------------------------------------------------------------
DEPS=""
_load_deps() {
  local pkg
  # gr_root, from lib/guard-root.sh, which lib/guard-parse.sh sources. This was
  # a `_root()` holding its own copy of the same expression, and mantahostels#1905 folded
  # the tier's copies into one so a correction to any of them reaches all.
  pkg="$(gr_root)/package.json"
  [[ -r "$pkg" ]] ||
    gl_open "no readable package.json at $pkg — install allowed unchecked"
  DEPS="$(jq -r '
      [(.dependencies//{}), (.devDependencies//{}),
       (.optionalDependencies//{}), (.peerDependencies//{})]
      | add // {} | keys[]' "$pkg" 2>/dev/null)" ||
    gl_open "package.json did not parse — install allowed unchecked"
  # A package.json with no dependencies at all parses to an empty string, which
  # is a true answer; a jq that printed nothing AND failed took the branch above.
  DEPS=$'\n'"$DEPS"$'\n'
}

_is_dependency() { [[ "$DEPS" == *$'\n'"$1"$'\n'* ]]; }

# _bin_owner <bin> — the direct dependency whose installed package.json `bin`
# names <bin>: an object's keys, or for a string `bin` the package's unscoped
# name. Prints nothing only where every dependency's package.json was read and
# none names it. Where one is missing or will not parse — a worktree, a partial
# install — "none" cannot be said, so it falls back to a dependency
# `@<scope>/<bin>` (workflow-core#1729), and returns 1 where none is one.
_bin_owner() {
  local dep root owner="" whole=1
  local -a manifests=()
  root="$(gr_root)"
  [[ -n "$DEPS" ]] || _load_deps
  while IFS= read -r dep; do
    [[ -n "$dep" ]] || continue
    if [[ -r "$root/node_modules/$dep/package.json" ]]; then
      manifests+=("$root/node_modules/$dep/package.json")
    else
      whole=0
    fi
  done <<<"$DEPS"
  if ((${#manifests[@]})) && ! owner="$(jq -rn --arg bin "$1" '
    first(inputs
      | select(if (.bin | type) == "object" then .bin | has($bin)
               else (.bin | type) == "string" and (.name | split("/") | last) == $bin end)
      | .name) // empty' "${manifests[@]}" 2>/dev/null)"; then
    gl_log "a dependency's package.json in node_modules did not parse — the owner of the $1 bin is unread"
    owner="" whole=0
  fi
  [[ -n "$owner" ]] && printf '%s\n' "$owner" && return 0
  ((whole)) && return 0
  while IFS= read -r dep; do
    [[ "$dep" == @*/"$1" ]] && printf '%s\n' "$dep" && return 0
  done <<<"$DEPS"
  return 1
}

# ---------------------------------------------------------------------------
# Package specs.
# ---------------------------------------------------------------------------

# The npm name inside a spec, or non-zero where the spec is not a registry one.
#
# Handles `pkg`, `pkg@1.2.3`, `pkg@^1`, `@scope/pkg`, `@scope/pkg@next`. Refuses
# a path, a URL, a git spec and an alias (`a@npm:b`), none of which the registry
# can be asked about.
_spec_name() {
  local spec="$1" name rest
  case "$spec" in
    "" | -*) return 1 ;;
    */*)
      # A scope is the only legitimate slash; everything else is a path or a URL.
      [[ "$spec" == @* ]] || return 1
      ;;
  esac
  case "$spec" in
    *:*) return 1 ;; # file:, git:, https:, npm: alias, github: shorthand
    # A leading `.` or `~` is a path. A tilde INSIDE the spec is npm's
    # approximate-version range — `lodash@~4.17.0` — and denying that as a path
    # would refuse an ordinary pinned install (mantahostels#1803's review, H1).
    .* | '~'*) return 1 ;;
  esac
  if [[ "$spec" == @* ]]; then
    # `${rest%@*}` strips a trailing `@<version>` and leaves a scope-only spelling
    # untouched, because a suffix that does not match removes nothing.
    rest="${spec:1}"
    name="@${rest%@*}"
  else
    name="${spec%%@*}"
  fi
  # Uppercase is accepted: npm has refused it for NEW names since 2017, but the
  # legacy ones are still installable — `JSONStream`, `Base64` — and rejecting
  # them here would call a real package a path (mantahostels#1803's review, H3).
  [[ "$name" =~ ^(@[A-Za-z0-9][A-Za-z0-9._-]*/)?[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || return 1
  printf '%s' "$name"
}

# ---------------------------------------------------------------------------
# The registry. Prints one word: ok | missing | unreachable | young:<days> |
# thin:<downloads>. Never exits — the caller decides the verdict.
# ---------------------------------------------------------------------------
_registry_verdict() {
  local pkg="$1" out rc created epoch now days dl

  command -v "$npm_bin" >/dev/null 2>&1 || {
    gl_log "npm not found — legitimacy of $pkg could not be checked, denying"
    printf 'unreachable'
    return 0
  }
  out="$(timeout 12 "$npm_bin" view "$pkg" time.created --json 2>/dev/null)"
  rc=$?
  if ((rc != 0)); then
    case "$out" in
      *E404*) printf 'missing' ;;
      *) printf 'unreachable' ;;
    esac
    return 0
  fi
  created="$(printf '%s' "$out" | jq -r 'if type=="string" then . else empty end' 2>/dev/null)"
  [[ -n "$created" ]] || {
    printf 'unreachable'
    return 0
  }
  epoch="$(date -d "$created" +%s 2>/dev/null)" || {
    printf 'unreachable'
    return 0
  }
  now="$(date +%s 2>/dev/null)" || {
    printf 'unreachable'
    return 0
  }
  days=$(((now - epoch) / 86400))
  ((days < MIN_AGE_DAYS)) && {
    printf 'young:%s' "$days"
    return 0
  }

  command -v "$curl_bin" >/dev/null 2>&1 || {
    gl_log "curl not found — download history of $pkg could not be checked, denying"
    printf 'unreachable'
    return 0
  }
  out="$("$curl_bin" -fsS --max-time 8 "https://api.npmjs.org/downloads/point/last-month/$pkg" 2>/dev/null)" ||
    {
      printf 'unreachable'
      return 0
    }
  dl="$(printf '%s' "$out" | jq -r '.downloads // empty' 2>/dev/null)"
  [[ "$dl" =~ ^[0-9]+$ ]] || {
    printf 'unreachable'
    return 0
  }
  ((dl < MIN_DOWNLOADS)) && {
    printf 'thin:%s' "$dl"
    return 0
  }
  printf 'ok'
}

# The line the refusal ends on, naming the escape and why the command-line
# spelling of it is not one.
_escape_note() {
  cat <<'EOF'
The escape is `WFC_ALLOW_NEW_PACKAGE=1` in the environment Claude Code itself
was started in — NOT on this command line, which is read but never honoured: an
escape a session can spell for itself is not a deny (mantahostels#109). Otherwise ask the
founder to run the install from their own terminal, which sees no hook.
EOF
}

# ---------------------------------------------------------------------------
# `npm install` — checks 1 and 2.
# ---------------------------------------------------------------------------
npm_arg() {
  case "$1" in
    arg) if [[ -z "$sub" ]]; then sub="$3"; else specs+=("$3"); fi ;;
    flag | opt)
      # `--help` and `-h` reach here as `--usage`.
      case "$2:$3" in
        --ignore-scripts: | --ignore-scripts:true | --no-ignore-scripts:false) ignore=1 ;;
        --ignore-scripts:false | --no-ignore-scripts: | --no-ignore-scripts:true) ignore=0 ;;
        --usage: | --usage:true | --no-usage:false) helping=1 ;;
        --usage:false | --no-usage: | --no-usage:true) helping=0 ;;
      esac
      ;;
  esac
  return 0
}

judge_npm() {
  local segment="$1"
  shift
  local sub="" ignore=0 helping=0 reason spec name verdict deadline now
  local -a specs=() fresh=() unvettable=()

  # Only an install is judged, and every spelling of one names its alias.
  local w
  for w in "$@"; do
    [[ "$NPM_INSTALL_SUBS" == *" ${w##*=} "* ]] && break
  done
  [[ "$NPM_INSTALL_SUBS" == *" ${w##*=} "* ]] || return 0

  local -a canon
  npm_canon "$@"
  # No spec: npm_canon has joined every value to its option.
  gp_scan_flags "" npm_arg -- "${canon[@]}"
  ((helping)) && return 0
  [[ "$NPM_INSTALL_SUBS" == *" $sub "* ]] || return 0
  ((${#specs[@]})) || return 0 # `npm install` from the lockfile: untouched

  # Sorted first, judged after — so check 1 below really does run before any
  # refusal, which the header claims and mantahostels#1803's review found untrue (H2).
  _load_deps
  for spec in "${specs[@]}"; do
    if name="$(_spec_name "$spec")"; then
      _is_dependency "$name" || fresh+=("$name")
    else
      unvettable+=("$spec")
    fi
  done
  ((${#fresh[@]} + ${#unvettable[@]})) || return 0 # every spec is already a dependency

  # --- check 1: the execution window ---
  # It counts the unvettable specs too: a tarball's `preinstall` is exactly the
  # thing `--ignore-scripts` shuts, and more certainly than a registry one's.
  ((ignore)) || {
    IFS= read -r -d '' reason <<EOF || :
This install adds $((${#fresh[@]} + ${#unvettable[@]})) package(s) this repo does not yet depend on — ${fresh[*]} ${unvettable[*]} — and does not carry \`--ignore-scripts\`: @CMD@

A package's \`preinstall\` and \`postinstall\` run as you, before anything reads a byte of it. Re-run with \`--ignore-scripts\`; it is per-invocation, so husky's \`prepare\` bootstrap on a fresh clone is untouched (mantahostels#1767 rejected the repo-wide \`.npmrc\` form for exactly that reason).

Then commit the lockfile.
EOF
    gp_deny "$reason" "$segment"
  }

  # --- check 2: legitimacy ---
  # The stand-down comes before every refusal check 2 can raise, the unvettable
  # spec included — a deny whose text names an escape that does not lift it is
  # worse than no escape at all (mantahostels#1803's review, H2).
  [[ -n "${WFC_ALLOW_NEW_PACKAGE:-}" ]] && return 0

  if ((${#unvettable[@]})); then
    IFS= read -r -d '' reason <<EOF || :
This install names a spec the registry cannot be asked about, so its legitimacy is unverifiable: \`${unvettable[0]}\`

@CMD@

A path, a tarball URL, a \`git:\`/\`github:\` spec and an \`npm:\` alias all bypass the checks this guard runs on a new package — that the name exists, its age, its download history. None of them can be answered for a spec that never touches the registry.

$(_escape_note)
EOF
    gp_deny "$reason" "$segment"
  fi

  ((${#fresh[@]})) || return 0

  # A WALL-CLOCK BUDGET, because the hook's own timeout is not a verdict.
  # self-plugin/hooks/hooks.json gives this guard 60 s; a hook killed at the ceiling
  # emits nothing, which Claude Code reads as no objection — the one fail-open
  # this guard could not record. So it stops asking the registry at 30 s and
  # refuses on what it could not check, which is the same answer as an
  # unreachable registry and reached deliberately.
  #
  # 30 s, not 40: the budget is tested BEFORE each package and one package costs
  # up to `timeout 12` + `curl --max-time 8` = 20 s, so a 40 s budget could
  # start a package at 39 s and finish at 59 s — inside the ceiling only by
  # luck (mantahostels#1803's review, H4). 30 + 20 leaves 10 s of margin.
  #
  # A `date` that cannot answer reads as 0 on BOTH sides, so the budget is spent
  # immediately and every package refuses, rather than the budget silently
  # switching off.
  now="$(date +%s 2>/dev/null)" || now=0
  [[ "$now" =~ ^[0-9]+$ ]] || now=0
  deadline=$((now == 0 ? 0 : now + 30))
  for name in "${fresh[@]}"; do
    now="$(date +%s 2>/dev/null)"
    [[ "$now" =~ ^[0-9]+$ ]] || now=0
    if ((now >= deadline)); then
      verdict="budget"
    else
      verdict="$(_registry_verdict "$name")"
    fi
    case "$verdict" in
      ok) continue ;;
      missing)
        IFS= read -r -d '' reason <<EOF || :
No package named \`$name\` exists on the npm registry: @CMD@

That is the shape of a hallucinated name. Roughly one in five package references generated by a code model does not exist (Spracklen et al., USENIX Security 2025), and 43% of those names recur across re-runs — which is what makes pre-registering them worth an attacker's time. Check the name against the tool's own documentation before trying again.
EOF
        gp_deny "$reason" "$segment"
        ;;
      young:*)
        IFS= read -r -d '' reason <<EOF || :
\`$name\` was first published ${verdict#young:} days ago, under this guard's ${MIN_AGE_DAYS}-day floor: @CMD@

A squat registered against a hallucinated name is days old. A genuinely new package that this project needs is a founder decision, not a session's.

$(_escape_note)
EOF
        gp_deny "$reason" "$segment"
        ;;
      thin:*)
        IFS= read -r -d '' reason <<EOF || :
\`$name\` was downloaded ${verdict#thin:} time(s) last month, under this guard's floor of ${MIN_DOWNLOADS}: @CMD@

A package worth installing has real download history. This has none, which is what a squatted name looks like from the outside.

$(_escape_note)
EOF
        gp_deny "$reason" "$segment"
        ;;
      budget)
        IFS= read -r -d '' reason <<EOF || :
This guard ran out of its own time budget before it could check \`$name\`, so nothing is known about it: @CMD@

The budget is 30 s, under the hook's 60 s ceiling — a hook killed at that ceiling emits nothing at all, which reads as no objection. Install one package at a time and each gets checked.

$(_escape_note)
EOF
        gp_deny "$reason" "$segment"
        ;;
      *)
        IFS= read -r -d '' reason <<EOF || :
The npm registry could not be reached to check \`$name\`, so this install proceeds on nothing: @CMD@

An install whose name, age and download history went unchecked is what this guard exists to prevent, so an unreachable registry refuses rather than waving it through (mantahostels#1767).

$(_escape_note)
EOF
        gp_deny "$reason" "$segment"
        ;;
    esac
  done
  return 0
}

# ---------------------------------------------------------------------------
# `npx` — check 3.
# ---------------------------------------------------------------------------
npx_arg() {
  case "$1" in
    arg) [[ -n "$binname" ]] || binname="$3" ;;
    flag | opt)
      # nopt reads a lone `-` as a word. `package` holds no Boolean, so a bare
      # `--package` is the package `true` and `--no-package` negates its value.
      [[ "$2" == - && -z "$binname" ]] && binname=-
      case "$2:$3" in
        --package:) pkgs+=(true) ;;
        --no-package: | --no-package:true) pkgs+=(false) ;;
        --no-package:false) pkgs+=(true) ;;
        --package:* | --no-package:*) pkgs+=("$3") ;;
        --usage: | --usage:true | --no-usage:false) helping=1 ;;
        --usage:false | --no-usage: | --no-usage:true) helping=0 ;;
      esac
      ;;
  esac
  return 0
}

judge_npx() {
  local segment="$1"
  shift
  local binname="" helping=0 subject name reason
  local -a npx_argv canon pkgs=() words=()

  # Quoted spans put back, so `--r"eg"` is `--reg` and `"@biomejs/biome"` is
  # judged by its name. An unexpanded `$VAR` keeps its visible text.
  for name in "$@"; do words+=("$(gp_literal "$name")"); done
  _npx_preparse "${words[@]}"
  npm_canon "${npx_argv[@]}"
  gp_scan_flags "" npx_arg -- "${canon[@]}"
  ((helping)) && return 0

  # `-p @scope/pkg biome ci .` states the package outright, so every `-p` is
  # judged, npm fetching them all (workflow-core#571); without one the first bare word is
  # both the package and the bin.
  ((${#pkgs[@]})) || pkgs=("$binname")
  subject=""
  for name in "${pkgs[@]}"; do
    case "$name" in
      "" | -* | @*/* | */* | .* | *:*) continue ;; # no registry name, scoped, a path, or a URL/git spec
    esac
    [[ -n "$DEPS" ]] || _load_deps
    _is_dependency "$name" || {
      subject="$name"
      break
    }
  done
  [[ -n "$subject" ]] || return 0

  local owner owner_line fix
  if ! owner="$(_bin_owner "$subject")"; then
    fix="This guard could not read every dependency's package.json in \`node_modules\` to find which carries \`$subject\`. Spell it so it resolves to one thing:
  node_modules/.bin/$subject …    in the canonical checkout
  npx -p <that dependency> $subject …    in a worktree"
  elif [[ -z "$owner" ]]; then
    fix="No dependency of this repo carries a \`$subject\` bin. Install the package that provides it, then run \`node_modules/.bin/$subject …\`."
  else
    # A package runs the bin it is named for, `npx @biomejs/biome`; any other
    # owner, `typescript` for `tsc`, is named with -p.
    if [[ "$owner" == @*/"$subject" ]]; then
      owner_line="npx $owner …"
    else
      owner_line="npx -p $owner $subject …"
    fi
    fix="Spell it so it resolves to one thing:
  node_modules/.bin/$subject …    in the canonical checkout
  $owner_line    \`$owner\`, the dependency that carries it, in a worktree"
  fi

  IFS= read -r -d '' reason <<EOF || :
This runs \`$subject\` by bare name, which resolves to two different things depending on whether \`node_modules\` happens to exist: @CMD@

npx tries \`node_modules/.bin\` first and the public registry second, and a throwaway worktree has no \`node_modules\` at all. What the registry holds under a bare name can be anyone's: in mantahostels#1538 the bare name \`biome\` fetched an unrelated package that accepts \`ci .\`, prints nothing and exits 0 — a check that went green having checked nothing. \`--no-install\` is not a defence: running the bare form once writes the impostor into \`~/.npm/_npx/\`, after which it resolves silently and offline.

$fix
EOF
  gp_deny "$reason" "$segment"
}

judge() {
  local segment="$1" head
  shift
  head="$(basename "${1:-}")"
  case "$head" in
    npm)
      shift
      judge_npm "$segment" "$@"
      ;;
    npx)
      shift
      judge_npx "$segment" "$@"
      ;;
  esac
  return 0
}

gp_walk_commands judge

gp_allow
