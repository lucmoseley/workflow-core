#!/usr/bin/env node
/*
 * start-lander-on-push.js — PostToolUse hook: after a push to a queue ref,
 * `queue/<name>`, start the queue lander detached (#2405, spec #2261; #4458).
 * The core is lib/lander-on-push.js.
 *
 * IMPLICIT:  after a Bash call that pushes to a queue ref, runs
 *            start-lander.js detached, which — where the `landing` module is
 *            on, no lander runs and a queue ref waits on the remote or a
 *            drop is owed a decision — starts `queue-lander.js run` in a
 *            session of its own.
 * JUSTIFIED: fail-safe — a queue push that starts no lander sits untested
 *            until some later session starts, and every session meanwhile
 *            builds on a `main` behind its own work.
 * DEFEAT:    turning the `landing` module off; deleting the registration.
 * TREE:      both — resolves the pushed ref in the session's checkout, walked from host-root.js's sessionDir, and starts the lander under the host root's config
 *
 * PostToolUse fires only on a call that exited 0, a failed push reaching
 * PostToolUseFailure instead, where this hook is not registered
 * (hook-registrations.test.ts pins it). A push whose failure the call hides
 * (`|| true`, a later `;`) still starts start-lander.js, which reads the remote
 * and starts nothing where no queue ref waits and no drop is owed a decision.
 *
 * Wired on PostToolUse with matcher "Bash", narrowed `if: Bash(*push*)`,
 * unanchored because the walk reads a push behind a launcher wrapper.
 *
 * LIMITS
 *  - A push the walk cannot see — `sh -c`, a script, the founder's terminal —
 *    starts nothing; the session-start launcher starts the lander instead.
 *  - It never writes to stdout: a PostToolUse hook's output is context handed
 *    to the session. start-lander.js's own output, a failure included, goes
 *    to the lander's log.
 *  - Every fault allows, logged to guard-errors.log.
 */

const { readSymbolicName } = require("./lib/git-tree.js");
const { run } = require("./lib/guard-entry.js");
const { decide } = require("./lib/lander-on-push.js");

run({
	field: "command",
	noun: "lander start",
	event: "PostToolUse",
	decide,
	ports: () => ({ symbolicName: (tree, src) => readSymbolicName(tree, src) }),
});
