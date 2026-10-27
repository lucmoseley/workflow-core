/*
 * push-rules.js — guard-push-rules.js's core (#2785): hand a session the push
 * rules BEFORE it pushes (mantahostels#1648, spec mantahostels#1762), and
 * warn, ahead of them, of pushed code no review covers (#1163).
 *
 * INJECTION ONLY — it never denies. No guard enforces any of the four rules
 * it carries: the push cadence is **Advisory** (mantahostels#244,
 * mantahostels#1098; #766), observed at Stop by scripts/guard-unpushed-commits.js,
 * the green-suite warning is **Advisory** (mantahostels#987; #185), and the
 * Vercel build and the CI lag are gotchas.
 *
 * THE IDS ARE NAMED, NOT REQUESTED WHOLESALE. Four clusters share this
 * trigger, and the emission ceiling is per call. Priority order, the recipe
 * first and then what qualifies or explains it, is push-cadence,
 * push-green-suite, vercel-build-on-push, ci-status-lag.
 *
 * NO ID IS PATH-SCOPED, deliberately. A push names refs, not paths. Each is
 * scoped to the HOST instead (#742).
 *
 * WHAT IS A PUSH
 *  - Any working tree of THIS repo, a linked worktree included
 *    (mantahostels#1213).
 *  - A push whose tree the walk CANNOT RESOLVE — `git -C "$W" push` with W
 *    unset — is handed the rules too (#319). Such a push may go to ANOTHER
 *    repo and still spend the session's latch.
 *  - `git push --help` and `git push --dry-run` push nothing: the latch would
 *    spend the injection the real push needed. A ref deletion IS a push and is not filtered.
 *  - Only a segment's own first word is read, so `xargs git push`, `env`,
 *    `sudo`, `timeout 5 git push` and `sh -c "git push"` state nothing
 *    (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/hook-if-bash-matching.md §1).
 *
 * THE REVIEW WARN (#1163) PROTECTS THE PUSHES AFTER THIS ONE. A WARN, NEVER A
 * REFUSAL: the advisory cadence pushes early to share certificates. Said once a
 * session on one latch a tier, so a change that turns escalated after a
 * standard warn is warned again (#1696), and again for each rejected marker
 * written after a warn, which the marker's checksum beside the latches tells
 * apart (#1772, #1840).
 */

const { ruleModule, ruleUnlessModule } = require("./rule-gates.js");
const { parseCommand, walkGit } = require("./shell-parse.js");

/** git push's spellings of a push that pushes nothing; -n is --dry-run. */
const INERT = ["-h", "--help", "-n", "--dry-run"];

const REVIEW_LATCH = "push-review-warn";
const REVIEW_LATCH_ESCALATED = "push-review-warn-escalated";
/* The checksum of the marker the last warn saw, beside the latches. */
const REVIEW_SUM = "sum.push-review-warn";

/**
 * @typedef {import("./push-review.js").ReviewOwed} ReviewOwed
 * @typedef {object} PushPorts
 * @property {string} sessionId the payload's, raw; "" where it has none
 * @property {(tree: string) => ReviewOwed | null} reviewOwed `tree` "" reads
 *   the repo root
 * @property {() => string} markerSum a checksum of the session's review
 *   marker; "" where there is none
 * @property {() => boolean} pushOwesCertificate lib/test-gate.js's push-gate skip
 *   finds a certificate owed, the answer check-test-marker.js warns on
 *   (#758)
 * @property {() => boolean} deploysVercel the host declares a Vercel deploy
 * @property {() => boolean} hasSweep the host runs the scheduled sweep
 *   check-ci-status.js reads
 * @typedef {import("./guard-entry.js").KitContext & PushPorts} PushContext
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
	/* Each rule goes only to a host meeting its premise (#742). With `landing`
	 * on, a push goes to `landing` and the lander tests it, so each text naming
	 * the route is its `-landing` twin (#2409), the CI-lag twin owing no
	 * sweep, and no push owes a certificate, so no green-suite rule goes
	 * (#2929). The suites and landing gates restate test-gate.js's premise
	 * because rule-emission.js budgets off them. */
	return {
		injectRules: [
			"push-cadence",
			"push-cadence-landing",
			"push-green-suite",
			"vercel-build-on-push",
			"ci-status-lag",
			"ci-status-lag-landing",
		],
		skip: [
			...ruleModule(ctx, "suites", ["push-green-suite"]),
			...ruleModule(ctx, "landing", [
				"push-cadence-landing",
				"ci-status-lag-landing",
			]),
			...ruleUnlessModule(ctx, "landing", [
				"push-cadence",
				"push-green-suite",
				"ci-status-lag",
			]),
			...(ctx.pushOwesCertificate() ? [] : ["push-green-suite"]),
			...(ctx.deploysVercel() ? [] : ["vercel-build-on-push"]),
			...(ctx.hasSweep() ? [] : ["ci-status-lag"]),
		],
		...reviewWarn(pushTree, ctx),
	};
}

/**
 * The review warn and its latches, as the injection's prelude; nothing where
 * no warn is owed or this one was already said.
 * @param {string} tree
 * @param {PushContext} ctx
 * @returns {{ prelude?: string, latchAfter?: string,
 *   latchWrites?: { name: string, text: string }[] }}
 */
function reviewWarn(tree, ctx) {
	const markerSum = ctx.markerSum();
	const markerChanged = (ctx.readLatch(REVIEW_SUM) ?? "") !== markerSum;
	const toldEscalated = ctx.told(REVIEW_LATCH_ESCALATED);
	if (toldEscalated && !markerChanged) return {};
	const owed = ctx.reviewOwed(tree);
	if (!owed) return {};
	const rearm = owed.passFault !== "" && markerChanged;
	let latch = null;
	if (owed.tier === "escalated") {
		if (!toldEscalated || rearm) latch = REVIEW_LATCH_ESCALATED;
	} else if (rearm || !ctx.told(REVIEW_LATCH)) latch = REVIEW_LATCH;
	if (!latch) return {};
	return {
		prelude: warnText(owed, ctx.sessionId),
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
	return `${rejected}This push carries code this session changed (${owed.files}) that no code review covers (#1163). ${owed.tierLine} Run the code-review skill with fixed point ${owed.base} now, before pushing again; its closing step runs node ${owed.markerScript}, which writes ${marker}.${owed.markerMore} This warn is said once a session, once more if the change turns escalated, and again for each marker written after a warn that is rejected.`;
}

module.exports = { decide };
