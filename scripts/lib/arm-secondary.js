/*
 * arm-secondary.js — three of the before/after test's secondary measures,
 * read off one main-session transcript (#2175,
 * `docs/research/startup-load-before-after-test.md` D3 §Secondary). Each is
 * lexical and reported beside the score, never in it.
 */

const { mainChainRecords, parseContentText } = require("./transcript");
const { needleIn } = require("./guard-fires");
const { meanVar } = require("./arm-stats.js");
const { REF_FORMS, SECTION, scanIssueRefs } = require("./issue-ref.js");
const {
	Q_MARKER,
	OPTION_LABEL,
	PRICED,
	CONFIDENCE_ANY,
} = require("./round-marker.js");

/** The line husky prints whenever any pre-commit gate exits non-zero. */
const HUSKY_REFUSAL = "husky - pre-commit script failed";

const UNATTRIBUTED_GATE = "unattributed";

/**
 * Each pre-commit gate's own refusal lines, any one of which names it.
 * Several also print on a pass, so a refusal goes to the gate matched last
 * before husky's line. A refusal whose output the harness cut off names none.
 * @type {readonly {id: string, lines: readonly string[]}[]}
 */
const COMMIT_GATES = require("../commit-gate-refusals.json").gates.map(
	(/** @type {{id: string, lines: (string | {text: string})[]}} */ g) => ({
		id: g.id,
		lines: g.lines.map((l) => (typeof l === "string" ? l : l.text)),
	}),
);

/**
 * @typedef {import("./guard-fires").Subject} Subject
 * @typedef {import("./guard-fires").LogRecord} LogRecord
 */

/**
 * @param {LogRecord} record
 * @returns {LogRecord[]}
 */
const blocksOf = (record) =>
	Array.isArray(record?.message?.content) ? record.message.content : [];

/**
 * What a call acts on, for telling a repeat.
 * @param {{name: string, input: Record<string, unknown>}} use
 */
function targetOf({ name, input }) {
	if (typeof input?.command === "string")
		return `${name} ${input.command.replace(/\s+/g, " ").trim()}`;
	const file = input?.file_path ?? input?.path;
	if (typeof file === "string") return `${name} ${file}`;
	return `${name} ${JSON.stringify(input)}`;
}

/**
 * Warned calls, and those the session acted against: its next call, the
 * first one it issued after seeing the warn, repeats the warned target or
 * draws the same warn again. A call counts once however many warns it drew,
 * and once however many times the transcript writes its record; a warn counts
 * where its text carries a registered guard's `warn` needle.
 * @param {LogRecord[]} records
 * @param {Subject[]} subjects
 */
function warnsActedAgainst(records, subjects) {
	const warnNeedles = subjects.flatMap((s) =>
		s.needles.filter((n) => n.kind === "warn"),
	);
	/** @type {{id: string, name: string, input: Record<string, unknown>, message: string}[]} */
	const uses = [];
	/** @type {Map<string, Set<string>>} each warned call's warn needle ids */
	const warned = new Map();
	for (const r of records) {
		for (const b of blocksOf(r))
			if (
				b?.type === "tool_use" &&
				typeof b.id === "string" &&
				!uses.some((u) => u.id === b.id)
			)
				uses.push({
					id: b.id,
					name: b.name,
					input: b.input,
					message: r.message?.id,
				});
		const a = r.attachment;
		if (a?.type !== "hook_additional_context" || a.hookEvent !== "PreToolUse")
			continue;
		const texts = [a.content].flat().filter((t) => typeof t === "string");
		const ids = warnNeedles
			.filter((n) => texts.some((t) => needleIn(t, n)))
			.map((n) => n.id);
		if (ids.length > 0)
			warned.set(
				a.toolUseID,
				new Set([...(warned.get(a.toolUseID) ?? []), ...ids]),
			);
	}
	let warnedCalls = 0;
	let repeated = 0;
	let rewarned = 0;
	uses.forEach((u, i) => {
		const ids = warned.get(u.id);
		if (!ids) return;
		warnedCalls++;
		// A sibling in the same message was issued before the warn was seen.
		const next = uses.slice(i + 1).find((n) => n.message !== u.message);
		if (!next) return;
		if (targetOf(next) === targetOf(u)) repeated++;
		else if ([...(warned.get(next.id) ?? [])].some((id) => ids.has(id)))
			rewarned++;
	});
	return {
		warnedCalls,
		actedAgainst: repeated + rewarned,
		repeated,
		rewarned,
	};
}

/** @param {string} output */
function gateBefore(output) {
	let gate = UNATTRIBUTED_GATE;
	let last = -1;
	for (const g of COMMIT_GATES)
		for (const line of g.lines) {
			const at = output.lastIndexOf(line);
			if (at > last) [gate, last] = [g.id, at];
		}
	return gate;
}

/**
 * Pre-commit refusals in Bash results, one per husky line, by the gate that
 * refused each. A Read or a subagent's report quoting the line is no refusal.
 * @param {LogRecord[]} records
 */
function commitGateRefusals(records) {
	/** @type {Record<string, number>} */
	const byGate = {};
	let total = 0;
	/** @type {Set<string>} */
	const bash = new Set();
	for (const r of records)
		for (const b of blocksOf(r)) {
			if (b?.type === "tool_use" && b.name === "Bash") bash.add(b.id);
			if (b?.type !== "tool_result" || !bash.has(b.tool_use_id)) continue;
			for (const gate of refusingGates(parseContentText(b.content))) {
				byGate[gate] = (byGate[gate] ?? 0) + 1;
				total++;
			}
		}
	return { total, byGate };
}

/**
 * The gate behind each husky line in one result, in order.
 * @param {string} text
 */
function refusingGates(text) {
	const gates = [];
	let from = 0;
	for (
		let at = text.indexOf(HUSKY_REFUSAL);
		at !== -1;
		at = text.indexOf(HUSKY_REFUSAL, at + 1)
	) {
		gates.push(gateBefore(text.slice(from, at)));
		from = at + HUSKY_REFUSAL.length;
	}
	return gates;
}

/** A figure with its band in brackets: `70% (60% - 80%)`. */
const BANDED = /\d{1,3}\s*%\s*\(\s*\d{1,3}\s*%\s*[-–—]\s*\d{1,3}\s*%\s*\)/g;
/** A gloss opening straight after an identifier: `#12 (the retry ticket)`. */
const GLOSS_AFTER = /^\s*\(/;
const FENCED = /^\s{0,3}```[\s\S]*?^\s{0,3}```/gm;
/** Code quoted inline, where `#12` is an example rather than a citation. */
const CODE_SPAN = /`[^`\n]*`/g;

/**
 * The session's last assistant message: the text blocks of the last
 * `message.id` that carried text.
 * @param {LogRecord[]} records
 */
function parseFinalMessage(records) {
	let id = null;
	/** @type {string[]} */
	let parts = [];
	for (const r of records) {
		if (r.type !== "assistant") continue;
		const text = parseContentText(
			blocksOf(r).filter((b) => b?.type === "text"),
		);
		if (!text) continue;
		if (r.message.id !== id) parts = [];
		id = r.message.id;
		parts.push(text);
	}
	return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * The lexical checks on a final message. `pricedOutsideRound` is a lettered
 * option and a Confidence line both above the first `❓ **Qn**` marker;
 * `glossed` counts the identifiers whose first mention opens a bracket.
 * @param {string} message
 */
function finalMessageChecks(message) {
	const lines = message.replace(FENCED, "").split("\n");
	const marker = lines.findIndex((l) => Q_MARKER.test(l));
	const outside = marker === -1 ? lines : lines.slice(0, marker);
	const prose = lines.join("\n").replace(CODE_SPAN, "");
	const confidenceLines = lines.filter((l) => CONFIDENCE_ANY.test(l));
	/** @type {Map<string, boolean>} */
	const firstMention = new Map();
	const identifiers = [
		...scanIssueRefs(prose, REF_FORMS.identifier),
		...[...prose.matchAll(SECTION)].map((m) => ({
			text: m[0],
			index: m.index,
		})),
	].sort((a, b) => a.index - b.index);
	for (const { text, index } of identifiers)
		if (!firstMention.has(text))
			firstMention.set(
				text,
				GLOSS_AFTER.test(prose.slice(index + text.length)),
			);
	return {
		pricedOutsideRound:
			outside.some((l) => OPTION_LABEL.test(l)) &&
			outside.some((l) => CONFIDENCE_ANY.test(l)),
		bandedFigures: (prose.match(BANDED) ?? []).length,
		unbandedConfidence: confidenceLines.filter((l) => !PRICED.test(l)).length,
		identifiers: firstMention.size,
		glossed: [...firstMention.values()].filter(Boolean).length,
	};
}

/**
 * @param {string} text
 * @param {Subject[]} subjects
 */
function secondaryOf(text, subjects) {
	const records = [...mainChainRecords(text, "main")];
	const final = parseFinalMessage(records);
	return {
		warnsActedAgainst: warnsActedAgainst(records, subjects),
		commitGateRefusals: commitGateRefusals(records),
		finalMessage: final === null ? null : finalMessageChecks(final),
	};
}

/**
 * One arm's measures over its runs: per-run mean and variance where a count
 * varies by run, totals where a share or a split is what reads.
 * @param {ReturnType<typeof secondaryOf>[]} runs
 */
function summariseSecondary(runs) {
	const sum = (/** @type {number[]} */ xs) => xs.reduce((a, b) => a + b, 0);
	/** @type {Record<string, number>} */
	const byGate = {};
	for (const r of runs)
		for (const [g, n] of Object.entries(r.commitGateRefusals.byGate))
			byGate[g] = (byGate[g] ?? 0) + n;
	const finals = runs.flatMap((r) => (r.finalMessage ? [r.finalMessage] : []));
	return {
		warnsActedAgainst: {
			perRun: meanVar(runs.map((r) => r.warnsActedAgainst.actedAgainst)),
			actedAgainst: sum(runs.map((r) => r.warnsActedAgainst.actedAgainst)),
			repeated: sum(runs.map((r) => r.warnsActedAgainst.repeated)),
			rewarned: sum(runs.map((r) => r.warnsActedAgainst.rewarned)),
			warnedCalls: sum(runs.map((r) => r.warnsActedAgainst.warnedCalls)),
		},
		commitGateRefusals: {
			perRun: meanVar(runs.map((r) => r.commitGateRefusals.total)),
			byGate,
		},
		finalMessage: {
			read: finals.length,
			pricedOutsideRound: finals.filter((f) => f.pricedOutsideRound).length,
			bandedFigures: meanVar(finals.map((f) => f.bandedFigures)),
			unbandedConfidence: meanVar(finals.map((f) => f.unbandedConfidence)),
			identifiers: sum(finals.map((f) => f.identifiers)),
			glossed: sum(finals.map((f) => f.glossed)),
		},
	};
}

module.exports = { secondaryOf, summariseSecondary };
