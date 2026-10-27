#!/usr/bin/env node
/*
 * guard-branch.js — PreToolUse guard: the shared working tree stays on
 * `main`, and a throwaway worktree needs `-b <name>` or `--detach`
 * (mantahostels#100, mantahostels#1648). The core, with its LIMITS, is
 * lib/branch-move.js.
 *
 * DENIES a branch move in the shared tree and a `git worktree add` with
 * neither; hands the rule over, once a session, before an allowed worktree
 * add or `git checkout main`.
 *
 * DENIES-THROUGH: lib/guard-entry.js — `run` writes the core's deny, so the
 * registration carries `"onFailure": "block"` and a crash or timeout refuses.
 *
 * FAILS CLOSED on a core that throws (lib/refuse-on-throw.js). Every input it
 * cannot resolve still fails open, recorded (mantahostels#103 §6,
 * mantahostels#147); the `.husky/pre-commit` branch assertion is the second
 * layer, and inspects state rather than a command string.
 *
 * LIMITS
 *  - Wired with `if: Bash(git *)` (mantahostels#2127; best-effort:
 *    docs/agents/guard-authoring.md's surface 4, which fails toward running)
 *    — not started unless some segment of the command leads with `git`.
 *  - It guards the Bash tool. A command run outside Claude Code sees no hook.
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/branch-move.js");
const { buildHostPorts } = require("./lib/branch-move-host.js");

run({
	field: "command",
	noun: "command",
	onThrow: "refuse",
	decide,
	ports: buildHostPorts,
});
