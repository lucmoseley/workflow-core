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
const { PROFILE_GATES: GATES } = require("./precommit-gates.js");

const HUSKY_REFUSAL = "husky - pre-commit script failed";

const UNATTRIBUTED_GATE = "unattributed";

/** @type {readonly {id: string, lines: readonly string[]}[]} */
const COMMIT_GATES = [
	...require("../commit-gate-refusals.json").gates,
	...GATES.map((g) => ({ id: g.id, lines: g.refusals })),
].map((/** @type {{id: string, lines: (string | {text: string})[]}} */ g) => ({
	id: g.id,
	lines: g.lines.map((l) => (typeof l === "string" ? l : l.text)),
}));

/**
 * @typedef {import("./guard-fires").Subject} Subject
 * @typedef {import("./transcript.js").TranscriptRecord} TranscriptRecord
 * @typedef {import("./transcript.js").TranscriptBlock} TranscriptBlock
 */

/**
 * @param {TranscriptRecord} record
 * @returns {TranscriptBlock[]}
 */
const blocksOf = (record) =>
	Array.isArray(record?.message?.content) ? record.message.content : [];

/** @param {{name: string, input: Record<string, unknown>}} use */
function targetOf({ name, input }) {
	if (typeof input?.command === "string")
		return `${name} ${input.command.replace(/\s+/g, " ").trim()}`;
	const file = input?.file_path ?? input?.path;
	if (typeof file === "string") return `${name} ${file}`;
	return `${name} ${JSON.stringify(input)}`;
}

/**
 * @param {TranscriptRecord[]} records
 * @param {Subject[]} subjects
 */
function warnsActedAgainst(records, subjects) {
	const warnNeedles = subjects.flatMap((s) =>
		s.needles.filter((n) => n.kind === "warn"),
	);
	/** @type {{id: string, name: string, input: Record<string, unknown>, message: string}[]} */
	const uses = [];
	/** @type {Map<string, Set<string>>} */
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

/** @param {TranscriptRecord[]} records */
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

/** @param {string} text */
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

const BANDED = /\d{1,3}\s*%\s*\(\s*\d{1,3}\s*%\s*[-–—]\s*\d{1,3}\s*%\s*\)/g;
const GLOSS_AFTER = /^\s*\(/;
const FENCED = /^\s{0,3}```[\s\S]*?^\s{0,3}```/gm;
const CODE_SPAN = /`[^`\n]*`/g;

/** @param {TranscriptRecord[]} records */
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

/** @param {string} message */
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

/** @param {ReturnType<typeof secondaryOf>[]} runs */
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
