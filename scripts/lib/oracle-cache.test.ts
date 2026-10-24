// @vitest-environment node
/*
 * oracle-cache.js shortens the oracle read three concurrent SessionStart hooks
 * pay (mantahostels#1924/mantahostels#1921). Since mantahostels#1960 that is ALL it shortens: a plain sequential
 * re-read never takes a cached hit any more, only a genuinely racing follower
 * does. It is allowed to make a read cheaper and never to change its answer:
 * every failure of the cache — concurrent or not — must land the caller on a
 * live spawn.
 *
 * Every test points CLAUDE_CONFIG_DIR at a temp directory: the cache is on in
 * the real config dir otherwise, and this machine exports WFC_CLAUDE_BIN in
 * the live shell, so nothing about a fake oracle makes a test inert.
 *
 * The session-start reaper, and the stranded-claim and ghost-job checks under
 * `npm run status`, read session liveness through it, so a loosened case lets a cached
 * listing answer for a daemon that has since failed (mantahostels#1946) — every
 * one of them then judges live sessions off a stale read.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const cache: any = createRequire(__filename)("./oracle-cache.js");
// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const liveness: any = createRequire(__filename)("./agent-liveness.js");

/* The keyed paths every process coordinates through, as it finds them on disk. */
const key = (bin: string) =>
	crypto.createHash("sha1").update(bin).digest("hex").slice(0, 12);
const cachePath = (bin: string) =>
	path.join(dir, `wfc-oracle-cache-${key(bin)}.json`);
const lockPath = (bin: string) =>
	path.join(dir, `wfc-oracle-cache-${key(bin)}.lock`);

/* The one field these tests read off a record. */
interface Rec {
	sessionId: string;
}

let dir = "";
const savedEnv = { ...process.env };

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-cache-"));
	process.env.CLAUDE_CONFIG_DIR = dir;
	process.env.WFC_ORACLE_CACHE = "1";
	process.env.CLAUDE_CODE_SESSION_ID = "";
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	process.env = { ...savedEnv };
});

/**
 * A `claude` stand-in that COUNTS ITS OWN RUNS — the claim under test is "one
 * spawn, not three".
 */
function countingClaude(body: string) {
	const bin = path.join(dir, "claude");
	const tally = path.join(dir, "spawns");
	fs.writeFileSync(
		bin,
		`#!/bin/sh\necho x >> '${tally}'\ncat <<'EOF'\n${body}\nEOF\n`,
		{ mode: 0o755 },
	);
	process.env.WFC_CLAUDE_BIN = bin;
	return {
		bin,
		spawns: () =>
			fs.existsSync(tally)
				? fs.readFileSync(tally, "utf8").trim().split("\n").length
				: 0,
	};
}

const listing = (...sessionIds: string[]) =>
	JSON.stringify(
		sessionIds.map((sessionId, i) => ({
			pid: 100 + i,
			sessionId,
			status: "busy",
			state: "working",
			kind: "session",
		})),
	);

describe("no plain TTL hit, for any caller (mantahostels#1960)", () => {
	/* mantahostels#1946, via mantahostels#1960. Sequential, not concurrent — the second call starts only
	 * once the first has fully returned, so single-flight's own-wait-only guard
	 * does not paper over this; it always re-spawns. */
	it("reflects a live failure on the second read rather than the first read's cached success", () => {
		const fake = countingClaude(listing("a"));
		const first = liveness.listedSessionIds();
		expect(first.why).toBeUndefined();
		expect([...first.ids]).toEqual(["a"]);
		fs.writeFileSync(fake.bin, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
		const second = liveness.listedSessionIds();
		expect(second.ids).toBeUndefined();
		expect(second.why).toContain("exit 3");
	});

	it("spawns the oracle again on a second read, even taken well inside the TTL", () => {
		const fake = countingClaude(listing("a", "b"));
		const first = liveness.listedAgents();
		const second = liveness.listedAgents();
		expect(first.agents.map((a: Rec) => a.sessionId)).toEqual(["a", "b"]);
		expect(second.agents.map((a: Rec) => a.sessionId)).toEqual(["a", "b"]);
		expect(fake.spawns()).toBe(2);
	});

	/* Every sequential read re-spawns regardless (above), so spawn count no
	 * longer discriminates the flag. `pick-next.test.ts` still rests its
	 * whole-file cache isolation on this switch — it must still do something. */
	it("writes no cache file at all under WFC_ORACLE_CACHE=0", () => {
		process.env.WFC_ORACLE_CACHE = "0";
		const fake = countingClaude(listing("a"));
		liveness.listedAgents();
		expect(fs.existsSync(cachePath(fake.bin))).toBe(false);
	});
});

describe("a cached record that does not answer THIS caller", () => {
	/*
	 * mantahostels#1924's headline invariant, on the one path that still reaches a cached
	 * record: a genuinely racing follower. The self-test is per-caller, so a
	 * leader's published record may fail it for a follower even where it
	 * passed for the leader; a hit that fails it costs a spawn, and must
	 * never become a refusal.
	 *
	 * The leader is given no session id, so its own self-test is skipped
	 * outright and it succeeds off the FIRST (slow) invocation, lacking "me".
	 * The follower is started only once the leader holds the lock, so its
	 * `acquire` fails and it must wait; the leader's record fails the
	 * follower's self-test, so it must fall through to a SECOND, fast
	 * invocation that lists "me".
	 */
	it("falls through to its own spawn where the leader's record fails ITS self-test", async () => {
		const tally = path.join(dir, "spawns");
		const bin = path.join(dir, "claude");
		fs.writeFileSync(
			bin,
			"#!/bin/sh\n" +
				`n=$(cat '${tally}' 2>/dev/null | wc -l)\n` +
				`echo x >> '${tally}'\n` +
				`if [ "$n" -eq 0 ]; then sleep 1; cat <<'EOF'\n${listing("a")}\nEOF\n` +
				`else cat <<'EOF'\n${listing("a", "me")}\nEOF\nfi\n`,
			{ mode: 0o755 },
		);
		const reader = path.join(dir, "read-role.js");
		fs.writeFileSync(
			reader,
			`const { listedAgents } = require(${JSON.stringify(path.join(__dirname, "agent-liveness.js"))});\n` +
				"const r = listedAgents();\n" +
				"if (r.why) { console.error(r.why); process.exit(3); }\n" +
				'if (process.env.EXPECT_ME && !r.agents.some((a) => a.sessionId === "me")) { console.error("missing me"); process.exit(4); }\n',
		);
		const baseEnv = {
			...process.env,
			WFC_CLAUDE_BIN: bin,
			CLAUDE_CONFIG_DIR: dir,
			WFC_ORACLE_CACHE: "1",
		};
		const wait = (kid: ReturnType<typeof spawn>) =>
			new Promise<number>((done) => {
				kid.on("exit", (code) => done(code ?? -1));
			});
		const leader = spawn(process.execPath, [reader], {
			env: { ...baseEnv, CLAUDE_CODE_SESSION_ID: "" },
			stdio: "ignore",
		});
		const held = lockPath(bin);
		const deadline = Date.now() + 5000;
		while (!fs.existsSync(held) && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(fs.existsSync(held)).toBe(true); // the leader holds it
		const follower = spawn(process.execPath, [reader], {
			env: { ...baseEnv, CLAUDE_CODE_SESSION_ID: "me", EXPECT_ME: "1" },
			stdio: "ignore",
		});
		const [leaderCode, followerCode] = await Promise.all([
			wait(leader),
			wait(follower),
		]);
		expect(leaderCode).toBe(0);
		expect(followerCode).toBe(0);
		expect(fs.readFileSync(tally, "utf8").trim().split("\n")).toHaveLength(2);
	}, 15_000);

	/*
	 * The real session-start shape, which the test above does not have (mantahostels#1924):
	 * all three SessionStart readers waive the self-test — two through
	 * `listedAgents({requireSelf: false})`, this one through `sweepSessionIds` —
	 * and every one runs inside a session the daemon has not registered. The
	 * leader's record must then satisfy the follower, so the start pays ONE
	 * spawn.
	 */
	it("costs one spawn where every racing reader is a waived sweep", async () => {
		const tally = path.join(dir, "spawns");
		const bin = path.join(dir, "claude");
		fs.writeFileSync(
			bin,
			"#!/bin/sh\n" +
				`echo x >> '${tally}'\n` +
				"sleep 1\n" +
				`cat <<'EOF'\n${listing("a")}\nEOF\n`,
			{ mode: 0o755 },
		);
		const reader = path.join(dir, "read-sweep.js");
		fs.writeFileSync(
			reader,
			`const { sweepSessionIds } = require(${JSON.stringify(path.join(__dirname, "agent-liveness.js"))});\n` +
				"const r = sweepSessionIds();\n" +
				"if (r.why) { console.error(r.why); process.exit(3); }\n" +
				'if (!r.ids.has("me")) { console.error("self not added back"); process.exit(4); }\n',
		);
		const baseEnv = {
			...process.env,
			WFC_CLAUDE_BIN: bin,
			CLAUDE_CONFIG_DIR: dir,
			WFC_ORACLE_CACHE: "1",
			CLAUDE_CODE_SESSION_ID: "me",
		};
		const wait = (kid: ReturnType<typeof spawn>) =>
			new Promise<number>((done) => {
				kid.on("exit", (code) => done(code ?? -1));
			});
		const leader = spawn(process.execPath, [reader], {
			env: baseEnv,
			stdio: "ignore",
		});
		const held = lockPath(bin);
		const deadline = Date.now() + 5000;
		while (!fs.existsSync(held) && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(fs.existsSync(held)).toBe(true); // the leader holds it
		const follower = spawn(process.execPath, [reader], {
			env: baseEnv,
			stdio: "ignore",
		});
		const [leaderCode, followerCode] = await Promise.all([
			wait(leader),
			wait(follower),
		]);
		expect(leaderCode).toBe(0);
		expect(followerCode).toBe(0);
		expect(fs.readFileSync(tally, "utf8").trim().split("\n")).toHaveLength(1);
	}, 15_000);

	it("still refuses where the live read also fails the self-test, naming the session the listing lacks", () => {
		countingClaude(listing("a"));
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		const answer = liveness.listedAgents();
		expect(answer.why).toMatch(/does not list this very session \(me\)/);
	});
});

/* Reached through `waitForLeader`, the one reader left since mantahostels#1960:
 * `liveness.listedAgents()` no longer reaches these guards. The lock taken
 * here stands in for a leader in another process. */
describe("what a follower refuses from the cache", () => {
	const follow = (bin: string) => {
		cache.acquire(bin);
		return cache.waitForLeader(bin);
	};

	beforeEach(() => {
		process.env.WFC_ORACLE_CACHE_WAIT_MS = "300";
		process.env.WFC_ORACLE_CACHE_POLL_MS = "50";
	});

	it("treats a corrupt record as a miss, not a throw", () => {
		const bin = "/nowhere/claude";
		fs.writeFileSync(cachePath(bin), "{not json");
		expect(follow(bin)).toBeNull();
	});

	it("treats a record dated in the future as a miss", () => {
		const bin = "/nowhere/claude";
		fs.writeFileSync(
			cachePath(bin),
			JSON.stringify({ at: Date.now() + 60_000, raw: listing("stale") }),
		);
		expect(follow(bin)).toBeNull();
	});

	/* Stamped 200 ms ahead so it still passes the start bound however long the
	 * set-up takes; the first poll lands 500 ms in, past a 50 ms TTL. */
	it("treats a record older than the TTL as a miss", () => {
		process.env.WFC_ORACLE_CACHE_TTL_MS = "50";
		process.env.WFC_ORACLE_CACHE_WAIT_MS = "1200";
		process.env.WFC_ORACLE_CACHE_POLL_MS = "500";
		const bin = "/nowhere/claude";
		fs.writeFileSync(
			cachePath(bin),
			JSON.stringify({ at: Date.now() + 200, raw: listing("aged") }),
		);
		expect(follow(bin)).toBeNull();
	});
});

describe("keying by binary", () => {
	it("does not serve one oracle's listing to another", () => {
		const first = countingClaude(listing("a"));
		liveness.listedAgents();
		const other = path.join(dir, "claude-other");
		fs.writeFileSync(other, `#!/bin/sh\ncat <<'EOF'\n${listing("z")}\nEOF\n`, {
			mode: 0o755,
		});
		process.env.WFC_CLAUDE_BIN = other;
		expect(liveness.listedAgents().agents.map((a: Rec) => a.sessionId)).toEqual(
			["z"],
		);
		expect(first.spawns()).toBe(1);
	});
});

describe("the claim the whole change is for (mantahostels#1924)", () => {
	/* Three processes reading at once, as a session start does. */
	it("spawns the oracle once when three readers race, not three times", async () => {
		const tally = path.join(dir, "spawns");
		const bin = path.join(dir, "claude");
		/* Slow on purpose: a spawn that returns instantly is over before a rival
		 * can start, so the race the test is about never happens. */
		fs.writeFileSync(
			bin,
			`#!/bin/sh\necho x >> '${tally}'\nsleep 1\ncat <<'EOF'\n${listing("a")}\nEOF\n`,
			{ mode: 0o755 },
		);
		const reader = path.join(dir, "read.js");
		fs.writeFileSync(
			reader,
			`const { listedAgents } = require(${JSON.stringify(path.join(__dirname, "agent-liveness.js"))});\n` +
				"const r = listedAgents();\n" +
				"if (r.why) { console.error(r.why); process.exit(3); }\n",
		);
		const env = {
			...process.env,
			WFC_CLAUDE_BIN: bin,
			CLAUDE_CONFIG_DIR: dir,
			WFC_ORACLE_CACHE: "1",
		};
		const codes = await Promise.all(
			[0, 1, 2].map(
				() =>
					new Promise<number>((done) => {
						const kid = spawn(process.execPath, [reader], {
							env,
							stdio: "ignore",
						});
						kid.on("exit", (code) => done(code ?? -1));
					}),
			),
		);
		expect(codes).toEqual([0, 0, 0]);
		expect(fs.readFileSync(tally, "utf8").trim().split("\n")).toHaveLength(1);
	}, 30_000);

	/* A listing short for any reason but the moment it was taken must judge
	 * nothing (mantahostels#535, mantahostels#1495). Since mantahostels#1960 every caller, waived or not, gets only
	 * single-flight and never a plain aged hit. */
	it("does not hand an aged record to a caller that waived the self-test", () => {
		const fake = countingClaude(listing("a"));
		liveness.listedAgents({ requireSelf: false });
		const answer = liveness.listedAgents({ requireSelf: false });
		expect(answer.agents).toHaveLength(1);
		expect(fake.spawns()).toBe(2);
	});
});

describe("the single-flight lock", () => {
	it("lets one caller lead and refuses the next", () => {
		const bin = "/nowhere/claude";
		expect(cache.acquire(bin)).toBe(true);
		expect(cache.acquire(bin)).toBe(false);
		cache.release(bin);
		expect(cache.acquire(bin)).toBe(true);
	});

	/* A FOLLOWER MAY TAKE ONLY WHAT ITS OWN LEADER PUBLISHED (mantahostels#1924). A record
	 * left by an earlier start is inside the TTL and is NOT the answer being
	 * waited for; taking it would turn the wait into an ordinary cache read. */
	it("ignores a record written before the wait began", () => {
		process.env.WFC_ORACLE_CACHE_WAIT_MS = "300";
		process.env.WFC_ORACLE_CACHE_POLL_MS = "50";
		const bin = "/nowhere/claude";
		fs.writeFileSync(
			cachePath(bin),
			JSON.stringify({ at: Date.now() - 5, raw: listing("a") }),
		);
		cache.acquire(bin);
		expect(cache.waitForLeader(bin)).toBeNull();
	});

	/* A leader that refused still releases, so a follower must not sit out its
	 * whole bound waiting for a record that is never coming (mantahostels#1924). */
	it("gives up on a leader that published nothing, rather than waiting out the clock", () => {
		const bin = "/nowhere/claude";
		cache.acquire(bin);
		cache.release(bin); // the leader failed and left
		let polls = 0;
		const sleep = () => {
			polls++;
			return true;
		};
		expect(cache.waitForLeader(bin, { sleep })).toBeNull();
		expect(polls).toBe(1);
	});

	/* A lock left by a cancelled hook would otherwise make every later start
	 * follow a leader that is not coming (mantahostels#1920). */
	it("breaks a lock left behind by a killed leader", () => {
		const bin = "/nowhere/claude";
		cache.acquire(bin);
		/* Aged by hand, not by a short bound: taking the lock and testing it in the
		 * same millisecond leaves age 0, which is inside any bound. */
		const old = new Date(Date.now() - 600_000);
		fs.utimesSync(lockPath(bin), old, old);
		expect(cache.acquire(bin)).toBe(true);
	});

	it("releases the lock even where the oracle refuses, so no follower is stranded", () => {
		process.env.WFC_CLAUDE_BIN = path.join(dir, "no-such-claude");
		const answer = liveness.listedAgents();
		expect(answer.why).toMatch(/would not run/);
		expect(fs.existsSync(lockPath(process.env.WFC_CLAUDE_BIN))).toBe(false);
	});
});

describe("an unwritable config dir", () => {
	it("degrades to a live read and never throws", () => {
		process.env.CLAUDE_CONFIG_DIR = path.join(dir, "file-not-a-dir");
		fs.writeFileSync(process.env.CLAUDE_CONFIG_DIR, "");
		const fake = countingClaude(listing("a"));
		expect(liveness.listedAgents().agents).toHaveLength(1);
		expect(fake.spawns()).toBe(1);
	});
});
