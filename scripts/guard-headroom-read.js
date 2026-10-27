#!/usr/bin/env node
/*
 * guard-headroom-read.js — PreToolUse guard: hand a session the headroom rule
 * BEFORE it decides that a short memory reading means stop (mantahostels#1933).
 *
 * INJECTION ONLY — it never denies. Reading memory is the correct thing to do;
 * what the rule corrects is the conclusion drawn from the reading, which no
 * guard can observe.
 *
 * It fires on the read, not on the launch: a session that stops on a short
 * reading never launches, so scripts/guard-suite-concurrency.js never fires.
 *
 * IMPLICIT: on an ALLOWED memory read it injects one rule as additionalContext
 *   and writes a `.rule-injected-*` latch under .claude/tmp/markers.
 * JUSTIFIED: fail-safe — the rule has no enforcing guard and cannot have one.
 *   The latch keeps it from costing bytes on every later read.
 * DEFEAT: `scripts/clear-rule-latch.sh` clears the latch and it is said again;
 *   deleting either registration silences that limb.
 *
 * LIMITS
 *  - It fires on a `free` followed by a space, as `Bash(*free *)` reads it, and
 *    on a read of /proc/meminfo; a bare `free` never matches (mantahostels#2811).
 *    A reading reached any other way — `vmstat`, `top`, a script, `memcheck` —
 *    states nothing, only a segment's own first word being read for the `free`
 *    limb.
 *  - `free --help`, `free -V` and `free --version` report no memory, so all are
 *    filtered: the latch would spend the injection the real read needed. `-h`
 *    is NOT filtered — it is free's human-readable flag, not help.
 *  - It FAILS OPEN on anything it cannot resolve, except the rule store, which
 *    refuses the call on a fragment it cannot read or emit.
 *  - It guards the Bash tool. A reading taken outside Claude Code sees no hook.
 */
// Wired with `if: Bash(*free *)` and `if: Bash(*/proc/meminfo*)`.

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/headroom-read.js");

run({ field: "command", noun: "command", decide });
