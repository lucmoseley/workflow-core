// @vitest-environment node
/*
 * Pins what the run prints and writes beside the shortlist: possible file
 * collisions, the write-set cache, the substrate-conflict graph, the run
 * summary, and the files it leaves on disk (mantahostels#1001, mantahostels#1002).
 *
 * Loosen a case and `/pick-next` can pair two issues that collide on a file.
 * The harness is lib/pick-next-testkit.ts.
 *
 * Each case runs scripts/pick-next.js in process against a stub gh, a git
 * tree and a claim store: ~0.2 s a case, under #4302's 60 s per-file limit.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	type Fixture,
	installPickNextHarness,
	kit,
	restCalls,
	run,
	sessionProcs,
	stubBrokenRepo,
	stubRepo,
} from "./lib/pick-next-testkit";

const writeSetCache = require("./lib/write-set-cache.js");
const warmFractionLog = require("./lib/warm-fraction-log.js");
const selectionMarker = require("./lib/selection-marker.js");

installPickNextHarness();

describe("possible file collisions", () => {
	/** The shortlist table alone. */
	const table = (out: string) => out.split("-".repeat(106))[1].split("\n\n")[0];

	it("reports two shortlisted issues whose bodies name the same tracked file", async () => {
		stubRepo(["scripts/lib/guard-log.sh", "scripts/pick-next.js"]);
		const r = await run({
			issues: [
				{ number: 181, body: "rework `scripts/lib/guard-log.sh`" },
				{ number: 183, body: "the parser in `scripts/lib/guard-log.sh`" },
				{ number: 184, body: "nothing shared here: `scripts/pick-next.js`" },
			],
		});
		expect(r.out).toMatch(
			/possible collision: #181 <-> #183 on scripts\/lib\/guard-log\.sh/,
		);
		expect(r.out.match(/possible collision:/g)).toHaveLength(1);
	});

	it("pairs the whole frontier, not just the rows --limit prints", async () => {
		// The skill invokes the script with --limit, so pairing the printed slice
		// would hide exactly the collisions a long frontier creates.
		stubRepo(["scripts/a.js"]);
		const r = await run(
			{
				issues: [
					{ number: 1 },
					{ number: 2, body: "`scripts/a.js`" },
					{ number: 3, body: "`scripts/a.js`" },
				],
			},
			["--limit", "1"],
		);
		expect(r.order()).toEqual([1]);
		expect(r.out).toMatch(/possible collision: #2 <-> #3 on scripts\/a\.js/);
	});

	it("leaves the shortlist byte-identical — it annotates, it never sorts", async () => {
		// mantahostels#192 (this annotation) changed none of mantahostels#106's five sort levels.
		stubRepo(["scripts/a.js", "scripts/b.js"]);
		const issues = [{ number: 4 }, { number: 7 }, { number: 9 }];
		const bare = await run({ issues });
		// Deliberately uneven path counts: any level keyed on them would reorder.
		const bodies: Record<number, string> = {
			4: "`scripts/a.js`",
			7: "`scripts/a.js` and `scripts/b.js`",
			9: "`scripts/a.js`",
		};
		const annotated = await run({
			issues: issues.map((i) => ({ ...i, body: bodies[i.number] })),
		});
		expect(table(annotated.out)).toBe(table(bare.out));
		expect(annotated.order()).toEqual([4, 7, 9]);
		expect(annotated.out).toMatch(/possible collision: #4 <-> #7/);
		expect(annotated.out).toMatch(/possible collision: #4 <-> #9/);
		expect(annotated.out).toMatch(/possible collision: #7 <-> #9/);
	});

	it("says so, and still prints a shortlist, when the tracked files are unreadable", async () => {
		stubBrokenRepo();
		const r = await run({
			issues: [
				{ number: 1, body: "`scripts/a.js`" },
				{ number: 2, body: "`scripts/a.js`" },
			],
		});
		expect(r.status).toBe(0);
		expect(r.order()).toEqual([1, 2]);
		expect(r.out).toMatch(/POSSIBLE FILE COLLISIONS — unavailable/);
		expect(r.out).not.toMatch(/possible collision:/);
	});

	it("carries the pairs and each issue's paths into JSON", async () => {
		stubRepo(["scripts/a.js", "scripts/b.js"]);
		const r = await run(
			{
				issues: [
					{ number: 1, body: "`scripts/a.js` and `scripts/b.js`" },
					{ number: 2, body: "`scripts/a.js`" },
				],
			},
			["--json"],
		);
		const j = r.json();
		expect(j.possibleCollisions).toEqual([
			{ a: 1, b: 2, paths: ["scripts/a.js"] },
		]);
		expect(j.frontier[0].pathsNamed).toEqual(["scripts/a.js", "scripts/b.js"]);
		expect(j.pathsUnavailable).toBe(null);
	});

	it("points the summary at the DOC-MAP QUEUE only when that block prints", async () => {
		stubRepo(["docs/doc-map.md"]);
		const r = await run({
			issues: [
				{ number: 1, body: "stamp `docs/doc-map.md` and §B2" },
				{ number: 2, body: "also `docs/doc-map.md`" },
			],
		});
		expect(r.out).toMatch(
			/1 pair sharing only a stamp path \(docs\/doc-map\.md\) suppressed — see the DOC-MAP QUEUE below;/,
		);
		expect(r.out).toMatch(/DOC-MAP QUEUE \(1\)/);
	});

	it("prints the band-read nominations, and nominates nobody off a stamp-only overlap (mantahostels#1484)", async () => {
		stubRepo(["scripts/a.js", "docs/doc-map.md"]);
		const r = await run({
			issues: [
				{ number: 1, body: "writes `scripts/a.js`" },
				{ number: 2, body: "also `scripts/a.js`" },
				{ number: 3, body: "stamp `docs/doc-map.md`" },
				{ number: 4, body: "also `docs/doc-map.md`" },
			],
		});
		// Both sides of the substrate overlap, and neither side of the stamp one.
		expect(r.out).toMatch(/BAND-READ NOMINATIONS \(2\)/);
		expect(r.out).toMatch(/#1 on scripts\/a\.js — with #2/);
		expect(r.out).toMatch(/#2 on scripts\/a\.js — with #1/);
		expect(r.out).not.toMatch(/#3 on /);
		expect(r.out).not.toMatch(/#4 on /);
	});

	it("keeps a suppressed pair in --json", async () => {
		stubRepo(["docs/doc-map.md"]);
		const r = await run(
			{
				issues: [
					{ number: 1, body: "`docs/doc-map.md`" },
					{ number: 2, body: "`docs/doc-map.md`" },
				],
			},
			["--json"],
		);
		expect(r.json().possibleCollisions).toEqual([
			{ a: 1, b: 2, paths: ["docs/doc-map.md"] },
		]);
	});

	it("adds no API call — the bodies come from the list call already made", async () => {
		stubRepo(["scripts/a.js"]);
		const withBodies = await run({
			issues: [
				{ number: 1, body: "`scripts/a.js`" },
				{ number: 2, body: "`scripts/a.js`" },
			],
		});
		expect(
			withBodies.calls().filter((c) => /issues\?state=open/.test(c)),
		).toHaveLength(1);
		expect(withBodies.calls().join("\n")).not.toMatch(/\/(files|contents)/);
	});
});

/*
 * mantahostels#384: the issues a live session holds an arbiter claim on are the in-flight
 * set — the sessions actually running right now (narrowed from the assignee at
 * mantahostels#645). They are dropped from the shortlist, so pairing candidates only
 * with each other misses every collision with work already under way.
 */
describe("candidate-vs-in-flight collisions", () => {
	it("reports a candidate naming a file a claimed issue also names", async () => {
		stubRepo(["scripts/session-arbiter.js"]);
		const r = await run({
			issues: [
				{ number: 1, body: "extract `session-arbiter.js`'s store" },
				{
					number: 2,
					assignees: ["owner"],
					body: "`session-arbiter.js` reads an unreadable store",
				},
			],
			claims: { 2: "self" },
		});
		expect(r.order()).toEqual([1]);
		expect(r.out).toMatch(
			/in flight: #1 <-> #2 \(claimed by owner\) on scripts\/session-arbiter\.js/,
		);
	});

	it("restates the advisory limits when only an in-flight pair fires", async () => {
		stubRepo(["scripts/a.js"]);
		const r = await run({
			issues: [
				{ number: 1, body: "`scripts/a.js`" },
				{ number: 2, assignees: ["luc"], body: "`scripts/a.js`" },
			],
			claims: { 2: "self" },
		});
		expect(r.out).toMatch(/POSSIBLE FILE COLLISIONS/);
		expect(r.out).toMatch(/may\s+name a file it\s*\n?only refers to/);
		expect(r.out).toMatch(/naming no file can still collide/);
	});

	it("leaves an in-flight issue out of the shortlist and out of its pairs", async () => {
		stubRepo(["scripts/a.js"]);
		const r = await run({
			issues: [
				{ number: 1, body: "`scripts/a.js`" },
				{ number: 2, assignees: ["luc"], body: "`scripts/a.js`" },
				{ number: 3, body: "`scripts/a.js`" },
			],
			claims: { 2: "self" },
		});
		expect(r.order()).toEqual([1, 3]);
		expect(r.out).toMatch(/possible collision: #1 <-> #3 on scripts\/a\.js/);
		expect(r.out.match(/possible collision:/g)).toHaveLength(1);
		expect(r.out.match(/in flight:/g)).toHaveLength(2);
	});

	it("ignores an issue excluded for anything other than a claim", async () => {
		// Blocked or a container: nobody is writing those files right now.
		stubRepo(["scripts/a.js"]);
		const r = await run({
			issues: [
				{ number: 1, body: "`scripts/a.js`" },
				{ number: 2, body: "`scripts/a.js`" },
				{ number: 3, parent: 2, body: "unrelated" },
			],
			deps: { 1: [] },
		});
		expect(r.out).not.toMatch(/in flight:/);
	});

	it("carries the in-flight pairs into --json", async () => {
		stubRepo(["scripts/a.js"]);
		const j = (
			await run(
				{
					issues: [
						{ number: 1, body: "`scripts/a.js`" },
						{ number: 2, assignees: ["luc"], body: "`scripts/a.js`" },
					],
					claims: { 2: "self" },
				},
				["--json"],
			)
		).json();
		expect(j.inFlightCollisions).toEqual([
			{
				candidate: 1,
				inFlight: 2,
				claimedBy: ["luc"],
				claimedSession: "self",
				paths: ["scripts/a.js"],
			},
		]);
	});

	it("keeps claimedBy a list in --json and joins it only for the printed line", async () => {
		stubRepo(["scripts/a.js"]);
		const issues = [
			{ number: 1, body: "`scripts/a.js`" },
			{ number: 2, assignees: ["luc", "ada"], body: "`scripts/a.js`" },
		];
		const claims = { 2: "self" };
		expect((await run({ issues, claims })).out).toMatch(
			/\(claimed by luc, ada\)/,
		);
		expect(
			(await run({ issues, claims }, ["--json"])).json().inFlightCollisions[0]
				.claimedBy,
		).toEqual(["luc", "ada"]);
	});

	it("carries every in-flight pair into --json, past the print cap", async () => {
		// 13 candidates against 12 in-flight, left as a product: the count is
		// quadratic in the issues sharing a path (.claude/skills/pick-next/SKILL.md).
		// The printed cap itself is pinned on collisionBlockLines (#4382).
		stubRepo(["scripts/a.js"]);
		const issues = Array.from({ length: 25 }, (_, k) => ({
			number: k + 1,
			body: "`scripts/a.js`",
			assignees: k % 2 ? ["luc"] : undefined,
		}));
		const claims = Object.fromEntries(
			issues.filter((i) => i.assignees).map((i) => [i.number, "self"]),
		);
		expect(
			(await run({ issues, claims }, ["--json"])).json().inFlightCollisions
				.length,
		).toBe(13 * 12);
	});

	it("changes no shortlist order — it annotates, like the pairs it extends", async () => {
		stubRepo(["scripts/a.js"]);
		const bare = await run({ issues: [{ number: 4 }, { number: 7 }] });
		const annotated = await run({
			issues: [
				{ number: 4, body: "`scripts/a.js`" },
				{ number: 7 },
				{ number: 9, assignees: ["luc"], body: "`scripts/a.js`" },
			],
			claims: { 9: "self" },
		});
		expect(annotated.order()).toEqual(bare.order());
	});
});

describe("--dump-bodies", () => {
	const dumpDir = () => path.join(kit.dir, "bodies");

	it("writes one file per open issue and issues no extra call for any of it", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, title: "first", body: "body one" },
					{ number: 2, title: "second", body: "body two" },
				],
			},
			["--dump-bodies", dumpDir()],
		);
		expect(r.status).toBe(0);
		expect(fs.readFileSync(path.join(dumpDir(), "1.md"), "utf8")).toContain(
			"body one",
		);
		expect(fs.readFileSync(path.join(dumpDir(), "2.md"), "utf8")).toContain(
			"body two",
		);
		for (const call of restCalls(r.calls()))
			expect(call).not.toMatch(/\bissue\b/);
		expect(r.calls().filter((c) => /issues\?state=open/.test(c))).toHaveLength(
			1,
		);
	});

	it("dumps no pull request, matching the shortlist's own candidate set", async () => {
		await run(
			{
				issues: [
					{ number: 1, body: "an issue" },
					{ number: 2, body: "a PR", pull_request: {} },
				],
			},
			["--dump-bodies", dumpDir()],
		);
		expect(fs.existsSync(path.join(dumpDir(), "1.md"))).toBe(true);
		expect(fs.existsSync(path.join(dumpDir(), "2.md"))).toBe(false);
	});

	it("dumps every open issue, not only the shortlisted ones", async () => {
		// An excluded issue's body is what says whether its exclusion still holds.
		await run(
			{
				issues: [
					{ number: 1, body: "takeable" },
					{ number: 2, body: "claimed", assignees: ["someone"] },
				],
				claims: { 2: "self" },
			},
			["--dump-bodies", dumpDir()],
		);
		expect(fs.existsSync(path.join(dumpDir(), "2.md"))).toBe(true);
	});

	it("says where the bodies landed, in both output modes", async () => {
		const text = await run({ issues: [{ number: 1 }] }, [
			"--dump-bodies",
			dumpDir(),
		]);
		expect(text.out).toContain(dumpDir());
		const json = await run({ issues: [{ number: 1 }] }, [
			"--dump-bodies",
			dumpDir(),
			"--json",
		]);
		expect(json.json().bodiesDumped).toEqual({
			dir: dumpDir(),
			count: 1,
			error: null,
		});
	});

	it("reports an undumpable directory without failing the shortlist", async () => {
		const blocked = path.join(kit.dir, "notadir");
		fs.writeFileSync(blocked, "");
		const r = await run({ issues: [{ number: 1 }] }, [
			"--dump-bodies",
			path.join(blocked, "under-a-file"),
		]);
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/could not dump/i);
		expect(r.out).toMatch(/TAKEABLE NOW: 1/);
	});

	it("dumps nothing when the flag is absent", async () => {
		const r = await run({ issues: [{ number: 1 }] }, ["--json"]);
		expect(r.json().bodiesDumped).toBeNull();
	});
});

describe("the doc-map queue", () => {
	/*
	 * The queue's own line, not the whole output: the conflict graph below it
	 * prints issue numbers too (mantahostels#1002), so a bare /mantahostels#1, mantahostels#2/ over the run would
	 * pass on either block.
	 */
	const parseQueueLine = (out: string) =>
		out.match(/just the top:\n {2}(.*)/)?.[1] ?? null;

	it("flags the bodies naming a §B entry as one queue, in shortlist order", async () => {
		const r = await run({
			issues: [
				{ number: 1, body: "no entry here" },
				{ number: 2, body: "extends §B2 with the measurement" },
				{ number: 3, body: "writes §B7" },
			],
		});
		expect(r.out).toMatch(/DOC-MAP QUEUE/);
		expect(parseQueueLine(r.out)).toBe("#2, #3");
	});

	it("prints the whole queue as one line, excluding none of it", async () => {
		const r = await run({
			issues: [
				{ number: 1, body: "§B1" },
				{ number: 2, body: "§B2" },
			],
		});
		expect(parseQueueLine(r.out)).toBe("#1, #2");
		expect(r.order()).toEqual([1, 2]);
		expect(r.out).not.toMatch(/EXCLUDED\n\n#/);
	});

	it("does not reorder the shortlist a flagged body sits in", async () => {
		// The flag is on the LOWER-ranked issue, so a queue that reached the sort —
		// in either direction — would show up as a swap here.
		const r = await run({
			issues: [
				{ number: 1, body: "nothing" },
				{ number: 2, body: "§B1 §B2 §B3" },
				{ number: 3, body: "nothing either" },
			],
		});
		expect(r.order()).toEqual([1, 2, 3]);
	});

	it("carries the queue in --json", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, body: "§B9" },
					{ number: 2, body: "plain" },
					{ number: 3, body: "§B10", assignees: ["someone"] },
				],
				claims: { 3: "self" },
			},
			["--json"],
		);
		// The shortlist is what the band read covers, so an excluded issue is no
		// part of the queue however its body reads.
		expect(r.json().docMapQueue).toEqual([1]);
	});

	it("prints no queue section when no body names an entry", async () => {
		const r = await run({ issues: [{ number: 1, body: "plain" }] });
		expect(r.out).not.toMatch(/DOC-MAP QUEUE/);
	});
});

describe("the write-set cache", () => {
	/*
	 * Every test here runs with `ownRepo`, dropping `--repo`: the store is keyed
	 * on the tree, so the cache serves only this repository's own issues.
	 * "skips the store entirely against another repository" is what pins that.
	 */
	const here = (fx: Fixture, args: string[] = []) =>
		run(fx, args, { ownRepo: true });

	/** Stores an entry the way `pick-next-cache.js put` would. */
	const store = (
		number: number,
		body: string,
		fields: Record<string, unknown> = {},
	) =>
		writeSetCache.writeEntry(kit.repoRoot, {
			issue: number,
			bodyHash: writeSetCache.bodyHash(body),
			writeSet: ["scripts/a.js"],
			trackedAtDerive: [],
			sizeBand: "M",
			gist: "what it does",
			...fields,
		});

	it("counts every frontier issue as cold on a first run", async () => {
		// `--no-prewarm` throughout the cold-path tests below: pre-warming fills
		// a miss in the same run that finds it (mantahostels#1001), so without the flag there
		// is no cold state left to assert on.
		const r = await here(
			{
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
				],
			},
			["--no-prewarm"],
		);
		expect(r.out).toMatch(
			/WRITE-SET CACHE .* 0 warm, 0 provisional, 2 to derive/,
		);
		expect(r.out).toMatch(/derive #1 #2/);
	});

	it("reads a stored entry back as warm, with its write-set and gist", async () => {
		store(1, "one");
		const r = await here({ issues: [{ number: 1, body: "one" }] });
		expect(r.out).toMatch(/1 warm, 0 provisional, 0 to derive/);
		expect(r.out).toMatch(/warm {2}#1 {2}1 path\(s\), M — what it does/);
	});

	it("re-derives an entry whose tracked path was renamed away", async () => {
		stubRepo(["scripts/new-name.js"]);
		store(1, "one", {
			writeSet: ["scripts/old-name.js"],
			trackedAtDerive: ["scripts/old-name.js"],
		});
		const r = await here({ issues: [{ number: 1, body: "one" }] }, [
			"--json",
			"--no-prewarm",
		]);
		expect(r.json().writeSetCache.cold[0].state).toBe("path-gone");
		expect(r.json().writeSetCache.cold[0].gonePaths).toEqual([
			"scripts/old-name.js",
		]);
	});

	it("says so when git could not list the tree, rather than hiding it", async () => {
		// The broken root first: `store` writes into whatever repoRoot then is.
		stubBrokenRepo();
		store(1, "one", {
			writeSet: ["scripts/a.js"],
			trackedAtDerive: ["scripts/a.js"],
		});
		const r = await here({ issues: [{ number: 1, body: "one" }] });
		expect(r.out).toMatch(/warm {2}#1.*unrevalidated/);
		const j = await here({ issues: [{ number: 1, body: "one" }] }, ["--json"]);
		expect(j.json().writeSetCache.warm[0].unrevalidated).toBe(true);
	});

	it("prunes the entry of an issue that is no longer open", async () => {
		store(1, "one");
		store(99, "closed since");
		const r = await here({ issues: [{ number: 1, body: "one" }] }, ["--json"]);
		expect(r.json().writeSetCache.pruned).toEqual([99]);
		expect(writeSetCache.readEntry(kit.repoRoot, 99)).toBeNull();
		expect(writeSetCache.readEntry(kit.repoRoot, 1)).not.toBeNull();
	});

	it("keeps the entry of an open issue the shortlist excluded", async () => {
		// A claimed issue is still open, and its entry is what makes the next
		// re-pick warm.
		store(2, "claimed");
		await here(
			{
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "claimed", assignees: ["someone"] },
				],
				claims: { 2: "self" },
			},
			["--json"],
		);
		expect(writeSetCache.readEntry(kit.repoRoot, 2)).not.toBeNull();
	});

	it("covers the whole frontier, not the --limit slice", async () => {
		// --limit is a display cap, and a warm entry hidden by it is one the band
		// read pays for a second time. `frontier` itself is not truncated either
		// (mantahostels#1289), so this checks the cache split, which is the
		// full frontier — and the written report alongside it.
		const r = await here(
			{
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
				],
			},
			["--limit", "1", "--json", "--no-prewarm"],
		);
		expect(r.json().frontier).toHaveLength(2);
		expect(
			r.json().writeSetCache.cold.map((c: { number: number }) => c.number),
		).toEqual([1, 2]);
	});

	it("changes neither the order nor the shortlist", async () => {
		// Advisory: nothing is refused on a prediction.
		store(2, "two");
		const r = await here({
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
			],
		});
		expect(r.order()).toEqual([1, 2]);
		expect(r.out).toMatch(/TAKEABLE NOW: 2/);
	});

	it("skips the store entirely against another repository", async () => {
		// The store is keyed on the tree, so another tracker's mantahostels#1 would read this
		// one's entry, and pruning would delete what that tracker has no issue for.
		store(1, "one");
		store(99, "gone");
		const r = await run({ issues: [{ number: 1, body: "one" }] }, ["--json"]);
		expect(r.json().writeSetCache.warm).toEqual([]);
		expect(r.json().writeSetCache.cold).toEqual([]);
		expect(writeSetCache.readEntry(kit.repoRoot, 99)).not.toBeNull();
	});

	/** Every line of the warm-fraction log this tree has recorded, oldest first. */
	const readLog = () =>
		fs
			.readFileSync(
				path.join(kit.repoRoot as string, warmFractionLog.LOG_SUBPATH),
				"utf8",
			)
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));

	/** Moves an entry's derive time, so the interval under test is not a race. */
	const derivedAt = (issue: number, at: string) => {
		const file = path.join(
			writeSetCache.cacheDir(kit.repoRoot),
			`${issue}.json`,
		);
		const e = JSON.parse(fs.readFileSync(file, "utf8"));
		fs.writeFileSync(file, JSON.stringify({ ...e, derivedAt: at }));
	};

	it("records how many entries were put since the run before it (mantahostels#667)", async () => {
		const fx = {
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
			],
		};
		await here(fx);
		const first = readLog()[0];
		// The band read the first run asked for, landing between the two runs.
		store(1, "one");
		derivedAt(1, new Date(Date.parse(first.at) + 1).toISOString());
		await here(fx);
		const lines = readLog();
		expect(lines).toHaveLength(2);
		// Nothing preceded the first run, so its interval is unknown, not empty.
		expect(first.putsSinceLastRun).toBeNull();
		expect(lines[1].putsSinceLastRun).toBe(1);
	});

	const logFile = () =>
		path.join(kit.repoRoot as string, warmFractionLog.LOG_SUBPATH);

	it("writes no line under --no-log", async () => {
		// A run made to produce a figure measures the harness rather than the
		// churn, so it must not enter the record it would be quoted from (mantahostels#628).
		const r = await here({ issues: [{ number: 1, body: "one" }] }, [
			"--no-log",
		]);
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/WRITE-SET CACHE/);
		expect(fs.existsSync(logFile())).toBe(false);
	});

	it("writes no line for a run against another repository", async () => {
		const r = await run({ issues: [{ number: 1, body: "one" }] });
		expect(r.status).toBe(0);
		// The run has to have got that far: an absent file alone would pass against
		// a run that fell over before reaching the log.
		expect(r.out).toMatch(/TAKEABLE NOW: 1/);
		expect(fs.existsSync(logFile())).toBe(false);
	});

	it("logs the whole frontier, not the --limit slice", async () => {
		// Recording the slice instead would shrink the denominator the warm
		// fraction is taken over.
		const r = await here(
			{
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
				],
			},
			["--limit", "1", "--no-prewarm"],
		);
		expect(r.order()).toEqual([1]);
		expect(readLog()[0].frontier).toBe(2);
		expect(readLog()[0].cold).toBe(2);
	});

	it("leaves the exit code and the shortlist alone when the append fails", async () => {
		// A directory where the log file belongs.
		fs.mkdirSync(logFile(), { recursive: true });
		const fx = {
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
			],
		};
		const r = await here(fx);
		expect(r.status).toBe(0);
		expect(r.order()).toEqual([1, 2]);
		expect(r.out).toMatch(/TAKEABLE NOW: 2/);
		expect(r.out).toMatch(
			/This run went unrecorded for mantahostels#628's warm fraction/,
		);
		const j = await here(fx, ["--json"]);
		expect(j.status).toBe(0);
		expect(j.json().warmFractionLogged.ok).toBe(false);
		expect(j.json().frontier).toHaveLength(2);
	});

	it("says a failed append went unrecorded even with nothing to derive", async () => {
		// Printed inside the cache block, the warning would be lost by a run with
		// an empty frontier.
		fs.mkdirSync(logFile(), { recursive: true });
		const r = await here({
			issues: [{ number: 1, body: "one" }],
			deps: { 1: [{ number: 2, state: "open" }] },
		});
		expect(r.status).toBe(0);
		expect(r.out).not.toMatch(/WRITE-SET CACHE/);
		expect(r.out).toMatch(/This run went unrecorded/);
	});

	describe("pre-warming a miss in the run that finds it (mantahostels#1001)", () => {
		it("prints a provisional row apart from a warm one, and says it has no size", async () => {
			store(1, "one");
			const r = await here({
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, title: "Do the thing", body: "two" },
				],
			});
			expect(r.out).toMatch(/warm {2}#1 {2}1 path\(s\), M — what it does/);
			expect(r.out).toMatch(
				/prov {2}#2 {2}0 path\(s\), no size \(predicted: small\) — Do the thing/,
			);
		});

		it("carries the two apart in --json, so a reader taking `warm` gets band reads only", async () => {
			store(1, "one");
			const r = await here(
				{
					issues: [
						{ number: 1, body: "one" },
						{ number: 2, title: "Do the thing", body: "two" },
					],
				},
				["--json"],
			);
			const j = r.json().writeSetCache;
			expect(j.warm.map((w: { number: number }) => w.number)).toEqual([1]);
			expect(j.provisional).toEqual([
				{
					number: 2,
					writeSet: [],
					sizeBand: null,
					predictedSize: "small",
					gist: "Do the thing",
					derivedAt: expect.any(String),
					provisional: true,
					replaced: "cold",
					unrevalidated: false,
				},
			]);
			expect(j.cold).toEqual([]);
			expect(j.prewarmed).toBe(true);
		});

		it("predicts the paths the body names, plus doc-map off a §B entry", async () => {
			stubRepo(["scripts/a.js", "docs/doc-map.md"]);
			const r = await here(
				{ issues: [{ number: 1, body: "edit `scripts/a.js`, register §B7" }] },
				["--json"],
			);
			expect(r.json().writeSetCache.provisional[0].writeSet).toEqual([
				"docs/doc-map.md",
				"scripts/a.js",
			]);
		});

		it("leaves a wayfinder:map issue cold, and says why", async () => {
			// Its substrate is its own body, so whatever its prose backticks is not
			// what it would write.
			const r = await here(
				{
					issues: [
						{ number: 1, body: "`scripts/a.js`", labels: ["wayfinder:map"] },
					],
				},
				["--json"],
			);
			expect(r.json().writeSetCache.cold[0].number).toBe(1);
			expect(r.json().writeSetCache.prewarmSkipped).toEqual([
				{ number: 1, why: expect.stringMatching(/wayfinder:map/) },
			]);
			const text = await here({
				issues: [
					{ number: 1, body: "`scripts/a.js`", labels: ["wayfinder:map"] },
				],
			});
			expect(text.out).toMatch(/not predicted: #1 — wayfinder:map/);
		});

		it("records the provisional tickets apart from warm in the measurement log", async () => {
			// Folding them into `warm` would drive every line towards 100% and make
			// mantahostels#385's 60-80% claim untestable.
			store(1, "one");
			await here({
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
				],
			});
			expect(readLog()[0].warm).toBe(1);
			expect(readLog()[0].provisional).toBe(1);
			expect(readLog()[0].cold).toBe(0);
			expect(readLog()[0].provisionalNumbers).toEqual([2]);
		});

		it("changes neither the order nor the shortlist", async () => {
			const r = await here({
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
				],
			});
			expect(r.order()).toEqual([1, 2]);
			expect(r.out).toMatch(/TAKEABLE NOW: 2/);
		});

		it("stores nothing at all under --no-prewarm", async () => {
			const r = await here({ issues: [{ number: 1, body: "one" }] }, [
				"--json",
				"--no-prewarm",
			]);
			expect(r.json().writeSetCache.prewarmed).toBe(false);
			expect(writeSetCache.readEntry(kit.repoRoot, 1)).toBeNull();
		});

		it("stores nothing against another repository, whose issue numbers are not ours", async () => {
			const r = await run({ issues: [{ number: 1, body: "one" }] }, ["--json"]);
			expect(r.json().writeSetCache.provisional).toEqual([]);
			expect(writeSetCache.readEntry(kit.repoRoot, 1)).toBeNull();
		});
	});
});

describe("the selection marker that arms guard-selection-sum.js (mantahostels#844)", () => {
	const here = (fx: Fixture, args: string[] = []) =>
		run(fx, args, { ownRepo: true });

	/** The id the harness gives the run, which is what the marker is keyed on. */
	const marker = () => selectionMarker.read(kit.repoRoot, kit.oracleSelfId);

	it("records the frontier a real run measured", async () => {
		const r = await here({
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
			],
		});
		expect(r.status).toBe(0);
		expect(marker()?.frontier).toBe(2);
	});

	it("records the whole frontier, not the --limit slice", async () => {
		// The guard checks the stated frontier against this number, so recording
		// the slice would make every honest accounting look like an invented one.
		const r = await here(
			{
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
					{ number: 3, body: "three" },
				],
			},
			["--limit", "1"],
		);
		expect(r.status).toBe(0);
		expect(marker()?.frontier).toBe(3);
	});

	it("records the admission slot count the run measured (mantahostels#1321)", async () => {
		// The guard demands §6's admission-cut line where the sessions dispatched
		// reach this number, so it must be the same figure the ADMISSION block
		// printed — not one the marker derived on its own.
		const r = await here({ issues: [{ number: 1, body: "one" }] });
		expect(r.status).toBe(0);
		const printed = r.out.match(/free slots\s+(\d+)/);
		expect(
			printed,
			"the run must print a slot count to compare against",
		).not.toBeNull();
		expect(marker()?.slots).toBe(Number((printed as RegExpMatchArray)[1]));
	});

	it("mints nothing under --no-log", async () => {
		// A run exercising the tooling dispatches nothing, so a Stop hook must not
		// start demanding §5's sum of it (mantahostels#628's flag, reused).
		const r = await here({ issues: [{ number: 1, body: "one" }] }, [
			"--no-log",
		]);
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/TAKEABLE NOW: 1/);
		expect(marker()).toBeNull();
	});
});

describe("the full-JSON snapshot every run leaves on disk", () => {
	const here = (fx: Fixture, args: string[] = []) =>
		run(fx, args, { ownRepo: true });
	const snapshotPath = () =>
		path.join(
			String(kit.repoRoot),
			".claude",
			"tmp",
			"markers",
			".pick-next",
			"last-run.json",
		);
	const readSnapshot = () =>
		JSON.parse(fs.readFileSync(snapshotPath(), "utf8"));

	it("writes the report on a plain text run, which asked for no JSON at all", async () => {
		const r = await here({ issues: [{ number: 1, body: "one" }] });
		expect(r.status).toBe(0);
		expect(readSnapshot().openIssues).toBe(1);
	});

	it("names the file it wrote, at the end where a tail still sees it", async () => {
		// Tailing the output is the failure this exists to fix, so a pointer at
		// the top would be lost by exactly the reader who needs it.
		const r = await here({ issues: [{ number: 1, body: "one" }] });
		expect(r.out).toMatch(/FULL JSON OF THIS RUN: .*last-run\.json/);
		// Genuinely last, not merely near the end: an "Advisory only" line
		// printed after it would leave a reader tailing two lines seeing neither.
		const lines = r.out.trimEnd().split("\n");
		expect(lines.at(-3)).toMatch(/FULL JSON OF THIS RUN/);
		expect(lines.at(-1)).toMatch(/Check its generatedAt and repo/);
		// The "Advisory only" line comes before it.
		expect(lines.slice(0, -3).join("\n")).toMatch(/Advisory only/);
	});

	it("records which repo and which flags produced it", async () => {
		// One file holds whatever ran last, so a reader told to trust it instead
		// of re-running needs to see that this was another tracker's run.
		const r = await here({ issues: [{ number: 1, body: "one" }] }, [
			"--no-log",
			"--limit",
			"1",
		]);
		expect(r.status).toBe(0);
		expect(readSnapshot().argv).toEqual(["--no-log", "--limit", "1"]);
		expect(typeof readSnapshot().repo).toBe("string");
		expect(readSnapshot().repo).toBeTruthy();
	});

	it("carries the whole frontier, not the --limit slice", async () => {
		// mantahostels#1289: a truncated written `frontier` forced a second full run to read
		// the tie band. `--limit` now caps only the printed table.
		const r = await here(
			{
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
					{ number: 3, body: "three" },
				],
			},
			["--limit", "1"],
		);
		expect(r.status).toBe(0);
		expect(readSnapshot().frontier).toHaveLength(3);
		expect(readSnapshot().frontierCount).toBe(3);
		expect(readSnapshot().summary.shown).toBe(1);
	});

	it("writes the same report --json prints, so re-running buys nothing", async () => {
		const r = await here({ issues: [{ number: 1, body: "one" }] }, ["--json"]);
		expect(r.status).toBe(0);
		const printed = r.json();
		const written = readSnapshot();
		// generatedAt is the one field a second run would legitimately move.
		delete printed.generatedAt;
		delete written.generatedAt;
		expect(written).toEqual(printed);
	});

	it("reports a write it could not make, and still answers", async () => {
		// The run's own answer is on stdout; losing the copy must not lose it.
		fs.mkdirSync(String(kit.repoRoot), { recursive: true });
		fs.mkdirSync(path.join(String(kit.repoRoot), ".claude", "tmp", "markers"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(
				String(kit.repoRoot),
				".claude",
				"tmp",
				"markers",
				".pick-next",
			),
			"not a dir",
		);
		const r = await here({ issues: [{ number: 1, body: "one" }] });
		expect(r.status).toBe(0);
		expect(r.out).toMatch(/TAKEABLE NOW: 1/);
		expect(r.out).toMatch(/FULL JSON NOT WRITTEN — /);
	});
});

describe("the substrate-conflict graph (mantahostels#1002)", () => {
	/*
	 * `ownRepo` throughout: the write-set cache is keyed on the tree, and a
	 * band-read write-set is the graph's better input — a body's backticked
	 * paths are only its floor.
	 */
	const here = (fx: Fixture, args: string[] = []) =>
		run(fx, args, { ownRepo: true });

	/** A warm cache entry, the shape `pick-next-cache.js put` writes. */
	const warm = (
		number: number,
		body: string,
		fields: Record<string, unknown>,
	) =>
		writeSetCache.writeEntry(kit.repoRoot, {
			issue: number,
			bodyHash: writeSetCache.bodyHash(body),
			trackedAtDerive: [],
			sizeBand: "M",
			gist: "what it does",
			...fields,
		});

	/** The graph block alone, so an assertion cannot pass on the table above it. */
	const block = (out: string) =>
		out.split("SUBSTRATE-CONFLICT GRAPH")[1]?.split("\nWRITE-SET CACHE")[0] ??
		"";

	it("names the pair sharing a file, and keeps the higher-ranked one", async () => {
		warm(1, "one", { writeSet: ["scripts/a.js"] });
		warm(2, "two", { writeSet: ["scripts/a.js"] });
		warm(3, "three", { writeSet: ["scripts/c.js"] });
		const r = await here({
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
				{ number: 3, body: "three" },
			],
		});
		expect(block(r.out)).toMatch(/#1 <-> #2 on scripts\/a\.js/);
		expect(block(r.out)).toMatch(/PROPOSED DISJOINT SET \(2\)[\s\S]*#1, #3/);
		expect(block(r.out)).toMatch(
			/not in it: #2 — #1 already in the set names scripts\/a\.js/,
		);
	});

	it("names the running session whose held file rules a candidate out", async () => {
		kit.oracleSessions = ["self", "worker"];
		kit.oracleNames = { worker: "Implement 900" };
		warm(1, "one", { writeSet: ["scripts/a.js"] });
		const r = await here({
			issues: [{ number: 1, body: "one" }],
			heldFiles: { "scripts/a.js": "worker" },
		});
		expect(block(r.out)).toMatch(/#1 — Implement 900 holds scripts\/a\.js/);
		expect(block(r.out)).toMatch(/PROPOSED DISJOINT SET \(0\)[\s\S]*empty/);
	});

	it("reports a doc-map-only overlap as stamp-sharing, and runs both", async () => {
		warm(1, "one", { writeSet: ["docs/doc-map.md"] });
		warm(2, "two", { writeSet: ["docs/doc-map.md"] });
		const r = await here({
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
			],
		});
		expect(block(r.out)).toMatch(
			/1 pair shares only docs\/doc-map\.md — a STAMP/,
		);
		expect(block(r.out)).not.toMatch(/candidate pairs naming one file/);
		expect(block(r.out)).toMatch(/PROPOSED DISJOINT SET \(2\)[\s\S]*#1, #2/);
	});

	it("prints a merge-test pair only where both sides are sized small", async () => {
		warm(1, "one", { writeSet: ["docs/doc-map.md"], sizeBand: "small" });
		warm(2, "two", { writeSet: ["docs/doc-map.md"], sizeBand: "small" });
		warm(3, "three", { writeSet: ["docs/doc-map.md"], sizeBand: "large" });
		const r = await here({
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
				{ number: 3, body: "three" },
			],
		});
		const pairs = block(r.out).split("merge-test pairs")[1] ?? "";
		expect(pairs).toMatch(/#1 \+ #2 on docs\/doc-map\.md/);
		// mantahostels#3 is not small, so it pairs with nobody — though it is still admitted.
		expect(pairs.split("PROPOSED")[0]).not.toMatch(/#3/);
		// Two of three limbs, said in the block itself.
		expect(block(r.out)).toMatch(/disjoint edit targets .* is\n {2}yours/);
	});

	it("falls back to the paths a cold body names, and says none was predicted", async () => {
		stubRepo(["scripts/a.js"]);
		const r = await here({
			issues: [
				{ number: 1, body: "edits `scripts/a.js`" },
				{ number: 2, body: "edits `scripts/a.js` too" },
				{ number: 3, body: "names no file at all" },
			],
		});
		expect(block(r.out)).toMatch(/#1 <-> #2 on scripts\/a\.js/);
		expect(block(r.out)).toMatch(/no write-set predicted[\s\S]*#3/);
		// Predicted nothing is not predicted safe: mantahostels#3 is admitted all the same.
		expect(block(r.out)).toMatch(/PROPOSED DISJOINT SET \(2\)[\s\S]*#1, #3/);
	});

	it("summarises the conflicting pairs by file, hottest first", async () => {
		warm(1, "one", { writeSet: ["scripts/hot.js"] });
		warm(2, "two", { writeSet: ["scripts/hot.js"] });
		warm(3, "three", { writeSet: ["scripts/hot.js"] });
		const r = await here({
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
				{ number: 3, body: "three" },
			],
		});
		expect(block(r.out)).toMatch(/3 candidate pairs name one file, by file:/);
		expect(block(r.out)).toMatch(/scripts\/hot\.js — 3 pairs/);
	});

	it("agrees its verbs on the singular row", async () => {
		warm(1, "one", { writeSet: ["scripts/hot.js"] });
		warm(2, "two", { writeSet: ["scripts/hot.js"] });
		const r = await here({
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
			],
		});
		expect(block(r.out)).toMatch(/1 candidate pair names one file/);
		expect(block(r.out)).toMatch(/scripts\/hot\.js — 1 pair$/m);
	});

	it("says how many write-sets are the body's floor rather than a band read", async () => {
		stubRepo(["scripts/a.js"]);
		warm(1, "one", { writeSet: ["scripts/a.js"] });
		const r = await here({
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "also edits `scripts/a.js`" },
			],
		});
		expect(block(r.out)).toMatch(
			/1 of 2 write-sets above are the body's backticked/,
		);
	});

	it("truncates a session name long enough to push the file off the row", async () => {
		kit.oracleSessions = ["self", "worker"];
		kit.oracleNames = {
			worker:
				"Implement 922, 989: What replaces the per-push pricing rule once nothing is billed",
		};
		warm(1, "one", { writeSet: ["scripts/a.js"] });
		const r = await here({
			issues: [{ number: 1, body: "one" }],
			heldFiles: { "scripts/a.js": "worker" },
		});
		expect(block(r.out)).toMatch(
			/#1 — Implement 922, 989: What replaces… holds scripts\/a\.js/,
		);
		expect(block(r.out)).toMatch(
			/not in it: #1 — Implement 922, 989: What replaces… holds scripts\/a\.js/,
		);
		// --json keeps the whole name: the truncation is the row's, not the data's.
		const j = (
			await run(
				{
					issues: [{ number: 1, body: "one" }],
					heldFiles: { "scripts/a.js": "worker" },
				},
				["--json"],
				{ ownRepo: true },
			)
		).json();
		expect(j.conflictGraph.inFlight[0].session).toBe(kit.oracleNames.worker);
	});

	it("carries the whole graph in --json", async () => {
		warm(1, "one", { writeSet: ["scripts/a.js"], sizeBand: "small" });
		warm(2, "two", { writeSet: ["scripts/a.js"], sizeBand: "small" });
		const r = await here(
			{
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
				],
			},
			["--json"],
		);
		const g = r.json().conflictGraph;
		expect(g.conflicts).toEqual([{ a: 1, b: 2, paths: ["scripts/a.js"] }]);
		expect(g.proposed).toEqual([1]);
		expect(g.mergeable).toEqual([{ a: 1, b: 2, paths: ["scripts/a.js"] }]);
		expect(g.stamps).toEqual(["docs/doc-map.md", "CLAUDE.md"]);
	});

	it("DISPATCHABLE FLOOR counts proposed members minus takes:human and takes:children", async () => {
		warm(1, "one", { writeSet: ["scripts/a.js"] });
		warm(2, "two", { writeSet: ["scripts/b.js"] });
		warm(3, "three", { writeSet: ["scripts/c.js"] });
		const issues = [
			{ number: 1, body: "one", labels: ["takes:implement"] },
			{ number: 2, body: "two", labels: ["takes:human"] },
			{ number: 3, body: "three", labels: ["takes:children"] },
		];
		const j = (await here({ issues }, ["--json"])).json();
		expect(j.conflictGraph.proposed).toEqual([1, 2, 3]);
		expect(j.dispatchableFloor).toBe(1);

		const r = await here({ issues });
		expect(r.out).toMatch(/DISPATCHABLE FLOOR: 1/);
	});

	it("refuses nothing: every candidate is still on the shortlist above", async () => {
		kit.oracleSessions = ["self", "worker"];
		warm(1, "one", { writeSet: ["scripts/a.js"] });
		warm(2, "two", { writeSet: ["scripts/a.js"] });
		const r = await here({
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
			],
			heldFiles: { "scripts/a.js": "worker" },
		});
		expect(r.status).toBe(0);
		expect(r.order()).toEqual([1, 2]);
		// And the header says what the block is not, where the reader meets it.
		expect(block(r.out)).toMatch(/NOT a substrate call/);
		expect(block(r.out)).toMatch(/candidate for that test, never its verdict/);
	});

	it("keeps every file claim where the oracle could not be read, and says so", async () => {
		kit.oracleFails = true;
		warm(1, "one", { writeSet: ["scripts/a.js"] });
		const r = await here({
			issues: [{ number: 1, body: "one" }],
			heldFiles: { "scripts/a.js": "whoever" },
		});
		expect(block(r.out)).toMatch(/ruled out by a running session/);
		expect(block(r.out)).toMatch(/CLAIMS DEGRADED/);
		expect(block(r.out)).toMatch(/may be free/);
	});

	describe("bandReadRequired — skip the band read when empty (mantahostels#1485)", () => {
		it("is false and says so where nothing is nominated and nothing is cold", async () => {
			warm(1, "one", { writeSet: ["scripts/a.js"], sizeBand: "small" });
			const r = await here({ issues: [{ number: 1, body: "one" }] }, [
				"--json",
			]);
			expect(r.json().bandReadRequired).toBe(false);
			const text = await here({ issues: [{ number: 1, body: "one" }] });
			expect(block(text.out)).toMatch(/NO BAND READ REQUIRED THIS RUN/);
		});

		it("is true where the nomination list is non-empty", async () => {
			stubRepo(["scripts/a.js"]);
			const r = await here(
				{
					issues: [
						{ number: 1, body: "edits `scripts/a.js`" },
						{ number: 2, body: "also edits `scripts/a.js`" },
					],
				},
				["--json"],
			);
			expect(r.json().conflictGraph.nominated.length).toBeGreaterThan(0);
			expect(r.json().bandReadRequired).toBe(true);
			const text = await here({
				issues: [
					{ number: 1, body: "edits `scripts/a.js`" },
					{ number: 2, body: "also edits `scripts/a.js`" },
				],
			});
			expect(block(text.out)).toMatch(/BAND READ REQUIRED THIS RUN/);
		});
	});
});

describe("the run summary (mantahostels#1001)", () => {
	/** The RUN SUMMARY block alone, so a match cannot land in another block. */
	const block = (out: string) =>
		out.split("RUN SUMMARY")[1]?.split("\nAdvisory only")[0] ?? "";

	it("carries the frontier count, the admission verdict and the shortlist size", async () => {
		const r = await run({
			issues: [
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
				{ number: 3, body: "three" },
			],
		});
		expect(block(r.out)).toMatch(/open issues +3/);
		expect(block(r.out)).toMatch(/frontier +3/);
		expect(block(r.out)).toMatch(/admission +START ONE NOW/);
	});

	it("gives the frontier, never the --limit slice, as the accounting denominator", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
					{ number: 3, body: "three" },
				],
			},
			["--limit", "1"],
		);
		expect(block(r.out)).toMatch(/frontier +3 /);
		expect(block(r.out)).toMatch(/shown +1/);
	});

	it("names the frontier issues whose takes: label is missing or doubled", async () => {
		const r = await run({
			issues: [
				{ number: 1, body: "one", labels: [] },
				{ number: 2, body: "two", labels: ["takes:implement", "takes:triage"] },
				{ number: 3, body: "three", labels: ["takes:implement"] },
			],
		});
		expect(block(r.out)).toMatch(
			/labelling +#1 \(none\), #2 \(implement\+triage\)/,
		);
		expect(block(r.out)).toMatch(/check-issue-labels\.js/);
		// mantahostels#3 carries exactly one value, so the labelling line must not name it —
		// asserted on that line alone, since the proposed set names it legitimately.
		const labelling = block(r.out)
			.split("\n")
			.find((l) => l.includes("labelling"));
		expect(labelling).not.toMatch(/#3/);
	});

	it("says nothing about labelling when every frontier issue carries one value", async () => {
		const r = await run({
			issues: [{ number: 1, body: "one", labels: ["takes:implement"] }],
		});
		expect(block(r.out)).not.toMatch(/labelling/);
	});

	it("reports the readiness-unknown count, and stays silent when there is none", async () => {
		const clean = await run({ issues: [{ number: 1, body: "one" }] });
		expect(block(clean.out)).not.toMatch(/degraded/);
		const r = await run({
			issues: [{ number: 1, body: "one" }],
			failDeps: [1],
		});
		expect(block(r.out)).toMatch(/degraded +1 readiness unknown/);
	});

	it("reports reclaimable sessions, which mean the headroom is understated", async () => {
		kit.oracleSessions = ["self", "done-one"];
		kit.oracleFinished = ["done-one"];
		const r = await run({ issues: [{ number: 1, body: "one" }] });
		expect(block(r.out)).toMatch(/reclaimable +1 /);
		expect(block(r.out)).toMatch(/headroom understated/);
	});

	it("splits the write-set cache into warm, provisional and to-derive", async () => {
		writeSetCache.writeEntry(kit.repoRoot, {
			issue: 1,
			bodyHash: writeSetCache.bodyHash("one"),
			writeSet: ["scripts/a.js"],
			trackedAtDerive: [],
			sizeBand: "small",
			gist: "what it does",
		});
		const r = await run(
			{
				issues: [
					{ number: 1, body: "one" },
					{ number: 2, body: "two" },
				],
			},
			[],
			{ ownRepo: true },
		);
		expect(block(r.out)).toMatch(
			/write-sets +1 warm, 1 provisional, 0 to derive/,
		);
	});

	it("carries every summary figure into --json, so a reader makes one read", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, body: "one", labels: [] },
					{ number: 2, body: "two", labels: ["takes:implement"] },
				],
			},
			["--json", "--limit", "1"],
		);
		const s = r.json().summary;
		expect(s.openIssues).toBe(2);
		expect(s.frontierCount).toBe(2);
		expect(s.shown).toBe(1);
		expect(s.admit).toBe(true);
		expect(s.degraded).toBe(0);
		expect(s.labelDefects).toEqual([{ number: 1, takes: [] }]);
		expect(s.writeSets).toEqual({ warm: 0, provisional: 0, cold: 0 });
	});

	it("prints a --limit-cut issue's label defect on the labelling row", async () => {
		const r = await run(
			{
				issues: [
					{ number: 1, body: "one", labels: ["takes:implement"] },
					{ number: 2, body: "two", labels: [] },
				],
			},
			["--limit", "1"],
		);
		expect(r.status).toBe(0);
		expect(block(r.out)).toMatch(/labelling +#2 \(none\)/);
		expect(block(r.out)).toMatch(/check-issue-labels\.js/);
	});

	it("prints the proposed set as a count, never as its numbers", async () => {
		stubRepo(["scripts/a.js", "scripts/b.js"]);
		const r = await run(
			{
				issues: [
					{ number: 1, body: "writes `scripts/a.js`" },
					{ number: 2, body: "writes `scripts/b.js`" },
				],
			},
			[],
			{ ownRepo: true },
		);
		const line = block(r.out)
			.split("\n")
			.find((l) => l.includes("proposed set"));
		expect(line).toMatch(/2 candidates/);
		expect(line).not.toMatch(/#1/);
	});

	it("names the admission figures as this run's, and sends the reader to re-read them", async () => {
		const r = await run({ issues: [{ number: 1, body: "one" }] });
		expect(block(r.out)).toMatch(
			/admission .*as of this run — re-read it with node scripts\/admission\.js/,
		);
	});

	it("holds, and says so, when the machine has no room", async () => {
		// A second live session: with none, the always-admit-one rule admits
		// whatever the headroom.
		kit.oracleSessions = ["self", "other"];
		kit.psOut = sessionProcs("other").join("\n");
		kit.memAvailableKb = 200 * 1024;
		const r = await run({ issues: [{ number: 1, body: "one" }] }, ["--json"]);
		expect(r.status).toBe(0);
		expect(r.json().summary.admit).toBe(false);
	});

	/*
	 * mantahostels#1780: the summary's `carrying` figure is null two ways — nobody asked git,
	 * or git would not answer — and only the second may be reported as "unknown
	 * how many carrying", which claims git WAS asked.
	 */
	it("drops the carrying parenthetical when the stranded count itself is unknown", async () => {
		kit.oracleSessions = ["self"];
		stubRepo(["scripts/dirty.js"]);
		const counted = await run({
			issues: [{ number: 1, body: "one" }],
			staleFiles: {
				a: { path: "scripts/dirty.js", sessionId: "dead-1", hoursAgo: 24 },
			},
		});
		expect(block(counted.out)).toMatch(
			/1 stranded claims \(1 carrying uncommitted work\)/,
		);

		kit.oracleFails = true;
		const r = await run({ issues: [{ number: 1, body: "one" }] });
		expect(block(r.out)).toMatch(/unknown stranded claims/);
		expect(block(r.out)).not.toMatch(/carrying uncommitted work/);
	});

	it("reports a failed reclaimable probe as unknown, never as silence a reader reads as zero", async () => {
		kit.oracleSelfId = "";
		kit.oracleSessions = ["self", "a"];
		kit.oracleFinished = ["a"];
		const r = await run({ issues: [{ number: 1, body: "one" }] });
		expect(block(r.out)).toMatch(/reclaimable +unknown \(/);
		expect(block(r.out)).toMatch(/CLAUDE_CODE_SESSION_ID/);
		const s = (
			await run({ issues: [{ number: 1, body: "one" }] }, ["--json"])
		).json().summary;
		expect(s.reclaimable).toBeNull();
		expect(s.reclaimableUnknown).toMatch(/CLAUDE_CODE_SESSION_ID/);
	});

	it("exits 0 on every summary above", async () => {
		const r = await run({ issues: [{ number: 1, body: "one" }] });
		expect(r.status).toBe(0);
	});
});
