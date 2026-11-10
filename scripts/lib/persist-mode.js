/*
 * persist-mode.js — does this invocation persist its report instead of
 * printing it?
 *
 * Extracted at mantahostels#2252. Two callers ask the same question of the same argv and
 * the same variable: `lib/check.js`'s checker tail, serving the `runCheck`
 * members of mantahostels#1949's persist set (mantahostels#1974), and `reap-finished-sessions.js`,
 * which is not one of them — it owns its own `--json` document and exit
 * contract, and so calls `lib/notify-report.js` directly rather than routing
 * through `runCheck` (mantahostels#2152). They must agree, because a
 * divergence would give one producer a different gate — an async hook that
 * writes no report and prints nothing, which is mantahostels#1854's class.
 *
 * Under `--notify` alone (mantahostels#1949's seam) the human report goes to stdout for a SessionStart hook to inject. With the variable set to
 * exactly `1` the same bytes go to a report file instead
 * (lib/notify-report.js) and stdout stays empty, so an `async` hook — whose
 * stdout the harness discards — still reaches a reader, through the replay
 * hook that reads those files at the next start.
 *
 * SET PER HOOK COMMAND IN `self-plugin/hooks/hooks.json`, NEVER INFERRED, and read as
 * `=== "1"` rather than for truthiness, so an inherited empty or `0` leaves
 * every path exactly as it is today (mantahostels#1924).
 *
 * `check.js`'s `--against` re-exec is covered by the `--json` limb rather than
 * by a check of its own: the parent runs the child under `--json`.
 */

const PERSIST_ENV = "WFC_NOTIFY_PERSIST";

/**
 * Takes argv rather than a ctx: check.js's reportCrash case is precisely the
 * one where no ctx could be built.
 *
 * `--json` outranks the variable in both callers, that document being a
 * caller's rather than a reader's. Anything further a caller must refuse is
 * `forbid`, not a second copy of the predicate — the reaper's `--dry-run`
 * being the only one today.
 *
 * `forbid` matches a flag by exact token, so a `--dry-run=1` or a short alias
 * would slip the gate silently.
 *
 * @param {string[]} argv
 * @param {{ forbid?: string[] }} [opts]
 */
const persisting = (argv, opts) =>
	process.env[PERSIST_ENV] === "1" &&
	argv.includes("--notify") &&
	!argv.includes("--json") &&
	!(opts?.forbid ?? []).some((flag) => argv.includes(flag));

module.exports = { persisting };
