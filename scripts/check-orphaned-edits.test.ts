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

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	AS_ROOT,
	commitAll,
	freshSandbox,
	gitRepo,
	locks,
	proc,
	store,
} from "./lib/arbiter-testkit";
import { runInProcess } from "./lib/run-in-process.js";
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
	process.env.WFC_CLAUDE_BIN = bin;
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
	process.env.WFC_ORPHAN_FILER = bin;
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
const run = (
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
	const r = runInProcess(SCRIPT, argv, {
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
	it("says nothing at session start when there is no orphan", () => {
		const r = run([], true);
		expect(r.out).toBe("");
		expect(r.status).toBe(0);
		expect(readFilings()).toEqual([]);
	});

	it("files an orphan at session start but prints nothing, the report being npm run status's (#2038)", () => {
		dirty("a.txt", 25);
		const r = run([], true);
		expect(r.out).toBe("");
		expect(readFilings()).toHaveLength(1);
	});

	it("files nothing without --write, and says --write files it, taking no marker (#4449)", () => {
		dirty("a.txt", 25);
		const r = run([], false, {}, false);
		expect(r.out).toContain("triage:  not filed: `--write` files it");
		expect(readFilings()).toEqual([]);
		expect(run().out).toContain("triage:  https://github.com/o/r/issues/7");
		expect(run([], false, {}, false).out).toContain(
			"triage:  already filed: https://github.com/o/r/issues/7",
		);
	});

	it("reports a file unchanged for 24 hours, and not one unchanged for less", () => {
		dirty("a.txt", 25);
		dirty("docs/b.md", 23);

		const r = run();

		expect(r.out).toContain("ORPHANED-EDIT (1)");
		expect(r.out).toContain("a.txt — unchanged 25h");
		expect(r.out).not.toContain("docs/b.md");
		// WARN, never FAIL: it reports and a human decides.
		expect(r.status).toBe(0);
	});

	it("names the path, its age, the last known writer, and the inspect, commit and revert commands", () => {
		dirty("a.txt", 72);
		fs.mkdirSync(store.paths.writesDir(), { recursive: true });
		fs.writeFileSync(store.paths.ledger("gone-session"), "a.txt\n");

		const r = run();

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

	it("says the writer is unknown where no ledger names the file", () => {
		dirty("a.txt", 30);
		expect(run().out).toContain("last known writer: unknown");
	});

	describe("a live session's ownership excludes the file", () => {
		it("by a live claim", () => {
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

			expect(run().out).not.toContain("ORPHANED-EDIT");
		});

		it("by a live session's observation", () => {
			dirty("a.txt", 30);
			fakeClaude("watcher");
			const file = store.paths.observation("a.txt", "watcher");
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				file,
				JSON.stringify({ path: "a.txt", sessionId: "watcher", obsId: "o1" }),
			);

			expect(run().out).not.toContain("ORPHANED-EDIT");
		});

		it("by a live session's write ledger", () => {
			dirty("a.txt", 30);
			fakeClaude("writer");
			fs.mkdirSync(store.paths.writesDir(), { recursive: true });
			fs.writeFileSync(store.paths.ledger("writer"), "a.txt\n");

			expect(run().out).not.toContain("ORPHANED-EDIT");
		});

		it("but not by the ledger of a session the oracle does not list", () => {
			dirty("a.txt", 30);
			fakeClaude("someone-else");
			fs.mkdirSync(store.paths.writesDir(), { recursive: true });
			fs.writeFileSync(store.paths.ledger("writer"), "a.txt\n");

			expect(run().out).toContain("ORPHANED-EDIT (1)");
		});
	});

	it("reports nothing where liveness cannot be read", () => {
		dirty("a.txt", 30);
		const bin = path.join(sb.dir, "bin", "claude");
		fs.writeFileSync(bin, "#!/bin/sh\nexit 1\n");

		const r = run(["--json"]);
		expect(JSON.parse(r.stdout).outcome).toBe("SKIP");
		expect(readFilings()).toEqual([]);
	});

	describe("filing", () => {
		it("files one takes:triage issue per path and blob, and nothing on a second run", () => {
			dirty("a.txt", 30);

			run();
			run();

			const calls = readFilings();
			expect(calls).toHaveLength(1);
			const { argv, body } = calls[0];
			expect(argv).toContain("takes:triage");
			expect(argv).toContain("--standalone");
			expect(argv.join(" ")).toContain("Orphaned edit: a.txt");
			expect(body).toContain("git diff HEAD -- a.txt");
			expect(run().out).toContain(
				"triage:  already filed: https://github.com/o/r/issues/7",
			);
		});

		it("files again when the same path holds a different blob", () => {
			dirty("a.txt", 30, "first\n");
			run();
			dirty("a.txt", 30, "second\n");
			run();

			expect(readFilings()).toHaveLength(2);
		});

		it("files each orphaned path on its own", () => {
			dirty("a.txt", 30);
			dirty("docs/b.md", 30);
			run();

			expect(readFilings()).toHaveLength(2);
		});

		it("names the titles file-issue.js lists as distinct, and files", () => {
			dirty("a.txt", 30);
			fakeFiler(
				0,
				`Nothing filed: #3 is not yet checked. Re-run with ${buildDistinctFromHint([3, 4])}`,
			);
			run();

			const calls = readFilings();
			expect(calls).toHaveLength(2);
			expect(calls[1].argv.slice(-2)).toEqual(["--distinct-from", "3,4"]);
			expect(run().out).toContain("already filed");
		});

		it("retries a filing that failed, rather than recording it", () => {
			dirty("a.txt", 30);
			fakeFiler(1);
			expect(run().out).toContain(
				"filing failed, retried next run: gh: offline",
			);
			fakeFiler(0);
			run();

			expect(readFilings()).toHaveLength(2);
			expect(run().out).toContain("already filed");
		});
	});

	it("files at most two a run and the rest at the next, saying so", () => {
		dirty("a.txt", 30);
		dirty("docs/b.md", 30);
		dirty("c.txt", 30);

		expect(run().out).toContain("this run's filing cap is spent");
		expect(readFilings()).toHaveLength(2);
		run();
		expect(readFilings()).toHaveLength(3);
	});

	it("leaves an interrupted filing alone rather than filing it again", () => {
		dirty("a.txt", 30);
		run();
		// What a filer killed mid-create leaves: its marker, empty.
		const dir = path.join(sb.repo, ".git", "orphaned-edits-filed");
		for (const f of fs.readdirSync(dir))
			fs.writeFileSync(path.join(dir, f), "");

		expect(run().out).toContain("filing in progress or interrupted");
		expect(readFilings()).toHaveLength(1);
	});

	it("never retries a filing whose filer died before it could say", () => {
		dirty("a.txt", 30);
		const bin = path.join(sb.dir, "bin", "dying-filer.js");
		fs.writeFileSync(bin, 'process.kill(process.pid, "SIGKILL");\n');
		process.env.WFC_ORPHAN_FILER = bin;
		expect(run().out).toContain("filing interrupted, not retried");

		fakeFiler();
		expect(run().out).toContain("filing in progress or interrupted");
		expect(readFilings()).toEqual([]);
	});

	it("refuses a negative --hours as a bad invocation", () => {
		const r = run(["--hours", "-1"], false);
		expect(r.out).toContain("--hours must be a non-negative number");
		expect(r.status).toBe(2);
	});

	describe("reports nothing where an ownership store will not read", () => {
		/* chmod binds nobody as root, so these say nothing there. */
		it.skipIf(AS_ROOT)("the lock store", () => {
			dirty("a.txt", 30);
			fs.mkdirSync(store.paths.locksDir(), { recursive: true });
			fs.chmodSync(store.paths.locksDir(), 0o000);
			try {
				expect(JSON.parse(run(["--json"]).stdout).outcome).toBe("SKIP");
			} finally {
				fs.chmodSync(store.paths.locksDir(), 0o755);
			}
			expect(readFilings()).toEqual([]);
		});

		it.skipIf(AS_ROOT)("the observation store", () => {
			dirty("a.txt", 30);
			fakeClaude("watcher");
			fs.mkdirSync(store.paths.observationsDir(), { recursive: true });
			fs.chmodSync(store.paths.observationsDir(), 0o000);
			try {
				expect(JSON.parse(run(["--json"]).stdout).outcome).toBe("SKIP");
			} finally {
				fs.chmodSync(store.paths.observationsDir(), 0o755);
			}
			expect(readFilings()).toEqual([]);
		});

		it.skipIf(AS_ROOT)("a live session's write ledger", () => {
			dirty("a.txt", 30);
			fakeClaude("writer");
			fs.mkdirSync(store.paths.writesDir(), { recursive: true });
			fs.writeFileSync(store.paths.ledger("writer"), "docs/b.md\n");
			fs.chmodSync(store.paths.ledger("writer"), 0o000);

			expect(JSON.parse(run(["--json"]).stdout).outcome).toBe("SKIP");
			expect(readFilings()).toEqual([]);
		});
	});

	it("never writes or reverts the orphaned file", () => {
		dirty("a.txt", 30, "precious weekend work\n");
		const before = fs.statSync(path.join(sb.repo, "a.txt")).mtimeMs;

		run();
		run();

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

	it("is an orphan under its owning session once that session is no longer listed", () => {
		const wt = worktreeOf("dead-owner-1", 30);

		const r = run();

		expect(r.out).toContain("ORPHANED-EDIT (1)");
		expect(r.out).toContain(".claude/worktrees/w1: a.txt — unchanged 30h");
		expect(r.out).toContain(
			"last known writer: session dead-owner-1 (Worker one), whose worktree it is",
		);
		expect(r.out).toContain(`inspect: git -C ${wt} diff HEAD -- a.txt`);
		const [filing] = readFilings();
		expect(filing?.argv.join(" ")).toContain(
			"Orphaned edit: a.txt in .claude/worktrees/w1 (blob",
		);
	});

	it("is owned while its session is listed live, though no claim or ledger names it", () => {
		worktreeOf("live-owner-1", 30);
		fakeClaude("bystander", "live-owner-1");

		expect(run().out).not.toContain("ORPHANED-EDIT");
		expect(readFilings()).toEqual([]);
	});

	it("is owned by the ledger at the file's path in its tree where no session owns the worktree (#4397)", () => {
		worktreeOf(null, 30);
		fakeClaude("bystander", "ledger-owner");
		fs.mkdirSync(store.paths.writesDir(), { recursive: true });
		fs.writeFileSync(store.paths.ledger("ledger-owner"), "a.txt\n");

		expect(run().out).not.toContain("ORPHANED-EDIT");
	});

	it("is judged by the worktree's file, not the main checkout's", () => {
		worktreeOf("dead-owner-2", 2);
		dirty("a.txt", 30);
		fakeClaude("bystander");

		const r = run(["--json"]);

		const data = JSON.parse(r.stdout);
		expect(
			data.orphans.map((o: { worktree: string | null }) => o.worktree),
		).toEqual([null]);
		expect(data.young).toBe(1);
	});

	it("is owned by a live session's ledger though the worktree's owner has ended", () => {
		worktreeOf("dead-owner-3", 30);
		fakeClaude("bystander", "mover");
		fs.mkdirSync(store.paths.writesDir(), { recursive: true });
		fs.writeFileSync(store.paths.ledger("mover"), "a.txt\n");

		expect(run().out).not.toContain("ORPHANED-EDIT");
		expect(readFilings()).toEqual([]);
	});

	it("judges an old file in an unowned worktree outside the host root by its path there (#4397)", () => {
		const wt = worktreeOf(null, 30, path.join(sb.dir, "outside-wt"));
		fakeClaude("bystander");

		const data = JSON.parse(run(["--json"]).stdout);

		expect(data.orphans.map((o: { worktree: string }) => o.worktree)).toEqual([
			wt,
		]);
	});

	it("names a registration whose directory has gone, and judges the rest", () => {
		const wt = worktreeOf("dead-owner-4", 30);
		fs.rmSync(wt, { recursive: true, force: true });
		dirty("a.txt", 30);

		const data = JSON.parse(run(["--json"]).stdout);

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

	it("is an orphan on the first run, whatever its age, naming its ledger's last writer", () => {
		dirty("a.txt", 0);
		fs.mkdirSync(store.paths.writesDir(), { recursive: true });
		fs.writeFileSync(store.paths.ledger("gone-writer"), "a.txt\n");

		const r = landingOn();

		expect(r.status).toBe(0);
		expect(r.out).toContain("ORPHANED-EDIT (1)");
		expect(r.out).toContain("in the cut-over main checkout at any age");
		expect(r.out).toContain("last known writer: session gone-writer");
		expect(readFilings()).toHaveLength(1);
	});

	it("is still owned by a live session's ledger", () => {
		dirty("a.txt", 0);
		fakeClaude("bystander", "live-writer");
		fs.mkdirSync(store.paths.writesDir(), { recursive: true });
		fs.writeFileSync(store.paths.ledger("live-writer"), "a.txt\n");

		const r = landingOn();

		expect(r.status).toBe(0);
		expect(r.out).toContain(
			"no orphaned edit in the cut-over main checkout at any age",
		);
	});

	it("waits 24 hours while main still tracks landing, not yet cut over", () => {
		dirty("a.txt", 0);
		spawnSync("git", ["config", "branch.main.merge", "refs/heads/landing"], {
			cwd: sb.repo,
		});

		const data = JSON.parse(landingOn(["--json"]).stdout);

		expect(data.mainCutOver).toBe(false);
		expect(data.orphanCount).toBe(0);
		expect(data.young).toBe(1);
	});

	it("leaves a linked worktree's dirt to the 24-hour test", () => {
		const wt = path.join(sb.repo, ".claude", "worktrees", "w2");
		fs.mkdirSync(path.dirname(wt), { recursive: true });
		spawnSync("git", ["worktree", "add", "-q", "--detach", wt], {
			cwd: sb.repo,
		});
		fs.writeFileSync(path.join(wt, "a.txt"), "worktree edit\n");

		const data = JSON.parse(landingOn(["--json"]).stdout);

		expect(data.mainCutOver).toBe(true);
		expect(data.orphanCount).toBe(0);
		expect(data.young).toBe(1);
	});
});
