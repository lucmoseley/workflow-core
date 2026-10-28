// @vitest-environment node
/*
 * init-adopter.js writes a fresh repository's day-one skeleton — config, rules
 * file, hooks, .gitignore — that commits green through its own gate stack.
 *
 * init is run as a process against a throwaway repository, because what it
 * promises is a repo that COMMITS (#5).
 *
 * The plugin root is this checkout, which is what an install resolves it to.
 * `--no-tracker` throughout, but for the tracker block, which fakes `gh` at
 * WFC_GH: nothing here touches GitHub.
 *
 * init is the one command a new adopter runs to bootstrap: loosen a case here
 * and that adopter's first commit is refused by the gates init itself installed,
 * or its sessions run from a skeleton that is missing pieces.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { failOpenLogPath } from "./guard-log-fixture";
import { initPaths } from "./init-adopter.js";
import { HOOKS, renderHookShim, TOOLS } from "./lib/adopter-skeleton.js";
import { skeletonPaths } from "./lib/core-owned-files.js";
import { RUFF_INSTALL } from "./lib/formatters.js";
import { stubGhScript } from "./lib/gh-stub";
import { defineTemplate, mkDirOutsideRepo } from "./lib/git-fixture";
import { installPathFor } from "./lib/plugin-state.js";
import { gateTmpdir } from "./lib/precommit-gate-harness.js";
import { allRegistrations, buildCommandLine } from "./lib/registrations.js";
import { runInProcess } from "./lib/run-in-process.js";
import { upgrade } from "./lib/upgrade-walk.js";
import { MODULES } from "./lib/workflow-core-config.js";

const SKELETON_PATHS = skeletonPaths(() => true);

const CORE = path.resolve(__dirname, "..");
const SCRIPT = path.join(__dirname, "init-adopter.js");

const made: string[] = [];
afterAll(() => {
	for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/* The template builds under git-fixture's scratch base, inside this checkout,
 * so the ceiling stops a failed `git init` from letting `git config` write
 * into the checkout's own .git/config (#2875). */
const emptyRepo = defineTemplate((dir) => {
	const env = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(dir) };
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, env });
	git("init", "-q", "-b", "main", ".");
	/* An identity, so the tests' commits are not refused for want of one. */
	git("config", "user.email", "fixture@example.invalid");
	git("config", "user.name", "Adopter Fixture");
});

/* Copies land outside any repository, not under the scratch base, so no
 * test's adopter repo sits inside this checkout. Residual: they are back on
 * the shared /tmp, where mantahostels#3144 saw a fixture deleted mid-copy. */
function repo() {
	const dir = mkDirOutsideRepo("adopter-");
	made.push(dir);
	emptyRepo.instantiate(dir);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, encoding: "utf8" });
	return { dir, git };
}

const init = (dir: string, ...args: string[]) =>
	initIn(process.env, dir, ...args);

const initIn = (env: NodeJS.ProcessEnv, dir: string, ...args: string[]) =>
	spawnSync(
		"node",
		[
			SCRIPT,
			"--root",
			dir,
			"--plugin-root",
			CORE,
			/* Every fixture skips it: a real `claude plugin install` mutates this
			 * machine's own plugin registry and is exercised on its own, against a
			 * stub `claude`, below (#75). */
			"--no-plugin-install",
			...args,
		],
		{
			cwd: dir,
			encoding: "utf8",
			/* init() passes NO CLAUDE_PROJECT_DIR: init sets it for its own
			 * children, so supplying it would prove the harness rather than the
			 * script (#5). */
			env,
		},
	);

/**
 * A stub `claude` that logs its own argv, one line per call, to `log`.
 *
 * Exits 0 for every call alike, so a passing test below proves the right
 * commands were sent, never that `update` actually re-pulled an
 * already-installed plugin (#120).
 */
function stubClaude(log: string) {
	const stub = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-claude-"));
	made.push(stub);
	fs.writeFileSync(
		path.join(stub, "claude"),
		`#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\n`,
		{ mode: 0o755 },
	);
	return stub;
}

/** A pathspec commit of `paths` in the adopter, through its own hooks. */
function commitThroughHooks(
	dir: string,
	message: string,
	paths = SKELETON_PATHS,
	env = process.env,
) {
	/* Intent-to-add, so the pathspec commit the convention asks for can name
	 * files git has never seen. */
	execFileSync("git", ["add", "-N", ...paths], { cwd: dir });
	/* The shims run this checkout, as CI's WORKFLOW_CORE_CHECKOUT would: the
	 * fixture has no install row for them to resolve (#1839). The skeleton's
	 * hooks arm the real shellcheck gate, so the commit takes the fixture's own
	 * TMPDIR for its lock, set after `env` so no caller's replaces it (#2648).
	 * CLAUDE_PROJECT_DIR is the adopter's, as its own session's would be: a
	 * session's inherited value names this checkout, and the hooks would read
	 * its config and run its `npm run check:staged` in the adopter (#3296). */
	return spawnSync("git", ["commit", "-m", message, "--", ...paths], {
		cwd: dir,
		encoding: "utf8",
		env: {
			WORKFLOW_CORE_DIR: CORE,
			...env,
			CLAUDE_PROJECT_DIR: dir,
			TMPDIR: gateTmpdir(dir),
		},
	});
}

describe("init in a fresh repository", () => {
	it("refuses without a founder, the config's one required key", () => {
		const { dir } = repo();
		const r = init(dir, "--no-tracker");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("--founder is required");
	});

	it("writes nothing under --dry-run", () => {
		const { dir } = repo();
		const r = init(dir, "--founder", "A Founder", "--no-tracker", "--dry-run");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("would   write .claude/workflow-core.md");
		expect(fs.existsSync(path.join(dir, "CLAUDE.md"))).toBe(false);
		expect(fs.existsSync(path.join(dir, ".claude"))).toBe(false);
	});

	it("names every missing tool, on a PATH that supplies none of them", () => {
		/* PATH emptied, so the MISSING branch is what this machine's own
		 * installs cannot change. WFC_GITLEAKS unset too (#239): gitleaks's
		 * probe honours it like the hooks do, so a session running this suite
		 * with the var exported would otherwise see gitleaks drop out of the
		 * MISSING line. */
		const { dir } = repo();
		const { WFC_GITLEAKS: _unused, ...rest } = process.env;
		const env = { ...rest, PATH: "" };
		const r = spawnSync(
			process.execPath,
			[
				SCRIPT,
				"--root",
				dir,
				"--plugin-root",
				CORE,
				"--founder",
				"A",
				"--no-tracker",
				"--dry-run",
			],
			{ cwd: dir, encoding: "utf8", env },
		);
		expect(r.status).toBe(0);
		const line = r.stdout
			.split("\n")
			.find((l) => l.startsWith("MISSING tools"));
		expect(line).toBeDefined();
		for (const tool of [
			"shellcheck",
			"actionlint",
			"jq",
			"gitleaks",
			"gh",
			"playwright",
		]) {
			expect(line).toContain(tool);
		}
		expect(line).not.toContain("ruff");
		expect(r.stdout).toContain(
			`MISSING ruff — the format gate refuses the first commit, which stages scripts/browse.py (#1463); install it: ${RUFF_INSTALL}`,
		);
	});

	it("finds gitleaks through WFC_GITLEAKS on a PATH that supplies none of the tools (#239)", () => {
		/* PATH emptied, as the MISSING case above, but WFC_GITLEAKS points at a
		 * real binary off PATH. Every tool but gitleaks stays MISSING. */
		const { dir } = repo();
		const stub = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-gitleaks-"));
		made.push(stub);
		const bin = path.join(stub, "gitleaks-elsewhere");
		fs.writeFileSync(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const r = spawnSync(
			process.execPath,
			[
				SCRIPT,
				"--root",
				dir,
				"--plugin-root",
				CORE,
				"--founder",
				"A",
				"--no-tracker",
				"--dry-run",
			],
			{
				cwd: dir,
				encoding: "utf8",
				env: { ...process.env, PATH: "", WFC_GITLEAKS: bin },
			},
		);
		expect(r.status).toBe(0);
		const line = r.stdout
			.split("\n")
			.find((l) => l.startsWith("MISSING tools"));
		expect(line).toBeDefined();
		expect(line).not.toContain("gitleaks");
		for (const tool of TOOLS.filter((t) => t !== "gitleaks" && t !== "ruff")) {
			expect(line).toContain(tool);
		}
	});

	it("says so where the PATH supplies every one of them", () => {
		const { dir } = repo();
		const stub = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-bin-"));
		made.push(stub);
		for (const tool of TOOLS) {
			fs.writeFileSync(path.join(stub, tool), "#!/bin/sh\nexit 0\n", {
				mode: 0o755,
			});
		}
		const r = spawnSync(
			process.execPath,
			[
				SCRIPT,
				"--root",
				dir,
				"--plugin-root",
				CORE,
				"--founder",
				"A",
				"--no-tracker",
				"--dry-run",
			],
			{ cwd: dir, encoding: "utf8", env: { ...process.env, PATH: stub } },
		);
		expect(r.stdout).toContain(`tools    all present: ${TOOLS.join(", ")}`);
	});

	describe("materialising the plugin (#75)", () => {
		it("runs marketplace add then install then update, not just settingsKeys, by default (#103)", () => {
			const { dir } = repo();
			const log = path.join(dir, "claude-calls.log");
			const stub = stubClaude(log);
			const r = spawnSync(
				process.execPath,
				[
					SCRIPT,
					"--root",
					dir,
					"--plugin-root",
					CORE,
					"--founder",
					"A",
					"--no-tracker",
				],
				{
					cwd: dir,
					encoding: "utf8",
					env: {
						...process.env,
						WFC_CLAUDE_BIN: path.join(stub, "claude"),
					},
				},
			);
			expect(r.status).toBe(0);
			const calls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
			expect(calls).toEqual([
				`plugin marketplace add ${CORE} --scope project`,
				"plugin install workflow-core@workflow-core -y --scope project",
				"plugin update workflow-core@workflow-core --scope project -y",
				"plugin details workflow-core@workflow-core",
			]);
			expect(r.stdout).toContain(
				"installed workflow-core@workflow-core — hooks and skills now load with no --plugin-dir",
			);
			const settings = JSON.parse(
				fs.readFileSync(path.join(dir, ".claude/settings.json"), "utf8"),
			);
			expect(settings.enabledPlugins).toHaveProperty(
				"workflow-core@workflow-core",
				true,
			);
		});

		/** Runs init through a `claude` whose `plugin details` prints ~2,273 tok. */
		const initMeasuring = (dir: string) => {
			const stub = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-claude-"));
			made.push(stub);
			const bin = path.join(stub, "claude");
			fs.writeFileSync(
				bin,
				'#!/bin/sh\n[ "$2" = details ] && echo "  Always-on:   ~2,273 tok   added to every session"\nexit 0\n',
				{ mode: 0o755 },
			);
			const env = { ...process.env, WFC_CLAUDE_BIN: bin };
			const r = spawnSync(
				process.execPath,
				[
					SCRIPT,
					"--root",
					dir,
					"--plugin-root",
					CORE,
					"--founder",
					"A",
					"--no-tracker",
				],
				{ cwd: dir, encoding: "utf8", env },
			);
			expect(r.status).toBe(0);
			return env;
		};
		const costTable = ".claude/plugin-context-cost.json";
		const coreId = "workflow-core@workflow-core";

		it("seeds the core's context-cost row, so the budget check raises no unpriced-plugin WARN on it (#679)", () => {
			const { dir } = repo();
			const env = initMeasuring(dir);
			const table = JSON.parse(
				fs.readFileSync(path.join(dir, costTable), "utf8"),
			);
			expect(table.plugins[coreId].tokens).toBe(2273);
			const budget = spawnSync(
				process.execPath,
				[
					path.join(CORE, "scripts/check-context-budget.js"),
					"--root",
					dir,
					"--json",
				],
				{ cwd: dir, encoding: "utf8", env },
			);
			const findings: { tag: string }[] = JSON.parse(budget.stdout).findings;
			expect(findings.filter((f) => f.tag === "UNPRICED-PLUGIN")).toEqual([]);
		});

		it("adds only the missing row on a re-run over an adopter's own table (#679)", () => {
			const { dir } = repo();
			const own = {
				about: "the adopter's own words",
				plugins: { "other@m": { tokens: 105, measured: "2026-01-01" } },
			};
			const text = `${JSON.stringify(own, null, "\t")}\n`;
			fs.mkdirSync(path.join(dir, ".claude"));
			fs.writeFileSync(path.join(dir, costTable), text);
			initMeasuring(dir);
			const after = JSON.parse(
				fs.readFileSync(path.join(dir, costTable), "utf8"),
			);
			expect(after.plugins[coreId].tokens).toBe(2273);
			delete after.plugins[coreId];
			expect(`${JSON.stringify(after, null, "\t")}\n`).toBe(text);
		});

		it("keeps `ref` in the final settings.json on a url source, despite the install's own rewrite", () => {
			const { dir } = repo();
			/* Simulates the real CLI's own side effect: `marketplace add` rewrites
			 * the marketplace's settings.json entry, and a caller that did not
			 * pass `ref` via the source URL's `#ref` syntax loses it. A JS stub,
			 * not a shell one, because this needs real JSON surgery. */
			const stub = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-claude-"));
			made.push(stub);
			/* An empty CLAUDE_CONFIG_DIR, so #258's own cross-scope check reads no
			 * real user-scope settings.json this machine happens to carry. */
			const configDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "adopter-config-"),
			);
			made.push(configDir);
			const log = path.join(dir, "claude-calls.log");
			fs.writeFileSync(
				path.join(stub, "claude"),
				[
					"#!/usr/bin/env node",
					"const fs = require('node:fs');",
					"const args = process.argv.slice(2);",
					`fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');`,
					"if (args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {",
					"  const at = '.claude/settings.json';",
					"  const existing = fs.existsSync(at) ? JSON.parse(fs.readFileSync(at, 'utf8')) : {};",
					"  existing.extraKnownMarketplaces = existing.extraKnownMarketplaces || {};",
					"  existing.extraKnownMarketplaces['workflow-core'] = { source: { source: 'git', url: 'https://example.invalid/x.git' } };",
					"  fs.mkdirSync('.claude', { recursive: true });",
					"  fs.writeFileSync(at, JSON.stringify(existing));",
					"}",
				].join("\n"),
				{ mode: 0o755 },
			);
			const r = spawnSync(
				process.execPath,
				[
					SCRIPT,
					"--root",
					dir,
					"--plugin-root",
					CORE,
					"--founder",
					"A",
					"--no-tracker",
					"--marketplace-ref",
					"v1.1.0",
				],
				{
					cwd: dir,
					encoding: "utf8",
					env: {
						...process.env,
						WFC_CLAUDE_BIN: path.join(stub, "claude"),
						CLAUDE_CONFIG_DIR: configDir,
					},
				},
			);
			expect(r.status).toBe(0);
			const settings = JSON.parse(
				fs.readFileSync(path.join(dir, ".claude/settings.json"), "utf8"),
			);
			expect(
				settings.extraKnownMarketplaces["workflow-core"].source,
			).toMatchObject({ source: "url", ref: "v1.1.0" });
			const calls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
			expect(calls[0]).toMatch(
				/^plugin marketplace add .*#v1\.1\.0 --scope project$/,
			);
		});

		it("skips it under --no-plugin-install, saying so", () => {
			const { dir } = repo();
			const log = path.join(dir, "claude-calls.log");
			const stub = stubClaude(log);
			const r = spawnSync(
				process.execPath,
				[
					SCRIPT,
					"--root",
					dir,
					"--plugin-root",
					CORE,
					"--founder",
					"A",
					"--no-tracker",
					"--no-plugin-install",
				],
				{
					cwd: dir,
					encoding: "utf8",
					env: {
						...process.env,
						WFC_CLAUDE_BIN: path.join(stub, "claude"),
					},
				},
			);
			expect(r.status).toBe(0);
			expect(fs.existsSync(log)).toBe(false);
			expect(r.stdout).toContain(
				"skipped materialising the plugin — --no-plugin-install",
			);
		});

		it("names the fallback command rather than failing the bootstrap, on a claude that refuses", () => {
			const { dir } = repo();
			const stub = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-claude-"));
			made.push(stub);
			fs.writeFileSync(
				path.join(stub, "claude"),
				"#!/bin/sh\necho boom >&2\nexit 1\n",
				{ mode: 0o755 },
			);
			const { WFC_CLAUDE_BIN: _unused, ...withoutClaudeBin } = process.env;
			const r = spawnSync(
				process.execPath,
				[
					SCRIPT,
					"--root",
					dir,
					"--plugin-root",
					CORE,
					"--founder",
					"A",
					"--no-tracker",
				],
				{
					cwd: dir,
					encoding: "utf8",
					/* On PATH, not WFC_CLAUDE_BIN, and with that var dropped: the
					 * fallback names whatever binary init resolved, and this asserts
					 * the default `claude` (#775). */
					env: {
						...withoutClaudeBin,
						PATH: `${stub}${path.delimiter}${process.env.PATH}`,
					},
				},
			);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("FAILED materialising the plugin: boom");
			expect(r.stdout).toContain(
				`claude plugin marketplace add ${CORE} --scope project && ` +
					"claude plugin install workflow-core@workflow-core -y --scope project && " +
					"claude plugin update workflow-core@workflow-core --scope project -y",
			);
		});

		it("refuses as a bad argument, naming both names and the fix, on a --marketplace that doesn't match the manifest (#90)", () => {
			const { dir } = repo();
			const r = init(
				dir,
				"--founder",
				"A",
				"--no-tracker",
				"--marketplace",
				"not-what-the-manifest-says",
			);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain('"not-what-the-manifest-says"');
			expect(r.stderr).toContain('"workflow-core"');
			expect(r.stderr).toContain("Pass --marketplace workflow-core");
			expect(fs.existsSync(path.join(dir, ".claude"))).toBe(false);
		});

		it("is unaffected where the caller's marketplace name already matches the manifest", () => {
			const { dir } = repo();
			const r = init(
				dir,
				"--founder",
				"A",
				"--no-tracker",
				"--marketplace",
				"workflow-core",
			);
			expect(r.status).toBe(0);
		});

		it("prints what it would run under --dry-run, without a claude on PATH", () => {
			const { dir } = repo();
			const r = spawnSync(
				process.execPath,
				[
					SCRIPT,
					"--root",
					dir,
					"--plugin-root",
					CORE,
					"--founder",
					"A",
					"--no-tracker",
					"--dry-run",
				],
				{ cwd: dir, encoding: "utf8", env: { ...process.env, PATH: "" } },
			);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(
				"would  materialise workflow-core@workflow-core (claude plugin marketplace add → install → update)",
			);
			expect(r.stdout).toContain(
				"would   add the workflow-core@workflow-core row to .claude/plugin-context-cost.json",
			);
		});
	});

	describe("recording the installed plugin commit (#108)", () => {
		it("directory-source run records the plugin root's HEAD sha and dirty flag", () => {
			const { dir } = repo();
			const r = init(dir, "--founder", "A", "--no-tracker", "--dry-run");
			expect(r.status).toBe(0);
			const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: CORE,
				encoding: "utf8",
			}).trim();
			const dirty =
				execFileSync("git", ["status", "--porcelain"], {
					cwd: CORE,
					encoding: "utf8",
				}).trim().length > 0;
			const expected = `directory source, HEAD ${headSha}${dirty ? " (dirty)" : ""}`;
			expect(r.stdout).toContain(`record   ${expected}`);
		});

		it("writes walkedTo at the plugin's own bootstrap version for a directory-sourced install (#252)", () => {
			const { dir } = repo();
			const r = init(dir, "--founder", "A", "--no-tracker");
			expect(r.status).toBe(0);
			const plugin = JSON.parse(
				fs.readFileSync(path.join(CORE, ".claude-plugin/plugin.json"), "utf8"),
			);
			const config = JSON.parse(
				fs.readFileSync(path.join(dir, ".claude/workflow-core.json"), "utf8"),
			);
			expect(config.walkedTo).toBe(`v${plugin.version}`);
		});

		it("writes no walkedTo for a url-sourced install — that walks from its pin instead (#252)", () => {
			const { dir } = repo();
			const configDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "adopter-config-"),
			);
			made.push(configDir);
			const r = spawnSync(
				process.execPath,
				[
					SCRIPT,
					"--root",
					dir,
					"--plugin-root",
					CORE,
					"--founder",
					"A",
					"--no-tracker",
					"--no-plugin-install",
					"--marketplace-ref",
					"v1.1.0",
				],
				{
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
				},
			);
			expect(r.status).toBe(0);
			const config = JSON.parse(
				fs.readFileSync(path.join(dir, ".claude/workflow-core.json"), "utf8"),
			);
			expect("walkedTo" in config).toBe(false);
		});

		it("url-source run records its ref, claiming no resolved sha before install runs", () => {
			const { dir } = repo();
			/* An empty CLAUDE_CONFIG_DIR, so this reads no real
			 * installed_plugins.json this machine happens to carry. */
			const configDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "adopter-config-"),
			);
			made.push(configDir);
			const r = spawnSync(
				process.execPath,
				[
					SCRIPT,
					"--root",
					dir,
					"--plugin-root",
					CORE,
					"--founder",
					"A",
					"--no-tracker",
					"--no-plugin-install",
					"--marketplace-ref",
					"v1.1.0",
				],
				{
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
				},
			);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(
				"record   url source, ref v1.1.0 (sha unknown)",
			);
			const rules = fs.readFileSync(
				path.join(dir, ".claude/workflow-core.reference.md"),
				"utf8",
			);
			expect(rules).toContain("url source, ref v1.1.0 (sha unknown)");
		});

		it("records 'no git' rather than failing where the plugin root carries none", () => {
			const { dir } = repo();
			const bareRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-nogit-"));
			made.push(bareRoot);
			const r = spawnSync(
				process.execPath,
				[
					SCRIPT,
					"--root",
					dir,
					"--plugin-root",
					bareRoot,
					"--founder",
					"A",
					"--no-tracker",
					"--dry-run",
				],
				{ cwd: dir, encoding: "utf8", env: process.env },
			);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(
				"record   directory source, no readable git at the plugin root",
			);
		});

		it("doesn't misattribute an ancestor checkout's HEAD to a nested plugin root with none of its own", () => {
			const { dir } = repo();
			/* A real ancestor repo, so a `git rev-parse HEAD` run from the nested
			 * directory would (if run there directly, with no `--no-git-dir` walk
			 * guard) resolve to the ANCESTOR's HEAD rather than reporting no git. */
			const ancestorRoot = fs.mkdtempSync(
				path.join(os.tmpdir(), "adopter-ancestor-"),
			);
			made.push(ancestorRoot);
			const git = (...args: string[]) =>
				execFileSync("git", args, { cwd: ancestorRoot, encoding: "utf8" });
			git("init", "-q", "-b", "main", ".");
			git("config", "user.email", "fixture@example.invalid");
			git("config", "user.name", "Adopter Fixture");
			fs.writeFileSync(path.join(ancestorRoot, "f"), "1");
			git("add", "f");
			git("commit", "-q", "-m", "seed");
			const nested = path.join(ancestorRoot, "a", "b");
			fs.mkdirSync(nested, { recursive: true });
			const r = spawnSync(
				process.execPath,
				[
					SCRIPT,
					"--root",
					dir,
					"--plugin-root",
					nested,
					"--founder",
					"A",
					"--no-tracker",
					"--dry-run",
				],
				{ cwd: dir, encoding: "utf8", env: process.env },
			);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(
				"record   directory source, no readable git at the plugin root",
			);
		});

		it("resolves and records a url source's sha once install actually runs", () => {
			const { dir } = repo();
			/* A JS stub `claude`, so `plugin install` can write the same side
			 * effect the real CLI leaves: an `installed_plugins.json` row for
			 * this repo and release carrying `gitCommitSha`, which installedSha()
			 * reads (#108: the marketplace clone's own HEAD tracks a
			 * moving branch and isn't the installed commit). Writes nothing on
			 * `update`, so an `update` that applied is indistinguishable from a
			 * no-op here too (#120). */
			const configDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "adopter-config-"),
			);
			made.push(configDir);
			fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
			const resolvedSha = "a".repeat(40);
			const stub = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-claude-"));
			made.push(stub);
			const log = path.join(dir, "claude-calls.log");
			fs.writeFileSync(
				path.join(stub, "claude"),
				[
					"#!/usr/bin/env node",
					"const fs = require('node:fs');",
					"const path = require('node:path');",
					"const args = process.argv.slice(2);",
					`fs.appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n');`,
					"if (args[0] === 'plugin' && args[1] === 'install') {",
					`  const at = ${JSON.stringify(path.join(configDir, "plugins", "installed_plugins.json"))};`,
					"  const doc = { version: 2, plugins: {} };",
					"  doc.plugins[args[2]] = [{ projectPath: process.env.CLAUDE_PROJECT_DIR, installPath: '/installed', version: '1.1.0', gitCommitSha: " +
						JSON.stringify(resolvedSha) +
						" }];",
					"  fs.writeFileSync(at, JSON.stringify(doc));",
					"}",
				].join("\n"),
				{ mode: 0o755 },
			);
			const r = spawnSync(
				process.execPath,
				[
					SCRIPT,
					"--root",
					dir,
					"--plugin-root",
					CORE,
					"--founder",
					"A",
					"--no-tracker",
					"--marketplace-ref",
					"v1.1.0",
				],
				{
					cwd: dir,
					encoding: "utf8",
					env: {
						...process.env,
						WFC_CLAUDE_BIN: path.join(stub, "claude"),
						CLAUDE_CONFIG_DIR: configDir,
					},
				},
			);
			expect(r.status).toBe(0);
			const expected = `url source, ref v1.1.0, HEAD ${resolvedSha}`;
			expect(r.stdout).toContain(`record   ${expected}`);
			const installedLine = r.stdout
				.split("\n")
				.find((l) => l.startsWith("installed "));
			expect(installedLine).toContain(resolvedSha);
			const rules = fs.readFileSync(
				path.join(dir, ".claude/workflow-core.reference.md"),
				"utf8",
			);
			expect(rules).toContain(expected);
			expect(rules).toContain("WFC_PLUGIN_ROOT");
		});

		it("--config-dir isolates the install from the calling session's own registry (#134)", () => {
			const { dir } = repo();
			/* The registry a live founder session already carries — must read
			 * back byte-identical once this run, passed a different
			 * --config-dir, is done. */
			const sessionRegistry = fs.mkdtempSync(
				path.join(os.tmpdir(), "adopter-session-registry-"),
			);
			made.push(sessionRegistry);
			fs.mkdirSync(path.join(sessionRegistry, "plugins"), {
				recursive: true,
			});
			const sessionRegistryFile = path.join(
				sessionRegistry,
				"plugins",
				"installed_plugins.json",
			);
			const sessionBefore = JSON.stringify({
				version: 2,
				plugins: {
					"workflow-core@workflow-core": [{ gitCommitSha: "s".repeat(40) }],
				},
			});
			fs.writeFileSync(sessionRegistryFile, sessionBefore);

			const installConfigDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "adopter-config-"),
			);
			made.push(installConfigDir);
			fs.mkdirSync(path.join(installConfigDir, "plugins"), {
				recursive: true,
			});
			const resolvedSha = "c".repeat(40);
			const stub = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-claude-"));
			made.push(stub);
			const log = path.join(dir, "claude-calls.log");
			fs.writeFileSync(
				path.join(stub, "claude"),
				[
					"#!/usr/bin/env node",
					"const fs = require('node:fs');",
					"const path = require('node:path');",
					"const args = process.argv.slice(2);",
					`fs.appendFileSync(${JSON.stringify(log)}, (process.env.CLAUDE_CONFIG_DIR || '') + ' ' + args.join(' ') + '\\n');`,
					/* Mirrors the real binary: it writes under whatever
					 * CLAUDE_CONFIG_DIR it was actually invoked with, never a
					 * path the fixture hardcodes. */
					"if (args[0] === 'plugin' && args[1] === 'install') {",
					"  const at = path.join(process.env.CLAUDE_CONFIG_DIR, 'plugins', 'installed_plugins.json');",
					"  const doc = { version: 2, plugins: {} };",
					"  doc.plugins[args[2]] = [{ projectPath: process.env.CLAUDE_PROJECT_DIR, installPath: '/installed', version: '1.1.0', gitCommitSha: " +
						JSON.stringify(resolvedSha) +
						" }];",
					"  fs.writeFileSync(at, JSON.stringify(doc));",
					"}",
				].join("\n"),
				{ mode: 0o755 },
			);

			const r = spawnSync(
				process.execPath,
				[
					SCRIPT,
					"--root",
					dir,
					"--plugin-root",
					CORE,
					"--founder",
					"A",
					"--no-tracker",
					"--marketplace-ref",
					"v1.1.0",
					"--config-dir",
					installConfigDir,
				],
				{
					cwd: dir,
					encoding: "utf8",
					env: {
						...process.env,
						WFC_CLAUDE_BIN: path.join(stub, "claude"),
						CLAUDE_CONFIG_DIR: sessionRegistry,
					},
				},
			);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(
				`record   url source, ref v1.1.0, HEAD ${resolvedSha}`,
			);
			expect(fs.readFileSync(sessionRegistryFile, "utf8")).toBe(sessionBefore);
			const calls = fs.readFileSync(log, "utf8");
			expect(calls).toContain(installConfigDir);
			expect(calls).not.toContain(sessionRegistry);
		});

		it("still resolves a url source's sha under --no-plugin-install, once an earlier run installed it", () => {
			const { dir } = repo();
			const configDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "adopter-config-"),
			);
			made.push(configDir);
			fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
			const resolvedSha = "b".repeat(40);
			fs.writeFileSync(
				path.join(configDir, "plugins", "installed_plugins.json"),
				JSON.stringify({
					version: 2,
					plugins: {
						"workflow-core@workflow-core": [
							{
								projectPath: dir,
								installPath: "/installed",
								version: "1.1.0",
								gitCommitSha: resolvedSha,
							},
						],
					},
				}),
			);
			const r = spawnSync(
				process.execPath,
				[
					SCRIPT,
					"--root",
					dir,
					"--plugin-root",
					CORE,
					"--founder",
					"A",
					"--no-tracker",
					"--no-plugin-install",
					"--marketplace-ref",
					"v1.1.0",
				],
				{
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
				},
			);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(
				`record   url source, ref v1.1.0, HEAD ${resolvedSha}`,
			);
		});

		it("takes no sha from another repo's row or another release's (#955)", () => {
			const { dir } = repo();
			const configDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "adopter-config-"),
			);
			made.push(configDir);
			fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
			const registry = (rows: object[]) =>
				fs.writeFileSync(
					path.join(configDir, "plugins", "installed_plugins.json"),
					JSON.stringify({
						version: 2,
						plugins: { "workflow-core@workflow-core": rows },
					}),
				);
			const record = () =>
				initIn(
					{ ...process.env, CLAUDE_CONFIG_DIR: configDir },
					dir,
					"--founder",
					"A",
					"--no-tracker",
					"--marketplace-ref",
					"v1.1.0",
				);
			const ours = {
				projectPath: dir,
				installPath: "/installed",
				version: "1.1.0",
				gitCommitSha: "a".repeat(40),
			};
			/* Another adopter's later install, last in the array — the row the
			 * old any-root read took. */
			registry([
				ours,
				{ ...ours, projectPath: "/elsewhere", gitCommitSha: "e".repeat(40) },
			]);
			let r = record();
			expect(r.status, r.stderr).toBe(0);
			expect(r.stdout).toContain(
				`record   url source, ref v1.1.0, HEAD ${"a".repeat(40)}`,
			);
			expect(r.stdout).not.toContain("e".repeat(40));

			registry([{ ...ours, version: "1.0.0" }]);
			r = record();
			expect(r.status, r.stderr).toBe(0);
			expect(r.stdout).toContain(
				"record   url source, ref v1.1.0 (sha unknown)",
			);
		});

		it("prints the same description on the `installed …` line", () => {
			const { dir } = repo();
			const log = path.join(dir, "claude-calls.log");
			const stub = stubClaude(log);
			const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: CORE,
				encoding: "utf8",
			}).trim();
			const r = spawnSync(
				process.execPath,
				[
					SCRIPT,
					"--root",
					dir,
					"--plugin-root",
					CORE,
					"--founder",
					"A",
					"--no-tracker",
				],
				{
					cwd: dir,
					encoding: "utf8",
					env: {
						...process.env,
						WFC_CLAUDE_BIN: path.join(stub, "claude"),
					},
				},
			);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("installed workflow-core@workflow-core");
			const installedLine = r.stdout
				.split("\n")
				.find((l) => l.startsWith("installed "));
			expect(installedLine).toContain(headSha);
		});

		it("a re-run updates the record", () => {
			const { dir } = repo();
			expect(
				init(
					dir,
					"--founder",
					"A",
					"--no-tracker",
					"--no-plugin-install",
					"--marketplace-ref",
					"v1.0.0",
				).status,
			).toBe(0);
			expect(
				fs.readFileSync(
					path.join(dir, ".claude/workflow-core.reference.md"),
					"utf8",
				),
			).toContain("ref v1.0.0");
			expect(
				init(
					dir,
					"--founder",
					"A",
					"--no-tracker",
					"--no-plugin-install",
					"--marketplace-ref",
					"v2.0.0",
				).status,
			).toBe(0);
			const rules = fs.readFileSync(
				path.join(dir, ".claude/workflow-core.reference.md"),
				"utf8",
			);
			expect(rules).toContain("ref v2.0.0");
			expect(rules).not.toContain("ref v1.0.0");
		});

		it("writes nothing under --dry-run but still prints what it would record", () => {
			const { dir } = repo();
			/* An empty CLAUDE_CONFIG_DIR, so this reads no real
			 * installed_plugins.json this machine happens to carry. */
			const configDir = fs.mkdtempSync(
				path.join(os.tmpdir(), "adopter-config-"),
			);
			made.push(configDir);
			const r = spawnSync(
				process.execPath,
				[
					SCRIPT,
					"--root",
					dir,
					"--plugin-root",
					CORE,
					"--founder",
					"A",
					"--no-tracker",
					"--no-plugin-install",
					"--dry-run",
					"--marketplace-ref",
					"v1.1.0",
				],
				{
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
				},
			);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(
				"record   url source, ref v1.1.0 (sha unknown)",
			);
			expect(fs.existsSync(path.join(dir, ".claude/workflow-core.md"))).toBe(
				false,
			);
		});
	});

	it("writes the settings keys onto whatever the install left", () => {
		const { dir } = repo();
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(
			path.join(dir, ".claude/settings.json"),
			JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }),
		);
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		const settings = JSON.parse(
			fs.readFileSync(path.join(dir, ".claude/settings.json"), "utf8"),
		);
		expect(settings.permissions.allow).toEqual(["Bash(ls)"]);
		expect(settings.outputStyle).toBe("workflow-core:Core voice");
		expect(settings.permissions.deny).toContain("Bash(gh auth token*)");
		expect(settings.enabledPlugins).toHaveProperty(
			"workflow-core@workflow-core",
		);
	});

	it("anchors the hooks in the ADOPTER's tree, not the session's own", () => {
		/* The --review child inherits the environment, and lib/host-root.js
		 * answers CLAUDE_PROJECT_DIR unconditionally, so a child left to inherit
		 * it re-anchors the CORE's registry and writes the adopter nothing (#5). */
		const { dir } = repo();
		const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-else-"));
		made.push(elsewhere);
		const r = initIn(
			{ ...process.env, CLAUDE_PROJECT_DIR: elsewhere },
			dir,
			"--founder",
			"A",
			"--no-tracker",
		);
		expect(r.status).toBe(0);
		expect(
			fs.existsSync(path.join(dir, ".claude/guard-registry-anchors.json")),
		).toBe(true);
		expect(
			fs.existsSync(
				path.join(elsewhere, ".claude/guard-registry-anchors.json"),
			),
		).toBe(false);
	});

	it("refuses rather than overwrite a settings file that does not parse", () => {
		const { dir } = repo();
		fs.mkdirSync(path.join(dir, ".claude"));
		fs.writeFileSync(path.join(dir, ".claude/settings.json"), "{ nope,\n");
		const r = init(dir, "--founder", "A Founder", "--no-tracker");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("does not parse");
		expect(
			fs.readFileSync(path.join(dir, ".claude/settings.json"), "utf8"),
		).toBe("{ nope,\n");
	});

	it("keeps the repo-owned half and rewrites the core-owned half", () => {
		const { dir } = repo();
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		fs.appendFileSync(path.join(dir, "CLAUDE.md"), "\n- the adopter's own\n");
		const rules = path.join(dir, ".claude/workflow-core.md");
		const marker = fs.readFileSync(rules, "utf8").split("\n")[0];
		fs.writeFileSync(rules, `${marker}\nclobbered\n`);
		const again = init(dir, "--founder", "A Founder", "--no-tracker");
		expect(again.status).toBe(0);
		expect(again.stdout).toContain("kept    CLAUDE.md");
		expect(again.stdout).toContain("rewrote .claude/workflow-core.md");
		expect(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8")).toContain(
			"the adopter's own",
		);
		expect(fs.readFileSync(rules, "utf8")).toContain(
			"Workflow core — session rules",
		);
	});

	it("leaves a rules file that does not open on the CORE-OWNED marker, and says so (#1501)", () => {
		const { dir } = repo();
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		const rules = path.join(dir, ".claude/workflow-core.md");
		fs.writeFileSync(rules, "the adopter's own\n");
		const again = init(dir, "--founder", "A Founder", "--no-tracker");
		expect(again.status).toBe(0);
		expect(again.stdout).toContain(
			"skipped .claude/workflow-core.md — it does not open on the CORE-OWNED marker",
		);
		expect(fs.readFileSync(rules, "utf8")).toBe("the adopter's own\n");
	});

	it("copies the browser helper in executable, and deliberately registers nothing (#133)", () => {
		const { dir } = repo();
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		const at = path.join(dir, "scripts/browse.py");
		const body = fs.readFileSync(at, "utf8");
		/* Byte-identical to the core's, since nothing is rewritten on the way in
		 * — the property that lets a bump replace it wholesale. */
		expect(body).toBe(
			fs.readFileSync(path.join(CORE, "scripts/browse.py"), "utf8"),
		);
		expect(fs.statSync(at).mode & 0o111).toBeTruthy();
		/* Deliberately NOT in the class sidecar: `scripts` is outside
		 * doc-map.js's SCOPE, so a key here would report UNTRACKED-ENTRY
		 * against every adopter for good. */
		const sidecar = JSON.parse(
			fs.readFileSync(path.join(dir, "docs/doc-map-classes.json"), "utf8"),
		);
		expect(sidecar["scripts/browse.py"]).toBeUndefined();
		expect(body).toContain("DO NOT EDIT AN ADOPTER'S COPY");
	});

	it("copies in the resolver the hook shims run, byte-identical to the core's (#1839)", () => {
		const { dir } = repo();
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		expect(
			fs.readFileSync(path.join(dir, "scripts/lib/resolve-core.js"), "utf8"),
		).toBe(
			fs.readFileSync(path.join(CORE, "scripts/lib/resolve-core.js"), "utf8"),
		);
	});

	it("replaces an adopter's edit to the browser helper on a re-run (#133)", () => {
		/* The other half of `generated-only`: unlike CLAUDE.md this is NOT kept,
		 * so a bump actually delivers a fixed helper rather than skipping it. */
		const { dir } = repo();
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		fs.writeFileSync(path.join(dir, "scripts/browse.py"), "clobbered\n");
		const again = init(dir, "--founder", "A Founder", "--no-tracker");
		expect(again.status).toBe(0);
		expect(
			fs.readFileSync(path.join(dir, "scripts/browse.py"), "utf8"),
		).toContain("browse.py — render a page with a real browser");
	});

	it("leaves an adopter's .husky/pre-commit.local byte-identical on a re-run (#437)", () => {
		const { dir } = repo();
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		const local = path.join(dir, ".husky/pre-commit.local");
		const body = "# mine\nnode scripts/own-gate.js || exit 1\n";
		fs.writeFileSync(local, body);
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		expect(fs.readFileSync(local, "utf8")).toBe(body);
		expect(fs.readFileSync(path.join(dir, ".husky/pre-commit"), "utf8")).toBe(
			renderHookShim("pre-commit"),
		);
	});

	it("skips the roadmap triple with the module off", () => {
		const { dir } = repo();
		const r = init(dir, "--founder", "A Founder", "--no-tracker");
		expect(r.stdout).toContain('skipped the roadmap triple — module "roadmap"');
		expect(fs.existsSync(path.join(dir, "docs/reference-roadmap.html"))).toBe(
			false,
		);
		expect(fs.existsSync(path.join(dir, "docs/doc-map.md"))).toBe(true);
	});

	it("writes the roadmap, its digest and its register when the module is on", () => {
		const { dir } = repo();
		const r = init(
			dir,
			"--founder",
			"A Founder",
			"--modules",
			"roadmap",
			"--category",
			"tech=Tech & Stack",
			"--no-tracker",
		);
		expect(r.status).toBe(0);
		const digest = fs.readFileSync(
			path.join(dir, "docs/roadmap-digest.md"),
			"utf8",
		);
		/* One placeholder card per phase, and the digest's version line must
		 * match the roadmap's or check-digest-version.js refuses the commit.
		 * The major.minor tracks the core's own plugin.json, never a literal —
		 * it drifts on every minor bump otherwise (#7). */
		const { version: pluginVersion } = JSON.parse(
			fs.readFileSync(path.join(CORE, ".claude-plugin/plugin.json"), "utf8"),
		);
		const [major, minor = "0"] = String(pluginVersion).split(".");
		expect(digest).toContain("5 cards");
		expect(digest).toMatch(new RegExp(`^v${major}\\.${minor} · updated `, "m"));
		expect(
			fs.readFileSync(path.join(dir, "docs/reference-roadmap.html"), "utf8"),
		).toContain('tech:"Tech & Stack"');
		expect(fs.existsSync(path.join(dir, "docs/called-cards.md"))).toBe(true);
		const sidecar = JSON.parse(
			fs.readFileSync(path.join(dir, "docs/doc-map-classes.json"), "utf8"),
		);
		expect(sidecar["docs/reference-roadmap.html"].class).toBe(
			"source-of-truth",
		);
		expect(
			fs.readFileSync(path.join(dir, "docs/doc-map.md"), "utf8"),
		).toContain("`docs/reference-roadmap.html`");
	});

	it("writes no file for governance: no archive folder, manual, cycle log or §A row (#414)", () => {
		const readFiles = (dir: string): string[] =>
			fs
				.readdirSync(dir, { recursive: true, encoding: "utf8" })
				.filter((f) => !f.startsWith(".git/") && f !== ".git")
				.sort();
		const plain = repo().dir;
		const governed = repo().dir;
		expect(init(plain, "--founder", "A Founder", "--no-tracker").status).toBe(
			0,
		);
		expect(
			init(
				governed,
				"--founder",
				"A Founder",
				"--modules",
				"governance",
				"--no-tracker",
			).status,
		).toBe(0);
		expect(readFiles(governed)).toEqual(readFiles(plain));
		for (const p of [
			"docs/archive",
			"docs/operating-manual.md",
			"docs/cycle-log.md",
		])
			expect(fs.existsSync(path.join(governed, p))).toBe(false);
		const readSidecar = (dir: string) =>
			fs.readFileSync(path.join(dir, "docs/doc-map-classes.json"), "utf8");
		expect(readSidecar(governed)).toBe(readSidecar(plain));
	});

	it("refuses an unknown module rather than writing half a skeleton", () => {
		const { dir } = repo();
		const r = init(dir, "--founder", "A Founder", "--modules", "roadmpa");
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("unknown module");
		expect(fs.existsSync(path.join(dir, "CLAUDE.md"))).toBe(false);
	});
});

describe("a complete day-one config (#715)", () => {
	const configPath = (dir: string) =>
		path.join(dir, ".claude/workflow-core.json");
	const readConfig = (dir: string) =>
		JSON.parse(fs.readFileSync(configPath(dir), "utf8"));
	const biomeStaged = 'node "$WFC_PLUGIN_ROOT"/scripts/biome-staged.js';
	const readSettings = (dir: string) =>
		JSON.parse(
			fs.readFileSync(path.join(dir, ".claude/settings.json"), "utf8"),
		);
	const write = (dir: string, rel: string, body: string) => {
		fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
		fs.writeFileSync(path.join(dir, rel), body);
	};

	it("--corpus writes the own tracker, then workflow-core, then the extras", () => {
		const { dir, git } = repo();
		git("remote", "add", "origin", "https://github.com/acme/widget.git");
		const r = init(
			dir,
			"--founder",
			"A Founder",
			"--corpus",
			"acme/rulings,lucmoseley/workflow-core-tracker",
			"--no-tracker",
		);
		expect(r.status).toBe(0);
		expect(readConfig(dir).corpus).toEqual([
			"acme/widget",
			"lucmoseley/workflow-core-tracker",
			"acme/rulings",
		]);
	});

	it("leaves corpus undeclared with no --corpus", () => {
		const { dir, git } = repo();
		git("remote", "add", "origin", "https://github.com/acme/widget.git");
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		expect(readConfig(dir)).not.toHaveProperty("corpus");
	});

	it("refuses --corpus where no own tracker resolves, writing nothing", () => {
		const { dir } = repo();
		const r = init(
			dir,
			"--founder",
			"A Founder",
			"--corpus",
			"acme/rulings",
			"--no-tracker",
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("own tracker");
		expect(fs.existsSync(path.join(dir, ".claude"))).toBe(false);
	});

	it.each([
		["a bare --corpus", ["--corpus"]],
		["a tracker not of owner/name shape", ["--corpus", "rulings"]],
	])("refuses %s, saying what --corpus wants", (_, args) => {
		const { dir, git } = repo();
		git("remote", "add", "origin", "https://github.com/acme/widget.git");
		const r = init(dir, "--founder", "A Founder", "--no-tracker", ...args);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("--corpus wants");
	});

	it("infers every command from package.json scripts, into the config and CLAUDE.md", () => {
		const { dir } = repo();
		write(
			dir,
			"package.json",
			JSON.stringify({
				scripts: {
					test: "vitest run",
					lint: "eslint .",
					typecheck: "tsc --noEmit",
					check: "biome check .",
					"check:staged": "biome check --staged",
				},
				devDependencies: { "@biomejs/biome": "2.0.0" },
			}),
		);
		const r = init(dir, "--founder", "A Founder", "--no-tracker");
		expect(r.status).toBe(0);
		expect(readConfig(dir).commands).toEqual({
			test: "npm run test",
			lint: "npm run lint",
			typecheck: "npm run typecheck",
			check: "npm run check",
			check_staged: 'node "$WFC_PLUGIN_ROOT"/scripts/biome-staged.js',
		});
		expect(r.stdout).toContain(
			"commands test: npm run test (inferred from package.json)",
		);
		expect(fs.readFileSync(path.join(dir, "CLAUDE.md"), "utf8")).toContain(
			"`npm run test`",
		);
	});

	// Biome's --staged reads each staged path's worktree bytes (#2540).
	it.each([
		[
			"biome check --staged --no-errors-on-unmatched --error-on-warnings",
			`${biomeStaged} --no-errors-on-unmatched --error-on-warnings`,
		],
		["npx @biomejs/biome check --staged", biomeStaged],
		["biome check --changed", "npm run check:staged"],
		[
			"biome check --staged --only=lint/style",
			`${biomeStaged} --only=lint/style`,
		],
	])("infers check_staged from a %j script as %s", (script, command) => {
		const { dir } = repo();
		write(
			dir,
			"package.json",
			JSON.stringify({
				scripts: { "check:staged": script },
				devDependencies: { "@biomejs/biome": "2.0.0" },
			}),
		);
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		expect(readConfig(dir).commands.check_staged).toBe(command);
	});

	it("maps an inferred write-flag script with --write dropped, printing the note and leaving package.json as written (#2773)", () => {
		const { dir } = repo();
		const pkg = JSON.stringify({
			scripts: {
				"check:staged": "biome check --staged --write --no-errors-on-unmatched",
			},
			devDependencies: { "@biomejs/biome": "2.5.15" },
		});
		write(dir, "package.json", pkg);
		const r = init(dir, "--founder", "A Founder", "--no-tracker");
		expect(r.status).toBe(0);
		expect(readConfig(dir).commands.check_staged).toBe(
			'node "$WFC_PLUGIN_ROOT"/scripts/biome-staged.js --no-errors-on-unmatched',
		);
		expect(r.stdout).toMatch(
			/^commands .*check_staged: node "\$WFC_PLUGIN_ROOT"\/scripts\/biome-staged\.js --no-errors-on-unmatched \(inferred from package\.json — auto-fix on commit dropped; /m,
		);
		expect(fs.readFileSync(path.join(dir, "package.json"), "utf8")).toBe(pkg);
	});

	it.each([
		[
			"biome check --staged && tsc",
			{ "@biomejs/biome": "2.0.0" },
			"holds more than that one command",
			`Declare check_staged instead as '${biomeStaged}' for the Biome part`,
		],
		[
			"biome check --staged --changed",
			{ "@biomejs/biome": "2.0.0" },
			"--changed",
			"Declare check_staged without '--changed'.",
		],
		[
			"npx @biomejs/biome check --staged",
			{},
			"does not declare @biomejs/biome",
			"Add @biomejs/biome to devDependencies.",
		],
	])(
		"refuses an inferred %j script, writing nothing and naming the way out (#2774)",
		(script, devDependencies, shape, wayOut) => {
			const { dir } = repo();
			write(
				dir,
				"package.json",
				JSON.stringify({
					scripts: { "check:staged": script },
					devDependencies,
				}),
			);
			const r = init(dir, "--founder", "A Founder", "--no-tracker");
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(
				'check_staged "npm run check:staged" (inferred from package.json) runs biome check --staged',
			);
			expect(r.stderr).toContain(shape);
			expect(r.stderr).toContain(wayOut);
			expect(fs.existsSync(configPath(dir))).toBe(false);
		},
	);

	it.each([
		["an npm run whose script", "npm run check:staged"],
		[
			"a direct biome check --staged that",
			"biome check --staged --no-errors-on-unmatched",
		],
	])(
		"refuses %s would map as an explicit --command, naming the mapped command (#2774)",
		(_, command) => {
			const { dir } = repo();
			write(
				dir,
				"package.json",
				JSON.stringify({
					scripts: {
						"check:staged": "biome check --staged --no-errors-on-unmatched",
					},
					devDependencies: { "@biomejs/biome": "2.0.0" },
				}),
			);
			const r = init(
				dir,
				"--founder",
				"A Founder",
				"--no-tracker",
				"--command",
				`check_staged=${command}`,
			);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(`check_staged "${command}" (--command)`);
			expect(r.stderr).toContain(
				`an explicit value is never rewritten. Declare check_staged instead as '${biomeStaged} --no-errors-on-unmatched'.`,
			);
			expect(fs.existsSync(configPath(dir))).toBe(false);
		},
	);

	it("accepts an explicit biome-staged.js --command unparsed (#2774)", () => {
		const { dir } = repo();
		const command = `${biomeStaged} --reporter-file=out.json`;
		const r = init(
			dir,
			"--founder",
			"A Founder",
			"--no-tracker",
			"--command",
			`check_staged=${command}`,
		);
		expect(r.status, r.stderr).toBe(0);
		expect(readConfig(dir).commands.check_staged).toBe(command);
	});

	it("leaves a kept config's biome check --staged check_staged to the hook (#2774)", () => {
		const { dir } = repo();
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		write(
			dir,
			"package.json",
			JSON.stringify({
				scripts: { "check:staged": "biome check --staged && tsc" },
				devDependencies: { "@biomejs/biome": "2.0.0" },
			}),
		);
		write(
			dir,
			".claude/workflow-core.json",
			JSON.stringify({
				...readConfig(dir),
				commands: { check_staged: "npm run check:staged" },
			}),
		);
		const r = init(dir, "--no-tracker");
		expect(r.status, r.stderr).toBe(0);
		expect(readConfig(dir).commands.check_staged).toBe("npm run check:staged");
	});

	// lint-staged hides a neighbour's unstaged hunks for its run (#2583).
	it("infers no check_staged from a lint-staged script alone (#2587)", () => {
		const { dir } = repo();
		write(
			dir,
			"package.json",
			JSON.stringify({ scripts: { "lint-staged": "lint-staged" } }),
		);
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		expect(readConfig(dir).commands).toBeUndefined();
	});

	it.each([
		["a check:staged script", "npx lint-staged && tsc", []],
		["a --command", "biome check .", ["--command", "check_staged=npm run pre"]],
	])(
		"refuses a check_staged from %s running lint-staged, writing nothing and naming biome-staged.js (#2587)",
		(_, script, args) => {
			const { dir } = repo();
			write(
				dir,
				"package.json",
				JSON.stringify({
					scripts: { "check:staged": script, pre: "lint-staged" },
				}),
			);
			const r = init(dir, "--founder", "A Founder", "--no-tracker", ...args);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("runs lint-staged");
			expect(r.stderr).toContain(
				'node "$WFC_PLUGIN_ROOT"/scripts/biome-staged.js',
			);
			expect(fs.existsSync(path.join(dir, ".claude/workflow-core.json"))).toBe(
				false,
			);
		},
	);

	it("counts npm init's placeholder test script as none, falling through to pytest config", () => {
		const { dir } = repo();
		write(
			dir,
			"package.json",
			JSON.stringify({
				scripts: { test: 'echo "Error: no test specified" && exit 1' },
			}),
		);
		write(dir, "pyproject.toml", "[tool.pytest.ini_options]\naddopts = -q\n");
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		expect(readConfig(dir).commands).toEqual({ test: "python3 -m pytest" });
	});

	it("takes pytest config ahead of *.test.js files", () => {
		const { dir } = repo();
		write(dir, "pytest.ini", "[pytest]\n");
		write(dir, "lib/a.test.js", "");
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		expect(readConfig(dir).commands).toEqual({ test: "python3 -m pytest" });
	});

	it("runs *.test.js files with node --test, never counting node_modules'", () => {
		const { dir } = repo();
		write(dir, "node_modules/dep/x.test.js", "");
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		expect(readConfig(dir)).not.toHaveProperty("commands");

		const other = repo().dir;
		write(other, "src/deep/a.test.js", "");
		expect(init(other, "--founder", "A Founder", "--no-tracker").status).toBe(
			0,
		);
		expect(readConfig(other).commands).toEqual({ test: "node --test" });
	});

	it("gives an empty repo none, and says so", () => {
		const { dir } = repo();
		const r = init(dir, "--founder", "A Founder", "--no-tracker");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("commands none");
		expect(readConfig(dir)).not.toHaveProperty("commands");
	});

	it("shows the inferred set under --dry-run, writing nothing", () => {
		const { dir } = repo();
		write(dir, "package.json", JSON.stringify({ scripts: { lint: "x" } }));
		const r = init(dir, "--founder", "A Founder", "--no-tracker", "--dry-run");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			"commands lint: npm run lint (inferred from package.json)",
		);
		expect(fs.existsSync(path.join(dir, ".claude"))).toBe(false);
	});

	it("lets --command override an inferred one", () => {
		const { dir } = repo();
		write(dir, "package.json", JSON.stringify({ scripts: { test: "x" } }));
		const r = init(
			dir,
			"--founder",
			"A Founder",
			"--command",
			"test=make test",
			"--no-tracker",
		);
		expect(r.status).toBe(0);
		expect(readConfig(dir).commands).toEqual({ test: "make test" });
		expect(r.stdout).toContain("commands test: make test (--command)");
	});

	it("says --corpus went unwritten over a kept config", () => {
		const { dir, git } = repo();
		git("remote", "add", "origin", "https://github.com/acme/widget.git");
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		const r = init(dir, "--corpus", "acme/rulings", "--no-tracker");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("corpus   NOT written");
		expect(readConfig(dir)).not.toHaveProperty("corpus");
	});

	it("reports a kept config's commands on a re-run, not a search it never made", () => {
		const { dir } = repo();
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		write(dir, "package.json", JSON.stringify({ scripts: { test: "x" } }));
		const r = init(dir, "--no-tracker");
		expect(r.stdout).toContain(
			"commands none declared in .claude/workflow-core.json",
		);
	});

	it.each([
		["package.json", "package.json does not parse"],
		[".claude/workflow-core.json", "workflow-core.json does not parse"],
	])(
		"refuses a %s that does not parse, naming the file, rather than reading it as empty",
		(rel, said) => {
			const { dir } = repo();
			write(dir, rel, "{ not json");
			const r = init(dir, "--founder", "A Founder", "--no-tracker");
			expect(r.status).toBe(2);
			expect(r.stderr).toContain(said);
		},
	);

	it("switches a module on when its config's modules is edited and init re-run (#708 Q4)", () => {
		const { dir } = repo();
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		const edited = readConfig(dir);
		edited.modules = ["roadmap"];
		write(dir, ".claude/workflow-core.json", JSON.stringify(edited));
		const r = init(dir, "--no-tracker");
		expect(r.status).toBe(0);
		expect(fs.existsSync(path.join(dir, "docs/reference-roadmap.html"))).toBe(
			true,
		);
	});

	it("switches a module on by the reference file's own instruction, keeping the plugin pin (#730)", () => {
		const { dir, git } = repo();
		expect(
			init(
				dir,
				"--founder",
				"A Founder",
				"--no-tracker",
				"--marketplace-ref",
				"v1.2.3",
			).status,
		).toBe(0);
		const readRules = () =>
			fs.readFileSync(path.join(dir, ".claude/workflow-core.md"), "utf8");
		const said = fs
			.readFileSync(
				path.join(dir, ".claude/workflow-core.reference.md"),
				"utf8",
			)
			.match(
				/add it to `modules` in `\.claude\/workflow-core\.json`, then run `(node \S+\/scripts\/init-adopter\.js[^`]*)`/,
			);
		expect(said?.[1]).toBe(
			`node ${CORE}/scripts/init-adopter.js --no-plugin-install`,
		);
		/* The template's own [roadmap] lines, so a cut or rewording of them
		 * selects this test and needs no hand copy here (#2240). */
		const roadmapLines = fs
			.readFileSync(
				path.join(CORE, "scripts/templates/adopter/session-rules.md"),
				"utf8",
			)
			.split("\n")
			.flatMap((line) => line.match(/^- \[roadmap\] (.+)$/)?.[1] ?? []);
		expect(roadmapLines.length).toBeGreaterThan(0);
		for (const line of roadmapLines) expect(readRules()).not.toContain(line);
		const edited = readConfig(dir);
		edited.modules = ["roadmap"];
		write(dir, ".claude/workflow-core.json", JSON.stringify(edited));
		/* Run as the session would, from the repo with no --root, but for the
		 * one flag that keeps the fixture off GitHub. */
		const env = { ...process.env };
		delete env.CLAUDE_PROJECT_DIR;
		const r = spawnSync("bash", ["-c", `${said?.[1]} --no-tracker`], {
			cwd: dir,
			encoding: "utf8",
			env,
		});
		expect(r.status, r.stderr).toBe(0);
		expect(fs.existsSync(path.join(dir, "docs/reference-roadmap.html"))).toBe(
			true,
		);
		for (const line of roadmapLines) expect(readRules()).toContain(line);
		/* The commit the rules file asks for next: the module's documents are
		 * registered, so the doc-map gate passes them. */
		git("add", "-A");
		const gate = spawnSync(
			"node",
			[path.join(CORE, "scripts/check-doc-map.js")],
			{ cwd: dir, encoding: "utf8", env },
		);
		expect(gate.status, `${gate.stdout}${gate.stderr}`).toBe(0);
		expect(
			readSettings(dir).extraKnownMarketplaces["workflow-core"].source,
		).toEqual(expect.objectContaining({ source: "url", ref: "v1.2.3" }));
	});

	it("adds no pin on a re-run of an unpinned install (#730)", () => {
		const { dir } = repo();
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		const r = init(dir, "--no-tracker");
		expect(r.status, r.stderr).toBe(0);
		expect(
			readSettings(dir).extraKnownMarketplaces["workflow-core"].source,
		).toEqual({
			source: "directory",
			path: CORE,
		});
	});

	it("keeps a directory source's declared checkout on a bare re-run from another plugin root (#731)", () => {
		const { dir } = repo();
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		const readSource = () =>
			readSettings(dir).extraKnownMarketplaces["workflow-core"].source;
		const declareSource = (declared: object) => {
			const edited = readSettings(dir);
			edited.extraKnownMarketplaces["workflow-core"].source = declared;
			write(dir, ".claude/settings.json", JSON.stringify(edited));
		};
		const declarePath = (at: string) =>
			declareSource({ source: "directory", path: at });
		/* The checkout bootstrap ran from. The re-run's plugin root is CORE, as
		 * the cache copy the rules file names is to a real adopter. */
		const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-"));
		made.push(checkout);
		const env = { ...process.env };
		delete env.CLAUDE_PROJECT_DIR;
		delete env.CLAUDE_PLUGIN_ROOT;
		const bare = () =>
			spawnSync("node", [SCRIPT, "--no-plugin-install", "--no-tracker"], {
				cwd: dir,
				encoding: "utf8",
				env,
			});
		declarePath(checkout);
		const kept = bare();
		expect(kept.status, kept.stderr).toBe(0);
		expect(readSource()).toEqual({ source: "directory", path: checkout });
		declarePath(path.join(checkout, "gone"));
		expect(bare().status).toBe(0);
		expect(readSource()).toEqual({ source: "directory", path: CORE });
		/* An explicit --plugin-root re-points it. */
		declarePath(checkout);
		expect(init(dir, "--no-tracker").status).toBe(0);
		expect(readSource()).toEqual({ source: "directory", path: CORE });
		/* A git source's ref is kept as a url source's is. */
		declareSource({
			source: "git",
			url: "https://example.invalid/x.git",
			ref: "v1.2.3",
		});
		expect(bare().status).toBe(0);
		expect(readSource()).toEqual(
			expect.objectContaining({ source: "url", ref: "v1.2.3" }),
		);
	});
});

/*
 * Slow by nature: it runs the whole pre-commit stack in a foreign repo,
 * gitleaks and every checker included. Skipped where gitleaks is absent, since
 * `.husky/pre-commit` refuses every commit without it; CI installs it (#55). The
 * probe resolves the binary as the hooks' `"${WFC_GITLEAKS:-gitleaks}"` does
 * (#224) — `||`, not `??`, so an empty value falls back rather than skipping
 * both cases.
 */
const HAS_GITLEAKS = (() => {
	try {
		execFileSync(process.env.WFC_GITLEAKS || "gitleaks", ["version"], {
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
})();

describe("the skeleton's first commit", () => {
	it.skipIf(!HAS_GITLEAKS)(
		"lands green through the full husky stack with no modules",
		() => {
			const { dir } = repo();
			expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(
				0,
			);
			/* A session's leaked CLAUDE_PROJECT_DIR, so CI too checks the
			 * helper's override (#3296). */
			const r = commitThroughHooks(
				dir,
				"Start the repo: the workflow-core skeleton",
				SKELETON_PATHS,
				{ ...process.env, CLAUDE_PROJECT_DIR: CORE },
			);
			expect(`${r.stdout}\n${r.stderr}`).not.toMatch(/^(FAIL|BROKEN):/m);
			expect(r.status).toBe(0);
			expect(
				execFileSync("git", ["ls-files", ".gitignore"], {
					cwd: dir,
					encoding: "utf8",
				}),
			).toBe(".gitignore\n");
		},
		180_000,
	);

	it.skipIf(!HAS_GITLEAKS)(
		"lands green with the roadmap module on",
		() => {
			const { dir } = repo();
			expect(
				init(
					dir,
					"--founder",
					"A Founder",
					"--modules",
					"roadmap",
					"--category",
					"core=Core",
					"--no-tracker",
				).status,
			).toBe(0);
			const r = commitThroughHooks(
				dir,
				"Start the repo: skeleton with the roadmap",
			);
			expect(`${r.stdout}\n${r.stderr}`).not.toMatch(/^(FAIL|BROKEN):/m);
			expect(r.status).toBe(0);
		},
		180_000,
	);
});

/**
 * The suite injects WFC_MODULES, which replaces the declared list; the
 * spawned init never saw it, so the upgrade must not either.
 */
function upgradeAfterInit(
	dir: string,
	labels?: Parameters<typeof upgrade>[0]["labels"],
) {
	const lines: string[] = [];
	vi.stubEnv("WFC_MODULES", undefined);
	try {
		upgrade({ root: dir, pluginRoot: CORE, out: (l) => lines.push(l), labels });
	} finally {
		vi.unstubAllEnvs();
	}
	return lines;
}

describe("the rules file's core commands (#654)", () => {
	it("a fresh init spells them at the plugin root, and an upgrade at the same root leaves the file byte-identical", () => {
		const { dir } = repo();
		expect(init(dir, "--founder", "A", "--no-tracker").status).toBe(0);
		const at = path.join(dir, ".claude/workflow-core.md");
		const written = fs.readFileSync(at, "utf8");
		const ref = path.join(dir, ".claude/workflow-core.reference.md");
		const reference = fs.readFileSync(ref, "utf8");
		expect(written).toContain(`\`${CORE}/scripts/bg-run.sh check <name>\``);
		expect(written).not.toMatch(/\b(?:node|bash) scripts\//);
		expect(reference).toContain(`\`node ${CORE}/scripts/status-report.js\``);
		expect(reference).toContain("## Plugin provenance");
		const lines = upgradeAfterInit(dir);
		expect(fs.readFileSync(at, "utf8")).toBe(written);
		expect(fs.readFileSync(ref, "utf8")).toBe(reference);
		expect(lines.filter((l) => l.includes("workflow-core."))).toEqual([]);
	});
});

describe("init then upgrade (#1501)", () => {
	/** Every file under `dir` but `.git`, as its bytes and mode. */
	function snapshot(dir: string) {
		const files: Record<string, string> = {};
		const walk = (rel: string) => {
			for (const e of fs.readdirSync(path.join(dir, rel), {
				withFileTypes: true,
			})) {
				const at = path.join(rel, e.name);
				if (at === ".git") continue;
				if (e.isDirectory()) walk(at);
				else {
					const mode = fs.statSync(path.join(dir, at)).mode & 0o777;
					files[at] =
						`${mode.toString(8)} ${fs.readFileSync(path.join(dir, at), "base64")}`;
				}
			}
		};
		walk("");
		return files;
	}

	it("an upgrade with no version change leaves every file init wrote byte-identical, no mode changed", () => {
		const { dir } = repo();
		expect(init(dir, "--founder", "A", "--no-tracker").status).toBe(0);
		const before = snapshot(dir);
		const lines = upgradeAfterInit(dir);
		expect(snapshot(dir)).toEqual(before);
		expect(lines.filter((l) => /^(wrote|rewrote|repaired) /.test(l))).toEqual(
			[],
		);
	});

	it("syncs an init-made adopter's labels through the tracker its origin derives, none being declared (#1484)", () => {
		const { dir, git } = repo();
		git("remote", "add", "origin", "https://github.com/acme/widgets.git");
		expect(init(dir, "--founder", "A", "--no-tracker").status).toBe(0);
		expect(
			"tracker" in
				JSON.parse(
					fs.readFileSync(path.join(dir, ".claude/workflow-core.json"), "utf8"),
				),
		).toBe(false);
		const calls: string[] = [];
		const labels = {
			list: (slug: string) => {
				calls.push(`list ${slug}`);
				return [];
			},
			create: (slug: string) => {
				calls.push(`create ${slug}`);
			},
		};
		upgradeAfterInit(dir, labels);
		expect(calls[0]).toBe("list acme/widgets");
		expect(calls).toContain("create acme/widgets");
	});

	it("keeps an adopter's own hook under a shipped name through init and upgrade, saying so each time", () => {
		const { dir } = repo();
		const own = "#!/bin/sh\necho the adopter's own\n";
		fs.mkdirSync(path.join(dir, ".husky"), { recursive: true });
		fs.writeFileSync(path.join(dir, ".husky", HOOKS[0]), own);
		const skip = `skipped .husky/${HOOKS[0]} — the adopter's own hook`;
		const r = init(dir, "--founder", "A", "--no-tracker");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(skip);
		const lines = upgradeAfterInit(dir);
		expect(lines.join("\n")).toContain(skip);
		expect(fs.readFileSync(path.join(dir, ".husky", HOOKS[0]), "utf8")).toBe(
			own,
		);
	});
});

/*
 * An adopter from before the host registries, with gaps of its own, commits
 * everything upgrade changed: the registry guard and the husky stack must both
 * let it through (#1671). Gitleaks-gated, and given the skeleton's first
 * commit's budget, as it runs the same stack.
 */
describe("an unseeded adopter's first commit after upgrade (#1671)", () => {
	const ownGuard = "scripts/guard-own.sh";
	const ownChecker = "scripts/check-own.js";

	/** init's tree, put back to a pre-v1.3.14 adopter's and committed. */
	function unseededAdopter() {
		const { dir, git } = repo();
		expect(init(dir, "--founder", "A", "--no-tracker").status).toBe(0);
		for (const rel of [
			".claude/registrations.json",
			".claude/guard-fire-needles.json",
		])
			fs.rmSync(path.join(dir, rel));
		/* A hook from before #1839, which upgrade turns into its shim. */
		fs.writeFileSync(
			path.join(dir, ".husky/pre-commit"),
			`#!/usr/bin/env sh\nWFC_PLUGIN_ROOT="${CORE}"\nexport WFC_PLUGIN_ROOT\n`,
		);
		/* Settings with a core key missing, so the merge rewrites the file, and a
		 * hook of the adopter's own that no registry pins or counts. */
		const at = path.join(dir, ".claude/settings.json");
		const settings = JSON.parse(fs.readFileSync(at, "utf8"));
		delete settings.env.CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP;
		settings.hooks = {
			PreToolUse: [
				{
					matcher: "Bash",
					hooks: [
						{
							type: "command",
							command: `bash "$CLAUDE_PROJECT_DIR"/${ownGuard}`,
						},
					],
				},
			],
		};
		fs.writeFileSync(at, `${JSON.stringify(settings, null, "\t")}\n`);
		fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(dir, ownGuard), "#!/usr/bin/env bash\n", {
			mode: 0o755,
		});
		fs.writeFileSync(path.join(dir, ownChecker), "// nothing calls this\n");
		git("add", "-A");
		/* With no hooks, so the gaps land as HEAD's and read as inherited below. */
		git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "before upgrade");
		return { dir, git };
	}

	const readHookLines = (dir: string) =>
		allRegistrations(
			JSON.parse(
				fs.readFileSync(path.join(dir, ".claude/settings.json"), "utf8"),
			),
		).map(buildCommandLine);

	it.skipIf(!HAS_GITLEAKS)(
		"lands the whole change set through the registry guard and the husky stack",
		() => {
			const { dir, git } = unseededAdopter();
			const hooksBefore = readHookLines(dir);
			upgradeAfterInit(dir);
			/* Upgrade adds no hook to settings.json, so it owes no `hooks` row:
			 * a change here reopens #1671's second question. */
			expect(readHookLines(dir)).toEqual(hooksBefore);

			const changed = git("status", "--porcelain", "-uall")
				.split("\n")
				.filter(Boolean)
				.map((l) => l.slice(3));
			expect(changed).toEqual(
				expect.arrayContaining([
					".claude/settings.json",
					".claude/registrations.json",
					".claude/guard-fire-needles.json",
					".husky/pre-commit",
				]),
			);
			const message = "Upgrade workflow-core";
			const config = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-config-"));
			made.push(config);
			const env = {
				...process.env,
				CLAUDE_PROJECT_DIR: dir,
				CLAUDE_CONFIG_DIR: config,
			};
			const guardOn = (paths: string[]) => {
				git("add", "-N", "--", ...paths);
				return runInProcess(
					path.join(__dirname, "guard-dispatch.js"),
					["--only", "guard-registry-atomicity"],
					{
						cwd: dir,
						env,
						stdin: JSON.stringify({
							hook_event_name: "PreToolUse",
							session_id: "upgrader",
							tool_name: "Bash",
							tool_input: {
								command: `git commit -m "${message}" -- ${paths.join(" ")}`,
							},
						}),
					},
				);
			};

			/* The upgrade moves no hook and adds no member, so the guard passes it
			 * on judging, not by failing open... */
			const allowed = guardOn(changed);
			expect(allowed.status).toBe(0);
			expect(allowed.stdout).not.toContain('"deny"');
			expect(fs.existsSync(failOpenLogPath(config, dir))).toBe(false);
			/* ...and the same tree refuses an unregistered guard riding along. */
			const extra = "scripts/guard-new.sh";
			fs.writeFileSync(path.join(dir, extra), "#!/usr/bin/env bash\n");
			const refused = guardOn([...changed, extra]);
			expect(refused.stdout).toContain('"deny"');
			expect(refused.stdout).toContain(extra);
			git("rm", "-q", "--cached", "--", extra);
			fs.rmSync(path.join(dir, extra));

			const commit = commitThroughHooks(dir, message, changed, env);
			const commitOutput = `${commit.stdout}\n${commit.stderr}`;
			expect(commitOutput).not.toMatch(/^(FAIL|BROKEN):/m);
			expect(commit.status).toBe(0);
			expect(commitOutput).toContain(`${ownGuard} has no sibling test`);
			expect(commitOutput).toContain(`${ownChecker} is run by no husky hook`);
			expect(commitOutput).toMatch(/inherited fault/);
		},
		180_000,
	);
});

describe("where a url pin's hooks and rules file run from (#736)", () => {
	/** An empty config dir, and an env reading neither this session's plugin nor its project. */
	function pinEnv() {
		const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-config-"));
		made.push(configDir);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			CLAUDE_CONFIG_DIR: configDir,
		};
		delete env.CLAUDE_PLUGIN_ROOT;
		delete env.CLAUDE_PROJECT_DIR;
		return { configDir, env };
	}
	const bare = (env: NodeJS.ProcessEnv, dir: string, ...args: string[]) =>
		spawnSync(
			process.execPath,
			[SCRIPT, "--root", dir, "--founder", "A", "--no-tracker", ...args],
			{ cwd: dir, encoding: "utf8", env },
		);
	/** The cache copy an install lands, standing in as a link to this checkout. */
	function cacheCopy(configDir: string, version: string) {
		const at = installPathFor(
			configDir,
			"workflow-core",
			"workflow-core",
			version,
		);
		fs.mkdirSync(path.dirname(at), { recursive: true });
		fs.symlinkSync(CORE, at);
		return at;
	}
	const hooks = (dir: string) =>
		HOOKS.map((h) => fs.readFileSync(path.join(dir, ".husky", h), "utf8"));
	const readRules = (dir: string) =>
		fs.readFileSync(path.join(dir, ".claude/workflow-core.md"), "utf8");

	it("runs the rules file from this repo's install row, not the code running, and writes hook shims naming neither", () => {
		const { dir } = repo();
		const { configDir, env } = pinEnv();
		const installPath = cacheCopy(configDir, "1.2.3");
		fs.writeFileSync(
			path.join(configDir, "plugins/installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: {
					"workflow-core@workflow-core": [
						{
							scope: "project",
							projectPath: dir,
							installPath,
							version: "1.2.3",
						},
					],
				},
			}),
		);
		const r = bare(
			env,
			dir,
			"--no-plugin-install",
			"--marketplace-ref",
			"v1.2.3",
		);
		expect(r.status, r.stderr).toBe(0);
		expect(readRules(dir)).toContain(
			`\`${installPath}/scripts/bg-run.sh check <name>\``,
		);
		expect(readRules(dir)).not.toContain(`${CORE}/scripts/`);
		expect(hooks(dir)).toEqual(HOOKS.map((h) => renderHookShim(h)));
	});

	it("falls back to the code running only with no install row, warning that it is off the pin", () => {
		const { dir } = repo();
		const { env } = pinEnv();
		const r = bare(
			env,
			dir,
			"--no-plugin-install",
			"--marketplace-ref",
			"v9.9.9",
		);
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain(
			`WARNING the hooks and rules file run from ${CORE}, a checkout whose HEAD is not v9.9.9, since no install row names this repo`,
		);
		expect(hooks(dir)).toEqual(HOOKS.map((h) => renderHookShim(h)));
	});

	it("takes a --plugin-root the install creates, versioned by the pin until it exists", () => {
		const { dir } = repo();
		const { configDir, env } = pinEnv();
		const at = installPathFor(
			configDir,
			"workflow-core",
			"workflow-core",
			"7.8.0",
		);
		const stub = fs.mkdtempSync(path.join(os.tmpdir(), "adopter-claude-"));
		made.push(stub);
		fs.writeFileSync(
			path.join(stub, "claude"),
			`#!/bin/sh\nif [ "$1 $2" = "plugin install" ]; then mkdir -p ${JSON.stringify(path.dirname(at))} && ln -s ${JSON.stringify(CORE)} ${JSON.stringify(at)}; fi\n`,
			{ mode: 0o755 },
		);
		const r = bare(
			{ ...env, WFC_CLAUDE_BIN: path.join(stub, "claude") },
			dir,
			"--plugin-root",
			at,
			"--modules",
			"roadmap",
			"--marketplace-ref",
			"v7.8.0",
		);
		expect(r.status, r.stderr).toBe(0);
		expect(
			JSON.parse(
				fs.readFileSync(path.join(dir, ".claude/workflow-core.json"), "utf8"),
			).roadmapMajorPin,
		).toBe(7);
		expect(hooks(dir)).toEqual(HOOKS.map((h) => renderHookShim(h)));
	});

	it("refuses a --plugin-root that still does not exist once the install is past, naming the path and the way out, and writes no hooks", () => {
		const { dir } = repo();
		const { configDir, env } = pinEnv();
		const at = path.join(configDir, "absent");
		const r = bare(
			env,
			dir,
			"--plugin-root",
			at,
			"--no-plugin-install",
			"--marketplace-ref",
			"v1.2.3",
		);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			`the plugin root ${at} does not exist, so the hooks and rules file would run nothing — install the plugin there, then re-run`,
		);
		expect(fs.existsSync(path.join(dir, ".husky"))).toBe(false);
	});
});

describe("the tracker step on a brand-new tracker (#716)", () => {
	/* GH_ISSUE is the newest issue's number (empty for none), and
	 * GH_SUB/GH_DEPS/GH_LIST/GH_DEFAULT are the stderr a failing call prints. */
	const ghStub = `#!/bin/sh
echo "$*" >> "$GH_LOG"
case "$*" in
"repo set-default"*) [ -z "$GH_DEFAULT" ] || { echo "$GH_DEFAULT" >&2; exit 1; } ;;
"issue list"*) [ -z "$GH_LIST" ] || { echo "$GH_LIST" >&2; exit 1; }; echo "$GH_ISSUE" ;;
"api "*sub_issues*) [ -z "$GH_SUB" ] || { echo "$GH_SUB" >&2; exit 1; } ;;
"api "*blocked_by*) [ -z "$GH_DEPS" ] || { echo "$GH_DEPS" >&2; exit 1; } ;;
esac
exit 0
`;

	function adoptFrom(
		origin: string,
		env: Record<string, string>,
		...args: string[]
	) {
		const { dir, git } = repo();
		git("remote", "add", "origin", origin);
		const log = path.join(dir, "gh-calls.log");
		fs.writeFileSync(log, "");
		const stub = stubGhScript(dir, ghStub);
		const r = initIn(
			{ ...process.env, ...stub.env, GH_LOG: log, ...env },
			dir,
			"--founder",
			"A Founder",
			...args,
		);
		const calls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
		return { r, calls };
	}

	const adopt = (env: Record<string, string>, ...args: string[]) =>
		adoptFrom("https://github.com/acme/widget.git", env, ...args);

	it("points gh at the origin and probes the newest issue, never a hard-coded #1", () => {
		const { r, calls } = adopt({ GH_ISSUE: "7" });
		expect(r.status).toBe(0);
		expect(calls).toContain("repo set-default acme/widget");
		expect(r.stdout).toContain("gh       default repo set to acme/widget");
		expect(r.stdout).toContain(
			"probe    repos/acme/widget/issues/7/sub_issues: reachable",
		);
		expect(r.stdout).toContain(
			"probe    repos/acme/widget/issues/7/dependencies/blocked_by: reachable",
		);
		expect(calls.join("\n")).not.toContain("issues/1/");
	});

	it("prints one not-probed line where the tracker has no issue yet", () => {
		const { r, calls } = adopt({ GH_ISSUE: "" });
		expect(r.status).toBe(0);
		expect(r.stdout.split("\n").filter((l) => /sub.issues/.test(l))).toEqual([
			"probe    sub-issues, dependencies: not probed — the tracker has no issue yet",
		]);
		expect(calls.filter((c) => /sub_issues|blocked_by/.test(c))).toEqual([]);
		expect(r.stdout).toContain(
			"probe    repos/acme/widget/actions/runs?per_page=1: reachable",
		);
	});

	it.each([
		["403", "gh: Resource not accessible by integration (HTTP 403)"],
		["410", "gh: Sub-issues are disabled (HTTP 410)"],
	])(
		"reads a %s as off for this owner, and any other error as gh's own message",
		(_, off) => {
			const { r } = adopt({
				GH_ISSUE: "7",
				GH_SUB: off,
				GH_DEPS: "gh: Server Error (HTTP 500)",
			});
			expect(r.stdout).toContain(
				"probe    repos/acme/widget/issues/7/sub_issues: off for this owner",
			);
			expect(r.stdout).toContain(
				"probe    repos/acme/widget/issues/7/dependencies/blocked_by: gh: Server Error (HTTP 500)",
			);
		},
	);

	it.each([
		["--dry-run", "would  gh repo set-default acme/widget"],
		["--no-tracker", "skipped the tracker — --no-tracker"],
	])("calls gh not at all under %s", (flag, line) => {
		const { r, calls } = adopt({ GH_ISSUE: "7" }, flag);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(line);
		expect(calls).toEqual([]);
	});

	it("prints gh's own message where set-default or the issue list fails", () => {
		const { r } = adopt({
			GH_DEFAULT: "gh: no such repo",
			GH_LIST: "gh: the repository has disabled issues",
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			"FAILED gh repo set-default acme/widget: gh: no such repo",
		);
		expect(r.stdout).toContain(
			"probe    sub-issues, dependencies: gh: the repository has disabled issues",
		);
	});

	it("skips set-default where no tracker resolves", () => {
		const { r, calls } = adoptFrom("https://gitlab.com/acme/widget.git", {
			GH_ISSUE: "7",
		});
		expect(r.stdout).toContain(
			"skipped gh repo set-default — no tracker resolves",
		);
		expect(calls.filter((c) => c.startsWith("repo "))).toEqual([]);
	});
});

describe("the .gitignore init writes (#737)", () => {
	const checkIgnore = (dir: string, ...paths: string[]) =>
		spawnSync("git", ["check-ignore", "--stdin"], {
			cwd: dir,
			input: `${paths.join("\n")}\n`,
			encoding: "utf8",
		}).stdout;

	it("ignores private/, .claude/tmp/ and .claude/worktrees/ in an empty repo, and none of init's own paths", () => {
		const { dir } = repo();
		const r = init(dir, "--founder", "A Founder", "--no-tracker");
		expect(r.status, r.stderr).toBe(0);
		expect(r.stdout).toContain("wrote   .gitignore");
		expect(
			checkIgnore(
				dir,
				"private/x",
				".claude/tmp/markers/x",
				".claude/worktrees/x",
			),
		).toBe("private/x\n.claude/tmp/markers/x\n.claude/worktrees/x\n");
		expect(checkIgnore(dir, ...initPaths([...MODULES]))).toBe("");
	});

	it("keeps an existing file's lines and appends the block once across re-runs", () => {
		const { dir } = repo();
		const at = path.join(dir, ".gitignore");
		fs.writeFileSync(at, "dist/\n*.log\n");
		expect(init(dir, "--founder", "A Founder", "--no-tracker").status).toBe(0);
		const once = fs.readFileSync(at, "utf8");
		expect(once.startsWith("dist/\n*.log\n# workflow-core:begin\n")).toBe(true);
		const again = init(dir, "--founder", "A Founder", "--no-tracker");
		expect(again.status).toBe(0);
		expect(again.stdout).not.toMatch(/^\S+ +\.gitignore\b/m);
		expect(fs.readFileSync(at, "utf8")).toBe(once);
	});
});

describe("the skeleton pathspec", () => {
	it("covers every path init can write, under every module at once", () => {
		const uncovered = initPaths([...MODULES]).filter(
			(p: string) =>
				!SKELETON_PATHS.some((s) => p === s || p.startsWith(`${s}/`)),
		);
		expect(uncovered).toEqual([]);
	});

	it("takes a new core-owned entry's paths with no other edit (#1540)", () => {
		const added = { bring: () => [], paths: ["scripts/new-helper.sh"] };
		expect(initPaths([], [added])).toContain("scripts/new-helper.sh");
	});
});

describe("a run refused before it writes anything (#743)", () => {
	/** Every path under `dir` but `.git`, so a refusal is seen writing nothing. */
	const readTree = (dir: string) =>
		(fs.readdirSync(dir, { recursive: true }) as string[])
			.filter((p) => p !== ".git" && !p.startsWith(`.git${path.sep}`))
			.sort();

	/** A copy of the core's marketplace manifest, as its own checkout carries. */
	function fakeCore() {
		const { dir } = repo();
		fs.mkdirSync(path.join(dir, ".claude-plugin"));
		fs.copyFileSync(
			path.join(CORE, ".claude-plugin", "marketplace.json"),
			path.join(dir, ".claude-plugin", "marketplace.json"),
		);
		return dir;
	}

	it("prints the usage line for --help and exits 0", () => {
		const { dir } = repo();
		const r = init(dir, "--founder", "A Founder", "--no-tracker", "--help");
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/^usage: node scripts\/init-adopter\.js /);
		expect(readTree(dir)).toEqual([]);
	});

	it("refuses an unknown flag with the usage line, exit 2", () => {
		const { dir } = repo();
		const r = init(
			dir,
			"--founder",
			"A Founder",
			"--no-tracker",
			"--no-such-flag",
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('unknown flag "--no-such-flag"');
		expect(r.stderr).toContain("usage: node scripts/init-adopter.js");
		expect(readTree(dir)).toEqual([]);
	});

	it("refuses a bare flag given a value rather than reading it as one, naming the value", () => {
		const { dir } = repo();
		const r = init(
			dir,
			"--founder",
			"A Founder",
			"--no-tracker",
			"--dry-run",
			"x",
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain('unexpected argument "x"');
	});

	it("refuses to adopt the core's own checkout, run from inside it, leaving the checkout untouched", () => {
		const dir = fakeCore();
		const before = readTree(dir);
		const r = spawnSync(
			"node",
			[SCRIPT, "--founder", "A Founder", "--no-tracker", "--no-plugin-install"],
			{
				cwd: dir,
				encoding: "utf8",
				env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
			},
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("plugin's own checkout");
		expect(readTree(dir)).toEqual(before);
	});

	it("refuses the core's checkout while installing another plugin, leaving the checkout untouched", () => {
		const dir = fakeCore();
		const before = readTree(dir);
		const { dir: other } = repo();
		fs.mkdirSync(path.join(other, ".claude-plugin"));
		for (const [file, body] of [
			["marketplace.json", { name: "other" }],
			["plugin.json", { name: "other", version: "1.0.0" }],
		] as const)
			fs.writeFileSync(
				path.join(other, ".claude-plugin", file),
				JSON.stringify(body),
			);
		const r = spawnSync(
			"node",
			[
				SCRIPT,
				"--root",
				dir,
				"--plugin-root",
				other,
				"--marketplace",
				"other",
				"--founder",
				"A Founder",
				"--no-tracker",
				"--no-plugin-install",
			],
			{ cwd: dir, encoding: "utf8" },
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("plugin's own checkout");
		expect(readTree(dir)).toEqual(before);
	});

	it("refuses a root that is the plugin root, manifest or none, writing nothing", () => {
		const { dir } = repo();
		const link = path.join(os.tmpdir(), `adopter-link-${process.pid}`);
		fs.rmSync(link, { force: true });
		fs.symlinkSync(dir, link);
		made.push(link);
		const r = spawnSync(
			"node",
			[
				SCRIPT,
				"--root",
				dir,
				"--plugin-root",
				link,
				"--founder",
				"A Founder",
				"--no-tracker",
				"--no-plugin-install",
			],
			{ cwd: dir, encoding: "utf8" },
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("plugin's own checkout");
		expect(readTree(dir)).toEqual([]);
	});
});

describe("the host registries (#1456)", () => {
	const registries = [
		".claude/registrations.json",
		".claude/guard-fire-needles.json",
	];

	function guardDenies(dir: string, command: string): boolean {
		const { stdout: out } = runInProcess(
			path.join(CORE, "scripts/guard-dispatch.js"),
			["--only", "guard-registry-atomicity"],
			{
				cwd: dir,
				stdin: JSON.stringify({
					hook_event_name: "PreToolUse",
					tool_name: "Bash",
					tool_input: { command },
				}),
				env: {
					...process.env,
					CLAUDE_PROJECT_DIR: dir,
					CLAUDE_CONFIG_DIR: path.join(dir, ".git", "fixture-config"),
				},
			},
		);
		return out.includes('"permissionDecision":"deny"');
	}

	it("init seeds both empty, the checker finds nothing unregistered, and the guard allows the first commit", () => {
		const { dir } = repo();
		expect(init(dir, "--founder", "A", "--no-tracker").status).toBe(0);
		const registry = JSON.parse(
			fs.readFileSync(path.join(dir, registries[0]), "utf8"),
		);
		expect(registry).toMatchObject({
			hooks: [],
			registeredElsewhere: {},
			calledElsewhere: {},
		});
		expect(
			JSON.parse(fs.readFileSync(path.join(dir, registries[1]), "utf8")).guards,
		).toEqual({});
		const check = runInProcess(
			path.join(CORE, "scripts/check-registrations.js"),
			["--root", dir],
			{ cwd: dir },
		);
		expect(check.stderr).toMatch(/^OK: /m);
		expect(check.status).toBe(0);
		execFileSync("git", ["add", "-N", ...SKELETON_PATHS], { cwd: dir });
		expect(
			guardDenies(dir, `git commit -m "start" -- ${SKELETON_PATHS.join(" ")}`),
		).toBe(false);
	});

	it("upgrade seeds an adopter that lacks them, and leaves a filled one alone", () => {
		const { dir } = repo();
		expect(init(dir, "--founder", "A", "--no-tracker").status).toBe(0);
		fs.rmSync(path.join(dir, registries[0]));
		const filled = '{"guards": {"x.sh": {"needles": []}}}\n';
		fs.writeFileSync(path.join(dir, registries[1]), filled);
		const lines = upgradeAfterInit(dir);
		expect(lines).toContain(`wrote   ${registries[0]}`);
		expect(fs.existsSync(path.join(dir, registries[0]))).toBe(true);
		expect(fs.readFileSync(path.join(dir, registries[1]), "utf8")).toBe(filled);
	});
});
