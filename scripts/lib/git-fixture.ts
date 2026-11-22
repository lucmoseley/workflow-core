import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll } from "vitest";

export type BuildFn = (dir: string) => void;

export type LeakCheckMode = "always" | "first-only";

export interface DefineTemplateOptions {
	leakCheck?: LeakCheckMode;
}

export interface InstantiateOptions {
	extraPaths?: string[];
}

export interface TemplateHandle {
	instantiate: (destination: string, options?: InstantiateOptions) => string;
}

export interface VariantTemplateHandle {
	instantiate: (
		destination: string,
		variant: string,
		options?: InstantiateOptions,
	) => string;
}

const DIRECT_ENV = "WFC_GIT_FIXTURE_DIRECT";

const isDirect = (): boolean => process.env[DIRECT_ENV] === "1";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

let scratchBaseCache: string | null = null;

export function scratchBase(): string {
	if (scratchBaseCache === null) {
		const base = resolveScratchBase(process.env, REPO_ROOT);
		fs.mkdirSync(base, { recursive: true });
		scratchBaseCache = fs.realpathSync(base);
	}
	return scratchBaseCache;
}

export function resolveScratchBase(
	env: Readonly<Record<string, string | undefined>>,
	repoRoot: string,
): string {
	const runnerTemp = env.RUNNER_TEMP;
	return runnerTemp && path.isAbsolute(runnerTemp)
		? path.join(runnerTemp, "wfc-fixtures")
		: path.join(repoRoot, ".claude", "tmp", "git-fixture");
}

export function mkScratchDir(prefix: string, base = scratchBase()): string {
	fs.mkdirSync(base, { recursive: true });
	return fs.mkdtempSync(path.join(base, prefix));
}

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

class Template {
	private dir: string | null = null;
	private leakChecked = false;

	constructor(
		private readonly build: BuildFn,
		private readonly leakCheckMode: LeakCheckMode,
	) {
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

function readRelinkCandidates(gitEntry: string): string[] {
	if (!fs.statSync(gitEntry).isDirectory()) {
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

function relink(
	destination: string,
	templateDir: string,
	extraPaths: string[],
): void {
	const candidates = new Set<string>();
	for (const gitEntry of findGitEntries(destination))
		for (const file of readRelinkCandidates(gitEntry)) candidates.add(file);
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

// guess, lucmoseley/mantahostels#2068
const BINARY_SNIFF_BYTES = 8000;

function looksBinary(buf: Buffer): boolean {
	const len = Math.min(buf.length, BINARY_SNIFF_BYTES);
	for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
	return false;
}

export function isSkippedFromLeakScan(relFromDestination: string): boolean {
	const segments = relFromDestination.split(path.sep);
	const gitAt = segments.lastIndexOf(".git");
	if (gitAt === -1) return false;
	const after = segments.slice(gitAt + 1);
	if (after[0] === "objects") {
		const onAlternatesPath =
			after.length === 1 ||
			(after.length === 2 && after[1] === "info") ||
			(after.length === 3 && after[1] === "info" && after[2] === "alternates");
		return !onAlternatesPath;
	}
	if (after.length === 1 && after[0] === "index") return true;
	return false;
}

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
	worktree?: "branch" | "detach";
}

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

export function cutWorktree(root: string, name = "s1"): string {
	const dir = path.join(root, ".claude", "worktrees", name);
	const exclude = path.join(
		git(root, "rev-parse", "--path-format=absolute", "--git-common-dir").trim(),
		"info",
		"exclude",
	);
	fs.mkdirSync(path.dirname(exclude), { recursive: true });
	fs.appendFileSync(exclude, ".claude/worktrees/\n");
	git(root, "worktree", "add", "-q", "--detach", dir);
	return fs.realpathSync(dir);
}

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

export function mainWorktreeOf(dir: string): string {
	const first = execFileSync("git", ["worktree", "list", "--porcelain"], {
		cwd: dir,
		encoding: "utf8",
	}).split("\n")[0];
	return fs.realpathSync((first ?? "").replace(/^worktree /, ""));
}
