#!/usr/bin/env node
/*
 * guard-ugrep-pattern.js — PreToolUse guard: warn a session whose `grep`
 * pattern carries a bounded repeat that `grep` here is Claude Code's bundled
 * ugrep, which can refuse such a pattern, and that exit status 2 then means a
 * refused pattern, not "no match" (workflow-core#1021). The core, with its LIMITS, is
 * lib/ugrep-pattern.js (workflow-core#2801).
 *
 * WHY. Whether ugrep refuses depends on the repeat sizes (workflow-core#1021), so any
 * ranged repeat is warned on.
 *
 * WARN, NOT DENY (workflow-core#1021 Q1): the pattern often works, and only the exit status
 * tells the session which happened.
 *
 * Its `if: Bash(grep *)` narrowing is anchored on purpose: only a bare `grep`
 * is the function, and every wrapper the unanchored form would admit — `xargs
 * grep`, `command grep`, `timeout 5 grep` — execs GNU grep instead. Not folded
 * into lib/recursive-dot-read.js, the one Bash guard already reading `grep`:
 * that one runs on every Bash call, and this narrowing is what spares the
 * rest.
 *
 * IMPLICIT: on a matching `grep` it injects one note as additionalContext and
 *   writes a `.rule-injected-warn.ugrep-pattern-*` latch under
 *   .claude/tmp/markers, once the note is out (mantahostels#2261).
 * JUSTIFIED: fail-safe — the refusal is silent under a discarded stderr, so a
 *   doc line alone would have to have been read beforehand (workflow-core#1021 Q1).
 * DEFEAT: `scripts/clear-rule-latch.sh` clears the latch and it is said again;
 *   deleting the registration from self-plugin/hooks/hooks.json silences it.
 *
 * ADVISORY: the registration carries no `onFailure`, and a core that throws is
 * allowed, logged, by lib/guard-entry.js's own catch. It FAILS OPEN throughout
 * (mantahostels#103 §6), recording every payload fault the kit names
 * (mantahostels#147).
 *
 * LIMITS of the wiring
 *  - `VAR=x grep …` is ugrep, and is judged, but the anchored `if` may not
 *    start the guard for it.
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/ugrep-pattern.js");

run({ field: "command", noun: "command", decide });
