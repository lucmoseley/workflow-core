/*
 * concision-receipts.js — reads the `.concision-pass-<session-id>` receipts a
 * concision pass writes at its step 6, and totals findings per run split by the
 * route the pass took.
 *
 * The seam behind scripts/concision-route-report.js, which is the only caller.
 * It exists so the parsing and the totalling can be asserted in-process, the
 * CLI staying a black-box subprocess (§X3).
 *
 * WHY THE SPLIT IS STILL READ. The question it was built for — is a subagent
 * pass cheaper because it re-reads less context, or because it is less thorough?
 * (mantahostels#1085, mantahostels#1099) — is closed: mantahostels#1100 and mantahostels#1143 ended that route, so nothing
 * writes `route=subagent` any more. The receipts already carrying it are the
 * only record of that arm, and mantahostels#1103 kept this reader for them.
 *
 * WHAT THE OUTPUT IS WORTH. Findings-per-run counts cuts, not whether the right
 * lines were cut; mantahostels#1085 priced it at ~60% validity as a proxy for quality —
 * never a quality measurement.
 */

const fs = require("node:fs");
const path = require("node:path");

/**
 * The routes a pass may record, plus the bucket for a receipt that names none
 * this file knows. Order is the report's row order.
 */
const ROUTES = ["subagent", "in-session", "mixed", "unrecorded"];

/** @typedef {{ findings: number, route: string }} Receipt */
/** @typedef {{ runs: number, findings: number, zero: number }} RouteTotals */

/**
 * Parses one receipt body. Returns null for a body carrying no usable
 * `findings=`, which is a receipt scripts/concision-backstop.sh would itself
 * have rejected as no pass.
 *
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
 * Totals each route over its own runs.
 *
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
 * Every readable receipt in `dir`. A receipt that cannot be read or parsed is
 * dropped rather than counted as a pass that found nothing — a findings=0 pass
 * is evidence and an unreadable file is not.
 *
 * @param {string} dir
 * @returns {Receipt[]}
 */
function collect(dir) {
	/** @type {Receipt[]} */
	const out = [];
	for (const f of fs.readdirSync(dir)) {
		if (!f.startsWith(".concision-pass-")) continue;
		try {
			const r = readReceipt(fs.readFileSync(path.join(dir, f), "utf8"));
			if (r) out.push(r);
		} catch {
			// Unreadable mid-write, or gone since the readdir. Neither is a pass.
		}
	}
	return out;
}

/**
 * The report, as Markdown. Every caveat that qualifies a row is printed with
 * the table: this output is read once, by a session deciding mantahostels#1099's held
 * question, and a caveat left elsewhere would not reach it.
 *
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
