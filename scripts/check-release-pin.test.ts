// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	defineTemplate,
	identityRepoTemplate,
	mkScratchDir,
} from "./lib/git-fixture";
import { runInProcess } from "./lib/run-in-process";

const SCRIPT = path.resolve(__dirname, "check-release-pin.js");

let dir: string;
let repo: string;
let remote: string;

const git = (at: string, ...args: string[]) =>
	execFileSync("git", args, { cwd: at, encoding: "utf8" }).trim();

const writePlugin = (version: string, name = "demo") =>
	fs.writeFileSync(
		path.join(repo, ".claude-plugin", "plugin.json"),
		JSON.stringify({ name, version }),
	);

const writeMarketplace = (
	entry: Record<string, unknown> | null,
	name = "demo",
) =>
	fs.writeFileSync(
		path.join(repo, ".claude-plugin", "marketplace.json"),
		JSON.stringify({
			name: "demo-market",
			plugins: entry === null ? [] : [{ name, source: entry }],
		}),
	);

const urlSource = (ref: string) => ({
	source: "url",
	url: `file://${remote}`,
	ref,
});

let envOverride: Record<string, string> = {};

const check = (...args: string[]) => {
	const env = {
		...process.env,
		GITHUB_ACTIONS: "false",
		CLAUDE_PROJECT_DIR: repo,
		...envOverride,
	};
	const r = runInProcess(SCRIPT, args, { cwd: repo, env });
	return {
		status: r.status,
		out: `${r.stdout}${r.stderr}`,
		tags: () => {
			const j = runInProcess(SCRIPT, [...args, "--json"], { cwd: repo, env });
			return (JSON.parse(j.stdout).findings ?? []).map(
				(f: { tag: string }) => f.tag,
			);
		},
		messages: () => {
			const j = runInProcess(SCRIPT, [...args, "--json"], { cwd: repo, env });
			return (JSON.parse(j.stdout).findings ?? []).map(
				(f: { message: string }) => f.message,
			);
		},
	};
};

const repoAndRemote = defineTemplate((at) => {
	const atRepo = path.join(at, "repo");
	const atRemote = path.join(at, "remote");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", atRemote]);
	fs.mkdirSync(path.join(atRepo, ".claude-plugin"), { recursive: true });
	identityRepoTemplate(atRepo);
	git(atRepo, "config", "core.hooksPath", path.join(at, "no-hooks"));
	git(atRepo, "remote", "add", "origin", atRemote);
});

beforeEach(() => {
	dir = repoAndRemote.instantiate(mkScratchDir("release-pin-test-"));
	repo = path.join(dir, "repo");
	remote = path.join(dir, "remote");

	writePlugin("1.2.3");
	writeMarketplace(urlSource("v1.2.3"));
	git(repo, "add", "-A");
	git(repo, "commit", "-qm", "init");
	git(repo, "push", "-q", "origin", "main");
});

afterEach(() => {
	envOverride = {};
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("check-release-pin", () => {
	it("passes when the pinned tag is on the remote, naming tag and remote", () => {
		git(repo, "tag", "v1.2.3");
		git(repo, "push", "-q", "origin", "v1.2.3");
		const out = check().out;
		expect(out).toContain("OK");
		expect(out).toContain("v1.2.3");
		expect(out).toContain("origin");
	});

	it("fails TAG-UNPUSHED when the tag exists locally but not on the remote, offering git push origin <tag> as the way out", () => {
		git(repo, "tag", "v1.2.3");
		const r = check();
		expect(r.status).toBe(1);
		expect(r.tags()).toEqual(["TAG-UNPUSHED"]);
		expect(r.out).toContain("git push origin v1.2.3");
	});

	it("fails TAG-UNCUT when the tag exists nowhere, and names the release command", () => {
		const r = check();
		expect(r.status).toBe(1);
		expect(r.tags()).toEqual(["TAG-UNCUT"]);
		expect(r.out).toContain("release-plugin.js");
	});

	it("fails TAG-UNRESOLVED, not TAG-UNPUSHED, under GITHUB_ACTIONS even when the tag exists locally, naming both ways out: the push and release-plugin.js", () => {
		git(repo, "tag", "v1.2.3");
		envOverride = { GITHUB_ACTIONS: "true" };
		const r = check();
		expect(r.status).toBe(1);
		expect(r.tags()).toEqual(["TAG-UNRESOLVED"]);
		expect(r.out).toContain("git push origin v1.2.3");
		expect(r.out).toContain("release-plugin.js");
	});

	it("fails TAG-UNRESOLVED, not TAG-UNCUT, under GITHUB_ACTIONS when the tag exists nowhere, naming both ways out: the push and release-plugin.js", () => {
		envOverride = { GITHUB_ACTIONS: "true" };
		const r = check();
		expect(r.status).toBe(1);
		expect(r.tags()).toEqual(["TAG-UNRESOLVED"]);
		expect(r.out).toContain("git push origin v1.2.3");
		expect(r.out).toContain("release-plugin.js");
	});

	describe("#4675: a bump whose tag is not yet cut, on the sweep", () => {
		const Now = Date.parse("2026-11-08T12:00:00Z");

		const commitAt = (msg: string, hours: number) => {
			const date = `${Math.floor(Now / 1000 - hours * 3600)} +0000`;
			execFileSync("git", ["commit", "-qam", msg, "--date", date], {
				cwd: repo,
				env: { ...process.env, GIT_COMMITTER_DATE: date },
			});
		};

		const bump = (hours: number) => {
			writePlugin("1.2.3");
			writeMarketplace(urlSource("v1.2.3"));
			commitAt("bump", hours);
		};

		beforeEach(() => {
			writePlugin("1.2.2");
			writeMarketplace(urlSource("v1.2.2"));
			commitAt("release 1.2.2", 100);
			git(repo, "tag", "v1.2.2");
			git(repo, "push", "-q", "origin", "v1.2.2");
			envOverride = {
				GITHUB_ACTIONS: "true",
				WFC_NOW: new Date(Now).toISOString(),
			};
		});

		it("skips as pending, naming when the cut falls due and both ways out", () => {
			bump(1);
			const r = check("--require-remote");
			expect(r.status).toBe(0);
			expect(r.out).toContain("v1.2.3 is a bump whose release is pending");
			expect(r.out).toContain("falls due within 23h");
			expect(r.out).toContain("git push origin v1.2.3");
			expect(r.out).toContain("release-plugin.js");
		});

		it("fails TAG-UNRESOLVED once the bump was committed 24h ago or more", () => {
			bump(24);
			const r = check("--require-remote");
			expect(r.status).toBe(1);
			expect(r.tags()).toEqual(["TAG-UNRESOLVED"]);
			expect(r.out).toContain("git push origin v1.2.3");
			expect(r.out).not.toContain("pending");
		});

		it("dates the bump from its own commit, not a later commit over it", () => {
			bump(25);
			fs.writeFileSync(path.join(repo, "later.txt"), "x");
			git(repo, "add", "later.txt");
			commitAt("later", 1);
			const r = check("--require-remote");
			expect(r.status).toBe(1);
			expect(r.tags()).toEqual(["TAG-UNRESOLVED"]);
			expect(r.out).toContain("git push origin v1.2.3");
			expect(r.out).toContain("release-plugin.js");
		});

		it("dates the bump from its own commit, not a later reformat of the pin line", () => {
			bump(25);
			const at = path.join(repo, ".claude-plugin", "marketplace.json");
			fs.writeFileSync(
				at,
				JSON.stringify(JSON.parse(fs.readFileSync(at, "utf8")), null, "\t"),
			);
			commitAt("reformat", 1);
			const r = check("--require-remote");
			expect(r.status).toBe(1);
			expect(r.tags()).toEqual(["TAG-UNRESOLVED"]);
			expect(r.out).toContain("git push origin v1.2.3");
			expect(r.out).toContain("release-plugin.js");
		});

		it("fails TAG-UNRESOLVED on a fresh pin that is not ahead of the newest cut tag", () => {
			git(repo, "tag", "v1.3.0");
			git(repo, "push", "-q", "origin", "v1.3.0");
			bump(1);
			const r = check("--require-remote");
			expect(r.status).toBe(1);
			expect(r.tags()).toEqual(["TAG-UNRESOLVED"]);
			expect(r.out).not.toContain("pending");
			expect(r.out).toContain("git push origin v1.2.3");
			expect(r.out).toContain("release-plugin.js");
		});

		it("fails TAG-UNRESOLVED in a shallow clone, which cannot date the bump", () => {
			bump(1);
			const shallow = path.join(dir, "shallow");
			git(dir, "clone", "-q", "--depth", "1", `file://${repo}`, shallow);
			repo = shallow;
			const r = check("--require-remote");
			expect(r.status).toBe(1);
			expect(r.tags()).toEqual(["TAG-UNRESOLVED"]);
			expect(r.out).toContain(`git push file://${remote} v1.2.3`);
			expect(r.out).toContain("release-plugin.js");
		});

		it("fails TAG-UNPUSHED at once where the tag was cut here, naming the push", () => {
			envOverride = { WFC_NOW: new Date(Now).toISOString() };
			bump(1);
			git(repo, "tag", "v1.2.3");
			const r = check("--require-remote");
			expect(r.status).toBe(1);
			expect(r.tags()).toEqual(["TAG-UNPUSHED"]);
			expect(r.out).toContain("git push origin v1.2.3");
		});

		it("fails TAG-UNCUT at once on a local run, which can cut", () => {
			envOverride = { WFC_NOW: new Date(Now).toISOString() };
			bump(1);
			const r = check();
			expect(r.status).toBe(1);
			expect(r.tags()).toEqual(["TAG-UNCUT"]);
			expect(r.out).toContain("release-plugin.js");
		});
	});

	it("fails PIN-MISMATCH when the ref and plugin.json disagree, naming both versions", () => {
		writeMarketplace(urlSource("v1.2.2"));
		git(repo, "tag", "v1.2.2");
		git(repo, "push", "-q", "origin", "v1.2.2");
		const r = check();
		expect(r.status).toBe(1);
		expect(r.tags()).toEqual(["PIN-MISMATCH"]);
		expect(r.out).toContain("v1.2.2");
		expect(r.out).toContain("1.2.3");
	});

	it("fails NO-ENTRY when the marketplace lists no entry for the plugin", () => {
		writeMarketplace(null);
		const r = check();
		expect(r.status).toBe(1);
		expect(r.tags()).toEqual(["NO-ENTRY"]);
		expect(r.out).toContain("demo");
	});

	it("skips rather than failing when the remote cannot be reached", () => {
		git(repo, "tag", "v1.2.3");
		const r = check("--remote", path.join(dir, "absent"));
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP");
		expect(r.out).toContain("proves nothing");
		expect(r.tags()).toEqual([]);
	});

	it("fails REMOTE-UNREACHABLE under --require-remote, naming persist-credentials and source.url as what to check", () => {
		git(repo, "tag", "v1.2.3");
		const r = check("--remote", path.join(dir, "absent"), "--require-remote");
		expect(r.status).toBe(1);
		expect(r.tags()).toEqual(["REMOTE-UNREACHABLE"]);
		expect(r.out).toContain("persist-credentials");
		expect(r.out).toContain("source.url");
		expect(r.messages()[0]).toContain("is published");
	});

	it("fails REMOTE-UNREACHABLE under --require-remote on a branch-pinned entry, saying the newest cut tag could not be found", () => {
		writeMarketplace({ source: "url", url: `file://${remote}`, ref: "main" });
		const r = check("--remote", path.join(dir, "absent"), "--require-remote");
		expect(r.status).toBe(1);
		expect(r.tags()).toEqual(["REMOTE-UNREACHABLE"]);
		expect(r.messages()[0]).toContain("newest cut tag");
	});

	it("does not gate on an unreachable remote under --require-remote --warn", () => {
		git(repo, "tag", "v1.2.3");
		const r = check(
			"--remote",
			path.join(dir, "absent"),
			"--require-remote",
			"--warn",
		);
		expect(r.status).toBe(0);
		expect(r.tags()).toEqual(["REMOTE-UNREACHABLE"]);
		expect(r.out).toContain("could not be reached");
	});

	it("is BROKEN when git cannot be run at all", () => {
		fs.mkdirSync(path.join(dir, "empty-path"));
		envOverride = { PATH: path.join(dir, "empty-path") };
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot list this repo's remotes");
	});

	it("--warn reports the fault without gating", () => {
		const r = check("--warn");
		expect(r.status).toBe(0);
		expect(r.out).toContain("never cut");
	});

	it("skips where the repo has no .claude-plugin files", () => {
		fs.rmSync(path.join(repo, ".claude-plugin"), { recursive: true });
		const out = check().out;
		expect(out).toContain("SKIP");
		expect(out).toContain("publishes no plugin");
	});

	it("skips a pin that names a branch rather than a release tag, when the version is not ahead", () => {
		git(repo, "tag", "v1.2.3");
		git(repo, "push", "-q", "origin", "v1.2.3");
		writeMarketplace({ source: "url", url: `file://${remote}`, ref: "main" });
		const out = check().out;
		expect(out).toContain("SKIP");
		expect(out).toContain("not a release tag");
	});

	it("fails VERSION-AHEAD when a branch-pinned plugin.json is ahead of every cut tag, naming both versions and offering a ref repoint or release-plugin.js, never a tag push", () => {
		git(repo, "tag", "v1.2.2");
		git(repo, "push", "-q", "origin", "v1.2.2");
		writeMarketplace({ source: "url", url: `file://${remote}`, ref: "main" });
		const r = check();
		expect(r.status).toBe(1);
		expect(r.tags()).toEqual(["VERSION-AHEAD"]);
		expect(r.out).toContain("1.2.3");
		expect(r.out).toContain("v1.2.2");
		expect(r.out).toContain("point the ref at v1.2.3");
		expect(r.out).toContain("release-plugin.js");
		expect(r.out).not.toContain("git push origin v1.2.3");
	});

	it("fails VERSION-AHEAD when a SHA-pinned plugin.json is ahead of every cut tag, naming both versions", () => {
		git(repo, "tag", "v1.2.2");
		git(repo, "push", "-q", "origin", "v1.2.2");
		const sha = git(repo, "rev-parse", "HEAD");
		writeMarketplace({ source: "url", url: `file://${remote}`, ref: sha });
		const r = check();
		expect(r.status).toBe(1);
		expect(r.tags()).toEqual(["VERSION-AHEAD"]);
		expect(r.out).toContain("1.2.3");
		expect(r.out).toContain("v1.2.2");
	});

	it("fails VERSION-AHEAD with a push remedy when the ahead-of tag was already cut here", () => {
		git(repo, "tag", "v1.2.2");
		git(repo, "push", "-q", "origin", "v1.2.2");
		writeMarketplace({ source: "url", url: `file://${remote}`, ref: "main" });
		git(repo, "tag", "v1.2.3");
		const r = check();
		expect(r.status).toBe(1);
		expect(r.tags()).toEqual(["VERSION-AHEAD"]);
		expect(r.out).toContain("git push origin v1.2.3");
	});

	it("fails VERSION-AHEAD with both remedies under GITHUB_ACTIONS", () => {
		git(repo, "tag", "v1.2.2");
		git(repo, "push", "-q", "origin", "v1.2.2");
		writeMarketplace({ source: "url", url: `file://${remote}`, ref: "main" });
		envOverride = { GITHUB_ACTIONS: "true" };
		const r = check();
		expect(r.status).toBe(1);
		expect(r.tags()).toEqual(["VERSION-AHEAD"]);
		expect(r.out).toContain("git push origin v1.2.3");
		expect(r.out).toContain("point the ref at v1.2.3");
		expect(r.out).toContain("release-plugin.js");
	});

	it("selects the numerically newest of several cut tags, not the lexically last", () => {
		for (const t of ["v1.2.9", "v1.2.10", "v1.1.0"]) {
			git(repo, "tag", t);
			git(repo, "push", "-q", "origin", t);
		}
		writePlugin("1.2.10");
		writeMarketplace({ source: "url", url: `file://${remote}`, ref: "main" });
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "bump");
		const r = check();
		expect(r.status).toBe(0);
		expect(r.tags()).toEqual([]);
	});

	it("fails VERSION-AHEAD naming the true newest of several cut tags", () => {
		for (const t of ["v1.2.9", "v1.2.10", "v1.1.0"]) {
			git(repo, "tag", t);
			git(repo, "push", "-q", "origin", t);
		}
		writePlugin("1.2.11");
		writeMarketplace({ source: "url", url: `file://${remote}`, ref: "main" });
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "bump");
		const r = check();
		expect(r.status).toBe(1);
		expect(r.tags()).toEqual(["VERSION-AHEAD"]);
		expect(r.out).toContain("v1.2.10");
	});

	it("skips rather than VERSION-AHEAD when a branch-pinned plugin.json is behind the newest cut tag", () => {
		git(repo, "tag", "v1.2.3");
		git(repo, "push", "-q", "origin", "v1.2.3");
		writePlugin("1.2.0");
		writeMarketplace({ source: "url", url: `file://${remote}`, ref: "main" });
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "downgrade");
		const r = check();
		expect(r.status).toBe(0);
		expect(r.tags()).toEqual([]);
		expect(r.out).toContain("SKIP");
	});

	it("is BROKEN when a branch-pinned plugin.json's version is not X.Y.Z", () => {
		git(repo, "tag", "v1.2.2");
		git(repo, "push", "-q", "origin", "v1.2.2");
		writePlugin("1.3.0-rc.1");
		writeMarketplace({ source: "url", url: `file://${remote}`, ref: "main" });
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "prerelease");
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("not X.Y.Z");
	});

	it("skips a branch-pinned entry when the remote cannot be reached to find the newest cut tag", () => {
		writeMarketplace({ source: "url", url: `file://${remote}`, ref: "main" });
		const r = check("--remote", path.join(dir, "absent"));
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP");
		expect(r.tags()).toEqual([]);
	});

	it("skips, not VERSION-AHEAD, when a branch-pinned plugin.json matches the newest cut tag", () => {
		git(repo, "tag", "v1.2.3");
		git(repo, "push", "-q", "origin", "v1.2.3");
		writeMarketplace({ source: "url", url: `file://${remote}`, ref: "main" });
		const r = check();
		expect(r.status).toBe(0);
		expect(r.tags()).toEqual([]);
		expect(r.out).toContain("SKIP");
	});

	it("skips a branch-pinned entry when the remote has cut no release tag yet", () => {
		writeMarketplace({ source: "url", url: `file://${remote}`, ref: "main" });
		const out = check().out;
		expect(out).toContain("SKIP");
		expect(out).toContain("not a release tag");
	});

	it("skips a directory-sourced plugin, which pins no tag", () => {
		writeMarketplace({ source: "directory", path: "." });
		const out = check().out;
		expect(out).toContain("SKIP");
		expect(out).toContain("rather than a URL");
	});

	it("is BROKEN when marketplace.json will not parse", () => {
		fs.writeFileSync(
			path.join(repo, ".claude-plugin", "marketplace.json"),
			"{ not json",
		);
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("marketplace.json");
	});

	it("matches the marketplace URL to a configured remote despite a .git suffix", () => {
		writeMarketplace({
			source: "url",
			url: `file://${remote}.git`,
			ref: "v1.2.3",
		});
		git(repo, "tag", "v1.2.3");
		const r = check();
		expect(r.out).toContain("not on origin");
	});
});

describe("--pin-only (#4002)", () => {
	it("adds --pin-only on a push run alone", () => {
		const step = fs
			.readFileSync(
				path.resolve(__dirname, "../.github/workflows/document-guards.yml"),
				"utf8",
			)
			.split("\n")
			.find((l) => l.includes("run: node scripts/check-release-pin.js"));
		expect(step).toContain("github.event_name == 'push' && '--pin-only' || ''");
	});

	it("passes a pin whose tag is on no remote, under --require-remote", () => {
		const r = check("--pin-only", "--require-remote");
		expect(r.status).toBe(0);
		expect(r.tags()).toEqual([]);
		expect(r.out).toContain("pins v1.2.3, matching plugin.json");
	});

	it("never reaches the remote", () => {
		const r = check(
			"--pin-only",
			"--require-remote",
			"--remote",
			path.join(dir, "absent"),
		);
		expect(r.status).toBe(0);
		expect(r.tags()).toEqual([]);
	});

	it("still fails PIN-MISMATCH", () => {
		writePlugin("1.2.4");
		const r = check("--pin-only");
		expect(r.status).toBe(1);
		expect(r.tags()).toEqual(["PIN-MISMATCH"]);
	});

	it("still fails NO-ENTRY", () => {
		writeMarketplace(null);
		const r = check("--pin-only");
		expect(r.status).toBe(1);
		expect(r.tags()).toEqual(["NO-ENTRY"]);
	});

	it("skips a branch pin, whose only question needs the remote", () => {
		writeMarketplace(urlSource("main"));
		const r = check("--pin-only", "--remote", path.join(dir, "absent"));
		expect(r.status).toBe(0);
		expect(r.out).toContain("which only the remote can judge");
	});
});

describe("the sweep step's --require-remote flag", () => {
	const root = path.resolve(__dirname, "..");
	const read = (at: string) => fs.readFileSync(path.join(root, at), "utf8");

	it("is spelled on the step that runs this checker", () => {
		const step = read(".github/workflows/document-guards.yml")
			.split("\n")
			.filter((l) => !l.trimStart().startsWith("#"))
			.find((l) => l.includes("check-release-pin.js"));
		expect(step).toBeDefined();
		expect(step).toContain("--require-remote");
	});

	it("is the spelling the checker reads", () => {
		expect(read("scripts/check-release-pin.js")).toContain(
			'ctx.has("--require-remote")',
		);
	});
});
