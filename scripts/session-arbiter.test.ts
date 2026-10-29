// @vitest-environment node
/*
 * The CLI's own suite: stdout shapes the hook actually reads, exit codes the
 * shell scripts branch on, argv parsing, and the once-per-PROCESS behaviour a
 * direct call on the store cannot exercise.
 *
 * The store is imported here only to ARRANGE state.
 *
 * The subcommands are the arbiter's whole production interface
 * (mantahostels#158), so cases run the CLI in-process inside a sandbox repo
 * and spawn a real process only where once-per-process or liveness is the
 * point. `scripts/lib/file-claim.js`'s `PreToolUse` core and
 * `.husky/post-commit` branch on this output: loosen a case and a live
 * neighbour's file is clobbered unrefused, or every guarded write is refused.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	AS_ROOT,
	commitAll,
	core,
	fakeGh,
	freshSandbox,
	ghAnswers,
	ghCallCount,
	ghClosedList,
	gitRepo,
	live,
	proc,
	readDebtOf,
	registerSession,
	SCRIPT,
	store,
} from "./lib/arbiter-testkit";
import { throughFullPipe } from "./lib/full-pipe-testkit";
import { shellQuote, writeFaultyGit } from "./lib/git-fault-fake";
import { runCore } from "./lib/guard-core-testkit";
import { cutInReplay, cutShellFunction } from "./lib/precommit-gate-testkit";
import { runInProcess } from "./lib/run-in-process";

/* The breadcrumb directory, from the module that owns it (mantahostels#3382). */
const hookRecord = createRequire(__filename)("./lib/hook-record.js");
const markerRoot = createRequire(__filename)("./lib/marker-root.js");
const { attributeDirty } = createRequire(__filename)("./lib/own-selection.js");

const sb = freshSandbox();

const cli = (args: string[], env: Record<string, string> = {}) =>
	runInProcess(SCRIPT, args, { cwd: sb.repo, env: { ...process.env, ...env } });

const out = (args: string[]) => {
	const r = runInProcess(SCRIPT, args, { cwd: sb.repo });
	if (r.status !== 0)
		throw new Error(
			`session-arbiter.js ${args.join(" ")} exited ${r.status}\n${r.stdout}${r.stderr}`,
		);
	return r.stdout;
};

/**
 * What the recovery command inside `context` gets back, run as printed.
 *
 * `prune` collects every unreferenced object first, so a version that comes
 * back proves the PIN holds it and not merely that `hash-object -w` wrote it.
 */
const readRecoveredBlob = (context: string, prune = false) => {
	const sha = context.match(/git cat-file -p ([0-9a-f]{40,64})/)?.[1];
	expect(sha).toBeTruthy();
	if (prune) execFileSync("git", ["gc", "--prune=now", "-q"], { cwd: sb.repo });
	return execFileSync("git", ["cat-file", "-p", sha as string], {
		cwd: sb.repo,
		encoding: "utf8",
	});
};

const readRefs = () =>
	execFileSync(
		"git",
		["for-each-ref", "--format=%(refname)", "refs/arbiter/"],
		{
			cwd: sb.repo,
			encoding: "utf8",
		},
	)
		.split("\n")
		.filter(Boolean);

const inRepo = (rel: string) => path.join(sb.repo, rel);

describe("the sandbox's isolation from the machine (mantahostels#1902)", () => {
	// What `stubOracles` (lib/arbiter-testkit.ts) exists to hold, driven through
	// the CLI: every assertion here is on what the arbiter did, never on the
	// environment the testkit set two lines earlier.
	const rel = "docs/doc-map.md";

	const sandboxOf = (name: string) => path.join(sb.dir, "stubs", name);

	it("force-releases with no oracle shim, so the default stub answers rather than refusing", () => {
		// The force is gated on `claude agents --json` and refuses whenever that
		// cannot be read (mantahostels#319). A stub echoing `[]` reads as a refusal, not as an
		// empty listing — this case is what catches that.
		gitRepo(sb);
		fs.writeFileSync(inRepo(rel), "alice's work\n");
		commitAll(sb);
		const alice = live(sb, "alice");
		store.acquire(rel, alice);
		store.recordContent(rel, alice);
		live(sb, "bob");

		const r = cli(["release", "--force", inRepo(rel)], {
			CLAUDE_CODE_SESSION_ID: "bob",
		});
		expect(r.stderr).not.toContain("could not be read");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Force-released docs/doc-map.md");
	});

	it("routes an unstubbed gh call to a stub that refuses", () => {
		const unstubbed = path.join(sb.dir, "gh-unstubbed");
		expect(process.env.WFC_GH).toBe(unstubbed);
		const r = spawnSync(unstubbed, ["issue", "view", "1"], {
			encoding: "utf8",
		});
		expect(r.status).not.toBe(0);
		expect(r.stderr).toContain("unstubbed gh call");
	});

	it("still lets fakeGh take the gh seam from the default", () => {
		// stubOracles claims WFC_GH in the sandbox's own beforeEach, and a case
		// arranging its own `gh` must still win.
		fakeGh(sb, 'echo \'{"state":"CLOSED"}\'');
		expect(process.env.WFC_GH).toBe(path.join(sb.dir, "gh-fake"));
		expect(ghCallCount(sb)).toBe(0);
	});

	it("resolves a bare `claude` to its stub too", () => {
		// The knob is belt; PATH is braces, for a caller not reading it.
		expect(
			spawnSync("sh", ["-c", "command -v claude"], {
				encoding: "utf8",
			}).stdout.trim(),
		).toBe(sandboxOf("claude"));
	});
});

describe("the CLI, as the hook and the scripts invoke it", () => {
	it("says nothing about an unguarded path", () => {
		expect(out(["check", inRepo("app/page.tsx")])).toBe("");
	});

	it("says nothing when the file is free", () => {
		// An UNREGIONED guarded path: a whole-file write to the doc map is never
		// silent (mantahostels#2334).
		registerSession(sb, "a", process.pid);
		expect(out(["check", inRepo("docs/other.md"), "a"])).toBe("");
	});

	it("emits a PreToolUse deny naming the holder", () => {
		registerSession(sb, "alice", process.pid);
		store.acquire("docs/doc-map.md", store.identify("alice"));
		registerSession(sb, "bob", process.pid);
		const json = JSON.parse(out(["check", inRepo("docs/doc-map.md"), "bob"]));
		expect(json.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(json.hookSpecificOutput.permissionDecisionReason).toContain("alice");
	});

	it("opens with the neighbour wait, then other subject, force and request (mantahostels#1686, #543)", () => {
		// A plain retry and a switch of subject carried every recovery that
		// worked; leading with `release --force` never did (mantahostels#1682).
		// The wait (#540) subsumes the retry, catching a mid-write release in
		// seconds, so it leads, and force and request close.
		registerSession(sb, "alice", process.pid);
		store.acquire("docs/doc-map.md", store.identify("alice"));
		registerSession(sb, "bob", process.pid);
		const reason = JSON.parse(out(["check", inRepo("docs/doc-map.md"), "bob"]))
			.hookSpecificOutput.permissionDecisionReason;

		const at = (needle: string) => {
			const i = reason.indexOf(needle);
			expect(i, `missing: ${needle}`).toBeGreaterThan(-1);
			return i;
		};
		// The first line names the holder and the wait command, so an adopter
		// without the core's CLAUDE.md meets it where the block happens.
		const [first] = reason.split("\n");
		expect(first).toContain("alice");
		expect(first).toContain(
			"node scripts/session-arbiter.js wait docs/doc-map.md",
		);
		expect(reason).toContain("Do not ask the founder whether to wait");
		// mantahostels#1406's hold-while-waiting is what DEADLOCK catches.
		expect(reason).toContain("#1406");
		expect(reason).toContain("DEADLOCK");
		expect(at("session-arbiter.js wait")).toBeLessThan(at("another subject"));
		expect(at("another subject")).toBeLessThan(at("release --force"));
		expect(at("release --force")).toBeLessThan(at("arbiter.js request"));
		expect(reason).toContain("release --force docs/doc-map.md");
		// What stops a session reaching for it against a live neighbour: it asks
		// the liveness oracle, and refuses rather than guessing when it cannot.
		expect(reason).toContain("claude agents --json");
		expect(reason).toContain("never a release on doubt");
		for (const refusal of [
			"dirty file",
			"cleanliness git cannot confirm",
			"claim store it cannot read",
			"changed underneath it",
		])
			expect(reason).toContain(refusal);
		expect(reason).toContain("git cat-file -p <sha>");
		// Both exits are routed, because the stub is already written either way:
		// a force that succeeds leaves an entry owing nothing, and clearing it is
		// the never-owed case, not the never-owned one.
		expect(reason).toContain("debt clear docs/doc-map.md unowned");
		// Anchored on the invocation, not the prose mention of `--force` further
		// up, which would pass vacuously.
		expect(reason.indexOf("release --force")).toBeLessThan(
			reason.indexOf("debt own"),
		);
	});

	it("aborts a script with exit 1 on a held file, and exits 0 on a free one", () => {
		// mantahostels#103: signal 3's helper must stop its caller, not merely record —
		// record-only would leave the digest protected for everyone and from
		// nobody (mantahostels#64, mantahostels#103).
		registerSession(sb, "alice", process.pid);
		store.acquire("docs/roadmap-digest.md", store.identify("alice"));
		registerSession(sb, "bob", process.pid);

		const held = cli(["claim", inRepo("docs/roadmap-digest.md"), "bob"]);
		expect(held.status).toBe(1);
		expect(held.stderr).toContain("alice");

		expect(cli(["claim", inRepo("docs/free.md"), "bob"]).status).toBe(0);
	});

	it("exits 2 with usage on an unknown subcommand", () => {
		const r = cli(["frobnicate"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("usage");
	});

	it("exits 0 when its registry is unreachable, but says the write is unprotected", () => {
		// Fail-open is house style (mantahostels#103 §6): exit 0, no deny, the write proceeds.
		// It never goes SILENT: a broken guard would look exactly like one finding
		// nothing wrong (mantahostels#174).
		// ENOTDIR — a directory path whose parent is a file. Deliberately NOT
		// a /proc path: mkdirSync(recursive) under /proc blocks forever on
		// this kernel instead of raising, so that shape tests the hang
		// defence in lib/file-claim-host.js, not this fail-open path.
		const r = cli(["check", inRepo("docs/doc-map.md"), "a"], {
			CLAUDE_CONFIG_DIR: "/dev/null/nope",
		});
		expect(r.status).toBe(0);
		const json = JSON.parse(r.stdout);
		// The hook must not refuse the write over a store it cannot reach, or one
		// bad path halts every session at once.
		expect(json.hookSpecificOutput.permissionDecision).toBeUndefined();
		expect(json.hookSpecificOutput.additionalContext).toMatch(
			/store is unreadable/,
		);
	});

	it("the hook fails open when the arbiter hangs", () => {
		// The exception handler cannot catch a hang, so lib/file-claim-host.js
		// bounds the arbiter's process. Without it a wedged arbiter would stall
		// every guarded write in every session for the full hook timeout. This is
		// the real hang shape: mkdirSync(recursive) under an unreadable /proc path
		// blocks forever on this kernel rather than raising. The arbiter inherits
		// it from this process's environment, which the sandbox restores.
		process.env.CLAUDE_CONFIG_DIR = "/proc/nonexistent/nope";
		const file = inRepo("docs/doc-map.md");
		const r = runCore(
			"guard-file-claim",
			{
				session_id: "a",
				tool_name: "Edit",
				tool_input: { file_path: file },
			},
			{ root: sb.repo },
		);
		// The record is what separates the bound firing from any other exit.
		expect(r.output).toBeNull();
		expect(r.logs).toEqual([
			`arbiter timed out on ${file} — write allowed unchecked`,
		]);
	}, 40_000);
});

/*
 * The core lib/file-claim.js has its own suite (mantahostels#149):
 * lib/file-claim.test.ts.
 *
 * One hook test stays above — "the hook fails open when the arbiter hangs"
 * drives the real hang shape, an unreadable CLAUDE_CONFIG_DIR under /proc. The
 * other suite stubs the hang, so neither stands in for the other and both pay
 * the host's 5s bound.
 */

describe("logging once across PROCESSES, not once per process", () => {
	it("says a sessionless run takes no claims once, not on every write", () => {
		// The arbiter is a fresh process per guarded write, so a pid-keyed marker
		// would log every write for exactly the sessionless case this bounds.
		for (let i = 0; i < 2; i++) {
			cli(["check", inRepo("docs/doc-map.md"), ""], {
				CLAUDE_CODE_SESSION_ID: "",
			});
		}
		const lines = fs
			.readFileSync(store.errorLog(), "utf8")
			.split("\n")
			.filter(Boolean);
		expect(lines.length).toBe(1);
	});
});

describe("the release CLI, as the skill loops invoke it", () => {
	// `sid` goes in the environment, which is where the release subcommand takes
	// its caller from; it accepts no positional session id.
	const run = (args: string[], sid: string) =>
		cli(args, { CLAUDE_CODE_SESSION_ID: sid });
	const docMap = () => inRepo("docs/doc-map.md");

	beforeEach(() => {
		gitRepo(sb);
		store.acquire("docs/doc-map.md", live(sb, "alice"));
	});

	it("says what it dropped on a released path, and nothing at all on an unguarded one", () => {
		const ok = run(["release", docMap()], "alice");
		expect(ok.status).toBe(0);
		expect(ok.stdout).toContain("Released docs/doc-map.md");
		// Silent, not just zero: an unguarded path is the one release outcome that
		// says nothing (docs/agents/guard-registry.md §Conventions, the release rule).
		const unguarded = run(["release", inRepo("app/page.tsx")], "alice");
		expect(unguarded.status).toBe(0);
		expect(unguarded.stdout).toBe("");
	});

	/* A claim standing on an EXEMPT path — one minted before mantahostels#2103 dropped
	 * `.claude/tmp/` out of both tiers. Nothing takes a new claim there, but the
	 * old ones must still be droppable: gating release on isWatched alone would
	 * exit 0 having dropped nothing, and the stranded-claim report would name
	 * them for ever (mantahostels#2053). */
	it("still drops a claim standing on an exempt path", () => {
		const scratch = ".claude/tmp/review-standards.md";
		store.acquire(scratch, live(sb, "alice"));
		const r = run(["release", inRepo(scratch)], "alice");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`Released ${scratch}`);
	});

	it("exits 0 saying nothing is claimed when the path is free", () => {
		run(["release", docMap()], "alice");
		const again = run(["release", docMap()], "alice");
		expect(again.status).toBe(0);
		expect(again.stdout).toContain("No claim on docs/doc-map.md");
	});

	it("exits 1 and names the holder when the caller is not it", () => {
		const r = run(["release", docMap()], live(sb, "bob").sessionId);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("alice");
	});

	it("refuses a session id passed in argv, naming the argument and keeping the claim, so nobody can release as someone else", () => {
		const r = run(["release", docMap(), "alice"], live(sb, "bob").sessionId);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/^unexpected argument: alice\n/);
		expect(
			store
				.listLocks()
				.some((l: { path: string }) => l.path === "docs/doc-map.md"),
		).toBe(true);
	});

	it("exits 1 with the reason when the path is dirty", () => {
		fs.writeFileSync(inRepo("docs/doc-map.md"), "half an edit\n");
		const r = run(["release", docMap()], "alice");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("uncommitted changes");
	});

	it.skipIf(AS_ROOT)(
		"exits 1 rather than reporting no claim when the store cannot be read (mantahostels#174)",
		() => {
			// "No claim on docs/doc-map.md" against a store that would not open tells
			// alice her claim is gone when it is still on disk.
			fs.chmodSync(store.paths.locksDir(), 0o000);
			try {
				const r = run(["release", docMap()], "alice");
				expect(r.status).toBe(1);
				expect(r.stdout).not.toContain("No claim");
				expect(r.stderr).toMatch(/could not read the claim store/);
			} finally {
				fs.chmodSync(store.paths.locksDir(), 0o755);
			}
		},
	);

	it("re-claims on the holder's next write, so a premature release self-heals", () => {
		run(["release", docMap()], "alice");
		// Since mantahostels#2334 the write carries the whole-file notice, and a notice is not a
		// refusal.
		const reclaim = JSON.parse(run(["check", docMap()], "alice").stdout);
		expect(reclaim.hookSpecificOutput.permissionDecision).toBeUndefined();
		expect(reclaim.hookSpecificOutput.additionalContext).toContain(
			"claims the WHOLE of",
		);

		const denied = JSON.parse(
			run(["check", docMap()], live(sb, "bob").sessionId).stdout,
		);
		expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
		expect(denied.hookSpecificOutput.permissionDecisionReason).toContain(
			"alice",
		);
	});
});

/*
 * mantahostels#2774: a background session that has ENDED — done, failed or stopped — keeps
 * its process until the reaper takes it, so `holderAlive` reads it alive and
 * the row said HELD.
 */
describe("list tells an ENDED holder from a running one", () => {
	const rel = "docs/doc-map.md";
	const claudeBin = () => path.join(sb.dir, "bin", "claude");

	/** A `claude` stand-in listing whole records, so `kind` and `state` reach the oracle. */
	const fakeClaude = (agents: Record<string, unknown>[], code = 0) => {
		fs.mkdirSync(path.join(sb.dir, "bin"), { recursive: true });
		fs.writeFileSync(
			claudeBin(),
			`#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(agents)}\nEOF\nexit ${code}\n`,
		);
		fs.chmodSync(claudeBin(), 0o755);
	};

	const listAs = (sid: string) =>
		cli(["list"], {
			CLAUDE_CODE_SESSION_ID: sid,
			WFC_CLAUDE_BIN: claudeBin(),
		});

	beforeEach(() => {
		store.acquire(rel, live(sb, "alice"));
		live(sb, "bob");
	});

	it.each(["done", "failed", "stopped"])(
		"labels a holder the oracle calls %s as ENDED",
		(state) => {
			fakeClaude([
				{ sessionId: "alice", kind: "background", state },
				{ sessionId: "bob" },
			]);
			expect(listAs("bob").stdout).toMatch(/ENDED.*docs\/doc-map\.md/);
		},
	);

	it("still says HELD for a holder the oracle calls working", () => {
		fakeClaude([
			{ sessionId: "alice", kind: "background", state: "working" },
			{ sessionId: "bob" },
		]);
		expect(listAs("bob").stdout).toMatch(/HELD .*docs\/doc-map\.md/);
	});

	/* DISPLAY WORDING, NEVER A RELEASE (mantahostels#318). The row stays in the default
	 * view — which filters on `alive` — and the guard still denies on it. */
	it("keeps the ENDED row in the default view and hides nothing", () => {
		fakeClaude([
			{ sessionId: "alice", kind: "background", state: "failed" },
			{ sessionId: "bob" },
		]);
		const printed = listAs("bob").stdout;
		expect(printed).toContain("docs/doc-map.md");
		expect(printed).not.toContain("stale claim(s) hidden");
	});

	/* Degrades to today's two labels: a refusal must not call a live holder ended. */
	it("falls back to HELD where the oracle refuses", () => {
		fakeClaude([], 3);
		expect(listAs("bob").stdout).toMatch(/HELD .*docs\/doc-map\.md/);
	});
});

describe("list", () => {
	it("marks a live holder HELD and a dead one STALE under --all", () => {
		registerSession(sb, "alice", process.pid);
		store.acquire("docs/a-live.md", store.identify("alice"));
		store.acquire("docs/b-dead.md", {
			sessionId: "gone",
			pid: 4_194_303,
			procStart: "1",
			durable: true,
		});
		const printed = out(["list", "--all"]);
		expect(printed).toMatch(/HELD .*docs\/a-live\.md/);
		expect(printed).toMatch(/STALE.*docs\/b-dead\.md/);
	});

	describe("the default view is live claims only (mantahostels#1814)", () => {
		/** One live claim and one dead one — the pair the filter has to separate. */
		const bothKinds = () => {
			registerSession(sb, "alice", process.pid);
			store.acquire("docs/a-live.md", store.identify("alice"));
			store.acquire("docs/b-dead.md", {
				sessionId: "gone",
				pid: 4_194_303,
				procStart: "1",
				durable: true,
			});
		};

		it("keeps the HELD rows and drops the STALE ones", () => {
			bothKinds();
			const printed = out(["list"]);
			expect(printed).toMatch(/HELD .*docs\/a-live\.md/);
			expect(printed).not.toContain("STALE");
			expect(printed).not.toContain("docs/b-dead.md");
		});

		it("counts what it hid and names the flag that shows it (mantahostels#174)", () => {
			bothKinds();
			expect(out(["list"])).toContain(
				"1 stale claim(s) hidden — node scripts/session-arbiter.js list --all",
			);
		});

		it.skipIf(AS_ROOT)(
			"warns that a STALE row may be live when the registry will not open",
			() => {
				// #273: the alive column is a boolean, so a holder resumed onto a
				// fresh process reads STALE and the default view then hides it.
				bothKinds();
				const dir = store.paths.sessionsDir();
				fs.chmodSync(dir, 0o000);
				try {
					const printed = out(["list"]);
					expect(printed).toContain("The sessions registry could not be read");
					expect(printed).toContain("may be a live holder resumed");
					// Once for the run, not once per lock, and above every row.
					expect(
						printed.split("The sessions registry could not be read"),
					).toHaveLength(2);
					expect(printed.indexOf("stale claim(s) hidden")).toBeLessThan(
						printed.indexOf("The sessions registry could not be read"),
					);
				} finally {
					fs.chmodSync(dir, 0o755);
				}
			},
		);

		it.skipIf(AS_ROOT)("warns under --all too, which hides nothing", () => {
			// --all is where the hidden-count line sends a reader, so it is the one
			// view with a STALE row on screen that may still be live.
			bothKinds();
			const dir = store.paths.sessionsDir();
			fs.chmodSync(dir, 0o000);
			try {
				const printed = out(["list", "--all"]);
				expect(printed).toContain("The sessions registry could not be read");
				expect(printed).not.toContain("stale claim(s) hidden");
			} finally {
				fs.chmodSync(dir, 0o755);
			}
		});

		it("says nothing about it when the registry opens", () => {
			bothKinds();
			expect(out(["list"])).not.toContain(
				"The sessions registry could not be read",
			);
		});

		it("says nothing about hiding when every claim is live", () => {
			registerSession(sb, "alice", process.pid);
			store.acquire("docs/a-live.md", store.identify("alice"));
			expect(out(["list"])).not.toContain("hidden");
		});

		it("does not call a store of stale claims empty", () => {
			store.acquire("docs/b-dead.md", {
				sessionId: "gone",
				pid: 4_194_303,
				procStart: "1",
				durable: true,
			});
			const printed = out(["list"]);
			expect(printed).not.toContain("No files are claimed.\n");
			expect(printed).toContain("No files are claimed by a live session.");
			expect(printed).toContain("1 stale claim(s) hidden");
		});

		it("keeps the ONE REGION marker on a live region claim", () => {
			registerSession(sb, "alice", process.pid);
			store.acquire(
				store.subjectFor("docs/doc-map.md", "B7"),
				store.identify("alice"),
			);
			store.acquire("docs/b-dead.md", {
				sessionId: "gone",
				pid: 4_194_303,
				procStart: "1",
				durable: true,
			});
			expect(out(["list"])).toContain("ONE REGION (B7)");
		});

		it("keeps an unreadable lock row — unreadable is not dead", () => {
			bothKinds();
			fs.writeFileSync(
				path.join(store.paths.locksDir(), "garbage.json"),
				"not json at all",
			);
			expect(out(["list"])).toContain("?????");
		});

		it("refuses a mistyped flag, naming it and the usage, rather than answering narrowly", () => {
			bothKinds();
			const r = cli(["list", "--al"]);
			expect(r.status).toBe(2);
			expect(r.stdout).toBe("");
			expect(r.stderr).toMatch(
				/^unknown flag: --al\n\nusage: session-arbiter\.js list \[--all\]/,
			);
		});

		it("exits 0 with or without the flag", () => {
			bothKinds();
			expect(cli(["list"]).status).toBe(0);
			expect(cli(["list", "--all"]).status).toBe(0);
		});
	});

	it("marks a RESUMED holder HELD, not STALE (mantahostels#359)", () => {
		// A lock freezes its holder's pid, so a session resumed onto a fresh host
		// reads dead from the lock alone. Printing STALE is what tells the person
		// reading this list the file is free — and nothing refuses the Bash-route
		// write they then make over a live editor.
		registerSession(sb, "resumed", process.pid);
		store.acquire("docs/b-dead.md", {
			sessionId: "resumed",
			pid: 4_194_303,
			procStart: "1",
			durable: true,
		});
		expect(out(["list"])).toMatch(/HELD .*docs\/b-dead\.md/);
	});

	it("says so when nothing is claimed", () => {
		expect(out(["list"])).toContain("No files are claimed.");
	});

	it.skipIf(AS_ROOT)(
		"refuses to call an unreadable store empty (mantahostels#174)",
		() => {
			// This is the command a person runs to decide whether a file is free, so
			// "No files are claimed." is the reading most likely to be acted on.
			registerSession(sb, "alice", process.pid);
			store.acquire("docs/a-live.md", store.identify("alice"));
			fs.chmodSync(store.paths.locksDir(), 0o000);
			try {
				const r = cli(["list"]);
				expect(r.status).toBe(1);
				expect(r.stdout).not.toContain("No files are claimed.");
				expect(r.stderr).toMatch(/could not read the lock store/);
			} finally {
				fs.chmodSync(store.paths.locksDir(), 0o755);
			}
		},
	);
});

describe("naming a holder by its session name, not its id (mantahostels#1196)", () => {
	// `docs/working-contract.md`: "Report a session by its name, never its id or
	// pid".
	const rel = "docs/doc-map.md";
	const claudeBin = () => path.join(sb.dir, "bin", "claude");
	const calls = () => path.join(sb.dir, "claude-calls");

	/** A `claude` stand-in listing `[sessionId, name]` pairs, recording each call. */
	const fakeClaude = (agents: [string, string?][], code = 0) => {
		fs.mkdirSync(path.join(sb.dir, "bin"), { recursive: true });
		const body = JSON.stringify(
			agents.map(([sessionId, name]) =>
				name ? { sessionId, name } : { sessionId },
			),
		);
		fs.writeFileSync(
			claudeBin(),
			`#!/bin/sh\necho hit >> "${calls()}"\ncat <<'EOF'\n${body}\nEOF\nexit ${code}\n`,
		);
		fs.chmodSync(claudeBin(), 0o755);
	};

	const oracleCalls = () =>
		fs.existsSync(calls())
			? fs.readFileSync(calls(), "utf8").split("\n").filter(Boolean).length
			: 0;

	const runAs = (args: string[], sid: string) =>
		cli(args, { CLAUDE_CODE_SESSION_ID: sid, WFC_CLAUDE_BIN: claudeBin() });

	beforeEach(() => {
		const alice = live(sb, "alice");
		store.acquire(rel, alice);
		live(sb, "bob");
	});

	it("names the holder in a claim denial, keeping the id for the commands that need one", () => {
		fakeClaude([
			["alice", "Wayfinder 1162"],
			["bob", "Implement 1104"],
		]);
		const r = runAs(["claim", inRepo(rel)], "bob");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("Wayfinder 1162");
		expect(r.stderr).toContain("alice");
	});

	it("renders the holder in full: name, id, pid and claimed-at (mantahostels#2452)", () => {
		// The WHOLE shape, not a substring of it. describeHolder and parkFirst share
		// one formatter now, and the pid-and-claimed-at trailer — which only
		// describeHolder takes — is the part a refactor of it could silently drop.
		fakeClaude([
			["alice", "Wayfinder 1162"],
			["bob", "Implement 1104"],
		]);
		const r = runAs(["claim", inRepo(rel)], "bob");
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(
			/Wayfinder 1162 \(id alice, pid \d+\) since \d{4}-\d{2}-\d{2}T/,
		);
	});

	it("names the holder in list", () => {
		fakeClaude([
			["alice", "Wayfinder 1162"],
			["bob", "Implement 1104"],
		]);
		const r = runAs(["list"], "bob");
		expect(r.stdout).toMatch(/HELD .*docs\/doc-map\.md.*Wayfinder 1162/);
	});

	it("falls back to the bare id when the oracle cannot be read", () => {
		fakeClaude([["alice", "Wayfinder 1162"]], 3);
		const r = runAs(["claim", inRepo(rel)], "bob");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("alice");
		expect(r.stderr).not.toContain("Wayfinder 1162");
	});

	it("falls back to the bare id for a holder the oracle lists without a name", () => {
		fakeClaude([["alice"], ["bob"]]);
		const r = runAs(["claim", inRepo(rel)], "bob");
		expect(r.stderr).toContain("alice");
	});

	it("reads the oracle once per process, however many holders it names", () => {
		fakeClaude([
			["alice", "Wayfinder 1162"],
			["bob", "Implement 1104"],
		]);
		store.acquire("docs/operating-manual.md", live(sb, "alice"));
		const r = runAs(["list"], "bob");
		expect(r.stdout).toContain("Wayfinder 1162");
		expect(oracleCalls()).toBe(1);
	});

	it("makes NO oracle call on the hook path, which mantahostels#411 bars it from", () => {
		fakeClaude([["alice", "Wayfinder 1162"]]);
		const r = runAs(["check", inRepo(rel), "bob"], "bob");
		expect(r.stdout).toContain("deny");
		expect(r.stdout).toContain("alice");
		expect(oracleCalls()).toBe(0);
	});
});

describe("versions — the pull-mode reader for the holder's own clobber (mantahostels#438)", () => {
	// The one clobber nothing reports: a `cp` the HOLDER runs is trusted by the
	// post-Bash refresh, which re-pins the clobbered bytes. mantahostels#329 declined a
	// detector on precision, so the shas are kept and asked for instead.
	const rel = "scripts/evidence-audit.py";

	beforeEach(() => {
		gitRepo(sb);
		fs.mkdirSync(path.join(sb.repo, "scripts"), { recursive: true });
		registerSession(sb, "alice", process.pid);
	});

	/** One write by alice: the PreToolUse check, then the PostToolUse record. */
	const aliceWrites = (text: string) => {
		out(["check", inRepo(rel), "alice"]);
		fs.writeFileSync(inRepo(rel), text);
		out(["record", inRepo(rel), "alice"]);
	};

	it("prints each version newest first with a recovery command that works", () => {
		aliceWrites("alice's uncommitted work\n");
		aliceWrites("restored from a backup\n"); // the holder's own clobber

		const printed = out(["versions", inRepo(rel)]);
		expect(printed).toContain(rel);
		expect(printed).toContain("alice");

		const shas = [
			...printed.matchAll(/git cat-file -p ([0-9a-f]{40,64})/g),
		].map((m) => m[1]);
		expect(shas.length).toBe(2);
		expect(
			shas.map((sha) =>
				execFileSync("git", ["cat-file", "-p", sha], {
					cwd: sb.repo,
					encoding: "utf8",
				}),
			),
		).toEqual(["restored from a backup\n", "alice's uncommitted work\n"]);
	});

	it("prints no recovery command for a version git has already pruned", () => {
		// Only the current version is pinned, so a prior lives on git's two-week
		// default. A `cat-file` line naming a swept object is an instruction that
		// fails, which is worse than saying the version is gone.
		aliceWrites("v1\n");
		aliceWrites("v2\n");
		execFileSync("git", ["gc", "--prune=now", "-q"], { cwd: sb.repo });

		const printed = out(["versions", inRepo(rel)]);
		expect(printed).toContain("GONE");
		expect([...printed.matchAll(/git cat-file -p /g)].length).toBe(1);
	});

	it("says so, and exits 0, where nothing holds the path", () => {
		fs.writeFileSync(inRepo(rel), "unclaimed\n");
		const r = cli(["versions", inRepo(rel)]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("No claim on");
	});

	/** The fail-open mantahostels#2333 covers: a write whose PreToolUse check never ran, so
	 * no lock was minted and the pin sits under the observation's obsId. */
	const unguardedWrite = (text: string) => {
		fs.writeFileSync(inRepo(rel), text);
		out(["record", inRepo(rel), "alice"]);
	};

	it("reports an unclaimed writer's own pinned bytes, which the rule text sends it here for (mantahostels#2374)", () => {
		unguardedWrite("alice's unclaimed work\n");
		fs.writeFileSync(inRepo(rel), "restored from a backup\n"); // the clobber

		const r = cli(["versions", inRepo(rel)], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});

		expect(r.status).toBe(0);
		expect(r.stdout).not.toContain("No claim on");
		expect(r.stdout).toContain("THIS session");
		const sha = r.stdout.match(/git cat-file -p ([0-9a-f]{40,64})/)?.[1];
		expect(
			execFileSync("git", ["cat-file", "-p", sha as string], {
				cwd: sb.repo,
				encoding: "utf8",
			}),
		).toBe("alice's unclaimed work\n");
	});

	it("prints the holder's versions AND the reader's own, each said to be whose (mantahostels#2374)", () => {
		registerSession(sb, "bob", process.ppid);
		aliceWrites("alice's uncommitted work\n");
		out(["check", inRepo(rel), "bob"]);
		fs.writeFileSync(inRepo(rel), "bob's uncommitted work\n");
		out(["record", inRepo(rel), "bob"]);

		const r = cli(["versions", inRepo(rel)], {
			CLAUDE_CODE_SESSION_ID: "bob",
		});

		expect(r.status).toBe(0);
		expect(r.stdout).toContain("claimed by");
		expect(r.stdout).toContain("alice");
		expect(r.stdout).toContain("THIS session");
		const shas = [
			...r.stdout.matchAll(/git cat-file -p ([0-9a-f]{40,64})/g),
		].map((m) =>
			execFileSync("git", ["cat-file", "-p", m[1]], {
				cwd: sb.repo,
				encoding: "utf8",
			}),
		);
		expect(shas).toContain("alice's uncommitted work\n");
		expect(shas).toContain("bob's uncommitted work\n");
	});

	/* A RECORD THAT WILL NOT READ IS NOT NO RECORD (mantahostels#2382). */
	const corrupt = (file: string) => fs.writeFileSync(file, "{not json");

	it("says the CLAIM record would not read rather than reporting no claim (mantahostels#2382)", () => {
		aliceWrites("alice's uncommitted work\n");
		corrupt(store.paths.lock(rel));

		const r = cli(["versions", inRepo(rel)]);
		// 1, not 0: the answer is incomplete, and mantahostels#174 bars a fault exiting clean.
		expect(r.status).toBe(1);
		expect(r.stdout).not.toContain("No claim on");
		expect(r.stdout).toContain("WOULD NOT READ (unparseable)");
		expect(r.stdout).toContain(store.paths.lock(rel));
		expect(r.stdout).toContain("git cat-file -p <sha>");
	});

	it.skipIf(AS_ROOT)(
		"says so for a CLAIM record the filesystem refuses (mantahostels#2382)",
		() => {
			aliceWrites("alice's uncommitted work\n");
			fs.chmodSync(store.paths.lock(rel), 0o000);
			try {
				const r = cli(["versions", inRepo(rel)]);
				expect(r.status).toBe(1);
				expect(r.stdout).not.toContain("No claim on");
				expect(r.stdout).toContain("WOULD NOT READ (refused)");
				expect(r.stdout).toContain("Check its permissions");
			} finally {
				fs.chmodSync(store.paths.lock(rel), 0o644);
			}
		},
	);

	it("says the OBSERVATION record would not read rather than reporting no claim (mantahostels#2382)", () => {
		unguardedWrite("alice's unclaimed work\n");
		corrupt(store.paths.observation(rel, "alice"));

		const r = cli(["versions", inRepo(rel)], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(1);
		expect(r.stdout).not.toContain("No claim on");
		expect(r.stdout).toContain("observation record");
		expect(r.stdout).toContain("WOULD NOT READ (unparseable)");
	});

	it.skipIf(AS_ROOT)(
		"says so for an OBSERVATION record the filesystem refuses (mantahostels#2382)",
		() => {
			unguardedWrite("alice's unclaimed work\n");
			const file = store.paths.observation(rel, "alice");
			fs.chmodSync(file, 0o000);
			try {
				const r = cli(["versions", inRepo(rel)], {
					CLAUDE_CODE_SESSION_ID: "alice",
				});
				expect(r.status).toBe(1);
				expect(r.stdout).not.toContain("No claim on");
				expect(r.stdout).toContain("WOULD NOT READ (refused)");
			} finally {
				fs.chmodSync(file, 0o644);
			}
		},
	);

	it("still prints the half that DID read, so one bad record hides nothing (mantahostels#2382)", () => {
		registerSession(sb, "bob", process.ppid);
		aliceWrites("alice's uncommitted work\n");
		fs.writeFileSync(inRepo(rel), "bob's unclaimed work\n");
		out(["record", inRepo(rel), "bob"]); // bob holds no lock: an observation
		corrupt(store.paths.lock(rel));

		const r = cli(["versions", inRepo(rel)], {
			CLAUDE_CODE_SESSION_ID: "bob",
		});
		expect(r.status).toBe(1);
		expect(r.stdout).toContain("WOULD NOT READ");
		expect(r.stdout).toContain("THIS session");
		expect(r.stdout).toMatch(/git cat-file -p [0-9a-f]{40,64}/);
	});

	it("adds nothing to a write, a check or a release — it is pull-mode only", () => {
		// mantahostels#288 and mantahostels#329 both rule the mechanism report-only, so this build must be
		// silent in normal operation.
		aliceWrites("v1\n");
		const before = cli(["check", inRepo(rel), "alice"]);
		aliceWrites("v2\n");
		const after = cli(["check", inRepo(rel), "alice"]);
		expect(after.stdout).toBe(before.stdout);
		expect(after.stderr).toBe(before.stderr);
		expect(after.status).toBe(before.status);
	});
});

describe("the second signal — dirty, but claimed by nobody", () => {
	// mantahostels#99's signal 2 names no session, so it can only warn (mantahostels#103): uncommitted work
	// with no live holder is a finished session's or a hand edit's, and overwriting
	// it unread is how that work is lost.
	const warning = (sessionId: string, file: string) => {
		const printed = out(["check", file, sessionId]);
		return printed === ""
			? ""
			: (JSON.parse(printed).hookSpecificOutput.additionalContext ?? "");
	};

	beforeEach(() => {
		gitRepo(sb);
	});

	it("allows the write but tells the session to read the diff first", () => {
		registerSession(sb, "a", process.pid);
		fs.writeFileSync(inRepo("docs/doc-map.md"), "someone's work\n");
		const json = JSON.parse(out(["check", inRepo("docs/doc-map.md"), "a"]));
		expect(json.hookSpecificOutput.permissionDecision).toBeUndefined();
		expect(json.hookSpecificOutput.additionalContext).toContain(
			"Read the diff",
		);
	});

	it("stays quiet when the file is clean", () => {
		// An UNREGIONED guarded path, per "says nothing when the file is free".
		registerSession(sb, "a", process.pid);
		expect(out(["check", inRepo("docs/other.md"), "a"])).toBe("");
	});

	it("denies rather than warns when a live session holds the dirty file", () => {
		// A holder is the stronger signal: naming them beats telling the session to
		// go and read a diff.
		registerSession(sb, "alice", process.pid);
		store.acquire("docs/doc-map.md", store.identify("alice"));
		fs.writeFileSync(inRepo("docs/doc-map.md"), "alice's work\n");
		registerSession(sb, "bob", process.pid);
		const json = JSON.parse(out(["check", inRepo("docs/doc-map.md"), "bob"]));
		expect(json.hookSpecificOutput.permissionDecision).toBe("deny");
	});

	// mantahostels#122 kept this warning on the ground that it fires at most once per file per
	// session: the gate is a FRESH claim, so later writes to a file the session
	// already holds are reentrant and silent. A renamed verdict would turn it into
	// a per-write nag.
	it("says it once, not on every write the session makes to the file", () => {
		registerSession(sb, "a", process.pid);
		const file = inRepo("docs/doc-map.md");
		fs.writeFileSync(file, "someone's work\n");
		expect(warning("a", file)).toContain("Read the diff");
		// Still dirty, still unclaimed by anyone else — only the claim has changed.
		fs.writeFileSync(file, "someone's work, edited\n");
		expect(warning("a", file)).toBe("");
	});

	it("holds its tongue for the claimant only, not for the file", () => {
		// Were the silence keyed by file, the first write of the day would spend the
		// warning and every session after it would overwrite the abandoned work in
		// silence.
		registerSession(sb, "a", process.pid);
		const file = inRepo("docs/doc-map.md");
		fs.writeFileSync(file, "a session's work\n");
		expect(warning("a", file)).toContain("Read the diff"); // and claims it
		// Kill the holder in the lock it left behind: a session that ends leaves its
		// claim on disk for the next claimant to break. The registry entry cannot
		// carry the death, being keyed by pid — "next" below overwrites "a"'s.
		const lock = store.paths.lock("docs/doc-map.md");
		fs.writeFileSync(
			lock,
			JSON.stringify({
				...JSON.parse(fs.readFileSync(lock, "utf8")),
				pid: 4_194_303,
				procStart: "1",
			}),
		);
		registerSession(sb, "next", process.pid);
		expect(warning("next", file)).toContain("Read the diff");
	});
});

/*
 * mantahostels#135. An empty list means "this session wrote nothing", which
 * the guard-commit-form core's attribution-aware warn (mantahostels#118) reads as *every staged
 * path is someone else's*. Returning it when the ledger could not be read hands
 * the session a list of its own files under the words "you never wrote these".
 */
describe("writes — an unreadable ledger is not an empty one", () => {
	const record = (rel: string, sessionId: string) =>
		store.recordWrite(inRepo(rel), sessionId);

	it("a session that has written nothing answers empty, and succeeds", () => {
		// recordWrite mints the ledger on the first write, so no file at all is the
		// honest empty answer — not an error. Collapsing this into the failure case
		// would fall back to the index-wide warn for every read-only session, which
		// is most of them.
		const r = cli(["writes", "never-wrote"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
	});

	it("a ledger it can read answers with the paths", () => {
		record("docs/a.md", "alice");
		const r = cli(["writes", "alice"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("docs/a.md\n");
	});

	it("a ledger it cannot read exits non-zero and prints nothing", () => {
		record("docs/a.md", "alice");
		fs.chmodSync(store.paths.ledger("alice"), 0o000);
		const r = cli(["writes", "alice"]);
		expect(r.status).not.toBe(0);
		expect(r.stdout).toBe("");
	});

	it("logs the unreadable ledger, so check-guard-errors can see it", () => {
		record("docs/a.md", "alice");
		fs.chmodSync(store.paths.ledger("alice"), 0o000);
		cli(["writes", "alice"]);
		expect(fs.readFileSync(store.errorLog(), "utf8")).toContain("writes alice");
	});

	/* A real commit, so a dropped committed path shows in stdout: git skips a
	 * sha it does not have. */
	const commitAsAlice = () => {
		gitRepo(sb);
		fs.writeFileSync(inRepo("docs/b.md"), "committed\n");
		commitAll(sb);
		const head = execFileSync("git", ["rev-parse", "HEAD"], {
			cwd: sb.repo,
			encoding: "utf8",
		}).trim();
		store.recordCommit(head, "alice");
	};

	it("--committed adds the paths the session's own commits touched (#2390)", () => {
		commitAsAlice();
		record("docs/a.md", "alice");
		const r = cli(["writes", "alice", "--committed"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("docs/a.md\ndocs/b.md\n");
	});

	it.skipIf(AS_ROOT)(
		"--committed prints the writes alone, and logs why, where the commit ledger will not read (mantahostels#114)",
		() => {
			commitAsAlice();
			record("docs/a.md", "alice");
			fs.chmodSync(store.paths.commitLedger("alice"), 0o000);
			const r = cli(["writes", "alice", "--committed"]);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("docs/a.md\n");
			expect(fs.readFileSync(store.errorLog(), "utf8")).toContain(
				"writes --committed",
			);
		},
	);

	it("no session id at all is unavailable, not empty", () => {
		// Neither argv nor CLAUDE_CODE_SESSION_ID names a session.
		const env = { ...process.env };
		delete env.CLAUDE_CODE_SESSION_ID;
		const r = runInProcess(SCRIPT, ["writes"], { cwd: sb.repo, env });
		expect(r.status).not.toBe(0);
		expect(r.stdout).toBe("");
	});
});

describe("record — the PostToolUse attribution path", () => {
	it("adds the path to the session's ledger", () => {
		expect(cli(["record", inRepo("docs/a.md"), "alice"]).status).toBe(0);
		expect(cli(["writes", "alice"]).stdout).toBe("docs/a.md\n");
	});

	it("is a no-op with no path, rather than an error the hook would surface", () => {
		expect(cli(["record"]).status).toBe(0);
	});

	it("ignores a trailing flag-shaped argument as it ignores any extra argument (#1137)", () => {
		const r = cli(["record", inRepo("docs/a.md"), "alice", "--help"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(cli(["writes", "alice"]).stdout).toBe("docs/a.md\n");
	});
});

describe("the argument reader — the caller's own flags parsed, the hook's free text not (#1137)", () => {
	it("refuses an unknown flag with the subcommand's usage, and drops nothing", () => {
		const alice = live(sb, "alice");
		store.acquire("docs/a.md", alice);
		const r = cli(["release", "--forse", inRepo("docs/a.md")], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(2);
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe(
			"unknown flag: --forse\n\nusage: session-arbiter.js release [--force] [--park] [--generator] [--not-mine] <path>\n",
		);
		expect(store.listLocks().map((l: { path: string }) => l.path)).toEqual([
			"docs/a.md",
		]);
	});

	it.each([
		[["debt", "sweep", "--json"], "debt sweep"],
		[["prune-markers", "--detatch"], "prune-markers [--detach]"],
		[["claim-issue", "--force", "12"], "claim-issue <issue-number>"],
	])("refuses %j with that subcommand's usage", (args, usage) => {
		const r = cli(args);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain(`usage: session-arbiter.js ${usage}\n`);
	});

	/* #1346: each fell to store.relativeToRepo(undefined), whose TypeError main's
	 * fail-open catch logged before exiting 0 with nothing said. */
	it.each([
		[["claim"], "claim <path> [session-id] [--generator]"],
		[
			["release"],
			"release [--force] [--park] [--generator] [--not-mine] <path>",
		],
		[["versions"], "versions <path>"],
		[["debt", "own"], 'debt own <path> <issue> "<gist>"'],
		[["debt", "clear"], "debt clear <path> [<issue>|unowned]"],
	])("refuses %j with no path, with that subcommand's usage", (args, usage) => {
		const r = cli(args);
		expect(r.status).toBe(2);
		expect(r.stderr).toBe(`usage: session-arbiter.js ${usage}\n`);
	});

	it("gets a refusal to a full stderr pipe in full before exiting non-zero (#1631)", () => {
		expect(
			throughFullPipe(2, [SCRIPT, "versions", "/nonexistent/x.md"], {
				cwd: sb.repo,
			}),
		).toBe("session-arbiter: /nonexistent/x.md is not in this repo\nexit 2\n");
	});

	it("refuses an argument past the subcommand's last, naming it", () => {
		const r = cli(["list", "extra"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/^unexpected argument: extra\n/);
	});

	it.each([
		[["--help"], "usage: session-arbiter.js check <path>"],
		[["release", "--help"], "usage: session-arbiter.js release [--force]"],
		[["wait", "-h"], "usage: session-arbiter.js wait <path|issue-number>"],
		[
			["debt", "--help"],
			'usage: session-arbiter.js debt own <path> <issue> "<gist>"',
		],
		[["debt", "sweep", "--help"], "usage: session-arbiter.js debt sweep\n"],
	])("answers %j on stdout, exit 0", (args, usage) => {
		const r = cli(args);
		expect(r.status).toBe(0);
		expect(r.stderr).toBe("");
		expect(r.stdout.startsWith(usage)).toBe(true);
	});

	it("refuses an unknown subcommand, with the whole usage", () => {
		const r = cli(["relase", inRepo("docs/a.md")]);
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(
			/^unknown command: relase\n\nusage: session-arbiter\.js check <path>/,
		);
	});

	/* Every flag a caller in scripts/, .claude/, hooks/ or .husky/ passes (#1137); prune-markers --detach is its own describe's, as it spawns. */
	it.each([
		[["claim", "docs/a.md", "--generator"]],
		[["release", "--force", "docs/a.md"]],
		[["release", "--park", "docs/a.md"]],
		[["release", "docs/a.md", "--generator"]],
		[["list", "--all"]],
		[["stale-check", "--staged"]],
	])("accepts %j without a refusal or usage text", (args) => {
		const r = cli(args.map((a) => (a.startsWith("docs/") ? inRepo(a) : a)));
		expect(r.stderr).not.toMatch(/unknown flag|unexpected argument|usage:/);
		expect(r.status).not.toBe(2);
	});

	it.each(["--help", "--x marks the old_string", "-h"])(
		"check takes an old_string of %j as the anchor, as the hook sends it",
		(anchor) => {
			registerSession(sb, "a", process.pid);
			const r = cli([
				"check",
				inRepo("docs/other.md"),
				"a",
				anchor,
				String(anchor.length),
			]);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
			expect(r.stderr).toBe("");
			expect(store.listLocks().map((l: { path: string }) => l.path)).toEqual([
				"docs/other.md",
			]);
		},
	);
});

describe("prune-markers — what the sweep itself does, run inline", () => {
	const prefixes = [
		".concision-base-",
		".concision-nagged-",
		".concision-pass-",
		".codereview-nagged-",
		".codereview-pass-",
		".priced-options-nagged-",
		".green-suite-nagged-",
		".selection-sum-nagged-",
	];
	const hour = 60 * 60 * 1000;
	/** Both spellings hook-record.js writes, guard name and all. */
	const crumbPrefixes = [
		".hook-ran-guard-priced-options-",
		".hook-ran-guard-selection-sum-",
	];
	const aged = (full: string, ms: number) => {
		const when = new Date(Date.now() - ms);
		fs.writeFileSync(full, "");
		fs.utimesSync(full, when, when);
	};
	const markers = (sessionId: string) => {
		fs.mkdirSync(markerRoot.markersDir(sb.repo), { recursive: true });
		for (const p of prefixes)
			aged(path.join(markerRoot.markersDir(sb.repo), p + sessionId), 25 * hour);
	};
	const surviving = (sessionId: string) =>
		prefixes.filter((p) =>
			fs.existsSync(path.join(markerRoot.markersDir(sb.repo), p + sessionId)),
		);
	/** Breadcrumbs for one session, all at the same age. */
	const crumbs = (sessionId: string, ms: number) => {
		fs.mkdirSync(hookRecord.recordsDir(sb.repo), { recursive: true });
		for (const p of crumbPrefixes)
			aged(path.join(hookRecord.recordsDir(sb.repo), p + sessionId), ms);
	};
	const crumbsLeft = (sessionId: string) =>
		crumbPrefixes.filter((p) =>
			fs.existsSync(path.join(hookRecord.recordsDir(sb.repo), p + sessionId)),
		);
	/*
	 * One of guard-entry.js's rule latches: `.rule-injected-<id>-<agent>-<sid>`, where
	 * <agent> is `main` for a parent session and `a<agent_id>` under a subagent.
	 */
	const latch = (id: string, agent: string, sessionId: string, ms: number) => {
		fs.mkdirSync(markerRoot.markersDir(sb.repo), { recursive: true });
		const full = path.join(
			markerRoot.markersDir(sb.repo),
			`.rule-injected-${id}-${agent}-${sessionId}`,
		);
		aged(full, ms);
		return full;
	};

	it("sweeps a finished session's markers and spares a live one's", () => {
		markers("ghost");
		markers("alice");
		live(sb, "alice");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(surviving("ghost")).toEqual([]);
		expect(surviving("alice")).toEqual(prefixes);
	});

	it("sweeps the Stop guards' block counters, mantahostels#1278's two and mantahostels#1308's third", () => {
		markers("ghost");
		live(sb, "someone-else");

		expect(cli(["prune-markers"]).status).toBe(0);

		for (const p of [
			".priced-options-nagged-",
			".green-suite-nagged-",
			".selection-sum-nagged-",
		])
			expect(fs.existsSync(path.join(sb.repo, `${p}ghost`))).toBe(false);
	});

	/*
	 * The whole point of mantahostels#1278's per-family age. At 25 hours a marker is gone and
	 * a breadcrumb must not be: mantahostels#1291's sample takes longer than a day to
	 * accumulate, so a shared day-long clock would delete the evidence before it
	 * could be read. The rates are on mantahostels#1278 and in lib/arbiter-markers.js.
	 */
	it("spares a dead session's breadcrumb past the marker age but under a week", () => {
		markers("ghost");
		crumbs("ghost", 25 * hour);
		live(sb, "someone-else");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(surviving("ghost")).toEqual([]);
		expect(crumbsLeft("ghost")).toEqual(crumbPrefixes);
	});

	it("sweeps a dead session's breadcrumb once it is over a week old", () => {
		crumbs("ghost", 8 * 24 * hour);
		live(sb, "someone-else");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(crumbsLeft("ghost")).toEqual([]);
	});

	/*
	 * The guard name sits between the prefix and the id and contains hyphens, so
	 * this only passes if liveness is matched on the filename's suffix rather than
	 * by slicing a fixed-length prefix.
	 */
	it("spares a live session's breadcrumb however old, past the guard name's hyphens", () => {
		crumbs("alice", 30 * 24 * hour);
		live(sb, "alice");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(crumbsLeft("alice")).toEqual(crumbPrefixes);
	});

	/* A live id must match the whole trailing segment, not merely appear in it. */
	it("does not spare a breadcrumb whose id is only a prefix of a live id", () => {
		crumbs("alic", 8 * 24 * hour);
		live(sb, "alice");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(crumbsLeft("alic")).toEqual([]);
	});

	/* And it must be the whole segment, not a tail of a longer one: without the
	 * separator, live "alice" would spare a breadcrumb belonging to "xalice". */
	it("does not spare a breadcrumb whose id merely ends with a live id", () => {
		crumbs("xalice", 8 * 24 * hour);
		live(sb, "alice");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(crumbsLeft("xalice")).toEqual([]);
	});

	/*
	 * The rule latches, through the CLI the SessionStart hook actually runs
	 * (mantahostels#1804). The matcher is pinned in lib/arbiter-markers.test.ts. Delete these
	 * before adding to them.
	 */
	it("sweeps a finished session's aged rule latch", () => {
		const f = latch("one", "main", "ghost", 25 * hour);
		live(sb, "someone-else");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(fs.existsSync(f)).toBe(false);
	});

	/* Sweeping this one would re-inject a rule the session has already been given. */
	it("spares a live session's rule latch however old, past the agent segment", () => {
		const f = latch("one", "main", "alice", 30 * 24 * hour);
		live(sb, "alice");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(fs.existsSync(f)).toBe(true);
	});

	/*
	 * A subagent's PreToolUse payload carries its PARENT's session_id, so the
	 * parent's liveness is the only liveness there is to read for a latch keyed
	 * under `a<agent_id>`.
	 */
	it("spares a subagent's rule latch under the live parent it is keyed to", () => {
		const f = latch("one", "aac7cb4a45383cc850", "alice", 30 * 24 * hour);
		live(sb, "alice");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(fs.existsSync(f)).toBe(true);
	});

	/*
	 * sweepAged walks the whole repo root, so the spare predicate is the only
	 * thing standing between this and deleting tracked files. An unrelated file
	 * older than both clocks must be untouched by either pass.
	 */
	it("never touches a file outside the swept families, however old", () => {
		// Weakest first: an unrelated file; a real root dotfile, which a defect
		// confined to dotfiles would still reach; and a near-miss sharing fifteen
		// characters with `.concision-base-`, differing only at the separator.
		fs.mkdirSync(markerRoot.markersDir(sb.repo), { recursive: true });
		const bystanders = [
			path.join(sb.repo, "package.json"),
			path.join(sb.repo, ".gitignore"),
			// Under the markers directory itself, not the repo root: since F8
			// (mantahostels#3515, #2) that is where the near-miss actually has
			// to be spared to prove anything.
			path.join(markerRoot.markersDir(sb.repo), ".concision-baseline-keep"),
		];
		for (const b of bystanders) aged(b, 400 * 24 * hour);
		live(sb, "alice");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(bystanders.filter((b) => !fs.existsSync(b))).toEqual([]);
	});

	/*
	 * The breadcrumb pass keeps its prefix test inside its own directory (mantahostels#3382),
	 * so a file in there under another name is spared, not swept (mantahostels#3394). The
	 * near-misses share `.hook-ran` and a dead session's suffix, one carrying the
	 * whole prefix mid-name; the dead crumbs prove the pass still ran.
	 */
	it("never touches a non-breadcrumb file in the breadcrumb directory, however old", () => {
		crumbs("ghost", 400 * 24 * hour);
		const strays = [
			"notes.txt",
			".hook-ranked-ghost",
			"x.hook-ran-guard-ghost",
		].map((f) => path.join(hookRecord.recordsDir(sb.repo), f));
		for (const s of strays) aged(s, 400 * 24 * hour);
		live(sb, "alice");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(strays.filter((s) => !fs.existsSync(s))).toEqual([]);
		expect(crumbsLeft("ghost")).toEqual([]);
	});

	/*
	 * All three sweeps read one liveness answer, so an unreadable registry must
	 * stop every one of them.
	 */
	it("sweeps no family when the sessions registry cannot be read", () => {
		markers("ghost");
		crumbs("ghost", 8 * 24 * hour);
		const stuckLatch = latch("one", "main", "ghost", 25 * hour);
		// A file where the directory should be: readdirSync throws ENOTDIR, which
		// is the "cannot tell live from finished" branch rather than ENOENT's
		// "nothing registered yet".
		const sessions = path.join(sb.home, "sessions");
		fs.rmSync(sessions, { recursive: true, force: true });
		fs.writeFileSync(sessions, "");

		expect(cli(["prune-markers"]).status).toBe(0);

		expect(surviving("ghost")).toEqual(prefixes);
		expect(crumbsLeft("ghost")).toEqual(crumbPrefixes);
		expect(fs.existsSync(stuckLatch)).toBe(true);
		// The log is the branch's only visibility: check-guard-errors reports it
		// under `npm run status`, so deleting the call must fail a test, not pass one.
		expect(fs.readFileSync(store.errorLog(), "utf8")).toContain("pruneMarkers");
	});
});

describe("debt — the denied session's half", () => {
	const rel = "docs/doc-map.md";
	/** The debt on rel owned by `issue`, or with no argument the unowned stub; null where none. */
	const readDebt = (issue: number | null = null) => readDebtOf(rel, issue);
	/** Who owes an edit on rel, in the order the store lists them. */
	const readOwners = (): (number | null)[] =>
		store
			.readDebts(rel)
			.map((e: { record: { issue: number | null } }) => e.record.issue);
	const debt = (...args: string[]) => cli(["debt", ...args]);
	const own = (issue = "123", gist?: string) =>
		debt("own", rel, issue, ...(gist === undefined ? [] : [gist]));

	describe("the stub a denial writes, through the real deny paths", () => {
		it("the hook's deny writes it, pointing at debt own, so the debt exists even if the denied session does nothing", () => {
			registerSession(sb, "alice", process.pid);
			store.acquire(rel, store.identify("alice"));
			registerSession(sb, "bob", process.pid);
			const json = JSON.parse(out(["check", inRepo(rel), "bob"]));
			expect(json.hookSpecificOutput.permissionDecision).toBe("deny");
			expect(json.hookSpecificOutput.permissionDecisionReason).toContain(
				"debt own",
			);
			expect(readDebt()).toMatchObject({
				path: rel,
				issue: null,
				recordedBy: "bob",
			});
		});

		it("a script's denial writes the stub too, not only the hook path's", () => {
			registerSession(sb, "alice", process.pid);
			store.acquire(rel, store.identify("alice"));
			registerSession(sb, "bob", process.pid);
			const r = cli(["claim", inRepo(rel), "bob"]);
			expect(r.status).toBe(1);
			expect(readDebt()).toMatchObject({
				path: rel,
				issue: null,
				recordedBy: "bob",
			});
		});
	});

	describe("the notice reaching a claimant", () => {
		it("rides a fresh claim's hook output into the claimant's context", () => {
			store.registerDenial(rel);
			registerSession(sb, "a", process.pid);
			const json = JSON.parse(out(["check", inRepo(rel), "a"]));
			expect(json.hookSpecificOutput.additionalContext).toContain(
				"carries a registered debt",
			);
		});

		it("fires once per session per file, not on every write", () => {
			// The second check is reentrant, so it skips the lookup.
			store.registerDenial(rel);
			registerSession(sb, "a", process.pid);
			expect(out(["check", inRepo(rel), "a"])).toContain("registered debt");
			expect(out(["check", inRepo(rel), "a"])).toBe("");
		});

		it("reaches a script's claim on stderr, without turning into an abort", () => {
			store.registerDenial(rel);
			registerSession(sb, "a", process.pid);
			const r = cli(["claim", inRepo(rel), "a"]);
			expect(r.status).toBe(0);
			expect(r.stderr).toContain("carries a registered debt");
		});

		// mantahostels#287 declined this notice on scripts/ as noise.
		it("stays off the detect-only tier", () => {
			store.registerDenial("scripts/thing.js");
			registerSession(sb, "a", process.pid);
			expect(out(["check", inRepo("scripts/thing.js"), "a"])).not.toContain(
				"registered debt",
			);
		});
	});

	describe("debt own", () => {
		it("completes the stub and reports the owner", () => {
			store.registerDenial(rel);
			// Backdated: a stub written and owned in the same millisecond carries the
			// same ISO string whether or not the timestamp was preserved.
			const denied = "2020-01-01T00:00:00.000Z";
			const stub = store.paths.debt(rel);
			core.writeRecord(stub, { ...core.readRecord(stub), createdAt: denied });
			const r = own("123", "one line on the edit");
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("owned by #123");
			expect(readDebt(123)).toMatchObject({
				issue: 123,
				gist: "one line on the edit",
				createdAt: denied,
			});
		});

		it("stamps the owning session, which the uncommitted-work guard reads (#1170)", () => {
			cli(["debt", "own", rel, "123", "gist"], {
				CLAUDE_CODE_SESSION_ID: "the-owner",
			});
			expect(readDebt(123).recordedBy).toBe("the-owner");
			cli(["debt", "own", rel, "124", "gist"], { CLAUDE_CODE_SESSION_ID: "" });
			expect(readDebt(124).recordedBy).toBeNull();
		});

		it("joins a multi-word gist rather than keeping only the first word", () => {
			own("123", "re-derive the ADR figure");
			expect(readDebt(123).gist).toBe("re-derive the ADR figure");
		});

		it("stores a gist opening `--` as text, never a flag (#1137)", () => {
			const r = own("123", "--help is what the gist says");
			expect(r.status).toBe(0);
			expect(readDebt(123).gist).toBe("--help is what the gist says");
		});

		it("accepts the #-prefixed spelling and stores the number", () => {
			expect(own("#77").status).toBe(0);
			expect(readDebt(77).issue).toBe(77);
		});

		it("records a missing gist as none, not as an empty string", () => {
			own("123");
			expect(readDebt(123).gist).toBeNull();
		});

		it("a second issue owning the same path adds an entry, never replacing (mantahostels#327)", () => {
			own("308", "the node-unit pass");
			own("323", ".github/workflows/scheduled-checks.yml's CI figures");
			expect(readOwners()).toEqual([308, 323]);
		});

		it.skipIf(AS_ROOT)(
			"exits 1 naming the path when the store refuses, without claiming a write failed",
			() => {
				// `own` reads the existing stub before writing, and that read can refuse
				// (mantahostels#174).
				store.registerDenial(rel);
				fs.chmodSync(store.paths.debtsDir(), 0o000);
				try {
					const r = own("123", "the gist");
					expect(r.status).toBe(1);
					expect(r.stderr).toContain(rel);
					expect(r.stderr).not.toContain("could not write the debt");
				} finally {
					fs.chmodSync(store.paths.debtsDir(), 0o755);
				}
			},
		);

		it("exits 2 on a path outside the repo, registering no debt", () => {
			const r = debt("own", "/etc/passwd", "123", "gist");
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("not in this repo");
			expect(readDebt()).toBeNull();
		});

		it("exits 2 on an issue that is not a number, and on none at all, printing the usage and recording no entry", () => {
			for (const args of [
				["own", rel, "abc", "gist"],
				["own", rel],
			]) {
				const r = debt(...args);
				expect(r.status).toBe(2);
				expect(r.stderr).toContain("usage");
			}
			expect(readDebt()).toBeNull();
		});

		it("exits 1 with the reason when the store cannot be written", () => {
			// 0555 — readable, not writable — so the read of the existing stub
			// succeeds and the WRITE is what fails.
			fs.mkdirSync(store.paths.debtsDir(), { recursive: true });
			fs.chmodSync(store.paths.debtsDir(), 0o555);
			let r: ReturnType<typeof own>;
			try {
				r = own();
			} finally {
				fs.chmodSync(store.paths.debtsDir(), 0o755);
			}
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("could not record the debt");
			expect(r.stderr).toContain(rel);
		});
	});

	describe("debt sweep — draining the register (mantahostels#1203)", () => {
		it("prints what it retired and what still stands, and exits 0", () => {
			ghClosedList(sb, [308]);
			own("308", "already done");
			own("323", "still owed");
			const r = debt("sweep");
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("retired\t#308");
			expect(r.stdout).toContain("#323\tdocs/doc-map.md\tstill owed");
			expect(r.stderr).toContain("1 retired");
			expect(r.stderr).toContain("1 standing");
		});

		it("names each stub it dropped, and the denial date it deleted with it", () => {
			// The print IS the feature: the entry is unlinked by the time this runs,
			// so these lines are the only place the path and date survive (mantahostels#1302).
			ghClosedList(sb, []);
			const stub = store.paths.debt("docs/other.md");
			fs.mkdirSync(store.paths.debtsDir(), { recursive: true });
			fs.writeFileSync(
				stub,
				JSON.stringify({
					path: "docs/other.md",
					issue: null,
					gist: null,
					createdAt: "2026-08-01T04:48:51.243Z",
				}),
			);
			const r = debt("sweep");
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("dropped\tUNOWNED\tdocs/other.md");
			expect(r.stdout).toContain("2026-08-01T04:48:51.243Z");
			expect(r.stderr).toContain("1 uncompletable stub dropped");
			expect(r.stderr).toContain("1 dropped (uncompletable stub)");
			expect(fs.existsSync(stub)).toBe(false);
		});

		it("says a stub was dropped even when gh cannot answer — the SKIP route deletes too", () => {
			fakeGh(sb, "exit 1");
			own("308", "already done");
			fs.mkdirSync(store.paths.debtsDir(), { recursive: true });
			fs.writeFileSync(
				store.paths.debt("docs/other.md"),
				JSON.stringify({
					path: "docs/other.md",
					issue: null,
					gist: null,
					createdAt: "2026-08-01T04:48:51.243Z",
				}),
			);
			const r = debt("sweep");
			expect(r.stderr).toContain("SKIP");
			expect(r.stdout).toContain("dropped\tUNOWNED\tdocs/other.md");
		});

		it.skipIf(AS_ROOT)(
			"names a stub it could not delete WITHOUT inventing an issue number",
			() => {
				// The owned-entry message reads "#<n> has closed but...". Reusing it
				// for a stub would print "#null" and send the reader looking for an
				// issue that never existed.
				ghClosedList(sb, []);
				fs.mkdirSync(store.paths.debtsDir(), { recursive: true });
				fs.writeFileSync(
					store.paths.debt("docs/other.md"),
					JSON.stringify({
						path: "docs/other.md",
						issue: null,
						gist: null,
						createdAt: "2026-08-01T04:48:51.243Z",
					}),
				);
				fs.chmodSync(store.paths.debtsDir(), 0o555);
				let r: ReturnType<typeof debt>;
				try {
					r = debt("sweep");
				} finally {
					fs.chmodSync(store.paths.debtsDir(), 0o755);
				}
				expect(r.stderr).toContain(
					"the uncompletable stub on docs/other.md could not be deleted",
				);
				expect(r.stderr).not.toContain("#null");
				expect(r.stderr).not.toContain("has closed but");
			},
		);

		it.skipIf(AS_ROOT)("names a refused deletion on the OFFLINE route", () => {
			// Deletions happen offline (mantahostels#1302), so a refused unlink there must
			// be named, not silently re-listed among the standing entries.
			fakeGh(sb, "exit 1");
			fs.mkdirSync(store.paths.debtsDir(), { recursive: true });
			fs.writeFileSync(
				store.paths.debt("docs/other.md"),
				JSON.stringify({
					path: "docs/other.md",
					issue: null,
					gist: null,
					createdAt: "2026-08-01T04:48:51.243Z",
				}),
			);
			own("308", "keeps the sweep asking");
			fs.chmodSync(store.paths.debtsDir(), 0o555);
			let r: ReturnType<typeof debt>;
			try {
				r = debt("sweep");
			} finally {
				fs.chmodSync(store.paths.debtsDir(), 0o755);
			}
			expect(r.stderr).toContain("SKIP");
			expect(r.stderr).toContain(
				"the uncompletable stub on docs/other.md could not be deleted",
			);
		});

		it("warns the reader that a survivor is not proof the work is outstanding", () => {
			// mantahostels#1203 spot-checked three standing entries whose edits the live files
			// already carried. A sweep that printed them as a to-do list would send
			// somebody to redo work that is already there.
			ghClosedList(sb, []);
			own("323", "still owed");
			expect(debt("sweep").stderr).toContain("NOT proof");
		});

		it("says nothing was retired, and exits 0, when gh cannot answer", () => {
			// SKIP, not a finding: GitHub being unreachable is the subject going
			// missing, and a red weekly job teaches the reader to skim past it.
			fakeGh(sb, "exit 1");
			own("308", "already done");
			const r = debt("sweep");
			expect(r.status).toBe(0);
			expect(r.stderr).toContain("SKIP");
			expect(r.stderr).toContain("UNCHECKED");
			expect(r.stdout).toContain("#308");
			expect(readDebt(308)).not.toBeNull();
		});

		it.skipIf(AS_ROOT)(
			"still counts what it could not parse on the SKIP route",
			() => {
				// A short list plus no count reads as the whole of what is owed —
				// mantahostels#174's failure, and the SKIP route is where it is easiest to miss.
				fakeGh(sb, "exit 1");
				own("308", "already done");
				const hidden = store.paths.debt("docs/other.md", 323);
				fs.writeFileSync(hidden, "{}");
				fs.chmodSync(hidden, 0o000);
				try {
					const r = debt("sweep");
					expect(r.stderr).toContain("SKIP");
					expect(r.stderr).toContain("1 entry could not be parsed");
				} finally {
					fs.chmodSync(hidden, 0o644);
				}
			},
		);

		it("SKIPs on a machine with no register rather than reporting it drained", () => {
			// What a CI runner and a fresh checkout see: the store lives under
			// ~/.claude/projects/<repo>/, outside the tree, so a scheduled run
			// there keeps the sweep runnable and drains nothing.
			ghClosedList(sb, [308]);
			const r = debt("sweep");
			expect(r.status).toBe(0);
			expect(r.stderr).toContain("SKIP: no debt register on this machine");
			expect(r.stdout).toBe("");
		});

		it.skipIf(AS_ROOT)("exits 2 BROKEN on a store it cannot read", () => {
			own("308", "already done");
			fs.chmodSync(store.paths.debtsDir(), 0o000);
			try {
				const r = debt("sweep");
				expect(r.status).toBe(2);
				expect(r.stderr).toContain("BROKEN");
			} finally {
				fs.chmodSync(store.paths.debtsDir(), 0o755);
			}
		});
	});

	describe("debt clear and debt list", () => {
		it("clear retires the entry", () => {
			store.registerDenial(rel);
			const r = debt("clear", rel);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("cleared");
			expect(readDebt()).toBeNull();
		});

		it("clearing a path with no debt is no fault", () => {
			const r = debt("clear", rel);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("No debt registered");
		});

		it("clear exits 2 on a path outside the repo", () => {
			expect(debt("clear", "/etc/passwd").status).toBe(2);
		});

		it("clear refuses a path with several debts, and prints the command for each (mantahostels#327)", () => {
			own("308", "the node-unit pass");
			own("323", ".github/workflows/scheduled-checks.yml's CI figures");
			const r = debt("clear", rel);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("debt clear docs/doc-map.md 308");
			expect(r.stderr).toContain("debt clear docs/doc-map.md 323");
			expect(store.readDebts(rel)).toHaveLength(2); // nothing was taken
		});

		it("clear takes the owner, in either spelling, and retires only that entry", () => {
			own("308", "the node-unit pass");
			own("323", ".github/workflows/scheduled-checks.yml's CI figures");
			expect(debt("clear", rel, "#308").stdout).toContain("owned by #308");
			expect(readOwners()).toEqual([323]);
		});

		it("clear takes `unowned` for the stub a denial wrote", () => {
			own("308", "the node-unit pass");
			store.registerDenial(rel);
			expect(debt("clear", rel, "unowned").status).toBe(0);
			expect(readOwners()).toEqual([308]);
		});

		it("clear exits 2 on an owner that is neither a number nor `unowned`, with usage, leaving the debt in place", () => {
			store.registerDenial(rel);
			const r = debt("clear", rel, "mine");
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("usage");
			expect(store.readDebts(rel)).toHaveLength(1);
		});

		it("clear names the owner it found nothing for, rather than a bare miss", () => {
			own("308", "the node-unit pass");
			expect(debt("clear", rel, "999").stdout).toContain("999");
		});

		it("list shows owned and unowned entries, and an empty store as empty", () => {
			expect(debt("list").stdout).toContain("No debts registered.");

			own("123", "the gist");
			store.registerDenial("docs/other.md");
			const printed = debt("list").stdout;
			expect(printed).toContain(`#123\t${rel}\tthe gist`);
			expect(printed).toContain("UNOWNED\tdocs/other.md\t(no gist)");
		});

		it("list prints a record older than the recorder field beside a new one (#1170)", () => {
			fs.mkdirSync(store.paths.debtsDir(), { recursive: true });
			fs.writeFileSync(
				store.paths.debt("docs/old.md", 9),
				JSON.stringify({
					path: "docs/old.md",
					issue: 9,
					gist: "old",
					createdAt: "2026-01-01T00:00:00.000Z",
				}),
			);
			own("123", "new");
			const printed = debt("list").stdout;
			expect(printed).toContain("#9\tdocs/old.md\told");
			expect(printed).toContain(`#123\t${rel}\tnew`);
		});

		it.skipIf(AS_ROOT)(
			"list exits 1 rather than showing an unreadable store as empty (mantahostels#174)",
			() => {
				// A debt entry is the only durable record that a session abandoned an
				// edit.
				own("123", "the gist");
				fs.chmodSync(store.paths.debtsDir(), 0o000);
				try {
					const r = debt("list");
					expect(r.status).toBe(1);
					expect(r.stdout).not.toContain("No debts registered.");
					expect(r.stderr).toMatch(/could not read the debt store/);
				} finally {
					fs.chmodSync(store.paths.debtsDir(), 0o755);
				}
			},
		);

		it.skipIf(AS_ROOT)(
			"list prints an entry it could not read rather than a short list (mantahostels#174)",
			() => {
				own("123", "the gist");
				store.registerDenial("docs/other.md");
				const hidden = store.paths.debt("docs/other.md");
				fs.chmodSync(hidden, 0o000);
				try {
					const printed = debt("list").stdout;
					expect(printed).toContain("#123");
					expect(printed).toMatch(/\?\?\?\?\?\s+\(unreadable debt file/);
				} finally {
					fs.chmodSync(hidden, 0o644);
				}
			},
		);

		it("list makes no network call, so it cannot stall or half-empty itself", () => {
			ghAnswers(sb, "CLOSED");
			own();
			const r = debt("list");
			expect(r.stdout).toContain("#123");
			expect(ghCallCount(sb)).toBe(0);
			expect(readDebt(123)).not.toBeNull();
		});

		it("list prints a path's several debts together, in issue order", () => {
			own("323", "second");
			own("308", "first");
			const lines = debt("list")
				.stdout.trim()
				.split("\n")
				.map((l) => l.split("\t")[0]);
			expect(lines).toEqual(["#308", "#323"]);
		});

		it.skipIf(AS_ROOT)(
			"clear exits 1 rather than reporting an unreadable store as nothing owed (mantahostels#174)",
			() => {
				own("308", "the node-unit pass");
				fs.chmodSync(store.paths.debtsDir(), 0o000);
				try {
					const r = debt("clear", rel);
					expect(r.status).toBe(1);
					expect(r.stdout).not.toContain("No debt registered");
					expect(r.stderr).toMatch(/could not read the debt store/);
				} finally {
					fs.chmodSync(store.paths.debtsDir(), 0o755);
				}
			},
		);

		it("a bare `debt` is list, and an unknown action exits 2 with usage", () => {
			expect(debt().stdout).toContain("No debts registered.");
			const r = debt("frobnicate");
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("usage");
		});
	});
});

describe("the clobber report — a write by a route no hook watches (mantahostels#295)", () => {
	// Report-only, on both tiers. mantahostels#288 followed check-stale-claims.js's doctrine:
	// "THIS SCRIPT NEVER WRITES … the machine displays it, a person acts."
	const auditScript = "scripts/evidence-audit.py";

	beforeEach(() => {
		gitRepo(sb);
		fs.mkdirSync(path.join(sb.repo, "scripts"), { recursive: true });
		registerSession(sb, "alice", process.pid);
	});

	const write = (rel: string, text: string) =>
		fs.writeFileSync(inRepo(rel), text);
	const notes = (stdout: string) =>
		stdout ? JSON.parse(stdout).hookSpecificOutput : {};

	/** One tool write by alice: the PreToolUse check, then the PostToolUse record. */
	const aliceWrites = (rel: string, text: string) => {
		const pre = out(["check", inRepo(rel), "alice"]);
		write(rel, text);
		out(["record", inRepo(rel), "alice"]);
		return pre;
	};

	it("warns and names the recovery command, and never denies", () => {
		aliceWrites(auditScript, "alice's uncommitted work\n");

		// The incident's own shape: a whole-file write from outside this session.
		write(auditScript, "restored from a backup\n");

		const seen = notes(out(["check", inRepo(auditScript), "alice"]));
		expect(seen.permissionDecision).toBeUndefined();
		expect(seen.additionalContext).toContain("has changed since this session");
		expect(readRecoveredBlob(seen.additionalContext)).toBe(
			"alice's uncommitted work\n",
		);
	});

	it("says nothing when the claimant's own writes are what changed the file", () => {
		aliceWrites(auditScript, "one\n");
		expect(out(["check", inRepo(auditScript), "alice"])).toBe("");
		aliceWrites(auditScript, "two\n");
		expect(out(["check", inRepo(auditScript), "alice"])).toBe("");
	});

	it("refreshes after a Bash write, so the claimant's own sed is not a clobber", () => {
		// The 42% class, end to end. `refresh` is what the PostToolUse Bash hook
		// runs; without it this same sequence reports a clobber.
		aliceWrites("docs/doc-map.md", "v1.35\n");
		write("docs/doc-map.md", "v1.36\n"); // sed -i '3s/v1.35/v1.36/'
		out(["refresh", "alice"]);
		expect(out(["check", inRepo("docs/doc-map.md"), "alice"])).toBe("");
	});

	it("refreshes only what this session holds, so a neighbour's file is untouched", () => {
		registerSession(sb, "bob", process.pid);
		aliceWrites("docs/alice.md", "alice\n");
		out(["check", inRepo("docs/bob.md"), "bob"]);
		write("docs/bob.md", "bob's\n");
		out(["record", inRepo("docs/bob.md"), "bob"]);

		// Alice's refresh must not re-record bob's claim — doing so would erase the
		// evidence bob is owed the moment somebody clobbers HIS file.
		write("docs/bob.md", "clobbered\n");
		out(["refresh", "alice"]);
		expect(
			notes(out(["check", inRepo("docs/bob.md"), "bob"])).additionalContext,
		).toContain("has changed since this session");
	});

	it("watches the detect-only tier and refuses nothing on it", () => {
		// mantahostels#287 put scripts/ in a second tier: the recorder keys off the union, the
		// refusal keys off the refusing tier alone. Keying refusals off the union
		// would impose a per-file mutex on the repo's busiest directory.
		aliceWrites(auditScript, "alice's\n");
		registerSession(sb, "bob", process.pid);
		expect(
			notes(out(["check", inRepo(auditScript), "bob"])).permissionDecision,
		).toBeUndefined();

		// And the claim really was taken, or there is nothing to compare against.
		expect(
			store.listLocks().some((l: { path: string }) => l.path === auditScript),
		).toBe(true);
	});

	it("still denies on the refusing tier", () => {
		aliceWrites("docs/doc-map.md", "alice's\n");
		registerSession(sb, "bob", process.pid);
		expect(
			notes(out(["check", inRepo("docs/doc-map.md"), "bob"]))
				.permissionDecision,
		).toBe("deny");
	});

	it("keeps the detect-only tier quiet about dirt nobody claims", () => {
		// The dirty-and-unclaimed warn stays on the refusing tier: on scripts/, the
		// repo's busiest directory, it would fire on most writes — noise mantahostels#287
		// declined to buy.
		write(auditScript, "uncommitted, unclaimed\n");
		expect(out(["check", inRepo(auditScript), "alice"])).toBe("");

		write("docs/doc-map.md", "uncommitted, unclaimed\n");
		expect(
			notes(out(["check", inRepo("docs/doc-map.md"), "alice"]))
				.additionalContext,
		).toContain("uncommitted changes that no live session claims");
	});

	it("releases a detect-only claim, so its holder can give the file back", () => {
		aliceWrites(auditScript, "alice's\n");
		commitAll(sb);
		expect(
			cli(["release", inRepo(auditScript)], { CLAUDE_CODE_SESSION_ID: "alice" })
				.stdout,
		).toContain("Released");
	});

	it("lets a script claim a detect-only path, and never aborts it there", () => {
		// cmdClaim is the helper a SCRIPT calls for itself, and mantahostels#103 ruled it must
		// abort its caller. Two halves, and they moved in opposite directions: the
		// CLAIM now spans the watched union, so a script writing a scripts/ file gets
		// a content record; the ABORT stays on the refusing tier, since there is
		// nothing to abort where nothing is refused, and aborting here would be the
		// per-file mutex on the repo's busiest directory that mantahostels#287 declined.
		//
		// Alice takes both claims BEFORE bob is registered: the registry is keyed by
		// pid, so registering bob replaces alice's entry and alice can take no more.
		fs.writeFileSync(inRepo("scripts/tool.js"), "alice's\n");
		expect(cli(["claim", inRepo("scripts/tool.js"), "alice"]).status).toBe(0);
		expect(
			store
				.listLocks()
				.some((l: { path: string }) => l.path === "scripts/tool.js"),
		).toBe(true);
		expect(out(["writes", "alice"])).toContain("scripts/tool.js");

		aliceWrites("docs/doc-map.md", "alice's\n");
		registerSession(sb, "bob", process.pid);

		const r = cli(["claim", inRepo("scripts/tool.js"), "bob"]);
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("is held by session");

		// A refusing path is still aborted, so the widening did not disarm it.
		expect(cli(["claim", inRepo("docs/doc-map.md"), "bob"]).status).toBe(1);
	});

	describe("a second writer's own baseline on the detect-only tier (mantahostels#363)", () => {
		/** One tool write by bob to a path alice holds: check, write, record. */
		const bobWrites = (rel: string, text: string) => {
			const pre = out(["check", inRepo(rel), "bob"]);
			write(rel, text);
			out(["record", inRepo(rel), "bob"]);
			return pre;
		};
		beforeEach(() => {
			aliceWrites(auditScript, "alice's uncommitted work\n");
			registerSession(sb, "bob", process.pid);
		});

		it("reports the clobber to the second writer, naming ITS bytes to recover", () => {
			// The bug the one-line fix would have shipped: reading the lock alice holds
			// gives bob alice's blob, so the recovery command hands bob a neighbour's
			// content as his own last write.
			expect(notes(bobWrites(auditScript, "bob's uncommitted work\n"))).toEqual(
				{},
			);

			write(auditScript, "restored from a backup\n"); // the clobber, by any route

			const seen = notes(out(["check", inRepo(auditScript), "bob"]));
			expect(seen.permissionDecision).toBeUndefined(); // still nothing refused
			expect(seen.additionalContext).toContain(
				"has changed since this session",
			);
			expect(readRecoveredBlob(seen.additionalContext)).toBe(
				"bob's uncommitted work\n",
			);
		});

		it("leaves the holder's report naming the holder's own bytes", () => {
			bobWrites(auditScript, "bob's uncommitted work\n");
			const seen = notes(out(["check", inRepo(auditScript), "alice"]));
			expect(seen.additionalContext).toContain(
				"has changed since this session",
			);
			expect(readRecoveredBlob(seen.additionalContext)).toBe(
				"alice's uncommitted work\n",
			);
		});

		it("says nothing when the second writer's own writes are what changed it", () => {
			bobWrites(auditScript, "bob's one\n");
			expect(out(["check", inRepo(auditScript), "bob"])).toBe("");
			bobWrites(auditScript, "bob's two\n");
			expect(out(["check", inRepo(auditScript), "bob"])).toBe("");
		});

		it("refreshes after a Bash write, so the second writer's own sed is not a clobber", () => {
			bobWrites(auditScript, "v1.35\n");
			write(auditScript, "v1.36\n"); // sed -i, which no PostToolUse write hook sees
			out(["refresh", "bob"]);
			expect(out(["check", inRepo(auditScript), "bob"])).toBe("");
		});

		it("reports and drops the second writer's record on release, and still refuses", () => {
			// The verdict is unchanged — a claim bob never took is not bob's to drop.
			bobWrites(auditScript, "bob's uncommitted work\n");
			write(auditScript, "restored from a backup\n");

			const r = cli(["release", inRepo(auditScript)], {
				CLAUDE_CODE_SESSION_ID: "bob",
			});
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("has changed since this session");
			expect(readRecoveredBlob(r.stderr)).toBe("bob's uncommitted work\n");
			expect(r.stderr).toContain("is held by session");
			expect(out(["check", inRepo(auditScript), "bob"])).toBe("");
		});
	});

	describe("a writer that took no claim at all (mantahostels#2333, mantahostels#2353)", () => {
		/** A tool write whose PreToolUse check never ran — the fail-open. */
		const unguardedWrite = (text: string) => {
			write(auditScript, text);
			out(["record", inRepo(auditScript), "alice"]);
		};

		it("reports the clobber, and the command it prints recovers ITS bytes", () => {
			unguardedWrite("alice's unclaimed work\n");

			write(auditScript, "restored from a backup\n"); // the clobber, by any route

			const seen = notes(out(["check", inRepo(auditScript), "alice"]));
			expect(seen.permissionDecision).toBeUndefined(); // still nothing refused
			expect(seen.additionalContext).toContain(
				"has changed since this session",
			);
			expect(readRecoveredBlob(seen.additionalContext, true)).toBe(
				"alice's unclaimed work\n",
			);
		});

		it("says nothing while the writer's own bytes stand, then speaks", () => {
			unguardedWrite("alice's unclaimed work\n");
			expect(out(["check", inRepo(auditScript), "alice"])).toBe("");
			unguardedWrite("alice's second pass\n");
			expect(out(["check", inRepo(auditScript), "alice"])).toBe("");

			write(auditScript, "restored from a backup\n");
			expect(
				notes(out(["check", inRepo(auditScript), "alice"])).additionalContext,
			).toContain("has changed since this session");
		});

		it("reports it on release too, worded for a reader holding no claim", () => {
			unguardedWrite("alice's unclaimed work\n");
			write(auditScript, "restored from a backup\n");

			const r = cli(["release", inRepo(auditScript)], {
				CLAUDE_CODE_SESSION_ID: "alice",
			});
			expect(r.status).toBe(0);
			expect(r.stdout).toContain(`No claim on ${auditScript}`);
			expect(r.stderr).toContain("has changed since this session");
			expect(r.stderr).not.toContain("The claim is dropped");
			expect(readRecoveredBlob(r.stderr)).toBe("alice's unclaimed work\n");
		});
	});

	describe("the second reporting site — release (mantahostels#332)", () => {
		const commit = () => commitAll(sb);
		const release = (rel: string) =>
			cli(["release", inRepo(rel)], { CLAUDE_CODE_SESSION_ID: "alice" });

		it("warns on the way out with a command that recovers the work, drops the claim anyway, and exits 0", () => {
			// The window the next-write report cannot see: the clobber lands after
			// alice's last write.
			aliceWrites(auditScript, "alice's work\n");
			commit();
			write(auditScript, "restored from a backup\n");
			commit();

			const r = release(auditScript);
			expect(r.status).toBe(0);
			expect(r.stdout).toContain("Released scripts/evidence-audit.py");
			expect(r.stderr).toContain("has changed since this session");

			// Released, not merely reported: a refusal here strands the claim for the
			// holder's whole process, the wedge mantahostels#104 forbids.
			expect(
				store.listLocks().some((l: { path: string }) => l.path === auditScript),
			).toBe(false);

			// The pin is dropped with the claim, so the id is only worth printing
			// while the loose object survives.
			const sha = r.stderr.match(/git cat-file -p ([0-9a-f]{40,64})/)?.[1];
			expect(
				execFileSync("git", ["cat-file", "-p", sha as string], {
					cwd: sb.repo,
					encoding: "utf8",
				}),
			).toBe("alice's work\n");
		});

		it("says only what it dropped when nobody touched the file", () => {
			aliceWrites(auditScript, "alice's work\n");
			commit();

			const r = release(auditScript);
			expect(r.stdout).toBe("Released scripts/evidence-audit.py.\n");
			expect(r.stderr).toBe("");
		});

		it("stays silent on a claim never recorded — unknown is not changed", () => {
			write(auditScript, "alice's work\n");
			out(["check", inRepo(auditScript), "alice"]); // claimed, never recorded
			commit();

			expect(release(auditScript).stderr).toBe("");
		});

		it("carries the clobber into the dirty refusal, which still refuses (mantahostels#337)", () => {
			// The commoner shape: the clobbering write is left uncommitted, so the
			// refusal fires first and the session is told only "commit or discard" —
			// and committing puts the neighbour's bytes under its own message (mantahostels#63).
			aliceWrites(auditScript, "alice's work\n");
			commit();
			write(auditScript, "restored from a backup\n"); // the clobber, uncommitted

			const r = release(auditScript);
			expect(r.status).toBe(1);
			expect(r.stderr).toMatch(
				/has uncommitted changes, and nothing here could prove .*, so the claim stands/,
			);
			expect(r.stderr).toContain("has changed since this session");
			// Recovery before the instruction that would bury it.
			expect(r.stderr.indexOf("has changed since this session")).toBeLessThan(
				r.stderr.indexOf("has uncommitted changes"),
			);

			// The claim stands, so the pin stands with it.
			expect(
				store.listLocks().some((l: { path: string }) => l.path === auditScript),
			).toBe(true);
			const sha = r.stderr.match(/git cat-file -p ([0-9a-f]{40,64})/)?.[1];
			expect(
				execFileSync("git", ["cat-file", "-p", sha as string], {
					cwd: sb.repo,
					encoding: "utf8",
				}),
			).toBe("alice's work\n");
		});

		it("carries the clobber into the uncheckable refusal, which still refuses (mantahostels#420)", () => {
			// The partial git failure: with .git/HEAD gone `status` exits 128 while
			// `hash-object` still answers, so cleanliness is unproven and the clobber
			// is knowable at once.
			aliceWrites(auditScript, "alice's work\n");
			commit();
			write(auditScript, "restored from a backup\n");
			fs.rmSync(path.join(sb.repo, ".git", "HEAD"));

			const r = release(auditScript);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("could not read git status");
			expect(r.stderr).toContain("has changed since this session");
			expect(r.stderr.indexOf("has changed since this session")).toBeLessThan(
				r.stderr.indexOf("could not read git status"),
			);
			// The pin keeps with the claim, off git's fortnight clock.
			expect(r.stderr).toContain("the claim and its pin both stand");
			expect(
				store.listLocks().some((l: { path: string }) => l.path === auditScript),
			).toBe(true);
		});

		it("says nothing extra on an uncheckable refusal nobody clobbered", () => {
			aliceWrites(auditScript, "alice's work\n");
			commit();
			fs.rmSync(path.join(sb.repo, ".git", "HEAD"));

			const r = release(auditScript);
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("could not read git status");
			expect(r.stderr).not.toContain("has changed since this session");
		});

		it("carries the clobber into the contended refusal (mantahostels#420)", () => {
			// The swap has to land between the store's read of the lock and its drop,
			// and the only window inside that span is a `git` call — so a stub at WFC_GIT
			// rewrites the claimId as `git status` runs, exactly as a neighbour
			// retaking the file would.
			aliceWrites(auditScript, "alice's work\n");
			commit();
			write(auditScript, "restored from a backup\n");
			commit();

			const { git } = writeFaultyGit(
				{ words: ["status"] },
				{
					script: `sed -i -E 's/("claimId"[[:space:]]*:[[:space:]]*")[^"]*/\\1swapped/' ${shellQuote(store.paths.lock(auditScript))}`,
				},
				{ under: sb.dir },
			);

			const r = cli(["release", inRepo(auditScript)], {
				CLAUDE_CODE_SESSION_ID: "alice",
				WFC_GIT: git,
			});
			expect(r.status).toBe(1);
			expect(r.stderr).toContain("changed while releasing it");
			expect(r.stderr).toContain("has changed since this session");
			expect(r.stderr.indexOf("has changed since this session")).toBeLessThan(
				r.stderr.indexOf("changed while releasing it"),
			);
			expect(r.stderr).toContain("the claim and its pin both stand");
		});

		it("refuses dirty in silence on the session's own unfinished edit", () => {
			// Nothing to report on the claimant's own edit (mantahostels#288), so the refusal
			// prints alone.
			aliceWrites(auditScript, "alice's work\n");
			commit();
			aliceWrites(auditScript, "alice's next edit\n");

			const r = release(auditScript);
			expect(r.status).toBe(1);
			expect(r.stderr).toMatch(
				/has uncommitted changes, and nothing here could prove .*, so the claim stands/,
			);
			expect(r.stderr).not.toContain("has changed since this session");
		});
	});

	describe("the third reporting site — a claim broken while its holder lived (mantahostels#349)", () => {
		/**
		 * Alice's process ends, or her registry entry is pruned: the lock is left
		 * recording a pid that is gone, and nothing can repoint it onto a live one.
		 */
		const aliceDisappears = () => {
			const lock = core.readRecord(store.paths.lock(auditScript));
			fs.writeFileSync(
				store.paths.lock(auditScript),
				JSON.stringify({ ...lock, pid: 999_999, procStart: "1" }),
			);
			fs.rmSync(path.join(sb.home, "sessions", `${process.pid}.json`));
			return lock;
		};

		it("tells the loser what happened and hands back its version", () => {
			aliceWrites(auditScript, "alice's work\n");
			aliceDisappears();

			registerSession(sb, "bob", process.pid);
			out(["check", inRepo(auditScript), "bob"]); // the break
			write(auditScript, "bob's replacement\n"); // the clobber

			registerSession(sb, "alice", process.pid);
			const seen = notes(out(["check", inRepo(auditScript), "alice"]));
			expect(seen.additionalContext).toContain("was broken at");
			expect(seen.additionalContext).toContain("bob");

			const sha = seen.additionalContext.match(
				/git cat-file -p ([0-9a-f]{40,64})/,
			)?.[1];
			expect(
				execFileSync("git", ["cat-file", "-p", sha as string], {
					cwd: sb.repo,
					encoding: "utf8",
				}),
			).toBe("alice's work\n");
		});

		it("carries the news into the denial, where the loser is most often standing", () => {
			// On the refusing tier the breaker holds the file, so the loser's next
			// write is denied.
			aliceWrites("docs/doc-map.md", "alice's work\n");
			const lock = core.readRecord(store.paths.lock("docs/doc-map.md"));
			fs.writeFileSync(
				store.paths.lock("docs/doc-map.md"),
				JSON.stringify({ ...lock, pid: 999_999, procStart: "1" }),
			);
			fs.rmSync(path.join(sb.home, "sessions", `${process.pid}.json`));

			registerSession(sb, "bob", process.pid);
			out(["check", inRepo("docs/doc-map.md"), "bob"]);

			registerSession(sb, "alice", process.pid);
			const seen = notes(out(["check", inRepo("docs/doc-map.md"), "alice"]));
			expect(seen.permissionDecision).toBe("deny");
			expect(seen.permissionDecisionReason).toContain("was broken at");
			expect(seen.permissionDecisionReason).toContain("git cat-file -p");
		});

		it("keeps the pin across the session-start sweep, then drops it with the record", () => {
			aliceWrites(auditScript, "alice's work\n");
			const broken = aliceDisappears();
			registerSession(sb, "bob", process.pid);
			out(["check", inRepo(auditScript), "bob"]);

			// The claim is gone, so the lock store alone would collect the pin here.
			out(["prune-markers"]);
			expect(readRefs()).toEqual([`refs/arbiter/${broken.claimId}`]);

			const file = store.paths.break(auditScript, broken.claimId);
			fs.writeFileSync(
				file,
				JSON.stringify({
					...core.readRecord(file),
					at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
				}),
			);

			out(["prune-markers"]);
			expect(readRefs()).toEqual([]);
		});
	});

	it("prune-markers sweeps the pins of claims that are gone", () => {
		aliceWrites(auditScript, "alice's\n");
		expect(readRefs()).toHaveLength(1);

		fs.rmSync(store.paths.locksDir(), { recursive: true, force: true });
		out(["prune-markers"]);
		expect(readRefs()).toEqual([]);
	});

	/*
	 * The pins go in ONE `update-ref --stdin`, which is atomic: a batch built
	 * wrong rejects whole and collects NOTHING, so a single-orphan test would
	 * pass over the very failure batching introduced (mantahostels#1899).
	 */
	it("collects a whole backlog of pins, not just the first", () => {
		for (const rel of ["docs/doc-map.md", "AGENTS.md", "CLAUDE.md"])
			aliceWrites(rel, `alice on ${rel}\n`);
		expect(readRefs().length).toBeGreaterThan(1);

		fs.rmSync(store.paths.locksDir(), { recursive: true, force: true });
		out(["prune-markers"]);
		expect(readRefs()).toEqual([]);
	});
});

/*
 * The SessionStart registration (mantahostels#1899). The sweep's cost tracks the record
 * backlog rather than the session, so it cannot be held to the hook's 10s
 * budget — `--detach` hands it to a child and returns. The child still has to
 * do the whole job, which is what these prove.
 */
describe("prune-markers --detach, the SessionStart form", () => {
	const docMap = "docs/doc-map.md";

	beforeEach(() => {
		gitRepo(sb);
		registerSession(sb, "alice", process.pid);
	});

	/** One tool write by alice, which is what mints the pin swept below. */
	const aliceWrites = (rel: string, text: string) => {
		out(["check", inRepo(rel), "alice"]);
		fs.writeFileSync(inRepo(rel), text);
		out(["record", inRepo(rel), "alice"]);
	};

	it("exits 0 and says nothing, so a session start is never blocked", () => {
		const r = cli(["prune-markers", "--detach"]);
		expect(r.status).toBe(0);
		expect(`${r.stdout}${r.stderr}`).toBe("");
	});

	it("still sweeps, in the child it launched", async () => {
		aliceWrites(docMap, "alice's\n");
		expect(readRefs()).toHaveLength(1);
		fs.rmSync(store.paths.locksDir(), { recursive: true, force: true });

		expect(cli(["prune-markers", "--detach"]).status).toBe(0);

		/* Polled, not slept: the child is a separate process and nothing here can
		 * wait on it. A `--detach` that spawned nothing runs this out. */
		const deadline = Date.now() + 20_000;
		while (readRefs().length > 0 && Date.now() < deadline)
			await new Promise((r) => setTimeout(r, 100));
		expect(readRefs()).toEqual([]);
	}, 30_000);
});

describe("release --force, the escape for a stranded claim (mantahostels#411)", () => {
	// mantahostels#254: the holder's host outlives its job, so its process reads alive and the
	// identity gate refuses everyone. The force is gated on `claude agents --json`
	// instead — and refuses whenever that cannot be read (mantahostels#319).
	const rel = "docs/doc-map.md";
	const run = (args: string[], sid: string) =>
		cli(args, { CLAUDE_CODE_SESSION_ID: sid, WFC_CLAUDE_BIN: claudeBin() });

	const claudeBin = () => path.join(sb.dir, "bin", "claude");
	const calls = () => path.join(sb.dir, "claude-calls");

	/**
	 * A `claude` stand-in listing these sessions, recording every invocation. A
	 * bare id lists as a session with no state; an object carries the `kind` and
	 * `state` the oracle's `terminal` set is derived from.
	 */
	const fakeClaude = (
		ids: (string | { sessionId: string; kind?: string; state?: string })[],
		code = 0,
	) => {
		fs.mkdirSync(path.join(sb.dir, "bin"), { recursive: true });
		const body = JSON.stringify(
			ids.map((a) => (typeof a === "string" ? { sessionId: a } : a)),
		);
		fs.writeFileSync(
			claudeBin(),
			`#!/bin/sh\necho hit >> "${calls()}"\ncat <<'EOF'\n${body}\nEOF\nexit ${code}\n`,
		);
		fs.chmodSync(claudeBin(), 0o755);
	};

	const oracleCalls = () =>
		fs.existsSync(calls())
			? fs.readFileSync(calls(), "utf8").split("\n").filter(Boolean).length
			: 0;

	beforeEach(() => {
		gitRepo(sb);
		fs.writeFileSync(inRepo(rel), "alice's work\n");
		commitAll(sb);
		const alice = live(sb, "alice");
		store.acquire(rel, alice);
		store.recordContent(rel, alice);
		live(sb, "bob");
	});

	it("drops a stranded claim and prints how to recover what it took", () => {
		fakeClaude(["bob"]);
		const r = run(["release", "--force", inRepo(rel)], "bob");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Force-released docs/doc-map.md");
		expect(r.stderr).toContain("alice");
		expect(r.stderr).toMatch(/git cat-file -p [0-9a-f]{40,64}/);
		expect(
			store.listLocks().some((l: { path: string }) => l.path === rel),
		).toBe(false);
	});

	it("exits 1 and names the holder while the oracle lists it live", () => {
		fakeClaude(["alice", "bob"]);
		const r = run(["release", "--force", inRepo(rel)], "bob");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("alice");
		expect(r.stderr).toContain("still lists as live");
		// mantahostels#1195: never send the caller to ask a holder that may be blocked on the
		// caller's own file. `wait` registers a want, so a cycle ends it as
		// DEADLOCK (#542); and spell the debt command, this being the escape
		// path's terminal site.
		expect(r.stderr).not.toContain("Ask that session");
		expect(r.stderr).toContain(
			"node scripts/session-arbiter.js wait docs/doc-map.md",
		);
		expect(r.stderr).toContain("debt own docs/doc-map.md <issue>");
	});

	it("drops the claim of a listed holder the oracle calls done, through the real oracle (#268)", () => {
		// The end-to-end proof that `listedSessionIds` delivers `terminal` to
		// forceRelease: the store's own tests inject a synthetic oracle, so
		// nothing else would catch the field going missing from this seam.
		fakeClaude([
			{ sessionId: "alice", kind: "background", state: "done" },
			"bob",
		]);
		const r = run(["release", "--force", inRepo(rel)], "bob");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Force-released docs/doc-map.md");
	});

	it("exits 1 on an unreadable oracle, naming retry, reboot and the Bash route", () => {
		// Not a warn and not a fallback to releasing: a stranded claim costs time, a
		// broken lock costs work (mantahostels#322).
		fakeClaude(["bob"], 3);
		const r = run(["release", "--force", inRepo(rel)], "bob");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("NOT released");
		expect(r.stderr).toMatch(/retry/i);
		expect(r.stderr).toMatch(/reboot/i);
		expect(r.stderr).toMatch(/Bash route/i);
	});

	it("refuses a dirty file with --force, exactly as without it", () => {
		fakeClaude(["bob"]);
		fs.writeFileSync(inRepo(rel), "half an edit\n");
		const r = run(["release", "--force", inRepo(rel)], "bob");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("uncommitted changes");
	});

	it("warns about a clobber before the dirty refusal, naming the claimant (mantahostels#337)", () => {
		// "Commit or discard" is destructive advice once a third route has replaced
		// the bytes, and under --force the bytes at stake are somebody else's.
		fakeClaude(["bob"]);
		fs.writeFileSync(inRepo(rel), "restored from a backup\n");
		const r = run(["release", "--force", inRepo(rel)], "bob");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("claimant alice");
		expect(r.stderr).toMatch(/git cat-file -p [0-9a-f]{40,64}/);
		expect(r.stderr.indexOf("cat-file")).toBeLessThan(
			r.stderr.indexOf("uncommitted changes"),
		);
	});

	it("says the recovered bytes are the holder's when the file was clobbered (mantahostels#420)", () => {
		// A clean file that is nonetheless not what alice last wrote: the break
		// record's recovery is HERS, and the disk holds a third party's version.
		fakeClaude(["bob"]);
		fs.writeFileSync(inRepo(rel), "restored from a backup\n");
		commitAll(sb, "clobber");

		const r = run(["release", "--force", inRepo(rel)], "bob");
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("claimant alice");
		expect(r.stderr).toMatch(/not what is on the disk now/);
		expect(r.stderr).toContain("was broken, not handed over");
		expect(r.stderr).toMatch(/git cat-file -p [0-9a-f]{40,64}/);
	});

	it("names the claimant in the clobber it reports on an uncheckable refusal (mantahostels#420)", () => {
		// The reader is not the claimant here, so "no tool call of yours did it" would
		// be addressed to the wrong session.
		fakeClaude(["bob"]);
		fs.writeFileSync(inRepo(rel), "restored from a backup\n");
		fs.rmSync(path.join(sb.repo, ".git", "HEAD"));

		const r = run(["release", "--force", inRepo(rel)], "bob");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("could not read git status");
		expect(r.stderr).toContain("claimant alice");
		expect(r.stderr).toContain("the claim and its pin both stand");
	});

	it("does not credit the pinned bytes to a session that retook the file (mantahostels#420)", () => {
		// On `contended` the store hands back the REPLACEMENT lock, so naming its
		// holder would attribute alice's recoverable version to carol.
		fakeClaude(["bob"]);
		fs.writeFileSync(inRepo(rel), "restored from a backup\n");
		commitAll(sb, "clobber");
		const { git } = writeFaultyGit(
			{ words: ["status"] },
			{
				script: `sed -i -E 's/("claimId"[[:space:]]*:[[:space:]]*")[^"]*/\\1swapped/; s/("sessionId"[[:space:]]*:[[:space:]]*")[^"]*/\\1carol/' ${shellQuote(store.paths.lock(rel))}`,
			},
			{ under: sb.dir },
		);

		const r = cli(["release", "--force", inRepo(rel)], {
			CLAUDE_CODE_SESSION_ID: "bob",
			WFC_CLAUDE_BIN: claudeBin(),
			WFC_GIT: git,
		});
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("changed while releasing it");
		expect(r.stderr).toContain("claimant alice");
		expect(r.stderr).not.toContain("carol");
	});

	it("says nothing extra when the force takes a file nobody clobbered", () => {
		fakeClaude(["bob"]);
		const r = run(["release", "--force", inRepo(rel)], "bob");
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("not what is on the disk now");
	});

	it("makes no oracle call on a release that succeeds", () => {
		// ~465 ms per call (mantahostels#317). The ordinary release is run by every skill loop.
		fakeClaude(["alice"]);
		expect(run(["release", inRepo(rel)], "alice").status).toBe(0);
		expect(oracleCalls()).toBe(0);
	});

	it("pays for one oracle call to name the holder a release is refused for", () => {
		fakeClaude(["bob"]);
		const r = run(["release", inRepo(rel)], "bob");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("alice");
		expect(oracleCalls()).toBe(1);
	});

	it("reads --force as a flag wherever it sits, never as a session id", () => {
		fakeClaude(["bob"]);
		const r = run(["release", inRepo(rel), "--force"], "bob");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Force-released");
	});
});

describe("the Bash-only writer, end to end — refresh scans, check reports (mantahostels#419)", () => {
	// mantahostels#364's gap, closed: a session that reaches a watched file only through
	// `sed -i` attempts no claim, so before this it had no baseline, and a
	// neighbour's clobber of its work was both unreportable and unrecoverable.
	const auditScript = "scripts/evidence-audit.py";
	const guarded = "docs/doc-map.md";

	const write = (rel: string, text: string) => {
		fs.mkdirSync(path.dirname(inRepo(rel)), { recursive: true });
		fs.writeFileSync(inRepo(rel), text);
	};
	const notes = (stdout: string) =>
		stdout ? JSON.parse(stdout).hookSpecificOutput : {};

	/** One Bash call by alice: the write no hook sees, then the PostToolUse refresh. */
	const aliceSeds = (rel: string, text: string) => {
		write(rel, text);
		out(["refresh", "alice"]);
	};

	beforeEach(() => {
		gitRepo(sb);
		registerSession(sb, "alice", process.pid);
		write(auditScript, "seeded\n");
		write(guarded, "seeded\n");
		out(["refresh", "alice"]);
	});

	it("names alice's own bytes as recoverable after a route no hook watches", () => {
		aliceSeds(auditScript, "alice's version bump\n");
		write(auditScript, "restored from a backup\n"); // the clobber, by any route

		const seen = notes(out(["check", inRepo(auditScript), "alice"]));
		expect(seen.permissionDecision).toBeUndefined();
		expect(seen.additionalContext).toContain("has changed since this session");
		expect(readRecoveredBlob(seen.additionalContext)).toBe(
			"alice's version bump\n",
		);
	});

	it("reports the same on the refusing tier, which the guard covers by tool route alone", () => {
		aliceSeds(guarded, "alice's version bump\n");
		write(guarded, "restored from a backup\n");

		const seen = notes(out(["check", inRepo(guarded), "alice"]));
		expect(readRecoveredBlob(seen.additionalContext)).toBe(
			"alice's version bump\n",
		);
	});

	it("takes no claim from the scan, so nothing is refused on an inference (mantahostels#288)", () => {
		aliceSeds(auditScript, "alice's version bump\n");
		aliceSeds(guarded, "alice's version bump\n");
		expect(store.listLocks()).toEqual([]);

		registerSession(sb, "bob", process.pid + 1);
		expect(
			notes(out(["check", inRepo(guarded), "bob"])).permissionDecision,
		).toBeUndefined();
	});

	it("says nothing about a file alice's own next Bash call rewrote", () => {
		aliceSeds(auditScript, "v1.35\n");
		aliceSeds(auditScript, "v1.36\n");
		expect(out(["check", inRepo(auditScript), "alice"])).toBe("");
	});

	it("says nothing on a session's very first Bash call, whatever the tier holds (mantahostels#158)", () => {
		// A migration that read the pre-session tree as changed would open every
		// session with a wall of clobber reports.
		registerSession(sb, "carol", process.pid);
		write(auditScript, "changed long before carol started\n");
		out(["refresh", "carol"]);
		expect(out(["check", inRepo(auditScript), "carol"])).toBe("");
	});
});

describe("claim-issue / release-issue — the selection claim (mantahostels#645)", () => {
	it("records the claim against the session in the environment", () => {
		registerSession(sb, "alice", process.pid);
		const r = cli(["claim-issue", "645"], { CLAUDE_CODE_SESSION_ID: "alice" });
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/Recorded #645 as claimed by session alice/);
		expect(out(["issue-claims"])).toMatch(/^#645\talice\tsince /m);
	});

	it("takes no session id from argv, so nobody claims for someone else", () => {
		registerSession(sb, "alice", process.pid);
		const r = cli(["claim-issue", "645", "bob"], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(2);
		expect(out(["issue-claims"])).not.toMatch(/alice|bob/);
		cli(["claim-issue", "645"], { CLAUDE_CODE_SESSION_ID: "alice" });
		expect(out(["issue-claims"])).toMatch(/alice/);
	});

	it("exits 0 with no session id, since an unrecorded claim only fails open", () => {
		const r = cli(["claim-issue", "645"], { CLAUDE_CODE_SESSION_ID: "" });
		expect(r.status).toBe(0);
		expect(r.stderr).toMatch(/stays selectable/);
	});

	it("exits 2 on an argument that is not an issue number", () => {
		registerSession(sb, "alice", process.pid);
		const r = cli(["claim-issue", "nonsense"], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toMatch(/is not an issue number/);
	});

	it("releases the claim it recorded", () => {
		registerSession(sb, "alice", process.pid);
		cli(["claim-issue", "645"], { CLAUDE_CODE_SESSION_ID: "alice" });
		const r = cli(["release-issue", "645"], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/Released the claim on #645/);
		expect(out(["issue-claims"])).toBe("No issues are claimed.\n");
	});

	it("says there was nothing of its own to release", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", process.pid);
		cli(["claim-issue", "645"], { CLAUDE_CODE_SESSION_ID: "bob" });
		const r = cli(["release-issue", "645"], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/No claim of this session's on #645/);
		// Bob's still stands: release drops the caller's record and no other.
		expect(out(["issue-claims"])).toMatch(/bob/);
	});

	it("never says 'No issues are claimed' about a store it could not read (mantahostels#174)", () => {
		if (AS_ROOT) return;
		fs.mkdirSync(store.paths.issueClaimsDir(), { recursive: true });
		fs.chmodSync(store.paths.issueClaimsDir(), 0o000);
		try {
			const r = cli(["issue-claims"]);
			expect(r.status).toBe(1);
			expect(r.stderr).toMatch(/unknown — not nothing/);
		} finally {
			fs.chmodSync(store.paths.issueClaimsDir(), 0o755);
		}
	});

	it("names both subcommands in the usage", () => {
		const usage = cli([]).stderr;
		expect(usage).toContain("session-arbiter.js claim-issue <issue-number>\n");
		expect(usage).toContain(
			"session-arbiter.js release-issue <issue-number>\n",
		);
	});

	it("warns and exits 1 on a corrupt record, but still prints what it could read (mantahostels#1186)", () => {
		cli(["claim-issue", "645"], { CLAUDE_CODE_SESSION_ID: "alice" });
		fs.writeFileSync(
			path.join(store.paths.issueClaimsDir(), "bogus.json"),
			"not json",
		);
		const r = cli(["issue-claims"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toMatch(/1 issue-claim record could not be read/);
		expect(r.stdout).toMatch(/#645\talice\tsince /);
	});

	/*
	 * The prune reads `claude agents --json` as well as the sessions registry
	 * (mantahostels#704), so the sweep needs a stand-in for it.
	 */
	const pruneBin = () => path.join(sb.dir, "prunebin", "claude");
	const fakePrune = (ids: string[], code = 0) => {
		fs.mkdirSync(path.join(sb.dir, "prunebin"), { recursive: true });
		const body = JSON.stringify(ids.map((sessionId) => ({ sessionId })));
		fs.writeFileSync(
			pruneBin(),
			`#!/bin/sh\ncat <<'EOF'\n${body}\nEOF\nexit ${code}\n`,
		);
		fs.chmodSync(pruneBin(), 0o755);
		return { CLAUDE_CODE_SESSION_ID: "sweeper", WFC_CLAUDE_BIN: pruneBin() };
	};

	const aged = () => {
		registerSession(sb, "bob", process.pid, { procStart: "999999999" });
		cli(["claim-issue", "645"], { CLAUDE_CODE_SESSION_ID: "bob" });
		const f = path.join(store.paths.issueClaimsDir(), "645-bob.json");
		const t = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
		fs.utimesSync(f, t, t);
		return f;
	};

	it("sweeps a finished session's stale claim at prune-markers", () => {
		const f = aged();
		expect(cli(["prune-markers"], fakePrune(["sweeper"])).status).toBe(0);
		expect(fs.existsSync(f)).toBe(false);
	});

	it("spares that claim where the agents oracle still lists its session (mantahostels#704)", () => {
		const f = aged();
		expect(cli(["prune-markers"], fakePrune(["sweeper", "bob"])).status).toBe(
			0,
		);
		expect(fs.existsSync(f)).toBe(true);
	});

	it("sweeps nothing at all where the agents oracle will not answer (mantahostels#704)", () => {
		const f = aged();
		expect(cli(["prune-markers"], fakePrune([], 1)).status).toBe(0);
		expect(fs.existsSync(f)).toBe(true);
	});

	/*
	 * The production shape, which the three above never build (mantahostels#710): this runs
	 * as a SessionStart hook, where the starting session is not yet registered,
	 * so the oracle lists everything EXCEPT the sweeper.
	 */
	it("sweeps when the oracle does not list the sweeping session (mantahostels#710)", () => {
		const f = aged();
		expect(cli(["prune-markers"], fakePrune(["someone-else"])).status).toBe(0);
		expect(fs.existsSync(f)).toBe(false);
	});

	it("still spares a live claim on a list that omits the sweeper", () => {
		const f = aged();
		expect(
			cli(["prune-markers"], fakePrune(["someone-else", "bob"])).status,
		).toBe(0);
		expect(fs.existsSync(f)).toBe(true);
	});

	/* The caller added back is the sweeper's own: its claim must survive a list
	 * that omits it. */
	it("spares the sweeping session's own aged claim (mantahostels#710)", () => {
		registerSession(sb, "sweeper", process.pid, { procStart: "999999999" });
		cli(["claim-issue", "710"], { CLAUDE_CODE_SESSION_ID: "sweeper" });
		const f = path.join(store.paths.issueClaimsDir(), "710-sweeper.json");
		const t = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
		fs.utimesSync(f, t, t);
		// Something else must be sweepable, or the prune never reaches the oracle.
		aged();
		expect(cli(["prune-markers"], fakePrune(["someone-else"])).status).toBe(0);
		expect(fs.existsSync(f)).toBe(true);
	});
});

/*
 * Region claims on docs/doc-map.md (mantahostels#848 ruled, mantahostels#970 built). Driven through the
 * CLI because the anchor arrives as argv from lib/file-claim-host.js, and the
 * whole point is what two SESSIONS see of each other.
 */
describe("region claims — a §B entry, not the whole file", () => {
	const docMap = "docs/doc-map.md";

	/*
	 * A SECOND live pid. The sessions registry is keyed by pid, so registering
	 * two sessions on process.pid leaves only the second — and the first then
	 * reads as undurable and silently takes no lock at all, which looks exactly
	 * like the region claim working.
	 */
	const neighbourPid = process.ppid;

	/** A map fixture with two entries, each holding a distinctive line. */
	const writeMap = () =>
		fs.writeFileSync(
			inRepo(docMap),
			[
				"# doc map",
				"",
				"v1.0 · 21 August 2026",
				"",
				"## Section B — figures",
				"",
				"### B1 · The first",
				"",
				"Body of the first entry.",
				"",
				"### B2 · The second",
				"",
				"Body of the second entry.",
				"",
			].join("\n"),
		);

	/** The same fixture plus a third entry no straddling edit touches. */
	const writeMapWithThird = () =>
		fs.appendFileSync(
			inRepo(docMap),
			["### B3 \u00b7 The third", "", "Body of the third entry.", ""].join(
				"\n",
			),
		);

	beforeEach(writeMap);

	/** What lib/file-claim.js runs: path, session, anchor. */
	const check = (session: string, anchor?: string) =>
		out([
			"check",
			inRepo(docMap),
			session,
			...(anchor === undefined ? [] : [anchor]),
		]);

	const denial = (raw: string) => {
		const json = JSON.parse(raw);
		return json.hookSpecificOutput.permissionDecision === "deny"
			? json.hookSpecificOutput.permissionDecisionReason
			: null;
	};

	it("lets two sessions hold two different entries at once", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		expect(check("alice", "Body of the first entry.")).toBe("");
		expect(check("bob", "Body of the second entry.")).toBe("");
		const held = store.listLocks().map((l: { path: string }) => l.path);
		expect(held).toContain(`${docMap}#B1`);
		expect(held).toContain(`${docMap}#B2`);
	});

	it("still denies a second session the SAME entry, naming the holder and the entry", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		check("alice", "Body of the first entry.");
		const reason = denial(check("bob", "Body of the first entry."));
		expect(reason).toContain("alice");
		expect(reason).toContain(`${docMap}#B1`);
	});

	it("records the region on the debt the denial registers", () => {
		// Without this the queue stays as unreadable as it was: thirty entries all
		// reading `docs/doc-map.md`, none saying which part of it is owed.
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		check("alice", "Body of the second entry.");
		check("bob", "Body of the second entry.");
		expect(out(["debt", "list"])).toContain(`${docMap}#B2`);
	});

	it("counts the file's torn records in a region claim's notice (mantahostels#1408)", () => {
		// The notice a region claimant gets gathers the region's own debts plus
		// the whole file's. Carrying only the region's torn count made the file's
		// unreadable entries vanish, and a short list reads as complete — mantahostels#174's
		// failure, the one the count exists to prevent.
		registerSession(sb, "alice", process.pid);
		store.registerDenial(`${docMap}#B1`); // the live debt the notice hangs off
		// One unreadable record on each side of the gather, so the notice can only
		// say two by summing both counts.
		fs.writeFileSync(store.paths.debt(docMap, 900), "{ half-writ");
		fs.writeFileSync(store.paths.debt(`${docMap}#B1`, 901), "{ half-writ");
		const json = JSON.parse(check("alice", "Body of the first entry."));
		const notice = json.hookSpecificOutput.additionalContext;
		expect(notice).toContain("carries a registered debt");
		expect(notice).toContain("2 further entries here could not be parsed");
	});

	// The positive case §X4 pairs with the regression above: with nothing torn,
	// the notice says nothing about parsing, so a hardcoded count or an
	// off-by-one in the sum cannot pass both.
	it("says nothing about parsing when every record reads back", () => {
		registerSession(sb, "alice", process.pid);
		store.registerDenial(`${docMap}#B1`);
		const json = JSON.parse(check("alice", "Body of the first entry."));
		const notice = json.hookSpecificOutput.additionalContext;
		expect(notice).toContain("carries a registered debt");
		expect(notice).not.toContain("could not be parsed");
	});

	/** An anchor running out of B1's body into B2's heading. */
	const straddling = "Body of the first entry.\n\n### B2 \u00b7 The second";

	/** Every subject held right now, so a test can say which regions were taken. */
	const paths = () => store.listLocks().map((l: { path: string }) => l.path);

	it("claims BOTH regions a straddling edit touches, not the file entire (mantahostels#1685)", () => {
		registerSession(sb, "alice", process.pid);
		check("alice", straddling);
		expect(paths()).toContain(`${docMap}#B1`);
		expect(paths()).toContain(`${docMap}#B2`);
		expect(paths()).not.toContain(docMap);
	});

	it("leaves a neighbour's OTHER region claimable after a straddling edit", () => {
		// The whole point: the escalated whole-file claim blocked every region on
		// the map, this one blocks only the two it rewrites.
		writeMapWithThird();
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		check("alice", straddling);
		// Nothing to say at all: the claim was free, so the hook prints no JSON.
		expect(check("bob", "Body of the third entry.")).toBe("");
		expect(paths()).toContain(`${docMap}#B3`);
	});

	it("says which regions the straddling edit took, and how to release them", () => {
		registerSession(sb, "alice", process.pid);
		const json = JSON.parse(check("alice", straddling));
		const notice = json.hookSpecificOutput.additionalContext;
		expect(notice).toContain(`${docMap}#B1`);
		expect(notice).toContain(`${docMap}#B2`);
		expect(notice).toContain("release");
	});

	it("takes NEITHER region when a neighbour holds one of them", () => {
		// All-or-none, through claim-all's seam: holding B1 while waiting on B2 is
		// the state mantahostels#1406 exists to prevent.
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		check("bob", "Body of the second entry.");
		const reason = denial(check("alice", straddling));
		expect(reason).toContain("bob");
		expect(reason).toContain(`${docMap}#B2`);
		expect(paths()).not.toContain(`${docMap}#B1`);
	});

	it("never tells a REFUSED straddling write to release what it does not hold", () => {
		// The notice and the refusal rode the same message: "claims 2 regions …
		// release them" printed above "none was claimed".
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		check("bob", "Body of the second entry.");
		const reason = denial(check("alice", straddling));
		expect(reason).not.toContain("Release them as soon as you are done");
		expect(reason).toContain("None of the 2 regions");
	});

	it("surfaces a debt registered against the SECOND region it takes", () => {
		// buildDebtNotice is per subject, so reading it off the first region alone
		// hides every debt owed on the other one.
		registerSession(sb, "alice", process.pid);
		store.registerDenial(`${docMap}#B2`);
		const json = JSON.parse(check("alice", straddling));
		expect(json.hookSpecificOutput.additionalContext).toContain(
			"carries a registered debt",
		);
	});

	it("still claims the file entire when the anchor is stale", () => {
		// The other four arms are untouched: the extent of THIS write is unknown,
		// so the whole file remains the only honest lock.
		registerSession(sb, "alice", process.pid);
		const json = JSON.parse(check("alice", "text that is not in the map"));
		expect(paths()).toContain(docMap);
		expect(json.hookSpecificOutput.additionalContext).toContain("WHOLE");
	});

	it("claims the file entire for a Write, which carries no anchor", () => {
		registerSession(sb, "alice", process.pid);
		expect(store.listLocks().map((l: { path: string }) => l.path)).toEqual([]);
		check("alice");
		expect(store.listLocks().map((l: { path: string }) => l.path)).toContain(
			docMap,
		);
	});

	it("tells a Write it took the WHOLE map, and how to release it (mantahostels#2334)", () => {
		// The claim is right — a Write does rewrite the file — but it was silent,
		// so its holder never learned it was blocking every other session.
		registerSession(sb, "alice", process.pid);
		const notice = JSON.parse(check("alice")).hookSpecificOutput
			.additionalContext;
		expect(notice).toContain("claims the WHOLE of");
		expect(notice).toContain(`release ${docMap}`);
		expect(notice).toContain("takes ONE region off its own anchor");
	});

	it("says the whole-file notice ONCE per session, not on every write", () => {
		// mantahostels#122's rule, and the reason the gate is a fresh claim: a session writing
		// the map five times holds one claim and needs telling once.
		registerSession(sb, "alice", process.pid);
		expect(check("alice")).toContain("claims the WHOLE of");
		expect(check("alice")).toBe("");
	});

	it("says it for the SIDECAR too, the other regioned path", () => {
		// mantahostels#1848: the sidecar's keys parse under a different reader, and coverage
		// that names only docs/doc-map.md has hidden it before.
		const sidecar = "docs/doc-map-classes.json";
		registerSession(sb, "alice", process.pid);
		fs.writeFileSync(inRepo(sidecar), "{}\n");
		const notice = JSON.parse(out(["check", inRepo(sidecar), "alice"]))
			.hookSpecificOutput.additionalContext;
		expect(notice).toContain(`claims the WHOLE of ${sidecar}`);
	});

	it("says nothing to a Write on an unregioned path", () => {
		// Nothing outside REGIONED has a whole-file/one-region choice to report.
		registerSession(sb, "alice", process.pid);
		fs.writeFileSync(inRepo("docs/other.md"), "### B1 · x\n\nBody A.\n");
		expect(out(["check", inRepo("docs/other.md"), "alice"])).toBe("");
	});

	it("never tells a REFUSED whole-file Write to release what it does not hold", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		check("alice", "Body of the first entry.");
		const reason = denial(check("bob"));
		expect(reason).toContain("alice");
		expect(reason).not.toContain("Release it as soon as you are done");
	});

	it("does not LOG the anchorless whole-file claim, which is no fault", () => {
		// The fallback logs because the anchor could not be placed.
		registerSession(sb, "alice", process.pid);
		check("alice");
		const log = fs.existsSync(sb.errorLog())
			? fs.readFileSync(sb.errorLog(), "utf8")
			: "";
		expect(log).not.toContain("claiming the whole file");
	});

	it("denies a region claim while a neighbour holds the whole file, naming the neighbour", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		check("alice"); // whole-file Write
		expect(denial(check("bob", "Body of the first entry."))).toContain("alice");
	});

	it("sends that denial to force the claim that is HELD, not the one asked for", () => {
		// Named the requested region, the escape answers `No claim on …` and dead
		// ends — the neighbour holds the file, not the entry.
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		check("alice");
		const reason = denial(check("bob", "Body of the first entry."));
		expect(reason).toContain(`release --force ${docMap}\n`);
		expect(reason).not.toContain(`release --force ${docMap}#B1`);
		// The debt, by contrast, is the edit bob could not make — so it keys on the
		// region, which is where the denial wrote the stub.
		expect(reason).toContain(`debt own ${docMap}#B1`);
		expect(reason).toContain(
			`${docMap}#B1 cannot be claimed while it is covered`,
		);
	});

	it("denies a whole-file write while a neighbour holds one entry, naming the neighbour and keeping no lock of its own", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		check("alice", "Body of the first entry.");
		const reason = denial(check("bob"));
		expect(reason).toContain("alice");
		// And bob's own lock did not survive the back-off, or alice could never be
		// released either.
		const held = store.listLocks().map((l: { path: string }) => l.path);
		expect(held).toEqual([`${docMap}#B1`]);
	});

	it("falls back to the whole file when the anchor cannot be placed, and says so", () => {
		registerSession(sb, "alice", process.pid);
		const raw = check("alice", "a line this file does not hold");
		expect(raw).toContain("claims the WHOLE of");
		expect(raw).toContain("anchor not found");
		expect(store.listLocks().map((l: { path: string }) => l.path)).toContain(
			docMap,
		);
	});

	it("logs that fallback as a fail-open, per mantahostels#103 §6", () => {
		registerSession(sb, "alice", process.pid);
		check("alice", "a line this file does not hold");
		expect(fs.readFileSync(sb.errorLog(), "utf8")).toContain(
			"claiming the whole file",
		);
	});

	it("falls back, and logs, when the map cannot be read at all", () => {
		registerSession(sb, "alice", process.pid);
		fs.rmSync(inRepo(docMap));
		const raw = check("alice", "Body of the first entry.");
		expect(raw).toContain("claims the WHOLE of");
		expect(fs.readFileSync(sb.errorLog(), "utf8")).toContain(
			"could not be read",
		);
	});

	it("leaves every other guarded path on the whole-file claim", () => {
		// mantahostels#848 refused a general mechanism at 35%: the other debts were spread over
		// four different files, so per-region claims there would buy nothing.
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		fs.writeFileSync(inRepo("docs/other.md"), "### B1 · x\n\nBody A.\n");
		out(["check", inRepo("docs/other.md"), "alice", "Body A."]);
		expect(store.listLocks().map((l: { path: string }) => l.path)).toEqual([
			"docs/other.md",
		]);
		const raw = out(["check", inRepo("docs/other.md"), "bob", "Body A."]);
		expect(JSON.parse(raw).hookSpecificOutput.permissionDecision).toBe("deny");
	});

	/**
	 * Release refuses a dirty path, so the map has to be committed first — an
	 * untracked fixture reads as an uncommitted change and every release below
	 * would refuse for a reason that is nothing to do with regions.
	 */
	const commitMap = () => {
		gitRepo(sb);
		execFileSync("git", ["add", "--", docMap], { cwd: sb.repo });
		execFileSync("git", ["commit", "-qm", "map", "--", docMap], {
			cwd: sb.repo,
		});
	};

	it("releases every region a bare path names", () => {
		commitMap();
		registerSession(sb, "alice", process.pid);
		check("alice", "Body of the first entry.");
		check("alice", "Body of the second entry.");
		const r = cli(["release", inRepo(docMap)], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.stdout).toContain(`Released ${docMap}#B1`);
		expect(r.stdout).toContain(`Released ${docMap}#B2`);
		expect(store.listLocks()).toEqual([]);
	});

	it("leaves a neighbour's region alone when a bare path is released", () => {
		// Walking every lock on the file earned a "not by this session" refusal for
		// a claim the caller never asked about — and under --force it would break
		// every neighbour's region wholesale.
		commitMap();
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		check("alice", "Body of the first entry.");
		check("bob", "Body of the second entry.");
		const r = cli(["release", inRepo(docMap)], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain("not by this session");
		expect(store.listLocks().map((l: { path: string }) => l.path)).toEqual([
			`${docMap}#B2`,
		]);
	});

	it("releases the whole-file claim too when the session holds both", () => {
		// A Write with no anchor then an Edit with one leaves a session holding
		// both. Stopping at the regions left the file-wide claim standing behind a
		// release that printed nothing but successes — a claim outliving a
		// successful release is what mantahostels#121/mantahostels#126 built the command to end.
		commitMap();
		registerSession(sb, "alice", process.pid);
		check("alice"); // whole file
		check("alice", "Body of the first entry."); // one region
		expect(store.listLocks()).toHaveLength(2);
		const r = cli(["release", inRepo(docMap)], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(0);
		expect(store.listLocks()).toEqual([]);
	});

	it("releases one region when the subject names one", () => {
		commitMap();
		registerSession(sb, "alice", process.pid);
		check("alice", "Body of the first entry.");
		check("alice", "Body of the second entry.");
		cli(["release", `${docMap}#B1`], { CLAUDE_CODE_SESSION_ID: "alice" });
		expect(store.listLocks().map((l: { path: string }) => l.path)).toEqual([
			`${docMap}#B2`,
		]);
	});
});

describe("alloc-entry — the next free B<n>, taken atomically", () => {
	const docMap = "docs/doc-map.md";

	/** A second live pid, for the registry's reason above. */
	const neighbourPid = process.ppid;

	beforeEach(() =>
		fs.writeFileSync(
			inRepo(docMap),
			"# doc map\n\nv1.0 · 21 August 2026\n\n## Section B\n\n### B7 · The last one\n\nBody.\n",
		),
	);

	const alloc = (session: string) =>
		cli(["alloc-entry"], { CLAUDE_CODE_SESSION_ID: session });

	it("hands out max + 1 and claims the slot with it", () => {
		registerSession(sb, "alice", process.pid);
		const r = alloc("alice");
		expect(r.status).toBe(0);
		expect(r.stdout.trim()).toBe("B8");
		expect(store.listLocks().map((l: { path: string }) => l.path)).toEqual([
			`${docMap}#B8`,
		]);
	});

	it("hands out the id above the high-water mark where a removed id sits above every live one (#2339)", () => {
		fs.writeFileSync(
			inRepo("docs/doc-map-high-water.json"),
			JSON.stringify({ highWaterMark: 9 }),
		);
		registerSession(sb, "alice", process.pid);
		expect(alloc("alice").stdout.trim()).toBe("B10");
	});

	it("warns, naming the missing high-water file and how to write it, yet still hands out an id (#3357)", () => {
		registerSession(sb, "alice", process.pid);
		const r = alloc("alice");
		expect(r.stdout.trim()).toBe("B8");
		expect(r.stderr).toContain("doc-map-high-water.json is missing");
		expect(r.stderr).toContain('{ "highWaterMark": <n> }');
	});

	it("gives a second session the NEXT id, not the same one", () => {
		// The whole reason it exists: two sessions reading the file in the same
		// second both write `### B8`, and mantahostels#892 forbids renumbering it away.
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		expect(alloc("alice").stdout.trim()).toBe("B8");
		expect(alloc("bob").stdout.trim()).toBe("B9");
	});

	it("gives every id out once under real concurrency", async () => {
		/*
		 * The claim that carries this whole subcommand: the store's hard-link
		 * create is mutually exclusive ACROSS PROCESSES. Measured directly at mantahostels#970
		 * — twelve processes racing 200 shared names produced exactly 200 winners,
		 * never two and never none — and asserted here through the CLI, because an
		 * in-process loop would prove nothing about two node processes.
		 *
		 * Each session needs a live pid of its own: the registry is keyed by pid,
		 * so six sessions sharing one leave five undurable, taking no lock and
		 * colliding for a reason that has nothing to do with atomicity.
		 */
		const hosts = Array.from({ length: 6 }, () => spawn("sleep", ["30"]));
		try {
			const sessions = hosts.map((h, i) => {
				registerSession(sb, `s${i}`, h.pid as number);
				return `s${i}`;
			});
			const runs = await Promise.all(
				sessions.map(
					(session) =>
						new Promise<string>((resolve) => {
							// spawn-kept: two processes at once — six allocations race.
							const r = spawn(process.execPath, [SCRIPT, "alloc-entry"], {
								cwd: sb.repo,
								env: { ...process.env, CLAUDE_CODE_SESSION_ID: session },
							});
							let stdout = "";
							r.stdout.on("data", (d) => {
								stdout += d;
							});
							r.on("close", () => resolve(stdout.trim()));
						}),
				),
			);
			expect(runs.every((id) => /^B\d+$/.test(id))).toBe(true);
			expect(new Set(runs).size).toBe(sessions.length);
		} finally {
			for (const h of hosts) h.kill();
		}
	});

	it("refuses rather than allocating while a neighbour holds the whole file, naming the holder", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		store.acquire(docMap, store.identify("alice"));
		const r = alloc("bob");
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("alice");
		expect(r.stdout).toBe("");
	});

	it("ends the want of a session that was waiting elsewhere (#1487)", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		store.acquire("docs/a.md", store.identify("alice"));
		expect(
			cli(["claim", inRepo("docs/a.md")], { CLAUDE_CODE_SESSION_ID: "bob" })
				.status,
		).toBe(1);
		expect(alloc("bob").stdout.trim()).toBe("B8");
		expect(store.readWants()).toEqual([]);
	});

	it("walks past a held id without recording a want or a denial (#1487)", () => {
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		store.acquire(`${docMap}#B8`, store.identify("alice"));
		expect(alloc("bob").stdout.trim()).toBe("B9");
		expect(store.readWants()).toEqual([]);
		expect(store.listDebts()).toEqual([]);
	});

	it("promises no debt stub it never wrote when the file is held whole", () => {
		// buildDenyReason's text tells the reader to clear a stub the denial registered;
		// allocation registers none, so that recipe answers "no debt" and dead-ends.
		registerSession(sb, "alice", process.pid);
		registerSession(sb, "bob", neighbourPid);
		store.acquire(docMap, store.identify("alice"));
		const r = alloc("bob");
		expect(r.stderr).not.toContain("debt clear");
		expect(r.stderr).toContain(`release --force ${docMap}`);
		expect(r.stderr).toContain("no id can be allocated");
	});

	it("refuses on a path that takes no per-entry claim", () => {
		registerSession(sb, "alice", process.pid);
		const r = cli(["alloc-entry", inRepo("CLAUDE.md")], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("no id to allocate");
	});

	it("refuses when the map cannot be read, allocating nothing", () => {
		registerSession(sb, "alice", process.pid);
		fs.rmSync(inRepo(docMap));
		const r = alloc("alice");
		expect(r.status).toBe(1);
		expect(r.stdout).toBe("");
		expect(store.listLocks()).toEqual([]);
	});
});

describe("claim validates the region id it is handed (mantahostels#1313)", () => {
	const docMap = "docs/doc-map.md";

	beforeEach(() =>
		fs.writeFileSync(
			inRepo(docMap),
			[
				"# doc map",
				"",
				"v1.0 · 21 August 2026",
				"",
				"## Section A — document register",
				"",
				"Rows.",
				"",
				"## Section B — figures",
				"",
				"### B1 · The first",
				"",
				"Body of the first entry.",
				"",
			].join("\n"),
		),
	);

	const claim = (subject: string, session = "alice") =>
		cli(["claim", inRepo(subject)], { CLAUDE_CODE_SESSION_ID: session });

	const heldPaths = () =>
		store.listLocks().map((l: { path: string }) => l.path);

	it("refuses an id the document has no region for, naming it and taking no claim", () => {
		registerSession(sb, "alice", process.pid);
		const r = claim(`${docMap}#A`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("has no region `A`");
		expect(heldPaths()).toEqual([]);
	});

	it("names the sections the file actually has, so the caller can correct it", () => {
		registerSession(sb, "alice", process.pid);
		const r = claim(`${docMap}#Section`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("section-a");
		expect(r.stderr).toContain("alloc-entry");
	});

	it("tells a poll loop the refusal is fatal, not contention", () => {
		// CLAUDE.md prescribes `claim` in a poll loop, on "exits non-zero while
		// held". Exit 2 is non-zero too, so a loop written to that recipe spins on
		// a typo for ever unless the text tells it to stop.
		registerSession(sb, "alice", process.pid);
		const r = claim(`${docMap}#A`);
		expect(r.stderr).toContain("RETRYING WILL NEVER CLEAR IT");
		expect(r.stderr).toContain("exit 2");
	});

	/** A map whose §B runs from B1 to `last`. */
	const bigMap = (last: number) => {
		const many = ["# doc map", "", "v1.0 · 21 August 2026", "", "## Section B"];
		for (let n = 1; n <= last; n++)
			many.push("", `### B${n} · Entry`, "", "Body.");
		fs.writeFileSync(inRepo(docMap), `${many.join("\n")}\n`);
	};

	it("truncates the id list", () => {
		registerSession(sb, "alice", process.pid);
		const many = ["# doc map", "", "v1.0 · 21 August 2026"];
		for (let n = 1; n <= 20; n++) many.push("", `## Chapter ${n}`, "", "Text.");
		fs.writeFileSync(inRepo(docMap), `${many.join("\n")}\n`);
		const r = claim(`${docMap}#nonesuch`);
		expect(r.stderr).toMatch(/and \d+ more/);
		expect(r.stderr).not.toContain("chapter-20");
	});

	it("shows the entries AROUND a mistyped entry id, not the first twelve", () => {
		// B50 is a gap below the high-water mark, so it is a typo rather than an
		// append slot.
		registerSession(sb, "alice", process.pid);
		bigMap(40);
		fs.appendFileSync(inRepo(docMap), "\n### B60 · The last\n\nBody.\n");
		const r = claim(`${docMap}#B50`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("B40");
		expect(r.stderr).not.toMatch(/\bB1,/);
	});

	it("claims a region the document does have", () => {
		registerSession(sb, "alice", process.pid);
		expect(claim(`${docMap}#B1`).status).toBe(0);
		expect(heldPaths()).toEqual([`${docMap}#B1`]);
	});

	it("claims a `## ` section by its slug", () => {
		registerSession(sb, "alice", process.pid);
		expect(claim(`${docMap}#section-b-preamble`).status).toBe(0);
		expect(heldPaths()).toEqual([`${docMap}#section-b-preamble`]);
	});

	it("still claims an append slot alloc-entry handed out (mantahostels#970)", () => {
		// B2 is not in the document: alloc-entry allocates it BEFORE the entry is
		// written, and a session re-running the claim by hand must not be refused.
		registerSession(sb, "alice", process.pid);
		expect(claim(`${docMap}#B2`).status).toBe(0);
		expect(heldPaths()).toEqual([`${docMap}#B2`]);
	});

	/*
	 * §A of the map is rendered from the sidecar and hand-edited by nobody, so
	 * asking for it by name is refused and routed to the sidecar — the generator
	 * excepted, which says so (mantahostels#2422).
	 */
	it("refuses `#section-a` on the map, routing the caller to the sidecar and its generator, and taking no claim", () => {
		registerSession(sb, "alice", process.pid);
		const r = claim(`${docMap}#section-a`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("§A register tables are derived");
		expect(r.stderr).toContain("docs/doc-map-classes.json#A:<path>");
		expect(r.stderr).toContain("node scripts/generate-doc-map-section-a.js");
		expect(r.stderr).toContain("RETRYING WILL NEVER CLEAR IT");
		expect(heldPaths()).toEqual([]);
	});

	it("refuses a §A row id on the map, which mantahostels#1414 waved through as a slot, saying §A is derived and taking no claim", () => {
		registerSession(sb, "alice", process.pid);
		const r = claim(`${docMap}#A:docs/brand-new.md`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("§A register tables are derived");
		expect(heldPaths()).toEqual([]);
	});

	it("lets the generator claim §A, which is the one caller that writes it", () => {
		registerSession(sb, "alice", process.pid);
		const r = cli(["claim", inRepo(`${docMap}#section-a`), "--generator"], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(r.status).toBe(0);
		expect(heldPaths()).toEqual([`${docMap}#section-a`]);
	});

	it("still mints `section-a` on the write hook's own route, which is ungated", () => {
		// The refusal above is by-NAME only. An Edit that really lands in §A —
		// its hand-written prose, which shares the id with the derived rows —
		// takes the claim from its own anchor and pins the bytes it replaces.
		registerSession(sb, "alice", process.pid);
		cli(["check", inRepo(docMap), "alice", "Rows."], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		expect(heldPaths()).toEqual([`${docMap}#section-a`]);
	});

	it("refuses the same subject inside a `claim-all` set, saying §A is derived and taking no lock", () => {
		registerSession(sb, "alice", process.pid);
		const r = cli(
			["claim-all", inRepo(`${docMap}#B1`), inRepo(`${docMap}#section-a`)],
			{ CLAUDE_CODE_SESSION_ID: "alice" },
		);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("§A register tables are derived");
		expect(heldPaths()).toEqual([]);
	});

	it("keeps §A's rows out of the sections a mistyped id is offered (mantahostels#1414)", () => {
		registerSession(sb, "alice", process.pid);
		fs.writeFileSync(
			inRepo(docMap),
			[
				"# doc map",
				"",
				"v1.0 · 21 August 2026",
				"",
				"## Section A — document register",
				"",
				"| `docs/alpha.md` | a doc | `source-of-truth` | Direct | — |",
				"| `docs/beta.md` | a doc | `source-of-truth` | Direct | — |",
				"",
				"## Section B — figures",
				"",
				"### B1 · The first",
				"",
				"Body.",
				"",
			].join("\n"),
		);
		const r = claim(`${docMap}#sektion-a`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("section-a");
		expect(r.stderr).not.toContain("A:docs/alpha.md");
	});

	it("refuses a B<n> BELOW the next free id that no entry uses, naming it, offering alloc-entry and taking no claim", () => {
		// A gap is a retired id, not a free slot (mantahostels#892): B<n> below the high-water
		// mark names an entry that was there and is not, so it is a typo.
		registerSession(sb, "alice", process.pid);
		fs.appendFileSync(inRepo(docMap), "\n### B5 · The last\n\nBody.\n");
		const r = claim(`${docMap}#B3`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("has no region `B3`");
		expect(r.stderr).toContain("alloc-entry");
		expect(heldPaths()).toEqual([]);
	});

	it("falls open when the map cannot be read, claiming as it did before", () => {
		registerSession(sb, "alice", process.pid);
		fs.rmSync(inRepo(docMap));
		expect(claim(`${docMap}#B1`).status).toBe(0);
		expect(heldPaths()).toEqual([`${docMap}#B1`]);
	});

	it("SAYS the claim went unvalidated when the map cannot be read", () => {
		// Silence here reads as an id that was checked and passed, which is the
		// mantahostels#1313 misreading arriving by a second route (§N5: a fail-open is printed
		// where a human reads the output).
		registerSession(sb, "alice", process.pid);
		fs.rmSync(inRepo(docMap));
		const r = claim(`${docMap}#B1`);
		expect(r.stderr).toContain("was never checked against it");
		expect(r.stderr).toContain("check-guard-errors.js");
	});

	it("leaves a bare path alone — there is no region to check", () => {
		registerSession(sb, "alice", process.pid);
		expect(claim(docMap).status).toBe(0);
		expect(heldPaths()).toEqual([docMap]);
	});

	it("leaves a `#` in an unregioned path alone", () => {
		// `#` is legal in a filename, and only docs/doc-map.md takes region claims.
		registerSession(sb, "alice", process.pid);
		expect(claim("docs/plan#1.md").status).toBe(0);
		expect(heldPaths()).toEqual(["docs/plan#1.md"]);
	});
});

describe("warns when a regioned path is claimed with no region (mantahostels#1856)", () => {
	// A bare `claim docs/doc-map.md` is legitimate — the whole file is a real
	// subject — and stays exit 0. What it never said is that it denies every
	// region claim on the file for as long as it is held (mantahostels#1846).
	const docMap = "docs/doc-map.md";
	const sidecar = "docs/doc-map-classes.json";
	const whole = "takes the WHOLE file";

	const writeMap = () =>
		fs.writeFileSync(
			inRepo(docMap),
			[
				"# doc map",
				"",
				"v1.0 · 21 August 2026",
				"",
				"## Section A — document register",
				"",
				"| `docs/alpha.md` | a doc | `source-of-truth` | Direct | — |",
				"",
				"## Section B — figures",
				"",
				"### B1 · The first",
				"",
				"Body.",
				"",
				"### B2 · The second",
				"",
				"Body.",
				"",
			].join("\n"),
		);

	beforeEach(() => {
		writeMap();
		registerSession(sb, "alice", process.pid);
	});

	const claim = (subject: string) =>
		cli(["claim", inRepo(subject)], { CLAUDE_CODE_SESSION_ID: "alice" });

	const heldPaths = () =>
		store.listLocks().map((l: { path: string }) => l.path);

	it("warns that it takes the whole file, and still takes the claim at exit 0", () => {
		const r = claim(docMap);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(whole);
		expect(heldPaths()).toEqual([docMap]);
	});

	it("lists the regions the file has, in the two shapes it still holds", () => {
		const { stderr } = claim(docMap);
		expect(stderr).toContain("section-a");
		expect(stderr).toContain("2 `B<n>` entries, B1 to B2");
		// The map's §A row carries no region of its own (mantahostels#2422).
		expect(stderr).not.toContain("register row");
	});

	it("names alloc-entry as the route to a new entry's slot", () => {
		expect(claim(docMap).stderr).toContain(`alloc-entry ${docMap}`);
	});

	it("reads the sidecar's keys, which parse under a different reader (mantahostels#1848)", () => {
		// parseRegions needs `rel` to pick the JSON-key parser. Without it the
		// sidecar yields the single region `head` and the listing is a lie.
		fs.writeFileSync(
			inRepo(sidecar),
			JSON.stringify(
				{ "docs/alpha.md": { class: "x" }, "docs/beta.md": { class: "y" } },
				null,
				2,
			),
		);
		const r = claim(sidecar);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("2 `A:<path>` register rows");
		expect(r.stderr).not.toContain("Its regions: head");
	});

	it("offers alloc-entry only where `B<n>` entries exist", () => {
		// cmdAllocEntry gates on isRegioned alone, so the line is not inert on the
		// sidecar: pasting it hands out a B1 the JSON file can never carry.
		fs.writeFileSync(
			inRepo(sidecar),
			JSON.stringify({ "docs/alpha.md": { class: "x" } }, null, 2),
		);
		expect(claim(sidecar).stderr).not.toContain("alloc-entry");
	});

	it("offers no alloc-entry line when the document could not be read", () => {
		fs.rmSync(inRepo(docMap));
		expect(claim(docMap).stderr).not.toContain("alloc-entry");
	});

	it("gives the entry range numerically, not by document order", () => {
		fs.writeFileSync(
			inRepo(docMap),
			[
				"# doc map",
				"",
				"## Section B — figures",
				"",
				"### B40 · Out of order",
				"",
				"Body.",
				"",
				"### B7 · Also out of order",
				"",
				"Body.",
				"",
			].join("\n"),
		);
		expect(claim(docMap).stderr).toContain("2 `B<n>` entries, B7 to B40");
	});

	it("says nothing when the claim names a region", () => {
		const r = claim(`${docMap}#B1`);
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain(whole);
	});

	it("says nothing on a watched path that has no regions", () => {
		const r = claim("docs/operating-manual.md");
		expect(r.status).toBe(0);
		expect(r.stderr).not.toContain(whole);
	});

	it("leaves a misspelt region exit 2, naming it, and does NOT also warn", () => {
		// The two are different verdicts: a misspelt region is fatal (mantahostels#1313), an
		// omitted one is a legitimate claim. Printing both would read as one
		// message contradicting itself.
		const r = claim(`${docMap}#sektion-a`);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("has no region `sektion-a`");
		expect(r.stderr).not.toContain(whole);
	});

	it("warns that it takes the whole file even when the claim is then DENIED", () => {
		store.acquire(docMap, live(sb, "bob"));
		const r = claim(docMap);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(whole);
	});

	it("still takes the claim when the map cannot be read", () => {
		// Fail open (mantahostels#103 §6): listing the regions is a courtesy, the claim is not.
		fs.rmSync(inRepo(docMap));
		const r = claim(docMap);
		expect(r.status).toBe(0);
		expect(r.stderr).toContain(whole);
		expect(r.stderr).not.toContain("Its regions:");
		expect(heldPaths()).toEqual([docMap]);
	});

	describe("claim-all", () => {
		const claimAll = (...subjects: string[]) =>
			cli(["claim-all", ...subjects.map(inRepo)], {
				CLAUDE_CODE_SESSION_ID: "alice",
			});

		it("warns once, about the offending subject alone", () => {
			const r = claimAll(docMap, "docs/operating-manual.md");
			expect(r.status).toBe(0);
			expect(r.stderr.split(whole)).toHaveLength(2);
			expect(r.stderr).not.toContain(
				"operating-manual.md is claimed per region",
			);
		});

		it("warns once per offending subject, not once per call, naming the sidecar in its own warning", () => {
			// The gap that hid mantahostels#1848's sidecar from this warning entirely: paired only
			// with an UNREGIONED neighbour, a `break` after the first warning fails
			// nothing. docs/doc-map-classes.json is the second regioned path.
			fs.writeFileSync(
				inRepo(sidecar),
				JSON.stringify({ "docs/alpha.md": { class: "x" } }, null, 2),
			);
			const r = claimAll(docMap, sidecar);
			expect(r.status).toBe(0);
			expect(r.stderr.split(whole)).toHaveLength(3);
			expect(r.stderr).toContain(`${sidecar} is claimed per region`);
		});

		it("says nothing when every regioned subject names its region", () => {
			const r = claimAll(`${docMap}#B1`, "docs/operating-manual.md");
			expect(r.status).toBe(0);
			expect(r.stderr).not.toContain(whole);
		});

		it("keeps the misspelt-region refusal ahead of the warn", () => {
			// The set is rejected whole at exit 2, so no subject is claimed and the
			// warn would describe a claim that was never taken.
			const r = claimAll(docMap, `${docMap}#sektion-a`);
			expect(r.status).toBe(2);
			expect(r.stderr).toContain("has no region `sektion-a`");
			expect(r.stderr).not.toContain(whole);
		});
	});
});

/*
 * The unallocated-id warning (mantahostels#1424). `alloc-entry` already hands out a `B<n>`
 * and claims its append slot atomically; what nothing could see was whether a
 * session used it, because a hand-written `### B<n>` takes a claim on whatever
 * the edit anchor landed in and no id-level protection at all.
 *
 * Driven through the CLI, because the ids arrive as a sixth argv entry from
 * lib/file-claim-host.js.
 */
describe("warns on a `### B<n>` this session never allocated (mantahostels#1424)", () => {
	const docMap = "docs/doc-map.md";

	beforeEach(() =>
		fs.writeFileSync(
			inRepo(docMap),
			[
				"# doc map",
				"",
				"v1.0 · 21 August 2026",
				"",
				"## Section B — figures",
				"",
				"### B7 · The last one",
				"",
				"Body.",
				"",
			].join("\n"),
		),
	);

	/** What lib/file-claim.js runs: path, session, anchor, length, new ids. */
	const check = (session: string, ids: string, anchor = "Body.") =>
		out(["check", inRepo(docMap), session, anchor, String(anchor.length), ids]);

	const context = (raw: string) =>
		raw ? JSON.parse(raw).hookSpecificOutput.additionalContext : "";

	it("names the id and the alloc-entry recipe", () => {
		registerSession(sb, "alice", process.pid);
		const said = context(check("alice", "B8"));
		expect(said).toContain("B8");
		expect(said).toContain("alloc-entry docs/doc-map.md");
	});

	it("says nothing about an id alloc-entry handed this session", () => {
		registerSession(sb, "alice", process.pid);
		expect(
			cli(["alloc-entry"], { CLAUDE_CODE_SESSION_ID: "alice" }).stdout.trim(),
		).toBe("B8");
		expect(context(check("alice", "B8"))).not.toContain("B8");
	});

	it("says nothing when the write introduces no heading", () => {
		// An edit inside an entry the session already holds is the common case,
		// and the one this must not shout at.
		registerSession(sb, "alice", process.pid);
		expect(check("alice", "")).toBe("");
	});

	it("says nothing while this session holds the file whole", () => {
		// alloc-entry refuses outright against a whole-file holder, so its holder
		// has already excluded the neighbour a duplicate id needs.
		registerSession(sb, "alice", process.pid);
		store.acquire(docMap, store.identify("alice"));
		expect(context(check("alice", "B8"))).not.toContain("B8");
	});

	it("warns rather than denying, even on an id nobody allocated", () => {
		// The check cannot tell an unallocated id from one the session is
		// legitimately re-typing, so a refusal would block real work.
		registerSession(sb, "alice", process.pid);
		const json = JSON.parse(check("alice", "B8"));
		expect(json.hookSpecificOutput.permissionDecision).toBeUndefined();
	});

	it("names every unallocated id at once", () => {
		registerSession(sb, "alice", process.pid);
		const said = context(check("alice", "B8,B9"));
		expect(said).toContain("B8");
		expect(said).toContain("B9");
	});

	it("ignores ids forwarded for a path that takes no region claims", () => {
		// Only docs/doc-map.md has entry ids to allocate (mantahostels#848).
		registerSession(sb, "alice", process.pid);
		expect(
			out(["check", inRepo("docs/other.md"), "alice", "", "0", "B8"]),
		).toBe("");
	});

	it("ignores a malformed id rather than naming it back", () => {
		registerSession(sb, "alice", process.pid);
		expect(check("alice", "B8x,../etc")).toBe("");
	});
});

describe("list says when a claim is one region, not the file (mantahostels#1313)", () => {
	const docMap = "docs/doc-map.md";

	it("marks a region claim as covering one region", () => {
		registerSession(sb, "alice", process.pid);
		store.acquire(`${docMap}#B190`, store.identify("alice"));
		const printed = out(["list"]);
		expect(printed).toContain("ONE REGION (B190)");
		expect(printed).toContain("its other regions are free");
	});

	it("says nothing of the sort about a whole-file claim", () => {
		registerSession(sb, "alice", process.pid);
		store.acquire(docMap, store.identify("alice"));
		expect(out(["list"])).not.toContain("ONE REGION");
	});

	it("leaves the path column a bare subject, greppable by filename", () => {
		// `session-arbiter list | grep doc-map.md` is a documented move, so the
		// marker rides after the holder rather than inside the path.
		registerSession(sb, "alice", process.pid);
		store.acquire(`${docMap}#B190`, store.identify("alice"));
		const line = out(["list"]).trim().split("\n")[0];
		expect(line.split("\t")[0]).toBe(`HELD   ${docMap}#B190`);
	});
});

describe("releasing a region the rest of the file's dirt no longer pins (mantahostels#1434)", () => {
	// mantahostels#1404 end to end: two regions committed cleanly, release refusing both on a
	// neighbour's uncommitted edit elsewhere in the file.
	const docMap = "docs/doc-map.md";

	const doc = (b196: string, b197: string) =>
		[
			"# doc map",
			"",
			"v1.0 · 21 August 2026",
			"",
			"## Section B — figures",
			"",
			"### B196 · The first",
			"",
			b196,
			"",
			"### B197 · The second",
			"",
			b197,
			"",
		].join("\n");

	const writeMap = (text: string) => fs.writeFileSync(inRepo(docMap), text);
	const alice = () => {
		registerSession(sb, "alice", process.pid);
		return store.identify("alice");
	};
	const release = (subject: string, ...flags: string[]) =>
		cli(["release", ...flags, subject], { CLAUDE_CODE_SESSION_ID: "alice" });

	beforeEach(() => {
		gitRepo(sb);
		writeMap(doc("B196 as committed.", "B197 as committed."));
		commitAll(sb);
	});

	it("releases a committed region while a neighbour's edit sits elsewhere", () => {
		store.acquire(`${docMap}#B196`, alice());
		writeMap(doc("B196 as committed.", "B197, mid-edit by a neighbour."));

		expect(release(`${docMap}#B196`).status).toBe(0);
		expect(store.listLocks()).toEqual([]);
	});

	it("still refuses while the claimed region itself is dirty, naming the region", () => {
		store.acquire(`${docMap}#B196`, alice());
		writeMap(doc("B196, half-rewritten.", "B197 as committed."));

		const r = release(`${docMap}#B196`);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain(`${docMap}#B196 has uncommitted changes`);
	});

	it("drops a claim on a region that has vanished from the document", () => {
		// The wedge a refusal here would create: nothing can ever make a region
		// that exists in neither revision clean, and force, park and plain release
		// all reach the same test. It has no bytes to hand anyone, so it goes.
		store.acquire(`${docMap}#B999`, alice());
		expect(release(`${docMap}#B999`).status).toBe(0);
		expect(store.listLocks()).toEqual([]);
	});

	it("still parks the whole file, which mantahostels#1434 does not narrow", () => {
		// --park REWRITES bytes where release merely hands a claim over, so it
		// keeps weighing the whole file. Narrowing it to the region would skip
		// park's own refusal on a file a live neighbour has also written.
		store.acquire(`${docMap}#B196`, alice());
		writeMap(doc("B196 as committed.", "B197, mid-edit by a neighbour."));

		const r = release(`${docMap}#B196`, "--park");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Parked the uncommitted changes");
		expect(fs.readFileSync(inRepo(docMap), "utf8")).toBe(
			doc("B196 as committed.", "B197 as committed."),
		);
	});

	it("still parks the session's own dirty region", () => {
		store.acquire(`${docMap}#B196`, alice());
		writeMap(doc("B196, half-rewritten.", "B197 as committed."));

		const r = release(`${docMap}#B196`, "--park");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Parked the uncommitted changes");
		expect(fs.readFileSync(inRepo(docMap), "utf8")).toBe(
			doc("B196 as committed.", "B197 as committed."),
		);
		expect(store.listLocks()).toEqual([]);
	});
});

describe("release-committed — the claim goes back when the commit lands (mantahostels#2336, #2058)", () => {
	const docMap = "docs/doc-map.md";
	const sidecar = "docs/doc-map-classes.json";

	/*
	 * A SECOND live pid, for the region suite's reason: the sessions registry is
	 * keyed by pid, so registering a neighbour on process.pid would evict alice
	 * and leave her undurable, taking no lock at all.
	 */
	const neighbourPid = process.ppid;

	/** post-commit's call: the landed commit's paths, no positional session. */
	const releaseCommitted = (sid: string, paths: string[]) =>
		cli(["release-committed", ...paths], { CLAUDE_CODE_SESSION_ID: sid });

	const held = (subject: string) =>
		store.listLocks().some((l: { path: string }) => l.path === subject);

	/** A committed path that takes no regions. */
	const environment = () => {
		const other = "docs/environment.md";
		fs.writeFileSync(inRepo(other), "notes\n");
		commitAll(sb, "environment");
		return other;
	};

	beforeEach(() => {
		gitRepo(sb);
		fs.writeFileSync(inRepo(docMap), "# doc map\n");
		fs.writeFileSync(inRepo(sidecar), "{}\n");
		commitAll(sb);
	});

	it("drops this session's whole-file claim on the doc map when the commit touched it", () => {
		store.acquire(docMap, live(sb, "alice"));

		const r = releaseCommitted("alice", [docMap]);

		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`Released ${docMap}`);
		expect(held(docMap)).toBe(false);
	});

	it("covers the class sidecar too", () => {
		store.acquire(sidecar, live(sb, "alice"));

		expect(releaseCommitted("alice", [sidecar]).stdout).toContain(
			`Released ${sidecar}`,
		);
		expect(held(sidecar)).toBe(false);
	});

	it("takes an absolute path, which is what git hands the hook's caller", () => {
		store.acquire(docMap, live(sb, "alice"));

		expect(releaseCommitted("alice", [inRepo(docMap)]).stdout).toContain(
			`Released ${docMap}`,
		);
		expect(held(docMap)).toBe(false);
	});

	it("leaves a REGION claim standing — one region is cheap, and mantahostels#2336 scopes to whole-file", () => {
		const subject = `${docMap}#section-b`;
		store.acquire(subject, live(sb, "alice"));

		const r = releaseCommitted("alice", [docMap]);

		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(
			new RegExp(
				`^Kept ${subject} — a region claim, which a commit never releases`,
			),
		);
		expect(held(subject)).toBe(true);
	});

	it("drops a claim on a path that takes no regions (#2058)", () => {
		const other = environment();
		store.acquire(other, live(sb, "alice"));

		const r = releaseCommitted("alice", [other]);

		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`Released ${other}`);
		expect(held(other)).toBe(false);
	});

	it("drops a detect-only scripts/ claim too, so `list` stops showing a finished file", () => {
		const script = "scripts/tool.js";
		fs.mkdirSync(inRepo("scripts"), { recursive: true });
		fs.writeFileSync(inRepo(script), "// tool\n");
		commitAll(sb, "tool");
		store.acquire(script, live(sb, "alice"));

		expect(releaseCommitted("alice", [script]).stdout).toContain(
			`Released ${script}`,
		);
		expect(held(script)).toBe(false);
	});

	it("names every released path on ONE line, and the dirty one it kept on another (#2148)", () => {
		const other = environment();
		const me = live(sb, "alice");
		for (const p of [docMap, sidecar, other]) store.acquire(p, me);
		fs.writeFileSync(inRepo(other), "notes\nhalf an edit\n");

		const r = releaseCommitted("alice", [docMap, sidecar, other]);

		const [released, kept, ...rest] = r.stdout.trim().split("\n");
		expect(rest).toEqual([]);
		expect(released).toContain(docMap);
		expect(released).toContain(sidecar);
		expect(released).not.toContain(other);
		expect(kept).toMatch(new RegExp(`^Kept ${other} — `));
		expect(held(other)).toBe(true);
	});

	it("leaves a claim the commit did not touch", () => {
		store.acquire(docMap, live(sb, "alice"));

		const r = releaseCommitted("alice", [sidecar]);

		expect(r.stdout).toBe(
			`Released nothing — this session holds no whole-file claim on ${sidecar}.\n`,
		);
		expect(held(docMap)).toBe(true);
	});

	it("never drops a neighbour's claim, however the commit was spelt", () => {
		registerSession(sb, "bob", neighbourPid);
		store.acquire(docMap, store.identify("bob"));
		live(sb, "alice");

		const r = releaseCommitted("alice", [docMap]);

		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Released nothing");
		expect(held(docMap)).toBe(true);
	});

	it("keeps the claim on a file the commit left dirty, and says so in ONE line (#2148)", () => {
		store.acquire(docMap, live(sb, "alice"));
		fs.writeFileSync(inRepo(docMap), "# doc map\nhalf an edit\n");

		const r = releaseCommitted("alice", [docMap]);

		// One line, unlike `release`, which prints the whole recovery ladder.
		expect(r.status).toBe(0);
		expect(r.stdout.trim().split("\n")).toHaveLength(1);
		expect(r.stdout).toMatch(new RegExp(`^Kept ${docMap} — `));
		expect(r.stderr).toBe("");
		expect(held(docMap)).toBe(true);
	});

	it("does nothing at all without a session id — a person's own terminal commit", () => {
		store.acquire(docMap, live(sb, "alice"));

		const r = cli(["release-committed", docMap], {
			CLAUDE_CODE_SESSION_ID: "",
		});

		expect(r.status).toBe(0);
		expect(r.stdout).toBe("");
		expect(held(docMap)).toBe(true);
		// The fail-open log, not stderr: identify()'s "no live session entry for
		// (no session id)" goes through sayOnce, which writes there — so returning
		// ahead of it is what keeps a person's terminal commits out of a log
		// `npm run status` reports on.
		expect(fs.existsSync(sb.errorLog())).toBe(false);
	});

	/** One tool write by alice: the PreToolUse check, then the PostToolUse record,
	 * which is what pins the bytes a later clobber is reported against. */
	const aliceWrites = (rel: string, text: string) => {
		out(["check", inRepo(rel), "alice"]);
		fs.writeFileSync(inRepo(rel), text);
		out(["record", inRepo(rel), "alice"]);
	};

	it("reports a clobber of the holder's own bytes even where the release is refused (mantahostels#332, mantahostels#420)", () => {
		live(sb, "alice");
		aliceWrites(docMap, "alice's work\n");
		commitAll(sb, "alice");
		// A write by a route no hook watches, left uncommitted: `release` refuses on
		// the dirt, and this is the last run that still holds the pin.
		fs.writeFileSync(inRepo(docMap), "restored from a backup\n");

		const r = releaseCommitted("alice", [docMap]);

		expect(r.status).toBe(0);
		expect(r.stderr).toContain("has changed since this session");
		expect(held(docMap)).toBe(true);
		// The pin survives the refusal, so the recovery command still resolves.
		const sha = r.stderr.match(/git cat-file -p ([0-9a-f]{40,64})/)?.[1];
		expect(
			execFileSync("git", ["cat-file", "-p", sha as string], {
				cwd: sb.repo,
				encoding: "utf8",
			}),
		).toBe("alice's work\n");
	});

	it("tells a refused reader the pin STANDS, not that it went with the record (mantahostels#2370)", () => {
		live(sb, "alice");
		aliceWrites(docMap, "alice's work\n");
		commitAll(sb, "alice");
		fs.writeFileSync(inRepo(docMap), "restored from a backup\n");

		const r = releaseCommitted("alice", [docMap]);

		// The refusal keeps the claim, so `dropContentRef` never ran: a reader told
		// git's fortnight had started may skip the diff, or treat a recoverable
		// version as expiring. Asserted on the OPENER, not on "both stand", which
		// the two `release`-path closings also carry.
		expect(r.status).toBe(0);
		expect(r.stderr).toContain("Nothing was released here");
		expect(r.stderr).not.toContain("dropped either way");
		expect(held(docMap)).toBe(true);
	});

	it("keeps the released branch's closing, where the pin really did go", () => {
		live(sb, "alice");
		aliceWrites(docMap, "alice's work\n");
		// The file is clean, so unlike the refusal above the release goes through.
		fs.writeFileSync(inRepo(docMap), "restored from a backup\n");
		commitAll(sb, "clobbered");

		const r = releaseCommitted("alice", [docMap]);

		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`Released ${docMap}`);
		expect(r.stderr).toContain("dropped either way");
		expect(r.stderr).not.toContain("Nothing was released here");
		expect(held(docMap)).toBe(false);
	});

	it("hands a dirty refusal the park paragraph, the only route out of one (mantahostels#1783)", () => {
		live(sb, "alice");
		store.acquire(docMap, store.identify("alice"));
		registerSession(sb, "bob", neighbourPid);
		cli(["request", inRepo(docMap), "needs B124"], {
			CLAUDE_CODE_SESSION_ID: "bob",
		});
		fs.writeFileSync(inRepo(docMap), "half an edit\n");

		const r = releaseCommitted("alice", [docMap]);

		expect(r.status).toBe(0);
		expect(r.stderr).toContain("--park");
		// firstSay mints the dedupe marker as it prints, so a notice suppressed
		// here is a notice never said.
		expect(held(docMap)).toBe(true);
	});

	it("exits 0 on a commit that touched no claimed path, saying it released nothing", () => {
		live(sb, "alice");
		const r = releaseCommitted("alice", ["app/page.tsx"]);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("Released nothing");
	});
});

/*
 * #2148: a holder whose own hunks have all landed gives the file back, even
 * where a neighbour's uncommitted hunks still sit in it — and only then.
 */
describe("releasing once the holder's own hunks have landed (#2148)", () => {
	const notes = "docs/notes.md";
	const seed = "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\n";
	/** A neighbour's hunk, on disk and uncommitted before alice ever writes. */
	const theirs = seed.replace("one", "ONE");
	/** Alice's write: the neighbour's hunk plus one of her own, far from it. */
	const both = theirs.replace("nine", "NINE");
	/** HEAD once alice has committed her hunk alone. */
	const herHunkOnly = seed.replace("nine", "NINE");

	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: sb.repo, encoding: "utf8" });

	const held = () =>
		store.listLocks().some((l: { path: string }) => l.path === notes);

	/** One tool write by alice: the PreToolUse check, then the PostToolUse record. */
	const aliceWrites = (text: string) => {
		out(["check", inRepo(notes), "alice"]);
		fs.writeFileSync(inRepo(notes), text);
		out(["record", inRepo(notes), "alice"]);
	};

	/** Commit `text` as the file's next version, leaving the disk as it was. */
	const commitOnly = (text: string) => {
		const disk = fs.readFileSync(inRepo(notes), "utf8");
		fs.writeFileSync(inRepo(notes), text);
		git("add", "--", notes);
		git("commit", "-q", "-m", "alice's hunk");
		fs.writeFileSync(inRepo(notes), disk);
	};

	const release = (...args: string[]) =>
		cli(["release", ...args, notes], { CLAUDE_CODE_SESSION_ID: "alice" });

	beforeEach(() => {
		gitRepo(sb);
		fs.mkdirSync(inRepo("docs"), { recursive: true });
		fs.writeFileSync(inRepo(notes), seed);
		commitAll(sb);
		live(sb, "alice");
		fs.writeFileSync(inRepo(notes), theirs);
	});

	it("gives the claim back at the commit, through .husky/post-commit's release path, with the neighbour's hunk still uncommitted", () => {
		aliceWrites(both);
		commitOnly(herHunkOnly);

		const root = path.resolve(path.dirname(SCRIPT), "..");
		const r = spawnSync(
			"sh",
			[
				"-e",
				"-c",
				`${cutInReplay()}\n${cutShellFunction("release_committed_claims")}\nrelease_committed_claims`,
			],
			{
				cwd: sb.repo,
				encoding: "utf8",
				env: {
					...process.env,
					CLAUDE_CODE_SESSION_ID: "alice",
					WFC_PLUGIN_ROOT: root,
					GIT_INDEX_FILE: ".git/index",
				},
			},
		);

		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`Released ${notes}`);
		expect(r.stdout).toContain(
			`Still carrying other sessions' uncommitted changes, none of this session's: ${notes}.`,
		);
		expect(held()).toBe(false);
		expect(fs.readFileSync(inRepo(notes), "utf8")).toBe(both);
		expect(git("diff", "--", notes)).toContain("+ONE");
	});

	it("keeps the claim while a hunk of the holder's own is uncommitted, saying so and offering no --not-mine (mantahostels#63)", () => {
		aliceWrites(both.replace("five", "FIVE"));
		commitOnly(herHunkOnly);

		const r = cli(["release-committed", notes], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});

		expect(r.stdout).toBe(
			`Kept ${notes} — an uncommitted change of this session's own is still in it; the commit that lands it releases the claim.\n`,
		);
		expect(held()).toBe(true);
	});

	/*
	 * #2539: the overlay reads the release's verdict, so a file the release
	 * left with only the neighbour's dirt is no longer this session's to carry.
	 */
	describe("the overlay's attribution after it", () => {
		const mine = () => attributeDirty([notes], { sessionId: "alice" }).mine;
		const releaseCommitted = () =>
			cli(["release-committed", notes], { CLAUDE_CODE_SESSION_ID: "alice" });

		it("stops carrying the file once the commit landed all of the holder's hunks", () => {
			aliceWrites(both);
			expect(mine()).toEqual([notes]);
			commitOnly(herHunkOnly);

			expect(releaseCommitted().stdout).toContain(`Released ${notes}`);
			expect(mine()).toEqual([]);
		});

		it("still carries it while a hunk of the holder's own is uncommitted", () => {
			aliceWrites(both.replace("five", "FIVE"));
			commitOnly(herHunkOnly);

			expect(releaseCommitted().stdout).toContain(`Kept ${notes}`);
			expect(mine()).toEqual([notes]);
		});

		it("still leaves it out once the neighbour writes to it after the release", () => {
			aliceWrites(both);
			commitOnly(herHunkOnly);
			releaseCommitted();

			fs.writeFileSync(inRepo(notes), both.replace("five", "FIVE"));

			expect(mine()).toEqual([]);
		});

		it("leaves it out after a --not-mine release the proof could not make", () => {
			aliceWrites(theirs.replace("two", "TWO"));
			commitOnly(seed.replace("two", "TWO"));

			expect(release("--not-mine").status).toBe(0);
			expect(mine()).toEqual([]);
		});

		it("carries it again once the holder writes to it after the release", () => {
			aliceWrites(both);
			commitOnly(herHunkOnly);
			releaseCommitted();

			aliceWrites(both.replace("five", "FIVE"));

			expect(mine()).toEqual([notes]);
		});
	});

	it("releases by hand on the same proof, saying the dirt left behind is not its own", () => {
		aliceWrites(both);
		commitOnly(herHunkOnly);

		const r = release();

		expect(r.status).toBe(0);
		expect(r.stdout).toContain(`Released ${notes}.`);
		expect(r.stdout).toContain("other sessions'");
		expect(held()).toBe(false);
	});

	it("refuses a hand release while a hunk of its own is uncommitted, even under --not-mine", () => {
		aliceWrites(both);

		for (const r of [release(), release("--not-mine")]) {
			expect(r.status).toBe(1);
			expect(r.stderr).toContain(
				"still holds an uncommitted change of this session's own",
			);
			expect(r.stderr).not.toContain("--not-mine");
		}
		expect(held()).toBe(true);
	});

	it("counts a hunk staged but never committed as the holder's own, though the disk no longer shows it", () => {
		aliceWrites(both.replace("five", "FIVE"));
		git("add", "--", notes);
		aliceWrites(both);
		commitOnly(herHunkOnly);
		// commitOnly committed the index; stage the FIVE hunk again over it.
		fs.writeFileSync(inRepo(notes), herHunkOnly.replace("five", "FIVE"));
		git("add", "--", notes);
		fs.writeFileSync(inRepo(notes), both);

		expect(release().status).toBe(1);
		expect(held()).toBe(true);
	});

	it("counts a write no hook re-pinned as the holder's own, and keeps the claim without offering --not-mine", () => {
		aliceWrites(both);
		commitOnly(herHunkOnly);
		// Most often the holder's own `sed -i`, which mints no record.
		fs.writeFileSync(inRepo(notes), both.replace("five", "FIVE"));

		const r = release("--not-mine");

		expect(r.status).toBe(1);
		expect(r.stderr).toContain("an uncommitted change of this session's own");
		expect(held()).toBe(true);
	});

	it("names `release --not-mine` where it cannot prove whose the dirt is — a hunk abutting a neighbour's, the known gap — and that releases", () => {
		aliceWrites(theirs.replace("two", "TWO"));
		commitOnly(seed.replace("two", "TWO"));

		const kept = cli(["release-committed", notes], {
			CLAUDE_CODE_SESSION_ID: "alice",
		});
		const refused = release();

		expect(kept.stdout).toContain(`Kept ${notes}`);
		expect(kept.stdout).toContain(`release --not-mine ${notes}`);
		expect(refused.status).toBe(1);
		expect(refused.stderr).toContain(`release --not-mine ${notes}`);
		expect(held()).toBe(true);

		const r = release("--not-mine");

		expect(r.status).toBe(0);
		expect(r.stdout).toContain("on this session's word (--not-mine)");
		expect(held()).toBe(false);
	});

	it("still finds a clean pending hunk where another hunk conflicts", () => {
		aliceWrites(theirs.replace("two", "TWO").replace("nine", "NINE"));
		commitOnly(seed.replace("two", "TWO"));

		const r = release();

		expect(r.status).toBe(1);
		expect(r.stderr).toContain("an uncommitted change of this session's own");
		expect(held()).toBe(true);
	});

	it("takes no preBlob where the file holds an earlier edit of the session's own — a resumed retake (mantahostels#63)", () => {
		aliceWrites(both.replace("five", "FIVE"));
		// The process ends and its lock goes; the resumed session writes again.
		fs.rmSync(core.paths.lock(notes));
		aliceWrites(both.replace("five", "FIVE"));
		commitOnly(herHunkOnly);

		const lock = JSON.parse(fs.readFileSync(core.paths.lock(notes), "utf8"));
		expect(lock.preBlob).toBeNull();
		expect(release().status).toBe(1);
		expect(held()).toBe(true);
	});
});

/*
 * #383: every seat keeps its claims in the first seat's store, so a hold taken
 * on one plan refuses a session on another.
 */
describe("one claim store across seats (#383)", () => {
	const seat = (name: string) => path.join(path.dirname(sb.home), name);

	/** Run the CLI as a session registered under `dir` alone. */
	const runOn = (dir: string, sessionId: string, args: string[]) => {
		fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "sessions", `${process.pid}.json`),
			JSON.stringify({
				pid: process.pid,
				sessionId,
				procStart: proc.readProcStartOf(process.pid),
				status: "idle",
				cwd: sb.repo,
			}),
		);
		return cli(args, {
			CLAUDE_CONFIG_DIR: dir,
			CLAUDE_CODE_SESSION_ID: sessionId,
		});
	};

	it("denies a seat-3 session the file a seat-2 session holds, naming the holder", () => {
		const file = inRepo("docs/seat.md");
		expect(
			runOn(seat(".claude2"), "alice", ["claim", file, "alice"]).status,
		).toBe(0);

		const r = runOn(seat(".claude3"), "bob", ["claim", file, "bob"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("alice");
		expect(
			runOn(seat(".claude3"), "bob", ["claim", inRepo("docs/other.md"), "bob"])
				.status,
		).toBe(0);
	});

	it("writes nothing outside the sandbox's own seat dirs", () => {
		runOn(seat(".claude2"), "alice", [
			"claim",
			inRepo("docs/seat.md"),
			"alice",
		]);
		runOn(seat(".claude3"), "bob", ["claim", inRepo("docs/seat.md"), "bob"]);

		expect(fs.readdirSync(path.dirname(sb.home)).sort()).toEqual([
			".claude",
			".claude2",
			".claude3",
		]);
		for (const s of [".claude2", ".claude3"])
			expect(fs.existsSync(path.join(seat(s), "projects"))).toBe(false);
		expect(fs.existsSync(path.join(sb.home, "projects"))).toBe(true);
	});
});

/*
 * Spawned, not run in-process: runInProcess returns only once the script
 * exits, and the release, death and signal cases act WHILE the wait runs.
 */
describe("wait: one call waits on a file or issue claim (#540)", () => {
	const rel = "docs/held.md";

	const waitAs = (
		sid: string,
		args: string[],
		extraEnv: Record<string, string> = {},
	) => {
		// spawn-kept: two processes at once — the case acts while the wait runs.
		const child = spawn(process.execPath, [SCRIPT, "wait", ...args], {
			cwd: sb.repo,
			env: {
				...process.env,
				CLAUDE_CODE_SESSION_ID: sid,
				WFC_ARBITER_WAIT_POLL_S: "0.05",
				...extraEnv,
			},
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		const done = new Promise<{
			status: number | null;
			stdout: string;
			stderr: string;
		}>((resolve) =>
			child.on("close", (status) => resolve({ status, stdout, stderr })),
		);
		return { child, done };
	};

	/** What `list` says `sid` is waiting on, or null where it names no wait. */
	const wantOf = (sid: string) =>
		cli(["list"], { CLAUDE_CODE_SESSION_ID: sid })
			.stdout.split("\n")
			.find((l) => l.startsWith(`WAITING  ${sid} wants `)) ?? null;

	/** Until the wait has registered its want. */
	const started = async (sid: string) => {
		for (let i = 0; i < 200 && wantOf(sid) === null; i++)
			await new Promise((r) => setTimeout(r, 25));
		expect(wantOf(sid)).not.toBeNull();
	};

	/** alice holds rel, committed clean so her release is not refused. */
	const aliceHolds = () => {
		gitRepo(sb);
		fs.writeFileSync(inRepo(rel), "alice's file\n");
		commitAll(sb);
		const alice = live(sb, "alice");
		expect(store.acquire(rel, alice).verdict).toBe("claimed");
		live(sb, "bob");
		return alice;
	};

	it("exits NOT-HELD at once when nothing holds the target", async () => {
		live(sb, "bob");
		const r = await waitAs("bob", [inRepo(rel), "30"]).done;
		expect(r.stdout).toMatch(/^NOT-HELD {2}docs\/held\.md/);
		expect(r.status).toBe(4);
	});

	/* A pipe can be non-blocking — a module this process loads that touches
	 * process.stdout sets that on the pipe itself, which the preload stands in
	 * for. */
	it("waits out a full non-blocking stdout pipe, keeping its verdict and its exit code (#1635)", () => {
		live(sb, "bob");
		const preload = path.join(sb.dir, "touch-stdout.js");
		fs.writeFileSync(preload, "process.stdout;\n");
		const seen = throughFullPipe(
			1,
			["--require", preload, SCRIPT, "wait", inRepo(rel), "30"],
			{ cwd: sb.repo, env: { ...process.env, CLAUDE_CODE_SESSION_ID: "bob" } },
		);
		expect(seen).toMatch(/^NOT-HELD {2}docs\/held\.md .*\nexit 4\n$/s);
	});

	it("exits RELEASED when the holder releases during the wait, and drops its want", async () => {
		const alice = aliceHolds();
		const w = waitAs("bob", [inRepo(rel), "30"]);
		await started("bob");
		expect(store.release(rel, alice).verdict).toBe("released");
		const r = await w.done;
		expect(r.stdout).toMatch(/^RELEASED {2}docs\/held\.md/);
		expect(r.status).toBe(0);
		expect(wantOf("bob")).toBeNull();
	});

	it("exits HOLDER-DEAD when the holder's process ends, and drops its want", async () => {
		const host = spawn("sleep", ["30"]);
		const exited = new Promise((resolve) => host.on("exit", resolve));
		registerSession(sb, "alice", host.pid as number);
		expect(store.acquire(rel, store.identify("alice")).verdict).toBe("claimed");
		live(sb, "bob");
		const w = waitAs("bob", [inRepo(rel), "30"]);
		await started("bob");
		host.kill("SIGKILL");
		await exited;
		const r = await w.done;
		expect(r.stdout).toMatch(/^HOLDER-DEAD {2}docs\/held\.md/);
		expect(r.status).toBe(3);
		expect(wantOf("bob")).toBeNull();
	});

	it("exits CEILING naming the holder, and drops its want", async () => {
		aliceHolds();
		const r = await waitAs("bob", [inRepo(rel), "0.3"]).done;
		expect(r.stdout).toMatch(
			/^CEILING {2}docs\/held\.md — still held by alice/,
		);
		expect(r.stdout).toContain("request docs/held.md");
		expect(r.status).toBe(5);
		expect(wantOf("bob")).toBeNull();
	});

	it("shows its want under `list` while it runs, and drops it when killed", async () => {
		aliceHolds();
		const w = waitAs("bob", [inRepo(rel), "30"]);
		await started("bob");
		expect(wantOf("bob")).toMatch(/wants docs\/held\.md, held by alice/);
		w.child.kill("SIGTERM");
		expect((await w.done).status).toBe(143);
		expect(wantOf("bob")).toBeNull();
	});

	it("waits on the issue-claim register for a bare issue number", async () => {
		const alice = live(sb, "alice");
		store.claimIssue(540, alice);
		const bob = live(sb, "bob");
		store.claimIssue(540, bob);
		const w = waitAs("bob", ["540", "30"]);
		await started("bob");
		expect(wantOf("bob")).toMatch(/wants issue #540, claimed by alice/);
		store.releaseIssue(540, alice);
		const r = await w.done;
		expect(r.stdout).toMatch(/^RELEASED {2}issue #540/);
		expect(r.status).toBe(0);
		expect(wantOf("bob")).toBeNull();
	});

	it("exits NOT-HELD for an issue nobody else claims", async () => {
		live(sb, "bob");
		const r = await waitAs("bob", ["540", "30"]).done;
		expect(r.stdout).toMatch(/^NOT-HELD {2}issue #540/);
		expect(r.status).toBe(4);
	});

	/*
	 * #542: the oracle's early exits. The stand-in logs each call, so the
	 * 30 s read ceiling is asserted on a count rather than trusted.
	 */
	describe("HOLDER-ENDED and DEADLOCK (#542)", () => {
		const calls = () => path.join(sb.dir, "oracle-calls");
		const oracleSays = (agents: Record<string, unknown>[], code = 0) => {
			const bin = path.join(sb.dir, "claude-542");
			fs.writeFileSync(
				bin,
				`#!/bin/sh\necho x >> ${calls()}\ncat <<'EOF'\n${JSON.stringify(agents)}\nEOF\nexit ${code}\n`,
			);
			fs.chmodSync(bin, 0o755);
			return { WFC_CLAUDE_BIN: bin, WFC_ORACLE_CACHE: "0" };
		};
		const aliceEnded = () =>
			oracleSays([
				{ sessionId: "alice", kind: "background", state: "done" },
				{ sessionId: "bob" },
			]);
		const oracleReads = () =>
			fs.existsSync(calls())
				? fs.readFileSync(calls(), "utf8").split("\n").filter(Boolean).length
				: 0;

		it("exits HOLDER-ENDED naming release --force when the oracle calls the holder ended", async () => {
			aliceHolds();
			const r = await waitAs("bob", [inRepo(rel), "30"], aliceEnded()).done;
			expect(r.stdout).toMatch(/^HOLDER-ENDED {2}docs\/held\.md/);
			expect(r.stdout).toContain("release --force docs/held.md");
			expect(r.status).toBe(6);
			expect(wantOf("bob")).toBeNull();
		});

		it("exits HOLDER-ENDED for an issue, saying its claim is stale", async () => {
			store.claimIssue(540, live(sb, "alice"));
			live(sb, "bob");
			const r = await waitAs("bob", ["540", "30"], aliceEnded()).done;
			expect(r.stdout).toMatch(/^HOLDER-ENDED {2}issue #540 — .*stale/);
			expect(r.status).toBe(6);
			expect(wantOf("bob")).toBeNull();
		});

		it("waits on to CEILING, never HOLDER-ENDED, where the oracle refuses — and says so", async () => {
			aliceHolds();
			const r = await waitAs(
				"bob",
				[inRepo(rel), "0.5"],
				oracleSays([{ sessionId: "alice", state: "done" }], 3),
			).done;
			expect(r.stdout).toMatch(/^CEILING {2}docs\/held\.md/);
			expect(r.stdout).toContain("Whether its session has ended is UNKNOWN");
			expect(r.status).toBe(5);
		});

		it("reads the oracle once, not once a poll, inside 30 s", async () => {
			aliceHolds();
			const r = await waitAs(
				"bob",
				[inRepo(rel), "0.6"],
				oracleSays([
					{ sessionId: "alice", kind: "background", state: "working" },
					{ sessionId: "bob" },
				]),
			).done;
			expect(r.status).toBe(5);
			expect(oracleReads()).toBe(1);
		});

		it("exits DEADLOCK naming both sessions when the holder waits on what this one holds", async () => {
			const alice = aliceHolds();
			const bob = live(sb, "bob");
			fs.writeFileSync(inRepo("docs/bobs.md"), "bob's file\n");
			commitAll(sb);
			expect(store.acquire("docs/bobs.md", bob).verdict).toBe("claimed");
			store.recordWant("docs/bobs.md", alice);
			const r = await waitAs("bob", [inRepo(rel), "30"]).done;
			expect(r.stdout).toMatch(
				/^DEADLOCK {2}docs\/held\.md — bob wants docs\/held\.md -> alice wants docs\/bobs\.md -> held by you/,
			);
			expect(r.stdout).toContain("release --park");
			expect(r.status).toBe(7);
			expect(wantOf("bob")).toBeNull();
		});

		it("exits DEADLOCK through an issue want, naming both sessions", async () => {
			const alice = live(sb, "alice");
			store.claimIssue(540, alice);
			const bob = live(sb, "bob");
			store.claimIssue(541, bob);
			store.recordWant("issue #541", alice);
			const r = await waitAs("bob", ["540", "30"]).done;
			expect(r.stdout).toMatch(
				/^DEADLOCK {2}issue #540 — bob wants issue #540 -> alice wants issue #541/,
			);
			expect(r.status).toBe(7);
			expect(wantOf("bob")).toBeNull();
		});
	});

	it.each(["soon", "0", "Infinity"])(
		"refuses a ceiling of %s, which would not bound the wait, printing the wait usage",
		async (ceiling) => {
			live(sb, "bob");
			const r = await waitAs("bob", [inRepo(rel), ceiling]).done;
			expect(r.stderr).toContain("usage: session-arbiter.js wait");
			expect(r.stdout).toBe("");
			expect(r.status).toBe(2);
		},
	);
});
