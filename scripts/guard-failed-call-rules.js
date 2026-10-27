#!/usr/bin/env node
/*
 * guard-failed-call-rules.js — after a call fails in one of two known ways,
 * hand the session the rule for that failure (workflow-core#2026). The core is
 * lib/failed-call-rules.js.
 *
 *   PostToolUseFailure, Bash, exit 137 or 143 — `rule:silent-kill`: a call
 *     killed by a signal is probably earlyoom; run `memcheck` before debugging.
 *   PostToolBatch, a `Skill` result refused for `disable-model-invocation` —
 *     `rule:skill-refused`: never replicate the skill; do the work directly.
 *
 * WHY TWO EVENTS. A refused `Skill` never reaches PostToolUseFailure: the
 * harness refuses it in the tool's input validation, which answers with a
 * `<tool_use_error>` before any PreToolUse or PostToolUse* hook runs.
 * PostToolBatch fires once per batch with every call's result text, the
 * refusal included, and takes `additionalContext`.
 *
 * FAILS OPEN (mantahostels#103 §6), recorded: an unparseable payload or an
 * unreadable fragment says nothing and logs why. With no node on PATH the
 * hook line exits 0, unrecorded.
 *
 * LIMITS
 *  - Exit 137/143 is a signal, not a cause: a `kill` or `timeout -s KILL` in
 *    the command lands here too.
 *  - The Skill limb matches the harness's refusal wording,
 *    "due to disable-model-invocation"; a reworded refusal goes unseen.
 *  - It speaks on every hit, unlatched.
 *
 * IMPLICIT: after a Bash call killed by signal, or a Skill call refused as
 *   slash-only, hands the session that rule's text as additionalContext.
 * JUSTIFIED: fail-safe — it adds context and refuses nothing.
 * DEFEAT: deleting either registration.
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/failed-call-rules.js");

run({
	field: "hook_event_name",
	top: true,
	noun: "failed call",
	event: "PostToolUseFailure",
	decide,
	ports: ({ payload }) => ({ payload }),
});
