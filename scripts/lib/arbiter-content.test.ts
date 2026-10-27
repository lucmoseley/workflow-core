// @vitest-environment node
/*
 * arbiter-content.js's own suite: the git-blob pins, the prior-version ring a
 * holder recovers from, and the comparison that reports a clobber, whole-file
 * and per region (mantahostels#295, mantahostels#438). Each test runs in a fresh
 * sandbox with its own `git init`: the pins are real refs over real blobs, and
 * neither may land in this repo. Loosening it lets a clobbered file go
 * unreported or unrecoverable.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	commitAll,
	content,
	core,
	durably,
	freshSandbox,
	gitRepo,
	live,
	locks,
	noSessions,
	registerSession,
	store,
} from "./arbiter-testkit";

const sb = freshSandbox();

describe("content identity — what the file held when its claimant last touched it (mantahostels#295)", () => {
	// A claim records the file's git blob id, so a write by any route is detected
	// AND recoverable.
	const rel = "scripts/evidence-audit.py";
	const abs = () => path.join(sb.repo, rel);
	const write = (text: string) => {
		fs.mkdirSync(path.dirname(abs()), { recursive: true });
		fs.writeFileSync(abs(), text);
	};

	beforeEach(() => {
		gitRepo(sb);
	});

	/** Claim the path and record what it holds, as the PostToolUse recorder does. */
	const claimAndRecord = (sessionId: string, text: string) => {
		const me = live(sb, sessionId);
		write(text);
		store.acquire(rel, me);
		return { me, blob: store.recordContent(rel, me) };
	};

	const readLock = () => core.readRecord(store.paths.lock(rel));

	it("records the blob on the claim, and an unrecorded claim reads as unknown", () => {
		// No blob is a question never asked, not a clobber.
		const unrecorded = locks.newLock({ path: rel });
		expect(unrecorded.blob).toBeNull();
		expect(store.contentState(rel, unrecorded).state).toBe("unknown");

		const { blob } = claimAndRecord("alice", "first\n");
		expect(blob).toMatch(/^[0-9a-f]{40,64}$/);
		expect(readLock().blob).toBe(blob);
	});

	it("pins the blob so `git gc --prune=now` cannot drop it", () => {
		// Detection alone was never the ask: the overwritten content has to be
		// GETTABLE. A loose object nothing references is gc's to delete.
		const { blob } = claimAndRecord("alice", "the content to survive\n");
		expect(
			execFileSync(
				"git",
				["for-each-ref", "--format=%(refname)", "refs/arbiter/"],
				{
					cwd: sb.repo,
					encoding: "utf8",
				},
			),
		).toContain(`refs/arbiter/${readLock().claimId}`);

		execFileSync("git", ["gc", "--prune=now", "-q"], { cwd: sb.repo });

		expect(
			execFileSync("git", ["cat-file", "-p", blob], {
				cwd: sb.repo,
				encoding: "utf8",
			}),
		).toBe("the content to survive\n");
	});

	it("reports a change reaching the file by a route no hook watches", () => {
		const { blob } = claimAndRecord("alice", "alice's work\n");
		expect(store.contentState(rel, readLock()).state).toBe("same");

		// The clobber, by the shape the incident took: a whole-file write from
		// outside this session entirely.
		write("restored from a backup\n");

		const seen = store.contentState(rel, readLock());
		expect(seen.state).toBe("changed");
		expect(seen.was).toBe(blob);
		expect(
			execFileSync("git", ["cat-file", "-p", seen.was], {
				cwd: sb.repo,
				encoding: "utf8",
			}),
		).toBe("alice's work\n");
	});

	it("says nothing when the claimant refreshed its own file — the 42% class", () => {
		// The measured dominant shape: a session Bash-writing a path it holds, a
		// version-stamp `sed -i` most often. Without the post-Bash refresh every one
		// of those reports as a clobber, and the detector lands below the ~15%
		// precision under which mantahostels#185 bars a content-reading detector.
		const { me } = claimAndRecord("alice", "v1.35\n");
		write("v1.36\n"); // the sed
		store.recordContent(rel, me); // the PostToolUse Bash refresh
		expect(store.contentState(rel, readLock()).state).toBe("same");
	});

	it("treats a deletion as a change, not as an unanswerable question", () => {
		// hash-object cannot report a missing file: git exits non-zero, which reads
		// as "could not answer" everywhere else in this module.
		claimAndRecord("alice", "here\n");
		fs.rmSync(abs());
		expect(store.contentState(rel, readLock()).state).toBe("changed");
	});

	it("refuses to record against a claim another session holds, leaving the claim with its holder", () => {
		// Identity, not liveness: a lock carrying someone else's id is not ours to
		// write to, whatever the state of its holder.
		claimAndRecord("alice", "alice's\n");
		expect(store.recordContent(rel, live(sb, "bob"))).toBeNull();
		expect(readLock().sessionId).toBe("alice");
	});

	it("records nothing where there is no claim at all", () => {
		write("unclaimed\n");
		expect(store.recordContent(rel, live(sb, "alice"))).toBeNull();
	});

	it("reads as unknown where git itself cannot be run", () => {
		const { blob } = claimAndRecord("alice", "content\n");
		const savedPath = process.env.PATH;
		process.env.PATH = "";
		try {
			expect(store.contentState(rel, { blob }).state).toBe("unknown");
		} finally {
			process.env.PATH = savedPath;
		}
	});

	it("records nothing outside a repository, so the claim stays unknown rather than wrong", () => {
		// `git hash-object` needs no repository — it is a pure hash, so the COMPARE
		// survives one that is gone. Writing the blob and pinning it do need one,
		// and a blob that was never pinned is not recoverable, so reporting an id
		// for it would be a recovery instruction that fails.
		fs.rmSync(path.join(sb.repo, ".git"), { recursive: true, force: true });
		write("content\n");
		const me = live(sb, "alice");
		store.acquire(rel, me);
		expect(store.recordContent(rel, me)).toBeNull();
		expect(store.contentState(rel, readLock()).state).toBe("unknown");
	});

	it("refuses a claim id that is not a safe ref name", () => {
		// claimId is a randomUUID, but a hand-written lock's is not
		// ours to trust, and it is being handed to git as a ref name.
		expect(content.blobRef("../../evil")).toBeNull();
		expect(content.blobRef("-d")).toBeNull();
		expect(content.blobRef(undefined)).toBeNull();
		expect(content.blobRef(crypto.randomUUID())).toMatch(/^refs\/arbiter\//);
	});

	describe("the pins are bounded by the arbiter's own sweep", () => {
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

		it("drops the pins of claims that no longer exist, and keeps the live ones", () => {
			claimAndRecord("alice", "held\n");
			const liveRef = `refs/arbiter/${readLock().claimId}`;
			execFileSync(
				"git",
				["update-ref", "refs/arbiter/a-dead-claim", readLock().blob],
				{
					cwd: sb.repo,
				},
			);
			expect(readRefs()).toHaveLength(2);

			store.pruneAll(noSessions);
			expect(readRefs()).toEqual([liveRef]);
		});

		it("deletes nothing when the lock store cannot be read", () => {
			// A live pin and an orphan are indistinguishable without the lock store,
			// and dropping a live one destroys exactly the content this keeps
			// recoverable (mantahostels#174).
			claimAndRecord("alice", "held\n");
			const before = readRefs();
			fs.rmSync(store.paths.locksDir(), { recursive: true, force: true });
			fs.writeFileSync(store.paths.locksDir(), "not a directory");

			store.pruneAll(noSessions);
			expect(readRefs()).toEqual(before);
			expect(fs.readFileSync(sb.errorLog(), "utf8")).toContain("pruneBlobRefs");
		});

		describe("a ref lock left by a killed git (#1193)", () => {
			const pin = (name: string) =>
				execFileSync(
					"git",
					["update-ref", `refs/arbiter/${name}`, readLock().blob],
					{ cwd: sb.repo },
				);
			const lockFile = (name: string) =>
				path.join(sb.repo, ".git", "refs", "arbiter", `${name}.lock`);
			const lock = (name: string, ageMs: number) => {
				fs.writeFileSync(lockFile(name), "");
				const t = (Date.now() - ageMs) / 1000;
				fs.utimesSync(lockFile(name), t, t);
			};
			// 10 minutes is STALE_REF_LOCK_MS in lib/arbiter-sweep.js.
			const past = 10 * 60 * 1000 + 60_000;

			it("removes an aged lock and prunes its ref with the rest", () => {
				claimAndRecord("alice", "held\n");
				const liveRef = `refs/arbiter/${readLock().claimId}`;
				for (const n of ["dead-1", "dead-2", "dead-3"]) pin(n);
				lock("dead-2", past);

				store.pruneAll(noSessions);
				expect(readRefs()).toEqual([liveRef]);
				expect(fs.existsSync(lockFile("dead-2"))).toBe(false);
			});

			it("leaves a young lock and its ref, and still prunes the others", () => {
				claimAndRecord("alice", "held\n");
				const liveRef = `refs/arbiter/${readLock().claimId}`;
				for (const n of ["dead-1", "dead-2", "dead-3"]) pin(n);
				lock("dead-2", 1000);

				store.pruneAll(noSessions);
				expect(readRefs().sort()).toEqual(
					[liveRef, "refs/arbiter/dead-2"].sort(),
				);
				expect(fs.existsSync(lockFile("dead-2"))).toBe(true);
			});

			it("removes an aged lock on a live claim's pin and keeps the pin", () => {
				claimAndRecord("alice", "held\n");
				const id = readLock().claimId;
				lock(id, past);

				store.pruneAll(noSessions);
				expect(readRefs()).toEqual([`refs/arbiter/${id}`]);
				expect(fs.existsSync(lockFile(id))).toBe(false);
			});

			it("logs a refused batch rather than swallowing it", () => {
				claimAndRecord("alice", "held\n");
				pin("dead-1");
				// A packed-refs lock is outside the arbiter's namespace, so it stays,
				// and deleting a packed ref needs it.
				execFileSync("git", ["pack-refs", "--all"], { cwd: sb.repo });
				fs.writeFileSync(path.join(sb.repo, ".git", "packed-refs.lock"), "");

				store.pruneAll(noSessions);
				expect(readRefs()).toContain("refs/arbiter/dead-1");
				expect(fs.readFileSync(sb.errorLog(), "utf8")).toMatch(
					/pruneBlobRefs[\s\S]*update-ref --stdin refused 1 orphan pin[\s\S]*packed-refs\.lock/,
				);
			});
		});

		it("drops the pin when the claim is released", () => {
			const { me } = claimAndRecord("alice", "held\n");
			execFileSync("git", ["add", "-A"], { cwd: sb.repo });
			execFileSync(
				"git",
				["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"],
				{ cwd: sb.repo },
			);
			expect(store.release(rel, me).verdict).toBe("released");
			expect(readRefs()).toEqual([]);
		});
	});

	describe("the second reporting site — release (mantahostels#332)", () => {
		const commit = () => commitAll(sb);

		it("hands the caller the content state, and the blob id read before the drop", () => {
			// Clean to git and still clobbered: the claimant's bytes were committed,
			// then replaced and committed by someone else.
			const { me, blob } = claimAndRecord("alice", "alice's work\n");
			commit();
			write("restored from a backup\n");
			commit();

			const r = store.release(rel, me);
			expect(r.verdict).toBe("released");
			expect(r.content.state).toBe("changed");
			expect(r.content.was).toBe(blob);

			// The pin is gone, but the object survives as loose until git prunes it.
			expect(
				execFileSync("git", ["cat-file", "-p", r.content.was], {
					cwd: sb.repo,
					encoding: "utf8",
				}),
			).toBe("alice's work\n");
		});

		it("reports same on a file nobody touched", () => {
			const { me } = claimAndRecord("alice", "alice's work\n");
			commit();
			expect(store.release(rel, me).content.state).toBe("same");
		});

		it("reports unknown, never changed, on a claim never recorded", () => {
			const me = live(sb, "alice");
			write("alice's work\n");
			store.acquire(rel, me); // claimed, never recorded: blob is null
			commit();
			expect(store.release(rel, me).content.state).toBe("unknown");
		});

		it("hands the caller the content state on a dirty refusal too (mantahostels#337)", () => {
			// The commoner clobber shape: a neighbour's `cp` or `git restore` leaves the
			// tree dirty, so the release refuses before it ever compares content — and
			// tells the session to commit, which commits the neighbour's bytes (mantahostels#63).
			const { me, blob } = claimAndRecord("alice", "alice's work\n");
			commit();
			write("restored from a backup\n"); // the clobber, left uncommitted

			const r = store.release(rel, me);
			expect(r.verdict).toBe("dirty");
			expect(r.content.state).toBe("changed");
			expect(r.content.was).toBe(blob);

			// The claim stands, so its pin stands: recovery is still available later.
			expect(
				execFileSync(
					"git",
					["for-each-ref", "--format=%(refname)", "refs/arbiter/"],
					{ cwd: sb.repo, encoding: "utf8" },
				),
			).toContain(`refs/arbiter/${readLock().claimId}`);
			expect(
				execFileSync("git", ["cat-file", "-p", r.content.was], {
					cwd: sb.repo,
					encoding: "utf8",
				}),
			).toBe("alice's work\n");
		});

		it("reads a dirty file its own claimant edited as unchanged, not clobbered", () => {
			// The ordinary dirty release — the session's own unfinished edit, refreshed
			// into the pin by the post-Bash recorder. Nothing to report.
			const { me } = claimAndRecord("alice", "alice's work\n");
			commit();
			write("alice's next edit\n");
			store.recordContent(rel, me);
			expect(store.release(rel, me).content.state).toBe("same");
		});
	});

	describe("updateIfUnchanged — the rewrite that cannot clobber a replacement", () => {
		it("puts back a lock that is not the one it read, rather than overwriting it", () => {
			// A plain read-modify-write would let a third session claim the path
			// between the read and the write, and the write would then replace that
			// session's live lock with our stale one.
			store.acquire(rel, live(sb, "alice"));
			const r = locks.updateIfUnchanged(
				rel,
				(m: { claimId: string }) => m.claimId === "not-this-one",
				(m: object) => ({ ...m, blob: "deadbeef" }),
			);
			expect(r.outcome).toBe("kept");
			expect(r.restored).toBe(true);
			expect(readLock().blob).toBeNull();
			expect(readLock().sessionId).toBe("alice");
		});
	});
});

describe("the versions a claim has held — the holder's own clobber (mantahostels#438)", () => {
	// mantahostels#329's residual: a `cp` the HOLDER runs is trusted by the post-Bash refresh,
	// which re-pins the clobbered bytes, and no detector was built because the HEAD
	// test that separates it from a `sed -i` fires on legitimate mutation cycles at
	// ~1.4% precision. So the claim keeps the shas it has held instead.
	const rel = "scripts/evidence-audit.py";
	const abs = () => path.join(sb.repo, rel);
	const write = (text: string) => {
		fs.mkdirSync(path.dirname(abs()), { recursive: true });
		fs.writeFileSync(abs(), text);
	};
	const readLock = () => core.readRecord(store.paths.lock(rel));

	beforeEach(() => {
		gitRepo(sb);
	});

	/** Write the file and refresh the claim's record, as the post-Bash hook does. */
	const revise = (me: object, text: string) => {
		write(text);
		return store.recordContent(rel, me);
	};

	const claiming = (sessionId: string) => {
		const me = live(sb, sessionId);
		write("v1\n");
		store.acquire(rel, me);
		store.recordContent(rel, me);
		return me;
	};

	it("keeps the sha a refresh replaced, so the clobbered version is namable", () => {
		const me = claiming("alice");
		const first = readLock().blob;

		// The clobber that reports nothing: the holder's own `cp` from a backup,
		// followed by the refresh that trusts it.
		revise(me, "restored from a backup\n");

		expect(readLock().blob).not.toBe(first);
		expect(readLock().priorBlobs.map((v: { sha: string }) => v.sha)).toEqual([
			first,
		]);
		expect(
			execFileSync("git", ["cat-file", "-p", first], {
				cwd: sb.repo,
				encoding: "utf8",
			}),
		).toBe("v1\n");
	});

	it("caps the chain, so forty refreshes do not grow the record without limit", () => {
		const me = claiming("alice");
		for (let i = 2; i <= 40; i++) revise(me, `v${i}\n`);
		expect(readLock().priorBlobs.length).toBe(content.PRIOR_BLOBS_MAX);
		// Newest first: the cap evicts the oldest, never the version just replaced.
		expect(
			execFileSync("git", ["cat-file", "-p", readLock().priorBlobs[0].sha], {
				cwd: sb.repo,
				encoding: "utf8",
			}),
		).toBe("v39\n");
	});

	it("drops a refresh that changed nothing, so identical entries cannot evict", () => {
		// The post-Bash refresh fires on EVERY Bash call, so most re-record the same
		// sha. Without this the cap fills with copies of one version.
		const me = claiming("alice");
		for (let i = 0; i < 20; i++) store.recordContent(rel, me);
		expect(readLock().priorBlobs).toEqual([]);
	});

	it("lists the versions newest first, current one first", () => {
		const me = claiming("alice");
		revise(me, "v2\n");
		revise(me, "v3\n");
		const seen = store.claimVersions(rel);
		expect(seen.lock.sessionId).toBe("alice");
		expect(
			seen.versions.map((v: { sha: string }) =>
				execFileSync("git", ["cat-file", "-p", v.sha], {
					cwd: sb.repo,
					encoding: "utf8",
				}),
			),
		).toEqual(["v3\n", "v2\n", "v1\n"]);
		expect(seen.versions.every((v: { gone: boolean }) => !v.gone)).toBe(true);
	});

	it("marks a version git has pruned as gone rather than as a recovery instruction", () => {
		// Only the CURRENT version is pinned — a prior lives on git's two-week
		// default and then stops being gettable. Printing its sha as a `cat-file`
		// line after that is an instruction that fails.
		const me = claiming("alice");
		revise(me, "v2\n");
		execFileSync("git", ["gc", "--prune=now", "-q"], { cwd: sb.repo });

		const seen = store.claimVersions(rel);
		expect(seen.versions[0].gone).toBe(false); // pinned
		expect(seen.versions[1].gone).toBe(true); // swept
	});

	it("reports no versions where nothing holds the path", () => {
		write("unclaimed\n");
		expect(store.claimVersions(rel)).toBeNull();
	});
});

/*
 * Region-scoped content identity (mantahostels#970). Without it the clobber detector fires
 * on every interleaved write to docs/doc-map.md the moment two sessions can
 * hold it at once — and the recovery it advises would destroy the neighbour's
 * work, which is the opposite of what mantahostels#295 built it for.
 */
describe("content identity on a region claim", () => {
	const docMap = "docs/doc-map.md";
	const body = (first: string, second: string) =>
		[
			"# doc map",
			"",
			"v1.0 · 21 August 2026",
			"",
			"## Section B",
			"",
			"### B1 · One",
			"",
			first,
			"",
			"### B2 · Two",
			"",
			second,
			"",
		].join("\n");

	const writeMap = (first: string, second: string) =>
		fs.writeFileSync(path.join(sb.repo, docMap), body(first, second));

	beforeEach(() => {
		gitRepo(sb);
		writeMap("first as written", "second as written");
	});

	const claimB1 = () => {
		const me = durably("alice");
		registerSession(sb, "alice", process.pid);
		store.acquire(`${docMap}#B1`, store.identify("alice"));
		store.recordContent(`${docMap}#B1`, store.identify("alice"));
		return me;
	};

	it("stays silent when a neighbour edits a DIFFERENT region", () => {
		claimB1();
		writeMap("first as written", "second, rewritten by a neighbour");
		const lock = store
			.listLocks()
			.find((l: { path: string }) => l.path === `${docMap}#B1`);
		expect(store.contentState(`${docMap}#B1`, lock).state).toBe("same");
	});

	it("reports a change inside the region it claims", () => {
		claimB1();
		writeMap("first, overwritten by something", "second as written");
		const lock = store
			.listLocks()
			.find((l: { path: string }) => l.path === `${docMap}#B1`);
		expect(store.contentState(`${docMap}#B1`, lock).state).toBe("changed");
	});

	it("pins bytes that come back as the region's own text", () => {
		claimB1();
		const lock = store
			.listLocks()
			.find((l: { path: string }) => l.path === `${docMap}#B1`);
		const recovered = execFileSync("git", ["cat-file", "-p", lock.blob], {
			cwd: sb.repo,
			encoding: "utf8",
		});
		expect(recovered).toContain("### B1 · One");
		expect(recovered).toContain("first as written");
		expect(recovered).not.toContain("### B2");
	});

	it("refreshes every region the session holds when handed the bare path", () => {
		// The PostToolUse write hook knows only the file, so a fan-out here is what
		// keeps the detector alive on a region-claiming session.
		registerSession(sb, "alice", process.pid);
		const me = store.identify("alice");
		store.acquire(`${docMap}#B1`, me);
		store.acquire(`${docMap}#B2`, me);
		store.recordContent(docMap, me);
		for (const l of store.listLocks()) expect(l.blob).toBeTruthy();
	});
});
