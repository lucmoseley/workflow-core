/*
 * git-fixture.ts — a git-repository template built once per worker process
 * and handed out as relinked, leak-checked copies (mantahostels#2068, spec mantahostels#2048).
 *
 * FOR TESTS ONLY. Nothing under scripts/ that runs in a hook, a gate or CI
 * should require this: a real invocation wants its own `git init`, matching
 * scripts/lib/run-in-process.js's own header warning.
 *
 * WHY: building the template once and handing out copies pays one
 * `fs.cpSync` instead of a rebuild per test (mantahostels#2016). mantahostels#2048 generalises that
 * pattern so every file doing the same thing shares one implementation of
 * it.
 *
 * WHAT A COPY BREAKS, AND WHY RELINKING IS NOT OPTIONAL: git writes ABSOLUTE
 * paths into a repository's own metadata — `core.hooksPath` and any
 * remote/submodule URL in `.git/config`, a worktree's `.git` pointer file,
 * the `gitdir`/`commondir` files under `.git/worktrees/<name>/`, and
 * `.git/objects/info/alternates`. A plain recursive copy of a finished
 * template leaves every one of those pointing at the TEMPLATE, so a commit
 * made in the copy — or in a copied worktree especially — lands in the
 * template's own object store and leaks into the next test. Nothing fails
 * loudly on its own: a worktree sharing its parent's objects is exactly what
 * git is for.
 *
 * Relinking below is DISCOVERED by walking the copy for `.git` entries,
 * rather than a hand-written list of paths per fixture (mantahostels#2048).
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";

/** Builds a template's contents into `dir`, which already exists. */
export type BuildFn = (dir: string) => void;

export type LeakCheckMode = "always" | "first-only";

export interface DefineTemplateOptions {
	/**
	 * Default "always": every instantiation is scanned for a surviving
	 * template path. "first-only" scans once and trusts every later copy —
	 * for a template large enough that the walk itself is a cost worth
	 * avoiding. Getting this wrong fails silent, not loud, so it is opt-in
	 * per template rather than a blanket default.
	 */
	leakCheck?: LeakCheckMode;
}

export interface InstantiateOptions {
	/**
	 * Extra paths, relative to the instance root, to fold into the
	 * relink/leak-check walk — a non-git file that also carries an absolute
	 * path, e.g. an arbiter store or a written CLAUDE_PROJECT_DIR.
	 */
	extraPaths?: string[];
}

export interface TemplateHandle {
	/** Copies the template into `destination`, relinks and leak-checks it. */
	instantiate: (destination: string, options?: InstantiateOptions) => string;
}

export interface VariantTemplateHandle {
	/** As TemplateHandle#instantiate, for the named variant's own template. */
	instantiate: (
		destination: string,
		variant: string,
		options?: InstantiateOptions,
	) => string;
}

/**
 * The escape hatch (mantahostels#2048 story 21): set to build straight into the
 * destination on every call, bypassing the template and the copy entirely —
 * for diagnosing a suspected template-sharing bug in one run rather than by
 * editing the file.
 */
const DIRECT_ENV = "WFC_GIT_FIXTURE_DIRECT";

const isDirect = (): boolean => process.env[DIRECT_ENV] === "1";

/** The repository this file ships in — resolved from the module's own path so
 * a chdir in a test, and a run from a detached worktree, both still land in
 * the tree the run is actually reading. */
const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

let scratchBaseCache: string | null = null;

/**
 * Where every fixture directory is minted, template and destination alike —
 * NOT `os.tmpdir()` (mantahostels#3149).
 *
 * WHY: `/tmp` was shared with whatever else the job put there, and something
 * under it deleted mid-copy (mantahostels#3144) — moving off it was meant to test that.
 * It didn't stop the deletion (mantahostels#3194): whatever it is followed the fixtures
 * here, or never depended on `/tmp` being shared. `copyTemplate` below
 * carries the falsification and the reopened candidate list.
 *
 * `RUNNER_TEMP` is the runner's own per-job scratch (`…/work/_temp` on GitHub
 * Actions), private to the job and swept with it. Off CI it is unset and the
 * base is `.claude/tmp/`, this repo's one sanctioned in-repo scratch
 * directory (mantahostels#2089, the environment doc's §12) — gitignored, excluded from
 * vitest's collection and from Biome, and reaped at 24 hours, none of which
 * reaches a directory living for the length of one test. `tsc --noEmit`
 * never reached it either: `**` globs skip dot-directories on their own, the
 * mechanism `tsconfig.json`'s skills-scripts include line documents (mantahostels#1138),
 * so mantahostels#3159's alarm on this directory was a false premise.
 *
 * Resolved once and realpath'd. Three consumers need the realpath: the leak
 * check below compares absolute path STRINGS; concision-backstop derives an
 * arbiter slug from the path; run-vitest compares it against `git rev-parse`,
 * which resolves symlinks itself. The realpath limb and the memoisation are
 * both UNVERIFIED — the covering test holds vacuously on a symlink-free path,
 * and nothing observes a second resolution.
 */
export function scratchBase(): string {
	if (scratchBaseCache === null) {
		const base = resolveScratchBase(process.env, REPO_ROOT);
		fs.mkdirSync(base, { recursive: true });
		scratchBaseCache = fs.realpathSync(base);
	}
	return scratchBaseCache;
}

/**
 * `scratchBase()`'s choice, without the mkdir — the seam the branch is tested
 * through, since the real one memoises `process.env` at first call. A relative
 * `RUNNER_TEMP` is ignored rather than joined onto: the base has to be
 * absolute for every caller, whatever its cwd.
 */
export function resolveScratchBase(
	env: Readonly<Record<string, string | undefined>>,
	repoRoot: string,
): string {
	const runnerTemp = env.RUNNER_TEMP;
	return runnerTemp && path.isAbsolute(runnerTemp)
		? path.join(runnerTemp, "wfc-fixtures")
		: path.join(repoRoot, ".claude", "tmp", "git-fixture");
}

/**
 * `fs.mkdtempSync` under `base`, which defaults to `scratchBase()`, creating
 * that base if a neighbour or the 24-hour reaper has removed it since it was
 * resolved.
 *
 * Every fixture root that instantiates a template mints through here, on the
 * default base; the parameter is the seam the regrow branch is proven
 * through, and its only caller is that one test. The shared base is one
 * directory for every file in a run, so a test removing it to watch it regrow
 * pulls the templates out from under the other workers (mantahostels#3168). Regrowth is
 * therefore proven on a private base, leaving one limb UNVERIFIED: that the
 * MEMOISED shared base regrows after removal.
 *
 * The paragraph below is about the default base, and a caller passing one of
 * its own outside the repository escapes every word of it.
 *
 * ONE HAZARD COMES WITH IT: this base is INSIDE the repository itself, so a
 * directory minted here is too, and git resolves upwards out of it rather
 * than reporting no repository. A fixture asserting out-of-repo behaviour
 * therefore takes `mkDirOutsideRepo` below, or sets `GIT_CEILING_DIRECTORIES`
 * at or under the base on the invocation, which stops git's walk there. The
 * ceiling reaches git alone: guard-parse.sh's `_gp_inside_any_repo` walks the
 * path lexically and still finds the repository's `.git`, so a case that must reach its
 * "no repository at all" branch needs the helper (mantahostels#3158). A second
 * consequence of living in the tree: `git clean -fdx` here now removes a
 * neighbouring session's live fixtures, which on `/tmp` it could not.
 */
export function mkScratchDir(prefix: string, base = scratchBase()): string {
	fs.mkdirSync(base, { recursive: true });
	return fs.mkdtempSync(path.join(base, prefix));
}

/**
 * A directory in NO repository, for a case asserting what a guard does with
 * one — the route a fixture takes to leave `scratchBase()`, since that base
 * sits inside the repository itself (`mkScratchDir` above, whose `base`
 * parameter is the other way out and is a test seam, not this). The caller
 * removes it.
 *
 * Throws where `base` itself sits under a `.git`: there every such case would
 * resolve to that repository and pass through the "another repository" branch
 * instead, green (mantahostels#3158).
 */
export function mkDirOutsideRepo(prefix: string, base = os.tmpdir()): string {
	const at = fs.mkdtempSync(path.join(fs.realpathSync(base), prefix));
	for (let p = at; ; p = path.dirname(p)) {
		if (fs.existsSync(path.join(p, ".git"))) {
			fs.rmSync(at, { recursive: true, force: true });
			throw new Error(
				`${at} sits inside a repository (${p}/.git), so a case asserting out-of-repo behaviour there would not be one`,
			);
		}
		if (path.dirname(p) === p) return at;
	}
}

/** One lazily-built template: the directory, and whether the leak check has
 * already run once for "first-only" mode. */
class Template {
	private dir: string | null = null;
	private leakChecked = false;

	constructor(
		private readonly build: BuildFn,
		private readonly leakCheckMode: LeakCheckMode,
	) {
		// Registered here, at defineTemplate() time, not lazily in ensureBuilt():
		// vitest only honours a hook registered while a suite is being
		// COLLECTED, which happens before any beforeEach/it body ever runs. An
		// afterAll registered from inside ensureBuilt() — reached only once a
		// test calls instantiate() — is silently never called, leaking every
		// template directory for the life of the worker.
		afterAll(() => {
			if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
			this.dir = null;
		});
	}

	private ensureBuilt(): string {
		if (this.dir === null) {
			const dir = mkScratchDir("git-fixture-tpl-");
			this.build(dir);
			this.dir = dir;
		}
		return this.dir;
	}

	instantiate(destination: string, options: InstantiateOptions = {}): string {
		const extraPaths = options.extraPaths ?? [];
		if (isDirect()) {
			fs.mkdirSync(destination, { recursive: true });
			this.build(destination);
			return destination;
		}
		const templateDir = this.ensureBuilt();
		const source = copyTemplate(templateDir, destination, fs.cpSync, () => {
			this.dir = null;
			// A rebuild is a NEW absolute path, so "first-only" must scan again.
			this.leakChecked = false;
			return this.ensureBuilt();
		});
		relink(destination, source, extraPaths);
		const shouldCheck = this.leakCheckMode === "always" || !this.leakChecked;
		if (shouldCheck) {
			checkForLeak(destination, source);
			this.leakChecked = true;
		}
		return destination;
	}
}

/**
 * Every `.git` entry (directory or gitdir-pointer file) under `root`.
 *
 * RESIDUAL (mantahostels#2068 review): a symlinked directory is not descended into
 * (`isDirectory()` reads false for a symlink), so a `.git` entry reachable
 * only through one is neither relinked nor leak-checked, and `fs.cpSync`
 * copies the symlink itself verbatim. Not walking a symlink is deliberate —
 * a symlink cycle would loop forever — but nothing in a template built by
 * this repo's own fixtures creates one today.
 *
 * RESIDUAL (mantahostels#2068 review): a submodule's own `.git/modules/<name>/config` is
 * not reached — a `.git` entry `continue`s the walk rather than being
 * descended into, so only the superproject's `.git/config` and a submodule's
 * own working-tree `.git` pointer file are covered. Untested; no fixture in
 * this repo builds a submodule template.
 */
function findGitEntries(root: string): string[] {
	const found: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		// biome-ignore lint/style/noNonNullAssertion: length checked above
		const dir = stack.pop()!;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.name === ".git") {
				found.push(full);
				continue;
			}
			if (entry.isDirectory()) stack.push(full);
		}
	}
	return found;
}

/** The files a given `.git` entry may have written the template's absolute
 * path into, filtered to the ones that actually exist. */
function relinkCandidatesFor(gitEntry: string): string[] {
	if (!fs.statSync(gitEntry).isDirectory()) {
		// A worktree or submodule pointer file: "gitdir: <absolute path>".
		return [gitEntry];
	}
	const candidates = [
		path.join(gitEntry, "config"),
		path.join(gitEntry, "objects", "info", "alternates"),
	];
	const worktrees = path.join(gitEntry, "worktrees");
	if (fs.existsSync(worktrees)) {
		for (const name of fs.readdirSync(worktrees)) {
			candidates.push(path.join(worktrees, name, "gitdir"));
			candidates.push(path.join(worktrees, name, "commondir"));
		}
	}
	return candidates.filter((p) => fs.existsSync(p));
}

/** Repoints every discovered path-bearing file at `destination`, in place. */
function relink(
	destination: string,
	templateDir: string,
	extraPaths: string[],
): void {
	const candidates = new Set<string>();
	for (const gitEntry of findGitEntries(destination))
		for (const file of relinkCandidatesFor(gitEntry)) candidates.add(file);
	for (const rel of extraPaths) {
		const full = path.join(destination, rel);
		if (fs.existsSync(full)) candidates.add(full);
	}
	for (const file of candidates) {
		const text = fs.readFileSync(file, "utf8");
		if (text.includes(templateDir)) {
			fs.writeFileSync(file, text.split(templateDir).join(destination));
		}
	}
}

/** True for the first 8 KB of `buf` carrying a NUL byte — cheap enough for a
 * fixture-sized tree. */
function looksBinary(buf: Buffer): boolean {
	const len = Math.min(buf.length, 8000);
	for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
	return false;
}

/** True for a path the leak scan skips outright: `.git/objects/` (pack and
 * loose object data, sharing exactly what a worktree is for) and `.git/index`
 * (git's own binary index, never a text carrier of the template's path).
 * Exported for its own direct test (mantahostels#2068 review) — the
 * objects/info/alternates carve-out has no path through the public
 * `instantiate()` API that fails when it regresses, since `relink()` already
 * rewrites that file before the scan runs. */
export function isSkippedFromLeakScan(relFromDestination: string): boolean {
	const segments = relFromDestination.split(path.sep);
	const gitAt = segments.lastIndexOf(".git");
	if (gitAt === -1) return false;
	const after = segments.slice(gitAt + 1);
	if (after[0] === "objects") {
		// objects/info/alternates is the one file under objects/ relink() itself
		// rewrites (relinkCandidatesFor above) — the leak scan must still reach
		// it, or the safety net is blind to exactly the failure it exists to
		// catch (mantahostels#2068 review). Everything else under objects/ is pack/loose object data, which
		// is legitimately huge and never a text carrier of the template's path.
		// The walker calls this on every ancestor on the way down too, so the
		// path TO alternates ("objects", "objects/info") must not be skipped
		// either, or it is never descended into to reach the file itself.
		const onAlternatesPath =
			after.length === 1 ||
			(after.length === 2 && after[1] === "info") ||
			(after.length === 3 && after[1] === "info" && after[2] === "alternates");
		return !onAlternatesPath;
	}
	if (after.length === 1 && after[0] === "index") return true;
	return false;
}

/** Scans the whole copy for a surviving occurrence of `templateDir`, throwing
 * and naming the offending file the moment one is found. */
function checkForLeak(destination: string, templateDir: string): void {
	const stack = [destination];
	while (stack.length > 0) {
		// biome-ignore lint/style/noNonNullAssertion: length checked above
		const dir = stack.pop()!;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			const rel = path.relative(destination, full);
			if (isSkippedFromLeakScan(rel)) continue;
			if (entry.isDirectory()) stack.push(full);
			else if (entry.isFile()) assertNoTemplatePath(full, templateDir);
		}
	}
}

/** Throws, naming `full`, where that file is text and names `templateDir`. */
function assertNoTemplatePath(full: string, templateDir: string): void {
	const buf = fs.readFileSync(full);
	if (looksBinary(buf)) return;
	if (buf.toString("utf8").includes(templateDir)) {
		throw new Error(
			`git-fixture: ${full} still names the template path ` +
				`(${templateDir}) after relinking — a leaked absolute path ` +
				"that would let a write in this copy reach the template.",
		);
	}
}

/**
 * `fs.cpSync(templateDir, destination, { recursive: true })`, retried once on
 * failure — mantahostels#2379. The caught error is printed rather than swallowed (§N5,
 * `docs/code-standards-base.md`).
 *
 * The destination is removed before the retry (mantahostels#2437) — git writes loose
 * objects `0444`, and `cpSync`'s overwrite is a plain open-for-write with no
 * unlink first, so replaying it over a partial `.git/objects/<xx>` from
 * attempt one throws EACCES (the error names the parent directory, which is
 * why CI reports `.git/objects/1f` rather than an object file) instead of
 * finishing the copy.
 *
 * Closes only one of mantahostels#2427's two sweep failures — `prepare-commit-msg-gate.test.ts`'s
 * EACCES, this mechanism exactly. The other, real `fs.cpSync` ENOENT naming a
 * destination's own `.git/objects` on a destination never written to before
 * the retry, is a different cause (mantahostels#2460).
 *
 * mantahostels#2460 reproduced nothing across four attempts (evidence on the issue) and
 * closed on its own accept-and-record acceptance criterion rather than a fix.
 *
 * The candidate this left standing was something external deleting under
 * `/tmp` mid-copy on the CI runner specifically — untested by all four axes,
 * none of which introduced an external deleter or ran on CI's own runner.
 * mantahostels#3144's triage evidenced it: the same real ENOENT fires in GREEN runs too,
 * absorbed by the retry above, in three unrelated fixtures across two runs.
 *
 * mantahostels#2427's AC 2 was finally tried, at mantahostels#3149: `scratchBase()` above moves the
 * fixture roots off `/tmp`. THE CANDIDATE IS FALSIFIED: run `34014755713`,
 * one sweep after the fix landed, logged `retrying (mantahostels#2379): ENOENT: no such
 * file or directory, lstat '…/_temp/wfc-fixtures/git-fixture-tpl-nIhzwH'` —
 * a path under `scratchBase()`, not `/tmp`, and not one of
 * `git-fixture.test.ts`'s own injected-failure fixtures (those mint
 * `git-fixture-copy-tpl-` and always carry `simulated` in the thrown
 * message). Moving off the runner's shared `/tmp` did not stop it, so the
 * deleter is not `/tmp`'s shared nature specifically. Candidate list,
 * reopened at mantahostels#3194: the runner's own per-job housekeeping reaching
 * `RUNNER_TEMP` too, a concurrency bug internal to this file's own template
 * lifecycle, or the git-version mismatch below. A path naming `/tmp` is
 * still one of the raw `git init` fixtures outside this file and proves
 * nothing either way.
 *
 * THE INTERNAL-CONCURRENCY CANDIDATE IS RULED OUT BY MECHANISM (mantahostels#3194).
 * Every mint goes through `fs.mkdtempSync` (`mkScratchDir`, above), so no
 * two `Template`s — in the same file or a different one — ever hold the same
 * path to collide on. The only code that removes a `git-fixture-tpl-`
 * directory is that `Template`'s own `afterAll` (`:220-223`), which vitest
 * registers per collected suite; `vitest.config.ts` sets no `isolate`
 * override, so the `forks` pool's default (`true`) gives each test FILE its
 * own module graph, and a fresh `Template` with it — one file's afterAll
 * cannot reach a path it never minted. Within one file, `ensureBuilt()` and
 * `copyTemplate()` run back-to-back with no `await` between them
 * (`Template.instantiate`, `:242-243`), and every build/copy step underneath
 * — `execFileSync`, `fs.cpSync` — is synchronous, so nothing in this
 * process's own event loop can interleave an afterAll between a template
 * being handed out and being copied from — including this SAME `Template`'s
 * own `afterAll` racing a later `instantiate()` in one file: vitest runs
 * `afterAll` only once every `it()` in the collected suite has settled, so
 * there is no later call for it to race. The one place this file's own
 * tests deliberately remove a base out from under a live mint — the regrow
 * case at `git-fixture.test.ts:620-627` — targets a caller-supplied PRIVATE
 * base, never the memoised `scratchBase()` every worker shares. This does
 * not reach a hazard outside Node's own execution model — a kill signal or
 * a host-level OOM reaper landing mid-syscall is not "internal" to this
 * file and is covered by the runner-housekeeping candidate below instead.
 *
 * THE RUNNER-HOUSEKEEPING CANDIDATE IS UNTESTABLE FROM THIS SEAM — nothing
 * under `scripts/` observes the runner's own process tree or its temp-dir
 * policy, and this repo's workflows (`.github/workflows/*.yml`) touch
 * `RUNNER_TEMP` only for `actionlint`'s own tarball and `bisect.yml`'s
 * scratch script, never as a sweep target. Next diagnostic step: GitHub
 * Actions' own raw logs already carry a per-line timestamp (`gh run view <id> --log`), so run `34014755713`'s failure and
 * mantahostels#3144's three absorbed-but-logged ENOENTs give four data points today —
 * line up each one against its job's own start time and see whether the
 * offset repeats. A periodic external sweep should recur at a roughly fixed
 * offset across those four; an in-process cause would not.
 *
 * THE MAINTENANCE CANDIDATE LEADS, UNCONFIRMED (#806). It rests on the git
 * version mismatch: CI's git 2.55.0 against this machine's 2.43.0. After
 * `git commit` (`initGitRepo`, below) recent git runs auto-maintenance DETACHED, and that
 * process takes a lock file under `.git/objects` — so it can be writing into
 * a template while `cpSync` walks it, the `.git/objects` path both #806 red
 * sweeps' ENOENTs name, and can recreate an entry under a template just
 * deleted, which is #124's symptom below. `vitest.setup.ts` now turns
 * `maintenance.auto` and `gc.auto` off for every git call that inherits the
 * test process's env, which every call in this file does. The
 * evidence that would confirm it: the scheduled sweep's log, which carried
 * 1–3 `template copy failed once … .git/objects` lines a sweep before #806,
 * carrying none after. Any such line refutes it.
 *
 * The reset is an unconditional `fs.rmSync(destination, { recursive: true,
 * force: true })` of a caller-supplied path — sound only because every
 * caller (`Template.instantiate`, `:233`) mints `destination` itself rather
 * than accepting caller-owned content there; nothing in this function's
 * signature enforces that. `force: true` makes it a silent no-op wherever
 * attempt one wrote nothing (the ENOENT path above, and a source-side
 * `rebuild`).
 *
 * A retry only finishes a DESTINATION-side failure. If the SOURCE has gone,
 * the replay is against a path already known to be missing and fails
 * identically, so `rebuild` is called first and its fresh directory copied
 * instead. The dir copied from is returned because relinking and the leak
 * check must both run against that path, not the vanished one (mantahostels#2392).
 *
 * THE REBUILD IS NOT DECIDED BY `fs.existsSync` ALONE (#124). That check is
 * kept only as a fast path — it skips a replay already known to be doomed —
 * and a source that survives it but fails the replay ANYWAY now rebuilds too.
 * The symptom that forced it: on a runner, a template directory the test had
 * just deleted still read as present, so the doomed replay ran and threw. Of
 * the candidates above only the maintenance one explains that — which is why
 * the replay's own message is printed when it fails. The copy from the
 * rebuilt directory is retried once too (#806).
 *
 * RESIDUALS. `rebuild` is optional, so a caller passing none — everything but
 * `Template` today — still replays against the vanished source and throws. And
 * a template directory still present but EMPTIED rebuilds nothing either way:
 * copying an empty tree throws nothing, so neither the existence check nor the
 * replay failure fires, and the destination gets an empty copy.
 *
 * `cpSync` is a parameter, defaulting to the real one, so a test can inject a
 * failing function instead of mocking `fs` itself (§X2,
 * `docs/code-standards-base.md`).
 */
export function copyTemplate(
	templateDir: string,
	destination: string,
	cpSync: typeof fs.cpSync = fs.cpSync,
	rebuild?: () => string,
): string {
	const messageOf = (err: unknown): string =>
		err instanceof Error ? err.message : String(err);
	const copyFrom = (source: string): string => {
		fs.rmSync(destination, { recursive: true, force: true });
		cpSync(source, destination, { recursive: true });
		return source;
	};
	// `run` is passed in rather than read off `rebuild` so each caller's own
	// `if (rebuild)` is what narrows it.
	const rebuildAndCopy = (run: () => string, why: string): string => {
		const source = run();
		console.warn(
			`git-fixture: template dir ${templateDir} ${why}; rebuilt at ${source}`,
		);
		try {
			return copyFrom(source);
		} catch (err) {
			console.warn(
				`git-fixture: rebuilt template copy failed once, retrying (#806): ${messageOf(err)}`,
			);
			return copyFrom(source);
		}
	};
	try {
		cpSync(templateDir, destination, { recursive: true });
		return templateDir;
	} catch (err) {
		// Printed before the rebuild, which can throw and would otherwise take
		// the original failure with it (§N5).
		console.warn(
			`git-fixture: template copy failed once, retrying (mantahostels#2379): ${messageOf(err)}`,
		);
		if (rebuild && !fs.existsSync(templateDir))
			return rebuildAndCopy(rebuild, "had vanished (mantahostels#2392)");
		try {
			return copyFrom(templateDir);
		} catch (again) {
			if (!rebuild) throw again;
			return rebuildAndCopy(
				rebuild,
				`failed the replay too (#124: ${messageOf(again)})`,
			);
		}
	}
}

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/**
 * Initialises a git repo at `at`: `main` branch, a test identity, hooks
 * disabled, one commit of `a.md`. `hooks` must be an existing empty
 * directory — a deliberate sentinel, since a missing path disables hooks by
 * accident — and `hooks` itself must be absolute, since this checkout's
 * `core.hooksPath` is and a scratch repo would otherwise run its Husky gates.
 */
export function initGitRepo(at: string, hooks: string): void {
	fs.mkdirSync(at, { recursive: true });
	git(at, "init", "-q", "-b", "main", ".");
	git(at, "config", "user.email", "test@example.com");
	git(at, "config", "user.name", "test");
	git(at, "config", "core.hooksPath", hooks);
	fs.writeFileSync(path.join(at, "a.md"), "a\n");
	git(at, "add", "a.md");
	git(at, "commit", "-qm", "init");
}

export interface TrioOptions {
	/**
	 * How `wt` is attached to `shared`. Default "branch" creates it on a
	 * branch named "side"; "detach" opens it with no branch, for a fixture
	 * that tests the no-branch case.
	 */
	worktree?: "branch" | "detach";
}

/**
 * The shared/elsewhere/worktree trio most guard fixtures need (mantahostels#2178): two
 * independent repos, `shared` and `elsewhere`, plus a linked worktree of
 * `shared` at `wt`. Returns a `BuildFn` for `defineTemplate()`.
 */
export function trioTemplate(options: TrioOptions = {}): BuildFn {
	const worktreeArgs =
		options.worktree === "detach"
			? ["worktree", "add", "-q", "--detach"]
			: ["worktree", "add", "-q", "-b", "side"];
	return (root: string) => {
		const hooks = path.join(root, "no-hooks");
		fs.mkdirSync(hooks);
		initGitRepo(path.join(root, "shared"), hooks);
		initGitRepo(path.join(root, "elsewhere"), hooks);
		git(path.join(root, "shared"), ...worktreeArgs, path.join(root, "wt"));
	};
}

/**
 * Defines a git-fixture template. The single-function form builds one
 * template on first `instantiate()`; the named-variant form
 * (`{ name: buildFn, ... }`) builds a separate template per name, each lazily
 * on its own first use — for a file whose tests need several pre-built
 * states rather than one (mantahostels#2048 finding 2).
 *
 * Call this at describe scope, not inside a `beforeEach`/`it` body: it
 * registers an `afterAll` for template teardown, and vitest only honours a
 * hook registered while a suite is being collected (mantahostels#2068 review).
 */
export function defineTemplate(
	build: BuildFn,
	options?: DefineTemplateOptions,
): TemplateHandle;
export function defineTemplate(
	variants: Record<string, BuildFn>,
	options?: DefineTemplateOptions,
): VariantTemplateHandle;
export function defineTemplate(
	buildOrVariants: BuildFn | Record<string, BuildFn>,
	options: DefineTemplateOptions = {},
): TemplateHandle | VariantTemplateHandle {
	const leakCheckMode = options.leakCheck ?? "always";

	if (typeof buildOrVariants === "function") {
		const template = new Template(buildOrVariants, leakCheckMode);
		return {
			instantiate: (destination: string, instOpts?: InstantiateOptions) =>
				template.instantiate(destination, instOpts),
		};
	}

	const templates = new Map<string, Template>();
	for (const [name, build] of Object.entries(buildOrVariants))
		templates.set(name, new Template(build, leakCheckMode));

	return {
		instantiate: (destination, variant, instOpts) => {
			const template = templates.get(variant);
			if (!template) {
				throw new Error(
					`git-fixture: no variant named "${variant}" — defined: ` +
						`${[...templates.keys()].join(", ")}`,
				);
			}
			return template.instantiate(destination, instOpts);
		},
	};
}
