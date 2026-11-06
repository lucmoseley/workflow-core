// @vitest-environment node
/*
 * The check-release-lag.js program (#4448) over a throwaway clone and $HOME.
 * Loosened, the lag reads from the tag rather than its source and counts all
 * of main's history, or a lag past the threshold stays silent at SessionStart.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "check-release-lag.js");
const DAY = 86_400;
const T0 = 1_790_000_000;

let dir: string;
let repo: string;
let home: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-lag-"));
	repo = path.join(dir, "repo");
	home = path.join(dir, "home");
	fs.mkdirSync(repo);
	fs.mkdirSync(home);
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function git(args: string[], at = 0): string {
	const date = `@${T0 + at} +0000`;
	return execFileSync("git", args, {
		cwd: repo,
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
}

function commit(at: number): string {
	git(["commit", "-q", "--allow-empty", "-m", `c${at}`], at);
	return git(["rev-parse", "HEAD"]);
}

/** A core clone: main's source at day 0, a release rendered from it, and
 * `ahead` more commits on origin/main, the last at `lagDays`. */
function buildCore({
	lagDays,
	ahead = 3,
	message,
}: {
	lagDays: number;
	ahead?: number;
	message?: (source: string) => string;
}) {
	git(["init", "-q", "-b", "main"]);
	fs.mkdirSync(path.join(repo, ".claude-plugin"));
	fs.writeFileSync(
		path.join(repo, ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: "workflow-core" }),
	);
	git(["add", "."]);
	git(["commit", "-q", "-m", "init"], 0);
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
}

function addAdopter(name: string, ref: string | null) {
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
}

function run(args: string[] = ["--json"]) {
	return runInProcess(SCRIPT, args, {
		env: {
			...process.env,
			GITHUB_ACTIONS: "",
			WFC_REPO_ROOT: repo,
			HOME: home,
		},
	});
}

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
		expect(env.summary).toContain("v0.9.0 ×1, v1.0.0 ×2");
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
		expect(r.stdout).toContain("no pin ×1, v1.0.0 ×1");
	});
});

describe("unread or not applicable", () => {
	it("warns where the tag names no source", () => {
		buildCore({ lagDays: 1, message: () => "Release v1.0.0" });
		const env = JSON.parse(run().stdout);
		expect(env.outcome).toBe("WARN");
		expect(env.findings[0].message).toContain("names no rendered-from source");
	});

	it("SKIPs outside workflow-core itself", () => {
		buildCore({ lagDays: 1 });
		fs.writeFileSync(
			path.join(repo, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "other" }),
		);
		expect(JSON.parse(run().stdout).outcome).toBe("SKIP");
	});

	it("SKIPs with no origin/main", () => {
		buildCore({ lagDays: 1 });
		git(["update-ref", "-d", "refs/remotes/origin/main"]);
		expect(JSON.parse(run().stdout).outcome).toBe("SKIP");
	});
});
