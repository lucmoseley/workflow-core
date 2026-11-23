// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ReadLock } from "./arbiter-records.js";
import { freshSandbox } from "./arbiter-testkit";
import { defineTemplate } from "./git-fixture";
import {
	attributeWorktreeDirt,
	classifyClaims,
	countStranded,
	dirtByTree,
	isDirtyClaim,
	readDirtyPaths,
} from "./stranded-count.js";

const sb = freshSandbox();

const asLock = (o: object) => o as ReadLock;

const lock = (p: string, sessionId: string, agedHours = 24) =>
	asLock({
		path: p,
		sessionId,
		claimedAt: new Date(Date.now() - agedHours * 3_600_000).toISOString(),
	});

const seedRepo = (dir: string, tracked: Record<string, string>) => {
	const git = (...args: string[]) =>
		spawnSync("git", args, { cwd: dir, encoding: "utf8" });
	fs.mkdirSync(path.join(dir, "docs"));
	for (const [rel, text] of Object.entries(tracked))
		fs.writeFileSync(path.join(dir, rel), text);
	git("init", "-q");
	git("add", "-A");
	git(
		"-c",
		"user.email=t@t",
		"-c",
		"user.name=t",
		"commit",
		"-qm",
		"seed",
		"--allow-empty",
	);
};

const repos = defineTemplate({
	clean: (dir) => seedRepo(dir, {}),
	tracked: (dir) => seedRepo(dir, { "docs/tracked.md": "seed\n" }),
});

function gitRepo(variant: "clean" | "tracked") {
	repos.instantiate(sb.repo, variant);
}

describe("classifyClaims", () => {
	const ids = new Set(["live"]);

	const bucketOf = (
		l: object,
		opts: { hours?: number; terminal?: Set<string> } = {},
	) => {
		const claim = asLock(l);
		const r = classifyClaims([claim], ids, opts);
		const buckets = Object.entries(r) as [string, ReadLock[]][];
		const hit = buckets.filter(([, v]) => v.includes(claim)).map(([k]) => k);
		expect(hit).toHaveLength(1);
		return hit[0];
	};

	it("names why a claim is not stranded, not merely that it is not", () => {
		expect(bucketOf({ path: "a.md", unreadable: true })).toBe("unreadable");
		expect(bucketOf({ path: "a.md" })).toBe("unreadable");
		expect(bucketOf(lock("a.md", "live"))).toBe("live");
		expect(bucketOf(lock("a.md", "dead", 2))).toBe("young");
		expect(bucketOf(lock("a.md", "dead", 24))).toBe("stranded");
	});

	it("sorts a stranded, a young, a live and an unreadable lock each into their own bucket", () => {
		const strandedLock = lock("a.md", "dead", 24);
		const youngLock = lock("b.md", "dead", 2);
		const liveLock = lock("c.md", "live", 24);
		const unreadableLock = asLock({ path: "d.md", unreadable: true });
		const r = classifyClaims(
			[strandedLock, youngLock, liveLock, unreadableLock],
			ids,
		);
		expect(r.stranded).toEqual([strandedLock]);
		expect(r.young).toEqual([youngLock]);
		expect(r.live).toEqual([liveLock]);
		expect(r.unreadable).toEqual([unreadableLock]);
	});

	it("takes an hours override, defaulting to the derived threshold", () => {
		const young = lock("a.md", "dead", 2);
		expect(bucketOf(young, { hours: 1 })).toBe("stranded");
		expect(bucketOf(young)).toBe("young");
	});

	it("calls a claim with an unreadable timestamp stranded", () => {
		expect(bucketOf({ path: "a.md", sessionId: "dead" })).toBe("stranded");
	});

	describe("a listed holder the oracle also calls terminal", () => {
		const terminal = new Set(["live"]);

		it("ages out past the threshold instead of reading live", () => {
			expect(bucketOf(lock("a.md", "live", 24), { terminal })).toBe("stranded");
		});

		it("still reads young below the threshold", () => {
			expect(bucketOf(lock("a.md", "live", 2), { terminal })).toBe("young");
		});

		it("defaults to no terminal holders, so a caller with none still exempts every listed one", () => {
			expect(bucketOf(lock("a.md", "live", 24))).toBe("live");
		});
	});
});

describe("countStranded", () => {
	it("counts a claim whose holder is not listed and which is past the threshold", () => {
		const r = countStranded(
			[lock("a.md", "dead", 24), lock("b.md", "live", 24)],
			new Set(["live"]),
		);
		expect(r).toMatchObject({ ok: true, stranded: 1 });
	});

	it("excludes a claim younger than STRANDED_AFTER_HOURS and includes an older one", () => {
		const ids = new Set(["live"]);
		expect(countStranded([lock("a.md", "dead", 11)], ids).stranded).toBe(0);
		expect(countStranded([lock("a.md", "dead", 13)], ids).stranded).toBe(1);
	});

	it("reports unknown, not zero, where the store or the oracle could not be read", () => {
		expect(countStranded(null, new Set())).toMatchObject({ ok: false });
		expect(countStranded([], null)).toMatchObject({ ok: false });
	});

	it("returns carrying null on a dirty set of null, and on no dirty set at all", () => {
		const locks = [lock("a.md", "dead", 24)];
		const ids = new Set(["live"]);
		expect(countStranded(locks, ids, { dirty: null }).carrying).toBeNull();
		expect(countStranded(locks, ids).carrying).toBeNull();
	});

	it("counts only the stranded claims inside the dirty set", () => {
		const r = countStranded(
			[lock("a.md", "dead", 24), lock("b.md", "dead", 24)],
			new Set(["live"]),
			{ dirty: new Set(["a.md"]) },
		);
		expect(r).toMatchObject({ ok: true, stranded: 2, carrying: 1 });
	});

	it("does not count a dirty file whose claim is live or young", () => {
		const dirty = new Set(["a.md", "b.md"]);
		const r = countStranded(
			[lock("a.md", "live", 24), lock("b.md", "dead", 2)],
			new Set(["live"]),
			{ dirty },
		);
		expect(r).toMatchObject({ stranded: 0, carrying: 0 });
	});

	it("matches a region claim against the file it names", () => {
		const r = countStranded(
			[lock("docs/doc-map.md#B42", "dead", 24)],
			new Set(["live"]),
			{ dirty: new Set(["docs/doc-map.md"]) },
		);
		expect(r.carrying).toBe(1);
	});

	it("counts a claim as carrying work where its file is dirty in the tree its holder wrote it in, not another (#4457)", () => {
		const found = [
			{ worktree: "/wt/dead", dirty: new Set(["a.md"]) },
			{ worktree: "/wt/other", dirty: new Set(["b.md"]) },
		];
		const r = countStranded(
			[
				asLock({ ...lock("a.md", "dead", 24), tree: "/wt/dead" }),
				asLock({ ...lock("b.md", "dead", 24), tree: "/wt/dead" }),
			],
			new Set(["live"]),
			{ dirty: new Set(), found },
		);
		expect(r).toMatchObject({ stranded: 2, carrying: 1 });
	});

	it("does not count a worktree claim on a path dirty only in the main checkout (#4457)", () => {
		const r = countStranded(
			[asLock({ ...lock("docs/x.md", "dead", 24), tree: "/wt/dead" })],
			new Set(["live"]),
			{ dirty: new Set(["docs/x.md"]), found: [] },
		);
		expect(r).toMatchObject({ stranded: 1, carrying: 0 });
	});

	it("counts a claim whose holder is listed but the oracle calls terminal, past the threshold", () => {
		const r = countStranded([lock("a.md", "live", 24)], new Set(["live"]), {
			terminal: new Set(["live"]),
		});
		expect(r).toMatchObject({ ok: true, stranded: 1 });
	});
});

describe("readDirtyPaths", () => {
	it("reports a modified tracked file and an untracked one", () => {
		gitRepo("tracked");
		fs.writeFileSync(path.join(sb.repo, "docs", "tracked.md"), "edited\n");
		fs.writeFileSync(path.join(sb.repo, "docs", "scratch.md"), "new\n");

		const dirty = readDirtyPaths();
		expect(dirty?.has("docs/tracked.md")).toBe(true);
		expect(dirty?.has("docs/scratch.md")).toBe(true);
	});

	it("is empty, not null, on a clean tree", () => {
		gitRepo("clean");
		expect(readDirtyPaths()?.size).toBe(0);
	});

	it("returns null where git cannot answer at all", () => {
		expect(readDirtyPaths()).toBeNull();
	});
});

describe("isDirtyClaim", () => {
	const dirt = (...paths: string[]) => dirtByTree(new Set(paths), []);

	it("is false against a dirt map of null", () => {
		expect(isDirtyClaim(null, { path: "a.md" })).toBe(false);
	});

	it("judges a region claim by its whole file", () => {
		expect(
			isDirtyClaim(dirt("docs/doc-map.md"), {
				path: "docs/doc-map.md#B42",
			}),
		).toBe(true);
	});
});

describe("an unreadable job store", () => {
	it("leaves the claim counts standing and calls the worktree count unknown", () => {
		const store = path.join(sb.home, "jobs");
		fs.mkdirSync(store, { recursive: true });
		fs.chmodSync(store, 0o000);
		try {
			const found = [{ worktree: "/wt/dead", dirty: new Set(["a.md"]) }];
			const attributed = attributeWorktreeDirt(found, {});
			expect(attributed.unread).toEqual([
				expect.stringContaining(`${store}: EACCES`),
			]);
			const r = countStranded([lock("a.md", "dead", 24)], new Set(["live"]), {
				dirty: new Set(),
				found,
				attributed,
			});
			expect(r).toMatchObject({
				ok: true,
				stranded: 1,
				strandedWorktrees: null,
			});
		} finally {
			fs.chmodSync(store, 0o755);
		}
	});
});
