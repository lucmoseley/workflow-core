#!/usr/bin/env node
/*
 * guard-push-rules.js — PreToolUse guard: hand a session the push rules
 * BEFORE it pushes, and warn of pushed code no review covers (#1163). The
 * core is lib/push-rules.js.
 *
 * INJECTION ONLY — it never denies a push, save on the one fault the kit
 * refuses on: a fragment it cannot read.
 *
 * IMPLICIT: on an allowed `git push` it injects the push rules as
 *   additionalContext and writes a `.rule-injected-*` latch per rule under
 *   .claude/tmp/markers; where the session's pushed code owes a review that
 *   no valid `.codereview-pass` marker covers, the warn rides ahead of them,
 *   latched once a session, again on an escalated change and on each
 *   rejected marker written (#1163).
 * JUSTIFIED: fail-safe — the moment before the push is the only one at which
 *   its rules can still shape it (mantahostels#1648, spec mantahostels#1762);
 *   and a review asked for only at Stop lands every finding on code already
 *   on `main` (#1163). The latch keeps that from costing a session bytes on
 *   every push.
 * DEFEAT: `scripts/clear-rule-latch.sh` clears the latch and the rules are
 *   said again; deleting this registration from hooks/hooks.json silences
 *   both.
 *
 * LIMITS
 *  - Wired with `if: Bash(git *)` (mantahostels#2127) — not started unless
 *    some segment of the command leads with `git`.
 *  - It FAILS OPEN, RECORDED (mantahostels#147), on anything else it cannot
 *    resolve: the payload, a tree git cannot answer for, a config
 *    lib/test-gate.js refuses (push-green-suite withheld, #758), and the
 *    review adapter (the Stop nag still fires).
 *  - The rules are stated ONCE PER SESSION, keyed per agent, so a subagent's
 *    push is told afresh.
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/push-rules.js");
const { buildHostPorts } = require("./lib/push-rules-host.js");

run({ field: "command", noun: "command", decide, ports: buildHostPorts });
