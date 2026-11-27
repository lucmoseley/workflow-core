#!/usr/bin/env node

const hookBlock = require("./lib/hook-block");
const { describeCall, reportOnce } = require("./lib/report-once");
const { readRuleParagraph } = require("./lib/rule-text");
const sessionTranscript = require("./lib/session-transcript");
const stopGuard = require("./lib/stop-guard");
const { isSafeId } = require("./lib/safe-id");
const { isSubagentPayload } = require("./lib/subagent-payload");
const { isSubagentTranscript, mainChainRecords } = require("./lib/transcript");

/**
 * @typedef {{session_id?: string, transcript_path?: string,
 *   agent_id?: unknown, agent_transcript_path?: unknown}} Payload
 * @typedef {{id: string, call: string, reason: string}} Refusal
 */

const DENIAL =
	/^\s*(?:Error:\s*)?Permission for this action was denied by the Claude Code auto mode classifier\.(?:\s*Reason:\s*([^\s.][^.]*|)\.)?/;

const PARAGRAPH_HEAD = "AN AUTO-MODE REFUSAL";

const SEEN_PREFIX = ".automode-refusal-seen-";

/**
 * @param {unknown} content
 * @returns {string}
 */
function parseResultText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) =>
			b?.type === "text" && typeof b.text === "string" ? b.text : "",
		)
		.join("\n");
}

/**
 * @param {import("./lib/transcript.js").TranscriptRecord} record
 * @returns {boolean}
 */
function isHumanPrompt(record) {
	if (record?.type !== "user" || record.isMeta) return false;
	const content = record.message?.content;
	if (typeof content === "string") return true;
	return (
		Array.isArray(content) && !content.some((b) => b?.type === "tool_result")
	);
}

/**
 * @param {string} text
 * @param {"main" | "subagent"} tier
 * @returns {Refusal[]}
 */
function refusalsThisTurn(text, tier) {
	/** @type {Map<string, {name?: unknown, input?: unknown}>} */
	const uses = new Map();
	/** @type {Refusal[]} */
	let out = [];
	for (const record of mainChainRecords(text, tier)) {
		if (isHumanPrompt(record)) {
			out = [];
			continue;
		}
		const content = record?.message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block?.type === "tool_use" && typeof block.id === "string")
				uses.set(block.id, block);
			const refusal = refusalOf(record, block, uses);
			if (refusal) out.push(refusal);
		}
	}
	return out;
}

/**
 * @param {import("./lib/transcript.js").TranscriptRecord} record
 * @param {import("./lib/transcript.js").TranscriptBlock} block
 * @param {Map<string, {name?: unknown, input?: unknown}>} uses
 * @returns {Refusal | null}
 */
function refusalOf(record, block, uses) {
	if (block?.type !== "tool_result") return null;
	if (typeof block.tool_use_id !== "string") return null;
	if (record.toolDenialKind === "automode-unavailable") return null;
	const tagged = record.toolDenialKind === "automode-blocked";
	const denial =
		block.is_error === true
			? DENIAL.exec(parseResultText(block.content))
			: null;
	if (!tagged && !denial) return null;
	return {
		id: block.tool_use_id,
		call: describeCall(uses.get(block.tool_use_id)),
		reason: denial?.[1]?.trim() || "none given",
	};
}

/**
 * @param {Payload} payload
 * @param {string} sid
 * @returns {{file: string | null, tier: "main" | "subagent", budgetKey: string} | null}
 */
function whoseTurn(payload, sid) {
	if (!isSubagentPayload(payload)) {
		const file = sessionTranscript.resolve(payload, sid);
		const tier = file && isSubagentTranscript(file) ? "subagent" : "main";
		return { file, tier, budgetKey: sid };
	}
	const agent = payload.agent_id;
	if (!isSafeId(agent)) return null;
	const own = payload.agent_transcript_path;
	return {
		file: typeof own === "string" && own !== "" ? own : null,
		tier: "subagent",
		budgetKey: `${sid}-${agent}`,
	};
}

/**
 * @param {Refusal[]} fresh
 * @param {"main" | "subagent"} tier
 * @returns {string}
 */
function reportFor(fresh, tier) {
	return [
		`THE AUTO-MODE CLASSIFIER REFUSED ${fresh.length === 1 ? "A CALL" : `${fresh.length} CALLS`} THIS TURN, and the turn is ending:`,
		"",
		...fresh.map((r) => `  ${r.call}\n    Reason: ${r.reason}`),
		"",
		readRuleParagraph("founder-handover", PARAGRAPH_HEAD),
		"",
		"Before ending the turn, say which applies to each: reached the goal another way (how), dropped it (why), or handing over a `!` line naming what you tried.",
		`Each refused call is shown this once, and this guard costs at most ${hookBlock.MAX_BLOCKS} turns ${tier === "subagent" ? "a subagent" : "a session"}.`,
	].join("\n");
}

/**
 * @param {{sessionId: string, payload: Payload, root: string,
 *   note: (outcome: string, payload?: Payload) => void}} ctx
 * @returns {boolean}
 */
function review({ sessionId: sid, payload, root, note }) {
	const turn = whoseTurn(payload, sid);
	if (!turn?.file) {
		note("no-transcript", payload);
		return false;
	}
	const { file, tier, budgetKey } = turn;
	let refusals;
	try {
		refusals = refusalsThisTurn(sessionTranscript.read(file), tier);
	} catch {
		note("unreadable-transcript", payload);
		return false;
	}
	if (refusals.length === 0) {
		note("no-finding", payload);
		return false;
	}
	note("message", payload);

	return reportOnce({
		root,
		sessionId: sid,
		seenPrefix: SEEN_PREFIX,
		items: refusals,
		idOf: (r) => r.id,
		block: (fresh) =>
			hookBlock.blockStop({
				prefix: ".automode-refusal-nagged-",
				sessionId: budgetKey,
				reason: reportFor(fresh, tier),
			}),
	});
}

if (require.main === module) stopGuard.onPayload({ review, record: true });
