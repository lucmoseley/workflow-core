// @vitest-environment node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AS_ROOT,
	core,
	DEAD,
	durably,
	freshSandbox,
	listedLocks,
	live,
	liveHolder,
	lockFiles,
	locks as locksMod,
	proc,
	registerSession,
	store,
} from "./arbiter-testkit";
import { cutWorktree, defineTemplate, emptyRepoTemplate } from "./git-fixture";
import { noop } from "./noop.js";
import { sleepSync } from "./sleep-sync.js";

const sb = freshSandbox();
const sandboxRepo = defineTemplate((dir) => {
	emptyRepoTemplate(dir);
	fs.mkdirSync(path.join(dir, "docs"));
});

const TORN_SETTLE_MS = 50;

const put = (rel: string, fields: object) => {
	fs.mkdirSync(store.paths.locksDir(), { recursive: true });
	const p = store.paths.lock(rel);
	fs.writeFileSync(
		p,
		JSON.stringify(locksMod.newLock({ path: rel, ...fields })),
	);
	return p;
};

describe("acquire — check and take in one operation", () => {
	it("takes a free file", () => {
		expect(store.acquire("docs/doc-map.md", live(sb, "a")).verdict).toBe(
			"claimed",
		);
	});

	it("is re-entrant for its own holder", () => {
		const me = live(sb, "a");
		store.acquire("docs/doc-map.md", me);
		expect(store.acquire("docs/doc-map.md", me).verdict).toBe("reentrant");
	});

	it("refuses a second live session and names the first", () => {
		store.acquire("docs/doc-map.md", live(sb, "alice"));
		const r = store.acquire("docs/doc-map.md", live(sb, "bob"));
		expect(r.verdict).toBe("held");
		expect(r.lock.sessionId).toBe("alice");
	});

	it("breaks a dead holder's lock rather than wedging the file forever", () => {
		store.acquire("docs/doc-map.md", {
			sessionId: "killed",
			pid: 4_194_303,
			procStart: "1",
			durable: true,
		});
		expect(store.acquire("docs/doc-map.md", live(sb, "bob")).verdict).toBe(
			"claimed",
		);
	});

	it("resolves a resumed session to its LIVE entry, not the first match", () => {
		registerSession(sb, "resumed", 4_194_303, { procStart: "1" });
		registerSession(sb, "resumed", process.pid);

		const me = store.identify("resumed");
		expect(me.pid).toBe(process.pid);
		expect(me.durable).toBe(true);

		store.acquire("docs/doc-map.md", me);
		expect(store.acquire("docs/doc-map.md", live(sb, "bob")).verdict).toBe(
			"held",
		);
	});

	it("takes no lock when every entry for the session id is dead", () => {
		registerSession(sb, "all-dead", 4_194_303, { procStart: "1" });
		const me = store.identify("all-dead");
		expect(me.durable).toBe(false);
		store.acquire("docs/doc-map.md", me);
		expect(fs.existsSync(store.paths.lock("docs/doc-map.md"))).toBe(false);
	});

	it("claims each path separately", () => {
		const me = live(sb, "a");
		store.acquire("docs/doc-map.md", me);
		expect(store.acquire("docs/other.md", me).verdict).toBe("claimed");
	});

	it("an unidentifiable session takes no lock but is still refused a held one", () => {
		const nobody = store.identify("ghost");
		expect(nobody.durable).toBe(false);

		expect(store.acquire("docs/doc-map.md", nobody).verdict).toBe("claimed");
		expect(fs.existsSync(store.paths.lock("docs/doc-map.md"))).toBe(false);

		store.acquire("docs/doc-map.md", live(sb, "alice"));
		expect(store.acquire("docs/doc-map.md", nobody).verdict).toBe("held");
	});

	it("a jobs state file alone does NOT make a claim, or the file wedges for good", () => {
		const jd = path.join(sb.home, "jobs", "j1");
		fs.mkdirSync(jd, { recursive: true });
		fs.writeFileSync(path.join(jd, "state.json"), "{}");

		const me = store.identify("j1");
		expect(me.durable).toBe(false);
		store.acquire("docs/doc-map.md", me);
		expect(fs.existsSync(store.paths.lock("docs/doc-map.md"))).toBe(false);
	});

	it("is re-entrant for an unidentifiable session's own live lock, not denied", () => {
		put("docs/doc-map.md", { sessionId: "casper", ...liveHolder() });
		const r = store.acquire("docs/doc-map.md", {
			sessionId: "casper",
			pid: null,
			procStart: null,
			durable: false,
		});
		expect(r.verdict).toBe("reentrant");
	});

	const casper = {
		sessionId: "casper",
		pid: null,
		procStart: null,
		durable: false,
	};

	it("is refused a lock whose holder was resumed onto a new process, recording the resumed holder (mantahostels#359)", () => {
		registerSession(sb, "resumed", process.pid);
		put("docs/doc-map.md", { sessionId: "resumed", ...DEAD });
		const r = store.acquire("docs/doc-map.md", casper);
		expect(r.verdict).toBe("held");
		expect(r.lock.sessionId).toBe("resumed");
	});

	it("does not write the resumed holder's live pid back, having no claim to write", () => {
		registerSession(sb, "resumed", process.pid);
		const p = put("docs/doc-map.md", { sessionId: "resumed", ...DEAD });
		store.acquire("docs/doc-map.md", casper);
		expect(JSON.parse(fs.readFileSync(p, "utf8")).pid).toBe(DEAD.pid);
	});

	it("refuses a REGION under a whole-file claim whose holder was resumed, recording the resumed holder (#259)", () => {
		registerSession(sb, "resumed", process.ppid);
		put("docs/doc-map.md", { sessionId: "resumed", ...DEAD });
		const r = store.acquire("docs/doc-map.md#B1", live(sb, "bob"));
		expect(r.verdict).toBe("held");
		expect(r.lock.sessionId).toBe("resumed");
	});

	it("refuses a REGION under a live whole-file claim that names no session (#1469 Q3)", () => {
		put("docs/doc-map.md", { sessionId: null, ...liveHolder() });
		expect(store.acquire("docs/doc-map.md#B1", live(sb, "bob")).verdict).toBe(
			"held",
		);
	});

	it("lets the region through where the whole-file holder really did end", () => {
		registerSession(sb, "ended", DEAD.pid, { procStart: DEAD.procStart });
		put("docs/doc-map.md", { sessionId: "ended", ...DEAD });
		expect(store.acquire("docs/doc-map.md#B1", live(sb, "bob")).verdict).toBe(
			"claimed",
		);
	});

	it("still takes a lock whose holder the registry cannot place", () => {
		registerSession(sb, "ended", DEAD.pid, { procStart: DEAD.procStart });
		put("docs/doc-map.md", { sessionId: "ended", ...DEAD });
		expect(store.acquire("docs/doc-map.md", casper).verdict).toBe("claimed");
	});

	it.skipIf(AS_ROOT)(
		"takes the lock — and says so — when the registry cannot be read at all",
		() => {
			registerSession(sb, "resumed", process.pid);
			put("docs/doc-map.md", { sessionId: "resumed", ...DEAD });

			fs.chmodSync(path.join(sb.home, "sessions"), 0o000);
			try {
				expect(store.acquire("docs/doc-map.md", casper).verdict).toBe(
					"claimed",
				);
			} finally {
				fs.chmodSync(path.join(sb.home, "sessions"), 0o755);
			}
			expect(fs.readFileSync(store.errorLog(), "utf8")).toContain(
				"sessions registry could not be read",
			);
		},
	);

	it("takes its OWN stale lock back, which needs no registry walk", () => {
		put("docs/doc-map.md", { sessionId: "casper", ...DEAD });
		expect(store.acquire("docs/doc-map.md", casper).verdict).toBe("claimed");
	});
});

describe("a lock recording a pid that is no longer the session's", () => {
	it("is retaken with the live pid, not accepted as re-entrant", () => {
		registerSession(sb, "resumed", process.pid);
		const me = store.identify("resumed");
		put("docs/doc-map.md", {
			sessionId: "resumed",
			pid: 4_194_303,
			procStart: "1",
			claimId: "old",
		});

		const r = store.acquire("docs/doc-map.md", me);
		expect(r.verdict).toBe("claimed");
		expect(r.lock.pid).toBe(process.pid);

		expect(store.acquire("docs/doc-map.md", durably("other")).verdict).toBe(
			"held",
		);
	});
});

describe("a stale lock whose session id still has a live entry (mantahostels#348)", () => {
	const staleLockFor = (sessionId: string | null) =>
		put("docs/doc-map.md", { sessionId, ...DEAD });

	it("refuses a neighbour rather than breaking it, recording the neighbour as holder", () => {
		registerSession(sb, "resumed", DEAD.pid, { procStart: DEAD.procStart });
		registerSession(sb, "resumed", process.pid);
		staleLockFor("resumed");

		const r = store.acquire("docs/doc-map.md", durably("bob"));
		expect(r.verdict).toBe("held");
		expect(r.lock.sessionId).toBe("resumed");
	});

	it("re-keys it to the live pid, so the next reader repeats no walk", () => {
		registerSession(sb, "resumed", process.pid);
		const p = staleLockFor("resumed");
		const before = JSON.parse(fs.readFileSync(p, "utf8"));

		store.acquire("docs/doc-map.md", durably("bob"));

		const after = JSON.parse(fs.readFileSync(p, "utf8"));
		expect(after.pid).toBe(process.pid);
		expect(proc.holderAlive(after)).toBe(true);
		expect(after.claimId).toBe(before.claimId);
	});

	it("breaks it when the id has no registry entry at all", () => {
		staleLockFor("unregistered");
		expect(store.acquire("docs/doc-map.md", durably("bob")).verdict).toBe(
			"claimed",
		);
	});

	it("breaks it when every entry for the id is dead", () => {
		registerSession(sb, "ended", DEAD.pid, { procStart: DEAD.procStart });
		staleLockFor("ended");
		expect(store.acquire("docs/doc-map.md", durably("bob")).verdict).toBe(
			"claimed",
		);
	});

	it("breaks it when the live entry carries no procStart", () => {
		registerSession(sb, "unproveable", process.pid, { procStart: null });
		staleLockFor("unproveable");
		expect(store.acquire("docs/doc-map.md", durably("bob")).verdict).toBe(
			"claimed",
		);
	});

	it("breaks a lock carrying no session id, which resolves to nobody", () => {
		staleLockFor(null);
		expect(store.acquire("docs/doc-map.md", durably("bob")).verdict).toBe(
			"claimed",
		);
	});

	it("breaks it — and says so — when the registry cannot be read at all", () => {
		if (AS_ROOT) return;
		registerSession(sb, "resumed", process.pid);
		staleLockFor("resumed");

		fs.chmodSync(path.join(sb.home, "sessions"), 0o000);
		try {
			expect(store.acquire("docs/doc-map.md", durably("bob")).verdict).toBe(
				"claimed",
			);
		} finally {
			fs.chmodSync(path.join(sb.home, "sessions"), 0o755);
		}
		expect(fs.readFileSync(store.errorLog(), "utf8")).toContain(
			"sessions registry could not be read",
		);
	});

	it("leaves the re-pointed lock scoped to a boot, never unscoped", () => {
		registerSession(sb, "resumed", process.pid);
		const p = staleLockFor("resumed");

		store.acquire("docs/doc-map.md", durably("bob"));

		expect(JSON.parse(fs.readFileSync(p, "utf8")).bootId).toBe(
			proc.readCurrentBootId(),
		);
	});

	it("hands back the lock actually on disk when the rewrite loses a race", () => {
		const existing = locksMod.newLock({
			path: "docs/doc-map.md",
			sessionId: "resumed",
			...DEAD,
		});
		const p = put("docs/doc-map.md", {
			sessionId: "someone-else",
			...liveHolder(),
		});
		const onDisk = JSON.parse(fs.readFileSync(p, "utf8"));

		const reported = locksMod.repointLock(
			"docs/doc-map.md",
			existing,
			liveHolder(),
		);

		expect(reported.claimId).toBe(onDisk.claimId);
		expect(reported.sessionId).toBe("someone-else");
		expect(JSON.parse(fs.readFileSync(p, "utf8"))).toEqual(onDisk);
	});
});

describe("contention this session lost every time", () => {
	const contend = (rel: string, fields: object) => {
		registerSession(sb, "a", process.pid);
		put(rel, fields);
		return store.identify("a");
	};

	it("does not let a DEAD lock it could not break refuse the write", () => {
		const me = contend("docs/doc-map.md", { sessionId: "ghost", ...DEAD });
		expect(store.acquire("docs/doc-map.md", me, 0).verdict).toBe("claimed");
		expect(fs.readFileSync(store.errorLog(), "utf8")).toContain(
			"no lock written",
		);
	});

	it("still refuses a file a LIVE session holds", () => {
		const me = contend("docs/doc-map.md", {
			sessionId: "alice",
			...liveHolder(),
		});
		expect(store.acquire("docs/doc-map.md", me, 0).verdict).toBe("held");
	});
});

describe("a lock broken on the final retry", () => {
	const claimant = (rel: string, fields: object) => {
		registerSession(sb, "a", process.pid);
		put(rel, fields);
		return store.identify("a");
	};

	it("takes the path a STALE-holder break freed, rather than writing no lock", () => {
		const me = claimant("docs/doc-map.md", { sessionId: "ghost", ...DEAD });
		const r = store.acquire("docs/doc-map.md", me, 1);
		expect(r.verdict).toBe("claimed");
		expect(r.lock).not.toBeNull();
		expect(r.lock.sessionId).toBe("a");
		expect(
			JSON.parse(fs.readFileSync(store.paths.lock("docs/doc-map.md"), "utf8"))
				.sessionId,
		).toBe("a");
	});

	it("takes the path a CORRUPT-record break freed", () => {
		registerSession(sb, "a", process.pid);
		fs.mkdirSync(store.paths.locksDir(), { recursive: true });
		fs.writeFileSync(store.paths.lock("docs/doc-map.md"), "");
		const r = store.acquire("docs/doc-map.md", store.identify("a"), 1);
		expect(r.verdict).toBe("claimed");
		expect(r.lock).not.toBeNull();
		expect(r.lock.sessionId).toBe("a");
	});

	it("still returns held for a live holder, having spent its whole budget", () => {
		const me = claimant("docs/doc-map.md", {
			sessionId: "alice",
			...liveHolder(),
		});
		const r = store.acquire("docs/doc-map.md", me, 3);
		expect(r.verdict).toBe("held");
		expect(r.lock.sessionId).toBe("alice");
	});
});

describe("readLocks — a record that will not parse", () => {
	interface Listed {
		sessionId?: string;
		unreadable?: boolean;
		file?: string;
	}

	const planted = (name: string, body: string) => {
		fs.mkdirSync(store.paths.locksDir(), { recursive: true });
		fs.writeFileSync(path.join(store.paths.locksDir(), name), body);
	};

	it("surfaces it in place, so the readable records beside it survive", () => {
		put("docs/doc-map.md", { sessionId: "alice", ...liveHolder() });
		planted("deadbeefcafe0002.json", "");
		const locks = store.readLocks();
		assert(locks);
		expect(locks).toHaveLength(2);
		expect(locks.find((l: Listed) => l.sessionId === "alice")).toBeTruthy();
		const bad = locks.find((l: Listed) => l.unreadable);
		expect(bad.file).toBe("deadbeefcafe0002.json");
		expect(bad.reason).toBe("unparseable");
	});

	it("settles: a record finished during the pause is a lock, not a fault", () => {
		put("docs/doc-map.md", { sessionId: "alice", ...liveHolder() });
		planted("deadbeefcafe0003.json", '{"path":"docs/PRD.md","sessi');
		const locks = store.readLocks(() =>
			planted(
				"deadbeefcafe0003.json",
				JSON.stringify(
					locksMod.newLock({ path: "docs/PRD.md", sessionId: "bob" }),
				),
			),
		);
		assert(locks);
		expect(locks).toHaveLength(2);
		expect(locks.some((l: Listed) => l.unreadable)).toBe(false);
		expect(locks.find((l: Listed) => l.sessionId === "bob")).toBeTruthy();
	});

	it("does not settle twice: one pause covers the whole listing", () => {
		planted("deadbeefcafe0004.json", "");
		planted("deadbeefcafe0005.json", "");
		let pauses = 0;
		const locks = store.readLocks(() => {
			pauses += 1;
		});
		expect(pauses).toBe(1);
		assert(locks);
		expect(locks.filter((l: Listed) => l.unreadable)).toHaveLength(2);
	});

	// #852.
	const ageOut = (name: string) => {
		const past = (Date.now() - 86_400_000) / 1000;
		fs.utimesSync(path.join(store.paths.locksDir(), name), past, past);
	};

	it("does not pause for a record over an hour old: it is corrupt on sight", () => {
		planted("deadbeefcafe0008.json", "");
		ageOut("deadbeefcafe0008.json");
		const locks = store.readLocks(() => {
			throw new Error("paused for a record that cannot still be mid-write");
		});
		assert(locks);
		expect(locks).toHaveLength(1);
		expect(locks[0].reason).toBe("unparseable");
	});

	it("still pauses once where an aged record sits beside a fresh one", () => {
		planted("deadbeefcafe0009.json", "");
		ageOut("deadbeefcafe0009.json");
		planted("deadbeefcafe000a.json", "");
		let pauses = 0;
		const locks = store.readLocks(() => {
			pauses += 1;
		});
		expect(pauses).toBe(1);
		assert(locks);
		expect(locks.filter((l: Listed) => l.unreadable)).toHaveLength(2);
	});

	it("pauses for an aged record whose age cannot be read", () => {
		planted("deadbeefcafe000b.json", "");
		ageOut("deadbeefcafe000b.json");
		const stat = vi.spyOn(fs, "statSync").mockImplementation(() => {
			throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		});
		let pauses = 0;
		try {
			store.readLocks(() => {
				pauses += 1;
			});
		} finally {
			stat.mockRestore();
		}
		expect(pauses).toBe(1);
	});

	it("resolves the lock directory once, however many records it judges", () => {
		put("docs/doc-map.md", { sessionId: "alice", ...liveHolder() });
		put("docs/PRD.md", { sessionId: "bob", ...liveHolder() });
		planted("deadbeefcafe0007.json", "");
		const spy = vi.spyOn(core.paths, "locksDir");
		try {
			expect(store.readLocks(noop)).toHaveLength(3);
			// #841
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
	});

	it("really waits by default, so production settles as well as the seam", () => {
		planted("deadbeefcafe0006.json", "");
		const started = Date.now();
		store.readLocks();
		expect(Date.now() - started).toBeGreaterThanOrEqual(TORN_SETTLE_MS - 10);
	});
});

describe("debris — what a process killed mid-break leaves behind", () => {
	const plant = (name: string, ageMs: number) => {
		fs.mkdirSync(store.paths.locksDir(), { recursive: true });
		const p = path.join(store.paths.locksDir(), name);
		fs.writeFileSync(p, "{}");
		const t = new Date(Date.now() - ageMs);
		fs.utimesSync(p, t, t);
		return p;
	};

	it("removes .tmp- and .stale- files old enough to be certainly abandoned", () => {
		const tmp = plant(".tmp-999-deadbeef", 2 * 60 * 60 * 1000);
		const stale = plant("abc123.json.stale-deadbeef", 2 * 60 * 60 * 1000);
		locksMod.sweepDebris();
		expect(fs.existsSync(tmp)).toBe(false);
		expect(fs.existsSync(stale)).toBe(false);
	});

	it("leaves recent debris alone — it may be a claim in flight", () => {
		const inflight = plant(".tmp-1000-cafe01", 30 * 60 * 1000);
		locksMod.sweepDebris();
		expect(fs.existsSync(inflight)).toBe(true);
	});

	it("restamps a lock renamed aside, so the sweep cannot take it mid-break", () => {
		const lockPath = put("docs/doc-map.md", { sessionId: "ghost", ...DEAD });
		const t = new Date(Date.now() - 3 * 60 * 60 * 1000);
		fs.utimesSync(lockPath, t, t);

		const r = lockFiles.dropIfUnchanged("docs/doc-map.md", () => {
			locksMod.sweepDebris();
			return false;
		});

		expect(r).toMatchObject({ outcome: "kept", restored: true });
		expect(fs.existsSync(lockPath)).toBe(true);
	});

	it("is actually run by acquire(), not merely available to it", () => {
		const old = plant(".tmp-999-abandoned", 2 * 60 * 60 * 1000);
		registerSession(sb, "alice", process.pid);
		store.acquire("docs/doc-map.md", store.identify("alice"));
		expect(fs.existsSync(old)).toBe(false);
	});

	it("clears an old once-per-session marker, so a still-broken guard is re-said", () => {
		const said = plant(".said-abcdef0123456789", 2 * 60 * 60 * 1000);
		locksMod.sweepDebris();
		expect(fs.existsSync(said)).toBe(false);
	});

	it("restores a live lock found stranded aside, instead of sweeping it", () => {
		const lockPath = store.paths.lock("docs/doc-map.md");
		fs.mkdirSync(store.paths.locksDir(), { recursive: true });
		fs.writeFileSync(
			`${lockPath}.stale-cafe02`,
			JSON.stringify(
				locksMod.newLock({
					path: "docs/doc-map.md",
					sessionId: "victim",
					...liveHolder(),
					claimId: "stranded",
				}),
			),
		);

		registerSession(sb, "other", process.pid);
		const r = store.acquire("docs/doc-map.md", store.identify("other"));
		expect(r.verdict).toBe("held");
		expect(r.lock.claimId).toBe("stranded");
		expect(fs.readFileSync(store.errorLog(), "utf8")).toContain(
			"stranded aside",
		);
	});

	it("restores an aside whose holder was RESUMED onto a new process (mantahostels#359)", () => {
		const lockPath = store.paths.lock("docs/doc-map.md");
		fs.mkdirSync(store.paths.locksDir(), { recursive: true });
		const aside = `${lockPath}.stale-cafe03`;
		fs.writeFileSync(
			aside,
			JSON.stringify(
				locksMod.newLock({
					path: "docs/doc-map.md",
					sessionId: "resumed",
					...DEAD,
					claimId: "stranded",
				}),
			),
		);
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
		fs.utimesSync(aside, old, old);
		registerSession(sb, "resumed", process.pid);

		locksMod.sweepDebris();

		expect(fs.existsSync(aside)).toBe(false);
		expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).claimId).toBe(
			"stranded",
		);
	});

	it.skipIf(AS_ROOT)(
		"sweeps an aged aside — and says so — on a registry it cannot read",
		() => {
			const aside = `${store.paths.lock("docs/doc-map.md")}.stale-cafe04`;
			fs.mkdirSync(store.paths.locksDir(), { recursive: true });
			fs.writeFileSync(
				aside,
				JSON.stringify(
					locksMod.newLock({
						path: "docs/doc-map.md",
						sessionId: "resumed",
						...DEAD,
					}),
				),
			);
			const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
			fs.utimesSync(aside, old, old);
			registerSession(sb, "resumed", process.pid);

			fs.chmodSync(path.join(sb.home, "sessions"), 0o000);
			try {
				locksMod.sweepDebris();
			} finally {
				fs.chmodSync(path.join(sb.home, "sessions"), 0o755);
			}

			expect(fs.existsSync(aside)).toBe(false);
			expect(fs.readFileSync(store.errorLog(), "utf8")).toContain(
				"cannot be told from debris",
			);
		},
	);

	it("does not resurrect a DEAD aside; the age sweep owns it", () => {
		const lockPath = store.paths.lock("docs/doc-map.md");
		fs.mkdirSync(store.paths.locksDir(), { recursive: true });
		const aside = `${lockPath}.stale-dead02`;
		fs.writeFileSync(
			aside,
			JSON.stringify(
				locksMod.newLock({
					path: "docs/doc-map.md",
					sessionId: "ghost",
					...DEAD,
				}),
			),
		);
		registerSession(sb, "other", process.pid);
		expect(
			store.acquire("docs/doc-map.md", store.identify("other")).verdict,
		).toBe("claimed");
		expect(fs.existsSync(aside)).toBe(true);
	});

	it("refuses to restore a lock over a path someone else has since taken, leaving the newer lock in place", () => {
		const lockPath = put("docs/doc-map.md", { sessionId: "third" });
		const aside = `${lockPath}.stale-cafe05`;
		fs.writeFileSync(
			aside,
			JSON.stringify(
				locksMod.newLock({
					path: "docs/doc-map.md",
					sessionId: "first",
					...liveHolder(),
				}),
			),
		);

		locksMod.sweepDebris();

		expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).sessionId).toBe(
			"third",
		);
		expect(fs.existsSync(aside)).toBe(true);
	});

	it("never touches a real lock, however old", () => {
		registerSession(sb, "alice", process.pid);
		store.acquire("docs/doc-map.md", store.identify("alice"));
		const lock = store.paths.lock("docs/doc-map.md");
		const t = new Date(Date.now() - 30 * 86_400_000);
		fs.utimesSync(lock, t, t);
		locksMod.sweepDebris();
		expect(fs.existsSync(lock)).toBe(true);
	});
});

describe("the break path — reached directly, because acquire() cannot be", () => {
	const readAsides = () =>
		fs
			.readdirSync(store.paths.locksDir())
			.filter((f: string) => f.includes(".json.stale-"));

	it("frees the path, and leaves no aside behind, when the lock really was stale", () => {
		const existing = locksMod.newLock({
			path: "docs/doc-map.md",
			...DEAD,
			claimId: "c1",
		});
		const p = put("docs/doc-map.md", { ...DEAD, claimId: "c1" });
		existing.claimId = JSON.parse(fs.readFileSync(p, "utf8")).claimId;

		expect(locksMod.breakStale("docs/doc-map.md", existing)).toBe("freed");
		expect(fs.existsSync(p)).toBe(false);
		expect(readAsides()).toEqual([]);
	});

	it("puts back a lock that turned live between the read and the rename", () => {
		const existing = locksMod.newLock({ path: "docs/doc-map.md", ...DEAD });
		const p = put("docs/doc-map.md", { ...liveHolder(), claimId: "fresh" });

		expect(locksMod.breakStale("docs/doc-map.md", existing)).toBe("retry");
		expect(fs.existsSync(p)).toBe(true);
		expect(JSON.parse(fs.readFileSync(p, "utf8")).claimId).toBe("fresh");
		expect(readAsides()).toEqual([]);
	});

	it("puts back a lock it cannot read rather than treating it as free", () => {
		const existing = locksMod.newLock({ path: "docs/doc-map.md", ...DEAD });
		const p = put("docs/doc-map.md", {});
		fs.writeFileSync(p, "{not json");

		expect(locksMod.breakStale("docs/doc-map.md", existing)).toBe("retry");
		expect(fs.existsSync(p)).toBe(true);
		expect(fs.readFileSync(p, "utf8")).toBe("{not json");
	});

	it("frees a lock whose holder is dead even when the claimId has changed", () => {
		const existing = locksMod.newLock({ path: "docs/doc-map.md", ...DEAD });
		const p = put("docs/doc-map.md", { ...DEAD, claimId: "different" });

		expect(locksMod.breakStale("docs/doc-map.md", existing)).toBe("freed");
		expect(fs.existsSync(p)).toBe(false);
	});
});

describe("a lock record that will never parse (mantahostels#1691)", () => {
	const rel = "docs/doc-map-counts.json";
	const corrupt = (bytes: string) => {
		fs.mkdirSync(store.paths.locksDir(), { recursive: true });
		const p = store.paths.lock(rel);
		fs.writeFileSync(p, bytes);
		return p;
	};
	const readBreaks = () =>
		fs.existsSync(store.paths.breaksDir())
			? fs.readdirSync(store.paths.breaksDir())
			: [];
	const readErrors = () =>
		fs.existsSync(store.errorLog())
			? fs.readFileSync(store.errorLog(), "utf8")
			: "";
	const onBreakRename = (before: () => void) => {
		const lockPath = store.paths.lock(rel);
		const real = fs.renameSync;
		let fired = false;
		return vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
			if (!fired && from === lockPath) {
				fired = true;
				before();
			}
			real(from, to);
		});
	};
	const childDelayMs = 20;
	const sleepSyncPath = path.join(__dirname, "sleep-sync.js");

	describe("probeRecord — the two nulls readRecord collapses", () => {
		it("tells absent, unparseable and ok apart", () => {
			const f = path.join(sb.dir, "probe.json");
			expect(core.probeRecord(f)).toEqual({ state: "absent", record: null });
			fs.writeFileSync(f, "");
			expect(core.probeRecord(f).state).toBe("unparseable");
			fs.writeFileSync(f, "{not json");
			expect(core.probeRecord(f).state).toBe("unparseable");
			fs.writeFileSync(f, "5");
			expect(core.probeRecord(f).state).toBe("unparseable");
			fs.writeFileSync(f, '{"a":1}');
			expect(core.probeRecord(f)).toEqual({ state: "ok", record: { a: 1 } });
		});

		it("throws on a refused read, exactly as readRecord does (mantahostels#174)", () => {
			const dir = path.join(sb.dir, "refused");
			fs.mkdirSync(dir, { recursive: true });
			const f = path.join(dir, "rec.json");
			fs.writeFileSync(f, "{}");
			fs.chmodSync(dir, 0o000);
			try {
				expect(() => core.probeRecord(f)).toThrow(/EACCES/);
			} finally {
				fs.chmodSync(dir, 0o700);
			}
		});
	});

	it("claims a path whose lock record is zero bytes, and writes a real lock", () => {
		registerSession(sb, "a", process.pid);
		const p = corrupt("");

		const taken = store.acquire(rel, store.identify("a"));

		expect(taken.verdict).toBe("claimed");
		expect(taken.lock).not.toBeNull();
		expect(core.readRecord(p)?.sessionId).toBe("a");
		expect(readErrors()).not.toContain("no lock written");
	});

	it("records the break, so a destroyed claim is visible rather than silent", () => {
		registerSession(sb, "a", process.pid);
		corrupt("{not json");

		store.acquire(rel, store.identify("a"));

		expect(readBreaks()).toHaveLength(1);
		const record = core.readRecord(
			path.join(store.paths.breaksDir(), readBreaks()[0]),
		);
		expect(record?.path).toBe(rel);
		expect(record?.brokenBy).toBe("a");
		expect(record?.lostBy).toBeNull();
		expect(readErrors()).toContain("unparseable lock record");
	});

	it("leaves no aside behind", () => {
		registerSession(sb, "a", process.pid);
		corrupt("");
		store.acquire(rel, store.identify("a"));
		expect(
			fs
				.readdirSync(store.paths.locksDir())
				.filter((f: string) => f.includes(".json.stale-")),
		).toEqual([]);
	});

	it("still refuses the file when the unparseable record was a TORN write, recording no break and leaving the live lock in place", () => {
		registerSession(sb, "a", process.pid);
		const p = corrupt("");
		const good = JSON.stringify(
			locksMod.newLock({ path: rel, sessionId: "mid-write", ...liveHolder() }),
		);
		const ready = path.join(sb.dir, "child-ready");
		const go = path.join(sb.dir, "go");
		const child = spawn(
			process.execPath,
			[
				"-e",
				`const fs=require("fs"),{sleepSync:w}=require(${JSON.stringify(sleepSyncPath)});` +
					`fs.writeFileSync(${JSON.stringify(ready)},"1");` +
					`while(!fs.existsSync(${JSON.stringify(go)}))w(1);` +
					`w(${childDelayMs});` +
					`fs.writeFileSync(${JSON.stringify(p)},${JSON.stringify(good)});`,
			],
			{ stdio: "ignore" },
		);
		try {
			const deadline = Date.now() + 10_000;
			while (!fs.existsSync(ready) && Date.now() < deadline) sleepSync(1);
			expect(fs.existsSync(ready)).toBe(true);
			fs.writeFileSync(go, "1");

			const began = Date.now();
			const taken = store.acquire(rel, store.identify("a"));
			const elapsed = Date.now() - began;

			expect(taken.verdict).toBe("held");
			expect(taken.lock?.sessionId).toBe("mid-write");
			expect(readBreaks()).toEqual([]);
			expect(core.readRecord(p)?.sessionId).toBe("mid-write");
			expect(elapsed).toBeGreaterThanOrEqual(TORN_SETTLE_MS);
		} finally {
			child.kill();
		}
	});

	it("puts back a record that turned readable between the judgement and the rename", () => {
		const p = corrupt("{not json");
		const good = JSON.stringify(
			locksMod.newLock({ path: rel, ...liveHolder(), claimId: "fresh" }),
		);
		const rename = onBreakRename(() => fs.writeFileSync(p, good));
		try {
			expect(store.acquire(rel, durably("a")).verdict).toBe("held");
		} finally {
			rename.mockRestore();
		}
		expect(core.readRecord(p)?.claimId).toBe("fresh");
		expect(readBreaks()).toEqual([]);
	});

	it.skipIf(AS_ROOT)(
		"puts back a record it could not READ rather than calling it corrupt (mantahostels#174)",
		() => {
			const p = corrupt("{not json");
			const rename = onBreakRename(() => fs.chmodSync(p, 0o000));
			try {
				expect(store.acquire(rel, durably("a")).verdict).toBe("unknown");
				expect(fs.existsSync(store.paths.lock(rel))).toBe(true);
			} finally {
				rename.mockRestore();
				fs.chmodSync(store.paths.lock(rel), 0o600);
			}
			expect(fs.readFileSync(store.paths.lock(rel), "utf8")).toBe("{not json");
			expect(readBreaks()).toEqual([]);
		},
	);
});

describe("release — the second exit from a claim", () => {
	beforeEach(() => {
		sandboxRepo.instantiate(sb.repo);
	});

	const held = (rel: string) => listedLocks().some((l) => l.path === rel);

	it("drops the claim, and the next session can then take the file", () => {
		const me = live(sb, "alice");
		store.acquire("docs/doc-map.md", me);
		expect(store.release("docs/doc-map.md", me).verdict).toBe("released");
		expect(held("docs/doc-map.md")).toBe(false);
		expect(store.acquire("docs/doc-map.md", live(sb, "bob")).verdict).toBe(
			"claimed",
		);
	});

	it("refuses a claim this session does not hold, and names the holder", () => {
		store.acquire("docs/doc-map.md", live(sb, "alice"));
		const r = store.release("docs/doc-map.md", live(sb, "bob"));
		expect(r.verdict).toBe("held-by-other");
		assert(r.lock);
		expect(r.lock.sessionId).toBe("alice");
		expect(held("docs/doc-map.md")).toBe(true);
	});

	it("refuses while the file is dirty, so the next claimant cannot commit the edit", () => {
		const me = live(sb, "alice");
		store.acquire("docs/doc-map.md", me);
		fs.writeFileSync(path.join(sb.repo, "docs/doc-map.md"), "half an edit\n");
		expect(store.release("docs/doc-map.md", me).verdict).toBe("dirty");
		expect(held("docs/doc-map.md")).toBe(true);
	});

	it("refuses when git cannot answer, rather than releasing on an unproven clean", () => {
		const me = live(sb, "alice");
		store.acquire("docs/doc-map.md", me);
		fs.rmSync(path.join(sb.repo, ".git"), { recursive: true, force: true });
		expect(store.gitDirty("docs/doc-map.md")).toBeNull();
		expect(store.release("docs/doc-map.md", me).verdict).toBe("uncheckable");
		expect(held("docs/doc-map.md")).toBe(true);
	});

	it("hands back the content answer on an uncheckable refusal (mantahostels#420)", () => {
		const me = live(sb, "alice");
		const file = path.join(sb.repo, "docs/doc-map.md");
		fs.writeFileSync(file, "alice's work\n");
		store.acquire("docs/doc-map.md", me);
		const blob = store.recordContent("docs/doc-map.md", me);
		fs.writeFileSync(file, "restored from a backup\n");
		fs.rmSync(path.join(sb.repo, ".git", "HEAD"));

		const r = store.release("docs/doc-map.md", me);
		expect(r.verdict).toBe("uncheckable");
		expect(r.content).toEqual({ state: "changed", was: blob, by: "alice" });
		expect(held("docs/doc-map.md")).toBe(true);
	});

	it("treats releasing a path nobody claims as no fault", () => {
		expect(store.release("docs/doc-map.md", live(sb, "alice")).verdict).toBe(
			"not-held",
		);
	});

	it("puts back a lock that is not the one it read, rather than dropping it", () => {
		store.acquire("docs/doc-map.md", live(sb, "alice"));
		const r = lockFiles.dropIfUnchanged(
			"docs/doc-map.md",
			(m: { claimId: string }) => m.claimId === "not-this-one",
		);
		expect(r.outcome).toBe("kept");
		expect(r.restored).toBe(true);
		expect(held("docs/doc-map.md")).toBe(true);
	});
});

describe("listLocks", () => {
	it("reports held paths with holder liveness, so wedged and busy are distinguishable", () => {
		registerSession(sb, "alice", process.pid);
		store.acquire("docs/a-live.md", store.identify("alice"));
		store.acquire("docs/b-dead.md", {
			sessionId: "gone",
			pid: 4_194_303,
			procStart: "1",
			durable: true,
		});
		const held = listedLocks();
		const aliveAt = (rel: string) => held.find((l) => l.path === rel)?.alive;
		expect(aliveAt("docs/a-live.md")).toBe(true);
		expect(aliveAt("docs/b-dead.md")).toBe(false);
	});

	const aliveOf = (rel: string) =>
		listedLocks().find((l) => l.path === rel)?.alive;

	it("calls a RESUMED holder's claim live, so `list` cannot print it STALE (mantahostels#359)", () => {
		registerSession(sb, "resumed", process.pid);
		put("docs/resumed.md", { sessionId: "resumed", ...DEAD });
		expect(aliveOf("docs/resumed.md")).toBe(true);
	});

	it("still calls a holder the registry cannot place dead", () => {
		registerSession(sb, "ended", DEAD.pid, { procStart: DEAD.procStart });
		put("docs/ended.md", { sessionId: "ended", ...DEAD });
		put("docs/unregistered.md", { sessionId: "nobody", ...DEAD });
		expect(aliveOf("docs/ended.md")).toBe(false);
		expect(aliveOf("docs/unregistered.md")).toBe(false);
	});

	it.skipIf(AS_ROOT)(
		"shows a resumed holder STALE — and says so — on a registry it cannot read",
		() => {
			registerSession(sb, "resumed", process.pid);
			put("docs/resumed.md", { sessionId: "resumed", ...DEAD });

			fs.chmodSync(path.join(sb.home, "sessions"), 0o000);
			try {
				expect(aliveOf("docs/resumed.md")).toBe(false);
			} finally {
				fs.chmodSync(path.join(sb.home, "sessions"), 0o755);
			}
			expect(fs.readFileSync(store.errorLog(), "utf8")).toContain(
				"judged STALE and may in fact be live",
			);
		},
	);

	it("leaves readHeldBy answering without judging liveness at all", () => {
		registerSession(sb, "resumed", process.pid);
		put("docs/resumed.md", { sessionId: "resumed", ...DEAD });
		expect(store.readHeldBy("resumed")).toEqual(["docs/resumed.md"]);
	});
});

describe("readHeldBy — the paths one session holds", () => {
	it("names this session's claims and nobody else's", () => {
		store.acquire("docs/a.md", live(sb, "alice"));
		store.acquire("scripts/b.js", live(sb, "alice"));
		store.acquire("docs/c.md", live(sb, "bob"));
		const heldBy = store.readHeldBy("alice");
		assert(heldBy);
		expect(heldBy.sort()).toEqual(["docs/a.md", "scripts/b.js"]);
	});

	it("returns null, not an empty hold, when the store cannot be read", () => {
		fs.mkdirSync(store.stateDir(), { recursive: true });
		fs.writeFileSync(store.paths.locksDir(), "not a directory");
		expect(store.readHeldBy("alice")).toBeNull();
	});
});

describe("whoHolds — the one holder-and-cover query (#1492)", () => {
	const map = "docs/doc-map.md";
	const registry = () => core.resumedHolderTest("test", "registry dark");
	const dark = Object.assign(() => false, { registryUnreadable: () => true });
	const ask = (subject: string, resumed = registry()) =>
		store.whoHolds(subject, "bob", resumed);

	it("names another session's live lock as the holder", () => {
		put("docs/a.md", { sessionId: "alice", ...liveHolder() });
		expect(ask("docs/a.md")).toMatchObject({
			holder: { sessionId: "alice" },
			own: null,
			dead: [],
			unknown: false,
		});
	});

	it("names the asker's own overlapping lock as cover, never as the holder", () => {
		put(map, { sessionId: "bob", ...DEAD });
		expect(ask(`${map}#B1`)).toMatchObject({
			holder: null,
			own: { sessionId: "bob", path: map },
			dead: [],
		});
	});

	it("lists a dead overlapping lock, and is not unknown where the registry opened", () => {
		registerSession(sb, "ended", DEAD.pid, { procStart: DEAD.procStart });
		put("docs/a.md", { sessionId: "ended", ...DEAD });
		expect(ask("docs/a.md")).toMatchObject({
			holder: null,
			dead: [{ sessionId: "ended" }],
			unknown: false,
		});
	});

	it("is unknown where a dead overlapping lock met a registry that would not open (#271)", () => {
		put("docs/a.md", { sessionId: "alice", ...DEAD });
		expect(ask("docs/a.md", dark)).toMatchObject({
			holder: null,
			unknown: true,
		});
	});

	it("is not unknown over a dead lock on some other path", () => {
		put("docs/other.md", { sessionId: "alice", ...DEAD });
		expect(ask("docs/a.md", dark)).toMatchObject({ dead: [], unknown: false });
	});

	it("never meets across two different regions", () => {
		put(`${map}#B1`, { sessionId: "alice", ...liveHolder() });
		expect(ask(`${map}#B2`)).toMatchObject({ holder: null, dead: [] });
	});

	it("meets a whole-file claim from a region, and a region claim from the whole file", () => {
		put(map, { sessionId: "alice", ...liveHolder() });
		expect(ask(`${map}#B1`)?.holder?.path).toBe(map);
		fs.rmSync(store.paths.lock(map));
		put(`${map}#B1`, { sessionId: "alice", ...liveHolder() });
		expect(ask(map)?.holder?.path).toBe(`${map}#B1`);
	});

	it("counts a live lock naming no session as a holder (#1469 Q3)", () => {
		put("docs/a.md", { sessionId: null, ...liveHolder() });
		expect(ask("docs/a.md")?.holder).toMatchObject({ sessionId: null });
	});

	it("never asks the registry about a dead lock naming no session", () => {
		put("docs/a.md", { sessionId: null, ...DEAD });
		const asked = Object.assign(
			vi.fn(() => false),
			{ registryUnreadable: () => true },
		);
		expect(ask("docs/a.md", asked)).toMatchObject({
			holder: null,
			dead: [{ sessionId: null }],
			unknown: false,
		});
		expect(asked).not.toHaveBeenCalled();
	});

	it("returns null where the store cannot be read", () => {
		fs.mkdirSync(store.stateDir(), { recursive: true });
		fs.writeFileSync(store.paths.locksDir(), "not a directory");
		expect(ask("docs/a.md")).toBeNull();
	});
});

describe("a region claim's cleanliness is its own region's, not the file's (mantahostels#1434)", () => {
	const rel = "docs/doc-map.md";
	const abs = () => path.join(sb.repo, rel);

	const doc = (b196: string, b197: string, row = "docs/agents/x.md") =>
		[
			"# Doc map",
			"",
			"v1.0 · 1 January 2026",
			"",
			"## Section A — document register",
			"",
			"| Path | Role |",
			"|---|---|",
			`| \`${row}\` | a register row |`,
			"",
			"## Section B — figures",
			"",
			"The preamble.",
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

	const write = (text: string) => {
		fs.mkdirSync(path.dirname(abs()), { recursive: true });
		fs.writeFileSync(abs(), text);
	};
	const stage = () =>
		execFileSync("git", ["add", "-A"], { cwd: sb.repo, encoding: "utf8" });

	const committedDoc = defineTemplate((dir) => {
		emptyRepoTemplate(dir);
		fs.mkdirSync(path.join(dir, "docs"));
		fs.writeFileSync(
			path.join(dir, rel),
			doc("B196 as committed.", "B197 as committed."),
		);
		execFileSync("git", ["add", "-A"], { cwd: dir });
		execFileSync(
			"git",
			["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"],
			{ cwd: dir },
		);
	});

	beforeEach(() => {
		committedDoc.instantiate(sb.repo);
	});

	it("reads a region as clean while another region of the file is dirty", () => {
		write(doc("B196 as committed.", "B197, edited by a neighbour."));
		expect(store.gitDirty(rel)).toBe(true);
		expect(store.subjectDirty(`${rel}#B196`)).toBe(false);
		expect(store.subjectDirty(`${rel}#B197`)).toBe(true);
	});

	it("releases a clean region while another region of the file is dirty", () => {
		const me = live(sb, "alice");
		store.acquire(`${rel}#B196`, me);
		write(doc("B196 as committed.", "B197, edited by a neighbour."));
		expect(store.release(`${rel}#B196`, me).verdict).toBe("released");
	});

	it("still refuses a release while the claimed region itself is dirty", () => {
		const me = live(sb, "alice");
		store.acquire(`${rel}#B196`, me);
		write(doc("B196, half-rewritten.", "B197 as committed."));
		expect(store.release(`${rel}#B196`, me).verdict).toBe("dirty");
	});

	it("ignores a neighbour's insert above, which shifts the region's lines", () => {
		const me = live(sb, "alice");
		store.acquire(`${rel}#B197`, me);
		write(
			doc("B196 as committed.", "B197 as committed.").replace(
				"The preamble.",
				"The preamble.\n\nA whole paragraph a neighbour added.",
			),
		);
		expect(store.subjectDirty(`${rel}#B197`)).toBe(false);
		expect(store.release(`${rel}#B197`, me).verdict).toBe("released");
	});

	it("reads the last region as clean, trailing newline and all", () => {
		expect(store.subjectDirty(`${rel}#B197`)).toBe(false);
	});

	it("reads a §A row region independently of the rest of §A", () => {
		write(
			doc(
				"B196 as committed.",
				"B197 as committed.",
				"docs/agents/x.md",
			).replace("| Path | Role |", "| Path | Role | Owner |"),
		);
		expect(store.subjectDirty(`${rel}#A:docs/agents/x.md`)).toBe(false);
		expect(store.subjectDirty(`${rel}#section-a`)).toBe(true);
	});

	it("calls a region dirty when it exists on only one side", () => {
		write(
			`${doc("B196 as committed.", "B197 as committed.")}\n### B198 · New\n`,
		);
		expect(store.subjectDirty(`${rel}#B198`)).toBe(true);
	});

	it("catches a change staged and then reverted in the working tree", () => {
		write(doc("B196, staged but not committed.", "B197 as committed."));
		stage();
		write(doc("B196 as committed.", "B197 as committed."));
		expect(store.subjectDirty(`${rel}#B196`)).toBe(true);
		expect(store.subjectDirty(`${rel}#B197`)).toBe(false);
	});

	it("reads a region in NEITHER revision as clean, so its claim can be dropped", () => {
		const me = live(sb, "alice");
		store.acquire(`${rel}#B999`, me);
		expect(store.subjectDirty(`${rel}#B999`)).toBe(false);
		expect(store.release(`${rel}#B999`, me).verdict).toBe("released");
	});

	it("falls back to the whole file where there is no HEAD to compare against", () => {
		fs.rmSync(path.join(sb.repo, ".git"), { recursive: true, force: true });
		execFileSync("git", ["init", "-q"], { cwd: sb.repo });
		expect(store.subjectDirty(`${rel}#B196`)).toBe(true);
	});

	it("leaves a whole-file subject on the file-level test", () => {
		write(doc("B196 as committed.", "B197, edited by a neighbour."));
		expect(store.subjectDirty(rel)).toBe(true);
	});

	describe("the §A generator's release waives that refusal (mantahostels#2428)", () => {
		const dirtyA = () =>
			write(
				doc("B196 as committed.", "B197 as committed.").replace(
					"| Path | Role |",
					"| Path | Role | Owner |",
				),
			);
		const stillHeld = (subject: string) =>
			listedLocks().some((l) => l.path === subject);

		it("drops a dirty §A claim under --generator", () => {
			const me = live(sb, "alice");
			store.acquire(`${rel}#section-a`, me);
			dirtyA();
			expect(store.subjectDirty(`${rel}#section-a`)).toBe(true);
			expect(
				store.release(`${rel}#section-a`, me, { generator: true }).verdict,
			).toBe("released");
			expect(stillHeld(`${rel}#section-a`)).toBe(false);
		});

		it("still refuses that same claim without the flag", () => {
			const me = live(sb, "alice");
			store.acquire(`${rel}#section-a`, me);
			dirtyA();
			expect(store.release(`${rel}#section-a`, me).verdict).toBe("dirty");
		});

		it("waives nothing on a hand-authored region, flag or no flag", () => {
			const me = live(sb, "alice");
			store.acquire(`${rel}#B196`, me);
			write(doc("B196, half-rewritten.", "B197 as committed."));
			expect(
				store.release(`${rel}#B196`, me, { generator: true }).verdict,
			).toBe("dirty");
		});

		it("waives nothing on the bare map, which is not a region at all", () => {
			const me = live(sb, "alice");
			store.acquire(rel, me);
			dirtyA();
			expect(store.release(rel, me, { generator: true }).verdict).toBe("dirty");
		});
	});
});

describe("a claim read in its holder's tree, not the reader's (#4457)", () => {
	const rel = "docs/x.md";
	let wt = "";
	const writeIn = (tree: string, text: string) =>
		fs.writeFileSync(path.join(tree, rel), text);
	const inDir = <T>(dir: string, fn: () => T): T => {
		const back = process.cwd();
		process.chdir(dir);
		try {
			return fn();
		} finally {
			process.chdir(back);
		}
	};

	const withWorktree = defineTemplate((dir) => {
		emptyRepoTemplate(dir);
		fs.appendFileSync(
			path.join(dir, ".git", "config"),
			"[user]\n\temail = t@t\n\tname = t\n",
		);
		fs.mkdirSync(path.join(dir, "docs"));
		writeIn(dir, "as committed\n");
		execFileSync("git", ["add", "-A"], { cwd: dir });
		execFileSync(
			"git",
			["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"],
			{ cwd: dir },
		);
		cutWorktree(dir);
	});

	beforeEach(() => {
		withWorktree.instantiate(sb.repo);
		wt = fs.realpathSync(path.join(sb.repo, ".claude", "worktrees", "s1"));
	});

	const holdDirtyInWorktree = () => {
		const me = live(sb, "alice");
		inDir(wt, () => store.acquire(rel, me));
		writeIn(wt, "half-written in the worktree\n");
		return me;
	};

	it("records the worktree on the lock, and no tree on a main-checkout claim", () => {
		holdDirtyInWorktree();
		store.acquire("docs/y.md", live(sb, "bob"));
		const byHolder = Object.fromEntries(
			(store.listLocks() as { sessionId: string; tree?: string }[]).map((l) => [
				l.sessionId,
				l.tree,
			]),
		);
		expect(byHolder).toEqual({ alice: wt, bob: undefined });
	});

	it("refuses a release run from the main checkout of a claim dirty in the worktree", () => {
		const me = holdDirtyInWorktree();
		inDir(sb.repo, () => {
			expect(store.subjectDirty(rel)).toBe(false);
			expect(store.release(rel, me).verdict).toBe("dirty");
		});
	});

	it("leaves a worktree-dirty claim out of the clean ones, read from the main checkout", () => {
		const me = holdDirtyInWorktree();
		inDir(sb.repo, () => expect(store.readHeldClean(me.sessionId)).toEqual([]));
		writeIn(wt, "as committed\n");
		inDir(sb.repo, () =>
			expect(store.readHeldClean(me.sessionId)).toEqual([rel]),
		);
	});

	it("releases a worktree claim from the main checkout once the worktree is clean, though the main checkout is dirty", () => {
		const me = holdDirtyInWorktree();
		writeIn(wt, "as committed\n");
		writeIn(sb.repo, "a main-checkout edit\n");
		inDir(sb.repo, () =>
			expect(store.release(rel, me).verdict).toBe("released"),
		);
	});
});
