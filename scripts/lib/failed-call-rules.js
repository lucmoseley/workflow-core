/*
 * failed-call-rules.js — guard-failed-call-rules.js's core (#2026): after a call fails in one of two known ways, which rule the
 * session is handed.
 *
 *   PostToolUseFailure, Bash, exit 137 or 143 — `rule:silent-kill`.
 *   PostToolBatch, a `Skill` result refused for `disable-model-invocation` —
 *     `rule:skill-refused`.
 *
 * A CORE: it does no I/O. The rule store arrives as a port.
 */

const { caught } = require("./caught.js");

const REFUSAL = "due to disable-model-invocation";
const KILLED = /(^|\n)Exit code (137|143)(\n|$)/;

/**
 * @typedef {object} FailedCallPorts
 * @property {Record<string, unknown>} payload the hook payload
 * @typedef {import("./kit-context.js").KitContext & FailedCallPorts} FailedCallContext
 */

/**
 * A tool result as text, whether a string or content blocks.
 * @param {unknown} response
 */
const asText = (response) =>
	typeof response === "string" ? response : JSON.stringify(response ?? "");

/** @param {Record<string, unknown>} payload */
function isKilledBash(payload) {
	const error = typeof payload.error === "string" ? payload.error : "";
	return (
		payload.tool_name === "Bash" && !payload.is_interrupt && KILLED.test(error)
	);
}

/** @param {Record<string, unknown>} payload */
function isRefusedSkill(payload) {
	const calls = Array.isArray(payload.tool_calls) ? payload.tool_calls : [];
	return calls.some(
		(c) =>
			c?.tool_name === "Skill" && asText(c.tool_response).includes(REFUSAL),
	);
}

/* Each rule's id is spelt literally in its call: check-guard-registry.js
 * finds a rule's emitter by that spelling. */
/** @type {Record<string, { hit: (payload: Record<string, unknown>) => boolean, rule: (ctx: FailedCallContext) => string }>} */
const LIMBS = {
	PostToolUseFailure: {
		hit: isKilledBash,
		rule: (ctx) => ctx.ruleText("silent-kill"),
	},
	PostToolBatch: {
		hit: isRefusedSkill,
		rule: (ctx) => ctx.ruleText("skill-refused"),
	},
};

/**
 * @param {string} event the payload's hook_event_name
 * @param {FailedCallContext} ctx
 * @returns {{ context: string } | null}
 */
function decide(event, ctx) {
	const limb = Object.hasOwn(LIMBS, event) ? LIMBS[event] : undefined;
	if (!limb?.hit(ctx.payload)) return null;
	let text = "";
	let why = "empty";
	try {
		text = limb.rule(ctx);
	} catch (e) {
		/* Fails open, logged (mantahostels#103 §6). */
		why = caught(e).message;
	}
	if (!text) {
		ctx.log(`rule fragment unreadable — a ${event} rule went unsaid`, why);
		return null;
	}
	return { context: text };
}

module.exports = { decide };
