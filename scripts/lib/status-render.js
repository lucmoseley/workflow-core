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
 * @property {number | null} code
 * @property {string | null} signal
 * @property {string} out
 */

/** @param {Result} r */
function verdict(r) {
	const last = r.out.split("\n").pop() ?? "";
	if (r.signal) return `killed by ${r.signal}`;
	if (r.code === 0 && r.out === "") return "OK";
	if (/^OK:/.test(last)) return "OK";
	if (/^SKIP:/.test(last)) return "SKIP";
	return null;
}

/** @param {Result[]} results @returns {string} */
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
