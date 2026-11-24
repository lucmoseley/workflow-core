#!/usr/bin/env bash

set -uo pipefail

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
[[ "$SCRIPT_DIR" == "${BASH_SOURCE[0]}" ]] && SCRIPT_DIR=.
SCRIPT_DIR="$(cd "$SCRIPT_DIR" >/dev/null 2>&1 && pwd)"
SCRIPT_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-root.sh
source "$SCRIPT_DIR/lib/guard-root.sh"
# shellcheck source=scripts/lib/atomic-write.sh
source "$SCRIPT_DIR/lib/atomic-write.sh"

HEARTBEAT_DEFAULT_S=5
HEARTBEAT_S="${WFC_BG_HEARTBEAT_S:-$HEARTBEAT_DEFAULT_S}"
# guess: three missed beats, lucmoseley/mantahostels#1900
STALE_S="${WFC_BG_STALE_S:-20}"
# guess: room for a short stack trace, lucmoseley/mantahostels#2572
INLINE_CAP="${WFC_BG_INLINE_CAP:-4000}"
# guess, lucmoseley/mantahostels#2572
WAIT_POLL_S="${WFC_BG_WAIT_POLL_S:-2}"
# guess, lucmoseley/mantahostels#2609
MISSING_S="${WFC_BG_MISSING_S:-2}"
# guess, lucmoseley/mantahostels#2609
MISSING_POLL_S="${WFC_BG_MISSING_POLL_S:-0.1}"
MEMINFO="${WFC_BG_MEMINFO:-/proc/meminfo}"
# guess, lucmoseley/mantahostels#2683
MAX_DESCENDANTS="${WFC_BG_MAX_DESCENDANTS:-500}"
# guess, workflow-core#2704
CEILING_GRACE_S=60
if [[ "${WFC_BG_CEILING_GRACE_S:-}" =~ ^[0-9]+$ ]] && [[ "$WFC_BG_CEILING_GRACE_S" -lt "$CEILING_GRACE_S" ]]; then
  CEILING_GRACE_S="$WFC_BG_CEILING_GRACE_S"
fi
WATCH_GATE="${WFC_BG_WATCH_GATE:-}"
# guess, workflow-core#1352
GATE_S=10
CHECK_GATE="${WFC_BG_CHECK_GATE:-}"
POLL_LOG="${WFC_BG_POLL_LOG:-}"
NOW="${WFC_BG_NOW:-}"
MONO="${WFC_BG_MONO:-}"
# guess, workflow-core#2110
WATCH_READY_S="${WFC_BG_WATCH_READY_S:-5}"
# guess, workflow-core#2110
WATCH_READY_POLL_S="${WFC_BG_WATCH_READY_POLL_S:-0.05}"
WATCH_FORK_DELAY_S="${WFC_BG_WATCH_FORK_DELAY_S:-}"
TOUCHER_KEEPS_TRAP="${WFC_BG_TOUCHER_KEEPS_TRAP:-}"

mono_s=""
mono_now() {
  if [[ -n "$MONO" ]]; then
    mono_s="$MONO"
  else
    mono_s="$(node -e 'process.stdout.write(String(Math.floor(Number(process.hrtime.bigint()) / 1e9)))' 2>/dev/null)"
  fi
  [[ "$mono_s" =~ ^[0-9]+$ ]]
}

clock_ticks=0
clock_now() {
  case "$NOW" in
    "") clock_s="$(date +%s)" ;;
    *+)
      clock_ticks=$((clock_ticks + 1))
      clock_s=$((${NOW%+} + clock_ticks))
      ;;
    *) clock_s="$NOW" ;;
  esac
}

available_mb() {
  local line
  line="$(grep -m1 '^MemAvailable:' "$MEMINFO" 2>/dev/null)" || return 1
  [[ "$line" =~ ([0-9]+)\ kB ]] || return 1
  echo $((BASH_REMATCH[1] / 1024))
}

declare -A CHILDREN_OF
build_children_map() {
  CHILDREN_OF=()
  local stat_file pid line rest ppid
  local -a fields
  for stat_file in /proc/[0-9]*/stat; do
    pid="${stat_file#/proc/}"
    pid="${pid%/stat}"
    IFS= read -r line 2>/dev/null <"$stat_file" || continue
    rest="${line##*) }"
    read -ra fields <<<"$rest"
    ppid="${fields[1]:-}"
    [[ "$ppid" =~ ^[0-9]+$ ]] || continue
    CHILDREN_OF["$ppid"]+="$pid "
  done
}

descendants=()
descendants_truncated=false
collect_descendants() {
  local parent="$1" exclude="$2" pid kid
  descendants=()
  descendants_truncated=false
  build_children_map
  local -a queue=()
  for kid in ${CHILDREN_OF[$parent]:-}; do
    [[ "$kid" = "$exclude" ]] && continue
    if [[ "${#queue[@]}" -ge "$MAX_DESCENDANTS" ]]; then
      descendants_truncated=true
      break
    fi
    queue+=("$kid")
  done
  while [[ "${#queue[@]}" -gt 0 ]]; do
    if [[ "${#descendants[@]}" -ge "$MAX_DESCENDANTS" ]]; then
      descendants_truncated=true
      break
    fi
    pid="${queue[0]}"
    queue=("${queue[@]:1}")
    descendants+=("$pid")
    for kid in ${CHILDREN_OF[$pid]:-}; do
      if [[ "${#queue[@]}" -ge "$MAX_DESCENDANTS" ]]; then
        descendants_truncated=true
        break
      fi
      queue+=("$kid")
    done
  done
}

children_rss_kb() {
  local pid line total=0 found=false
  collect_descendants "$1" "$2"
  for pid in "${descendants[@]}"; do
    line="$(grep -m1 '^VmRSS:' "/proc/$pid/status" 2>/dev/null)" || continue
    if [[ "$line" =~ ([0-9]+)\ kB ]]; then
      total=$((total + BASH_REMATCH[1]))
      found=true
    fi
  done
  "$found" || return 1
  echo "$total $descendants_truncated"
}

sample_mem() {
  local dir="$1" parent="$2" exclude="$3" avail rss_line rss truncated
  avail="$(available_mb)" || return 0
  rss_line="$(children_rss_kb "$parent" "$exclude")" || return 0
  read -r rss truncated <<<"$rss_line"
  aw_write "$dir/mem" printf 'mem_available_mb=%s rss_kb=%s rss_truncated=%s\n' \
    "$avail" "$rss" "$truncated" 2>/dev/null
}

run_root() {
  if [[ -n "${WFC_BG_ROOT:-}" ]]; then
    printf '%s\n' "$WFC_BG_ROOT"
  elif [[ -n "${CLAUDE_JOB_DIR:-}" ]]; then
    printf '%s\n' "$CLAUDE_JOB_DIR/tmp/bg"
  else
    printf '%s\n' "${TMPDIR:-/tmp}/wfc-bg"
  fi
}

durable_log_path() {
  local base="$1" fallback="$2"
  local common
  common="$(git -C "$(gr_root)" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
  if [[ -n "$common" ]]; then
    printf '%s\n' "$common/$base"
    return 0
  fi
  printf '%s\n' "$(run_root)/$fallback"
}

kill_log_path() {
  if [[ -n "${WFC_BG_KILL_LOG:-}" ]]; then
    printf '%s\n' "$WFC_BG_KILL_LOG"
    return 0
  fi
  durable_log_path bg-kills.jsonl kills.jsonl
}

launch_log_path() {
  if [[ -n "${WFC_BG_LAUNCH_LOG:-}" ]]; then
    printf '%s\n' "$WFC_BG_LAUNCH_LOG"
    return 0
  fi
  durable_log_path bg-launches.jsonl launches.jsonl
}

json_escape() {
  local v="$1"
  v="${v//\\/\\\\}"
  v="${v//\"/\\\"}"
  v="${v//$'\n'/\\n}"
  v="${v//$'\r'/\\r}"
  v="${v//$'\t'/\\t}"
  printf '%s' "$v"
}

record_launch() {
  local name="$1" started_at="$2" watcher_ready="$3"

  local avail
  avail="$(available_mb)" || avail=""
  [[ -n "$avail" ]] || avail="unknown"

  local job_dir_set=false
  [[ -n "${CLAUDE_JOB_DIR:-}" ]] && job_dir_set=true

  local escape_field=null
  if [[ -n "${CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP+x}" ]]; then
    escape_field="\"$(json_escape "$CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP")\""
  fi

  local log
  log="$(launch_log_path)"
  mkdir -p "$(dirname "$log")" 2>/dev/null
  printf '{"name":"%s","started_epoch":"%s","run_root":"%s","job_dir_set":%s,"reap_escape":%s,"mem_available_mb":"%s","watcher_ready":%s}\n' \
    "$(json_escape "$name")" "$started_at" "$(json_escape "$(run_root)")" "$job_dir_set" "$escape_field" "$avail" "$watcher_ready" \
    >>"$log"
}

die() {
  printf 'bg-run: %s\n' "$1" >&2
  exit 3
}

SIGNAL_DIR=""

on_signal() {
  local code=$?
  local sig="$1"
  local sig_num=""
  case "$sig" in
    TERM) sig_num=15 ;;
    HUP) sig_num=1 ;;
  esac
  if [[ -n "$SIGNAL_DIR" ]] && [[ -n "$sig_num" ]] && [[ "$code" -eq "$((128 + sig_num))" ]]; then
    printf '%s\n' "$sig" >"$SIGNAL_DIR/.signal" 2>/dev/null
    trap - TERM HUP
    kill -"$sig" "$$"
  fi
  trap - TERM HUP
}
trap 'on_signal TERM' TERM
trap 'on_signal HUP' HUP

pinned_run_dir() {
  local name="$1"
  local log
  log="$(launch_log_path)"
  [[ -f "$log" ]] || return 1
  local root
  root="$(grep -F "\"name\":\"$(json_escape "$name")\"" "$log" 2>/dev/null |
    sed -n 's/.*"run_root":"\([^"]*\)".*/\1/p' | tail -1)"
  [[ -n "$root" ]] || return 1
  printf '%s/%s\n' "$root" "$name"
}

resolve_run_dir() {
  local name="$1"
  local dir pinned
  dir="$(run_root)/$name"
  [[ -d "$dir" ]] && {
    printf '%s\n' "$dir"
    return 0
  }
  pinned="$(pinned_run_dir "$name")" || {
    printf '%s\n' "$dir"
    return 0
  }
  [[ -d "$pinned" ]] && {
    printf '%s\n' "$pinned"
    return 0
  }
  printf '%s\n' "$dir"
}

poll_until() {
  local window="$1" interval="$2"
  shift 2
  local deadline_ns
  deadline_ns=$(($(date +%s%N) + $(awk "BEGIN{printf \"%.0f\", $window * 1000000000}")))
  while [[ "$(date +%s%N)" -lt "$deadline_ns" ]]; do
    sleep "$interval"
    "$@" && return 0
  done
  return 1
}

found_dir=""
run_dir_appeared() {
  [[ -z "$POLL_LOG" ]] || printf 'missing\n' >>"$POLL_LOG"
  found_dir="$(resolve_run_dir "$1")"
  [[ -d "$found_dir" ]]
}

scratch_dir() {
  printf '%s\n' "$(dirname "$1")/.tmp-$(basename "$1")"
}

held_scratch_dir() {
  local tmp pinned
  tmp="$(scratch_dir "$(run_root)/$1")"
  [[ -d "$tmp" ]] && {
    printf '%s\n' "$tmp"
    return 0
  }
  pinned="$(pinned_run_dir "$1")" || return 1
  tmp="$(scratch_dir "$pinned")"
  [[ -d "$tmp" ]] && printf '%s\n' "$tmp"
}

publish_settled() {
  run_dir_appeared "$1" || [[ ! -d "$2" ]]
}

require_run_dir() {
  local name="$1"
  local dir
  dir="$(resolve_run_dir "$name")"
  [[ -d "$dir" ]] && {
    printf '%s\n' "$dir"
    return 0
  }
  if poll_until "$MISSING_S" "$MISSING_POLL_S" run_dir_appeared "$name"; then
    printf '%s\n' "$found_dir"
    return 0
  fi
  local tmp
  if tmp="$(held_scratch_dir "$name")" &&
    poll_until "$(awk "BEGIN{print $WATCH_READY_S + $MISSING_S}")" "$MISSING_POLL_S" publish_settled "$name" "$tmp" &&
    run_dir_appeared "$name"; then
    printf '%s\n' "$found_dir"
    return 0
  fi
  local pinned
  if pinned="$(pinned_run_dir "$name")"; then
    die "no run named $name under $(run_root); its launch line points at $pinned, gone too"
  fi
  die "no run named $name under $(run_root)"
}

await_watcher() {
  local ready="$1"
  [[ -e "$ready" ]] && return 0
  poll_until "$WATCH_READY_S" "$WATCH_READY_POLL_S" test -e "$ready"
}

cmd_run() {
  [[ "$#" -ge 2 ]] || die "run needs a name and a command"
  local name="$1"
  shift
  local dir tmp
  dir="$(run_root)/$name"
  tmp="$(scratch_dir "$dir")"
  local grave
  grave="$(dirname "$dir")/.grave-$(basename "$dir")-$$-$RANDOM"
  if [[ -e "$dir" ]]; then
    mv -T "$dir" "$grave" && rm -rf "$grave"
  fi
  rm -rf "$tmp"

  mkdir -p "$tmp" || die "cannot create $tmp"
  : >"$tmp/out"
  local started_at
  clock_now
  started_at="$clock_s"
  printf '%s\n' "$started_at" >"$tmp/started"
  local token="$started_at-$$-$RANDOM"
  printf '%s\n' "$token" >"$tmp/token"

  local watcher_ready=null
  if command -v setsid >/dev/null 2>&1; then
    local ready="$tmp/.watching-$token"
    (
      [[ -z "$WATCH_FORK_DELAY_S" ]] || sleep "$WATCH_FORK_DELAY_S"
      exec setsid --fork "$SCRIPT_PATH" __watch "$dir" "$name" "$$" "$token" "$ready"
    ) </dev/null >/dev/null 2>&1 &
    disown 2>/dev/null || true
    watcher_ready=true
    await_watcher "$ready" || watcher_ready=false
  fi
  record_launch "$name" "$started_at" "$watcher_ready" || true

  clock_now
  touch -d "@$clock_s" "$tmp/beat" || die "cannot create $tmp/beat"
  mv -T "$tmp" "$dir" || die "cannot publish $dir"
  SIGNAL_DIR="$dir"

  local parent=$$
  (
    if [[ -n "$TOUCHER_KEEPS_TRAP" ]]; then
      trap 'on_signal TERM' TERM
      : >"$TOUCHER_KEEPS_TRAP"
    fi
    while kill -0 "$parent" 2>/dev/null; do
      sleep "$HEARTBEAT_S" >/dev/null 2>&1
      touch "$dir/beat" 2>/dev/null || exit 0
      sample_mem "$dir" "$parent" "$BASHPID"
    done
  ) &
  local beater=$!
  printf '%s\n' "$beater" >"$dir/.toucher"

  WFC_SUITE_DEADLINE_FILE="$dir/deadline-$token" "$@" >>"$dir/out" 2>&1
  local code=$?

  kill -KILL "$beater" 2>/dev/null
  wait "$beater" 2>/dev/null

  printf 'exit=%s\n' "$code" >"$dir/status"
  return "$code"
}

print_inline() {
  local path="$1"
  if [[ "$out_size" -le "$INLINE_CAP" ]]; then
    printf 'out=%s bytes=%s\n' "$path" "$out_size"
  else
    printf 'out=%s bytes=%s (last %s shown)\n' "$path" "$out_size" "$INLINE_CAP"
  fi
  printf '%s' "$out_tail"
}

record_kill() {
  local dir="$1" name="$2" reason="$3" death_epoch="${4:-}"
  mkdir "$dir/.kill-recorded" 2>/dev/null || return 0

  local now started="" elapsed=""
  clock_now
  now="$clock_s"
  if [[ -f "$dir/started" ]]; then
    started="$(cat "$dir/started" 2>/dev/null)"
    [[ "$started" =~ ^[0-9]+$ ]] || started=""
  fi
  if [[ -n "$death_epoch" ]] && [[ -n "$started" ]]; then
    elapsed=$((death_epoch - started))
  elif [[ -n "$started" ]]; then
    elapsed=$((now - started))
  fi
  [[ -n "${elapsed:-}" ]] || elapsed="unknown"

  local death_out death_source=beat
  if [[ -n "$death_epoch" ]]; then
    death_out="$death_epoch"
  else
    death_out="$now"
    death_source=clock
  fi
  [[ -n "$started" ]] || started="unknown"

  local heartbeat="$HEARTBEAT_S"
  [[ "$heartbeat" =~ ^[0-9]+$ ]] || heartbeat=null

  local out_exists=false out_size=0
  if [[ -f "$dir/out" ]]; then
    out_exists=true
    out_size="$(wc -c <"$dir/out" 2>/dev/null | tr -d ' [:space:]')"
    [[ -n "$out_size" ]] || out_size=0
  fi

  local queue_state="n/a"
  if [[ "$out_exists" = true ]]; then
    if grep -qE -- '--queue: (gate opened|gate still closed after [0-9]+s — running anyway)' "$dir/out" 2>/dev/null; then
      queue_state="passed"
    elif grep -qE -- '--queue: .* — refused, not run' "$dir/out" 2>/dev/null; then
      queue_state="refused"
    elif grep -q -- '--queue: a suite is already running; waiting for it' "$dir/out" 2>/dev/null; then
      queue_state="waiting"
    fi
  fi

  local mem_avail rss rss_truncated
  if [[ -f "$dir/mem" ]]; then
    mem_avail="$(sed -n 's/.*mem_available_mb=\([^ ]*\).*/\1/p' "$dir/mem" | tail -1)"
    rss="$(sed -n 's/.*rss_kb=\([^ ]*\).*/\1/p' "$dir/mem" | tail -1)"
    rss_truncated="$(sed -n 's/.*rss_truncated=\([^ ]*\).*/\1/p' "$dir/mem" | tail -1)"
  fi
  [[ -n "${mem_avail:-}" ]] || mem_avail="unknown"
  [[ -n "${rss:-}" ]] || rss="unknown"
  [[ -n "${rss_truncated:-}" ]] || rss_truncated="unknown"

  local name_esc
  name_esc="${name//\\/\\\\}"
  name_esc="${name_esc//\"/\\\"}"

  local signal
  signal="unknown"
  if [[ -f "$dir/.signal" ]]; then
    signal="$(head -1 "$dir/.signal" 2>/dev/null)"
    [[ -n "$signal" ]] || signal="unknown"
  fi
  local signal_esc
  signal_esc="${signal//\\/\\\\}"
  signal_esc="${signal_esc//\"/\\\"}"

  local log
  log="$(kill_log_path)"
  mkdir -p "$(dirname "$log")" 2>/dev/null
  printf '{"name":"%s","reason":"%s","started_epoch":"%s","death_epoch":"%s","death_epoch_source":"%s","heartbeat_s":%s,"elapsed_s":"%s","queue_state":"%s","out_bytes":%s,"out_exists":%s,"mem_available_mb":"%s","rss_kb":"%s","rss_truncated":"%s","signal":"%s"}\n' \
    "$name_esc" "$reason" "$started" "$death_out" "$death_source" "$heartbeat" "$elapsed" "$queue_state" "$out_size" "$out_exists" "$mem_avail" "$rss" "$rss_truncated" "$signal_esc" \
    >>"$log"
}

cmd_watch() {
  [[ "$#" -ge 5 ]] || die "watch needs a dir, a name, a parent pid, a run token and a ready path"
  local dir="$1" name="$2" parent="$3" launched_for="$4" ready="$5"
  : >"$ready" 2>/dev/null
  WFC_BG_KILL_LOG="$(kill_log_path)"
  local mono_unread_logged="" parent_start="" due_in
  proc_start_of "$parent" && parent_start="$proc_start"
  while :; do
    [[ -f "$dir/status" ]] && exit 0
    if ! { proc_start_of "$parent" && [[ "$proc_start" = "$parent_start" ]]; }; then
      [[ -f "$dir/status" ]] && exit 0
      cd "$dir" 2>/dev/null || exit 0
      local now_token
      now_token="$(cat token 2>/dev/null)"
      [[ "$now_token" = "$launched_for" ]] || exit 0
      [[ -n "$WATCH_GATE" ]] && hold_at_gate "$WATCH_GATE"
      local beat
      beat="$(date -r beat +%s 2>/dev/null)" || beat=""
      record_kill . "$name" "stale-beat" "$beat"
      exit 0
    fi
    due_in=""
    if read_deadline "$dir/deadline-$launched_for"; then
      if mono_now; then
        due_in="$((deadline_s + CEILING_GRACE_S - mono_s))"
        [[ "$due_in" -le 0 ]] &&
          ceiling_kill "$dir" "$name" "$parent" "$launched_for"
      else
        [[ -z "$POLL_LOG" ]] || printf 'mono-unread\n' >>"$POLL_LOG"
        [[ -n "$mono_unread_logged" ]] || note_mono_unread "$dir" "$launched_for"
        mono_unread_logged=1
      fi
    fi
    watch_nap "$due_in"
    [[ -z "$POLL_LOG" || -z "$due_in" ]] || printf 'nap %s\n' "$nap" >>"$POLL_LOG"
    sleep "$nap"
  done
}

nap=""
watch_nap() {
  local cap="$HEARTBEAT_DEFAULT_S"
  [[ -n "${1:-}" && "$1" -lt "$cap" ]] && cap="$1"
  nap="$HEARTBEAT_S"
  [[ "$HEARTBEAT_S" =~ ^([0-9]{0,9})(\.[0-9]*)?$ ]] &&
    ((10#${BASH_REMATCH[1]:-0} < cap)) || nap="$cap"
}

note_mono_unread() {
  cd "$1" 2>/dev/null || return 0
  [[ "$(cat token 2>/dev/null)" = "$2" ]] &&
    printf '\n%s\n' "bg-run: the monotonic clock would not read (workflow-core#2886), so the suite ceiling's backstop skips each poll it fails on (workflow-core#3160)" >>out
  cd "$OLDPWD" 2>/dev/null || :
}

proc_start=""
proc_start_of() {
  local stat
  IFS= read -r stat 2>/dev/null <"/proc/$1/stat" || return 1
  local -a fields
  read -ra fields <<<"${stat##*) }"
  [[ "${fields[0]}" != Z ]] || return 1
  proc_start="${fields[19]}"
}

deadline_s=""
deadline_pgid=""
read_deadline() {
  read -r deadline_s deadline_pgid 2>/dev/null <"$1" || return 1
  [[ "$deadline_s" =~ ^[0-9]+$ && "$deadline_pgid" =~ ^[0-9]+$ ]]
}

group_is_runs() {
  local pgid="$1" started="$2" stat btime
  [[ "$pgid" -gt 1 ]] || return 1
  [[ "$started" =~ ^[0-9]+$ ]] || return 1
  IFS= read -r stat 2>/dev/null <"/proc/$pgid/stat" || return 0
  local -a fields
  read -ra fields <<<"${stat##*) }"
  btime="$(awk '/^btime/ {print $2}' /proc/stat)"
  [[ "$((btime + fields[19] / $(getconf CLK_TCK)))" -ge "$((started - 1))" ]]
}

ceiling_kill() {
  local dir="$1" name="$2" parent="$3" launched_for="$4"
  cd "$dir" 2>/dev/null || exit 0
  [[ "$(cat token 2>/dev/null)" = "$launched_for" ]] || exit 0
  read_deadline "deadline-$launched_for" || exit 0
  printf 'grace_s=%s\n' "$CEILING_GRACE_S" >ceiling-kill
  if [[ -f status ]]; then
    rm -f ceiling-kill
    exit 0
  fi
  group_is_runs "$deadline_pgid" "$(cat started 2>/dev/null)" &&
    kill -KILL -- "-$deadline_pgid" 2>/dev/null
  collect_descendants "$parent" "$(cat .toucher 2>/dev/null)"
  [[ "${#descendants[@]}" -eq 0 ]] || kill -KILL "${descendants[@]}" 2>/dev/null
  record_kill . "$name" "ceiling"
  exit 0
}

hold_at_gate() {
  : >"$1.waiting"
  local i
  for ((i = 0; i < GATE_S * 10; i++)); do
    [[ -e "$1" ]] && return 0
    sleep 0.1
  done
}

holds_run() {
  [[ -d "$1" ]] || return 1
  [[ "$(cat "$1/token" 2>/dev/null)" = "$2" ]] && [[ -d "$1" ]]
}

read_run() {
  local dir="$1" name="$2" try="$3"
  verdict="" verdict_code=3 kill_reason="" kill_beat="" read_fault=""
  read_token="$(cat "$dir/token" 2>/dev/null)"
  [[ -z "$CHECK_GATE" ]] || hold_at_gate "$CHECK_GATE.$try"

  if [[ -f "$dir/status" ]]; then
    local code
    code="$(sed -n 's/^exit=//p' "$dir/status" 2>/dev/null | head -1)"
    if [[ -z "$code" ]]; then
      read_fault="status file for $name is unreadable"
    elif [[ -f "$dir/ceiling-kill" ]] && [[ "$code" != 0 ]]; then
      local grace
      grace="$(sed -n 's/^grace_s=//p' "$dir/ceiling-kill" 2>/dev/null | head -1)"
      verdict="DONE exit=$code ceiling-kill: bg-run killed it ${grace:-?}s past its suite deadline"
      verdict_code=0
    else
      verdict="DONE exit=$code"
      verdict_code=0
    fi
  elif [[ ! -f "$dir/beat" ]]; then
    verdict="KILLED before the first beat"
    verdict_code=1
    kill_reason=before-first-beat
  else
    local beat age
    if beat="$(date -r "$dir/beat" +%s 2>/dev/null)"; then
      clock_now
      age=$((clock_s - beat))
      if [[ "$age" -gt "$STALE_S" ]]; then
        verdict="KILLED ${age}s ago"
        verdict_code=1
        kill_reason=stale-beat
        kill_beat="$beat"
      else
        verdict="RUNNING last beat ${age}s ago"
        verdict_code=2
      fi
    else
      read_fault="cannot stat $dir/beat"
    fi
  fi
  out_size="$(wc -c <"$dir/out" 2>/dev/null | tr -d ' [:space:]')"
  [[ -n "$out_size" ]] || out_size=0
  { out_tail="$(
    tail -c "$INLINE_CAP" "$dir/out" 2>/dev/null
    printf x
  )"; } 2>/dev/null
  out_tail="${out_tail%x}"
  holds_run "$dir" "$read_token"
}

cmd_check() {
  [[ "$#" -ge 1 ]] || die "check needs a name"
  local name="$1"
  local dir try
  for try in 1 2; do
    dir="$(require_run_dir "$name")" || exit $?
    read_run "$dir" "$name" "$try" && break
    [[ "$try" -eq 2 ]] && die "run $name was replaced twice while check read it"
  done
  [[ -z "$read_fault" ]] || die "$read_fault"

  printf '%s\n' "$verdict"
  if [[ -n "$kill_reason" ]]; then
    [[ -z "$CHECK_GATE" ]] || hold_at_gate "$CHECK_GATE.record"
    (
      WFC_BG_KILL_LOG="$(kill_log_path)"
      cd "$dir" 2>/dev/null || exit 0
      [[ "$(cat token 2>/dev/null)" = "$read_token" ]] || exit 0
      record_kill . "$name" "$kill_reason" "$kill_beat"
    )
  fi
  print_inline "$dir/out"
  return "$verdict_code"
}

cmd_wait() {
  [[ "$#" -ge 1 ]] || die "wait needs a name"
  local name="$1"
  # guess: under the Bash tool's 120 s timeout, lucmoseley/mantahostels#2572
  local ceiling="${2:-60}"
  local start
  clock_now
  start="$clock_s"
  require_run_dir "$name" >/dev/null || exit $?

  local now code
  while :; do
    cmd_check "$name" >/dev/null
    code=$?
    [[ -z "$POLL_LOG" ]] || printf '%s\n' "$code" >>"$POLL_LOG"
    [[ "$code" -ne 2 ]] && break
    clock_now
    now="$clock_s"
    [[ "$((now - start))" -ge "$ceiling" ]] && break
    sleep "$WAIT_POLL_S"
  done
  cmd_check "$name"
}

main() {
  [[ "$#" -ge 1 ]] || die "usage: bg-run.sh run|check|wait <name> [command...]"
  local verb="$1"
  shift
  case "$verb" in
    run) cmd_run "$@" ;;
    check) cmd_check "$@" ;;
    wait) cmd_wait "$@" ;;
    __watch) cmd_watch "$@" ;;
    *) die "unknown verb $verb — expected run, check or wait" ;;
  esac
}

main "$@"
