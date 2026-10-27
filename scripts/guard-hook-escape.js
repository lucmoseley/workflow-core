#!/usr/bin/env node
/*
 * guard-hook-escape.js — PreToolUse guard: a git-hook escape is the
 * founder's to set, never an agent's (workflow-core#916). The core, with what it refuses
 * and its LIMITS, is lib/hook-escape.js.
 *
 * DENIES any Bash command assigning or exporting WFC_ALLOW_BRANCH or
 * WFC_ALLOW_GATE_INPUT_DELETE, whatever the command runs; a mention passes.
 *
 * DENIES-THROUGH: lib/guard-entry.js — `run` writes the core's deny, so the
 * registration carries `"onFailure": "block"` and a crash or timeout refuses.
 *
 * FAILS CLOSED on a core that throws (lib/refuse-on-throw.js). Every input it
 * cannot resolve still fails open, recorded (mantahostels#103 §6,
 * mantahostels#147). An unreadable rule fragment still denies, naming the
 * file.
 *
 * Wired with `if: Bash(*WFC_ALLOW_*)`.
 *
 * IMPLICIT: it refuses any Bash command assigning or exporting one of the two
 *   escapes, whatever the command runs.
 * JUSTIFIED: fail-safe — a commit past a stood-down gate lands on the shared
 *   `main`, and the escape exists for a judgement the founder makes.
 * DEFEAT: the core's LIMITS; deleting the registration from
 *   self-plugin/hooks/hooks.json (or, in an adopter, the plugin's
 *   hooks/hooks.json) silences it.
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/hook-escape.js");

run({
	field: "command",
	noun: "command",
	onThrow: "refuse",
	decide,
});
