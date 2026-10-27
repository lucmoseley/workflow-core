/*
 * bg-resume.js — the job `claude --bg --resume <session id>` says it started
 * (#2968). On 2.1.310 a stopped job wakes in place under its own job id; one
 * still running, open elsewhere or otherwise not wakeable is carried on by a
 * copy under a new job id (#2963).
 *
 * Residual: a harness that rewords either note reads as naming no job, so
 * the loop counts its resume failed and hands the ticket off; re-recording
 * after an upgrade (`node scripts/record-claude-responses.js`) is what catches it.
 */

/* Every copy note the 2.1.310 binary holds; `[\w-]` leaves the full stop
 * out. */
const COPY =
	/started a (?:restricted )?copy (?:of that conversation )?as ([\w-]+)/;
const WOKE = /woke session ([\w-]+)/;

/**
 * The job a launcher's response names: a copy, or the job woken in place;
 * null where it names neither.
 * @param {{stdout: string, stderr: string}} response
 * @returns {{jobId: string, copy: boolean}|null}
 */
function parseResumed({ stdout, stderr }) {
	const out = `${stdout}${stderr}`;
	const copy = COPY.exec(out)?.[1];
	if (copy) return { jobId: copy, copy: true };
	const woke = WOKE.exec(out)?.[1];
	return woke ? { jobId: woke, copy: false } : null;
}

module.exports = { parseResumed };
