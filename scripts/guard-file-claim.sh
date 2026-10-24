#!/usr/bin/env bash
# PreToolUse guard: refuse a write to a file another live session is holding.
#
# THIN BY DESIGN. All of it lives in the arbiter — scripts/session-arbiter.js and
# its store under scripts/lib/ — mantahostels#102 ruled one named subsystem with thin guards
# over it rather than independent guards, divergent attribution logic being a
# demonstrated failure.
#
# It must watch Write, Edit and NotebookEdit alike, or a session simply reaches
# for the tool the guard does not watch.
#
# LIMITS
#  - It FAILS OPEN (mantahostels#103 §6): no node, no jq, an arbiter that throws, a payload
#    it cannot parse, a lib/guard-parse.sh it cannot load — all allow the write.
#    ONE EXCEPTION (mantahostels#1646), and it is gp_rule's rather than this guard's:
#    the store side of the injection below fails CLOSED (lib/guard-parse.sh),
#    exiting 2 and refusing the write on an unloadable lib/rule-text.sh, an
#    unknown id, an empty fragment or one over the emission ceiling. A guard
#    that denies while stating no rule is the failure that pays for it (mantahostels#1644).
#    The payload side of the same call fails open like everything else here.
#    A fail-closed bug would halt every concurrent session the WSL memory cap
#    allows, on their most-used files. The cost is that a silently
#    broken guard looks exactly like a guard finding nothing wrong, which is why
#    every fail-open is recorded — through lib/guard-log.sh, shared with every
#    other guard (mantahostels#147) — and check-guard-errors.js reports it.
#  - A file written by a Bash heredoc or by a script is invisible to it — that
#    is why the arbiter exposes a `claim` command scripts call for themselves
#    (mantahostels#99's signal 3).
#  - On docs/doc-map.md alone the claim is per-REGION, not per-file (mantahostels#848, built
#    at mantahostels#970): one `### B<n>` entry, one §A register row (mantahostels#1402), or one
#    top-level section — or, where one anchor straddles several of them, every
#    region it rewrites, taken all or none (mantahostels#1685). Everywhere else a
#    claim is still the whole file. Region resolution failing — an unreadable
#    file, an anchor that cannot be placed, a parser that throws — falls back to
#    the whole-file claim and SAYS SO, never to no claim at all.
#  - It refuses on docs/, .claude/, CLAUDE.md and AGENTS.md, and on nothing
#    else. scripts/ is a detect-only tier (mantahostels#287) this guard never denies on;
#    everything further out is left to git, since guarding the lot would be a
#    repo-wide per-file mutex (mantahostels#103). ONE HOLE INSIDE THAT SCOPE: .claude/tmp/,
#    the sanctioned scratch directory (mantahostels#2089), which arbiter-core.js's EXEMPT
#    list drops from both tiers — throwaway bytes carry no work to protect.
#  - A SECOND LIMB (mantahostels#1646, spec mantahostels#1762): on the CLEAN branch it hands the
#    session the claim cluster's five rules — docs/agents/rules/file-claim.txt,
#    claim-release.txt, denied-edit-debt.txt, claim-bash-route.txt and
#    script-self-claim.txt — through gp_rule at the foot of this file. gp_rule
#    latches per session, so each is said once, and its 4,000-byte ceiling
#    spreads the five over the session's first writes — a scripts-tier session
#    gets file-claim on its second.
#  - A THIRD (workflow-core#1011): a Write CREATING scripts/guard-*.sh or guard-*.js is
#    first handed guard-authoring.txt, the pointer to the eight surfaces a new
#    guard owes — the one place this guard reads tool_name. A guard created
#    through Bash, or named otherwise, gets nothing.
#  - A FOURTH (workflow-core#2016): on the deny tier, a write to a path
#    docs/doc-map-classes.json registers `derived` or `generated-only` leads the
#    cluster with doc-authority-class.txt.
#  - A FIFTH (workflow-core#2021, workflow-core#2233, workflow-core#2301, workflow-core#2302): a write to a path the docs arm's
#    path_rules table lists, in a host with that row's modules on, leads the
#    cluster with the row's rule.
#  - A SIXTH (workflow-core#2030): a write to a skill file, a CLAUDE.md or an AGENTS.md,
#    anywhere in the repo, leads with writing-for-agents.txt — on its own
#    outside both tiers, where no claim rules ride.
#
# DENIES-THROUGH: session-arbiter.js check — its refusal is relayed byte for byte below, and this line is what lib/deny-capable.js reads to know this guard can refuse (workflow-core#1815).
#
# IMPLICIT:  besides refusing a write to a held file, TAKES a claim on the file this session is writing and pins its prior bytes for recovery, and on an ALLOWED write hands over the claim rules, and the writing-for-agents pointer on a document written for agents — none of the three asked for.
# JUSTIFIED: fail-safe — a claim nobody has to remember to take is what makes a clobber by any route reportable and the overwritten version recoverable (mantahostels#295); and a rule stated before the mistake reaches a session that would otherwise never have read it (mantahostels#1762).
# DEFEAT:    none — the claim is minted by the write itself; `session-arbiter.js release [--force] <path>` drops one afterwards. The injection is silenced by having already had it, by writing outside both tiers (the writing-for-agents pointer excepted), or — for that write alone, the rules deferring unlatched to the next one — by the arbiter having REFUSED. A note it merely SAID rides in the same envelope as the rules, as gp_rule_prelude, rather than displacing them (mantahostels#2334, mantahostels#2359, mantahostels#2369). THREE RESIDUALS. A REFUSAL still displaces the cluster whole, because it carries a permissionDecision and gp_rule can only emit additionalContext — denied-edit-debt is reprinted in the refusal itself, the other three are not. The note spends gp_rule's 4,000-byte ceiling, so a long one pushes low-priority ids off the end: they defer unlatched, which is loss again only for a session that never writes a guarded file twice. And gp_rule's own missing-jq fail-open loses the note outright, jq being what renders the envelope it would ride in.

set -uo pipefail

here="$(dirname "${BASH_SOURCE[0]}")"

# The fail-open record, sourced separately so the load failure below is loggable
# at all. A guard-log.sh that cannot be read leaves this guard doing its real
# work unlogged rather than not doing it; check-guard-errors.js probes for the
# library's absence directly.
# shellcheck source=scripts/lib/guard-log.sh
source "$here/lib/guard-log.sh" 2>/dev/null
declare -F gl_open >/dev/null 2>&1 || gl_open() { exit 0; }
declare -F gl_log >/dev/null 2>&1 || gl_log() { :; }

# The shared library, for the payload seam and the verdict envelope only (mantahostels#157,
# mantahostels#187) — this guard judges a JSON tool payload, never a shell command, so it
# takes neither walker and never loads the parser's git machinery. Same load
# gate as every other guard: `declare -F gp_begin`, never `source`'s own exit
# status, and a library it cannot read disarms the guard rather than blocking
# every write (mantahostels#103 §6, fail open).
# shellcheck source=scripts/lib/guard-parse.sh
source "$here/lib/guard-parse.sh" 2>/dev/null
declare -F gp_begin >/dev/null 2>&1 || {
  gl_open "lib/guard-parse.sh did not load — write allowed unchecked"
}

# For gp_rule_module, which skips the module-gated rules without it.
# shellcheck source=scripts/lib/wfc-config.sh
source "$here/lib/wfc-config.sh" 2>/dev/null ||
  gl_log "lib/wfc-config.sh did not load — the module-gated claim rules are skipped"

# NotebookEdit names its target notebook_path, not file_path. Reading only the
# latter matched the tool and then allowed every write through it unchecked.
#
# gp_begin logs rather than silently allowing on each of a missing jq, a payload
# that is not JSON, and an empty extraction: a matched Write/Edit/NotebookEdit
# payload always carries a path today, so an empty one means the payload's shape
# has changed under the guard — the notebook_path defect again, and the log is
# the only place it can show. An empty payload alone is not a fault; there is
# nothing to check.
gp_begin '.tool_input.file_path // .tool_input.notebook_path' "write" "file path"
file="$(gp_subject)"

command -v node >/dev/null 2>&1 || gl_open "node not found — write allowed unchecked"

# A Write to a path not yet on disk is a file being CREATED (workflow-core#1011): read here,
# before the arbiter runs, so nothing it does to the path can answer for it. An
# Edit cannot create a file, so only a Write counts.
creating=""
[[ "$(gp_payload_field '.tool_name')" == "Write" && ! -e "$file" ]] && creating=1

# The EDIT ANCHOR (mantahostels#970). An Edit payload carries old_string, and where the file
# is docs/doc-map.md that string is what places the write inside one `### B<n>`
# entry or one §A register row, so two sessions on two entries — or registering
# two different documents — never contend. The RESOLUTION is the
# arbiter's, not this guard's: it forwards the anchor and judges nothing about
# it.
#
# Write and NotebookEdit carry no such field, so the extraction is empty and the
# arbiter claims the file entire, which is the honest reading of a whole-file
# write.
#
# TRUNCATED at 8000 characters, because the anchor crosses an execve boundary and
# Linux caps a single argument at 128 KB — a longer old_string would fail the
# exec rather than the check.
#
# The ORIGINAL LENGTH rides alongside it, because truncation loses the anchor's
# END and the end is what says whether the write crosses out of one entry into
# the next. Told the length, the arbiter treats a truncated anchor as
# unresolvable and claims the whole file; told nothing, it would silently claim
# the entry the surviving prefix happens to sit in.
#
# THE SENTINEL X is what keeps a newline-terminated anchor whole (mantahostels#1188).
# Command substitution strips EVERY trailing newline, while the length below is
# jq's over the untouched string, so a newline-terminated anchor reads as
# truncated and the arbiter claims the WHOLE file. Appending X inside the
# substitution puts a non-newline last, so nothing of the value is stripped, and
# `%X` removes exactly one character.
#
# The `&&` separates a jq FAILURE from a field that is legitimately absent: an
# absent old_string prints `""` and exits 0, taking the sentinel and emptying
# normally, while a failed jq prints nothing and appends no X. So only the
# failure reaches the else arm, and its gl_log is what stops that fail-open
# being the one route to a whole-file claim check-guard-errors.js never sees.
anchor="$(gp_payload_field '.tool_input.old_string[0:8000]' && printf X)"
if [[ "$anchor" == *X ]]; then
  anchor="${anchor%X}"
else
  anchor=""
  gl_log "jq could not read old_string on $file — anchor dropped, whole file claimed"
fi
# jq's `length` of a null is 0, so a payload with no old_string sends 0 — read
# only after the empty-anchor test, which answers first.
anchor_len="$(gp_payload_field '.tool_input.old_string | length')" || anchor_len=""

# THE ENTRY IDS THIS WRITE INTRODUCES (mantahostels#1424) — every `### B<n>` heading present
# in new_string and absent from old_string, comma-joined. The arbiter warns where
# the session holds no claim on one, `alloc-entry` being what hands an id and its
# append slot out together; it never refuses on it.
#
# EXTRACTED IN JQ, not forwarded as new_string whole. new_string is unbounded and
# would need the same 8000-character truncation the anchor takes — which would
# then leave "no new ids" and "the ids fell off the end" indistinguishable, the
# ambiguity anchor_len exists to resolve. A handful of matched ids cannot truncate.
#
# THE SUBTRACTION IS JQ'S TOO, against the UNTRUNCATED old_string, so an Edit that
# merely rewrites the body under a heading it quotes introduces nothing. Doing it
# arbiter-side would compare against the truncated anchor and warn about a heading
# the edit only re-typed.
#
# ONLY new_string IS READ. A Write payload carries `content` instead, and a
# whole-file Write claims the file entire — so nothing per-entry could be said
# about it anyway.
#
# And this sees TOOL WRITES ONLY, as the LIMITS above say of the guard entire: a
# `sed -i`, a heredoc or a script appending an entry reaches docs/doc-map.md with
# no payload to read, so an id taken that way is never warned about.
#
# Capped at 64 ids, far above any real entry-adding edit and short of an argv a
# pathological payload could blow the 128 KB execve limit with.
#
# Same sentinel-X and `&&` discipline as the anchor (mantahostels#1188): a jq FAILURE logs and
# forwards nothing, rather than an empty list the arbiter would read as "this
# write adds no entries".
new_ids="$(gp_payload_field '[[(.tool_input.new_string // "") | split("\n")[] | scan("^### (B[0-9]+)")] - [(.tool_input.old_string // "") | split("\n")[] | scan("^### (B[0-9]+)")] | .[][0]] | unique | .[0:64] | join(",")' && printf X)"
if [[ "$new_ids" == *X ]]; then
  new_ids="${new_ids%X}"
else
  new_ids=""
  gl_log "jq could not read new_string on $file — entry ids dropped, allocation unchecked"
fi

# Claude Code sends session_id on every hook payload; the env var is the
# fallback.
session="$(gp_payload_field '.session_id')" || session=""
[[ -n "$session" ]] || session="${CLAUDE_CODE_SESSION_ID:-}"

# The arbiter prints the hook JSON itself, or nothing when it has nothing to say.
#
# CAPTURED rather than passed straight through, because the pre-emptive limb at
# the foot of this file emits a hook object of its own and Claude Code reads one
# per hook.
#
# Bounded by `timeout`, because fail-open-on-exception cannot catch a HANG
# (mantahostels#175). Without this, an arbiter that wedged would stall every
# guarded write for the full hook timeout. 5s is far above the ~80ms a real
# check takes and below settings.json's 10s.
#
# gl_open EXITS, so it cannot be called from inside the substitution — there it
# would end the subshell and let this file run on as though the arbiter had
# answered.
if command -v timeout >/dev/null 2>&1; then
  arb="$(timeout 5 node "$here/session-arbiter.js" check "$file" "$session" "$anchor" "$anchor_len" "$new_ids" 2>/dev/null)"
  rc=$?
else
  arb="$(node "$here/session-arbiter.js" check "$file" "$session" "$anchor" "$anchor_len" "$new_ids" 2>/dev/null)"
  rc=$?
fi
# The arbiter names its own commands as `scripts/x`; an install serves them
# through the plugin root (workflow-core#343).
# shellcheck source=scripts/lib/script-path.sh
if [[ -n "$arb" ]] && source "$here/lib/script-path.sh" 2>/dev/null; then
  arb="$(printf '%s' "$arb" | resolve_script_paths)"
fi
# HELD, NOT PRINTED (mantahostels#2369). A note the arbiter merely SAID rides out in the
# rule envelope below instead, so a session making a single guarded write gets
# both. Every path between here and there that does not reach gp_rule prints it
# itself — gl_open writes nothing to stdout, so an unqualified one swallows it.
#
# The fail-opens below are three of those paths, and they come first.
if ((rc != 0)); then
  [[ -n "$arb" ]] && printf '%s\n' "$arb"
  # The arbiter catches its own exceptions and exits 0, so ANY non-zero exit is a
  # fault it never saw and never logged: 124 is timeout's own "I killed it", 137
  # is earlyoom reaping node at the WSL memory cap, and a node that fails to start gives
  # neither.
  ((rc == 124)) && gl_open "arbiter timed out on $file — write allowed unchecked"
  gl_open "arbiter exited $rc on $file — write allowed unchecked"
fi

# ONLY THE EXACT NOTE SHAPE IS UNWRAPPED — the whole object, keys and all
# (`keys` sorts), because unwrapping re-emits one field and would drop anything
# else the arbiter said. Every other shape is relayed byte for byte:
#
#   a DENIAL — it carries a permissionDecision, which gp_rule cannot emit, so
#     the cluster defers there, unlatched.
#   a shape jq cannot read, or one carrying a field not named here.
arb_note=""
if [[ -n "$arb" ]]; then
  arb_note="$(printf '%s' "$arb" |
    jq -r 'if (keys == ["hookSpecificOutput"])
             and (.hookSpecificOutput | keys == ["additionalContext", "hookEventName"])
             and (.hookSpecificOutput.hookEventName == "PreToolUse")
           then .hookSpecificOutput.additionalContext
           else empty end' 2>/dev/null)"
  if [[ -z "$arb_note" ]]; then
    printf '%s\n' "$arb"
    gp_allow
  fi
fi

# PRE-EMPTIVE INJECTION (mantahostels#1646, spec mantahostels#1762) — the claim cluster's five rules,
# handed over BEFORE the mistake rather than only in the refusal that follows
# one. gp_rule emits additionalContext and never a permissionDecision, so an
# allow stays an allow, and it latches per (rule, agent, session) so each rule
# is said once.
#
# AN ARBITER NOTE RIDES WITH THIS RATHER THAN SILENCING IT (mantahostels#2369): it is handed
# to gp_rule_prelude, spending the same ceiling. Only a DENIAL displaces the
# rules, above.
#
# THE TIER TEST IS THIS FILE'S, AND CHOOSES ONLY WHETHER TO SPEAK. The arbiter
# stays the authority on what is claimed and what is refused (mantahostels#102); a prefix
# that drifted out of step here costs a hint not given, never a wrong verdict.
# Without it a session working only in app/ would be handed 4 KB of claim rules
# it can never need.

# gr_root strips the trailing slash before the prefix comes off:
# CLAUDE_PROJECT_DIR is an environment variable a human sets, and one spelled
# with a trailing / made every strip below a no-op — no case match, no
# injection, and no log line saying so. That strip lived here alone until mantahostels#1905
# folded all four copies of the expression into the one helper.
root="$(gr_root)"
# Empty is gr_root's disarm signal (lib/guard-root.sh). Untested, the
# strip below takes nothing off and the `case` matches no arm — which is mantahostels#1646's
# defect again, silent, by a second route.
if [[ -z "$root" ]]; then
  [[ -n "$arb_note" ]] && printf '%s\n' "$arb"
  gl_open "the repo root did not resolve — claim rules not stated"
fi
rel="${file#"$root"/}"
rel="${rel#./}"

# A DOCUMENT WRITTEN FOR AGENTS (workflow-core#2030), on whichever arm below takes its path.
# Its id leads each tier's call: small, path-gated and reprinted nowhere, it
# still leaves claim-bash-route room in the first envelope, which the test's
# packing cases pin.
agent_doc=""
case "$rel" in
  .claude/skills/* | .agents/skills/* | CLAUDE.md | AGENTS.md | */CLAUDE.md | */AGENTS.md) agent_doc=1 ;;
esac

# Ids in gp_rule's PRIORITY ORDER, highest first: its 4,000-byte ceiling cannot
# carry all five at once, so the tail defers to the next write.
#
# WHAT THIS CALLER MEANS BY PRIORITY IS SURVIVAL, NOT IMPORTANCE (mantahostels#2386) — a
# departure from guard-parse.sh:189, which reads the parameter as which rule
# matters most. The five arrive in ONE envelope, so their sequence inside it is
# invisible to the reader; the only thing the order decides here is which of
# them the ceiling keeps.
#
# denied-edit-debt IS LAST DELIBERATELY. On the deny tier the whole cluster
# defers — a refusal is the one arbiter output that still displaces it — and
# denied-edit-debt is the only id that costs nothing there: the refusal reprints
# it in full, with the real path substituted, so a session that never gets it
# here gets it at the moment it applies. Nothing anywhere reprints
# claim-bash-route, so it must not be the id that falls off the end.
#
# SO IT LEADS (mantahostels#2386). gp_rule stops at the first id that does not fit rather
# than skipping to a smaller one behind it, so leading with the LARGEST id spent
# most of the ceiling and then broke, and claim-bash-route reached only a session
# that wrote a guarded file twice. Led by the small unreprinted id, both arms fit
# one more id into write 1, a derived doc's arm included. The byte figures are in guard-file-claim.test.ts's
# packing block, which is what fails when a fragment edit moves this boundary.
#
# THE RESIDUAL, AND IT IS LIVE ON BOTH ARMS. A gp_rule_prelude spends this same
# budget, and each arm's first envelope is nearly full, so a note of a few
# hundred bytes drops file-claim to write 2 — mantahostels#2334's whole-file notice for
# docs/doc-map.md already does on the deny arm. It defers UNLATCHED and arrives
# whole on the next write, and a note rides a GRANTED claim, so no refusal was
# going to restate it either way.
case "$rel" in
  .claude/tmp/*)
    # The sanctioned scratch directory (mantahostels#2089, mantahostels#2103), carved out of BOTH halves:
    # arbiter-core.js's EXEMPT list takes no claim there, and this arm keeps the
    # claim rules unsaid — a session writing throwaway scratch has no claim to
    # release and no debt to own. NOT nothing a Bash-route write could clobber,
    # though: two concurrent sessions landing on the same bare filename here
    # clobber each other same as anywhere else (mantahostels#2220 fixed one concrete case,
    # the review-axis paths, by suffixing them with the writing session's id;
    # the exemption itself still offers no general protection against a repeat
    # under a different bare name).
    # It leads the case because the `.claude/*` arm below would otherwise take it.
    [[ -n "$arb_note" ]] && printf '%s\n' "$arb"
    ;;
  docs/* | .claude/* | CLAUDE.md | AGENTS.md)
    gp_rule_prelude "$arb_note"
    # A HAND EDIT OF A `derived` OR `generated-only` DOC (workflow-core#2016) — every Write or
    # Edit is one, generators writing by script. A host with no register, a path
    # it does not list, or a row whose classQualifier leaves part of the file
    # hand-edited skips the rule.
    classes="$root/docs/doc-map-classes.json"
    class=""
    # A blank qualifier is no qualifier, as lib/doc-map.js's sidecarClassText reads it.
    if [[ -f "$classes" ]] && ! class="$(jq -r --arg p "$rel" '.[$p] | select((.classQualifier // "") | test("^\\s*$")) | .class // empty' "$classes" 2>&1)"; then
      gl_log "jq could not read $classes — authority class of $rel unchecked: ${class:0:GL_DETAIL_MAX}"
      class=""
    fi
    [[ "$class" == derived || "$class" == generated-only ]] || gp_rule_skip doc-authority-class
    # THE PATH-TIED RULES (workflow-core#2302), one row each: "<rule> <path> [<module>...]".
    # A write to the path leads the cluster with the rule, in a host with every
    # module named on. The gp_rule call below and guard-file-claim.test.ts's
    # order model both read this table, so the docs arm and the test need no
    # other edit for a new row.
    path_rules=(
      # Nothing here tells a hand edit from the roadmap-edit loop's own, so the
      # loop gets the rule too; its text says so (workflow-core#2021). With roadmap off,
      # check-gate-switches.js refuses any commit while the file is tracked, so
      # the loop cannot land it (workflow-core#2301).
      "roadmap-edit docs/reference-roadmap.html roadmap"
      # The manual-sync skill's own write included; it refuses with either
      # module off (workflow-core#2233).
      "manual-sync docs/operating-manual.md governance roadmap"
    )
    gp_rule_path_rows "$rel" path_rules
    [[ -n "$agent_doc" ]] || gp_rule_skip writing-for-agents
    gp_rule writing-for-agents "${path_rules[@]%% *}" doc-authority-class claim-bash-route file-claim claim-release denied-edit-debt
    ;;
  scripts/*)
    # The detect-only tier, and the one place the script rule has a live trigger:
    # a script writing a tracked doc raises no Write hook at all, so the moment it
    # can be said is while the script is being WRITTEN.
    gp_rule_prelude "$arb_note"
    # A NEW guard also owes the seven surfaces beyond its script (workflow-core#1011). It
    # leads, so the ceiling defers the claim rules rather than it. gp_rule EXITS
    # once it emits, so the call below runs only where this one had nothing left
    # to say — and names a subset of it, so says nothing either.
    if [[ -n "$creating" && "$rel" =~ ^scripts/guard-[^/]+\.(sh|js)$ && "$rel" != *.test.js ]]; then
      gp_rule guard-authoring script-self-claim claim-bash-route file-claim claim-release denied-edit-debt
    fi
    # The adopter templates of CLAUDE.md and AGENTS.md live here.
    [[ -n "$agent_doc" ]] || gp_rule_skip writing-for-agents
    gp_rule writing-for-agents script-self-claim claim-bash-route file-claim claim-release denied-edit-debt
    ;;
  *)
    # A vendored skill under .agents/, or a nested CLAUDE.md: the one rule,
    # with the note riding it.
    if [[ -n "$agent_doc" ]]; then
      gp_rule_prelude "$arb_note"
      gp_rule writing-for-agents
    fi
    # Reached only where no rule was said, so the note goes out on its own.
    [[ -n "$arb_note" ]] && printf '%s\n' "$arb"
    ;;
esac

gp_allow
