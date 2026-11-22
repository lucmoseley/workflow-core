const COPY =
	/started a (?:restricted )?copy (?:of that conversation )?as ([\w-]+)/;
const WOKE = /woke session ([\w-]+)/;
const BACKGROUNDED = /backgrounded · ([\w-]+)/;

/**
 * @param {{stdout: string, stderr: string}} response
 * @returns {{jobId: string, copy: true, why: string}|{jobId: string,
 *   copy: false}|null}
 */
function parseResumed({ stdout, stderr }) {
	const out = `${stdout}${stderr}`;
	const note = out.split("\n").find((line) => COPY.test(line));
	const copy = note && COPY.exec(note)?.[1];
	if (note && copy) return { jobId: copy, copy: true, why: note.trim() };
	const own = WOKE.exec(out)?.[1] ?? BACKGROUNDED.exec(out)?.[1];
	return own ? { jobId: own, copy: false } : null;
}

module.exports = { parseResumed };
