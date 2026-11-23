// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate } from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "check-release-lag.js");
const DAY = 86_400;
const T0 = 1_790_000_000;

let dir: string;
let repo: string;
let home: string;
let registry: { plugins: Record<string, object[]> };
beforeEach(() => {
	registry = { plugins: { "workflow-core@wfc": [] } };
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-lag-"));
	repo = path.join(dir, "repo");
	home = path.join(dir, "home");
	fs.mkdirSync(repo);
	fs.mkdirSync(home);
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const gitIn = (cwd: string, args: string[], at = 0): string => {
	const date = `@${T0 + at} +0000`;
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_DATE: date,
			GIT_COMMITTER_DATE: date,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@t",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@t",
		},
	}).trim();
};

const git = (args: string[], at = 0): string => gitIn(repo, args, at);

const seededCore = defineTemplate((root) => {
	gitIn(root, ["init", "-q", "-b", "main"]);
	fs.mkdirSync(path.join(root, ".claude-plugin"));
	fs.writeFileSync(
		path.join(root, ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: "workflow-core" }),
	);
	gitIn(root, ["add", "."]);
	gitIn(root, ["commit", "-q", "-m", "init"], 0);
});

const commit = (at: number) =>
	git(["commit", "-q", "--allow-empty", "-m", `c${at}`], at);

const buildCore = ({
	lagDays,
	ahead = 3,
	message,
}: {
	lagDays: number;
	ahead?: number;
	message?: (source: string) => string;
}) => {
	seededCore.instantiate(repo);
	const source = git(["rev-parse", "HEAD"]);
	for (let i = 1; i <= ahead; i++)
		commit(Math.round((lagDays * DAY * i) / ahead));
	git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
	git(["checkout", "-q", "--orphan", "release"]);
	git(
		[
			"commit",
			"-q",
			"-m",
			message
				? message(source)
				: `Release workflow-core v1.0.0, rendered from ${source}`,
		],
		DAY,
	);
	git(["tag", "v1.0.0"]);
	git(["checkout", "-q", "main"]);
	return source;
};

const addAdopter = (
	name: string,
	ref: string | null,
	installed: string | null = ref,
) => {
	const root = path.join(home, name);
	fs.mkdirSync(path.join(root, ".git"), { recursive: true });
	fs.mkdirSync(path.join(root, ".claude"));
	fs.writeFileSync(path.join(root, ".claude", "workflow-core.json"), "{}");
	const settings =
		ref === null
			? {}
			: {
					enabledPlugins: { "workflow-core@wfc": true },
					extraKnownMarketplaces: {
						wfc: { source: { source: "github", repo: "x/y", ref } },
					},
				};
	fs.writeFileSync(
		path.join(root, ".claude", "settings.json"),
		JSON.stringify(settings),
	);
	if (installed === null) return;
	registry.plugins["workflow-core@wfc"]?.push({
		projectPath: root,
		installPath: path.join(home, "cache", installed),
		version: installed.replace(/^v/, ""),
	});
	const at = path.join(home, ".claude", "plugins", "installed_plugins.json");
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, JSON.stringify(registry));
};

const run = (args: string[] = ["--json"]) =>
	runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			GITHUB_ACTIONS: "",
			WFC_REPO_ROOT: repo,
			HOME: home,
			CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
		},
	});

describe("a lag within the threshold", () => {
	it("is OK, counting commits and days from the tag's source", () => {
		const source = buildCore({ lagDays: 3, ahead: 3 });
		addAdopter("a", "v1.0.0");
		addAdopter("b", "v1.0.0");
		addAdopter("c", "v0.9.0");
		const r = run();
		expect(r.status).toBe(0);
		const env = JSON.parse(r.stdout);
		expect(env.outcome).toBe("OK");
		expect(env).toMatchObject({ commits: 3, days: 3, source });
		expect(env.summary).toContain("3 commit(s) and 3 day(s) behind");
		expect(env.summary).toContain(
			"Adopters, pin / installed: a v1.0.0 / v1.0.0, b v1.0.0 / v1.0.0, c v0.9.0 / v0.9.0.",
		);
	});

	it("prints nothing at SessionStart", () => {
		buildCore({ lagDays: 3 });
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});
});

describe("a lag past the threshold", () => {
	it("warns at SessionStart, naming the lag and the adopters", () => {
		buildCore({ lagDays: 8 });
		addAdopter("a", "v1.0.0");
		addAdopter("d", null);
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("RELEASE-LAG");
		expect(r.stdout).toContain("8 day(s) behind origin/main");
		expect(r.stdout).toContain(
			"-day threshold: no fix since reaches an adopter",
		);
		expect(r.stdout).toContain("a v1.0.0 / v1.0.0, d no pin / not installed");
	});
});

describe("an install off its pin", () => {
	it("warns at SessionStart within the lag threshold, naming pin and install", () => {
		buildCore({ lagDays: 1 });
		addAdopter("level", "v1.0.0");
		addAdopter("old", "v1.0.0", "v0.9.0");
		addAdopter("absent", "v1.0.0", null);
		const r = run(["--notify"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(
			"INSTALL-OFF-PIN — Install not at pin, pin / installed: absent v1.0.0 / not installed, old v1.0.0 / v0.9.0. The pinned release is not what runs there; each checkout's own session start names the commands that install it (scripts/check-plugin-gap.js).",
		);
		expect(r.stdout).toContain(
			"Adopters, pin / installed: absent v1.0.0 / not installed, level v1.0.0 / v1.0.0, old v1.0.0 / v0.9.0.",
		);
	});
});

describe("unread or not applicable", () => {
	it("warns, exit 0, where this clone lacks the source, naming the fetch", () => {
		buildCore({
			lagDays: 1,
			message: () => `Release v1.0.0, rendered from ${"a".repeat(40)}`,
		});
		const r = run();
		expect(r.status).toBe(0);
		const env = JSON.parse(r.stdout);
		expect(env.outcome).toBe("WARN");
		expect(env.findings[0].message).toContain("aaaaaaaaa is not in this clone");
		expect(env.findings[0].message).toContain("`git fetch origin`");
	});

	it("SKIPs, exit 0, outside workflow-core itself", () => {
		buildCore({ lagDays: 1 });
		fs.writeFileSync(
			path.join(repo, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "other" }),
		);
		const r = run();
		expect(r.status).toBe(0);
		const env = JSON.parse(r.stdout);
		expect(env.outcome).toBe("SKIP");
		expect(env.summary).toContain("an adopter cuts no release");
	});

	it("SKIPs, exit 0, with no origin/main, naming the fetch", () => {
		buildCore({ lagDays: 1 });
		git(["update-ref", "-d", "refs/remotes/origin/main"]);
		const r = run();
		expect(r.status).toBe(0);
		const env = JSON.parse(r.stdout);
		expect(env.outcome).toBe("SKIP");
		expect(env.summary).toContain("no origin/main in this clone");
		expect(env.summary).toContain("`git fetch origin`");
	});
});
