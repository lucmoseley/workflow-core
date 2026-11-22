// @vitest-environment node

import type { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withStopClockLeft } from "./hook-deadline-testkit";
import { keptSpawn } from "./kept-spawn.js";
import { shellQuote } from "./sh-quote.js";

const cache = createRequire(__filename)(
	"./oracle-cache.js",
) as typeof import("./oracle-cache.js");
const liveness = createRequire(__filename)(
	"./agent-liveness.js",
) as typeof import("./agent-liveness.js");

const hashOf = (key: string) =>
	crypto.createHash("sha1").update(key).digest("hex").slice(0, 12);
const cachePath = (key: string) =>
	path.join(dir, `wfc-oracle-cache-${hashOf(key)}.json`);
const lockPath = (key: string) =>
	path.join(dir, `wfc-oracle-cache-${hashOf(key)}.lock`);
const live = (bin: string): string => liveness.oracleCacheKey(bin);

function idsOf(r: { ids?: Set<string>; why?: string }) {
	if (!r.ids) throw new Error(r.why);
	return [...r.ids];
}

function sessionsOf(r: { agents?: { sessionId: string }[]; why?: string }) {
	if (!r.agents) throw new Error(r.why);
	return r.agents.map((a) => a.sessionId);
}

let dir = "";

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-cache-"));
	vi.stubEnv("CLAUDE_CONFIG_DIR", dir);
	vi.stubEnv("WFC_ORACLE_CACHE", "1");
	vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function countingClaude(body: string) {
	const bin = path.join(dir, "claude");
	const tally = path.join(dir, "spawns");
	fs.writeFileSync(
		bin,
		`#!/bin/sh\necho x >> ${shellQuote(tally)}\ncat <<'EOF'\n${body}\nEOF\n`,
		{ mode: 0o755 },
	);
	vi.stubEnv("WFC_CLAUDE_BIN", bin);
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

describe("no plain TTL hit, for any strict caller (mantahostels#1960)", () => {
	it("reflects a live failure on the second read rather than the first read's cached success", () => {
		const fake = countingClaude(listing("a"));
		const first = liveness.listedSessionIds();
		expect(first.why).toBeUndefined();
		expect(idsOf(first)).toEqual(["a"]);
		fs.writeFileSync(fake.bin, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
		const second = liveness.listedSessionIds();
		expect(second.ids).toBeUndefined();
		expect(second.why).toContain("exit 3");
	});

	it("spawns the oracle again on a second read, even taken well inside the TTL", () => {
		const fake = countingClaude(listing("a", "b"));
		const first = liveness.listedAgents();
		const second = liveness.listedAgents();
		expect(sessionsOf(first)).toEqual(["a", "b"]);
		expect(sessionsOf(second)).toEqual(["a", "b"]);
		expect(fake.spawns()).toBe(2);
	});

	it("writes no cache file at all under WFC_ORACLE_CACHE=0", () => {
		vi.stubEnv("WFC_ORACLE_CACHE", "0");
		const fake = countingClaude(listing("a"));
		liveness.listedAgents();
		expect(fs.existsSync(cachePath(live(fake.bin)))).toBe(false);
	});
});

describe("the shared reading wait polls (#3561)", () => {
	it("serves a second reader inside the TTL without a spawn", () => {
		const fake = countingClaude(listing("a"));
		expect(idsOf(liveness.sharedSessionIds())).toEqual(["a"]);
		expect(idsOf(liveness.sharedSessionIds())).toEqual(["a"]);
		expect(fake.spawns()).toBe(1);
	});

	it("spawns past the TTL, so a daemon failing since reads as doubt", () => {
		vi.stubEnv("WFC_ORACLE_CACHE_TTL_MS", "50");
		const fake = countingClaude(listing("a"));
		fs.writeFileSync(
			cachePath(live(fake.bin)),
			JSON.stringify({ at: Date.now() - 1000, raw: listing("a") }),
		);
		fs.writeFileSync(fake.bin, "#!/bin/sh\nexit 3\n", { mode: 0o755 });
		const r = liveness.sharedSessionIds();
		expect(r.ids).toBeUndefined();
		expect(r.why).toContain("exit 3");
	});

	it("spawns past an unreadable record", () => {
		const fake = countingClaude(listing("a"));
		fs.writeFileSync(cachePath(live(fake.bin)), "{not json");
		expect(idsOf(liveness.sharedSessionIds())).toEqual(["a"]);
		expect(fake.spawns()).toBe(1);
	});

	it("answers doubt, starting nothing, while another reader refreshes", () => {
		vi.stubEnv("WFC_ORACLE_CACHE_WAIT_MS", "200");
		vi.stubEnv("WFC_ORACLE_CACHE_POLL_MS", "50");
		const fake = countingClaude(listing("a"));
		fs.mkdirSync(lockPath(live(fake.bin)));
		const r = liveness.sharedSessionIds();
		expect(r.why).toMatch(/another reader is refreshing/);
		expect(fake.spawns()).toBe(0);
	});

	it("is never served to a strict reader", () => {
		const fake = countingClaude(listing("a"));
		liveness.sharedSessionIds();
		liveness.listedSessionIds();
		expect(fake.spawns()).toBe(2);
	});

	it("serves a failed refresh as doubt for the TTL, starting nothing", () => {
		const fake = countingClaude(listing("a"));
		fs.writeFileSync(
			fake.bin,
			`#!/bin/sh\necho x >> ${shellQuote(path.join(dir, "spawns"))}\nexit 3\n`,
			{
				mode: 0o755,
			},
		);
		expect(liveness.sharedSessionIds().why).toContain("exit 3");
		const again = liveness.sharedSessionIds();
		expect(again.why).toMatch(/exit 3.*a shared reading/);
		expect(fake.spawns()).toBe(1);
	});

	it("is one record across the plan seats, and none shared with an overflow seat", () => {
		const [seatA, seatB, overflow] = [".claude", ".claude2", "overflow"].map(
			(name) => path.join(dir, name),
		);
		for (const d of [seatA, seatB, overflow]) fs.mkdirSync(d);
		vi.stubEnv("WFC_CLAUDE_CONFIG_A", seatA);
		vi.stubEnv("WFC_CLAUDE_CONFIG_B", seatB);
		const fake = countingClaude(listing("a"));
		vi.stubEnv("CLAUDE_CONFIG_DIR", seatB);
		liveness.sharedSessionIds();
		const plan = fake.spawns();
		vi.stubEnv("CLAUDE_CONFIG_DIR", seatA);
		expect(idsOf(liveness.sharedSessionIds())).toEqual(["a"]);
		expect(fake.spawns()).toBe(plan);
		vi.stubEnv("CLAUDE_CONFIG_DIR", overflow);
		liveness.sharedSessionIds();
		expect(fake.spawns()).toBeGreaterThan(plan);
	});
});

describe("the shown reading the refill panel polls (#4169)", () => {
	const aged = (bin: string, ageMs: number) => {
		const at = Date.now() - ageMs;
		fs.writeFileSync(
			cachePath(live(bin)),
			JSON.stringify({ at, raw: listing("a") }),
		);
		return at;
	};

	it("serves a reading past the TTL, inside its own age, without a spawn", () => {
		vi.stubEnv("WFC_ORACLE_CACHE_TTL_MS", "50");
		const fake = countingClaude(listing("a", "b"));
		aged(fake.bin, 60_000);
		const r = liveness.readAgentsForDisplay();
		expect(sessionsOf(r)).toEqual(["a"]);
		expect(fake.spawns()).toBe(0);
	});

	it("dates a served reading by its write, not the read (#4175)", () => {
		const fake = countingClaude(listing("a"));
		const at = aged(fake.bin, 60_000);
		expect(liveness.readAgentsForDisplay().readAt).toBe(at);
	});

	it("spawns past its own age", () => {
		const fake = countingClaude(listing("a", "b"));
		aged(fake.bin, liveness.DISPLAY_MAX_AGE_MS + 1000);
		const r = liveness.readAgentsForDisplay();
		expect(sessionsOf(r)).toEqual(["a", "b"]);
		expect(fake.spawns()).toBe(1);
	});

	it("is never served to the budget's strict reader", () => {
		const fake = countingClaude(listing("a", "b"));
		aged(fake.bin, 0);
		liveness.readAgentsForBudget();
		expect(fake.spawns()).toBe(1);
	});
});

describe("a cached record that does not answer THIS caller", () => {
	it("falls through to its own spawn where the leader's record fails ITS self-test", async () => {
		const tally = path.join(dir, "spawns");
		const bin = path.join(dir, "claude");
		fs.writeFileSync(
			bin,
			"#!/bin/sh\n" +
				`n=$(cat ${shellQuote(tally)} 2>/dev/null | wc -l)\n` +
				`echo x >> ${shellQuote(tally)}\n` +
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
		const leader = keptSpawn("concurrent").spawn(process.execPath, [reader], {
			env: { ...baseEnv, CLAUDE_CODE_SESSION_ID: "" },
			stdio: "ignore",
		});
		const held = lockPath(live(bin));
		const deadline = Date.now() + 5000;
		while (!fs.existsSync(held) && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(fs.existsSync(held)).toBe(true);
		const follower = keptSpawn("concurrent").spawn(process.execPath, [reader], {
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

	it("costs one spawn where every racing reader is a waived sweep", async () => {
		const tally = path.join(dir, "spawns");
		const bin = path.join(dir, "claude");
		fs.writeFileSync(
			bin,
			"#!/bin/sh\n" +
				`echo x >> ${shellQuote(tally)}\n` +
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
		const leader = keptSpawn("concurrent").spawn(process.execPath, [reader], {
			env: baseEnv,
			stdio: "ignore",
		});
		const held = lockPath(live(bin));
		const deadline = Date.now() + 5000;
		while (!fs.existsSync(held) && Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(fs.existsSync(held)).toBe(true);
		const follower = keptSpawn("concurrent").spawn(process.execPath, [reader], {
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
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "me");
		const answer = liveness.listedAgents();
		expect(answer.why).toMatch(/does not list this very session \(me\)/);
	});
});

describe("what a follower refuses from the cache", () => {
	const follow = (bin: string) => {
		cache.acquire(bin);
		return cache.waitForLeader(bin);
	};

	beforeEach(() => {
		vi.stubEnv("WFC_ORACLE_CACHE_WAIT_MS", "300");
		vi.stubEnv("WFC_ORACLE_CACHE_POLL_MS", "50");
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

	it("treats a record older than the TTL as a miss", () => {
		vi.stubEnv("WFC_ORACLE_CACHE_TTL_MS", "50");
		vi.stubEnv("WFC_ORACLE_CACHE_WAIT_MS", "1200");
		vi.stubEnv("WFC_ORACLE_CACHE_POLL_MS", "500");
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
		vi.stubEnv("WFC_CLAUDE_BIN", other);
		expect(sessionsOf(liveness.listedAgents())).toEqual(["z"]);
		expect(first.spawns()).toBe(1);
	});
});

describe("racing readers (mantahostels#1924)", () => {
	it("spawns the oracle once when three readers race, not three times", async () => {
		const tally = path.join(dir, "spawns");
		const bin = path.join(dir, "claude");
		fs.writeFileSync(
			bin,
			`#!/bin/sh\necho x >> ${shellQuote(tally)}\nsleep 1\ncat <<'EOF'\n${listing("a")}\nEOF\n`,
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
						const kid = keptSpawn("concurrent").spawn(
							process.execPath,
							[reader],
							{
								env,
								stdio: "ignore",
							},
						);
						kid.on("exit", (code) => done(code ?? -1));
					}),
			),
		);
		expect(codes).toEqual([0, 0, 0]);
		expect(fs.readFileSync(tally, "utf8").trim().split("\n")).toHaveLength(1);
	}, 30_000);

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

	it("ignores a record written before the wait began", () => {
		vi.stubEnv("WFC_ORACLE_CACHE_WAIT_MS", "300");
		vi.stubEnv("WFC_ORACLE_CACHE_POLL_MS", "50");
		const bin = "/nowhere/claude";
		fs.writeFileSync(
			cachePath(bin),
			JSON.stringify({ at: Date.now() - 5, raw: listing("a") }),
		);
		cache.acquire(bin);
		expect(cache.waitForLeader(bin)).toBeNull();
	});

	it("waits no longer than a started hook budget leaves (#4115)", () => {
		vi.stubEnv("WFC_ORACLE_CACHE_WAIT_MS", "4000");
		vi.stubEnv("WFC_ORACLE_CACHE_POLL_MS", "50");
		vi.useFakeTimers({ toFake: ["Date"] });
		const { loaded, drop } = withStopClockLeft(["./oracle-cache.js"], 300);
		try {
			const [fresh] = loaded;
			const bin = "/nowhere/claude";
			fresh.acquire(bin);
			let polls = 0;
			const sleep = (ms: number) => {
				polls++;
				vi.setSystemTime(Date.now() + ms);
				return true;
			};
			expect(fresh.waitForLeader(bin, { sleep })).toBeNull();
			expect(polls).toBe(6);
		} finally {
			vi.useRealTimers();
			drop();
		}
	});

	it("hands a follower its leader's record with that record's write time (#4175)", () => {
		const bin = "/nowhere/claude";
		cache.acquire(bin);
		const sleep = () => {
			cache.write(bin, listing("a"));
			return true;
		};
		const hit = cache.waitForLeader(bin, { sleep });
		const written = JSON.parse(fs.readFileSync(cachePath(bin), "utf8"));
		expect(hit).toEqual({ raw: listing("a"), at: written.at });
	});

	it("gives up on a leader that published nothing, rather than waiting out the clock (mantahostels#1924)", () => {
		const bin = "/nowhere/claude";
		cache.acquire(bin);
		cache.release(bin);
		let polls = 0;
		const sleep = () => {
			polls++;
			return true;
		};
		expect(cache.waitForLeader(bin, { sleep })).toBeNull();
		expect(polls).toBe(1);
	});

	it("breaks a lock left behind by a killed leader (mantahostels#1920)", () => {
		const bin = "/nowhere/claude";
		cache.acquire(bin);
		const old = new Date(Date.now() - 600_000);
		fs.utimesSync(lockPath(bin), old, old);
		expect(cache.acquire(bin)).toBe(true);
	});

	it("releases the lock even where the oracle refuses, so no follower is stranded", () => {
		vi.stubEnv("WFC_CLAUDE_BIN", path.join(dir, "no-such-claude"));
		const answer = liveness.listedAgents();
		expect(answer.why).toMatch(/would not run/);
		expect(
			fs.existsSync(lockPath(live(String(process.env.WFC_CLAUDE_BIN)))),
		).toBe(false);
	});
});

describe("an unwritable config dir", () => {
	it("degrades to a live read and never throws", () => {
		const notADir = path.join(dir, "file-not-a-dir");
		vi.stubEnv("CLAUDE_CONFIG_DIR", notADir);
		fs.writeFileSync(notADir, "");
		const fake = countingClaude(listing("a"));
		expect(liveness.listedAgents().agents).toHaveLength(1);
		expect(fake.spawns()).toBe(1);
	});
});
