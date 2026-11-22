const fs = require("node:fs");
const path = require("node:path");
const { buildCachedBanner, foldCached, lookup } = require("./pass-store.js");
const { bareWords } = require("./suite-bounded.js");
const { JS_TEST_FILE } = require("./test-kind.js");
const { relativeUnder } = require("./is-under.js");
const {
	CLOSURE_ROOTS,
	markerFrom,
	record,
	repoRoot,
} = require("./test-pass-marker.js");
const { readTreeSnapshot, endOfRunTreeIdentity } = require("./tree-drift.js");

/**
 * @typedef {import("./pass-store.js").Cached} Cached
 * @typedef {{ argv: string[], files: string[], banner: string,
 *   admissible?: boolean, changed?: string[]|null }} Plan
 */
/**
 * @template {Plan} P
 * @typedef {{ argv: string[], plan: P|null, cached: Cached[]|null,
 *   refused: string[], allCached: boolean, banner: string,
 *   notice: string|null }} Looked
 */

const UNNAMED = new Set(["--changed", "--adopt", "--retest"]);

/**
 * @template {Plan} P
 * @param {string[]} argv
 * @param {P|null} plan
 * @param {{ root: string, on: boolean }} options
 * @returns {Looked<P>}
 */
function lookupLaunch(argv, plan, { root, on }) {
	/** @type {Looked<P>} */
	const unlooked = {
		argv,
		plan,
		cached: null,
		refused: [],
		allCached: false,
		banner: plan ? plan.banner : "",
		notice: null,
	};
	if (!on) return unlooked;
	const files = plan ? plan.files : namedTestFiles(argv, root);
	if (!files || files.length === 0) return unlooked;
	const found = lookup(files, { root, storeRoot: repoRoot(root) || null });
	if (found.refused.length > 0) return { ...unlooked, refused: found.refused };
	const looked = { ...unlooked, cached: found.cached, notice: found.notice };
	if (found.cached.length === 0) return looked;
	const hit = new Set(found.cached.map((c) => c.file));
	const banner = buildCachedBanner(found.cached, Date.now());
	const allCached = found.run.length === 0;
	if (!plan)
		return {
			...looked,
			argv: argv.filter((w) => !hit.has(relativeTo(root, w) ?? "")),
			allCached,
			banner,
		};
	return {
		...looked,
		plan: {
			...plan,
			files: found.run,
			argv: plan.argv.filter((w) => !hit.has(w)),
			banner: `${plan.banner}${banner}`,
		},
		allCached,
		banner: `${plan.banner}${banner}`,
	};
}

/**
 * @param {string[]} argv
 * @param {string} root
 * @returns {string[]|null}
 */
function namedTestFiles(argv, root) {
	if (argv.some((w) => UNNAMED.has(w) || w.startsWith("--changed=")))
		return null;
	const words = bareWords(argv);
	if (words.length === 0) return null;
	const files = words.map((w) => relativeTo(root, w));
	return files.every(
		(f) =>
			f !== null && JS_TEST_FILE.test(f) && fs.existsSync(path.join(root, f)),
	)
		? [...new Set(/** @type {string[]} */ (files))]
		: null;
}

/**
 * @param {string} root
 * @param {string} word
 * @returns {string|null}
 */
const relativeTo = (root, word) =>
	relativeUnder(root, path.resolve(root, word))?.split(path.sep).join("/") ??
	null;

/**
 * @param {Cached[]} cached
 * @param {{ root: string, launch: Partial<import("./suite-handoff.js").Launch>,
 *   changedPaths: string[]|null, base: string|null, startedAtMs: number,
 *   sessionId?: string|null }} run
 * @returns {boolean}
 */
function recordAllCached(
	cached,
	{ root, launch, changedPaths, base, startedAtMs, sessionId },
) {
	const snapshot = readTreeSnapshot(root);
	if (!snapshot) return false;
	const roots = [...CLOSURE_ROOTS];
	const marker = markerFrom(snapshot, snapshot, null, {
		scope: {
			modulesRun: 0,
			modulesTotal: cached.length,
			tests: 0,
			skipped: 0,
			nameFilter: null,
			fileFilters: [],
			changed: null,
			...(launch.admissible ? { admissible: true } : {}),
			...(launch.viaChanged ? { viaChanged: true } : {}),
			...(launch.touched ? { touched: true } : {}),
			...(launch.leftOut ? { leftOut: launch.leftOut } : {}),
			...(launch.touchedBase ? { touchedBase: launch.touchedBase } : {}),
			resolvedFiles: 0,
		},
		startedAtMs,
		elapsedMs: Date.now() - startedAtMs,
		isolated: launch.isolated === true,
		treeAtEnd: endOfRunTreeIdentity(root),
		argv: launch.argv ?? null,
		...(sessionId === undefined ? {} : { sessionId }),
		attestation: foldCached(
			{
				closure: roots,
				selected: [],
				changedPaths,
				base,
				imports: {},
				roots,
			},
			cached,
		),
	});
	return record(marker, { root: repoRoot(root) });
}

module.exports = { lookupLaunch, recordAllCached };
