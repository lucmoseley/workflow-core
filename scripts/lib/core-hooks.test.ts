// @vitest-environment node
/*
 * runningHooks is the one answer to "which hooks does this repo run" (spec
 * #2295, seam 1). At the core it is the self-plugin's file then the canary its
 * settings keep (#2473), at an adopter the host's settings merged with the
 * plugin's file. A reader answering from the
 * wrong file attributes fires, liveness and census counts to a registration no
 * session runs; one answering an absent or broken file as empty reports every
 * guard as unregistered.
 *
 * selfPluginSetup is checked against the canary's printed line, its hand-kept
 * shell twin, so the two never name different commands (#2461).
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	SELF_PLUGIN_HOOKS,
	runningHooks,
	flattenHooks,
	hookSourcesOf,
	isCoreRoot,
	ownHookSources,
	ownHooks,
	ownHooksFile,
	selfPluginSetup,
} = require("./core-hooks.js");

const CANARY = path.resolve(__dirname, "..", "self-plugin-canary.sh");

const stop = (script: string) => ({
	Stop: [{ hooks: [{ type: "command", command: script }] }],
});

function write(root: string, rel: string, data: unknown) {
	fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
	fs.writeFileSync(
		path.join(root, rel),
		typeof data === "string" ? data : JSON.stringify(data),
	);
}

function git(root: string, ...args: string[]) {
	execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

function initRepo(root: string) {
	git(root, "init", "-q");
	git(root, "config", "user.email", "test@example.com");
	git(root, "config", "user.name", "test");
}

let core: string;
let host: string;
beforeEach(() => {
	core = fs.mkdtempSync(path.join(os.tmpdir(), "core-hooks-core-"));
	host = fs.mkdtempSync(path.join(os.tmpdir(), "core-hooks-host-"));
});
afterEach(() => {
	fs.rmSync(core, { recursive: true, force: true });
	fs.rmSync(host, { recursive: true, force: true });
});

describe("runningHooks at the core's own checkout", () => {
	it("reads the self-plugin's file then the settings' canary, not the plugin render (#2473)", () => {
		write(core, SELF_PLUGIN_HOOKS, { hooks: stop("self.sh") });
		write(core, ".claude/settings.json", { hooks: stop("canary.sh") });
		write(core, "hooks/hooks.json", { hooks: stop("render.sh") });
		expect(runningHooks(core, { core })).toEqual({
			Stop: [...stop("self.sh").Stop, ...stop("canary.sh").Stop],
		});
	});

	it("reads the settings at the same revision as the self-plugin's file", () => {
		initRepo(core);
		write(core, SELF_PLUGIN_HOOKS, { hooks: stop("self.sh") });
		write(core, ".claude/settings.json", { hooks: stop("committed.sh") });
		git(core, "add", "-A");
		git(core, "commit", "-qm", "first");
		write(core, ".claude/settings.json", { hooks: stop("disk.sh") });
		expect(runningHooks(core, { core, rev: "HEAD" })).toEqual({
			Stop: [...stop("self.sh").Stop, ...stop("committed.sh").Stop],
		});
	});

	it("reads the file at a revision, and the index under an empty revision", () => {
		initRepo(core);
		write(core, SELF_PLUGIN_HOOKS, { hooks: stop("first.sh") });
		git(core, "add", "-A");
		git(core, "commit", "-qm", "first");
		write(core, SELF_PLUGIN_HOOKS, { hooks: stop("second.sh") });
		git(core, "add", "-A");
		git(core, "commit", "-qm", "second");
		write(core, SELF_PLUGIN_HOOKS, { hooks: stop("staged.sh") });
		git(core, "add", "-A");
		write(core, SELF_PLUGIN_HOOKS, { hooks: stop("disk.sh") });

		expect(runningHooks(core, { core, rev: "HEAD~1" })).toEqual(
			stop("first.sh"),
		);
		expect(runningHooks(core, { core, rev: "HEAD" })).toEqual(
			stop("second.sh"),
		);
		expect(runningHooks(core, { core, rev: "" })).toEqual(stop("staged.sh"));
		expect(runningHooks(core, { core })).toEqual(stop("disk.sh"));
	});

	it("throws naming the file where it is absent, on disk or at a revision", () => {
		expect(() => runningHooks(core, { core })).toThrow(
			`${SELF_PLUGIN_HOOKS} cannot be read at ${core}`,
		);
		initRepo(core);
		write(core, "a", "a");
		git(core, "add", "-A");
		git(core, "commit", "-qm", "a");
		expect(() => runningHooks(core, { core, rev: "HEAD" })).toThrow(
			`${SELF_PLUGIN_HOOKS} cannot be read at HEAD in ${core}`,
		);
	});

	it("throws where the file is not JSON or carries no hooks object", () => {
		write(core, SELF_PLUGIN_HOOKS, "not json");
		expect(() => runningHooks(core, { core })).toThrow("is not valid JSON");
		write(core, SELF_PLUGIN_HOOKS, { hooks: [] });
		expect(() => runningHooks(core, { core })).toThrow(
			"carries no hooks object",
		);
	});
});

describe("runningHooks at an adopter host", () => {
	it("merges the host's settings with the plugin's file, settings first", () => {
		write(host, ".claude/settings.json", { hooks: stop("host.sh") });
		write(core, "hooks/hooks.json", { hooks: stop("plugin.sh") });
		write(core, SELF_PLUGIN_HOOKS, { hooks: stop("self.sh") });
		expect(runningHooks(host, { core })).toEqual({
			Stop: [...stop("host.sh").Stop, ...stop("plugin.sh").Stop],
		});
	});

	it("names an absent settings file on stderr, and says nothing under quiet (#2462)", () => {
		write(core, "hooks/hooks.json", { hooks: stop("plugin.sh") });
		// The whole text taken: a 0-byte answer holds writeFd for its 10 s ceiling.
		const written = vi
			.spyOn(fs, "writeSync")
			.mockImplementation((_fd, data) => Buffer.byteLength(data as string));
		try {
			expect(runningHooks(host, { core, quiet: true })).toEqual(
				stop("plugin.sh"),
			);
			expect(written).not.toHaveBeenCalled();
			runningHooks(host, { core });
			expect(
				written.mock.calls.map(([fd, data]) => [fd, String(data)]),
			).toEqual([
				[
					2,
					`⚠ ${path.join(host, ".claude", "settings.json")} is absent — it registers no hook here.\n`,
				],
			]);
		} finally {
			written.mockRestore();
		}
	});

	it("refuses a revision, which no caller reads an adopter at", () => {
		initRepo(host);
		write(host, ".claude/settings.json", { hooks: stop("host.sh") });
		git(host, "add", "-A");
		git(host, "commit", "-qm", "first");
		expect(() => runningHooks(host, { core, rev: "HEAD" })).toThrow(
			"is read from disk only",
		);
	});

	it("throws naming the file where one is not valid JSON", () => {
		write(core, "hooks/hooks.json", "not json");
		expect(() => runningHooks(host, { core })).toThrow(
			`${path.join(core, "hooks", "hooks.json")} is not valid JSON`,
		);
	});
});

describe("ownHooks, the hooks a repo registers itself (#2442)", () => {
	it("reads the self-plugin's file then the settings' canary at the core, at a revision too (#2572)", () => {
		initRepo(core);
		write(core, SELF_PLUGIN_HOOKS, { hooks: stop("committed.sh") });
		write(core, ".claude/settings.json", { hooks: stop("canary.sh") });
		git(core, "add", "-A");
		git(core, "commit", "-qm", "first");
		write(core, SELF_PLUGIN_HOOKS, { hooks: stop("disk.sh") });
		write(core, ".claude/settings.json", { hooks: stop("settings.sh") });
		expect(ownHooksFile(core, { core })).toBe(SELF_PLUGIN_HOOKS);
		expect(ownHooks(core, { core })).toEqual({
			Stop: [...stop("disk.sh").Stop, ...stop("settings.sh").Stop],
		});
		expect(ownHooks(core, { core, rev: "HEAD" })).toEqual({
			Stop: [...stop("committed.sh").Stop, ...stop("canary.sh").Stop],
		});
	});

	it("reads an adopter's settings alone, leaving out the plugin's file", () => {
		write(host, ".claude/settings.json", { hooks: stop("host.sh") });
		write(core, "hooks/hooks.json", { hooks: stop("plugin.sh") });
		expect(ownHooksFile(host, { core })).toBe(".claude/settings.json");
		expect(ownHooks(host, { core })).toEqual(stop("host.sh"));
	});

	it("reads an adopter's settings at a revision", () => {
		initRepo(host);
		write(host, ".claude/settings.json", { hooks: stop("committed.sh") });
		git(host, "add", "-A");
		git(host, "commit", "-qm", "first");
		write(host, ".claude/settings.json", { hooks: stop("disk.sh") });
		expect(ownHooks(host, { core, rev: "HEAD" })).toEqual(stop("committed.sh"));
	});

	it("answers null for an adopter's absent settings, and none for one with no hooks key", () => {
		expect(ownHooks(host, { core })).toBeNull();
		initRepo(host);
		write(host, "a", "a");
		git(host, "add", "-A");
		git(host, "commit", "-qm", "a");
		expect(ownHooks(host, { core, rev: "HEAD" })).toBeNull();
		write(host, ".claude/settings.json", { permissions: {} });
		expect(ownHooks(host, { core })).toEqual({});
	});

	it("throws on an absent self-plugin file at the core, and a malformed file anywhere", () => {
		expect(() => ownHooks(core, { core })).toThrow(
			`${SELF_PLUGIN_HOOKS} cannot be read at ${core}`,
		);
		write(host, ".claude/settings.json", "not json");
		expect(() => ownHooks(host, { core })).toThrow("is not valid JSON");
		write(host, ".claude/settings.json", { hooks: [] });
		expect(() => ownHooks(host, { core })).toThrow("carries no hooks object");
		write(host, ".claude/settings.json", { hooks: { Stop: { hooks: [] } } });
		expect(() => ownHooks(host, { core })).toThrow(
			"its Stop hooks are not a list",
		);
	});

	it("names the file each of its hooks is in: the self-plugin's then the settings' at the core (#2572)", () => {
		write(core, SELF_PLUGIN_HOOKS, { hooks: stop("self.sh") });
		write(core, ".claude/settings.json", { hooks: stop("canary.sh") });
		write(host, ".claude/settings.json", { hooks: stop("host.sh") });
		expect(ownHookSources(core, { core })).toEqual([
			{
				file: path.join(core, SELF_PLUGIN_HOOKS),
				settings: { hooks: stop("self.sh") },
			},
			{
				file: path.join(core, ".claude/settings.json"),
				settings: { hooks: stop("canary.sh") },
			},
		]);
		expect(ownHookSources(host, { core })).toEqual([
			{
				file: path.join(host, ".claude/settings.json"),
				settings: { hooks: stop("host.sh") },
			},
		]);
	});
});

describe("a materialised core revision (#2445)", () => {
	it("is the core wherever its tree carries the self-plugin's file, on disk and at a revision", () => {
		write(host, SELF_PLUGIN_HOOKS, { hooks: stop("self.sh") });
		write(host, ".claude/settings.json", { hooks: stop("settings.sh") });
		const both = {
			Stop: [...stop("self.sh").Stop, ...stop("settings.sh").Stop],
		};
		expect(ownHooksFile(host, { core })).toBe(SELF_PLUGIN_HOOKS);
		expect(ownHooks(host, { core })).toEqual(both);
		initRepo(host);
		git(host, "add", "-A");
		git(host, "commit", "-qm", "first");
		write(host, SELF_PLUGIN_HOOKS, { hooks: stop("on-disk.sh") });
		expect(ownHooks(host, { core, rev: "HEAD" })).toEqual(both);
		expect(runningHooks(host, { core, rev: "HEAD" })).toEqual(both);
	});

	it("is an adopter at a revision that does not carry the file, though the disk does", () => {
		initRepo(host);
		write(host, ".claude/settings.json", { hooks: stop("settings.sh") });
		git(host, "add", "-A");
		git(host, "commit", "-qm", "first");
		write(host, SELF_PLUGIN_HOOKS, { hooks: stop("self.sh") });
		expect(ownHooksFile(host, { core, rev: "HEAD" })).toBe(
			".claude/settings.json",
		);
		expect(ownHooks(host, { core, rev: "HEAD" })).toEqual(stop("settings.sh"));
	});

	it("is an adopter where the self-plugin's folder holds no hooks file (#2633)", () => {
		write(host, "self-plugin/.claude-plugin/marketplace.json", {});
		expect(isCoreRoot(host, { core })).toBe(false);
		write(host, SELF_PLUGIN_HOOKS, { hooks: {} });
		expect(isCoreRoot(host, { core })).toBe(true);
	});

	it("throws on a revision git cannot show, never reading it as an adopter", () => {
		initRepo(host);
		write(host, ".claude/settings.json", { hooks: stop("settings.sh") });
		git(host, "add", "-A");
		git(host, "commit", "-qm", "first");
		expect(() => ownHooks(host, { core, rev: "no-such-rev" })).toThrow(
			/no-such-rev/,
		);
	});
});

describe("hookSourcesOf, the files registering a host's hooks (#2444)", () => {
	it("answers the self-plugin's file then the settings at the core, never the plugin's (#2473)", () => {
		write(core, SELF_PLUGIN_HOOKS, { hooks: stop("self.sh") });
		write(core, ".claude/settings.json", { hooks: stop("canary.sh") });
		write(core, "hooks/hooks.json", { hooks: stop("plugin.sh") });
		expect(hookSourcesOf(core, { core })).toEqual([
			{
				file: path.join(core, SELF_PLUGIN_HOOKS),
				settings: { hooks: stop("self.sh") },
			},
			{
				file: path.join(core, ".claude", "settings.json"),
				settings: { hooks: stop("canary.sh") },
			},
		]);
	});

	it("answers an absent settings file at the core as registering nothing", () => {
		write(core, SELF_PLUGIN_HOOKS, { hooks: stop("self.sh") });
		expect(hookSourcesOf(core, { core })[1]).toEqual({
			file: path.join(core, ".claude", "settings.json"),
			settings: null,
		});
	});

	it("answers an adopter's settings, then the plugin's hooks file", () => {
		write(host, ".claude/settings.json", { hooks: stop("host.sh") });
		write(core, "hooks/hooks.json", { hooks: stop("plugin.sh") });
		expect(hookSourcesOf(host, { core })).toEqual([
			{
				file: path.join(host, ".claude", "settings.json"),
				settings: { hooks: stop("host.sh") },
			},
			{
				file: path.join(core, "hooks", "hooks.json"),
				settings: { hooks: stop("plugin.sh") },
			},
		]);
	});

	it("throws at a core with no self-plugin file, naming it", () => {
		expect(() => hookSourcesOf(core, { core })).toThrow(
			`${SELF_PLUGIN_HOOKS} cannot be read`,
		);
	});
});

describe("the core's own checkout", () => {
	it("is named through a symlink", () => {
		const link = `${host}-link`;
		fs.symlinkSync(core, link);
		try {
			expect(ownHooksFile(link, { core })).toBe(SELF_PLUGIN_HOOKS);
			expect(ownHooksFile(host, { core })).toBe(".claude/settings.json");
		} finally {
			fs.rmSync(link);
		}
	});
});

describe("selfPluginSetup (#2461)", () => {
	const Placeholder = "<absolute path to the main checkout>";

	function checkout(name: string) {
		const at = path.join(fs.realpathSync(host), name);
		fs.mkdirSync(at);
		initRepo(at);
		git(at, "commit", "-q", "--allow-empty", "--no-verify", "-m", "init");
		return at;
	}

	function worktreeOf(main: string) {
		const at = path.join(main, ".claude", "worktrees", "wt");
		git(main, "worktree", "add", "-q", at);
		return at;
	}

	/** The command's arguments as bash parses them. */
	function args(command: string) {
		return execFileSync(
			"bash",
			["-c", `set -- ${command}; printf '%s\\0' "$@"`],
			{ encoding: "utf8" },
		)
			.split("\0")
			.slice(0, -1);
	}

	it("names the main checkout from a worktree, as one argument", () => {
		const main = checkout("the founder's checkout");
		expect(args(selfPluginSetup(worktreeOf(main)))).toEqual([
			"claude",
			"plugin",
			"marketplace",
			"add",
			`${main}/self-plugin`,
			"--scope",
			"user",
		]);
	});

	it("carries the placeholder where the root is no git checkout", () => {
		expect(selfPluginSetup(host)).toBe(
			`claude plugin marketplace add '${Placeholder}/self-plugin' --scope user`,
		);
	});

	it.each([
		["a worktree", () => worktreeOf(checkout("main"))],
		["no git checkout", () => host],
	])("is the line the canary prints from %s", (_, rootOf) => {
		const root = rootOf();
		const r = spawnSync(CANARY, [], {
			encoding: "utf8",
			input: JSON.stringify({ session_id: "no-marker", tool_name: "Bash" }),
			env: { ...process.env, CLAUDE_PROJECT_DIR: root },
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`\n! ${selfPluginSetup(root)}\n`);
	});
});

describe("flattenHooks", () => {
	it("gives one entry per command, keeping every field it carries", () => {
		expect(
			flattenHooks({
				PreToolUse: [
					{
						matcher: "Bash",
						hooks: [
							{ type: "command", command: "a.sh", if: "Bash(git *)" },
							{
								type: "command",
								command: "node",
								args: ["b.js"],
								timeout: 5,
								async: true,
							},
						],
					},
				],
				Stop: [{ hooks: [{ type: "command", command: "c.sh" }] }],
			}),
		).toEqual([
			{
				event: "PreToolUse",
				matcher: "Bash",
				type: "command",
				command: "a.sh",
				if: "Bash(git *)",
			},
			{
				event: "PreToolUse",
				matcher: "Bash",
				type: "command",
				command: "node",
				args: ["b.js"],
				timeout: 5,
				async: true,
			},
			{ event: "Stop", type: "command", command: "c.sh" },
		]);
	});
});

describe("hookSourcesOf at an adopter host (#2297)", () => {
	beforeEach(() => fs.mkdirSync(path.join(core, "hooks")));

	it("reads the host's settings, then the plugin's hooks, an absent one as null", () => {
		fs.writeFileSync(
			path.join(core, "hooks", "hooks.json"),
			JSON.stringify({ hooks: { Stop: [] } }),
		);
		expect(hookSourcesOf(host, { core })).toEqual([
			{ file: path.join(host, ".claude", "settings.json"), settings: null },
			{
				file: path.join(core, "hooks", "hooks.json"),
				settings: { hooks: { Stop: [] } },
			},
		]);
	});

	it("throws naming the file where one is not valid JSON", () => {
		const file = path.join(core, "hooks", "hooks.json");
		fs.writeFileSync(file, "not json");
		expect(() => hookSourcesOf(host, { core })).toThrow(
			`${file} is not valid JSON`,
		);
	});

	it("throws naming the file where one cannot be read", () => {
		const file = path.join(host, ".claude", "settings.json");
		fs.mkdirSync(file, { recursive: true });
		expect(() => hookSourcesOf(host, { core })).toThrow(
			`${file} cannot be read`,
		);
	});
});
