/*
 * resolve-core.js — finds the workflow-core directory an adopter's checks and
 * tests import the helper surface from (#457), and that its husky hook shims
 * run (#1839). Core-owned in every adopter: init and upgrade copy it
 * (core-owned-files.js). resolve_core.py, beside it where the adopter has
 * Python code (#465), is copied once and never re-synced.
 *
 * FROZEN: a change to its lookup, its export or its variable names is a major
 * release with a migration note. A linked worktree with no row of its own
 * taking its main checkout's is, on #4117's judgement call, no lookup change:
 * the adopter root means the main checkout (adopterRoot), and an exact row
 * still wins. It requires node builtins only, because it runs before the core
 * is found.
 *
 * LOOKUP, first hit wins:
 *   1. WORKFLOW_CORE_DIR — an explicit override, for a test or an unusual layout.
 *   2. WORKFLOW_CORE_CHECKOUT — where CI checked the core out, at the pin.
 *      The workflow steps: docs/agents/helper-surface.md.
 *   3. The installed plugin: the last `workflow-core@<marketplace>` row of
 *      `<config>/plugins/installed_plugins.json` whose `projectPath` is the
 *      adopter root as spelt, else, where the root is a checkout's top level,
 *      that checkout's main checkout as git spells it, the marketplace read
 *      from the pin in the root's `.claude/settings.json` — the read
 *      plugin-state.js makes. git is asked only where the root as spelt has no
 *      row. So a linked worktree resolves through its main checkout, and so
 *      does a main checkout's root spelt through a symlink or with a trailing
 *      slash (#4150). `<config>` is CLAUDE_CONFIG_DIR, else ~/.claude, so a
 *      git hook or an npm script run outside any session resolves too.
 * A variable that is set but names no directory fails rather than falling
 * through: it was set to be used.
 *
 * Only the installed plugin can drift from the pin — CI checks the pin out
 * itself, and an override is deliberate — so only it is compared: a version
 * other than the pinned tag warns and still resolves.
 *
 * RUN AS A SCRIPT, it runs a core script with the rest of its argv and exits as
 * that script did — how an adopter's npm scripts reach a core runner (#552):
 *   node scripts/lib/resolve-core.js scripts/run-vitest.js --changed
 * An adopter holding a copy from before this form re-copies it.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const PLUGIN = "workflow-core";
const OVERRIDE = "WORKFLOW_CORE_DIR";
const CHECKOUT = "WORKFLOW_CORE_CHECKOUT";
/* plugin-state.js's TAG_REF: a branch or a SHA names no version to compare. */
const TAG_REF = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * `any` because the CLI writes these files, not the core, and every read
 * narrows through `?.`. A missing file and a corrupt one both read null: either
 * way the caller fails naming the file.
 * @param {string} at
 * @returns {any}
 */
function readJson(at) {
	try {
		return JSON.parse(fs.readFileSync(at, "utf8"));
	} catch {
		return null;
	}
}

/** @param {string} dir */
function isDir(dir) {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The main checkout and the top level of the tree `options` runs git in, or
 * null where that is no git checkout. A common dir not named `.git` — a
 * submodule's, a `--separate-git-dir` one — sits outside the tree, so the top
 * level answers for the main checkout there.
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv}} [options]
 * @returns {{main: string, top: string} | null}
 */
function readGitRoots({ cwd, env } = {}) {
	let out;
	try {
		out = execFileSync(
			"git",
			[
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
				"--show-toplevel",
			],
			{ cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
	} catch {
		/* Not a git checkout, or no git to ask: the caller's own directory is
		 * the only root left, and a miss still fails naming it (#4117). */
		return null;
	}
	const [common, top] = out.trim().split("\n");
	if (common === undefined || top === undefined)
		throw new Error(`git rev-parse printed fewer than two lines: ${out}`);
	return {
		main: path.basename(common) === ".git" ? path.dirname(common) : top,
		top,
	};
}

/*
 * The main checkout, even from a linked worktree: the install record is keyed
 * on the tree the plugin was installed for. Outside a git checkout the cwd is
 * the only root left, and a miss still fails naming it.
 */
function adopterRoot() {
	return readGitRoots()?.main ?? process.cwd();
}

/**
 * The main checkout of `root`, which a program passing its own tree spells as
 * the linked worktree it runs in (#4117). A hook's GIT_DIR must not answer for
 * a directory named outright, and a directory that is no tree's top level is
 * no checkout: it answers for itself.
 * @param {string} root
 * @returns {string}
 */
function readMainCheckout(root) {
	const env = { ...process.env };
	for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"])
		delete env[name];
	const roots = readGitRoots({ cwd: root, env });
	return roots && fs.realpathSync(roots.top) === fs.realpathSync(root)
		? roots.main
		: root;
}

/**
 * @param {string} root
 * @returns {{marketplace: string|null, ref: string|null}}
 */
function readPin(root) {
	const settings = readJson(path.join(root, ".claude", "settings.json"));
	const raw = settings?.extraKnownMarketplaces;
	/* Own keys of a plain object only: `in` would count `constructor`, match an
	 * array's indices and throw on a string (#474). */
	const known =
		raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
	for (const key of Object.keys(settings?.enabledPlugins ?? {})) {
		const [name, marketplace] = key.split("@");
		if (name === PLUGIN && marketplace && Object.hasOwn(known, marketplace))
			return { marketplace, ref: known[marketplace]?.source?.ref ?? null };
	}
	return { marketplace: null, ref: null };
}

/**
 * The install rows for `root`, else for its main checkout, and what was
 * searched. An exact row spawns no git (#4150). `any` for readJson's reason:
 * the CLI writes the record, and every row read narrows through `?.`.
 * @param {any} entries
 * @param {string} root
 * @returns {{rows: any[], searched: string}}
 */
function readInstallRows(entries, root) {
	/** @param {string} tree */
	const rowsFor = (tree) =>
		Array.isArray(entries)
			? entries.filter((row) => row?.projectPath === tree)
			: [];
	const own = rowsFor(root);
	if (own.length > 0) return { rows: own, searched: root };
	const main = readMainCheckout(root);
	return main === root
		? { rows: [], searched: root }
		: { rows: rowsFor(main), searched: `${root} or ${main}` };
}

/**
 * The core's directory. Throws, naming the pin and what was missing, where no
 * directory is found.
 * @param {{root?: string, env?: Record<string, string|undefined>,
 *   warn?: (line: string) => void}} [options]
 * @returns {string}
 */
function resolveCore({
	root = adopterRoot(),
	env = process.env,
	warn = (line) => process.stderr.write(`${line}\n`),
} = {}) {
	const { marketplace, ref } = readPin(root);
	const pin = ref ?? "none";
	/** @param {string} missing @returns {never} */
	const fail = (missing) => {
		throw new Error(
			`resolve-core: no ${PLUGIN} directory for pin ${pin} — ${missing}`,
		);
	};

	for (const name of [OVERRIDE, CHECKOUT]) {
		const dir = env[name];
		if (!dir) continue;
		if (!isDir(dir)) fail(`${name} names ${dir}, which is not a directory`);
		return path.resolve(dir);
	}

	const unset = `${OVERRIDE} and ${CHECKOUT} are unset`;
	if (!marketplace)
		fail(
			`${unset}, and ${path.join(root, ".claude", "settings.json")} enables no ${PLUGIN} from a known marketplace`,
		);
	const config = env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
	const record = path.join(config, "plugins", "installed_plugins.json");
	const key = `${PLUGIN}@${marketplace}`;
	const { rows, searched } = readInstallRows(
		readJson(record)?.plugins?.[key],
		root,
	);
	const installPath = rows.at(-1)?.installPath;
	if (!installPath)
		fail(`${unset}, and ${record} records no ${key} install for ${searched}`);
	if (!isDir(installPath))
		fail(`${record} records ${installPath}, which is not a directory`);

	const version = readJson(
		path.join(installPath, ".claude-plugin", "plugin.json"),
	)?.version;
	if (
		TAG_REF.test(pin) &&
		typeof version === "string" &&
		version.replace(/^v/, "") !== pin.replace(/^v/, "")
	)
		warn(
			`resolve-core: the installed ${PLUGIN} is ${version}, not the pinned ${pin} — local results can differ from CI's until the install catches up`,
		);
	return installPath;
}

/**
 * Runs `<core>/<script>` with `args`, inheriting stdio and the environment.
 * @param {string[]} argv the script, core-relative, then its arguments
 * @returns {number} the exit status to leave with
 */
function runCore([script, ...args]) {
	if (!script) {
		process.stderr.write(
			"resolve-core: name the core script to run, core-relative, then its arguments\n",
		);
		return 2;
	}
	let core;
	try {
		core = resolveCore();
	} catch (err) {
		/* Narrowed in place: an adopter's copy of this file has no core to
		 * require caught.js from until this call succeeds. */
		process.stderr.write(
			`${err instanceof Error ? err.message : String(err)}\n`,
		);
		return 1;
	}
	const r = spawnSync(process.execPath, [path.join(core, script), ...args], {
		stdio: "inherit",
	});
	if (r.error) {
		process.stderr.write(`resolve-core: ${r.error.message}\n`);
		return 1;
	}
	/* Died on a signal: die on the same one, so npm reports it as such. */
	if (r.signal) process.kill(process.pid, r.signal);
	return r.status ?? 1;
}

module.exports = { resolveCore };

if (require.main === module) process.exitCode = runCore(process.argv.slice(2));
