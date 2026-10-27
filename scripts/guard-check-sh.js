#!/usr/bin/env node
/*
 * guard-check-sh.js — PreToolUse guard: hand a session the two shellcheck
 * rules BEFORE it runs the shell gate (mantahostels#1805, spec
 * mantahostels#1762), and, before the full run, the changed-paths route
 * (#1015). The core, with its scope and LIMITS, is lib/check-sh-rules.js.
 *
 * IMPLICIT: on a shell-gate command it injects two rules as additionalContext
 *   (three texts before the full run) and writes a `.rule-injected-*` latch
 *   per text under .claude/tmp/markers.
 * JUSTIFIED: fail-safe — a `check:sh` that never found the binary prints no
 *   findings, only `shellcheck: not found` and exit 127, which a session
 *   skimming for findings misreads as a clean gate, so the moment before the
 *   run is the moment to say so.
 * DEFEAT: `scripts/clear-rule-latch.sh` clears the latch and the rules are
 *   said again; deleting this registration from self-plugin/hooks/hooks.json
 *   silences both.
 *
 * FAILS OPEN on anything it cannot resolve — an unreadable payload, a core
 * that throws, a payload with no session id — RECORDED on the guard-error log
 * (mantahostels#103 §6, mantahostels#147), through lib/guard-entry.js. The
 * one exception is the store side: a fragment the store cannot give refuses
 * the call, naming the rule (mantahostels#1762), as a `permissionDecision`
 * deny on exit 0.
 *
 * LIMITS
 *  - Wired with `if: Bash(*shellcheck *)` and `if: Bash(*npm *)`
 *    (mantahostels#2811): a bare `shellcheck` or `npm` with no further word
 *    never starts this guard, and neither spelling runs the gate.
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/check-sh-rules.js");

run({ field: "command", noun: "command", decide });
