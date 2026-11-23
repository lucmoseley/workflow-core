// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
	core,
	finished,
	freshSandbox,
	listedLocks,
	live,
	noSessions,
	store,
} from "./arbiter-testkit";
import { writeFaultyGit } from "./git-fault-fake";
import { defineTemplate, emptyRepoTemplate } from "./git-fixture";
import { shellQuote } from "./sh-quote.js";
import { sleepSync } from "./sleep-sync.js";

const sb = freshSandbox();
const sandboxRepo = defineTemplate((dir) => {
	emptyRepoTemplate(dir);
	fs.mkdirSync(path.join(dir, "docs"));
});

describe("the tier scan — a baseline for a write no hook ever sees (mantahostels#419)", () => {
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
	const locks = () => listedLocks().map((l) => l.path);

	const bashWrote = (sessionId: string, rel: string, text: string) => {
		const me = live(sb, sessionId);
		store.scanChanged(sessionId);
		write(rel, text);
		const changed = store.scanChanged(sessionId);
		for (const p of changed) store.recordObservation(p, me, { viaBash: true });
		return changed;
	};

	beforeEach(() => {
		sandboxRepo.instantiate(sb.repo);
		write(auditScript, "seeded\n");
		write(guarded, "seeded\n");
	});

	it("gives a session that only ever Bash-wrote a path its own baseline and pin", () => {
		expect(bashWrote("alice", auditScript, "alice's sed\n")).toContain(
			auditScript,
		);

		const seen = store.observationState(auditScript, "alice");
		expect(seen.state).toBe("same");
		assert(seen.was);
		expect(readBlobContent(seen.was)).toBe("alice's sed\n");

		write(auditScript, "clobbered by a neighbour\n");
		execFileSync("git", ["gc", "--prune=now", "-q"], { cwd: sb.repo });
		const after = store.observationState(auditScript, "alice");
		expect(after.state).toBe("changed");
		assert(after.was);
		expect(readBlobContent(after.was)).toBe("alice's sed\n");
	});

	it("skips an exempt path though its pathspec still names it", () => {
		expect(
			bashWrote("alice", ".claude/tmp/scratch.md", "scratch\n"),
		).not.toContain(".claude/tmp/scratch.md");
	});

	it("covers the refusing tier too, where a `git restore` walks past the guard", () => {
		expect(bashWrote("alice", guarded, "alice's sed\n")).toContain(guarded);
		const { was } = store.observationState(guarded, "alice");
		assert(was);
		expect(readBlobContent(was)).toBe("alice's sed\n");
	});

	it("mints no lock on either tier, so nothing is refused on an inference (mantahostels#288)", () => {
		bashWrote("alice", auditScript, "alice's sed\n");
		bashWrote("alice", guarded, "alice's sed\n");
		expect(locks()).toEqual([]);
	});

	it("reads a session's first Bash call as unknown, never as changed (mantahostels#158)", () => {
		const me = live(sb, "alice");
		write(auditScript, "changed before this session ever scanned\n");
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
		const cap = 20;
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
		live(sb, "alice");
		live(sb, "bob");
		store.scanChanged("alice");
		write(auditScript, "alice's sed\n");
		expect(store.scanChanged("alice")).toContain(auditScript);
		expect(store.scanChanged("bob")).toEqual([]);
	});

	it("survives a symlink in the tier, which aborts a batched hash-object", () => {
		fs.symlinkSync(sb.dir, path.join(sb.repo, "scripts", "linked"));
		live(sb, "alice");
		store.scanChanged("alice");
		write(auditScript, "alice's sed\n");
		expect(store.scanChanged("alice")).toContain(auditScript);
	});
});

describe("the tier scan re-hashes only what moved (#833)", () => {
	const auditScript = "scripts/evidence-audit.py";
	const abs = (rel: string) => path.join(sb.repo, rel);

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

	const settle = () => sleepSync(1100);

	beforeEach(() => {
		sandboxRepo.instantiate(sb.repo);
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
	const snapshot = (sessionId: string) => store.paths.snapshot(sessionId);
	const seed = (sessionId: string, ageMs: number) => {
		fs.mkdirSync(store.paths.snapshotsDir(), { recursive: true });
		fs.writeFileSync(snapshot(sessionId), "deadbeef scripts/x.py\n");
		const when = Date.now() - ageMs;
		fs.utimesSync(snapshot(sessionId), when / 1000, when / 1000);
	};
	const pastWeek = 8 * 24 * 60 * 60 * 1000;

	it("spares a live session's snapshot however old it is", () => {
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
