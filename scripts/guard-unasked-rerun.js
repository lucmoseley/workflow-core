#!/usr/bin/env node
/*
 * guard-unasked-rerun.js — PreToolUse guard: refuse a session's first unasked
 * re-run of the suite (workflow-core#815, ruled at workflow-core#790 Q3 and Q7, spec workflow-core#810), the waste
 * workflow-core#787 counted. The core is lib/unasked-rerun-guard.js; the judgement,
 * lib/unasked-rerun.js.
 *
 * ONCE A SESSION, AND RE-TYPING RUNS IT (workflow-core#790 Q7). The refusal names the runs
 * whose certificates attest the session's own work.
 *
 * DENIES-THROUGH: lib/guard-entry.js — `run` writes the core's deny, so the
 * registration carries `"onFailure": "block"` and a crash or timeout refuses.
 *
 * FAILURE POLICY. A core that throws refuses (lib/refuse-on-throw.js). The
 * judge's faults fail open, recorded (mantahostels#103 §6): no session id
 * allows silently, there being no session to refuse once; a judge that throws,
 * or says it could not judge — an unreadable ledger, marker store or git —
 * allows and logs why.
 *
 * LIMITS
 *  - Fails closed on the rule fragment's wording only: an unreadable fragment
 *    still refuses, carrying a fallback that names its file.
 *  - A file this session wrote through Bash is absent from its write ledger, so
 *    a session whose only uncommitted edits went that way is refused (workflow-core#816).
 *    The judge reads the run's own `attributeDirty` (workflow-core#1218), which credits
 *    inline python and node writes; `sed -i` and redirects are credited only
 *    on a code path no live neighbour holds (mantahostels#2778).
 *    Elsewhere they stay uncredited.
 *  - A neighbour's commit in no commit ledger counts as the session's own
 *    (workflow-core#1154), so an untested one lets a pure repeat through.
 *  - `npm run -s test` is unread: its flag sits before the script name.
 *  - Wired with `if: Bash(*npm *)`, best-effort (docs/agents/guard-authoring.md's
 *    surface 4), so the core re-reads the command itself.
 *
 * IMPLICIT: it refuses the first bare test run in a session whose own work —
 *   its commits and its uncommitted files — certificates already attest. It
 *   writes an unreferenced commit object of that tree on every judged run, and
 *   on a refusal a per-session latch and one line to
 *   `.unasked-rerun-refusals.jsonl` under .claude/tmp/markers.
 * JUSTIFIED: fail-safe — a refused run costs one re-typed command, and the
 *   run it stops is one the push and `result:` gates already do not need.
 * DEFEAT: re-typing the command; any flag but `--queue`, or a file filter;
 *   `bash -c`, a script or a heredoc wrapping the launch; deleting the
 *   registration.
 */

const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/unasked-rerun-guard.js");
const { buildHostPorts } = require("./lib/unasked-rerun-guard-host.js");

run({
	field: "command",
	noun: "command",
	onThrow: "refuse",
	decide,
	ports: buildHostPorts,
});
