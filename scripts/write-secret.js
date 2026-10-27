#!/usr/bin/env node
/*
 * write-secret.js — reads one secret with typing hidden and writes it into the
 * host repository's `.env`, so a founder hand-over can capture a credential
 * without its value ever entering the chat (#640, spec #632).
 *
 * Usage:
 *   node write-secret.js <NAME>
 *
 * The value is typed at the terminal with echo off. A value on piped stdin is
 * accepted too — the test seam; the hand-over never uses it, because a piped
 * value sits in the shell's history. Under Claude Code's `!` prefix stdin is
 * no terminal and carries nothing, and there is no controlling terminal to
 * open instead (#2554): `lib/empty-secret.js` words that refusal.
 *
 * TARGET: `.env` at the host root, `lib/host-root.js`'s, so an install writes
 * into the adopter's tree, never the plugin cache.
 *
 * NO FAMILY (§N3), as `grant-permission.js`: 0 written; 1 `.env` is tracked by
 * git, is a symlink, or cannot be written; 2 bad arguments or a value no .env
 * line can carry. Every refusal leaves `.env` untouched, and one about `.env`
 * itself comes before the value is asked for.
 *
 * A SYMLINKED `.env` IS REFUSED: its target may be a tracked file, which the
 * tracked check on `.env` itself cannot see (#640 review).
 *
 * NOTHING OF THE VALUE IS PRINTED — not it, its length or any part of it — and
 * nor is a malformed name, which is most likely the secret pasted in the
 * wrong place.
 *
 * THE UPSERT replaces the value on every line assigning <NAME> (`NAME=`,
 * `export NAME =`), keeping that line's prefix and CRLF ending; with none, it
 * appends `NAME=value`. Every other byte, and whether the file ends in a
 * newline, is kept. It lands by rename; a new `.env` is created owner-only, an
 * existing one keeps its mode.
 *
 * THE VALUE is trimmed, as `guard-jev-advisory.js`'s reader and dotenv both
 * trim. It is written unquoted unless it holds `#` (dotenv's comment), `$` or a
 * backtick (expansion), or starts or ends with a quote (which both readers
 * strip) — then single-quoted, which both read back literally. A value needing
 * quotes that holds a single quote is refused: no quoting survives both.
 *
 * A STALE ASIDE an earlier run left, a full copy of `.env`, is removed first,
 * before any refusal: a regular file `.env.<pid>.<hex>.tmp` at the host root
 * whose pid is not running. Only this writer makes that name there (#2320).
 * One whose pid runs is a concurrent run's, or a reused pid's: it is named and
 * left. One git tracks is named and left too, as its copy is in history, and
 * so is one git cannot say is tracked, with the same rotate warning (#2736).
 * Residual: a concurrent run in another pid namespace reads as dead and loses
 * its aside; its rename then fails and it refuses, so nothing leaks.
 *
 * NO FILE CLAIM (spec #525's ruling for `grant-permission.js`): `.env` is
 * untracked, and the founder's paste has no session to claim with.
 */

const fs = require("node:fs");
const path = require("node:path");
const { pidAlive } = require("./lib/arbiter-proc.js");
const {
	asidePath,
	asidePid,
	writeFileAtomic,
} = require("./lib/atomic-write.js");
const { parseOrCode } = require("./lib/cli-args");
const { hostRoot } = require("./lib/host-root.js");
const { emptyWhy } = require("./lib/empty-secret.js");
const { readHidden } = require("./lib/read-hidden.js");
const { caught } = require("./lib/caught.js");
const { SHELL_VAR_NAME } = require("./lib/shell-var-name.js");
const { spawnGitSync } = require("./lib/git.js");
const { requiredGroup } = require("./lib/regex-group.js");
const { isUnder } = require("./lib/is-under.js");

const VAR_NAME = new RegExp(`^${SHELL_VAR_NAME}$`);

const USAGE = `usage: write-secret.js <NAME>
  <NAME>  a shell variable name; the value is then asked for with typing hidden`;

/**
 * @param {string} why
 * @param {number} status
 * @returns {number}
 */
function refuse(why, status) {
	process.stderr.write(`write-secret: refused, .env untouched — ${why}\n`);
	return status;
}

/* A git hook sets GIT_DIR and GIT_INDEX_FILE, so a run under one would ask
 * another repository than the host root's. */
const REDIRECTS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
	"GIT_OBJECT_DIRECTORY",
	"GIT_CEILING_DIRECTORIES",
	"GIT_DISCOVERY_ACROSS_FILESYSTEM",
];

/* Each changes how the pathspec below is read: GIT_LITERAL_PATHSPECS turns
 * its magic off (#3063). */
const PATHSPEC_MODES = [
	"GIT_LITERAL_PATHSPECS",
	"GIT_GLOB_PATHSPECS",
	"GIT_NOGLOB_PATHSPECS",
	"GIT_ICASE_PATHSPECS",
];

/**
 * Whether `name` injects config, `core.excludesFile` among it, that a commit
 * from a shell without it would not see (#3063). GIT_CONFIG_NOSYSTEM is kept:
 * it can only drop an exclude.
 * @param {string} name
 * @returns {boolean}
 */
function isConfigInjection(name) {
	return /^GIT_CONFIG(_|$)/.test(name) && name !== "GIT_CONFIG_NOSYSTEM";
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {(name: string) => boolean} drop
 * @returns {NodeJS.ProcessEnv}
 */
function buildEnvWithout(env, drop) {
	return Object.fromEntries(Object.entries(env).filter(([n]) => !drop(n)));
}

/**
 * Whether `dir` holds a `.git` entry. One lstat cannot read for any reason
 * but its absence counts as one, so a check leaning on it fails closed.
 * @param {string} dir
 */
function hasGitEntry(dir) {
	try {
		fs.lstatSync(path.join(dir, ".git"));
		return true;
	} catch (e) {
		return caught(e).code !== "ENOENT";
	}
}

/**
 * The directories from `dir` up that hold a `.git` entry, nearest first,
 * stopping below `stop` where it is met.
 * @param {string} dir
 * @param {string} [stop]
 * @returns {string[]}
 */
function readGitEntryDirs(dir, stop) {
	const found = [];
	for (let d = dir; d !== stop; d = path.dirname(d)) {
		if (hasGitEntry(d)) found.push(d);
		if (path.dirname(d) === d) return found;
	}
	return found;
}

/**
 * Whether the `.git` entry in `dir` may be a repository: anything but an
 * empty directory.
 * @param {string} dir
 * @returns {boolean}
 */
function isRepoEntry(dir) {
	const entry = path.join(dir, ".git");
	try {
		return (
			!fs.lstatSync(entry).isDirectory() || fs.readdirSync(entry).length > 0
		);
	} catch {
		return true;
	}
}

/**
 * Who a query stands for, which sets the 128s isOutsideAnyRepo trusts: the
 * host root's plain shell, the caller's shell, or a plain shell pinned to the
 * `.git` entry in its own directory.
 * @typedef {"root" | "caller" | "pinned"} QueryKind
 * @typedef {{ cwd: string, env: NodeJS.ProcessEnv, kind: QueryKind }} GitQuery
 */

/**
 * The caller's environment less PATHSPEC_MODES, git's messages untranslated.
 * @returns {NodeJS.ProcessEnv}
 */
function buildCallerEnv() {
	return buildEnvWithout({ ...process.env, LC_ALL: "C" }, (n) =>
		PATHSPEC_MODES.includes(n),
	);
}

/**
 * `env` as a shell without REDIRECTS or injected config holds it.
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
function buildPlainEnv(env) {
	return buildEnvWithout(
		env,
		(n) => REDIRECTS.includes(n) || isConfigInjection(n),
	);
}

/**
 * Where git is asked about a file under `root`: from `root` in a plain
 * shell, as one without REDIRECTS or injected config finds the repository;
 * from the caller's directory with the caller's environment, as a commit
 * from the caller's shell sees it, which a bare repository entered through
 * GIT_DIR and GIT_WORK_TREE, or a `core.worktree` naming the root, is
 * (#3063); and from `root` with it, as that shell sees it once in `root`,
 * where a GIT_DIR with no work tree takes `root` as its work tree.
 * @param {string} root
 * @returns {GitQuery[]}
 */
function buildHostQueries(root) {
	const caller = buildCallerEnv();
	return [
		{ cwd: root, env: buildPlainEnv(caller), kind: "root" },
		{ cwd: process.cwd(), env: caller, kind: "caller" },
		{ cwd: root, env: caller, kind: "caller" },
	];
}

/**
 * buildHostQueries, and a plain shell's pinned to each `.git` entry that may
 * be a repository from `root` or the caller's directory up: a repository
 * nested at the root hides an outer one that may still track the file
 * (#3063), and git's own search steps past a damaged `.git` to the healthy
 * one above it, where pinned it fails (#3080). It is pinned by a ceiling at
 * its parent, not GIT_DIR, which would skip git's ownership check, the
 * guard against running another user's config. Residual: a `.git` there
 * that another user owns fails git's ownership check, so every run refuses
 * as "git could not say".
 * @param {string} root
 * @returns {GitQuery[]}
 */
function buildTrackedQueries(root) {
	const dirs = new Set(
		[...readGitEntryDirs(root), ...readGitEntryDirs(process.cwd())].filter(
			isRepoEntry,
		),
	);
	return buildHostQueries(root).concat([...dirs].map(buildPinnedQuery));
}

/**
 * A plain shell's query pinned to the `.git` entry in `dir`.
 * @param {string} dir
 * @returns {GitQuery}
 */
function buildPinnedQuery(dir) {
	return {
		cwd: dir,
		env: {
			...buildPlainEnv(buildCallerEnv()),
			GIT_CEILING_DIRECTORIES: path.dirname(dir),
		},
		kind: "pinned",
	};
}

/**
 * buildHostQueries less injected config: an exclude it injects is one a
 * shell without it would not apply (#3063). And a pinned query per `.git`
 * above `root` whose index holds entries under it: git descends into a
 * directory it tracks files in even where that directory holds a repository
 * of its own, so `add -A` there stages a `.env` only the nested one ignores
 * (#3073). One that says it tracks nothing under `root`, a dotfiles `~/.git`
 * above every project, never descends, so it is not asked; one that cannot
 * say is, failing toward the warning.
 * @param {string} root
 * @returns {GitQuery[]}
 */
function buildIgnoredQueries(root) {
	const host = buildHostQueries(root).map((q) => ({
		...q,
		env: buildEnvWithout(q.env, isConfigInjection),
	}));
	const outer = readGitEntryDirs(root)
		.filter((d) => d !== root && isRepoEntry(d))
		.map(buildPinnedQuery)
		.filter((q) => {
			const indexLost = isGitPathMissing(q, "index");
			return buildSpellings(q, root, "").some(
				(named) => isTrackedBy(q, root, named, indexLost) !== false,
			);
		});
	return host.concat(outer);
}

/**
 * @param {GitQuery} query
 * @param {string[]} args
 * @param {"ignore" | "pipe"} [stdout]
 */
function runQuery(query, args, stdout = "ignore") {
	return spawnGitSync(args, {
		cwd: query.cwd,
		env: query.env,
		encoding: "utf8",
		stdio: ["ignore", stdout, "pipe"],
	});
}

/**
 * Whether any `.git` from `dir` up, below `stop`, isRepoEntry. After a
 * no-repository 128 it is one git cannot open (lost HEAD, refs or index; a
 * gitfile or symlink whose target moved) that a commit may take the file
 * into once it is mended (#2777, #3063). `stop` is the mount point git's
 * search stopped at: a `.git` above it has a pinned query of its own (#3080).
 * Residual: an empty directory that is a git directory's unmounted mount
 * point reads as no repository.
 * @param {string} dir
 * @param {string} [stop]
 * @returns {boolean}
 */
function mayHoldRepo(dir, stop) {
	return readGitEntryDirs(dir, stop).some(isRepoEntry);
}

const MOUNT_STOP =
	/^fatal: not a git repository \(or any parent up to mount point (.+)\)$/m;

/**
 * Whether git's fatal 128 says it found a repository that cannot take the
 * file: outside the work tree, inside a submodule, or with no work tree.
 * @param {string} stderr
 * @returns {boolean}
 */
function isOutsideMessage(stderr) {
	return (
		stderr.includes("' is outside repository at '") ||
		stderr.includes("' is in submodule '") ||
		stderr.startsWith("fatal: this operation must be run in a work tree")
	);
}

/**
 * Whether git's fatal 128 under `query` says no repository it reaches can
 * commit a file under `root`: git names it outside the work tree it found or
 * inside a submodule, has no work tree, or finds no repository. The caller's
 * queries trust no-repository only where git searched and found none, as the
 * path form there may name an inherited GIT_DIR mid-move (#3063). A pinned
 * query's no-repository is its own `.git` damaged. The root's trusts one
 * where mayHoldRepo finds nothing from the root up, and no 128 where the
 * root holds a `.git` of its own, since a damaged one there prints the same
 * from inside a repository (#2777). Residual: a bare repository the
 * caller's directory is, damaged so git cannot open it, holds no `.git` to
 * ask from, so a GIT_WORK_TREE naming the root and its no-repository reads
 * as outside.
 * @param {GitQuery} query
 * @param {string} root
 * @param {string} stderr
 * @returns {boolean}
 */
function isOutsideAnyRepo(query, root, stderr) {
	const outside = isOutsideMessage(stderr);
	if (query.kind === "caller")
		return outside || stderr.startsWith("fatal: not a git repository (or any");
	if (query.kind === "pinned") return outside;
	if (hasGitEntry(root)) return false;
	const mount = stderr.match(MOUNT_STOP);
	return (
		outside ||
		(stderr.startsWith("fatal: not a git repository") &&
			!mayHoldRepo(
				query.cwd,
				mount ? requiredGroup(mount, 1, MOUNT_STOP) : undefined,
			))
	);
}

/**
 * `p` as the kernel resolves it: the JS realpath reads a `..` after a
 * symlink as text, naming a directory git never opens (#3080).
 * @param {string} p
 * @returns {string | null}
 */
function realpathOrNull(p) {
	try {
		return fs.realpathSync.native(p);
	} catch {
		return null;
	}
}

const GITFILE = /^gitdir: (.+)$/m;

/**
 * The git directory the `.git` entry in `dir` names, resolved, or null where
 * it names none.
 * @param {string} dir
 * @returns {string | null}
 */
function readGitDir(dir) {
	const entry = path.join(dir, ".git");
	try {
		if (!fs.statSync(entry).isFile()) return realpathOrNull(entry);
		const m = fs.readFileSync(entry, "utf8").match(GITFILE);
		if (!m) return null;
		// Joined, not path.resolve'd, which would collapse a `..` as text.
		const target = requiredGroup(m, 1, GITFILE);
		return realpathOrNull(
			path.isAbsolute(target) ? target : `${dir}${path.sep}${target}`,
		);
	} catch {
		return null;
	}
}

/**
 * What `git <args>` prints under `query`, its newline dropped, or null where
 * it fails.
 * @param {GitQuery} query
 * @param {string[]} args
 * @returns {string | null}
 */
function readGitOutput(query, args) {
	const r = runQuery(query, args, "pipe");
	return r.status === 0 ? r.stdout.replace(/\n$/, "") : null;
}

/**
 * Whether a pinned query opened its own `.git`: GIT_CEILING_DIRECTORIES
 * splits on `:` with no escape, so a parent path holding one sets no
 * ceiling (#3080). Where git opens none, ls-files reports that itself.
 * @param {GitQuery} query
 * @returns {boolean}
 */
function isPinHeld(query) {
	const dir = readGitOutput(query, ["rev-parse", "--absolute-git-dir"]);
	return dir === null || isOwnGitDir(dir, query.cwd);
}

/**
 * Whether `gitDir`, as git printed it, is the one the `.git` entry in `dir`
 * names.
 * @param {string} gitDir
 * @param {string} dir
 * @returns {boolean}
 */
function isOwnGitDir(gitDir, dir) {
	const opened = realpathOrNull(gitDir);
	return opened !== null && opened === readGitDir(dir);
}

/**
 * Whether a root query's fatal 128 comes from the root's own `.git` being a
 * bare repository (#3088). Git has no work tree to place the absolute
 * spelling in, while the relative one still reads the index, so the 128 says
 * nothing about tracking. A damaged `.git` is never the one git opens, so
 * #2777's distrust of it stands. isIgnored does not take it: a bare
 * repository cannot say it ignores the file a dotfiles alias's `--work-tree`
 * would commit.
 * @param {GitQuery} query
 * @param {string} root
 * @param {string} stderr
 * @returns {boolean}
 */
function isBareRootOutside(query, root, stderr) {
	if (query.kind !== "root" || !isOutsideMessage(stderr)) return false;
	const out = readGitOutput(query, [
		"rev-parse",
		"--is-bare-repository",
		"--absolute-git-dir",
	]);
	const [bare, dir] = out?.split("\n") ?? [];
	return bare === "true" && dir !== undefined && isOwnGitDir(dir, root);
}

/**
 * Whether `name` under the git directory `query` reaches is missing. Where
 * git cannot name it, it reads as present: the `logs/HEAD` caller then reads
 * null, and the `index` caller's ls-files reports the failure itself.
 * @param {GitQuery} query
 * @param {string} name
 * @returns {boolean}
 */
function isGitPathMissing(query, name) {
	const p = resolveGitPath(query, name);
	return p !== null && !fs.existsSync(p);
}

/**
 * The absolute path of `name` under the git directory `query` reaches, or
 * null where git cannot name it.
 * @param {GitQuery} query
 * @param {string} name
 * @returns {string | null}
 */
function resolveGitPath(query, name) {
	const p = readGitOutput(query, ["rev-parse", "--git-path", name]);
	return p === null ? null : path.resolve(query.cwd, p);
}

const GITLINK_MODE = "160000";

const NULL_OID = /^0+$/;

/**
 * The commit the newest entry of reflog `log` moved to, or from where that
 * move deleted the ref: none where the reflog is absent or holds no entry,
 * or the deleted ref was unborn; null where git cannot name it or it cannot
 * be read.
 * @param {GitQuery} query
 * @param {string} log
 * @returns {string[] | null}
 */
function readReflogTip(query, log) {
	const p = resolveGitPath(query, log);
	if (p === null) return null;
	/** @type {string} */
	let text;
	try {
		text = fs.readFileSync(p, "utf8");
	} catch (e) {
		return caught(e).code === "ENOENT" ? [] : null;
	}
	const last = text.trimEnd().split("\n").pop() ?? "";
	if (last === "") return [];
	const [from, to] = last.split(" ");
	if (from === undefined || to === undefined) return null;
	if (!NULL_OID.test(to)) return [to];
	return NULL_OID.test(from) ? [] : [from];
}

/**
 * The commits HEAD would be restored to, or null where git cannot name one.
 * A HEAD that resolves is its commit; one that does not is the tip of each
 * of HEAD's and its branch's reflogs, as restoring a lost ref takes it from
 * there, and none where neither has one: an unborn branch. An orphan has
 * the tip of the branch it left, as checking it out logs no move. A git
 * older than 2.45 echoes `--show-ref-format` back, and knows no other format.
 * Residual: reftable keeps no reflog files, so its unresolved HEAD is null,
 * and a project dir below the top of a reftable repository whose HEAD is
 * unborn, fresh from `git init` among them, refuses as git could not say
 * (#3100).
 * @param {GitQuery} query
 * @returns {string[] | null}
 */
function readHeadCommits(query) {
	const head = readGitOutput(query, ["rev-parse", "--verify", "-q", "HEAD"]);
	if (head !== null) return [head];
	const format = readGitOutput(query, ["rev-parse", "--show-ref-format"]);
	if (format !== "files" && format !== "--show-ref-format") return null;
	const reflogs = ["logs/HEAD"];
	const ref = readGitOutput(query, ["symbolic-ref", "-q", "HEAD"]);
	if (ref !== null) reflogs.push(`logs/${ref}`);
	/** @type {string[]} */
	const commits = [];
	for (const log of reflogs) {
		const tip = readReflogTip(query, log);
		if (tip === null) return null;
		commits.push(...tip);
	}
	return commits;
}

/**
 * The paths at which the index of the work tree `query`
 * reaches, or a commit its HEAD would be restored to, records a gitlink, a
 * submodule: HEAD too, as a `git reset` brings back one `git rm --cached`
 * staged out. Null where git cannot list either.
 * @param {GitQuery} query
 * @returns {Set<string> | null}
 */
function readGitlinks(query) {
	const staged = runQuery(
		query,
		["ls-files", "-s", "-z", "--full-name", "--", ":(top)"],
		"pipe",
	);
	if (staged.status !== 0) return null;
	const commits = readHeadCommits(query);
	if (commits === null) return null;
	const listed = [staged.stdout];
	for (const commit of commits) {
		const r = runQuery(
			query,
			["ls-tree", "-r", "-z", "--full-tree", commit],
			"pipe",
		);
		if (r.status !== 0) return null;
		listed.push(r.stdout);
	}
	return new Set(
		listed
			.join("\0")
			.split("\0")
			.filter((e) => e.startsWith(`${GITLINK_MODE} `))
			.map((e) => e.slice(e.indexOf("\t") + 1)),
	);
}

/**
 * Whether a path in `gitlinks`, under `top`, names directory `d` though
 * spelt otherwise: the filesystem folds case or Unicode form there, as
 * macOS's and a Windows drive's do, so `.env` written in `d` lands in that
 * submodule (#3063). One inode for both spellings proves it. Where the
 * filesystem mints an inode per spelling (CIFS under `noserverino`, FUSE
 * without `use_ino`), names equal once folded match wherever either is not
 * listed under its own spelling.
 * On ext4 a healthy `Lib` beside a plain `lib/` is another directory, both
 * listed (#3100).
 * @param {Set<string>} gitlinks
 * @param {string} top
 * @param {string} d
 * @returns {boolean}
 */
function isFoldedGitlink(gitlinks, top, d) {
	const rel = path.relative(top, d);
	const at = statOrNull(d);
	for (const g of gitlinks) {
		const other = statOrNull(path.join(top, g));
		if (at && other && other.dev === at.dev && other.ino === at.ino)
			return true;
		if (
			foldName(g) === foldName(rel) &&
			!(isListed(top, rel) && isListed(top, g))
		)
			return true;
	}
	return false;
}

/**
 * `p` folded as near as JS can to a filesystem's case and Unicode folding:
 * upper then lower case meets `σ` and `ς`, and NFC meets HFS+'s decomposed
 * names. It folds some pairs no filesystem does (`ß` and `ss`); those match
 * only where isListed finds a spelling unlisted, and refuse.
 * @param {string} p
 * @returns {string}
 */
function foldName(p) {
	return p.normalize("NFC").toUpperCase().toLowerCase();
}

/**
 * Whether each segment of `rel` under `top` is listed under that spelling.
 * A directory that cannot be listed reads as not, so the caller refuses.
 * @param {string} top
 * @param {string} rel
 * @returns {boolean}
 */
function isListed(top, rel) {
	let dir = top;
	for (const seg of rel.split(path.sep)) {
		try {
			if (!fs.readdirSync(dir).includes(seg)) return false;
		} catch {
			return false;
		}
		dir = path.join(dir, seg);
	}
	return true;
}

/**
 * Any failure reads as no inode: isFoldedGitlink's name check then decides.
 * @param {string} p
 * @returns {fs.Stats | null}
 */
function statOrNull(p) {
	try {
		return fs.statSync(p);
	} catch {
		return null;
	}
}

/**
 * Whether a directory from `root` up to the top of the work tree `query`
 * reaches is a submodule git cannot open: the work tree records a gitlink
 * there and the directory holds no repository. Its git directory, wherever
 * it is kept, may still track the file, and a restored `.git` file commits
 * it (#3087). An uninitialised or deinitialised submodule reads so too, as
 * does any directory there where git cannot list the gitlinks. A `.git`
 * that cannot be read counts as a repository, whose pinned query answers.
 * A gitlink spelt otherwise than the root matches only where
 * isFoldedGitlink finds the filesystem folds it (#3100).
 * Residual: a submodule neither the index nor a commit HEAD would be
 * restored to records (added but never committed with the index lost,
 * moved but not committed with the index lost, removed in a commit, or
 * recorded only on a branch HEAD is not on) whose
 * directory and git directory remain, and one whose directory now holds
 * another repository, are not found: reading its git directory would mean
 * opening it through GIT_DIR.
 * @param {GitQuery} query
 * @param {string} root
 * @returns {boolean}
 */
function hasLostSubmodule(query, root) {
	// --show-cdup, as --show-toplevel is check-host-root.js's second
	// host-root seam. Where git cannot place the work tree, isTrackedBy's
	// query reports that failure itself.
	const cdup = readGitOutput(query, ["rev-parse", "--show-cdup"]);
	const top =
		cdup === null ? null : realpathOrNull(path.resolve(query.cwd, cdup));
	const real = realpathOrNull(root);
	if (top === null || real === null) return false;
	// A root outside this work tree lies in none of its submodules, and
	// isTrackedBy reads this query as outside it; the query whose work tree
	// does hold the root runs this check for itself (#3100).
	if (top !== path.parse(top).root && !isUnder(real, [top], path.sep))
		return false;
	/** @type {Set<string> | null | undefined} */
	let gitlinks;
	for (let d = real; d !== top; d = path.dirname(d)) {
		if (hasGitEntry(d) && isRepoEntry(d)) continue;
		gitlinks ??= readGitlinks(query);
		if (gitlinks === null) return true;
		if (
			gitlinks.has(path.relative(top, d)) ||
			isFoldedGitlink(gitlinks, top, d)
		)
			return true;
	}
	return false;
}

/**
 * One query's answer on `file`, one spelling of it: `ls-files --error-unmatch`
 * exits 0 tracked, 1 untracked. Its 128 is git's general fatal exit, so it
 * reads as untracked only where isOutsideAnyRepo says so. Any other 128 (a
 * corrupt index, dubious ownership) and anything else, git missing included,
 * is null: FAILS CLOSED (#640 review, #2777).
 * A LOST INDEX (#3080) hides what HEAD tracks and a `git reset` brings back,
 * so where it is lost `--with-tree=HEAD` counts HEAD's files too; a staged
 * `git rm --cached` keeps the index, as its commit removes the file. A HEAD
 * git cannot resolve reads as unborn only where HEAD has no reflog, which
 * would restore a lost or emptied branch ref. Residual: a lost index whose
 * branch ref and HEAD reflog are lost too reads as unborn (#3098).
 * CASE-BLIND (#3063): on a case-insensitive filesystem a tracked `.ENV`, or
 * `.env` under a directory or work tree spelled in another case, is the file
 * a write to `.env` lands in. The pathspec's `icase` covers the path inside
 * the work tree and `core.ignorecase` the work tree's own prefix.
 * @param {GitQuery} query
 * @param {string} root
 * @param {string} file
 * @param {boolean} indexLost
 * @returns {boolean | null}
 */
function isTrackedBy(query, root, file, indexLost) {
	const r = runQuery(query, [
		"-c",
		"core.ignorecase=true",
		"ls-files",
		...(indexLost ? ["--with-tree=HEAD"] : []),
		"--error-unmatch",
		"--",
		`:(icase,literal)${file}`,
	]);
	if (r.status === 0) return true;
	if (r.status === 1) return false;
	if (
		indexLost &&
		r.status === 128 &&
		r.stderr.startsWith("fatal: tree-ish HEAD not found")
	)
		return isGitPathMissing(query, "logs/HEAD") ? false : null;
	if (
		r.status === 128 &&
		(isOutsideAnyRepo(query, root, r.stderr) ||
			isBareRootOutside(query, root, r.stderr))
	)
		return false;
	return null;
}

/**
 * `file` under `root` as a query names it: absolute, and relative to the
 * query's directory. Each misreads one layout, so both are asked (#3063):
 * a relative path from outside the work tree names a path under its top,
 * and an absolute one reads as outside a work tree only injected
 * `core.worktree` names.
 * @param {GitQuery} query
 * @param {string} root
 * @param {string} file
 * @returns {string[]}
 */
function buildSpellings(query, root, file) {
	const absolute = path.join(root, file);
	return [absolute, path.relative(query.cwd, absolute)];
}

/**
 * Whether git tracks `file` under `root`, the strictest of the queries'
 * answers.
 * The binary is WFC_GIT's (base §N7): a stub answering 1, or 128 with a
 * message isOutsideAnyRepo trusts, defeats this check, as a decoy `git`
 * first on PATH does where WFC_GIT is unset. Residual: a repository git
 * reaches through neither the environment nor a `.git` entry, a dotfiles
 * alias passing `--git-dir`, is not asked; nor is a linked worktree whose
 * `.git` gitfile was deleted, whose index under the main repository's
 * `worktrees/` may still track the file, as nothing at the root names it
 * (#3080).
 * @param {string} root
 * @param {string} file
 * @returns {boolean | null}
 */
function isTracked(root, file) {
	const answers = buildTrackedQueries(root).flatMap((q) => {
		if (q.kind === "pinned" && !isPinHeld(q)) return [null];
		if (hasLostSubmodule(q, root)) return [null];
		const indexLost = isGitPathMissing(q, "index");
		return buildSpellings(q, root, file).map((f) =>
			isTrackedBy(q, root, f, indexLost),
		);
	});
	if (answers.includes(true)) return true;
	return answers.includes(null) ? null : false;
}

/**
 * Whether git ignores `file` under `root` in every query and spelling that
 * reaches a repository able to commit it. Any other failure reads as "not ignored",
 * which fails toward the warning (#640).
 * A plain path, not isTrackedBy's pathspec: `check-ignore` refuses pathspec
 * magic, and forcing `core.ignorecase` here could only silence the warning.
 * @param {string} root
 * @param {string} file
 * @returns {boolean}
 */
function isIgnored(root, file) {
	return buildIgnoredQueries(root).every((query) =>
		buildSpellings(query, root, file).every((named) => {
			const r = runQuery(query, ["check-ignore", "-q", "--", named]);
			return (
				r.status === 0 ||
				(r.status === 128 && isOutsideAnyRepo(query, root, r.stderr))
			);
		}),
	);
}

/**
 * Warns where git would let `.env`, or the aside writeFileAtomic leaves when a
 * run dies or its cleanup fails, be committed. Before the value is asked for,
 * so a refused or killed run is warned too (#2255).
 * @param {string} root
 */
function warnUnignored(root) {
	const aside = asidePath(".env", "<pid>", "<hex>");
	// A real aside's shape, which an ignore rule for that shape must match.
	const sample = asidePath(".env", 0, "00000000");
	if (!isIgnored(root, ".env")) {
		process.stderr.write(
			`write-secret: warning — git does not ignore .env in ${root}, so it could be committed. Add .env and .env.*.tmp to .gitignore.\n`,
		);
	} else if (!isIgnored(root, sample)) {
		process.stderr.write(
			`write-secret: warning — git ignores .env in ${root} but not ${aside}, the copy of .env an interrupted write leaves, so it could be committed. Add .env.*.tmp to .gitignore.\n`,
		);
	}
}

const LEFT = "a copy of .env an earlier interrupted write left";
const ROTATE =
	"its secrets are in history. Rotate them, then git rm --cached it";

/**
 * Removes, or names and leaves, the aside `name` at `root`, written by `pid`,
 * never reading it.
 * @param {string} root
 * @param {string} name
 * @param {number} pid
 */
function sweepAside(root, name, pid) {
	const file = path.join(root, name);
	const tracked = isTracked(root, name);
	if (tracked === null) {
		const when = pidAlive(pid) ? " once no write-secret runs" : "";
		process.stderr.write(
			`write-secret: warning — ${file}, ${LEFT}, was left: git could not say whether it is tracked. If it is, ${ROTATE}; either way, delete it${when}.\n`,
		);
	} else if (tracked) {
		process.stderr.write(
			`write-secret: warning — ${file}, ${LEFT}, is tracked by git, so ${ROTATE}.\n`,
		);
	} else if (pidAlive(pid)) {
		process.stderr.write(
			`write-secret: left ${file}, a copy of .env: its pid ${pid} is running, so it may be a run still writing. Delete it once no write-secret runs.\n`,
		);
	} else {
		try {
			fs.rmSync(file);
			process.stderr.write(`write-secret: removed ${file}, ${LEFT}.\n`);
		} catch (e) {
			process.stderr.write(
				`write-secret: warning — ${file}, ${LEFT}, could not be removed (${caught(e).code ?? "error"}). Delete it by hand.\n`,
			);
		}
	}
}

/** @param {string} root */
function sweepAsides(root) {
	let names;
	try {
		names = fs.readdirSync(root);
	} catch (e) {
		process.stderr.write(
			`write-secret: warning — ${root} could not be listed (${caught(e).code ?? "error"}), so ${LEFT} may remain there. Look for .env.*.tmp by hand.\n`,
		);
		return;
	}
	for (const name of names) {
		const pid = asidePid(".env", name);
		if (pid === null) continue;
		const stat = fs.lstatSync(path.join(root, name), { throwIfNoEntry: false });
		if (stat?.isFile()) sweepAside(root, name, pid);
	}
}

/**
 * The value from piped stdin, less one trailing line break.
 * @returns {string}
 */
function readPiped() {
	return fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
}

/**
 * `value` as a .env line's right-hand side, or null where none reads back.
 * @param {string} value
 * @returns {string | null}
 */
function quoteValue(value) {
	if (!/[#$`]|^["'`]|["'`]$/.test(value)) return value;
	return value.includes("'") ? null : `'${value}'`;
}

/**
 * `text` with <name>'s value replaced on every line assigning it, or the
 * assignment appended.
 * @param {string} text
 * @param {string} name
 * @param {string} value
 * @returns {{ text: string, replaced: boolean }}
 */
function upsert(text, name, value) {
	const assigns = new RegExp(
		`^([ \\t]*(?:export[ \\t]+)?${name}[ \\t]*=[ \\t]*).*?(\\r?)$`,
	);
	let replaced = false;
	const lines = text.split("\n").map((line) => {
		const m = line.match(assigns);
		if (!m) return line;
		replaced = true;
		return `${m[1]}${value}${m[2]}`;
	});
	if (replaced) return { text: lines.join("\n"), replaced };
	if (text === "") return { text: `${name}=${value}\n`, replaced };
	return text.endsWith("\n")
		? { text: `${text}${name}=${value}\n`, replaced }
		: { text: `${text}\n${name}=${value}`, replaced };
}

/**
 * Upserts the value, once it is in hand, into `.env` at `root`.
 * @param {string} root
 * @param {string} name
 * @param {string} raw
 * @param {boolean} fromTerminal whether `raw` was typed at the hidden prompt
 * @returns {number}
 */
function upsertEnv(root, name, raw, fromTerminal) {
	if (/[\r\n]/.test(raw)) {
		return refuse(
			"the value holds a line break, which one .env line cannot carry. Re-run and give it on one line.",
			2,
		);
	}
	const trimmed = raw.trim();
	if (trimmed === "") {
		return refuse(emptyWhy(name, root, fromTerminal), 2);
	}
	const value = quoteValue(trimmed);
	if (value === null) {
		return refuse(
			"the value holds a single quote as well as #, $, a backtick or a quote at an end, which no .env quoting reads back intact. Store it elsewhere, or rotate to a value without them.",
			2,
		);
	}

	const envPath = path.join(root, ".env");
	try {
		let text = "";
		let mode = 0o600;
		if (fs.existsSync(envPath)) {
			text = fs.readFileSync(envPath, "utf8");
			mode = fs.statSync(envPath).mode & 0o777;
		}
		const next = upsert(text, name, value);
		writeFileAtomic(envPath, next.text, { mode });
		process.stdout.write(
			`write-secret: ${next.replaced ? "replaced" : "added"} ${name} in ${envPath}\n`,
		);
	} catch (e) {
		return refuse(
			`${envPath} could not be written (${caught(e).code ?? "error"}). Check it is a regular file you can write, then re-run.`,
			1,
		);
	}

	return 0;
}

/**
 * @param {string[]} argv
 * @returns {number | Promise<number>} exit status
 */
function main(argv) {
	const parsed = parseOrCode(argv, { usage: USAGE, min: 1 });
	if (typeof parsed === "number") return parsed;
	const { positionals } = parsed;
	const [name] = positionals;
	if (name === undefined)
		throw new Error("parse passed no <NAME> despite min: 1");
	if (!VAR_NAME.test(name)) {
		return refuse(
			"the argument is not a shell variable name (letters, digits and underscores, not starting with a digit). The value is asked for afterwards, never given on the command line.",
			2,
		);
	}

	const root = hostRoot();
	sweepAsides(root);
	const envPath = path.join(root, ".env");
	const tracked = isTracked(root, ".env");
	if (tracked === null) {
		return refuse(
			`git could not say whether ${envPath} is tracked, so the secret might be committed. Check git runs in ${root}, then re-run.`,
			1,
		);
	}
	if (tracked) {
		return refuse(
			`${envPath} is tracked by git, so a secret written there would be committed. Untrack it (git rm --cached .env) and ignore it first.`,
			1,
		);
	}
	if (fs.lstatSync(envPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
		return refuse(
			`${envPath} is a symlink, whose target git may track. Replace it with a regular file, then re-run.`,
			1,
		);
	}

	warnUnignored(root);

	if (!process.stdin.isTTY) return upsertEnv(root, name, readPiped(), false);
	process.stderr.write(`Value for ${name} (typing hidden, Enter to finish): `);
	return readHidden(process.stdin).then(
		(raw) => {
			process.stderr.write("\n");
			return upsertEnv(root, name, raw, true);
		},
		() => {
			process.stderr.write("\n");
			return refuse("interrupted. Re-run to enter the value.", 2);
		},
	);
}

if (require.main === module) {
	const status = main(process.argv.slice(2));
	/* Set synchronously where it can be: the piped path is the test seam, and
	 * `lib/run-in-process.js` reads the exit before any promise settles. */
	if (typeof status === "number") process.exitCode = status;
	else
		status.then(
			(s) => {
				process.exitCode = s;
			},
			(e) => {
				process.stderr.write(`write-secret: ${e}\n`);
				process.exitCode = 1;
			},
		);
}
