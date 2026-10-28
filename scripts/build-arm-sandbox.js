#!/usr/bin/env node
/*
 * build-arm-sandbox.js — the before/after test's two environments (#2042,
 * `docs/research/startup-load-before-after-test.md` D1, D2).
 *
 *   node scripts/build-arm-sandbox.js config --from <config dir> --to <new dir> [--override <path>=<file>]...
 *   node scripts/build-arm-sandbox.js task --repo <repo> --at <rev> --to <new dir>
 *       [--revert <sha>]... [--unapply <patch>]... [--issue <n>=<frozen issue json>]...
 *       [--node-modules <dir>]
 *       [--config-dir <arm config dir>]
 *
 * `config` builds an arm's config dir by COPYING the user-level layer, every
 * symlink dereferenced, so no file in it is a live one: a swap in a symlinked
 * dir would change every live session on the machine. Live config paths in
 * the copied settings and plugin registries are rewritten to the copy; any
 * left over are listed in `liveRefs`, for the pilot to read. Each `--override`
 * puts `<file>` at `<path>` inside the copy before that rewrite, as arm A's
 * pre-cut `CLAUDE.md`, settings and hooks. No credentials are copied — each arm
 * dir is logged in by the founder's Authorize click (D2 step 2).
 *
 * `task` builds one run's sandbox: a fresh clone at `--at` with every
 * `--revert`, then every `--unapply` patch in reverse, applied as one commit, whose `origin` is a local bare repo, and `bin/gh`, a stub
 * that logs every call and reaches nothing (`lib/arm-gh-stub.js`). It refuses a
 * target under any config dir's `jobs/` tree or a `.claude/worktrees` tree, where
 * lib/job-dir-scratch.js and the worktree rules would fire on every run, and a
 * `--revert` or `--unapply` that does not take at `--at`, leaving `--to` as it
 * was.
 * With `--node-modules` linked, the clone's own `npm run prepare` arms its git
 * hooks, so the commit gates and pre-push run as they do live. Launch the
 * session with `sandbox.env` sourced, cwd `<to>/repo`: it puts the stub first
 * on PATH, which is how a session's own `gh` reaches it, and sets `WFC_GH` for
 * the repo's scripts.
 *
 * With `--config-dir`, the arm config dir's `wfc-self` marketplace, and its
 * `extraKnownMarketplaces` declaration in `settings.json`, are pointed at the
 * clone's own `self-plugin/`, so the run loads the registration of the
 * revision under test and its canary finds the marker its own writer leaves
 * (#2440). The config dir is the arm's, shared by its runs: a session reads the
 * pointer at its start, so the next build re-points it without moving one
 * already running (#2295 §2a: plugin hooks do not reload live). Whether a
 * /clear or /compact re-reads it is unmeasured. Residual: whether a session
 * start re-reads the `settings.json` declaration is unmeasured too, so it is
 * pointed in case it does (#2630). Where the revision enables `wfc-self` and
 * the config dir registers no marketplace for it, the build is refused: that
 * run's canary would refuse its every call.
 *
 * Both print a JSON summary on stdout.
 *
 * IN NO §N3 FAMILY, DELIBERATELY: it gates nothing and files no issue, and it
 * writes sandboxes outside the repo rather than one file in it.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { readCommit } = require("./lib/commit-sha.js");
const { execGit, gitReader, spawnGitSync } = require("./lib/git.js");
const { resolveKey } = require("./lib/workflow-core-config.js");
const {
	readTrackerRemotes,
	fetchTrackerCommand,
} = require("./lib/tracker-remotes.js");
const { flagValue, parseOrExit } = require("./lib/cli-args");
const { writeFd } = require("./lib/write-fd.js");
const { jobStorePath } = require("./lib/job-paths.js");
const {
	SELF_PLUGIN_DIR,
	SELF_PLUGIN_ID,
	SELF_PLUGIN_MARKETPLACE,
	selfPluginSetup,
} = require("./lib/core-hooks.js");

const CONFIG_USAGE =
	"Usage: node scripts/build-arm-sandbox.js config --from <config dir> --to <new dir> [--override <path>=<file>]...";
const TASK_USAGE =
	"Usage: node scripts/build-arm-sandbox.js task --repo <repo> --at <rev> --to <new dir> [--revert <sha>]... [--unapply <patch>]... [--issue <n>=<file>]... [--node-modules <dir>] [--config-dir <arm config dir>]";

/** @type {import("./lib/cli-args").CliSpec} */
const CLI = {
	usage:
		"Usage: node scripts/build-arm-sandbox.js (config --from <dir> --to <dir> [--override <path>=<file>]... | task --repo <repo> --at <rev> --to <dir> [--revert <sha>]... [--unapply <patch>]... [--issue <n>=<file>]... [--node-modules <dir>] [--config-dir <dir>])",
	commands: {
		config: {
			usage: CONFIG_USAGE,
			flags: { "--from": "value", "--to": "value", "--override": "list" },
		},
		task: {
			usage: TASK_USAGE,
			flags: {
				"--repo": "value",
				"--at": "value",
				"--to": "value",
				"--revert": "list",
				"--unapply": "list",
				"--issue": "list",
				"--node-modules": "value",
				"--config-dir": "value",
			},
		},
	},
};

const CONFIG_ENTRIES = [
	"CLAUDE.md",
	"settings.json",
	"keybindings.json",
	"statusline.sh",
	"skills",
	"plugins",
	"hooks",
];

/** Copied files that name config-dir paths, rewritten to the copy; and every file under `hooks/`. */
const PATH_FILES = [
	"settings.json",
	"statusline.sh",
	"plugins/installed_plugins.json",
	"plugins/known_marketplaces.json",
];

/** @param {string} msg */
function refuse(msg) {
	writeFd(2, `✗ ${msg}\n`);
	return 1;
}

/** @param {string} dir */
function isEmptyOrAbsent(dir) {
	return !fs.existsSync(dir) || fs.readdirSync(dir).length === 0;
}

/**
 * Copy `src` to `dst` with every symlink replaced by what it points at. A
 * dangling link, or one that loops back into its own ancestry, is skipped and
 * named.
 * @param {string} src
 * @param {string} dst
 * @param {string[]} skipped accumulator: each link not copied is pushed here
 * @param {Set<string>} [ancestry] real paths of the directories being copied
 */
function copyDereferenced(src, dst, skipped, ancestry = new Set()) {
	const real = readRealOrNull(src);
	if (real === null) {
		skipped.push(src);
		return;
	}
	const stat = fs.statSync(real);
	if (!stat.isDirectory()) {
		fs.copyFileSync(real, dst);
		fs.chmodSync(dst, stat.mode & 0o777);
		return;
	}
	if (ancestry.has(real)) {
		skipped.push(src);
		return;
	}
	fs.mkdirSync(dst, { recursive: true });
	const inner = new Set(ancestry).add(real);
	for (const name of fs.readdirSync(real))
		copyDereferenced(
			path.join(real, name),
			path.join(dst, name),
			skipped,
			inner,
		);
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function readSymlinksUnder(dir) {
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isSymbolicLink()) out.push(p);
		else if (e.isDirectory()) out.push(...readSymlinksUnder(p));
	}
	return out;
}

/**
 * @param {string} p
 * @returns {string | null} null where `p` dangles or is absent
 */
function readRealOrNull(p) {
	try {
		return fs.realpathSync(p);
	} catch {
		// Fails open by design (#2042): a dangling link in a plugin cache is no
		// reason to stop the copy, and each one is printed in `skipped`.
		return null;
	}
}

/** @param {string} s */
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Copy each config entry into `dest`, from the source dir or, failing that,
 * from ~/.claude: settings.json names `$HOME/.claude/hooks`, which a config
 * dir other than ~/.claude does not carry itself.
 * @param {string} from
 * @param {string} userDir
 * @param {string} dest
 * @param {string[]} skipped accumulator: each link not copied is pushed here
 * @returns {Map<string, string>} each copied entry's real source path
 */
function copyEntries(from, userDir, dest, skipped) {
	const copied = new Map();
	for (const entry of CONFIG_ENTRIES) {
		const src = [path.join(from, entry), path.join(userDir, entry)].find((p) =>
			fs.existsSync(p),
		);
		if (!src) continue;
		copyDereferenced(src, path.join(dest, entry), skipped);
		copied.set(entry, fs.realpathSync(src));
	}
	return copied;
}

/**
 * Every spelling of a copied entry's live path, mapped to its copy: the real
 * path, each config dir linking to the same file (as ~/.claude2 and ~/.claude3
 * do), and the `$HOME` forms a hook command uses.
 * @param {Map<string, string>} copied
 * @param {string} from
 * @param {string} home
 * @param {string} dest
 * @returns {Map<string, string>}
 */
function liveAliases(copied, from, home, dest) {
	const configDirs = [
		path.resolve(from),
		...fs
			.readdirSync(home)
			.filter((n) => n.startsWith(".claude"))
			.map((n) => path.join(home, n)),
	];
	const aliases = new Map();
	for (const [entry, real] of copied) {
		const copy = path.join(dest, entry);
		aliases.set(real, copy);
		for (const dir of configDirs)
			if (readRealOrNull(path.join(dir, entry)) === real)
				aliases.set(path.join(dir, entry), copy);
		if (aliases.has(path.join(home, ".claude", entry)))
			// JSON escapes the quotes a shell command puts round `$HOME`.
			for (const h of ['\\"$HOME\\"', '"$HOME"', "$HOME", "~"])
				aliases.set(`${h}/.claude/${entry}`, copy);
	}
	return aliases;
}

/**
 * @param {string} dest
 * @param {Map<string, string>} aliases
 * @param {string} home
 * @returns {string[]} the config-dir paths still named, which no copy answers
 */
function rewriteLivePaths(dest, aliases, home) {
	const spellings = [...aliases.keys()].sort((a, b) => b.length - a.length);
	const liveSpelling = new RegExp(
		`(?:${spellings.map(escapeRe).join("|")})(?=[/"]|$)`,
		"g",
	);
	const leftoverRef = new RegExp(
		`(?:\\$HOME|~|${escapeRe(home)})/\\.claude[^/"]*/[^"\\s]*`,
		"g",
	);
	const liveRefs = [];
	const hooks = path.join(dest, "hooks");
	const hookFiles = fs.existsSync(hooks)
		? fs
				.readdirSync(hooks, { withFileTypes: true })
				.filter((e) => e.isFile())
				.map((e) => path.join("hooks", e.name))
		: [];
	for (const rel of [...PATH_FILES, ...hookFiles]) {
		const p = path.join(dest, rel);
		if (!fs.existsSync(p)) continue;
		const text = fs
			.readFileSync(p, "utf8")
			.replace(liveSpelling, (m) => String(aliases.get(m)));
		fs.writeFileSync(p, text);
		for (const [ref] of text.matchAll(leftoverRef))
			if (!ref.startsWith(dest)) liveRefs.push(`${rel}: ${ref}`);
	}
	return liveRefs;
}

/**
 * Each `--override <path>=<file>`, or the refusal for the first malformed one.
 * @param {string[]} specs
 * @param {string} dest
 * @returns {{ target: string, file: string }[] | string}
 */
function parseOverrides(specs, dest) {
	const out = [];
	for (const spec of specs) {
		const eq = spec.indexOf("=");
		const rel = spec.slice(0, eq);
		const file = spec.slice(eq + 1);
		const target = path.resolve(dest, rel);
		if (eq <= 0 || !file || !target.startsWith(`${dest}${path.sep}`))
			return `--override takes <path inside the config dir>=<file>, got ${spec}`;
		if (!fs.existsSync(file)) return `--override ${spec}: no file ${file}`;
		out.push({ target, file });
	}
	return out;
}

/**
 * @param {import("./lib/cli-args").Parsed} parsed
 * @returns {number}
 */
function buildConfig({ flags, lists }) {
	const from = flagValue(flags, "--from");
	const to = flagValue(flags, "--to");
	if (!from || !to) return refuse(CONFIG_USAGE);
	if (!isEmptyOrAbsent(to)) return refuse(`${to} exists and is not empty.`);
	const home = process.env.HOME || "";
	const dest = path.resolve(to);
	const overrides = parseOverrides(lists["--override"] ?? [], dest);
	if (typeof overrides === "string") return refuse(overrides);
	fs.mkdirSync(dest, { recursive: true });

	/** @type {string[]} */
	const skipped = [];
	const copied = copyEntries(from, path.join(home, ".claude"), dest, skipped);
	for (const { target, file } of overrides) {
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.copyFileSync(fs.realpathSync(file), target);
	}
	const liveRefs = rewriteLivePaths(
		dest,
		liveAliases(copied, from, home, dest),
		home,
	);

	const links = readSymlinksUnder(dest);
	if (links.length > 0)
		return refuse(`symlinks survived the copy: ${links.join(", ")}`);
	writeFd(
		1,
		`${JSON.stringify({ to: dest, copied: [...copied.keys()], skipped, liveRefs, login: "owed: no credentials are copied" }, null, 2)}\n`,
	);
	return 0;
}

/**
 * Is `p` inside a config dir's `jobs/` tree or a repo's `.claude/worktrees`?
 * Read through the real path of its nearest existing ancestor, so a link into
 * one is caught, and against `$CLAUDE_CONFIG_DIR`'s own `jobs/` whatever its
 * name.
 * @param {string} p
 */
function isInsideForbiddenTree(p) {
	let base = path.resolve(p);
	let rest = "";
	while (readRealOrNull(base) === null && path.dirname(base) !== base) {
		rest = path.join(path.basename(base), rest);
		base = path.dirname(base);
	}
	const real = path.join(readRealOrNull(base) ?? base, rest);
	const parts = real.split(path.sep);
	const configJobs = process.env.CLAUDE_CONFIG_DIR
		? jobStorePath(path.resolve(process.env.CLAUDE_CONFIG_DIR))
		: null;
	return (
		(configJobs !== null &&
			(real === configJobs || real.startsWith(`${configJobs}${path.sep}`))) ||
		parts.some(
			(seg, i) =>
				seg.startsWith(".claude") &&
				(parts[i + 1] === "jobs" || parts[i + 1] === "worktrees"),
		)
	);
}

/**
 * @param {string} cwd
 * @param {string[]} args
 */
const git = (cwd, args) =>
	execGit(args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

/**
 * `core.hooksPath` in `repo`, or "none" where it is unset; any other git
 * failure throws (#3440).
 * @param {string} repo
 * @returns {string}
 */
function readHooksPath(repo) {
	// `git config <key>` exits 1 on an unset key, which is an answer here.
	const r = gitReader(repo)(["config", "core.hooksPath"], [1]);
	if (!r.ok) throw new Error(`git config core.hooksPath: ${r.why}`);
	return r.out.trim() || "none";
}

/**
 * Whether `rev` names a commit in `repo`; a git that will not answer, a path
 * that is no repo among them, throws.
 * @param {string} repo
 * @param {string} rev
 */
function hasCommit(repo, rev) {
	const r = readCommit(gitReader(repo), rev);
	if (!r.ok) throw new Error(`git rev-parse ${rev}: ${r.why}`);
	return r.sha !== null;
}

/**
 * A clone of the public code repo holds none of the tracker's history, where
 * the task shas live (#1954, #2854).
 * @param {string} repo
 * @param {string[]} missing
 */
function refuseMissing(repo, missing) {
	const tracker = resolveKey("tracker", { root: repo });
	const fetch =
		typeof tracker === "string"
			? `cd ${repo} && ${fetchTrackerCommand(readTrackerRemotes(tracker, { cwd: repo }), tracker)}`
			: "add a remote naming the tracker and fetch it";
	return `${repo} holds no commit ${missing.join(", ")}; fetch the tracker's history into it, then build again: ${fetch}`;
}

/** @param {string} clone */
function isSelfPluginEnabled(clone) {
	const p = path.join(clone, ".claude", "settings.json");
	if (!fs.existsSync(p)) return false;
	return (
		JSON.parse(fs.readFileSync(p, "utf8")).enabledPlugins?.[SELF_PLUGIN_ID] ===
		true
	);
}

/**
 * Points the `wfc-self` marketplace a settings file declares in
 * `extraKnownMarketplaces` at `dir`, where it declares one.
 * @param {string} settingsFile
 * @param {string} dir
 */
function pointDeclaredSelfMarketplace(settingsFile, dir) {
	if (!fs.existsSync(settingsFile)) return;
	const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
	const declared = settings.extraKnownMarketplaces?.[SELF_PLUGIN_MARKETPLACE];
	if (!declared) return;
	declared.source = { ...declared.source, path: dir };
	fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * The `known_marketplaces.json` entry that registers the `wfc-self`
 * marketplace loaded in place from `dir`.
 * @param {string} dir
 */
const selfMarketplaceEntry = (dir) => ({
	source: { source: "directory", path: dir },
	installLocation: dir,
});

/**
 * Points `configDir`'s `wfc-self` marketplace, its `settings.json`
 * declaration, and any install record loaded in place from it, at `clone`'s
 * `self-plugin/`.
 * @param {string} configDir
 * @param {string} clone
 * @returns {{dir: string} | {unpointed: string}}
 */
function pointSelfPlugin(configDir, clone) {
	const dir = path.join(clone, SELF_PLUGIN_DIR);
	if (!fs.existsSync(dir))
		return { unpointed: `the revision has no ${SELF_PLUGIN_DIR}/` };
	pointDeclaredSelfMarketplace(path.join(configDir, "settings.json"), dir);
	const knownFile = path.join(configDir, "plugins", "known_marketplaces.json");
	const known = fs.existsSync(knownFile)
		? JSON.parse(fs.readFileSync(knownFile, "utf8"))
		: {};
	const entry = known[SELF_PLUGIN_MARKETPLACE];
	if (!entry)
		return {
			unpointed: `${knownFile} registers no ${SELF_PLUGIN_MARKETPLACE} marketplace`,
		};
	const was = entry.installLocation;
	const pointed = selfMarketplaceEntry(dir);
	known[SELF_PLUGIN_MARKETPLACE] = {
		...entry,
		...pointed,
		source: { ...entry.source, ...pointed.source },
	};
	fs.writeFileSync(knownFile, `${JSON.stringify(known, null, 2)}\n`);
	const installedFile = path.join(
		configDir,
		"plugins",
		"installed_plugins.json",
	);
	if (!fs.existsSync(installedFile)) return { dir };
	const installed = JSON.parse(fs.readFileSync(installedFile, "utf8"));
	const records = installed.plugins?.[SELF_PLUGIN_ID];
	if (Array.isArray(records)) {
		for (const r of records) if (r.installPath === was) r.installPath = dir;
		fs.writeFileSync(installedFile, `${JSON.stringify(installed, null, 2)}\n`);
	}
	return { dir };
}

/**
 * @param {string|undefined} configDir
 * @param {string} clone
 * @returns {{dir: string} | {unpointed: string} | {refusal: string}}
 */
function armSelfPlugin(configDir, clone) {
	if (!configDir) return { unpointed: "no --config-dir" };
	const dir = path.resolve(configDir);
	const pointed = pointSelfPlugin(dir, clone);
	if (!("unpointed" in pointed) || !isSelfPluginEnabled(clone)) return pointed;
	return {
		refusal: `the revision enables ${SELF_PLUGIN_ID} but ${pointed.unpointed}, so the run's canary would refuse every call. Register it in the arm config dir, then build again: CLAUDE_CONFIG_DIR=${dir} ${selfPluginSetup(clone)}`,
	};
}

/**
 * Takes the work out of `clone`: each sha reverted, then each patch applied in
 * reverse, as one commit with a neutral subject, not git's `Revert "…"` per
 * sha, whose subjects name the work to redo and the commits that hold it
 * (#2044).
 * @param {string} clone
 * @param {string[]} reverts
 * @param {string[]} unapplied absolute patch paths
 * @param {string} at the revision the clone starts from, for the refusal
 * @returns {string | null} the refusal where a sha does not revert or a patch
 *   does not reverse-apply
 */
function startTask(clone, reverts, unapplied, at) {
	if (reverts.length + unapplied.length === 0) return null;
	const start = git(clone, ["rev-parse", "HEAD"]);
	const identity = [
		"-c",
		"user.name=arm sandbox",
		"-c",
		"user.email=sandbox@invalid",
	];
	/** @param {string[]} args */
	const failure = (args) => {
		const r = spawnGitSync(args, { cwd: clone, encoding: "utf8" });
		return r.status === 0 ? null : String(r.stderr).trim();
	};
	for (const sha of reverts) {
		const err = failure([...identity, "revert", "--no-edit", sha]);
		if (err !== null)
			return `--revert ${sha} does not revert cleanly at ${at}; pick an --at it reverts at, then build again:\n${err}`;
	}
	for (const patch of unapplied) {
		const err = failure(["apply", "--reverse", "--3way", "--index", patch]);
		if (err !== null)
			return `--unapply patch ${patch} does not reverse-apply at ${at}; regenerate it against ${at}, then build again:\n${err}`;
	}
	git(clone, ["reset", "--quiet", "--soft", start]);
	git(clone, [...identity, "commit", "--quiet", "-m", "Start the task"]);
	return null;
}

/**
 * Leaves `root` as the build found it, which `readTaskRefusal` has made
 * empty or absent.
 * @param {string} root
 * @param {boolean} preexisting
 */
function unbuild(root, preexisting) {
	const doomed = preexisting
		? fs.readdirSync(root).map((e) => path.join(root, e))
		: [root];
	for (const p of doomed) fs.rmSync(p, { recursive: true, force: true });
}

/**
 * Why a task sandbox cannot be built from these inputs, before anything is
 * written.
 * @param {{ repo: string, at: string, to: string, reverts: string[], unapplied: string[] }} inputs
 * @returns {string | null}
 */
function readTaskRefusal({ repo, at, to, reverts, unapplied }) {
	if (isInsideForbiddenTree(to))
		return `${to} is inside a config dir's jobs/ tree or a .claude/worktrees tree; build the sandbox outside every one.`;
	if (!isEmptyOrAbsent(to)) return `${to} exists and is not empty.`;
	const missing = [at, ...reverts].filter((rev) => !hasCommit(repo, rev));
	if (missing.length > 0) return refuseMissing(repo, missing);
	const absent = unapplied.filter((p) => !fs.existsSync(p));
	if (absent.length > 0)
		return `no --unapply patch ${absent.join(", ")}; name a patch file that exists, then build again.`;
	return null;
}

/**
 * @param {import("./lib/cli-args").Parsed} parsed
 * @returns {number}
 */
function buildTask({ flags, lists }) {
	const repo = flagValue(flags, "--repo");
	const at = flagValue(flags, "--at");
	const to = flagValue(flags, "--to");
	const nodeModules = flagValue(flags, "--node-modules");
	const configDir = flagValue(flags, "--config-dir");
	if (!repo || !at || !to) return refuse(TASK_USAGE);
	const reverts = lists["--revert"] ?? [];
	const unapplied = (lists["--unapply"] ?? []).map((p) => path.resolve(p));
	const refusal = readTaskRefusal({ repo, at, to, reverts, unapplied });
	if (refusal) return refuse(refusal);
	const base = git(repo, ["rev-parse", "--verify", `${at}^{commit}`]);

	const root = path.resolve(to);
	const preexisting = fs.existsSync(root);
	const origin = path.join(root, "origin.git");
	const clone = path.join(root, "repo");
	fs.mkdirSync(path.join(root, "bin"), { recursive: true });
	fs.mkdirSync(path.join(root, "gh-fixtures"));
	git(root, ["init", "--quiet", "--bare", origin]);
	git(root, ["clone", "--quiet", path.resolve(repo), clone]);
	git(clone, ["checkout", "--quiet", "-B", "main", base]);
	const unstarted = startTask(clone, reverts, unapplied, at);
	if (unstarted) {
		unbuild(root, preexisting);
		return refuse(unstarted);
	}
	git(clone, ["remote", "set-url", "origin", origin]);
	git(clone, ["push", "--quiet", "origin", "main"]);
	git(clone, ["fetch", "--quiet", "--prune", "origin"]);
	git(clone, ["branch", "--quiet", "-u", "origin/main"]);
	let hooksPath =
		"unarmed: no --node-modules, so the clone's prepare cannot run";
	if (nodeModules) {
		fs.symlinkSync(path.resolve(nodeModules), path.join(clone, "node_modules"));
		execFileSync("npm", ["run", "--silent", "--if-present", "prepare"], {
			cwd: clone,
			stdio: "pipe",
		});
		hooksPath = readHooksPath(clone);
	}

	for (const spec of lists["--issue"] ?? []) {
		const eq = spec.indexOf("=");
		const n = spec.slice(0, eq);
		const file = spec.slice(eq + 1);
		if (eq === -1 || !/^\d+$/.test(n) || !file)
			return refuse(`--issue takes <n>=<file>, got ${spec}`);
		fs.copyFileSync(file, path.join(root, "gh-fixtures", `issue-${n}.json`));
	}

	const selfPlugin = armSelfPlugin(configDir, clone);
	if ("refusal" in selfPlugin) return refuse(selfPlugin.refusal);

	const gh = path.join(root, "bin", "gh");
	fs.copyFileSync(path.join(__dirname, "lib", "arm-gh-stub.js"), gh);
	fs.chmodSync(gh, 0o755);
	fs.writeFileSync(path.join(root, "gh.log"), "");
	// GH_HOST is a backstop: a real `gh` reached by absolute path resolves nowhere.
	// GIT_ALLOW_PROTOCOL keeps git to local paths, so a push to a named URL fails.
	const env = path.join(root, "sandbox.env");
	fs.writeFileSync(
		env,
		`export PATH="${path.join(root, "bin")}:$PATH"\nexport WFC_GH="${gh}"\nexport GH_HOST=gh-stub.invalid\nexport GIT_ALLOW_PROTOCOL=file\n`,
	);

	writeFd(
		1,
		`${JSON.stringify({ root, repo: clone, origin, gh, log: path.join(root, "gh.log"), env, hooksPath, selfPlugin, base, head: git(clone, ["rev-parse", "HEAD"]) }, null, 2)}\n`,
	);
	return 0;
}

/** @param {string[]} argv */
function main(argv) {
	const parsed = parseOrExit(argv, CLI);
	if (parsed.command === "config") return buildConfig(parsed);
	if (parsed.command === "task") return buildTask(parsed);
	return refuse(CLI.usage);
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, selfMarketplaceEntry };
