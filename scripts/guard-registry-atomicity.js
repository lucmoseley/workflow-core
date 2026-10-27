#!/usr/bin/env node
/*
 * guard-registry-atomicity.js — PreToolUse guard: a commit that lands a member
 * of a repo-wide registry without the wiring that registers it
 * (mantahostels#2671).
 *
 * DENIES-THROUGH: lib/guard-entry.js — `run` writes the core's deny, so the
 * registration carries `"onFailure": "block"` and a crash or timeout refuses.
 *
 * Why: several of this repo's tests assert over the WHOLE repository rather
 * than over one module (mantahostels#2671 names them). An invariant of that
 * shape is FALSE between the commit that adds the member and the commit that
 * wires it, and it is false for everyone. So the member and its wiring land in ONE commit, and this judges
 * that commit.
 *
 * FOUR CLASSES, each the exact predicate of the test it protects:
 *
 *   a new scripts/check-*.js      needs a sibling scripts/check-<name>.test.ts
 *                                 and a caller — one of the four surfaces
 *                                 checker-registrations.test.ts reads. Escape:
 *                                 a CALLED_ELSEWHERE entry in the same commit.
 *
 *   a new scripts/guard-*.{sh,js} needs a sibling test, a registration in
 *                                 self-plugin/hooks/hooks.json, a REGISTRATIONS
 *                                 entry in hook-registrations.test.ts and a
 *                                 guard-fire-needles.json entry. Escape: a
 *                                 REGISTERED_ELSEWHERE entry in the same commit.
 *
 *   a self-plugin/hooks/hooks.json
 *   hook added or removed         needs the needle registry and the
 *                                 REGISTRATIONS table to move with it, in the
 *                                 same direction — count-guard-fires.test.ts
 *                                 fails on drift EITHER way.
 *
 *   an edit to text a             needs guard-fire-needles.json's `text` to
 *   guard-fire-needles.json       move with it, and a needle ARRIVING keyed on
 *   needle is keyed on            text nothing prints is the same fault written
 *                                 backwards (mantahostels#2708). Both judged on
 *                                 the containment count-guard-fires.test.ts
 *                                 asserts, through scripts/lib/needle-corpus.js.
 *
 * A REPO WITHOUT THE CORE'S REGISTRIES IS JUDGED AGAINST ITS OWN (workflow-core#1456).
 * Where the tree after the commit lacks the self-plugin file, a host's
 * .claude/settings.json registers its hooks; where it lacks a registry, its
 * demands move to the host-side file every adopter is seeded with:
 * .claude/registrations.json — a `hooks` row for the REGISTRATIONS entry, a
 * `registeredElsewhere` or `calledElsewhere` key for the two allowlists — and
 * .claude/guard-fire-needles.json. A host sibling test may be any of
 * lib/registrations.js's SIBLING_SUFFIXES, and node
 * <plugin>/scripts/check-registrations.js holds the whole-repo form. A host
 * file that does not exist yet is judged as empty.
 *
 * THE ONE TEMPORARY SPLIT THIS REPO PRODUCES, and what to do about it: a live
 * session holds self-plugin/hooks/hooks.json or
 * scripts/hook-registrations.test.ts, so lib/file-claim.js denies the wiring
 * edit and the commit cannot be atomic today. DO NOT take the allowlist for
 * it — the allowlist says "nothing will ever wire this", which is a lie that
 * outlives the claim. Ask for the file
 * (`node scripts/session-arbiter.js request <path> "<why>"`), leave the new
 * file UNCOMMITTED, and say so in the turn; guard-uncommitted-work.js caps at
 * six blocks and a debt is registered either way.
 *
 * DENY, NOT WARN (mantahostels#103): every input is a structured fact — what
 * the commit names, what HEAD holds, what the wiring files say — and the
 * escapes are named in the refusal. It binds in a LINKED WORKTREE too: this
 * guards no index, only the commit's own contents. A refusal is
 * permissionDecision JSON on exit 0.
 *
 * LIMITS
 *  - Wired twice: `if: Bash(git *)`, as its neighbour guard-commit-form is
 *    (mantahostels#2127), and `if: Bash(*commit-paths.js*)` for the form
 *    CLAUDE.md requires (workflow-core#1727).
 *  - A commit-paths.js `--patch` commit lands only its patch's hunks of each
 *    file it carries, but each is judged whole from the working tree, so a
 *    neighbour's uncommitted lines in one count as landing.
 *  - Suppressed mid-merge, mid-rebase, mid-cherry-pick, mid-revert and mid-am.
 *    A replay commit's contents were chosen by an earlier session, and
 *    refusing it strands the sequence.
 *  - The caller scan reads the DISK to find candidates and the tree after the
 *    commit to judge them, so a caller line that HEAD carries but an
 *    uncommitted edit has deleted is never a candidate at all — a denial the
 *    suite would not make. On a bare commit the same read misses a caller line
 *    staged and then deleted on disk.
 *  - The caller scan is a plain substring search where the test strips
 *    whole-line comments first. So a caller surface that merely MENTIONS the
 *    checker in a comment reads here as a caller and the commit is allowed —
 *    the test then fails on it. Deliberately the allowing direction.
 *  - A landing path is read from the copy the commit will take: the INDEX for
 *    a bare `git commit`, the working tree for a pathspec one and for `-a`,
 *    which re-stages every tracked file on its way in (mantahostels#2734).
 *  - `--pathspec-from-file` contributes no words, so a commit spelled that way
 *    is judged on nothing and allowed.
 *  - It sees the Bash tool only. A commit from the founder's own terminal, or
 *    from inside a script, reaches no hook.
 *  - A member REMOVED without its wiring is judged on ONE limb
 *    (mantahostels#2685): a deleted scripts/check-*.js whose CALLED_ELSEWHERE
 *    entry stays behind reds checker-registrations.test.ts, so that is
 *    refused. A deleted GUARD is not, because nothing asserts a
 *    REGISTERED_ELSEWHERE entry still names a file that exists.
 *  - A deletion is read as "in HEAD, absent from the tree after this commit".
 *    A `git rm --cached` leaves the file on disk, and a bare commit lands that
 *    removal, which the index read sees. A PATHSPEC commit naming the same
 *    path does not: git re-stages the working-tree copy, so the removal never
 *    lands and there is nothing to judge (mantahostels#2734).
 *  - The hook list is diffed as (event, matcher, guardKey) TRIPLES, read
 *    through scripts/lib/guard-fires.js so that this guard and
 *    count-guard-fires.test.ts key a registration identically
 *    (mantahostels#2685). Where ONLY the event or the matcher moved, the
 *    demand is that scripts/hook-registrations.test.ts either lands in the
 *    same commit or already spells the new event and the new matcher. The
 *    table pins the matcher against the id positionally and no substring test
 *    here can see that pairing, so both limbs are loose.
 *  - A registration file it cannot parse — a mid-edit one included — fails
 *    open, logged. So does a host .claude/registrations.json or the
 *    .claude/settings.json beside it (workflow-core#1670). A moved hook needs only some row
 *    on its new event and matcher, not the row pinning it.
 *  - The needle-text limb reads guard-fire-needles.json from the tree AS IT
 *    WILL BE and the CORPUS from the WORKING TREE for every file the commit
 *    does not land. So a literal a neighbour's uncommitted edit still prints
 *    reads as printed here and the commit is allowed.
 *  - Containment is a plain substring search over every corpus byte, so a
 *    literal quoted in a fixture, a rule fragment or a comment counts as
 *    printed. TEST FILES are excluded from the corpus (mantahostels#3288).
 *  - The needle-text limb reads scripts/guard-fire-needles.json alone, so a
 *    host's .claude/guard-fire-needles.json `text` drifting is unjudged; and
 *    it judges `text` literals ONLY — a `routes`, `kind` or `span` drifting
 *    is nothing it can see.
 *  - It FAILS OPEN, RECORDED (mantahostels#103 §6, mantahostels#147), on
 *    anything it cannot resolve: a git read that errors or times out, a
 *    `cd`/`git -C` target it cannot read — a `$(…)`, `${W:-x}` and the rest
 *    shell-parse.js's walk names — and a core that throws.
 *  - An UNSET variable in that target is read as empty (workflow-core#313, workflow-core#310's narrow
 *    form): shell state does not carry between Bash calls, so `cd "$W"` with
 *    `W` from an earlier call runs in the cwd, and is judged there. The
 *    refusal names the variable.
 *  - "Could not resolve the top level" is reachable only from a cwd inside a
 *    repo's `.git` directory. That fail-open lands nothing unjudged: `git
 *    commit` there fails too, `must be run in a work tree` (exit 128, workflow-core#313).
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/registry-atomicity.js");
const { buildHostPorts } = require("./lib/registry-atomicity-host.js");

run({ field: "command", noun: "command", decide, ports: buildHostPorts });
