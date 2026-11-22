#!/usr/bin/env node

const fs = require("node:fs");
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

const { readRuleTextOr } = require("./lib/rule-text");
const { caught, orFallback } = require("./lib/caught.js");
const { execGit } = require("./lib/git.js");

function readRoadmapRule() {
	return readRuleTextOr(
		"roadmap-validity",
		"A commit staging the roadmap must leave it structurally valid",
		"check-roadmap-valid",
	).split("\n");
}

/** @typedef {import("./lib/check").Ctx} Ctx */

const HTML = "docs/reference-roadmap.html";
const BASELINE = `HEAD:${HTML}`;

function hostLadder() {
	return { off: !declaresLadder({ quiet: true }), path: ladderPath() };
}
const LADDER_OFF = `${CONFIG_PATH} does not declare "capacityLadder": true, so there is no ladder to re-open`;
const LOG_HEADING = "### Re-assessment log";

const PHASE_GATE = /^validate-p\d+$/;

const git = (/** @type {string[]} */ ...args) =>
	execGit(args, { encoding: "utf8" });

/** @type {import("./lib/check.js").CheckSpec} */
const SPEC = {
	name: "roadmap-valid",
	module: "roadmap",
	usage: "node check-roadmap-valid.js [--tree]",
	flags: ["--tree"],
	run(/** @type {Ctx} */ ctx) {
		if (ctx.has("--tree")) return runTree(ctx);
		return runIndex(ctx);
	},
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);

/**
 * @param {string} message
 */
function unfigured(message) {
	return message.replace(/(?<![\w#-])\d+(?:\.\d+)?(?![\w-])/g, "#");
}

/**
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

function cardStates(/** @type {string} */ html) {
	/** @type {Map<string, string|undefined>} */
	const byId = new Map();
	for (const it of parseRoadmap(html).ITEMS)
		if (it.id) byId.set(it.id, it.state);
	return byId;
}

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
		return null;
	}
	return doneGateIds(stagedHtml).filter(
		(id) => before.has(id) && before.get(id) !== "done",
	);
}

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
	const log = (end === -1 ? rest : rest.slice(0, end)).replace(
		/<!--[\s\S]*?-->/g,
		"",
	);

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
			...readRoadmapRule(),
		],
		okLine: `${HTML} is structurally valid.`,
	});

	if (unrecorded.length > 0 && v.okLine)
		return {
			noun: `unrecorded phase boundar${unrecorded.length === 1 ? "y" : "ies"}`,
			count: unrecorded.length,
		};
	return v;
}

/**
 * @param {Ctx} ctx
 * @returns {{ baseline: string|null, firstRoadmap: boolean }}
 */
function readBaseline(ctx) {
	/** @type {string|null} */
	let baseline = null;
	let firstRoadmap = false;
	try {
		git("rev-parse", "--verify", "--quiet", "HEAD");
	} catch {
		const commits = orFallback(
			() => git("rev-list", "--all", "--count").trim(),
			"1",
		);
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
 * @param {Ctx} ctx
 * @param {{ html: string, baseline: string|null }} at
 * @returns {{ crossed: string[], lines: string[] }}
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

function retiresModule() {
	if (git("ls-files", "--", HTML).trim() !== "") return false;
	try {
		const modules = JSON.parse(git("show", `:${CONFIG_PATH}`)).modules;
		return Array.isArray(modules) && !modules.includes("roadmap");
	} catch {
		return false;
	}
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

	if (retiresModule())
		ctx.skip(
			`this commit deletes ${HTML} and drops the roadmap module from its staged ${CONFIG_PATH} — nothing to validate.`,
		);

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
		ctx.broken(`the staged ${HTML} could not be parsed — ${caught(e).message}`);
	}

	const { added, removed } = result;
	/** @type {string[]} */
	const extra = [];
	if (added.length > 0) extra.push(`  cards added:   ${added.join(", ")}`);
	if (removed.length > 0) extra.push(`  cards removed: ${removed.join(", ")}`);

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
			...readRoadmapRule(),
		],
		okLine: `the staged ${HTML} is structurally valid.`,
	});

	if (crossed.length > 0 && v.okLine)
		return {
			noun: `phase boundar${crossed.length === 1 ? "y" : "ies"} crossed`,
			count: crossed.length,
		};
	return v;
}
