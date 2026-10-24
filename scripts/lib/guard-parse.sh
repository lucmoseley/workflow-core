#!/usr/bin/env bash
# Shared parser (mantahostels#123), verdict emitters (mantahostels#138) and payload seam (mantahostels#157) for the
# PreToolUse guards.
#
# The walkers answer the question a guard judging a Bash command's effect must
# settle before it can judge anything: given one opaque shell string from a Bash
# tool call, which commands does it actually run, and against which working
# tree? A caller reading its field raw, or judging a non-Bash payload
# (guard-last30days.sh a Skill one, guard-file-claim.sh a
# Write/Edit/NotebookEdit one), takes the payload seam and the emitters only —
# no walker, and none of the git machinery below.
#
# SOURCED, NEVER RUN.
#
# EVERY ARRAY HERE IS `_gp_`-PREFIXED, LOCALS INCLUDED (mantahostels#1813). shellcheck's
# `-x` follows a source line but ignores `local`, so a bare array name in this
# file reads as file-scope in every script that sources it, and any one of
# them assigning a scalar of that name fails `check:sh` with SC2178 — mantahostels#1812,
# on `seen`. Pre-commit catches that only where the script is staged, its run
# following sources downward, so an array added HERE is a whole red CI job,
# discovered at the next sweep rather than at the commit.
#
# THE INTERFACE (mantahostels#157). A guard uses the names below:
#
#   gp_begin <jq path> <noun> [<field label>]
#                               read the payload, keep the field being judged
#                               and arm the abort record (#1818)
#   gp_adopt_payload <payload>  take a payload the caller has already read off
#                               stdin, for a hook that routes on it before
#                               sourcing this file (#569); arms that record too
#   gp_subject                  that field, for a guard that reads it raw
#   gp_payload_field <jq path>  any other field; non-zero if jq could not answer
#   gp_agent_key                `<agent> <sid>`, the agent `main` for the parent
#                               and `a<agent_id>` for a subagent, for a caller
#                               keeping per-agent state (#1486); 2 where the
#                               payload did not parse, 3 where it has no
#                               session_id
#   gp_walk_commands [--bare-redirects] <fn>
#                               every command the string runs, its words with
#                               the redirections taken out (#1488)
#   gp_redirects                inside any walk, those redirections: descriptor,
#                               kind, target and resolved path, answered in four
#                               $_gp_redir_* arrays (#1488)
#   gp_write_targets <word>...  inside any walk, every file the command writes
#                               or removes, by every spelling the guard tier
#                               reads, answered in four $_gp_wt_* arrays (#1827)
#   ${_gp_words[@]:0:_gp_assign_end}
#                               inside that walk, the command's leading
#                               assignments, among any reserved words before
#                               them (#1013); read raw by guard-hook-escape.sh
#   gp_carries_var <NAME> <word>...
#                               inside that walk, whether the command carries
#                               NAME non-empty, by leading assignment or `env`
#                               (#1499); answers by exit status, and leaves
#                               gp_unwrap's two arrays set over <word>...
#   gp_cwd                      inside that walk, the directory the command
#                               runs in; empty where it is unknown (mantahostels#3453)
#   gp_resolve_word <word>      inside that walk, one of the command's words as
#                               the shell would expand it (#1030)
#   gp_assigned <NAME>          inside that walk, whether the command assigned
#                               NAME, before this point, a value the walk
#                               resolves (#2436)
#   gp_walk_shared_git <fn> <noun> <subcommand>...
#                               every named git subcommand running against THIS
#                               repo's shared working tree
#   gp_walk_shared_git_strict <fn> <noun> <subcommand>...
#                               the same, with the unresolved target tree handed
#                               to <fn> instead of logged and skipped (#301)
#   gp_walk_repo_git <fn> <noun> <subcommand>...
#                               the same, widened to any working tree of this
#                               repo — a linked worktree included (mantahostels#1213)
#   gp_walk_repo_git_strict <fn> <noun> <subcommand>...
#                               the same, with the unresolved target tree handed
#                               to <fn> instead of logged and skipped (#311)
#   any of the four walkers --empty-unset <fn> ...
#                               an unset variable in the target read as empty,
#                               as the shell reads it (#325); gp_empty_vars
#                               names them, inside the callback
#   gp_unset_text <var>         those names as a refusal's line, into <var>
#   gp_scan_flags <spec> <fn> -- <word>...
#                               one command's own flags and bare words (mantahostels#477)
#   gp_git_value_flags <merge|rebase|commit>
#                               that subcommand's measured gp_scan_flags spec (#302)
#   gp_unwrap <word>...         one command's words with the launcher wrappers
#                               stripped off, answered in $_gp_unwrapped and
#                               $_gp_wrapper_words (mantahostels#2524), the latter
#                               read raw by guard-hook-escape.sh
#   gp_commit_paths_args <word>...
#                               a `node …/commit-paths.js` call's arguments after
#                               the script, answered in $_gp_cp_args; 1 where
#                               the words are no such call (#2022)
#   gp_commit_paths_parse       those arguments split as commit-paths.js reads
#                               them, answered in $_gp_cp_paths, $_gp_cp_patch,
#                               $_gp_cp_message_flag, $_gp_cp_message and
#                               $_gp_cp_tree; 1 where it would refuse them
#                               (#2147, #2383)
#   gp_patch_files <dir> <word> the files a patch touches, answered in
#                               $_gp_patch_files; 1 where it is unreadable
#   gp_find_starts <word>...    a `find`'s start points, answered in
#                               $_gp_find_starts (#2060)
#   gp_gh_words <word>...       a `gh` command's words from its command word
#                               on, answered in $_gp_gh_args (#772), and the
#                               `-R` it steps over in $_gp_gh_repo (#2020)
#   gp_git_words <word>...      a `git` command's subcommand, past its wrappers
#                               and git's own options, answered in $_gp_git_sub,
#                               and the words after it in $_gp_git_args (#2383)
#   gp_heredoc_lines            the subject's lines, numbered from 0, that a
#                               heredoc's body or terminator fills, answered in
#                               $_gp_heredoc_lines (#2384)
#
# plus the emitters gp_deny / gp_deny_context / gp_warn / gp_context / gp_allow / gp_unmask, the pre-emptive
# gp_rule (mantahostels#1804, which prints a rule BEFORE the mistake rather than in the
# refusal), gp_rule_told / gp_rule_mark_told, which bound the repeat of a rule a
# guard splices into its own wording (mantahostels#2275), gp_rule_skip (mantahostels#1805) and
# gp_rule_prelude (mantahostels#2369), which scope and prefix that emission, gp_rule_text
# (#772), a fragment for a guard's own wording with a fallback, gp_latch_path
# (mantahostels#2411), which hands a latch marker's path to a caller keeping something of
# its own beside the latches, the readers gp_literal, gp_as_written and
# gp_tree_scope, gp_norm_abs (mantahostels#3315), which makes two spellings of one
# absolute path compare equal, gp_redirect_writes (#1488), whether a
# redirection kind writes a file, and the constant $QUOTED.
# Everything else is _gp_-prefixed and private, bar the answer variables the
# interface above names.
#
# Every walker hands its callback the facts as ARGUMENTS (mantahostels#157), bar
# what the callback asks gp_cwd, gp_empty_vars and gp_redirects for. The
# answer variables escape that: each is inert until a caller runs the function
# that fills it, so it costs no other caller anything. Printing was the
# alternative and cannot be taken — the answer is a word LIST, and a word may
# hold a space.
#
# The decision — whether to refuse, and every word of the reason — stays in the
# guard that owns it; only the JSON envelope Claude Code parses lives here.
#
# No copy per guard (mantahostels#138): each guard already stands down
# entirely when its `declare -F` gate finds this file damaged, so its verdict is
# breakable from here either way.
#
# session-arbiter.js still hand-rolls the same envelope in JavaScript and cannot
# source this file. Change the envelope in both.
#
# FAIL OPEN is the house rule (mantahostels#103 §6): a guard that cannot resolve something
# allows the command through rather than blocking work. That extends to this
# file's own absence — each guard's `source` line exits 0 when it cannot be
# read. Every fail-open below is RECORDED before it allows (mantahostels#147), through
# lib/guard-log.sh.
#
# ONE EXCEPTION, ruled at mantahostels#1762 and confined to gp_rule's STORE side: a rule id
# no fragment answers to exits 2. Its payload side keeps the house rule.

# The fail-open record (mantahostels#147). Sourced here as well as by each guard, so the
# functions below can log wherever they are driven from. A guard-log.sh that
# cannot be read falls back to allowing silently, rather than crashing the guard
# on an undefined function and leaving the run half-judged.
# shellcheck source=scripts/lib/guard-log.sh
source "$(dirname "${BASH_SOURCE[0]}")/guard-log.sh" 2>/dev/null
declare -F gl_log >/dev/null 2>&1 || gl_log() { :; }
declare -F gl_open >/dev/null 2>&1 || gl_open() { exit 0; }
declare -F gl_arm_exit >/dev/null 2>&1 || gl_arm_exit() { :; }
declare -F gl_exit >/dev/null 2>&1 || gl_exit() { exit "$1"; }

# The repo root, in the one spelling the whole guard tier uses (mantahostels#1905). Sourced
# directly rather than leaned on through guard-log.sh, which sources it too: a
# guard whose guard-log.sh is detached must stay ARMED, and it can only do that
# with a root it can still resolve.
#
# The stub is deliberately empty, and NOT a shortened re-spelling of the
# expression, which mantahostels#1905 exists to stop. The empty string is the DISARM SIGNAL,
# and both readers below test for it by hand rather than trusting what an empty
# root happens to do: `git -C ""` succeeds against the cwd's repo, so
# _gp_init_repo would carry on judging with a root it never resolved, and
# `/.rule-injected-…` is writable as root, so gp_rule would litter a directory
# outside any repo.
# shellcheck source=scripts/lib/guard-root.sh
source "${BASH_SOURCE[0]%/*}/guard-root.sh" 2>/dev/null
declare -F gr_root >/dev/null 2>&1 || gr_root() { :; }
# shellcheck source=scripts/lib/marker-root.sh
source "${BASH_SOURCE[0]%/*}/marker-root.sh" 2>/dev/null
declare -F gr_markers_dir >/dev/null 2>&1 || gr_markers_dir() { :; }
# shellcheck source=scripts/lib/wfc-config.sh
source "${BASH_SOURCE[0]%/*}/wfc-config.sh" 2>/dev/null
declare -F wfc_disabled >/dev/null 2>&1 || wfc_disabled() { return 1; }

# Sentinel standing in for a quoted span. Public: guard-issue-body.sh asks
# whether a `gh api` field it read is a blanked span rather than a literal.
#
# It is the PREFIX of what the masker emits, not the whole of it (mantahostels#183): each
# span is blanked to $QUOTED<index>\x01, and $_gp_spans[<index>] keeps the
# original text so a path argument can be read back. Every consumer tests it as
# a substring (`== *"$QUOTED"*`), which the indexed form still satisfies.
QUOTED=$'\x01QSTR\x01'

# Private state.
_gp_payload=""
_gp_subject=""
_gp_project_common=""
_gp_segments=""
_gp_split_done=0
_gp_cwd=""
# The cwd each open subshell will hand back at its `)`, innermost last (mantahostels#3453).
_gp_cwd_stack=()
# gp_walk_commands's seed, read off the payload once.
_gp_cwd_seed=""
_gp_words=()
_gp_wi=0
_gp_sub=""
_gp_args=()
_gp_target_dir=""
# What left the tree unresolved, AS TYPED, for the unresolved-tree record's field
# 4 (#320) — $_gp_target_dir cannot carry it, being blanked to "" wherever a path
# fails to resolve. The `-C <word>` that failed, and the `cd` words that made
# the cwd unknown. Stored masked; _gp_as_written renders them.
_gp_target_written=""
_gp_cwd_lost=""
# Set by the two strict walkers as a LOCAL, so it reaches _gp_walk_git by
# dynamic scope and leaves nothing behind (#301). The two ordinary walkers set it
# to 0 the same way, so a walk nested in a strict callback does not inherit it
# (#311). Declared here for readers only; the seam stays argument-shaped, which
# is mantahostels#157's ruling.
_gp_judge_unresolved_tree=0
# A walker's --empty-unset opt-in (#325), set LOCAL by _gp_walk_git the same way.
# The names it substituted as unset, space-separated, follow the path they fed:
# one _gp_path_arg call's, the running cwd's (stacked per subshell like the cwd),
# and the judged target's, which gp_empty_vars reads back. Local to each walk.
_gp_empty_unset=0
# A walker's --unwrap opt-in (#1731), set LOCAL by _gp_walk_git the same way:
# a git command behind gp_unwrap's wrappers (`env X=1 git push`, `timeout 60
# git push`) is judged as the git command it launches. Opt-in, so the guards
# whose LIMITS name the wrapper blind spot keep it until each is re-tested.
_gp_unwrap_git=0
_gp_path_names=""
_gp_cwd_names=""
_gp_cwd_names_stack=()
_gp_target_names=""
# What the lexer has done, never reset, so a test can bound the parse's cost by
# count rather than by clock (#1916): every character fed, and the widest piece,
# which bounds what one step copies (#510).
_gp_lx_lexed=0
_gp_lx_widest=0
# The masked-out quoted spans, in the order they were blanked. Each entry is the
# quote character followed by the span's text, because the two kinds resolve
# differently: "$HOME/x" is a variable, '$HOME/x' is a directory with a dollar
# in its name.
_gp_spans=()
# The lexer's state — see _gp_lex. $_gp_lx_st is its frame stack, $_gp_lx_out
# the masked text so far, $_gp_lx_q and $_gp_lx_span the outermost open span's
# quote and text, $_gp_lx_prefix the masked text before that span,
# $_gp_lx_hline the heredoc body line read so far, $_gp_lx_bs 1 where a
# backslash waits on the character it escapes, and $_gp_lx_cmt 1 inside a
# comment.
_gp_lx_st=""
_gp_lx_out=""
_gp_lx_span=""
_gp_lx_q=""
_gp_lx_prefix=""
_gp_lx_bs=0
_gp_lx_cmt=0
_gp_lx_hline=""
# Counts the outermost spans opened, so a caller can tell a new one from the one
# it already judged.
_gp_lx_opens=0
_gp_lx_depth=()
_gp_lx_term=()
_gp_lx_dash=()
_gp_lx_saved=()
_gp_lx_saved_depth=()
_gp_lx_saved_term=()
_gp_lx_saved_dash=()
# Variables the command string assigns to itself, resolved (mantahostels#208). Names in
# _gp_locals_dead were assigned something this file will not resolve, or
# assigned twice with different values — see _gp_harvest_assignments.
declare -A _gp_locals=()
declare -A _gp_locals_dead=()
# The index in $_gp_segments of the first segment after the string's first `||`
# outside a quoted span, or -1 where it carries none (#328) — see
# _gp_harvest_assignments. Compared against $_gp_seg_idx, the segment each
# walker is reading, which the walkers set as a LOCAL.
_gp_conditional=-1
_gp_seg_idx=-1
# Out-parameters. These helpers must not run in a command substitution: the
# masker appends to $_gp_spans, and a subshell would drop every span it recorded.
_gp_masked=""
_gp_mask_open=""
_gp_expanded=""
_gp_path=""
# _gp_path_arg's second answer: the argument resolved, and resolved to the empty
# string (#301). Only a literal `""` reaches it. Meaningful after a non-zero
# return from that function and nowhere else.
_gp_path_empty=0

gp_allow() { exit 0; }

# _gp_load_script_path — script-path.sh, sourced at its first use so a silent
# guard never pays for it. 1 where it cannot be loaded.
_gp_load_script_path() {
  declare -F resolve_script_paths >/dev/null 2>&1 && return 0
  # shellcheck source=scripts/lib/script-path.sh
  source "${BASH_SOURCE[0]%/*}/script-path.sh" 2>/dev/null && return 0
  gl_log "script-path.sh unreadable — core paths go out unresolved"
  return 1
}

# gp_script_path <name> — script_path for a guard's message (#343, #1758): a
# script under scripts/ as a session should spell it, bare where script-path.sh
# cannot be loaded.
gp_script_path() {
  if _gp_load_script_path; then
    script_path "$1"
  else
    printf 'scripts/%s' "$1"
  fi
}

# _gp_core_paths <var> — the text in <var> with every `scripts/x` and
# `docs/x` the core holds spelled at the plugin root in an install, so a
# guard's prose sends an adopter to a file that exists (#343, #1010). Untouched
# in a checkout; where the resolver cannot be loaded the text goes out as
# written.
_gp_core_paths() {
  local -n _gp_cp="$1"
  _gp_load_script_path && ! sp_in_checkout &&
    _gp_cp="$(printf '%s' "$_gp_cp" | resolve_script_paths)"
  return 0
}

# gp_deny <reason> [<segment>]
#
# Claude Code keys hookSpecificOutput off hookEventName; a block missing it is
# dropped silently.
#
# The reason is the guard's own prose, and a trailing newline is trimmed so a
# caller can build it with a quoted heredoc and escape no backticks or quotes.
# Given a segment, @CMD@ in the reason is replaced by it, rendered by gp_unmask.
#
# The splice is jq's split/join, which is literal. Bash's ${//} is not: since 5.2
# an unquoted & in the replacement text stands for the matched text, so a
# command containing one would reach the user mangled.
gp_deny() {
  gp_deny_context "$@"
  exit 0
}

# gp_deny_context <reason> [<segment>] — gp_deny's envelope printed WITHOUT
# exiting, for a guard that latches after the refusal on mantahostels#2261's
# order, as gp_context is gp_warn's (#2436). Returns non-zero where the envelope
# did not render, which the caller records.
gp_deny_context() {
  local cmd="" reason="${1%$'\n'}"
  (($# > 1)) && cmd="$(gp_unmask "$2")"
  _gp_core_paths reason
  jq -nc --arg reason "$reason" --arg cmd "$cmd" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: ($reason | split("@CMD@") | join($cmd))
    }
  }'
}

# gp_context <msg> — the additionalContext envelope, printed WITHOUT exiting, for
# a guard with something to do after the emission: gp_rule and
# guard-vitest-wrapper.sh both latch after it, on mantahostels#2261's order (mantahostels#2275). Returns
# non-zero where the envelope did not render, which the caller records.
# <event> defaults to PreToolUse; a PostToolUse hook passes its own, as Claude
# Code drops an envelope naming another event.
gp_context() { _gp_emit_context "$1" "${2:-PreToolUse}"; }

# The private half gp_warn and gp_context share.
_gp_emit_context() {
  local msg="$1" event="${2:-PreToolUse}"
  _gp_core_paths msg
  jq -nc --arg msg "$msg" --arg event "$event" '{
    hookSpecificOutput: {
      hookEventName: $event,
      additionalContext: $msg
    }
  }'
}

gp_warn() {
  _gp_emit_context "$1"
  exit 0
}

# ---------------------------------------------------------------------------
# gp_rule <id> [<id>...] — hand a session a rule's full text BEFORE the mistake
# (mantahostels#1804, spec mantahostels#1762).
#
# Ids are given in PRIORITY ORDER, highest first.
#
# TWO FAULT DIRECTIONS, and they are deliberately opposite (mantahostels#1762's ruling):
#
#   store fault  — an id no fragment answers to, an empty fragment, an
#                  unreadable store, a fragment too large to emit at all.
#                  EXIT 2, refusing the tool call.
#   payload fault — no payload, no jq, unparseable JSON, no session_id.
#                  gl_open (exit 0), the house fail-open (mantahostels#103).
#
# THE LATCH. A rule is injected once per session per id: `.rule-injected-<id>-
# <agent>-<sid>` at the repo root, on the `.<kind>-nagged-<sid>` precedent.
#
# Written AFTER the emission (mantahostels#2261, reversing mantahostels#1804's order). A PreToolUse hook
# CANCELLED at its timeout has its stdout discarded, so latching first marks a
# session as told and never tells it, for the whole of its life. Latching after
# leaves a cancelled hook's id unlatched, and the rule arrives whole on the next
# trigger. The ceiling is self-plugin/hooks/hooks.json's own `"timeout": 10`, not a
# harness property, and whether 10 is right is mantahostels#2265's.
#
# WHAT THE REVERSAL COSTS. An unlatchable id retries on EVERY trigger for the
# session's life — up to GP_RULE_CAP bytes each — because nothing records that
# it was already said.
#
# UNVERIFIED: no test drives a real SIGKILL between jq and the marker write.
#
# What is latched is THIS HOOK'S OWN EMISSION, never delivery. Whether the
# harness kept the bytes is unobservable from inside a hook.
#
# Swept at SessionStart by arbiter-markers.js's pruneMarkers, on a pass of its own
# — see RULE_LATCH_PREFIX there for why it is not a MARKER_PREFIXES entry.
#
# <agent> IS NOT DECORATION (mantahostels#1804): a dispatched subagent's PreToolUse payload
# carries its PARENT's session_id, and is told apart only by an `agent_id` field
# the parent's own calls do not carry. Keyed on the session id alone, a rule the
# parent had already been given would be suppressed for every subagent under it.
# So `main` for the parent, `a<agent_id>` for a subagent, each injected once.
#
# The discriminator goes BEFORE the session id, not after: both the sweep and
# scripts/clear-rule-latch.sh's glob match the id as a trailing segment.
#
# THE CAP. GP_RULE_CAP bytes — see the constant for where the figure comes from
# and what in it is a judgement. Over it the emission carries the
# highest-priority ids that fit and DEFERS the rest — unlatched, so they arrive
# whole on the next trigger. Never truncated mid-string. A gp_rule_prelude spends
# the same budget and can push every id out, in which case the envelope carries
# the prelude alone and latches nothing — but the prelude itself is never capped;
# see gp_rule_prelude for why.
#
# A deferral stops at the first id that does not fit rather than skipping on to
# a smaller one behind it: priority order is the caller's statement of which
# rule matters most, and reordering silently overrides it.
# ---------------------------------------------------------------------------

# 40% of HOOK_PERSIST_CHARS (lib/hook-limits.sh). The 40% is a judgement, not a measurement: it leaves
# room for the guard's own warn text and for a second hook on the same event.
GP_RULE_CAP=4000

# Length in BYTES, whatever locale the harness handed the hook.
#
# ${#s} counts characters in a UTF-8 locale and bytes under LC_ALL=C, and every
# fragment in the live store is multibyte. So an unqualified ${#s} makes the one
# guarantee this ceiling offers depend on an environment variable nothing here
# sets.
_gp_rule_len() {
  local LC_ALL=C
  printf '%s' "${#1}"
}

# $1 with ONE leading `rule:` removed — rt_bare_id's rule, restated here because
# the store is not sourced until gp_rule is well past its payload checks, and
# gp_rule_skip runs before any of that (mantahostels#2719). NOTHING PINS THE TWO TO THE SAME
# RULE: a change to rt_bare_id's stripping has to be made here by hand.
#
# WHY IT EXISTS AT ALL: the store's accessor resolves `rule:x` and `x` to the
# same fragment, so a latch keyed on the id AS GIVEN would hand one session the
# same rule twice.
_gp_bare_id() {
  printf '%s' "${1#rule:}"
}

# The latch file for one (rule, agent, session) triple.
#
# The directory comes from gr_markers_dir, which is also what
# scripts/clear-rule-latch.sh globs with — one expression, so the two cannot
# drift out of byte-for-byte agreement and leave the compaction clear missing
# what this wrote (mantahostels#1905). Under .claude/tmp/markers rather than
# the repo root since F8 (mantahostels#3515, #2).
_gp_rule_marker() {
  printf '%s/.rule-injected-%s-%s-%s' "$(gr_markers_dir)" "$1" "$2" "$3"
}

# gp_agent_key — the (agent, session) pair every latch marker is keyed on, as
# `<agent> <sid>`, and lib/echo-chain.sh's chain store and guard-agent-poll.sh's
# window too (#1004).
#
# Both halves become path segments, so anything outside the id alphabet is
# replaced rather than trusted. `agent_id` is absent on the parent's own calls
# and present on every subagent's — see the header above for why keying on the
# session id alone would suppress a parent's rule for every subagent under it. A
# payload jq cannot answer for leaves it empty, which reads as the parent and so
# at worst repeats an injection.
#
# Return codes are distinct because gp_rule's two fail-opens name different
# faults: 2 where the payload did not parse, 3 where it carried no session id.
gp_agent_key() {
  local sid agent
  sid="$(gp_payload_field '.session_id')" || return 2
  [[ -n "$sid" ]] || return 3
  sid="${sid//[^A-Za-z0-9_-]/_}"
  agent="$(gp_payload_field '.agent_id')" || agent=""
  agent="${agent//[^A-Za-z0-9_-]/_}"
  agent="${agent:+a$agent}"
  agent="${agent:-main}"
  printf '%s %s' "$agent" "$sid"
}

# gp_agent_label <consequence> — gp_agent_key's first half: `main` for the
# parent's own calls, `a<agent_id>` for a subagent's. A guard telling a parent
# from a subagent calls this, not gp_agent_key (#1735). A payload gp_agent_key
# cannot answer for prints `main` and logs <consequence>.
gp_agent_label() {
  local key
  if key="$(gp_agent_key 2>/dev/null)"; then
    printf '%s' "${key%% *}"
  else
    gl_log "could not tell a subagent from its parent — $1"
    printf 'main'
  fi
}

# gp_parent_wait_text — why the parent ending its turn loses nothing, written to
# continue a clause (`and stop: `) and be continued (`, so …`) (#1779).
gp_parent_wait_text() {
  printf '%s' "the completion notification wakes the session or, arriving mid-call, is folded into the next tool result (97%, #845)"
}

# gp_subagent_wait_text — what a subagent is told where the parent is told to
# end its turn, written to continue a clause (`Instead: `, `then `) (#1735).
gp_subagent_wait_text() {
  printf '%s' "wait inside the turn — what you wait on in the foreground with \`timeout: 600000\`, a bg-run.sh job with \`$(gp_script_path bg-run.sh) wait <name>\`, or the blocked operation retried directly. You are a subagent: ending your turn ends your work for good, since nothing wakes you to resume it."
}

# ---------------------------------------------------------------------------
# gp_latch_path <id> — the marker path for one latch id in THIS session, for a
# caller keeping something of its own beside the latches (mantahostels#2411).
#
# guard-claimed-bash-write.sh's session ledger is the one external caller, under
# a `led.` namespace of its own (mantahostels#1905).
#
# PRINTS NOTHING ON FAILURE. 1 is the unresolved root, guard-root.sh's disarm
# signal; 2 and 3 are gp_agent_key's own codes, passed through rather than
# collapsed, so a caller can tell an unparsed payload from a missing session id.
# It logs nothing itself: what a missing latch costs is the caller's to say, not
# this file's.
#
# gp_rule DOES NOT ROUTE THROUGH IT, and that fourth empty-root check stays
# (mantahostels#2423): its faults exit through _gp_rule_open rather than returning, and its
# loop needs the key's two halves for a marker per id, not one path.
#
# THE ID IS SANITISED HERE AND NOT AT THE CALL SITE. Public, this argument is no
# longer bounded by rule-text.sh's id pattern. The dot stays legal: the
# namespaces (`warn.`, `led.`) are spelled with it, and with no slash it cannot
# walk anywhere.
gp_latch_path() {
  local key id="${1//[^A-Za-z0-9_.-]/_}"
  [[ -n "$(gr_root)" ]] || return 1
  key="$(gp_agent_key)" || return $?
  _gp_rule_marker "$id" "${key%% *}" "${key#* }"
}

# ---------------------------------------------------------------------------
# gp_rule_told / gp_rule_mark_told — the bound on a guard's own `rule_text` splice
# (mantahostels#2275, on mantahostels#2055's census).
#
# gp_rule's latch is unreachable from a guard that composes its own text: it
# resolves the fragment itself, consults no marker, and so pays the whole
# fragment again on every firing. Behind a denial that is self-limiting, the
# command never running; on a WARN it is not.
#
#   if gp_rule_told <id>; then …          already delivered this session
#   gp_rule_mark_told <id>                record that it now has been
#
# TWO CALLS, NOT ONE, because the emission sits between them (mantahostels#2261).
#
# ITS OWN NAMESPACE, `warn.<id>`, never gp_rule's own marker: shared, a
# pre-emptive injection would silence the rule inside a later REFUSAL, which is
# the one place it must always be stated. A rule id cannot contain a dot
# (rule-text.sh's id pattern), so the two namespaces cannot collide — while
# `.rule-injected-*-<sid>` still globs it, so scripts/clear-rule-latch.sh clears
# it at a compaction and arbiter-markers.js sweeps it, exactly as for gp_rule.
#
# FAILS OPEN TOWARDS TELLING. An unresolved root, a missing jq or an unreadable
# session id all report NOT told, so the rule arrives whole — and each is
# recorded with gl_log. gl_log, never gl_open: that exits, and a query function
# must answer. THE UNRESOLVED-ROOT ARM IS FILED UNDER NO PROJECT — gl_log slugs
# the root into the directory name, and with none to slug it files under
# `projects/unresolved-root/` instead, which check-guard-errors.js reads
# separately and reports in every project (mantahostels#2438).
#
# The names are `gp_rule_`-prefixed and still invisible to EMIT_RULE_RE in
# scripts/lib/rule-emission.js, which requires whitespace straight after
# `gp_rule`.

# BOTH TAKE THEIR PATH FROM gp_latch_path (mantahostels#2423), so both inherit its id
# sanitisation, and both bare one `rule:` first so `warn.rule:x` and `warn.x` are
# one latch, as gp_rule's own two spellings are (mantahostels#2719). gp_rule's own marker
# passes _gp_rule_marker an id gp_rule bared for itself, so the two families
# reach the same place by different routes and neither sanitises the other's.
#
# `local path rc` AND THE ASSIGNMENT ARE SEPARATE LINES ON PURPOSE. `local
# path="$(…)"` returns local's status, always 0, so the `||` branch never fires
# and the fault goes unrecorded. Nothing tests the collapse.
gp_rule_told() {
  local path rc
  path="$(gp_latch_path "warn.$(_gp_bare_id "$1")")" || {
    rc=$?
    _gp_told_fault "$1" "$rc" "unlatchable, delivered again"
    return 1
  }
  [[ -f "$path" ]]
}

gp_rule_mark_told() {
  local path rc
  path="$(gp_latch_path "warn.$(_gp_bare_id "$1")")" || {
    rc=$?
    _gp_told_fault "$1" "$rc" "left unlatched"
    return 0
  }
  : >"$path" 2>/dev/null ||
    gl_log "latch marker unwritable — rule $1 will be delivered again"
}

# gp_rule_given <id> — 0 where gp_rule has already injected <id> this session,
# for a caller whose own notice rides only with the rule's first telling (#2024).
# It reads gp_rule's own marker, through the same _gp_rule_marker, never
# gp_rule_told's `warn.` one. A key it cannot read answers 1, not given, which
# is gp_rule's own fail direction.
gp_rule_given() {
  local key
  [[ -n "$(gr_root)" ]] || return 1
  key="$(gp_agent_key)" || return 1
  [[ -f "$(_gp_rule_marker "$(_gp_bare_id "$1")" "${key%% *}" "${key#* }")" ]]
}

# The fault sentence for one gp_latch_path failure, in the caller's own words:
# `$1` the rule id, `$2` gp_latch_path's exit code, `$3` what the caller loses by
# it. 1 is the unresolved root and 2/3 are the key's, reported as one fault: the
# caller cannot act on the difference.
_gp_told_fault() {
  case "$2" in
    1) gl_log "repo root unresolved — rule $1 $3" ;;
    *) gl_log "no session key — rule $1 $3" ;;
  esac
}

# gp_rule_skip <id> [<id>...] — take ids OUT of the next gp_rule call (mantahostels#1805).
#
# THE ALTERNATIVE TO THIS FUNCTION was a caller building its id list in an array
# and passing `"${ids[@]}"`, which works at run time and is INVISIBLE to
# scripts/check-guard-registry.js: that gate reads the literal ids at the call
# site to decide which guard prints which fragment, so every scoped-away
# fragment would report UNPRINTED-RULE.
#
# So a scoped caller names EVERY id its trigger can carry, literally, and says
# separately which the command in front of it puts out of scope. The one array
# the readers expand is gp_rule_path_rows' table, below.
#
# An unknown id here is not a fault: it names something not being emitted.
#
# CONSUMED BY THE NEXT gp_rule CALL AND CLEARED THERE, so a guard with two calls
# does not silently inherit the first one's scoping.
# BARED like gp_rule's own arguments, so a scoping spelled `rule:x` still takes
# `x` out of the call (mantahostels#2719).
_gp_rule_skipped=()
gp_rule_skip() {
  local id
  for id in "$@"; do _gp_rule_skipped+=("$(_gp_bare_id "$id")"); done
}

# gp_rule_module <module> <id> [<id>...] — gp_rule_skip the ids unless the host
# lists <module> under "modules" (#449). Statement-initial and literal, because
# scripts/lib/rule-emission.js reads the call to leave the ids out of the
# budget of a host with the module off. Needs lib/wfc-config.sh sourced; without
# it every module reads as off.
gp_rule_module() {
  local module="$1"
  shift
  declare -F wfc_module_on >/dev/null 2>&1 && wfc_module_on "$module" && return 0
  gp_rule_skip "$@"
}

# gp_rule_path_rows <rel> <table> — for each row "<id> <path> [<module>...]" of
# the array named <table>, gp_rule_skip <id> unless <rel> is <path> and every
# <module> is on (#2302). The gp_rule call names the table's ids as
# "${<table>[@]%% *}", the one array spelling the static readers of gp_rule ids
# expand, from the table's literal `<table>=(` assignment of double-quoted rows
# (scripts/lib/rule-table.js).
gp_rule_path_rows() {
  local rel="$1" row module
  local -n _gp_rows="$2"
  local -a words
  for row in "${_gp_rows[@]}"; do
    read -ra words <<<"$row"
    [[ "$rel" == "${words[1]}" ]] || gp_rule_skip "${words[0]}"
    for module in "${words[@]:2}"; do gp_rule_module "$module" "${words[0]}"; done
  done
}

# gp_rule_unless_module <module> <id> [<id>...] — gp_rule_module's mirror: skip
# the ids where the host lists <module>, for the text a module replaces
# (#2409). Read by rule-emission.js the same way.
gp_rule_unless_module() {
  local module="$1"
  shift
  declare -F wfc_module_on >/dev/null 2>&1 && wfc_module_on "$module" || return 0
  gp_rule_skip "$@"
}

# gp_module_on <module> — 0 where the host lists <module>, read once a call. A
# config wfc_module_on cannot read, or refuses, reads as off and is logged with
# what it printed (#2409).
declare -A _gp_module_state=()
gp_module_on() {
  local module="$1" err
  if [[ -z "${_gp_module_state[$module]:-}" ]]; then
    _gp_module_state[$module]=off
    if err="$(wfc_module_on "$module" 2>&1 >/dev/null)"; then
      _gp_module_state[$module]=on
    elif [[ -n "$err" ]] && declare -F gl_log >/dev/null 2>&1; then
      gl_log "module $module read as off on a config fault" "$err"
    fi
  fi
  [[ "${_gp_module_state[$module]}" == on ]]
}

# gp_rule_prelude <text> — text that rides in the SAME envelope as the next
# gp_rule call's fragments, ahead of them (mantahostels#2369).
#
# IT EXISTS BECAUSE Claude Code reads ONE hook object per hook. A guard with
# something of its own to say — guard-file-claim.sh relaying
# session-arbiter.js's notes — could otherwise only print that object and let
# the rules defer, which for a session making a single guarded write means they
# never arrive at all.
#
# IT SPENDS GP_RULE_CAP BUT IS NOT BOUNDED BY IT. A prelude that alone exceeds
# the ceiling is still emitted whole: it is the caller's own text, not a rule,
# and a notice truncated mid-sentence is worse than a long envelope.
#
# CONSUMED BY THE NEXT gp_rule CALL AND CLEARED THERE.
#
# Invisible to EMIT_RULE_RE in scripts/lib/rule-emission.js for gp_rule_told's
# reason.
_gp_rule_prelude=""
gp_rule_prelude() { _gp_rule_prelude="$1"; }

# gp_rule_latch_after <id> — hand the NEXT gp_rule call the prelude's own latch
# key, to be marked told after the envelope renders (mantahostels#2528).
#
# IT EXISTS BECAUSE gp_rule EXITS. A caller latching its prelude itself can only
# do so BEFORE the call, which is mantahostels#2261's order inverted. gp_rule marks this key
# where it marks the ids — after _gp_emit_context returns.
#
# THE KEY IS gp_rule_told's, `warn.<id>`, so a caller still TESTS with
# gp_rule_told and simply stops calling gp_rule_mark_told itself.
#
# EVERY FAIL PATH LEAVES IT UNLATCHED, deliberately: the fail-OPEN arms that do
# still emit the prelude (_gp_rule_open) and the store faults that print it on
# stderr (_gp_rule_refuse_prelude) all re-say it on the next trigger rather than
# reason about whether it landed.
#
# CONSUMED BY THE NEXT gp_rule CALL AND CLEARED THERE, on gp_rule_skip's
# precedent. A ZERO-ID gp_rule call consumes neither this nor the prelude: it
# returns before the clear.
#
# MARKED_RULE_RE in scripts/lib/rule-emission.js reads this name alongside
# gp_rule_mark_told, so a deferred mark still closes the bound
# check-context-budget.js reports on — BUT ONLY WHERE THE ID IS A LITERAL.
# Spell either half as a literal and the other must be one too.
_gp_rule_prelude_latch=""
gp_rule_latch_after() { _gp_rule_prelude_latch="$1"; }

# gp_rule's fail-OPEN exits, when a prelude is being held. gl_open writes nothing
# to stdout, so an unqualified one would swallow the caller's own notice along
# with the rules it was riding with.
#
# THE MISSING-JQ ARM IS THE ONE IT CANNOT SAVE, jq being what renders the
# envelope. There the prelude is lost.
_gp_rule_open() {
  [[ -z "$_gp_rule_prelude" ]] || _gp_emit_context "$_gp_rule_prelude"
  gl_open "$1"
}

# The same, for gp_rule's fail-CLOSED exits — a store fault, which refuses the
# tool call. The refusal travels on stderr, so the prelude goes there too rather
# than into an additionalContext the harness discards on exit 2.
#
# IT TAKES THE TEXT rather than reading the global, because the last of its three
# call sites sits past the point where gp_rule clears that global into a local.
_gp_rule_refuse_prelude() {
  [[ -z "$1" ]] ||
    printf 'gp_rule: the caller also had this to say:\n%s\n' "$1" >&2
}

gp_rule() {
  (($# > 0)) || return 0

  # --- payload side: fail open, on the record ---
  # The latch root first, because an empty one puts every marker at
  # `/.rule-injected-…` — outside any repo, and writable where the hook runs as
  # root. Injecting nothing costs a session its rules; writing there costs every
  # session on the machine a latch that no compaction clears.
  [[ -n "$(gr_root)" ]] ||
    _gp_rule_open "the repo root did not resolve — rule injection skipped"
  [[ -n "$_gp_payload" ]] ||
    _gp_rule_open "no payload — rule injection skipped"
  command -v jq >/dev/null 2>&1 ||
    _gp_rule_open "jq not found — rule injection skipped"
  local key agent sid
  key="$(gp_agent_key)" || case $? in
    3) _gp_rule_open "no session_id in payload — rule injection skipped" ;;
    *) _gp_rule_open "payload did not parse as JSON — rule injection skipped" ;;
  esac
  agent="${key%% *}"
  sid="${key#* }"

  # --- store side: fail closed ---
  if ! _gp_load_rule_text; then
    # Recorded as well as printed: exit 2 reaches the session that tripped it
    # and nobody else, while check-guard-errors.js reads the log under
    # `npm run status`.
    gl_log "rule-text store unloadable — refusing, rules: $*"
    printf 'gp_rule: the rule-text store (%s/rule-text.sh) could not be loaded, so rules %s cannot be stated.\n' \
      "${BASH_SOURCE[0]%/*}" "$*" >&2
    _gp_rule_refuse_prelude "$_gp_rule_prelude"
    gl_exit 2
  fi

  # RESOLVED AS GIVEN, KEYED BARE (mantahostels#2719). The store's accessor strips one
  # leading `rule:` itself, so handing it the caller's own spelling keeps gp_rule
  # to the one-strip contract: `rule:rule:x` refuses here exactly as the fetcher
  # refuses it.
  local id bid text
  local -a _gp_ids=()
  local -A _gp_texts=()
  for id in "$@"; do
    if ! text="$(rule_text "$id" 2>&1)"; then
      gl_log "rule fragment unreadable — refusing: $text"
      printf 'gp_rule: %s\n' "$text" >&2
      _gp_rule_refuse_prelude "$_gp_rule_prelude"
      gl_exit 2
    fi
    bid="$(_gp_bare_id "$id")"
    _gp_texts["$bid"]="$text"
    _gp_ids+=("$bid")
  done

  # --- the latch ---
  # A caller that names the same id twice gets it once: the marker is not
  # written until after this loop, so the second mention would otherwise pass
  # the same test and be concatenated onto itself.
  local -a _gp_want=()
  local -A _gp_seen=()
  for id in "${_gp_ids[@]}"; do
    if [[ -n "${_gp_seen[$id]:-}" ]]; then continue; fi
    _gp_seen["$id"]=1
    # Scoped out by the caller (mantahostels#1805). Deliberately BEFORE the latch test and
    # after the store read: the fragment is still resolved, so a skipped id that
    # names nothing is still a store fault, and it is left UNLATCHED, so the
    # next command it does apply to gets it whole.
    local skipped
    for skipped in ${_gp_rule_skipped+"${_gp_rule_skipped[@]}"}; do
      [[ "$skipped" == "$id" ]] && continue 2
    done
    if [[ -f "$(_gp_rule_marker "$id" "$agent" "$sid")" ]]; then continue; fi
    _gp_want+=("$id")
  done
  # Spent: see gp_rule_skip's header. Cleared after the want-list is built and
  # before the emission, so this function's own exit cannot skip it.
  _gp_rule_skipped=()
  # Spent for the same reason, and taken into a local so no exit further down can
  # skip the clear (mantahostels#2369). Everything past this line reads `$prelude`; the two
  # store faults above it read the global.
  local prelude="$_gp_rule_prelude"
  _gp_rule_prelude=""
  local prelude_latch="$_gp_rule_prelude_latch"
  _gp_rule_prelude_latch=""

  # A prelude still goes out with every id latched or scoped away — it is the
  # caller's own notice, not a rule.
  if ((${#_gp_want[@]} == 0)); then
    [[ -n "$prelude" ]] || return 0
    _gp_emit_context "$prelude" ||
      gl_open "the prelude envelope did not render"
    [[ -z "$prelude_latch" ]] || gp_rule_mark_told "$prelude_latch"
    exit 0
  fi

  # --- the cap ---
  local out="$prelude" sep="" candidate
  [[ -z "$out" ]] || sep=$'\n\n'
  local -a _gp_emitted=()
  for id in "${_gp_want[@]}"; do
    candidate="$out$sep${_gp_texts[$id]}"
    if (($(_gp_rule_len "$candidate") > GP_RULE_CAP)); then
      # A fragment that cannot fit an EMPTY envelope can never be injected at
      # all, which is a store fault. One squeezed out by a prelude or by a
      # higher-priority id simply defers — the second test tells the two apart.
      if ((${#_gp_emitted[@]} == 0)) &&
        (($(_gp_rule_len "${_gp_texts[$id]}") > GP_RULE_CAP)); then
        gl_log "rule fragment over the emission ceiling — refusing: $id"
        printf 'gp_rule: the fragment for rule id "%s" is %s bytes, over the %d-byte emission ceiling, so it can never be injected. Split the rule or shorten the fragment.\n' \
          "$id" "$(_gp_rule_len "${_gp_texts[$id]}")" "$GP_RULE_CAP" >&2
        _gp_rule_refuse_prelude "$prelude"
        gl_exit 2
      fi
      break # this id and every lower-priority one defer, unlatched
    fi
    out="$candidate"
    sep=$'\n\n'
    _gp_emitted+=("$id")
  done

  # --- the emission, THEN the latch (mantahostels#2261) ---
  # IT SHRINKS THE WINDOW, IT DOES NOT CLOSE IT. A cancellation inside the
  # marker loop below still latches the ids already written and loses the rest,
  # reproducing mantahostels#2261 on a subset.
  _gp_emit_context "$out" ||
    gl_open "the rule envelope did not render — left unlatched: ${_gp_emitted[*]:-none, prelude only}"

  # A marker that cannot be written costs one repeated injection, so it is not
  # worth failing the hook over.
  for id in "${_gp_emitted[@]}"; do
    : >"$(_gp_rule_marker "$id" "$agent" "$sid")" 2>/dev/null || true
  done
  [[ -z "$prelude_latch" ]] || gp_rule_mark_told "$prelude_latch"

  exit 0
}

# The store's accessor, sourced at first use rather than at the top of this
# file: a guard that never states a rule should not pay for it.
_gp_load_rule_text() {
  declare -F rule_text >/dev/null 2>&1 && return 0
  # shellcheck source=scripts/lib/rule-text.sh
  source "${BASH_SOURCE[0]%/*}/rule-text.sh" 2>/dev/null || true
  declare -F rule_text >/dev/null 2>&1
}

# gp_rule_text <id> <fallback> — print a rule's fragment for a guard to splice
# into its own refusal or warning, or <fallback> where the store cannot give it
# (#772).
#
# FAILS CLOSED ON THE WORDING ONLY: the command in front of the guard is known
# bad, only its rule is unreadable, so the caller still refuses or warns —
# carrying a fallback that names the fragment's file — and nothing is logged.
# An unreadable fragment is check-guard-registry.js's assertion, not a guard's.
#
# THE ID MUST BE A LITERAL at the call site: scripts/lib/rule-emission.js reads
# this function's calls as it reads a direct fetch (DIRECT_RULE_RE), so an id
# built at runtime leaves its fragment reported unprinted.
gp_rule_text() {
  local text
  if _gp_load_rule_text && text="$(rule_text "$1" 2>/dev/null)"; then
    printf '%s' "$text"
    return 0
  fi
  printf '%s' "${2-}"
}

# Render a flattened segment for a human: the split blanked every quoted span to
# $QUOTED, so echoing one back raw prints the sentinel byte. Also drops the
# leading whitespace the flattening leaves behind.
gp_unmask() {
  local s="$1" out="" idx
  while [[ "$s" == *"$QUOTED"* ]]; do
    out+="${s%%"$QUOTED"*}"
    s="${s#*"$QUOTED"}"
    # Eat the index the masker glued on (mantahostels#183). A sentinel without one is not
    # something this file writes, so it is rendered and left alone.
    idx="${s%%$'\x01'*}"
    [[ "$idx" =~ ^[0-9]+$ ]] && s="${s#*$'\x01'}"
    out+='"…"'
  done
  out+="$s"
  printf '%s' "${out#"${out%%[![:space:]]*}"}"
}

# gp_as_written <masked text> — print it as typed, each quoted span back inside
# its own quotes: _gp_as_written's, for a guard handing a command back to be
# re-issued (#519). Safe in a command substitution, reading $_gp_spans alone.
gp_as_written() {
  _gp_as_written "$1"
  printf '%s' "$_gp_written"
}

# gp_literal <word> — print the text of a word whose quoted spans the split
# blanked, put back. Non-zero means some of it could not be read: an unexpanded
# $VAR, a command substitution, or a sentinel naming a span never recorded.
#
# It prints what it can EITHER WAY, so a caller can judge on the visible part
# and treat the rest as hidden.
#
# It only READS $_gp_spans, so unlike the maskers it is safe in a command
# substitution.
gp_literal() {
  local s="$1" out="" lit idx span kind rc=0
  while [[ "$s" == *"$QUOTED"* ]]; do
    lit="${s%%"$QUOTED"*}"
    s="${s#*"$QUOTED"}"
    idx="${s%%$'\x01'*}"
    if [[ "$idx" =~ ^[0-9]+$ ]] && [[ -n "${_gp_spans[idx]+set}" ]]; then
      s="${s#*$'\x01'}"
      span="${_gp_spans[idx]}"
      kind="${span:0:1}"
      span="${span:1}"
      # A single-quoted span is literal whatever it holds; a double-quoted one
      # carrying an expansion is only partly known.
      case "$kind" in
        "'") ;;
        *) case "$span" in *'$'* | *'`'*) rc=1 ;; esac ;;
      esac
    else
      span=""
      rc=1
    fi
    case "$lit" in *'$'* | *'`'*) rc=1 ;; esac
    out+="$lit$span"
  done
  case "$s" in *'$'* | *'`'*) rc=1 ;; esac
  printf '%s' "$out$s"
  return "$rc"
}

# gp_norm_abs <absolute path> — collapse `.`, `..` and doubled slashes, so two
# spellings of one path compare equal as STRINGS. `/repo/./a.md` and
# `/repo/a.md` both come back `/repo/a.md`.
#
# TEXTUAL, and deliberately not _gp_canon, whose `realpath -m` resolves
# symlinks: session-arbiter.js's relativeToRepo is `path.resolve`, lexical, so a
# symlink-resolved answer here would disagree with the arbiter's on a symlinked
# checkout (mantahostels#3315).
#
# ONE LINE ONLY. `read` stops at the first newline, so a path holding one comes
# back truncated. A pathspec word or `cd` target spelled that way is vanishingly
# rare and every caller fails towards its own safe verdict.
gp_norm_abs() {
  local _gp_part
  local -a _gp_out=() _gp_parts=()
  # `read -ra`, not `for part in $1`: word-splitting an unquoted expansion also
  # GLOBS it, so a directory named `*` would expand against the caller's cwd.
  IFS=/ read -ra _gp_parts <<<"$1"
  for _gp_part in ${_gp_parts+"${_gp_parts[@]}"}; do
    case "$_gp_part" in
      '' | .) ;;
      ..) ((${#_gp_out[@]})) && unset '_gp_out[-1]' ;;
      *) _gp_out+=("$_gp_part") ;;
    esac
  done
  # `${_gp_out[*]}` joins on IFS's first character, which is what makes this a
  # path again rather than a space-separated list.
  local IFS=/
  printf '/%s' "${_gp_out[*]}"
}

# gp_repo_rel <absolute path> <root> — the path relative to <root>, through
# gp_norm_abs, so a `..` anywhere in it is resolved before the root is stripped
# (#2546). Non-zero, printing nothing, where it lies outside <root> or is <root>
# itself. A relative path reads as outside: the harness sends a file tool's
# path absolute.
#
# A path the lexical test puts outside is tried again with its deepest existing
# directory resolved by gr_physical, as gr_root resolves <root> (#2553). The
# harness hands hooks CLAUDE_PROJECT_DIR already physical but a file tool's path
# as the model spelled it, so a write named through a symlink to the checkout
# would otherwise read as outside. A miss pays a fork per level walked, never an
# exec. The walk starts from the lexical form, so `..` resolves lexically on both
# tries (mantahostels#3315).
gp_repo_rel() {
  local _gp_p _gp_r="${2%/}" _gp_d _gp_tail="" _gp_real
  [[ "$1" == /* ]] || return 1
  _gp_p="$(gp_norm_abs "$1")"
  if [[ "$_gp_p" != "$_gp_r"/?* ]]; then
    _gp_d="$_gp_p"
    until _gp_real="$(gr_physical "${_gp_d:-/}")"; do
      # Ends here where guard-root.sh did not load, as `/` always resolves.
      [[ -n "$_gp_d" ]] || return 1
      _gp_tail="/${_gp_d##*/}$_gp_tail"
      _gp_d="${_gp_d%/*}"
    done
    _gp_p="$(gp_norm_abs "$_gp_real$_gp_tail")"
    [[ "$_gp_p" == "$_gp_r"/?* ]] || return 1
  fi
  printf '%s' "${_gp_p#"$_gp_r"/}"
}

# Absolute, symlink-resolved, so two spellings of one path compare equal.
_gp_canon() {
  local p="$1"
  [[ -n "$p" ]] || return 1
  if command -v realpath >/dev/null 2>&1; then
    realpath -m -- "$p" 2>/dev/null
  else
    printf '%s' "$p"
  fi
}

# A path we cannot resolve now (an unexpanded variable, or a quoted span already
# blanked out) must not produce a verdict.
_gp_resolvable() {
  case "$1" in
    "" | *'$'* | *'`'* | *"$QUOTED"*) return 1 ;;
    *) return 0 ;;
  esac
}

# Does a word start after text $1 — nothing before it, or whitespace or a
# control operator? A span's closing sentinel byte is neither, so `"a"#b` is one
# word.
_gp_word_start() {
  [[ -z "$1" || "$1" == *[[:space:]\;\&\|\(\)] ]]
}

# THE LEXER (#490, #510). One left-to-right state machine, as shell lexes, that
# blanks each outermost quoted span to $QUOTED<index>\x01 and records its text in
# $_gp_spans. Every pass that asks whether a quote is open asks it, so no two of
# them can disagree.
#
# RESUMABLE: _gp_lex consumes text and leaves its state behind, so the line
# join feeds each line once rather than re-lexing the whole join on every line
# (#510). Feed it a line at a time — every step copies the rest of what it was
# fed.
#
# The first quote opens the span and the other kind is literal inside it; a
# backslash outside a `'…'` escapes the next character; `$'…'` takes backslash
# escapes, after an odd run of `$` only, `$$` being the shell's pid. Inside a
# `"…"`, a `$(` is read to its own close, so the quotes of the command inside —
# `--body "$(cat <<'EOF'` and a body quoting "a phrase" — close nothing.
#
# Inside a `$(…)`, brackets nest, quotes open spans of their own, and a
# heredoc's body runs from the end of its opener's line to its terminator line.
# `case` patterns and `#` comments there are not read.
#
# A span's text is the raw text between its quotes. $_gp_lx_st is the stack of
# open frames, innermost last: S `'…'`, E `$'…'`, D `"…"`, C `$(…)`, H a heredoc
# body inside a C. Each frame's slot in the three arrays is its depth, written
# on every push so the arrays stay dense for _gp_lx_save: a C's bracket depth
# and the heredoc its line has opened, an H's terminator.
_gp_lx_reset() {
  _gp_lx_st="" _gp_lx_out="" _gp_lx_span="" _gp_lx_q="" _gp_lx_prefix=""
  _gp_lx_bs=0 _gp_lx_cmt=0 _gp_lx_hline=""
  _gp_lx_depth=() _gp_lx_term=() _gp_lx_dash=()
}

# Set the lexer's state aside, and put it back, around a lex that must not move
# it on. One slot: never nested.
_gp_lx_save() {
  _gp_lx_saved=("$_gp_lx_st" "$_gp_lx_out" "$_gp_lx_span" "$_gp_lx_q" "$_gp_lx_prefix" "$_gp_lx_bs" "$_gp_lx_cmt" "$_gp_lx_hline")
  _gp_lx_saved_depth=(${_gp_lx_depth+"${_gp_lx_depth[@]}"})
  _gp_lx_saved_term=(${_gp_lx_term+"${_gp_lx_term[@]}"})
  _gp_lx_saved_dash=(${_gp_lx_dash+"${_gp_lx_dash[@]}"})
}
_gp_lx_load() {
  _gp_lx_st="${_gp_lx_saved[0]}" _gp_lx_out="${_gp_lx_saved[1]}" _gp_lx_span="${_gp_lx_saved[2]}"
  _gp_lx_q="${_gp_lx_saved[3]}" _gp_lx_prefix="${_gp_lx_saved[4]}" _gp_lx_bs="${_gp_lx_saved[5]}"
  _gp_lx_cmt="${_gp_lx_saved[6]}" _gp_lx_hline="${_gp_lx_saved[7]}"
  _gp_lx_depth=(${_gp_lx_saved_depth+"${_gp_lx_saved_depth[@]}"})
  _gp_lx_term=(${_gp_lx_saved_term+"${_gp_lx_saved_term[@]}"})
  _gp_lx_dash=(${_gp_lx_saved_dash+"${_gp_lx_saved_dash[@]}"})
}

# _gp_lx_push <frame> [<term> <dash>]
_gp_lx_push() {
  local n=${#_gp_lx_st}
  _gp_lx_st+="$1"
  _gp_lx_depth[n]=1
  _gp_lx_term[n]="${2-}"
  _gp_lx_dash[n]="${3-}"
}

# Open the frame a `'` opens after text $1: `$'…'` after an odd run of `$`,
# `$$` being the shell's pid, `'…'` otherwise.
_gp_lx_single() {
  local dollars="${1##*[!\$]}"
  if ((${#dollars} % 2)); then _gp_lx_push E; else _gp_lx_push S; fi
}

# Close the innermost frame on its closing character $1. Closing the outermost
# records the span and blanks it.
_gp_lx_pop() {
  _gp_lx_st="${_gp_lx_st%?}"
  if [[ -n "$_gp_lx_st" ]]; then
    _gp_lx_span+="$1"
    return
  fi
  _gp_spans+=("$_gp_lx_q$_gp_lx_span")
  _gp_lx_out+="$QUOTED$((${#_gp_spans[@]} - 1))"$'\x01'
  _gp_lx_span=""
}

# _gp_lx_step <bracket pattern> — split the caller's $r at its first character
# matching the pattern: the text before into $p, that character into $c, the
# rest back into $r. Non-zero where none matches, $p then holding all of $r.
_gp_lx_step() {
  [[ "$r" == *$1* ]] || {
    p="$r"
    r=""
    return 1
  }
  # shellcheck disable=SC2295 # $1 is a glob pattern, matched as one on purpose.
  p="${r%%$1*}"
  c="${r:${#p}:1}"
  r="${r:${#p}+1}"
}

# _gp_lex <text> — consume $1 from the state the last call left.
#
# A long line goes in 512-character pieces, each step copying only the rest of its
# piece, or one long line would still be quadratic (#510). A piece ends on a
# space no lookahead crosses: never one after `<` or `-`, which a heredoc
# opener's delimiter may follow, nor after another space.
_gp_lex() {
  local s="$1" head cut n
  while ((${#s} > 512)); do
    head="${s:0:512}"
    cut="${head%[!<[:space:]-][[:space:]]*}"
    n=$((${#cut} == 512 ? 512 : ${#cut} + 2))
    _gp_lex_piece "${s:0:n}"
    s="${s:n}"
  done
  _gp_lex_piece "$s"
}

_gp_lex_piece() {
  local r="$1" p c f n m line
  ((_gp_lx_lexed += ${#1}, _gp_lx_widest = ${#1} > _gp_lx_widest ? ${#1} : _gp_lx_widest))
  while [[ -n "$r" ]]; do
    # The character a backslash escaped. At top level a `\`-newline is no break
    # to bash, so both vanish.
    if ((_gp_lx_bs)); then
      _gp_lx_bs=0
      c="${r:0:1}"
      r="${r:1}"
      if [[ -n "$_gp_lx_st" ]]; then
        _gp_lx_span+="$c"
      elif [[ "$c" != $'\n' ]]; then
        _gp_lx_out+="\\$c"
      fi
      continue
    fi
    f="${_gp_lx_st: -1}"
    n=$((${#_gp_lx_st} - 1))
    case "$f" in
      '')
        # A `#` opening a word comments out the rest of its line, quotes and a
        # trailing `\` included, so bash neither runs nor continues it.
        if ((_gp_lx_cmt)); then
          [[ "$r" == *$'\n'* ]] || break
          r=$'\n'"${r#*$'\n'}"
          _gp_lx_cmt=0
        fi
        _gp_lx_step "[\'\"\\\\#]" || {
          _gp_lx_out+="$p"
          break
        }
        _gp_lx_out+="$p"
        case "$c" in
          '#')
            if _gp_word_start "$_gp_lx_out"; then
              _gp_lx_cmt=1
            else
              _gp_lx_out+="#"
            fi
            ;;
          \\) _gp_lx_bs=1 ;;
          *)
            _gp_lx_prefix="$_gp_lx_out"
            _gp_lx_q="$c"
            _gp_lx_opens=$((_gp_lx_opens + 1))
            if [[ "$c" == '"' ]]; then _gp_lx_push D; else _gp_lx_single "$p"; fi
            ;;
        esac
        ;;
      S)
        _gp_lx_step "\'" || {
          _gp_lx_span+="$p"
          break
        }
        _gp_lx_span+="$p"
        _gp_lx_pop "$c"
        ;;
      E | D)
        if [[ "$f" == E ]]; then
          _gp_lx_step "[\'\\\\]"
        else
          _gp_lx_step '["\\$]'
        fi || {
          _gp_lx_span+="$p"
          break
        }
        _gp_lx_span+="$p"
        case "$c" in
          \\)
            _gp_lx_span+="$c"
            _gp_lx_bs=1
            ;;
          '$')
            _gp_lx_span+="$c"
            [[ "$r" == '('* ]] && {
              _gp_lx_span+="("
              r="${r:1}"
              _gp_lx_push C
            }
            ;;
          *) _gp_lx_pop "$c" ;;
        esac
        ;;
      C)
        _gp_lx_step $'[()\'"\\\\<\n]' || {
          _gp_lx_span+="$p"
          break
        }
        _gp_lx_span+="$p$c"
        case "$c" in
          '(') ((_gp_lx_depth[n]++)) ;;
          # A C is never outermost, so it closes without _gp_lx_pop.
          ')') ((--_gp_lx_depth[n])) || _gp_lx_st="${_gp_lx_st%?}" ;;
          \\) _gp_lx_bs=1 ;;
          "'") _gp_lx_single "$p" ;;
          '"') _gp_lx_push D ;;
          '<')
            # A `<<<` here-string opens no body; its third `<` must not read as one.
            [[ "$r" == '<<'* ]] && {
              _gp_lx_span+="<<"
              r="${r:2}"
              continue
            }
            [[ -z "${_gp_lx_term[n]}" && "$r" =~ ^\<(-?)[[:space:]]*\\?([\'\"]?)([A-Za-z_][A-Za-z0-9_]*)([\'\"]?) ]] &&
              [[ "${BASH_REMATCH[2]}" == "${BASH_REMATCH[4]}" ]] || continue
            m="${BASH_REMATCH[0]}"
            _gp_lx_dash[n]="${BASH_REMATCH[1]}"
            _gp_lx_term[n]="${BASH_REMATCH[3]}"
            _gp_lx_span+="$m"
            r="${r:${#m}}"
            ;;
          *)
            # A newline. Where a heredoc opened on the line it ends, its body
            # runs from here to the terminator line.
            [[ -n "${_gp_lx_term[n]}" ]] || continue
            _gp_lx_push H "${_gp_lx_term[n]}" "${_gp_lx_dash[n]}"
            _gp_lx_term[n]=""
            _gp_lx_hline=""
            ;;
        esac
        ;;
      H)
        _gp_lx_step $'\n' || {
          _gp_lx_span+="$p"
          _gp_lx_hline+="$p"
          break
        }
        _gp_lx_span+="$p$c"
        line="$_gp_lx_hline$p"
        _gp_lx_hline=""
        [[ -n "${_gp_lx_dash[n]}" ]] && line="${line#"${line%%[!$'\t']*}"}"
        [[ "$line" == "${_gp_lx_term[n]}" ]] && _gp_lx_st="${_gp_lx_st%?}"
        ;;
    esac
  done
}

# Is a quote — or, as `\`, a line still to come — open where the lexer stands?
# Into $_gp_mask_open, leaving the state to be fed on.
_gp_lx_open() {
  _gp_mask_open=""
  if [[ -n "$_gp_lx_st" ]]; then
    _gp_mask_open="$_gp_lx_q"
  elif ((_gp_lx_bs)); then
    _gp_mask_open=\\
  fi
}

# The masked text so far, into $_gp_masked. An UNTERMINATED quote is left alone:
# the rest of the text is literal.
_gp_lx_end() {
  _gp_lx_open
  if [[ -n "$_gp_lx_st" ]]; then
    _gp_masked="$_gp_lx_prefix$_gp_lx_q$_gp_lx_span"
  else
    _gp_masked="$_gp_lx_out"
  fi
}

# Blank every quoted span out of $1, into $_gp_masked, recording each in
# $_gp_spans so gp_literal and _gp_path_arg can read it back (mantahostels#183). Sets
# $_gp_mask_open to the quote left unclosed, or empty — `\` where the text ends
# in a line still to come. Resets the lexer.
_gp_mask_both() {
  local -a _gp_lines
  local i
  _gp_lx_reset
  mapfile -t _gp_lines <<<"$1"
  for i in "${!_gp_lines[@]}"; do
    ((i)) && _gp_lex $'\n'
    _gp_lex "${_gp_lines[i]}"
  done
  _gp_lx_end
}

# Expand $VAR and ${VAR} in $1 from the command string's own assignments and
# then the guard's OWN environment, into $_gp_expanded. Non-zero means the text
# cannot be resolved and the caller must fall back to failing open.
#
# This is what lets a worktree path spelled through a variable be judged
# (mantahostels#183), such as `"$CLAUDE_PROJECT_DIR/.claude/worktrees/<name>"`: a hook
# process inherits CLAUDE_JOB_DIR and CLAUDE_PROJECT_DIR — verified by
# name-issue-session.sh, a hook that writes $CLAUDE_JOB_DIR/state.json.
#
# A name the command assigned itself wins over the environment, which is what
# shell does — `WT=<shared tree> && git -C "$WT" checkout -b x` moved the shared
# tree and was allowed unchecked (mantahostels#208, correcting mantahostels#183).
#
# DELIBERATELY NARROW. It refuses, rather than guessing, on: command
# substitution, every ${VAR<operator>…} form, an unset or empty variable, and a
# value carrying whitespace or a shell metacharacter — which is not a path this
# guard should build a verdict on. Nothing here ever runs the text.
_gp_expand_vars() {
  local s="$1" out="" name val
  case "$s" in *'$('* | *'`'*) return 1 ;; esac
  while [[ "$s" == *'$'* ]]; do
    out+="${s%%\$*}"
    s="${s#*\$}"
    if [[ "$s" == '{'* ]]; then
      [[ "$s" == *'}'* ]] || return 1
      name="${s#\{}"
      name="${name%%\}*}"
      s="${s#*\}}"
    elif [[ "$s" =~ ^[A-Za-z_][A-Za-z0-9_]* ]]; then
      name="${BASH_REMATCH[0]}"
      s="${s#"$name"}"
    else
      return 1
    fi
    # Anything but a bare name — ${VAR:-x}, ${#VAR}, ${!VAR}, $1 — is refused.
    [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || return 1
    if [[ -n "${_gp_locals_dead[$name]+set}" ]]; then
      # Assigned by the command in a way this file will not resolve. The
      # environment must NOT be consulted as a fallback: the command overwrote
      # the name, so an inherited value of it is the wrong path.
      return 1
    elif [[ -n "${_gp_locals[$name]+set}" ]]; then
      val="${_gp_locals[$name]}"
      [[ -z "$val" ]] && _gp_provably_empty "$name" 1 && continue
    elif [[ -v "$name" ]]; then
      val="${!name}"
    else
      _gp_provably_empty "$name" 0 && continue
      return 1
    fi
    case "$val" in "" | *[\$\`\'\"\;\|\&\(\)\<\>\*\?[:space:]]*) return 1 ;; esac
    out+="$val"
  done
  _gp_expanded="$out$s"
}

# Resolve one path argument — a `cd` target or a `git -C` value — into $_gp_path.
# Non-zero means it stays unresolved and the caller fails open, as before.
#
# ONE non-zero return is not a fail-open, and $_gp_path_empty tells it apart
# (#301): the argument resolved fully and resolved to the EMPTY STRING, which
# only a literal `""` can produce. `git -C ""` and `cd ""` both run against the
# cwd (measured, git 2.43.0 / bash 5.2).
#
# The word arrives already masked, so a fully literal `cd "/abs/path"` reaches
# here as the sentinel alone and was unresolvable for that reason alone (mantahostels#183).
_gp_path_arg() {
  local raw="$1" rest lit idx span kind out=""
  _gp_path_empty=0
  _gp_path_names=""
  # An unquoted leading `~` is the shell's to expand (mantahostels#3453). A quoted one
  # arrives as a sentinel and never matches. `~user` is refused, not looked up.
  case "$raw" in
    \~ | \~/*)
      _gp_expand_vars "\$HOME" || return 1
      raw="$_gp_expanded${raw#\~}"
      ;;
    \~*) return 1 ;;
  esac
  # Already a plain word: nothing to put back.
  _gp_resolvable "$raw" && {
    _gp_path="$raw"
    return 0
  }
  [[ -n "$raw" ]] || return 1
  rest="$raw"
  while [[ "$rest" == *"$QUOTED"* ]]; do
    lit="${rest%%"$QUOTED"*}"
    rest="${rest#*"$QUOTED"}"
    idx="${rest%%$'\x01'*}"
    [[ "$idx" =~ ^[0-9]+$ ]] || return 1
    rest="${rest#*$'\x01'}"
    [[ -n "${_gp_spans[idx]+set}" ]] || return 1
    span="${_gp_spans[idx]}"
    kind="${span:0:1}"
    span="${span:1}"
    _gp_expand_vars "$lit" || return 1
    out+="$_gp_expanded"
    case "$kind" in
      '"')
        _gp_expand_vars "$span" || return 1
        span="$_gp_expanded"
        ;;
      # Single quotes are literal, so a $ or a backtick inside one names a
      # directory rather than an expansion. Refused rather than guessed at.
      "'") case "$span" in *'$'* | *'`'*) return 1 ;; esac ;;
      *) return 1 ;;
    esac
    out+="$span"
  done
  _gp_expand_vars "$rest" || return 1
  out+="$_gp_expanded"
  # An EMPTY result is the case this gate carries alone. It is still non-zero,
  # so a caller that does nothing keeps the old fail-open — but $_gp_path_empty
  # marks it as RESOLVED-to-empty rather than unknown, for the caller that wants
  # the cwd git and bash both use for it (#301).
  [[ -n "$out" ]] && {
    _gp_resolvable "$out" || return 1
    _gp_path="$out"
    return 0
  }
  # Only a quoted word survives expanding to nothing: unquoted, bash drops it,
  # so `cd $W` with W empty is a bare `cd` and goes to $HOME (#325).
  [[ "$raw" == *"$QUOTED"* ]] || return 1
  _gp_path_empty=1
  return 1
}

# _gp_provably_empty <name> <own assignments> — under a walker's --empty-unset
# opt-in (#325), true where `$<name>` is empty for certain, so _gp_expand_vars
# substitutes it rather than refusing.
#
# The caller has already found the name unset in the hook's environment and
# unharvested (<own assignments> 0), or harvested as empty (1). Either is
# certain only where the command assigns it NOWHERE ELSE: the harvest sees
# leading `NAME=` words alone, so an `export W=…`, `read W` or `for W in` must
# stop it. Any bare-word mention past the count refuses — a heredoc or a quoted
# string naming it included, which fails open where it need not. A command
# carrying `||` may skip an assignment the count cannot tell from a use, and one
# running `source`, `.` or `eval` can assign without naming it (#325 review), so
# both refuse outright.
#
# RESIDUAL (#310's Q2): a name the Bash tool's shell holds and the hook's
# environment lacks — an unexported ~/.bashrc variable — reads as unset here, so
# the guard judges the cwd where the command runs elsewhere. Measured only
# lexically (#325).
_gp_provably_empty() {
  local name="$1" allowed="$2" rest="$_gp_subject" seen="" before n=0
  ((_gp_empty_unset)) && ((_gp_conditional < 0)) || return 1
  [[ "$_gp_subject" =~ (^|[\;\&\|\(]|$'\n'|then|do|else)[[:space:]]*(source|\.|eval)[[:space:]] ]] && return 1
  while [[ "$rest" == *"$name"* ]]; do
    before="$seen${rest%%"$name"*}"
    rest="${rest#*"$name"}"
    seen="$before$name"
    [[ "$before" =~ [A-Za-z0-9_]$ || "$rest" =~ ^[A-Za-z0-9_] ]] && continue
    # A plain reference — `$W` or `${W}` — assigns nothing.
    [[ "$before" == *'$' || "$before" == *'${' ]] && continue
    ((++n > allowed)) && return 1
  done
  # Only the unset ones are named in a refusal; one this command emptied
  # itself needs no telling that variables do not carry between calls.
  ((allowed)) || _gp_path_names+=" $name"
  return 0
}

# Record the literal variable assignments in $@ — the words a segment carries
# before its command, or a segment that is nothing but assignments — into
# $_gp_locals, so a later `$VAR` in a cd or a `git -C` resolves (mantahostels#208).
#
# Called per segment, in order, so an assignment is only ever visible to the
# commands after it, as in shell.
#
# THREE REFUSALS, each landing the name in $_gp_locals_dead, which makes every
# later use of it unresolvable and so fails open exactly as before:
#
#  - any assignment at or after the string's first `||` (#328).
#    `[ -d wt ] || WT=<the shared tree>` then `git -C "$WT" …` would DENY a
#    command shell ran somewhere else, and the reassignment refusal below
#    cannot see it — there is only one assignment. One BEFORE the first `||` is
#    harvested, because a `||` can only skip what follows it.
#  - a value this file will not resolve — command substitution, an unset
#    variable, nested quoting. Nothing here ever runs the text.
#  - a name assigned TWICE with different values. `_gp_flatten` throws away the
#    operator between segments, so a reassignment cannot be told from a second
#    one, and taking the last would build a verdict — possibly a DENY — on a
#    value the command never held there. mantahostels#103 allows a verdict on a structured
#    fact; which arm ran is an inference.
_gp_harvest_assignments() {
  local w name raw val ok
  for w in "$@"; do
    [[ "$w" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    name="${BASH_REMATCH[1]}"
    raw="${BASH_REMATCH[2]}"
    # A whitespace or metacharacter value is stored, not gated here: the case in
    # _gp_expand_vars refuses it at substitution, as it does the environment's.
    # So is an EMPTY one (#325), which that case refuses too unless a walker's
    # --empty-unset opt-in reads it as provably empty.
    ok=1
    if ((_gp_conditional >= 0 && _gp_seg_idx >= _gp_conditional)); then
      ok=0
    elif [[ -z "$raw" ]]; then
      val=""
    elif _gp_path_arg "$raw"; then
      val="$_gp_path"
    else
      val=""
      ((_gp_path_empty)) || ok=0
    fi
    if ((!ok)) ||
      { [[ -n "${_gp_locals[$name]+set}" ]] && [[ "${_gp_locals[$name]}" != "$val" ]]; }; then
      unset '_gp_locals[$name]'
      _gp_locals_dead[$name]=1
      continue
    fi
    _gp_locals[$name]="$val"
  done
}

# Is $1 inside a git repository at all, as a FILESYSTEM fact? Asked only once
# git has already refused to answer for the directory, to tell git's two
# refusals apart (mantahostels#253).
#
# It cannot be asked of git. `rev-parse` exits 128 both for "this is not a
# repository" and for genuine breakage, with the same stderr: a `.git` file
# pointing at a gitdir that is gone, an unreadable `.git`, and a garbage HEAD all
# print `fatal: not a git repository`. So matching the message would fold real
# breakage into a confident "no", and an extra `rev-parse --is-inside-work-tree`
# probe fails identically to the call it was meant to disambiguate.
#
# Instead: walk the ancestry for a `.git` entry — a directory, or the file a
# linked worktree and a submodule leave. Found means git failed for one of the
# other reasons, so the caller stays unknown.
#
# The path is canonicalised FIRST, because the walk is lexical and git resolves
# the physical directory. With `link -> /real/proj/sub` and the broken marker at
# /real/proj/.git, stripping components off the spelling never visits /real/proj,
# so the one case this function exists to catch reads as "no repo at all" and
# goes unrecorded. Canonicalising failing is itself answered "in a repo", which
# records.
#
# It ignores GIT_CEILING_DIRECTORIES and $GIT_DIR. Both can only make it answer
# "in a repo" where git said no, which records too.
_gp_inside_any_repo() {
  local p
  p="$(_gp_canon "$1")" || return 0
  [[ -n "$p" ]] || return 0
  while [[ "$p" == /?* ]]; do
    [[ -e "$p/.git" ]] && return 0
    p="${p%/*}"
  done
  [[ -e /.git ]]
}

# Which working tree of which repo is $1? Four answers, through the exit status:
#
#   0  THIS repo's shared (main) working tree
#   3  a LINKED worktree of this repo
#   1  judged, and neither — another repository, or no repository at all
#   2  NOT judged: git could not answer for the directory (mantahostels#147's fail-open)
#
# The 1/2 split is the load-bearing one: 1 says "judged, and it is not the tree
# I was asked about", 2 says "not judged", which the walkers record as a
# fail-open. The 0/3 split is what lets a guard scope one verdict to the shared
# tree and another to the whole repo (mantahostels#1213) — a linked worktree keeps its own
# index at .git/worktrees/<name>/index, so nothing staged there can be another
# session's, but it runs the same commit hooks the shared tree does (mantahostels#344).
_gp_tree_class() {
  local dir="$1" gitdir common
  # A path with nothing at it is JUDGED — 1, not 2. git fails before it touches
  # anything, so it is no more this repo's tree than another repo is (mantahostels#208).
  # Relies on $dir being absolute, which the walkers guarantee by rejecting the
  # empty case; a relative one would be read against the HOOK's cwd, not the
  # session's.
  [[ -d "$dir" ]] || return 1
  # A directory in NO repository is judged for the same reason (mantahostels#253).
  common="$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || {
    _gp_inside_any_repo "$dir" && return 2
    return 1
  }
  gitdir="$(git -C "$dir" rev-parse --path-format=absolute --git-dir 2>/dev/null)" || return 2
  # Also 2: _gp_canon failing leaves the path empty, which compares unequal to a
  # _gp_project_common already proved non-empty — so an unchecked status here
  # returns a confident "not this repo" built on an unresolved path.
  common="$(_gp_canon "$common")" || return 2
  gitdir="$(_gp_canon "$gitdir")" || return 2
  [[ "$common" == "$_gp_project_common" ]] || return 1
  [[ "$gitdir" == "$common" ]] && return 0
  return 3
}

# Is $1 THIS repo's shared (main) working tree? A different repo or a linked
# worktree answers no (1); a directory git cannot answer for answers 2.
_gp_is_shared_tree() {
  local rc
  _gp_tree_class "$1"
  rc=$?
  # A linked worktree is judged-and-not-it, so it folds into 1 rather than
  # reaching a caller that only knows the three older answers.
  ((rc == 3)) && return 1
  return "$rc"
}

# Is $1 ANY working tree of this repo — shared or linked? Same 1/2 split.
_gp_is_repo_tree() {
  local rc
  _gp_tree_class "$1"
  rc=$?
  ((rc == 3)) && return 0
  return "$rc"
}

# gp_tree_scope <dir> — public. Print which tree that is, for a guard walking
# the whole repo with gp_walk_repo_git and scoping only SOME of its verdicts to
# the shared index (mantahostels#1213):
#
#   shared   this repo's shared (main) working tree
#   linked   a linked worktree of this repo
#   other    another repository, or no repository at all
#   unknown  git could not answer, or $1 is empty — a strict walker's
#            unresolved tree (#311). The caller RECORDS this before allowing,
#            mantahostels#147's rule that every fail-open is logged
#
# It prints rather than returning a status because a caller that treats
# `unknown` like `linked` would silently swallow that fail-open.
gp_tree_scope() {
  local rc
  [[ -n "$1" ]] || {
    printf 'unknown\n'
    return 0
  }
  _gp_tree_class "$1"
  rc=$?
  case "$rc" in
    0) printf 'shared\n' ;;
    3) printf 'linked\n' ;;
    2) printf 'unknown\n' ;;
    *) printf 'other\n' ;;
  esac
}

# Resolve the repo this session is guarding, into $_gp_project_common. Allows on
# a directory git cannot answer for, and records it: with the repo unresolved,
# _gp_is_shared_tree answers no to everything and the guard reaches a verdict on
# no command at all.
_gp_init_repo() {
  local dir
  # Never a local root expression (mantahostels#1905).
  dir="$(gr_root)"
  # Tested BEFORE git sees it: `git -C ""` does not fail, it silently answers
  # for the cwd's repo — so an empty root would be judged rather than allowed.
  [[ -n "$dir" ]] ||
    gl_open "the repo root did not resolve — command allowed unchecked"
  _gp_project_common="$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" ||
    gl_open "git could not resolve a git dir for $dir — command allowed unchecked"
  _gp_project_common="$(_gp_canon "$_gp_project_common")" ||
    gl_open "could not canonicalise the git dir for $dir — command allowed unchecked"
  [[ -n "$_gp_project_common" ]] ||
    gl_open "empty git dir for $dir — command allowed unchecked"
}

# Break one masked line into the segments it runs. A subshell or a command
# substitution splits too, so neither can hide a command behind its bracket.
#
# Given `mark`, each bracket also stands on a line of its own behind
# $_gp_scope_mark, so a walker can end a subshell's `cd` at its `)` (mantahostels#3453).
#
# The `&` and `|` of a redirection — `>&`, `<&`, `&>`, `&>>`, `>|` — are
# shielded from the split (#1488).
_gp_scope_mark=$'\x02'
_gp_flatten() {
  local brackets='s/[()]/\n/g' amp=$'\x03' bar=$'\x04'
  [[ "${2-}" == mark ]] && brackets="s/[()]/\n$_gp_scope_mark&\n/g"
  printf '%s\n' "$1" | sed -e 's/&&/\n/g' -e 's/||/\n/g' \
    -e "s/\([<>]\)&/\1$amp/g" -e "s/&>/$amp>/g" -e "s/>|/>$bar/g" \
    -e "$brackets" -e 's/[;|&]/\n/g' -e "s/$amp/\&/g" -e "s/$bar/|/g"
}

# _gp_scope <segment> — true where the segment is a bracket marker, having
# opened or closed a subshell's cwd. A `)` with no `(` open is a `case` pattern,
# which moves nothing, so the cwd stands.
#
# RESIDUAL: a `case` pattern INSIDE a subshell closes that subshell early, so a
# `cd` after it outlives the subshell's real `)`.
_gp_scope() {
  case "$1" in
    "$_gp_scope_mark(")
      _gp_cwd_stack+=("$_gp_cwd")
      _gp_cwd_names_stack+=("$_gp_cwd_names")
      ;;
    "$_gp_scope_mark)")
      ((${#_gp_cwd_stack[@]})) || return 0
      _gp_cwd="${_gp_cwd_stack[-1]}"
      unset '_gp_cwd_stack[-1]'
      ((${#_gp_cwd_names_stack[@]})) || return 0
      _gp_cwd_names="${_gp_cwd_names_stack[-1]}"
      unset '_gp_cwd_names_stack[-1]'
      ;;
    *) return 1 ;;
  esac
}

# _gp_arith_scope <segment> — _gp_scope, and keep $_gp_no_redirects set over an
# arithmetic `((` or `$((` (#1488), whose `>` and `<` compare. Each `(` stacks
# the state its `)` restores: a `$(` opens a command, a `(` inside arithmetic
# groups, and a second `(` straight after a first — the flatten leaves exactly
# an empty line between — opens arithmetic. Reads and sets the walker's
# $_gp_ar_stack, $_gp_ar_prev and $_gp_ar_last.
_gp_arith_scope() {
  case "$1" in
    "$_gp_scope_mark(")
      _gp_scope "$1"
      _gp_ar_stack+=("$_gp_no_redirects")
      if [[ "$_gp_ar_last" == open-empty ]]; then
        _gp_no_redirects=1
        _gp_ar_last=""
      else
        [[ "$_gp_ar_prev" == *'$' ]] && _gp_no_redirects=0
        _gp_ar_last=open
      fi
      _gp_ar_prev="$1"
      return 0
      ;;
    "$_gp_scope_mark)")
      _gp_scope "$1"
      ((${#_gp_ar_stack[@]})) && {
        _gp_no_redirects="${_gp_ar_stack[-1]}"
        unset '_gp_ar_stack[-1]'
      }
      _gp_ar_last=""
      _gp_ar_prev="$1"
      return 0
      ;;
    '') [[ "$_gp_ar_last" == open ]] && _gp_ar_last=open-empty ;;
    *) _gp_ar_last="" ;;
  esac
  _gp_ar_prev="$1"
  return 1
}

# _gp_track_cd <word>... — move $_gp_cwd for one command's words, assignments
# stripped. Returns 1 where the command changes no directory.
#
# Followed: `cd <path>`, through _gp_path_arg — and `cd ""`, which stays where
# it is (#301). Made unknown, because the target is not on the command or is
# not read: `cd -` and any other flag, a bare `cd`, `pushd`, `popd`,
# `builtin cd` and `command cd`. `pushd ""` is among them, so the empty-path
# rule does NOT reach it. A relative move from an unknown directory stays
# unknown.
_gp_track_cd() {
  case "$1" in
    cd) ;;
    pushd | popd)
      _gp_lose_cwd "$@"
      return 0
      ;;
    builtin | command)
      [[ "${2-}" == cd ]] || return 1
      _gp_lose_cwd "$@"
      return 0
      ;;
    *) return 1 ;;
  esac
  if _gp_path_arg "${2-}"; then
    :
  elif ((_gp_path_empty)); then
    # `cd ""` stays where it is, exactly as `git -C ""` does, so the cwd is
    # unchanged rather than unknown (#301).
    _gp_cwd_names+="$_gp_path_names"
    return 0
  else
    _gp_lose_cwd "$@"
    return 0
  fi
  if [[ "$_gp_path" == -* ]]; then
    _gp_lose_cwd "$@"
  elif [[ "$_gp_path" == /* ]]; then
    _gp_cwd="$_gp_path"
    _gp_cwd_names="$_gp_path_names"
  elif [[ -n "$_gp_cwd" ]]; then
    _gp_cwd="$_gp_cwd/$_gp_path"
    _gp_cwd_names+="$_gp_path_names"
  fi
  return 0
}

# _gp_lose_cwd <word>... — make the cwd unknown, keeping the command that did it.
# RESIDUAL: not stacked, so a subshell's `)` handing back an unknown cwd leaves
# the words of a `cd` inside it.
_gp_lose_cwd() {
  _gp_cwd=""
  _gp_cwd_names=""
  _gp_cwd_lost="$*"
}

# The command names the Bash guards judge. A guard added for a third command
# name belongs in this list.
#
# IT STAYS AT `git` AND `gh`, AND mantahostels#1818 TRIED THE OTHER WAY AND REVERTED IT.
# The list bounds the LINE JOIN, so widening it makes the join abandon more
# often — which sounds conservative and is the opposite for the DENY guards.
# `git` and `gh` are safe here only because a line a deny guard refuses always
# BEGINS with one of them, so such a line trips the abandon itself. Add `cp` and
# an ordinary PROSE line trips it, exposing the rest of a quoted string as
# commands: measured on `node scripts/issue-body.js comment 1 "<three lines of
# prose, one naming cp and one naming npm install>"`, which guard-npm-install.sh
# then DENIED. Balanced quotes were enough; no mis-pairing was needed, and
# _gp_message_open does not exempt it — that exemption reaches `git -m` and
# `gh -b` only, never this repo's own prescribed issue-body writer.
#
# guard-wide-read.sh:47-51 had already ruled this out for `cat`/`sed`/`grep`, on
# the same trade in the same words. The price is mantahostels#287's named gap: a write-shaped
# command joined into a mis-paired string above it is invisible to
# guard-claimed-bash-write.sh (mantahostels#1818), a MISSED WARN rather than a wrong refusal.
#
# THE RULING IS A GATE NOW, NOT A PARAGRAPH (mantahostels#2346). Adding ANY word to the case
# below fails scripts/guard-parse-head-widening.test.ts, which pins the list to
# these two.
_gp_guarded_head() {
  case "${1##*/}" in git | gh) return 0 ;; esac
  return 1
}

# Does $1, read on its own, run a command a guard judges? Every segment is
# checked, not just the line's head word: `foo; git checkout -b evil` hides a
# checkout its first word does not name.
#
# Runs once per line of a quoted body (#510), so it masks $1 on a lexer of its
# own, the join shadowed by locals rather than copied, and splits in bash rather
# than forking _gp_flatten. Only the head words are read.
_gp_absorbs_command() {
  local seg _gp_lx_st _gp_lx_out _gp_lx_span _gp_lx_q _gp_lx_prefix _gp_lx_bs \
    _gp_lx_cmt _gp_lx_hline _gp_lx_opens=0
  local -a _gp_lx_depth _gp_lx_term _gp_lx_dash
  _gp_mask_both "$1"
  while IFS= read -r seg; do
    _gp_command_words "$seg" bare || continue
    _gp_guarded_head "${_gp_words[_gp_wi]}" && return 0
  done <<<"${_gp_masked//[;&|()]/$'\n'}"
  return 1
}

# Is $1's still-open quote the argument of a flag whose value is DATA — a commit
# message, an issue body — rather than shell text? Then the lines that follow are
# prose, and a command named in them is quoted, not run (mantahostels#232).
#
# Narrow at both ends: the segment holding the open quote must be a git or gh
# command, and the word the quote opens on must be one of its message flags.
# `echo it's fine` fails the first test and `$'…'` the second, so mantahostels#182's
# stray-quote shapes keep their per-line reading.
#
# Asked of the lexer where the join stands, the quote being its outermost open
# span and $_gp_lx_prefix the text before it.
_gp_message_open() {
  local seg last="" head word
  [[ -n "$_gp_lx_st" ]] || return 1

  while IFS= read -r seg; do last="$seg"; done < <(_gp_flatten "$_gp_lx_prefix")
  _gp_command_words "$last" || return 1
  head="${_gp_words[_gp_wi]}"
  # The word the quote opens on. `--message="…` arrives glued to its `=`.
  word="${_gp_words[-1]}"
  word="${word%=}"
  # NOT keyed on the subcommand. Gating `git` on `commit|tag` was tried and
  # deleted: no test can tell it apart, because a quoted argument is data to bash
  # whatever the subcommand — `git branch -m "…"` takes a branch name spanning
  # lines, and a command named inside it is no more run than one in a message.
  case "${head##*/}" in
    git) case "$word" in -m | --message) return 0 ;; esac ;;
    # gh's -b/-t are --body/--title. Neither reaches the branch guard, but both
    # carry text a person wrote.
    gh) case "$word" in -b | --body | -t | --title) return 0 ;; esac ;;
  esac
  return 1
}

# Keep every line held in $_gp_pending as a segment of its own, and start the
# lexer afresh. Reads and clears $_gp_pending and $_gp_kept from
# _gp_split_segments's scope.
_gp_keep_per_line() {
  local line
  for line in ${_gp_pending+"${_gp_pending[@]}"}; do
    _gp_mask_both "$line"
    _gp_kept+=("$_gp_masked")
  done
  _gp_pending=()
  _gp_lx_reset
}

# Flatten the subject into $_gp_segments, one command per line. Memoised: both
# walkers and gp_heredoc_lines ask for it, and the answer cannot change within
# a run.
_gp_split_segments() {
  ((_gp_split_done)) && return 0
  _gp_split_done=1

  local -a _gp_raw _gp_command_lines _gp_kept _gp_pending
  local idx line mask term held tail

  # Quoted spans are blanked FIRST, and heredoc openers are then detected on the
  # blanked text. Order matters both ways: detecting `<<` before blanking lets a
  # string like `echo "a << b"` open a heredoc that swallows every command after
  # it, and blanking alone would lose the `<<'EOF'` delimiter, so a quoted
  # delimiter is read back off the original line.
  #
  # A heredoc body is data, not commands, so this pass drops it, recording
  # each body and terminator line in $_gp_heredoc_lines.
  #
  # The lexer CARRIES across lines (mantahostels#201), so a `<<` inside a string
  # opened lines above is no opener. It is fed here rather than up front so a
  # heredoc body's own quotes never reach it.
  _gp_spans=()
  _gp_heredoc_lines=()
  mapfile -t _gp_raw < <(printf '%s\n' "$_gp_subject")
  _gp_command_lines=()
  term=""
  held=""
  _gp_lx_reset
  for idx in "${!_gp_raw[@]}"; do
    line="${_gp_raw[idx]}"
    if [[ -n "$term" ]]; then
      _gp_heredoc_lines+=("$idx")
      [[ "$line" == "$term" || "$line" == "$term;" ]] && term=""
      continue
    fi
    # A `\`-newline outside a `'…'` or `$'…'` is no break at all to bash, so the
    # line is held and the next joined onto it (#490).
    line="$held$line"
    held=""
    tail="${line##*[!\\]}"
    ((${#tail} % 2)) && _gp_lx_save
    _gp_lx_out=""
    _gp_lex "$line"
    if ((_gp_lx_bs)) && [[ "${_gp_lx_st: -1}" != E ]]; then
      _gp_lx_load
      held="${line%\\}"
      continue
    fi
    _gp_lex $'\n'
    mask="$_gp_lx_out"
    if [[ "$mask" =~ \<\<-?[[:space:]]*\\?([A-Za-z_][A-Za-z0-9_]*) ]]; then
      term="${BASH_REMATCH[1]}"
    elif [[ "$mask" == *'<<'* ]] &&
      [[ "$line" =~ \<\<-?[[:space:]]*[\'\"]([A-Za-z_][A-Za-z0-9_]*) ]]; then
      term="${BASH_REMATCH[1]}"
    fi
    # An opener ends the carry. A quote after the `<<` — `gh api <<EOF # don't`
    # is the ordinary case — would otherwise stay open across the skipped body
    # and blank every line after the terminator, hiding the NEXT heredoc's
    # opener and promoting its body to commands the guards then judge.
    [[ -n "$term" ]] && _gp_lx_reset
    _gp_command_lines+=("$line")
  done
  [[ -n "$held" ]] && _gp_command_lines+=("$held")
  _gp_spans=()

  # Mask again, this time over LOGICAL lines (mantahostels#182). Masking line-by-line left a
  # cross-line quoted string exposed to the metacharacter split below, and the
  # words after it on a segment of their own: that is how
  # `git commit -m "<multi-line message>" -- <paths>` reached the commit-form
  # guard with its `--` in a different segment from its `git commit`.
  #
  # A quote the lexer leaves open is the signal to take the next line too. Each
  # line is fed once, on the state the last left (#510).
  #
  # ABANDONED the moment it would absorb a command. The masker lexes as shell
  # does (#490) but not the whole of shell: an apostrophe in a `#` comment
  # inside a `$(…)`, or an unmatched quote bash would refuse, leaves it open
  # where bash is not. Joining on that takes every line after it into one segment
  # headed by the first, hiding the rest from every guard, so the join is bounded
  # by its consequence: absorb no line that runs a command.
  #
  # EXCEPT inside a message argument (mantahostels#232). That bound read a commit message
  # naming a command as the command, so `git commit -m "…git checkout -b x…"`
  # was DENIED by guard-branch.sh and rewording the message was the only way
  # through — on a repo whose messages carry lay-readable motivation.
  #
  # Whether the quote is a message is asked once per span, not once per line:
  # the answer cannot change until another span opens.
  local message_at="" prose=0
  _gp_kept=()
  _gp_pending=()
  _gp_lx_reset
  for idx in "${!_gp_command_lines[@]}"; do
    line="${_gp_command_lines[idx]}"
    if ((${#_gp_pending[@]})); then
      if [[ "$message_at" != "$_gp_lx_opens${_gp_lx_st:+open}" ]]; then
        message_at="$_gp_lx_opens${_gp_lx_st:+open}"
        prose=0
        _gp_message_open && prose=1
      fi
      if ! ((prose)) && _gp_absorbs_command "$line"; then
        _gp_pending+=("$line")
        _gp_keep_per_line
        continue
      fi
      # The join point is inside the quote still open, so the newline lands in
      # a span and never in a segment — kept, because the lexer reads a
      # heredoc's terminator line by it.
      _gp_lex $'\n'
    fi
    _gp_pending+=("$line")
    _gp_lex "$line"
    _gp_lx_open
    [[ -n "$_gp_mask_open" ]] && continue
    _gp_kept+=("$_gp_lx_out")
    _gp_pending=()
    _gp_lx_reset
  done

  # A quote that never closed was not a multi-line string — a stray apostrophe
  # in a comment is the ordinary case.
  _gp_keep_per_line

  # Read BEFORE the flatten, which turns every `||` into a newline like any
  # other separator. Quoted spans are already blanked, so a `||` inside a string
  # does not count. The text before the first `||` flattens to exactly the
  # segments ahead of it, so its line count is the first one after.
  local text
  text="$(printf '%s\n' ${_gp_kept+"${_gp_kept[@]}"})"
  _gp_conditional=-1
  [[ "$text" == *'||'* ]] && _gp_conditional="$(_gp_flatten "${text%%'||'*}" mark | wc -l)"

  _gp_segments="$(_gp_flatten "$text" mark)"
}

# gp_heredoc_lines — the split's heredoc lines, answered in $_gp_heredoc_lines,
# for a guard re-reading or re-issuing the subject as typed, which must leave a
# body's data alone (#2384).
_gp_heredoc_lines=()
gp_heredoc_lines() { _gp_split_segments; }

# Split one segment into its words and find the word the command actually starts
# at — leading environment assignments (FOO=bar gh …) are not the command. Sets
# $_gp_words and $_gp_wi; returns 1 for a segment that runs nothing at all.
#
# Skipped in shell's own order (#1013): any run of reserved words, then the
# assignments, then an `exec` and its flags. A word after `exec` is the command
# even where it looks like an assignment, as shell runs it. `case` arms and
# function bodies stay unread.
# $_gp_assign_end is where the assignments stop, before any `exec`.
#
# Given `bare`, only the assignments are skipped. _gp_absorbs_command asks
# that way, because skipping a reserved word there turns a prose line opening
# `if git …` into a command, and the join gives up (mantahostels#1818's trade).
_gp_assign_end=0
_gp_command_words() {
  _gp_words=()
  # shellcheck disable=SC2206  # deliberate word-splitting: quotes are gone
  read -ra _gp_words <<<"$1"
  _gp_strip_redirects
  _gp_wi=0
  ((${#_gp_words[@]})) || return 1
  while [[ "${2-}" != bare ]] && ((_gp_wi < ${#_gp_words[@]})); do
    case "${_gp_words[_gp_wi]}" in
      '{' | '!' | if | then | else | elif | while | until | do | coproc) ;;
      time)
        [[ "${_gp_words[_gp_wi + 1]-}" == -p ]] && ((_gp_wi++))
        [[ "${_gp_words[_gp_wi + 1]-}" == -- ]] && ((_gp_wi++))
        ;;
      *) break ;;
    esac
    ((_gp_wi++))
  done
  while ((_gp_wi < ${#_gp_words[@]})) && [[ "${_gp_words[_gp_wi]}" == [A-Za-z_]*=* ]]; do ((_gp_wi++)); done
  _gp_assign_end="$_gp_wi"
  if [[ "${2-}" != bare && "${_gp_words[_gp_wi]-}" == exec ]]; then
    ((_gp_wi++))
    while [[ "${_gp_words[_gp_wi]-}" == -* ]]; do
      [[ "${_gp_words[_gp_wi]}" == -*a ]] && ((_gp_wi++))
      ((_gp_wi++))
    done
  fi
  ((_gp_wi < ${#_gp_words[@]}))
}

# Take the redirections out of $_gp_words, into $_gp_redirs (#1488): one entry
# per redirection, `<descriptor>\x1f<operator>\x1f<target>`, the target masked
# as the words are. A word carrying an operator part-way — `echo hi>out` — is
# cut there, as bash cuts it; a leading run of digits or a `{name}` is the
# descriptor. An operator with no target left, or one whose target is a
# `<(…)` or `>(…)`, is dropped unrecorded: the flatten split that body off.
#
# Not inside `[[ … ]]`, where `>` and `<` compare strings, nor in arithmetic,
# which _gp_no_redirects marks. `[` and `test` get no such exemption: bash
# redirects an unescaped `>` there, and `\>` is a word already.
_gp_redirs=()
_gp_no_redirects=0
_gp_redirect_re='^((\\.|[^\\<>])*)([<>].*)$'
_gp_strip_redirects() {
  _gp_redirs=()
  [[ "${_gp_words[*]-}" == *[\<\>]* ]] || return 0
  ((_gp_no_redirects)) && return 0
  local -a _gp_rd_out=()
  local w pre op rest fd target i=0 n=${#_gp_words[@]} cond=0
  # A `&&` inside `[[ … ]]` splits it, so a segment reaching its `]]` with no
  # `[[` is the conditional's tail.
  for w in "${_gp_words[@]}"; do
    [[ "$w" == '[[' ]] && break
    [[ "$w" == ']]' ]] && {
      cond=1
      break
    }
  done
  while ((i < n)); do
    w="${_gp_words[i]}"
    ((++i))
    case "$w" in
      '[[') cond=1 ;;
      ']]') cond=0 ;;
    esac
    while [[ -n "$w" ]]; do
      if ((cond)) || ! [[ "$w" =~ $_gp_redirect_re ]]; then
        _gp_rd_out+=("$w")
        break
      fi
      pre="${BASH_REMATCH[1]}"
      rest="${BASH_REMATCH[3]}"
      fd=""
      if [[ "$pre" == *'&' && "$pre" != *'\&' && "$rest" == '>'* ]]; then
        pre="${pre%&}"
        rest="&$rest"
        fd='&'
      fi
      if [[ -z "$fd" && "$pre" =~ ^([0-9]+|\{[A-Za-z_][A-Za-z0-9_]*\})$ ]]; then
        fd="$pre"
      elif [[ -n "$pre" ]]; then
        _gp_rd_out+=("$pre")
      fi
      case "$rest" in
        '&>>'*) op='&>>' ;;
        '&>'*) op='&>' ;;
        '>>'*) op='>>' ;;
        '>|'*) op='>|' ;;
        '>&'*) op='>&' ;;
        '<<<'*) op='<<<' ;;
        '<<-'*) op='<<-' ;;
        '<<'*) op='<<' ;;
        '<>'*) op='<>' ;;
        '<&'*) op='<&' ;;
        *) op="${rest:0:1}" ;;
      esac
      rest="${rest:${#op}}"
      if [[ -z "$rest" ]]; then
        ((i < n)) || break
        target="${_gp_words[i]}"
        ((++i))
        w=""
        # `2> >(tee e)` and `< <(ls)`: the target is a process substitution,
        # whose own bare operator the flatten left last.
        [[ "$target" == '<' || "$target" == '>' ]] && ((i == n)) && break
      elif [[ "$rest" =~ $_gp_redirect_re ]]; then
        target="${BASH_REMATCH[1]}"
        w="${rest:${#target}}"
        [[ "$target" == *'&' && "$w" == '>'* ]] && {
          target="${target%&}"
          w="&$w"
        }
      else
        target="$rest"
        w=""
      fi
      _gp_redirs+=("$fd"$'\x1f'"$op"$'\x1f'"$target")
    done
  done
  _gp_words=(${_gp_rd_out+"${_gp_rd_out[@]}"})
}

# gp_redirects — inside any walk, the redirections of the command being handed
# to the callback (#1488), answered in four arrays, one entry per redirection in
# the order written:
#
#   _gp_redir_fd      the descriptor: as written, else 1 for an output and 0 for
#                     an input; `&` for `&>`, `&>>` and `>&<file>`, which send
#                     both 1 and 2
#   _gp_redir_kind    truncate (`>`, `&>`), clobber (`>|`), append (`>>`,
#                     `&>>`), read (`<`), read-write (`<>`), copy (`n>&m`,
#                     `n<&m`), close (`n>&-`, `n<&-`), here-string (`<<<`) or
#                     heredoc (`<<`, `<<-`)
#   _gp_redir_target  the target as written, masked as the callback's words are
#                     — a descriptor for copy and close, the delimiter for a
#                     heredoc
#   _gp_redir_path    the target as an absolute path, through gp_resolve_word
#                     and gp_cwd; EMPTY where it will not resolve, and always for
#                     copy, close, here-string and heredoc
#
# CALL IT IN THE CALLER'S OWN SHELL, never in `$(…)`, as gp_unwrap.
#
# gp_redirect_writes <kind> — true where that kind writes a file: truncate,
# clobber, append or read-write.
gp_redirect_writes() {
  case "$1" in truncate | clobber | append | read-write) return 0 ;; esac
  return 1
}
_gp_redir_fd=()
_gp_redir_kind=()
_gp_redir_target=()
_gp_redir_path=()
gp_redirects() {
  _gp_redir_fd=()
  _gp_redir_kind=()
  _gp_redir_target=()
  _gp_redir_path=()
  local entry fd op target kind path
  for entry in ${_gp_cmd_redirs+"${_gp_cmd_redirs[@]}"}; do
    fd="${entry%%$'\x1f'*}"
    op="${entry#*$'\x1f'}"
    target="${op#*$'\x1f'}"
    op="${op%%$'\x1f'*}"
    case "$op" in
      '>') kind=truncate ;;
      '>|') kind=clobber ;;
      '>>' | '&>>') kind=append ;;
      '&>') kind=truncate ;;
      '<') kind='read' ;;
      '<>') kind=read-write ;;
      '<<<') kind=here-string ;;
      '<<' | '<<-') kind=heredoc ;;
      '>&' | '<&')
        # Bash decides on the expanded word, so `>&$fd` is read through its
        # value, and taken as a copy where it has none.
        path="$(gp_resolve_word "$target")" || path=1
        if [[ "$path" == - ]]; then
          kind=close
        elif [[ "$path" =~ ^[0-9]+-?$ ]]; then
          kind=copy
        elif [[ "$op" == '>&' && -z "$fd" ]]; then
          # `>&file` with no descriptor is bash's older `&>file`.
          kind=truncate
          fd='&'
        else
          kind='read'
        fi
        ;;
    esac
    [[ -n "$fd" ]] || case "$op" in '<'*) fd=0 ;; *) fd=1 ;; esac
    path=""
    if [[ "$kind" == read ]] || gp_redirect_writes "$kind"; then
      path="$(_gp_resolve_abs "$target")"
    fi
    _gp_redir_fd+=("$fd")
    _gp_redir_kind+=("$kind")
    _gp_redir_target+=("$target")
    _gp_redir_path+=("$path")
  done
  return 0
}

# gp_write_targets <word>... — inside gp_walk_commands, every file the command
# handed to the callback writes or removes (#1827), given that command's words.
# The routes it reads:
#
#   a redirect            every kind gp_redirect_writes names; never inside
#                         `[[`, where `>` compares two strings. A heredoc's
#                         own redirect is read; its body is data and is not
#   `cp` / `mv`           the LAST bare word, or `-t <dir>`, as
#                         `<dest>/<basename>` where the destination is a
#                         directory, ends in `/` or takes two sources — and for
#                         `mv` alone its SOURCES, which it destroys
#   `sed -i` / `perl -i`  every bare file argument
#   `truncate`, `tee`     every bare file argument
#   `git restore <path>`  every bare word after the subcommand, unless
#                         `--staged` without `--worktree` — that writes the index
#   `git checkout -- <p>` every bare word after the `--`
#   `rm`, `git rm`,       every bare word, and every word past a `--`
#   `git mv`
#
# Answered in four arrays, one entry per target, redirects first:
#
#   _gp_wt_mode    write; move-source, for `mv`'s sources; delete, for the
#                  last row
#   _gp_wt_route   the route that read it: redirect, or the command as the
#                  table names it — cp, mv, sed, perl, truncate, tee, rm,
#                  git restore, git checkout, git mv or git rm (#2142)
#   _gp_wt_target  the target as written, masked as the callback's words are —
#                  `<dest>/<basename>` for a copy into a directory, its
#                  basename read through gp_literal
#   _gp_wt_path    the target as an absolute path, through gp_resolve_word and
#                  gp_cwd; EMPTY where it will not resolve
#
# The command word is read as written, never through gp_unwrap, so `sudo tee x`
# is not read. `git checkout <path>` without `--` is not read either: the word
# is a revision at least as often as a path. Nor is a git global option, so
# `git -C <dir> checkout -- <p>` reads nothing.
#
# CALL IT IN THE CALLER'S OWN SHELL, never in `$(…)`, as gp_redirects.
_gp_wt_mode=()
_gp_wt_route=()
_gp_wt_target=()
_gp_wt_path=()
gp_write_targets() {
  _gp_wt_mode=()
  _gp_wt_route=()
  _gp_wt_target=()
  _gp_wt_path=()
  # The route _gp_wt_add stamps on each row, read through bash's dynamic scope
  # so the nine call sites under the route helpers need not each carry it
  # (#2142).
  local i base _gp_wt_route_now=redirect
  gp_redirects
  for i in "${!_gp_redir_kind[@]}"; do
    gp_redirect_writes "${_gp_redir_kind[i]}" &&
      _gp_wt_add write "${_gp_redir_target[i]}" "${_gp_redir_path[i]}"
  done
  base="$(gp_literal "${1-}")" || return 0
  base="${base##*/}"
  (($#)) && shift
  _gp_wt_route_now="$base"
  [[ "$base" == git ]] && _gp_wt_route_now="git ${1:-}"
  case "$base" in
    cp | mv) _gp_wt_copy "$base" "$@" ;;
    sed) _gp_wt_inplace sed "$@" && _gp_wt_bare "-e -f --expression --file" "$@" ;;
    perl) _gp_wt_inplace perl "$@" && _gp_wt_bare "-e -E -I -m -M -F" "$@" ;;
    truncate) _gp_wt_bare "-s --size -r --reference" "$@" ;;
    tee) _gp_wt_bare "" "$@" ;;
    rm) _gp_wt_delete "$@" ;;
    git) _gp_wt_git "${1:-}" "${@:2}" ;;
  esac
  return 0
}

# _gp_wt_add <mode> <target> [<path>] — one answer row; the path is resolved
# from the target where the caller has none.
_gp_wt_add() {
  local path
  if (($# >= 3)); then
    path="$3"
  else
    path="$(_gp_resolve_abs "$2")"
  fi
  _gp_wt_mode+=("$1")
  _gp_wt_route+=("$_gp_wt_route_now")
  _gp_wt_target+=("$2")
  _gp_wt_path+=("$path")
}

# _gp_resolve_abs <word> — the word as an absolute normalised path, joined to
# gp_cwd where relative; nothing where it will not resolve.
_gp_resolve_abs() {
  local path
  path="$(gp_resolve_word "$1")" && [[ -n "$path" ]] || return 0
  if [[ "$path" != /* ]]; then
    [[ -n "$_gp_cwd" ]] || return 0
    path="$_gp_cwd/$path"
  fi
  gp_norm_abs "$path"
}

# `cp` leaves its sources alone, so reading them would report a read as a write.
_gp_wt_copy() {
  local prog="$1" dest="" word src lit name tgt rsrc path dpath next=0 into=0
  shift
  local -a _gp_wt_srcs=()
  for word in "$@"; do
    if ((next)); then
      ((next == 1)) && dest="$word"
      next=0
      continue
    fi
    case "$word" in
      -t | --target-directory)
        next=1
        continue
        ;;
      --target-directory=*)
        dest="${word#*=}"
        continue
        ;;
      # The backup suffix, a value and no file.
      -S | --suffix)
        next=2
        continue
        ;;
      -*) continue ;;
    esac
    _gp_wt_srcs+=("$word")
  done

  if [[ -n "$dest" ]]; then
    into=1
  else
    ((${#_gp_wt_srcs[@]} >= 2)) || return 0
    dest="${_gp_wt_srcs[-1]}"
    unset '_gp_wt_srcs[-1]'
    # Two sources or more land in a directory or nowhere.
    ((${#_gp_wt_srcs[@]} >= 2)) && into=1
  fi
  dpath="$(_gp_resolve_abs "$dest")"
  lit="$(gp_literal "$dest")" || :
  [[ -n "$lit$dpath" ]] || return 0
  # A directory as this hook sees it, or one by its own spelling — a trailing
  # `/` names nothing else, existing or not.
  [[ -n "$dpath" && -d "$dpath" ]] || [[ "$lit" == */ ]] && into=1
  for src in ${_gp_wt_srcs+"${_gp_wt_srcs[@]}"}; do
    if ((into)); then
      # The basename as written where it reads, else the masked word's own —
      # `"$F"` stays unreadable to the caller, `$HOME/a.md` comes back `a.md`.
      if name="$(gp_literal "$src")"; then
        tgt="${dest%/}/${name##*/}"
      else
        tgt="${dest%/}/${src##*/}"
      fi
      rsrc="$(gp_resolve_word "$src")" || rsrc="$name"
      path=""
      [[ -n "$dpath" && -n "$rsrc" ]] && path="$(gp_norm_abs "$dpath/${rsrc##*/}")"
      _gp_wt_add write "$tgt" "$path"
    fi
    [[ "$prog" == "mv" ]] && _gp_wt_add move-source "$src"
  done
  ((into)) || _gp_wt_add write "$dest" "$dpath"
  return 0
}

# Is any word in `$@` an in-place switch for `$1`? Bundled single letters are
# read left to right and the scan stops at the first switch that TAKES an
# argument, so `perl -Ilib` is not misread as in-place on its `i`.
_gp_wt_inplace() {
  local prog="$1" takes_arg word rest ch
  shift
  case "$prog" in
    sed) takes_arg="efl" ;;
    *) takes_arg="0CDeEFIlmMx" ;;
  esac
  for word in "$@"; do
    case "$word" in
      --in-place | --in-place=*) return 0 ;;
      --) return 1 ;;
      -*)
        rest="${word#-}"
        [[ "$rest" == -* ]] && continue # a long option this scan cannot bundle
        while [[ -n "$rest" ]]; do
          ch="${rest:0:1}"
          [[ "$ch" == "i" ]] && return 0
          [[ "$takes_arg" == *"$ch"* ]] && break
          rest="${rest:1}"
        done
        ;;
    esac
  done
  return 1
}

# _gp_wt_bare <skip> <word>... — every bare word as a write target. `skip`
# names the flags whose VALUE is the next word and so is not a file of this
# command's own.
_gp_wt_bare() {
  local skip="$1" word next=0
  shift
  for word in "$@"; do
    if ((next)); then
      next=0
      continue
    fi
    case "$word" in
      --) continue ;;
      -*)
        [[ -n "$skip" && " $skip " == *" $word "* ]] && next=1
        continue
        ;;
    esac
    _gp_wt_add write "$word"
  done
}

# No flag of `rm`, `git rm` or `git mv` takes a separate value but
# `git rm --pathspec-from-file`, whose file then lands here.
_gp_wt_delete() {
  local word seen_sep=0
  for word in "$@"; do
    if ((!seen_sep)); then
      case "$word" in
        --)
          seen_sep=1
          continue
          ;;
        -*) continue ;;
      esac
    fi
    _gp_wt_add delete "$word"
  done
}

_gp_wt_git() {
  local sub="$1" word seen_sep=0
  shift
  case "$sub" in
    restore)
      if [[ " $* " == *" --staged "* || " $* " == *" -S "* ]] &&
        [[ " $* " != *" --worktree "* && " $* " != *" -W "* ]]; then
        return 0
      fi
      _gp_wt_bare "-s --source --pathspec-from-file" "$@"
      ;;
    checkout)
      for word in "$@"; do
        if ((seen_sep)); then
          _gp_wt_add write "$word"
        elif [[ "$word" == "--" ]]; then
          seen_sep=1
        fi
      done
      ;;
    mv | rm) _gp_wt_delete "$@" ;;
  esac
}

# Parse one segment as a git invocation.
#
# Returns 0 only when the segment is a git invocation carrying a subcommand, and
# then sets $_gp_sub, $_gp_args and $_gp_target_dir — the tree it runs against.
# Returns 1 for everything else, including a `cd`, which updates the running
# $_gp_cwd instead through _gp_track_cd (emptying it where the target cannot be
# resolved, so every later segment fails open rather than falling back to $PWD
# and judging a worktree command against the shared tree).
_gp_parse_segment() {
  local segment="$1"
  local i head nxt ran

  _gp_command_words "$segment"
  ran=$?
  # Harvested even when the segment runs nothing, because `WT=/x && git …`
  # flattens the assignment into a segment of its own (mantahostels#208). _gp_command_words
  # has already found where the assignments stop.
  _gp_harvest_assignments "${_gp_words[@]:0:_gp_assign_end}"
  ((ran == 0)) || return 1
  i="$_gp_wi"
  head="${_gp_words[i]}"

  _gp_track_cd "${_gp_words[@]:i}" && return 1

  # A wrapper's own `-C DIR` (`env -C`) is swept, not followed: the git command
  # is judged against the running cwd.
  if ((_gp_unwrap_git)); then
    gp_unwrap "${_gp_words[@]:i}"
    ((${#_gp_unwrapped[@]})) || return 1
    _gp_words=("${_gp_words[@]:0:i}" "${_gp_unwrapped[@]}")
    head="${_gp_words[i]}"
  fi

  [[ "$(basename "$head")" == "git" ]] || return 1

  # Walk git's own options to find the subcommand, honouring -C.
  _gp_target_dir="$_gp_cwd"
  _gp_target_names="$_gp_cwd_names"
  _gp_target_written=""
  ((i++))
  while ((i < ${#_gp_words[@]})); do
    case "${_gp_words[i]}" in
      -C)
        if _gp_path_arg "${_gp_words[i + 1]-}"; then
          nxt="$_gp_path"
        elif ((_gp_path_empty)); then
          # `git -C ""` runs against the cwd — git treats an empty path as if
          # -C were not given (#301). Leave $_gp_target_dir where it stands and
          # read the next option.
          _gp_target_names+="$_gp_path_names"
          ((i += 2))
          continue
        else
          nxt=""
        fi
        if [[ -z "$nxt" ]]; then
          _gp_target_dir=""
          _gp_target_written="-C ${_gp_words[i + 1]-}"
        elif [[ "$nxt" != /* ]] && [[ -z "$_gp_target_dir" ]]; then
          _gp_target_dir=""
        elif [[ "$nxt" == /* ]]; then
          _gp_target_dir="$nxt"
          _gp_target_names="$_gp_path_names"
          _gp_target_written=""
        else
          _gp_target_dir="$_gp_target_dir/$nxt"
          _gp_target_names+="$_gp_path_names"
        fi
        ((i += 2))
        ;;
      -*)
        if _gp_git_takes_value "${_gp_words[i]}"; then ((i += 2)); else ((i++)); fi
        ;;
      *) break ;;
    esac
  done
  ((i < ${#_gp_words[@]})) || return 1
  _gp_sub="${_gp_words[i]}"
  ((i++))
  _gp_args=("${_gp_words[@]:i}")
}

# ---------------------------------------------------------------------------
# Entry points. gp_begin is LAST in the file on purpose: a truncated or
# syntactically damaged library leaves bash having defined everything up to the
# break and nothing after it, so gating on the last name defined disarms the
# guard on any damage anywhere. That is why a guard's load gate is one name and
# not the list of functions it happens to call.
# ---------------------------------------------------------------------------

# gp_subject — the payload field this guard judges, verbatim. A guard reads it
# raw only to search the text the parser deliberately blanked.
gp_subject() { printf '%s' "$_gp_subject"; }

# gp_payload_field <jq path> — any other field of the hook payload, e.g.
# .session_id. Prints the value; non-zero means jq could not answer, which is
# not the same as the field being absent (that prints empty and returns 0).
#
# -j, not -r: no trailing newline, so the value reads the same whether or not
# the caller took it through a command substitution.
gp_payload_field() {
  printf '%s' "$_gp_payload" | jq -j "$1 // \"\"" 2>/dev/null
}

# gp_walk_commands [--bare-redirects] <fn> — call <fn> once per command the
# subject runs, with the flattened segment as $1 and the command's own words as
# $2 onward, leading environment assignments and every redirection removed
# (#1488): gp_redirects reads those. Segments that run nothing are skipped —
# bar, given --bare-redirects, one that is redirections alone — `> out`,
# `exec 3> log`, or the `> out` a `$(…)` split from its command — handed over
# with no words.
#
# No subshell anywhere on this path: a callback that accumulates across segments
# (guard-commit-form.sh holds a warning back in case a later segment denies)
# needs its assignments to survive the loop.
#
# It tracks the cwd as _gp_walk_git does, for gp_cwd, and moves it AFTER each
# callback, so a `cd`'s own callback still reads the directory it ran from.
#
# SEEDED FROM THE PAYLOAD'S `.cwd`, else this process's own, where _gp_walk_git
# seeds from $PWD alone. The payload's is where the session's shell stands
# (mantahostels#2682).
#
# RE-ENTRANT: guard-commit-form.sh runs one from inside gp_walk_repo_git's loop,
# so the cwd and harvested assignments that walk is still reading are put back
# on the way out.
gp_walk_commands() {
  local bare=0
  [[ "$1" == --bare-redirects ]] && {
    bare=1
    shift
  }
  local fn="$1" segment ran _gp_outer_cwd="$_gp_cwd" _gp_outer_lost="$_gp_cwd_lost" _gp_empty_unset=0
  local _gp_path_names="" _gp_cwd_names="" _gp_no_redirects=0 _gp_ar_prev="" _gp_ar_last=""
  local -a _gp_outer_stack=(${_gp_cwd_stack+"${_gp_cwd_stack[@]}"}) _gp_cmd=() _gp_cwd_names_stack=()
  local -a _gp_cmd_redirs=() _gp_ar_stack=()
  local -A _gp_outer_locals=() _gp_outer_dead=()
  local _gp_seg_idx=-1
  _gp_copy_assoc _gp_locals _gp_outer_locals
  _gp_copy_assoc _gp_locals_dead _gp_outer_dead

  _gp_split_segments
  if [[ -z "$_gp_cwd_seed" ]]; then
    _gp_cwd_seed="$(gp_payload_field '.cwd')" || _gp_cwd_seed=""
    [[ "$_gp_cwd_seed" == /* ]] || _gp_cwd_seed="$PWD"
  fi
  _gp_cwd="$_gp_cwd_seed"
  _gp_cwd_lost=""
  _gp_cwd_stack=()
  _gp_locals=()
  _gp_locals_dead=()

  while IFS= read -r segment; do
    ((++_gp_seg_idx))
    _gp_arith_scope "$segment" && continue
    _gp_command_words "$segment"
    ran=$?
    _gp_harvest_assignments "${_gp_words[@]:0:_gp_assign_end}"
    # Copied first: a callback may walk again and overwrite $_gp_words.
    _gp_cmd_redirs=(${_gp_redirs+"${_gp_redirs[@]}"})
    if ((ran)); then
      ((bare && ${#_gp_cmd_redirs[@]})) && "$fn" "$segment"
      continue
    fi
    _gp_cmd=("${_gp_words[@]:_gp_wi}")
    "$fn" "$segment" "${_gp_cmd[@]}"
    _gp_track_cd "${_gp_cmd[@]}" || :
  done <<<"$_gp_segments"

  _gp_cwd="$_gp_outer_cwd"
  _gp_cwd_lost="$_gp_outer_lost"
  _gp_cwd_stack=(${_gp_outer_stack+"${_gp_outer_stack[@]}"})
  _gp_copy_assoc _gp_outer_locals _gp_locals
  _gp_copy_assoc _gp_outer_dead _gp_locals_dead
  return 0
}

# _gp_copy_assoc <from> <to> — replace one associative array's entries with
# another's, both named.
_gp_copy_assoc() {
  local -n _gp_from="$1" _gp_to="$2"
  local _gp_k
  _gp_to=()
  # shellcheck disable=SC2004 # an associative subscript is a string, not arithmetic: the $ is required.
  for _gp_k in "${!_gp_from[@]}"; do _gp_to[$_gp_k]="${_gp_from[$_gp_k]}"; done
}

# gp_cwd — inside gp_walk_commands, the directory the command being handed to
# the callback runs in (mantahostels#3453). EMPTY where the walk cannot know it, which the
# caller records before it fails open. Not made absolute or normalised.
gp_cwd() { printf '%s' "$_gp_cwd"; }

# gp_resolve_word <word> — inside gp_walk_commands, one masked word of the
# command with its quoted spans put back and a leading `~` and every `$VAR`
# expanded, the command's own earlier assignments first (mantahostels#208, #1030).
# Prints nothing and returns non-zero where any part will not resolve, on
# _gp_expand_vars's refusals. Relative stays relative: join it to gp_cwd.
# Safe in a command substitution, reading $_gp_spans and never adding to it;
# a quoted `""` comes back unresolved, $_gp_path_empty dying in the subshell.
gp_resolve_word() {
  _gp_path_arg "$1" || return 1
  printf '%s' "$_gp_path"
}

# gp_assigned <NAME> — inside gp_walk_commands, 0 where the command assigned NAME
# earlier a value the walk resolved, as gp_resolve_word would read it; 1 where
# it never did, or did with a value the walk refused (#2436).
gp_assigned() { [[ -n "${_gp_locals[$1]+set}" ]]; }

# gp_unwrap <word>... — strip the launcher wrappers off one command's words, so
# the command actually being run stands first (mantahostels#2511, mantahostels#2524, mantahostels#2552).
#
# Sets two arrays rather than returning, bash having no way to return one:
#
#   _gp_unwrapped      what is left to judge. Empty where the wrappers ran out
#                      of words mid-strip; a caller must test that before
#                      reading $1. It is NOT a promise that a command word
#                      stands first — a malformed `bg-run.sh run` with no name
#                      leaves `bg-run.sh run` standing.
#   _gp_wrapper_words  the assignments an `env` carried, which a guard reading
#                      an escape from the command string must still see — inside
#                      an `env` prefix the escape is a WORD, not a leading shell
#                      assignment that _gp_command_words has already set
#                      $_gp_wi past.
#
# `nohup FOO=1 cmd` execs a program literally named `FOO=1` and starts nothing,
# so an assignment after any other wrapper is the command word and stops the
# strip.
#
# `bg-run.sh run <name>` is stripped alongside the launchers: wrapping a suite
# in the kill detector (mantahostels#1900) changes nothing about what the suite then does.
# Its job NAME is free text and is never an escape.
#
# CALL IT IN THE CALLER'S OWN SHELL, never in `$(…)`: the answer is two globals,
# so a subshell drops it and the caller reads the previous segment's words with
# no sign anything went wrong.
#
# `sudo` IS STRIPPED, DELIBERATELY. Not stripping it was the alternative, and it
# loses on the one asymmetry: stripping only ever widens what is judged.
#
# `env -S <string>` IS SPLIT, NOT SKIPPED. The string is the command, so
# skipping it as an ordinary flag value would leave nothing to judge and allow
# the launch.
#
# THE WRAPPER CLASS IS STILL NOT CLOSED (mantahostels#2629). `sh -c "…"` and a heredoc walk
# past unstripped, for DIFFERENT reasons. `sh` is simply absent from the case
# list below, so it stands as the command word — and its payload is a quoted span, blanked to a $QUOTED sentinel
# before any split, so nothing downstream sees the command inside it. Closing
# that would mean reading the span back out of $_gp_spans and splitting it, the
# way the `-S` branch does. A heredoc's body never reaches a split at all:
# _gp_split_segments's heredoc pass drops it as data, leaving only the opener
# line's own segments — `cat <<EOF | sh` still yields two. So does a
# separate-value flag absent from
# `_gp_takes_value` below, whose value then stands where the command word is
# looked for. And the `-S` split is an IFS split, so a quote INSIDE the string
# stays welded to its word — `env -S 'npm run "test"'` leaves `"test"`, which
# no command word matches.
_gp_unwrapped=()
_gp_wrapper_words=()
_gp_split=()

# _gp_takes_value <wrapper> <flag> — true where <flag> takes its value as a
# SEPARATE word for <wrapper>, so the sweep in gp_unwrap must shift two.
#
# REQUIRED-value flags only. An OPTIONAL-value one takes its value joined or not
# at all, so listing it here would eat the command word — which is why `xargs
# -e[END]`, `-i[R]` and `-l[MAX]`, `sudo -h` (`--help` as readily as `--host`)
# and `env`'s `--*-signal[=SIG]` family are absent, and adding any of them for
# completeness reopens mantahostels#2552.
#
# `-u`, `-C`, `--unset` and `--chdir` are absent here: gp_unwrap sweeps those
# four for every wrapper, so `sudo -u`, `sudo -C` and `sudo --chdir` are already
# covered.
_gp_takes_value() {
  case "$1:$2" in
    stdbuf:-i | stdbuf:-o | stdbuf:-e | \
      stdbuf:--input | stdbuf:--output | stdbuf:--error) ;;
    nice:-n | nice:--adjustment) ;;
    ionice:-c | ionice:-n | ionice:-p | ionice:-P | \
      ionice:--class | ionice:--classdata | ionice:--pid | ionice:--pgid) ;;
    xargs:-a | xargs:-d | xargs:-E | xargs:-I | xargs:-L | xargs:-n | xargs:-P | \
      xargs:-s | xargs:--arg-file | xargs:--delimiter | xargs:--max-lines | \
      xargs:--max-args | xargs:--max-procs | xargs:--max-chars | \
      xargs:--process-slot-var) ;;
    sudo:-c | sudo:-D | sudo:-g | sudo:-p | sudo:-r | sudo:-R | sudo:-t | \
      sudo:-T | sudo:-U | sudo:--close-from | sudo:--login-class | \
      sudo:--group | sudo:--host | sudo:--prompt | sudo:--role | \
      sudo:--chroot | sudo:--type | sudo:--command-timeout | \
      sudo:--other-user | sudo:--user) ;;
    *) return 1 ;;
  esac
  return 0
}

# gp_commit_paths_args <word>... — where the command words are a
# `node …/commit-paths.js` call, fill _gp_cp_args with the arguments after the
# script and return 0; otherwise return 1. That call runs no `git` a walk sees,
# so a guard judging commits reads it here (#1727, #2022).
#
# Judged on the visible text: a `"$CLAUDE_PROJECT_DIR"/scripts/commit-paths.js`
# spelling hides its directory and keeps its basename. Residual: a node flag
# taking a value outside the list below leaves the value in the script's place,
# and the call is not recognised.
_gp_cp_args=()
gp_commit_paths_args() {
  _gp_cp_args=()
  gp_unwrap "$@"
  set -- ${_gp_unwrapped+"${_gp_unwrapped[@]}"}
  local word
  word="$(gp_literal "${1-}")"
  word="${word##*/}"
  [[ "$word" == node || "$word" == nodejs ]] || return 1
  shift
  while (($#)) && [[ "$1" == -* ]]; do
    case "$1" in
      -r | --require | --import | --loader | --experimental-loader) shift 2 || return 1 ;;
      *) shift ;;
    esac
  done
  word="$(gp_literal "${1-}")"
  [[ "${word##*/}" == commit-paths.js ]] || return 1
  shift
  _gp_cp_args=("$@")
}

# gp_commit_paths_parse — after gp_commit_paths_args, split _gp_cp_args as
# commit-paths.js's parseArgs does (#2147): the words after `--` into
# _gp_cp_paths, the `--patch` word into _gp_cp_patch, the message's `-m` or
# `-F` into _gp_cp_message_flag and its word into _gp_cp_message (#2383), and
# _gp_cp_tree set for a `--tree` call. A value is never an option, so `-m --`
# stays a message. Returns 1 where commit-paths.js would refuse the option
# words: an unknown option, `--help` among them, one missing its value, or a
# second message or `--patch`. The words stay masked, for gp_literal.
_gp_cp_paths=()
_gp_cp_patch=""
_gp_cp_message_flag=""
_gp_cp_message=""
_gp_cp_tree=0
gp_commit_paths_parse() {
  _gp_cp_paths=()
  _gp_cp_patch=""
  _gp_cp_message_flag=""
  _gp_cp_message=""
  _gp_cp_tree=0
  set -- ${_gp_cp_args+"${_gp_cp_args[@]}"}
  while (($#)); do
    case "$(gp_literal "$1")" in
      --)
        shift
        _gp_cp_paths=("$@")
        return 0
        ;;
      --tree) _gp_cp_tree=1 ;;
      -m | -F | --patch)
        (($# >= 2)) || return 1
        if [[ "$(gp_literal "$1")" == --patch ]]; then
          [[ -z "$_gp_cp_patch" ]] || return 1
          _gp_cp_patch="$2"
        else
          [[ -z "$_gp_cp_message_flag" ]] || return 1
          _gp_cp_message_flag="$(gp_literal "$1")"
          _gp_cp_message="$2"
        fi
        shift
        ;;
      *) return 1 ;;
    esac
    shift
  done
}

# gp_patch_files <dir> <word> — fill _gp_patch_files with the absolute path of
# every file the patch file <word> touches, read as commit-paths.js's
# patchFiles reads them: `git apply --numstat` from the top level, a rename's
# new name only. <word> is masked and, where relative, joined to <dir>. Returns
# 1 where the word or the patch cannot be read, the caller logging what that
# costs it.
_gp_patch_files=()
gp_patch_files() {
  _gp_patch_files=()
  local file top field
  local -a _gp_pf_fields
  file="$(gp_literal "$2")" || return 1
  [[ "$file" == /* ]] || file="$1/$file"
  top="$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" && [[ -r "$file" ]] || return 1
  mapfile -d '' -t _gp_pf_fields < <(git -C "$top" apply --numstat -z --unidiff-zero "$file" 2>/dev/null)
  ((${#_gp_pf_fields[@]})) || return 1
  # One `<added>\t<deleted>\t<path>` field per file.
  for field in "${_gp_pf_fields[@]}"; do
    _gp_patch_files+=("$top/${field#*$'\t'*$'\t'}")
  done
}

# gp_find_starts <word>... — fill _gp_find_starts with a `find`'s start points:
# the words after its leading options (`-H`, `-L`, `-P`, `-D <opts>`, `-O<n>`,
# `--`) and before the first word opening an expression — one starting `-`, or
# `(`, `!`, `,`. Empty means `find` defaults to `.`. The words stay masked, for
# gp_literal to read.
_gp_find_starts=()
gp_find_starts() {
  _gp_find_starts=()
  while (($#)); do
    case "$(gp_literal "$1")" in
      -H | -L | -P | -O*) shift ;;
      -D) shift 2 || return 0 ;;
      --)
        shift
        break
        ;;
      *) break ;;
    esac
  done
  while (($#)); do
    case "$(gp_literal "$1")" in
      -* | '(' | '\(' | '!' | '\!' | ',') return 0 ;;
    esac
    _gp_find_starts+=("$1")
    shift
  done
}

gp_unwrap() {
  _gp_unwrapped=()
  _gp_wrapper_words=()
  local _gp_in_env=0 _gp_w=
  while (($#)); do
    # An assignment keeps its whole word: the basename of `A=/x/y` is `y`,
    # which would stop the strip before a later `FOO=1` (#1499).
    _gp_w="$1"
    [[ "$_gp_w" == [A-Za-z_]*=* ]] || _gp_w="${_gp_w##*/}"
    case "$_gp_w" in
      env)
        _gp_in_env=1
        shift
        ;;
      nohup | setsid | time | command | stdbuf | nice | ionice | xargs | sudo)
        _gp_in_env=0
        shift
        ;;
      timeout)
        # Its DURATION is a bare positional, so the shared flag sweep below would
        # stop on it and leave it standing where the command word is looked for.
        _gp_in_env=0
        shift
        while (($#)) && [[ "$1" == -* ]]; do
          case "$1" in
            -k | --kill-after | -s | --signal) shift 2 || return 0 ;;
            *) shift ;;
          esac
        done
        shift || return 0
        continue
        ;;
      bg-run.sh)
        [[ "${2-}" == run ]] || break
        _gp_in_env=0
        shift 3 || break
        continue
        ;;
      [A-Za-z_]*=*)
        ((_gp_in_env)) || break
        _gp_wrapper_words+=("$1")
        shift
        ;;
      *) break ;;
    esac
    # `-u NAME` and `-C DIR` take their value as a SEPARATE word, so sweeping
    # flags alone leaves `NAME` standing where the command word is looked for.
    # The joined spellings (`-uNAME`,
    # `--unset=NAME`) need nothing — they are one flag word.
    while (($#)) && [[ "$1" == -* ]]; do
      case "$1" in
        -u | -C | --unset | --chdir) shift 2 || return 0 ;;
        -S | --split-string | --split-string=*)
          ((_gp_in_env)) || {
            shift
            continue
          }
          if [[ "$1" == --split-string=* ]]; then
            set -- "${1#--split-string=}" "${@:2}"
          else
            shift
          fi
          (($#)) || return 0
          _gp_split=()
          read -ra _gp_split <<<"$(gp_literal "$1")"
          shift
          set -- "${_gp_split[@]}" "$@"
          continue 2
          ;;
        *)
          if _gp_takes_value "$_gp_w" "$1"; then
            shift 2 || return 0
          else
            shift
          fi
          ;;
      esac
    done
  done
  _gp_unwrapped=("$@")
}

# gp_carries_var <NAME> <word>... — true where the command whose ORIGINAL words
# follow carries NAME set to a non-empty value (#1499), as an escape a guard
# reads off the command string.
#
# Read from two sources and no other: the segment's own leading assignments,
# and the assignments `gp_unwrap` takes off an `env`. Spelled
# `env NAME=1 npm run test`, the assignment is an argument to `env`, not one
# _gp_command_words sets $_gp_assign_end past (mantahostels#2511, mantahostels#2524). A word
# after the command word — `npm run test -- NAME=1` — is a flag value and no
# escape.
#
# Hand it the callback's words BEFORE any `set -- "${_gp_unwrapped[@]}"`: it
# runs gp_unwrap over them itself, leaving $_gp_unwrapped and
# $_gp_wrapper_words as that call sets them. Call it inside a gp_walk_commands
# callback, in the caller's own shell and never in `$(…)` — it reads that
# segment's $_gp_words.
#
# guard-hook-escape.sh refuses a wider set — empty values, `+=`, `export`,
# `exec NAME=1` — and reads the two sources itself; this answer would loosen it.
gp_carries_var() {
  local _gp_name="$1" _gp_w
  shift
  gp_unwrap "$@"
  for _gp_w in ${_gp_words+"${_gp_words[@]:0:_gp_assign_end}"} \
    ${_gp_wrapper_words+"${_gp_wrapper_words[@]}"}; do
    [[ "$_gp_w" == "$_gp_name"=?* ]] && return 0
  done
  return 1
}

# _gp_git_takes_value <option> — true where one of git's own options, before the
# subcommand, takes its value as the next word.
_gp_git_takes_value() {
  case "$1" in
    -C | -c | --namespace | --work-tree | --git-dir | --exec-path) return 0 ;;
  esac
  return 1
}

# gp_git_words <word>... — where one command's words, past any launcher wrapper
# (gp_unwrap) and git's own options, are a `git` subcommand, answer it in
# $_gp_git_sub, read through gp_literal, and the words after it, RAW, in
# $_gp_git_args (#2383). Non-zero where the command is not `git` or carries
# no subcommand. For a reader judging the command and not the tree it runs
# against, which takes a git walker instead.
_gp_git_sub=""
_gp_git_args=()
gp_git_words() {
  _gp_git_sub=""
  _gp_git_args=()
  gp_unwrap "$@"
  set -- ${_gp_unwrapped+"${_gp_unwrapped[@]}"}
  local _gp_w
  _gp_w="$(gp_literal "${1-}" 2>/dev/null)"
  [[ "${_gp_w##*/}" == git ]] || return 1
  shift
  while (($#)) && [[ "$1" == -* ]]; do
    if _gp_git_takes_value "$1"; then shift 2 || return 1; else shift; fi
  done
  (($#)) || return 1
  _gp_git_sub="$(gp_literal "$1" 2>/dev/null)"
  shift
  _gp_git_args=("$@")
}

# gp_gh_words <word>... — one command's words from `gh`'s command word on,
# answered in $_gp_gh_args, RAW: each is still to be read through gp_literal
# (#772). Stepped over first: any launcher wrapper (gp_unwrap), a path to the
# binary, and `gh`'s own flags before the command word, of which only
# `-R`/`--repo` takes a value.
#
# The `-R`/`--repo` value it steps over is kept, raw, in $_gp_gh_repo.
#
# Non-zero where the command is not `gh`, or where `--help`/`-h` stands anywhere
# in it: usage prints and dispatches nothing.
_gp_gh_args=()
_gp_gh_repo=""
gp_gh_words() {
  _gp_gh_args=()
  _gp_gh_repo=""
  gp_unwrap "$@"
  set -- ${_gp_unwrapped+"${_gp_unwrapped[@]}"}
  local _gp_w
  _gp_w="$(gp_literal "${1-}" 2>/dev/null)"
  [[ "${_gp_w##*/}" == gh ]] || return 1
  shift
  for _gp_w in "$@"; do
    _gp_w="$(gp_literal "$_gp_w" 2>/dev/null)"
    [[ "$_gp_w" == --help || "$_gp_w" == -h ]] && return 1
  done
  # gp_literal's exit is ignored: a flag carrying an expansion (`--repo=$R`)
  # is still a flag to step over.
  while
    _gp_w="$(gp_literal "${1-}" 2>/dev/null)"
    [[ "$_gp_w" == -* ]]
  do
    case "$_gp_w" in
      -R | --repo)
        _gp_gh_repo="${2-}"
        shift 2 || return 1
        ;;
      --repo=*)
        _gp_gh_repo="${1#--repo=}"
        shift
        ;;
      -R?*)
        _gp_gh_repo="${1#-R}"
        shift
        ;;
      *) shift ;;
    esac
  done
  _gp_gh_args=("$@")
}

# gp_walk_shared_git <fn> <noun> <subcommand>...
#
# Call <fn> once per git invocation of one of the named subcommands that runs
# against THIS repo's shared working tree, with:
#
#   $1 the flattened segment, $2 the subcommand, $3 the tree it runs against,
#   $4 onward the subcommand's own arguments.
#
# Everything else is filtered out here: another repo, a linked worktree, a
# subcommand the guard did not ask for, and a `cd` — which moves the running cwd
# rather than being judged.
#
# <noun> names what the guard would have judged, for the fail-open record. Only
# the named subcommands can produce one: a `git status` whose tree cannot be
# resolved is not a fail-open, because no guard was going to judge it, and
# logging it would bury the ones that matter.
gp_walk_shared_git() {
  local _gp_judge_unresolved_tree=0
  _gp_walk_git _gp_is_shared_tree "$@"
}

# gp_walk_shared_git_strict <fn> <noun> <subcommand>... — the same walk, with the
# UNRESOLVED target tree handed to <fn> with $3 EMPTY rather than logged and
# skipped (#301). The callback then owns both the verdict and the fail-open
# record for whatever it still allows.
#
# For a guard whose subject is bad in the shared tree and whose target may BE
# the shared tree: `git -C "$W"` with W unset runs here, so declining to judge
# allows the very command the guard exists to refuse.
#
# THE CONTRACT, for both strict walkers (#311): an empty $3 means the tree is
# UNKNOWN — this repo's shared tree, a linked worktree or another repo alike,
# because the tree is unresolved before either filter runs. Branch on it before
# any `git -C "$3"`: `git -C ""` does not fail, it answers for the HOOK's own
# cwd, so the callback would judge the wrong tree.
gp_walk_shared_git_strict() {
  local _gp_judge_unresolved_tree=1
  _gp_walk_git _gp_is_shared_tree "$@"
}

# gp_walk_repo_git <fn> <noun> <subcommand>... — the same walk, one filter wider:
# ANY working tree of this repo, a linked worktree included (mantahostels#1213). For a guard
# whose reason to refuse is not the shared index — the `--no-verify` deny, which
# protects hooks a worktree runs too (mantahostels#344). Callback signature is
# identical; a guard mixing the two scopes asks gp_tree_scope "$3" for the
# verdicts that only bind the shared tree.
gp_walk_repo_git() {
  local _gp_judge_unresolved_tree=0
  _gp_walk_git _gp_is_repo_tree "$@"
}

# gp_walk_repo_git_strict <fn> <noun> <subcommand>... — gp_walk_repo_git's scope,
# gp_walk_shared_git_strict's handling of an unresolved tree, and its contract
# (#311).
gp_walk_repo_git_strict() {
  local _gp_judge_unresolved_tree=1
  _gp_walk_git _gp_is_repo_tree "$@"
}

# _gp_as_written <masked text> — the text as typed, into $_gp_written: each
# blanked span put back inside its own quotes, and a span index never recorded
# written as `<quoted>` rather than guessed. Two passes, because a
# double-quoted span can hold a single-quoted one's sentinel; the third is a
# ceiling. RESIDUAL: nesting past it leaves `QSTR<n>` in the text, gl_log
# stripping only its \x01.
_gp_as_written() {
  local s="$1" out idx span _
  for _ in 1 2 3; do
    [[ "$s" == *"$QUOTED"* ]] || break
    out=""
    while [[ "$s" == *"$QUOTED"* ]]; do
      out+="${s%%"$QUOTED"*}"
      s="${s#*"$QUOTED"}"
      idx="${s%%$'\x01'*}"
      s="${s#*$'\x01'}"
      if [[ "$idx" =~ ^[0-9]+$ ]] && [[ -n "${_gp_spans[idx]+set}" ]]; then
        span="${_gp_spans[idx]}"
        out+="$span${span:0:1}"
      else
        out+="<quoted>"
      fi
    done
    s="$out$s"
  done
  _gp_written="$s"
}

# _gp_unresolved_detail — field 4 of the unresolved-tree record (#315, #320),
# into $_gp_detail: what the walk could not resolve as typed, the hook's $PWD,
# and the walk's own cwd.
_gp_unresolved_detail() {
  local t="$_gp_target_written"
  [[ -n "$t" ]] || t="$_gp_target_dir"
  [[ -n "$t" ]] || t="$_gp_cwd_lost"
  _gp_as_written "${t:-<unknown>}"
  _gp_detail="target=$_gp_written pwd=$PWD cwd=${_gp_cwd:-<unknown>}"
}

# gp_empty_vars — inside the callback of a walk opted in with --empty-unset,
# each name read as unset and substituted empty on the way to the tree in $3
# (#325), once each, one per line, without its `$`.
gp_empty_vars() {
  local -A _gp_seen=()
  local n
  for n in $_gp_target_names; do
    [[ -n "${_gp_seen[$n]+set}" ]] && continue
    _gp_seen[$n]=1
    printf '%s\n' "$n"
  done
}

# gp_unset_text <var> — the line #310 ruled for a refusal whose tree was reached
# through an unset variable, with a blank line after it, into the caller's
# <var>; empty where gp_empty_vars names none. Into a variable, not printed:
# `$(…)` would strip that blank line.
gp_unset_text() {
  local -a _gp_names=()
  local _gp_n _gp_list="" _gp_verb=is
  printf -v "$1" '%s' ""
  mapfile -t _gp_names < <(gp_empty_vars)
  ((${#_gp_names[@]})) || return 0
  for _gp_n in "${_gp_names[@]}"; do _gp_list+="${_gp_list:+, }\`\$$_gp_n\`"; done
  ((${#_gp_names[@]} == 1)) || _gp_verb=are
  printf -v "$1" '%s' "$_gp_list $_gp_verb unset in this call; shell variables do not carry over between Bash calls."$'\n\n'
}

# The body every walker shares: $1 is the tree test, which must answer 0 for a
# tree to judge, 2 for one git could not answer for, and anything else for a
# tree this walk has no business in.
#
# --empty-unset, before <fn>, is the opt-in #310 ruled: a `cd`/`git -C` target
# whose every `$` is a bare name the command does not assign and the hook's
# environment does not set — or one the command sets to empty — is substituted
# EMPTY and judged, which in quotes is the cwd. Shell state does not carry
# between Bash calls, so that is the tree the command runs in. Anything else
# unresolved — `$(…)`, `${W:-x}`, a command carrying `||` — keeps its fail-open.
# --unwrap, in either order with it, judges a git command behind gp_unwrap's
# wrappers (#1731). Both are local, so a walk nested in the callback does not
# inherit them.
_gp_walk_git() {
  local tree_test="$1" _gp_empty_unset=0 _gp_unwrap_git=0
  shift
  while [[ "${1-}" == --empty-unset || "${1-}" == --unwrap ]]; do
    if [[ "$1" == --empty-unset ]]; then _gp_empty_unset=1; else _gp_unwrap_git=1; fi
    shift
  done
  local fn="$1" noun="$2"
  shift 2
  local -a _gp_wanted=("$@") _gp_cwd_names_stack=()
  local segment want hit _gp_path_names="" _gp_cwd_names="" _gp_target_names=""
  local _gp_seg_idx=-1 _gp_no_redirects=0 _gp_ar_prev="" _gp_ar_last=""
  local -a _gp_cmd_redirs=() _gp_ar_stack=()

  _gp_init_repo
  _gp_split_segments
  _gp_cwd="$PWD"
  _gp_cwd_lost=""
  _gp_cwd_stack=()

  while IFS= read -r segment; do
    ((++_gp_seg_idx))
    _gp_arith_scope "$segment" && continue
    _gp_parse_segment "$segment" || continue
    _gp_cmd_redirs=(${_gp_redirs+"${_gp_redirs[@]}"})

    hit=0
    for want in ${_gp_wanted+"${_gp_wanted[@]}"}; do
      [[ "$_gp_sub" == "$want" ]] && {
        hit=1
        break
      }
    done
    ((hit)) || continue

    _gp_resolvable "$_gp_target_dir" ||
      {
        # Opted in through either strict walker (#301, #311), whose header says
        # why a guard would want this.
        ((_gp_judge_unresolved_tree)) && {
          "$fn" "$segment" "$_gp_sub" "" ${_gp_args+"${_gp_args[@]}"}
          continue
        }
        _gp_unresolved_detail
        gl_log "could not resolve the working tree for a git $_gp_sub — $noun allowed unchecked" "$_gp_detail"
        continue
      }
    # Exit 2 is "git could not answer for that directory", not "a different
    # tree"; the guard is declining to judge a command it asked for, so it is
    # recorded.
    "$tree_test" "$_gp_target_dir" || {
      (($? == 2)) &&
        gl_log "git could not answer for $_gp_target_dir — a git $_gp_sub there was allowed unchecked"
      continue
    }

    "$fn" "$segment" "$_gp_sub" "$_gp_target_dir" ${_gp_args+"${_gp_args[@]}"}
  done <<<"$_gp_segments"
  return 0
}

# gp_scan_flags <spec> <fn> -- <word>...
#
# Read one command's own arguments and hand <fn> one event per option or bare
# word (mantahostels#477).
#
# <spec> is the space-separated list of the flags that TAKE A VALUE, short and
# long together — "-c --comment -R --repo". Every other flag takes none. Leave
# one out and its value is read as the next argument, and the guard reaches a
# verdict on the wrong word.
#
# <fn> is called once per word, with <kind> <name> <value>:
#
#   opt      <flag>  <value>   a value-taking flag, and the value it took
#   flag     <flag>  ""        a flag taking no value
#   dangling <flag>  ""        a value-taking flag with no value left to take
#   arg      ""      <word>    a bare word
#
# A non-zero return from <fn> stops the scan, and gp_scan_flags returns non-zero
# too.
#
# A BARE `--` ENDS THE OPTIONS: it is emitted as `flag --`, and every word after
# it is an `arg` however it is spelled, so `git commit -m x -- -weird-file`
# reaches the caller as the pathspec it is rather than as a flag (mantahostels#495). git and
# gh (pflag) both parse it that way, so this is faithfulness for every caller,
# not a capability added for one — which is why it needs no event kind of its
# own.
#
# A `--flag=value` is read as name and value WHATEVER <spec> says, so no guard
# has to be told in advance which flags a writer might spell that way.
#
# A SHORT-FLAG RUN IS WALKED CHARACTER BY CHARACTER, and a value-taking letter
# takes the rest of the run: `-qr` is -q then -r, `-Xtheirs` is -X with the
# value theirs, `-ltakes:human` is -l with that label. That one rule is what
# makes the bundle walk guard-pull-form.sh needs and the argv walk the two gh
# guards need the same function rather than two parameterised ones. A leading =
# on such a value is dropped: gh's flag reader (pflag) takes `-l=x` as x.
#
# A SHORT FLAG WHOSE VALUE IS OPTIONAL is listed with a trailing ?, as `-S?`. It
# takes the rest of its run as a value, but never the next word. Its value
# keeps a leading =, as git's does: `-S=key` is key =key.
#
# It knows nothing of quoting. The words arrive already masked from
# _gp_command_words, and gp_literal is what reads a value back.
gp_scan_flags() {
  local spec="$1" fn="$2"
  shift 2
  [[ "${1-}" == "--" ]] && shift
  local -a _gp_argv=("$@")
  local i=0 j tok val rest ch ended=0
  while ((i < ${#_gp_argv[@]})); do
    tok="${_gp_argv[i]}"
    if ((ended)); then
      "$fn" arg "" "$tok" || return 1
      ((i++))
      continue
    fi
    case "$tok" in
      # A lone `-` is stdin, not an option. Called a bare word instead, it would
      # be read as guard-issue-close.sh's issue number.
      -) "$fn" flag "-" "" || return 1 ;;
      --)
        ended=1
        "$fn" flag "--" "" || return 1
        ;;
      --*=*) "$fn" opt "${tok%%=*}" "${tok#*=}" || return 1 ;;
      --*)
        if [[ " $spec " == *" $tok "* ]]; then
          if ((i + 1 < ${#_gp_argv[@]})); then
            "$fn" opt "$tok" "${_gp_argv[i + 1]}" || return 1
            ((i += 2))
            continue
          fi
          "$fn" dangling "$tok" "" || return 1
        else
          "$fn" flag "$tok" "" || return 1
        fi
        ;;
      -?*)
        rest="${tok#-}"
        for ((j = 0; j < ${#rest}; j++)); do
          ch="${rest:j:1}"
          val="${rest:j+1}"
          if [[ " $spec " == *" -$ch? "* ]]; then
            if [[ -n "$val" ]]; then
              "$fn" opt "-$ch" "$val" || return 1
            else
              "$fn" flag "-$ch" "" || return 1
            fi
            break
          fi
          if [[ " $spec " != *" -$ch "* ]]; then
            "$fn" flag "-$ch" "" || return 1
            continue
          fi
          if [[ -n "$val" ]]; then
            "$fn" opt "-$ch" "${val#=}" || return 1
          elif ((i + 1 < ${#_gp_argv[@]})); then
            "$fn" opt "-$ch" "${_gp_argv[i + 1]}" || return 1
            ((i++))
          else
            "$fn" dangling "-$ch" "" || return 1
          fi
          break
        done
        ;;
      *) "$fn" arg "" "$tok" || return 1 ;;
    esac
    ((i++))
  done
  return 0
}

# gp_git_value_flags <merge|rebase|commit> — the gp_scan_flags spec for that
# subcommand, shared by guard-pull-form.sh and guard-commit-form.sh (#302).
#
# Derived from `git merge -h`, `git rebase -h` and `git commit -h`, then each
# entry measured on
# git 2.43.0: `git <sub> <flag> --bogus other` reports --bogus as the flag's
# bad value where the flag swallows the next word, and as an unknown option
# where it does not. The help text alone misleads twice: `-m` under rebase is
# --merge and takes nothing, and `-S`, `--gpg-sign`, `--log` and rebase's `-r`
# print a value but take one only when stuck on (`-Skey`, `--log=5`).
#
# A flag missing here has its value read as a flag, and one listed wrongly
# swallows a real flag — both guards' verdicts are wrong either way. The long
# optional-value flags are absent
# because gp_scan_flags reads `--flag=value` unprompted.
gp_git_value_flags() {
  case "$1" in
    merge) echo "-s -X -m -F -S? --strategy --strategy-option --message --file --cleanup --into-name" ;;
    rebase) echo "-s -X -x -C -S? -r? --strategy --strategy-option --onto --exec --whitespace --empty" ;;
    commit) echo "-m -c -C -F -t --message --author --date --file --template --reedit-message --reuse-message --fixup --squash --cleanup --trailer --pathspec-from-file" ;;
  esac
}

# gp_adopt_payload <payload> — gp_begin's payload read without its stdin read,
# its disabled check or its subject. The caller owns all three. It arms
# gl_arm_exit's record.
gp_adopt_payload() {
  _gp_payload="$1"
  gl_arm_exit
}

# gp_begin <jq path> <noun> — read the hook payload from stdin and keep the
# field this guard judges. Allows (exit 0) on anything unreadable, including a
# missing jq — and records every one of those, because a guard reading no
# subject judges nothing at all.
#
# An EMPTY payload is the one case that is not a fault: there is nothing to
# check. Everything below it is, because a payload that matched the guard's tool
# always carries the field today, so an extraction that comes back empty means
# the payload's shape has changed under the guard.
#
# <noun> is what would be allowed unchecked — "command" for the Bash guards,
# "skill call" for guard-last30days.sh.
#
# <field label> names the missing field in that last record, and defaults to the
# jq path's last component. guard-file-claim.sh passes one because its path is an
# alternation — .tool_input.file_path // .tool_input.notebook_path — so the
# default would report a Write payload as missing `notebook_path` (mantahostels#187).
gp_begin() {
  local field="$1" noun="$2" label="${3:-${1##*.}}"
  # A guard the host lists under "disabled" stands down unread (#2).
  wfc_disabled "${0##*/}" 2>/dev/null && exit 0
  gp_adopt_payload "$(cat)"
  [[ -n "$_gp_payload" ]] || gp_allow
  command -v jq >/dev/null 2>&1 ||
    gl_open "jq not found — $noun allowed unchecked"
  _gp_subject="$(gp_payload_field "$field")" ||
    gl_open "payload did not parse as JSON — $noun allowed unchecked"
  [[ -n "$_gp_subject" ]] ||
    gl_open "no $label in payload — $noun allowed unchecked"
  # A second payload in one process is a new subject: the split and the cwd
  # seed are the last one's (#2383).
  _gp_split_done=0
  _gp_cwd_seed=""
}
