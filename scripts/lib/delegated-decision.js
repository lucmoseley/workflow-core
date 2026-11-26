const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./host-root.js");
const { readJsonl } = require("./jsonl.js");
const { MARKERS_REL, markersDir } = require("./marker-root.js");
const { repoRoot } = require("./test-pass-marker.js");

const LEDGER = "delegated-decisions.jsonl";

const TEXT_FLAGS = [
	"--question",
	"--taken",
	"--runner-up",
	"--rung-rulings",
	"--rung-web",
	"--rung-subagent",
	"--reverse",
];

const FLAGS = /** @type {Record<string, "value">} */ (
	Object.fromEntries(
		[
			...TEXT_FLAGS,
			"--taken-figure",
			"--runner-up-figure",
			"--still-caught",
		].map((f) => [f, "value"]),
	)
);

/**
 * @typedef {{question: string,
 * taken: {option: string, figure: number},
 * runnerUp: {option: string, figure: number},
 * rungs: {rulings: string, web: string, subagent: string},
 * stillClose: boolean, reverse: string}} Entry
 */

/**
 * @param {string | undefined} raw
 */
function parseFigure(raw) {
	const m = /^\s*(\d{1,3})\s*%\s*$/.exec(raw ?? "");
	return m && Number(m[1]) <= 100 ? Number(m[1]) : null;
}

/**
 * @param {Record<string, string | true>} flags
 * @returns {{entry: Entry} | {faults: string[]}}
 */
function entryFrom(flags) {
	/** @param {string} flag */
	const text = (flag) => {
		const v = flags[flag];
		return typeof v === "string" ? v.trim() : "";
	};
	const faults = [];
	for (const flag of TEXT_FLAGS) {
		if (!text(flag)) faults.push(`${flag} is missing or empty`);
		else if (/[\r\n]/.test(text(flag)))
			faults.push(`${flag} spans more than one line`);
	}
	/** @param {string} flag */
	const percent = (flag) => {
		const value = parseFigure(text(flag));
		if (value === null) faults.push(`${flag} must be a percentage such as 70%`);
		return value ?? 0;
	};
	const taken = percent("--taken-figure");
	const runnerUp = percent("--runner-up-figure");
	const still = text("--still-caught");
	if (still !== "yes" && still !== "no")
		faults.push("--still-caught must be yes or no");
	if (faults.length > 0) return { faults };
	return {
		entry: {
			question: text("--question"),
			taken: { option: text("--taken"), figure: taken },
			runnerUp: { option: text("--runner-up"), figure: runnerUp },
			rungs: {
				rulings: text("--rung-rulings"),
				web: text("--rung-web"),
				subagent: text("--rung-subagent"),
			},
			stillClose: still === "yes",
			reverse: text("--reverse"),
		},
	};
}

/** @param {Entry} e */
const renderComment = (e) =>
	[
		"**Delegated decision:**",
		"",
		`- Question: ${e.question}`,
		`- Taken: ${e.taken.option} — ${e.taken.figure}%`,
		`- Runner-up: ${e.runnerUp.option} — ${e.runnerUp.figure}%`,
		`- Rung 1, past rulings: ${e.rungs.rulings}`,
		`- Rung 2, web or vendor docs: ${e.rungs.web}`,
		`- Rung 3, fresh subagent: ${e.rungs.subagent}`,
		`- Still caught: ${e.stillClose ? "yes" : "no"}`,
		`- To reverse: ${e.reverse}`,
		"",
	].join("\n");

const ledgerPath = () => {
	const host = hostRoot();
	return path.join(markersDir(repoRoot(host) ?? host), LEDGER);
};

/**
 * @typedef {Entry & {at: string, repo: string, issue: number, comment: string,
 *   session: string | null}} LedgerLine
 */

/**
 * @typedef {{before: string | null, after: string | null}} ZeroedRecord
 */

/**
 * @param {string} file
 * @returns {{lines: LedgerLine[], torn: number, zeroed: ZeroedRecord[]}}
 */
function readLedgerLines(file) {
	const read = readJsonl(file);
	if (!read) return { lines: [], torn: 0, zeroed: [] };
	/** @param {{row: Record<string, unknown>} | undefined} entry */
	const writtenAt = (entry) => {
		if (entry === undefined) return null;
		return typeof entry.row.at === "string" ? entry.row.at : "an undated row";
	};
	return {
		lines: /** @type {LedgerLine[]} */ (read.rows),
		torn: read.bad.length,
		zeroed: read.zeroed.map((line) => ({
			before: writtenAt(read.entries.findLast((e) => e.line < line)),
			after: writtenAt(read.entries.find((e) => e.line >= line)),
		})),
	};
}

/** @param {string} root */
const readLedger = (root) =>
	readLedgerLines(path.join(root, MARKERS_REL, LEDGER));

/**
 * @param {string} file
 * @param {string} commentUrl
 */
const hasEntry = (file, commentUrl) =>
	readLedgerLines(file).lines.some((line) => line.comment === commentUrl);

/**
 * @param {string} file
 * @param {object} line
 */
const appendEntry = (file, line) =>
	fs.appendFileSync(file, `${JSON.stringify(line)}\n`);

module.exports = {
	FLAGS,
	appendEntry,
	entryFrom,
	hasEntry,
	ledgerPath,
	readLedger,
	renderComment,
};
