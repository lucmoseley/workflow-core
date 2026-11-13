/*
 * status-render.js — the report npm run status prints from its checkers'
 * finished runs (scripts/status-report.js), a module of its own so the
 * STANDINGS print rule is tested through its export (workflow-core#4107).
 */

/**
 * Checkers whose clean run IS the report — a standing to read, not a finding —
 * so their body is printed even under an `OK:` line. A SKIP is no clean run:
 * it stays with the clean list.
 */
const STANDINGS = new Set([
	"escape-audit",
	"primitives",
	"wsl-currency",
	"compaction-backstop",
	"release-lag",
]);

/**
 * @typedef {object} Result
 * @property {string} name
 * @property {number | null} code   exit status, or null where a signal killed it
 * @property {string | null} signal
 * @property {string} out           stdout and stderr, merged in arrival order
 */

/**
 * A checker whose last line is its own `OK:` or `SKIP:` summary found nothing,
 * and its body is dropped rather than printed. So did a `--notify` run that
 * printed nothing at all.
 *
 * @param {Result} r
 */
function verdict(r) {
	const last = r.out.split("\n").pop() ?? "";
	if (r.signal) return `killed by ${r.signal}`;
	if (r.code === 0 && r.out === "") return "OK";
	if (/^OK:/.test(last)) return "OK";
	if (/^SKIP:/.test(last)) return "SKIP";
	return null;
}

/**
 * The report for a finished run.
 *
 * @param {Result[]} results
 * @returns {string}
 */
function render(results) {
	let text = "";
	/** @type {string[]} */
	const clean = [];
	for (const r of results) {
		const v = verdict(r);
		if (v === "SKIP" || (v === "OK" && !STANDINGS.has(r.name))) {
			clean.push(`${r.name} (${v})`);
			continue;
		}
		text += `\n▸ ${r.name}${v ? `  — ${v}` : ""}\n`;
		text += `${r.out || "(no output)"}\n`;
	}
	if (clean.length > 0)
		text += `\nnothing to report from: ${clean.join(", ")}\n`;
	text += `\n${results.length} checker(s) run, ${clean.length} clean. Nothing here is a ticket by itself.\n`;
	return text;
}

module.exports = { render };
