/*
 * session-id.js — the one place either side of the selection round trip asks
 * "which session is this?" (mantahostels#1774).
 *
 * `scripts/pick-next.js` mints a selection marker keyed on the session id, and
 * `scripts/guard-selection-sum.js` reads that marker back for the id its Stop
 * payload carries. The two ids come from different places — the Bash tool's
 * environment on the mint side, the hook payload on the reading side — and
 * nothing in-process can prove a running harness gives both the same value
 * (mantahostels#844, the ticket that measured them equal).
 *
 * Both are read at call time and never cached: a hook is handed a fresh
 * environment and a fresh payload per invocation.
 *
 * It also answers who started a run that is no session's: a report owner
 * (workflow-core#4706) and the lander's mark (workflow-core#4757).
 */

/**
 * The id as the Bash tool's environment gives it — the minting side.
 * @param {Record<string, string|undefined>} [env] defaults to this process's
 *   environment. Widened from `NodeJS.ProcessEnv`, which Next's types make
 *   `NODE_ENV`-bearing, so a test cannot hand it a one-key literal.
 * @returns {string|null} null where it is unset or empty, never `""`
 */
function fromEnv(env = process.env) {
	return env.CLAUDE_CODE_SESSION_ID || null;
}

/**
 * The id as a hook payload gives it — the reading side.
 * @param {{session_id?: string}|null|undefined} input the parsed hook payload
 * @returns {string|null} null where there is no payload, or none in it
 */
function fromPayload(input) {
	return input?.session_id || null;
}

/* The session a notify report is owed to, set by the outliving launch on a
 * job that is no session's process (workflow-core#4706). */
const REPORT_OWNER = "WFC_REPORT_OWNER";

/**
 * The session a notify report names as its owner: the starter an outliving
 * job carries, else this process's own session. Never read for liveness or
 * self-exclusion, which want `fromEnv`.
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
function reportOwner(env = process.env) {
	return env[REPORT_OWNER] || fromEnv(env);
}

/* Set on every run the lander's tester spawns, so a run's record names the
 * lander from its source, never from an argv another script can copy (workflow-core#4757). */
const LANDER_RUN = "WFC_LANDER_RUN";

/**
 * Whether the lander started this process's run.
 * @param {Record<string, string|undefined>} [env]
 * @returns {boolean}
 */
function isLanderRun(env = process.env) {
	return env[LANDER_RUN] === "1";
}

/** The keys `forgetSession` strips, which lib/detach.sh's `outlive` mirrors. */
const FORGOTTEN_KEYS = Object.freeze([
	"CLAUDE_CODE_SESSION_ID",
	"CLAUDE_JOB_DIR",
	REPORT_OWNER,
]);

/**
 * Strip the session identity from `env` in place, for a detached loop that is
 * no session: it outlives the one that started it. Under that one's id the
 * reaper spares the wrong session and admission's liveness self-test refuses
 * every reading once it ends (workflow-core#2046); under its job dir a child's scratch
 * lands in a directory swept with it; under a report owner its reports reach
 * whichever session started it (workflow-core#4706).
 * @param {Record<string, string|undefined>} env
 */
function forgetSession(env) {
	for (const key of FORGOTTEN_KEYS) delete env[key];
}

module.exports = {
	fromEnv,
	fromPayload,
	reportOwner,
	forgetSession,
	REPORT_OWNER,
	isLanderRun,
	LANDER_RUN,
};
