/*
 * scripts/measure-bash-write-firing/lib.js — the classifiers the other four
 * scripts share (mantahostels#2865, on mantahostels#2854's method).
 *
 * WHY A SHARED FILE AND NOT A COPY EACH. The write-call list and the tier-1
 * test decide every rate this directory prints, so two copies drifting apart
 * would show up as two different answers to one question, with nothing saying
 * which run used which.
 *
 * WHAT IS DELIBERATELY *NOT* SHARED: measure-firing-rate.js's own spelling of
 * the guard's two limbs. That one re-spells scripts/lib/claimed-bash-write.js
 * independently ON PURPOSE — it is the drift check, and a shared implementation
 * would make it check itself.
 */

/**
 * Is this repo-relative path in the guard's tier 1 — the tier it WARNS about?
 * `scripts/` is detect-only by mantahostels#287 and is deliberately absent.
 *
 * @param {string} p
 */
const tier1 = (p) =>
	/^(docs\/|\.claude\/)/.test(p) || p === "CLAUDE.md" || p === "AGENTS.md";

/**
 * A tier-1 path a session could actually be holding. `.claude/tmp/` is scratch
 * — gitignored, swept at 24 hours, never claimed — so a firing whose only
 * candidates sit there can never deliver a line however the guard reads it.
 *
 * @param {string} p
 */
const claimable = (p) => tier1(p) && !p.startsWith(".claude/tmp/");

/**
 * Every quoted whitespace-free token in `text`, one pass per quote kind — the
 * same three passes `quoted_tokens` makes in the guard.
 *
 * @param {string} text
 * @returns {string[]}
 */
function quotedTokens(text) {
	/** @type {Set<string>} */
	const out = new Set();
	for (const q of ["'", '"', "`"]) {
		for (const m of text.match(new RegExp(`${q}[^${q}\\s]+${q}`, "g")) ?? []) {
			out.add(m.slice(1, -1));
		}
	}
	return [...out];
}

/*
 * Does the command's inline program WRITE anything at all?
 *
 * LEXICAL, and that is the whole error bar: it asks whether a write-shaped call
 * appears anywhere in the command string, never whether the path the guard
 * named is the one written. mantahostels#2854 hand-checked it against a 60-command sample
 * and reported the rate with that check, not as an exact count.
 */
const WRITE_CALL = [
	/\.write_text\s*\(/,
	/\.write_bytes\s*\(/,
	/\.writelines\s*\(/,
	/\bopen\s*\([^)]*,\s*['"`][wax]/,
	/\bjson\.dump\s*\(/,
	/\bwriteFileSync\b/,
	/\bappendFileSync\b/,
	/\bcreateWriteStream\b/,
	/\bfs\.promises\.(writeFile|appendFile)\b/,
	/\bwriteFile\s*\(/,
	/\bshutil\.(copy|move)/,
	/\bos\.(replace|rename|remove|unlink)\b/,
	/\bfs\.(renameSync|unlinkSync|copyFileSync|rmSync)\b/,
	/\.mkdir/,
	/\bsys\.stdout\.write/,
];

/** @param {string} cmd */
const writesSomething = (cmd) => WRITE_CALL.some((re) => re.test(cmd));

/**
 * One `{s, c}` record per line, and a count of the lines that would not parse.
 * The count is RETURNED rather than swallowed: every figure this directory
 * prints is a rate, and a silently shrunken denominator is a wrong rate that
 * looks right (mantahostels#2865 review).
 *
 * @param {string} text
 * @returns {{rows: {s: string, c: string}[], unparsed: number}}
 */
function parseRows(text) {
	/** @type {{s: string, c: string}[]} */
	const rows = [];
	let unparsed = 0;
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			rows.push(JSON.parse(line));
		} catch {
			unparsed++;
		}
	}
	return { rows, unparsed };
}

module.exports = {
	WRITE_CALL,
	claimable,
	parseRows,
	quotedTokens,
	writesSomething,
};
