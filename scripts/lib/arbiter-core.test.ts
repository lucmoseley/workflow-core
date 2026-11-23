// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { assert, describe, expect, it, vi } from "vitest";
import {
	AS_ROOT,
	core,
	DEAD,
	durably,
	freshSandbox,
	listedLocks,
	live,
	lockRecord,
	markers,
	noSessions,
	proc,
	registerSession,
	store,
} from "./arbiter-testkit";
import { noop } from "./noop.js";
import { shellQuote } from "./sh-quote.js";

const sb = freshSandbox();

const record = (rel: string, sessionId: string) =>
	store.recordWrite(path.join(sb.repo, rel), sessionId);

const put = (rel: string, fields: object) => {
	fs.mkdirSync(store.paths.locksDir(), { recursive: true });
	const p = store.paths.lock(rel);
	fs.writeFileSync(p, JSON.stringify(lockRecord({ path: rel, ...fields })));
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
		for (const p of refused) expect(store.isWarned(p)).toBe(true);
	});

	it("never refuses on the detect-only tier", () => {
		for (const p of detected) expect(store.isWarned(p)).toBe(false);
	});

	it("leaves everything outside both tiers to git", () => {
		for (const p of uncovered) {
			expect(store.isWarned(p)).toBe(false);
			expect(store.isWatched(p)).toBe(false);
		}
	});

	it("watches both tiers, so the recorder sees scripts/ too", () => {
		for (const p of [...refused, ...detected]) {
			expect(store.isWatched(p)).toBe(true);
		}
	});

	it("takes no claim at all under the sanctioned scratch directory", () => {
		for (const p of [
			".claude/tmp/review-standards.md",
			".claude/tmp/i1965/close.md",
		]) {
			expect(store.isWarned(p)).toBe(false);
			expect(store.isWatched(p)).toBe(false);
		}
	});

	it("keeps an exempt path releasable though it is not watched", () => {
		expect(store.isWatched(".claude/tmp/review-spec.md")).toBe(false);
		expect(store.isReleasable(".claude/tmp/review-spec.md")).toBe(true);
		expect(store.isReleasable("app/page.tsx")).toBe(false);
		expect(store.isReleasable("scripts/session-arbiter.js")).toBe(true);
	});

	it("exempts the directory, not the name it starts with", () => {
		expect(store.isWarned(".claude/tmpfile.md")).toBe(true);
		expect(store.isWatched(".claude/tmpfile.md")).toBe(true);
	});

	it("returns null for a path outside the repo", () => {
		expect(store.claimKey("/etc/passwd")).toBeNull();
	});
});

describe("the state directory has a name (mantahostels#205)", () => {
	it("is what locks/, writes/ and the fail-open log all sit in", () => {
		const dir = store.stateDir();
		for (const p of [
			store.paths.locksDir(),
			store.paths.writesDir(),
			store.errorLog(),
		])
			expect(path.dirname(p)).toBe(dir);
	});

	it("sits under the config dir, not in the repo", () => {
		expect(store.stateDir()).not.toBe(sb.repo);
		expect(store.stateDir().startsWith(sb.home)).toBe(true);
	});

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
	const withProjectDir = <T>(dir: string, body: () => T): T => {
		vi.stubEnv("CLAUDE_PROJECT_DIR", dir);
		return body();
	};

	it("answers the same root however the variable is spelled", () => {
		expect(withProjectDir(`${sb.repo}/`, () => store.paths.repoRoot())).toBe(
			withProjectDir(sb.repo, () => store.paths.repoRoot()),
		);
	});

	it("leaves a repo rooted at / alone, which has no slash to spare", () => {
		expect(withProjectDir("/", () => store.paths.repoRoot())).toBe("/");
	});

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
					`source ${shellQuote(path.resolve(__dirname, "guard-log.sh"))} && gl_log "the trailing-slash probe"`,
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
		vi.stubEnv("CLAUDE_CONFIG_DIR", seat(".claude2"));
		expect(store.stateDir()).toBe(stateIn(sb.home));
	});

	it("resolves an overflow launch on the second seat's dir to the first seat's store (#3701)", () => {
		const home = path.dirname(sb.home);
		fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".claude", "refill-seats"),
			"~/.claude2\n~/.claude2 api key=WFC_TEST_KEY grant=200 cycle-day=20\n",
		);
		vi.stubEnv("CLAUDE_CONFIG_DIR", seat(".claude2"));
		vi.stubEnv("WFC_SEAT_KEY", "WFC_TEST_KEY");
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", undefined);
		expect(store.stateDir()).toBe(stateIn(sb.home));
	});

	it("keeps a config dir that is no seat on a store of its own", () => {
		const scratch = path.join(sb.dir, "scratch");
		vi.stubEnv("CLAUDE_CONFIG_DIR", scratch);
		expect(store.stateDir()).toBe(stateIn(scratch));
	});
});

describe("repoRoot is memoised (mantahostels#1775)", () => {
	const stubGit = (dir: string, toplevel: string) => {
		fs.mkdirSync(dir, { recursive: true });
		const bin = path.join(dir, "git");
		const calls = path.join(dir, "git-calls");
		fs.writeFileSync(
			bin,
			`#!/bin/sh\necho x >> ${shellQuote(calls)}\necho ${shellQuote(toplevel)}\n`,
			{ mode: 0o755 },
		);
		const decoys = path.join(dir, "path");
		fs.mkdirSync(decoys, { recursive: true });
		fs.writeFileSync(
			path.join(decoys, "git"),
			`#!/bin/sh\necho x >> ${shellQuote(calls)}\nexit 1\n`,
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

	const offTheHookPath = (
		at: string,
		git: { bin: string; decoys: string },
		body: () => void,
	) => {
		const savedCwd = process.cwd();
		vi.stubEnv("WFC_GIT", git.bin);
		vi.stubEnv("PATH", git.decoys);
		vi.stubEnv("CLAUDE_PROJECT_DIR", undefined);
		process.chdir(at);
		try {
			body();
		} finally {
			process.chdir(savedCwd);
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
			`#!/bin/sh\necho x >> ${shellQuote(calls)}\nexit 1\n`,
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
		expect(store.paths.repoRoot()).toBe(sb.repo);
		expect(store.paths.repoRoot()).toBe(sb.repo);
		expect(git.count()).toBe(0);
	});

	it("stateDir follows a re-pointed CLAUDE_CONFIG_DIR", () => {
		const first = store.stateDir();
		const elsewhere = path.join(sb.dir, "other-config");
		vi.stubEnv("CLAUDE_CONFIG_DIR", elsewhere);
		expect(store.stateDir()).not.toBe(first);
		expect(store.stateDir().startsWith(elsewhere)).toBe(true);
		vi.stubEnv("CLAUDE_CONFIG_DIR", sb.home);
		expect(store.stateDir()).toBe(first);
	});
});

describe("withGitTimeout bounds the store's git (#2891)", () => {
	const hangingGit = (dir: string) => {
		fs.mkdirSync(dir, { recursive: true });
		const bin = path.join(dir, "git");
		const calls = path.join(dir, "git-calls");
		fs.writeFileSync(
			bin,
			`#!/bin/sh\necho x >> ${shellQuote(calls)}\nexec sleep 30\n`,
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
		vi.stubEnv("WFC_GIT", git.bin);
		vi.stubEnv("CLAUDE_PROJECT_DIR", undefined);
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
		}
		expect(git.count()).toBe(1);
	});

	it("reads a hung git call as an overrun and null, spawning no git after it", () => {
		const git = hangingGit(path.join(sb.dir, "g-hang-call"));
		vi.stubEnv("WFC_GIT", git.bin);
		const { value, overran } = core.withGitTimeout(200, () => [
			core.git(["status", "--porcelain"]),
			core.subjectDirty("docs/doc-map.md#B1"),
			core.gitIn(["hash-object", "--stdin"], "x"),
		]);
		expect(overran).toBe(true);
		expect(value).toEqual([null, null, null]);
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
	const captured: string[] = [];
	const own = freshSandbox((s) => captured.push(s.stateDir()));

	it("sees the sandbox's state dir, never the developer's real ~/.claude", () => {
		expect(captured.at(-1)?.startsWith(own.home)).toBe(true);
	});
});

describe("one naming scheme, one reader, one writer", () => {
	it("files a lock and a break for the same path under the same key", () => {
		const a = store.paths.lock("docs/doc-map.md");
		const b = store.paths.break("docs/doc-map.md", "claim-1");
		expect(path.basename(b).startsWith(path.basename(a, ".json"))).toBe(true);
		expect(path.dirname(a)).not.toBe(path.dirname(b));
	});

	it("gives different paths different names", () => {
		expect(path.basename(store.paths.lock("docs/a.md"))).not.toBe(
			path.basename(store.paths.lock("docs/b.md")),
		);
	});

	it("reads a record that is valid JSON but not an object as nothing", () => {
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
			expect(
				core.readRecord(path.join(sb.dir, "never-written.json")),
			).toBeNull();
		});
	});

	describe("readRecordOrFlag — absent, present-and-unreadable, told apart (mantahostels#2382)", () => {
		const noPause = noop;

		it("re-probes after the pause, so a TORN record is not called a fault", () => {
			const f = path.join(sb.dir, "torn.json");
			fs.writeFileSync(f, "{not json");
			const seen = core.readRecordOrFlag(f, "test", () =>
				fs.writeFileSync(f, JSON.stringify({ a: 1 })),
			);
			expect(seen.unreadable).toBeUndefined();
			assert(!seen.unreadable);
			expect(seen.record).toEqual({ a: 1 });
		});

		it("calls a record still unparseable after the pause a fault, and logs it", () => {
			const f = path.join(sb.dir, "corrupt.json");
			fs.writeFileSync(f, "{not json");
			const seen = core.readRecordOrFlag(f, "versions corrupt", noPause);
			expect(seen.unreadable).toBe(true);
			assert(seen.unreadable);
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
			assert(!seen.unreadable);
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
					assert(seen.unreadable);
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
			sealed(store.paths.locksDir(), () => {
				const got = store.acquire("docs/doc-map.md", durably("bob"));
				expect(got.verdict).toBe("unknown");
				expect(got.lock).toBeNull();
			});
		});

		it("reports `unknown` for a session it could not identify either", () => {
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
			expect(store.listLocks()).toEqual([]);
		});

		it("reports a single unreadable lock in place rather than dropping it", () => {
			registerSession(sb, "alice", process.pid);
			store.acquire("docs/a-live.md", store.identify("alice"));
			const p = store.paths.lock("docs/a-live.md");
			fs.chmodSync(p, 0o000);
			try {
				const held = store.listLocks();
				assert(held);
				expect(held).toHaveLength(1);
				expect(held[0].unreadable).toBe(true);
			} finally {
				fs.chmodSync(p, 0o644);
			}
		});
	});

	d("the debris sweep", () => {
		it("leaves an aside it cannot read, rather than deleting it on age", () => {
			fs.mkdirSync(store.paths.locksDir(), { recursive: true });
			const aside = `${store.paths.lock("docs/doc-map.md")}.stale-deadbeef`;
			fs.writeFileSync(
				aside,
				JSON.stringify(lockRecord({ path: "docs/doc-map.md" })),
			);
			const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
			fs.utimesSync(aside, old, old);
			fs.chmodSync(aside, 0o000);
			try {
				store.acquire("docs/swept.md", {
					sessionId: "sweeper",
					pid: null,
					procStart: null,
					durable: false,
				});
				expect(fs.existsSync(aside)).toBe(true);
			} finally {
				fs.chmodSync(aside, 0o644);
			}
		});
	});
});

describe("identify — a session entry with no procStart", () => {
	it("is not durable, and says so in the error log", () => {
		fs.writeFileSync(
			path.join(sb.home, "sessions", `${process.pid}.json`),
			JSON.stringify({ pid: process.pid, sessionId: "no-start", cwd: sb.repo }),
		);

		expect(store.identify("no-start").durable).toBe(false);
		const log = fs.readFileSync(store.errorLog(), "utf8");
		expect(log).toContain("procStart");
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

	const readLoggedLine = () =>
		fs.readFileSync(store.errorLog(), "utf8").split("\n").find(Boolean) ?? "";

	it("logs an Error's first stack line, not its whole stack", () => {
		const err = new Error("boom");
		err.stack = "Error: boom\n    at frameOne\n    at frameTwo";
		store.logError("where", err);
		const line = readLoggedLine();
		expect(line).toContain("Error: boom");
		expect(line).not.toContain("frameTwo");
		expect(line.split("\t").length).toBe(3);
	});

	it('logs the value itself when the stack is null, never the string "null"', () => {
		store.logError("where", { message: "boom", stack: null });
		expect(readLoggedLine()).toContain("[object Object]");
		expect(readLoggedLine()).not.toContain("\tnull");
	});

	it("logs a thrown string as itself", () => {
		store.logError("where", "boom");
		expect(readLoggedLine()).toMatch(/\tboom$/);
	});

	it("logs something rather than nothing when the stack is not a string", () => {
		store.logError("where", { stack: 123 });
		expect(readLoggedLine()).toContain("[object Object]");
	});

	it("keeps a TAB in a path from shifting the log's fields", () => {
		store.logError("check docs/a\tb.md", new Error("boom"));
		const lines = fs
			.readFileSync(store.errorLog(), "utf8")
			.split("\n")
			.filter(Boolean);
		expect(lines[0].split("\t").length).toBe(3);
	});

	it("collapses a tab or newline in a record's detail, so it can neither shift a field nor forge a record (#320)", () => {
		store.logError("where", "what broke", 'target=-C "a\tb\nc" pwd=/p');
		const lines = fs
			.readFileSync(store.errorLog(), "utf8")
			.split("\n")
			.filter(Boolean);
		expect(lines).toHaveLength(1);
		expect(lines[0].split("\t").slice(1)).toEqual([
			"where",
			"what broke",
			'target=-C "a b c" pwd=/p',
		]);
	});
});

describe("several config dirs — a neighbour plan's sessions registry (mantahostels#1309)", () => {
	const neighbour = () => path.join(path.dirname(sb.home), ".claude2");

	const third = () => path.join(path.dirname(sb.home), ".claude3");

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

	const liveNextDoor = (sessionId: string) => liveIn(neighbour(), sessionId);

	const markersDir = () =>
		createRequire(__filename)("./marker-root.js").markersDir(sb.repo);

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
		fs.symlinkSync(sb.home, neighbour());
		fs.symlinkSync(sb.home, third());

		expect(store.paths.sessionDirs()).toEqual([path.join(sb.home, "sessions")]);
	});

	it("walks its own config dir even when it is named neither sibling", () => {
		const own = path.join(sb.dir, "elsewhere");
		fs.mkdirSync(path.join(own, "sessions"), { recursive: true });
		vi.stubEnv("CLAUDE_CONFIG_DIR", own);

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
		agedMarker("thirdplan");
		liveIn(third(), "thirdplan");

		markers.pruneMarkers();

		expect(
			fs.existsSync(path.join(markersDir(), ".concision-base-thirdplan")),
		).toBe(true);
	});

	it("spares the snapshot of a session only the neighbour registry knows", () => {
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

		record("docs/first.md", "first-writer");

		expect(fs.existsSync(store.paths.ledger("nextdoor"))).toBe(true);
	});

	it("calls a resumed holder registered next door live, not stale", () => {
		put("docs/resumed.md", { sessionId: "nextdoor", ...DEAD });
		liveNextDoor("nextdoor");

		expect(listedLocks().find((l) => l.path === "docs/resumed.md")?.alive).toBe(
			true,
		);
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
		vi.stubEnv("WFC_CLAUDE_CONFIG_A", a);
		vi.stubEnv("WFC_CLAUDE_CONFIG_B", b);
		vi.stubEnv("WFC_CLAUDE_CONFIG_C", c);

		expect(store.paths.sessionDirs()).toEqual([
			path.join(sb.home, "sessions"),
			path.join(a, "sessions"),
			path.join(b, "sessions"),
			path.join(c, "sessions"),
		]);
	});

	it("still defaults _B and _C when only WFC_CLAUDE_CONFIG_A is set", () => {
		vi.stubEnv("WFC_CLAUDE_CONFIG_A", path.join(sb.dir, "plan-a"));

		expect(store.paths.sessionDirs()).toEqual([
			path.join(sb.home, "sessions"),
			path.join(sb.dir, "plan-a", "sessions"),
			path.join(neighbour(), "sessions"),
			path.join(third(), "sessions"),
		]);
	});

	describe("an unreadable registry, off the sweep path", () => {
		const aliveOf = (rel: string) =>
			listedLocks().find((l) => l.path === rel)?.alive;

		const sealed = () => {
			const dir = path.join(sb.dir, "unreadable");
			fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
			vi.stubEnv("WFC_CLAUDE_CONFIG_A", dir);
			return path.join(dir, "sessions");
		};

		it.skipIf(AS_ROOT)(
			"still calls a resumed holder registered next door LIVE",
			() => {
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
			liveNextDoor("only-next-door");

			expect(store.identify("only-next-door").durable).toBe(false);
		});

		it.skipIf(AS_ROOT)(
			"leaves this session identifiable, so it keeps claiming",
			() => {
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

describe("subject handling — review findings", () => {
	const docMap = "docs/doc-map.md";

	it("keeps the region out of the write ledger, which names files", () => {
		store.recordWrite(path.join(sb.repo, `${docMap}#B42`), "alice");
		expect(store.readWritesBy("alice")).toEqual([docMap]);
	});

	it("reads a `#` in a real filename as part of the name, not as a region", () => {
		expect(store.splitSubject("docs/plan#1.md")).toEqual({
			rel: "docs/plan#1.md",
			region: null,
		});
		expect(store.subjectPath("docs/plan#1.md")).toBe("docs/plan#1.md");
		expect(store.splitSubject(`${docMap}#B42`)).toEqual({
			rel: docMap,
			region: "B42",
		});
	});

	it("finds a Bash-route baseline recorded under the plain path from a region claim", () => {
		execFileSync("git", ["init", "-q"], { cwd: sb.repo });
		const body = (entry: string) =>
			`# map\n\nv1.0 · 21 August 2026\n\n## Section B\n\n### B1 · One\n\n${entry}\n`;
		fs.writeFileSync(path.join(sb.repo, docMap), body("body"));
		registerSession(sb, "alice", process.pid);
		const me = store.identify("alice");
		store.recordObservation(docMap, me, { viaBash: true });
		expect(store.observationState(`${docMap}#B1`, "alice").state).toBe("same");
		fs.writeFileSync(path.join(sb.repo, docMap), body("clobbered"));
		expect(store.observationState(`${docMap}#B1`, "alice").state).toBe(
			"changed",
		);
	});

	it("refreshes the whole-file pin as well as the regions a session holds", () => {
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

	it("does not call a file unclaimed while a neighbour holds a region of it", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", process.ppid);
		store.acquire(`${docMap}#B1`, store.identify("alice"));
		const mine = store.acquire(`${docMap}#B2`, store.identify("bob"));
		expect(
			store.liveClaimElsewhereOnFile(`${docMap}#B2`, mine.lock.claimId),
		).toBe(true);
		expect(store.liveClaimElsewhereOnFile("docs/other.md", null)).toBe(false);
	});
});
