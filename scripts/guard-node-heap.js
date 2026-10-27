#!/usr/bin/env node
/*
 * guard-node-heap.js — PreToolUse guard: hand a session the Node heap rule on a
 * command touching `max-old-space-size`, the moment it might remove or raise
 * the cap (workflow-core#2025).
 *
 * INJECTION ONLY — it never denies. Setting a lower heap for one command is
 * legitimate.
 *
 * It is narrowed to `if: Bash(*max-old-space-size*)` and
 * `if: Bash(*max_old_space_size*)`, as V8 takes either spelling.
 *
 * IMPLICIT: on a Bash command naming the flag it injects `rule:node-heap` as
 *   additionalContext and writes a `.rule-injected-*` latch under
 *   .claude/tmp/markers.
 * JUSTIFIED: fail-safe — it adds context and refuses nothing; the latch keeps
 *   a session that sets the flag often from paying for the rule each time.
 * DEFEAT: `scripts/clear-rule-latch.sh` clears the latch and it is said again;
 *   deleting either registration silences that spelling.
 *
 * LIMITS
 *  - A mixed spelling such as `max-old_space-size`, which V8 also accepts,
 *    passes the `if` narrowing and is never seen.
 *  - It matches the flag anywhere in the command, so a `grep` or `echo` that
 *    only mentions it spends the once-a-session delivery.
 *  - An edit to `~/.bashrc` through Write or Edit, or a heap set from inside a
 *    script the command runs, is no Bash command naming the flag.
 *  - It FAILS OPEN on anything it cannot resolve, except the rule store, which
 *    refuses the call on a fragment it cannot read or emit.
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/node-heap.js");

run({ field: "command", noun: "command", decide });
