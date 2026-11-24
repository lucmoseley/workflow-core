const { caught } = require("./caught.js");

const REFUSAL = "due to disable-model-invocation";
const KILLED = /(^|\n)Exit code (137|143)(\n|$)/;

/**
 * @typedef {object} FailedCallPorts
 * @property {Record<string, unknown>} payload
 * @typedef {import("./kit-context.js").KitContext & FailedCallPorts} FailedCallContext
 */

/** @param {unknown} response */
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
 * @param {string} event
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
		why = caught(e).message;
	}
	if (!text) {
		ctx.log(`rule fragment unreadable — a ${event} rule went unsaid`, why);
		return null;
	}
	return { context: text };
}

module.exports = { decide };
