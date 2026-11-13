#!/usr/bin/env node
/*
 * check-unclosed-launches.js — name each open `takes:implement` ticket whose
 * latest refill-loop launch committed and ended without closing it
 * (lib/unclosed-launch.js, workflow-core#3782).
 *
 * Usage:  node scripts/check-unclosed-launches.js [--json]
 *
 * WARN, never FAIL: a ticket here may hold work still to do. A parked ticket is
 * left out: its question is what it waits on. A tracker that will not read, or a
 * damaged state, is a WARN rather than a SKIP or BROKEN, as in
 * check-idle-efforts.js.
 *
 * LOCAL ONLY. It reads the loop's state under ~/.claude, which a stopped loop
 * leaves readable.
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), reads the loop's state and each launch's tracker, and names the tickets above.
 * JUSTIFIED: fail-safe — such a ticket otherwise waits unreported at its rank, as workflow-core#3609 did for three days.
 * DEFEAT:    none needed — it never blocks.
 */

const { runCheck } = require("./lib/check");
const { caught } = require("./lib/caught.js");
const { ghIssueListAll } = require("./lib/gh");
const { PARKED_LABEL } = require("./lib/parked.js");
const { readState } = require("./lib/refill-state.js");
const { readHostTracker } = require("./lib/refill-repos");
const { takesLabel } = require("./lib/takes-label.js");
const { unclosedLaunches } = require("./lib/unclosed-launch.js");

const IMPLEMENT_LABEL = takesLabel("implement");

/**
 * Open issues of `repo` by number.
 * @param {string} repo
 * @returns {Map<number, {number: number, title: string, labels: {name: string}[]}>}
 */
function readOpen(repo) {
	/** @type {{number: number, title: string, labels: {name: string}[]}[]} */
	const issues = ghIssueListAll(`${repo}'s open issues`, [
		"--repo",
		repo,
		"--state",
		"open",
		"--json",
		"number,title,labels",
	]);
	return new Map(issues.map((i) => [i.number, i]));
}

/**
 * `root`'s tracker and its open issues, or null having said why it has none.
 * @param {string} root
 * @param {import("./lib/check").Ctx} ctx
 */
function readTracker(root, ctx) {
	const repo = readHostTracker(root);
	if (!repo) {
		ctx.say(`${root}: no tracker configured, not read.`);
		return null;
	}
	try {
		return { repo, open: readOpen(repo) };
	} catch (err) {
		const line = `${repo}: tracker would not read (${caught(err).message.split("\n")[0]})`;
		ctx.warn("TRACKER-UNREAD", line);
		ctx.say(line);
		return null;
	}
}

const SPEC = {
	name: "check-unclosed-launches",
	usage: "node check-unclosed-launches.js [--json]",
	async run(/** @type {import("./lib/check").Ctx} */ ctx) {
		const { launches } = readState((line) =>
			ctx.warn("REFILL-LOOP-FILE-DAMAGED", line),
		);
		const unclosed = unclosedLaunches(launches);
		const found = [];
		for (const root of new Set(unclosed.map((l) => l.root))) {
			const tracker = readTracker(root, ctx);
			if (!tracker) continue;
			const { repo, open } = tracker;
			for (const l of unclosed.filter((u) => u.root === root)) {
				const [number] = l.issues;
				if (number === undefined)
					throw new Error(`unclosed launch ${l.launchedAt} names no issue`);
				const issue = open.get(number);
				if (!issue) continue;
				const names = issue.labels.map((x) => x.name);
				if (!names.includes(IMPLEMENT_LABEL) || names.includes(PARKED_LABEL))
					continue;
				const at = new Date(l.launchedAt).toISOString().slice(0, 16);
				const text = `${repo}#${issue.number} ${issue.title}: its launch of ${at}Z committed and ended without closing; the loop's next launch checks first whether the work landed.`;
				found.push({ repo, number: issue.number, launchedAt: l.launchedAt });
				ctx.warn("UNCLOSED-LAUNCH", text);
				ctx.say(text);
			}
		}
		return {
			okLine:
				"no open ticket's latest loop launch committed and did not close.",
			noun: "finding(s)",
			data: { unclosed: found },
		};
	},
};

const main = () => runCheck(SPEC);

module.exports = { main };
if (require.main === module) main();
