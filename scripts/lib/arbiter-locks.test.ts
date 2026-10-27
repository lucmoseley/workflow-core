// @vitest-environment node
/*
 * arbiter-locks.js's own suite — taking a claim, the two exits from one, and
 * the debris a process killed mid-break leaves behind. Everything that must go
 * through a spawned CLI stays in scripts/session-arbiter.test.ts. Split out at
 * mantahostels#1795; the live-holder and unparseable-lock rulings are
 * mantahostels#348 and mantahostels#1691.
 *
 * Each case runs in arbiter-testkit's sandbox, with locks written straight to
 * disk and holders made live or certainly dead by hand, so a stale, corrupt or
 * half-broken lock is built exactly rather than raced for.
 *
 * The claim registry is what `lib/file-claim.js`, a `PreToolUse` core on
 * every Write and Edit, refuses on: loosen a case here and two sessions hold
 * one file and clobber each other, or a live session's claim is broken.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	AS_ROOT,
	breaks as breaksMod,
	commitAll,
	core,
	DEAD,
	durably,
	freshSandbox,
	live,
	liveHolder,
	locks as locksMod,
	noSessions,
	proc,
	registerSession,
	store,
} from "./arbiter-testkit";
import { sleepSync } from "./sleep-sync.js";

const sb = freshSandbox();

/** Put a lock on disk at `rel`, bypassing acquire. */
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
		// The whole reason mantahostels#104 was a hard prerequisite: mantahostels#103 chose deny, and under
		// deny an earlyoom kill would otherwise lock a file permanently.
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
		// Entries are named by pid, so a resumed session leaves two carrying the same
		// session id (mantahostels#322). Taking the first match handed back a dead pid, and a
		// lock minted on a dead pid is stale the moment it is written: the next
		// session breaks it and edits the file under its live holder, with nothing
		// logged.
		registerSession(sb, "resumed", 4_194_303, { procStart: "1" }); // the abandoned entry
		registerSession(sb, "resumed", process.pid); // the live one

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
		// No sessions entry and no jobs entry: there is no process whose death
		// could release its claim, so recording one would wedge the file forever.
		const nobody = store.identify("ghost");
		expect(nobody.durable).toBe(false);

		expect(store.acquire("docs/doc-map.md", nobody).verdict).toBe("claimed");
		expect(fs.existsSync(store.paths.lock("docs/doc-map.md"))).toBe(false);

		store.acquire("docs/doc-map.md", live(sb, "alice"));
		expect(store.acquire("docs/doc-map.md", nobody).verdict).toBe("held");
	});

	it("a jobs state file alone does NOT make a claim, or the file wedges for good", () => {
		// A lock carrying only a state file can be proved dead by nothing: job dirs
		// outlive their sessions, so `holderAlive` would answer alive for ever and
		// no later session could take that path (mantahostels#104).
		const jd = path.join(sb.home, "jobs", "j1");
		fs.mkdirSync(jd, { recursive: true });
		fs.writeFileSync(path.join(jd, "state.json"), "{}");

		const me = store.identify("j1");
		expect(me.durable).toBe(false);
		store.acquire("docs/doc-map.md", me);
		expect(fs.existsSync(store.paths.lock("docs/doc-map.md"))).toBe(false);
	});

	it("is re-entrant for an unidentifiable session's own live lock, not denied", () => {
		// A session can lose its registry entry mid-run. It takes no new claims, but
		// denying it the file its own live lock holds blocks its remaining work for
		// nothing.
		put("docs/doc-map.md", { sessionId: "casper", ...liveHolder() });
		const r = store.acquire("docs/doc-map.md", {
			sessionId: "casper",
			pid: null,
			procStart: null,
			durable: false,
		});
		expect(r.verdict).toBe("reentrant");
	});

	// A session that can take no claim of its own is still DENIED one (mantahostels#359): what
	// is unknown here is the HOLDER's liveness, not this session's.
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
			// A registry that will not open is no evidence of life, so the write goes
			// ahead. It can land under a live editor, so it goes in the log (mantahostels#174).
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
	// A session outlives its process: a resumed session keeps its session id under
	// a new pid (mantahostels#322).
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
	// A lock freezes pid and procStart at claim time, but a resumed session keeps
	// its id under a fresh host process. So the recorded pid is genuinely gone while
	// the holder is genuinely alive, and breaking the lock writes the file under a
	// live editor — mantahostels#63, the incident where one session's work landed under
	// another's, reached by a second route.
	const staleLockFor = (sessionId: string | null) =>
		put("docs/doc-map.md", { sessionId, ...DEAD });

	it("refuses a neighbour rather than breaking it, recording the neighbour as holder", () => {
		registerSession(sb, "resumed", DEAD.pid, { procStart: DEAD.procStart }); // abandoned host
		registerSession(sb, "resumed", process.pid); // the one it resumed onto
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
		// The content pin is keyed by claimId (mantahostels#295), so a re-key minting a new one
		// would strand the blob recording what the file held.
		expect(after.claimId).toBe(before.claimId);
	});

	it("breaks it when the id has no registry entry at all", () => {
		// A pruned registry, or a headless run that registered nothing, is no
		// evidence of life.
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
		// entry.procStart only, never a fresh /proc read as a fallback: falling back
		// compares that read against itself, so a recycled pid reads live and the
		// lock outlives the session that asked for it.
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
		// An unbreakable lock is the failure mantahostels#104 ruled worse than an over-eager
		// break. But this break can take a file from a live session, so it goes in
		// the log (mantahostels#174).
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
		// An unscoped lock is one a reboot can hand to a stranger holding the same
		// pid. The branch that keeps
		// the OLD id — this machine refusing to name the current boot — cannot be
		// reached in-process and is unverified: /proc/sys/kernel/random/boot_id is
		// readable here and its answer is cached for the run.
		registerSession(sb, "resumed", process.pid);
		const p = staleLockFor("resumed");

		store.acquire("docs/doc-map.md", durably("bob"));

		expect(JSON.parse(fs.readFileSync(p, "utf8")).bootId).toBe(
			proc.readCurrentBootId(),
		);
	});

	it("hands back the lock actually on disk when the rewrite loses a race", () => {
		// The refusal is right either way; what must not happen is a denial naming
		// the dead pid this session read, when a different holder now has the file.
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
	// Driven through acquire() itself with its retry budget set to zero, so the
	// production call site is what runs.
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

/*
 * mantahostels#1701. Both break sites `continue`, so a break landing on the last retry left
 * the path standing open with no round left to take it — and the write was then
 * reported as claimed with no lock behind it. The budget below is 1, so the
 * single round is spent on the break and the fall-through is what must claim.
 *
 * Mutated: disabling the fall-through create fails the two break cases and
 * nothing else; the live-holder case passes without it.
 */
describe("a lock broken on the final retry", () => {
	/** A registered session, with `fields`' lock already on `rel` to contend with. */
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

/*
 * mantahostels#1692.
 *
 * The torn/corrupt discriminator is driven through readLocks' `pause` seam
 * (mantahostels#1711): a callback standing in for the 50 ms wait finishes the record, so
 * the second probe reads what a real writer left and no clock is raced.
 * Mutated: judging on the first probe, and dropping the pause, each fail the
 * settling case and the once-only case; binding the default to a no-op fails
 * the last case alone. Dropping the age gate fails the hour-old case; inverting
 * it fails the settling case.
 */
describe("readLocks — a record that will not parse", () => {
	/** As much of a ListedLock as any one case asserts on. */
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
		planted("deadbeefcafe0002.json", ""); // the zero-byte shape of mantahostels#1692
		const locks = store.readLocks();
		expect(locks).toHaveLength(2);
		expect(locks.find((l: Listed) => l.sessionId === "alice")).toBeTruthy();
		const bad = locks.find((l: Listed) => l.unreadable);
		expect(bad.file).toBe("deadbeefcafe0002.json");
		expect(bad.reason).toBe("unparseable");
	});

	it("settles: a record finished during the pause is a lock, not a fault", () => {
		put("docs/doc-map.md", { sessionId: "alice", ...liveHolder() });
		planted("deadbeefcafe0003.json", '{"path":"docs/PRD.md","sessi'); // mid-write
		const locks = store.readLocks(() =>
			planted(
				"deadbeefcafe0003.json",
				JSON.stringify(
					locksMod.newLock({ path: "docs/PRD.md", sessionId: "bob" }),
				),
			),
		);
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
		expect(locks.filter((l: Listed) => l.unreadable)).toHaveLength(2);
	});

	// #852.
	const ageOut = (name: string) => {
		const past = (Date.now() - locksMod.DEBRIS_AGE_MS - 60_000) / 1000;
		fs.utimesSync(path.join(store.paths.locksDir(), name), past, past);
	};

	it("does not pause for a record over an hour old: it is corrupt on sight", () => {
		planted("deadbeefcafe0008.json", "");
		ageOut("deadbeefcafe0008.json");
		const locks = store.readLocks(() => {
			throw new Error("paused for a record that cannot still be mid-write");
		});
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
		expect(locks.filter((l: Listed) => l.unreadable)).toHaveLength(2);
	});

	it("pauses for an aged record whose age cannot be read", () => {
		planted("deadbeefcafe000b.json", "");
		ageOut("deadbeefcafe000b.json");
		// Spied, not chmod-ed: a mode that refuses the stat refuses probeRecord's
		// read too, and the record would list as "refused" before age is asked.
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

	// #841. Counts an internal call, the breach base §X6 allows with a reason:
	// resolving per record cost ~90 ms on every Bash call, and no return value
	// shows the count.
	it("resolves the lock directory once, however many records it judges", () => {
		put("docs/doc-map.md", { sessionId: "alice", ...liveHolder() });
		put("docs/PRD.md", { sessionId: "bob", ...liveHolder() });
		planted("deadbeefcafe0007.json", ""); // torn, so the second pass runs too
		const spy = vi.spyOn(core.paths, "locksDir");
		try {
			expect(
				store.readLocks(() => {
					/* no settle wait, so the torn record stays torn */
				}),
			).toHaveLength(3);
			expect(spy).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
	});

	// A lower bound is not a race — Atomics.wait cannot return early, so only
	// skipping the wait fails this.
	it("really waits by default, so production settles as well as the seam", () => {
		planted("deadbeefcafe0006.json", "");
		const started = Date.now();
		store.readLocks();
		// §X9: the default settle is a real Atomics.wait, and this floor is its one proof.
		expect(Date.now() - started).toBeGreaterThanOrEqual(
			locksMod.TORN_SETTLE_MS - 10,
		);
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
		// earlyoom kills mid-syscall at the WSL memory cap, so a claim can die between
		// writing its temp file and linking it, or between renaming a stale lock
		// aside and unlinking it. Neither file is ever read again; without a sweep
		// they accumulate for the life of the machine.
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
		const lock = plant("deadbeefcafe0001.json", 3 * 60 * 60 * 1000);
		const aside = locksMod.renameAside(lock);
		expect(aside).not.toBeNull();
		locksMod.sweepDebris();
		expect(fs.existsSync(aside as string)).toBe(true);
	});

	it("is actually run by acquire(), not merely available to it", () => {
		const old = plant(".tmp-999-abandoned", 2 * 60 * 60 * 1000);
		registerSession(sb, "alice", process.pid);
		store.acquire("docs/doc-map.md", store.identify("alice"));
		expect(fs.existsSync(old)).toBe(false);
	});

	it("clears an old once-per-session marker, so a still-broken guard is re-said", () => {
		// .said- markers bound sayOnce; left forever, a fault would be said once per
		// machine lifetime instead of once per session.
		const said = plant(".said-abcdef0123456789", 2 * 60 * 60 * 1000);
		locksMod.sweepDebris();
		expect(fs.existsSync(said)).toBe(false);
	});

	it("restores a live lock found stranded aside, instead of sweeping it", () => {
		// A breaker killed between its rename and its re-judge (the hook's own
		// `timeout 5`, earlyoom) strands what it moved. If that was a live
		// replacement, the path reads free while its holder works on unprotected —
		// so the next claim's sweep puts it back before anything judges the path.
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
		// The aside records the pid the holder had when it claimed, which a resume
		// leaves behind. Judged by that pid alone it is debris, and the age sweep
		// deletes the live claim of a session still editing the file.
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
		fs.utimesSync(aside, old, old); // old enough for the age sweep to take it
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
			// Housekeeping is otherwise silent, but this sweep can delete a live
			// session's claim (mantahostels#174).
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
		expect(fs.existsSync(aside)).toBe(true); // fresh, so the age test leaves it too
	});

	it("refuses to restore a lock over a path someone else has since taken, leaving the newer lock in place", () => {
		// The break path moves a lock aside and puts it back if it turns out live.
		// rename(2) would REPLACE whatever now sits at the path — deleting the live
		// claim of a third session that took the file in between, and leaving two
		// sessions holding it. The restore must fail instead of clobbering.
		const lockPath = put("docs/doc-map.md", { sessionId: "first" });
		const aside = locksMod.renameAside(lockPath);
		put("docs/doc-map.md", { sessionId: "third" });

		expect(locksMod.restoreAside(aside, lockPath)).toBe(false);
		expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).sessionId).toBe(
			"third",
		);
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
	// acquire() decides a lock is stale, then renames it aside, then re-judges what
	// it actually moved. The interesting branches need the lock to CHANGE between
	// those two steps, which no in-process test can arrange from outside acquire().
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
		// put() mints its own claimId, so re-point the judged lock at what landed.
		existing.claimId = JSON.parse(fs.readFileSync(p, "utf8")).claimId;

		expect(locksMod.breakStale("docs/doc-map.md", existing)).toBe("freed");
		expect(fs.existsSync(p)).toBe(false);
		// The aside must be unlinked, not merely abandoned for the hourly sweep.
		expect(readAsides()).toEqual([]);
	});

	it("puts back a lock that turned live between the read and the rename", () => {
		// The caller judged `existing` stale. By the time the rename lands, the
		// holder's replacement is a DIFFERENT, live claim. Taking the file here is
		// the two-holder bug the whole re-judge exists to prevent.
		const existing = locksMod.newLock({ path: "docs/doc-map.md", ...DEAD });
		const p = put("docs/doc-map.md", { ...liveHolder(), claimId: "fresh" });

		expect(locksMod.breakStale("docs/doc-map.md", existing)).toBe("retry");
		expect(fs.existsSync(p)).toBe(true);
		expect(JSON.parse(fs.readFileSync(p, "utf8")).claimId).toBe("fresh");
		expect(readAsides()).toEqual([]);
	});

	it("puts back a lock it cannot read rather than treating it as free", () => {
		// A torn or truncated lock says NOTHING about whether its holder is alive.
		// Unlinking it because it would not parse is how a live claim gets dropped.
		const existing = locksMod.newLock({ path: "docs/doc-map.md", ...DEAD });
		const p = put("docs/doc-map.md", {});
		fs.writeFileSync(p, "{not json");

		expect(locksMod.breakStale("docs/doc-map.md", existing)).toBe("retry");
		expect(fs.existsSync(p)).toBe(true);
		expect(fs.readFileSync(p, "utf8")).toBe("{not json");
	});

	it("frees a lock whose holder is dead even when the claimId has changed", () => {
		// Re-judging must turn on LIVENESS, not on identity: a dead holder replaced
		// by another dead holder is still a file nobody is working on, and refusing
		// to break it would wedge the path until the hourly sweep.
		const existing = locksMod.newLock({ path: "docs/doc-map.md", ...DEAD });
		const p = put("docs/doc-map.md", { ...DEAD, claimId: "different" });

		expect(locksMod.breakStale("docs/doc-map.md", existing)).toBe("freed");
		expect(fs.existsSync(p)).toBe(false);
	});
});

describe("a lock record that will never parse (mantahostels#1691)", () => {
	// readRecord answers null for a torn write and for a corrupt one alike, and
	// the claim path retried both. Three attempts later it gave up and let the
	// write proceed with NO lock at all, so a permanently corrupt record made its
	// path unclaimable for good.
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
	/** Comfortably inside the settle pause, and comfortably past acquire's first probe. */
	const childDelayMs = 20;
	/** The child is a bare `node -e`, so it reaches the shared pause by absolute path. */
	const sleepSyncPath = path.join(__dirname, "sleep-sync.js");

	describe("probeRecord — the two nulls readRecord collapses", () => {
		it("tells absent, unparseable and ok apart", () => {
			const f = path.join(sb.dir, "probe.json");
			expect(core.probeRecord(f)).toEqual({ state: "absent", record: null });
			fs.writeFileSync(f, "");
			expect(core.probeRecord(f).state).toBe("unparseable");
			fs.writeFileSync(f, "{not json");
			expect(core.probeRecord(f).state).toBe("unparseable");
			// Valid JSON that is not an object is as unusable as a truncated file:
			// `lock.pid` on 5 is undefined, so it reads as a holder nobody can
			// prove dead.
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
		// Unparseable means nothing is known about whose claim it was.
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
		// The discriminator, and the case the fix must not collapse. A second
		// process writes a LIVE lock over the corrupt bytes while acquire() is
		// inside its settle pause — which is what a genuine mid-write looks like —
		// and the re-read must find it and back off rather than break it.
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
					// The delay is what makes this test say something. Writing on `go`
					// races acquire()'s FIRST probe, and a child that wins it is never
					// unparseable at all — every assertion below then passes with the
					// discriminator deleted.
					`w(${childDelayMs});` +
					`fs.writeFileSync(${JSON.stringify(p)},${JSON.stringify(good)});`,
			],
			{ stdio: "ignore" },
		);
		try {
			// Pay node's start-up cost BEFORE the timed window, so the write lands
			// milliseconds into the pause rather than racing the interpreter.
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
			// And the settle branch is what answered.
			// §X9: two processes at once: the write lands from a real child mid-pause, so only the clock shows the settle branch answered.
			expect(elapsed).toBeGreaterThanOrEqual(locksMod.TORN_SETTLE_MS);
		} finally {
			child.kill();
		}
	});

	it("puts back a record that turned readable between the judgement and the rename", () => {
		// breakCorrupt reached directly: acquire() cannot arrange a change between
		// its own rename and its re-read. A neighbour that broke the same corrupt
		// lock first and took the path must not lose its claim to us.
		const p = put(rel, { ...liveHolder(), claimId: "fresh" });

		expect(locksMod.breakCorrupt(rel, durably("a"))).toBe("retry");
		expect(core.readRecord(p)?.claimId).toBe("fresh");
		expect(readBreaks()).toEqual([]);
	});

	it.skipIf(AS_ROOT)(
		"puts back a record it could not READ rather than calling it corrupt (mantahostels#174)",
		() => {
			// Dropping a lock the filesystem refused is how a live claim gets
			// destroyed on no evidence at all. The refusal is on the FILE, not the
			// directory: rename needs only the directory, so the aside is made and
			// then cannot be read.
			const p = corrupt("{not json");
			fs.chmodSync(p, 0o000);
			try {
				expect(locksMod.breakCorrupt(rel, durably("a"))).toBe("retry");
				expect(fs.existsSync(store.paths.lock(rel))).toBe(true);
			} finally {
				fs.chmodSync(store.paths.lock(rel), 0o600);
			}
			expect(fs.readFileSync(store.paths.lock(rel), "utf8")).toBe("{not json");
			expect(readBreaks()).toEqual([]);
		},
	);
});

describe("release — the second exit from a claim", () => {
	// mantahostels#121: process death was the only exit, so a session that had finished with a
	// file could not say so and blocked everyone else for hours.
	beforeEach(() => {
		execFileSync("git", ["init", "-q"], { cwd: sb.repo });
	});

	const held = (rel: string) =>
		store.listLocks().some((l: { path: string }) => l.path === rel);

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
		expect(r.lock.sessionId).toBe("alice");
		expect(held("docs/doc-map.md")).toBe(true);
	});

	it("refuses while the file is dirty, so the next claimant cannot commit the edit", () => {
		// mantahostels#63, by a new route: one session's pathspec commit taking another session's
		// working-tree edit in under its own message.
		const me = live(sb, "alice");
		store.acquire("docs/doc-map.md", me);
		fs.writeFileSync(path.join(sb.repo, "docs/doc-map.md"), "half an edit\n");
		expect(store.release("docs/doc-map.md", me).verdict).toBe("dirty");
		expect(held("docs/doc-map.md")).toBe(true);
	});

	it("refuses when git cannot answer, rather than releasing on an unproven clean", () => {
		// A failed release costs today's behaviour; a wrong one hands the file over
		// mid-edit (mantahostels#99).
		const me = live(sb, "alice");
		store.acquire("docs/doc-map.md", me);
		fs.rmSync(path.join(sb.repo, ".git"), { recursive: true, force: true });
		expect(store.gitDirty("docs/doc-map.md")).toBeNull();
		expect(store.release("docs/doc-map.md", me).verdict).toBe("uncheckable");
		expect(held("docs/doc-map.md")).toBe(true);
	});

	it("hands back the content answer on an uncheckable refusal (mantahostels#420)", () => {
		// With .git/HEAD gone, `status` exits 128 while `hash-object` still answers,
		// so an ordinary modification is fully knowable on this branch.
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
		// dropIfUnchanged is the shared drop, and release passes it the strictest
		// possible test: this exact claim, or nothing. Driven directly because
		// getting there through release() needs the lock to change mid-call.
		store.acquire("docs/doc-map.md", live(sb, "alice"));
		const r = store.dropIfUnchanged(
			"docs/doc-map.md",
			(m: { claimId: string }) => m.claimId === "not-this-one",
		);
		expect(r.outcome).toBe("kept");
		expect(r.restored).toBe(true);
		expect(held("docs/doc-map.md")).toBe(true);
	});

	// Release's own wiring of that branch is UNVERIFIED: reaching it needs a second
	// session to replace the lock between release's read and its drop, inside one
	// call, which no in-process test can arrange.
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
		const held: Array<{ path: string; alive: boolean }> = store.listLocks();
		expect(held.find((l) => l.path === "docs/a-live.md")?.alive).toBe(true);
		expect(held.find((l) => l.path === "docs/b-dead.md")?.alive).toBe(false);
	});

	const aliveOf = (rel: string) =>
		store.listLocks().find((l: { path: string }) => l.path === rel)?.alive;

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
			// STALE is read as free, and nothing refuses the Bash-route write that
			// follows (mantahostels#174).
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
		// It runs after every Bash call in every session, and a registry walk there
		// is the cost mantahostels#322 ruled out of a hot path.
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
		expect(store.readHeldBy("alice").sort()).toEqual([
			"docs/a.md",
			"scripts/b.js",
		]);
	});

	it("returns null, not an empty hold, when the store cannot be read", () => {
		// A caller iterating this must not read a dark store as "holds nothing"
		// (mantahostels#174).
		fs.mkdirSync(store.stateDir(), { recursive: true });
		fs.writeFileSync(store.paths.locksDir(), "not a directory");
		expect(store.readHeldBy("alice")).toBeNull();
	});
});

describe("whoHolds — the one holder-and-cover query (#1492)", () => {
	const map = "docs/doc-map.md";
	const registry = () => core.resumedHolderTest("test", "registry dark");
	/** A registry that would not open: nobody reads as resumed. */
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

describe("forceRelease — the supported escape for a stranded claim (mantahostels#411)", () => {
	// mantahostels#319 ruled the escape for mantahostels#254: a force gated on
	// `claude agents --json` saying the holder is not live.
	const rel = "docs/doc-map.md";
	const abs = () => path.join(sb.repo, rel);

	const commit = () => commitAll(sb);

	beforeEach(() => {
		execFileSync("git", ["init", "-q"], { cwd: sb.repo });
		fs.writeFileSync(abs(), "alice's work\n");
		commit();
	});

	/** Alice holds rel with her content pinned; bob is the session forcing it. */
	const stranded = () => {
		const alice = live(sb, "alice");
		store.acquire(rel, alice);
		const blob = store.recordContent(rel, alice);
		return { blob, bob: live(sb, "bob") };
	};

	/** An oracle listing exactly these sessions, counting its calls. */
	const lists = (...ids: string[]) => {
		const fn = () => {
			fn.calls++;
			return { ids: new Set(ids) };
		};
		fn.calls = 0;
		return fn;
	};
	const blind = (why: string) => () => ({ why });
	/** An oracle listing `ids`, of which `ended` have reached a terminal state. */
	const listsEnded = (ids: string[], ended: string[]) => () => ({
		ids: new Set(ids),
		terminal: new Set(ended),
	});

	const held = () =>
		store.listLocks().some((l: { path: string }) => l.path === rel);
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

	it("drops the claim when the oracle does not list its holder, though every process reader calls it live (#262)", () => {
		const { bob } = stranded();
		// alice's lock froze this process's own pid, so `holderAlive` and every
		// reader built on it call her live — the stranded shape (mantahostels#254), a pooled
		// host outliving the job it was taken for. THIS ASSERTION IS WHY THE CASE
		// GOES RED IF forceRelease IS EVER PUT ON `liveOrResumed` OR THE SESSIONS
		// REGISTRY (#262).
		expect(
			store.listLocks().find((l: { path: string }) => l.path === rel)?.alive,
		).toBe(true);
		expect(store.forceRelease(rel, bob, lists("bob")).verdict).toBe("forced");
		expect(held()).toBe(false);
		expect(store.acquire(rel, bob).verdict).toBe("claimed");
	});

	it("refuses, naming the holder, while the oracle still lists it live", () => {
		// A listed session may be mid-edit.
		const { bob } = stranded();
		const r = store.forceRelease(rel, bob, lists("alice", "bob"));
		expect(r.verdict).toBe("holder-live");
		expect(r.lock.sessionId).toBe("alice");
		expect(held()).toBe(true);
	});

	it("forces a holder the oracle still lists but calls ended — the case --force exists for (#268)", () => {
		const { bob } = stranded();
		expect(
			store.forceRelease(rel, bob, listsEnded(["alice", "bob"], ["alice"]))
				.verdict,
		).toBe("forced");
		expect(held()).toBe(false);
	});

	it("still refuses a listed holder the oracle has not called ended (#268)", () => {
		const { bob } = stranded();
		const r = store.forceRelease(rel, bob, listsEnded(["alice", "bob"], []));
		expect(r.verdict).toBe("holder-live");
		expect(held()).toBe(true);
	});

	it("refuses when the oracle cannot be read, rather than releasing on doubt, recording the error the oracle gave", () => {
		const { bob } = stranded();
		const r = store.forceRelease(rel, bob, blind("the daemon would not run"));
		expect(r.verdict).toBe("oracle-unreadable");
		expect(r.why).toContain("would not run");
		expect(held()).toBe(true);
	});

	it("refuses a lock naming no session, which no oracle can be asked about", () => {
		store.acquire(rel, {
			sessionId: "",
			pid: 1,
			procStart: "1",
			durable: true,
		});
		const r = store.forceRelease(rel, live(sb, "bob"), lists("bob"));
		expect(r.verdict).toBe("holder-unnamed");
		expect(held()).toBe(true);
	});

	it("writes a break record carrying both sessions and the pinned blob", () => {
		const { blob, bob } = stranded();
		const r = store.forceRelease(rel, bob, lists("bob"));
		expect(r.record).toMatchObject({
			path: rel,
			lostBy: "alice",
			brokenBy: "bob",
			blob,
		});
		expect(breaksMod.readBrokenClaimIds()).toEqual(
			new Set([r.record.lostClaimId]),
		);
		expect(breaksMod.buildBreakNotice(rel, "alice")).toContain("by bob");
	});

	it("keeps the pin, so the version it took is still recoverable", () => {
		// mantahostels#349's terms: the break holds the pin open for a week. An ordinary release
		// drops it, because there the holder is the one letting go.
		const { blob, bob } = stranded();
		const r = store.forceRelease(rel, bob, lists("bob"));
		expect(readRefs()).toEqual([`refs/arbiter/${r.record.lostClaimId}`]);
		store.pruneAll(noSessions);
		expect(readRefs()).toHaveLength(1);
		expect(
			execFileSync("git", ["cat-file", "-p", blob], {
				cwd: sb.repo,
				encoding: "utf8",
			}),
		).toBe("alice's work\n");
	});

	it("tells the holder, once, at its next write to the path", () => {
		const { bob } = stranded();
		store.forceRelease(rel, bob, lists("bob"));
		expect(store.buildBreakNotice(rel, "alice")).toContain("git cat-file -p");
		expect(store.buildBreakNotice(rel, "alice")).toBeNull();
	});

	it("refuses a dirty file, exactly as release does", () => {
		const { bob } = stranded();
		fs.writeFileSync(abs(), "half an edit\n");
		expect(store.forceRelease(rel, bob, lists("bob")).verdict).toBe("dirty");
		expect(held()).toBe(true);
	});

	it("hands back the holder's content state on a dirty refusal, as release does (mantahostels#337)", () => {
		// The refusal that follows says commit or discard, and both are destructive
		// once a third route has replaced the bytes — worse here, where the reader is
		// not the claimant whose work is at stake.
		const { blob, bob } = stranded();
		fs.writeFileSync(abs(), "restored from a backup\n");
		const r = store.forceRelease(rel, bob, lists("bob"));
		expect(r.verdict).toBe("dirty");
		expect(r.content).toEqual({ state: "changed", was: blob, by: "alice" });
	});

	it("puts back a lock that changed while the oracle was being asked", () => {
		// The oracle call (mantahostels#317) is the widest window in the arbiter.
		const { bob } = stranded();
		const swapped = () => {
			store.dropIfUnchanged(rel, () => true);
			store.acquire(rel, live(sb, "carol"));
			return { ids: new Set(["bob"]) };
		};
		const r = store.forceRelease(rel, bob, swapped);
		expect(r.verdict).toBe("contended");
		expect(
			store.listLocks().find((l: { path: string }) => l.path === rel).sessionId,
		).toBe("carol");
	});

	it("refuses when git cannot answer, exactly as release does", () => {
		const { bob } = stranded();
		fs.rmSync(path.join(sb.repo, ".git"), { recursive: true, force: true });
		expect(store.forceRelease(rel, bob, lists("bob")).verdict).toBe(
			"uncheckable",
		);
		expect(held()).toBe(true);
	});

	it("hands back the content answer on an uncheckable refusal (mantahostels#420)", () => {
		const { blob, bob } = stranded();
		fs.writeFileSync(abs(), "restored from a backup\n");
		fs.rmSync(path.join(sb.repo, ".git", "HEAD"));

		const r = store.forceRelease(rel, bob, lists("bob"));
		expect(r.verdict).toBe("uncheckable");
		expect(r.content).toEqual({ state: "changed", was: blob, by: "alice" });
		expect(held()).toBe(true);
	});

	it("hands back the content answer on a contended refusal (mantahostels#420)", () => {
		// Committed, so the dirty refusal does not fire first and the lock swap under
		// the oracle is what decides the verdict.
		const { blob, bob } = stranded();
		fs.writeFileSync(abs(), "restored from a backup\n");
		commit();
		const swapped = () => {
			store.dropIfUnchanged(rel, () => true);
			store.acquire(rel, live(sb, "carol"));
			return { ids: new Set(["bob"]) };
		};

		const r = store.forceRelease(rel, bob, swapped);
		expect(r.verdict).toBe("contended");
		expect(r.content).toEqual({ state: "changed", was: blob, by: "alice" });
	});

	it("treats a path nobody claims as no fault, and asks no oracle", () => {
		const oracle = lists("bob");
		expect(store.forceRelease(rel, live(sb, "bob"), oracle).verdict).toBe(
			"not-held",
		);
		expect(oracle.calls).toBe(0);
	});

	it("delegates the caller's OWN claim to release, asking no oracle", () => {
		// Identity has already answered it, and the ~465 ms call would be paid on
		// the commonest path for nothing.
		const alice = live(sb, "alice");
		store.acquire(rel, alice);
		const oracle = lists("alice");
		expect(store.forceRelease(rel, alice, oracle).verdict).toBe("released");
		expect(oracle.calls).toBe(0);
		expect(held()).toBe(false);
	});

	it("refuses rather than reporting no claim when the store cannot be read (mantahostels#174)", () => {
		const { bob } = stranded();
		fs.rmSync(store.paths.locksDir(), { recursive: true, force: true });
		fs.writeFileSync(store.paths.locksDir(), "not a directory");
		expect(store.forceRelease(rel, bob, lists("bob")).verdict).toBe(
			"unreadable",
		);
	});
});

describe("a region claim's cleanliness is its own region's, not the file's (mantahostels#1434)", () => {
	// The block this fixes: a file-level dirtiness test pinned every region of a
	// document that is dirty somewhere almost always, so a session that had
	// committed its own region cleanly could never release it (mantahostels#1404).
	const rel = "docs/doc-map.md";
	const abs = () => path.join(sb.repo, rel);

	/** A document with a §A row, §B's preamble and two entries — four regions. */
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

	beforeEach(() => {
		execFileSync("git", ["init", "-q"], { cwd: sb.repo });
		write(doc("B196 as committed.", "B197 as committed."));
		commitAll(sb);
	});

	it("reads a region as clean while another region of the file is dirty", () => {
		write(doc("B196 as committed.", "B197, edited by a neighbour."));
		expect(store.gitDirty(rel)).toBe(true);
		expect(store.subjectDirty(`${rel}#B196`)).toBe(false);
		expect(store.subjectDirty(`${rel}#B197`)).toBe(true);
	});

	it("releases the clean region the file-level test used to pin", () => {
		const me = live(sb, "alice");
		store.acquire(`${rel}#B196`, me);
		write(doc("B196 as committed.", "B197, edited by a neighbour."));
		expect(store.release(`${rel}#B196`, me).verdict).toBe("released");
	});

	it("still refuses a release while the claimed region itself is dirty", () => {
		// mantahostels#63's rule, unweakened: your own unfinished edit must not be handed to
		// the next holder to commit under their message.
		const me = live(sb, "alice");
		store.acquire(`${rel}#B196`, me);
		write(doc("B196, half-rewritten.", "B197 as committed."));
		expect(store.release(`${rel}#B196`, me).verdict).toBe("dirty");
	});

	it("ignores a neighbour's insert above, which shifts the region's lines", () => {
		// The trap the issue named: a naive line-range comparison against HEAD
		// reports a region dirty for an edit that never touched a byte of it.
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
		// gitRaw, not git: the trim git() applies would strip the file's final
		// newline from HEAD's copy alone, so the last region would never compare
		// equal and every release of it would refuse.
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
		// The index is repo-global here, so the next holder's commit would sweep
		// the staged version in under their own message — mantahostels#63's harm exactly,
		// invisible to a worktree-versus-HEAD comparison.
		write(doc("B196, staged but not committed.", "B197 as committed."));
		stage();
		write(doc("B196 as committed.", "B197 as committed."));
		expect(store.subjectDirty(`${rel}#B196`)).toBe(true);
		expect(store.subjectDirty(`${rel}#B197`)).toBe(false);
	});

	it("refuses a park under a neighbour whose session was RESUMED, naming that neighbour (#259)", () => {
		// park rewrites the whole file, so a holder holderAlive() mistakes for dead
		// is a live session whose uncommitted bytes park would throw away.
		registerSession(sb, "resumed", process.ppid);
		put(`${rel}#B197`, { sessionId: "resumed", ...DEAD });
		const alice = live(sb, "alice");
		store.acquire(`${rel}#B196`, alice);
		write(doc("B196 as committed.", "B197, written by the resumed neighbour."));
		const r = store.park(rel, alice);
		expect(r.verdict).toBe("shared");
		expect(r.others).toContain("resumed");
	});

	it("still parks where the claim's holder really did end (#259)", () => {
		// Crediting a resumed holder must not turn every dead claim into a blocker.
		registerSession(sb, "ended", DEAD.pid, { procStart: DEAD.procStart });
		put(`${rel}#B197`, { sessionId: "ended", ...DEAD });
		const alice = live(sb, "alice");
		store.acquire(`${rel}#B196`, alice);
		write(doc("B196, edited by alice.", "B197 as committed."));
		expect(store.park(rel, alice).verdict).toBe("parked");
	});

	it("reads a region in NEITHER revision as clean, so its claim can be dropped", () => {
		// A §A row whose path was renamed and committed: the old key names nothing
		// on either side, so there are no bytes to hand the next holder and mantahostels#63's
		// harm cannot happen. Refusing here would wedge the claim permanently —
		// force, park and plain release all go through this one test.
		const me = live(sb, "alice");
		store.acquire(`${rel}#B999`, me);
		expect(store.subjectDirty(`${rel}#B999`)).toBe(false);
		expect(store.release(`${rel}#B999`, me).verdict).toBe("released");
	});

	it("falls back to the whole file where there is no HEAD to compare against", () => {
		// A fresh repo with no commit: git show has nothing to answer with, and a
		// fallback to the file-level test is the only safe reading.
		fs.rmSync(path.join(sb.repo, ".git"), { recursive: true, force: true });
		execFileSync("git", ["init", "-q"], { cwd: sb.repo });
		expect(store.subjectDirty(`${rel}#B196`)).toBe(true);
	});

	it("leaves a whole-file subject on the file-level test", () => {
		write(doc("B196 as committed.", "B197, edited by a neighbour."));
		expect(store.subjectDirty(rel)).toBe(true);
	});

	describe("the §A generator's release waives that refusal (mantahostels#2428)", () => {
		// Its own write is what makes §A dirty.
		/** Rewrite §A's table header, which dirties §A and no other region. */
		const dirtyA = () =>
			write(
				doc("B196 as committed.", "B197 as committed.").replace(
					"| Path | Role |",
					"| Path | Role | Owner |",
				),
			);
		const stillHeld = (subject: string) =>
			store.listLocks().some((l: { path: string }) => l.path === subject);

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

		it("rides --force too, on the holder's own claim", () => {
			const me = live(sb, "alice");
			store.acquire(`${rel}#section-a`, me);
			dirtyA();
			expect(
				store.forceRelease(`${rel}#section-a`, me, () => ({ ids: new Set() }), {
					generator: true,
				}).verdict,
			).toBe("released");
			expect(stillHeld(`${rel}#section-a`)).toBe(false);
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

describe("sweepRisk — what a pathspec commit would take from a neighbour (mantahostels#1539)", () => {
	/*
	 * The incident: `git commit -m "…" -- docs/doc-map.md …` followed
	 * CLAUDE.md's pathspec rule exactly and still landed another session's whole
	 * new §B entry under a message describing only its own. A pathspec takes the
	 * WORKING-TREE copy of every path it names, so the index rule cures nothing
	 * here.
	 *
	 * The test mantahostels#1558 chose: the neighbour's pinned blob differs from that
	 * subject's blob at HEAD, AND the pin is still what the tree holds.
	 */
	const docMap = "docs/doc-map.md";
	const plain = "docs/plain.md";
	const abs = (rel: string) => path.join(sb.repo, rel);

	/** A doc-map with §B196 and §B197, so a region subject has somewhere to live. */
	const doc = (b196: string, b197: string) =>
		[
			"# Doc map",
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

	const write = (rel: string, text: string) => {
		fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
		fs.writeFileSync(abs(rel), text);
	};

	/** `sessionId` claims `subject` and pins whatever the tree holds now.
	 * With no `name`, the session is registered without a title. */
	const pinnedClaim = (subject: string, sessionId: string, name?: string) => {
		const me = live(sb, sessionId, name);
		store.acquire(subject, me);
		return { me, blob: store.recordContent(subject, me) };
	};

	beforeEach(() => {
		execFileSync("git", ["init", "-q"], { cwd: sb.repo });
		write(docMap, doc("B196 as committed.", "B197 as committed."));
		write(plain, "committed\n");
		commitAll(sb);
	});

	it("flags a whole-file subject the neighbour has uncommitted, pinned work in, recording its holder", () => {
		write(plain, "alice's unsaved edit\n");
		pinnedClaim(plain, "alice");
		expect(store.sweepRisk([plain], "bob")).toEqual([
			{ subject: plain, rel: plain, region: null, holder: "alice" },
		]);
	});

	it("names the region, not merely the file, on a doc-map region claim", () => {
		write(docMap, doc("B196 as committed.", "B197, alice's unsaved edit."));
		pinnedClaim(`${docMap}#B197`, "alice");
		expect(store.sweepRisk([docMap], "bob")).toEqual([
			{
				subject: `${docMap}#B197`,
				rel: docMap,
				region: "B197",
				holder: "alice",
			},
		]);
	});

	it("flags a region that does not exist at HEAD, recording its id — the incident's own shape", () => {
		// A brand-new §B entry: nothing to compare against at HEAD, so the pin
		// differs from it, and the pin is what the tree holds.
		write(
			docMap,
			`${doc("B196 as committed.", "B197 as committed.")}
### B229 · alice's new entry

Its body.
`,
		);
		pinnedClaim(`${docMap}#B229`, "alice");
		expect(store.sweepRisk([docMap], "bob")).toMatchObject([
			{ region: "B229" },
		]);
	});

	it("says nothing where the neighbour pinned no bytes (mantahostels#1558)", () => {
		// A claim minted without a write through Write or Edit — the Bash-route
		// neighbour. No fall-back to "a live claim exists here": on
		// docs/doc-map.md that is the ordinary state.
		write(plain, "alice's unsaved edit\n");
		const me = live(sb, "alice");
		store.acquire(plain, me);
		expect(core.readRecord(store.paths.lock(plain)).blob).toBeFalsy();
		expect(store.sweepRisk([plain], "bob")).toEqual([]);
	});

	it("says nothing where the pin equals HEAD — the neighbour has committed", () => {
		write(plain, "alice's work\n");
		pinnedClaim(plain, "alice");
		commitAll(sb, "alice's own commit");
		expect(store.sweepRisk([plain], "bob")).toEqual([]);
	});

	it("says nothing on a stale pin — it differs from HEAD but is not in the tree", () => {
		write(plain, "alice's work\n");
		pinnedClaim(plain, "alice");
		write(plain, "and then something else\n"); // moved on, never re-pinned
		expect(store.sweepRisk([plain], "bob")).toEqual([]);
	});

	it("never reports the committing session's own claim", () => {
		write(plain, "bob's unsaved edit\n");
		pinnedClaim(plain, "bob");
		expect(store.sweepRisk([plain], "bob")).toEqual([]);
	});

	it("says nothing about a claim whose holder has stopped running", () => {
		write(plain, "alice's work\n");
		const me = { sessionId: "alice", ...DEAD, durable: true };
		store.acquire(plain, me);
		store.recordContent(plain, me);
		expect(store.sweepRisk([plain], "bob")).toEqual([]);
	});

	it("says nothing about a path the pathspec does not name", () => {
		write(plain, "alice's unsaved edit\n");
		pinnedClaim(plain, "alice");
		expect(store.sweepRisk(["docs/elsewhere.md"], "bob")).toEqual([]);
	});

	it("covers a claim beneath a DIRECTORY the pathspec names", () => {
		// `git commit -m "…" -- docs/` takes everything under it.
		write(plain, "alice's unsaved edit\n");
		pinnedClaim(plain, "alice");
		expect(store.sweepRisk(["docs"], "bob")).toMatchObject([{ rel: plain }]);
	});

	it("covers everything under the REPO ROOT, which arrives as an empty path", () => {
		// `git commit -m "…" -- .` is the broadest pathspec there is, and
		// relativeToRepo maps the root to "" rather than ".". Prefixing claims
		// with "/" would match none of them and silence the guard on the one
		// form that sweeps the most.
		write(plain, "alice's unsaved edit\n");
		pinnedClaim(plain, "alice");
		expect(store.sweepRisk([""], "bob")).toMatchObject([{ rel: plain }]);
	});

	it("names the holder by its session title, and falls back to the id", () => {
		write(plain, "alice's unsaved edit\n");
		pinnedClaim(plain, "alice", "Implement 1594: guard-commit-form");
		expect(store.sweepRisk([plain], "bob")[0].holder).toBe(
			"Implement 1594: guard-commit-form",
		);
		// The same registry entry without a title: the id is what is left to print.
		registerSession(sb, "alice", process.pid);
		expect(store.sweepRisk([plain], "bob")[0].holder).toBe("alice");
	});

	it("returns nothing for an empty pathspec rather than scanning every claim", () => {
		write(plain, "alice's unsaved edit\n");
		pinnedClaim(plain, "alice");
		expect(store.sweepRisk([], "bob")).toEqual([]);
	});
});
