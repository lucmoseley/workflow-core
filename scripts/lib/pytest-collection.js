const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { pythonBin } = require("./python-bin.js");
const { requiredGroup } = require("./regex-group.js");
const { PYTEST_DEFAULT_FILES } = require("./test-kind.js");

/** @typedef {import("./dirty-tree.js").ExecFn} ExecFn */

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

const PYTEST_CONFIGS = [
	["pytest.ini", null],
	[".pytest.ini", null],
	["pyproject.toml", "tool.pytest.ini_options"],
	["tox.ini", "pytest"],
	["setup.cfg", "tool:pytest"],
];

const INI_HEAD = /^\[(.+)\]\s*$/;
const INI_KEY = /^([\w-]+)\s*[=:]\s*(\S.*|)$/;

/**
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
 * @param {Record<string, string[]>} keys
 * @param {string} key
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

const PYPROJECT_OPTIONS = [
	"import json, sys, tomllib",
	"t = tomllib.load(open(sys.argv[1], 'rb'))",
	"print(json.dumps(t.get('tool', {}).get('pytest', {}).get('ini_options', {})))",
].join("\n");

/**
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
