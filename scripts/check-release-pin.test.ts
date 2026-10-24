// @vitest-environment node
/*
 * Pins that check-release-pin.js finds the tag marketplace.json pins on the
 * remote, telling a tag never cut from one cut and never pushed (#257), and
 * flags a branch- or SHA-pinned version already ahead of every cut tag (#261).
 *
 * check-release-pin.js reads two JSON files and asks a git remote one question,
 * so the fixture is a working repo plus a bare repo standing in for `origin`.
 * A bare repo is a real remote to `git ls-remote` — no network, and the
 * unpushed/uncut distinction the checker turns on is exactly what pushing a tag
 * to it does or does not create.
 *
 * It runs in `npm run status` and, with --require-remote, in roadmap-digest.yml:
 * loosen a case and adopters silently stay on an old release because the pin
 * names a tag they cannot fetch.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkScratchDir } from "./lib/git-fixture";
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

/** The marketplace source shape this repo publishes: a URL plus a tag ref. */
const urlSource = (ref: string) => ({
	source: "url",
	url: `file://${remote}`,
	ref,
});

/** Applied on top of the environment every `check` call runs under. */
let envOverride: Record<string, string> = {};

/*
 * Sequential, never concurrent: scripts/lib/run-in-process.js patches the
 * process globally for the duration of a call.
 */
const check = (...args: string[]) => {
	/* GITHUB_ACTIONS is pinned off rather than inherited: the checker reads it
	 * to decide whether local tags can be trusted (#264), so a runner's own
	 * value leaks into the fixture and sends every case that does not set it
	 * down the untrusted branch — green here, red in CI (#274). A case wanting
	 * that branch sets the variable through envOverride. */
	const env = {
		...process.env,
		GITHUB_ACTIONS: "false",
		CLAUDE_PROJECT_DIR: repo,
		...envOverride,
	};
	const r = runInProcess(SCRIPT, args, { cwd: repo, env });
	// Both streams: check.js puts the human report on stderr and reserves stdout
	// for machine readers, so reading one alone asserts against an empty string.
	return {
		status: r.status,
		out: `${r.stdout}${r.stderr}`,
		/*
		 * The finding TAGS this run raised. They are the checker's stable
		 * identities and appear only in the --json envelope, the human report
		 * carrying prose and a noun instead — so a case asserting on one re-runs
		 * under --json rather than grepping the report for a word that is not
		 * there.
		 */
		tags: () => {
			const j = runInProcess(SCRIPT, [...args, "--json"], { cwd: repo, env });
			return (JSON.parse(j.stdout).findings ?? []).map(
				(f: { tag: string }) => f.tag,
			);
		},
		/*
		 * The finding MESSAGES, which the human report never carries — it prints
		 * say()'s prose and a noun instead. Where two call sites raise the same
		 * tag through one helper, this is the only thing that tells them apart,
		 * so a route's message is pinned here or by nothing.
		 */
		messages: () => {
			const j = runInProcess(SCRIPT, [...args, "--json"], { cwd: repo, env });
			return (JSON.parse(j.stdout).findings ?? []).map(
				(f: { message: string }) => f.message,
			);
		},
	};
};

beforeEach(() => {
	dir = mkScratchDir("release-pin-test-");
	repo = path.join(dir, "repo");
	remote = path.join(dir, "remote");

	execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);

	fs.mkdirSync(path.join(repo, ".claude-plugin"), { recursive: true });
	git(dir, "init", "-q", "-b", "main", repo);
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "user.name", "test");
	// No hooks: this checkout's core.hooksPath is absolute, so a scratch repo
	// would otherwise run the real Husky stack on its fixture commit.
	git(repo, "config", "core.hooksPath", path.join(dir, "no-hooks"));
	git(repo, "remote", "add", "origin", remote);

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

	/* #257's actual failure: cut locally, never pushed. A local-only check reads
	 * this as healthy, which is why the remote is the subject. */
	it("fails TAG-UNPUSHED when the tag exists locally but not on the remote, offering git push origin <tag> as the way out", () => {
		git(repo, "tag", "v1.2.3");
		const r = check();
		expect(r.status).toBe(1);
		expect(r.tags()).toEqual(["TAG-UNPUSHED"]);
		// the refusal has to carry the way out
		expect(r.out).toContain("git push origin v1.2.3");
	});

	it("fails TAG-UNCUT when the tag exists nowhere, and names the release command", () => {
		const r = check();
		expect(r.status).toBe(1);
		expect(r.tags()).toEqual(["TAG-UNCUT"]);
		expect(r.out).toContain("release-plugin.js");
	});

	/* #264: a runner's local tags are populated FROM the remote it just fetched,
	 * so `hasLocalTag` can never separate cut-not-pushed from never-cut there. */
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

	it("fails PIN-MISMATCH when the ref and plugin.json disagree, naming both versions", () => {
		writeMarketplace(urlSource("v1.2.2"));
		git(repo, "tag", "v1.2.2");
		git(repo, "push", "-q", "origin", "v1.2.2");
		const r = check();
		expect(r.status).toBe(1);
		expect(r.tags()).toEqual(["PIN-MISMATCH"]);
		// both sides quoted, or the reader cannot tell which file to move
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

	/* An unreachable remote leaves the checker with no answer about its SUBJECT,
	 * which lib/check.js's alphabet sends to SKIP rather than a gate. The local
	 * tag is deliberately not offered as a consolation reading. */
	it("skips rather than failing when the remote cannot be reached", () => {
		git(repo, "tag", "v1.2.3");
		const r = check("--remote", path.join(dir, "absent"));
		expect(r.status).toBe(0);
		expect(r.out).toContain("SKIP");
		expect(r.out).toContain("proves nothing");
		expect(r.tags()).toEqual([]);
	});

	/* The sweep's caller-side escalation (#263): there a SKIP leaves the job
	 * green with nothing printed anywhere a session reads, so the flag says the
	 * reach itself was the subject. Paired with the case above, which fixes the
	 * default the other callers keep. */
	it("fails REMOTE-UNREACHABLE under --require-remote, naming persist-credentials and source.url as what to check", () => {
		git(repo, "tag", "v1.2.3");
		const r = check("--remote", path.join(dir, "absent"), "--require-remote");
		expect(r.status).toBe(1);
		expect(r.tags()).toEqual(["REMOTE-UNREACHABLE"]);
		// the two things that carry the reach on a runner, so the reader knows
		// what to look at before calling it an outage
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

	/* --warn is a caller-side CAP over a caller-side escalation: the finding is
	 * still raised, and still prints, but no longer gates. */
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

	/* Git itself missing is this checker's own reading APPARATUS failing, not
	 * its subject, so it is BROKEN where an unreachable remote is a SKIP. */
	it("is BROKEN when git cannot be run at all", () => {
		// An empty PATH is the only honest way to stage this: the checker resolves
		// git through the environment.
		fs.mkdirSync(path.join(dir, "empty-path"));
		envOverride = { PATH: path.join(dir, "empty-path") };
		const r = check();
		expect(r.status).toBe(2);
		expect(r.out).toContain("cannot list this repo's remotes");
	});

	/* --warn is a caller-side cap, so a real fault still prints and stops
	 * gating. The pre-commit stack is not this checker's home, but `npm run
	 * status` and a hand run both reach the flag. */
	it("--warn reports the fault without gating", () => {
		const r = check("--warn");
		expect(r.status).toBe(0);
		expect(r.out).toContain("never cut");
	});

	/* This script ships into every adopter, and an adopter publishes no
	 * marketplace of its own. */
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

	/* No local v1.2.3 tag exists yet, so the remedy cannot be "push it" —
	 * release-plugin.js refuses to cut until the ref itself points at v1.2.3. */
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

	/* #264: under GITHUB_ACTIONS the VERSION-AHEAD remedy cannot trust a local
	 * "no tag" reading either, so it offers both moves rather than only the cut
	 * command a tag already cut locally would make release-plugin.js refuse. */
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

	/* The comparator has to pick the newest among several candidates, not just
	 * notice one — numeric ordering, not lexical (`v1.2.9` sorts after
	 * `v1.2.10` lexically but not numerically). */
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

	/* The URL and the configured remote are the same repository spelled two
	 * ways in the real repo (https vs the remote name). Resolving the URL to a
	 * remote NAME is what lets a private repo authenticate at all, so the
	 * matching has to survive a `.git` suffix the other side lacks. */
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

/*
 * The flag is a string agreed between two files and nothing else: the sweep
 * step spells it, the checker reads it through ctx.has(), and positionals()
 * drops an unrecognised `--` argument without a word. So a one-character drift
 * in the YAML — or a rename here — silently restores exit 0 on an unreachable
 * remote, which is the whole harm #263 closed.
 */
describe("the sweep step's --require-remote flag", () => {
	const root = path.resolve(__dirname, "..");
	const read = (at: string) => fs.readFileSync(path.join(root, at), "utf8");

	it("is spelled on the step that runs this checker", () => {
		const step = read(".github/workflows/roadmap-digest.yml")
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
