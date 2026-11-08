// @vitest-environment node
/*
 * Pins that check-orphaned-edits.js names an uncommitted file no live session
 * owns, untouched for 24 hours — or at any age in a cut-over main checkout —
 * files it once for triage, and stays silent
 * where ownership cannot be read.
 *
 * The checker (#813) runs end to end, through lib/run-in-process.js, over a
 * sandbox git repository and arbiter store, with a fake `claude` on
 * WFC_CLAUDE_BIN for the liveness oracle and a fake filer on WFC_ORPHAN_FILER,
 * so no case reaches the real tracker.
 *
 * Breaking an exclusion case lets the checker file a triage issue sending a
 * session to commit or revert a live neighbour's work; breaking a filing case
 * files the same orphan at every session start.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	AS_ROOT,
	commitAll,
	freshSandbox,
	gitRepo,
	locks,
	proc,
	store,
} from "./lib/arbiter-testkit";
import { readWorktreeDirt, readWorktreeFiling } from "./lib/orphan-filings.js";
import { runInProcessAsync } from "./lib/run-in-process.js";
import { worktreeLabel } from "./lib/session-worktrees.js";
import { buildDistinctFromHint } from "./lib/similar-titles.js";

const SCRIPT = path.join(__dirname, "check-orphaned-edits.js");
const HOUR = 3_600_000;

const sb = freshSandbox((fresh) => {
	fs.mkdirSync(path.join(fresh.dir, "bin"), { recursive: true });
	fs.writeFileSync(path.join(fresh.repo, "a.txt"), "seed\n");
	fs.writeFileSync(path.join(fresh.repo, "docs", "b.md"), "seed\n");
	fs.writeFileSync(path.join(fresh.repo, "c.txt"), "seed\n");
	gitRepo(fresh);
	commitAll(fresh);
	// Never an empty list: the oracle reads `[]` as a refusal.
	fakeClaude("bystander");
	fakeFiler();
});

/** A `claude` stand-in whose `agents --json` lists `sessionIds`, all working. */
function fakeClaude(...sessionIds: string[]) {
	const body = JSON.stringify(
		sessionIds.map((sessionId, i) => ({
			pid: 100 + i,
			sessionId,
			state: "working",
		})),
	);
	const bin = path.join(sb.dir, "bin", "claude");
	fs.writeFileSync(bin, `#!/bin/sh\ncat <<'EOF'\n${body}\nEOF\n`);
	fs.chmodSync(bin, 0o755);
	vi.stubEnv("WFC_CLAUDE_BIN", bin);
}

const filerLog = () => path.join(sb.dir, "filer-calls");

/**
 * A filer stand-in: records its argv and stdin, prints an issue URL. With
 * `hint`, it refuses as file-issue.js does until --distinct-from is given.
 */
function fakeFiler(code = 0, hint = "") {
	const bin = path.join(sb.dir, "bin", "filer.js");
	fs.writeFileSync(
		bin,
		`const fs = require("node:fs");
const body = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(filerLog())}, JSON.stringify({ argv: process.argv.slice(2), body }) + "\\n");
if (${code}) { console.error("gh: offline"); process.exit(${code}); }
if (${JSON.stringify(hint)} && !process.argv.includes("--distinct-from")) { console.error(${JSON.stringify(hint)}); process.exit(2); }
console.log("https://github.com/o/r/issues/7");
`,
	);
	vi.stubEnv("WFC_ORPHAN_FILER", bin);
}

const readFilings = (): { argv: string[]; body: string }[] =>
	fs.existsSync(filerLog())
		? fs
				.readFileSync(filerLog(), "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];

/** Dirty a tracked file and back-date it `hours`. */
function dirty(rel: string, hours: number, content = "edited\n") {
	const file = path.join(sb.repo, rel);
	fs.writeFileSync(file, content);
	const at = new Date(Date.now() - hours * HOUR);
	fs.utimesSync(file, at, at);
}

/* GITHUB_ACTIONS off: check.js writes ::warning:: to stdout when it is set. */
/* A hand run by default, which exits on a fault where the hook run (`notify`)
 * stays at 0. */
const run = async (
	args: string[] = [],
	notify = false,
	env: NodeJS.ProcessEnv = {},
	write = true,
) => {
	/* --write as the hook passes it, unless `write` is false. */
	const argv = [
		...(notify ? ["--notify"] : []),
		...args,
		...(write ? ["--write"] : []),
	];
	const r = await runInProcessAsync(SCRIPT, argv, {
		env: {
			...process.env,
			...env,
			GITHUB_ACTIONS: "",
			WFC_ORACLE_CACHE: "0",
			CLAUDE_PROJECT_DIR: sb.repo,
		},
		cwd: sb.repo,
	});
	return { ...r, out: r.stdout + r.stderr };
};

describe("check-orphaned-edits", () => {
	it("says nothing at session start when there is no orphan", async () => {
		const r = await run([], true);
		expect(r.out).toBe("");
		expect(r.status).toBe(0);
		expect(readFilings()).toEqual([]);
	});

	it("files an orphan at session start but prints nothing, the report being npm run status's (#2038)", async () => {
		dirty("a.txt", 25);
		const r = await run([], true);
		expect(r.out).toBe("");
		expect(readFilings()).toHaveLength(1);
	});

	it("files nothing without --write, and says --write files it, taking no marker (#4449)", async () => {
		dirty("a.txt", 25);
		const r = await run([], false, {}, false);
		expect(r.out).toContain("triage:  not filed: `--write` files it");
		expect(readFilings()).toEqual([]);
		expect((await run()).out).toContain(
			"triage:  https://github.com/o/r/issues/7",
		);
		expect((await run([], false, {}, false)).out).toContain(
			"triage:  already filed: https://github.com/o/r/issues/7",
		);
	});

	it("reports a file unchanged for 24 hours, and not one unchanged for less", async () => {
		dirty("a.txt", 25);
		dirty("docs/b.md", 23);

		const r = await run();

		expect(r.out).toContain("ORPHANED-EDIT (1)");
		expect(r.out).toContain("a.txt — unchanged 25h");
		expect(r.out).not.toContain("docs/b.md");
		expect(r.status).toBe(0);
	});

	it("names the path, its age, the last known writer, and the inspect, commit and revert commands", async () => {
		dirty("a.txt", 72);
		fs.mkdirSync(store.paths.writesDir(), { recursive: true });
		fs.writeFileSync(store.paths.ledger("gone-session"), "a.txt\n");

		const r = await run();

		expect(r.out).toContain("a.txt — unchanged 3d");
		expect(r.out).toContain("last known writer: session gone-session");
		expect(r.out).toContain("inspect: git diff HEAD -- a.txt");
		expect(r.out).toContain(
			'commit:  git commit -m "<why, in plain language>" -- a.txt',
		);
		expect(r.out).toContain(
			"revert:  git restore --source=HEAD --staged --worktree -- a.txt",
		);
		expect(r.out).toContain("triage:  https://github.com/o/r/issues/7");
	});

	it("says the writer is unknown where no ledger names the file", async () => {
		dirty("a.txt", 30);
		expect((await run()).out).toContain("last known writer: unknown");
	});

	describe("a live session's ownership excludes the file", () => {
		it("by a live claim", async () => {
			dirty("docs/b.md", 30);
			fs.mkdirSync(store.paths.locksDir(), { recursive: true });
			const rec = locks.newLock({
				path: "docs/b.md",
				sessionId: "holder",
				pid: process.pid,
				procStart: proc.readProcStartOf(process.pid),
			});
			const name = `${createHash("sha256").update("docs/b.md").digest("hex").slice(0, 16)}.json`;
			fs.writeFileSync(
				path.join(store.paths.locksDir(), name),
				JSON.stringify(rec),
			);

			expect((await run()).out).not.toContain("ORPHANED-EDIT");
		});

		it("by a live session's observation", async () => {
			dirty("a.txt", 30);
			fakeClaude("watcher");
			const file = store.paths.observation("a.txt", "watcher");
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				file,
				JSON.stringify({ path: "a.txt", sessionId: "watcher", obsId: "o1" }),
			);

			expect((await run()).out).not.toContain("ORPHANED-EDIT");
		});

		it("by a live session's write ledger", async () => {
			dirty("a.txt", 30);
			fakeClaude("writer");
			fs.mkdirSync(store.paths.writesDir(), { recursive: true });
			fs.writeFileSync(store.paths.ledger("writer"), "a.txt\n");

			expect((await run()).out).not.toContain("ORPHANED-EDIT");
		});

		it("but not by the ledger of a session the oracle does not list", async () => {
			dirty("a.txt", 30);
			fakeClaude("someone-else");
			fs.mkdirSync(store.paths.writesDir(), { recursive: true });
			fs.writeFileSync(store.paths.ledger("writer"), "a.txt\n");

			expect((await run()).out).toContain("ORPHANED-EDIT (1)");
		});
	});

	it("reports nothing where liveness cannot be read", async () => {
		dirty("a.txt", 30);
		const bin = path.join(sb.dir, "bin", "claude");
		fs.writeFileSync(bin, "#!/bin/sh\nexit 1\n");

		const r = await run(["--json"]);
		expect(JSON.parse(r.stdout).outcome).toBe("SKIP");
		expect(readFilings()).toEqual([]);
	});

	describe("filing", () => {
		it("files one takes:triage issue per path and blob, and nothing on a second run", async () => {
			dirty("a.txt", 30);

			await run();
			await run();

			const calls = readFilings();
			expect(calls).toHaveLength(1);
			const { argv, body } = calls[0];
			expect(argv).toContain("takes:triage");
			expect(argv).toContain("--standalone");
			expect(argv.join(" ")).toContain("Orphaned edit: a.txt");
			expect(body).toContain("git diff HEAD -- a.txt");
			expect((await run()).out).toContain(
				"triage:  already filed: https://github.com/o/r/issues/7",
			);
		});

		it("files again when the same path holds a different blob", async () => {
			dirty("a.txt", 30, "first\n");
			await run();
			dirty("a.txt", 30, "second\n");
			await run();

			expect(readFilings()).toHaveLength(2);
		});

		it("files each orphaned path on its own", async () => {
			dirty("a.txt", 30);
			dirty("docs/b.md", 30);
			await run();

			expect(readFilings()).toHaveLength(2);
		});

		it("names the titles file-issue.js lists as distinct, and files", async () => {
			dirty("a.txt", 30);
			fakeFiler(
				0,
				`Nothing filed: #3 is not yet checked. Re-run with ${buildDistinctFromHint([3, 4])}`,
			);
			await run();

			const calls = readFilings();
			expect(calls).toHaveLength(2);
			expect(calls[1].argv.slice(-2)).toEqual(["--distinct-from", "3,4"]);
			expect((await run()).out).toContain("already filed");
		});

		it("retries a filing that failed, rather than recording it", async () => {
			dirty("a.txt", 30);
			fakeFiler(1);
			expect((await run()).out).toContain(
				"filing failed, retried next run: gh: offline",
			);
			fakeFiler(0);
			await run();

			expect(readFilings()).toHaveLength(2);
			expect((await run()).out).toContain("already filed");
		});
	});

	it("files at most two a run and the rest at the next, saying so", async () => {
		dirty("a.txt", 30);
		dirty("docs/b.md", 30);
		dirty("c.txt", 30);

		expect((await run()).out).toContain("this run's filing cap is spent");
		expect(readFilings()).toHaveLength(2);
		await run();
		expect(readFilings()).toHaveLength(3);
	});

	it("starts no filing its ceiling would carry past the hook's timeout, filing it next run (#4542)", async () => {
		dirty("a.txt", 30);

		expect(
			(await run([], false, { WFC_ORPHAN_HOOK_TIMEOUT_MS: "21000" })).out,
		).toContain("not filed yet: this run's time is spent");
		expect(readFilings()).toEqual([]);

		await run();
		expect(readFilings()).toHaveLength(1);
	});

	it("budgets the timeout hooks/hooks.json gives its SessionStart run (#4542)", () => {
		const hooks = fs.readFileSync(
			path.join(__dirname, "..", "hooks", "hooks.json"),
			"utf8",
		);
		const entry = JSON.parse(hooks)
			.hooks.SessionStart.flatMap((g: { hooks: object[] }) => g.hooks)
			.find((h: { command: string }) =>
				h.command.includes("check-orphaned-edits.js"),
			);
		/* Read off the source: requiring the script would load lib/check.js's
		 * process handlers into this worker. */
		const budget = /const HOOK_TIMEOUT_MS = ([\d_]+);/.exec(
			fs.readFileSync(SCRIPT, "utf8"),
		)?.[1];
		expect(entry.timeout * 1000).toBe(Number(budget?.replaceAll("_", "")));
		/* Async (#4367): it prints nothing, so no start waits on it. */
		expect(entry.async).toBe(true);
	});

	describe("--hourly, the SessionStart run's throttle (#4367)", () => {
		/* Mid-hour, so no run here straddles a clock hour. */
		const at = (minutes: number) => ({
			WFC_NOW: new Date(
				Math.floor(Date.now() / HOUR) * HOUR + (30 + minutes) * 60_000,
			).toISOString(),
		});
		const hourly = (minutes = 0, json = false) =>
			run(["--hourly", ...(json ? ["--json"] : [])], !json, at(minutes));

		it("skips the run inside the clock hour of the last one", async () => {
			await hourly();
			dirty("a.txt", 30);

			const r = await hourly(20, true);
			expect(JSON.parse(r.stdout)).toMatchObject({ walked: false });
			expect(readFilings()).toEqual([]);
		});

		it("runs once the clock hour has passed", async () => {
			await hourly();
			dirty("a.txt", 30);

			await hourly(60);
			expect(readFilings()).toHaveLength(1);
		});

		it("lets one of two runs started together through", async () => {
			dirty("a.txt", 30);
			const child = () =>
				new Promise<string>((resolve) => {
					// spawn-kept: two processes at once, as two session starts are.
					const p = spawn(
						process.execPath,
						[SCRIPT, "--hourly", "--json", "--write"],
						{
							cwd: sb.repo,
							env: {
								...process.env,
								...at(0),
								GITHUB_ACTIONS: "",
								WFC_ORACLE_CACHE: "0",
								CLAUDE_PROJECT_DIR: sb.repo,
							},
						},
					);
					let out = "";
					p.stdout.on("data", (d) => {
						out += d;
					});
					p.on("close", () => resolve(out));
				});
			const outs = await Promise.all([child(), child()]);
			expect(outs.map((o) => JSON.parse(o).walked).sort()).toEqual([
				false,
				true,
			]);
		});

		it("never throttles a run without it", async () => {
			await hourly();
			dirty("a.txt", 30);

			await run([], false, at(0));
			expect(readFilings()).toHaveLength(1);
		});
	});

	it("leaves an interrupted filing alone rather than filing it again", async () => {
		dirty("a.txt", 30);
		await run();
		// What a filer killed mid-create leaves: its marker, empty.
		const dir = path.join(sb.repo, ".git", "orphaned-edits-filed");
		for (const f of fs.readdirSync(dir))
			fs.writeFileSync(path.join(dir, f), "");

		expect((await run()).out).toContain("filing in progress or interrupted");
		expect(readFilings()).toHaveLength(1);
	});

	it("never retries a filing whose filer died before it could say", async () => {
		dirty("a.txt", 30);
		const bin = path.join(sb.dir, "bin", "dying-filer.js");
		fs.writeFileSync(bin, 'process.kill(process.pid, "SIGKILL");\n');
		vi.stubEnv("WFC_ORPHAN_FILER", bin);
		expect((await run()).out).toContain("filing interrupted, not retried");

		fakeFiler();
		expect((await run()).out).toContain("filing in progress or interrupted");
		expect(readFilings()).toEqual([]);
	});

	it("refuses a negative --hours as a bad invocation", async () => {
		const r = await run(["--hours", "-1"], false);
		expect(r.out).toContain("--hours must be a non-negative number");
		expect(r.status).toBe(2);
	});

	describe("reports nothing where an ownership store will not read", () => {
		/* chmod binds nobody as root, so these say nothing there. */
		it.skipIf(AS_ROOT)("the lock store", async () => {
			dirty("a.txt", 30);
			fs.mkdirSync(store.paths.locksDir(), { recursive: true });
			fs.chmodSync(store.paths.locksDir(), 0o000);
			try {
				expect(JSON.parse((await run(["--json"])).stdout).outcome).toBe("SKIP");
			} finally {
				fs.chmodSync(store.paths.locksDir(), 0o755);
			}
			expect(readFilings()).toEqual([]);
		});

		it.skipIf(AS_ROOT)("the observation store", async () => {
			dirty("a.txt", 30);
			fakeClaude("watcher");
			fs.mkdirSync(store.paths.observationsDir(), { recursive: true });
			fs.chmodSync(store.paths.observationsDir(), 0o000);
			try {
				expect(JSON.parse((await run(["--json"])).stdout).outcome).toBe("SKIP");
			} finally {
				fs.chmodSync(store.paths.observationsDir(), 0o755);
			}
			expect(readFilings()).toEqual([]);
		});

		it.skipIf(AS_ROOT)("a live session's write ledger", async () => {
			dirty("a.txt", 30);
			fakeClaude("writer");
			fs.mkdirSync(store.paths.writesDir(), { recursive: true });
			fs.writeFileSync(store.paths.ledger("writer"), "docs/b.md\n");
			fs.chmodSync(store.paths.ledger("writer"), 0o000);

			expect(JSON.parse((await run(["--json"])).stdout).outcome).toBe("SKIP");
			expect(readFilings()).toEqual([]);
		});
	});

	it("never writes or reverts the orphaned file", async () => {
		dirty("a.txt", 30, "precious weekend work\n");
		const before = fs.statSync(path.join(sb.repo, "a.txt")).mtimeMs;

		await run();
		await run();

		const file = path.join(sb.repo, "a.txt");
		expect(fs.readFileSync(file, "utf8")).toBe("precious weekend work\n");
		expect(fs.statSync(file).mtimeMs).toBe(before);
	});
});

/*
 * Seam 2 (#4244, spec #4229): the host root is the main checkout and the dirt
 * sits in a linked worktree of it, owned by the session whose job record
 * names that worktree as its cwd.
 */
describe("a linked worktree's dirt", () => {
	/** A worktree of the sandbox repo, detached at HEAD, which job record
	 * `sessionId` names as its cwd; `a.txt` in it dirtied and back-dated. */
	function worktreeOf(
		sessionId: string | null,
		hours: number,
		wt = path.join(sb.repo, ".claude", "worktrees", "w1"),
	) {
		fs.mkdirSync(path.dirname(wt), { recursive: true });
		const r = spawnSync("git", ["worktree", "add", "-q", "--detach", wt], {
			cwd: sb.repo,
			encoding: "utf8",
		});
		if (r.status !== 0) throw new Error(r.stderr);
		if (sessionId) {
			const job = path.join(sb.home, "jobs", sessionId.slice(0, 8));
			fs.mkdirSync(job, { recursive: true });
			fs.writeFileSync(
				path.join(job, "state.json"),
				JSON.stringify({
					sessionId,
					name: "Worker one",
					cwd: wt,
					updatedAt: new Date().toISOString(),
				}),
			);
		}
		const file = path.join(wt, "a.txt");
		fs.writeFileSync(file, "worktree edit\n");
		const at = new Date(Date.now() - hours * HOUR);
		fs.utimesSync(file, at, at);
		return fs.realpathSync(wt);
	}

	it("is an orphan under its owning session once that session is no longer listed", async () => {
		const wt = worktreeOf("dead-owner-1", 30);

		const r = await run();

		expect(r.out).toContain("ORPHANED-EDIT (1)");
		expect(r.out).toContain(".claude/worktrees/w1: a.txt — unchanged 30h");
		expect(r.out).toContain(
			"last known writer: session dead-owner-1 (Worker one), whose worktree it is",
		);
		expect(r.out).toContain(`inspect: git -C ${wt} diff HEAD -- a.txt`);
		const [filing] = readFilings();
		expect(filing?.argv.join(" ")).toContain(
			"Orphaned edits: 1 file(s) in .claude/worktrees/w1 (state",
		);
	});

	function dirtyIn(wt: string, rel: string, hours: number, content: string) {
		const file = path.join(wt, rel);
		fs.writeFileSync(file, content);
		const at = new Date(Date.now() - hours * HOUR);
		fs.utimesSync(file, at, at);
	}

	/** Point `origin/main` at a line of commits on HEAD, each carrying
	 * one entry of `commits`, then put the main checkout back at HEAD. */
	function landOnOrigin(...commits: Record<string, string>[]) {
		const git = (...args: string[]) =>
			spawnSync("git", args, { cwd: sb.repo, encoding: "utf8" });
		const head = git("rev-parse", "HEAD").stdout.trim();
		for (const files of commits) {
			for (const [rel, content] of Object.entries(files))
				fs.writeFileSync(path.join(sb.repo, rel), content);
			commitAll(sb, "landed");
		}
		git("update-ref", "refs/remotes/origin/main", "HEAD");
		git("reset", "-q", "--hard", head);
	}

	/** The issue the reaper defers to for worktree `wt` as its dirt stands. */
	const reaperSees = (wt: string) =>
		readWorktreeFiling(
			path.join(sb.repo, ".git"),
			worktreeLabel(sb.repo, wt),
			readWorktreeDirt(wt) ?? [],
		);

	const bodyOf = () => readFilings().map((f) => f.body);

	it("files one issue for all of a dead worktree's files, and once more when any of them changes (#4439)", async () => {
		const wt = worktreeOf("dead-owner-5", 30);
		dirtyIn(wt, "c.txt", 30, "worktree edit\n");

		await run();
		await run();

		expect(readFilings()).toHaveLength(1);
		const [filing] = readFilings();
		expect(filing?.argv.join(" ")).toContain(
			"Orphaned edits: 2 file(s) in .claude/worktrees/w1",
		);
		expect(filing?.body).toContain("| `a.txt` |");
		expect(filing?.body).toContain("| `c.txt` |");

		expect(reaperSees(wt)).toBe("https://github.com/o/r/issues/7");

		dirtyIn(wt, "c.txt", 30, "edited again\n");
		expect(reaperSees(wt)).toBeNull();
		await run();
		await run();

		expect(readFilings()).toHaveLength(2);
		expect(readFilings()[1]?.body).toContain(
			"Supersedes https://github.com/o/r/issues/7",
		);
		expect(reaperSees(wt)).toBe("https://github.com/o/r/issues/7");
	});

	it("names removing the worktree where every change in it is already on origin/main (#4439)", async () => {
		landOnOrigin({ "a.txt": "worktree edit\n" });
		const wt = worktreeOf("dead-owner-6", 30);

		const r = await run();

		const [body] = bodyOf();
		expect(body).toContain("| `a.txt` | 30h |");
		expect(body).toContain("| yes, byte for byte |");
		expect(body).toContain("holds nothing unlanded");
		expect(body).toContain(`git worktree remove --force ${wt}`);
		expect(body).not.toContain("session-checkout.js land");
		expect(r.out).toContain("on origin/main: yes, byte for byte");
	});

	it("reads a change landed and since superseded as landed by its lines (#4439)", async () => {
		landOnOrigin({ "a.txt": "worktree edit\nlater line\n" });
		worktreeOf("dead-owner-7", 30);

		await run();

		const [body] = bodyOf();
		expect(body).toContain("| yes, every changed line |");
		expect(body).toContain("holds nothing unlanded");
	});

	it("keeps the land route where a change is not on origin/main (#4439)", async () => {
		landOnOrigin({ "c.txt": "other\n" });
		const wt = worktreeOf("dead-owner-8", 30);

		await run();

		const [body] = bodyOf();
		expect(body).toContain("| no |");
		expect(body).toContain("session-checkout.js land");
		expect(body).toContain(`git -C ${wt} diff HEAD`);
	});

	it("waits while another file in the worktree is under 24 hours, then files them together (#4439)", async () => {
		const wt = worktreeOf("dead-owner-9", 30);
		dirtyIn(wt, "c.txt", 1, "fresh\n");

		expect((await run()).out).toContain(
			"not filed yet: 1 other file(s) in its worktree changed within 24h",
		);
		expect(readFilings()).toEqual([]);

		dirtyIn(wt, "c.txt", 30, "fresh\n");
		await run();

		expect(readFilings()).toHaveLength(1);
		expect(readFilings()[0]?.argv.join(" ")).toContain("2 file(s)");
	});

	it("keeps the land route where an untracked file in the worktree would go with it (#4439)", async () => {
		landOnOrigin({ "a.txt": "worktree edit\n" });
		const wt = worktreeOf("dead-owner-10", 30);
		fs.writeFileSync(path.join(wt, "new.txt"), "never added\n");

		await run();

		const [body] = bodyOf();
		expect(body).toContain("| yes, byte for byte |");
		expect(body).toContain("1 other path(s) in it, untracked");
		expect(body).toContain("session-checkout.js land");
	});

	it("reads a change landed and since reworked as landed, by the version that made it (#4439)", async () => {
		landOnOrigin({ "a.txt": "seed\nX\nY\n" }, { "a.txt": "seed\nY\n" });
		const wt = worktreeOf("dead-owner-11", 30);
		dirtyIn(wt, "a.txt", 30, "seed\nX\n");

		await run();

		expect(bodyOf()[0]).toContain("| yes, every changed line |");
	});

	it("does not read a line added twice as landed where landing added it once (#4439)", async () => {
		landOnOrigin({ "a.txt": "seed\nX\n", "c.txt": "moved\n" });
		const wt = worktreeOf("dead-owner-12", 30);
		dirtyIn(wt, "a.txt", 30, "seed\nX\nX\n");

		await run();

		expect(bodyOf()[0]).toContain("| no |");
	});

	/** A `git` stand-in that logs each call's arguments, a line each, then runs git. */
	function loggedGit() {
		const log = path.join(sb.dir, "git-calls");
		const bin = path.join(sb.dir, "bin", "git-logged");
		fs.writeFileSync(
			bin,
			`#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexec git "$@"\n`,
		);
		fs.chmodSync(bin, 0o755);
		return {
			env: { WFC_GIT: bin },
			/** The calls that read landed history: versions listed, or blobs read. */
			landedReads: () =>
				(fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "")
					.split("\n")
					.filter((c) => /^(log --format= --raw|cat-file)/.test(c)),
			reset: () => fs.rmSync(log, { force: true }),
		};
	}

	it("reads every file's landed versions in a worktree through one cat-file batch (#4542)", async () => {
		landOnOrigin({
			"a.txt": "worktree edit\nlater line\n",
			"c.txt": "c edit\nmore\n",
		});
		const wt = worktreeOf("dead-owner-13", 30);
		dirtyIn(wt, "c.txt", 30, "c edit\n");
		const git = loggedGit();

		await run([], false, git.env);

		expect(bodyOf()[0]).toContain("| `a.txt` | 30h | ");
		expect(bodyOf()[0]?.match(/\| yes, every changed line \|/g)).toHaveLength(
			2,
		);
		expect(git.landedReads().filter((c) => c.startsWith("cat-file"))).toEqual([
			"cat-file --batch",
		]);
	});

	it("reads no landed history for a worktree already filed (#4542)", async () => {
		landOnOrigin({ "a.txt": "worktree edit\nlater line\n" });
		worktreeOf("dead-owner-14", 30);
		const git = loggedGit();
		await run([], false, git.env);
		expect(readFilings()).toHaveLength(1);
		git.reset();

		const r = await run([], false, git.env);

		expect(r.out).toContain("triage:  already filed");
		expect(r.out).toContain("on origin/main: unread");
		expect(git.landedReads()).toEqual([]);
		expect((await run([], false, git.env, false)).out).toContain(
			"triage:  already filed",
		);
		expect(git.landedReads()).toEqual([]);
	});

	it("is owned while its session is listed live, though no claim or ledger names it", async () => {
		worktreeOf("live-owner-1", 30);
		fakeClaude("bystander", "live-owner-1");

		expect((await run()).out).not.toContain("ORPHANED-EDIT");
		expect(readFilings()).toEqual([]);
	});

	it("is owned by the ledger at the file's path in its tree where no session owns the worktree (#4397)", async () => {
		const wt = worktreeOf(null, 30);
		fakeClaude("bystander", "ledger-owner");
		fs.mkdirSync(store.paths.writesDir(), { recursive: true });
		fs.writeFileSync(store.paths.ledger("ledger-owner"), `a.txt\t${wt}\n`);

		expect((await run()).out).not.toContain("ORPHANED-EDIT");
	});

	it("is not owned by a live session's ledger at the same path in the main checkout (#4457)", async () => {
		worktreeOf(null, 30);
		fakeClaude("bystander", "main-writer");
		fs.mkdirSync(store.paths.writesDir(), { recursive: true });
		fs.writeFileSync(store.paths.ledger("main-writer"), "a.txt\n");

		expect((await run()).out).toContain("ORPHANED-EDIT");
	});

	it("is judged by the worktree's file, not the main checkout's", async () => {
		worktreeOf("dead-owner-2", 2);
		dirty("a.txt", 30);
		fakeClaude("bystander");

		const r = await run(["--json"]);

		const data = JSON.parse(r.stdout);
		expect(
			data.orphans.map((o: { worktree: string | null }) => o.worktree),
		).toEqual([null]);
		expect(data.young).toBe(1);
	});

	it("is owned by a live session's ledger though the worktree's owner has ended", async () => {
		const wt = worktreeOf("dead-owner-3", 30);
		fakeClaude("bystander", "mover");
		fs.mkdirSync(store.paths.writesDir(), { recursive: true });
		fs.writeFileSync(store.paths.ledger("mover"), `a.txt\t${wt}\n`);

		expect((await run()).out).not.toContain("ORPHANED-EDIT");
		expect(readFilings()).toEqual([]);
	});

	it("judges an old file in an unowned worktree outside the host root by its path there (#4397)", async () => {
		const wt = worktreeOf(null, 30, path.join(sb.dir, "outside-wt"));
		fakeClaude("bystander");

		const data = JSON.parse((await run(["--json"])).stdout);

		expect(data.orphans.map((o: { worktree: string }) => o.worktree)).toEqual([
			wt,
		]);
	});

	it("names a registration whose directory has gone, and judges the rest", async () => {
		const wt = worktreeOf("dead-owner-4", 30);
		fs.rmSync(wt, { recursive: true, force: true });
		dirty("a.txt", 30);

		const data = JSON.parse((await run(["--json"])).stdout);

		expect(data.orphanCount).toBe(1);
		expect(data.unreadWorktrees).toEqual([wt]);
	});
});

/*
 * Seam 2 (#4317, spec #4229): with the `landing` module on and the sandbox's `main`
 * tracking no `landing` upstream, the main checkout is cut over, so #4248's
 * refusal holds every session out of it and its dirt is judged at once.
 */
describe("a cut-over main checkout's dirt", () => {
	const landingOn = (args: string[] = []) =>
		run(args, false, {
			WFC_MODULES: `${process.env.WFC_MODULES},landing`,
		});

	it("is an orphan on the first run, whatever its age, naming its ledger's last writer", async () => {
		dirty("a.txt", 0);
		fs.mkdirSync(store.paths.writesDir(), { recursive: true });
		fs.writeFileSync(store.paths.ledger("gone-writer"), "a.txt\n");

		const r = await landingOn();

		expect(r.status).toBe(0);
		expect(r.out).toContain("ORPHANED-EDIT (1)");
		expect(r.out).toContain("in the cut-over main checkout at any age");
		expect(r.out).toContain("last known writer: session gone-writer");
		expect(readFilings()).toHaveLength(1);
	});

	it("is still owned by a live session's ledger", async () => {
		dirty("a.txt", 0);
		fakeClaude("bystander", "live-writer");
		fs.mkdirSync(store.paths.writesDir(), { recursive: true });
		fs.writeFileSync(store.paths.ledger("live-writer"), "a.txt\n");

		const r = await landingOn();

		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"no orphaned edit in the cut-over main checkout at any age",
		);
	});

	it("waits 24 hours while main still tracks landing, not yet cut over", async () => {
		dirty("a.txt", 0);
		spawnSync("git", ["config", "branch.main.merge", "refs/heads/landing"], {
			cwd: sb.repo,
		});

		const data = JSON.parse((await landingOn(["--json"])).stdout);

		expect(data.mainCutOver).toBe(false);
		expect(data.orphanCount).toBe(0);
		expect(data.young).toBe(1);
	});

	describe("read from a session launched in a linked worktree (#4483)", () => {
		/** A worktree of the sandbox repo, `a.txt` in it dirtied now, which a
		 * session launched there names as its project dir and cwd. */
		function launchedIn() {
			const wt = path.join(sb.repo, ".claude", "worktrees", "probe");
			fs.mkdirSync(path.dirname(wt), { recursive: true });
			spawnSync("git", ["worktree", "add", "-q", "--detach", wt], {
				cwd: sb.repo,
			});
			fs.writeFileSync(path.join(wt, "a.txt"), "worktree edit\n");
			return fs.realpathSync(wt);
		}
		const runFrom = async (tree: string, args: string[] = ["--json"]) => {
			const r = await runInProcessAsync(SCRIPT, [...args, "--write"], {
				env: {
					...process.env,
					WFC_MODULES: `${process.env.WFC_MODULES},landing`,
					GITHUB_ACTIONS: "",
					WFC_ORACLE_CACHE: "0",
					CLAUDE_PROJECT_DIR: tree,
				},
				cwd: tree,
			});
			expect(r.status).toBe(0);
			return { stdout: r.stdout, out: r.stdout + r.stderr };
		};

		it("judges the worktree's fresh dirt as that worktree's, filing nothing", async () => {
			const data = JSON.parse((await runFrom(launchedIn())).stdout);

			expect(data.orphanCount).toBe(0);
			expect(data.young).toBe(1);
			expect(readFilings()).toEqual([]);
		});

		it("judges the main checkout's dirt against the main checkout's store", async () => {
			const wt = launchedIn();
			dirty("c.txt", 0);
			fakeClaude("bystander", "live-writer");
			fs.mkdirSync(store.paths.writesDir(), { recursive: true });
			fs.writeFileSync(store.paths.ledger("live-writer"), "c.txt\n");

			const data = JSON.parse((await runFrom(wt)).stdout);

			expect(data.mainCutOver).toBe(true);
			expect(data.orphanCount).toBe(0);
			expect(readFilings()).toEqual([]);
		});

		it("still files the main checkout's unowned dirt, by its main-checkout path", async () => {
			const wt = launchedIn();
			dirty("c.txt", 0);

			const { out } = await runFrom(wt, []);

			expect(out).toContain("ORPHANED-EDIT (1)");
			const filings = readFilings();
			expect(filings).toHaveLength(1);
			expect(filings[0].body).toContain("c.txt");
			expect(filings[0].body).not.toContain(".claude/worktrees/probe");
		});

		it("files the worktree's aged dirt under the worktree's name", async () => {
			const wt = launchedIn();
			const at = new Date(Date.now() - 30 * HOUR);
			fs.utimesSync(path.join(wt, "a.txt"), at, at);

			const { out } = await runFrom(wt, []);

			expect(out).toContain(".claude/worktrees/probe: a.txt");
			expect(readFilings()).toHaveLength(1);
		});
	});

	it("leaves a linked worktree's dirt to the 24-hour test", async () => {
		const wt = path.join(sb.repo, ".claude", "worktrees", "w2");
		fs.mkdirSync(path.dirname(wt), { recursive: true });
		spawnSync("git", ["worktree", "add", "-q", "--detach", wt], {
			cwd: sb.repo,
		});
		fs.writeFileSync(path.join(wt, "a.txt"), "worktree edit\n");

		const data = JSON.parse((await landingOn(["--json"])).stdout);

		expect(data.mainCutOver).toBe(true);
		expect(data.orphanCount).toBe(0);
		expect(data.young).toBe(1);
	});
});
