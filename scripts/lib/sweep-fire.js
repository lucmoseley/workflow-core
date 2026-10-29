/*
 * sweep-fire.js — the dispatcher core that puts a hand-fired sweep on the same
 * daily budget the automatic one already spends (mantahostels#2202, ruled at
 * mantahostels#2188).
 *
 * THE HOLE IT CLOSES. `scripts/check-ci-status.js` fires a sweep for itself when
 * the newest verdict has gone stale (mantahostels#1816), bounded at three a day
 * against the `.sweep-autofire` marker in the git common dir. A session typing
 * `gh workflow run scheduled-checks.yml` spent nothing at all.
 *
 * `ci.yml` IS THE SAME SPEND (mantahostels#3514): it runs the same `Full
 * suite` a scheduled-checks fire runs, so a second counter for it would be a
 * second three. A `ci.yml` run buys check-ci-status.js no verdict — it reads
 * scheduled-checks runs alone.
 *
 * ONE BUDGET, THREE A DAY, SPENT BY EVERY ROUTE. Three of one, three of another
 * or any mix exhausts the day. The counter is `scripts/lib/sweep-budget.js`,
 * which the autofire also reads and writes, so the two arithmetics cannot
 * drift: the spend is lib/sweep-fire-host.js's port over that module.
 *
 * A DENY, NOT A WARN (mantahostels#2188 Q4).
 *
 * NO EXEMPTION FOR SCHEDULE REPAIR (mantahostels#2188 Q3). A fire made while the
 * ledger shows a missed slot spends the cap like any other. The autofire
 * already covers the stale-verdict-plus-moved-HEAD condition a dropped slot
 * produces, inside this same budget, so an exemption would double-count it,
 * and the miss rate would make it near-universal.
 *
 * WHAT IT CANNOT SEE — four routes, because a Bash `PreToolUse` hook reads the
 * command string it is handed and nothing else: the GitHub web UI, `gh api …
 * /dispatches`, a fire from inside a script, and the founder's own terminal.
 * The deny names them, from docs/agents/rules/sweep-fire-budget.txt.
 *
 * AN UNMATCHED SPELLING FIRES AND SPENDS NOTHING, so the matcher is
 * deliberately generous about spelling: the binary by BASENAME
 * (`/usr/bin/gh`), after a wrapper unwrap strips (`env VAR=x`, `nohup`,
 * `timeout 60`, …), past `gh`'s own global flags (`gh -R owner/repo workflow
 * run …`) — both lib/shell-words.js's ghWords (#772) — and with the workflow
 * argument read through literal, so a quoted `"scheduled-checks.yml"` counts.
 *
 * THE DISPLAY NAME IS MATCHED TOO (mantahostels#3514's review): `gh workflow
 * run` accepts it, and `ci.yml`'s is `CI`. THE NUMERIC ID STAYS UNMATCHED:
 * nothing in this repo prints it.
 *
 * A `--help` is excluded the other way: it prints usage and dispatches nothing,
 * so spending a unit on one would be a refusal bought with no sweep.
 *
 * FAILS OPEN on a budget it cannot count — a marker that will not read, a git
 * that will not name a common dir, a budget module that will not load — logged
 * (mantahostels#103 §6). The one exception is the rule fragment: a budget that
 * IS out still denies when docs/agents/rules/sweep-fire-budget.txt will not
 * read, the deny naming the file instead (mantahostels#3128). No pre-emptive
 * rule injection, unlike the sibling guards: route (f)'s Bash cap sits within
 * 30 B of full (docs/doc-map.md §Capture and placement §3), so the rule reaches
 * a session on the deny alone.
 *
 * IMPLICIT: it SPENDS one unit of the day's sweep budget on every matching
 *   command it allows, writing the shared `.sweep-autofire` marker in the git
 *   common dir before the command runs.
 * JUSTIFIED: fail-safe — the spend has to happen before the dispatch or a fire
 *   that hangs, 403s or is denied downstream leaves the budget unspent and the
 *   day uncapped — the same trade check-ci-status.js makes when it writes the
 *   marker before its own dispatch. The cost is that an abandoned command
 *   still costs a unit, of three.
 * DEFEAT: the four routes above are all outside this hook, so any of them
 *   fires a sweep without spending anything; listing `guard-sweep-fire` under
 *   the host's `disabled` silences it.
 */

const { parseCommand, unmask, walkCommands } = require("./shell-parse.js");
const { ghWords, literal, scanFlags } = require("./shell-words.js");
const { ruleOrFallback } = require("./guard-verdict.js");
const { trimEndRun } = require("./trim-run.js");

/**
 * @typedef {import("./guard-dispatch.js").CoreContext} CoreContext
 * @typedef {import("./guard-entry.js").Decision} Decision
 * @typedef {import("./sweep-fire-host.js").Spend} Spend
 */

const SWEEP_WORKFLOWS = [
	"scheduled-checks.yml",
	"scheduled-checks",
	"ci.yml",
	"CI",
];

/* `gh workflow run`'s flags that TAKE A VALUE. Without them `--ref main`
 * leaves `main` looking like the workflow argument, and the sweep in
 * `gh workflow run --ref main scheduled-checks.yml` goes uncounted. */
const GH_VALUE_FLAGS = "--ref -r --field -F --raw-field -f --input --repo -R";

/**
 * Whether one command fires a sweep workflow: `gh workflow run <file>`, the
 * file as typed or as a path ending in it. Flags may sit either side of it,
 * so the workflow is the first true positional — anything after it is `gh`'s
 * own extra argument and never a second workflow.
 * @param {string[]} words
 * @param {string[]} spans
 */
function firesSweep(words, spans) {
	const gh = ghWords(words, spans);
	if (!gh) return false;
	const read = (/** @type {string | undefined} */ w) =>
		literal(w ?? "", spans).text;
	if (read(gh.args[0]) !== "workflow" || read(gh.args[1]) !== "run")
		return false;
	let named = false;
	let seen = false;
	scanFlags(GH_VALUE_FLAGS, gh.args.slice(2), (kind, _name, value) => {
		if (kind !== "arg" || seen) return;
		seen = true;
		/* Through literal, not the raw word: the parser masks every quoted span,
		 * so `"scheduled-checks.yml"` would compare equal to nothing. A word it
		 * cannot read is an expansion, which cannot be this filename. */
		const lit = literal(value, spans);
		if (!lit.known) return;
		named = SWEEP_WORKFLOWS.some(
			(wf) => lit.text === wf || lit.text.endsWith(`/${wf}`),
		);
	});
	return named;
}

/**
 * @param {{ spent: number, cap: number, day: string }} spend the day it is out
 * @param {string} segment
 * @param {CoreContext & { spendSweep: (now: string | undefined) => Spend }} ctx
 */
function refusal({ spent, cap, day }, segment, ctx) {
	const rule = ruleOrFallback(
		ctx,
		"sweep-fire-budget",
		"A hand-fired sweep spends the same three-a-day budget the autofire spends",
	);
	return ctx.corePaths(
		`Today's sweep budget is gone: ${spent} of ${cap} already fired on ${day} (UTC), so the next unit is available on the day after ${day}.\n\n${rule}\n\nThe command: ${trimEndRun(unmask(segment), "\n")}`,
	);
}

/**
 * Spend a unit for every sweep the command fires, in order; refuse the first
 * the day has no unit left for.
 * @param {string} command
 * @param {CoreContext & { spendSweep: (now: string | undefined) => Spend }} ctx
 * @returns {Decision}
 */
function decide(command, ctx) {
	const parsed = parseCommand(command);
	/** @type {Decision} */
	let verdict = null;
	walkCommands(
		parsed,
		(cmd) => {
			if (verdict || !firesSweep(cmd.words, parsed.spans)) return;
			// clock-kept: the spend port's own parse, a bad pin a fault (mantahostels#2209)
			const spend = ctx.spendSweep(ctx.env.WFC_NOW);
			if ("fault" in spend) {
				/* A budget that cannot be counted refuses nothing (mantahostels#103 §6). */
				ctx.log(
					`the sweep budget could not be counted (${spend.fault}) — a hand-fired sweep allowed uncounted`,
				);
				return;
			}
			if (spend.out) verdict = { deny: refusal(spend, cmd.segment, ctx) };
		},
		ctx,
	);
	return verdict;
}

module.exports = { field: "command", noun: "command", decide };
