/*
 * changed-selection.js — what a `--changed` or `--adopt` run of
 * `run-vitest.js` hands vitest: the diff, vitest's own import-graph selection
 * of it, and the read graph's runtime readers of the same paths (mantahostels#2095).
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EDGES_FILE, RETEST_FLAG } = require("./test-pass-marker.js");
const { JS_TEST_FILE } = require("./test-kind.js");
const { render: renderReadEdges } = require("../generate-test-read-edges.js");
const { testsReading } = require("./test-read-edges.js");
const { hostRoot } = require("./host-root.js");
const { commandOrDefault } = require("./workflow-core-config.js");
const { GIT_TIMEOUT_MS, gitRead, untrackedFiles } = require("./dirty-tree.js");
const { pushedRef } = require("./landing-refs.js");
const { CHILD_MAX_BUFFER } = require("./child-buffer.js");
const { FULL_SHA, commitSha } = require("./commit-sha.js");

const EDGES_SCRIPT = "scripts/generate-test-read-edges.js";

/** The read graph the tree at `root` renders now (workflow-core#998); throws where it will not. */
const liveEdges = (/** @type {string} */ root) => renderReadEdges(root).edges;

/** The committed read graph at `root`; throws where it is missing or not JSON. */
const committedEdges = (/** @type {string} */ root) =>
	JSON.parse(fs.readFileSync(path.join(root, EDGES_FILE), "utf8")).edges ?? {};

/*
 * `--changed` EXPANDED AGAINST THE READ GRAPH (mantahostels#2095).
 *
 * Vitest selects `--changed` on the import graph, so a test that reads a repo
 * document through `readFileSync` is invisible to it (mantahostels#2031).
 *
 * So the flag is consumed here instead of passed through: vitest's own selection
 * is taken with `vitest list --changed --filesOnly`, unioned with the manifest's
 * runtime readers of the same diff, and the result handed to vitest as an
 * explicit file list. That list lands in the certificate's `fileFilters`, so the
 * run is still a NARROWING and still records no full green (mantahostels#1230).
 */

/*
 * PACKAGE.JSON IS A VITEST DEPENDENCY-GRAPH ROOT (mantahostels#2132).
 *
 * Vitest invalidates its whole selection on it regardless of what else the
 * commit does (mantahostels#2099), so a `--changed` run over such a diff buys the
 * full wall run without saying so. This warns at the point the diff is read for selection.
 */
const PACKAGE_JSON = "package.json";
/* the suite-file-timings note (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/suite-file-timings.md)'s run-one wall clock (mantahostels#2031).
 * **Residual:** one run, not a mean — that document records a 3.7x spread —
 * and nothing watches it for drift as the suite grows. */
const PACKAGE_JSON_FULL_SUITE_SECONDS = 292;

/*
 * ...AND THE BAIL-OUT IS NARROWED FOR AN ALLOW-LISTED KEY SET (mantahostels#2160).
 *
 * The whole cost above is one glob: `forceRerunTriggers` defaults to
 * `["**\/package.json/**", "**\/{vitest,vite}.config.*\/**"]` and
 * `VitestSpecifications.filterTestsBySource` returns EVERY spec unfiltered the
 * moment a changed path matches it, before any dependency walk. So where the
 * diff's `package.json` hunk changes only keys on the allow-list below,
 * `expandChanged` hands its own `vitest list` probe a `--config` override dropping the
 * package.json trigger and keeping the vitest/vite config one.
 *
 * `scripts` IS ON THE LIST DESPITE NOT BEING INERT — tests assert
 * `pkg.scripts` content directly. It is safe only because `testsReading()`
 * selects docs/test-read-edges.json's `package.json` readers off the run's OWN
 * diff, whatever vitest's selection does; dropping that union would make this
 * unsafe.
 *
 * `dependencies`, `devDependencies` and `overrides` are DELIBERATELY ABSENT and
 * must never be added. Vitest's graph walk excludes node_modules outright, so
 * today's blanket bail-out is the only thing in this repo that gives a
 * dependency VERSION bump any chance of selecting a test.
 *
 * FAIL CLOSED: an unreadable side, unparseable JSON, or one key off the list
 * leaves the run exactly as it was before this existed.
 */
const PACKAGE_JSON_SAFE_KEYS = new Set([
	"scripts",
	"comments",
	"name",
	"version",
	"engines",
	"type",
	"browserslist",
]);

/* Vitest's own default (`node_modules/vitest/dist/config.cjs:62`), read into
 * the scratch config as the fallback for a real config that sets none of its
 * own — never hardcoded as the narrowed list itself. The scratch config
 * FILTERS whatever `base.test.forceRerunTriggers` actually is at load time,
 * so a trigger `vitest.config.ts` adds later survives the narrowing; only
 * this one glob is ever dropped from it. */
const VITEST_DEFAULT_FORCE_RERUN_TRIGGERS = [
	"**/package.json/**",
	"**/{vitest,vite}.config.*/**",
];
const PACKAGE_JSON_TRIGGER_GLOB = "**/package.json/**";

/* The scratch configs' one spelling of the narrowed trigger list. */
const NARROWED_TRIGGER_DECLS = [
	`const fallback = ${JSON.stringify(VITEST_DEFAULT_FORCE_RERUN_TRIGGERS)};`,
	`const drop = ${JSON.stringify(PACKAGE_JSON_TRIGGER_GLOB)};`,
];
const NARROWED_TRIGGERS =
	"(base.test?.forceRerunTriggers ?? fallback).filter((t) => t !== drop)";

/**
 * The scratch config's own name. Pid-scoped, like `inflightFile`, so two
 * concurrent wrappers never write each other's probe config. `.mts` because
 * vite transpiles a TS config through esbuild, which is what lets it import the
 * repo's own `vitest.config.ts`.
 * @param {string} [tmpDir]
 * @param {number} [pid]
 */
function probeConfigFile(tmpDir = os.tmpdir(), pid = process.pid) {
	return path.join(tmpDir, `wfc-vitest-probe-${pid}.mts`);
}

/**
 * The real `vitest.config.ts` as an import specifier from `file`'s directory.
 * @param {string} root
 * @param {string} file
 */
function realConfigSpec(root, file) {
	const rel = path
		.relative(path.dirname(file), path.join(root, "vitest.config.ts"))
		.split(path.sep)
		.join("/");
	/* A bare `vitest.config.ts` would resolve as a PACKAGE specifier. */
	return rel.startsWith(".") ? rel : `./${rel}`;
}

/**
 * A path-set probe's scratch config — an adoption's (workflow-core#1213) or an own-work
 * default's (workflow-core#1216): the real config, spread for `probeConfigSource`'s
 * reason, with `related` naming the paths. The CLI takes no `--related` on
 * `vitest list`, and vitest's `--changed` is only a way of filling `related`,
 * `forceRerunTriggers` included. Absolute, as vitest compares them to module
 * ids unresolved. `narrowed` drops the package.json trigger as
 * `probeConfigSource` does.
 *
 * @param {string} root
 * @param {string} file where the config will be written
 * @param {string[]} paths repo-relative
 * @param {boolean} [narrowed]
 * @returns {string}
 */
function relatedConfigSource(root, file, paths, narrowed = false) {
	const spec = realConfigSpec(root, file);
	const triggers = narrowed ? `, forceRerunTriggers: ${NARROWED_TRIGGERS}` : "";
	return [
		"/* Written by scripts/run-vitest.js for one path-set probe (workflow-core#1213, workflow-core#1216).",
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
 * The scratch config's text.
 *
 * IT SPREADS THE REAL CONFIG. A `--config` override REPLACES the config rather
 * than merging into it, so without the spread the probe would enumerate against
 * the wrong `include`/`exclude` and resolve aliases and return the wrong file
 * list — silently, since that is still a plausible list of test files.
 *
 * @param {string} root
 * @param {string} file where the config will be written
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
 * Which TOP-LEVEL keys the diff changed in `package.json`, or null where that
 * cannot be established.
 *
 * PARSED JSON, NOT A TEXT DIFF: the old side comes from `git show <ref>:…` and
 * the new one from the working tree, and the two are compared key by key. A
 * text diff would have to guess which object a changed line sits in, and a
 * reformat would read as a change to every key.
 *
 * TOTAL BY CONSTRUCTION — it answers null rather than throwing, so a missing
 * file, a wedged git or a half-written working tree costs the narrowing and
 * never the run.
 *
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
			execFn("git", ["show", `${ref ?? "HEAD"}:${PACKAGE_JSON}`], {
				cwd: root,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: GIT_TIMEOUT_MS,
			}) ?? "",
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
 * Whether the probe may be narrowed for this diff: `package.json` is in it, and
 * every top-level key it changes is allow-listed. Anything else is false.
 *
 * An empty changed-key set — a whitespace or key-order-only edit — narrows: the
 * parsed document is identical, so no test's reading of it can have moved.
 *
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
 * Write the probe's scratch config, or null where it cannot be written — an
 * unwritable temp directory costs the narrowing, never the run.
 *
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
 * @param {boolean} [narrowed] whether the bail-out was narrowed for this diff
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

/* A ceiling on the vitest listing the expansion shells out to, so a wedged
 * vitest fails the expansion open rather than hanging the suite launch. Its git
 * counterpart is `GIT_TIMEOUT_MS`, reused for every git this file runs. Neither
 * is measured against a slow machine. */
const LIST_TIMEOUT_MS = 120_000;

/* How many added readers the banner names before it counts the rest. An
 * unmeasured first guess. */
const ADDED_SHOWN_MAX = 12;

/*
 * The file filter a run whose selection is EMPTY is handed (workflow-core#189 §6, ruled at
 * workflow-core#151): a name no test file carries, so vitest collects nothing, exits 0 on
 * the `--passWithNoTests` beside it, and still fires the reporter's end hook
 * — which is what writes the marker. Handing vitest an empty list instead
 * would run the whole suite.
 */
const EMPTY_SELECTION_FILTER = "wfc-empty-selection";

/**
 * The base a narrowed selection diffed from, as a sha where git will resolve
 * the ref and as the ref itself otherwise (workflow-core#189 §7): `HEAD` moves, and a
 * marker naming a moved ref would diff the wrong range at match time.
 *
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
 * Where `--changed` sits in argv and what ref it was given, or null.
 *
 * The ref is optional and positional, exactly as vitest parses it, so a bare
 * `--changed` followed by another flag takes no value.
 *
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
 * Whether argv is `npm run test:changed`'s own argv and nothing else — the
 * flag, its optional ref, no other word.
 *
 * SHARED WITH THE ROUTE FLAG so the gate and the denominator cannot drift
 * apart (mantahostels#2303). `-t`, an added path or a project filter
 * each narrow the run past the diff, so a run carrying one is not the command
 * this repo permits at the push and does not belong in its denominator either.
 * The render is the SECOND limb and lives only on the gate's side: a read
 * graph that will not render makes a `test:changed` run inadmissible without
 * making it some other command.
 *
 * @param {string[]} argv
 * @returns {boolean}
 */
const isChangedOnlyArgv = (argv) => {
	const flag = changedFlag(argv);
	return flag != null && argv.length === flag.span;
};

const CHANGED_FLAG = "--changed";

/* An adoption run (workflow-core#1213): `npm run push:check` hands it back over the
 * uncovered paths of commits whose session has ended. */
const ADOPT_FLAG = "--adopt";

/**
 * Where `--adopt` sits in argv and the paths it names — every word after it up
 * to the next flag — or null.
 *
 * @param {string[]} argv
 * @returns {{ at: number, span: number, paths: string[] }|null}
 */
const adoptFlag = (/** @type {string[]} */ argv) => listFlag(argv, ADOPT_FLAG);

/**
 * Where `--retest` sits in argv and the tests it names (workflow-core#1860).
 *
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

/**
 * Whether argv is `--adopt` and its paths and nothing else — the adoption
 * run's admissible shape, as `isChangedOnlyArgv` is `test:changed`'s.
 *
 * @param {string[]} argv
 */
const isAdoptOnlyArgv = (argv) => {
	const flag = adoptFlag(argv);
	return flag != null && flag.paths.length > 0 && argv.length === flag.span;
};

/**
 * Whether argv is `--retest` and test files and nothing else — the re-test
 * run's admissible shape (workflow-core#1860). A word that is not a test file is dropped
 * before vitest, which would read it as a filter matching anything.
 *
 * @param {string[]} argv
 */
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
 * The paths the diff touches: the working tree against HEAD for a bare
 * `--changed`, against the named ref otherwise.
 *
 * NOT IDENTICAL TO VITEST'S OWN BASE. Vitest reads a bare `--changed` as `git diff --cached` plus
 * `git ls-files --other --modified`, so it counts UNTRACKED files, and reads a
 * ref three-dot. This is two-dot and tracked-only. For selection the
 * divergence is inert: every manifest key is a tracked path, so an untracked
 * file has no edge to miss, and vitest is asked for its own selection
 * separately, on its own base. For the certificate it is one-sided (workflow-core#189):
 * this list is the marker's `changedPaths`, and `attestationOf` asks every file of
 * the commit's range, added files included, to lie in some run's list — so a
 * commit adding an untracked test stays uncovered until a run after it.
 *
 * DELETIONS AND RENAMES ARE KEPT, which is what `--no-renames` buys. A test
 * reading a document that has just been deleted or moved is exactly the test
 * that should re-run, and with rename detection on git prints the destination
 * alone — so the manifest is never asked about the path its readers are
 * recorded under.
 *
 * @param {string} root
 * @param {string|null} ref
 * @param {ExecFn} execFn
 * @returns {string[]}
 */
function changedPaths(root, ref, execFn) {
	const out = execFn(
		"git",
		["diff", "--name-only", "--no-renames", ref ?? "HEAD"],
		{
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: GIT_TIMEOUT_MS,
		},
	);
	return nonEmptyLines(String(out ?? ""));
}

/** @param {string} out */
const nonEmptyLines = (out) =>
	out
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

/**
 * The paths that differ between two commits, or null where git will not say.
 *
 * @param {string} root
 * @param {string} from
 * @param {string} to
 * @param {ExecFn} execFn
 * @returns {string[]|null}
 */
function diffNames(root, from, to, execFn) {
	const out = gitRead(
		["diff", "--name-only", "--no-renames", from, to],
		root,
		execFn,
	);
	return out === null ? null : nonEmptyLines(out);
}

/**
 * Vitest's own import-graph selection for the same flag.
 *
 * It costs a second node process on every `test:changed`, so it is bounded:
 * the timeout throws and the caller fails open to handing `--changed` to
 * vitest as before (mantahostels#2095).
 *
 * `config` is a scratch config narrowing `forceRerunTriggers` for this ONE
 * probe call (mantahostels#2160); the real vitest.config.ts is never touched
 * and no other vitest invocation sees it.
 *
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
 * The test files `vitest list <args>` names, repo-relative.
 *
 * @param {string} bin
 * @param {string} root
 * @param {ExecFn} execFn
 * @param {string[]} args
 * @returns {string[]}
 */
function vitestList(bin, root, execFn, args) {
	const out = execFn(bin, ["list", ...args], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
		maxBuffer: CHILD_MAX_BUFFER,
		timeout: LIST_TIMEOUT_MS,
	});
	return String(out ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => JS_TEST_FILE.test(line))
		.map((line) => path.relative(root, path.resolve(root, line)));
}

/**
 * Vitest's import-graph selection for a path set, through a scratch config
 * the caller removes.
 *
 * `config` is where the scratch config is written.
 *
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
 * What the run will actually execute, and the line that says so — or null where
 * argv carries neither `--changed` nor `--adopt`, or the expansion could not be
 * computed.
 *
 * AN ADOPTION SELECTS FROM ITS NAMED PATHS (workflow-core#1213), never a diff: they are
 * the run's `changedPaths`, so its green covers those paths and no other, and
 * it has no `base`. `package.json` among them is never narrowed, having no
 * ref to compare against.
 *
 * A RE-TEST RUNS ITS NAMED TESTS AND NOTHING ELSE (workflow-core#1860), with no diff at
 * all: its green vouches for those tests at whatever commit their own reads
 * are unchanged, never for a path, so its `changedPaths` is empty.
 *
 * `ownWork` (workflow-core#1216) replaces a `--changed <ref>` diff with the resolver's
 * path set over it, selected as an adoption is. Only the bare default and the
 * queue's probes pass it. `carriesUntracked` is the probes' (workflow-core#1221): the set
 * already holds the session's own new files, and the tree's others are a
 * neighbour's.
 *
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
		execFn = execFileSync,
		fs: fsImpl = fs,
		probeConfig = probeConfigFile(),
		loadEdges = () => committedEdges(root),
		renderEdges = () => liveEdges(root),
		ownWork = null,
		err = process.stderr,
	} = {},
) {
	const source = selectionSource(argv);
	if (!source) return null;
	const { from, consumed, flag, adopt, retest } = source;
	const diffOf = () => diffOfSource(source, { ownWork, root, execFn });

	const edges = readEdges(loadEdges, diffOf, err);
	if (edges === null) return null;

	/* Whether the package.json bail-out was narrowed for this run (mantahostels#2160), and
	 * the scratch config that did it. Held out here so the `finally` can
	 * clean up whatever was written, on the throwing path as well. */
	/** @type {Selection} */
	const sel = { changed: [], own: [], narrowed: false, override: null };
	try {
		fillSelection(sel, {
			diffOf,
			adopt,
			retest,
			ref: flag?.ref ?? null,
			ownWork,
			probe: { bin, root, execFn, probeConfig, fsImpl },
		});
	} catch (error) {
		reportUnexpanded(sel.changed, Boolean(adopt), error, err);
		return null;
	} finally {
		removeScratch(sel.override, fsImpl);
	}
	const { changed, own, narrowed } = sel;

	const { graph, rendered, renderError } = readGraph(edges, renderEdges);

	const seen = new Set(own);
	const added = testsReading(changed, graph).filter((t) => !seen.has(t));
	const files = [...seen, ...added].sort();

	const packageJsonLine = packageJsonWarning(changed, narrowed);

	/*
	 * WHETHER THIS RUN IS ADMISSIBLE — the whole push gate (mantahostels#2207), and
	 * not a stand-in for a wider one.
	 */
	const rest = [
		...argv.slice(0, consumed.at),
		...argv.slice(consumed.at + consumed.span),
	];
	const isAdmissible = source.onlyArgv(argv) && rendered !== null;
	const separatorAt = rest.indexOf("--");
	const endOfOptions = separatorAt === -1 ? rest.length : separatorAt;

	const lines = [
		...(packageJsonLine ? [packageJsonLine.trimEnd()] : []),
		...selectionLines({ files, own, added, from }, (t) =>
			changedReadsOf(changed, graph, t),
		),
		/* An empty selection records a marker too (workflow-core#189 §6): a narrowed run
		 * with zero files, admissible on the same conditions as any other. */
		admissibleLine({
			from,
			listed: consumed.paths,
			rest,
			isAdmissible,
			changed,
			files,
			renderError,
		}),
	];

	return {
		/* --passWithNoTests RIDES WITH THE LIST because vitest sets it implicitly
		 * for --changed, and this consumes that flag. Without it a union whose
		 * entries have all since been deleted collects nothing and exits 1 — a
		 * red suite where the truth is a stale manifest. */
		argv: [
			/* THE LIST GOES AHEAD OF A BARE `--`, which `npm run test -- --retest
			 * a.test.ts -- --queue` leaves in `rest`: vitest reads no word after
			 * it as a file filter, so a list placed there ran the whole suite
			 * (workflow-core#2181). Residual: a path the caller writes after the `--` is still
			 * no filter. */
			...rest.slice(0, endOfOptions),
			"--passWithNoTests",
			/* A filter matching nothing, never an empty list, which vitest reads
			 * as the whole suite (workflow-core#189 §6). */
			...(files.length > 0 ? files : [EMPTY_SELECTION_FILTER]),
			...rest.slice(endOfOptions),
		],
		files,
		own,
		added,
		admissible: isAdmissible,
		narrowed,
		/* The diff the selection was computed from, for the marker's
		 * `changedPaths` (workflow-core#189). */
		changed,
		/* What `changed` was diffed against, for the marker's `base` (workflow-core#189 §7). */
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
 * The committed read-edge manifest, or null after saying why it could not be
 * read.
 *
 * @param {() => Record<string, string[]>} loadEdges
 * @param {() => string[]} diffOf
 * @param {{ write: (s: string) => unknown }} err
 * @returns {Record<string, string[]>|null}
 */
function readEdges(loadEdges, diffOf, err) {
	try {
		return loadEdges();
	} catch (error) {
		/* The diff is not computed yet on this path — the manifest read comes
		 * first — so the package.json warning runs its own changedPaths call,
		 * un-narrowed as in reportUnexpanded (mantahostels#2151). A diff that
		 * cannot be read either is silently no warning. */
		try {
			const warning = packageJsonWarning(diffOf());
			if (warning) err.write(warning);
		} catch {
			/* no diff to warn about */
		}
		err.write(
			`${EDGES_FILE} could not be read (${error}) — running --changed on the import graph alone, which misses every test that reads a document rather than importing it (mantahostels#2031). Regenerate it: npm run gen:test-read-edges\n`,
		);
		return null;
	}
}

/**
 * `changed` is already known here even where the expansion is being
 * abandoned after it — bailing to a bare --changed must not also lose
 * the package.json warning that run is about to earn (mantahostels#2151).
 * Empty before `changedPaths` succeeds, and packageJsonWarning
 * returns null on that, same as no warning at all.
 *
 * ALWAYS THE UN-NARROWED WARNING, never `narrowed`: whatever a
 * successful probe would have done, the run that actually follows is
 * a bare `--changed` with vitest's default triggers intact, so the
 * full-cost claim is the true one here.
 *
 * @param {string[]} changed
 * @param {boolean} adopted
 * @param {unknown} error
 * @param {{ write: (s: string) => unknown }} err
 */
function reportUnexpanded(changed, adopted, error, err) {
	const warning = packageJsonWarning(changed);
	if (warning) err.write(warning);
	err.write(
		adopted
			? `--adopt could not be expanded (${error}) — vitest will refuse the flag, so re-run once the listing works\n`
			: `--changed could not be expanded (${error}) — passing it to vitest unchanged, so the read graph is not consulted\n`,
	);
}

/**
 * Fills `sel` step by step — the diff, then vitest's own selection over it —
 * so a throw part-way leaves the caller what was already known and written
 * (workflow-core#1389, which split it out of expandChanged).
 *
 * @param {Selection} sel accumulator: the diff, narrowing, override and vitest's selection are filled in turn
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
		/* A config that could not be written narrows nothing, and the
		 * banner must not say it did. */
		if (!sel.override) sel.narrowed = false;
	}
	sel.own = vitestSelection({ bin, root, ref, execFn, config: sel.override });
}

/**
 * @param {Selection} sel accumulator: the override and vitest's selection are filled; `changed` is read
 * @param {{ carriesUntracked?: boolean }} ownWork
 * @param {Probe} probe
 */
function fillOwnWorkSelection(
	sel,
	ownWork,
	{ bin, root, execFn, probeConfig, fsImpl },
) {
	/* Untracked files too, as vitest's own `--changed` lists them. An
	 * empty `related` selects nothing, so it is never asked. */
	const related = [
		...sel.changed,
		...(ownWork.carriesUntracked ? [] : (untrackedFiles(root, execFn) ?? [])),
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
 * Best effort: a leftover scratch file in the temp directory is cheaper than
 * a run that fails on its cleanup.
 *
 * @param {string|null} override
 * @param {ExpandFs} fsImpl
 */
function removeScratch(override, fsImpl) {
	if (!override) return;
	try {
		fsImpl.unlinkSync(override);
	} catch {
		/* already gone, or a temp directory that will not unlink */
	}
}

/**
 * Readers come from the committed manifest AND the graph this tree renders
 * now (workflow-core#998), so a neighbour's uncommitted edge selects its reader rather
 * than voiding the run. A render that throws leaves the manifest alone to
 * select on, and the run certifies nothing.
 *
 * @param {Record<string, string[]>} edges
 * @param {() => Record<string, string[]>} renderEdges
 * @returns {{ graph: Record<string, string[]>,
 *   rendered: Record<string, string[]>|null, renderError: unknown }}
 */
function readGraph(edges, renderEdges) {
	/** @type {Record<string, string[]> | null} */
	let rendered = null;
	/** @type {unknown} */
	let renderError = null;
	try {
		rendered = renderEdges();
	} catch (error) {
		renderError = error;
	}
	/** @type {Record<string, string[]>} */
	const graph = { ...edges };
	for (const [p, readers] of Object.entries(rendered ?? {}))
		graph[p] = [...new Set([...(graph[p] ?? []), ...readers])];
	return { graph, rendered, renderError };
}

/**
 * Which changed path pulled an added reader in — without it the reader
 * cannot tell a real runtime read from a manifest gone stale.
 *
 * @param {string[]} changed
 * @param {Record<string, string[]>} graph
 * @param {string} test
 * @returns {string[]}
 */
function changedReadsOf(changed, graph, test) {
	return changed.filter((p) => (graph[p] ?? []).includes(test));
}

/**
 * The flag argv's selection is computed from — `--changed`, else `--adopt`,
 * else `--retest` — with the argv shape that makes a run of it admissible, or
 * null where argv carries none.
 *
 * @param {string[]} argv
 * @returns {{ from: SelectionFrom, consumed: { at: number, span: number, paths: string[] },
 *   flag: ReturnType<typeof changedFlag>, adopt: ReturnType<typeof adoptFlag>,
 *   retest: ReturnType<typeof retestFlag>, onlyArgv: (argv: string[]) => boolean }|null}
 */
function selectionSource(argv) {
	const none = { flag: null, adopt: null, retest: null };
	const flag = changedFlag(argv);
	if (flag)
		return {
			...none,
			from: "diff",
			consumed: { ...flag, paths: [] },
			flag,
			onlyArgv: isChangedOnlyArgv,
		};
	const adopt = adoptFlag(argv);
	if (adopt)
		return {
			...none,
			from: "adopt",
			consumed: adopt,
			adopt,
			onlyArgv: isAdoptOnlyArgv,
		};
	const retest = retestFlag(argv);
	if (retest)
		return {
			...none,
			from: "retest",
			consumed: retest,
			retest,
			onlyArgv: isRetestOnlyArgv,
		};
	return null;
}

/**
 * @param {NonNullable<ReturnType<typeof selectionSource>>} source
 * @param {{ ownWork: { paths: string[] }|null, root: string, execFn: ExecFn }} at
 * @returns {string[]}
 */
function diffOfSource({ adopt, retest, flag }, { ownWork, root, execFn }) {
	if (adopt) return [...new Set(adopt.paths)];
	if (retest) return [];
	return ownWork?.paths ?? changedPaths(root, flag?.ref ?? null, execFn);
}

/**
 * The banner's selection block.
 *
 * @typedef {"diff"|"adopt"|"retest"} SelectionFrom
 * @param {{ files: string[], own: string[], added: string[], from: SelectionFrom }} at
 * @param {(test: string) => string[]} why
 * @returns {string[]}
 */
function selectionLines({ files, own, added, from }, why) {
	if (from === "retest")
		return [
			files.length > 0
				? `RE-TEST SELECTION — the ${files.length} named test file(s) and nothing else (workflow-core#1860).`
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
 * The banner's verdict on whether this run meets the push gate.
 *
 * @param {{ from: SelectionFrom, listed: string[], rest: string[],
 *   isAdmissible: boolean, changed: string[], files: string[],
 *   renderError: unknown }} at
 * @returns {string}
 */
function admissibleLine({
	from,
	listed,
	rest,
	isAdmissible,
	changed,
	files,
	renderError,
}) {
	if (from === "adopt" && listed.length === 0)
		return "NOT ADMISSIBLE — `--adopt` names no path, so this run covers nothing at the push (workflow-core#1213).";
	if (from === "retest" && listed.some((t) => !JS_TEST_FILE.test(t)))
		return "NOT ADMISSIBLE — `--retest` names a word that is not a test file, which this run drops, so it certifies nothing at the push; name test files alone (workflow-core#1860).";
	if (rest.length > 0) {
		const { what, alone } = {
			diff: { what: "diff", alone: "--changed" },
			adopt: { what: "adopted paths", alone: "--adopt <paths>" },
			retest: { what: "named tests", alone: "--retest <tests>" },
		}[from];
		return `NOT ADMISSIBLE — this run is narrowed past the ${what} by ${rest.join(" ")}, so it certifies nothing at the push; re-run with \`${alone}\` alone (mantahostels#2146).`;
	}
	if (isAdmissible && from === "adopt")
		return `MEETS THE PUSH GATE FOR THE ${changed.length} ADOPTED PATH(S) — every reader of them was selected from ${EDGES_FILE} and from the read graph this tree renders now, so a green here covers those paths, and no other, at the push (workflow-core#1213). It does not cover a test that reads an adopted document through an imported HELPER (mantahostels#2131).`;
	if (isAdmissible && from === "retest")
		return `MEETS THE PUSH GATE FOR THE ${files.length} NAMED TEST(S) — a green here vouches for each at any commit where nothing that test reads has changed; it covers no path a test it did not run reads (workflow-core#1860).`;
	if (isAdmissible)
		return [
			`MEETS THE PUSH GATE — every reader of the diff was selected from ${EDGES_FILE} and from the read graph this tree renders now (workflow-core#998), so a green here is the whole gate: no whole-suite run is owed (mantahostels#2207).`,
			`  The marker is keyed to HEAD as this run ENDS and to what each test read: the commit you make from this tree is covered without a re-run wherever every file the push's range changes lies in this run's diff or a neighbour's green (ADR-0009) and each test reading it still holds — nothing it reads changed between the two trees (workflow-core#1860). The push then says \`attested by tree\`, and \`${commandOrDefault("push_check")}\` says so before it, or names the tests to re-run.`,
			"  It does not cover a test that reads a changed document through an imported HELPER — the manifest's extractor is lexical, so there is no edge to select on and this check cannot see one missing (mantahostels#2131).",
		].join("\n");
	return `NOT ADMISSIBLE — the read graph could not be rendered from this tree (${renderError}), so readers were selected from ${EDGES_FILE} alone and this run certifies nothing; re-run once \`node ${EDGES_SCRIPT} --check\` renders (workflow-core#998).`;
}

/**
 * `merge-base(HEAD, <pushed ref>)`, or `HEAD` where that ref does not exist or
 * the merge-base cannot be resolved (an unrelated history, a wedged git). The
 * pushed ref is lib/landing-refs.js's `pushedRef`.
 *
 * @param {string} root
 * @param {ExecFn} execFn
 * @returns {string}
 */
function defaultChangedBase(root, execFn) {
	const ref = pushedRef({ root });
	try {
		execFn("git", ["rev-parse", "--verify", "--quiet", ref], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: GIT_TIMEOUT_MS,
		});
	} catch {
		return "HEAD";
	}
	try {
		const out = execFn("git", ["merge-base", "HEAD", ref], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: GIT_TIMEOUT_MS,
		});
		const sha = String(out ?? "").trim();
		return sha || "HEAD";
	} catch {
		return "HEAD";
	}
}

/**
 * Why the default's narrowing would be worthless for this diff, or null
 * where it narrows fine. Checked BEFORE vitest's own listing runs, so an
 * escalation never pays for a probe it is about to discard.
 *
 * THE THREE REASONS MATCH `FULL_REASONS` IN lib/test-pass-marker.js (mantahostels#3207):
 * `"stale-manifest"` (`docs/test-read-edges.json` is unreadable or the read
 * graph could not be rendered from this tree, workflow-core#998), `"dependency-root"` (the
 * diff touches `package.json` outside the narrowing allow-list
 * mantahostels#2160 exempts), and
 * `"expansion-failed"` (the diff against `ref` could not even be read —
 * checked here — or run-vitest.js's `runDefault`'s later call into `expandChanged` finds
 * that `git diff` succeeded but its own `vitest list` probe threw, mantahostels#3251).
 *
 * `changed` is the own-work path set (workflow-core#1216) where the resolver gave one, read
 * in place of the diff.
 *
 * @param {string} root
 * @param {string} ref
 * @param {{ execFn?: ExecFn, loadEdges?: () => unknown,
 *   renderEdges?: () => unknown, changed?: string[] }} [options]
 * @returns {"stale-manifest"|"dependency-root"|"expansion-failed"|null}
 */
function defaultEscalationReason(
	root,
	ref,
	{
		execFn = execFileSync,
		loadEdges = () => committedEdges(root),
		renderEdges = () => liveEdges(root),
		changed: given,
	} = {},
) {
	try {
		loadEdges();
		renderEdges();
	} catch {
		return "stale-manifest";
	}
	/** @type {string[]} */
	let changed;
	try {
		changed = given ?? changedPaths(root, ref, execFn);
	} catch {
		return "expansion-failed";
	}
	if (
		changed.includes(PACKAGE_JSON) &&
		!packageJsonNarrowable(changed, { root, ref, execFn, fs })
	)
		return "dependency-root";
	return null;
}

module.exports = {
	ADOPT_FLAG,
	CHANGED_FLAG,
	PACKAGE_JSON,
	adoptFlag,
	retestFlag,
	isRetestOnlyArgv,
	changedFlag,
	changedPaths,
	committedEdges,
	defaultChangedBase,
	defaultEscalationReason,
	diffNames,
	expandChanged,
	isChangedOnlyArgv,
	liveEdges,
};
