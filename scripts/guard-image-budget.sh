#!/usr/bin/env bash
# guard-image-budget.sh — PostToolUse hook on Read: tell an agent when the
# images it has read stop reaching it (workflow-core#1784).
#
# THE FAULT. Claude Code sends at most ~17.5 M base64 characters of images
# and documents in one request (~13 MB decoded). Past that, as it builds each
# request, it swaps the OLDEST for the text `[media removed: request limit]`,
# retroactively — an image the agent saw a few Reads ago goes too. The Read
# result in the transcript still holds the image, so nothing marks the swap.
#
# WHY A COUNTER, NOT A MATCH ON THE STRING. The string is added at request
# build, after this hook has run, so no PostToolUse payload carries it. The
# measure is the binary's own, `source.data.length` summed over image and
# document blocks. A count cap is ruled out: 300 small images in one Haiku
# subagent and 130 in one Opus subagent lost none (workflow-core#1784).
#
# WHAT IT SAYS. Per (session, agent) — gp_agent_key — it appends each Read
# result's base64 length and path to a store, and:
#  - once, as the running total crosses WFC_IMAGE_WARN_CHARS: the budget is
#    nearly spent, and what to do before it runs out;
#  - on every Read that pushes more images past WFC_IMAGE_BUDGET_CHARS: which
#    files are now gone, by name, each named once.
# Silent on every other Read.
#
# LIMITS
#  - Only Read is counted. An image pasted in, a screenshot from an MCP tool or
#    any other media route adds to the real total unseen, so the warning comes
#    late there.
#  - A compaction drops images the store still counts, so after one the
#    warning comes early.
#  - A store idle for STALE_MIN is deleted, so a session resumed after that
#    with its images still in context starts counting from zero.
#  - The cap is bracketed, not pinned: 17.51 M to 18.14 M on CLI 2.1.301
#    (workflow-core#1784). BUDGET takes the low end, erring toward naming an image at the
#    edge a Read early over leaving a gone one unnamed. A release that moves
#    the cap makes every figure here wrong until re-measured.
#  - Without `flock` two parallel Reads can race on the store, so a notice may
#    repeat or a file be named twice; none is lost.
#
# FAILS OPEN (mantahostels#103 §6), recorded via lib/guard-log.sh: an
# unparseable payload, no session id or an unwritable store says nothing.
#
# IMPLICIT: after an image Read, tells the agent when its images near or pass
#   the per-request budget, naming the files that no longer reach it.
# JUSTIFIED: fail-safe — it adds context and refuses nothing; the judgement it
#   heads off is made on an image the agent never saw.
# DEFEAT: WFC_NO_IMAGE_BUDGET=1 — nothing is recorded or said.

set -uo pipefail

[[ "${WFC_NO_IMAGE_BUDGET:-}" == "1" ]] && exit 0

here="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null

# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  declare -F gl_open >/dev/null 2>&1 &&
    gl_open "lib/guard-parse.sh did not load — an image Read went uncounted"
  exit 0
}

BUDGET="${WFC_IMAGE_BUDGET_CHARS:-17500000}"
# A judgement: 4.5 M short of the budget leaves the mmm-infra scorers' median
# image (~160 K characters) about 28 more Reads to act on the warning.
WARN="${WFC_IMAGE_WARN_CHARS:-13000000}"
# A judgement: ten names fit a screen; older ones are summarised by count.
NAME_MAX=10
# A judgement: two days outlasts any working session seen here.
STALE_MIN=2880

gp_begin '.tool_name' Read
[[ "$_gp_subject" == Read ]] || exit 0

# Any response carrying base64 — an image, or a PDF's document block — counts,
# as both count against the same budget.
size="$(gp_payload_field '.tool_response.file.base64? // "" | length')" ||
  gl_open "payload did not parse as JSON — an image Read went uncounted"
[[ "$size" =~ ^[0-9]+$ ]] && ((size > 0)) || exit 0
file_path="$(gp_payload_field '.tool_input.file_path')"
file_path="${file_path//[$'\t\r\n']/ }"

key="$(gp_agent_key)" ||
  gl_open "no session id in payload — an image Read went uncounted"
store_dir="${TMPDIR:-/tmp}/wfc-image-budget"
mkdir -p "$store_dir" 2>/dev/null ||
  gl_open "could not create $store_dir — an image Read went uncounted"
find "$store_dir" -maxdepth 1 -type f -mmin +"$STALE_MIN" -delete 2>/dev/null
store="$store_dir/${key#* }.${key%% *}"

# Parallel Reads in one message run this hook concurrently; the append, the
# sums and the sidecar update are one read-modify-write.
if command -v flock >/dev/null 2>&1; then
  exec {lock}>>"$store.lock" 2>/dev/null && flock -w 2 "$lock" 2>/dev/null
fi

# The store: one `<size>\t<path>` line per Read, oldest first. Its sidecar
# holds what has been said — `<warned 0|1> <files named gone>` — and is
# rewritten on every Read so the two age out together.
printf '%s\t%s\n' "$size" "$file_path" >>"$store" 2>/dev/null ||
  gl_open "could not write $store — an image Read went uncounted"
told=(0 0)
[[ -r "$store.told" ]] && read -r -a told <"$store.told"
[[ "${told[0]:-}" =~ ^[01]$ && "${told[1]:-}" =~ ^[0-9]+$ ]] || told=(0 0)

# Totals, and how many of the oldest the cap has pushed out: everything older
# than the newest run of images that fits in BUDGET.
read -r count total gone < <(awk -F'\t' -v cap="$BUDGET" '
  { s[NR] = $1; t += $1 }
  END {
    kept = 0
    for (i = NR; i >= 1; i--) { if (kept + s[i] > cap) break; kept += s[i] }
    print NR, t, i
  }' "$store")

millions() { awk -v n="$1" 'BEGIN { printf "%.1f", n / 1000000 }'; }

message=""
if ((gone > told[1])); then
  names="$(awk -F'\t' -v from="$((told[1] + 1))" -v to="$gone" -v max="$NAME_MAX" '
    NR >= from && NR <= to {
      if (++n <= max) printf "%s  - %s (image %d of this context)", (n > 1 ? "\n" : ""), $2, NR
    }
    END { if (n > max) printf "\n  - and %d more, older than these", n - max }' "$store")"
  message="IMAGE BUDGET (workflow-core#1784): this context has now read $count images, $(millions "$total") M characters of image data, past the $(millions "$BUDGET") M Claude Code sends in one request. It now replaces the OLDEST images, silently, with the text \`[media removed: request limit]\` — the Read result still says it returned an image. By this hook's count these no longer reach you:
$names
Do not judge, compare against or describe any of them from memory. Re-reading one pushes out the next oldest. If your task still needs them, stop and report which images you could not see; a job this size belongs split across agents."
  told=(1 "$gone")
elif ((told[0] == 0 && total >= WARN)); then
  message="IMAGE BUDGET (workflow-core#1784): this context has read $count images, $(millions "$total") M characters of image data. Past $(millions "$BUDGET") M, Claude Code replaces the OLDEST images, silently, with the text \`[media removed: request limit]\` — the Read result still says it returned an image. Finish judging the early images before reading many more. Before using an earlier image again, check it still shows; where one shows \`[media removed: request limit]\`, do not judge it — stop and report which images never reached you."
  told=(1 "${told[1]}")
fi

printf '%s %s\n' "${told[0]}" "${told[1]}" >"$store.told" 2>/dev/null ||
  gl_log "could not write $store.told — a notice may repeat"
[[ -n "$message" ]] || exit 0
gp_context "$message" PostToolUse
exit 0
