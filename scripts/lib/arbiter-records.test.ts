// @vitest-environment node
import fs from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
	breaks,
	freshSandbox,
	live,
	liveHolder,
	lockFiles,
	lockRecord,
	proc,
	records,
	store,
} from "./arbiter-testkit";

const observations: typeof import("./arbiter-observations.js") = createRequire(
	import.meta.url,
)("./arbiter-observations.js");

const sb = freshSandbox();

describe("a lock record — where its fields are written down", () => {
	it("reads a lock with no observed process as dead, so a bare one is breakable", () => {
		const lock = lockRecord({ path: "docs/doc-map.md", sessionId: "ancient" });
		expect(proc.holderAlive(lock)).toBe(false);
	});

	it("stamps each claim with a claim id and this boot, so two locks never collide", () => {
		const me = live(sb, "alice");
		const a = store.acquire("docs/a.md", me).lock;
		const b = store.acquire("docs/b.md", me).lock;
		expect(a?.claimId).not.toBe(b?.claimId);
		expect(a?.bootId).toBe(proc.readCurrentBootId());
	});
});

const AT = new Date().toISOString();
const lock = lockRecord({
	path: "docs/a.md",
	sessionId: "alice",
	priorBlobs: [{ sha: "abc", at: null }],
});
const breakRecord = {
	path: "docs/a.md",
	lostBy: "alice",
	lostClaimId: "c1",
	blob: null,
	brokenBy: "bob",
	at: AT,
	reportedAt: null,
};
const observation = {
	path: "docs/a.md",
	sessionId: "alice",
	obsId: "o1",
	blob: null,
	at: AT,
};
const want = {
	sessionId: "alice",
	wants: "issue #1",
	pid: null,
	procStart: null,
	since: AT,
};

describe("each record guard — what it takes and what it refuses (#5642)", () => {
	const cases: [string, (v: unknown) => boolean, object, object[]][] = [
		[
			"isLockRecord",
			records.isLockRecord,
			lock,
			[
				{ claimId: 7 },
				{ pid: "1" },
				{ procStart: true },
				{ priorBlobs: null },
				{ priorBlobs: [{ sha: 1, at: null }] },
				{ tree: null },
			],
		],
		[
			"isBreakRecord",
			records.isBreakRecord,
			breakRecord,
			[{ at: 7 }, { lostClaimId: 7 }, { reportedAt: undefined }],
		],
		[
			"isObservationRecord",
			records.isObservationRecord,
			observation,
			[{ obsId: null }, { sessionId: 7 }, { tree: 7 }],
		],
		[
			"isIssueClaimRecord",
			records.isIssueClaimRecord,
			{ issue: 5, sessionId: null, claimedAt: AT },
			[{ issue: 0 }, { issue: 1.5 }, { claimedAt: 7 }],
		],
		[
			"isWantRecord",
			records.isWantRecord,
			want,
			[{ sessionId: "" }, { wants: "" }, { since: 7 }, { bootId: null }],
		],
		[
			"isMutexRecord",
			records.isMutexRecord,
			{ pid: 1, procStart: "9" },
			[{ pid: null }, { procStart: [] }, { bootId: 7 }],
		],
	];

	for (const [name, guard, good, faults] of cases) {
		it(`${name} takes a record as its writer builds it`, () => {
			expect(guard(JSON.parse(JSON.stringify(good)))).toBe(true);
		});

		it(`${name} refuses a non-object and every mistyped field`, () => {
			for (const value of [null, 7, "x", [good]])
				expect(guard(value)).toBe(false);
			for (const fault of faults)
				expect(guard({ ...good, ...fault }), JSON.stringify(fault)).toBe(false);
		});
	}

	it("isRecordObject takes any plain object, a harness-written entry's only promise", () => {
		expect(records.isRecordObject({ pid: "odd" })).toBe(true);
		for (const value of [null, 7, "x", []])
			expect(records.isRecordObject(value)).toBe(false);
	});
});

describe("a record that parses but is the wrong shape reads as unreadable (#5642)", () => {
	const rel = "docs/a.md";
	const bodies = (good: object, fault: object) =>
		[
			["does not parse", "{not json"],
			["parses but is the wrong shape", JSON.stringify({ ...good, ...fault })],
		] as const;

	for (const [kind, body] of bodies(lock, { claimId: 7 })) {
		it(`releases nothing where the lock ${kind}`, () => {
			fs.mkdirSync(store.paths.locksDir(), { recursive: true });
			fs.writeFileSync(store.paths.lock(rel), body);
			expect(store.release(rel, live(sb, "alice")).verdict).toBe("not-held");
		});

		it(`puts the lock back untouched where it ${kind}`, () => {
			fs.mkdirSync(store.paths.locksDir(), { recursive: true });
			fs.writeFileSync(store.paths.lock(rel), body);
			expect(lockFiles.dropIfUnchanged(rel, () => true).outcome).toBe("kept");
			expect(fs.readFileSync(store.paths.lock(rel), "utf8")).toBe(body);
		});
	}

	for (const [kind, body] of bodies(breakRecord, { at: 7 }))
		it(`reads the broken claim ids as unknown where a break ${kind}`, () => {
			fs.mkdirSync(store.paths.breaksDir(), { recursive: true });
			fs.writeFileSync(store.paths.break(rel, "c1"), body);
			expect(breaks.readBrokenClaimIds()).toBeNull();
		});

	for (const [kind, body] of bodies(observation, { obsId: null }))
		it(`reads the observed ids as unknown where an observation ${kind}`, () => {
			fs.mkdirSync(store.paths.observationsDir(), { recursive: true });
			fs.writeFileSync(store.paths.observation(rel, "alice"), body);
			expect(observations.readObservedIds()).toBeNull();
		});

	for (const [kind, body] of bodies({ ...want, ...liveHolder() }, { since: 7 }))
		it(`skips a want that ${kind}`, () => {
			fs.mkdirSync(store.paths.wantsDir(), { recursive: true });
			fs.writeFileSync(store.paths.want("alice"), body);
			expect(store.readWants()).toEqual([]);
		});
});
