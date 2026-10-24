/*
 * infer-commands.js — a repo's commands, `SCRIPT_NAMES`'s keys, found rather than asked (workflow-core#692): `package.json` scripts first, then
 * pytest config, then `*.test.js` files ⇒ `node --test`. Only `test` has the
 * two fallbacks. An empty repo gets none. `runsLintStaged` judges whether a
 * `check_staged` runs lint-staged, which init refuses (workflow-core#2587).
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { requiredGroup } = require("./regex-group.js");

/** The `package.json` script names each command is read from, first match
 *  wins. Past the command's own name, a guess at the common spelling. */
const SCRIPT_NAMES = {
	test: ["test"],
	lint: ["lint"],
	typecheck: ["typecheck", "type-check"],
	check: ["check"],
	check_staged: ["check:staged"],
	push_check: ["push:check"],
};

/* `npm init` writes this as the test script; it is no test command. */
const NPM_INIT_PLACEHOLDER = /no test specified/;

/**
 * Throws on a `package.json` that does not parse, which would otherwise read
 * as one naming no script.
 * @param {string} root
 */
function readPackage(root) {
	let text;
	try {
		text = fs.readFileSync(path.join(root, "package.json"), "utf8");
	} catch {
		return { scripts: {}, biome: false };
	}
	let pkg;
	try {
		pkg = JSON.parse(text);
	} catch (err) {
		throw new Error(
			`package.json does not parse, so no command can be inferred from it — fix it, or name each with --command: ${caught(err).message}`,
			{ cause: err },
		);
	}
	const scripts = pkg?.scripts;
	return {
		scripts: scripts && typeof scripts === "object" ? scripts : {},
		biome: ["dependencies", "devDependencies"].some(
			(k) => typeof pkg?.[k]?.["@biomejs/biome"] === "string",
		),
	};
}

/* A `biome check --staged` script and nothing more. Biome's --staged lints the
 * worktree's bytes of each staged path, so a `commit-paths.js --patch` commit
 * (workflow-core#801) is judged on a neighbour's unstaged hunks; the plugin's
 * biome-staged.js lints the index's (workflow-core#2429, workflow-core#2540). It runs the `biome` the
 * hook puts on PATH from `node_modules/.bin`, so only a `package.json`
 * declaring `@biomejs/biome` is rewritten; an `npx` fetching it is not.
 * Residual: any other script stays `npm run` — a composite one, another
 * runner, a flag value holding `.` or `/` or given after a space, a short
 * flag, and a write flag, whose fixes would land in biome-staged.js's
 * thrown-away extract (workflow-core#2590). */
const BIOME_STAGED =
	/^(?:npx\s+)?(?:@biomejs\/)?biome\s+check((?:\s+--[\w=-]+)+)\s*$/;

const BIOME_STAGED_COMMAND = 'node "$WFC_PLUGIN_ROOT"/scripts/biome-staged.js';

const WRITE_FLAGS = new Set([
	"--write",
	"--fix",
	"--unsafe",
	"--apply",
	"--apply-unsafe",
]);

/**
 * `check_staged` for a `check:staged` script. The adopter's hook shim exports
 * WFC_PLUGIN_ROOT.
 * @param {string} name
 * @param {string} script
 * @param {boolean} biome whether `package.json` declares `@biomejs/biome`
 * @returns {string}
 */
function checkStagedCommand(name, script, biome) {
	const kept = `npm run ${name}`;
	const m = BIOME_STAGED.exec(script.trim());
	if (!m || !biome) return kept;
	const flags = requiredGroup(m, 1, BIOME_STAGED).trim().split(/\s+/);
	if (!flags.includes("--staged") || flags.some((f) => WRITE_FLAGS.has(f)))
		return kept;
	const rest = flags.filter((f) => f !== "--staged");
	return [BIOME_STAGED_COMMAND, ...rest].join(" ");
}

/* For `runsLintStaged` (workflow-core#2583): a command is read through each `npm run`, `pnpm run`, `yarn run` or `bun run` it makes
 * into the script that names, so a script merely named `lint-staged` counts
 * only for what it runs. Residual: a runner's run-less shorthand
 * (`yarn <script>`), and a script reached through a shell file, are not
 * followed. */
const LINT_STAGED = /(?:^|[\s;&|(/"'])lint-staged(?=$|[\s;&|)@"'])/;
const RUN_SCRIPT =
	/\b(?:npm|pnpm|yarn|bun)(?:\s+(?!run\b)[^\s;&|]+)*?\s+run(?:-script)?(?:\s+-\S+)*\s+["']?([^\s;&|"']+)/g;

/**
 * Whether `command` runs lint-staged, itself or through a `package.json`
 * script it runs.
 * @param {string} root
 * @param {string} command
 * @returns {boolean}
 */
function runsLintStaged(root, command) {
	const { scripts } = readPackage(root);
	const seen = new Set();
	/** @param {string} text */
	const runs = (text) => {
		if (LINT_STAGED.test(text.replace(RUN_SCRIPT, " "))) return true;
		for (const m of text.matchAll(RUN_SCRIPT)) {
			const name = requiredGroup(m, 1, RUN_SCRIPT);
			if (seen.has(name) || typeof scripts[name] !== "string") continue;
			seen.add(name);
			if (runs(scripts[name])) return true;
		}
		return false;
	};
	return runs(command);
}

/** @param {string} root */
function hasPytestConfig(root) {
	/** @type {[string, RegExp|null][]} */
	const files = [
		["pytest.ini", null],
		["pyproject.toml", /^\[tool\.pytest\.ini_options\]/m],
		["setup.cfg", /^\[tool:pytest\]/m],
		["tox.ini", /^\[pytest\]/m],
	];
	return files.some(([file, section]) => {
		try {
			const text = fs.readFileSync(path.join(root, file), "utf8");
			return section === null || section.test(text);
		} catch {
			return false;
		}
	});
}

/* node --test's own default patterns, the `.js` family. Dot-directories and
 * `node_modules` are skipped, as node --test skips them. */
const NODE_TEST_FILE = /\.test\.[cm]?js$/;

/**
 * @param {string} dir
 * @returns {boolean}
 */
function hasNodeTestFile(dir) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return false;
	}
	for (const e of entries) {
		if (e.isFile() && NODE_TEST_FILE.test(e.name)) return true;
	}
	return entries.some(
		(e) =>
			e.isDirectory() &&
			!e.name.startsWith(".") &&
			e.name !== "node_modules" &&
			hasNodeTestFile(path.join(dir, e.name)),
	);
}

/**
 * @param {string} root
 * @returns {Partial<Record<keyof typeof SCRIPT_NAMES, {command: string, from: string}>>}
 */
function inferCommands(root) {
	const { scripts, biome } = readPackage(root);
	/** @type {Partial<Record<keyof typeof SCRIPT_NAMES, {command: string, from: string}>>} */
	const found = {};
	for (const [command, names] of Object.entries(SCRIPT_NAMES)) {
		const name = names.find(
			(n) =>
				typeof scripts[n] === "string" &&
				scripts[n].trim() &&
				!(n === "test" && NPM_INIT_PLACEHOLDER.test(scripts[n])),
		);
		if (name)
			found[/** @type {keyof typeof SCRIPT_NAMES} */ (command)] = {
				command:
					command === "check_staged"
						? checkStagedCommand(name, scripts[name], biome)
						: `npm run ${name}`,
				from: "package.json",
			};
	}
	if (!found.test && hasPytestConfig(root))
		found.test = { command: "python3 -m pytest", from: "pytest config" };
	else if (!found.test && hasNodeTestFile(root))
		found.test = { command: "node --test", from: "*.test.js files" };
	return found;
}

module.exports = { inferCommands, runsLintStaged, BIOME_STAGED_COMMAND };
