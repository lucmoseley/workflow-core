// @vitest-environment node
/*
 * `resolveCore` finds the core an adopter imports from in its fixed lookup
 * order, fails naming what is missing, warns on an install off its pin, and
 * run as a script hands its argv to a core script (#461, #552).
 *
 * `env` is passed explicitly and carries `CLAUDE_CONFIG_DIR`, so no case reads
 * this machine's registry or its own WORKFLOW_CORE_* variables.
 *
 * The file is FROZEN and copied once into every adopter's tree, so a
 * regression a loosened case lets through cannot be re-synced away: an
 * adopter's checks and npm scripts resolve the wrong core, or die without
 * naming the pin.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { adopterFixtures } from "./plugin-state-testkit.js";
import { resolveCore } from "./resolve-core.js";

const fixture = adopterFixtures("wfc-resolve-core-");

/** A fresh directory beside `root`, inside the fixture's throwaway tree. */
function siblingDir(root: string, name: string) {
	const dir = path.join(path.dirname(root), name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * The resolver run as a git hook runs it: its own process, in `cwd`, with no
 * harness variable — `~/.claude` is a home directory linked to `configDir`.
 */
function resolveInPlainShell(cwd: string, configDir: string) {
	const home = siblingDir(cwd, "home");
	if (!fs.existsSync(path.join(home, ".claude")))
		fs.symlinkSync(configDir, path.join(home, ".claude"));
	const script = `process.stdout.write(require(${JSON.stringify(
		path.join(__dirname, "resolve-core.js"),
	)}).resolveCore())`;
	return execFileSync(process.execPath, ["-e", script], {
		cwd,
		env: { PATH: process.env.PATH, HOME: home },
		encoding: "utf8",
	});
}

function resolve(
	root: string,
	env: Record<string, string>,
	warnings: string[] = [],
) {
	return resolveCore({ root, env, warn: (line) => warnings.push(line) });
}

describe("resolveCore's lookup order (#461)", () => {
	it("takes the override ahead of the CI checkout and the installed plugin", () => {
		const { root, configDir } = fixture({ pinRef: "v1.1.8" });
		const override = siblingDir(root, "override");
		expect(
			resolve(root, {
				CLAUDE_CONFIG_DIR: configDir,
				WORKFLOW_CORE_DIR: override,
				WORKFLOW_CORE_CHECKOUT: siblingDir(root, "checkout"),
			}),
		).toBe(override);
	});

	it("takes the CI checkout ahead of the installed plugin", () => {
		const { root, configDir } = fixture({ pinRef: "v1.1.8" });
		const checkout = siblingDir(root, "checkout");
		expect(
			resolve(root, {
				CLAUDE_CONFIG_DIR: configDir,
				WORKFLOW_CORE_CHECKOUT: checkout,
			}),
		).toBe(checkout);
	});

	it("falls back to the installed plugin's installPath", () => {
		const { root, configDir, installPath } = fixture({ pinRef: "v1.1.8" });
		const warnings: string[] = [];
		expect(resolve(root, { CLAUDE_CONFIG_DIR: configDir }, warnings)).toBe(
			installPath,
		);
		expect(warnings).toEqual([]);
	});

	it("takes the last install row recorded for this root, not another project's", () => {
		const { root, configDir, installPath } = fixture({ pinRef: "v1.1.8" });
		const record = path.join(configDir, "plugins", "installed_plugins.json");
		const older = siblingDir(root, "older-install");
		const neighbour = siblingDir(root, "neighbour-install");
		fs.writeFileSync(
			record,
			JSON.stringify({
				plugins: {
					"workflow-core@wc": [
						{ projectPath: root, installPath: older },
						{ projectPath: root, installPath },
						{ projectPath: "/another/project", installPath: neighbour },
					],
				},
			}),
		);
		expect(resolve(root, { CLAUDE_CONFIG_DIR: configDir })).toBe(installPath);
	});

	it("resolves with no harness variables, from a git hook's plain environment and from a linked worktree", () => {
		const { root, configDir, installPath } = fixture({ pinRef: "v1.1.8" });
		execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
		execFileSync(
			"git",
			[
				"-c",
				"user.email=a@a",
				"-c",
				"user.name=a",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				"x",
			],
			{ cwd: root },
		);
		const worktree = path.join(path.dirname(root), "wt");
		execFileSync("git", ["worktree", "add", "-q", "--detach", worktree], {
			cwd: root,
		});

		for (const cwd of [root, worktree])
			expect(resolveInPlainShell(cwd, configDir)).toBe(installPath);
	});

	it("resolves from a checkout whose git dir lives outside it", () => {
		const { root, configDir, installPath } = fixture({ pinRef: "v1.1.8" });
		const gitDir = path.join(path.dirname(root), "elsewhere");
		execFileSync("git", ["init", "-q", "--separate-git-dir", gitDir], {
			cwd: root,
		});

		expect(resolveInPlainShell(root, configDir)).toBe(installPath);
	});
});

describe("resolveCore's failure (#461)", () => {
	it("names the pin and the missing install record where nothing resolves", () => {
		const { root } = fixture({ pinRef: "v1.1.8" });
		const emptyConfig = siblingDir(root, "empty-config");
		expect(() => resolve(root, { CLAUDE_CONFIG_DIR: emptyConfig })).toThrow(
			`resolve-core: no workflow-core directory for pin v1.1.8 — WORKFLOW_CORE_DIR and WORKFLOW_CORE_CHECKOUT are unset, and ${emptyConfig}/plugins/installed_plugins.json records no workflow-core@wc install for ${root}`,
		);
	});

	it("names the pin and the variable where a set variable names no directory, rather than falling through", () => {
		const { root, configDir } = fixture({ pinRef: "v1.1.8" });
		const gone = path.join(path.dirname(root), "never-checked-out");
		expect(() =>
			resolve(root, {
				CLAUDE_CONFIG_DIR: configDir,
				WORKFLOW_CORE_CHECKOUT: gone,
			}),
		).toThrow(
			`for pin v1.1.8 — WORKFLOW_CORE_CHECKOUT names ${gone}, which is not a directory`,
		);
	});

	it("names the recorded install path where it is gone from disk", () => {
		const { root, configDir, installPath } = fixture({ pinRef: "v1.1.8" });
		fs.rmSync(installPath, { recursive: true });
		expect(() => resolve(root, { CLAUDE_CONFIG_DIR: configDir })).toThrow(
			`records ${installPath}, which is not a directory`,
		);
	});

	it("names the missing pin where the settings enable no workflow-core", () => {
		const { root, configDir } = fixture({ pinRef: "v1.1.8" });
		const settings = path.join(root, ".claude", "settings.json");
		fs.rmSync(settings);
		expect(() => resolve(root, { CLAUDE_CONFIG_DIR: configDir })).toThrow(
			`resolve-core: no workflow-core directory for pin none — WORKFLOW_CORE_DIR and WORKFLOW_CORE_CHECKOUT are unset, and ${settings} enables no workflow-core from a known marketplace`,
		);
	});

	it("names the missing install, not a TypeError, where the record's row is malformed", () => {
		const { root, configDir } = fixture({ pinRef: "v1.1.8" });
		fs.writeFileSync(
			path.join(configDir, "plugins", "installed_plugins.json"),
			JSON.stringify({ plugins: { "workflow-core@wc": { installPath: "x" } } }),
		);
		expect(() => resolve(root, { CLAUDE_CONFIG_DIR: configDir })).toThrow(
			"records no workflow-core@wc install",
		);
	});
});

describe("resolveCore's stale-install warning (#461)", () => {
	it("warns, naming both versions, and still resolves, where the installed plugin is behind the pin", () => {
		const { root, configDir, installPath } = fixture({
			pinRef: "v1.1.11",
			installedVersion: "1.1.8",
		});
		const warnings: string[] = [];
		expect(resolve(root, { CLAUDE_CONFIG_DIR: configDir }, warnings)).toBe(
			installPath,
		);
		expect(warnings).toEqual([
			"resolve-core: the installed workflow-core is 1.1.8, not the pinned v1.1.11 — local results can differ from CI's until the install catches up",
		]);
	});

	it("warns where the installed plugin is ahead of the pin too, naming both versions", () => {
		const { root, configDir } = fixture({
			pinRef: "v1.1.8",
			installedVersion: "1.1.11",
		});
		const warnings: string[] = [];
		resolve(root, { CLAUDE_CONFIG_DIR: configDir }, warnings);
		expect(warnings).toEqual([
			expect.stringContaining("is 1.1.11, not the pinned v1.1.8"),
		]);
	});

	it.each(["main", "b88b6baafe3998bb3f84a5aa495d4ab01c2945f4"])(
		"compares nothing against a pin that names no version (%s)",
		(pinRef) => {
			const { root, configDir } = fixture({ pinRef });
			const warnings: string[] = [];
			resolve(root, { CLAUDE_CONFIG_DIR: configDir }, warnings);
			expect(warnings).toEqual([]);
		},
	);
});

describe("resolve-core.js run as a script (#552)", () => {
	const self = path.join(__dirname, "resolve-core.js");
	/** Runs the resolver's script form in `cwd` with only `env` set. */
	function run(cwd: string, env: Record<string, string>, args: string[]) {
		// spawn-kept: a real fd — the form under test hands its stdio and exit status to a child
		return spawnSync(process.execPath, [self, ...args], {
			cwd,
			env: { PATH: process.env.PATH ?? "", ...env },
			encoding: "utf8",
		});
	}

	it("runs the named core script with the rest of its argv, and exits as it did", () => {
		const { root, configDir } = fixture({ pinRef: "v1.1.8" });
		const core = siblingDir(root, "core");
		fs.mkdirSync(path.join(core, "scripts"));
		fs.writeFileSync(
			path.join(core, "scripts", "echo.js"),
			"console.log(JSON.stringify(process.argv.slice(2))); process.exit(3);",
		);
		const r = run(
			root,
			{ CLAUDE_CONFIG_DIR: configDir, WORKFLOW_CORE_DIR: core },
			["scripts/echo.js", "--changed", "a b"],
		);
		expect(r.stdout.trim()).toBe('["--changed","a b"]');
		expect(r.status).toBe(3);
	});

	it("exits 1 naming the pin where no core resolves", () => {
		const { root } = fixture({ pinRef: "v1.1.8" });
		const r = run(root, { CLAUDE_CONFIG_DIR: siblingDir(root, "empty") }, [
			"scripts/run-vitest.js",
		]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(
			"resolve-core: no workflow-core directory for pin v1.1.8",
		);
	});

	it("exits 2 naming the usage where no script is named", () => {
		const { root, configDir } = fixture({ pinRef: "v1.1.8" });
		const r = run(root, { CLAUDE_CONFIG_DIR: configDir }, []);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("name the core script to run");
	});
});
