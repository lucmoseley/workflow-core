/*
 * review-rules.js — the dispatcher core that hands a session the code-review
 * rules when it loads the code-review skill, rather than at the prompt that
 * started the session (#2792; mantahostels#3451, applying mantahostels#3421's
 * nearest-trigger ruling).
 *
 * It injects, and denies one call only: a bare `code-review` in a project with
 * no `.claude/skills/code-review/` of its own (#1165). The rules bind the
 * review's dispatch and its disposition, both of which happen after the skill
 * loads, so the one-call lag route (f) carries (docs/doc-map.md §Capture and
 * placement §3, step 3) lands them before the first decision they bind rather
 * than after it.
 *
 * IMPLICIT: on a Skill call naming `code-review` it injects the six review
 *   rules and this session's two review-axis Artefact paths as
 *   additionalContext, and the kit writes a `.rule-injected-*` latch file per
 *   rule under .claude/tmp/markers. In an adopter it denies the bare name
 *   instead, naming `workflow-core:code-review`.
 * JUSTIFIED: fail-safe — the vendored skill cannot carry project rules, and a
 *   rule handed to a session reaches it far more often than one it must fetch
 *   (mantahostels#2501).
 * DEFEAT: `scripts/clear-rule-latch.sh` clears the latch and the rules are
 *   said again; `guard-review-rules` in `.claude/workflow-core.json`'s
 *   `disabled` silences them. Any `.claude/skills/code-review/SKILL.md` in an
 *   adopter lifts the deny.
 *
 * THE ARTEFACT PATHS RIDE IN THE PRELUDE because a fragment is static and the
 * paths are not: each carries the first 8 characters of the session id, so two
 * concurrent reviews land on different files (mantahostels#2220). A subagent's
 * Write expands no environment variable (mantahostels#2088), so the literal
 * path has to be in the text. The base path is machine-specific, so it rides
 * there too; the four standards fragments name it as "the standards base named
 * above" (#965).
 *
 * LIMITS
 *  - It fires on the Skill TOOL only. A `/code-review` the founder types is
 *    expanded without one, which is why scripts/inject-tracker-docs.sh keeps
 *    its /code-review arm: for that session the prompt is the nearest event. A
 *    review run by hand, with no skill loaded, is told nothing here;
 *    scripts/concision-backstop.sh's Stop nag restates the dispatch shape.
 *  - The plugin skill `code-review:code-review` reviews a pull request and is
 *    a different skill, so it is not matched.
 *  - The rules are stated ONCE PER SESSION, by the kit's latch, so a second
 *    review in the same session is not told again.
 *  - `review-dispatch-shape` points at the type and paths in the prelude, so
 *    it reads right only in the prelude's envelope. The prelude and six
 *    fragments fit RULE_CAP whatever the checkout's path (#1729); grow them
 *    past it and a deferred fragment arrives on a later call without the
 *    paths. An adopter's base path, in its plugin cache, still counts, along
 *    with its longer subagent type and qualified citations: review-rules.test.ts
 *    measures the envelope at the longest one on the founder's machine
 *    (#1882). The sensitive-path tier rides in its own core,
 *    lib/review-tier.js, for that reason.
 *  - The kit's store side refuses on a fragment it cannot read
 *    (mantahostels#1762); a throw here refuses too, the row failing closed.
 */

const { reviewSuffix } = require("./review-suffix.js");

const PRELUDE_LATCH = "review-rules-prelude";

/* The project's own code-review skill, which shadows the built-in. */
const LOCAL_SKILL = ".claude/skills/code-review";

const BUILT_IN = `A bare \`code-review\` here is the harness's built-in reviewer, not workflow-core's: this project carries no code-review skill of its own (no \`SKILL.md\` under \`.claude/skills/code-review/\`). The built-in diffs only \`@{upstream}...HEAD\`, never your fixed point, and writes neither review-axis Artefact. Call the Skill tool with \`workflow-core:code-review\` instead, same fixed point (#1165).`;

/**
 * @typedef {import("./guard-dispatch.js").CoreContext
 *   & ReturnType<typeof import("./review-rules-host.js").buildHostPorts>} ReviewRulesContext
 */

/**
 * A PLUGIN SKILL ARRIVES NAMESPACED (#201): in an adopter this call is
 * `workflow-core:code-review`. `code-review:code-review` is Anthropic's own
 * pull-request plugin, a different skill, excluded BEFORE the namespaced arm
 * rather than by narrowing that arm — a plugin may name itself anything, and
 * only this one collision is known. lib/last30days.js matches the same way.
 * @param {string} skill
 */
const ours = (skill) =>
	skill !== "code-review:code-review" &&
	(skill === "code-review" || skill.endsWith(":code-review"));

/**
 * The prelude: the type and paths the fragments point at.
 * @param {ReviewRulesContext} ctx
 * @param {import("./review-rules-host.js").ReviewStandards} standards
 */
function prelude(ctx, standards) {
	/* An absent session id leaves the bare names, reinstating
	 * mantahostels#2220's collision in that one case rather than injecting
	 * nothing. */
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
	/* A BARE NAME IN AN ADOPTER IS THE HARNESS'S BUILT-IN REVIEWER (#1165).
	 * Only a project carrying its own code-review skill shadows it; injecting
	 * into the built-in hands the plugin's rules to a skill that never reads
	 * them. Refused before the latch, so the namespaced retry is still told. */
	if (
		skill === "code-review" &&
		!ctx.isFile(`${ctx.root}/${LOCAL_SKILL}/SKILL.md`)
	)
		return { deny: BUILT_IN };
	/* lib/script-path.js's coreRoot(): WFC_SCRIPT_ROOT, a test seam, over the
	 * root this core was installed under. */
	const standards = ctx.reviewStandards(
		ctx.env.WFC_SCRIPT_ROOT || ctx.installRoot,
	);
	/** @type {{ prelude?: string, latchAfter?: string }} */
	let lead = {};
	if (!ctx.told(PRELUDE_LATCH)) {
		lead = { prelude: prelude(ctx, standards), latchAfter: PRELUDE_LATCH };
		/* Inside the latch, so a review is logged once rather than per call. */
		if (standards.missingBase)
			ctx.log(standards.missingBase.what, standards.missingBase.detail);
	}
	/* Priority order: the deviations record is owed before the dispatch, and
	 * the dispatch shape before what each axis is handed. One literal per
	 * branch: lib/rule-emission.js and check-guard-registry.js read them. */
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
