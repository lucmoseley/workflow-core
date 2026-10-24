// @vitest-environment node
/*
 * arbiter-sweep.js's own suite: `pruneAll` clears every aged family in one
 * call, and on an unreadable sessions registry sweeps nothing session-keyed
 * while still sweeping the families keyed to no session (mantahostels#1796,
 * mantahostels#174).
 *
 * One aged record per family is seeded in arbiter-testkit's sandbox, backdated
 * with `utimes`, so a week's ageing needs no wait and the founder's live
 * registry is never read.
 *
 * `pruneAll` runs detached at every `SessionStart`: loosen a case here and a
 * family stops being swept and its state grows unbounded, or an unreadable
 * registry lets the sweep delete a live session's state.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	durably,
	finished,
	freshSandbox,
	noSessions,
	store,
} from "./arbiter-testkit";

/** Since F8 (mantahostels#3515, #2): under .claude/tmp/markers/, not the repo
 * root directly. */
const markersDir = () =>
	createRequire(__filename)("./marker-root.js").markersDir(sb.repo);

const sb = freshSandbox();

describe("pruneAll — the session-start sweep as one call (mantahostels#1796)", () => {
	const pastWeek = 8 * 24 * 60 * 60 * 1000;
	const pastDay = 25 * 60 * 60 * 1000;
	const pastBackstop = 49 * 60 * 60 * 1000;

	/* pastBackstop clears every unspared family's age at once. */
	const age = (file: string, ms: number) => {
		const t = (Date.now() - ms) / 1000;
		fs.utimesSync(file, t, t);
	};
	const only = (dir: string) => path.join(dir, fs.readdirSync(dir)[0]);

	/**
	 * One aged-out record in each family this describe covers, all left by "bob".
	 * NOT every family pruneAll runs: the two pin-holding ones — observations and
	 * break records — are covered where their pins are, at mantahostels#363's and mantahostels#349's own
	 * describes.
	 */
	const seedAll = () => {
		finished(sb, "bob");

		const marker = path.join(markersDir(), ".concision-base-bob");
		fs.mkdirSync(path.dirname(marker), { recursive: true });
		fs.writeFileSync(marker, "");
		age(marker, pastDay);

		fs.mkdirSync(store.paths.snapshotsDir(), { recursive: true });
		const snapshot = store.paths.snapshot("bob");
		fs.writeFileSync(snapshot, "deadbeef scripts/x.py\n");
		age(snapshot, pastWeek);

		store.claimIssue(1796, { sessionId: "bob" });
		const claim = only(store.paths.issueClaimsDir());
		age(claim, pastWeek);

		store.recordWant("docs/a.md", durably("bob"), "alice");
		const want = only(store.paths.wantsDir());
		age(want, pastBackstop);

		store.recordRequest("docs/b.md", durably("bob"), "alice", null);
		const request = only(store.paths.requestsDir());
		age(request, pastBackstop);

		return { marker, snapshot, claim, want, request };
	};

	it("clears each aged table family, and the markers and issue claims, in one call", () => {
		const seeded = seedAll();
		store.pruneAll(noSessions);
		for (const [family, file] of Object.entries(seeded))
			expect([family, fs.existsSync(file)]).toEqual([family, false]);
	});

	it("sweeps nothing and names each session-keyed family when the registry cannot be read (mantahostels#174)", () => {
		const seeded = seedAll();
		fs.rmSync(path.join(sb.home, "sessions"), { recursive: true, force: true });
		fs.writeFileSync(path.join(sb.home, "sessions"), "not a directory");

		store.pruneAll(noSessions);

		for (const file of [seeded.marker, seeded.snapshot, seeded.claim])
			expect(fs.existsSync(file)).toBe(true);
		// A family keyed to no session reads no registry, so it must still sweep.
		// Without this, a bail-out of the whole loop passes.
		for (const file of [seeded.want, seeded.request])
			expect(fs.existsSync(file)).toBe(false);
		const log = fs.readFileSync(sb.errorLog(), "utf8");
		for (const family of ["pruneMarkers", "pruneSnapshots", "pruneIssueClaims"])
			expect(log).toContain(family);
	});
});
