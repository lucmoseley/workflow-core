// @vitest-environment node
/*
 * The before/after test's sandboxes (#2042), built by the command against
 * throwaway stand-ins: a "live" config dir the arm copy must not link to, and
 * a git repo whose sandbox clone must push nowhere but its own bare origin,
 * run its own commit hooks, and reach `gh` only as a stub that logs and
 * reaches nothing. A break here lets an arm write to the founder's live config
 * or to GitHub.
 *
 * `gh` is spawned through PATH on purpose: PATH is the sandbox's own contract
 * with a session's Bash calls, which never read `WFC_GH`.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process";

const ROOT = path.resolve(__dirname, "..");
const cliPath = path.join(ROOT, "scripts", "build-arm-sandbox.js");

let tmp: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arm-sandbox-"));
});
afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

const run = (args: string[], env: NodeJS.ProcessEnv = process.env) => {
	const r = runInProcess(cliPath, args, { cwd: ROOT, env });
	return { out: r.stdout, err: r.stderr, code: r.status };
};

const symlinksUnder = (dir: string): string[] =>
	fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		if (e.isSymbolicLink()) return [p];
		return e.isDirectory() ? symlinksUnder(p) : [];
	});

describe("config: an arm's config dir", () => {
	/** `~/.claude` holds the files; `~/.claude3` links to them, as on this machine. */
	const liveLayer = () => {
		const home = path.join(tmp, "home");
		const live = path.join(home, ".claude");
		const seat = path.join(home, ".claude3");
		fs.mkdirSync(path.join(live, "plugins", "cache", "p"), { recursive: true });
		fs.mkdirSync(path.join(live, "hooks"), { recursive: true });
		fs.mkdirSync(seat);
		fs.writeFileSync(path.join(live, "CLAUDE.md"), "today's text\n");
		fs.writeFileSync(
			path.join(live, "settings.json"),
			JSON.stringify({
				hooks: {
					PreToolUse: [
						{ hooks: [{ command: '"$HOME"/.claude/hooks/guard.sh' }] },
					],
				},
			}),
		);
		fs.writeFileSync(path.join(live, "hooks", "guard.sh"), "exit 0\n");
		fs.writeFileSync(
			path.join(live, "plugins", "installed_plugins.json"),
			JSON.stringify({
				a: `${seat}/plugins/cache/p`,
				b: `${home}/.claude2/plugins/cache/p`,
			}),
		);
		fs.writeFileSync(path.join(live, "plugins", "cache", "p", "x.md"), "x\n");
		fs.symlinkSync(
			"x.md",
			path.join(live, "plugins", "cache", "p", "alias.md"),
		);
		fs.symlinkSync(
			"gone.md",
			path.join(live, "plugins", "cache", "p", "dangling.md"),
		);
		for (const e of ["CLAUDE.md", "settings.json", "plugins"])
			fs.symlinkSync(`../.claude/${e}`, path.join(seat, e));
		fs.mkdirSync(path.join(home, ".claude2"));
		fs.symlinkSync(
			"../.claude/plugins",
			path.join(home, ".claude2", "plugins"),
		);
		return { home, live, seat };
	};

	it("holds no symlink, and names its own copies where the live layer named live paths", () => {
		const { home, live, seat } = liveLayer();
		const to = path.join(tmp, "arm-a");
		const r = run(["config", "--from", seat, "--to", to], {
			...process.env,
			HOME: home,
		});
		expect(r.code, r.err).toBe(0);
		expect(symlinksUnder(to)).toEqual([]);
		expect(fs.readFileSync(path.join(to, "CLAUDE.md"), "utf8")).toBe(
			"today's text\n",
		);
		expect(
			fs.readFileSync(
				path.join(to, "plugins", "cache", "p", "alias.md"),
				"utf8",
			),
		).toBe("x\n");
		expect(fs.existsSync(path.join(to, "hooks", "guard.sh"))).toBe(true);
		expect(fs.readFileSync(path.join(to, "settings.json"), "utf8")).toContain(
			`${to}/hooks/guard.sh`,
		);
		expect(
			JSON.parse(
				fs.readFileSync(
					path.join(to, "plugins", "installed_plugins.json"),
					"utf8",
				),
			),
		).toEqual({
			a: `${to}/plugins/cache/p`,
			b: `${to}/plugins/cache/p`,
		});
		const summary = JSON.parse(r.out);
		expect(summary.liveRefs).toEqual([]);
		expect(summary.skipped).toEqual([
			path.join(live, "plugins", "cache", "p", "dangling.md"),
		]);

		fs.writeFileSync(path.join(to, "CLAUDE.md"), "changed in the arm\n");
		expect(fs.readFileSync(path.join(live, "CLAUDE.md"), "utf8")).toBe(
			"today's text\n",
		);
	});

	it("carries arm B's cut text in place of the live CLAUDE.md", () => {
		const { home, seat } = liveLayer();
		const cut = path.join(tmp, "cut.md");
		fs.writeFileSync(cut, "the cut text\n");
		const to = path.join(tmp, "arm-b");
		expect(
			run(
				[
					"config",
					"--from",
					seat,
					"--to",
					to,
					"--override",
					`CLAUDE.md=${cut}`,
				],
				{ ...process.env, HOME: home },
			).code,
		).toBe(0);
		expect(fs.readFileSync(path.join(to, "CLAUDE.md"), "utf8")).toBe(
			"the cut text\n",
		);
	});

	it("carries arm A's pre-cut settings and hook, live paths rewritten to the copy", () => {
		const { home, seat } = liveLayer();
		const settings = path.join(tmp, "settings.pre");
		fs.writeFileSync(
			settings,
			JSON.stringify({
				hooks: {
					Stop: [{ hooks: [{ command: "$HOME/.claude/hooks/guard.sh" }] }],
				},
			}),
		);
		const hook = path.join(tmp, "guard.pre");
		fs.writeFileSync(hook, "#!/bin/sh\necho pre-cut\n");
		const to = path.join(tmp, "arm-a");
		const r = run(
			[
				"config",
				"--from",
				seat,
				"--to",
				to,
				"--override",
				`settings.json=${settings}`,
				"--override",
				`hooks/guard.sh=${hook}`,
			],
			{ ...process.env, HOME: home },
		);
		expect(r.code).toBe(0);
		expect(
			JSON.parse(fs.readFileSync(path.join(to, "settings.json"), "utf8")).hooks
				.Stop[0].hooks[0].command,
		).toBe(`${to}/hooks/guard.sh`);
		expect(fs.readFileSync(path.join(to, "hooks", "guard.sh"), "utf8")).toBe(
			"#!/bin/sh\necho pre-cut\n",
		);
	});

	it("refuses an override aimed outside the copy, and writes nothing", () => {
		const { home, seat } = liveLayer();
		const to = path.join(tmp, "arm-a");
		const r = run(
			["config", "--from", seat, "--to", to, "--override", `../escape=${tmp}`],
			{ ...process.env, HOME: home },
		);
		expect(r.code).toBe(1);
		expect(r.err).toContain("--override takes");
		expect(fs.existsSync(to)).toBe(false);
	});
});

describe("task: one run's sandbox", () => {
	const git = (cwd: string, ...args: string[]) =>
		spawnSync(
			"git",
			["-c", "user.name=t", "-c", "user.email=t@invalid", ...args],
			{
				cwd,
				encoding: "utf8",
			},
		);

	const sourceRepo = () => {
		const repo = path.join(tmp, "source");
		fs.mkdirSync(repo);
		git(repo, "init", "--quiet", "-b", "main");
		git(repo, "config", "user.email", "test@example.com");
		git(repo, "config", "user.name", "test");
		fs.writeFileSync(path.join(repo, "f.txt"), "before\n");
		// The repo arms its hooks from `prepare`.
		fs.writeFileSync(
			path.join(repo, "package.json"),
			JSON.stringify({
				scripts: { prepare: "git config core.hooksPath .hooks" },
			}),
		);
		fs.mkdirSync(path.join(repo, ".hooks"));
		fs.writeFileSync(
			path.join(repo, ".hooks", "pre-commit"),
			"#!/bin/sh\ntouch pre-commit-ran\n",
			{ mode: 0o755 },
		);
		git(repo, "add", "f.txt", "package.json", ".hooks/pre-commit");
		git(repo, "commit", "--quiet", "-m", "one");
		fs.writeFileSync(path.join(repo, "f.txt"), "after\n");
		git(repo, "commit", "--quiet", "-am", "the landing commit");
		return repo;
	};

	it("reverts the task's commit, pushes only to its own bare origin, and stubs gh", () => {
		const repo = sourceRepo();
		const landing = git(repo, "rev-parse", "HEAD").stdout.trim();
		const issue = path.join(tmp, "issue.json");
		fs.writeFileSync(
			issue,
			JSON.stringify({ title: "Do it", body: "The ticket." }),
		);
		const to = path.join(tmp, "run-1");
		const r = run([
			"task",
			"--repo",
			repo,
			"--at",
			"HEAD",
			"--to",
			to,
			"--revert",
			landing,
			"--issue",
			`7=${issue}`,
			"--node-modules",
			fs.mkdtempSync(path.join(tmp, "nm-")),
		]);
		expect(r.code, r.err).toBe(0);
		const { repo: clone, origin, log, hooksPath } = JSON.parse(r.out);
		expect(hooksPath).toBe(".hooks");
		expect(fs.readFileSync(path.join(clone, "f.txt"), "utf8")).toBe("before\n");
		expect(git(clone, "log", "-1", "--format=%s").stdout.trim()).toBe(
			"Start the task",
		);

		fs.writeFileSync(path.join(clone, "f.txt"), "redone\n");
		git(clone, "commit", "--quiet", "-am", "redo");
		expect(fs.existsSync(path.join(clone, "pre-commit-ran"))).toBe(true);
		expect(git(clone, "push", "--quiet").status).toBe(0);
		expect(git(origin, "log", "-1", "--format=%s", "main").stdout.trim()).toBe(
			"redo",
		);
		expect(git(repo, "rev-parse", "HEAD").stdout.trim()).toBe(landing);

		const env = {
			...process.env,
			PATH: `${path.join(to, "bin")}:${process.env.PATH}`,
		};
		const gh = (...args: string[]) =>
			spawnSync("gh", args, { cwd: clone, env, encoding: "utf8" });
		expect(gh("issue", "comment", "7", "--body", "done").status).toBe(0);
		expect(
			JSON.parse(gh("issue", "view", "7", "--json", "title").stdout),
		).toEqual({ title: "Do it" });
		const unanswered = gh("pr", "list");
		expect(unanswered.status).not.toBe(0);
		expect(unanswered.stderr).toContain("no fixture answers `gh pr list`");
		const filtered = gh(
			"issue",
			"view",
			"7",
			"--json",
			"title",
			"--jq",
			".title",
		);
		expect(filtered.status).not.toBe(0);
		expect(
			gh("api", "graphql", "-f", "query={ viewer { login } }").status,
		).not.toBe(0);
		expect(gh("api", "graphql", "-f", "query=mutation { x }").status).toBe(0);
		const calls = fs
			.readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(calls.map((c) => [c.argv[1], c.write])).toEqual([
			["comment", true],
			["view", false],
			["list", false],
			["view", false],
			["graphql", false],
			["graphql", true],
		]);
		const stub = path.join(to, "bin", "gh");
		expect(fs.lstatSync(stub).isSymbolicLink()).toBe(false);
		expect(fs.readFileSync(stub, "utf8")).toBe(
			fs.readFileSync(
				path.join(ROOT, "scripts", "lib", "arm-gh-stub.js"),
				"utf8",
			),
		);
		const sandboxEnv = fs.readFileSync(path.join(to, "sandbox.env"), "utf8");
		expect(sandboxEnv).toContain(`export WFC_GH="${stub}"`);
		expect(sandboxEnv).toContain("GH_HOST=gh-stub.invalid");
		expect(sandboxEnv).toContain("GIT_ALLOW_PROTOCOL=file");
	});

	it.each([
		["a config dir's jobs tree", path.join(".claude3", "jobs", "abc", "run")],
		["a repo's worktrees", path.join("repo", ".claude", "worktrees", "run")],
		["a jobs tree reached through a link", path.join("link", "run")],
	])("refuses a target inside %s", (_, rel) => {
		fs.mkdirSync(path.join(tmp, ".claude3", "jobs"), { recursive: true });
		fs.symlinkSync(path.join(tmp, ".claude3", "jobs"), path.join(tmp, "link"));
		const target = path.join(tmp, rel);
		const r = run([
			"task",
			"--repo",
			sourceRepo(),
			"--at",
			"HEAD",
			"--to",
			target,
		]);
		expect(r.code).toBe(1);
		expect(r.err).toContain(`${target} is inside`);
		expect(r.err).toContain("build the sandbox outside every one");
	});

	/** An arm config dir whose wfc-self marketplace and install name the live checkout. */
	const armConfig = () => {
		const live = "/live/workflow-core/self-plugin";
		const configDir = path.join(tmp, "arm-config");
		fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
		const known = path.join(configDir, "plugins", "known_marketplaces.json");
		fs.writeFileSync(
			known,
			JSON.stringify({
				"wfc-self": {
					source: { source: "directory", path: live },
					installLocation: live,
				},
				other: {
					source: { source: "github", repo: "o/other" },
					installLocation: "/live/other",
				},
			}),
		);
		const installed = path.join(configDir, "plugins", "installed_plugins.json");
		fs.writeFileSync(
			installed,
			JSON.stringify({
				version: 2,
				plugins: { "wfc-self@wfc-self": [{ installPath: live }] },
			}),
		);
		const settings = path.join(configDir, "settings.json");
		fs.writeFileSync(
			settings,
			JSON.stringify({
				model: "opus",
				extraKnownMarketplaces: {
					"wfc-self": { source: { source: "directory", path: live } },
					other: { source: { source: "github", repo: "o/other" } },
				},
			}),
		);
		return { configDir, known, installed, settings };
	};
	const read = (p: string) => JSON.parse(fs.readFileSync(p, "utf8"));
	const buildWith = (repo: string, configDir: string) =>
		run([
			"task",
			"--repo",
			repo,
			"--at",
			"HEAD",
			"--to",
			path.join(tmp, "run-1"),
			"--config-dir",
			configDir,
		]);

	/** Commits a self-plugin/ into `repo`, and `settings` as its settings file. */
	const withSelfPlugin = (repo: string, settings?: object) => {
		const files: Record<string, string> = {
			"self-plugin/.claude-plugin/marketplace.json": "{}\n",
		};
		if (settings) files[".claude/settings.json"] = JSON.stringify(settings);
		for (const [rel, body] of Object.entries(files)) {
			fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
			fs.writeFileSync(path.join(repo, rel), body);
		}
		git(repo, "add", ...Object.keys(files));
		git(repo, "commit", "--quiet", "-m", "self-plugin");
		return repo;
	};

	it("points the arm config dir's wfc-self marketplace, its settings declaration and its in-place install at the clone (#2440, #2630)", () => {
		const repo = withSelfPlugin(sourceRepo());
		const { configDir, known, installed, settings } = armConfig();
		const before = read(known);
		const settingsBefore = read(settings);
		const r = buildWith(repo, configDir);
		expect(r.code, r.err).toBe(0);
		const { repo: clone, selfPlugin } = JSON.parse(r.out);
		const dir = path.join(clone, "self-plugin");
		expect(selfPlugin).toEqual({ dir });
		expect(read(known)).toEqual({
			...before,
			"wfc-self": {
				source: { source: "directory", path: dir },
				installLocation: dir,
			},
		});
		expect(read(installed).plugins["wfc-self@wfc-self"]).toEqual([
			{ installPath: dir },
		]);
		expect(read(settings)).toEqual({
			...settingsBefore,
			extraKnownMarketplaces: {
				...settingsBefore.extraKnownMarketplaces,
				"wfc-self": { source: { source: "directory", path: dir } },
			},
		});
	});

	it("points the settings declaration at the clone where the arm config dir registers no wfc-self marketplace", () => {
		const repo = withSelfPlugin(sourceRepo());
		const { configDir, known, settings } = armConfig();
		fs.writeFileSync(known, "{}");
		const r = buildWith(repo, configDir);
		expect(r.code, r.err).toBe(0);
		const { repo: clone } = JSON.parse(r.out);
		expect(read(settings).extraKnownMarketplaces["wfc-self"]).toEqual({
			source: { source: "directory", path: path.join(clone, "self-plugin") },
		});
	});

	it("leaves a settings file that declares no wfc-self marketplace as it was, pointing the rest", () => {
		const repo = withSelfPlugin(sourceRepo());
		const { configDir, known, settings } = armConfig();
		fs.writeFileSync(settings, JSON.stringify({ model: "opus" }));
		const r = buildWith(repo, configDir);
		expect(r.code, r.err).toBe(0);
		const { repo: clone } = JSON.parse(r.out);
		expect(read(settings)).toEqual({ model: "opus" });
		expect(read(known)["wfc-self"].installLocation).toBe(
			path.join(clone, "self-plugin"),
		);
	});

	it("leaves the arm config dir as it was for a revision with no self-plugin/", () => {
		const { configDir, known, installed, settings } = armConfig();
		const before = [read(known), read(installed), read(settings)];
		const r = buildWith(sourceRepo(), configDir);
		expect(r.code, r.err).toBe(0);
		expect(JSON.parse(r.out).selfPlugin).toEqual({
			unpointed: "the revision has no self-plugin/",
		});
		expect([read(known), read(installed), read(settings)]).toEqual(before);
	});

	it("refuses a revision that enables wfc-self where the arm config dir registers no marketplace for it, naming the setup", () => {
		const repo = withSelfPlugin(sourceRepo(), {
			enabledPlugins: { "wfc-self@wfc-self": true },
		});
		const configDir = path.join(tmp, "bare-config");
		fs.mkdirSync(configDir);
		const r = buildWith(repo, configDir);
		expect(r.code).toBe(1);
		expect(r.err).toContain("the revision enables wfc-self@wfc-self but");
		expect(r.err).toContain(
			`CLAUDE_CONFIG_DIR=${configDir} claude plugin marketplace add '${path.join(tmp, "run-1", "repo")}/self-plugin' --scope user`,
		);
	});
});
