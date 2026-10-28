/*
 * test-kind.js — the core's one definition of a test file, in the readings its
 * callers need (#2101).
 *
 * `isTestKind` is what base §X binds: §0's test kind, `.spec.` files included
 * (#2109), widened to test support by base §G6 (#1361), and Python's test
 * shapes (#1743). The standards checker, the architecture-scan counter and the
 * test-rules injector all read it, so a file one calls a test the others never
 * treat as code.
 *
 * `COLLECTED_TEST` is narrower: a file a runner collects as a test, which is what
 * makes a repo hold a suite for gate-subjects.js. It leaves out support, which
 * no runner collects, and adds design-vault's `*.test.py`, which its own
 * runner does and which reaches §X through a local route row (#1266).
 * `isCollectedTestOrConftest` adds pytest's `conftest.py`, which no runner
 * collects but every pytest run loads: the files needle-corpus.js never counts
 * as a guard's printer (#2655), plugin-tree.js never ships and check-doc-map.js
 * leaves out of its section-reference check (#2759). `PY_COLLECTED_TEST` is
 * `COLLECTED_TEST`'s Python half, the scripts suite-launch.js counts as a suite.
 *
 * `JS_TEST_FILE` is a JS test file alone, what vitest.config.ts collects (#2545):
 * the guard-<name> or check-<name> file check-registrations.js and
 * registry-atomicity.js never count as a guard or checker and file-claim.js
 * never points at guard-authoring (#2869, #3012), and the test files the
 * isolation and fixture-identity checkers read;
 * `PY_TEST_FILE` is a pytest test file alone, pytest's default `python_files`.
 * `isJsTestFile` is `JS_TEST_FILE` as a predicate. .husky/pre-commit's
 * test-file gates arm on it written in grep's ERE, pinned equal by
 * test-kind.test.ts. `siblingTests` is every name a test of one
 * script may take, by `JS_TEST_FILE` and `PY_COLLECTED_TEST`: the files
 * registrations.js, registry-atomicity.js and doc-map.js's self-filter take as
 * a script's own test; `pytestSiblings` is its pytest half, touched-tests.js's.
 * check-host-root.js adds the suite's apparatus to `JS_TEST_FILE`.
 *
 * One reading asks another runner's question and stays apart:
 * infer-commands.js's `NODE_TEST_FILE` is node --test's own default patterns,
 * which take `test/**` and `*-test.js` and no `.spec.` form.
 */

// Vitest's default include collects both forms (#2271).
const JS_TEST_SOURCE = String.raw`\.(?:test|spec)\.[cm]?[jt]sx?$`;
const JS_TEST_FILE = new RegExp(JS_TEST_SOURCE);
/* `JS_TEST_SOURCE`'s parts, spelt out. */
const JS_TEST_PARTS = {
	kind: ["test", "spec"],
	module: ["", "c", "m"],
	lang: ["j", "t"],
	jsx: ["", "x"],
};
const JS_TEST_SUFFIXES = JS_TEST_PARTS.kind.flatMap((kind) =>
	JS_TEST_PARTS.module.flatMap((module) =>
		JS_TEST_PARTS.lang.flatMap((lang) =>
			JS_TEST_PARTS.jsx.map((jsx) => `.${kind}.${module}${lang}s${jsx}`),
		),
	),
);
const PY_TEST = String.raw`(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$`;
const PY_TEST_FILE = new RegExp(PY_TEST);
/* `PY_TEST` as globs: pytest's default `python_files`. */
const PYTEST_DEFAULT_FILES = ["test_*.py", "*_test.py"];
const CONFTEST = /(?:^|\/)conftest\.py$/;
const SUPPORT_NAME = "(?:testkit|harness|fixture|stub|fake)";

const PY_COLLECTED_SOURCE = String.raw`${PY_TEST}|(?:^|\/)[^/]+\.test\.py$`;
const PY_COLLECTED_TEST = new RegExp(PY_COLLECTED_SOURCE);
const COLLECTED_TEST = new RegExp(
	`(?:${JS_TEST_SOURCE}|${PY_COLLECTED_SOURCE})`,
);

/**
 * A test or spec file, anything under a `test/`, `tests/`, `fixtures/`,
 * `testkit/`, `testkits/`, `stubs/` or `fakes/` directory, a testkit, harness, fixture, stub or fake
 * module named for what it is, and pytest's `test_*.py`, `*_test.py` and
 * `conftest.py`.
 */
const TEST_KIND = new RegExp(
	String.raw`(?:${JS_TEST_SOURCE}|(?:^|\/)(?:tests?|fixtures|testkits?|stubs|fakes)\/|[-_.]${SUPPORT_NAME}\.[cm]?[jt]sx?$|(?:^|\/)${SUPPORT_NAME}(?:[-_.][^/]*)?\.[cm]?[jt]sx?$|${PY_TEST}|${CONFTEST.source})`,
);

/** @param {string} rel repo-relative or a basename, forward slashes */
const isJsTestFile = (rel) => JS_TEST_FILE.test(rel);

/**
 * The pytest test names of `stem`, by its default `python_files`.
 * @param {string} stem a basename without its extension
 */
const pytestSiblings = (stem) =>
	PYTEST_DEFAULT_FILES.map((glob) => glob.replace("*", stem));

/**
 * `stem` split at its last slash, the directory keeping it.
 * @param {string} stem
 */
const splitStem = (stem) => {
	const slash = stem.lastIndexOf("/") + 1;
	return { dir: stem.slice(0, slash), base: stem.slice(slash) };
};

/**
 * Every path a test of the script at `stem` may take.
 * @param {string} stem the script's path without its extension, forward slashes
 */
function siblingTests(stem) {
	const { dir, base } = splitStem(stem);
	return [
		...JS_TEST_SUFFIXES.map((s) => `${stem}${s}`),
		...pytestSiblings(base).map((n) => `${dir}${n}`),
		`${stem}.test.py`,
	];
}

/**
 * `siblingTests` as a refusal spells it.
 * @param {string} stem
 */
function spellSiblingTests(stem) {
	const { dir, base } = splitStem(stem);
	const { kind, module, lang, jsx } = JS_TEST_PARTS;
	return `${stem}.{${kind}}.{${module}}{${lang}}s{${jsx}}, ${pytestSiblings(
		base,
	)
		.map((n) => `${dir}${n}`)
		.join(", ")} or ${stem}.test.py`;
}

/** @param {string} rel repo-relative, forward slashes */
const isTestKind = (rel) => TEST_KIND.test(rel);

/** @param {string} rel repo-relative or a basename, forward slashes */
const isCollectedTestOrConftest = (rel) =>
	COLLECTED_TEST.test(rel) || CONFTEST.test(rel);

module.exports = {
	COLLECTED_TEST,
	JS_TEST_FILE,
	PY_COLLECTED_TEST,
	PY_TEST_FILE,
	PYTEST_DEFAULT_FILES,
	isCollectedTestOrConftest,
	isJsTestFile,
	isTestKind,
	pytestSiblings,
	siblingTests,
	spellSiblingTests,
};
