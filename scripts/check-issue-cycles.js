#!/usr/bin/env node

const { runCheck, brokenError, skipError } = require("./lib/check");
const {
	assertOpenRead,
	ghApiSlurp,
	isForbidden,
	isNotFound,
	parseErrLine,
	parseGhFailureReason,
	raiseGhFailure,
	unreachableRemedy,
} = require("./lib/gh");
const { loops, linkText } = require("./lib/wait-graph.js");
const { refLabel } = require("./lib/issue-ref.js");
const { resolveCorpus, resolveKey } = require("./lib/workflow-core-config.js");

const CONCLUSION = "No issue-cycle conclusion drawn.";

/** @typedef {import("./lib/wait-graph.js").Ref} Ref */

/**
 * @param {string} repo
 * @returns {{number: number, pull_request?: unknown}[]}
 */
function readOpen(repo) {
	const read = () =>
		ghApiSlurp([
			`repos/${repo}/issues`,
			"-X",
			"GET",
			"-f",
			"state=open",
			"-f",
			"per_page=100",
		]);
	const rows = read();
	return rows.length > 0 ? rows : assertOpenRead(read(), repo);
}

/**
 * @param {string[]} trackers
 * @returns {{seeds: Ref[], read: string[], hidden: {repo: string, error: string}[]}}
 */
function readSeeds(trackers) {
	/** @type {Ref[]} */
	const seeds = [];
	const read = [];
	const hidden = [];
	for (const repo of trackers) {
		try {
			for (const i of readOpen(repo))
				if (!i.pull_request) seeds.push({ repo, number: i.number });
			read.push(repo);
		} catch (e) {
			if (
				parseGhFailureReason(e) !== "unreachable" &&
				(isNotFound(e) || isForbidden(e))
			)
				hidden.push({ repo, error: parseErrLine(e) });
			else raiseGhFailure(e, CONCLUSION);
		}
	}
	return { seeds, read, hidden };
}

/** @param {Ref[]} members @param {string|null} home */
const tags = (members, home) => members.map((m) => refLabel(m, home));

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {{members: Ref[], path: import("./lib/wait-graph.js").Link[]}[]} cycles
 * @param {string|null} home
 */
function reportCycles(ctx, cycles, home) {
	for (const c of cycles)
		ctx.warn(
			"ISSUE-CYCLE",
			`${tags(c.members, home).join(", ")} wait on each other in a loop`,
			c,
			`ISSUE-CYCLE\t${tags(c.members, home).join(",")}`,
		);
	if (cycles.length === 0) return;
	ctx.say(`ISSUE-CYCLE (${cycles.length}) — none of these issues can close:`);
	for (const c of cycles) {
		ctx.say(`  ${tags(c.members, home).join(", ")}`);
		for (const l of c.path) ctx.say(`    ${linkText(l, home)}`);
	}
	ctx.say(
		"\n  Break the loop at the link that orders nothing. A sub-issue holds its parent open, so work\n" +
			"  ruled not to hold its originator belongs beside it, not under it\n" +
			"  (docs/agents/issue-tracker.md §Placing a new issue).",
	);
	if (cycles.some((c) => c.path.some((l) => l.kind === "gate")))
		ctx.say(
			"  A shipped ticket gated on an adopter's issue closes, leaving the proof to that adopter ticket.",
		);
}

const SPEC = {
	name: "issue-cycles",
	usage: "node check-issue-cycles.js [--warn] [--json]",
	async run(/** @type {import("./lib/check").Ctx} */ ctx) {
		const { trackers } = resolveCorpus({ quiet: true });
		if (trackers.length === 0)
			throw skipError(
				`the corpus resolves no tracker — declare "corpus" or "tracker" in .claude/workflow-core.json. ${CONCLUSION}`,
			);
		const own = resolveKey("tracker");
		const home = typeof own === "string" ? own : (trackers[0] ?? null);

		const { seeds, read, hidden } = readSeeds(trackers);
		for (const h of hidden)
			ctx.say(
				`Not read: ${h.repo} — GitHub would not list its open issues to this token (${h.error}); it is left out of the seeds.`,
			);
		if (read.length === 0)
			throw brokenError(
				`GitHub would list the open issues of none of the ${trackers.length} corpus tracker(s) to this token — check its scopes with \`gh auth status\`. ${CONCLUSION}`,
			);

		const walk = await loops(seeds, { home });
		const lost = walk.unread.find((u) => u.reason === "unreachable");
		if (lost)
			throw skipError(
				`could not read the links of ${refLabel(lost.ref, home)} (${lost.error}).\n      ` +
					`${unreachableRemedy(Object.assign(new Error(lost.error), { stderr: lost.error }))} ${CONCLUSION}`,
			);
		if (walk.unread.length > 0)
			throw brokenError(
				`could not read the links of ${walk.unread.map((u) => `${refLabel(u.ref, home)} (${u.error})`).join(", ")} — an unread node ` +
					`could hide the link that closes a loop. ${CONCLUSION}`,
			);

		const scope = `${seeds.length} open issue(s) across ${read.length} tracker(s)${hidden.length > 0 ? `, ${hidden.length} more not read` : ""}`;
		ctx.say(`Checked ${scope}.\n`);
		reportCycles(ctx, walk.cycles, home);

		const cycles = walk.cycles.map((c) => ({
			members: tags(c.members, home),
			path: c.path.map((l) => linkText(l, home)),
		}));
		return {
			okLine: `no loop among ${scope}, sub-issue, blocked_by and Gated on links read together.`,
			noun: "loop(s) among open issues",
			data: {
				issues: seeds.length,
				trackers: read,
				hidden: hidden.map((h) => h.repo),
				cycles,
				cycleCount: cycles.length,
			},
		};
	},
};

const main = () => runCheck(SPEC);

module.exports = { main };
if (require.main === module) main();
