/*
 * already-red.js — which of a red run's failing files were already red on
 * the base its launch recorded (#3624); `readRunBase` in run-vitest.js says
 * which route records which base.
 *
 * THE EVIDENCE IS WHAT IS ALREADY ON RECORD, never a run of its own:
 * - the red store's earlier runs, any session's, and the certificate store's,
 *   each judged at the base BY CONTENT (`holdsTestByTree`): the tree the run
 *   read against the base's, never the sha stamped on it, so a red its own
 *   uncommitted files caused is no evidence about the base. The newest that
 *   holds decides;
 * - where none holds, the lander's base check, the tip's red files run at the
 *   base `main` held (lib/lander.js `onMain`), at that sha alone. It decides
 *   only then because its heartbeat dates the beat, not the check, so it
 *   cannot be ranked against the stores.
 *
 * EVIDENCE, NEVER A LICENCE (lib/session-verdict.js): already red says the
 * file failed at the base's content, not that the session's diff leaves it
 * unbroken.
 */

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const {
	DEFAULT_SUITE,
	holdsTestByTree,
	readFailures,
	readMarkers,
	EVIDENCE_NOT_LICENCE,
	FLAKE_NOTE,
	shortSha,
	suiteOf,
} = require("./test-pass-marker.js");
const { GIT_TIMEOUT_MS } = require("./git.js");
const { landerFiles, readHeartbeat } = require("./lander.js");
const { caught } = require("./caught.js");

/* Untraced: how many runs naming a failing file are judged, newest first. */
const MAX_WALKED = 100;

/* An isolated run's worktree, whose paths are the checkout's under it. */
const WORKTREE = /^\.claude\/worktrees\/[^/]+\//;

/**
 * @typedef {import("./test-pass-marker.js").Marker} Marker
 * @typedef {{sha: string, at: string|null, by: "red store"|"lander"}} RedOnBase
 * @typedef {{file: string, red: RedOnBase|null}} Classified
 * @typedef {{sha: string, files: string[]}} LanderBaseCheck the lander's
 *   base check that came back red, and the base it ran at
 * @typedef {{m: Marker, red: boolean}} Evidence a run on record
 * @typedef {{reds: Marker[], certificates: Marker[], lander: LanderBaseCheck|null}} OnRecord
 *   the evidence on record, as `readRedEvidence` reads it
 * @typedef {{base: string|null, files: Classified[], allAlreadyRed: boolean}} Classing
 *   `allAlreadyRed` where the run recorded a base and every failure is already red on it
 */

/**
 * The repo-relative path of a recorded failing file, an isolated worktree's
 * included; one outside the checkout as it stands.
 * @param {string} file
 * @param {string} root
 */
function toRepoPath(file, root) {
	if (!path.isAbsolute(file)) return file;
	const rel = path.relative(root, file).split(path.sep).join("/");
	return rel.startsWith("..") ? file : rel.replace(WORKTREE, "");
}

/**
 * Each of `run`'s failing files, with the newest record that it was red at
 * the run's base; null where no record holds there or a certificate is newer.
 * Null overall where the run carries no failure to class. The one
 * classification the run summary and the unasked-rerun guard
 * (lib/unasked-rerun-io.js) both read (#3633).
 *
 * @param {Marker} run the red run, as the red store records it
 * @param {OnRecord} evidence
 * @param {{root: string, execFn?: typeof execFileSync}} options
 * @returns {Classing|null}
 */
function classifyFailures(run, { reds, certificates, lander }, options) {
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
	/* Evidence the run had: its own line and any later one are no prior record. */
	const isBefore = (/** @type {Marker} */ m) =>
		String(m.at ?? "") < String(run.at ?? "");
	/** @type {Evidence[]} */
	const newestFirst = [
		...reds.map((m) => ({ m, red: true })),
		...certificates.map((m) => ({ m, red: false })),
	]
		.filter(({ m }) => suiteOf(m) === DEFAULT_SUITE && isBefore(m))
		.sort((a, b) => String(b.m.at ?? "").localeCompare(String(a.m.at ?? "")));

	/** @type {Classified[]} */
	const files = failing.map((file) => {
		const held = newestFirst
			.filter(({ m, red }) => (red ? hasFailed : hasRun)(m, file, options.root))
			.slice(0, MAX_WALKED)
			.find(({ m }) => holdsTestByTree(m, file, base, gitOpts));
		/** @type {RedOnBase|null} */
		let onBase = null;
		if (held?.red)
			onBase = { sha: held.m.sha, at: held.m.at ?? null, by: "red store" };
		else if (!held && lander?.sha === base && lander.files.includes(file))
			onBase = { sha: base, at: null, by: "lander" };
		return { file, red: onBase };
	});
	return { base, files, allAlreadyRed: files.every((f) => f.red !== null) };
}

/**
 * @param {Marker} m
 * @param {string} test repo-relative
 * @param {string} root
 */
const hasFailed = (m, test, root) =>
	(m.scope?.failures ?? []).some((f) => toRepoPath(f.file, root) === test);

/**
 * A certificate's run of `test`: it selected it, or ran whole.
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
 * The lander's last red base check, from its heartbeat, or null.
 * @param {string} root the canonical checkout
 * @returns {LanderBaseCheck|null}
 */
function readLanderBaseCheck(root) {
	const red = readHeartbeat(landerFiles(root).heartbeat)?.red;
	return red?.onMain?.kind === "red" && red.base
		? { sha: red.base, files: red.onMain.files }
		: null;
}

/**
 * The evidence on record at `root`: the red store, the certificate store and
 * the lander's heartbeat.
 * @param {string} root the canonical checkout
 * @returns {OnRecord}
 */
const readRedEvidence = (root) => ({
	reds: readFailures({ root }),
	certificates: readMarkers({ root }),
	lander: readLanderBaseCheck(root),
});

/**
 * The red run's ALREADY RED / NEW lines, read off the stores at `root` and
 * the lander's heartbeat. Never throws: a fault costs the lines and says why.
 * @param {Marker} run
 * @param {string} root the canonical checkout
 * @returns {string[]}
 */
function readAlreadyRedLines(run, root) {
	try {
		return buildAlreadyRedLines(
			classifyFailures(run, readRedEvidence(root), { root }),
		);
	} catch (e) {
		return [
			`  Whether these failures were already red on the base went unread (#3624): ${caught(e).message ?? e}`,
		];
	}
}

/* The verdict on a red whose every failure was already red on its base. */
const ALL_ALREADY_RED =
	"  Every failure here was already red on the base, so no rerun is owed to attribute them";

/**
 * The lines a red run's summary carries, or none where nothing failed.
 * @param {Classing|null} classed
 * @returns {string[]}
 */
function buildAlreadyRedLines(classed) {
	if (!classed) return [];
	if (!classed.base)
		return [
			"  This run recorded no base, so no failure could be checked against one (#3624).",
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
 * The files a classing shows already red on its base, each with the run that
 * shows it, under one heading, or none where no file is.
 * @param {Classing} classed
 * @returns {string[]}
 */
function buildAlreadyRedFileLines(classed) {
	if (!classed.base) return [];
	const already = classed.files.flatMap(({ file, red }) =>
		red
			? [
					`    ${file} — by the ${red.by}'s run at ${shortSha(red.sha)}${red.at ? `, ${red.at}` : ""}`,
				]
			: [],
	);
	return already.length > 0
		? [
				`  ALREADY RED on the base ${shortSha(classed.base)} (#3624):`,
				...already,
			]
		: [];
}

module.exports = {
	ALL_ALREADY_RED,
	buildAlreadyRedFileLines,
	buildAlreadyRedLines,
	classifyFailures,
	readAlreadyRedLines,
	readRedEvidence,
};
