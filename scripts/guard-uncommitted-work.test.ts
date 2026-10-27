// @vitest-environment node
/*
 * guard-uncommitted-work.js blocks a turn's end while this session's own
 * tracked edits sit uncommitted in the shared tree — not a neighbour's dirt,
 * not untracked scratch, not a linked worktree (mantahostels#1555).
 *
 * Driven end-to-end through the CLI — a payload on stdin, a real git repo on
 * disk, a real write ledger, the block JSON on stdout. Only end-to-end
 * exercises the shared-tree limb, which needs an actual linked worktree to be
 * wrong about. Through `runInProcess` (§X3): the guard's own git reads are
 * real subprocesses either way, so nothing here needs a spawn of the guard
 * itself.
 *
 * The guard is a `Stop` hook in self-plugin/hooks/hooks.json: loosen a case
 * here and a background job can stop mid-edit with work nobody else sees for
 * hours, or blocks a session on a neighbour's edits it cannot commit.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readCurrentBootId, readProcStartOf } from "./lib/arbiter-proc";
import { AS_ROOT } from "./lib/arbiter-testkit";
import { runInProcess } from "./lib/run-in-process";
import { readStopGuardBlock, type StopBlock } from "./lib/stop-guard-testkit";
import { buildBashCall } from "./lib/transcript-testkit";

const require_ = createRequire(__filename);
const { REFUSAL_NAMED_MAX } = require_("./lib/dirty-tree.js");
const arbiter = require_("./lib/arbiter-store.js");

const GUARD = path.join(__dirname, "guard-uncommitted-work.js");

let root: string;
let sid: string;

/** A throwaway repo with one committed tracked file. */
function makeRepo(): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "uncommitted-")),
	);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: dir, stdio: "ignore" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "T");
	fs.writeFileSync(path.join(dir, "tracked.md"), "one\n");
	fs.writeFileSync(path.join(dir, "other.md"), "one\n");
	// A code path, so the fixture below reads as the case it means. The CODE
	// glob that decides it is pinned in lib/claimed-bash-write.test.ts, not
	// here.
	fs.writeFileSync(path.join(dir, "tool.sh"), "one\n");
	git("add", "tracked.md", "other.md", "tool.sh");
	git("commit", "-qm", "base");
	return dir;
}

/** The arbiter's per-project state directory for `forRoot`, or one of its
 * subdirectories. */
function storeDir(sub = "", forRoot = root): string {
	return path.join(
		root,
		".claude-home",
		"projects",
		forRoot.replace(/[^a-zA-Z0-9]/g, "-"),
		sub,
	);
}

/* The ledger the arbiter keeps for a session: one repo-relative path per line,
 * at <config>/projects/<root with every non-alphanumeric dashed>/writes/<sid>.txt
 * (lib/arbiter-store.js `paths.ledger`). Written directly rather than through
 * the post-write core so each case states the ledger it means. */
function ledger(entries: string[] | null, forRoot = root) {
	const dir = storeDir("writes", forRoot);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `${sid.replace(/[^A-Za-z0-9_-]/g, "-")}.txt`);
	if (entries === null) {
		fs.rmSync(file, { force: true });
		return;
	}
	fs.writeFileSync(file, entries.map((e) => `${e}\n`).join(""));
}

interface Run {
	blocked: boolean;
	reason: string;
	/** The warn limb speaks through `systemMessage` and never blocks (mantahostels#2211). */
	warn: string;
}

/**
 * No transcript is named unless a case names one. `stdin`, when given, is sent
 * in place of the whole payload, for a malformed one.
 */
function run(
	cwd = root,
	extraEnv: Record<string, string> = {},
	payload: Record<string, unknown> = {},
	stdin?: string,
): Run {
	const out = readStopGuardBlock(GUARD, {
		dir: cwd,
		sid,
		config: path.join(root, ".claude-home"),
		env: extraEnv,
		payload: { transcript_path: undefined, ...payload },
		stdin,
	}) as (Partial<StopBlock> & { systemMessage?: string }) | null;
	if (!out) return { blocked: false, reason: "", warn: "" };
	return {
		blocked: out.decision === "block",
		reason: out.reason ?? "",
		warn: out.systemMessage ?? "",
	};
}

function dirty(rel: string) {
	fs.appendFileSync(path.join(root, rel), "two\n");
}

beforeEach(() => {
	root = makeRepo();
	sid = `test-session-${Math.random().toString(36).slice(2)}`;
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("the dirt limb", () => {
	it("blocks when a tracked file this session wrote is uncommitted, naming it", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const r = run();
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("tracked.md");
	});

	it("passes on a clean tree", () => {
		ledger(["tracked.md"]);
		expect(run().blocked).toBe(false);
	});

	it("passes when the dirty file is staged AND committed", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		execFileSync("git", ["commit", "-qm", "x", "--", "tracked.md"], {
			cwd: root,
			stdio: "ignore",
		});
		expect(run().blocked).toBe(false);
	});

	it("blocks on a merely staged change", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		execFileSync("git", ["add", "tracked.md"], { cwd: root, stdio: "ignore" });
		// exempt (mantahostels#2082): reason text pinned by "blocks when a tracked file this session wrote is
		// uncommitted" above, which exercises the same readDirtyTracked()
		// block for the same file.
		expect(run().blocked).toBe(true);
	});
});

describe("attribution — a neighbour's dirt is not yours (mantahostels#114)", () => {
	it("passes when the dirty file is not in this session's ledger", () => {
		ledger(["tracked.md"]);
		dirty("other.md");
		expect(run().blocked).toBe(false);
	});

	it("names only the session's own file when both are dirty", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		dirty("other.md");
		const r = run();
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("tracked.md");
		expect(r.reason).not.toContain("other.md");
	});

	it("passes when the ledger is empty", () => {
		ledger([]);
		dirty("tracked.md");
		expect(run().blocked).toBe(false);
	});

	/* A session that has written nothing has no ledger file at all — readWritesBy
	 * reads that ENOENT as the empty answer. */
	it("passes when there is no ledger file at all", () => {
		ledger(null);
		dirty("tracked.md");
		expect(run().blocked).toBe(false);
	});
});

/*
 * lib/claimed-bash-write.js credits an uncontended CODE target to this
 * session's ledger at `PreToolUse` (mantahostels#2778), so dirt that reached the tree by
 * `sed -i` or a redirect now refuses the turn.
 *
 * Driven through the REAL hook entry rather than a hand-written ledger line, to
 * pin that the two halves agree on the ledger's location and its spelling of a
 * path. The CODE-glob gate that decides which targets are credited at all is
 * pinned in lib/claimed-bash-write.test.ts.
 *
 * Through `runInProcess` like the guard itself (§X3): its `env` option replaces
 * and restores the suite's own environment for the call.
 */
describe("a Bash-route code write is credited and blocks (mantahostels#2778)", () => {
	const entry = path.join(__dirname, "guard-dispatch.js");

	/** The PreToolUse entry on a `sed -i` over `rel`. */
	function credit(rel: string) {
		const res = runInProcess(entry, [], {
			cwd: root,
			env: {
				...process.env,
				CLAUDE_PROJECT_DIR: root,
				CLAUDE_CONFIG_DIR: path.join(root, ".claude-home"),
			},
			stdin: JSON.stringify({
				session_id: sid,
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_input: { command: `sed -i s/a/b/ ${rel}` },
			}),
		});
		// Crediting refuses nothing and prints nothing, so a non-zero exit or a
		// word on stdout is a fault in the fixture, not a verdict.
		expect(res.status).toBe(0);
		expect(res.stdout).toBe("");
	}

	it("blocks on an uncommitted code file the credit half billed here, naming it", () => {
		credit("tool.sh");
		dirty("tool.sh");
		const r = run();
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("tool.sh");
	});

	/* The credit bills the path it was GIVEN and no other — a credit half that
	 * billed the whole tree would pass the case above and fail here. */
	it("leaves a doc the same session dirtied unnamed and unblocked", () => {
		credit("tool.sh");
		dirty("tracked.md");
		expect(run().blocked).toBe(false);
	});
});

describe("untracked scratch is out (mantahostels#1555)", () => {
	it("passes on an untracked file even when the ledger claims it", () => {
		ledger(["scratch.md"]);
		fs.writeFileSync(path.join(root, "scratch.md"), "notes\n");
		expect(run().blocked).toBe(false);
	});
});

/* `scripts/lib/root-scratch.test.ts` covers the stray-scratch rule, at
 * `PreToolUse` (mantahostels#2340). What stays here is the one case this
 * guard's deleted limb leaves — that a turn with strays and no tracked dirt
 * says nothing at all, which is the mutation a half-done deletion would leave
 * passing. */
describe("the deleted stray-scratch limb", () => {
	it("is silent on untracked scratch at the repo root", () => {
		fs.writeFileSync(path.join(root, ".i0.out"), "captured\n");
		const r = run();
		expect(r.blocked).toBe(false);
		expect(r.warn).toBe("");
	});
});

describe("the shared-tree carve-out", () => {
	it("passes inside a linked worktree", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const wt = path.join(root, "..", `wt-${path.basename(root)}`);
		execFileSync("git", ["worktree", "add", "--detach", "-q", wt], {
			cwd: root,
			stdio: "ignore",
		});
		try {
			const real = fs.realpathSync(wt);
			/* The ledger is keyed on CLAUDE_PROJECT_DIR, so without this second
			 * copy the worktree run finds no ledger and passes for the wrong
			 * reason — the mutation that removes inSharedTree() would go
			 * undetected. */
			ledger(["tracked.md"], real);
			fs.appendFileSync(path.join(wt, "tracked.md"), "three\n");
			/* Untracked too: the warn limb stands down with the rest of the guard,
			 * and without this file it would pass for having nothing to say. */
			fs.writeFileSync(path.join(wt, ".i0.out"), "captured\n");
			const r = run(real);
			expect(r.blocked).toBe(false);
			expect(r.warn).toBe("");
		} finally {
			execFileSync("git", ["worktree", "remove", "--force", wt], {
				cwd: root,
				stdio: "ignore",
			});
		}
	});

	/* Double-covered on purpose, and so unable to isolate inSharedTree(): outside
	 * a repo the ledger is keyed elsewhere and readDirtyTracked() returns null too. */
	it("passes where the cwd is not a git repository at all", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "notarepo-"));
		try {
			expect(run(outside).blocked).toBe(false);
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});
});

/* The backstop's nag marker is written once and never cleared, so honouring it
 * would exempt the session permanently. */
describe("the concision backstop's markers buy no exemption", () => {
	it.each(["concision", "codereview"])(
		"blocks even while the %s pass it demanded is outstanding",
		(kind) => {
			ledger(["tracked.md"]);
			dirty("tracked.md");
			// exempt (mantahostels#2082): reason text pinned by "blocks when a tracked file this session wrote is
			// uncommitted" — this only proves the nag marker changes nothing.
			fs.writeFileSync(path.join(root, `.${kind}-nagged-${sid}`), "");
			expect(run().blocked).toBe(true);
		},
	);
});

describe("the way out", () => {
	it("hands over a pathspec commit naming every dirty path", () => {
		ledger(["tracked.md", "other.md"]);
		dirty("tracked.md");
		dirty("other.md");
		const r = run();
		expect(r.reason).toContain(
			'git commit -m "<why, in plain language>" -- other.md tracked.md',
		);
		expect(r.reason).toContain("Never `git add` first");
	});

	/** `count` dirty files, committed first — `-uno` sees only tracked ones. */
	function manyDirty(count: number): string[] {
		const many = Array.from({ length: count }, (_, i) => `f${String(i)}.md`);
		for (const f of many) fs.writeFileSync(path.join(root, f), "one\n");
		execFileSync("git", ["add", ...many], { cwd: root, stdio: "ignore" });
		execFileSync("git", ["commit", "-qm", "many"], {
			cwd: root,
			stdio: "ignore",
		});
		for (const f of many) dirty(f);
		ledger(many);
		return many;
	}

	it("withholds the command rather than truncating it, above the cap", () => {
		manyDirty(REFUSAL_NAMED_MAX + 2);
		const r = run();
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("(and 2 more)");
		/* A partial pathspec is worse than none: the session would run it, commit
		 * all but the two it never saw, and spend a block on the guard's own
		 * half-remedy. */
		expect(r.reason).not.toContain(
			'git commit -m "<why, in plain language>" -- f',
		);
		expect(r.reason).toContain("git status --porcelain -uno");
	});

	/* The boundary on the shared number, the same pair `run-vitest.test.ts`
	 * pins for `--isolated` (mantahostels#2231). */
	it("names every path at exactly the cap", () => {
		manyDirty(REFUSAL_NAMED_MAX);
		const r = run();
		expect(r.reason).not.toContain("more)");
		expect(r.reason).toContain('git commit -m "<why, in plain language>" -- f');
	});

	it("truncates one path past the cap", () => {
		manyDirty(REFUSAL_NAMED_MAX + 1);
		expect(run().reason).toContain("(and 1 more)");
	});
});

describe("the block is bounded (lib/hook-block.js)", () => {
	/* Six since mantahostels#2791, not the house three. */
	it("stops blocking after six, so an uncommittable session is not trapped", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		// exempt (mantahostels#2082): reason text pinned by "blocks when a tracked file this session wrote is
		// uncommitted" — this test is only about the six-call bound.
		for (let i = 0; i < 6; i++) expect(run().blocked).toBe(true);
		expect(run().blocked).toBe(false);
	});

	/* Both `capSpent` and `blockStop` have to carry the 6 for this to pass. */
	it("still blocks at three, the cap it used to stop at (mantahostels#2791)", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		fs.writeFileSync(path.join(root, `.uncommitted-nagged-${sid}`), "3\n");
		// exempt (mantahostels#2082): as above.
		expect(run().blocked).toBe(true);
	});
});

describe("a debt this session owned releases the path (#1170)", () => {
	function debt(rel: string, record: Record<string, unknown>) {
		const dir = storeDir("debts");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(
				dir,
				`${rel.replace(/[^A-Za-z0-9_-]/g, "-")}-${String(record.issue ?? "unowned")}.json`,
			),
			JSON.stringify({
				path: rel,
				gist: "a gate refused the commit",
				createdAt: new Date().toISOString(),
				...record,
			}),
		);
	}

	it("passes when this session owned a debt on its one dirty path", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		debt("tracked.md", { issue: 1806, recordedBy: sid });
		expect(run().blocked).toBe(false);
	});

	it("still blocks on a debt another session recorded, naming the file", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		debt("tracked.md", { issue: 1806, recordedBy: "some-other-session" });
		const r = run();
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("tracked.md");
	});

	it("still blocks on an unowned stub, even this session's own, naming the file", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		debt("tracked.md", { issue: null, recordedBy: sid });
		const r = run();
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("tracked.md");
	});

	it("still blocks on a record older than the recorder field, naming the file", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		debt("tracked.md", { issue: 1806 });
		const r = run();
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("tracked.md");
	});

	it("releases only the declared path, and names the remedy for the rest", () => {
		ledger(["tracked.md", "other.md"]);
		dirty("tracked.md");
		dirty("other.md");
		debt("tracked.md", { issue: 1806, recordedBy: sid });
		const r = run();
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("1 tracked file(s)");
		expect(r.reason).toContain("-- other.md`");
		expect(r.reason).toContain("session-arbiter.js debt own <path> <issue>");
	});
});

describe("the payload limb", () => {
	it("passes when the payload carries no session id", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		expect(
			run(root, {}, {}, JSON.stringify({ hook_event_name: "Stop" })),
		).toEqual({ blocked: false, reason: "", warn: "" });
	});
});

/* The write ledger says "this session wrote this path, ever" — not "this dirt is
 * this session's". A neighbour's live claim is what separates the two (mantahostels#63). */
describe("a live neighbour's claim subtracts the path", () => {
	/** A lock record the arbiter reads as live and owned by `owner`. */
	function claim(rel: string, owner: string) {
		const dir = storeDir("locks");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, `${rel.replace(/[^A-Za-z0-9_-]/g, "-")}.json`),
			JSON.stringify({
				path: rel,
				sessionId: owner,
				pid: process.pid,
				procStart: readProcStartOf(process.pid),
				bootId: readCurrentBootId(),
			}),
		);
	}

	it("passes when a live OTHER session holds the dirty path", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		claim("tracked.md", "some-other-session");
		expect(run().blocked).toBe(false);
	});

	it("still blocks when the live claim is this session's own", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		// exempt (mantahostels#2082): reason text pinned by "blocks when a tracked file this session wrote is
		// uncommitted" — this proves a same-session claim is not exempt,
		// not a different block reason.
		claim("tracked.md", sid);
		expect(run().blocked).toBe(true);
	});
});

/** A fake `claude` whose `agents --json` lists `ids`, or one that will not
 * run at all. `marker` is touched on every call, so a test can prove the
 * oracle was never spent. */
function oracle(ids: string[] | null, { marker }: { marker?: string } = {}) {
	const bin = path.join(root, "fake-claude");
	const listing = path.join(root, "agents.json");
	if (ids !== null)
		fs.writeFileSync(
			listing,
			JSON.stringify(ids.map((sessionId) => ({ sessionId }))),
		);
	fs.writeFileSync(
		bin,
		`#!/bin/sh\n${marker ? `touch ${JSON.stringify(marker)}\n` : ""}${
			ids === null
				? 'echo "no daemon" >&2\nexit 1\n'
				: `cat ${JSON.stringify(listing)}\n`
		}`,
		{ mode: 0o755 },
	);
	return bin;
}

/** The oracle's self-test needs this session named in the listing. */
const withOracle = (ids: string[] | null, opts?: { marker?: string }) => ({
	WFC_CLAUDE_BIN: oracle(ids, opts),
	CLAUDE_CODE_SESSION_ID: sid,
});

/* A claim is not the only way a neighbour comes to own bytes: on the detect-only
 * `scripts/` tier a Bash-route write mints no lock, only an OBSERVATION — the
 * shape that trapped mantahostels#2272 (mantahostels#2282). */
describe("a live neighbour's observation subtracts the path (mantahostels#2282)", () => {
	const neighbour = "neighbour-session";
	/* An observation is minted only on a WATCHED tier (`arbiter-core.js`'s
	 * `isWatched`), so the repo's own `tracked.md` cannot carry one. */
	const mine = "scripts/one.js";
	const others = "scripts/two.js";

	const observationsDir = () => storeDir("observations");

	beforeEach(() => {
		fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
		for (const rel of [mine, others])
			fs.writeFileSync(path.join(root, rel), "one\n");
		execFileSync("git", ["add", mine, others], { cwd: root, stdio: "ignore" });
		execFileSync("git", ["commit", "-qm", "scripts"], {
			cwd: root,
			stdio: "ignore",
		});
	});

	/** `owner`'s own baseline on `rel`, taken without a claim (mantahostels#363). */
	function observe(rel: string, owner: string) {
		const before = [
			process.env.CLAUDE_PROJECT_DIR,
			process.env.CLAUDE_CONFIG_DIR,
		];
		process.env.CLAUDE_PROJECT_DIR = root;
		process.env.CLAUDE_CONFIG_DIR = path.join(root, ".claude-home");
		try {
			const sha = arbiter.recordObservation(rel, { sessionId: owner });
			expect(sha, `no observation was minted for ${rel}`).not.toBeNull();
		} finally {
			[process.env.CLAUDE_PROJECT_DIR, process.env.CLAUDE_CONFIG_DIR] = before;
		}
	}

	it("passes when a live OTHER session has observed the dirty path", () => {
		ledger([mine]);
		dirty(mine);
		observe(mine, neighbour);
		expect(run(root, withOracle([sid, neighbour])).blocked).toBe(false);
	});

	it("still blocks when the observation is this session's own", () => {
		ledger([mine]);
		dirty(mine);
		observe(mine, sid);
		// exempt (mantahostels#2082): reason text pinned by "blocks when a tracked file this session wrote is
		// uncommitted".
		expect(run(root, withOracle([sid])).blocked).toBe(true);
	});

	it("still blocks when the observing session is not live", () => {
		ledger([mine]);
		dirty(mine);
		observe(mine, neighbour);
		// exempt (mantahostels#2082): as above.
		expect(run(root, withOracle([sid])).blocked).toBe(true);
	});

	it("still blocks when the neighbour observed some other file", () => {
		ledger([mine]);
		dirty(mine);
		observe(others, neighbour);
		// exempt (mantahostels#2082): as above.
		expect(run(root, withOracle([sid, neighbour])).blocked).toBe(true);
	});

	it("blocks and says the neighbour check went blind when the oracle refuses", () => {
		ledger([mine]);
		dirty(mine);
		observe(mine, neighbour);
		const r = run(root, withOracle(null));
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("could not run");
	});

	/* chmod is advisory to root, so the seal below would not seal. */
	it.skipIf(AS_ROOT)(
		"blocks and says so when the observation store will not open",
		() => {
			ledger([mine]);
			dirty(mine);
			observe(mine, neighbour);
			fs.chmodSync(observationsDir(), 0o000);
			try {
				const r = run(root, withOracle([sid, neighbour]));
				expect(r.blocked).toBe(true);
				expect(r.reason).toContain("could not be read");
			} finally {
				fs.chmodSync(observationsDir(), 0o755);
			}
		},
	);

	/* The oracle is dear and this guard fires on every turn (mantahostels#2282). */
	it("does not spend the oracle on a turn with nothing to name", () => {
		const marker = path.join(root, "oracle-ran");
		ledger([mine]);
		observe(mine, neighbour);
		expect(run(root, withOracle([sid, neighbour], { marker })).blocked).toBe(
			false,
		);
		expect(fs.existsSync(marker)).toBe(false);
	});
});

/* A session PAST its six blocks is deliberately leaving work uncommitted,
 * which is what the cap exists to allow, so it must not go on paying for a
 * message that can never print (mantahostels#2383). */
describe("the spent block cap stands the oracle down (mantahostels#2383)", () => {
	const neighbour = "neighbour-session";
	const mine = "tracked.md";

	/* The block counter lives under gr_markers_dir (.claude/tmp/markers), not
	 * the throwaway root itself — `lib/hook-block.js`'s counterPath (mantahostels#3515 F8,
	 * issue #2). */
	const counter = () =>
		path.join(
			require_("./lib/marker-root.js").markersDir(root),
			`.uncommitted-nagged-${sid}`,
		);

	it("does not spend the oracle once the block cap is spent", () => {
		const marker = path.join(root, "oracle-ran");
		ledger([mine]);
		dirty(mine);
		fs.writeFileSync(counter(), "6\n");
		expect(run(root, withOracle([sid, neighbour], { marker })).blocked).toBe(
			false,
		);
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("leaves the counter untouched — the read never increments it", () => {
		ledger([mine]);
		dirty(mine);
		fs.writeFileSync(counter(), "6\n");
		run(root, withOracle([sid, neighbour]));
		expect(fs.readFileSync(counter(), "utf8")).toBe("6\n");
	});

	/* Fail open: a counter that will not parse must let the guard run rather
	 * than silence it. */
	it("still blocks when the counter holds something that is not a number", () => {
		ledger([mine]);
		dirty(mine);
		fs.writeFileSync(counter(), "not a number\n");
		// exempt (mantahostels#2082): reason text pinned by "blocks when a tracked file this
		// session wrote is uncommitted".
		expect(run(root, withOracle([sid])).blocked).toBe(true);
	});

	it("still blocks below the cap, and spends the oracle to get there", () => {
		const marker = path.join(root, "oracle-ran");
		ledger([mine]);
		dirty(mine);
		fs.writeFileSync(counter(), "5\n");
		// exempt (mantahostels#2082): as above.
		expect(run(root, withOracle([sid], { marker })).blocked).toBe(true);
		expect(fs.existsSync(marker)).toBe(true);
	});
});

describe("path shapes the porcelain parser exists for", () => {
	it("names a path containing a space, quoted as one shell word", () => {
		const spaced = "a file.md";
		fs.writeFileSync(path.join(root, spaced), "one\n");
		execFileSync("git", ["add", spaced], { cwd: root, stdio: "ignore" });
		execFileSync("git", ["commit", "-qm", "spaced"], {
			cwd: root,
			stdio: "ignore",
		});
		dirty(spaced);
		ledger([spaced]);
		const r = run();
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("'a file.md'");
	});

	it("names both sides of a rename, and reads its source as a source", () => {
		execFileSync("git", ["mv", "other.md", "renamed.md"], {
			cwd: root,
			stdio: "ignore",
		});
		dirty("tracked.md");
		ledger(["tracked.md", "other.md", "renamed.md"]);
		const r = run();
		expect(r.blocked).toBe(true);
		/* Both sides, because a commit that carries only one of them leaves the
		 * rename half-applied in the index. */
		expect(r.reason).toContain("renamed.md");
		expect(r.reason).toContain("tracked.md");
		/* The source rides in a NUL field of its own, with no status letters in
		 * front of it. */
		expect(r.reason).toContain("other.md");
	});
});

describe("the `waiting:` stand-down (mantahostels#2567)", () => {
	/* The guard reads this file twice: once through `readPendingTasks`, and once
	 * more through `readOutgoingMessage` where the payload carries no message of its
	 * own. */
	const launchId = "toolu_launch01";

	function transcript(lines: unknown[]): string {
		const file = path.join(root, "transcript.jsonl");
		fs.writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
		return file;
	}

	const userTurn = {
		type: "user",
		message: { content: [{ type: "text", text: "go" }] },
	};

	const bashLaunch = buildBashCall("sleep 60", launchId, {
		input: { run_in_background: true },
	});

	const notification = {
		type: "user",
		message: {
			content: [
				{
					type: "text",
					text: `<task-notification><tool-use-id>${launchId}</tool-use-id></task-notification>`,
				},
			],
		},
	};

	function say(text: string) {
		return {
			type: "assistant",
			message: { content: [{ type: "text", text }] },
		};
	}

	const handoff = "waiting: the suite run above will wake this session.";

	it("stands down on a waiting: hand-off with a launch still out", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const file = transcript([userTurn, bashLaunch, say(handoff)]);
		expect(
			run(root, {}, { last_assistant_message: handoff, transcript_path: file })
				.blocked,
		).toBe(false);
	});

	it("stands down for a foreground call moved to the background at its timeout (#1012)", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const foreground = buildBashCall("npm run test", launchId);
		const overrun = {
			type: "user",
			message: {
				content: [
					{
						type: "tool_result",
						tool_use_id: launchId,
						content:
							"Command did not complete within its 600s timeout and was moved to the background (ID: b1).",
					},
				],
			},
		};
		const file = transcript([userTurn, foreground, overrun, say(handoff)]);
		expect(
			run(root, {}, { last_assistant_message: handoff, transcript_path: file })
				.blocked,
		).toBe(false);
	});

	it("still blocks when the launch has already been settled, naming the file", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const file = transcript([userTurn, bashLaunch, notification, say(handoff)]);
		const r = run(
			root,
			{},
			{
				last_assistant_message: handoff,
				transcript_path: file,
			},
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).toContain("tracked.md");
	});

	it("still blocks when the transcript holds no launch at all", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const file = transcript([userTurn, say(handoff)]);
		expect(
			run(root, {}, { last_assistant_message: handoff, transcript_path: file })
				.blocked,
		).toBe(true);
	});

	it("still blocks on a bare waiting: carrying nothing after the colon", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const file = transcript([userTurn, bashLaunch, say("waiting:")]);
		expect(
			run(
				root,
				{},
				{ last_assistant_message: "waiting:", transcript_path: file },
			).blocked,
		).toBe(true);
	});

	it.each([
		["with a launch still out", [userTurn, bashLaunch] as unknown[]],
		["with no launch at all", [userTurn] as unknown[]],
	])("still blocks where a later marker governs, %s", (_name, prefix) => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const message = `${handoff}\nresult: done.`;
		const file = transcript([...prefix, say(message)]);
		expect(
			run(root, {}, { last_assistant_message: message, transcript_path: file })
				.blocked,
		).toBe(true);
	});

	it("reads the message off the transcript when the payload omits it", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const file = transcript([userTurn, bashLaunch, say(handoff)]);
		expect(run(root, {}, { transcript_path: file }).blocked).toBe(false);
	});

	/* Every failure path declines the stand-down. */
	it("still blocks when the transcript named does not exist", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		expect(
			run(
				root,
				{},
				{
					last_assistant_message: handoff,
					transcript_path: path.join(root, "absent.jsonl"),
				},
			).blocked,
		).toBe(true);
	});

	it("names the fault when a waiting: hand-off does not earn the stand-down", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const file = transcript([userTurn, bashLaunch, notification, say(handoff)]);
		const r = run(
			root,
			{},
			{
				last_assistant_message: handoff,
				transcript_path: file,
			},
		);
		expect(r.reason).toContain(
			"nothing this session launched is still running",
		);
		expect(r.reason).toContain("Re-sending it unchanged will block again");
	});

	it("says nothing about the hand-off where the turn never claimed one", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const file = transcript([userTurn, say("result: done.")]);
		const r = run(
			root,
			{},
			{
				last_assistant_message: "result: done.",
				transcript_path: file,
			},
		);
		expect(r.blocked).toBe(true);
		expect(r.reason).not.toContain("hand-off");
	});

	/* The message fallback's own catch, distinct from `readPendingTasks`'. */
	it("still blocks when the payload omits the message and the transcript will not read", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const dir = path.join(root, "adirectory.jsonl");
		fs.mkdirSync(dir);
		const r = run(root, {}, { transcript_path: dir });
		expect(r.blocked).toBe(true);
		expect(r.reason).not.toContain("hand-off");
	});

	it("falls back to the conventional transcript path when the payload names none", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const dir = storeDir();
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, `${sid}.jsonl`),
			[userTurn, bashLaunch, say(handoff)]
				.map((l) => `${JSON.stringify(l)}\n`)
				.join(""),
		);
		expect(run(root, {}, { last_assistant_message: handoff }).blocked).toBe(
			false,
		);
	});

	it("spends no block when it stands down", () => {
		ledger(["tracked.md"]);
		dirty("tracked.md");
		const file = transcript([userTurn, bashLaunch, say(handoff)]);
		run(root, {}, { last_assistant_message: handoff, transcript_path: file });
		const markers = require_("./lib/marker-root.js").markersDir(root);
		const counters = fs
			.readdirSync(markers)
			.filter((f) => f.startsWith(".uncommitted-nagged-"));
		expect(counters).toEqual([]);
	});
});
