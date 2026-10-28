// @vitest-environment node
/*
 * arbiter-snapshots.js's own suite: the tier scan baselines a watched file a
 * Bash-route write moved, re-hashes only what moved, and its per-session state
 * is swept with the session (mantahostels#419, #833).
 *
 * Each case runs in arbiter-testkit's sandbox over a real `git init`, writing
 * files by hand between scans, because the scan reads bytes and stat and never
 * the command that wrote them.
 *
 * The refresh-claims core, a `PostToolUse` Bash hook, runs this scan: loosen a case
 * here and a `sed -i`, `cp` or heredoc clobber of a watched file goes
 * unreported (mantahostels#364), or every Bash call re-hashes the whole tier.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	core,
	finished,
	freshSandbox,
	live,
	noSessions,
	store,
} from "./arbiter-testkit";
import { shellQuote, writeFaultyGit } from "./git-fault-fake";
import { sleepSync } from "./sleep-sync.js";

const sb = freshSandbox();

describe("the tier scan — a baseline for a write no hook ever sees (mantahostels#419)", () => {
	// mantahostels#364's gap: a baseline is minted by a CLAIM ATTEMPT, and only a tool write
	// makes one. A session that reaches a watched file through `sed -i`, `cp` or
	// `git restore` mints nothing, so a later clobber of its work is unreportable
	// and its version unrecoverable. The scan reads bytes, never the command.
	const auditScript = "scripts/evidence-audit.py";
	const guarded = "docs/doc-map.md";

	const write = (rel: string, text: string) => {
		fs.mkdirSync(path.dirname(path.join(sb.repo, rel)), { recursive: true });
		fs.writeFileSync(path.join(sb.repo, rel), text);
	};
	const readBlobContent = (blob: string) =>
		execFileSync("git", ["cat-file", "-p", blob], {
			cwd: sb.repo,
			encoding: "utf8",
		});
	const locks = () =>
		store.listLocks().map((l: { path: string }) => l.path as string);

	/** What cmdRefresh does with the scan's answer, for a session holding nothing. */
	const bashWrote = (sessionId: string, rel: string, text: string) => {
		const me = live(sb, sessionId);
		store.scanChanged(sessionId); // the previous Bash call: the tier is now known
		write(rel, text);
		const changed = store.scanChanged(sessionId);
		for (const p of changed) store.recordObservation(p, me, { viaBash: true });
		return changed;
	};

	beforeEach(() => {
		execFileSync("git", ["init", "-q"], { cwd: sb.repo });
		write(auditScript, "seeded\n");
		write(guarded, "seeded\n");
	});

	it("gives a session that only ever Bash-wrote a path its own baseline and pin", () => {
		expect(bashWrote("alice", auditScript, "alice's sed\n")).toContain(
			auditScript,
		);

		const seen = store.observationState(auditScript, "alice");
		expect(seen.state).toBe("same");
		expect(readBlobContent(seen.was)).toBe("alice's sed\n");

		// Pinned, not merely hashed: an unreferenced blob is git gc's to drop.
		write(auditScript, "clobbered by a neighbour\n");
		execFileSync("git", ["gc", "--prune=now", "-q"], { cwd: sb.repo });
		const after = store.observationState(auditScript, "alice");
		expect(after.state).toBe("changed");
		expect(readBlobContent(after.was)).toBe("alice's sed\n");
	});

	/* The scan asks git for the raw tiers, which are wider than the watched
	 * union (mantahostels#2103): `.claude/tmp/` sits inside `.claude/` and outside both
	 * tiers. Scratch has no version worth recovering, so it is baselined by
	 * nothing — and the sandbox has no .gitignore, so this pins the filter
	 * itself rather than git's ignore rules standing in for it. */
	it("skips an exempt path though its pathspec still names it", () => {
		expect(
			bashWrote("alice", ".claude/tmp/scratch.md", "scratch\n"),
		).not.toContain(".claude/tmp/scratch.md");
	});

	it("covers the refusing tier too, where a `git restore` walks past the guard", () => {
		expect(bashWrote("alice", guarded, "alice's sed\n")).toContain(guarded);
		expect(readBlobContent(store.observationState(guarded, "alice").was)).toBe(
			"alice's sed\n",
		);
	});

	it("mints no lock on either tier, so nothing is refused on an inference (mantahostels#288)", () => {
		bashWrote("alice", auditScript, "alice's sed\n");
		bashWrote("alice", guarded, "alice's sed\n");
		expect(locks()).toEqual([]);
	});

	it("reads a session's first Bash call as unknown, never as changed (mantahostels#158)", () => {
		const me = live(sb, "alice");
		write(auditScript, "changed before this session ever scanned\n");
		// No previous snapshot: the tier's state predates the session, and a
		// migration that read it as changed would baseline the whole repo.
		expect(store.scanChanged("alice")).toEqual([]);
		expect(store.observationState(auditScript, me.sessionId).state).toBe(
			"unknown",
		);
	});

	it("baselines a file the session created, which has no other record at all", () => {
		const newRel = "scripts/brand-new.py";
		live(sb, "alice");
		store.scanChanged("alice");
		write(newRel, "created from a heredoc\n");
		expect(store.scanChanged("alice")).toContain(newRel);
	});

	it("returns nothing for a deletion, which has no bytes left to pin", () => {
		live(sb, "alice");
		store.scanChanged("alice");
		fs.rmSync(path.join(sb.repo, auditScript));
		expect(store.scanChanged("alice")).not.toContain(auditScript);
	});

	it("leaves a path the session HOLDS to its claim, minting no second baseline", () => {
		// Two baselines for one writer would pin two versions and disagree about
		// which is "what I last wrote".
		const me = live(sb, "alice");
		store.acquire(auditScript, me);
		store.recordContent(auditScript, me);
		store.scanChanged("alice");
		write(auditScript, "alice's own sed\n");

		expect(store.scanChanged("alice")).toContain(auditScript);
		expect(
			store.recordObservation(auditScript, me, { viaBash: true }),
		).toBeNull();
		expect(store.recordContent(auditScript, me)).toBeTruthy();
		expect(
			store.contentState(
				auditScript,
				core.readRecord(store.paths.lock(auditScript)),
			).state,
		).toBe("same");
	});

	it("caps one scan's mints, and still reports the rest on the next call", () => {
		// A `git pull` moves the whole tier at once. Uncapped, the mints overrun
		// the hook's `timeout 5` and the tick is lost entirely — so the paths over
		// the cap keep their OLD hash rather than being silently skipped.
		const cap = 20; // SCAN_MINT_MAX in lib/arbiter-snapshots.js
		const many = Array.from(
			{ length: cap + 5 },
			(_, i) => `scripts/gen-${i}.py`,
		);
		for (const rel of many) write(rel, "v1\n");
		live(sb, "alice");
		store.scanChanged("alice");
		for (const rel of many) write(rel, "v2\n");

		const first = store.scanChanged("alice");
		expect(first).toHaveLength(cap);
		const second = store.scanChanged("alice");
		expect(second).toHaveLength(5);
		expect(new Set([...first, ...second]).size).toBe(many.length);
	});

	it("says nothing twice about bytes that have not moved since", () => {
		bashWrote("alice", auditScript, "alice's sed\n");
		expect(store.scanChanged("alice")).toEqual([]);
	});

	it("keeps one session's scan out of another's", () => {
		// The diff is against THIS session's own previous snapshot, so a neighbour's
		// quiet spell does not make its files read as unchanged for everyone.
		live(sb, "alice");
		live(sb, "bob");
		store.scanChanged("alice");
		write(auditScript, "alice's sed\n");
		expect(store.scanChanged("alice")).toContain(auditScript);
		expect(store.scanChanged("bob")).toEqual([]);
	});

	it("survives a symlink in the tier, which aborts a batched hash-object", () => {
		// One unhashable path fails the whole batch, and the output is positional,
		// so a partial answer would mis-attribute every hash after it.
		fs.symlinkSync(sb.dir, path.join(sb.repo, "scripts", "linked"));
		live(sb, "alice");
		store.scanChanged("alice");
		write(auditScript, "alice's sed\n");
		expect(store.scanChanged("alice")).toContain(auditScript);
	});
});

describe("the tier scan re-hashes only what moved (#833)", () => {
	// A file whose size, mtime and ctime match the previous scan keeps the blob
	// id it had — unless that scan read it inside the racy window, where a
	// same-tick rewrite would leave its stat unchanged.
	const auditScript = "scripts/evidence-audit.py";
	const abs = (rel: string) => path.join(sb.repo, rel);

	/**
	 * Run `body` with a `git` at WFC_GIT that logs each hash-object batch's paths,
	 * and return them, one array per spawn. The scan shells out directly, so
	 * there is nothing to spy on.
	 */
	const readHashedDuring = (body: () => void): string[][] => {
		const log = path.join(sb.dir, "hash-object.log");
		const { git } = writeFaultyGit(
			{ first: "hash-object" },
			{
				script: [
					`echo -- >> ${shellQuote(log)}`,
					`tee -a ${shellQuote(log)} | "$REAL_GIT" "$@"`,
					"exit",
				].join("\n"),
			},
			{ under: sb.dir },
		);
		vi.stubEnv("WFC_GIT", git);
		body();
		if (!fs.existsSync(log)) return [];
		return fs
			.readFileSync(log, "utf8")
			.split("--\n")
			.slice(1)
			.map((batch) => batch.split("\n").filter(Boolean));
	};

	/** Outlast the one-second racy window, so files written so far are trusted on their stat. */
	const settle = () => sleepSync(1100);

	beforeEach(() => {
		execFileSync("git", ["init", "-q"], { cwd: sb.repo });
		fs.mkdirSync(path.dirname(abs(auditScript)), { recursive: true });
		fs.writeFileSync(abs(auditScript), "seeded\n");
		live(sb, "alice");
	});

	it("spawns no hash-object when nothing moved", () => {
		settle();
		store.scanChanged("alice");
		expect(readHashedDuring(() => store.scanChanged("alice"))).toEqual([]);
	});

	it("re-hashes a file the previous scan read inside the racy window", () => {
		store.scanChanged("alice");
		expect(readHashedDuring(() => store.scanChanged("alice"))).toEqual([
			[auditScript],
		]);
	});

	it("reports a same-size rewrite with its mtime set back", () => {
		// `cp -p` or `touch -r` after a rewrite: size and mtime both match, so
		// only ctime — which userland cannot set — says the bytes moved.
		// A whole second, so setting it back restores every nanosecond of it.
		const second = Math.floor(Date.now() / 1000) - 3600;
		fs.utimesSync(abs(auditScript), second, second);
		settle();
		store.scanChanged("alice");
		fs.writeFileSync(abs(auditScript), "SEEDED\n");
		fs.utimesSync(abs(auditScript), second, second);
		expect(store.scanChanged("alice")).toEqual([auditScript]);
	});

	it("reports a same-size rewrite in the same second as the scan", () => {
		store.scanChanged("alice");
		fs.writeFileSync(abs(auditScript), "SEEDED\n");
		expect(store.scanChanged("alice")).toEqual([auditScript]);
	});

	it("reads an unparseable header as hash-everything, never as a wall of changes", () => {
		fs.writeFileSync(abs("scripts/untouched.py"), "left alone\n");
		store.scanChanged("alice");
		const file = store.paths.snapshot("alice");
		const [, ...rest] = fs.readFileSync(file, "utf8").split("\n");
		fs.writeFileSync(file, ["#trust-ctime-before junk", ...rest].join("\n"));
		fs.writeFileSync(abs(auditScript), "moved\n");
		expect(store.scanChanged("alice")).toEqual([auditScript]);
	});

	it("keeps a path with a space in it across scans", () => {
		const spaced = "scripts/two words.py";
		fs.writeFileSync(abs(spaced), "v1\n");
		store.scanChanged("alice");
		fs.writeFileSync(abs(spaced), "v2\n");
		expect(store.scanChanged("alice")).toEqual([spaced]);
		expect(store.scanChanged("alice")).toEqual([]);
	});
});

describe("the snapshot sweep — per-session state goes with the session (mantahostels#419)", () => {
	// Reached through pruneAll: the other families are empty in this sandbox.
	const snapshot = (sessionId: string) => store.paths.snapshot(sessionId);
	const seed = (sessionId: string, ageMs: number) => {
		fs.mkdirSync(store.paths.snapshotsDir(), { recursive: true });
		fs.writeFileSync(snapshot(sessionId), "deadbeef scripts/x.py\n");
		const when = Date.now() - ageMs;
		fs.utimesSync(snapshot(sessionId), when / 1000, when / 1000);
	};
	const pastWeek = 8 * 24 * 60 * 60 * 1000;

	it("spares a live session's snapshot however old it is", () => {
		// mtime is that session's last Bash call, and a resumed session keeps its id
		// across a quiet week — sweeping under it would lose every baseline it has.
		live(sb, "alice");
		seed("alice", pastWeek);

		store.pruneAll(noSessions);
		expect(fs.existsSync(snapshot("alice"))).toBe(true);
	});

	it("still sweeps a finished session's aged snapshot", () => {
		finished(sb, "bob");
		seed("bob", pastWeek);

		store.pruneAll(noSessions);
		expect(fs.existsSync(snapshot("bob"))).toBe(false);
	});
});
