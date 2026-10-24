#!/usr/bin/env node
/*
 * guard-automode-refusal.js — Stop hook. Sends a session back when it ends a
 * turn in which the auto-mode classifier refused one of its tool calls, with
 * the founder's rule for what a refusal obliges (workflow-core#860).
 *
 * WHY Stop. The rule applies at the end of a turn carrying a refusal, which
 * a Stop hook sees. A `PermissionDenied` hook fires on the refusal itself but cannot add
 * context, only `retry: true` (workflow-core#860 §Out of scope).
 *
 * WHAT COUNTS AS A REFUSAL. A tool result since the last human prompt that is
 * an error and opens with the classifier's denial sentence, or a record the
 * harness tags with an `automode-*` `toolDenialKind`. The sentence is anchored
 * at the start because a tool result merely QUOTING it — a grep over
 * transcripts, a read of this file — is not a refusal. Reading the transcript
 * is safe here, unlike for the outgoing text (docs/agents/guard-authoring.md
 * §Choosing the event): tool results are in the file by Stop.
 *
 * A REPORTING GUARD (docs/agents/guard-authoring.md): it asks the session to
 * say which way it took and does not grade the answer. So it does NOT stand
 * down on `stop_hook_active` the way guard-lost-deny.js does — a turn another
 * Stop hook sent back would otherwise end unshown, the next human prompt
 * starting a new turn. The latch in DEFEAT is what bounds it.
 *
 * IMPLICIT:  reads this session's own transcript at every Stop and refuses one
 *            turn carrying an auto-mode refusal it has not yet shown the rule
 *            for.
 * JUSTIFIED: fail-safe — a session that ends on a refusal stalls the ticket,
 *            and the remedy is one sentence saying which way it went.
 * DEFEAT:    once per refused call and at most MAX_BLOCKS times per session;
 *            silent where the turn carries no refusal, and on every failure
 *            path.
 */

const hookBlock = require("./lib/hook-block");
const { describeCall, reportOnce } = require("./lib/report-once");
const { ruleParagraph } = require("./lib/rule-text");
const sessionTranscript = require("./lib/session-transcript");
const stopGuard = require("./lib/stop-guard");
const { isSubagentTranscript, mainChainRecords } = require("./lib/transcript");

/**
 * @typedef {{session_id?: string, transcript_path?: string}} Payload
 * @typedef {{id: string, call: string, reason: string}} Refusal
 */

/** How the harness opens every classifier refusal (workflow-core#860). */
const DENIAL =
	/^\s*(?:Error:\s*)?Permission for this action was denied by the Claude Code auto mode classifier\.(?:\s*Reason:\s*([^.]*)\.)?/;

/** The paragraph of `rule:founder-handover` this guard prints. */
const PARAGRAPH_HEAD = "AN AUTO-MODE REFUSAL";

/** Tool calls already reported, one id per line (lib/report-once.js). */
const SEEN_PREFIX = ".automode-refusal-seen-";

/**
 * A tool result's text, whichever of its two shapes the harness wrote.
 * @param {unknown} content
 * @returns {string}
 */
function resultText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) =>
			b?.type === "text" && typeof b.text === "string" ? b.text : "",
		)
		.join("\n");
}

/**
 * A record the person typed — not a tool result, and not the harness's own
 * `isMeta` injection, which is how a Stop hook's feedback arrives.
 * @param {Record<string, any>} record typed as loosely as `mainChainRecords`
 *   yields it — a transcript is an external format this repo does not define.
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
 * Every auto-mode refusal since the last human prompt, oldest first.
 * @param {string} text the transcript
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
 * One content block's refusal, if it is one.
 * @param {Record<string, any>} record as `mainChainRecords` yields it
 * @param {any} block `any`: one entry of that record's `message.content`, an
 *   external format this repo does not define
 * @param {Map<string, {name?: unknown, input?: unknown}>} uses the tool_use
 *   blocks seen so far, by id
 * @returns {Refusal | null}
 */
function refusalOf(record, block, uses) {
	if (block?.type !== "tool_result") return null;
	if (typeof block.tool_use_id !== "string") return null;
	const tagged =
		typeof record.toolDenialKind === "string" &&
		record.toolDenialKind.startsWith("automode-");
	const denial =
		block.is_error === true ? DENIAL.exec(resultText(block.content)) : null;
	if (!tagged && !denial) return null;
	return {
		id: block.tool_use_id,
		call: describeCall(uses.get(block.tool_use_id)),
		reason: denial?.[1]?.trim() || "none given",
	};
}

/**
 * @param {Refusal[]} fresh
 * @returns {string}
 */
function reportFor(fresh) {
	return [
		`THE AUTO-MODE CLASSIFIER REFUSED ${fresh.length === 1 ? "A CALL" : `${fresh.length} CALLS`} THIS TURN, and the turn is ending:`,
		"",
		...fresh.map((r) => `  ${r.call}\n    Reason: ${r.reason}`),
		"",
		ruleParagraph("founder-handover", PARAGRAPH_HEAD),
		"",
		"Before ending the turn, say which applies to each: reached the goal another way (how), dropped it (why), or handing over a `!` line naming what you tried.",
		`Each refused call is shown this once, and this guard costs at most ${hookBlock.MAX_BLOCKS} turns a session.`,
	].join("\n");
}

/**
 * Every path fails open and leaves a breadcrumb (mantahostels#1731, on the house
 * rule at mantahostels#103 §6).
 * @param {{sessionId: string, payload: Payload, root: string,
 *   note: (outcome: string, payload?: Payload) => void}} ctx
 * @returns {boolean} whether a block was emitted
 */
function review({ sessionId: sid, payload, root, note }) {
	const file = sessionTranscript.resolve(payload, sid);
	if (!file) {
		note("no-transcript", payload);
		return false;
	}
	let refusals;
	try {
		const text = sessionTranscript.read(file);
		refusals = refusalsThisTurn(
			text,
			isSubagentTranscript(file) ? "subagent" : "main",
		);
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
				sessionId: sid,
				reason: reportFor(fresh),
			}),
	});
}

if (require.main === module) stopGuard.onPayload({ review, record: true });
