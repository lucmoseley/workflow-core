const { execFileSync } = require("node:child_process");
const path = require("node:path");
const {
	DEFAULT_SUITE,
	gitReader,
	holdsTestByTree,
	readFailures,
	readMarkers,
	EVIDENCE_NOT_LICENCE,
	FLAKE_NOTE,
	shortSha,
	suiteOf,
} = require("./test-pass-marker.js");
const { GIT_TIMEOUT_MS } = require("./git.js");
const { caught } = require("./caught.js");
const { relativeUnder } = require("./is-under.js");
const { heldAtSha } = require("./pass-store.js");

// guess, workflow-core#5529
const MAX_WALKED = 100;

const WORKTREE = /^\.claude\/worktrees\/[^/]+\//;

/**
 * @typedef {import("./test-pass-marker.js").Marker} Marker
 * @typedef {{sha: string, at: string|null}} RedOnBase
 * @typedef {{file: string, red: RedOnBase|null}} Classified
 * @typedef {{m: Marker, red: boolean}} Evidence
 * @typedef {{reds: Marker[], certificates: Marker[], storeRoot?: string|null}} OnRecord
 * @typedef {{base: string|null, files: Classified[], allAlreadyRed: boolean}} Classing
 */

/**
 * @param {string} file
 * @param {string} root
 */
function toRepoPath(file, root) {
	if (!path.isAbsolute(file)) return file;
	const rel = relativeUnder(root, file);
	return rel === null
		? file
		: rel.split(path.sep).join("/").replace(WORKTREE, "");
}

/**
 * @param {Marker} run
 * @param {OnRecord} evidence
 * @param {{root: string, execFn?: typeof execFileSync}} options
 * @returns {Classing|null}
 */
function classifyFailures(run, { reds, certificates, storeRoot }, options) {
	const failing = (run.scope?.failures ?? []).map((f) =>
		toRepoPath(f.file, options.root),
	);
	if (failing.length === 0) return null;
	const base = run.base ?? null;
	if (!base) return { base, files: [], allAlreadyRed: false };
	const gitOpts = {
		root: options.root,
		execFn: options.execFn ?? boundedExec,
		cache: new Map(),
	};
	const isBefore = (/** @type {Marker} */ m) =>
		String(m.at ?? "") < String(run.at ?? "");
	/** @type {Evidence[]} */
	const newestFirst = [
		...reds.map((m) => ({ m, red: true })),
		...certificates.map((m) => ({ m, red: false })),
	]
		.filter(({ m }) => suiteOf(m) === DEFAULT_SUITE && isBefore(m))
		.sort((a, b) => String(b.m.at ?? "").localeCompare(String(a.m.at ?? "")));

	const rows = heldAtSha(failing, {
		storeRoot: storeRoot ?? null,
		sha: base,
		before: String(run.at ?? ""),
		git: gitReader(gitOpts).git,
	});

	/** @type {Classified[]} */
	const files = failing.map((file) => {
		const held = newestFirst
			.filter(({ m, red }) => (red ? hasFailed : hasRun)(m, file, options.root))
			.slice(0, MAX_WALKED)
			.find(({ m }) => holdsTestByTree(m, file, base, gitOpts));
		const newest = newerOf(
			held ? { sha: held.m.sha, at: held.m.at ?? null, red: held.red } : null,
			rows.get(file) ?? null,
		);
		return {
			file,
			red: newest?.red ? { sha: newest.sha, at: newest.at } : null,
		};
	});
	return { base, files, allAlreadyRed: files.every((f) => f.red !== null) };
}

/**
 * @typedef {{sha: string, at: string|null, red: boolean}} Held
 * @param {Held|null} a
 * @param {Held|null} b
 * @returns {Held|null}
 */
function newerOf(a, b) {
	if (!a || !b) return a ?? b;
	return String(b.at ?? "") > String(a.at ?? "") ? b : a;
}

/**
 * @param {Marker} m
 * @param {string} test
 * @param {string} root
 */
const hasFailed = (m, test, root) =>
	(m.scope?.failures ?? []).some((f) => toRepoPath(f.file, root) === test);

/**
 * @param {Marker} m
 * @param {string} test
 */
const hasRun = (m, test) =>
	m.closure === "*" || (m.selected ?? []).includes(test);

/** @type {typeof execFileSync} */
const boundedExec = /** @type {typeof execFileSync} */ (
	(file, args, opts) =>
		execFileSync(file, args, { ...opts, timeout: GIT_TIMEOUT_MS })
);

/**
 * @param {string} root
 * @returns {OnRecord}
 */
const readRedEvidence = (root) => ({
	reds: readFailures({ root }),
	certificates: readMarkers({ root }),
	storeRoot: root,
});

/**
 * @param {Marker} run
 * @param {string} root
 * @returns {string[]}
 */
function readAlreadyRedLines(run, root) {
	try {
		return buildAlreadyRedLines(
			classifyFailures(run, readRedEvidence(root), { root }),
		);
	} catch (e) {
		return [
			`  Whether these failures were already red on the base went unread (workflow-core#3624): ${caught(e).message ?? e}`,
		];
	}
}

const ALL_ALREADY_RED =
	"  Every failure here was already red on the base, so no rerun is owed to attribute them";

/**
 * @param {Classing|null} classed
 * @returns {string[]}
 */
function buildAlreadyRedLines(classed) {
	if (!classed) return [];
	if (!classed.base)
		return [
			"  This run recorded no base, so no failure could be checked against one (workflow-core#3624).",
		];
	return [
		...buildAlreadyRedFileLines(classed),
		...(classed.allAlreadyRed
			? [`${ALL_ALREADY_RED} — ${EVIDENCE_NOT_LICENCE}: ${FLAKE_NOTE}.`]
			: [
					"  NEW — no record shows these red on the base:",
					...classed.files
						.filter((f) => !f.red)
						.map(({ file }) => `    ${file}`),
				]),
	];
}

/**
 * @param {Classing} classed
 * @returns {string[]}
 */
function buildAlreadyRedFileLines(classed) {
	if (!classed.base) return [];
	const already = classed.files.flatMap(({ file, red }) =>
		red
			? [
					`    ${file} — by the red store's run at ${shortSha(red.sha)}${red.at ? `, ${red.at}` : ""}`,
				]
			: [],
	);
	return already.length > 0
		? [
				`  ALREADY RED on the base ${shortSha(classed.base)} (workflow-core#3624):`,
				...already,
			]
		: [];
}

module.exports = {
	ALL_ALREADY_RED,
	buildAlreadyRedFileLines,
	classifyFailures,
	readAlreadyRedLines,
	readRedEvidence,
};
