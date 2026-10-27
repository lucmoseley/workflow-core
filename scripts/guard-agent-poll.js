#!/usr/bin/env node
/*
 * guard-agent-poll.js — PreToolUse guard: stop a session waiting by looking,
 * on its Bash routes — a no-op command, and a timed watch opening `sleep <n>`
 * (mantahostels#627, mantahostels#659). The core, with its WHY and LIMITS,
 * is lib/agent-poll.js; its Read and ListAgents routes run in the
 * dispatcher (lib/guard-cores.json), over the same core and the same
 * window.
 *
 * DENIES a second no-op inside five minutes. WARNS a fourth timed watch.
 *
 * DENIES-THROUGH: lib/guard-entry.js — `run` writes the core's deny, so the
 * registrations carry `"onFailure": "block"` and a crash or timeout refuses.
 *
 * FAILS CLOSED on a core that throws (lib/refuse-on-throw.js), as the
 * dispatcher row does. Every fault the core can name still fails open,
 * recorded (mantahostels#103 §6, mantahostels#147).
 *
 * LIMITS
 *  - Its four narrowings, `if: Bash(*sleep *)`, `if: Bash(true*)`,
 *    `if: Bash(:*)` and `if: Bash(exit*)`, cannot match a command opening with
 *    whitespace, which the core's routes would classify (mantahostels#2811).
 *
 * It answers under the dispatcher row's name, so one `disabled` entry,
 * `guard-agent-poll`, silences every route (#569).
 */

// deny-timing: delayed — the deny arrives on the THIRD poll, so a session
// that never read the rule has already polled twice by the time this text
// reaches it. CLAUDE.md's copy is the only one that arrives in time: do not
// cut it (mantahostels#964, which settled that test).

const { run } = require("./lib/guard-entry.js");
const { decide, field, noun, top } = require("./lib/agent-poll.js");
const { buildHostPorts } = require("./lib/agent-poll-host.js");

run({
	field,
	top,
	name: "guard-agent-poll",
	noun,
	onThrow: "refuse",
	decide,
	ports: () => ({ ...buildHostPorts(), env: process.env }),
});
