// @vitest-environment node
/*
 * arbiter-breaks.js's own suite: a broken stale claim leaves a break record that
 * outlives the lock, keeps its pre-clobber pin, and tells the losing session
 * when it returns (mantahostels#322, mantahostels#349).
 *
 * Each case runs in arbiter-testkit's sandbox over a real `git init`, with
 * locks written straight to disk and the holder made certainly dead, because a
 * pin is a real ref over a real blob and a live holder is never broken.
 *
 * The arbiter runs behind `lib/file-claim.js`, a `PreToolUse` core on every
 * Write and Edit: loosen a case here and a session whose stale claim was broken
 * comes back to a clobbered file unwarned, its own version unrecoverable.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	breaks,
	core,
	DEAD,
	durably,
	freshSandbox,
	live,
	liveHolder,
	locks,
	noSessions,
	store,
} from "./arbiter-testkit";

const sb = freshSandbox();

/** Put a lock on disk at `rel`, bypassing acquire. */
const put = (rel: string, fields: object) => {
	fs.mkdirSync(store.paths.locksDir(), { recursive: true });
	const p = store.paths.lock(rel);
	fs.writeFileSync(p, JSON.stringify(locks.newLock({ path: rel, ...fields })));
	return p;
};

describe("a broken claim — the clobber the content record could not reach (mantahostels#349)", () => {
	// mantahostels#322, the ticket that found the hole: an ordinary stale break was silent; the
	// break deleted the lock, which is the
	// only thing naming the pre-clobber blob; and pruneBlobRefs then collected the
	// pin, because its claim no longer existed.
	const rel = "scripts/evidence-audit.py";
	const abs = () => path.join(sb.repo, rel);

	beforeEach(() => {
		execFileSync("git", ["init", "-q"], { cwd: sb.repo });
	});

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

	/**
	 * `sessionId`'s claim on rel, its content pinned, its holder then gone — the
	 * lock left recording a pid that is certainly dead.
	 */
	const staleClaim = (text: string, sessionId = "alice", pin = true) => {
		fs.mkdirSync(path.dirname(abs()), { recursive: true });
		fs.writeFileSync(abs(), text);
		const me = live(sb, sessionId);
		store.acquire(rel, me);
		const blob = pin ? store.recordContent(rel, me) : null;
		const lock = { ...core.readRecord(store.paths.lock(rel)), ...DEAD };
		fs.writeFileSync(store.paths.lock(rel), JSON.stringify(lock));
		return { blob, lock };
	};

	it("records what the break destroyed — both sessions, and the blob", () => {
		const { blob, lock } = staleClaim("alice's work\n");

		expect(locks.breakStale(rel, lock, durably("bob"))).toBe("freed");

		expect(breaks.readBrokenClaimIds()).toEqual(new Set([lock.claimId]));
		const notice = breaks.buildBreakNotice(rel, "alice");
		expect(notice).toContain(`claim on ${rel} was broken`);
		expect(notice).toContain("by bob");
		expect(notice).toContain(`git cat-file -p ${blob}`);
	});

	it("records nothing when the lock went back", () => {
		// A record here would send the live holder chasing a clobber that never
		// happened.
		const existing = locks.newLock({ path: rel, ...DEAD });
		put(rel, { ...liveHolder(), claimId: "fresh" });

		expect(locks.breakStale(rel, existing, durably("bob"))).toBe("retry");
		expect(breaks.readBrokenClaimIds()).toEqual(new Set());
	});

	it("records nothing when a session breaks its own stale lock", () => {
		// takeLock routes a session's own dead lock through the break path so it is
		// retaken on the live pid. Nobody is clobbered, and reporting it would tell
		// a session it had lost work to itself.
		const { lock } = staleClaim("alice's work\n");

		expect(locks.breakStale(rel, lock, durably("alice"))).toBe("freed");
		expect(breaks.buildBreakNotice(rel, "alice")).toBeNull();
		expect(breaks.readBrokenClaimIds()).toEqual(new Set());
	});

	it("keeps the pin, so the lost version survives a gc after the break", () => {
		// Detection is worth nothing if the bytes have gone, and the pin is the broken
		// claim's, so the sweep would otherwise collect it.
		const { blob, lock } = staleClaim("alice's work\n");
		locks.breakStale(rel, lock, durably("bob"));
		fs.writeFileSync(abs(), "bob's replacement\n"); // the clobber

		store.pruneAll(noSessions);
		execFileSync("git", ["gc", "--prune=now", "-q"], { cwd: sb.repo });

		expect(
			execFileSync("git", ["cat-file", "-p", blob], {
				cwd: sb.repo,
				encoding: "utf8",
			}),
		).toBe("alice's work\n");
	});

	it("bounds the retention: an aged-out record lets the sweep collect its pin", () => {
		// pruneBlobRefs exists because a pin per file ever claimed accumulates, and a
		// retained one must not escape that.
		const { lock } = staleClaim("alice's work\n");
		locks.breakStale(rel, lock, durably("bob"));
		const file = store.paths.break(rel, lock.claimId);
		fs.writeFileSync(
			file,
			JSON.stringify({
				...core.readRecord(file),
				at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
			}),
		);

		// Through pruneAll, so this pins the ORDER too: a break record holds its
		// pin open, and a sweep that collected the pins first would leave the blob
		// alive for another week (mantahostels#1796).
		store.pruneAll(noSessions);
		expect(fs.existsSync(file)).toBe(false);
		expect(readRefs()).toEqual([]);
	});

	it("ages a break from when it happened, not from when it was read", () => {
		// The notice rewrites the record to stamp it as said. A sweep on mtime would
		// hand a break reported on day six another week for having been read.
		const { lock } = staleClaim("alice's work\n");
		locks.breakStale(rel, lock, durably("bob"));
		const file = store.paths.break(rel, lock.claimId);
		const record = core.readRecord(file);
		fs.writeFileSync(
			file,
			JSON.stringify({
				...record,
				at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
			}),
		);

		store.buildBreakNotice(rel, "alice"); // the stamp, which refreshes mtime
		breaks.pruneBreaks();
		expect(fs.existsSync(file)).toBe(false);
	});

	it("keeps every pin when one record will not parse", () => {
		// Per-file, not only per-directory (mantahostels#174): the pin behind an unreadable
		// record is indistinguishable from an orphan, and dropping it destroys the
		// content this exists to keep.
		const { lock } = staleClaim("alice's work\n");
		locks.breakStale(rel, lock, durably("bob"));
		fs.writeFileSync(store.paths.break(rel, lock.claimId), "{not json");

		store.pruneAll(noSessions);
		expect(readRefs()).toEqual([`refs/arbiter/${lock.claimId}`]);
	});

	it("ages out a record that will not parse, so nothing is pinned for ever", () => {
		// Without an mtime fallback, one torn record would hold its blob — and every
		// later one — indefinitely.
		const { lock } = staleClaim("alice's work\n");
		locks.breakStale(rel, lock, durably("bob"));
		const file = store.paths.break(rel, lock.claimId);
		fs.writeFileSync(file, "{not json");
		const old = new Date(Date.now() - 30 * 86_400_000);
		fs.utimesSync(file, old, old);

		breaks.pruneBreaks();
		expect(fs.existsSync(file)).toBe(false);
	});

	it("keeps both breaks of lock records that would not parse", () => {
		// An unparseable lock leaves no claimId, and keying every such break to the
		// same filename would let the second break on a path erase the first.
		breaks.recordBreak(rel, null, durably("bob"));
		breaks.recordBreak(rel, null, durably("bob"));
		expect(fs.readdirSync(store.paths.breaksDir())).toHaveLength(2);
	});

	it("keeps a pin the lock store alone would have collected", () => {
		// The pin's claim is gone by construction — that is what a break is — so
		// pruneBlobRefs must read the break records, not only the locks.
		const { lock } = staleClaim("alice's work\n");
		locks.breakStale(rel, lock, durably("bob"));

		store.pruneAll(noSessions);
		expect(readRefs()).toEqual([`refs/arbiter/${lock.claimId}`]);
	});

	it("deletes no pin when the break records cannot be read", () => {
		// Same rule as an unreadable lock store: unreadable must not look like
		// empty (mantahostels#174).
		const { lock } = staleClaim("alice's work\n");
		locks.breakStale(rel, lock, durably("bob"));
		fs.rmSync(store.paths.breaksDir(), { recursive: true, force: true });
		fs.writeFileSync(store.paths.breaksDir(), "not a directory");

		store.pruneAll(noSessions);
		expect(readRefs()).toEqual([`refs/arbiter/${lock.claimId}`]);
		expect(fs.readFileSync(sb.errorLog(), "utf8")).toContain("pruneBlobRefs");
	});

	it("frees the path anyway when the record cannot be written, and logs the fault", () => {
		// FAIL OPEN, BUT NEVER SILENTLY (mantahostels#174). Refusing the break because it could
		// not be logged would wedge the path, which is worse than the silence.
		const { lock } = staleClaim("alice's work\n");
		fs.mkdirSync(store.stateDir(), { recursive: true });
		fs.writeFileSync(store.paths.breaksDir(), "not a directory");

		expect(locks.breakStale(rel, lock, durably("bob"))).toBe("freed");
		expect(fs.existsSync(store.paths.lock(rel))).toBe(false);
		expect(fs.readFileSync(sb.errorLog(), "utf8")).toContain(`break ${rel}`);
	});

	describe("the notice — the losing session, when it comes back to the file", () => {
		it("names the breaker and how to get the version back", () => {
			const { blob, lock } = staleClaim("alice's work\n");
			locks.breakStale(rel, lock, durably("bob"));

			const notice = store.buildBreakNotice(rel, "alice");
			expect(notice).toContain("bob");
			expect(notice).toContain(`git cat-file -p ${blob}`);
		});

		it("says nothing to the session that did the breaking", () => {
			const { lock } = staleClaim("alice's work\n");
			locks.breakStale(rel, lock, durably("bob"));
			expect(store.buildBreakNotice(rel, "bob")).toBeNull();
		});

		it("says nothing about a path this session never lost", () => {
			const { lock } = staleClaim("alice's work\n");
			locks.breakStale(rel, lock, durably("bob"));
			expect(store.buildBreakNotice("docs/doc-map.md", "alice")).toBeNull();
		});

		it("is said once, not on every write for a week", () => {
			const { lock } = staleClaim("alice's work\n");
			locks.breakStale(rel, lock, durably("bob"));

			expect(store.buildBreakNotice(rel, "alice")).toBeTruthy();
			expect(store.buildBreakNotice(rel, "alice")).toBeNull();
		});

		it("says the version is gone where the broken claim recorded none", () => {
			// A claim whose content was never recorded. Offering a recovery command
			// with no sha to run it on would be an instruction that fails.
			const { lock } = staleClaim("alice's work\n", "alice", false);
			locks.breakStale(rel, lock, durably("bob"));

			const notice = store.buildBreakNotice(rel, "alice");
			expect(notice).toContain("not recoverable");
			expect(notice).not.toContain("cat-file");
		});
	});

	it("is recorded through acquire, not only by a direct call", () => {
		// The call site is what runs in production: a session whose registry entry
		// has been pruned, or a headless run that never wrote one.
		const { lock } = staleClaim("alice's work\n");
		fs.rmSync(path.join(sb.home, "sessions", `${process.pid}.json`));

		expect(store.acquire(rel, live(sb, "bob")).verdict).toBe("claimed");
		expect(breaks.readBrokenClaimIds()).toEqual(new Set([lock.claimId]));
		expect(breaks.buildBreakNotice(rel, "alice")).toContain("by bob");
	});
});
