const RETRO_BUNDLE_CAP = 8;
const RETRO_MARK = /^Standalone: retro-sweep finding\b/m;

const RETRO_BUNDLE_MODEL = "opus";

const RETRO_BUNDLE_CLAUSE =
	"one decision, one round comment and one brief per issue";

/** @param {number[]} bundle */
const buildBundlePrompt = (bundle) =>
	`/triage ${bundle.join(" ")} — ${RETRO_BUNDLE_CLAUSE}`;

/** @typedef {{issues: number[], model: string, prompt: string}} RetroLaunch */

/**
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
	retroBundles,
	retroLaunches,
};
