const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

const CI_RUNS = {
	shfmt: /\bshfmt\b|check-shfmt\.js/,
	ruffFormat: /\bruff\s+format\b/,
	ruffCheck: /\bruff\s+check\b/,
	shellcheck: /\bshellcheck\b/,
	actionlint: /\bactionlint\b/,
};

/** @typedef {keyof typeof CI_RUNS} CiTool */

/**
 * @param {string} root
 * @returns {Record<CiTool, string[]>}
 */
function readCiRuns(root) {
	const dir = path.join(root, ".github", "workflows");
	/** @type {string[]} */
	let files = [];
	try {
		files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
	} catch (e) {
		if (caught(e).code !== "ENOENT") throw e;
	}
	/** @type {Record<string, unknown>} */
	let scripts = {};
	try {
		scripts =
			JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
				.scripts ?? {};
	} catch (e) {
		if (caught(e).code !== "ENOENT") throw e;
	}
	/**
	 * @param {string} text
	 * @param {Set<string>} seen
	 * @returns {string}
	 */
	const expand = (text, seen) =>
		text.replace(/\bnpm\s+run(?:-script)?\s+([\w:.-]+)/g, (call, name) => {
			const body = scripts[name];
			if (typeof body !== "string" || seen.has(name)) return call;
			seen.add(name);
			return `${call} ${expand(body, seen)}`;
		});
	const tools = /** @type {CiTool[]} */ (Object.keys(CI_RUNS));
	const runs = /** @type {Record<CiTool, string[]>} */ (
		Object.fromEntries(tools.map((t) => [t, /** @type {string[]} */ ([])]))
	);
	for (const f of files) {
		const text = expand(
			fs
				.readFileSync(path.join(dir, f), "utf8")
				.split("\n")
				.filter((line) => !/^\s*#/.test(line))
				.join("\n"),
			new Set(),
		);
		for (const tool of tools)
			if (CI_RUNS[tool].test(text)) runs[tool].push(`.github/workflows/${f}`);
	}
	return runs;
}

if (require.main === module) {
	const tool = process.argv[2] ?? "";
	if (process.argv.length !== 3 || !Object.hasOwn(CI_RUNS, tool)) {
		writeFd(2, `usage: node ci-runs.js <${Object.keys(CI_RUNS).join("|")}>\n`);
		process.exit(2);
	}
	const runs = readCiRuns(process.cwd())[/** @type {CiTool} */ (tool)];
	writeFd(1, `ci:${runs.join(", ")}\n`);
}

module.exports = { readCiRuns };
