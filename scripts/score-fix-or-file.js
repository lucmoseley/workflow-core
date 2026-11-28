#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const advisory = require("./guard-jev-advisory.js");
const { readJsonl } = require("./lib/jsonl.js");
const { worktreeRoot } = require("./lib/host-root.js");

const LABELS = path.join(
	"docs",
	"data",
	"fix-or-file-labels-2026-11-28",
	"labels.jsonl",
);

// #5827: wider than the hook's 3 s abort, a cold first call measured 8 s
const ABORT_MS = 30_000;

const THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

const QUESTION_KEY = "leaves_problem";

// #5814
const QUESTION = {
	type: "boolean",
	instructions:
		"Does this message name a concrete problem (a defect in code, docs, a ticket or config) that it neither says it fixed nor says it recorded on an issue (an issue number, a comment, a filing)?",
	criteria: {
		true: "the message names a concrete defect and, for at least one, says neither that it was fixed nor that it was filed or recorded on a named issue",
		false:
			"the message names no defect, or says of each defect it names that it was fixed, or filed or recorded on a named issue",
	},
};

/**
 * @typedef {{id: string, label: boolean|null, kind: string, text?: string}} Row
 * @typedef {{id: string, label: boolean|null, kind: string, p: number}} Scored
 */

/**
 * @param {Scored[]} scored
 * @param {number} threshold
 */
function rates(scored, threshold) {
	const pos = scored.filter((s) => s.label === true);
	const neg = scored.filter((s) => s.label === false);
	const fired = scored.filter((s) => s.p >= threshold);
	const tp = pos.filter((s) => s.p >= threshold).length;
	const fp = neg.filter((s) => s.p >= threshold).length;
	return {
		threshold,
		fires: fired.length,
		tp,
		fp,
		unjudged: fired.length - tp - fp,
		tpr: pos.length > 0 ? tp / pos.length : null,
		tnr: neg.length > 0 ? (neg.length - fp) / neg.length : null,
		effectiveFp: tp + fp > 0 ? fp / (tp + fp) : null,
	};
}

/** @param {number|null} r */
const pct = (r) =>
	r === null ? "  n/a" : `${(r * 100).toFixed(0)}%`.padStart(5);

/**
 * @param {Scored[]} scored
 * @returns {string[]}
 */
function report(scored) {
	const count = (/** @type {boolean|null} */ label) =>
		scored.filter((s) => s.label === label).length;
	const lines = [
		`${scored.length} replies scored: ${count(true)} positive, ${count(false)} negative, ${count(null)} unjudged.`,
		"threshold   TPR   TNR  fires  tp fp unjudged  effective FP",
	];
	for (const t of THRESHOLDS) {
		const r = rates(scored, t);
		lines.push(
			`   ${t.toFixed(1)}     ${pct(r.tpr)} ${pct(r.tnr)}  ${String(r.fires).padStart(5)}  ${r.tp} ${r.fp} ${r.unjudged}  ${pct(r.effectiveFp)}`,
		);
	}
	return lines;
}

/** @param {string} file @returns {Row[]} */
function readRows(file) {
	const read = readJsonl(file);
	if (!read) throw new Error(`${file}: no such file`);
	if (read.bad.length > 0)
		throw new Error(`${file}: lines ${read.bad.join(", ")} are not JSON`);
	return /** @type {Row[]} */ (/** @type {unknown} */ (read.rows));
}

/**
 * @param {{rows: Row[], key: string}} spec
 * @returns {Promise<Scored[]>}
 */
async function scoreAll({ rows, key }) {
	/** @type {Scored[]} */
	const scored = [];
	for (const row of rows) {
		if (typeof row.text !== "string") {
			process.stderr.write(`${row.id}: no text, its source repo is private\n`);
			continue;
		}
		if (advisory.gateway.sweepRefusal({ message: row.text })) {
			process.stderr.write(
				`${row.id}: not sent, the redaction sweep refused it\n`,
			);
			continue;
		}
		const { probability: p } = await advisory.gateway.askJev({
			key,
			message: row.text,
			questions: { [QUESTION_KEY]: QUESTION },
			questionKey: QUESTION_KEY,
			abortMs: ABORT_MS,
		});
		scored.push({ id: row.id, label: row.label, kind: row.kind, p });
	}
	return scored;
}

/** @returns {Promise<number>} */
async function main() {
	const { values } = parseArgs({
		options: {
			labels: { type: "string" },
			out: { type: "string" },
			help: { type: "boolean" },
		},
		strict: true,
	});
	if (values.help) {
		process.stdout.write(
			"usage: node scripts/score-fix-or-file.js [--labels <jsonl>] [--out <jsonl>]\n",
		);
		return 0;
	}
	const key = advisory.gateway.readKey();
	if (!key) {
		process.stderr.write("no AI_GATEWAY_API_KEY: nothing can be scored.\n");
		return 2;
	}
	const scored = await scoreAll({
		rows: readRows(values.labels ?? path.join(worktreeRoot(), LABELS)),
		key,
	});
	const out = values.out;
	if (out)
		fs.writeFileSync(
			out,
			`${scored.map((s) => JSON.stringify(s)).join("\n")}\n`,
		);
	process.stdout.write(`${report(scored).join("\n")}\n`);
	return 0;
}

module.exports = { rates, report, QUESTION };

if (require.main === module)
	main().then(
		(code) => {
			process.exitCode = code;
		},
		(e) => {
			process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
			process.exitCode = 1;
		},
	);
