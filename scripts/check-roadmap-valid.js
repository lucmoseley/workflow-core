#!/usr/bin/env node
/*
 * check-roadmap-valid.js — is the roadmap structurally valid?
 *
 * Usage:
 *   node check-roadmap-valid.js          (npm run check:roadmap)
 *   node check-roadmap-valid.js --tree   (npm run check:roadmap:tree)
 *
 * INDEX MODE (default) is the commit gate `.husky/pre-commit` runs. It judges
 * the commit's INDEX, which a pathspec commit fills: run by hand outside a
 * commit it SKIPs, having nothing to look at.
 *
 * TREE MODE (--tree) judges the roadmap as it stands in the WORKING TREE, with
 * no parent to compare against. It is for the scheduled `Document guards` job,
 * which has no commit in flight and so nothing for index mode to look at
 * (mantahostels#974).
 *
 * It calls validateRoadmap() in-process rather than shelling out to that
 * validator's CLI, so the gate and the command line can never disagree about
 * what "valid" means (mantahostels#696, which split the function out).
 *
 * Severity mapping (mantahostels#697):
 *
 *   any validator ERROR                        FAIL,   exit 1
 *   any validator WARNING                      WARN,   exit 0
 *   a validate-pN card newly done              WARN,   exit 0 (mantahostels#1130)
 *   a done validate-pN card the ladder's log
 *     does not name (tree mode only)            WARN,   exit 0 (mantahostels#1377)
 *   either of the two above, unless the host
 *     declares `"capacityLadder": true`         a named skip line, no finding (#401, #748)
 *   cards added or removed                     reported only, no finding
 *   roadmap/baseline/index unreadable          BROKEN, exit 2
 *   roadmap not staged in this commit          SKIP,   exit 0
 *
 * Tree mode maps the same way minus every row that needs a baseline — the
 * newly-done row, the added/removed list — minus SKIP, the roadmap being
 * present in every checkout, and minus STAMP MISDATED: an unedited roadmap's
 * stamp is rightly the day of its last edit (#1602). So a misdated stamp
 * landed past the pre-commit gate, or left by an edit tree mode is run
 * straight after, goes unreported here. Unreadable or unparseable is BROKEN, on
 * check.js's APPARATUS limb — "fs will not read a tracked file".
 *
 * KNOWN RESIDUAL: a merge that deletes or mangles the roadmap reports as exit
 * 2, "the checker cannot do its job", rather than as a finding about the
 * roadmap. Read a BROKEN here as a roadmap verdict, not only a broken checker.
 *
 * The phase boundary is checked TWICE, on different questions (mantahostels#1377). Index
 * mode asks "did THIS commit flip a gate card", which only a commit running the
 * pre-commit hook can be asked — an auto-resolving merge and a --no-verify
 * commit run none. Tree mode asks the durable question instead: does any
 * `validate-pN` card read `done` without the ladder's `### Re-assessment log`
 * naming it? The ladder is `capacityLadderPath` in `.claude/workflow-core.json`,
 * default `docs/capacity-procurement-ladder.md` (#401).
 * It needs no baseline, so it survives the commit passing, and it stops on its
 * own once that log line lands.
 *
 *
 * THE RULE IT PRINTS lives in docs/agents/rules/roadmap-validity.txt, not here
 * (mantahostels#1649, spec mantahostels#1641): CLAUDE.md keeps a trigger line naming the id, and the
 * FAIL advice splices the fragment in. An unreadable fragment does NOT make this
 * a BROKEN run — the roadmap verdict is sound whatever the store says, so
 * roadmapRule() prints a pointer instead. check-guard-registry.js owns the
 * assertion that the fragment exists and that a wired guard prints it.
 * KNOWN RESIDUAL: the log line is what silences it, so a line naming the card
 * without the re-assessment behind it silences it just as well.
 *
 * WARNINGs never gate: SCHEMA DRIFT and VERSION TRIPWIRE are
 * advisory by design and "version unchanged" is normal mid-loop, so gating on
 * them would redden correct work.
 *
 * The added/removed list never gates either. /card-close treats a non-empty list
 * as a refusal because it only ever changes one existing card; a commit gate
 * cannot assume that, because a roadmap-edit run adding a card is ordinary
 * work.
 *
 * Index mode reads the git INDEX, not the working tree: the staged blob against
 * HEAD's. Reading the tree would let a parallel session's half-saved roadmap
 * fail an unrelated commit and leave that session no legal move (mantahostels#179, mantahostels#298).
 * Tree mode over a shared working tree can still report a neighbour's
 * half-saved roadmap — a false alarm it costs nothing to re-run, not a blocked
 * session.
 */

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const {
	validateRoadmap,
	parseRoadmap,
} = require("../.claude/skills/roadmap-edit/scripts/validate.js");
const { runCheck } = require("./lib/check");
const {
	declaresLadder,
	ladderPath,
	CONFIG_PATH,
} = require("./lib/workflow-core-config");

const { ruleTextOr } = require("./lib/rule-text");
const { CHILD_MAX_BUFFER } = require("./lib/child-buffer.js");
const { caught } = require("./lib/caught.js");

/*
 * The rule this checker prints (mantahostels#1649, spec mantahostels#1641). Operative text in
 * docs/agents/rules/roadmap-validity.txt; CLAUDE.md keeps a trigger line only,
 * so this failure is where the rule reaches a session.
 *
 * ruleText throws on an unreadable store, and a throw here would report BROKEN
 * — "the checker cannot do its job" — over a fault that has nothing to do with
 * the roadmap. So ruleTextOr answers a pointer instead: the roadmap verdict
 * stands either way, and an unreadable fragment is check-guard-registry.js's
 * assertion rather than this checker's.
 */
function roadmapRule() {
	return ruleTextOr(
		"roadmap-validity",
		"A commit staging the roadmap must leave it structurally valid.",
		"check-roadmap-valid",
	).split("\n");
}

/** @typedef {import("./lib/check").CheckContext} Ctx */

const HTML = "docs/reference-roadmap.html";
const BASELINE = `HEAD:${HTML}`;

/* Where a crossed boundary is recorded as answered (mantahostels#1377) — or
 * `off` where the host keeps no ladder (#401, #748). */
function hostLadder() {
	return { off: !declaresLadder({ quiet: true }), path: ladderPath() };
}
const LADDER_OFF = `${CONFIG_PATH} does not declare "capacityLadder": true, so there is no ladder to re-open`;
const LOG_HEADING = "### Re-assessment log";

/* A phase-validation card. One going `done` is the roadmap's only
 * machine-readable phase boundary, and a boundary re-opens the agent-spend
 * ladder (mantahostels#1130; docs/capacity-procurement-ladder.md §Re-assessment). */
const PHASE_GATE = /^validate-p\d+$/;

const git = (/** @type {string[]} */ ...args) =>
	execFileSync("git", args, { encoding: "utf8", maxBuffer: CHILD_MAX_BUFFER });

runCheck({
	name: "roadmap-valid",
	module: "roadmap",
	usage: "node check-roadmap-valid.js [--tree]",
	flags: ["--tree"],
	run(/** @type {Ctx} */ ctx) {
		if (ctx.has("--tree")) return runTree(ctx);
		return runIndex(ctx);
	},
});

/**
 * A validator message as a finding's key: the message is all the identity
 * validateRoadmap returns, so its free-standing numbers — a word count, a
 * callout length, minutes of clock drift — are masked (#1591). Residual: a
 * reworded message, or a date in one, still rekeys it.
 * @param {string} message
 */
function unfigured(message) {
	return message.replace(/(?<![\w#-])\d+(?:\.\d+)?(?![\w-])/g, "#");
}

/**
 * Everything the two modes must say identically: the header line, the findings
 * in warning-then-error order, the severities, and the record check.js turns
 * into an outcome.
 *
 * What legitimately differs between the two modes is passed in.
 *
 * @param {Ctx} ctx
 * @param {ReturnType<typeof validateRoadmap>} result
 * @param {{
 *   label: string,
 *   advice: string[],
 *   okLine: string,
 *   extra?: string[],
 * }} spec
 */
function verdict(ctx, result, { label, advice, okLine, extra = [] }) {
	const { errors, warnings, version, cardCount } = result;

	ctx.say(
		`${label}: ${version ? version.raw : "version NOT FOUND"}, ${cardCount} cards`,
	);
	for (const line of extra) ctx.say(line);

	for (const w of warnings) {
		ctx.warn(
			"ROADMAP-WARNING",
			w,
			undefined,
			`ROADMAP-WARNING\t${unfigured(w)}`,
		);
		ctx.say(`  ⚠ ${w}`);
	}
	for (const e of errors) {
		ctx.fail("ROADMAP-ERROR", e, undefined, `ROADMAP-ERROR\t${unfigured(e)}`);
		ctx.say(`  ✗ ${e}`);
	}

	if (errors.length > 0) {
		ctx.say("");
		for (const line of advice) ctx.say(line);
		return { noun: "roadmap error(s)" };
	}
	if (warnings.length > 0) return { noun: "roadmap warning(s)" };
	return { okLine };
}

/**
 * Which `validate-pN` cards read `done` in the staged roadmap without reading
 * `done` in the baseline — the commit that crosses a phase boundary.
 *
 * Returns null where the baseline cannot be parsed — never an empty list, which
 * the caller could not tell from "no boundary crossed". The caller prints the
 * skip: a silent one leaves the boundary check dead for good on an `OK:` run.
 */
function cardStates(/** @type {string} */ html) {
	/* The value is optional because a card may carry no state at all — which
	 * `validate.js` reports as an error and this reader must not assume away. */
	/** @type {Map<string, string|undefined>} */
	const byId = new Map();
	for (const it of parseRoadmap(html).ITEMS)
		if (it.id) byId.set(it.id, it.state);
	return byId;
}

/** Every `validate-pN` card reading `done` in one roadmap, sorted. */
function doneGateIds(/** @type {string} */ html) {
	/** @type {string[]} */
	const ids = [];
	for (const [id, state] of cardStates(html))
		if (PHASE_GATE.test(id) && state === "done") ids.push(id);
	return ids.sort();
}

/**
 * @param {string} stagedHtml
 * @param {string} baselineHtml
 */
function newlyDonePhaseGates(stagedHtml, baselineHtml) {
	let before;
	try {
		before = cardStates(baselineHtml);
	} catch {
		// Fails OPEN, and says so at the call site (mantahostels#1130). With no baseline to
		// compare against, every gate card already reading `done` would look
		// newly done.
		return null;
	}
	// The staged blob is already known to parse: validateRoadmap threw otherwise.
	// `before.has(id)` is what makes this a FLIP rather than a state: a gate card
	// added already `done` — a restructure, a rename — crossed no boundary.
	return doneGateIds(stagedHtml).filter(
		(id) => before.has(id) && before.get(id) !== "done",
	);
}

/**
 * Which `validate-pN` cards read `done` in this roadmap without the ladder's
 * Re-assessment log naming them — a boundary crossed and never answered.
 *
 * Asked of the roadmap as it stands rather than of a diff, so it survives the
 * commit that crossed the boundary (mantahostels#1377).
 *
 * Fails CLOSED where the log cannot be read: unlike the index-mode baseline,
 * an unreadable ladder is itself the thing worth saying.
 *
 * Reads a STATE where index mode reads a FLIP, so the two disagree on one case:
 * a gate card that arrives already `done` — a rename, a restructure — crossed
 * no boundary, and index mode stays quiet about it while this reports it until
 * the log names it. Inherent: with no baseline there is nothing to tell the two
 * apart.
 */
/**
 * @param {string} html
 * @param {{off: boolean, path: string}} ladder
 */
function unrecordedPhaseGates(html, ladder) {
	const done = doneGateIds(html);
	if (done.length === 0) return { ids: [], note: null };

	if (ladder.off)
		return {
			ids: [],
			note: `phase-boundary log check SKIPPED for ${done.join(", ")} — ${LADDER_OFF}.`,
		};

	/** @type {string} */
	let md;
	try {
		md = fs.readFileSync(ladder.path, "utf8");
	} catch (e) {
		return {
			ids: done,
			note: `${ladder.path} could not be read — ${caught(e).message} — so nothing here can show a re-assessment happened.`,
		};
	}

	const at = md.indexOf(LOG_HEADING);
	if (at === -1)
		return {
			ids: done,
			note: `${ladder.path} has no “${LOG_HEADING}” heading, so nothing here can show a re-assessment happened.`,
		};

	const rest = md.slice(at + LOG_HEADING.length);
	const end = rest.search(/^#{1,6} /m);
	// Comments stripped so an example line in the section's own comment cannot
	// read as a record.
	const log = (end === -1 ? rest : rest.slice(0, end)).replace(
		/<!--[\s\S]*?-->/g,
		"",
	);

	// Bounded rather than a substring test: `validate-p10` must not read as a
	// record of `validate-p1`.
	const ids = done.filter(
		(id) => !new RegExp(`(?<![\\w-])${id}(?![\\w-])`).test(log),
	);
	return { ids, note: null };
}

/** @param {Ctx} ctx */
function runTree(ctx) {
	let html;
	try {
		html = fs.readFileSync(HTML, "utf8");
	} catch (e) {
		ctx.broken(
			`cannot read ${HTML} in the working tree — ${caught(e).message}`,
		);
	}

	let result;
	try {
		result = validateRoadmap(html, null, { judgeStampDay: false });
	} catch (e) {
		ctx.broken(`${HTML} could not be parsed — ${caught(e).message}`);
	}

	const ladder = hostLadder();
	const { ids: unrecorded, note } = unrecordedPhaseGates(html, ladder);
	/** @type {string[]} */
	const extra = [];
	if (note) extra.push(`  ⚠ ${note}`);
	// Warned AND said: ctx.warn alone prints no human line.
	for (const id of unrecorded) {
		const msg = `${id} reads done and ${ladder.path}'s ${LOG_HEADING} does not name it — a phase boundary re-opens the agent-spend ladder, and this one has no record of being answered. Read that file's §Re-assessment, do the four reads it names, and add a dated log line naming ${id} verbatim, even where nothing has moved.`;
		ctx.warn(
			"PHASE-BOUNDARY-UNRECORDED",
			msg,
			undefined,
			`PHASE-BOUNDARY-UNRECORDED\t${id}`,
		);
		extra.push(`  ⚠ ${msg}`);
	}

	const v = verdict(ctx, result, {
		label: HTML,
		extra,
		advice: [
			`${HTML} is structurally invalid in this checkout. Fix the cards above.`,
			"",
			...roadmapRule(),
		],
		okLine: `${HTML} is structurally valid.`,
	});

	// Only relabel an otherwise-clean run, so a structural error keeps its own
	// summary.
	if (unrecorded.length > 0 && v.okLine)
		return {
			noun: `unrecorded phase boundar${unrecorded.length === 1 ? "y" : "ies"}`,
			count: unrecorded.length,
		};
	return v;
}

/**
 * The HEAD roadmap to judge the staged one against, or null where this is the
 * repo's first roadmap.
 * @param {Ctx} ctx
 * @returns {{ baseline: string|null, firstRoadmap: boolean }}
 */
function readBaseline(ctx) {
	// Unreadable is BROKEN here rather than the ERROR the validator raises for
	// its own caller-supplied baseline: that one can be a typo'd path, this one
	// is HEAD, so its absence means the repo is not in the shape assumed. The
	// one exception is a HEAD that holds no roadmap yet: the commit adding a
	// repo's first roadmap has nothing to compare against, so it is judged as
	// --tree judges, with no baseline (#3). Residual: any other `cat-file -e`
	// failure on a readable HEAD reads as a first roadmap too, and skips the
	// baseline comparison rather than going BROKEN.
	/** @type {string|null} */
	let baseline = null;
	let firstRoadmap = false;
	/* A repo with NO COMMIT AT ALL has no HEAD to read, and its first commit is
	 * the one an adopter's bootstrap must land green (#5) — the same
	 * no-baseline judgement as a HEAD holding no roadmap yet.
	 *
	 * UNBORN, NOT MERELY UNREADABLE. `rev-list --all` counts every commit the
	 * repo has by any ref, so a HEAD that exists and does not resolve — a
	 * symbolic ref to a deleted branch, a corrupt object — still falls through
	 * to the BROKEN below rather than passing as a first commit. */
	try {
		git("rev-parse", "--verify", "--quiet", "HEAD");
	} catch {
		let commits = "1";
		try {
			commits = git("rev-list", "--all", "--count").trim();
		} catch {
			/* not a repo at all — the diff --cached above has already BROKEN */
		}
		if (commits === "0") firstRoadmap = true;
		else
			ctx.broken(
				`HEAD does not resolve in a repository that holds ${commits} commit(s) — a symbolic ref to a deleted branch, or a corrupt object. Nothing here can be compared against a baseline.`,
			);
	}
	if (!firstRoadmap) {
		try {
			try {
				git("cat-file", "-e", BASELINE);
			} catch {
				firstRoadmap = true;
			}
			if (!firstRoadmap) baseline = git("show", BASELINE);
		} catch (e) {
			ctx.broken(`cannot read the ${BASELINE} baseline — ${caught(e).message}`);
		}
	}
	return { baseline, firstRoadmap };
}

/**
 * Warn on each validate-pN card the staged roadmap newly marks done.
 * @param {Ctx} ctx
 * @param {{ html: string, baseline: string|null }} at
 * @returns {{ crossed: string[], lines: string[] }} the ids warned on, and
 *   the lines to print for them
 */
function warnNewlyDoneGates(ctx, { html, baseline }) {
	/** @type {string[]} */
	const extra = [];
	const gates = baseline === null ? [] : newlyDonePhaseGates(html, baseline);
	if (gates === null)
		extra.push(
			`  ⚠ phase-boundary check SKIPPED — ${BASELINE} did not parse as a roadmap, so a validate-pN card going done would go unreported here (mantahostels#1130).`,
		);
	const ladder = hostLadder();
	if (ladder.off && gates && gates.length > 0)
		extra.push(
			`  phase-boundary warning SKIPPED for ${gates.join(", ")} — ${LADDER_OFF}.`,
		);
	const crossed = ladder.off ? [] : gates || [];
	for (const id of crossed) {
		const msg = `${id} is newly done — a phase boundary re-opens the agent-spend ladder. This commit is fine; the work is afterwards. Read ${ladder.path} §Re-assessment, do the four reads it names, and add a dated line to its Re-assessment log naming ${id} verbatim, even where nothing has moved — that name is what stops --tree reporting this boundary for good.`;
		ctx.warn("PHASE-BOUNDARY", msg, undefined, `PHASE-BOUNDARY\t${id}`);
		extra.push(`  ⚠ ${msg}`);
	}
	return { crossed, lines: extra };
}

/** @param {Ctx} ctx */
function runIndex(ctx) {
	let staged;
	try {
		staged = git("diff", "--cached", "--name-only", "--no-renames")
			.split("\n")
			.filter(Boolean);
	} catch (e) {
		ctx.broken(`cannot read the git index — ${caught(e).message}`);
	}

	if (!staged.includes(HTML))
		ctx.skip(`${HTML} is not staged — nothing to validate.`);

	let html;
	try {
		html = git("show", `:${HTML}`);
	} catch (e) {
		ctx.broken(`cannot read the staged ${HTML} — ${caught(e).message}`);
	}

	const { baseline, firstRoadmap } = readBaseline(ctx);

	let result;
	try {
		result = validateRoadmap(html, baseline, { originalLabel: BASELINE });
	} catch (e) {
		// Unparseable input is the checker being unable to do its job, not a
		// finding about the roadmap (lib/check.js's SUBJECT vs APPARATUS split).
		ctx.broken(`the staged ${HTML} could not be parsed — ${caught(e).message}`);
	}

	const { added, removed } = result;
	/** @type {string[]} */
	const extra = [];
	if (added.length > 0) extra.push(`  cards added:   ${added.join(", ")}`);
	if (removed.length > 0) extra.push(`  cards removed: ${removed.join(", ")}`);

	// Warned AND said: ctx.warn alone prints no human line.
	if (firstRoadmap)
		extra.push(
			`  first roadmap commit — ${BASELINE} does not exist, so no card was compared against a baseline.`,
		);
	const gated = warnNewlyDoneGates(ctx, { html, baseline });
	extra.push(...gated.lines);
	const { crossed } = gated;

	const v = verdict(ctx, result, {
		label: `staged ${HTML}`,
		extra,
		advice: [
			"The staged roadmap is structurally invalid. Fix the cards above.",
			"",
			...roadmapRule(),
		],
		okLine: `the staged ${HTML} is structurally valid.`,
	});

	// Only relabel an otherwise-clean run, so a structural error keeps its own
	// summary.
	if (crossed.length > 0 && v.okLine)
		return {
			noun: `phase boundar${crossed.length === 1 ? "y" : "ies"} crossed`,
			count: crossed.length,
		};
	return v;
}
