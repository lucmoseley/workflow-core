const {
	execProgram,
	gitBinary,
	gitSpawnOptions,
	GIT_TIMEOUT_MS,
} = require("./git.js");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EDGES_FILE, RETEST_FLAG } = require("./test-pass-marker.js");
const { JS_TEST_FILE } = require("./test-kind.js");
const { render: renderReadEdges } = require("./read-edges-render.js");
const { testsReading } = require("./test-read-edges.js");
const { hostRoot } = require("./host-root.js");
const { gitRead, readUntrackedFiles } = require("./dirty-tree.js");
const { VERIFIED_REF } = require("./landing-refs.js");
const { FULL_SHA, commitSha } = require("./commit-sha.js");
const { vitestList } = require("./vitest-collected.js");
const { ignoreFailure, orFallback } = require("./caught.js");

const REGENERATE_EDGES = "Regenerate it: npm run gen:test-read-edges";

class SelectionFailed extends Error {
	/** @override */
	name = "SelectionFailed";
}

const liveEdges = (/** @type {string} */ root) => renderReadEdges(root).edges;

const readCommittedEdges = (/** @type {string} */ root) =>
	JSON.parse(fs.readFileSync(path.join(root, EDGES_FILE), "utf8")).edges ?? {};

const PACKAGE_JSON = "package.json";
// lucmoseley/mantahostels#2031 measured a 292 s run-one wall clock, one run
const PACKAGE_JSON_FULL_SUITE_SECONDS = 292;

const PACKAGE_JSON_SAFE_KEYS = new Set([
	"scripts",
	"comments",
	"name",
	"version",
	"engines",
	"type",
	"browserslist",
]);

const VITEST_DEFAULT_FORCE_RERUN_TRIGGERS = [
	"**/package.json/**",
	"**/{vitest,vite}.config.*/**",
];
const PACKAGE_JSON_TRIGGER_GLOB = "**/package.json/**";

const NARROWED_TRIGGER_DECLS = [
	`const fallback = ${JSON.stringify(VITEST_DEFAULT_FORCE_RERUN_TRIGGERS)};`,
	`const drop = ${JSON.stringify(PACKAGE_JSON_TRIGGER_GLOB)};`,
];
const NARROWED_TRIGGERS =
	"(base.test?.forceRerunTriggers ?? fallback).filter((t) => t !== drop)";

/**
 * @param {string} [tmpDir]
 * @param {number} [pid]
 */
function probeConfigFile(tmpDir = os.tmpdir(), pid = process.pid) {
	return path.join(tmpDir, `wfc-vitest-probe-${pid}.mts`);
}

/**
 * @param {string} root
 * @param {string} file
 */
function realConfigSpec(root, file) {
	const rel = path
		.relative(path.dirname(file), path.join(root, "vitest.config.ts"))
		.split(path.sep)
		.join("/");
	return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * @param {string} root
 * @param {string} file
 * @param {string[]} paths
 * @param {boolean} [narrowed]
 * @returns {string}
 */
function relatedConfigSource(root, file, paths, narrowed = false) {
	const spec = realConfigSpec(root, file);
	const triggers = narrowed ? `, forceRerunTriggers: ${NARROWED_TRIGGERS}` : "";
	return [
		"/* Written by scripts/run-vitest.js for one path-set probe (#1213, #1216).",
		` * Delete freely — the real config is ${spec}. */`,
		`import base from ${JSON.stringify(spec)};`,
		...(narrowed ? NARROWED_TRIGGER_DECLS : []),
		"export default {",
		"\t...base,",
		`\ttest: { ...base.test, related: ${JSON.stringify(paths.map((p) => path.resolve(root, p)))}${triggers} },`,
		"};",
		"",
	].join("\n");
}

/**
 * @param {string} root
 * @param {string} file
 * @returns {string}
 */
function probeConfigSource(root, file) {
	const spec = realConfigSpec(root, file);
	return [
		"/* Written by scripts/run-vitest.js for one `vitest list` probe (mantahostels#2160).",
		` * Delete freely — the real config is ${spec}. */`,
		`import base from ${JSON.stringify(spec)};`,
		...NARROWED_TRIGGER_DECLS,
		"export default {",
		"\t...base,",
		"\ttest: {",
		"\t\t...base.test,",
		`\t\tforceRerunTriggers: ${NARROWED_TRIGGERS},`,
		"\t},",
		"};",
		"",
	].join("\n");
}

/**
 * @typedef {{ readFileSync: typeof import("node:fs").readFileSync,
 *   writeFileSync: typeof import("node:fs").writeFileSync,
 *   unlinkSync: typeof import("node:fs").unlinkSync }} ExpandFs
 */

/**
 * @param {string} root
 * @param {string|null} ref
 * @param {ExecFn} execFn
 * @param {ExpandFs} fsImpl
 * @returns {string[]|null}
 */
function changedPackageJsonKeys(root, ref, execFn, fsImpl) {
	/** @param {unknown} value */
	const isObject = (value) =>
		!!value && typeof value === "object" && !Array.isArray(value);
	try {
		const oldText = String(
			execFn(
				gitBinary(),
				["show", `${ref ?? "HEAD"}:${PACKAGE_JSON}`],
				gitSpawnOptions({
					cwd: root,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
					timeout: GIT_TIMEOUT_MS,
				}),
			) ?? "",
		);
		const newText = String(
			fsImpl.readFileSync(path.join(root, PACKAGE_JSON), "utf8"),
		);
		const before = JSON.parse(oldText);
		const after = JSON.parse(newText);
		if (!isObject(before) || !isObject(after)) return null;
		const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
		return [...keys].filter(
			(key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
		);
	} catch {
		return null;
	}
}

/**
 * @param {string[]} changed
 * @param {{ root: string, ref: string|null, execFn: ExecFn, fs: ExpandFs }} io
 * @returns {boolean}
 */
function packageJsonNarrowable(changed, { root, ref, execFn, fs: fsImpl }) {
	if (!changed.includes(PACKAGE_JSON)) return false;
	const keys = changedPackageJsonKeys(root, ref, execFn, fsImpl);
	if (!keys) return false;
	return keys.every((key) => PACKAGE_JSON_SAFE_KEYS.has(key));
}

/**
 * @param {string} root
 * @param {string} file
 * @param {ExpandFs} fsImpl
 * @returns {string|null}
 */
function writeProbeConfig(root, file, fsImpl) {
	try {
		fsImpl.writeFileSync(file, probeConfigSource(root, file));
		return file;
	} catch {
		return null;
	}
}

/**
 * @param {string[]} changed
 * @param {boolean} [narrowed]
 * @returns {string|null}
 */
function packageJsonWarning(changed, narrowed = false) {
	if (!changed.includes(PACKAGE_JSON)) return null;
	if (narrowed)
		return (
			`NOTE: this diff touches ${PACKAGE_JSON}, but changes only keys on the ` +
			"narrowing allow-list, so vitest's bail-out on it was dropped for this " +
			"run's selection probe (mantahostels#2160). The count below is the real selection.\n"
		);
	return (
		`WARNING: this diff touches ${PACKAGE_JSON} — vitest treats it as a ` +
		"dependency-graph root, so this --changed run selects effectively the " +
		"whole suite regardless of what else changed, costing the full " +
		`~${PACKAGE_JSON_FULL_SUITE_SECONDS}s wall run (mantahostels#2099).\n`
	);
}

// guess, #5529
const ADDED_SHOWN_MAX = 12;

const EMPTY_SELECTION_FILTER = "wfc-empty-selection";

/**
 * @param {string} root
 * @param {string|null} ref
 * @param {ExecFn} execFn
 * @returns {string}
 */
function resolvedBase(root, ref, execFn) {
	const named = ref ?? "HEAD";
	if (FULL_SHA.test(named)) return named;
	return commitSha(root, named, execFn) ?? named;
}

/**
 * @param {string[]} argv
 * @returns {{ at: number, span: number, ref: string|null }|null}
 */
function changedFlag(argv) {
	for (const [i, word] of argv.entries()) {
		if (word === CHANGED_FLAG) {
			const next = argv[i + 1];
			const ref = next && !next.startsWith("-") ? next : null;
			return { at: i, span: ref ? 2 : 1, ref };
		}
		if (word.startsWith("--changed="))
			return { at: i, span: 1, ref: word.slice("--changed=".length) };
	}
	return null;
}

/**
 * @param {string[]} argv
 * @returns {boolean}
 */
const isChangedOnlyArgv = (argv) => {
	const flag = changedFlag(argv);
	return flag != null && argv.length === flag.span;
};

const CHANGED_FLAG = "--changed";

const ADOPT_FLAG = "--adopt";

/**
 * @param {string[]} argv
 * @returns {{ at: number, span: number, paths: string[] }|null}
 */
const adoptFlag = (/** @type {string[]} */ argv) => listFlag(argv, ADOPT_FLAG);

/**
 * @param {string[]} argv
 * @returns {{ at: number, span: number, paths: string[] }|null}
 */
const retestFlag = (argv) => listFlag(argv, RETEST_FLAG);

/**
 * @param {string[]} argv
 * @param {string} flag
 * @returns {{ at: number, span: number, paths: string[] }|null}
 */
function listFlag(argv, flag) {
	const at = argv.indexOf(flag);
	if (at === -1) return null;
	let end = at + 1;
	while (end < argv.length && !String(argv[end]).startsWith("-")) end++;
	return { at, span: end - at, paths: argv.slice(at + 1, end) };
}

/** @param {string[]} argv */
const isAdoptOnlyArgv = (argv) => {
	const flag = adoptFlag(argv);
	return flag != null && flag.paths.length > 0 && argv.length === flag.span;
};

/** @param {string[]} argv */
const isRetestOnlyArgv = (argv) => {
	const flag = retestFlag(argv);
	return (
		flag != null &&
		flag.paths.length > 0 &&
		flag.paths.every((t) => JS_TEST_FILE.test(t)) &&
		argv.length === flag.span
	);
};

/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */

/**
 * @param {string} root
 * @param {string|null} ref
 * @param {ExecFn} execFn
 * @returns {string[]}
 */
function readChangedPaths(root, ref, execFn) {
	const out = execFn(
		gitBinary(),
		["diff", "--name-only", "--no-renames", ref ?? "HEAD"],
		gitSpawnOptions({
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: GIT_TIMEOUT_MS,
		}),
	);
	return parseNonEmptyLines(String(out ?? ""));
}

/** @param {string} out */
const parseNonEmptyLines = (out) =>
	out
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

/**
 * @param {string} root
 * @param {string} from
 * @param {string} to
 * @param {ExecFn} execFn
 * @returns {string[]|null}
 */
function readDiffNames(root, from, to, execFn) {
	const out = gitRead(
		["diff", "--name-only", "--no-renames", from, to],
		root,
		execFn,
	);
	return out === null ? null : parseNonEmptyLines(out);
}

/**
 * @param {{ bin: string, root: string, ref: string|null, execFn: ExecFn,
 *   config?: string|null }} probe
 * @returns {string[]}
 */
function vitestSelection({ bin, root, ref, execFn, config = null }) {
	return vitestList(bin, root, execFn, [
		"--changed",
		...(ref ? [ref] : []),
		"--filesOnly",
		...(config ? ["--config", config] : []),
	]);
}

/**
 * @param {{ bin: string, root: string, paths: string[], execFn: ExecFn,
 *   config: string, fsImpl: ExpandFs, narrowed?: boolean }} probe
 * @returns {string[]}
 */
function vitestRelated({ bin, root, paths, execFn, config, fsImpl, narrowed }) {
	fsImpl.writeFileSync(
		config,
		relatedConfigSource(root, config, paths, narrowed),
	);
	return vitestList(bin, root, execFn, ["--filesOnly", "--config", config]);
}

/**
 * @param {string[]} argv
 * @param {{ root?: string, bin?: string, execFn?: ExecFn,
 *   loadEdges?: () => Record<string, string[]>,
 *   renderEdges?: () => Record<string, string[]>,
 *   fs?: ExpandFs, probeConfig?: string,
 *   ownWork?: { paths: string[], carriesUntracked?: boolean }|null,
 *   err?: { write: (s: string) => unknown } }} [options]
 * @returns {{ argv: string[], files: string[], own: string[], added: string[],
 *   admissible: boolean, narrowed: boolean, changed: string[], base: string|null,
 *   banner: string }|null}
 */
function expandChanged(
	argv,
	{
		root = hostRoot(),
		bin = path.join(root, "node_modules", ".bin", "vitest"),
		execFn = execProgram,
		fs: fsImpl = fs,
		probeConfig = probeConfigFile(),
		loadEdges = () => readCommittedEdges(root),
		renderEdges = () => liveEdges(root),
		ownWork = null,
		err = process.stderr,
	} = {},
) {
	const source = selectionSource(argv);
	if (!source) return null;
	const { from, consumed, flag, adopt, retest } = source;
	const readDiff = () => readDiffOfSource(source, { ownWork, root, execFn });

	const edges = readSourceEdges(source, loadEdges, readDiff, err);
	if (edges === null) return null;

	/** @type {Selection} */
	const sel = { changed: [], own: [], narrowed: false, override: null };
	try {
		fillSelection(sel, {
			diffOf: readDiff,
			adopt,
			retest,
			ref: flag?.ref ?? null,
			ownWork,
			probe: { bin, root, execFn, probeConfig, fsImpl },
		});
	} catch (error) {
		throw new SelectionFailed(
			`${adopt ? ADOPT_FLAG : CHANGED_FLAG} could not be expanded: ${(error instanceof Error ? error.message : String(error)).trim()}`,
			{ cause: error },
		);
	} finally {
		removeScratch(sel.override, fsImpl);
	}
	const { changed, own, narrowed } = sel;

	const { graph, rendered } = readGraph(edges, renderEdges);

	const seen = new Set(own);
	const added = testsReading(changed, graph).filter((t) => !seen.has(t));
	const files = [...seen, ...added].sort();

	const packageJsonLine = packageJsonWarning(changed, narrowed);

	const rest = [
		...argv.slice(0, consumed.at),
		...argv.slice(consumed.at + consumed.span),
	];
	const isAdmissible = source.onlyArgv(argv) && rendered !== null;
	const separatorAt = rest.indexOf("--");
	const endOfOptions = separatorAt === -1 ? rest.length : separatorAt;

	const lines = [
		...(packageJsonLine ? [packageJsonLine.trimEnd()] : []),
		...buildSelectionLines({ files, own, added, from }, (t) =>
			changedReadsOf(changed, graph, t),
		),
	];

	return {
		argv: [
			...rest.slice(0, endOfOptions),
			"--passWithNoTests",
			...(files.length > 0 ? files : [EMPTY_SELECTION_FILTER]),
			...rest.slice(endOfOptions),
		],
		files,
		own,
		added,
		admissible: isAdmissible,
		narrowed,
		changed,
		base: flag ? resolvedBase(root, flag.ref, execFn) : null,
		banner: `${lines.join("\n")}\n`,
	};
}

/**
 * @typedef {{ changed: string[], own: string[], narrowed: boolean,
 *   override: string|null }} Selection
 * @typedef {{ bin: string, root: string, execFn: ExecFn, probeConfig: string,
 *   fsImpl: ExpandFs }} Probe
 */

/**
 * @param {NonNullable<ReturnType<typeof selectionSource>>} source
 * @param {() => Record<string, string[]>} loadEdges
 * @param {() => string[]} diffOf
 * @param {{ write: (s: string) => unknown }} err
 * @returns {Record<string, string[]>|null}
 */
function readSourceEdges({ from }, loadEdges, diffOf, err) {
	if (from === "retest") return {};
	if (from === "diff") return readEdges(loadEdges, diffOf, err);
	try {
		return loadEdges();
	} catch (error) {
		throw new SelectionFailed(
			`${ADOPT_FLAG} could not read ${EDGES_FILE} (${error}). ${REGENERATE_EDGES}`,
			{ cause: error },
		);
	}
}

/**
 * @param {() => Record<string, string[]>} loadEdges
 * @param {() => string[]} diffOf
 * @param {{ write: (s: string) => unknown }} err
 * @returns {Record<string, string[]>|null}
 */
function readEdges(loadEdges, diffOf, err) {
	try {
		return loadEdges();
	} catch (error) {
		ignoreFailure(() => {
			const warning = packageJsonWarning(diffOf());
			if (warning) err.write(warning);
		});
		err.write(
			`${EDGES_FILE} could not be read (${error}) — running --changed on the import graph alone, which misses every test that reads a document rather than importing it (mantahostels#2031). ${REGENERATE_EDGES}\n`,
		);
		return null;
	}
}

/**
 * @param {Selection} sel
 * @param {{ diffOf: () => string[],
 *   adopt: { paths: string[] }|null, retest: { paths: string[] }|null,
 *   ref: string|null,
 *   ownWork: { paths: string[], carriesUntracked?: boolean }|null,
 *   probe: Probe }} at
 */
function fillSelection(sel, { diffOf, adopt, retest, ref, ownWork, probe }) {
	const { bin, root, execFn, probeConfig, fsImpl } = probe;
	sel.changed = diffOf();
	if (retest) {
		sel.own = [...new Set(retest.paths.filter((t) => JS_TEST_FILE.test(t)))];
		return;
	}
	if (adopt) {
		sel.override = probeConfig;
		sel.own = vitestRelated({
			bin,
			root,
			paths: sel.changed,
			execFn,
			config: probeConfig,
			fsImpl,
		});
		return;
	}
	sel.narrowed = packageJsonNarrowable(sel.changed, {
		root,
		ref,
		execFn,
		fs: fsImpl,
	});
	if (ownWork) {
		fillOwnWorkSelection(sel, ownWork, probe);
		return;
	}
	if (sel.narrowed) {
		sel.override = writeProbeConfig(root, probeConfig, fsImpl);
		if (!sel.override) sel.narrowed = false;
	}
	sel.own = vitestSelection({ bin, root, ref, execFn, config: sel.override });
}

/**
 * @param {Selection} sel
 * @param {{ carriesUntracked?: boolean }} ownWork
 * @param {Probe} probe
 */
function fillOwnWorkSelection(
	sel,
	ownWork,
	{ bin, root, execFn, probeConfig, fsImpl },
) {
	const related = [
		...sel.changed,
		...(ownWork.carriesUntracked
			? []
			: (readUntrackedFiles(root, execFn) ?? [])),
	];
	sel.override = related.length > 0 ? probeConfig : null;
	sel.own = sel.override
		? vitestRelated({
				bin,
				root,
				paths: related,
				execFn,
				config: sel.override,
				fsImpl,
				narrowed: sel.narrowed,
			})
		: [];
}

/**
 * @param {string|null} override
 * @param {ExpandFs} fsImpl
 */
function removeScratch(override, fsImpl) {
	if (!override) return;
	ignoreFailure(() => fsImpl.unlinkSync(override));
}

/**
 * @param {Record<string, string[]>} edges
 * @param {() => Record<string, string[]>} renderEdges
 * @returns {{ graph: Record<string, string[]>,
 *   rendered: Record<string, string[]>|null }}
 */
function readGraph(edges, renderEdges) {
	/** @type {Record<string, string[]> | null} */
	const rendered = orFallback(() => renderEdges(), null);
	/** @type {Record<string, string[]>} */
	const graph = { ...edges };
	for (const [p, readers] of Object.entries(rendered ?? {}))
		graph[p] = [...new Set([...(graph[p] ?? []), ...readers])];
	return { graph, rendered };
}

/**
 * @param {string[]} changed
 * @param {Record<string, string[]>} graph
 * @param {string} test
 * @returns {string[]}
 */
function changedReadsOf(changed, graph, test) {
	return changed.filter((p) => (graph[p] ?? []).includes(test));
}

/**
 * @param {string[]} argv
 * @returns {{ from: SelectionFrom, consumed: { at: number, span: number, paths: string[] },
 *   flag: ReturnType<typeof changedFlag>, adopt: ReturnType<typeof adoptFlag>,
 *   retest: ReturnType<typeof retestFlag>, onlyArgv: (argv: string[]) => boolean }|null}
 */
function selectionSource(argv) {
	const none = { flag: null, adopt: null, retest: null };
	for (const { pick } of SELECTION_FLAGS) {
		const picked = pick(argv);
		if (picked) return { ...none, ...picked };
	}
	return null;
}

/**
 * @typedef {{ from: SelectionFrom, consumed: { at: number, span: number, paths: string[] },
 *   flag?: ReturnType<typeof changedFlag>, adopt?: ReturnType<typeof adoptFlag>,
 *   retest?: ReturnType<typeof retestFlag>, onlyArgv: (argv: string[]) => boolean }} PickedSelection
 */

/**
 * @type {{ word: string, pick: (argv: string[]) => PickedSelection|null }[]}
 */
const SELECTION_FLAGS = [
	{
		word: CHANGED_FLAG,
		pick: (argv) => {
			const flag = changedFlag(argv);
			return (
				flag && {
					from: "diff",
					consumed: { ...flag, paths: [] },
					flag,
					onlyArgv: isChangedOnlyArgv,
				}
			);
		},
	},
	{
		word: ADOPT_FLAG,
		pick: (argv) => {
			const adopt = adoptFlag(argv);
			return (
				adopt && {
					from: "adopt",
					consumed: adopt,
					adopt,
					onlyArgv: isAdoptOnlyArgv,
				}
			);
		},
	},
	{
		word: RETEST_FLAG,
		pick: (argv) => {
			const retest = retestFlag(argv);
			return (
				retest && {
					from: "retest",
					consumed: retest,
					retest,
					onlyArgv: isRetestOnlyArgv,
				}
			);
		},
	},
];

/**
 * @param {string[]} argv
 * @returns {string[]|null}
 */
function selectionFlagClash(argv) {
	const found = SELECTION_FLAGS.flatMap(({ word, pick }) => {
		const picked = pick(argv);
		return picked ? [{ word, at: picked.consumed.at }] : [];
	});
	if (found.length < 2) return null;
	return found.sort((a, b) => a.at - b.at).map(({ word }) => word);
}

/**
 * @param {NonNullable<ReturnType<typeof selectionSource>>} source
 * @param {{ ownWork: { paths: string[] }|null, root: string, execFn: ExecFn }} at
 * @returns {string[]}
 */
function readDiffOfSource({ adopt, retest, flag }, { ownWork, root, execFn }) {
	if (adopt) return [...new Set(adopt.paths)];
	if (retest) return [];
	return ownWork?.paths ?? readChangedPaths(root, flag?.ref ?? null, execFn);
}

/**
 * @typedef {"diff"|"adopt"|"retest"} SelectionFrom
 * @param {{ files: string[], own: string[], added: string[], from: SelectionFrom }} at
 * @param {(test: string) => string[]} why
 * @returns {string[]}
 */
function buildSelectionLines({ files, own, added, from }, why) {
	if (from === "retest")
		return [
			files.length > 0
				? `RE-TEST SELECTION — the ${files.length} named test file(s) and nothing else (#1860).`
				: "RE-TEST SELECTION — `--retest` names no test file. Nothing to run.",
		];
	if (files.length === 0)
		return [
			`READ-GRAPH SELECTION — the ${from === "adopt" ? "adopted paths reach" : "diff reaches"} no test file, by import or by ${EDGES_FILE}. Nothing to run.`,
		];
	return [
		`READ-GRAPH SELECTION — ${files.length} test file(s): ${own.length} from vitest's import graph, ${added.length} added from the read graph.`,
		...added
			.slice(0, ADDED_SHOWN_MAX)
			.map((t) => `  + ${t} — reads ${why(t).join(", ")}`),
		...(added.length > ADDED_SHOWN_MAX
			? [`  … and ${added.length - ADDED_SHOWN_MAX} more`]
			: []),
	];
}

/**
 * @param {string} root
 * @param {ExecFn} execFn
 * @returns {string}
 */
function readDefaultChangedBase(root, execFn) {
	const ref = VERIFIED_REF;
	try {
		execFn(
			gitBinary(),
			["rev-parse", "--verify", "--quiet", ref],
			gitSpawnOptions({
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: GIT_TIMEOUT_MS,
			}),
		);
	} catch {
		return "HEAD";
	}
	try {
		const out = execFn(
			gitBinary(),
			["merge-base", "HEAD", ref],
			gitSpawnOptions({
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: GIT_TIMEOUT_MS,
			}),
		);
		const sha = String(out ?? "").trim();
		return sha || "HEAD";
	} catch {
		return "HEAD";
	}
}

module.exports = {
	ADOPT_FLAG,
	CHANGED_FLAG,
	PACKAGE_JSON,
	REGENERATE_EDGES,
	SelectionFailed,
	adoptFlag,
	retestFlag,
	selectionFlagClash,
	changedFlag,
	readChangedPaths,
	readCommittedEdges,
	readDefaultChangedBase,
	readDiffNames,
	expandChanged,
	isChangedOnlyArgv,
	liveEdges,
};
