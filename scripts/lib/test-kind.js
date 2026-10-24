/*
 * test-kind.js — the core's one definition of a test file, in the three readings
 * its callers need (#2101).
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
 *
 * `JS_TEST_FILE` is a JS test file alone, what vitest.config.ts collects (#2545).
 * check-host-root.js's pattern asks another question and stays apart: it names
 * the suite's apparatus by basename.
 */

// Vitest's default include collects both forms (#2271).
const JS_TEST = String.raw`\.(?:test|spec)\.[cm]?[jt]sx?$`;
const JS_TEST_FILE = new RegExp(JS_TEST);
const PY_TEST = String.raw`(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$`;
// inject-test-rules.sh pre-filters on these words, `test` and `spec`: widen both together.
const SUPPORT_NAME = "(?:testkit|harness|fixture|stub|fake)";

const COLLECTED_TEST = new RegExp(
	String.raw`(?:${JS_TEST}|${PY_TEST}|(?:^|\/)[^/]+\.test\.py$)`,
);

/**
 * A test or spec file, anything under a `test/`, `tests/`, `fixtures/`,
 * `testkit/`, `testkits/`, `stubs/` or `fakes/` directory, a testkit, harness, fixture, stub or fake
 * module named for what it is, and pytest's `test_*.py`, `*_test.py` and
 * `conftest.py`.
 */
const TEST_KIND = new RegExp(
	String.raw`(?:${JS_TEST}|(?:^|\/)(?:tests?|fixtures|testkits?|stubs|fakes)\/|[-_.]${SUPPORT_NAME}\.[cm]?[jt]sx?$|(?:^|\/)${SUPPORT_NAME}(?:[-_.][^/]*)?\.[cm]?[jt]sx?$|${PY_TEST}|(?:^|\/)conftest\.py$)`,
);

/** @param {string} rel repo-relative, forward slashes */
const isTestKind = (rel) => TEST_KIND.test(rel);

module.exports = { COLLECTED_TEST, JS_TEST_FILE, isTestKind };
