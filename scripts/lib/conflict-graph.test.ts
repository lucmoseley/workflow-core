// @vitest-environment node
/*
 * Pins the substrate-conflict graph: which candidates share a file, which a
 * live session's claims rule out, and the disjoint set it proposes
 * (mantahostels#1002; terminal holders since #637).
 *
 * The graph is pure apart from readHeldFiles(), which reads the arbiter's claim
 * store — pointed at a throwaway CLAUDE_CONFIG_DIR here, never the founder's,
 * which would make the suite report on whatever live sessions happen to hold.
 *
 * pick-next.js prints this graph for /pick-next, so a loosened case lets it
 * launch two tickets that write one file side by side, or hold back one that
 * nothing blocks.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const graph = require("./conflict-graph.js");
const arbiter = require("./arbiter-store.js");

interface Candidate {
	number: number;
	writeSet: string[];
	source?: string;
	sizeBand?: string | null;
}

const cand = (
	number: number,
	writeSet: string[],
	sizeBand: string | null = null,
): Candidate => ({ number, writeSet, source: "band-read", sizeBand });

const build = (candidates: Candidate[], files: unknown[] = []) =>
	graph.buildGraph({ candidates, held: { files, kept: false, why: null } });

describe("which candidates cannot run alongside which", () => {
	it("names the pair and the file they share", () => {
		const g = build([
			cand(1, ["scripts/a.js"]),
			cand(2, ["scripts/a.js", "scripts/b.js"]),
		]);
		expect(g.conflicts).toEqual([{ a: 1, b: 2, paths: ["scripts/a.js"] }]);
	});

	it("leaves a pair sharing no file out of the graph", () => {
		const g = build([cand(1, ["scripts/a.js"]), cand(2, ["scripts/b.js"])]);
		expect(g.conflicts).toEqual([]);
		expect(g.proposed).toEqual([1, 2]);
	});

	it("reports a doc-map-only overlap as stamp-sharing, not as a conflict", () => {
		const g = build([
			cand(1, ["docs/doc-map.md"]),
			cand(2, ["docs/doc-map.md"]),
		]);
		expect(g.conflicts).toEqual([]);
		expect(g.stampSharing.pairs).toBe(1);
		expect(g.proposed).toEqual([1, 2]);
	});

	it("reports a CLAUDE.md-only overlap as stamp-sharing, not as a conflict", () => {
		const g = build([cand(1, ["CLAUDE.md"]), cand(2, ["CLAUDE.md"])]);
		expect(g.conflicts).toEqual([]);
		expect(g.stampSharing.pairs).toBe(1);
		// And so both run: a stamp disqualifies nobody (mantahostels#1281).
		expect(g.proposed).toEqual([1, 2]);
	});

	it("still conflicts where a pair shares the stamp AND a real file", () => {
		const g = build([
			cand(1, ["docs/doc-map.md", "scripts/a.js"]),
			cand(2, ["docs/doc-map.md", "scripts/a.js"]),
		]);
		// The conflict names only the file that disqualifies, never the stamp.
		expect(g.conflicts).toEqual([{ a: 1, b: 2, paths: ["scripts/a.js"] }]);
		expect(g.stampSharing.pairs).toBe(0);
		expect(g.proposed).toEqual([1]);
	});
});

describe("what a running session rules out", () => {
	const holder = (p: string, session = "Implement 900") => ({
		path: p,
		sessionId: "sess-1",
		session,
	});

	it("names the candidate, the file and the session holding it", () => {
		const g = build([cand(7, ["scripts/a.js"])], [holder("scripts/a.js")]);
		expect(g.inFlight).toEqual([
			{
				candidate: 7,
				paths: ["scripts/a.js"],
				session: "Implement 900",
				sessionId: "sess-1",
			},
		]);
		expect(g.proposed).toEqual([]);
		expect(g.dropped).toEqual([
			{
				number: 7,
				why: "Implement 900 holds scripts/a.js",
				kind: "held",
				heldBy: "Implement 900",
				sessionId: "sess-1",
				paths: ["scripts/a.js"],
			},
		]);
	});

	it("treats a held stamp as a queue, not a rule-out", () => {
		const g = build(
			[cand(7, ["docs/doc-map.md"])],
			[holder("docs/doc-map.md")],
		);
		expect(g.inFlight).toEqual([]);
		expect(
			g.stampQueued.map((r: { candidate: number }) => r.candidate),
		).toEqual([7]);
		expect(g.proposed).toEqual([7]);
	});

	it("ignores a file no candidate names", () => {
		const g = build([cand(7, ["scripts/a.js"])], [holder("app/page.tsx")]);
		expect(g.inFlight).toEqual([]);
		expect(g.proposed).toEqual([7]);
	});
});

describe("the proposed disjoint set", () => {
	it("keeps the higher-ranked of two candidates sharing a file", () => {
		const g = build([
			cand(1, ["scripts/a.js"]),
			cand(2, ["scripts/a.js"]),
			cand(3, ["scripts/c.js"]),
		]);
		expect(g.proposed).toEqual([1, 3]);
		expect(g.dropped).toEqual([
			{
				number: 2,
				why: "#1 already in the set names scripts/a.js",
				kind: "clash",
				with: 1,
				paths: ["scripts/a.js"],
			},
		]);
	});

	it("walks the ranking order it is handed, not the issue numbers", () => {
		const g = build([cand(9, ["scripts/a.js"]), cand(2, ["scripts/a.js"])]);
		expect(g.proposed).toEqual([9]);
	});

	it("does not let a dropped candidate reserve the paths it never gets to write", () => {
		// mantahostels#2 loses `a.js` to mantahostels#1 and is out — so its `b.js` is free, and mantahostels#3 takes it.
		const g = build([
			cand(1, ["a.js"]),
			cand(2, ["a.js", "b.js"]),
			cand(3, ["b.js"]),
		]);
		expect(g.proposed).toEqual([1, 3]);
	});

	it("puts every candidate in exactly one of proposed and dropped", () => {
		const g = build([
			cand(1, ["a.js"]),
			cand(2, ["a.js"]),
			cand(3, ["docs/doc-map.md"]),
		]);
		expect(
			[
				...g.proposed,
				...g.dropped.map((d: { number: number }) => d.number),
			].sort((a, b) => a - b),
		).toEqual([1, 2, 3]);
	});

	it("admits a candidate nothing was predicted for, and says so", () => {
		const g = build([cand(1, ["scripts/a.js"]), cand(2, [])]);
		expect(g.proposed).toEqual([1, 2]);
		expect(g.noWriteSet).toEqual([2]);
	});

	it("admits every candidate where only the stamp is shared repo-wide", () => {
		const g = build([
			cand(1, ["docs/doc-map.md", "scripts/a.js"]),
			cand(2, ["docs/doc-map.md", "scripts/b.js"]),
			cand(3, ["docs/doc-map.md"]),
		]);
		expect(g.proposed).toEqual([1, 2, 3]);
		expect(g.dropped).toEqual([]);
	});
});

describe("the shape a capped pair list hides", () => {
	it("counts the pairs each file makes, hottest first", () => {
		const g = build([
			cand(1, ["hot.md", "cool.md"]),
			cand(2, ["hot.md", "cool.md"]),
			cand(3, ["hot.md"]),
		]);
		expect(g.conflictsByFile).toEqual([
			{ path: "hot.md", pairs: 3 },
			{ path: "cool.md", pairs: 1 },
		]);
	});
});

describe("the merge test's mechanical limbs", () => {
	it("pairs two small issues on one file, stamp included", () => {
		const g = build([
			cand(1, ["docs/doc-map.md"], "small"),
			cand(2, ["docs/doc-map.md"], "small"),
		]);
		expect(g.mergeable).toEqual([{ a: 1, b: 2, paths: ["docs/doc-map.md"] }]);
	});

	it("cannot admit a grep-derived candidate, which never carries a size (mantahostels#1001)", () => {
		/*
		 * The merge test admits on size alone, never on source, so the invariant
		 * keeping a prediction out of it is `provisional` meaning `sizeBand: null`
		 * without exception — `write-set-predict.js` carries no size forward for
		 * exactly this reason.
		 */
		const g = build([
			{ number: 1, writeSet: ["scripts/a.js"], source: "grep", sizeBand: null },
			cand(2, ["scripts/a.js"], "small"),
		]);
		expect(g.mergeable).toEqual([]);
	});

	it("drops the pair where either side is not sized small", () => {
		const g = build([
			cand(1, ["scripts/a.js"], "small"),
			cand(2, ["scripts/a.js"], "medium"),
			cand(3, ["scripts/a.js"], null),
		]);
		expect(g.mergeable).toEqual([]);
	});
});

describe("what the graph says about its own inputs", () => {
	it("carries each candidate's source and size through to the graph", () => {
		const g = graph.buildGraph({
			candidates: graph.writeSetsFor(
				[
					{ number: 1, paths: ["body.md"] },
					{ number: 2, paths: [] },
				],
				[
					{
						number: 2,
						writeSet: ["a.js"],
						sizeBand: "small",
						unrevalidated: true,
					},
				],
			),
			held: { files: [], kept: false, why: null },
		});
		expect(g.candidates).toEqual([
			{
				number: 1,
				writeSet: ["body.md"],
				source: "body",
				sizeBand: null,
				unrevalidated: false,
			},
			{
				number: 2,
				writeSet: ["a.js"],
				source: "band-read",
				sizeBand: "small",
				unrevalidated: true,
			},
		]);
	});

	it("reads a size a band read spelled `Small`, which nothing validates", () => {
		const g = build([cand(1, ["a.js"], "Small "), cand(2, ["a.js"], "SMALL")]);
		expect(g.mergeable).toEqual([{ a: 1, b: 2, paths: ["a.js"] }]);
	});
});

describe("write-sets: a band read's, or the body's as a floor", () => {
	it("prefers the cached write-set and carries its size", () => {
		const sets = graph.writeSetsFor(
			[{ number: 1, paths: ["docs/mentioned.md"] }],
			[
				{
					number: 1,
					writeSet: ["scripts/real.js"],
					sizeBand: "small",
					gist: "x",
				},
			],
		);
		expect(sets).toEqual([
			{
				number: 1,
				writeSet: ["scripts/real.js"],
				source: "band-read",
				sizeBand: "small",
				unrevalidated: false,
			},
		]);
	});

	it("falls back to the paths the body named, with no size", () => {
		const sets = graph.writeSetsFor(
			[{ number: 1, paths: ["b.md", "a.md"] }],
			[],
		);
		expect(sets).toEqual([
			{
				number: 1,
				writeSet: ["a.md", "b.md"],
				source: "body",
				sizeBand: null,
				unrevalidated: false,
			},
		]);
	});

	it("carries a warm entry's unrevalidated flag through", () => {
		const sets = graph.writeSetsFor(
			[{ number: 1, paths: [] }],
			[{ number: 1, writeSet: ["a.js"], unrevalidated: true }],
		);
		expect(sets[0].unrevalidated).toBe(true);
	});
});

describe("reading the live file claims", () => {
	let dir: string;
	let repo: string;
	const lock = (rel: string, sessionId: string) => {
		const key = require("node:crypto")
			.createHash("sha256")
			.update(rel)
			.digest("hex")
			.slice(0, 16);
		const locks = path.join(
			dir,
			"projects",
			repo.replace(/[^a-zA-Z0-9]/g, "-"),
			"locks",
		);
		fs.mkdirSync(locks, { recursive: true });
		fs.writeFileSync(
			path.join(locks, `${key}.json`),
			JSON.stringify({
				path: rel,
				sessionId,
				claimedAt: new Date().toISOString(),
			}),
		);
	};

	/*
	 * Saved and restored, never assigned `undefined` — that stores the literal
	 * string "undefined", which every reader here treats as a real value.
	 */
	const vars = [
		"CLAUDE_CONFIG_DIR",
		"CLAUDE_PROJECT_DIR",
		"CLAUDE_CODE_SESSION_ID",
	] as const;
	let saved: Record<string, string | undefined>;
	const restore = () => {
		for (const v of vars) {
			if (saved[v] === undefined) delete process.env[v];
			else process.env[v] = saved[v];
		}
	};

	beforeEach(() => {
		saved = Object.fromEntries(vars.map((v) => [v, process.env[v]]));
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "conflict-graph-"));
		repo = path.join(dir, "repo");
		process.env.CLAUDE_CONFIG_DIR = dir;
		process.env.CLAUDE_PROJECT_DIR = repo;
		delete process.env.CLAUDE_CODE_SESSION_ID;
	});
	afterEach(() => {
		restore();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("keeps a claim whose session the oracle lists, and drops one it does not", () => {
		lock("scripts/live.js", "alive");
		lock("scripts/dead.js", "finished");
		const held = graph.readHeldFiles({
			ids: new Set(["alive"]),
			names: new Map([["alive", "Implement 900"]]),
		});
		expect(held.files).toEqual([
			{ path: "scripts/live.js", sessionId: "alive", session: "Implement 900" },
		]);
		expect(held.kept).toBe(false);
	});

	it("drops a claim whose listed holder is terminal, and keeps a working one's (#637)", () => {
		lock("scripts/live.js", "alive");
		lock("scripts/stopped.js", "stopped");
		const held = graph.readHeldFiles({
			ids: new Set(["alive", "stopped"]),
			terminal: new Set(["stopped"]),
		});
		expect(held.files.map((f: { path: string }) => f.path)).toEqual([
			"scripts/live.js",
		]);
	});

	it("keeps every claim where liveness could not be read, and says why", () => {
		lock("scripts/live.js", "alive");
		lock("scripts/dead.js", "finished");
		const held = graph.readHeldFiles({ ids: null, why: "no daemon" });
		expect(held.files.map((f: { path: string }) => f.path).sort()).toEqual([
			"scripts/dead.js",
			"scripts/live.js",
		]);
		expect(held.kept).toBe(true);
		expect(held.why).toBe("no daemon");
		expect(graph.buildGraph({ candidates: [], held }).heldDegraded).toEqual({
			why: "no daemon",
			kept: true,
		});
	});

	it("names a session the oracle did not name by a short id", () => {
		lock("scripts/live.js", "abcdef0123456789");
		const held = graph.readHeldFiles({ ids: new Set(["abcdef0123456789"]) });
		expect(held.files[0].session).toBe("abcdef01");
	});

	it("reports an unreadable store rather than an empty frontier of claims", () => {
		// A locks directory that is a file, so readdir fails with something other
		// than ENOENT.
		const state = path.join(
			dir,
			"projects",
			repo.replace(/[^a-zA-Z0-9]/g, "-"),
		);
		fs.mkdirSync(state, { recursive: true });
		fs.writeFileSync(path.join(state, "locks"), "not a directory");
		const held = graph.readHeldFiles({ ids: new Set(["alive"]) });
		expect(held.files).toEqual([]);
		expect(held.why).toMatch(/could not be read/);
	});

	it("does not count this run's own claims as a hold", () => {
		lock("scripts/mine.js", "me");
		lock("scripts/theirs.js", "other");
		process.env.CLAUDE_CODE_SESSION_ID = "me";
		const held = graph.readHeldFiles({ ids: new Set(["me", "other"]) });
		expect(held.files.map((f: { path: string }) => f.path)).toEqual([
			"scripts/theirs.js",
		]);
	});

	it("is empty and uncomplaining where nothing has ever been claimed", () => {
		const held = graph.readHeldFiles({ ids: new Set(["alive"]) });
		expect(held.files).toEqual([]);
		expect(held.why).toBe(null);
	});

	describe("a claim outliving its holder's issue (mantahostels#2764)", () => {
		it("drops a claim whose holder's issue closed, though the agents oracle still lists the finished session", () => {
			lock("scripts/guard-registry-atomicity.sh", "finished");
			arbiter.claimIssue(2734, { sessionId: "finished" });
			const held = graph.readHeldFiles(
				{
					ids: new Set(["finished"]),
					names: new Map([["finished", "Implement 2734"]]),
				},
				new Set([1, 2, 3]), // 2734 is not among this run's open issues
			);
			expect(held.files).toEqual([]);
		});

		it("keeps a claim whose holder's issue is still open", () => {
			lock("scripts/live.js", "alive");
			arbiter.claimIssue(42, { sessionId: "alive" });
			const held = graph.readHeldFiles(
				{ ids: new Set(["alive"]) },
				new Set([42]),
			);
			expect(held.files.map((f: { path: string }) => f.path)).toEqual([
				"scripts/live.js",
			]);
		});

		it("still drops a claim whose session the oracle does not list, issue open or not", () => {
			// The mantahostels#2694 shape: absent from `claude agents --json` altogether. The
			// liveness check gates before the issue check ever runs.
			lock("scripts/bg-run.sh", "gone");
			arbiter.claimIssue(2694, { sessionId: "gone" });
			const held = graph.readHeldFiles({ ids: new Set() }, new Set([2694]));
			expect(held.files).toEqual([]);
		});

		it("skips the issue check where no open-issue set is passed, unchanged from before mantahostels#2764", () => {
			lock("scripts/guard-registry-atomicity.sh", "finished");
			arbiter.claimIssue(2734, { sessionId: "finished" });
			const held = graph.readHeldFiles({
				ids: new Set(["finished"]),
			});
			expect(held.files.map((f: { path: string }) => f.path)).toEqual([
				"scripts/guard-registry-atomicity.sh",
			]);
		});

		it("keeps a claim where its holder has a stale record on a closed issue AND a live one still open — first-writer-wins over the two must not strand it", () => {
			// claimIssue writes one file per (issue, session) and never clears an
			// earlier one, so a session moving from mantahostels#100 (closed, never released)
			// onto mantahostels#200 (open) holds both records. Whichever readdirSync happens to
			// return first must not decide this.
			lock("scripts/live.js", "busy");
			arbiter.claimIssue(100, { sessionId: "busy" });
			arbiter.claimIssue(200, { sessionId: "busy" });
			const held = graph.readHeldFiles(
				{ ids: new Set(["busy"]) },
				new Set([200]), // only mantahostels#200 is open; mantahostels#100 has closed
			);
			expect(held.files.map((f: { path: string }) => f.path)).toEqual([
				"scripts/live.js",
			]);
		});

		it("drops a claim only where every issue its holder has ever claimed has closed", () => {
			lock("scripts/dead.js", "done");
			arbiter.claimIssue(100, { sessionId: "done" });
			arbiter.claimIssue(101, { sessionId: "done" });
			const held = graph.readHeldFiles(
				{ ids: new Set(["done"]) },
				new Set([200]), // neither 100 nor 101 is open
			);
			expect(held.files).toEqual([]);
		});

		it("reports why where the issue-claims store itself could not be read, rather than skipping silently", () => {
			lock("scripts/live.js", "alive");
			// A directory in place of the issue-claims store forces a non-ENOENT
			// readdir failure.
			const issueClaimsDir = path.join(
				dir,
				"projects",
				repo.replace(/[^a-zA-Z0-9]/g, "-"),
				"issue-claims",
			);
			fs.mkdirSync(path.dirname(issueClaimsDir), { recursive: true });
			fs.writeFileSync(issueClaimsDir, "not a directory");
			const held = graph.readHeldFiles(
				{ ids: new Set(["alive"]) },
				new Set([1]),
			);
			// Fails open: the claim is still shown as held...
			expect(held.files.map((f: { path: string }) => f.path)).toEqual([
				"scripts/live.js",
			]);
			expect(held.why).toMatch(/issue-claims store could not be read/);
			expect(held.kept).toBe(true);
		});
	});
});

describe("the stamp-sharing summary names what was shared", () => {
	it("names the stamp the pairs actually share, not the whole allowlist", () => {
		const g = graph.buildGraph({
			candidates: [cand(1, ["docs/doc-map.md"]), cand(2, ["docs/doc-map.md"])],
			held: { files: [], kept: false, why: null },
			stamps: ["docs/doc-map.md", "docs/never-touched.md"],
		});
		expect(g.stampSharing.paths).toEqual(["docs/doc-map.md"]);
	});
});

describe("the stamp allowlist itself", () => {
	it("holds exactly the ruled stamps, not docs/reference-roadmap.html", () => {
		// see module header, mantahostels#1074, mantahostels#1281
		expect(graph.STAMP_PATHS).toEqual(["docs/doc-map.md", "CLAUDE.md"]);
	});
});

describe("which issues the band read is nominated to cover (mantahostels#1484)", () => {
	const prov = (number: number, writeSet: string[]): Candidate => ({
		number,
		writeSet,
		source: "grep",
		sizeBand: null,
	});

	it("nominates both sides of a provisional pair sharing a real file", () => {
		const g = build([prov(1, ["scripts/a.js"]), prov(2, ["scripts/a.js"])]);
		expect(g.nominated).toEqual([
			{ number: 1, paths: ["scripts/a.js"], with: [2] },
			{ number: 2, paths: ["scripts/a.js"], with: [1] },
		]);
	});

	it("nominates nobody for a stamp-only overlap, which merges anyway", () => {
		const g = build([
			prov(1, ["docs/doc-map.md", "CLAUDE.md"]),
			prov(2, ["docs/doc-map.md", "CLAUDE.md"]),
		]);
		expect(g.nominated).toEqual([]);
		expect(g.stampSharing.pairs).toBe(1);
	});

	it("nominates the sizeless side of a warm/provisional pair, not the warm one", () => {
		const g = build([
			cand(1, ["scripts/a.js"], "small"),
			prov(2, ["scripts/a.js"]),
		]);
		expect(g.nominated).toEqual([
			{ number: 2, paths: ["scripts/a.js"], with: [1] },
		]);
	});

	it("leaves a provisional candidate sharing no file with anything alone", () => {
		const g = build([prov(1, ["scripts/a.js"]), prov(2, ["scripts/b.js"])]);
		expect(g.nominated).toEqual([]);
	});

	it("nominates a body-sourced row too, which carries no size either", () => {
		const g = graph.buildGraph({
			candidates: graph.writeSetsFor(
				[
					{ number: 1, paths: ["scripts/a.js"] },
					{ number: 2, paths: ["scripts/a.js"] },
				],
				[{ number: 2, writeSet: ["scripts/a.js"], sizeBand: "small" }],
			),
			held: { files: [], kept: false, why: null },
		});
		expect(g.nominated).toEqual([
			{ number: 1, paths: ["scripts/a.js"], with: [2] },
		]);
	});

	it("nominates on the substrate half of an overlap that is part stamp", () => {
		const g = build([
			prov(1, ["docs/doc-map.md", "scripts/a.js"]),
			prov(2, ["docs/doc-map.md", "scripts/a.js"]),
		]);
		expect(g.nominated[0].paths).toEqual(["scripts/a.js"]);
	});

	it("gathers every partner and path a candidate is nominated by", () => {
		const g = build([
			prov(1, ["scripts/a.js", "scripts/b.js"]),
			prov(2, ["scripts/a.js"]),
			prov(3, ["scripts/b.js"]),
		]);
		expect(g.nominated[0]).toEqual({
			number: 1,
			paths: ["scripts/a.js", "scripts/b.js"],
			with: [2, 3],
		});
	});

	it("walks the ranking order it is handed, not the issue numbers", () => {
		const g = build([prov(9, ["scripts/a.js"]), prov(4, ["scripts/a.js"])]);
		expect(g.nominated.map((n: { number: number }) => n.number)).toEqual([
			9, 4,
		]);
	});
});
