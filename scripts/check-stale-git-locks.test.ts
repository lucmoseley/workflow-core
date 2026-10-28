// @vitest-environment node
/*
 * Pins that check-stale-git-locks.js names a git lock that has outlived any git
 * that could hold it, with its recovery, leaves it on disk, and stays quiet on
 * a young lock and on refs/arbiter/.
 *
 * Built for #1193. Every case runs against a scratch repo through
 * CLAUDE_PROJECT_DIR: a run against the founder's would read, and a bug could
 * remove, a live git's lock.
 *
 * It reports through `npm run status`: loosen a case and a lock a killed git
 * left blocks git work in silence, or a live git's lock is named for removal.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const SCRIPT = path.join(__dirname, "check-stale-git-locks.js");
const STATUS = path.join(__dirname, "status-report.js");
const HOUR = 60 * 60 * 1000;

let repo: string;
beforeEach(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "git-locks-"));
	execFileSync("git", ["init", "-q"], { cwd: repo });
});
afterEach(() => {
	fs.rmSync(repo, { recursive: true, force: true });
});

const lock = (rel: string, ageMs: number) => {
	const at = path.join(repo, ".git", rel);
	fs.mkdirSync(path.dirname(at), { recursive: true });
	fs.writeFileSync(at, "");
	const t = (Date.now() - ageMs) / 1000;
	fs.utimesSync(at, t, t);
	return at;
};

const env = () => ({
	...process.env,
	CLAUDE_PROJECT_DIR: repo,
	GITHUB_ACTIONS: "",
});
const run = (args: string[] = []) =>
	runInProcess(SCRIPT, args, { cwd: repo, env: env() });

describe("stale git locks (#1193)", () => {
	it("names a stale logs/HEAD.lock with its recovery, and leaves it on disk", () => {
		const at = lock("logs/HEAD.lock", 2 * HOUR);
		const r = run();
		expect(r.status).toBe(0); // WARN: a report, never a gate
		expect(r.stderr).toContain("STALE-GIT-LOCK");
		expect(r.stderr).toContain("logs/HEAD.lock");
		expect(r.stderr).toContain("pgrep -a git");
		expect(fs.existsSync(at)).toBe(true);
	});

	it("is quiet on a young lock, which a live git may hold", () => {
		lock("index.lock", 60_000);
		const r = run(["--json"]);
		expect(r.status).toBe(0);
		expect(JSON.parse(r.stdout).findings).toEqual([]);
	});

	it("leaves refs/arbiter/ to the arbiter's own sweep", () => {
		lock("refs/arbiter/some-claim.lock", 2 * HOUR);
		lock("objects/info/commit-graph.lock", 2 * HOUR);
		lock("objects/pack/multi-pack-index.lock", 2 * HOUR);
		const r = run(["--json"]);
		expect(r.status).toBe(0);
		expect(
			JSON.parse(r.stdout).findings.map((f: { path: string }) => f.path),
		).toEqual([
			"objects/info/commit-graph.lock",
			"objects/pack/multi-pack-index.lock",
		]);
	});

	it("skips outside a repository rather than calling it clean", () => {
		fs.rmSync(path.join(repo, ".git"), { recursive: true, force: true });
		const r = run();
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/^SKIP: no git repository here/m);
	});

	it("reaches the founder through npm run status", () => {
		lock("logs/HEAD.lock", 2 * HOUR);
		// spawn-kept: status-report.js's async entry has no require.main guard
		// and no exported main, so runInProcessAsync cannot load it.
		const out = execFileSync(
			process.execPath,
			[STATUS, "--only", "git-locks"],
			{ cwd: repo, env: env(), encoding: "utf8", stdio: "pipe" },
		);
		expect(out).toContain("logs/HEAD.lock");
	});
});
