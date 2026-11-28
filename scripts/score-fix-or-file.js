#!/usr/bin/env node
// #5827, #5833

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { parseArgs } = require("node:util");
const advisory = require("./guard-jev-advisory.js");
const { claudeBin } = require("./lib/claude-bin.js");
const {
	claudeArgs,
	claudePrompt,
	parseClaudeVerdict,
} = require("./lib/fix-or-file-claude.js");
const {
	readLabelRows,
	recordedScores,
	report,
} = require("./lib/fix-or-file-rates.js");
const {
	rehydrate,
	transcriptIndex,
} = require("./lib/fix-or-file-rehydrate.js");
const { worktreeRoot } = require("./lib/host-root.js");
const gateway = require("./lib/jev-gateway.js");
const { scriptPath } = require("./lib/script-path.js");

const LABELS = path.join(
	"docs",
	"data",
	"fix-or-file-labels-2026-11-28",
	"labels.jsonl",
);

// measured, #5827: a cold first call took 8 s
const ABORT_MS = 30_000;

// guess, #5833: a trial `claude -p` call took under 10 s
const CLAUDE_MS = 120_000;

// guess, #5833: the fast model a prompt hook defaults to
const CLAUDE_MODEL = "haiku";

const ROUTES = ["jev", "claude"];

/** @typedef {import("./lib/fix-or-file-rates.js").Scored} Scored */
/** @typedef {import("./lib/fix-or-file-rates.js").Row} Row */
/** @typedef {import("./lib/fix-or-file-claude.js").Question} Question */
/** @typedef {(message: string) => Promise<{p: number, costUsd?: number}>} Ask */

/**
 * @param {string|undefined} file
 * @returns {Question}
 */
function readQuestion(file) {
	if (!file) return advisory.LEAVES_QUESTION;
	const q = JSON.parse(fs.readFileSync(file, "utf8"));
	if (
		typeof q?.instructions !== "string" ||
		typeof q?.criteria?.true !== "string" ||
		typeof q?.criteria?.false !== "string"
	)
		throw new Error(`${file}: no instructions with true and false criteria`);
	return { ...q, type: "boolean" };
}

/**
 * @param {Question} question
 * @returns {Ask|null}
 */
function jevAsk(question) {
	const key = gateway.readKey();
	if (!key) return null;
	return async (message) => {
		const { probability } = await gateway.askJev({
			key,
			message,
			questions: { [advisory.LEAVES_KEY]: question },
			questionKey: advisory.LEAVES_KEY,
			abortMs: ABORT_MS,
		});
		return { p: probability };
	};
}

/**
 * @param {Question} question
 * @param {string} model
 * @returns {Ask}
 */
function claudeAsk(question, model) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "fix-or-file-claude-"));
	return async (message) => {
		const res = spawnSync(claudeBin(), claudeArgs({ model }), {
			cwd,
			input: claudePrompt(question, message),
			encoding: "utf8",
			timeout: CLAUDE_MS,
		});
		if (res.error) throw res.error;
		return parseClaudeVerdict(res.stdout);
	};
}

/**
 * @param {{rows: Row[], ask: Ask}} spec
 * @returns {Promise<{scored: Scored[], costUsd: number}>}
 */
async function scoreAll({ rows, ask }) {
	/** @type {Scored[]} */
	const scored = [];
	let costUsd = 0;
	for (const row of rows) {
		if (typeof row.text !== "string") continue;
		if (gateway.sweepRefusal({ message: row.text })) {
			process.stderr.write(
				`${row.id}: not sent, the redaction sweep refused it\n`,
			);
			continue;
		}
		let answer;
		try {
			answer = await ask(row.text);
		} catch (e) {
			process.stderr.write(
				`${row.id}: not scored, ${e instanceof Error ? e.message : String(e)}\n`,
			);
			continue;
		}
		const { p, costUsd: cost = 0 } = answer;
		costUsd += cost;
		scored.push({ id: row.id, label: row.label, kind: row.kind, p });
	}
	return { scored, costUsd };
}

/**
 * @param {Row[]} rows
 * @returns {Row[]}
 */
function withLocalText(rows) {
	const { rows: filled, unresolved } = rehydrate(
		rows,
		transcriptIndex(os.homedir()),
	);
	for (const id of unresolved)
		process.stderr.write(`${id}: no text, and no local transcript holds it\n`);
	return filled;
}

const USAGE = `usage: node ${scriptPath("score-fix-or-file.js")} [--labels <jsonl>] [--recorded | [--question <json>] [--route jev|claude] [--model <m>] [--out <jsonl>]]\n`;

/** @returns {Promise<number>} */
async function score() {
	const { values } = parseArgs({
		options: {
			labels: { type: "string" },
			out: { type: "string" },
			recorded: { type: "boolean" },
			question: { type: "string" },
			route: { type: "string", default: "jev" },
			model: { type: "string", default: CLAUDE_MODEL },
			help: { type: "boolean" },
		},
		strict: true,
	});
	if (values.help) {
		process.stdout.write(USAGE);
		return 0;
	}
	if (!ROUTES.includes(values.route)) {
		process.stderr.write(USAGE);
		return 2;
	}
	const rows = readLabelRows(
		values.labels ?? path.join(worktreeRoot(), LABELS),
	);
	if (values.recorded) {
		process.stdout.write(`${report(recordedScores(rows)).join("\n")}\n`);
		return 0;
	}
	const question = readQuestion(values.question);
	const ask =
		values.route === "claude"
			? claudeAsk(question, values.model)
			: jevAsk(question);
	if (!ask) {
		process.stderr.write(`no ${gateway.KEY_VAR}: nothing can be scored.\n`);
		return 2;
	}
	const { scored, costUsd } = await scoreAll({
		rows: withLocalText(rows),
		ask,
	});
	if (values.out)
		fs.writeFileSync(
			values.out,
			`${scored.map((s) => JSON.stringify(s)).join("\n")}\n`,
		);
	const perTurn = scored.length > 0 ? costUsd / scored.length : 0;
	process.stdout.write(
		`${report(scored).join("\n")}\ncost: $${costUsd.toFixed(4)} over ${scored.length} replies, $${perTurn.toFixed(5)} per turn (${values.route})\n`,
	);
	return 0;
}

/** @returns {Promise<void>} */
async function main() {
	process.exitCode = await score();
}

module.exports = { main };

if (require.main === module)
	main().catch((e) => {
		process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
		process.exitCode = 1;
	});
