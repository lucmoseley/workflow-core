// @vitest-environment node
/*
 * Pins that check-orphaned-edits.js names an uncommitted file no live session
 * owns, untouched for 24 hours, files it once for triage, and stays silent
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
import { distinctFromHint } from "./lib/similar-titles.js";

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

const filings = (): { argv: string[]; body: string }[] =>
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
const run = (args: string[] = [], notify = false) => {
	const r = runInProcess(SCRIPT, notify ? ["--notify", ...args] : args, {
		env: {
			...process.env,
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
		expect(filings()).toEqual([]);
	});

	it("files an orphan at session start but prints nothing, the report being npm run status's (#2038)", () => {
		dirty("a.txt", 25);
		const r = run([], true);
		expect(r.out).toBe("");
		expect(filings()).toHaveLength(1);
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
				procStart: proc.procStartOf(process.pid),
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
		expect(filings()).toEqual([]);
	});

	describe("filing", () => {
		it("files one takes:triage issue per path and blob, and nothing on a second run", () => {
			dirty("a.txt", 30);

			run();
			run();

			const calls = filings();
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

			expect(filings()).toHaveLength(2);
		});

		it("files each orphaned path on its own", () => {
			dirty("a.txt", 30);
			dirty("docs/b.md", 30);
			run();

			expect(filings()).toHaveLength(2);
		});

		it("names the titles file-issue.js lists as distinct, and files", () => {
			dirty("a.txt", 30);
			fakeFiler(
				0,
				`Nothing filed: #3 is not yet checked. Re-run with ${distinctFromHint([3, 4])}`,
			);
			run();

			const calls = filings();
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

			expect(filings()).toHaveLength(2);
			expect(run().out).toContain("already filed");
		});
	});

	it("files at most two a run and the rest at the next, saying so", () => {
		dirty("a.txt", 30);
		dirty("docs/b.md", 30);
		dirty("c.txt", 30);

		expect(run().out).toContain("this run's filing cap is spent");
		expect(filings()).toHaveLength(2);
		run();
		expect(filings()).toHaveLength(3);
	});

	it("leaves an interrupted filing alone rather than filing it again", () => {
		dirty("a.txt", 30);
		run();
		// What a filer killed mid-create leaves: its marker, empty.
		const dir = path.join(sb.repo, ".git", "orphaned-edits-filed");
		for (const f of fs.readdirSync(dir))
			fs.writeFileSync(path.join(dir, f), "");

		expect(run().out).toContain("filing in progress or interrupted");
		expect(filings()).toHaveLength(1);
	});

	it("never retries a filing whose filer died before it could say", () => {
		dirty("a.txt", 30);
		const bin = path.join(sb.dir, "bin", "dying-filer.js");
		fs.writeFileSync(bin, 'process.kill(process.pid, "SIGKILL");\n');
		process.env.WFC_ORPHAN_FILER = bin;
		expect(run().out).toContain("filing interrupted, not retried");

		fakeFiler();
		expect(run().out).toContain("filing in progress or interrupted");
		expect(filings()).toEqual([]);
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
			expect(filings()).toEqual([]);
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
			expect(filings()).toEqual([]);
		});

		it.skipIf(AS_ROOT)("a live session's write ledger", () => {
			dirty("a.txt", 30);
			fakeClaude("writer");
			fs.mkdirSync(store.paths.writesDir(), { recursive: true });
			fs.writeFileSync(store.paths.ledger("writer"), "docs/b.md\n");
			fs.chmodSync(store.paths.ledger("writer"), 0o000);

			expect(JSON.parse(run(["--json"]).stdout).outcome).toBe("SKIP");
			expect(filings()).toEqual([]);
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
