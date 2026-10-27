/*
 * formatters.js — the shell and Python formatters of record (#1332), shared by the three
 * routes that run them: formatWritten on a tool write (lib/post-write.js),
 * scripts/check-format-staged.js in .husky/pre-commit, and
 * scripts/check-shfmt.js plus `ruff format --check .` in CI.
 *
 * Shell is shfmt at `-i 2 -ci`, from npm `@wasm-fmt/shfmt` — a WASM build with
 * no CLI of its own, so `npm install` supplies it on every machine. It is
 * resolved from the working directory's node_modules first, so an adopter
 * running these from the plugin cache formats with its own pinned copy.
 * `WFC_SHFMT`, where set, names the module to load instead (§N7).
 * Python is `ruff format`, from requirements-dev.txt's ruff pin.
 *
 * Run as a program it is .husky/pre-commit's one reading of both (#1354):
 *
 *   node scripts/lib/formatters.js shell-files  the shell files among the
 *     [--index|--tracked]                       paths on stdin, their heads
 *                                               read from the worktree or,
 *                                               with --index, the staged
 *                                               blobs; --tracked lists every
 *                                               tracked one instead (#1828)
 *   node scripts/lib/formatters.js ruff-config  the plugin ruff.toml the
 *                                               Python gates pass as --config,
 *                                               or nothing
 *   node scripts/lib/formatters.js skip-flags   `flags:` and the --skip-shell
 *                                               or --skip-python the format
 *                                               gate takes, so the hook tells
 *                                               no flag from a crash
 *   node scripts/lib/formatters.js lint-missing `lint:skip` or `lint:refuse`,
 *                                               the ruff lint gate's verdict
 *                                               where ruff is missing, its
 *                                               reason on stderr
 *
 * A half is skipped only where its formatter is missing AND a workflow under
 * .github/workflows/ runs that formatter, which then catches what the hook let
 * through (#1463). Elsewhere the checker reports the missing formatter BROKEN
 * and the commit is refused. The lint gate takes the same reading of
 * `ruff check` (#1563); lib/ci-runs.js owns the workflow read.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const { readCiRuns } = require("./ci-runs.js");
const { requiredGroup } = require("./regex-group.js");
const { caught } = require("./caught.js");
const { writeFd } = require("./write-fd.js");
const { readBlob } = require("./staged.js");
const { HOOK_GIT_TIMEOUT_MS, spawnGitSync } = require("./git.js");
const { GIT_MODE } = require("./git-mode.js");

/* The shell file set (#1828), which check:sh lints and both formatter routes
 * format: a husky hook, its `.local` companion or a `.sh`/`.bash` file by name, and a file with no
 * extension whose shebang names a shell shellcheck and shfmt both read, zsh
 * not being one. shellFiles() drops what .gitattributes marks vendored or
 * generated, the paths base §0 lets a route row send to "none". */
/* Both are POSIX ERE too: precommit-gate.sh arms on their union. */
const SHELL_NAME = /^\.husky\/[^/.]+(\.local)?$|\.(sh|bash)$/;
const NO_EXTENSION = /(^|\/)[^/.]+$/;
const SHELL_SHEBANG =
	/^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(?:ba|da|k)?sh(?:\s|$)/;
const EXCLUDING_ATTRS = ["linguist-vendored", "linguist-generated"];

const SHFMT_OPTIONS = { indent: 2, switchCaseIndent: true };

const RUFF = process.env.WFC_RUFF || "ruff";
const SHFMT_MODULE = process.env.WFC_SHFMT;

/** The one line that installs each formatter in any repo, at the core's pins
 * (package.json, requirements-dev.txt); formatters.test.ts pins them equal. */
const SHFMT_INSTALL =
	"npm install --ignore-scripts --save-dev --save-exact @wasm-fmt/shfmt@0.2.7";
const RUFF_INSTALL = "python3 -m pip install ruff==0.16.4";

/** @typedef {(source: string, path?: string, options?: object) => string} ShfmtFormat */

/**
 * shfmt's format function, or null where neither the working directory nor
 * the plugin has `@wasm-fmt/shfmt` installed, or `WFC_SHFMT` names no module.
 * @returns {ShfmtFormat | null}
 */
function loadShfmt() {
	const roots = SHFMT_MODULE
		? [() => require(SHFMT_MODULE)]
		: [path.join(process.cwd(), "package.json"), __filename].map(
				(from) => () => createRequire(from)("@wasm-fmt/shfmt"),
			);
	for (const load of roots) {
		try {
			return load().format;
		} catch {
			// Not installed from here; the next root may have it.
		}
	}
	return null;
}

// A subscript shfmt printed as arithmetic: `[a - b]`.
const SPACED_SUBSCRIPT = /\[([^\]\s"'$]+(?: [-+*/%] [^\]\s"'$]+)+)\]/g;
const DECLARATION =
	/\b(?:declare|local|typeset)((?:[ \t]+-\w+)+)[ \t]+([^;\n|&)]*)/g;

/**
 * The names a `declare`/`local`/`typeset` with `-A` makes associative.
 * @param {string} source
 * @returns {Set<string>}
 */
function associativeNames(source) {
	const names = new Set();
	for (const m of source.matchAll(DECLARATION)) {
		if (!requiredGroup(m, 1, DECLARATION).includes("A")) continue;
		for (const word of requiredGroup(m, 2, DECLARATION).split(/\s+/)) {
			const name = word.match(/^[A-Za-z_]\w*/);
			if (name) names.add(name[0]);
		}
	}
	return names;
}

/**
 * The array a subscript at `at` belongs to: the name before its `[`, or, for
 * a `[k]=v` entry, the nearest `name=(` above it.
 * @param {string} out
 * @param {number} at
 * @returns {string | undefined}
 */
function subscriptOwner(out, at) {
	const before = out.slice(0, at);
	const direct = before.match(/([A-Za-z_]\w*)$/);
	if (direct) return direct[1];
	return [...before.matchAll(/([A-Za-z_]\w*)=\(/g)].at(-1)?.[1];
}

/**
 * The source as shfmt prints it. Throws on a parse error, with shfmt's message,
 * and where shfmt would respace an unquoted associative-array key: it parses
 * `M[a-b]` as arithmetic and prints `M[a - b]`, a different key (#1332). An
 * indexed array's `w[i+1]` means the same either way, so only arrays the file
 * declares `-A` are checked.
 * @param {ShfmtFormat} format
 * @param {string} source
 * @param {string} file
 * @returns {string}
 */
function formatShell(format, source, file) {
	const out = format(source, file, SHFMT_OPTIONS);
	const associative = associativeNames(source);
	if (associative.size === 0) return out;
	for (const m of out.matchAll(SPACED_SUBSCRIPT)) {
		const spaced = requiredGroup(m, 1, SPACED_SUBSCRIPT);
		const key = spaced.replaceAll(" ", "");
		const owner = subscriptOwner(out, m.index);
		if (
			owner &&
			associative.has(owner) &&
			source.includes(`[${key}]`) &&
			!source.includes(`[${spaced}]`)
		)
			throw new Error(
				`shfmt would rewrite the key [${key}] as [${spaced}]; quote it: ["${key}"]`,
			);
	}
	return out;
}

/**
 * What a check of one shell file finds: null where shfmt leaves it as it is,
 * else the finding, carrying shfmt's output where it parsed.
 * @param {ShfmtFormat} format
 * @param {string} source
 * @param {string} file
 * @returns {{ tag: "UNFORMATTED", message: string, out: string } | { tag: "UNPARSEABLE", message: string } | null}
 */
function shellFinding(format, source, file) {
	let out;
	try {
		out = formatShell(format, source, file);
	} catch (e) {
		return {
			tag: "UNPARSEABLE",
			message: `shfmt cannot parse it: ${caught(e).message}`,
		};
	}
	return out === source
		? null
		: { tag: "UNFORMATTED", message: "not shfmt-formatted", out };
}

/**
 * A path's opening bytes in the worktree, null where it is no regular file: a
 * symlink's target is judged at its own path.
 * @param {string} p
 * @returns {string | null}
 */
function readWorktreeHead(p) {
	let fd;
	try {
		if (!fs.lstatSync(p).isFile()) return null;
		fd = fs.openSync(p, "r");
		// Linux reads 256 bytes for a shebang line (BINPRM_BUF_SIZE, kernel 5.1+).
		const buf = Buffer.alloc(256);
		return buf.toString("utf8", 0, fs.readSync(fd, buf, 0, buf.length, 0));
	} catch {
		return null;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/**
 * A head reader over the index: a path's staged blob, null for a staged
 * symlink, whose blob is its target's path. Throws where git cannot list the
 * index.
 * @returns {(p: string) => string | null}
 */
function indexHead() {
	const r = spawnGitSync(["ls-files", "-s", "-z"], { encoding: "utf8" });
	if (r.status !== 0)
		throw new Error(`git ls-files failed: ${r.stderr.trim()}`);
	const links = new Set();
	for (const entry of r.stdout.split("\0"))
		if (entry.startsWith(`${GIT_MODE.symlink} `))
			links.add(entry.slice(entry.indexOf("\t") + 1));
	return (p) => (links.has(p) ? null : readBlob(`:${p}`));
}

/**
 * The paths .gitattributes marks vendored or generated. Throws where git
 * cannot read the attributes.
 * @param {string[]} paths
 * @param {boolean} cached read .gitattributes from the index, as a commit carries it
 * @param {number | undefined} timeout the git call's ceiling, none where undefined
 * @returns {Set<string>}
 */
function readAttributeExcluded(paths, cached, timeout) {
	if (paths.length === 0) return new Set();
	const r = spawnGitSync(
		[
			"check-attr",
			"-z",
			"--stdin",
			...(cached ? ["--cached"] : []),
			...EXCLUDING_ATTRS,
		],
		{
			input: paths.map((p) => `${p}\0`).join(""),
			encoding: "utf8",
			...(timeout === undefined ? {} : { timeout }),
		},
	);
	if (r.status !== 0)
		throw new Error(`git check-attr failed: ${r.stderr.trim()}`);
	const fields = r.stdout.split("\0");
	const excluded = new Set();
	for (let i = 0; i + 2 < fields.length; i += 3) {
		const value = fields[i + 2];
		if (value === "set" || value === "true") excluded.add(fields[i]);
	}
	return excluded;
}

/**
 * The shell files among `paths`, in their order (#1828). Throws where git
 * cannot read the attributes.
 * @param {string[]} paths repo-relative, read from the host root
 * @param {(p: string) => string | null} head a path's opening text, null
 *   where it is no regular file, which drops it
 * @param {{ cached?: boolean, timeout?: number }} [opts] cached: read
 *   .gitattributes from the index; timeout: the attribute read's ceiling
 * @returns {string[]}
 */
function shellFiles(paths, head, { cached = false, timeout } = {}) {
	const shell = paths.filter((p) => {
		const named = SHELL_NAME.test(p);
		if (!named && !NO_EXTENSION.test(p)) return false;
		const text = head(p);
		return text !== null && (named || SHELL_SHEBANG.test(text));
	});
	const excluded = readAttributeExcluded(shell, cached, timeout);
	return shell.filter((p) => !excluded.has(p));
}

/**
 * Every tracked shell file, its head read from the worktree. Throws where git
 * fails.
 * @returns {string[]}
 */
function readTrackedShellFiles() {
	const r = spawnGitSync(["ls-files", "-z"], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
	return shellFiles(r.stdout.split("\0").filter(Boolean), readWorktreeHead);
}

/**
 * The plugin's ruff.toml as `--config`, where the working directory has no
 * ruff config of its own (#106). The plugin root is the hook's
 * `WFC_PLUGIN_ROOT`, or the harness's `CLAUDE_PLUGIN_ROOT` on a tool write.
 *
 * Read at the root only: `--config` turns off ruff's per-directory discovery,
 * so a host whose ruff config sits in a subdirectory alone is overridden by
 * the plugin's. Such a host adds a root ruff.toml.
 * @returns {string[]}
 */
function ruffConfigArgs() {
	const has = (/** @type {string} */ f) =>
		fs.existsSync(path.join(process.cwd(), f));
	let pyproject = "";
	try {
		pyproject = fs.readFileSync(
			path.join(process.cwd(), "pyproject.toml"),
			"utf8",
		);
	} catch {
		// No pyproject.toml: no [tool.ruff] table in it either.
	}
	if (
		has("ruff.toml") ||
		has(".ruff.toml") ||
		/^\s*\[tool\.ruff/m.test(pyproject)
	)
		return [];
	const root = process.env.WFC_PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT;
	const plugin = root && path.join(root, "ruff.toml");
	return plugin && fs.existsSync(plugin) ? ["--config", plugin] : [];
}

/**
 * The adopter's `ruffExclude` from .claude/workflow-core.json. An unreadable or
 * malformed value fails OPEN on the exclusion alone — every path is read, the
 * stricter reading — and says so through `say` (#122).
 * @param {(line: string) => void} say
 * @returns {string[]}
 */
function readRuffExcludes(say) {
	try {
		const {
			faultsOn,
			readConfig,
			buildWarningLine,
		} = require("./workflow-core-config.js");
		const config = readConfig({ quiet: true });
		for (const f of faultsOn(config, "ruffExclude"))
			say(`${buildWarningLine(f)}, so nothing is excluded (#122)`);
		return config.ruffExclude ?? [];
	} catch (e) {
		say(
			`ruffExclude unread, so nothing is excluded (#122): ${caught(e).message}`,
		);
		return [];
	}
}

/**
 * `--force-exclude` plus one `--extend-exclude` per `ruffExclude` pattern, so
 * a host's own `exclude` and its adopter-config exclusions bind every route.
 * @param {(line: string) => void} say
 * @returns {string[]}
 */
function readRuffExcludeArgs(say) {
	return [
		"--force-exclude",
		...readRuffExcludes(say).flatMap((p) => ["--extend-exclude", p]),
	];
}

/** @returns {boolean} whether `ruff` runs at all */
function hasRuff() {
	return !spawnSync(RUFF, ["--version"], { stdio: "ignore" }).error;
}

/**
 * The flags the format gate takes in the working directory.
 * @returns {string[]}
 */
function skipFlags() {
	const missing = { shell: !loadShfmt(), python: !hasRuff() };
	if (!missing.shell && !missing.python) return [];
	const ci = readCiRuns(process.cwd());
	return [
		missing.shell && ci.shfmt.length > 0 && "--skip-shell",
		missing.python && ci.ruffFormat.length > 0 && "--skip-python",
	].filter((f) => typeof f === "string");
}

/**
 * The ruff lint gate's verdict where ruff is missing, its reason written to
 * stderr: skipped only where a workflow runs `ruff check` (#1563).
 * @returns {"skip" | "refuse"}
 */
function lintMissing() {
	const ci = readCiRuns(process.cwd()).ruffCheck;
	if (ci.length > 0) {
		writeFd(
			2,
			`pre-commit: ${RUFF} is not on PATH — the ruff gate is SKIPPED, this commit is NOT blocked.\n` +
				`  ruff check runs in ${ci.join(", ")}, which can catch what this lets through when it next runs. Install it: ${RUFF_INSTALL}\n`,
		);
		return "skip";
	}
	writeFd(
		2,
		`pre-commit: ${RUFF} is not on PATH and no workflow under .github/workflows/ runs ruff check, so the ruff gate refused this commit.\n` +
			`  Install it: ${RUFF_INSTALL}\n`,
	);
	return "refuse";
}

/**
 * The `shell-files` route: one a line; exit 1 where git fails.
 * @param {string} mode "", "--index" or "--tracked"
 */
function printShellFiles(mode) {
	let files;
	try {
		if (mode === "--tracked") files = readTrackedShellFiles();
		else {
			const paths = fs.readFileSync(0, "utf8").split("\n").filter(Boolean);
			files =
				mode === "--index"
					? shellFiles(paths, indexHead(), { cached: true })
					: shellFiles(paths, readWorktreeHead);
		}
	} catch (e) {
		writeFd(2, `formatters.js shell-files: ${caught(e).message}\n`);
		process.exit(1);
	}
	writeFd(1, files.map((f) => `${f}\n`).join(""));
}

/* The post-write core's spawns run in series under the PostToolUse entry's
 * 15 s (#2787): Biome, then ruff or the attribute read's 3 s git ceiling.
 * Two formatter calls at 5 s and that ceiling leave 2 s for the other cores. */
const WRITE_FORMAT_TIMEOUT_MS = 5000;

/**
 * Format one file a tool just wrote, if it is shell or Python (#1332): the
 * post-write core's step 1 beside Biome. Run from the host root, which has
 * already been checked to hold the file. Answers `shell` where the file is in
 * the shellcheck set, which post-write answers with its shell-lint-blind fragment,
 * and "" on any other. A missing formatter or an unparseable file leaves the
 * file as written: this is convenience, and .husky/pre-commit's format gate is
 * what refuses.
 * @param {string} file the written path, as the tool named it
 * @returns {"shell" | ""}
 */
function formatWritten(file) {
	const rel = path.relative(process.cwd(), path.resolve(file));
	let shell = false;
	try {
		shell =
			shellFiles([rel], readWorktreeHead, { timeout: HOOK_GIT_TIMEOUT_MS })
				.length > 0;
	} catch {
		// git unreadable: left as written, for the gate to judge.
	}
	if (shell) {
		const format = loadShfmt();
		try {
			const source = fs.readFileSync(file, "utf8");
			const out = format && formatShell(format, source, rel);
			if (out && out !== source) fs.writeFileSync(file, out);
		} catch {
			// Unparseable or unreadable: left as written, for the gate to name.
		}
		return "shell";
	}
	if (rel.endsWith(".py"))
		spawnSync(
			process.env.WFC_RUFF || "ruff",
			[
				"format",
				...ruffConfigArgs(),
				...readRuffExcludeArgs(() => {
					/* a write hook stays silent: the commit gate names an unread exclude */
				}),
				"--",
				rel,
			],
			{ stdio: "ignore", timeout: WRITE_FORMAT_TIMEOUT_MS },
		);
	return "";
}

if (require.main === module) {
	const want = process.argv.slice(2).join(" ");
	if (want === "skip-flags") writeFd(1, `flags:${skipFlags().join(" ")}\n`);
	else if (want === "lint-missing") writeFd(1, `lint:${lintMissing()}\n`);
	else if (/^shell-files(?: --index| --tracked)?$/.test(want))
		printShellFiles(want.slice("shell-files ".length));
	else if (want === "ruff-config") {
		const [, config] = ruffConfigArgs();
		if (config) writeFd(1, `${config}\n`);
	} else {
		writeFd(
			2,
			"usage: node formatters.js <ruff-config|skip-flags|lint-missing|shell-files [--index|--tracked]>\n",
		);
		process.exit(2);
	}
}

module.exports = {
	RUFF,
	RUFF_INSTALL,
	SHFMT_INSTALL,
	WRITE_FORMAT_TIMEOUT_MS,
	formatShell,
	formatWritten,
	indexHead,
	loadShfmt,
	ruffConfigArgs,
	readRuffExcludeArgs,
	shellFiles,
	shellFinding,
	readTrackedShellFiles,
	readWorktreeHead,
};
