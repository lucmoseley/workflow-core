/*
 * retro-bundles.js — which frontier issues /pick-next launches together as one
 * `/triage` session — the open retro-sweep findings, at most 8 to a session
 * (workflow-core#1105; the cap and the bundling ruled at workflow-core#1093 Q1 (D)) — and the model and
 * prompt each bundle launches with (workflow-core#1195).
 *
 * WHY 8: the workflow-core#1093 test bundle of 8 findings peaked at 131,725 tokens of
 * context, about 16k a finding, so a bundle crosses the 200,000 notice near
 * 12. The pick-next and retro-sweep SKILL.md files quote it.
 *
 * POOLED ACROSS RUNS, NOT KEYED ON ONE: a finding names its run only in free
 * prose, and a leftover from last week's run costs a session of its own if
 * kept apart. A run alone on the frontier still yields ceil(N/8) bundles.
 *
 * A finding is an issue labelled `takes:triage` and nothing else, whose body
 * carries the `Standalone:` line retro-sweep step 5 files it with. Every
 * other `takes:triage` issue launches singly, as before.
 */

const RETRO_BUNDLE_CAP = 8;
const RETRO_MARK = /^Standalone: retro-sweep finding\b/m;

/* A copy of launch-models.sh's `triage` row, which owns it, kept so pick-next.js
 * spawns no bash; launch-models.test.ts fails where the two differ (workflow-core#1195). */
const RETRO_BUNDLE_MODEL = "opus";

/* The vendored /triage skill has no bundle rule, so the launched session reads
 * this or nothing (workflow-core#1195). No digit: dispatch-ledger.js reads every integer in
 * a prompt as an issue number. */
const RETRO_BUNDLE_CLAUSE =
	"one decision, one round comment and one brief per issue";

/**
 * A bundle's §7 launch prompt.
 * @param {number[]} bundle
 */
const buildBundlePrompt = (bundle) =>
	`/triage ${bundle.join(" ")} — ${RETRO_BUNDLE_CLAUSE}`;

/** @typedef {{issues: number[], model: string, prompt: string}} RetroLaunch */

/**
 * Each bundle as pick-next's text and JSON both carry it, so a reader of either
 * launches the same prompt (workflow-core#1206).
 * @param {number[][]} bundles
 * @returns {RetroLaunch[]}
 */
const retroLaunches = (bundles) =>
	bundles.map((issues) => ({
		issues,
		model: RETRO_BUNDLE_MODEL,
		prompt: buildBundlePrompt(issues),
	}));

/** @param {{takes: string[], body: string}} issue */
const isRetroFinding = (issue) =>
	issue.takes.length === 1 &&
	issue.takes[0] === "triage" &&
	RETRO_MARK.test(issue.body);

/**
 * The fewest bundles of at most the cap, balanced so no two differ by more than
 * one member, each in filing order: 9 findings make 5 + 4, not 8 + 1.
 * @param {{number: number, takes: string[], body: string}[]} frontier
 * @returns {number[][]}
 */
function retroBundles(frontier) {
	const found = frontier
		.filter(isRetroFinding)
		.map((i) => i.number)
		.sort((a, b) => a - b);
	const count = Math.ceil(found.length / RETRO_BUNDLE_CAP);
	const bundles = [];
	for (let k = 0, from = 0; k < count; k++) {
		const size = Math.ceil((found.length - from) / (count - k));
		bundles.push(found.slice(from, from + size));
		from += size;
	}
	return bundles;
}

module.exports = {
	RETRO_BUNDLE_CAP,
	RETRO_BUNDLE_MODEL,
	retroBundles,
	retroLaunches,
};
