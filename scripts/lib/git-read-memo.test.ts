// @vitest-environment node
/*
 * lib/git-read-memo.js through lib/git.js's spawns: a read run once a memo, and
 * a replay answering each route as its own spawn would have (#4127). Break this
 * and a guard judges a call on a stale or misshapen git answer, or a host's
 * failure outcome changes under it.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRealGit, writeFaultyGit } from "./git-fault-fake";
import { initGitRepo, mkScratchDir } from "./git-fixture";
import { shellQuote } from "./sh-quote.js";

const {
	execGit,
	execProgram,
	gitAnswer,
	gitBinary,
	gitOrNull,
	gitOutcome,
	spawnGitSync,
} = require("./git.js") as typeof import("./git.js");
const { withGitReadMemo, withoutGitReadMemo } =
	require("./git-read-memo.js") as typeof import("./git-read-memo.js");

/* Crossed for real: only a real process timeout shows a kept timeout replayed.
 * The two waits are short and ordered, one shorter than the other; the hang far
 * outlives both; the case's limit allows for a loaded machine. */
const SHORT_WAIT_MS = 50;
const LONGER_WAIT_MS = 100;
const HANG_S = 30;
const LOADED_CASE_MS = 10_000;

let dir: string;
let repo: string;
let calls: string;

function loggingGit(): void {
	const { git } = writeFaultyGit(
		{ all: true },
		{ script: `echo "$*" >>${shellQuote(calls)}\nexec "$REAL_GIT" "$@"` },
		{ under: dir },
	);
	vi.stubEnv("WFC_GIT", git);
}

const spawned = () =>
	fs.existsSync(calls)
		? fs.readFileSync(calls, "utf8").split("\n").filter(Boolean)
		: [];

beforeEach(() => {
	dir = mkScratchDir("git-read-memo-");
	repo = path.join(dir, "repo");
	calls = path.join(dir, "calls");
	fs.mkdirSync(path.join(dir, "no-hooks"));
	initGitRepo(repo, path.join(dir, "no-hooks"));
});

afterEach(() => {
	vi.unstubAllEnvs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("what counts as a read", () => {
	it.each([
		[["rev-parse", "HEAD"], 1],
		[["-C", ".", "-c", "core.quotePath=false", "diff", "--cached"], 1],
		[["--literal-pathspecs", "diff", "--name-only"], 1],
		[["config", "--get", "user.name"], 1],
		[["config", "user.name", "x"], 2],
		[["remote", "-v"], 1],
		[["remote", "add", "o", "u"], 2],
		[["update-ref", "HEAD", "x"], 2],
		[["hash-object", "-w", "--", "a.md"], 2],
		[["-C", ".", "read-tree", "HEAD"], 2],
		[["--version"], 2],
		[["--git-dir", ".git", "rev-parse", "HEAD"], 2],
		[["remote", "-v", "add", "o", "u"], 2],
		[["config", "user.name", "--get-regexp"], 2],
		[["diff", "--output=out"], 2],
		[["symbolic-ref", "--short", "HEAD"], 1],
		[["symbolic-ref", "HEAD", "refs/heads/main"], 2],
		[["symbolic-ref", "-d", "NOPE"], 2],
		[["worktree", "list"], 1],
		[["worktree", "prune"], 2],
		[["show-ref"], 1],
		[["check-ignore", "--", "a.md"], 1],
	])("%j asked twice starts %i git", (args, want) => {
		loggingGit();
		withGitReadMemo(() => {
			gitOrNull(args, { cwd: repo });
			gitOrNull(args, { cwd: repo });
		});
		expect(spawned()).toHaveLength(want);
	});
});

describe("one memo's reads", () => {
	it("runs a read once across every route that asks it", () => {
		loggingGit();
		const opts = { cwd: repo, encoding: "utf8", stdio: "pipe" } as const;
		const answers = withGitReadMemo(() => [
			gitOrNull(["rev-parse", "HEAD"], { cwd: repo }),
			gitOutcome(["rev-parse", "HEAD"], [], repo),
			spawnGitSync(["rev-parse", "HEAD"], opts).stdout,
			execGit(["rev-parse", "HEAD"], opts),
			execProgram(gitBinary(), ["rev-parse", "HEAD"], opts),
		]);
		const head = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: repo,
			encoding: "utf8",
		});
		expect(answers).toEqual([head, { ok: true, out: head }, head, head, head]);
		expect(spawned()).toEqual(["rev-parse HEAD"]);
	});

	it("runs a read again in another directory, under another env and after the memo ends", () => {
		loggingGit();
		const other = path.join(dir, "other");
		initGitRepo(other, path.join(dir, "no-hooks"));
		withGitReadMemo(() => {
			gitOrNull(["rev-parse", "HEAD"], { cwd: repo });
			gitOrNull(["rev-parse", "HEAD"], { cwd: other });
			const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, "index") };
			gitOrNull(["rev-parse", "HEAD"], { cwd: repo, env });
		});
		gitOrNull(["rev-parse", "HEAD"], { cwd: repo });
		expect(spawned()).toHaveLength(4);
	});

	it("repeats a write, and reads afresh after one", () => {
		loggingGit();
		const hash = ["hash-object", "-w", "--", "a.md"];
		const seen = withGitReadMemo(() => {
			const before = gitOrNull(["ls-files", "-s"], { cwd: repo });
			gitOrNull(hash, { cwd: repo });
			gitOrNull(hash, { cwd: repo });
			fs.writeFileSync(path.join(repo, "b.md"), "b\n");
			gitOrNull(["add", "b.md"], { cwd: repo });
			return [before, gitOrNull(["ls-files", "-s"], { cwd: repo })];
		});
		expect(seen[1]).not.toBe(seen[0]);
		expect(spawned().filter((c) => c.startsWith("hash-object"))).toHaveLength(
			2,
		);
		expect(spawned().filter((c) => c.startsWith("ls-files"))).toHaveLength(2);
	});

	it("joins the memo already on, one nested inside it sharing its reads", () => {
		loggingGit();
		const head = () => gitOrNull(["rev-parse", "HEAD"], { cwd: repo });
		withGitReadMemo(() => {
			head();
			withGitReadMemo(head);
			head();
		});
		expect(spawned()).toHaveLength(1);
	});

	it("runs every read inside withoutGitReadMemo, and keeps on after it", () => {
		loggingGit();
		const head = () => gitOrNull(["rev-parse", "HEAD"], { cwd: repo });
		withGitReadMemo(() => {
			head();
			withoutGitReadMemo(() => {
				head();
				head();
			});
			head();
		});
		expect(spawned()).toHaveLength(3);
	});

	it("reads afresh after another program runs through execProgram", () => {
		loggingGit();
		const head = () => gitOrNull(["rev-parse", "HEAD"], { cwd: repo });
		withGitReadMemo(() => {
			head();
			execProgram("true", [], {});
			head();
		});
		expect(spawned()).toHaveLength(2);
	});

	it.each([
		["an option a replay would drop", { killSignal: "SIGKILL" }],
		["an inherited stdin", { stdio: ["inherit", "pipe", "pipe"] }],
	])("leaves a read with %s to its own spawn", (_, extra) => {
		loggingGit();
		const opts = { cwd: repo, ...extra } as Parameters<typeof spawnGitSync>[1];
		withGitReadMemo(() => {
			spawnGitSync(["rev-parse", "HEAD"], opts);
			spawnGitSync(["rev-parse", "HEAD"], opts);
		});
		expect(spawned()).toHaveLength(2);
	});

	it("does not keep a git that could not start", () => {
		const later = path.join(dir, "later-git");
		vi.stubEnv("WFC_GIT", later);
		const [before, after] = withGitReadMemo(() => {
			const failed = gitOutcome(["rev-parse", "HEAD"], [], repo);
			fs.symlinkSync(resolveRealGit(), later);
			return [failed, gitOutcome(["rev-parse", "HEAD"], [], repo)];
		});
		expect(before).toMatchObject({ ok: false, isUnrun: true });
		expect(after).toMatchObject({ ok: true });
	});

	it("leaves a read fed stdin to its own spawn", () => {
		loggingGit();
		const asked = {
			cwd: repo,
			encoding: "utf8",
			input: "HEAD\n",
		} as const;
		const out = withGitReadMemo(() => [
			spawnGitSync(["cat-file", "--batch-check"], asked).stdout,
			spawnGitSync(["cat-file", "--batch-check"], asked).stdout,
		]);
		expect(out[0]).toMatch(/ commit /);
		expect(spawned()).toHaveLength(2);
	});
});

describe("a replay answers as the caller's own spawn would", () => {
	/* Each read twice in one memo, the second the replay, against no memo. */
	const both = <T>(read: () => T) => {
		const plain = read();
		const [first, replay] = withGitReadMemo(() => [read(), read()]);
		expect(first).toEqual(plain);
		expect(replay).toEqual(plain);
	};
	const thrown = (read: () => unknown) => () => {
		try {
			return { returned: read() };
		} catch (e) {
			const { message, status, signal, stdout, stderr, code } = e as Record<
				string,
				unknown
			>;
			return { message, status, signal, stdout, stderr, code };
		}
	};
	const spawnFields = (read: () => ReturnType<typeof spawnGitSync>) => () => {
		const { status, signal, stdout, stderr, output, error } = read();
		return { status, signal, stdout, stderr, output, error: error?.message };
	};

	it.each([
		["an answer", ["rev-parse", "HEAD"]],
		["a non-zero exit", ["rev-parse", "--verify", "no-such-ref"]],
		["a fatal exit", ["show", "no-such-ref:x"]],
	])("gives %s the same value or throw on every route", (_, args) => {
		const stdio = ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"];
		const quiet = ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"];
		both(() => gitAnswer(args, { cwd: repo }));
		both(() => gitOutcome(args, [1], repo));
		both(thrown(() => execGit(args, { cwd: repo, encoding: "utf8", stdio })));
		both(thrown(() => execGit(args, { cwd: repo, stdio: quiet })));
		both(spawnFields(() => spawnGitSync(args, { cwd: repo, stdio })));
		both(
			spawnFields(() =>
				spawnGitSync(args, { cwd: repo, encoding: "utf8", stdio: quiet }),
			),
		);
	});

	it("echoes a replayed stderr to a caller naming no stdio, as execFileSync does", () => {
		const args = ["rev-parse", "--verify", "no-such-ref"];
		const written = vi
			.spyOn(fs, "writeSync")
			.mockImplementation((_fd, text) => String(text).length);
		try {
			withGitReadMemo(() => {
				expect(() => execGit(args, { cwd: repo })).toThrow();
				expect(() => execGit(args, { cwd: repo })).toThrow();
			});
			expect(written.mock.calls.filter(([fd]) => fd === 2)).toHaveLength(2);
		} finally {
			written.mockRestore();
		}
	});

	it("gives a git that cannot start the same value or throw on every route", () => {
		vi.stubEnv("WFC_GIT", path.join(dir, "no-such-git"));
		const args = ["rev-parse", "HEAD"];
		both(() => gitAnswer(args, { cwd: repo }));
		both(() => gitOutcome(args, [], repo));
		both(thrown(() => execGit(args, { cwd: repo, stdio: "pipe" })));
		both(spawnFields(() => spawnGitSync(args, { cwd: repo })));
	});

	describe("a read that overruns", () => {
		let hits: () => number;

		beforeEach(() => {
			const slow = writeFaultyGit(
				{ all: true },
				{ sleep: HANG_S },
				{ under: dir },
			);
			hits = slow.hits;
			vi.stubEnv("WFC_GIT", slow.git);
		});

		it(
			"replays the timeout to a caller no more patient, and to gitOutcome as unrun",
			() => {
				const args = ["rev-parse", "HEAD"];
				const [a, b, c] = withGitReadMemo(() => [
					gitAnswer(args, { cwd: repo, timeout: LONGER_WAIT_MS }),
					gitAnswer(args, { cwd: repo, timeout: LONGER_WAIT_MS }),
					gitOutcome(args, [], repo, SHORT_WAIT_MS),
				]);
				expect(a).toEqual({ out: null, timedOut: true });
				expect(b).toEqual(a);
				expect(c).toMatchObject({ ok: false, isUnrun: true });
				expect(hits()).toBe(1);
			},
			LOADED_CASE_MS,
		);

		it(
			"gives a more patient caller its own wait",
			() => {
				const args = ["rev-parse", "HEAD"];
				withGitReadMemo(() => {
					gitAnswer(args, { cwd: repo, timeout: SHORT_WAIT_MS });
					gitAnswer(args, { cwd: repo, timeout: LONGER_WAIT_MS });
				});
				expect(hits()).toBe(2);
			},
			LOADED_CASE_MS,
		);
	});
});
