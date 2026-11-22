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
 *                                               gate takes, one a line, so the
 *                                               hook tells
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
const { caught, ignoreFailure, orFallback } = require("./caught.js");
const { noop } = require("./noop.js");
const { readFdAll } = require("./read-fd.js");
const { writeFd } = require("./write-fd.js");
const { readBlob } = require("./staged.js");
const { HOOK_GIT_TIMEOUT_MS, spawnGitSync } = require("./git.js");
const { GIT_MODE } = require("./git-mode.js");
const { readAttributeExcluded } = require("./git-attributes.js");

// #5529
const SHELL_NAME = /^\.husky\/[^/.]+(\.local)?$|\.(sh|bash)$/;
const NO_EXTENSION = /(^|\/)[^/.]+$/;
const SHELL_SHEBANG =
	/^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?(?:ba|da|k)?sh(?:\s|$)/;

const BINPRM_BUF_SIZE = 256;

const SHFMT_OPTIONS = { indent: 2, switchCaseIndent: true };

const RUFF = process.env.WFC_RUFF || "ruff";
const SHFMT_MODULE = process.env.WFC_SHFMT;

const SHFMT_INSTALL =
	"npm install --ignore-scripts --save-dev --save-exact @wasm-fmt/shfmt@0.2.7";
const RUFF_INSTALL = "python3 -m pip install --only-binary :all: ruff==0.16.4";

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
		const loaded = orFallback(load, null);
		if (loaded) return loaded.format;
	}
	return null;
}

const TERM_CHAR = /[^\]\s"'$]/;
const ARITHMETIC_OPS = "-+*/%";

function termEnd(/** @type {string} */ s, /** @type {number} */ from) {
	let end = from;
	while (end < s.length && TERM_CHAR.test(s.charAt(end))) end++;
	return end;
}

/**
 * @param {string} s
 * @returns {{index: number, spaced: string}[]}
 */
function spacedSubscripts(s) {
	const found = [];
	let open = s.indexOf("[");
	while (open >= 0) {
		let end = termEnd(s, open + 1);
		let terms = end > open + 1 ? 1 : 0;
		while (
			terms > 0 &&
			s.charAt(end) === " " &&
			s.charAt(end + 2) === " " &&
			ARITHMETIC_OPS.includes(s.charAt(end + 1))
		) {
			const next = termEnd(s, end + " + ".length);
			if (next === end + " + ".length) break;
			end = next;
			terms++;
		}
		const closed = terms > 1 && s.charAt(end) === "]";
		if (closed) found.push({ index: open, spaced: s.slice(open + 1, end) });
		open = s.indexOf("[", closed ? end + 1 : end);
	}
	return found;
}

const DECLARATION =
	/\b(?:declare|local|typeset)((?:[ \t]+-\w+)+)[ \t]+([^;\n|&)]*)/g;

/**
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
 * @param {string} out
 * @param {number} at
 * @returns {string | undefined}
 */
function subscriptOwner(out, at) {
	const before = out.slice(0, at);
	const direct = before.match(/(?=[A-Za-z_])(?<=(?:^|\W)\d*)([A-Za-z_]\w*)$/);
	if (direct) return direct[1];
	return [
		...before.matchAll(/(?=[A-Za-z_])(?<=(?:^|\W)\d*)([A-Za-z_]\w*)=\(/g),
	].at(-1)?.[1];
}

/**
 * @param {ShfmtFormat} format
 * @param {string} source
 * @param {string} file
 * @returns {string}
 */
function formatShell(format, source, file) {
	const out = format(source, file, SHFMT_OPTIONS);
	const associative = associativeNames(source);
	if (associative.size === 0) return out;
	for (const { index, spaced } of spacedSubscripts(out)) {
		const key = spaced.replaceAll(" ", "");
		const owner = subscriptOwner(out, index);
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
 * @param {string} p
 * @returns {string | null}
 */
function readWorktreeHead(p) {
	let fd;
	try {
		if (!fs.lstatSync(p).isFile()) return null;
		fd = fs.openSync(p, "r");
		const buf = Buffer.alloc(BINPRM_BUF_SIZE);
		return buf.toString("utf8", 0, fs.readSync(fd, buf, 0, buf.length, 0));
	} catch {
		return null;
	} finally {
		if (fd !== undefined) fs.closeSync(fd);
	}
}

/**
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
 * @param {string[]} paths
 * @param {(p: string) => string | null} head
 * @param {{ cached?: boolean, timeout?: number, cwd?: string }} [read]
 * @returns {string[]}
 */
function shellFiles(paths, head, { cached = false, timeout, cwd } = {}) {
	const shell = paths.filter((p) => {
		const named = SHELL_NAME.test(p);
		if (!named && !NO_EXTENSION.test(p)) return false;
		const text = head(p);
		return text !== null && (named || SHELL_SHEBANG.test(text));
	});
	const excluded = readAttributeExcluded(shell, {
		from: cached ? "index" : "worktree",
		timeout,
		cwd,
	});
	return shell.filter((p) => !excluded.has(p));
}

/**
 * @returns {string[]}
 */
function readTrackedShellFiles() {
	const r = spawnGitSync(["ls-files", "-z"], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ls-files failed: ${r.stderr}`);
	return shellFiles(r.stdout.split("\0").filter(Boolean), readWorktreeHead);
}

/**
 * @returns {string[]}
 */
function ruffConfigArgs() {
	const has = (/** @type {string} */ f) =>
		fs.existsSync(path.join(process.cwd(), f));
	const pyproject = orFallback(
		() => fs.readFileSync(path.join(process.cwd(), "pyproject.toml"), "utf8"),
		"",
	);
	if (
		has("ruff.toml") ||
		has(".ruff.toml") ||
		/^[^\S\n\r\u2028\u2029]*\[tool\.ruff/m.test(pyproject)
	)
		return [];
	const root = process.env.WFC_PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT;
	const plugin = root && path.join(root, "ruff.toml");
	return plugin && fs.existsSync(plugin) ? ["--config", plugin] : [];
}

/**
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
 * @param {string} mode
 */
function printShellFiles(mode) {
	let files;
	try {
		if (mode === "--tracked") files = readTrackedShellFiles();
		else {
			const paths = readFdAll(0).toString("utf8").split("\n").filter(Boolean);
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

// guess, #2787
const WRITE_FORMAT_TIMEOUT_MS = 5000;

/**
 * @param {string} file
 * @returns {"shell" | ""}
 */
function formatWritten(file) {
	const rel = path.relative(process.cwd(), path.resolve(file));
	const shell = orFallback(
		() =>
			shellFiles([rel], readWorktreeHead, { timeout: HOOK_GIT_TIMEOUT_MS })
				.length > 0,
		false,
	);
	if (shell) {
		const format = loadShfmt();
		ignoreFailure(() => {
			const source = fs.readFileSync(file, "utf8");
			const out = format && formatShell(format, source, rel);
			if (out && out !== source) fs.writeFileSync(file, out);
		});
		return "shell";
	}
	if (rel.endsWith(".py"))
		spawnSync(
			process.env.WFC_RUFF || "ruff",
			["format", ...ruffConfigArgs(), ...readRuffExcludeArgs(noop), "--", rel],
			{ stdio: "ignore", timeout: WRITE_FORMAT_TIMEOUT_MS },
		);
	return "";
}

if (require.main === module) {
	const want = process.argv.slice(2).join(" ");
	if (want === "skip-flags") writeFd(1, `flags:${skipFlags().join("\n")}\n`);
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
