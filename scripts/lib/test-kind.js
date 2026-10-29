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
 * never points at guard-authoring (#2869, #3012), the test files the
 * isolation and fixture-identity checkers read and check-jsonl-reads.js
 * skips, and the suffix `buildInfixTestName` keeps, for the copy arm-tasks.js
 * makes of a hidden test;
 * `PY_TEST_FILE` is a pytest test file alone, pytest's default `python_files`.
 * `isJsTestFile` is `JS_TEST_FILE` as a predicate. .husky/pre-commit's
 * test-file gates arm on its `JS_TEST_ERE`, `JS_TEST_FILE` in grep's ERE,
 * pinned equal by test-kind.test.ts. `siblingTests` is every name a test of one
 * script may take, by `JS_TEST_FILE` and `PY_COLLECTED_TEST`: the files
 * registrations.js (and through its `buildMissingSiblingNames` the core's hook-
 * and checker-registrations tests), registry-atomicity.js and doc-map.js's
 * self-filter take as a script's own test; `pytestSiblings` is its pytest half, touched-tests.js's.
 * check-host-root.js adds the suite's apparatus to `JS_TEST_FILE`, on
 * `JS_EXT_SOURCE`, every JS or TS extension, and scans `JS_EXTENSIONS`, the
 * same family listed.
 *
 * One reading asks another runner's question and stays apart:
 * infer-commands.js's `NODE_TEST_FILE` is the `.js` family of node --test's own
 * default patterns, which take `test/**` and `*-test.js` and no `.spec.` form;
 * their `.ts` family is left out, for the reason infer-commands.js gives.
 */

// Vitest's default include collects both kinds (#2271). Each part of the
// extension after the kind, in order.
const JS_TEST_KINDS = ["test", "spec"];
const JS_EXT_PARTS = [["", "c", "m"], ["j", "t"], ["s"], ["", "x"]];
/**
 * A part of single characters as a character class, `?` where it may be empty.
 * @param {string[]} chars
 */
const buildCharClass = (chars) => {
	const set = chars.filter(Boolean);
	const one = set.length === 1 ? set[0] : `[${set.join("")}]`;
	return chars.includes("") ? `${one}?` : one;
};
/* `\.[cm]?[jt]sx?`, every JS or TS extension. */
const JS_EXT_SOURCE = String.raw`\.${JS_EXT_PARTS.map(buildCharClass).join("")}`;
const JS_TEST_SOURCE = String.raw`\.(?:${JS_TEST_KINDS.join("|")})${JS_EXT_SOURCE}$`;
const JS_TEST_FILE = new RegExp(JS_TEST_SOURCE);
const JS_EXTENSIONS = JS_EXT_PARTS.reduce(
	(heads, part) => heads.flatMap((head) => part.map((c) => head + c)),
	[""],
);
const JS_TEST_SUFFIXES = JS_TEST_KINDS.flatMap((kind) =>
	JS_EXTENSIONS.map((ext) => `.${kind}.${ext}`),
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
	String.raw`(?:${JS_TEST_SOURCE}|(?:^|\/)(?:tests?|fixtures|testkits?|stubs|fakes)\/|[-_.]${SUPPORT_NAME}${JS_EXT_SOURCE}$|(?:^|\/)${SUPPORT_NAME}(?:[-_.][^/]*)?${JS_EXT_SOURCE}$|${PY_TEST}|${CONFTEST.source})`,
);

/** @param {string} rel repo-relative or a basename, forward slashes */
const isJsTestFile = (rel) => JS_TEST_FILE.test(rel);

/**
 * `rel` with `.<infix>` before its `JS_TEST_FILE` suffix, a test of the same
 * form beside it, or null where `rel` is no JS test file.
 * @param {string} rel
 * @param {string} infix
 */
const buildInfixTestName = (rel, infix) =>
	isJsTestFile(rel)
		? rel.replace(JS_TEST_FILE, (suffix) => `.${infix}${suffix}`)
		: null;

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
	const ext = JS_EXT_PARTS.map((part) =>
		part.length === 1 ? part[0] : `{${part}}`,
	).join("");
	return `${stem}.{${JS_TEST_KINDS}}.${ext}, ${pytestSiblings(base)
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
	JS_EXT_SOURCE,
	JS_EXTENSIONS,
	JS_TEST_FILE,
	PY_COLLECTED_TEST,
	PY_TEST_FILE,
	PYTEST_DEFAULT_FILES,
	isCollectedTestOrConftest,
	isJsTestFile,
	buildInfixTestName,
	isTestKind,
	pytestSiblings,
	siblingTests,
	spellSiblingTests,
};
