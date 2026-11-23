// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assert, beforeEach, describe, expect, it } from "vitest";
import {
	AS_ROOT,
	freshSandbox,
	live,
	noSessions,
	readLockAt,
	store,
} from "./arbiter-testkit";
import { defineTemplate, emptyRepoTemplate } from "./git-fixture";

const sb = freshSandbox();
const sandboxRepo = defineTemplate((dir) => {
	emptyRepoTemplate(dir);
	fs.mkdirSync(path.join(dir, "docs"));
});

describe("a second writer's own content record on a detect-only path (mantahostels#363)", () => {
	const rel = "scripts/evidence-audit.py";
	const abs = () => path.join(sb.repo, rel);
	const write = (text: string) => {
		fs.mkdirSync(path.dirname(abs()), { recursive: true });
		fs.writeFileSync(abs(), text);
	};
	const readLock = () => readLockAt(store.paths.lock(rel));
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
	const readBlobContent = (blob: string | null) => {
		assert(blob);
		return execFileSync("git", ["cat-file", "-p", blob], {
			cwd: sb.repo,
			encoding: "utf8",
		});
	};

	beforeEach(() => {
		sandboxRepo.instantiate(sb.repo);
	});

	const holder = (sessionId: string, text: string) => {
		const me = live(sb, sessionId);
		write(text);
		store.acquire(rel, me);
		return { me, blob: store.recordContent(rel, me) };
	};

	const observer = (sessionId: string, text: string) => {
		const me = live(sb, sessionId);
		write(text);
		store.acquire(rel, me);
		return { me, blob: store.recordObservation(rel, me) };
	};

	it("gives the second writer its own baseline, leaving the holder's untouched", () => {
		const alice = holder("alice", "alice's work\n");
		const bob = observer("bob", "bob's work\n");

		expect(bob.blob).toMatch(/^[0-9a-f]{40,64}$/);
		expect(bob.blob).not.toBe(alice.blob);
		expect(readLock().sessionId).toBe("alice");
		expect(readLock().blob).toBe(alice.blob);
	});

	it("shows the second writer its OWN last write, never the holder's", () => {
		const alice = holder("alice", "alice's work\n");
		observer("bob", "bob's work\n");

		write("restored from a backup\n");

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
		const guarded = "docs/doc-map.md";
		fs.writeFileSync(path.join(sb.repo, guarded), "held\n");
		store.acquire(guarded, live(sb, "alice"));
		expect(store.recordObservation(guarded, live(sb, "bob"))).toBeNull();
	});

	it("records nothing where the caller holds the claim itself", () => {
		const { me } = holder("alice", "alice's\n");
		expect(store.recordObservation(rel, me)).toBeNull();
	});

	it("records a baseline where nobody holds the path at all (mantahostels#2333)", () => {
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
			holder("alice", "alice's\n");
			const bob = observer("bob", "bob's work\n");
			write("clobbered by a third route\n");

			const r = store.release(rel, live(sb, "bob"));
			expect(r.verdict).toBe("held-by-other");
			assert(r.observed);
			expect(r.observed.state).toBe("changed");
			expect(r.observed.was).toBe(bob.blob);
			expect(fs.existsSync(store.paths.observation(rel, "bob"))).toBe(false);
			expect(readRefs()).toEqual([`refs/arbiter/${readLock().claimId}`]);
		});

		it("drops it on a path whose holder has since released, too", () => {
			holder("alice", "alice's\n");
			const aliceRef = `refs/arbiter/${readLock().claimId}`;
			observer("bob", "bob's\n");
			fs.rmSync(store.paths.lock(rel));

			const r = store.release(rel, live(sb, "bob"));
			expect(r.verdict).toBe("not-held");
			assert(r.observed);
			expect(r.observed.state).toBe("same");
			expect(fs.existsSync(store.paths.observation(rel, "bob"))).toBe(false);
			expect(readRefs()).toEqual([aliceRef]);
		});

		it("leaves the holder's own release untouched", () => {
			const { me } = holder("alice", "alice's\n");
			observer("bob", "bob's\n");
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

			const observedBy = store.readObservedBy("bob");
			assert(observedBy);
			expect(observedBy.sort()).toEqual([rel, "scripts/other.js"]);
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
	const rel = "scripts/evidence-audit.py";

	beforeEach(() => {
		sandboxRepo.instantiate(sb.repo);
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
