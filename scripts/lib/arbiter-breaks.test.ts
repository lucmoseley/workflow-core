// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assert, beforeEach, describe, expect, it } from "vitest";
import {
	acquireSeeing,
	breaks,
	buildLockRecord,
	DEAD,
	durably,
	freshSandbox,
	live,
	liveHolder,
	noSessions,
	readBreakAt,
	readLockAt,
	store,
} from "./arbiter-testkit";
import { defineTemplate, emptyRepoTemplate } from "./git-fixture";

const sb = freshSandbox();
const sandboxRepo = defineTemplate((dir) => {
	emptyRepoTemplate(dir);
	fs.mkdirSync(path.join(dir, "docs"));
});

const put = (rel: string, fields: object) => {
	fs.mkdirSync(store.paths.locksDir(), { recursive: true });
	const p = store.paths.lock(rel);
	fs.writeFileSync(
		p,
		JSON.stringify(buildLockRecord({ path: rel, ...fields })),
	);
	return p;
};

describe("a broken claim — the clobber the content record could not reach (mantahostels#349)", () => {
	const rel = "scripts/evidence-audit.py";
	const abs = () => path.join(sb.repo, rel);

	beforeEach(() => {
		sandboxRepo.instantiate(sb.repo);
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

	const staleClaim = (text: string, sessionId = "alice", pin = true) => {
		fs.mkdirSync(path.dirname(abs()), { recursive: true });
		fs.writeFileSync(abs(), text);
		const me = live(sb, sessionId);
		store.acquire(rel, me);
		const blob = pin ? store.recordContent(rel, me) : null;
		const lock = { ...readLockAt(store.paths.lock(rel)), ...DEAD };
		fs.writeFileSync(store.paths.lock(rel), JSON.stringify(lock));
		return { blob, lock };
	};

	const breakAs = (sessionId: string) =>
		store.acquire(rel, live(sb, sessionId)).verdict;

	it("records what the break destroyed — both sessions, and the blob", () => {
		const { blob, lock } = staleClaim("alice's work\n");

		expect(breakAs("bob")).toBe("claimed");

		expect(breaks.readBrokenClaimIds()).toEqual(new Set([lock.claimId]));
		const notice = breaks.buildBreakNotice(rel, "alice");
		expect(notice).toContain(`claim on ${rel} was broken`);
		expect(notice).toContain("by bob");
		expect(notice).toContain(`git cat-file -p ${blob}`);
	});

	it("records nothing when the lock went back", () => {
		const existing = buildLockRecord({ path: rel, ...DEAD });
		put(rel, { ...liveHolder(), claimId: "fresh" });

		expect(acquireSeeing(rel, existing, durably("bob")).verdict).toBe("held");
		expect(breaks.readBrokenClaimIds()).toEqual(new Set());
	});

	it("records nothing when a session breaks its own stale lock", () => {
		staleClaim("alice's work\n");

		expect(breakAs("alice")).toBe("claimed");
		expect(breaks.buildBreakNotice(rel, "alice")).toBeNull();
		expect(breaks.readBrokenClaimIds()).toEqual(new Set());
	});

	it("keeps the pin, so the lost version survives a gc after the break", () => {
		const { blob } = staleClaim("alice's work\n");
		assert(blob);
		breakAs("bob");
		fs.writeFileSync(abs(), "bob's replacement\n");

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
		const { lock } = staleClaim("alice's work\n");
		breakAs("bob");
		const file = store.paths.break(rel, lock.claimId);
		fs.writeFileSync(
			file,
			JSON.stringify({
				...readBreakAt(file),
				at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
			}),
		);

		store.pruneAll(noSessions);
		expect(fs.existsSync(file)).toBe(false);
		expect(readRefs()).toEqual([]);
	});

	it("ages a break from when it happened, not from when it was read", () => {
		const { lock } = staleClaim("alice's work\n");
		breakAs("bob");
		const file = store.paths.break(rel, lock.claimId);
		const record = readBreakAt(file);
		fs.writeFileSync(
			file,
			JSON.stringify({
				...record,
				at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
			}),
		);

		store.buildBreakNotice(rel, "alice");
		breaks.pruneBreaks();
		expect(fs.existsSync(file)).toBe(false);
	});

	it("keeps every pin when one record will not parse", () => {
		const { lock } = staleClaim("alice's work\n");
		breakAs("bob");
		fs.writeFileSync(store.paths.break(rel, lock.claimId), "{not json");

		store.pruneAll(noSessions);
		expect(readRefs()).toEqual([`refs/arbiter/${lock.claimId}`]);
	});

	it("ages out a record that will not parse, so nothing is pinned for ever", () => {
		const { lock } = staleClaim("alice's work\n");
		breakAs("bob");
		const file = store.paths.break(rel, lock.claimId);
		fs.writeFileSync(file, "{not json");
		const old = new Date(Date.now() - 30 * 86_400_000);
		fs.utimesSync(file, old, old);

		breaks.pruneBreaks();
		expect(fs.existsSync(file)).toBe(false);
	});

	it("keeps both breaks of lock records that would not parse", () => {
		breaks.recordBreak(rel, null, durably("bob"));
		breaks.recordBreak(rel, null, durably("bob"));
		expect(fs.readdirSync(store.paths.breaksDir())).toHaveLength(2);
	});

	it("keeps a pin the lock store alone would have collected", () => {
		const { lock } = staleClaim("alice's work\n");
		breakAs("bob");

		store.pruneAll(noSessions);
		expect(readRefs()).toEqual([`refs/arbiter/${lock.claimId}`]);
	});

	it("deletes no pin when the break records cannot be read", () => {
		const { lock } = staleClaim("alice's work\n");
		breakAs("bob");
		fs.rmSync(store.paths.breaksDir(), { recursive: true, force: true });
		fs.writeFileSync(store.paths.breaksDir(), "not a directory");

		store.pruneAll(noSessions);
		expect(readRefs()).toEqual([`refs/arbiter/${lock.claimId}`]);
		expect(fs.readFileSync(sb.errorLog(), "utf8")).toContain("pruneBlobRefs");
	});

	it("frees the path anyway when the record cannot be written, and logs the fault", () => {
		staleClaim("alice's work\n");
		fs.mkdirSync(store.stateDir(), { recursive: true });
		fs.writeFileSync(store.paths.breaksDir(), "not a directory");

		expect(breakAs("bob")).toBe("claimed");
		expect(readLockAt(store.paths.lock(rel)).sessionId).toBe("bob");
		expect(fs.readFileSync(sb.errorLog(), "utf8")).toContain(`break ${rel}`);
	});

	describe("the notice — the losing session, when it comes back to the file", () => {
		it("names the breaker and how to get the version back", () => {
			const { blob } = staleClaim("alice's work\n");
			breakAs("bob");

			const notice = store.buildBreakNotice(rel, "alice");
			expect(notice).toContain("bob");
			expect(notice).toContain(`git cat-file -p ${blob}`);
		});

		it("says nothing to the session that did the breaking", () => {
			staleClaim("alice's work\n");
			breakAs("bob");
			expect(store.buildBreakNotice(rel, "bob")).toBeNull();
		});

		it("says nothing about a path this session never lost", () => {
			staleClaim("alice's work\n");
			breakAs("bob");
			expect(store.buildBreakNotice("docs/doc-map.md", "alice")).toBeNull();
		});

		it("is said once, not on every write for a week", () => {
			staleClaim("alice's work\n");
			breakAs("bob");

			expect(store.buildBreakNotice(rel, "alice")).toBeTruthy();
			expect(store.buildBreakNotice(rel, "alice")).toBeNull();
		});

		it("says the version is gone where the broken claim recorded none", () => {
			staleClaim("alice's work\n", "alice", false);
			breakAs("bob");

			const notice = store.buildBreakNotice(rel, "alice");
			expect(notice).toContain("not recoverable");
			expect(notice).not.toContain("cat-file");
		});
	});
});
