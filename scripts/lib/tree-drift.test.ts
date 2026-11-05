// @vitest-environment node
/*
 * tree-drift.js names what moved in the working tree while a run was reading
 * it, and the tree a run actually saw at its end, without ever failing the run
 * (mantahostels#273, mantahostels#392, mantahostels#2187).
 *
 * Exercised inside a throwaway repository: the assertions are about a tree
 * changing mid-window, which cannot be arranged against this repo without
 * writing to it.
 *
 * The suite reporters and the test-pass marker read it on every run; loosen a
 * case and a red caused by a neighbour's half-written file reads as the
 * session's own, or a certificate over a moving tree is recorded as clean.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const {
	readTreeSnapshot,
	drift,
	format,
	neighbourDirty,
	endOfRunTreeIdentity,
} = require("./tree-drift.js");

/** A lock as `arbiter-store.listLocks()` returns it. */
const lock = (
	filePath: string,
	sessionId: string,
	extra: Record<string, unknown> = {},
) => ({ path: filePath, sessionId, pid: 4242, alive: true, ...extra });

let repo: string;

const unreadableFs = {
	readFileSync: () => {
		throw new Error("EBUSY");
	},
};

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" });

const write = (file: string, body: string) => {
	fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
	fs.writeFileSync(path.join(repo, file), body);
};

beforeEach(() => {
	repo = fs.mkdtempSync(path.join(os.tmpdir(), "tree-drift-test-"));
	git("init", "-q", ".");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	write("src/a.js", "one\n");
	write("src/b.js", "two\n");
	git("add", "--", "src/a.js", "src/b.js");
	git("commit", "-qm", "first");
});
afterEach(() => {
	fs.rmSync(repo, { recursive: true, force: true });
});

describe("readTreeSnapshot", () => {
	it("hashes a dirty tracked file and ignores a clean one", () => {
		write("src/a.js", "edited\n");
		const s = readTreeSnapshot(repo);
		expect(Object.keys(s.files)).toEqual(["src/a.js"]);
		expect(s.head).toMatch(/^[0-9a-f]{40}$/);
	});

	it("says nothing about a clean tree, tracked or untracked", () => {
		expect(readTreeSnapshot(repo)).toMatchObject({ files: {}, untracked: [] });
	});

	it("takes the new name of a rename, which is what a later run finds", () => {
		git("mv", "src/a.js", "src/c.js");
		expect(Object.keys(readTreeSnapshot(repo).files)).toEqual(["src/c.js"]);
	});

	it("keeps an untracked file out of files, where drift would see it", () => {
		write("scratch.log", "noise\n");
		expect(Object.keys(readTreeSnapshot(repo).files)).toEqual([]);
	});

	it("carries an untracked file separately, for the attribution to read", () => {
		write("scratch.log", "noise\n");
		expect(readTreeSnapshot(repo).untracked).toEqual(["scratch.log"]);
	});

	it("names each file in a wholly-new directory, not the directory", () => {
		write("newdir/sub/mod.js", "half-written\n");
		write("newdir/other.js", "half-written\n");

		expect(readTreeSnapshot(repo).untracked).toEqual([
			"newdir/other.js",
			"newdir/sub/mod.js",
		]);
	});

	it("does not report a new file as drift, the two lists being separate", () => {
		const before = readTreeSnapshot(repo);
		write("src/new.js", "appeared mid-run\n");

		expect(drift(before, readTreeSnapshot(repo))).toBeNull();
	});

	it("returns null where git cannot answer, so no drift is claimed", () => {
		const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "tree-drift-bare-"));
		try {
			expect(readTreeSnapshot(notARepo)).toBeNull();
		} finally {
			fs.rmSync(notARepo, { recursive: true, force: true });
		}
	});

	it("stands a marker in for a file it cannot read, never throwing", () => {
		write("src/a.js", "edited\n");
		expect(readTreeSnapshot(repo, { fs: unreadableFs }).files["src/a.js"]).toBe(
			"unreadable",
		);
	});

	it("marks an unreadable file the same way twice", () => {
		write("src/a.js", "edited\n");
		const before = readTreeSnapshot(repo, { fs: unreadableFs });

		// A clock in the sentinel would make this pair differ and cry drift on
		// every run holding one unreadable path.
		expect(
			drift(before, readTreeSnapshot(repo, { fs: unreadableFs })),
		).toBeNull();
	});
});

describe("endOfRunTreeIdentity (mantahostels#2187)", () => {
	it("on a still tree, equals HEAD's own tree", () => {
		expect(endOfRunTreeIdentity(repo)).toBe(
			git("rev-parse", "HEAD^{tree}").trim(),
		);
	});

	it("differs from HEAD's tree once a tracked file is dirty", () => {
		const clean = endOfRunTreeIdentity(repo);
		write("src/a.js", "edited mid-run\n");

		expect(endOfRunTreeIdentity(repo)).not.toBe(clean);
	});

	it("leaves HEAD, the index, the working tree and the stash list untouched", () => {
		write("src/a.js", "edited mid-run\n");
		const headBefore = git("rev-parse", "HEAD").trim();
		const index = path.join(repo, ".git/index");
		const indexBefore = fs.readFileSync(index);
		const indexMtime = fs.statSync(index).mtimeMs;

		endOfRunTreeIdentity(repo);

		expect(git("rev-parse", "HEAD").trim()).toBe(headBefore);
		expect(fs.readFileSync(path.join(repo, "src/a.js"), "utf8")).toBe(
			"edited mid-run\n",
		);
		expect(git("stash", "list").trim()).toBe("");
		expect(fs.readFileSync(index).equals(indexBefore)).toBe(true);
		expect(fs.statSync(index).mtimeMs).toBe(indexMtime);
	});

	it("ignores an untracked file — no tracked dirt", () => {
		const clean = endOfRunTreeIdentity(repo);
		write("scratch.log", "noise\n");

		expect(endOfRunTreeIdentity(repo)).toBe(clean);
	});

	it("returns null where git cannot answer", () => {
		const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), "tree-drift-bare-"));
		try {
			expect(endOfRunTreeIdentity(notARepo)).toBeNull();
		} finally {
			fs.rmSync(notARepo, { recursive: true, force: true });
		}
	});

	it("reads what the tree held at the END of the window, not the start", () => {
		const atStart = endOfRunTreeIdentity(repo);
		write("src/a.js", "changed while the suite ran\n");
		const atEnd = endOfRunTreeIdentity(repo);

		expect(atEnd).not.toBe(atStart);
	});

	const stashTree = () =>
		git("rev-parse", `${git("stash", "create").trim()}^{tree}`).trim();

	it.each([
		["an unstaged edit", () => write("src/a.js", "edited\n")],
		["a deletion", () => fs.rmSync(path.join(repo, "src/b.js"))],
		[
			"a staged new file",
			() => {
				write("src/c.js", "new\n");
				git("add", "--", "src/c.js");
			},
		],
		[
			"a staged edit edited again",
			() => {
				write("src/a.js", "staged\n");
				git("add", "--", "src/a.js");
				write("src/a.js", "then edited\n");
			},
		],
	])("gives the tree `git stash create` gives, on %s (#2104)", (_, dirty) => {
		dirty();
		expect(endOfRunTreeIdentity(repo)).toBe(stashTree());
	});

	/*
	 * Deterministic racy entry: the index caches a.js's stat while a.js is
	 * older than it, then a same-size edit keeps that stat and the index is
	 * re-stamped to a.js's time. Only git's racy check (file not older than
	 * the index) catches the edit — what a fresh-stamped index copy loses.
	 */
	it("sees a same-size edit only the racy check catches (#2104)", () => {
		git("config", "core.trustctime", "false");
		const file = path.join(repo, "src/a.js");
		const index = path.join(repo, ".git/index");
		const old = new Date("2020-01-01T00:00:00Z");
		fs.utimesSync(file, old, old);
		git("update-index", "--really-refresh");
		write("src/a.js", "ONE\n");
		fs.utimesSync(file, old, old);
		fs.utimesSync(index, old, old);

		const tree = endOfRunTreeIdentity(repo);

		expect(tree).not.toBe(git("rev-parse", "HEAD^{tree}").trim());
		expect(tree).toBe(stashTree());
	});

	it("answers on a dirty tree while a neighbour holds the index lock, never writing the shared index (#2104)", () => {
		write("src/a.js", "edited\n");
		const expected = stashTree();
		const index = path.join(repo, ".git/index");
		const indexBefore = fs.readFileSync(index);
		fs.writeFileSync(path.join(repo, ".git/index.lock"), "");

		expect(endOfRunTreeIdentity(repo)).toBe(expected);
		expect(fs.readFileSync(index).equals(indexBefore)).toBe(true);
		expect(fs.readFileSync(path.join(repo, ".git/index.lock"), "utf8")).toBe(
			"",
		);
	});

	/*
	 * An unmerged path reads as UNKNOWN — never as a match on HEAD's own tree,
	 * the one value a reader must not mistake for "nothing moved"
	 * (mantahostels#2187's own point), and never as the tree `add -u` would make
	 * by staging the conflict markers.
	 */
	it("reads UNKNOWN, not HEAD's tree, on an unmerged path", () => {
		git("checkout", "-qb", "feature");
		write("src/a.js", "feature\n");
		git("commit", "-qam", "feature edit");
		git("checkout", "-q", "master");
		write("src/a.js", "master\n");
		git("commit", "-qam", "master edit");
		try {
			git("merge", "-q", "feature");
		} catch {
			/* the conflict is the point */
		}

		expect(endOfRunTreeIdentity(repo)).toBeNull();
	});
});

describe("drift", () => {
	it("says nothing when the tree did not move", () => {
		write("src/a.js", "edited\n");
		const before = readTreeSnapshot(repo);
		expect(drift(before, readTreeSnapshot(repo))).toBeNull();
	});

	it("reports a dirty file whose content changed under it — the mantahostels#273 shape", () => {
		write("src/a.js", "edited\n");
		const before = readTreeSnapshot(repo);
		write("src/a.js", "edited again\n");

		const d = drift(before, readTreeSnapshot(repo));
		expect(d.moved).toEqual([{ path: "src/a.js", kind: "changed" }]);
		expect(d.headMoved).toBe(false);
	});

	it("reports a clean file a neighbour started editing mid-run", () => {
		const before = readTreeSnapshot(repo);
		write("src/b.js", "touched\n");

		expect(drift(before, readTreeSnapshot(repo)).moved).toEqual([
			{ path: "src/b.js", kind: "appeared" },
		]);
	});

	it("reports a file that stopped being dirty, ie a neighbour committing", () => {
		write("src/a.js", "edited\n");
		const before = readTreeSnapshot(repo);
		git("add", "--", "src/a.js");
		git("commit", "-qm", "neighbour");

		const d = drift(before, readTreeSnapshot(repo));
		expect(d.moved).toEqual([{ path: "src/a.js", kind: "settled" }]);
		expect(d.headMoved).toBe(true);
	});

	it("reports a HEAD move on its own, with no file left dirty", () => {
		const before = readTreeSnapshot(repo);
		write("src/c.js", "new\n");
		git("add", "--", "src/c.js");
		git("commit", "-qm", "neighbour");

		const d = drift(before, readTreeSnapshot(repo));
		expect(d.headMoved).toBe(true);
		expect(d.moved).toEqual([]);
	});

	/*
	 * The boundary of the window comparison: a file left half-written BEFORE
	 * the window opened breaks the suite exactly as mantahostels#273 did, and
	 * `drift` reports nothing (mantahostels#291).
	 */
	it("cannot see a file left half-written before the window opened", () => {
		write("src/a.js", "half-written, and nobody touches it again\n");
		const before = readTreeSnapshot(repo);

		expect(drift(before, readTreeSnapshot(repo))).toBeNull();
	});

	it("claims no drift when either snapshot is missing", () => {
		expect(drift(null, readTreeSnapshot(repo))).toBeNull();
		expect(drift(readTreeSnapshot(repo), null)).toBeNull();
	});
});

describe("format", () => {
	it("says nothing where there is no drift", () => {
		expect(format(null)).toBeNull();
	});

	it("names the issue", () => {
		const out = format({
			headMoved: false,
			moved: [{ path: "x", kind: "changed" }],
		});
		expect(out).toContain("#273");
		expect(out).toContain("changed  x");
	});

	it("says a neighbour committed when HEAD moved", () => {
		expect(format({ headMoved: true, moved: [] })).toContain("HEAD moved");
	});

	it("caps the list, so a big rebase cannot bury the summary", () => {
		const moved = Array.from({ length: 15 }, (_, i) => ({
			path: `f${i}`,
			kind: "changed",
		}));
		const out = format({ headMoved: false, moved }, 12);
		expect(out).toContain("… and 3 more");
		// The count line prints whether or not the list was actually cut, so the
		// cap is only proven by the entries themselves being absent.
		expect(out.match(/^ {3}changed {2}f\d+$/gm)).toHaveLength(12);
		expect(out).not.toMatch(/\bf1[234]\b/);
	});
});

describe("neighbourDirty", () => {
	it("names a file a live neighbour left dirty before the run", () => {
		write("src/a.js", "half-written\n");
		const before = readTreeSnapshot(repo);

		expect(neighbourDirty(before, [lock("src/a.js", "them")], "me")).toEqual([
			{ path: "src/a.js", sessionId: "them", pid: 4242, dead: false },
		]);
	});

	it("names a NEW file a neighbour is part-way through writing", () => {
		write("src/new.js", "half-written\n");
		const before = readTreeSnapshot(repo);

		expect(neighbourDirty(before, [lock("src/new.js", "them")], "me")).toEqual([
			{ path: "src/new.js", sessionId: "them", pid: 4242, dead: false },
		]);
	});

	it("says nothing about a file this session holds itself", () => {
		write("src/a.js", "my own work\n");
		const before = readTreeSnapshot(repo);

		expect(neighbourDirty(before, [lock("src/a.js", "me")], "me")).toBeNull();
	});

	it("says nothing about a dirty file under no claim at all", () => {
		write("src/a.js", "nobody claims this\n");
		const before = readTreeSnapshot(repo);

		expect(neighbourDirty(before, [], "me")).toBeNull();
	});

	it("says nothing about a claimed file that is clean", () => {
		const before = readTreeSnapshot(repo);

		expect(neighbourDirty(before, [lock("src/a.js", "them")], "me")).toBeNull();
	});

	it("names a dead holder's file, which breaks a run just the same", () => {
		write("src/a.js", "left behind\n");
		const before = readTreeSnapshot(repo);

		expect(
			neighbourDirty(
				before,
				[
					lock("src/a.js", "them", {
						alive: false,
						claimedAt: new Date().toISOString(),
					}),
				],
				"me",
			),
		).toEqual([{ path: "src/a.js", sessionId: "them", pid: 4242, dead: true }]);
	});

	/* The clock is passed in, so the boundary is exact rather than racing the
	 * real one: `claimedAt` sits at t0 and `now` moves around the cutoff. */
	const t0 = Date.parse("2026-08-17T00:00:00.000Z");
	// The cutoff is 24 hours (mantahostels#392); spelled here, not imported.
	const deadClaimMaxAgeMs = 24 * 60 * 60 * 1000;
	const deadAt = (extra: Record<string, unknown> = {}) =>
		lock("src/a.js", "them", {
			alive: false,
			claimedAt: new Date(t0).toISOString(),
			...extra,
		});

	it("drops a dead holder's claim once it is too old to explain anything", () => {
		write("src/a.js", "abandoned days ago\n");
		const before = readTreeSnapshot(repo);

		expect(
			neighbourDirty(before, [deadAt()], "me", {
				now: t0 + deadClaimMaxAgeMs + 1,
			}),
		).toBeNull();
	});

	it("keeps a dead holder's claim right up to the cutoff", () => {
		write("src/a.js", "abandoned an hour ago\n");
		const before = readTreeSnapshot(repo);

		expect(
			neighbourDirty(before, [deadAt()], "me", {
				now: t0 + deadClaimMaxAgeMs,
			}),
		).toHaveLength(1);
	});

	it("keeps a LIVE holder's claim however old it is", () => {
		// The cutoff is about a holder that will never release, not about age.
		write("src/a.js", "long-running session\n");
		const before = readTreeSnapshot(repo);
		const claimedAt = new Date(
			Date.now() - deadClaimMaxAgeMs * 10,
		).toISOString();

		expect(
			neighbourDirty(before, [lock("src/a.js", "them", { claimedAt })], "me"),
		).toHaveLength(1);
	});

	it("reports a dead holder whose claim carries no readable timestamp", () => {
		write("src/a.js", "left behind\n");
		const before = readTreeSnapshot(repo);

		expect(
			neighbourDirty(
				before,
				[lock("src/a.js", "them", { alive: false, claimedAt: "not a date" })],
				"me",
			),
		).toHaveLength(1);
	});

	it("ignores an unreadable lock, which names no path", () => {
		write("src/a.js", "half-written\n");
		const before = readTreeSnapshot(repo);

		expect(
			neighbourDirty(before, [{ file: "x.json", unreadable: true }], "me"),
		).toBeNull();
	});

	it("says nothing when the session cannot name itself", () => {
		write("src/a.js", "half-written\n");
		const before = readTreeSnapshot(repo);

		expect(neighbourDirty(before, [lock("src/a.js", "them")], "")).toBeNull();
	});

	it("says nothing when the claim store could not be read", () => {
		write("src/a.js", "half-written\n");
		const before = readTreeSnapshot(repo);

		expect(neighbourDirty(before, null, "me")).toBeNull();
	});

	it("says nothing when there is no snapshot to compare against", () => {
		expect(neighbourDirty(null, [lock("src/a.js", "them")], "me")).toBeNull();
	});

	it("orders by path, so the list is stable between runs", () => {
		write("src/a.js", "x\n");
		write("src/b.js", "y\n");
		const before = readTreeSnapshot(repo);

		expect(
			neighbourDirty(
				before,
				[lock("src/b.js", "them"), lock("src/a.js", "them")],
				"me",
			).map((e: { path: string }) => e.path),
		).toEqual(["src/a.js", "src/b.js"]);
	});
});
