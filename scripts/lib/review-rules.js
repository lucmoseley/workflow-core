const { reviewSuffix } = require("./review-suffix.js");

const PRELUDE_LATCH = "review-rules-prelude";

const LOCAL_SKILL = ".claude/skills/code-review";

const BUILT_IN = `A bare \`code-review\` here is the harness's built-in reviewer, not workflow-core's: this project carries no code-review skill of its own (no \`SKILL.md\` under \`.claude/skills/code-review/\`). The built-in diffs only \`@{upstream}...HEAD\`, never your fixed point, and writes neither review-axis Artefact. Call the Skill tool with \`workflow-core:code-review\` instead, same fixed point (workflow-core#1165).`;

/**
 * @typedef {import("./core-contract.js").CoreContext
 *   & ReturnType<typeof import("./review-rules-host.js").buildHostPorts>} ReviewRulesContext
 */

/** @param {string} skill */
const ours = (skill) =>
	skill !== "code-review:code-review" &&
	(skill === "code-review" || skill.endsWith(":code-review"));

/**
 * @param {ReviewRulesContext} ctx
 * @param {import("./review-rules-host.js").ReviewStandards} standards
 */
function prelude(ctx, standards) {
	const suffix = ctx.session ? reviewSuffix(ctx.session) : "";
	return `Rules for the code-review you are loading. This session's review subagent type: \`${ctx.reviewAgentType()}\`. Its two review-axis Artefact paths: \`.claude/tmp/review-standards${suffix}.md\` and \`.claude/tmp/review-spec${suffix}.md\`. Its standards base: \`${standards.baseShown}\`.${standards.glossaryLine}`;
}

/**
 * @param {string} skill
 * @param {ReviewRulesContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(skill, ctx) {
	if (!ours(skill)) return null;
	if (
		skill === "code-review" &&
		!ctx.isFile(`${ctx.root}/${LOCAL_SKILL}/SKILL.md`)
	)
		return { deny: BUILT_IN };
	const standards = ctx.reviewStandards(
		ctx.env.WFC_SCRIPT_ROOT || ctx.installRoot,
	);
	/** @type {{ prelude?: string, latchAfter?: string }} */
	let lead = {};
	if (!ctx.told(PRELUDE_LATCH)) {
		lead = { prelude: prelude(ctx, standards), latchAfter: PRELUDE_LATCH };
		if (standards.missingBase)
			ctx.log(standards.missingBase.what, standards.missingBase.detail);
	}
	if (standards.state === "base")
		return {
			...lead,
			injectRules: [
				"review-deviations-write",
				"review-dispatch-shape",
				"review-standards-axis-base",
				"review-deviations-read",
				"review-finding-destination",
				"review-ultra-axis",
			],
		};
	if (standards.state === "local")
		return {
			...lead,
			injectRules: [
				"review-deviations-write",
				"review-dispatch-shape",
				"review-standards-axis-local",
				"review-deviations-read",
				"review-finding-destination",
				"review-ultra-axis",
			],
		};
	if (standards.state === "neither")
		return {
			...lead,
			injectRules: [
				"review-deviations-write",
				"review-dispatch-shape",
				"review-standards-axis-absent",
				"review-deviations-read",
				"review-finding-destination",
				"review-ultra-axis",
			],
		};
	return {
		...lead,
		injectRules: [
			"review-deviations-write",
			"review-dispatch-shape",
			"review-standards-axis",
			"review-deviations-read",
			"review-finding-destination",
			"review-ultra-axis",
		],
	};
}

module.exports = { field: "skill", noun: "skill call", decide };
