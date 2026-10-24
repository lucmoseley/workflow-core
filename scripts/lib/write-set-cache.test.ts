// @vitest-environment node
/*
 * Pins the per-issue write-set cache: an entry keyed on the issue body alone,
 * a malformed store read as a miss, promotion, pruning, and a provisional
 * entry never counted as a band read (mantahostels#385, mantahostels#1001).
 *
 * Exercised against a throwaway root: pointing it at this repo would write the
 * real cache.
 *
 * Breaking it costs `/pick-next` either a stale write-set, so it pairs issues
 * that collide on a file, or a cold cache that re-buys every band read.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	CACHE_SUBDIR,
	bodyHash,
	cacheDir,
	readEntry,
	writeEntry,
	lookup,
	lookupAll,
	prune,
	countDerivedSince,
} = require("./write-set-cache.js");

let root: string;

/** `trackedFiles()`'s shape, as pick-next.js passes it in. */
const tracked = (files: string[]) => ({ ok: true, files });
const trackedFailed = { ok: false, error: "git ls-files: not a repository" };

/** Writes an entry the way the CLI does. */
const put = (
	issue: number,
	body: string,
	fields: Record<string, unknown> = {},
) =>
	writeEntry(root, {
		issue,
		bodyHash: bodyHash(body),
		writeSet: [],
		sizeBand: "M",
		gist: "a gist",
		...fields,
	});

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "write-set-cache-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("the staleness key", () => {
	it("ignores a ticked checkbox, which moves the body without changing the work", () => {
		const before = "## Acceptance criteria\n\n- [ ] one\n- [ ] two\n";
		const after = "## Acceptance criteria\n\n- [x] one\n- [ ] two\n";
		expect(bodyHash(after)).toBe(bodyHash(before));
	});

	it("ignores an upper-case tick too, which some clients write", () => {
		expect(bodyHash("- [X] one")).toBe(bodyHash("- [ ] one"));
	});

	it("changes when the prose changes", () => {
		expect(bodyHash("write scripts/a.js")).not.toBe(
			bodyHash("write scripts/b.js"),
		);
	});

	it("flattens a task-list tick and leaves an [x](url) link alone", () => {
		// Unanchored, the same pattern rewrites the link, so two bodies differing
		// only there would collide.
		expect(bodyHash("* [X] one")).toBe(bodyHash("* [ ] one"));
		expect(bodyHash("see [x](http://u) inline")).not.toBe(
			bodyHash("see [ ](http://u) inline"),
		);
	});

	it("treats a missing body as the empty one rather than throwing", () => {
		expect(bodyHash(null)).toBe(bodyHash(""));
		expect(bodyHash(undefined)).toBe(bodyHash(""));
	});
});

describe("the store", () => {
	it("puts one file per issue under the gitignored subdirectory", () => {
		put(7, "a body");
		expect(fs.existsSync(path.join(root, CACHE_SUBDIR, "7.json"))).toBe(true);
	});

	it("stamps when the entry was derived", () => {
		put(7, "a body");
		expect(Date.parse(readEntry(root, 7).derivedAt)).not.toBeNaN();
	});

	it("overwrites in place, so two sessions deriving the same body agree", () => {
		// A per-issue entry is a pure function of the body, so last-writer-wins
		// loses nothing.
		put(7, "a body", { gist: "first" });
		put(7, "a body", { gist: "second" });
		expect(readEntry(root, 7).gist).toBe("second");
		expect(fs.readdirSync(cacheDir(root))).toEqual(["7.json"]);
	});

	it("reports an unwritable store instead of throwing", () => {
		fs.mkdirSync(path.join(root, ".claude", "tmp", "markers"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(root, ".claude", "tmp", "markers", ".pick-next"),
			"",
		);
		expect(put(7, "a body").ok).toBe(false);
	});

	it("reads a missing or corrupt entry as absent", () => {
		expect(readEntry(root, 7)).toBeNull();
		fs.mkdirSync(cacheDir(root), { recursive: true });
		fs.writeFileSync(path.join(cacheDir(root), "8.json"), "{not json");
		expect(readEntry(root, 8)).toBeNull();
	});

	it("rejects an entry whose issue number disagrees with its filename", () => {
		fs.mkdirSync(cacheDir(root), { recursive: true });
		fs.writeFileSync(
			path.join(cacheDir(root), "9.json"),
			JSON.stringify({ issue: 10, bodyHash: "x", writeSet: [] }),
		);
		expect(readEntry(root, 9)).toBeNull();
	});

	it("rejects an entry whose write-set is not a list of paths", () => {
		fs.mkdirSync(cacheDir(root), { recursive: true });
		fs.writeFileSync(
			path.join(cacheDir(root), "9.json"),
			JSON.stringify({ issue: 9, bodyHash: "x", writeSet: "scripts/a.js" }),
		);
		expect(readEntry(root, 9)).toBeNull();
	});

	it("rejects an entry whose predictedSize is not small/medium/large/absent", () => {
		fs.mkdirSync(cacheDir(root), { recursive: true });
		fs.writeFileSync(
			path.join(cacheDir(root), "9.json"),
			JSON.stringify({
				issue: 9,
				bodyHash: "x",
				writeSet: [],
				predictedSize: "huge",
			}),
		);
		expect(readEntry(root, 9)).toBeNull();
	});

	it("round-trips a predicted size, and coerces anything else to null", () => {
		put(7, "a body", { predictedSize: "medium" });
		expect(readEntry(root, 7).predictedSize).toBe("medium");
		put(7, "a body", { predictedSize: "huge" });
		expect(readEntry(root, 7).predictedSize).toBeNull();
	});

	it("reads the band of an entry stored under the old `size` key (#1494)", () => {
		fs.mkdirSync(cacheDir(root), { recursive: true });
		fs.writeFileSync(
			path.join(cacheDir(root), "9.json"),
			JSON.stringify({
				issue: 9,
				bodyHash: "x",
				writeSet: [],
				size: "small",
			}),
		);
		const e = readEntry(root, 9);
		expect(e.sizeBand).toBe("small");
		expect(e).not.toHaveProperty("size");
	});

	it("re-stores an old-key entry under the new key on its next write", () => {
		fs.mkdirSync(cacheDir(root), { recursive: true });
		fs.writeFileSync(
			path.join(cacheDir(root), "7.json"),
			JSON.stringify({
				issue: 7,
				bodyHash: bodyHash("a body"),
				writeSet: ["scripts/new.js"],
				trackedAtDerive: [],
				size: "L",
			}),
		);
		lookupAll(
			root,
			[{ number: 7, body: "a body" }],
			tracked(["scripts/new.js"]),
		);
		const raw = JSON.parse(
			fs.readFileSync(path.join(cacheDir(root), "7.json"), "utf8"),
		);
		expect(raw.sizeBand).toBe("L");
		expect(raw).not.toHaveProperty("size");
	});
});

describe("lookup", () => {
	const issue = (number: number, body: string) => ({ number, body });

	it("hits when the body still hashes to the stored key", () => {
		put(7, "a body", { writeSet: ["scripts/a.js"], trackedAtDerive: [] });
		const r = lookup(root, issue(7, "a body"), tracked([]));
		expect(r.state).toBe("hit");
		expect(r.entry.writeSet).toEqual(["scripts/a.js"]);
	});

	it("hits through a tick", () => {
		put(7, "- [ ] one");
		expect(lookup(root, issue(7, "- [x] one"), tracked([])).state).toBe("hit");
	});

	it("misses when the body was really edited", () => {
		put(7, "a body");
		expect(lookup(root, issue(7, "a different body"), tracked([])).state).toBe(
			"body-changed",
		);
	});

	it("misses when there is no entry at all", () => {
		expect(lookup(root, issue(7, "a body"), tracked([])).state).toBe("cold");
	});

	it("re-derives an entry whose path was renamed out from under it", () => {
		put(7, "a body", {
			writeSet: ["scripts/old-name.js"],
			trackedAtDerive: ["scripts/old-name.js"],
		});
		const r = lookup(
			root,
			issue(7, "a body"),
			tracked(["scripts/new-name.js"]),
		);
		expect(r.state).toBe("path-gone");
		expect(r.gonePaths).toEqual(["scripts/old-name.js"]);
	});

	it("keeps an entry predicting a file the issue has yet to create", () => {
		// Untracked at derive time means "this issue makes it", not "renamed":
		// promoting such a path would read it as renamed away on every later run.
		put(7, "a body", {
			writeSet: ["scripts/not-yet.js"],
			trackedAtDerive: [],
		});
		const r = lookup(root, issue(7, "a body"), tracked([]));
		expect(r.state).toBe("hit");
		expect(r.promotable).toBeUndefined();
	});

	it("promotes a path the issue has since created into the rename check", () => {
		put(7, "a body", { writeSet: ["scripts/new.js"], trackedAtDerive: [] });
		const r = lookup(root, issue(7, "a body"), tracked(["scripts/new.js"]));
		expect(r.state).toBe("hit");
		expect(r.promotable).toEqual(["scripts/new.js"]);
	});

	it("promotes nothing where every write-set path was already tracked", () => {
		put(7, "a body", {
			writeSet: ["scripts/a.js"],
			trackedAtDerive: ["scripts/a.js"],
		});
		expect(
			lookup(root, issue(7, "a body"), tracked(["scripts/a.js"])).promotable,
		).toBeUndefined();
	});

	it("promotes nothing when git could not list the tree", () => {
		// An absent listing is not evidence a file was created.
		put(7, "a body", { writeSet: ["scripts/new.js"], trackedAtDerive: [] });
		expect(
			lookup(root, issue(7, "a body"), trackedFailed).promotable,
		).toBeUndefined();
	});

	it("serves the entry flagged when git could not list the tree", () => {
		// A prediction is advisory, so a stale path costs a wrong hint; re-deriving
		// costs the band read minutes, on a run that is already degraded.
		put(7, "a body", {
			writeSet: ["scripts/a.js"],
			trackedAtDerive: ["scripts/a.js"],
		});
		const r = lookup(root, issue(7, "a body"), trackedFailed);
		expect(r.state).toBe("hit");
		expect(r.unrevalidated).toBe(true);
	});

	it("hits without git where the entry claims no tracked path to revalidate", () => {
		put(7, "a body", { writeSet: [], trackedAtDerive: [] });
		expect(lookup(root, issue(7, "a body"), trackedFailed).state).toBe("hit");
	});
});

describe("lookupAll", () => {
	it("splits the list into what is warm and what still needs deriving", () => {
		put(1, "one");
		put(3, "three");
		const r = lookupAll(
			root,
			[
				{ number: 1, body: "one" },
				{ number: 2, body: "two" },
				{ number: 3, body: "three edited" },
			],
			tracked([]),
		);
		expect(r.warm.map((w: { number: number }) => w.number)).toEqual([1]);
		expect(r.cold.map((c: { number: number }) => c.number)).toEqual([2, 3]);
	});

	it("gives every cold issue its body hash, so the deriver can store one back", () => {
		const r = lookupAll(root, [{ number: 2, body: "two" }], tracked([]));
		expect(r.cold[0].bodyHash).toBe(bodyHash("two"));
	});

	it("says why each cold issue is cold", () => {
		put(3, "three");
		const r = lookupAll(
			root,
			[
				{ number: 2, body: "two" },
				{ number: 3, body: "three edited" },
			],
			tracked([]),
		);
		expect(r.cold.find((c: { number: number }) => c.number === 2).state).toBe(
			"cold",
		);
		expect(r.cold.find((c: { number: number }) => c.number === 3).state).toBe(
			"body-changed",
		);
	});
});

describe("promotion of a path created after derive time", () => {
	it("records it, so the next rename of it is caught", () => {
		put(7, "a body", { writeSet: ["scripts/new.js"], trackedAtDerive: [] });
		lookupAll(
			root,
			[{ number: 7, body: "a body" }],
			tracked(["scripts/new.js"]),
		);
		expect(readEntry(root, 7).trackedAtDerive).toEqual(["scripts/new.js"]);
		expect(
			lookup(root, { number: 7, body: "a body" }, tracked(["scripts/moved.js"]))
				.state,
		).toBe("path-gone");
	});

	it("leaves derivedAt alone, so a promotion is not counted as a derive", () => {
		const derivedAt = "2020-01-01T00:00:00.000Z";
		put(7, "a body", {
			writeSet: ["scripts/new.js"],
			trackedAtDerive: [],
			derivedAt,
		});
		lookupAll(
			root,
			[{ number: 7, body: "a body" }],
			tracked(["scripts/new.js"]),
		);
		expect(readEntry(root, 7).derivedAt).toBe(derivedAt);
	});

	it("adds to the paths already recorded rather than replacing them", () => {
		put(7, "a body", {
			writeSet: ["scripts/a.js", "scripts/new.js"],
			trackedAtDerive: ["scripts/a.js"],
		});
		lookupAll(
			root,
			[{ number: 7, body: "a body" }],
			tracked(["scripts/a.js", "scripts/new.js"]),
		);
		expect(readEntry(root, 7).trackedAtDerive).toEqual([
			"scripts/a.js",
			"scripts/new.js",
		]);
	});

	it("hands the caller the updated tracked list on the warm entry", () => {
		put(7, "a body", { writeSet: ["scripts/new.js"], trackedAtDerive: [] });
		const r = lookupAll(
			root,
			[{ number: 7, body: "a body" }],
			tracked(["scripts/new.js"]),
		);
		expect(r.warm[0].trackedAtDerive).toEqual(["scripts/new.js"]);
	});

	it("serves the entry, unpromoted, when the store cannot be written", () => {
		// Reporting a promotion the store does not hold would have the caller
		// believe a rename check covers a path it does not.
		put(7, "a body", { writeSet: ["scripts/new.js"], trackedAtDerive: [] });
		fs.chmodSync(cacheDir(root), 0o500);
		try {
			const r = lookupAll(
				root,
				[{ number: 7, body: "a body" }],
				tracked(["scripts/new.js"]),
			);
			expect(r.warm.map((w: { number: number }) => w.number)).toEqual([7]);
			expect(r.warm[0].trackedAtDerive).toEqual([]);
		} finally {
			fs.chmodSync(cacheDir(root), 0o700);
		}
	});

	it("does not write over an entry a neighbour re-derived meanwhile", () => {
		// The snapshot in hand is keyed on the old body, so writing it back would
		// throw away the band read the neighbour just paid for. The neighbour's
		// store lands between this run's lookup and its promotion: the second
		// read of the entry. No real seam reaches that gap, which only a second
		// process racing this one opens.
		put(7, "a body", { writeSet: ["scripts/new.js"], trackedAtDerive: [] });
		const file = path.join(cacheDir(root), "7.json");
		const realRead = fs.readFileSync;
		let reads = 0;
		vi.spyOn(fs, "readFileSync").mockImplementation(((
			...args: Parameters<typeof fs.readFileSync>
		) => {
			if (args[0] === file && ++reads === 2)
				put(7, "a newer body", {
					writeSet: ["scripts/fresh.js"],
					trackedAtDerive: [],
				});
			return realRead.apply(fs, args);
		}) as typeof fs.readFileSync);
		try {
			const r = lookupAll(
				root,
				[{ number: 7, body: "a body" }],
				tracked(["scripts/new.js"]),
			);
			expect(reads).toBeGreaterThanOrEqual(2);
			expect(r.warm[0].trackedAtDerive).toEqual([]);
		} finally {
			vi.restoreAllMocks();
		}
		expect(readEntry(root, 7).writeSet).toEqual(["scripts/fresh.js"]);
		expect(readEntry(root, 7).bodyHash).toBe(bodyHash("a newer body"));
	});

	it("keeps every other field of the entry", () => {
		put(7, "a body", {
			writeSet: ["scripts/new.js"],
			trackedAtDerive: [],
			sizeBand: "L",
			gist: "the gist",
		});
		lookupAll(
			root,
			[{ number: 7, body: "a body" }],
			tracked(["scripts/new.js"]),
		);
		const e = readEntry(root, 7);
		expect(e.trackedAtDerive).toEqual(["scripts/new.js"]);
		expect(e.sizeBand).toBe("L");
		expect(e.gist).toBe("the gist");
		expect(e.bodyHash).toBe(bodyHash("a body"));
	});
});

describe("prune", () => {
	it("drops entries for issues no longer in the open list", () => {
		put(1, "one");
		put(2, "two");
		put(3, "three");
		const r = prune(root, [1, 3]);
		expect(r.removed).toEqual([2]);
		expect(fs.readdirSync(cacheDir(root)).sort()).toEqual(["1.json", "3.json"]);
	});

	it("leaves a file that is not an issue entry alone", () => {
		put(1, "one");
		fs.writeFileSync(path.join(cacheDir(root), "README"), "");
		expect(prune(root, [1]).removed).toEqual([]);
		expect(fs.existsSync(path.join(cacheDir(root), "README"))).toBe(true);
	});

	it("sweeps a scratch file a crash left behind", () => {
		put(1, "one");
		const orphan = path.join(cacheDir(root), "2.json.999.tmp");
		fs.writeFileSync(orphan, "half a write");
		prune(root, [1]);
		expect(fs.existsSync(orphan)).toBe(false);
		expect(readEntry(root, 1)).not.toBeNull();
	});

	it("is a no-op on a store that was never created", () => {
		const r = prune(root, [1]);
		expect(r.ok).toBe(true);
		expect(r.removed).toEqual([]);
	});

	it("prunes nothing when the open list is empty, which is a failed query", () => {
		// Emptying the cache on one would throw away every warm entry.
		put(1, "one");
		expect(prune(root, []).removed).toEqual([]);
		expect(readEntry(root, 1)).not.toBeNull();
	});
});

describe("a caller passing the wrong shape", () => {
	it("degrades to cold rather than throwing at the caller", () => {
		put(1, "one", { writeSet: ["a.js"], trackedAtDerive: ["a.js"] });
		const r = lookupAll(
			root,
			[{ number: 1, body: "one" }],
			// `ok` with no `files`.
			{ ok: true } as { ok: boolean; files: string[] },
		);
		expect(r.warm).toEqual([]);
		expect(r.cold.map((c: { number: number }) => c.number)).toEqual([1]);
	});
});

describe("counting the puts since an instant", () => {
	/** Backdates an entry the way a put minutes ago would have left it. */
	const putAt = (issue: number, derivedAt: string) => {
		put(issue, `body ${issue}`);
		const file = path.join(cacheDir(root), `${issue}.json`);
		const e = JSON.parse(fs.readFileSync(file, "utf8"));
		fs.writeFileSync(file, JSON.stringify({ ...e, derivedAt }));
	};

	it("counts only the entries derived after it", () => {
		putAt(1, "2026-08-19T08:00:00.000Z");
		putAt(2, "2026-08-19T08:30:00.000Z");
		putAt(3, "2026-08-19T09:00:00.000Z");
		expect(countDerivedSince(root, "2026-08-19T08:15:00.000Z")).toEqual({
			ok: true,
			count: 2,
		});
	});

	it("says it cannot answer where there is no instant to count from", () => {
		putAt(1, "2026-08-19T08:00:00.000Z");
		expect(countDerivedSince(root, null)).toEqual({ ok: false, count: null });
		expect(countDerivedSince(root, "not a date")).toEqual({
			ok: false,
			count: null,
		});
	});

	it("counts nothing, rather than failing, before any entry has been stored", () => {
		expect(countDerivedSince(root, "2026-08-19T08:00:00.000Z")).toEqual({
			ok: true,
			count: 0,
		});
	});

	it("skips an entry it cannot date, which makes the count a lower bound", () => {
		putAt(1, "2026-08-19T09:00:00.000Z");
		fs.mkdirSync(cacheDir(root), { recursive: true });
		fs.writeFileSync(path.join(cacheDir(root), "2.json"), "{not json");
		fs.writeFileSync(path.join(cacheDir(root), "notes.txt"), "ignored");
		expect(countDerivedSince(root, "2026-08-19T08:00:00.000Z")).toEqual({
			ok: true,
			count: 1,
		});
	});
});

describe("the provisional flag (mantahostels#1001)", () => {
	it("round-trips, so a prediction can never be read back as a band read", () => {
		put(1, "one", { provisional: true });
		expect(readEntry(root, 1).provisional).toBe(true);
	});

	it("defaults false, so a band read storing over a prediction clears it", () => {
		put(1, "one", { provisional: true });
		put(1, "one", { writeSet: ["scripts/a.js"], sizeBand: "S" });
		expect(readEntry(root, 1).provisional).toBe(false);
	});

	it("rejects an entry whose flag is not a boolean, rather than guessing", () => {
		// Guessing either way hides a prediction or discards a band read.
		put(1, "one");
		const file = path.join(cacheDir(root), "1.json");
		const e = JSON.parse(fs.readFileSync(file, "utf8"));
		fs.writeFileSync(file, JSON.stringify({ ...e, provisional: "yes" }));
		expect(readEntry(root, 1)).toBeNull();
	});

	it("survives a promotion, which re-records the entry without re-deriving it", () => {
		put(1, "one", {
			provisional: true,
			writeSet: ["scripts/a.js"],
			trackedAtDerive: [],
		});
		lookupAll(root, [{ number: 1, body: "one" }], tracked(["scripts/a.js"]));
		expect(readEntry(root, 1).provisional).toBe(true);
		expect(readEntry(root, 1).trackedAtDerive).toEqual(["scripts/a.js"]);
	});

	it("reads as a normalised boolean on a warm hit, even on an entry predating it", () => {
		put(1, "one");
		const file = path.join(cacheDir(root), "1.json");
		const e = JSON.parse(fs.readFileSync(file, "utf8"));
		delete e.provisional;
		fs.writeFileSync(file, JSON.stringify(e));
		const { warm } = lookupAll(root, [{ number: 1, body: "one" }], tracked([]));
		expect(warm[0].provisional).toBe(false);
	});

	it("keeps a provisional entry out of the band-read count (mantahostels#667)", () => {
		/*
		 * Selection writes a provisional entry for every miss on every run, so
		 * counting one would make `putsSinceLastRun` non-zero on every line and
		 * tell the duplicate collapse a band read ran in every gap.
		 */
		put(1, "one");
		put(2, "two", { provisional: true });
		expect(countDerivedSince(root, "2026-08-19T08:00:00.000Z")).toEqual({
			ok: true,
			count: 1,
		});
	});
});
