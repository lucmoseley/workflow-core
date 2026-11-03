/*
 * bg-resume.js — the job `claude --bg --resume <session id>` says it started
 * (workflow-core#2968). On 2.1.310 a stopped job wakes in place under its own job id; one
 * still running, open elsewhere or otherwise not wakeable is carried on by a
 * copy under a new job id (workflow-core#2963). One whose job directory has gone is
 * continued under a job of its own id, with no note at all (workflow-core#3773).
 *
 * Residual: a harness that rewords either note reads as a job under its own
 * id, whose record refill-tick.js's resumeStopped then checks, so the loop
 * counts a copy's resume failed and hands the ticket off; re-recording
 * after an upgrade (`node scripts/record-claude-responses.js`) is what catches it.
 */

/* Every copy note the 2.1.310 binary holds; `[\w-]` leaves the full stop
 * out. */
const COPY =
	/started a (?:restricted )?copy (?:of that conversation )?as ([\w-]+)/;
const WOKE = /woke session ([\w-]+)/;
const BACKGROUNDED = /backgrounded · ([\w-]+)/;

/**
 * The job a launcher's response names: a copy, else the job woken or continued
 * under its session's id; null where it names none.
 * @param {{stdout: string, stderr: string}} response
 * @returns {{jobId: string, copy: boolean}|null}
 */
function parseResumed({ stdout, stderr }) {
	const out = `${stdout}${stderr}`;
	const copy = COPY.exec(out)?.[1];
	if (copy) return { jobId: copy, copy: true };
	const own = WOKE.exec(out)?.[1] ?? BACKGROUNDED.exec(out)?.[1];
	return own ? { jobId: own, copy: false } : null;
}

module.exports = { parseResumed };
