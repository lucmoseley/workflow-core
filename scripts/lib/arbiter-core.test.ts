// @vitest-environment node
/*
 * arbiter-core.js's own suite — the record-file primitives, the subject
 * vocabulary, the sessions registry and the error log. Everything that must go
 * through a spawned CLI stays in scripts/session-arbiter.test.ts. Split out at
 * mantahostels#1795; the state directory's rulings are mantahostels#205 and #32.
 *
 * Each case runs in arbiter-testkit's sandbox, with `gh` faked and sessions
 * registered by hand, so no case reads or writes the founder's live registry.
 *
 * Every arbiter family and the `lib/file-claim.js` `PreToolUse` core stand on
 * these primitives: loosen a case here and state lands in the wrong directory
 * or a finished session reads as live, so claims block or vanish everywhere.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	AS_ROOT,
	core,
	DEAD,
	durably,
	fakeGh,
	freshSandbox,
	ghCallCount,
	live,
	locks,
	markers,
	noSessions,
	proc,
	readDebtOf,
	registerSession,
	store,
} from "./arbiter-testkit";

const sb = freshSandbox();

/** What the post-write core records on PostToolUse. */
const record = (rel: string, sessionId: string) =>
	store.recordWrite(path.join(sb.repo, rel), sessionId);

/** Put a lock on disk at `rel`, bypassing acquire. */
const put = (rel: string, fields: object) => {
	fs.mkdirSync(store.paths.locksDir(), { recursive: true });
	const p = store.paths.lock(rel);
	fs.writeFileSync(p, JSON.stringify(locks.newLock({ path: rel, ...fields })));
	return p;
};

describe("scope — the prefix rule, not a hand-listed hot set", () => {
	const refused = [
		"docs/doc-map.md",
		"docs/research/x.md",
		".claude/settings.json",
		"CLAUDE.md",
		"AGENTS.md",
	];
	const detected = [
		"scripts/session-arbiter.js",
		"scripts/lib/arbiter-store.js",
		"scripts/evidence-audit.py",
	];
	const uncovered = [
		"app/page.tsx",
		"package.json",
		"docs.md",
		"CLAUDE.md.bak",
	];

	it("refuses on the coordination layer", () => {
		for (const p of refused) expect(store.isGuarded(p)).toBe(true);
	});

	it("never refuses on the detect-only tier", () => {
		for (const p of detected) expect(store.isGuarded(p)).toBe(false);
	});

	it("leaves everything outside both tiers to git", () => {
		for (const p of uncovered) {
			expect(store.isGuarded(p)).toBe(false);
			expect(store.isWatched(p)).toBe(false);
		}
	});

	it("watches both tiers, so the recorder sees scripts/ too", () => {
		for (const p of [...refused, ...detected]) {
			expect(store.isWatched(p)).toBe(true);
		}
	});

	/* The sanctioned scratch directory, out of BOTH tiers — throwaway bytes
	 * carry no work to protect, and the claim they took stranded
	 * (mantahostels#2089, mantahostels#2103). */
	it("takes no claim at all under the sanctioned scratch directory", () => {
		for (const p of [
			".claude/tmp/review-standards.md",
			".claude/tmp/i1965/close.md",
		]) {
			expect(store.isGuarded(p)).toBe(false);
			expect(store.isWatched(p)).toBe(false);
		}
	});

	/* An exempt path takes no NEW claim but must still give back an old one, or
	 * the claims minted before the exemption landed could never be dropped
	 * (mantahostels#2053). This is the pair that distinguishes the two predicates. */
	it("keeps an exempt path releasable though it is not watched", () => {
		expect(store.isWatched(".claude/tmp/review-spec.md")).toBe(false);
		expect(store.isReleasable(".claude/tmp/review-spec.md")).toBe(true);
		// Still nothing outside the tiers: releasable is the union PLUS exempt,
		// never everything.
		expect(store.isReleasable("app/page.tsx")).toBe(false);
		expect(store.isReleasable("scripts/session-arbiter.js")).toBe(true);
	});

	/* `under()` falls back to exact equality for a prefix carrying no trailing
	 * slash, so an EXEMPT entry spelled `.claude/tmp` would exempt the file of
	 * that name and nothing beneath it. This pins the boundary from the other
	 * side: the neighbour whose name merely starts with the prefix. */
	it("exempts the directory, not the name it starts with", () => {
		expect(store.isGuarded(".claude/tmpfile.md")).toBe(true);
		expect(store.isWatched(".claude/tmpfile.md")).toBe(true);
	});

	it("returns null for a path outside the repo", () => {
		expect(store.relativeToRepo("/etc/passwd")).toBeNull();
	});
});

describe("the state directory has a name (mantahostels#205)", () => {
	it("is what locks/, debts/, writes/ and the fail-open log all sit in", () => {
		const dir = store.stateDir();
		for (const p of [
			store.paths.locksDir(),
			store.paths.debtsDir(),
			store.paths.writesDir(),
			store.errorLog(),
		])
			expect(path.dirname(p)).toBe(dir);
	});

	it("sits under the config dir, not in the repo", () => {
		expect(store.stateDir()).not.toBe(sb.repo);
		expect(store.stateDir().startsWith(sb.home)).toBe(true);
	});

	// `seen` is written at module scope on purpose: it is the early capture.
	const seen: string[] = [];
	for (const n of [1, 2]) {
		it(`re-points the testkit handle for every test (${n} of 2)`, () => {
			expect(sb.stateDir()).toBe(store.stateDir());
			expect(sb.errorLog()).toBe(store.errorLog());
			expect(seen).not.toContain(sb.stateDir());
			seen.push(sb.stateDir());
		});
	}
});

describe("repoRoot normalises the trailing slash (mantahostels#1905)", () => {
	/** Call `body` with CLAUDE_PROJECT_DIR set to `dir`, then put it back. */
	const withProjectDir = <T>(dir: string, body: () => T): T => {
		const saved = process.env.CLAUDE_PROJECT_DIR;
		process.env.CLAUDE_PROJECT_DIR = dir;
		try {
			return body();
		} finally {
			if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
			else process.env.CLAUDE_PROJECT_DIR = saved;
		}
	};

	it("answers the same root however the variable is spelled", () => {
		expect(withProjectDir(`${sb.repo}/`, () => store.paths.repoRoot())).toBe(
			withProjectDir(sb.repo, () => store.paths.repoRoot()),
		);
	});

	it("leaves a repo rooted at / alone, which has no slash to spare", () => {
		expect(withProjectDir("/", () => store.paths.repoRoot())).toBe("/");
	});

	/*
	 * The invariant guard-log.sh's header states: the directory gl_log WRITES to
	 * and the one node READS must agree byte for byte, or every fail-open is
	 * filed where check-guard-errors.js never looks.
	 */
	it.each([
		["spelled plainly", ""] as const,
		["spelled with a trailing slash", "/"] as const,
	])(
		"puts gl_log's record where node reads it, with the root %s",
		(_n, sfx) => {
			const dir = sb.repo + sfx;
			execFileSync(
				"bash",
				[
					"-c",
					`source "${path.resolve(__dirname, "guard-log.sh")}" && gl_log "the trailing-slash probe"`,
				],
				{ encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: dir } },
			);
			const written = withProjectDir(dir, () =>
				fs.readFileSync(store.errorLog(), "utf8"),
			);
			expect(written).toContain("the trailing-slash probe");
		},
	);
});

describe("every seat's state lives in the first seat's store (#383)", () => {
	const { projectSlug } = createRequire(import.meta.url)("./project-slug.js");

	const seat = (name: string) => path.join(path.dirname(sb.home), name);
	const stateIn = (dir: string) =>
		path.join(dir, "projects", projectSlug(sb.repo));

	it("resolves the store under the first seat for a session on the second", () => {
		process.env.CLAUDE_CONFIG_DIR = seat(".claude2");
		expect(store.stateDir()).toBe(stateIn(sb.home));
	});

	it("keeps a config dir that is no seat on a store of its own", () => {
		const scratch = path.join(sb.dir, "scratch");
		process.env.CLAUDE_CONFIG_DIR = scratch;
		expect(store.stateDir()).toBe(stateIn(scratch));
	});
});

describe("repoRoot is memoised (mantahostels#1775)", () => {
	/*
	 * The assertion is a COUNT OF `git` INVOCATIONS, not a wall-clock figure. A
	 * stub at WFC_GIT is the only place the count is observable: repoRoot calls
	 * execFileSync directly, and the store is required through createRequire, so
	 * there is nothing to spy on.
	 *
	 * There is no reset seam, so each fork-counting case runs from a cwd it
	 * mkdtemps for itself. That cwd is the memo key, and no earlier test can
	 * have filled it.
	 */
	const stubGit = (dir: string, toplevel: string) => {
		fs.mkdirSync(dir, { recursive: true });
		const bin = path.join(dir, "git");
		const calls = path.join(dir, "git-calls");
		fs.writeFileSync(
			bin,
			`#!/bin/sh\necho x >> ${JSON.stringify(calls)}\necho ${JSON.stringify(toplevel)}\n`,
			{ mode: 0o755 },
		);
		/* A second git, alone on PATH, failing every call into the same log: a
		 * fork that bypasses WFC_GIT is counted too, not served by a real git. */
		const decoys = path.join(dir, "path");
		fs.mkdirSync(decoys, { recursive: true });
		fs.writeFileSync(
			path.join(decoys, "git"),
			`#!/bin/sh\necho x >> ${JSON.stringify(calls)}\nexit 1\n`,
			{ mode: 0o755 },
		);
		return {
			bin,
			decoys,
			count: () =>
				fs.existsSync(calls)
					? fs.readFileSync(calls, "utf8").trim().split("\n").length
					: 0,
		};
	};

	/** Run `body` with CLAUDE_PROJECT_DIR unset, `git` stubbed as `stubGit` returns it, and cwd at `at`. */
	const offTheHookPath = (
		at: string,
		git: { bin: string; decoys: string },
		body: () => void,
	) => {
		const savedCwd = process.cwd();
		const savedProject = process.env.CLAUDE_PROJECT_DIR;
		vi.stubEnv("WFC_GIT", git.bin);
		vi.stubEnv("PATH", git.decoys);
		delete process.env.CLAUDE_PROJECT_DIR;
		process.chdir(at);
		try {
			body();
		} finally {
			process.chdir(savedCwd);
			vi.unstubAllEnvs();
			if (savedProject !== undefined)
				process.env.CLAUDE_PROJECT_DIR = savedProject;
		}
	};

	it("forks git once for many repoRoot calls from one cwd", () => {
		const here = fs.mkdtempSync(path.join(sb.dir, "cwd-a-"));
		const git = stubGit(sb.dir, "/fake/toplevel");
		offTheHookPath(here, git, () => {
			const seen = [
				store.paths.repoRoot(),
				store.paths.repoRoot(),
				store.paths.repoRoot(),
			];
			expect(seen).toEqual([
				"/fake/toplevel",
				"/fake/toplevel",
				"/fake/toplevel",
			]);
		});
		expect(git.count()).toBe(1);
	});

	it("forks again from a different cwd, rather than serving the first answer", () => {
		const a = fs.mkdtempSync(path.join(sb.dir, "cwd-b-"));
		const b = fs.mkdtempSync(path.join(sb.dir, "cwd-c-"));
		const gitA = stubGit(path.join(sb.dir, "ga"), "/top/a");
		const gitB = stubGit(path.join(sb.dir, "gb"), "/top/b");
		offTheHookPath(a, gitA, () => {
			expect(store.paths.repoRoot()).toBe("/top/a");
		});
		offTheHookPath(b, gitB, () => {
			expect(store.paths.repoRoot()).toBe("/top/b");
		});
		expect(gitA.count()).toBe(1);
		expect(gitB.count()).toBe(1);
	});

	it("re-forks after a git that failed, rather than sticking on the fallback", () => {
		const here = fs.mkdtempSync(path.join(sb.dir, "cwd-d-"));
		const dir = path.join(sb.dir, "g-broken");
		fs.mkdirSync(dir, { recursive: true });
		const bin = path.join(dir, "git");
		const calls = path.join(dir, "git-calls");
		fs.writeFileSync(
			bin,
			`#!/bin/sh\necho x >> ${JSON.stringify(calls)}\nexit 1\n`,
			{ mode: 0o755 },
		);
		const count = () =>
			fs.readFileSync(calls, "utf8").trim().split("\n").length;
		offTheHookPath(here, { bin, decoys: dir }, () => {
			expect(store.paths.repoRoot()).toBe(here);
			expect(store.paths.repoRoot()).toBe(here);
			expect(count()).toBe(2);
		});
	});

	it("never forks at all while CLAUDE_PROJECT_DIR is set — the hook path", () => {
		const git = stubGit(path.join(sb.dir, "gh-none"), "/never");
		vi.stubEnv("WFC_GIT", git.bin);
		vi.stubEnv("PATH", git.decoys);
		try {
			expect(store.paths.repoRoot()).toBe(sb.repo);
			expect(store.paths.repoRoot()).toBe(sb.repo);
		} finally {
			vi.unstubAllEnvs();
		}
		expect(git.count()).toBe(0);
	});

	// stateDir carries no memo of its own: it re-reads the config dir on every
	// call, which is what the testkit's per-test re-pointing rests on.
	it("stateDir follows a re-pointed CLAUDE_CONFIG_DIR", () => {
		const first = store.stateDir();
		const elsewhere = path.join(sb.dir, "other-config");
		const saved = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = elsewhere;
		try {
			expect(store.stateDir()).not.toBe(first);
			expect(store.stateDir().startsWith(elsewhere)).toBe(true);
		} finally {
			if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
			else process.env.CLAUDE_CONFIG_DIR = saved;
		}
		expect(store.stateDir()).toBe(first);
	});
});

describe("withGitTimeout bounds the store's git (#2891)", () => {
	/* A git at WFC_GIT that hangs past the bound on every call, tallying each.
	 * The bound is crossed on the real clock, as only a real process can be
	 * killed past it; 200 ms keeps that cheap, and the sleep outlives it. */
	const hangingGit = (dir: string) => {
		fs.mkdirSync(dir, { recursive: true });
		const bin = path.join(dir, "git");
		const calls = path.join(dir, "git-calls");
		fs.writeFileSync(
			bin,
			`#!/bin/sh\necho x >> ${JSON.stringify(calls)}\nexec sleep 30\n`,
			{ mode: 0o755 },
		);
		return {
			bin,
			count: () => fs.readFileSync(calls, "utf8").trim().split("\n").length,
		};
	};

	it("reads a hung root lookup as an overrun, spawning no git after it", () => {
		const here = fs.mkdtempSync(path.join(sb.dir, "cwd-hang-"));
		const git = hangingGit(path.join(sb.dir, "g-hang"));
		const savedCwd = process.cwd();
		const savedProject = process.env.CLAUDE_PROJECT_DIR;
		vi.stubEnv("WFC_GIT", git.bin);
		delete process.env.CLAUDE_PROJECT_DIR;
		process.chdir(here);
		try {
			const { value, overran } = core.withGitTimeout(200, () => [
				core.repoRoot(),
				core.repoRoot(),
				core.git(["status", "--porcelain"]),
			]);
			expect(overran).toBe(true);
			expect(value).toEqual([
				fs.realpathSync(here),
				fs.realpathSync(here),
				null,
			]);
		} finally {
			process.chdir(savedCwd);
			vi.unstubAllEnvs();
			if (savedProject !== undefined)
				process.env.CLAUDE_PROJECT_DIR = savedProject;
		}
		expect(git.count()).toBe(1);
	});

	it("reads a hung git call as an overrun and null, spawning no git after it", () => {
		const git = hangingGit(path.join(sb.dir, "g-hang-call"));
		vi.stubEnv("WFC_GIT", git.bin);
		try {
			const { value, overran } = core.withGitTimeout(200, () => [
				core.git(["status", "--porcelain"]),
				core.gitRaw(["show", "HEAD:a.md"]),
				core.gitIn(["hash-object", "--stdin"], "x"),
			]);
			expect(overran).toBe(true);
			expect(value).toEqual([null, null, null]);
		} finally {
			vi.unstubAllEnvs();
		}
		expect(git.count()).toBe(1);
	});

	it("reports no overrun where git answers inside the bound", () => {
		const { value, overran } = core.withGitTimeout(10_000, () =>
			core.git(["--version"]),
		);
		expect(overran).toBe(false);
		expect(value).toMatch(/^git version /);
	});
});

describe("freshSandbox's setUp callback (mantahostels#205)", () => {
	// Its own sandbox, registered after the file's, so its hook runs last.
	const captured: string[] = [];
	const own = freshSandbox((s) => captured.push(s.stateDir()));

	it("sees the sandbox's state dir, never the developer's real ~/.claude", () => {
		expect(captured.at(-1)?.startsWith(own.home)).toBe(true);
	});
});

describe("one naming scheme, one reader, one writer", () => {
	it("files a lock and a debt for the same path under the same key", () => {
		const a = store.paths.lock("docs/doc-map.md");
		const b = store.paths.debt("docs/doc-map.md");
		// A debt is keyed by (path, issue) since mantahostels#327, so it carries the owner after
		// the shared key rather than being named for the path alone.
		expect(path.basename(b).startsWith(path.basename(a, ".json"))).toBe(true);
		expect(path.dirname(a)).not.toBe(path.dirname(b));
	});

	it("gives two owners of one path two different debt files", () => {
		expect(store.paths.debt("docs/doc-map.md", 308)).not.toBe(
			store.paths.debt("docs/doc-map.md", 323),
		);
		expect(store.paths.debt("docs/doc-map.md", 308)).not.toBe(
			store.paths.debt("docs/doc-map.md"),
		);
	});

	it("gives different paths different names", () => {
		expect(path.basename(store.paths.lock("docs/a.md"))).not.toBe(
			path.basename(store.paths.lock("docs/b.md")),
		);
	});

	it("reads a record that is valid JSON but not an object as nothing", () => {
		// A torn write can leave a bare literal. Returning it would hand a caller a
		// number where it expects a lock, and `lock.pid` on it is undefined rather
		// than an error — so the file would read as a holder nobody can prove dead.
		const f = path.join(sb.dir, "rec.json");
		fs.writeFileSync(f, "5");
		expect(core.readRecord(f)).toBeNull();
		fs.writeFileSync(f, "null");
		expect(core.readRecord(f)).toBeNull();
		fs.writeFileSync(f, "{not json");
		expect(core.readRecord(f)).toBeNull();
	});

	it("round-trips what the writer wrote", () => {
		const f = path.join(sb.dir, "rec.json");
		core.writeRecord(f, { a: 1 });
		expect(core.readRecord(f)).toEqual({ a: 1 });
	});

	it("refuses to overwrite under the wx flag, leaving the first record as it was, which is what makes a stub stick", () => {
		const f = path.join(sb.dir, "rec.json");
		core.writeRecord(f, { first: true }, { flag: "wx" });
		expect(() =>
			core.writeRecord(f, { second: true }, { flag: "wx" }),
		).toThrow();
		expect(core.readRecord(f)).toEqual({ first: true });
	});
});

describe("a store the filesystem refuses — unreadable is not empty (mantahostels#174)", () => {
	const d = AS_ROOT ? describe.skip : describe;

	/** Make `dir` unreadable for the body, then put it back so afterEach can rm it. */
	const sealed = (dir: string, body: () => void) => {
		fs.mkdirSync(dir, { recursive: true });
		fs.chmodSync(dir, 0o000);
		try {
			body();
		} finally {
			fs.chmodSync(dir, 0o755);
		}
	};

	d("the reader", () => {
		it("throws on a refused read, rather than reporting nothing there", () => {
			const f = path.join(sb.dir, "refused.json");
			fs.writeFileSync(f, JSON.stringify({ a: 1 }));
			fs.chmodSync(f, 0o000);
			try {
				expect(() => core.readRecord(f)).toThrow(/EACCES/);
			} finally {
				fs.chmodSync(f, 0o644);
			}
		});

		it("still reads an absent record as null", () => {
			// Absent must stay null or every first claim on a machine becomes a fault.
			expect(
				core.readRecord(path.join(sb.dir, "never-written.json")),
			).toBeNull();
		});
	});

	describe("readRecordOrFlag — absent, present-and-unreadable, told apart (mantahostels#2382)", () => {
		const noPause = () => {
			/* the probes run back to back */
		};

		it("re-probes after the pause, so a TORN record is not called a fault", () => {
			// The pause stands in for the writer finishing.
			const f = path.join(sb.dir, "torn.json");
			fs.writeFileSync(f, "{not json");
			const seen = core.readRecordOrFlag(f, "test", () =>
				fs.writeFileSync(f, JSON.stringify({ a: 1 })),
			);
			expect(seen.unreadable).toBeUndefined();
			expect(seen.record).toEqual({ a: 1 });
		});

		it("calls a record still unparseable after the pause a fault, and logs it", () => {
			const f = path.join(sb.dir, "corrupt.json");
			fs.writeFileSync(f, "{not json");
			const seen = core.readRecordOrFlag(f, "versions corrupt", noPause);
			expect(seen.unreadable).toBe(true);
			expect(seen.reason).toBe("unparseable");
			expect(seen.file).toBe(f);
			expect(fs.readFileSync(core.errorLog(), "utf8")).toContain(
				"versions corrupt",
			);
		});

		it("reads an absent record as absent, never as a fault", () => {
			const seen = core.readRecordOrFlag(
				path.join(sb.dir, "never-written.json"),
				"test",
				noPause,
			);
			expect(seen.unreadable).toBeUndefined();
			expect(seen.record).toBeNull();
		});

		it("does not spend the pause on a record that read first time", () => {
			const f = path.join(sb.dir, "fine.json");
			fs.writeFileSync(f, JSON.stringify({ a: 1 }));
			let paused = 0;
			core.readRecordOrFlag(f, "test", () => {
				paused++;
			});
			expect(paused).toBe(0);
		});

		it.skipIf(AS_ROOT)(
			"reports a refused read as refused, without the pause",
			() => {
				const f = path.join(sb.dir, "refused-flag.json");
				fs.writeFileSync(f, JSON.stringify({ a: 1 }));
				fs.chmodSync(f, 0o000);
				let paused = 0;
				try {
					const seen = core.readRecordOrFlag(f, "test", () => {
						paused++;
					});
					expect(seen.unreadable).toBe(true);
					expect(seen.reason).toBe("refused");
					expect(paused).toBe(0);
				} finally {
					fs.chmodSync(f, 0o644);
				}
			},
		);
	});

	d("acquire", () => {
		it("reports `unknown`, never `claimed`, when it cannot use the store", () => {
			// Fail open (mantahostels#103 §6) — the write is allowed by the caller, because one
			// broken directory must not halt every session at once.
			sealed(store.paths.locksDir(), () => {
				const got = store.acquire("docs/doc-map.md", durably("bob"));
				expect(got.verdict).toBe("unknown");
				expect(got.lock).toBeNull();
			});
		});

		it("reports `unknown` for a session it could not identify either", () => {
			// A session with no live registry entry takes no claim, so it only ever
			// READ the store — and the read came back null, meaning free. This is the
			// branch that raised nothing at all.
			sealed(store.paths.locksDir(), () => {
				expect(
					store.acquire("docs/doc-map.md", {
						sessionId: "bob",
						pid: null,
						procStart: null,
						durable: false,
					}).verdict,
				).toBe("unknown");
			});
		});

		it("logs the fault, so check-guard-errors.js reports the guard is inert", () => {
			sealed(store.paths.locksDir(), () => {
				store.acquire("docs/doc-map.md", durably("bob"));
			});
			expect(fs.readFileSync(store.errorLog(), "utf8")).toMatch(
				/could not use the lock store for docs\/doc-map\.md/,
			);
		});
	});

	d("release", () => {
		it("refuses rather than reporting the claim already gone", () => {
			// A refusal costs only today's behaviour — the claim stands and the next
			// write re-takes it — while "not-held" tells a session its claim is gone
			// when it is not.
			sealed(store.paths.locksDir(), () => {
				expect(store.release("docs/doc-map.md", durably("alice")).verdict).toBe(
					"unreadable",
				);
			});
		});
	});

	d("the listings", () => {
		it("returns null from listLocks, so nothing can print `No files are claimed.`", () => {
			sealed(store.paths.locksDir(), () => {
				expect(store.listLocks()).toBeNull();
			});
		});

		it("still returns [] from listLocks when nothing has ever been claimed", () => {
			// ENOENT is the empty answer and must not become a fault, or a fresh
			// machine reports its lock store broken on day one.
			expect(store.listLocks()).toEqual([]);
		});

		it("reports a single unreadable lock in place rather than dropping it", () => {
			registerSession(sb, "alice", process.pid);
			store.acquire("docs/a-live.md", store.identify("alice"));
			const p = store.paths.lock("docs/a-live.md");
			fs.chmodSync(p, 0o000);
			try {
				const held = store.listLocks();
				expect(held).toHaveLength(1);
				expect(held[0].unreadable).toBe(true);
			} finally {
				fs.chmodSync(p, 0o644);
			}
		});

		it("returns null from listDebts", () => {
			sealed(store.paths.debtsDir(), () => {
				expect(store.listDebts()).toBeNull();
			});
		});

		it("reports a single unreadable debt in place rather than dropping it", () => {
			// Dropping it printed a short list that reads as complete.
			store.registerDenial("docs/doc-map.md");
			const p = store.paths.debt("docs/doc-map.md");
			fs.chmodSync(p, 0o000);
			try {
				const debts = store.listDebts();
				expect(debts).toHaveLength(1);
				expect(debts[0].unreadable).toBe(true);
			} finally {
				fs.chmodSync(p, 0o644);
			}
		});
	});

	d("the debt read path", () => {
		it("warns that a debt exists but could not be read, instead of staying silent", () => {
			// Silence here hands the path to a session that would have been told the
			// work is owned elsewhere.
			store.registerDenial("docs/doc-map.md");
			const p = store.paths.debt("docs/doc-map.md");
			fs.chmodSync(p, 0o000);
			try {
				expect(store.buildDebtNotice("docs/doc-map.md")).toMatch(
					/registered debt that could not be read/,
				);
			} finally {
				fs.chmodSync(p, 0o644);
			}
		});

		it("warns when the whole debt STORE is unreadable, not just one entry", () => {
			// An existsSync pre-check returned false for a debt inside an unreadable
			// directory, so the warning above was unreachable in exactly the case it
			// exists for.
			store.registerDenial("docs/doc-map.md");
			sealed(store.paths.debtsDir(), () => {
				expect(store.buildDebtNotice("docs/doc-map.md")).toMatch(
					/registered debt that could not be read/,
				);
			});
		});

		it("still reports no debt where none was ever registered", () => {
			// A readable store with nothing in it must stay silent, or every claim on
			// the machine carries a debt warning.
			expect(store.buildDebtNotice("docs/doc-map.md")).toBeNull();
		});
	});

	d("the debris sweep", () => {
		it("leaves an aside it cannot read, rather than deleting it on age", () => {
			// An unreadable aside may be a LIVE claim a breaker moved and died before
			// restoring. Deleting it on age drops a lock whose holder is still working.
			fs.mkdirSync(store.paths.locksDir(), { recursive: true });
			const aside = `${store.paths.lock("docs/doc-map.md")}.stale-deadbeef`;
			fs.writeFileSync(
				aside,
				JSON.stringify(locks.newLock({ path: "docs/doc-map.md" })),
			);
			const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
			fs.utimesSync(aside, old, old);
			fs.chmodSync(aside, 0o000);
			try {
				locks.sweepDebris();
				expect(fs.existsSync(aside)).toBe(true);
			} finally {
				fs.chmodSync(aside, 0o644);
			}
		});
	});
});

describe("identify — a session entry with no procStart", () => {
	it("is not durable, and says so in the error log", () => {
		// Liveness is `procStart` recorded at registration, compared against /proc
		// now. Falling back to reading /proc when the entry has none compares that
		// read against ITSELF, so it always matches: a recycled pid then reads
		// durable, and the lock minted on it outlives the session that asked for
		// it, wedging the file for as long as the stranger holding the pid runs.
		// An entry without procStart means a Claude Code that stopped writing it
		// (mantahostels#348) — silent inertness, hence the log.
		fs.writeFileSync(
			path.join(sb.home, "sessions", `${process.pid}.json`),
			JSON.stringify({ pid: process.pid, sessionId: "no-start", cwd: sb.repo }),
		);

		expect(store.identify("no-start").durable).toBe(false);
		const log = fs.readFileSync(store.errorLog(), "utf8");
		expect(log).toContain("procStart");
		// The full path, not the bare `<pid>.json`: two config dirs share one pid
		// namespace, so a basename no longer says which file to open (mantahostels#1309).
		expect(log).toContain(
			path.join(sb.home, "sessions", `${process.pid}.json`),
		);
	});
});

describe("the error log — the only thing that breaks fail-open's silence", () => {
	it("says once per session, not once per write, that a session takes no claims", () => {
		for (let i = 0; i < 5; i++) store.identify("never-registered");
		const lines = fs
			.readFileSync(store.errorLog(), "utf8")
			.split("\n")
			.filter(Boolean);
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("takes no claims");
	});

	it("says it for a session with no registry entry at all, not only a malformed one", () => {
		// The unidentifiable session is the one whose files are unprotected. Logging
		// only the malformed-entry case reported all-clear over a guard doing
		// nothing whenever the entry was simply absent.
		store.identify("never-registered");
		expect(fs.readFileSync(store.errorLog(), "utf8")).toContain(
			"no live session entry",
		);
	});

	it("keeps a path containing a newline on one line", () => {
		store.logError("check docs/a\nb.md", new Error("boom"));
		const lines = fs
			.readFileSync(store.errorLog(), "utf8")
			.split("\n")
			.filter(Boolean);
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("a b.md");
	});

	/*
	 * These four pin the stack-read shapes mantahostels#1460's narrowing distinguishes. One
	 * case would not: every candidate reading agrees on `new Error(...)`, so a
	 * broken narrowing killed no test while that was the only shape covered.
	 */
	/** The single line the log holds, for a test that wrote exactly one. */
	const readLoggedLine = () =>
		fs.readFileSync(store.errorLog(), "utf8").split("\n").find(Boolean) ?? "";

	it("logs an Error's first stack line, not its whole stack", () => {
		/*
		 * The stack is set by hand and the SECOND frame is what the assertion
		 * turns on. Asserting the first frame instead proves nothing: `flat()`
		 * collapses newlines to spaces, so a whole stack still lands on one line
		 * with three tab fields and still contains its own first frame (mantahostels#1460).
		 */
		const err = new Error("boom");
		err.stack = "Error: boom\n    at frameOne\n    at frameTwo";
		store.logError("where", err);
		const line = readLoggedLine();
		expect(line).toContain("Error: boom");
		expect(line).not.toContain("frameTwo");
		expect(line.split("\t").length).toBe(3);
	});

	it('logs the value itself when the stack is null, never the string "null"', () => {
		// What a JSON round-trip of an Error leaves behind, and this store reads
		// its own JSON.
		store.logError("where", { message: "boom", stack: null });
		expect(readLoggedLine()).toContain("[object Object]");
		expect(readLoggedLine()).not.toContain("\tnull");
	});

	it("logs a thrown string as itself", () => {
		store.logError("where", "boom");
		expect(readLoggedLine()).toMatch(/\tboom$/);
	});

	it("logs something rather than nothing when the stack is not a string", () => {
		// This one used to throw inside the template and reach the outer catch,
		// which logged nothing at all.
		store.logError("where", { stack: 123 });
		expect(readLoggedLine()).toContain("[object Object]");
	});

	it("keeps a TAB in a path from shifting the log's fields", () => {
		// The reader splits on tab; an unflattened tab pushes the message into a
		// fourth field it never reads.
		store.logError("check docs/a\tb.md", new Error("boom"));
		const lines = fs
			.readFileSync(store.errorLog(), "utf8")
			.split("\n")
			.filter(Boolean);
		expect(lines[0].split("\t").length).toBe(3);
	});
});

/*
 * mantahostels#1309. This machine runs three Claude plans under three CLAUDE_CONFIG_DIRs, and
 * only `sessions/` is split between them — `projects/<repo>`, where every record
 * a sweep deletes lives, is one directory reached by both. So a registry read
 * scoped to one plan calls the other plan's live sessions finished and deletes
 * their records out of the shared store.
 */
describe("several config dirs — a neighbour plan's sessions registry (mantahostels#1309)", () => {
	/** The config dir the second plan registers under, beside this sandbox's own. */
	const neighbour = () => path.join(path.dirname(sb.home), ".claude2");

	/** The third plan's, beside it. */
	const third = () => path.join(path.dirname(sb.home), ".claude3");

	/** A session registered ONLY in `where`, on a pid that is certainly running. */
	const liveIn = (where: string, sessionId: string) => {
		const dir = path.join(where, "sessions");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, `${process.pid}.json`),
			JSON.stringify({
				pid: process.pid,
				sessionId,
				procStart: proc.readProcStartOf(process.pid),
				status: "idle",
				cwd: sb.repo,
			}),
		);
		return dir;
	};

	/** A session registered ONLY next door, on a pid that is certainly running. */
	const liveNextDoor = (sessionId: string) => liveIn(neighbour(), sessionId);

	/** Since F8 (mantahostels#3515, #2): under .claude/tmp/markers/, not the repo
	 * root directly. */
	const markersDir = () =>
		createRequire(__filename)("./marker-root.js").markersDir(sb.repo);

	/** One backstop marker for `sessionId`, backdated past MARKER_AGE_MS. */
	const agedMarker = (sessionId: string) => {
		const full = path.join(markersDir(), `.concision-base-${sessionId}`);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, "");
		const when = new Date(Date.now() - 25 * 60 * 60 * 1000);
		fs.utimesSync(full, when, when);
		return full;
	};

	it("walks the sibling config dirs alongside its own", () => {
		expect(store.paths.sessionDirs()).toEqual([
			path.join(sb.home, "sessions"),
			path.join(neighbour(), "sessions"),
			path.join(third(), "sessions"),
		]);
	});

	it("lists a dir once when two spellings symlink to the same place", () => {
		// The dedupe is by realpath, not by string: reading one directory under two
		// names would double every entry in the walk.
		fs.symlinkSync(sb.home, neighbour());
		fs.symlinkSync(sb.home, third());

		expect(store.paths.sessionDirs()).toEqual([path.join(sb.home, "sessions")]);
	});

	it("walks its own config dir even when it is named neither sibling", () => {
		// A proving arena or a hand-set CLAUDE_CONFIG_DIR need not be named either.
		const own = path.join(sb.dir, "elsewhere");
		fs.mkdirSync(path.join(own, "sessions"), { recursive: true });
		process.env.CLAUDE_CONFIG_DIR = own;

		expect(store.paths.sessionDirs()[0]).toBe(path.join(own, "sessions"));
	});

	it("spares the markers of a session only the neighbour registry knows", () => {
		agedMarker("nextdoor");
		liveNextDoor("nextdoor");

		markers.pruneMarkers();

		expect(
			fs.existsSync(path.join(markersDir(), ".concision-base-nextdoor")),
		).toBe(true);
	});

	it("spares the markers of a session only the THIRD plan's registry knows", () => {
		// The third dir is otherwise proven only by path equality, and a swept
		// marker under a live session is the failure the union exists to stop.
		agedMarker("thirdplan");
		liveIn(third(), "thirdplan");

		markers.pruneMarkers();

		expect(
			fs.existsSync(path.join(markersDir(), ".concision-base-thirdplan")),
		).toBe(true);
	});

	it("spares the snapshot of a session only the neighbour registry knows", () => {
		// Sweeping under a live session makes its next Bash call read the whole
		// tier as unknown.
		fs.mkdirSync(store.paths.snapshotsDir(), { recursive: true });
		fs.writeFileSync(
			store.paths.snapshot("nextdoor"),
			"deadbeef scripts/x.py\n",
		);
		const when = Date.now() - 8 * 24 * 60 * 60 * 1000;
		fs.utimesSync(store.paths.snapshot("nextdoor"), when / 1000, when / 1000);
		liveNextDoor("nextdoor");

		store.pruneAll(noSessions);

		expect(fs.existsSync(store.paths.snapshot("nextdoor"))).toBe(true);
	});

	it("spares the ledger of a session only the neighbour registry knows", () => {
		record("docs/theirs.md", "nextdoor");
		const when = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
		fs.utimesSync(store.paths.ledger("nextdoor"), when, when);
		liveNextDoor("nextdoor");

		record("docs/first.md", "first-writer"); // a first write runs the sweep

		expect(fs.existsSync(store.paths.ledger("nextdoor"))).toBe(true);
	});

	it("calls a resumed holder registered next door live, not stale", () => {
		put("docs/resumed.md", { sessionId: "nextdoor", ...DEAD });
		liveNextDoor("nextdoor");

		expect(
			store
				.listLocks()
				.find((l: { path: string }) => l.path === "docs/resumed.md")?.alive,
		).toBe(true);
	});

	it("sweeps as before when no neighbour config dir exists at all", () => {
		agedMarker("ghost");

		markers.pruneMarkers();

		expect(
			fs.existsSync(path.join(markersDir(), ".concision-base-ghost")),
		).toBe(false);
	});

	it.skipIf(AS_ROOT)(
		"deletes nothing when the NEIGHBOUR registry cannot be read",
		() => {
			// A partial union is the silent-half-read failure mantahostels#1309 ruled worse than
			// a documented single read, so one unreadable registry stops the sweep.
			agedMarker("ghost");
			const dir = liveNextDoor("nextdoor");
			fs.chmodSync(dir, 0o000);
			try {
				markers.pruneMarkers();
			} finally {
				fs.chmodSync(dir, 0o755);
			}

			expect(
				fs.existsSync(path.join(markersDir(), ".concision-base-ghost")),
			).toBe(true);
		},
	);

	it("takes the set from WFC_CLAUDE_CONFIG_A, _B and _C when all are set", () => {
		const a = path.join(sb.dir, "plan-a");
		const b = path.join(sb.dir, "plan-b");
		const c = path.join(sb.dir, "plan-c");
		process.env.WFC_CLAUDE_CONFIG_A = a;
		process.env.WFC_CLAUDE_CONFIG_B = b;
		process.env.WFC_CLAUDE_CONFIG_C = c;

		expect(store.paths.sessionDirs()).toEqual([
			path.join(sb.home, "sessions"),
			path.join(a, "sessions"),
			path.join(b, "sessions"),
			path.join(c, "sessions"),
		]);
	});

	it("still defaults _B and _C when only WFC_CLAUDE_CONFIG_A is set", () => {
		// Each knob falls back on its own, the spelling claude-agents-union uses.
		// Defaulting them together would let the agents oracle and this reader
		// disagree about which plans exist, on one set of env vars.
		process.env.WFC_CLAUDE_CONFIG_A = path.join(sb.dir, "plan-a");

		expect(store.paths.sessionDirs()).toEqual([
			path.join(sb.home, "sessions"),
			path.join(sb.dir, "plan-a", "sessions"),
			path.join(neighbour(), "sessions"),
			path.join(third(), "sessions"),
		]);
	});

	/*
	 * `null` means opposite things to a sweep and to the lock-break path: the
	 * sweep holds off, the break path goes AHEAD and takes the lock (mantahostels#104). So the
	 * union's failure direction is per-caller, or a neighbour's permissions cost a
	 * live session its claim.
	 */
	describe("an unreadable registry, off the sweep path", () => {
		const aliveOf = (rel: string) =>
			store.listLocks().find((l: { path: string }) => l.path === rel)?.alive;

		/** A config dir whose sessions registry refuses to open. */
		const sealed = () => {
			const dir = path.join(sb.dir, "unreadable");
			fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
			process.env.WFC_CLAUDE_CONFIG_A = dir;
			return path.join(dir, "sessions");
		};

		it.skipIf(AS_ROOT)(
			"still calls a resumed holder registered next door LIVE",
			() => {
				// listLocks reaches resumedHolderTest, whose `false` prints STALE —
				// which reads as free, so nothing then refuses a write to that file.
				put("docs/resumed.md", { sessionId: "nextdoor", ...DEAD });
				liveNextDoor("nextdoor");
				const dir = sealed();

				fs.chmodSync(dir, 0o000);
				try {
					expect(aliveOf("docs/resumed.md")).toBe(true);
				} finally {
					fs.chmodSync(dir, 0o755);
				}
			},
		);

		it("is never consulted to identify this session at all", () => {
			// identify reads its own config dir alone — a session's entry is always
			// written under its own CLAUDE_CONFIG_DIR, so this arrangement cannot
			// occur in life. Without this test, widening identify back to every
			// registry makes the per-write hot path pay for a walk it cannot use.
			liveNextDoor("only-next-door");

			expect(store.identify("only-next-door").durable).toBe(false);
		});

		it.skipIf(AS_ROOT)(
			"leaves this session identifiable, so it keeps claiming",
			() => {
				// identify reads its OWN registry alone: a neighbour's permissions must
				// not fire "this session takes no claims and its files are unprotected".
				live(sb, "alice");
				const dir = sealed();

				fs.chmodSync(dir, 0o000);
				try {
					expect(store.identify("alice").durable).toBe(true);
				} finally {
					fs.chmodSync(dir, 0o755);
				}
			},
		);
	});
});

/*
 * Findings from the mantahostels#970 code review. Each names the defect it closes: without
 * the fix these all fail SILENTLY, which is why they are pinned here.
 */
describe("subject handling — review findings", () => {
	const docMap = "docs/doc-map.md";

	it("keeps the region out of the write ledger, which names files", () => {
		// The guard-commit-form core compares the ledger against staged paths, and git
		// stages no region — so an unstripped subject warns the session off its own
		// commit as "a path this session never wrote".
		store.recordWrite(path.join(sb.repo, `${docMap}#B42`), "alice");
		expect(store.readWritesBy("alice")).toEqual([docMap]);
	});

	it("reads a `#` in a real filename as part of the name, not as a region", () => {
		// splitSubject splits on the first `#`; without the isRegioned test a real
		// docs/plan#1.md becomes region `1.md` of a file `docs/plan`, and every
		// filesystem call then runs against a path that does not exist.
		expect(store.splitSubject("docs/plan#1.md")).toEqual({
			rel: "docs/plan#1.md",
			region: null,
		});
		expect(store.subjectPath("docs/plan#1.md")).toBe("docs/plan#1.md");
		// The regioned path still splits.
		expect(store.splitSubject(`${docMap}#B42`)).toEqual({
			rel: docMap,
			region: "B42",
		});
	});

	it("finds a Bash-route baseline recorded under the plain path from a region claim", () => {
		// The mantahostels#419 scan mints observations per FILE — it knows no regions — so a
		// region-keyed lookup would never find one, silently dropping the
		// second-writer clobber cover on the one file this change made concurrent.
		execFileSync("git", ["init", "-q"], { cwd: sb.repo });
		// A head section, so region B1's bytes are NOT the file's bytes — with a
		// single-entry fixture the two hashes agree and the test cannot tell a
		// whole-file baseline from a region one.
		const body = (entry: string) =>
			`# map\n\nv1.0 · 21 August 2026\n\n## Section B\n\n### B1 · One\n\n${entry}\n`;
		fs.writeFileSync(path.join(sb.repo, docMap), body("body"));
		registerSession(sb, "alice", process.pid);
		const me = store.identify("alice");
		store.recordObservation(docMap, me, { viaBash: true });
		// Untouched, the region lookup must find that whole-file baseline and read
		// SAME. Compared against the region's bytes instead it reads "changed" on a
		// file nobody has touched — a clobber report on every write.
		expect(store.observationState(`${docMap}#B1`, "alice").state).toBe("same");
		fs.writeFileSync(path.join(sb.repo, docMap), body("clobbered"));
		expect(store.observationState(`${docMap}#B1`, "alice").state).toBe(
			"changed",
		);
	});

	it("warns a region claimant about a debt registered on the whole file, naming its issue", () => {
		// Every debt registered before this change is keyed on the plain path, and
		// draining that queue is the change's entire purpose.
		store.ownDebt(docMap, 123, "an edit owed on this file");
		const notice = store.buildDebtNotice(`${docMap}#B42`);
		expect(notice).toContain("123");
	});

	it("keeps the write side keyed exactly, so a denial writes its own stub", () => {
		// The read widening must not reach registerDenial, or a region denial would
		// see the file's stub and record nothing of its own.
		store.ownDebt(docMap, 123, "a file-level debt");
		store.registerDenial(`${docMap}#B42`);
		/* The unowned stub sits on the region alone, none on the file. */
		expect(readDebtOf(`${docMap}#B42`)).not.toBeNull();
		expect(readDebtOf(docMap)).toBeNull();
	});

	it("refreshes the whole-file pin as well as the regions a session holds", () => {
		// A session can hold both — a Write with no anchor, then an Edit with one.
		// Refreshing only the regions freezes the file-wide claim's recovery bytes
		// at the moment the first region was taken.
		execFileSync("git", ["init", "-q"], { cwd: sb.repo });
		fs.writeFileSync(path.join(sb.repo, docMap), "### B1 · One\n\nbody\n");
		registerSession(sb, "alice", process.pid);
		const me = store.identify("alice");
		store.acquire(docMap, me);
		store.acquire(`${docMap}#B1`, me);
		store.recordContent(docMap, me);
		const held = store.listLocks() as Array<{ path: string; blob: string }>;
		expect(held).toHaveLength(2);
		for (const l of held) expect(l.blob).toBeTruthy();
	});

	it("caps the debt list, own-subject entries first, when a file carries dozens", () => {
		// docs/doc-map.md carried 46 file-level entries the day region claims
		// landed, and every one rides along with any region claim on that file —
		// uncapped, they bury the claim's own debt under a queue about other
		// entries.
		for (let i = 0; i < 12; i++)
			store.ownDebt(docMap, 500 + i, `a file-level debt ${i}`);
		store.ownDebt(`${docMap}#B42`, 999, "the debt on this very entry");
		const notice = store.buildDebtNotice(`${docMap}#B42`);
		expect(notice).toContain("#999");
		expect(notice).toContain("more: node scripts/session-arbiter.js debt list");
		expect(notice.split("\n").length).toBeLessThan(14);
	});

	it("looks nothing up on GitHub, its own debts included (mantahostels#1251)", () => {
		// Region claims once skipped their inherited entries' lookups to stay inside
		// the guard's 5s timeout. Nothing is looked up now, so the flag is gone.
		fakeGh(sb, JSON.stringify({ state: "OPEN" }));
		for (let i = 0; i < 5; i++)
			store.ownDebt(docMap, 600 + i, `file debt ${i}`);
		store.ownDebt(`${docMap}#B42`, 700, "this entry's own debt");
		store.buildDebtNotice(`${docMap}#B42`);
		expect(ghCallCount(sb)).toBe(0);
	});

	it("does not call a file unclaimed while a neighbour holds a region of it", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", process.ppid);
		store.acquire(`${docMap}#B1`, store.identify("alice"));
		const mine = store.acquire(`${docMap}#B2`, store.identify("bob"));
		expect(
			store.liveClaimElsewhereOnFile(`${docMap}#B2`, mine.lock.claimId),
		).toBe(true);
		// And nothing at all on a file nobody holds.
		expect(store.liveClaimElsewhereOnFile("docs/other.md", null)).toBe(false);
	});
});
