/*
 * ci-runs.js — which workflows under .github/workflows/ run each commit-gate
 * tool, so a gate that skips a missing tool can say truly whether CI catches
 * what it let through (workflow-core#1463, workflow-core#1563, workflow-core#1629).
 *
 * Run as a program it is precommit-gate.sh's tool_gate reading:
 *
 *   node scripts/lib/ci-runs.js <tool>   `ci:` and the workflows running it,
 *                                        comma-separated, so the hook tells
 *                                        none from a crash
 *
 * The read is lexical — a non-comment line naming the tool, or an `npm run`
 * of a package.json script that does — so a step that names shellcheck
 * without running it, as a download URL does, counts as running it.
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");

/** What a workflow line runs for each tool, once `npm run`s are expanded. */
const CI_RUNS = {
	shfmt: /\bshfmt\b|check-shfmt\.js/,
	ruffFormat: /\bruff\s+format\b/,
	ruffCheck: /\bruff\s+check\b/,
	shellcheck: /\bshellcheck\b/,
	actionlint: /\bactionlint\b/,
};

/** @typedef {keyof typeof CI_RUNS} CiTool */

/**
 * The workflows under `root`'s .github/workflows/ that run each CI_RUNS tool.
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
	 * @param {Set<string>} seen accumulator: the scripts already expanded
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
