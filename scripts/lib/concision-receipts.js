const fs = require("node:fs");
const path = require("node:path");
const { orFallback } = require("./caught.js");

const ROUTES = ["subagent", "in-session", "mixed", "unrecorded"];

/** @typedef {{ findings: number, route: string }} Receipt */
/** @typedef {{ runs: number, findings: number, zero: number }} RouteTotals */

/**
 * @param {string} body
 * @returns {Receipt | null}
 */
function readReceipt(body) {
	/** @param {string} key */
	const line = (key) =>
		body
			.split("\n")
			.find((l) => l.startsWith(`${key}=`))
			?.slice(key.length + 1)
			.trim();
	const findings = line("findings");
	if (!findings || !/^\d+$/.test(findings)) return null;
	const route = line("route");
	return {
		findings: Number(findings),
		route: route && ROUTES.includes(route) ? route : "unrecorded",
	};
}

/**
 * @param {Receipt[]} receipts
 * @returns {Map<string, RouteTotals>}
 */
function summarise(receipts) {
	/** @type {Map<string, RouteTotals>} */
	const out = new Map();
	for (const r of receipts) {
		const g = out.get(r.route) ?? { runs: 0, findings: 0, zero: 0 };
		g.runs += 1;
		g.findings += r.findings;
		if (r.findings === 0) g.zero += 1;
		out.set(r.route, g);
	}
	return out;
}

/**
 * @param {string} dir
 * @returns {Receipt[]}
 */
function collect(dir) {
	/** @type {Receipt[]} */
	const out = [];
	for (const f of fs.readdirSync(dir)) {
		if (!f.startsWith(".concision-pass-")) continue;
		const r = orFallback(
			() => readReceipt(fs.readFileSync(path.join(dir, f), "utf8")),
			null,
		);
		if (r) out.push(r);
	}
	return out;
}

/**
 * @param {Receipt[]} receipts
 * @returns {string}
 */
function report(receipts) {
	const groups = summarise(receipts);
	const lines = [
		`${receipts.length} concision-pass receipts, by route:`,
		"",
		"| Route | Runs | Findings | Mean per run | findings=0 |",
		"|---|---|---|---|---|",
	];
	for (const route of ROUTES) {
		const g = groups.get(route);
		if (!g) continue;
		lines.push(
			`| ${route} | ${g.runs} | ${g.findings} | ${(g.findings / g.runs).toFixed(1)} | ${g.zero} |`,
		);
	}
	lines.push(
		"",
		"Findings-per-run is a directional proxy priced at ~60% validity (mantahostels#1085,",
		"which measured what a pass costs where it runs), not a quality",
		"measurement: it counts cuts, not whether the right lines went.",
		"`unrecorded` is a receipt naming no route this file knows — every one",
		"predating mantahostels#1099 (which added `route=`), plus any misspelling since. It is",
		"not evidence for either arm.",
		"Not counted at all: the concision pass the backstop's CODE signal demands,",
		"whose cuts fold into `.codereview-pass-<sid>`'s count of review findings",
		"and leave no receipt of their own.",
	);
	return lines.join("\n");
}

module.exports = { collect, report };
