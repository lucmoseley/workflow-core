#!/usr/bin/env node
/*
 * check-issue-cycles.js — reports a set of open issues that wait on each other
 * in a loop, so that none of them can ever close (#495), in any tracker
 * (#5070).
 *
 * TWO KINDS OF LINK, READ TOGETHER, ACROSS REPOS. An issue waits on its open
 * blockers, and a parent on its open sub-issues; lib/wait-graph.js reads both.
 * The seeds are every open issue in each tracker the host's corpus resolves
 * to (lib/workflow-core-config.js resolveCorpus); the walk follows links from
 * them into any repo they reach, so a loop through a repo outside the corpus
 * is still found.
 *
 * A loop is a strongly connected component of that graph, so it is reported
 * once however many members it has, with one example path naming each link.
 *
 * FAILS CLOSED ON A PARTIAL READ. One unread node could hide the link that
 * closes a loop, so any read failing twice is BROKEN, never OK — save a corpus
 * tracker whose open-issue list answers not-found or forbidden, which is
 * named on its own line and left out of the seeds, so a token that cannot see
 * one tracker still checks the rest (#5086); where it can see none, that is
 * BROKEN, since an OK over no tracker would be a false clean.
 *
 * WARN, never FAIL: world state, not a commit property. THIS SCRIPT NEVER
 * WRITES — which link is wrong is a judgement about the tickets. The link
 * commands (lib/link-writer.js) refuse a new loop when it is written; this
 * check is the backstop for a link made any other way.
 *
 * Usage: node check-issue-cycles.js [--warn] [--json]
 */

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
 * One tracker's open issues and pull requests, an empty answer re-read once
 * and then held to the repo's own count, as lib/gh.js ghOpenIssues reads the
 * default repo's.
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
 * Each tracker's open issues as seeds, and the trackers whose list GitHub
 * would not show this token.
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

		const scope = `${seeds.length} open issue(s) across ${read.length} tracker(s)${hidden.length > 0 ? ` (${hidden.length} not read)` : ""}`;
		ctx.say(`Checked ${scope}.\n`);
		reportCycles(ctx, walk.cycles, home);

		const cycles = walk.cycles.map((c) => ({
			members: tags(c.members, home),
			path: c.path.map((l) => linkText(l, home)),
		}));
		return {
			okLine: `no loop among ${scope}, sub-issue and blocked_by links read together.`,
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
