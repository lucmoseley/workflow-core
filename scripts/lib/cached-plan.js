/*
 * IMPLICIT:  narrows a vitest launch by the per-file pass store (#4790) — the files a recorded pass covers on identical inputs leave the plan or argv, a banner names each — and writes the pass record of a launch whose every file was cached, which spawns nothing.
 */
const fs = require("node:fs");
const path = require("node:path");
const { buildCachedBanner, foldCached, lookup } = require("./pass-store.js");
const { bareWords } = require("./suite-bounded.js");
const { JS_TEST_FILE } = require("./test-kind.js");
const { markerFrom, record, repoRoot } = require("./test-pass-marker.js");
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

/* Selection flags whose argv no lookup narrows: what they select is
 * expanded elsewhere, or not a list of files. */
const UNNAMED = new Set(["--changed", "--adopt", "--retest"]);

/**
 * The launch with every file a recorded pass covers taken out of it. A plan
 * keeps its order and loses those files from `files` and `argv`; a named
 * launch — every bare word an existing test file — loses those words. Any
 * other launch, or one `on` is false for, is looked nothing up: `cached`
 * is then null, which the run's records keep apart from none cached.
 *
 * `banner` is what the launch prints of it: a plan's own banner, with the
 * cached files named after it.
 *
 * `allCached` is a launch whose every file was cached: it must spawn
 * nothing, its argv narrowed to no file reading as the whole suite.
 * @template {Plan} P
 * @param {string[]} argv
 * @param {P|null} plan
 * @param {{ root: string, on: boolean, now?: number,
 *   seams?: Omit<Parameters<typeof lookup>[1], "root"|"storeRoot"> }} options
 * @returns {Looked<P>}
 */
function lookupLaunch(argv, plan, { root, on, now = Date.now(), seams = {} }) {
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
	const found = lookup(files, {
		root,
		storeRoot: repoRoot(root) || null,
		...seams,
	});
	if (found.refused.length > 0) return { ...unlooked, refused: found.refused };
	const looked = { ...unlooked, cached: found.cached, notice: found.notice };
	if (found.cached.length === 0) return looked;
	const hit = new Set(found.cached.map((c) => c.file));
	const banner = buildCachedBanner(found.cached, now);
	const allCached = found.run.length === 0;
	if (!plan)
		return {
			...looked,
			argv: argv.filter((w) => !hit.has(relativeTo(root, w))),
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
 * The repo-relative test files a named launch's bare words are, or null
 * where any word is something else — a filter vitest matches as a
 * substring, a directory, a missing file — or a selection flag expands it.
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
			!f.startsWith("../") &&
			JS_TEST_FILE.test(f) &&
			fs.existsSync(path.join(root, f)),
	)
		? [...new Set(files)]
		: null;
}

/**
 * @param {string} root
 * @param {string} word
 */
const relativeTo = (root, word) =>
	path.relative(root, path.resolve(root, word)).split(path.sep).join("/");

/**
 * The pass record of a launch whose every file a recorded pass covered: the
 * run's certificate as its vitest teardown would have written it, no file
 * run and each cached file folded in, so the push gate reads it as it reads
 * any narrowed run (#4790). Returns whether the record landed.
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
	const roots = ["package.json"];
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
