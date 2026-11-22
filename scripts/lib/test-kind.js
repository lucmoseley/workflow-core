// Vitest's default include collects both kinds: https://vitest.dev/config/#include
const JS_TEST_KINDS = ["test", "spec"];
const JS_EXT_PARTS = [["", "c", "m"], ["j", "t"], ["s"], ["", "x"]];
/** @param {string[]} chars */
const buildCharClass = (chars) => {
	const set = chars.filter(Boolean);
	const one = set.length === 1 ? set[0] : `[${set.join("")}]`;
	return chars.includes("") ? `${one}?` : one;
};
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
// pytest's default `python_files`: https://docs.pytest.org/en/stable/reference/reference.html#confval-python_files
const PYTEST_DEFAULT_FILES = ["test_*.py", "*_test.py"];
const CONFTEST = /(?:^|\/)conftest\.py$/;
const SUPPORT_NAME = "(?:testkit|harness|fixture|stub|fake)";

const PY_COLLECTED_SOURCE = String.raw`${PY_TEST}|(?:^|\/)[^/]+\.test\.py$`;
const PY_COLLECTED_TEST = new RegExp(PY_COLLECTED_SOURCE);
const COLLECTED_TEST = new RegExp(
	`(?:${JS_TEST_SOURCE}|${PY_COLLECTED_SOURCE})`,
);

const TEST_KIND = new RegExp(
	String.raw`(?:${JS_TEST_SOURCE}|(?:^|\/)(?:tests?|fixtures|testkits?|stubs|fakes)\/|[-_.]${SUPPORT_NAME}${JS_EXT_SOURCE}$|(?:^|\/)${SUPPORT_NAME}(?:[-_.][^/]*)?${JS_EXT_SOURCE}$|${PY_TEST}|${CONFTEST.source})`,
);

const JS_EXT_SET = new Set(JS_EXTENSIONS.map((ext) => `.${ext}`));
/** @param {string} ext */
const isJsExt = (ext) => JS_EXT_SET.has(ext);

/** @param {string} rel */
const isJsTestFile = (rel) => JS_TEST_FILE.test(rel);

/**
 * @param {string} rel
 * @param {string} infix
 */
const buildInfixTestName = (rel, infix) =>
	isJsTestFile(rel)
		? rel.replace(JS_TEST_FILE, (suffix) => `.${infix}${suffix}`)
		: null;

/** @param {string} stem */
const pytestSiblings = (stem) =>
	PYTEST_DEFAULT_FILES.map((glob) => glob.replace("*", stem));

/** @param {string} stem */
const splitStem = (stem) => {
	const slash = stem.lastIndexOf("/") + 1;
	return { dir: stem.slice(0, slash), base: stem.slice(slash) };
};

/** @param {string} stem */
function siblingTests(stem) {
	const { dir, base } = splitStem(stem);
	return [
		...JS_TEST_SUFFIXES.map((s) => `${stem}${s}`),
		...pytestSiblings(base).map((n) => `${dir}${n}`),
		`${stem}.test.py`,
	];
}

/** @param {string} stem */
function spellSiblingTests(stem) {
	const { dir, base } = splitStem(stem);
	const ext = JS_EXT_PARTS.map((part) =>
		part.length === 1 ? part[0] : `{${part}}`,
	).join("");
	return `${stem}.{${JS_TEST_KINDS}}.${ext}, ${pytestSiblings(base)
		.map((n) => `${dir}${n}`)
		.join(", ")} or ${stem}.test.py`;
}

/** @param {string} rel */
const isTestKind = (rel) => TEST_KIND.test(rel);

/** @param {string} rel */
const isCollectedTestOrConftest = (rel) =>
	COLLECTED_TEST.test(rel) || CONFTEST.test(rel);

module.exports = {
	COLLECTED_TEST,
	JS_EXT_SOURCE,
	JS_TEST_FILE,
	PY_COLLECTED_TEST,
	PY_TEST_FILE,
	PYTEST_DEFAULT_FILES,
	isCollectedTestOrConftest,
	isJsExt,
	isJsTestFile,
	buildInfixTestName,
	isTestKind,
	pytestSiblings,
	siblingTests,
	spellSiblingTests,
};
