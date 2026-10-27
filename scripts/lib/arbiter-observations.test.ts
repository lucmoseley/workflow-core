// @vitest-environment node
/*
 * arbiter-observations.js's own suite: on a detect-only path, a second writer
 * gets its own baseline and is shown its own last write, never the holder's,
 * and an unknown is never reported as changed (mantahostels#363, mantahostels#419).
 *
 * Each case runs in arbiter-testkit's sandbox over a real `git init`, because a
 * baseline is a real blob, with the claim holder and second writer set by hand.
 *
 * The arbiter runs behind `lib/file-claim.js`, a `PreToolUse` core on every
 * Write and Edit: loosen a case here and a clobber of a second writer's
 * scripts/ edit goes unreported, or its own refresh is reported as one.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	AS_ROOT,
	core,
	freshSandbox,
	live,
	noSessions,
	store,
} from "./arbiter-testkit";

const sb = freshSandbox();

describe("a second writer's own content record on a detect-only path (mantahostels#363)", () => {
	// mantahostels#330 found the hole: the detect-only tier refuses nobody, so two sessions can
	// write one scripts/ file at once — and only the first, which holds the claim,
	// got a baseline.
	//
	// The baseline is a property of the (session, path) pair here, not of the claim,
	// so each writer compares against its OWN last write.
	const rel = "scripts/evidence-audit.py";
	const abs = () => path.join(sb.repo, rel);
	const write = (text: string) => {
		fs.mkdirSync(path.dirname(abs()), { recursive: true });
		fs.writeFileSync(abs(), text);
	};
	const readLock = () => core.readRecord(store.paths.lock(rel));
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
	const readBlobContent = (blob: string) =>
		execFileSync("git", ["cat-file", "-p", blob], {
			cwd: sb.repo,
			encoding: "utf8",
		});

	beforeEach(() => {
		execFileSync("git", ["init", "-q"], { cwd: sb.repo });
	});

	/** The holder: claims the path and records what it wrote, as PostToolUse does. */
	const holder = (sessionId: string, text: string) => {
		const me = live(sb, sessionId);
		write(text);
		store.acquire(rel, me);
		return { me, blob: store.recordContent(rel, me) };
	};

	/** The second writer: writes a path someone else holds, and records for itself. */
	const observer = (sessionId: string, text: string) => {
		const me = live(sb, sessionId);
		write(text);
		store.acquire(rel, me); // "held" — no lock of its own is minted
		return { me, blob: store.recordObservation(rel, me) };
	};

	it("gives the second writer its own baseline, leaving the holder's untouched", () => {
		const alice = holder("alice", "alice's work\n");
		const bob = observer("bob", "bob's work\n");

		expect(bob.blob).toMatch(/^[0-9a-f]{40,64}$/);
		expect(bob.blob).not.toBe(alice.blob);
		// The lock is the holder's record, and a second writer never touches it.
		expect(readLock().sessionId).toBe("alice");
		expect(readLock().blob).toBe(alice.blob);
	});

	it("shows the second writer its OWN last write, never the holder's", () => {
		// The bug the obvious one-liner would have shipped (mantahostels#363): lifting the
		// "held" skip makes contentState read the HOLDER's blob, so the recovery
		// command hands the second writer somebody else's content as its own.
		const alice = holder("alice", "alice's work\n");
		observer("bob", "bob's work\n");

		write("restored from a backup\n"); // the clobber, by any route

		const seen = store.observationState(rel, "bob");
		expect(seen.state).toBe("changed");
		expect(seen.was).not.toBe(alice.blob);
		expect(readBlobContent(seen.was)).toBe("bob's work\n");
	});

	it("leaves the holder's own report exactly as it was", () => {
		const alice = holder("alice", "alice's work\n");
		observer("bob", "bob's work\n");

		const seen = store.contentState(rel, readLock());
		expect(seen.state).toBe("changed");
		expect(seen.was).toBe(alice.blob);
		expect(readBlobContent(seen.was)).toBe("alice's work\n");
	});

	it("says nothing when the second writer refreshed its own file", () => {
		// cmdRefresh's half: a second writer's `sed -i` on the path must not report
		// as a clobber.
		holder("alice", "alice's\n");
		const { me } = observer("bob", "bob's v1\n");
		write("bob's v2\n");
		store.recordObservation(rel, me);
		expect(store.observationState(rel, "bob").state).toBe("same");
	});

	it("says unknown, not changed, where this session has observed nothing", () => {
		holder("alice", "alice's\n");
		expect(store.observationState(rel, "bob").state).toBe("unknown");
		expect(store.observationState(rel, "").state).toBe("unknown");
	});

	it("records nothing on the refusing tier, where a second writer is denied anyway", () => {
		// mantahostels#363 scopes this to the detect-only tier. On docs/ the guard refuses the
		// write, so a second baseline there would describe a write that never lands.
		const guarded = "docs/doc-map.md";
		fs.writeFileSync(path.join(sb.repo, guarded), "held\n");
		store.acquire(guarded, live(sb, "alice"));
		expect(store.recordObservation(guarded, live(sb, "bob"))).toBeNull();
	});

	it("records nothing where the caller holds the claim itself", () => {
		// The claim's own blob is that session's record; a second one would be two
		// baselines for one writer, and the pins would disagree.
		const { me } = holder("alice", "alice's\n");
		expect(store.recordObservation(rel, me)).toBeNull();
	});

	it("records a baseline where nobody holds the path at all (mantahostels#2333)", () => {
		// The write landed — the detect-only tier refuses nobody — so this record is
		// the only trace the writer exists. Withholding it left park() reading an
		// empty writer set and restoring HEAD over live work.
		write("unclaimed\n");
		expect(store.recordObservation(rel, live(sb, "bob"))).toMatch(
			/^[0-9a-f]{40,64}$/,
		);
	});

	it("pins the second writer's bytes, so its recovery command works after a gc", () => {
		holder("alice", "alice's\n");
		const bob = observer("bob", "bob's work to survive\n");
		write("clobbered\n");

		execFileSync("git", ["gc", "--prune=now", "-q"], { cwd: sb.repo });
		expect(readBlobContent(bob.blob)).toBe("bob's work to survive\n");
	});

	it("keeps a second writer's pin through the sweep that collects orphans", () => {
		// pruneBlobRefs spares what the LOCKS name. A second writer holds no lock, so
		// without its own sparing rule the sweep collects exactly the bytes this
		// exists to keep recoverable.
		holder("alice", "alice's\n");
		const bob = observer("bob", "bob's\n");
		store.pruneAll(noSessions);
		expect(readRefs()).toHaveLength(2);
		expect(readBlobContent(bob.blob)).toBe("bob's\n");
	});

	it("deletes nothing when the observations cannot be read at all (mantahostels#174)", () => {
		holder("alice", "alice's\n");
		observer("bob", "bob's\n");
		fs.rmSync(store.paths.observationsDir(), { recursive: true, force: true });
		fs.writeFileSync(store.paths.observationsDir(), "not a directory");

		store.pruneAll(noSessions);
		expect(readRefs()).toHaveLength(2);
		expect(fs.readFileSync(sb.errorLog(), "utf8")).toContain("pruneBlobRefs");
	});

	describe("release — the drop path for a record its caller does not hold", () => {
		it("drops the second writer's record and pin, and reports the clobber first", () => {
			// Without this the record and its pin leak until the sweep, and the second
			// writer never gets the release-site report (mantahostels#332) the holder gets.
			holder("alice", "alice's\n");
			const bob = observer("bob", "bob's work\n");
			write("clobbered by a third route\n");

			const r = store.release(rel, live(sb, "bob"));
			expect(r.verdict).toBe("held-by-other");
			expect(r.observed.state).toBe("changed");
			expect(r.observed.was).toBe(bob.blob);
			expect(fs.existsSync(store.paths.observation(rel, "bob"))).toBe(false);
			expect(readRefs()).toEqual([`refs/arbiter/${readLock().claimId}`]);
		});

		it("drops it on a path whose holder has since released, too", () => {
			holder("alice", "alice's\n");
			const aliceRef = `refs/arbiter/${readLock().claimId}`;
			observer("bob", "bob's\n");
			fs.rmSync(store.paths.lock(rel)); // alice's claim, gone

			const r = store.release(rel, live(sb, "bob"));
			expect(r.verdict).toBe("not-held");
			expect(r.observed.state).toBe("same");
			expect(fs.existsSync(store.paths.observation(rel, "bob"))).toBe(false);
			// Bob's pin went with bob's record; alice's is now an orphan for the sweep.
			expect(readRefs()).toEqual([aliceRef]);
		});

		it("drops it on the --force route, where the caller is never the holder", () => {
			// forceRelease is the one exit that reaches a claim without going through
			// release's identity gate, so it needs its own drop or the forcing
			// session's record outlives every claim it was keyed against.
			holder("alice", "alice's\n");
			const bob = observer("bob", "bob's work\n");
			execFileSync("git", ["add", "-A"], { cwd: sb.repo });
			execFileSync(
				"git",
				["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"],
				{ cwd: sb.repo },
			);

			const r = store.forceRelease(rel, live(sb, "bob"), () => ({
				ids: new Set(["bob"]),
			}));
			expect(r.verdict).toBe("forced");
			expect(r.observed.was).toBe(bob.blob);
			expect(fs.existsSync(store.paths.observation(rel, "bob"))).toBe(false);
		});

		it("leaves the holder's own release untouched", () => {
			const { me } = holder("alice", "alice's\n");
			observer("bob", "bob's\n");
			// Alice's release is judged on alice's claim alone.
			const r = store.release(rel, me);
			expect(r.verdict).toBe("dirty");
			expect(fs.existsSync(store.paths.observation(rel, "bob"))).toBe(true);
		});
	});

	describe("readObservedBy — the paths one session is a second writer on", () => {
		it("names this session's observations and nobody else's", () => {
			holder("alice", "alice's\n");
			observer("bob", "bob's\n");
			fs.writeFileSync(path.join(sb.repo, "scripts/other.js"), "x\n");
			store.acquire("scripts/other.js", live(sb, "carol"));
			store.recordObservation("scripts/other.js", live(sb, "bob"));

			expect(store.readObservedBy("bob").sort()).toEqual([
				rel,
				"scripts/other.js",
			]);
			expect(store.readObservedBy("alice")).toEqual([]);
		});

		it("returns null, not an empty set, when the store cannot be read (mantahostels#174)", () => {
			fs.mkdirSync(store.stateDir(), { recursive: true });
			fs.writeFileSync(store.paths.observationsDir(), "not a directory");
			expect(store.readObservedBy("bob")).toBeNull();
			expect(store.readObservedBy("")).toBeNull();
		});
	});

	describe("the records are bounded by the arbiter's own sweep", () => {
		it("drops a record nobody has written against for a week, and its pin with it", () => {
			holder("alice", "alice's\n");
			observer("bob", "bob's\n");
			const file = store.paths.observation(rel, "bob");
			const old = Date.now() - 8 * 24 * 60 * 60 * 1000;
			fs.utimesSync(file, old / 1000, old / 1000);

			store.pruneAll(noSessions);
			expect(fs.existsSync(file)).toBe(false);
			expect(readRefs()).toEqual([`refs/arbiter/${readLock().claimId}`]);
		});

		it("keeps a record written against inside the week", () => {
			holder("alice", "alice's\n");
			observer("bob", "bob's\n");
			store.pruneAll(noSessions);
			expect(fs.existsSync(store.paths.observation(rel, "bob"))).toBe(true);
		});
	});
});

describe("readObservedBy reads its own records, not the whole store (mantahostels#419)", () => {
	// The observations directory is one flat store shared by every session, and the
	// scan made it grow with every watched path any session Bash-touches. Opening
	// all of it after every Bash call in every session is what would walk the hook
	// into its own `timeout 5`.
	const rel = "scripts/evidence-audit.py";

	beforeEach(() => {
		execFileSync("git", ["init", "-q"], { cwd: sb.repo });
		fs.mkdirSync(path.join(sb.repo, "scripts"), { recursive: true });
		fs.writeFileSync(path.join(sb.repo, rel), "seeded\n");
	});

	it("returns this session's paths and none of a neighbour's", () => {
		const alice = live(sb, "alice");
		const bob = live(sb, "bob");
		store.recordObservation(rel, alice, { viaBash: true });
		store.recordObservation("scripts/other.py", bob, { viaBash: true });

		expect(store.readObservedBy("alice")).toEqual([rel]);
	});

	it("treats the filename as an index, never as the authority", () => {
		const alice = live(sb, "alice");
		store.recordObservation(rel, alice, { viaBash: true });
		const file = store.paths.observation(rel, "alice");
		const record = JSON.parse(fs.readFileSync(file, "utf8"));
		fs.writeFileSync(file, JSON.stringify({ ...record, sessionId: "bob" }));

		expect(store.readObservedBy("alice")).toEqual([]);
	});

	it("still reports an unreadable store as unavailable, not as empty (mantahostels#174)", () => {
		if (AS_ROOT) return;
		live(sb, "alice");
		fs.mkdirSync(store.paths.observationsDir(), { recursive: true });
		fs.chmodSync(store.paths.observationsDir(), 0o000);
		try {
			expect(store.readObservedBy("alice")).toBeNull();
		} finally {
			fs.chmodSync(store.paths.observationsDir(), 0o755);
		}
	});
});
