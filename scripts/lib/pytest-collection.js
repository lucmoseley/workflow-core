/*
 * pytest-collection.js — which of a set of test files pytest collects in a
 * tree (workflow-core#2952), read off its config rather than asked: named files, which
 * `pytest --collect-only` would collect whatever `testpaths` and
 * `python_files` say, cannot ask it.
 *
 * A config file that is present but unreadable throws, never widening to
 * pytest's defaults.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { pythonBin } = require("./python-bin.js");
const { requiredGroup } = require("./regex-group.js");
const { PYTEST_DEFAULT_FILES } = require("./test-kind.js");

/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */

/* pytest 9.1.1's documented `norecursedirs` default, the version
 * requirements-dev.txt pins (docs.pytest.org/en/stable/reference/reference.html#confval-norecursedirs). */
const PYTEST_DEFAULT_NORECURSE = [
	"*.egg",
	".*",
	"_darcs",
	"build",
	"CVS",
	"dist",
	"node_modules",
	"venv",
	"{arch}",
];

/**
 * The config files pytest reads at its rootdir, in its own order, each with
 * the section that makes it count: pytest.ini and .pytest.ini count bare.
 */
const PYTEST_CONFIGS = [
	["pytest.ini", null],
	[".pytest.ini", null],
	["pyproject.toml", "tool.pytest.ini_options"],
	["tox.ini", "pytest"],
	["setup.cfg", "tool:pytest"],
];

const INI_HEAD = /^\[(.+)\]\s*$/;
const INI_KEY = /^([\w-]+)\s*[=:]\s*(.*)$/;

/**
 * `section`'s keys in ini `text`, each value split on whitespace; null where
 * `text` has no such section.
 *
 * @param {string} text
 * @param {string} section
 * @returns {Record<string, string[]>|null}
 */
function parseIniSection(text, section) {
	/** @type {Record<string, string[]>|null} */
	let keys = null;
	let current = "";
	let key = "";
	for (const line of text.split("\n")) {
		if (!line.trim() || /^\s*[#;]/.test(line)) continue;
		const head = INI_HEAD.exec(line);
		if (head) {
			current = requiredGroup(head, 1, INI_HEAD);
			key = "";
			if (current === section) keys ??= {};
		} else if (keys && current === section) key = foldIniLine(keys, key, line);
	}
	return keys;
}

/**
 * Folds one line of an ini section into `keys`, returning the key a
 * continuation line after it extends.
 *
 * @param {Record<string, string[]>} keys
 * @param {string} key the key the line before it set or extended
 * @param {string} line
 * @returns {string}
 */
function foldIniLine(keys, key, line) {
	const words = line.trim().split(/\s+/).filter(Boolean);
	if (/^\s/.test(line) && key) {
		keys[key]?.push(...words);
		return key;
	}
	const m = INI_KEY.exec(line);
	if (!m) return "";
	const name = requiredGroup(m, 1, INI_KEY);
	keys[name] = requiredGroup(m, 2, INI_KEY).split(/\s+/).filter(Boolean);
	return name;
}

/* pyproject's table through Python's own TOML reader. */
const PYPROJECT_OPTIONS = [
	"import json, sys, tomllib",
	"t = tomllib.load(open(sys.argv[1], 'rb'))",
	"print(json.dumps(t.get('tool', {}).get('pytest', {}).get('ini_options', {})))",
].join("\n");

/**
 * pyproject.toml's `[tool.pytest.ini_options]`, a string value split on
 * whitespace as pytest splits an ini one.
 *
 * @param {string} file
 * @param {ExecFn} execFn
 * @returns {Record<string, string[]>}
 */
function readPyprojectOptions(file, execFn) {
	const table = JSON.parse(
		String(
			execFn(pythonBin(), ["-I", "-c", PYPROJECT_OPTIONS, file], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}),
		),
	);
	return Object.fromEntries(
		Object.entries(table).map(([k, v]) => [
			k,
			Array.isArray(v) ? v.map(String) : String(v).split(/\s+/).filter(Boolean),
		]),
	);
}

/**
 * `file`'s text, or null where it is missing, as pytest reads a missing
 * config.
 *
 * @param {string} file
 * @returns {string|null}
 */
function readIfPresent(file) {
	try {
		return fs.readFileSync(file, "utf8");
	} catch (error) {
		if (caught(error).code === "ENOENT") return null;
		throw error;
	}
}

/**
 * The pytest config at `root`: the first of `PYTEST_CONFIGS` that counts,
 * read as pytest reads it; none where no file does.
 *
 * @param {string} root
 * @param {ExecFn} execFn
 * @returns {Record<string, string[]>}
 */
function readPytestConfig(root, execFn) {
	for (const [name, section] of PYTEST_CONFIGS) {
		const file = path.join(root, String(name));
		const text = readIfPresent(file);
		if (text === null) continue;
		if (name === "pyproject.toml") {
			if (/^\[tool\.pytest\.ini_options\]/m.test(text))
				return readPyprojectOptions(file, execFn);
			continue;
		}
		const keys = parseIniSection(text, section ?? "pytest");
		if (keys || section === null) return keys ?? {};
	}
	return {};
}

/**
 * A glob as a whole-string regex, `*` and `?` stopping at `/` and `**`
 * crossing it: fnmatch's reading for the basenames `python_files` and
 * `norecursedirs` match, and the recursive glob pytest expands `testpaths`
 * with.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
const buildGlobRegex = (glob) =>
	new RegExp(
		`^${glob.replace(
			/\*\*\/|\*\*|\*|\?|\[!|[.+^${}()|\\]/g,
			(t) =>
				({
					"**/": "(?:.*/)?",
					"**": ".*",
					"*": "[^/]*",
					"?": "[^/]",
					"[!": "[^",
				})[t] ?? `\\${t}`,
		)}$`,
	);

/**
 * Of `files`, those pytest collects in the tree at `root`: under a
 * `testpaths` entry, or anywhere where none is set; in no `norecursedirs`
 * directory below it; named by a `python_files` glob. An `--ignore` in
 * `addopts` and a conftest's `collect_ignore` are not read.
 *
 * @param {string} root
 * @param {string[]} files
 * @param {ExecFn} execFn
 * @returns {string[]}
 */
function pytestCollected(root, files, execFn) {
	if (files.length === 0) return files;
	const config = readPytestConfig(root, execFn);
	const names = (config.python_files ?? PYTEST_DEFAULT_FILES).map(
		buildGlobRegex,
	);
	const skip = (config.norecursedirs ?? PYTEST_DEFAULT_NORECURSE).map(
		buildGlobRegex,
	);
	const testpaths = (config.testpaths ?? []).map((p) =>
		buildGlobRegex(path.posix.normalize(p).replace(/\/$/, "")),
	);
	return files.filter((f) => {
		if (!names.some((re) => re.test(path.posix.basename(f)))) return false;
		const dirs = path.posix
			.dirname(f)
			.split("/")
			.filter((d) => d !== ".");
		/* How many leading segments the testpath holding `f` spans. */
		const held =
			testpaths.length === 0
				? 0
				: [
						".",
						...dirs.map((_, i) => dirs.slice(0, i + 1).join("/")),
					].findIndex((at) => testpaths.some((re) => re.test(at)));
		return (
			held !== -1 &&
			!dirs.slice(held).some((d) => skip.some((re) => re.test(d)))
		);
	});
}

module.exports = { pytestCollected };
