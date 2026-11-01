#!/usr/bin/env node
/*
 * check-unclosed-launches.js — name each open `takes:implement` ticket whose
 * latest refill-loop launch committed and ended without closing it (#3782). Its
 * session may have finished and died before its close; the loop's next launch
 * of it checks first (lib/unclosed-launch.js), so this says what is waiting on
 * that launch, at whatever rank.
 *
 * Usage:  node scripts/check-unclosed-launches.js [--json]
 *
 * WARN, never FAIL: a ticket here may hold work still to do. A parked ticket is
 * left out: its question is what it waits on. A tracker that will not read is
 * its own line, never "none".
 *
 * LOCAL ONLY. It reads the loop's state under ~/.claude; a stopped loop's state
 * still reads, so a stop does not hide a stranded ticket.
 *
 * IMPLICIT:  on `npm run status` (scripts/status-report.js), reads the loop's state and each launch's tracker, and names the tickets above.
 * JUSTIFIED: fail-safe — such a ticket otherwise waits unreported at its rank, as #3609 did for three days.
 * DEFEAT:    none needed — it never blocks.
 */

const { runCheck } = require("./lib/check");
const { caught } = require("./lib/caught.js");
const { ghAsync } = require("./lib/gh");
const { PARKED_LABEL } = require("./lib/parked.js");
const { loopFiles, readJson } = require("./lib/refill-files.js");
const { parseState } = require("./lib/refill-loop.js");
const { readHostTracker } = require("./lib/refill-repos");
const { unclosedLaunches } = require("./lib/unclosed-launch.js");

const IMPLEMENT_LABEL = "takes:implement";
const OPEN_LIMIT = "1000";

/**
 * Open issues of `repo` by number.
 * @param {string} repo
 * @returns {Promise<Map<number, {number: number, title: string, labels: {name: string}[]}>>}
 */
async function readOpen(repo) {
	const out = await ghAsync([
		"issue",
		"list",
		"--repo",
		repo,
		"--state",
		"open",
		"--limit",
		OPEN_LIMIT,
		"--json",
		"number,title,labels",
	]);
	return new Map(
		JSON.parse(out).map(
			(
				/** @type {{number: number, title: string, labels: {name: string}[]}} */ i,
			) => [i.number, i],
		),
	);
}

const SPEC = {
	name: "check-unclosed-launches",
	usage: "node check-unclosed-launches.js [--json]",
	async run(/** @type {import("./lib/check").Ctx} */ ctx) {
		const { launches } = parseState(
			readJson(loopFiles().state, (line) =>
				ctx.warn("REFILL-LOOP-FILE-DAMAGED", line),
			),
		);
		const unclosed = unclosedLaunches(launches);
		const found = [];
		for (const root of new Set(unclosed.map((l) => l.root))) {
			const repo = readHostTracker(root);
			if (!repo) continue;
			let open;
			try {
				open = await readOpen(repo);
			} catch (err) {
				const line = `${repo}: tracker would not read (${caught(err).message.split("\n")[0]})`;
				ctx.warn("TRACKER-UNREAD", line);
				ctx.say(line);
				continue;
			}
			for (const l of unclosed.filter((u) => u.root === root)) {
				const issue = open.get(l.issues[0]);
				const names = issue?.labels.map((x) => x.name) ?? [];
				if (!names.includes(IMPLEMENT_LABEL) || names.includes(PARKED_LABEL))
					continue;
				const at = new Date(l.launchedAt).toISOString().slice(0, 16);
				const text = `${repo}#${issue?.number} ${issue?.title}: its launch of ${at}Z committed and ended without closing; the loop's next launch checks first whether the work landed.`;
				found.push({ repo, number: issue?.number, launchedAt: l.launchedAt });
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
