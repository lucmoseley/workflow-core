/*
 * delegated-decision.js — one delegated decision's entry: the fields it owes,
 * the comment that records it on its ticket, and the ledger line the morning
 * review issue lists it from (#2002; spec #1995 §Delegated decisions).
 *
 * The comment and the ledger line are rendered from the same entry, so the
 * review can never list a call the ticket records differently.
 *
 * THE LEDGER lives in the CANONICAL checkout's markers directory — the parent
 * of the common git dir — so a decision recorded from a throwaway worktree
 * lands where the review generator reads, not in a tree about to be deleted.
 * Where git will not answer, the host root's.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { hostRoot } = require("./host-root.js");
const { MARKERS_REL, markersDir } = require("./marker-root.js");
const { repoRoot } = require("./test-pass-marker.js");

const LEDGER = "delegated-decisions.jsonl";

/**
 * The free-text flags, every one required on one line. The three rungs are the
 * research ladder's (#1905): each takes the fact it found, or `none`.
 */
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
 *   taken: {option: string, figure: number},
 *   runnerUp: {option: string, figure: number},
 *   rungs: {rulings: string, web: string, subagent: string},
 *   stillClose: boolean, reverse: string}} Entry
 * `stillClose` is whether the round is still caught once research is spent:
 * its top two rivals close, or no option likely right — the meaning #2328 gave
 * the close-check log's field of that name. The key keeps its name because
 * ledger lines already written carry it (#2594). Residual: the key reads
 * `stillClose` while the comment prints `Still caught:`, so a search for one
 * misses the other.
 */

/**
 * @param {string | undefined} raw
 */
function figure(raw) {
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
		const value = figure(text(flag));
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

/**
 * The comment: a literal `**Delegated decision:**` line, then one line per
 * field.
 * @param {Entry} e
 */
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
 * The ledger's lines, parsed, and a count of the torn ones — a crashed
 * append's half line — which parse to nothing. A missing ledger holds none;
 * an unreadable one throws.
 * @param {string} file
 * @returns {{lines: LedgerLine[], torn: number}}
 */
function ledgerLines(file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (caught(e).code === "ENOENT") return { lines: [], torn: 0 };
		throw e;
	}
	/** @type {LedgerLine[]} */
	const lines = [];
	let torn = 0;
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			lines.push(JSON.parse(line));
		} catch {
			torn++;
		}
	}
	return { lines, torn };
}

/**
 * The ledger in checkout `root`, without creating its markers directory, for
 * the morning review (#2011), which names the torn count rather than drop
 * those decisions silently.
 * @param {string} root
 */
const readLedger = (root) => ledgerLines(path.join(root, MARKERS_REL, LEDGER));

/**
 * Whether the ledger holds a line for `commentUrl` already.
 * @param {string} file
 * @param {string} commentUrl
 */
const hasEntry = (file, commentUrl) =>
	ledgerLines(file).lines.some((line) => line.comment === commentUrl);

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
