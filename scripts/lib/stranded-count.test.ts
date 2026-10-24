// @vitest-environment node
/*
 * lib/stranded-count.js is the ONE OWNER of the stranded-claim threshold and of
 * the actionable subset — which standing claims sit on a file carrying
 * uncommitted work. check-stranded-file-claims.js's --notify line prints those
 * numbers, and pick-next.js's OWED WORK headline will (mantahostels#1206, mantahostels#1780).
 *
 * Cases run against an arbiter sandbox (`freshSandbox`) and a throwaway git
 * repo for the dirty-file subset, never the live claim store or this tree.
 *
 * The stranded-claim line `npm run status` prints is built on these figures; loosen a
 * case and it calls a live holder's claim stranded, inviting a forced release
 * over work in flight, or hides a dead one carrying uncommitted edits.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshSandbox } from "./arbiter-testkit";

// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const mod: any = createRequire(__filename)("./stranded-count.js");

const sb = freshSandbox();

/** A lock in the shape readLocks() returns, `agedHours` back-dating it. */
const lock = (p: string, sessionId: string, agedHours = 24) => ({
	path: p,
	sessionId,
	claimedAt: new Date(Date.now() - agedHours * 3_600_000).toISOString(),
});

function gitRepo() {
	const git = (...args: string[]) =>
		spawnSync("git", args, { cwd: sb.repo, encoding: "utf8" });
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
}

/* The one owner of "is this claim stranded". Both readers sort through
 * `classifyClaims`, so a case asserted here is the same case the sweep applies
 * (mantahostels#1780, mantahostels#1800). */
describe("classifyClaims", () => {
	const ids = new Set(["live"]);

	/** The one bucket `classifyClaims` sorts a lone lock into. */
	const bucketOf = (
		l: object,
		opts: { hours?: number; terminal?: Set<string> } = {},
	) => {
		const r = mod.classifyClaims([l], ids, opts);
		const hit = Object.keys(r).filter((k) => r[k].includes(l));
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
		const unreadableLock = { path: "d.md", unreadable: true };
		const r = mod.classifyClaims(
			[strandedLock, youngLock, liveLock, unreadableLock],
			ids,
		);
		expect(r.stranded).toEqual([strandedLock]);
		expect(r.young).toEqual([youngLock]);
		expect(r.live).toEqual([liveLock]);
		expect(r.unreadable).toEqual([unreadableLock]);
	});

	/* The sweep passes its `--hours <n>` override; nothing else does. */
	it("takes an hours override, defaulting to the derived threshold", () => {
		const young = lock("a.md", "dead", 2);
		expect(bucketOf(young, { hours: 1 })).toBe("stranded");
		expect(bucketOf(young)).toBe("young");
	});

	/* An unreadable timestamp is reported, not suppressed: the holder is already
	 * known not to be listed, and the threshold only keeps noise down. */
	it("calls a claim with an unreadable timestamp stranded", () => {
		expect(bucketOf({ path: "a.md", sessionId: "dead" })).toBe("stranded");
	});

	/* mantahostels#2765: the oracle keeps listing a finished-but-unreaped session, so
	 * `listed` alone is not liveness — a holder in the `finished` pool is judged
	 * like an unlisted one instead of exempted for ever. */
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
		const r = mod.countStranded(
			[lock("a.md", "dead", 24), lock("b.md", "live", 24)],
			new Set(["live"]),
		);
		expect(r).toMatchObject({ ok: true, stranded: 1 });
	});

	/* The threshold's own boundary: mantahostels#1746 derived 12 h. */
	it("excludes a claim younger than STRANDED_AFTER_HOURS and includes an older one", () => {
		const ids = new Set(["live"]);
		expect(mod.countStranded([lock("a.md", "dead", 11)], ids).stranded).toBe(0);
		expect(mod.countStranded([lock("a.md", "dead", 13)], ids).stranded).toBe(1);
	});

	it("reports unknown, not zero, where the store or the oracle could not be read", () => {
		expect(mod.countStranded(null, new Set())).toMatchObject({ ok: false });
		expect(mod.countStranded([], null)).toMatchObject({ ok: false });
	});

	/* THE CONTRACT pick-next.js's headline depends on: a working tree git would
	 * not report on is NOT a clean one, so the subset reads unknown. */
	it("returns carrying null on a dirty set of null, and on no dirty set at all", () => {
		const locks = [lock("a.md", "dead", 24)];
		const ids = new Set(["live"]);
		expect(mod.countStranded(locks, ids, null).carrying).toBeNull();
		expect(mod.countStranded(locks, ids).carrying).toBeNull();
	});

	it("counts only the stranded claims inside the dirty set", () => {
		const r = mod.countStranded(
			[lock("a.md", "dead", 24), lock("b.md", "dead", 24)],
			new Set(["live"]),
			new Set(["a.md"]),
		);
		expect(r).toMatchObject({ ok: true, stranded: 2, carrying: 1 });
	});

	/* A dirty file whose claim is NOT stranded — young, or its holder still
	 * listed — is not owed work, so it must not reach the subset. */
	it("does not count a dirty file whose claim is live or young", () => {
		const dirty = new Set(["a.md", "b.md"]);
		const r = mod.countStranded(
			[lock("a.md", "live", 24), lock("b.md", "dead", 2)],
			new Set(["live"]),
			dirty,
		);
		expect(r).toMatchObject({ stranded: 0, carrying: 0 });
	});

	/* A region claim spells itself `docs/doc-map.md#B42` and git has never heard
	 * of it (mantahostels#1747): the subset must match through subjectPath. */
	it("matches a region claim against the file it names", () => {
		const r = mod.countStranded(
			[lock("docs/doc-map.md#B42", "dead", 24)],
			new Set(["live"]),
			new Set(["docs/doc-map.md"]),
		);
		expect(r.carrying).toBe(1);
	});

	it("counts a claim whose holder is listed but the oracle calls terminal, past the threshold", () => {
		const r = mod.countStranded(
			[lock("a.md", "live", 24)],
			new Set(["live"]),
			null,
			new Set(["live"]),
		);
		expect(r).toMatchObject({ ok: true, stranded: 1 });
	});
});

describe("dirtyPaths", () => {
	it("reports a modified tracked file and an untracked one", () => {
		fs.writeFileSync(path.join(sb.repo, "docs", "tracked.md"), "seed\n");
		gitRepo();
		fs.writeFileSync(path.join(sb.repo, "docs", "tracked.md"), "edited\n");
		fs.writeFileSync(path.join(sb.repo, "docs", "scratch.md"), "new\n");

		const dirty = mod.dirtyPaths();
		expect(dirty.has("docs/tracked.md")).toBe(true);
		// `-uall`, not `-uno`: an abandoned session's findings sit in an untracked
		// scratch file.
		expect(dirty.has("docs/scratch.md")).toBe(true);
	});

	it("is empty, not null, on a clean tree", () => {
		gitRepo();
		expect(mod.dirtyPaths().size).toBe(0);
	});

	/* Degrades to unknown, never to clean (mantahostels#1747). */
	it("returns null where git cannot answer at all", () => {
		expect(mod.dirtyPaths()).toBeNull();
	});
});

describe("isDirtyClaim", () => {
	it("is false against a dirty set of null", () => {
		expect(mod.isDirtyClaim(null, "a.md")).toBe(false);
	});

	it("judges a region claim by its whole file", () => {
		expect(
			mod.isDirtyClaim(new Set(["docs/doc-map.md"]), "docs/doc-map.md#B42"),
		).toBe(true);
	});
});
