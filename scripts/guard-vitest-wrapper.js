#!/usr/bin/env node
/*
 * guard-vitest-wrapper.js — PreToolUse guard: warn on a vitest run that
 * skips scripts/run-vitest.js, which is the only thing that kills a run
 * parked on a synchronous call that never returns (mantahostels#2002). The
 * core, with its scope and blind spots, is lib/vitest-wrapper.js.
 *
 * WARNS, never denies (mantahostels#908, mantahostels#987).
 *
 * IMPLICIT: on an unwrapped one-shot vitest run it hands the session the rule
 *   once a session (a short standing line after that) and the wrapped command
 *   every time, as additionalContext (mantahostels#2275), and on the first run
 *   writes a `.rule-injected-warn.vitest-wrapper-*` latch under
 *   .claude/tmp/markers.
 * JUSTIFIED: fail-safe — a parked worker produces no output and no error for
 *   as long as the session waits, and the launch is the last moment to say so.
 * DEFEAT: `scripts/clear-rule-latch.sh` clears the latch and the rule is said
 *   again; deleting the registration from self-plugin/hooks/hooks.json
 *   silences it.
 *
 * FAILS OPEN on everything — an unreadable payload, a core that throws, an
 * unwritable latch — recorded on the guard-error log (mantahostels#103 §6,
 * mantahostels#147), through lib/guard-entry.js. A rule the store cannot give
 * is sent as a fallback sentence naming the file, logged, never refused.
 *
 * LIMITS
 *  - Wired with `if: Bash(*vitest *)` and `if: Bash(*npx *)`
 *    (mantahostels#2811): a vitest invocation carrying no argument at all —
 *    `vitest`, `node_modules/.bin/vitest` — matches neither pattern and never
 *    starts this guard, though the core would warn on it.
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/vitest-wrapper.js");

run({ field: "command", noun: "command", decide });
