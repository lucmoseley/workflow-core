const { parseCommand, walkGit } = require("./shell-parse.js");

const INERT = ["-h", "--help", "-n", "--dry-run"];

const REVIEW_LATCH = "push-review-warn";
const REVIEW_LATCH_ESCALATED = "push-review-warn-escalated";
const REVIEW_SUM = "sum.push-review-warn";

/**
 * @typedef {import("./push-review.js").ReviewOwed} ReviewOwed
 * @typedef {object} PushPorts
 * @property {(tree: string, session: string) => ReviewOwed | null} reviewOwed
 * @property {(session: string) => string} markerSum
 * @property {() => boolean} deploysVercel
 * @typedef {import("./kit-context.js").KitContext & PushPorts & {
 *   session: string,
 *   tree: () => Pick<import("./guard-host-ports.js").TreePorts, "root"> }} PushContext
 */

/**
 * @param {string} command
 * @param {PushContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	let pushed = false;
	let pushTree = "";
	walkGit(
		parseCommand(command),
		({ tree, args }) => {
			if (args.some((a) => INERT.includes(a))) return;
			pushed = true;
			pushTree ||= tree;
		},
		ctx,
		{ subs: ["push"], noun: "push", scope: "repo", strict: true },
	);
	if (!pushed) return null;
	return {
		injectRules: ["push-cadence", "vercel-build-on-push", "ci-status-lag"],
		skip: [...(ctx.deploysVercel() ? [] : ["vercel-build-on-push"])],
		...reviewWarn(pushTree, ctx),
	};
}

/**
 * @param {string} tree
 * @param {PushContext} ctx
 * @returns {{ prelude?: string, latchAfter?: string,
 *   latchWrites?: { name: string, text: string }[] }}
 */
function reviewWarn(tree, ctx) {
	const markerSum = ctx.markerSum(ctx.session);
	const markerChanged = (ctx.readLatch(REVIEW_SUM) ?? "") !== markerSum;
	const toldEscalated = ctx.told(REVIEW_LATCH_ESCALATED);
	if (toldEscalated && !markerChanged) return {};
	const owed = ctx.reviewOwed(tree || ctx.tree().root, ctx.session);
	if (!owed) return {};
	const rearm = owed.passFault !== "" && markerChanged;
	let latch = null;
	if (owed.tier === "escalated") {
		if (!toldEscalated || rearm) latch = REVIEW_LATCH_ESCALATED;
	} else if (rearm || !ctx.told(REVIEW_LATCH)) latch = REVIEW_LATCH;
	if (!latch) return {};
	return {
		prelude: warnText(owed, ctx.session),
		latchAfter: latch,
		latchWrites: [{ name: REVIEW_SUM, text: markerSum }],
	};
}

/**
 * @param {ReviewOwed} owed
 * @param {string} sid
 */
function warnText(owed, sid) {
	const marker = `.claude/tmp/markers/.codereview-pass-${sid}`;
	const rejected = owed.passFault
		? `The marker ${marker} was rejected — ${owed.passFault} — so it counts as no review. `
		: "";
	return `${rejected}This push carries code this session changed (${owed.files}) that no code review covers (workflow-core#1163). ${owed.tierLine} Run the code-review skill with fixed point ${owed.base} now, before pushing again; its closing step runs node ${owed.markerScript}, which writes ${marker}.${owed.markerMore} This warn is said once a session, once more if the change turns escalated, and again for each marker written after a warn that is rejected.`;
}

module.exports = { field: "command", noun: "command", decide };
