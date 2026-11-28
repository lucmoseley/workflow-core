#!/usr/bin/env node
// #5827

const fs = require("node:fs");
const path = require("node:path");
const { parseArgs } = require("node:util");
const gateway = require("./lib/jev-gateway.js");
const { scriptPath } = require("./lib/script-path.js");
const {
	readLabelRows,
	recordedScores,
	report,
} = require("./lib/fix-or-file-rates.js");
const { worktreeRoot } = require("./lib/host-root.js");

const LABELS = path.join(
	"docs",
	"data",
	"fix-or-file-labels-2026-11-28",
	"labels.jsonl",
);

// measured, #5827: a cold first call took 8 s
const ABORT_MS = 30_000;

const QUESTION_KEY = "leaves_problem";

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

/** @typedef {import("./lib/fix-or-file-rates.js").Scored} Scored */

/**
 * @param {{rows: import("./lib/fix-or-file-rates.js").Row[], key: string}} spec
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
		if (gateway.sweepRefusal({ message: row.text })) {
			process.stderr.write(
				`${row.id}: not sent, the redaction sweep refused it\n`,
			);
			continue;
		}
		const { probability: p } = await gateway.askJev({
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
			recorded: { type: "boolean" },
			help: { type: "boolean" },
		},
		strict: true,
	});
	if (values.help) {
		process.stdout.write(
			`usage: node ${scriptPath("score-fix-or-file.js")} [--labels <jsonl>] [--recorded | --out <jsonl>]\n`,
		);
		return 0;
	}
	const rows = readLabelRows(
		values.labels ?? path.join(worktreeRoot(), LABELS),
	);
	if (values.recorded) {
		process.stdout.write(`${report(recordedScores(rows)).join("\n")}\n`);
		return 0;
	}
	const key = gateway.readKey();
	if (!key) {
		process.stderr.write("no AI_GATEWAY_API_KEY: nothing can be scored.\n");
		return 2;
	}
	const scored = await scoreAll({ rows, key });
	if (values.out)
		fs.writeFileSync(
			values.out,
			`${scored.map((s) => JSON.stringify(s)).join("\n")}\n`,
		);
	process.stdout.write(`${report(scored).join("\n")}\n`);
	return 0;
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(e) => {
		process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
		process.exitCode = 1;
	},
);
