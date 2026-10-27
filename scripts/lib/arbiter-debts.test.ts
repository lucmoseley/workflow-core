// @vitest-environment node
/*
 * arbiter-debts.test.ts — the debt store's suite: the record a denied edit
 * leaves, the notice a claimant reads, and the sweep and clear that retire it.
 *
 * Every case runs in arbiter-testkit's throwaway sandbox with `gh` stubbed, so
 * none touches the real arbiter state or the tracker. Loosening one lets a
 * denied session's owed edit vanish unreported (mantahostels#120).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	AS_ROOT,
	commitAll,
	core,
	fakeGh,
	freshSandbox,
	ghAnswers,
	ghCallCount,
	ghCalls,
	ghClosedList,
	readDebtOf,
	store,
} from "./arbiter-testkit";
import { ISSUE_LIST_LIMIT } from "./gh-limits.js";

const sb = freshSandbox();

/* The debt store: ruled by mantahostels#116, built by mantahostels#120. */
describe("debt — the record of an edit a denial abandoned", () => {
	const docMap = "docs/doc-map.md";
	/** No argument reads the unowned stub; a number reads that issue's entry. */
	const readDebtEntry = (issue: number | null = null) =>
		readDebtOf(docMap, issue);
	/** Who owes an edit on docMap, in the order the store lists them. */
	const readOwners = (): (number | null)[] =>
		store
			.readDebts(docMap)
			.map((e: { record: { issue: number | null } }) => e.record.issue);

	describe("registration — the stub the deny path writes", () => {
		it("records an unowned stub with when, and nothing it cannot know", () => {
			store.registerDenial(docMap);
			expect(readDebtEntry()).toMatchObject({
				path: docMap,
				issue: null,
				gist: null,
			});
			expect(readDebtEntry().createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		});

		it("a later denial cannot erase a completed entry back to a stub", () => {
			store.registerDenial(docMap);
			store.ownDebt(docMap, 123, "the gist");
			store.registerDenial(docMap);
			expect(readDebtEntry(123).issue).toBe(123);
		});

		it("a later denial registers its own stub beside the owned entry (mantahostels#327)", () => {
			// The second denial is a second abandoned edit.
			store.registerDenial(docMap);
			store.ownDebt(docMap, 123, "the gist");
			store.registerDenial(docMap);
			expect(readOwners()).toEqual([123, null]);
		});

		it("a second denial while the first is still unowned adds no duplicate stub", () => {
			store.registerDenial(docMap);
			store.registerDenial(docMap);
			expect(store.readDebts(docMap)).toHaveLength(1);
		});

		it("a store it cannot write is logged, never thrown into the deny path", () => {
			fs.mkdirSync(store.paths.debtsDir(), { recursive: true });
			fs.chmodSync(store.paths.debtsDir(), 0o555);
			try {
				store.registerDenial(docMap);
			} finally {
				fs.chmodSync(store.paths.debtsDir(), 0o755);
			}
			expect(readDebtEntry()).toBeNull();
			expect(fs.readFileSync(store.errorLog(), "utf8")).toContain(
				"debt register",
			);
		});
	});

	describe("ownDebt — completing the stub", () => {
		it("keeps the denial's timestamp, which dates the abandoned edit", () => {
			store.registerDenial(docMap);
			// A stub written and owned in the same millisecond stamps the same ISO
			// string either way, so only a backdated stub makes the assertion prove
			// anything.
			const denied = "2020-01-01T00:00:00.000Z";
			const stub = store.paths.debt(docMap);
			core.writeRecord(stub, { ...core.readRecord(stub), createdAt: denied });
			store.ownDebt(docMap, 123, "one line on the edit");
			expect(readDebtEntry(123)).toMatchObject({
				issue: 123,
				gist: "one line on the edit",
				createdAt: denied,
			});
			// The stub was completed, not left standing beside its own completion.
			expect(readDebtEntry()).toBeNull();
		});

		it("mints the entry when no stub exists — a debt can be declared by hand", () => {
			store.ownDebt(docMap, 123, "");
			expect(readDebtEntry(123).issue).toBe(123);
		});

		it("records a missing gist as none, not as an empty string", () => {
			store.ownDebt(docMap, 123, "");
			expect(readDebtEntry(123).gist).toBeNull();
		});

		it("leaves another issue's entry on the same path standing (mantahostels#327)", () => {
			store.ownDebt(docMap, 308, "the node-unit pass");
			store.ownDebt(
				docMap,
				323,
				"#314's measured CI figures in .github/workflows/scheduled-checks.yml",
			);
			expect(readOwners()).toEqual([308, 323]);
			expect(readDebtEntry(308).gist).toBe("the node-unit pass");
		});

		it("re-owning updates that issue's own entry rather than adding a second", () => {
			store.ownDebt(docMap, 308, "first wording");
			store.ownDebt(docMap, 308, "sharper wording");
			expect(store.readDebts(docMap)).toHaveLength(1);
			expect(readDebtEntry(308).gist).toBe("sharper wording");
		});

		it("throws on a store it cannot write, for the CLI to turn into an exit code", () => {
			fs.mkdirSync(store.paths.debtsDir(), { recursive: true });
			fs.chmodSync(store.paths.debtsDir(), 0o555);
			try {
				expect(() => store.ownDebt(docMap, 123, "gist")).toThrow();
			} finally {
				fs.chmodSync(store.paths.debtsDir(), 0o755);
			}
		});
	});

	describe("the read path — what the next claimant is told", () => {
		it("no debt costs no gh call and says nothing", () => {
			ghAnswers(sb, "CLOSED");
			expect(store.buildDebtNotice(docMap)).toBeNull();
			expect(ghCallCount(sb)).toBe(0);
		});

		it("an unowned stub warns that nothing will ever retire it, offering debt own as the way out", () => {
			store.registerDenial(docMap);
			const notice = store.buildDebtNotice(docMap);
			expect(notice).toContain("never owned");
			expect(notice).toContain("debt own");
			expect(ghCallCount(sb)).toBe(0); // no issue, nothing to look up
		});

		it("an owned debt with an open issue names the owner and the gist as a hint", () => {
			ghAnswers(sb, "OPEN");
			store.ownDebt(docMap, 123, "re-derive the ADR figure");
			const notice = store.buildDebtNotice(docMap);
			expect(notice).toContain("#123");
			expect(notice).toContain("re-derive the ADR figure");
			expect(notice).toContain("hint");
			expect(readDebtEntry(123)).not.toBeNull(); // shown, not spent
		});

		it("names every owing issue, not just one of them (mantahostels#327)", () => {
			ghAnswers(sb, "OPEN");
			store.ownDebt(docMap, 308, "the node-unit pass");
			store.ownDebt(
				docMap,
				323,
				".github/workflows/scheduled-checks.yml's CI figures",
			);
			const notice = store.buildDebtNotice(docMap);
			expect(notice).toContain("#308");
			expect(notice).toContain("#323");
			expect(notice).toContain(
				".github/workflows/scheduled-checks.yml's CI figures",
			);
		});

		it("shows an unowned stub alongside the owned entries, marked as owned by nobody", () => {
			ghAnswers(sb, "OPEN");
			store.ownDebt(docMap, 308, "the node-unit pass");
			store.registerDenial(docMap);
			const notice = store.buildDebtNotice(docMap);
			expect(notice).toContain("UNOWNED");
			expect(notice).toContain("debt own");
		});

		it("shows a debt whose owning issue has CLOSED, and leaves the entry standing (mantahostels#1251)", () => {
			ghAnswers(sb, "CLOSED");
			store.ownDebt(docMap, 123, "done, on a closed ticket");
			expect(store.buildDebtNotice(docMap)).toContain("#123");
			expect(readDebtEntry(123)).not.toBeNull();
			// The stub is the negative proof: CLOSED is exactly what used to retire
			// this entry, and it is never even asked.
			expect(ghCallCount(sb)).toBe(0);
		});

		it("shows both a closed issue's entry and an open one's, undistinguished", () => {
			fakeGh(
				sb,
				'case "$3" in 308) echo \'{"state":"CLOSED"}\';; *) echo \'{"state":"OPEN"}\';; esac',
			);
			store.ownDebt(docMap, 308, "done");
			store.ownDebt(docMap, 323, "still owed");
			const notice = store.buildDebtNotice(docMap);
			expect(notice).toContain("#323");
			expect(notice).toContain("#308");
			expect(readDebtEntry(308)).not.toBeNull();
			expect(readDebtEntry(323)).not.toBeNull();
			expect(ghCallCount(sb)).toBe(0);
		});

		it("takes no gh call at all, so a broken gh cannot change what it says", () => {
			fakeGh(sb, "exit 1");
			store.ownDebt(docMap, 123, "");
			expect(store.buildDebtNotice(docMap)).toContain("#123");
			expect(readDebtEntry(123)).not.toBeNull();
			expect(ghCallCount(sb)).toBe(0);
		});

		it("says how many entries it could not parse, rather than a short list reading as complete", () => {
			// mantahostels#174's doctrine at the claim: dropping a torn record silently removes
			// one debt from a list the reader takes for the whole of what is owed.
			ghAnswers(sb, "OPEN");
			store.ownDebt(docMap, 308, "the node-unit pass");
			fs.writeFileSync(store.paths.debt(docMap, 323), "{not json");
			const notice = store.buildDebtNotice(docMap);
			expect(notice).toContain("#308");
			expect(notice).toContain("1 further entry here could not be parsed");
		});

		it("takes no gh call however many entries stand", () => {
			// The count is the proof (base §X9); the sweep's ONE-call case below
			// shows the stub is the gh this module reaches.
			fakeGh(sb, 'echo \'{"state":"CLOSED"}\'');
			store.ownDebt(docMap, 308, "first");
			store.ownDebt(docMap, 323, "second");
			store.ownDebt(docMap, 336, "third");
			const notice = store.buildDebtNotice(docMap);
			expect(notice).toContain("#308");
			expect(notice).toContain("#323");
			expect(notice).toContain("#336");
			expect(ghCallCount(sb)).toBe(0);
		});

		it("threatens deletion only for the entry the sweep will actually delete", () => {
			// The drop spares an unowned entry carrying a gist, so telling that one
			// it is deleted in 24h is a promise the sweep does not keep (mantahostels#1302).
			fs.mkdirSync(store.paths.debtsDir(), { recursive: true });
			fs.writeFileSync(
				store.paths.debt(docMap),
				JSON.stringify({
					path: docMap,
					issue: null,
					gist: "the sentence I could not write",
					createdAt: new Date().toISOString(),
				}),
			);
			expect(store.buildDebtNotice(docMap)).not.toContain("DELETED");

			fs.unlinkSync(store.paths.debt(docMap));
			store.registerDenial(docMap);
			expect(store.buildDebtNotice(docMap)).toContain("DELETED");
		});

		it("a corrupt entry reads as no debt", () => {
			fs.mkdirSync(store.paths.debtsDir(), { recursive: true });
			fs.writeFileSync(store.paths.debt(docMap), "{not json");
			expect(store.buildDebtNotice(docMap)).toBeNull();
		});
	});

	describe("debtsOwnedBy — what the uncommitted-work guard releases (#1170)", () => {
		it("names a path this session owned a debt on", () => {
			store.ownDebt(docMap, 123, "blocked by a gate", "me");
			expect([...store.debtsOwnedBy("me")]).toEqual([docMap]);
		});

		it("never names a debt another session recorded", () => {
			store.ownDebt(docMap, 123, "blocked by a gate", "someone-else");
			expect(store.debtsOwnedBy("me").size).toBe(0);
		});

		it("never names an unowned stub, even this session's own", () => {
			store.registerDenial(docMap, "me");
			expect(readDebtEntry().recordedBy).toBe("me");
			expect(store.debtsOwnedBy("me").size).toBe(0);
		});

		it("stamps the OWNING session when it completes another's stub", () => {
			store.registerDenial(docMap, "denied-one");
			store.ownDebt(docMap, 123, "gist", "owner");
			expect([...store.debtsOwnedBy("owner")]).toEqual([docMap]);
			expect(store.debtsOwnedBy("denied-one").size).toBe(0);
		});

		it("never names a debt owned with no session, which still lists", () => {
			fs.mkdirSync(store.paths.debtsDir(), { recursive: true });
			const sessionless = {
				path: docMap,
				issue: 123,
				gist: "old",
				createdAt: "2026-01-01T00:00:00.000Z",
				recordedBy: null,
			};
			fs.writeFileSync(
				store.paths.debt(docMap, 123),
				JSON.stringify(sessionless),
			);
			expect(store.listDebts()).toEqual([sessionless]);
			expect(store.debtsOwnedBy("me").size).toBe(0);
			expect(store.debtsOwnedBy("").size).toBe(0);
		});

		it("answers a region subject with its whole file", () => {
			store.ownDebt(`${docMap}#B1`, 123, "gist", "me");
			expect([...store.debtsOwnedBy("me")]).toEqual([docMap]);
		});

		it.skipIf(AS_ROOT)("exempts nothing where the store will not read", () => {
			store.ownDebt(docMap, 123, "gist", "me");
			fs.chmodSync(store.paths.debtsDir(), 0o000);
			try {
				expect(store.debtsOwnedBy("me").size).toBe(0);
			} finally {
				fs.chmodSync(store.paths.debtsDir(), 0o755);
			}
		});
	});

	/* The sweep is the drain (mantahostels#1203). */
	describe("sweep — the whole register on one batched lookup", () => {
		const other = "docs/environment.md";

		it("retires every entry whose owning issue has closed, not just the first", () => {
			ghClosedList(sb, [308, 323, 336]);
			store.ownDebt(docMap, 308, "first");
			store.ownDebt(docMap, 323, "second");
			store.ownDebt(docMap, 336, "third");
			const result = store.sweepDebts();
			expect(result.status).toBe("swept");
			expect(
				result.retired.map((d: { issue: number }) => d.issue).sort(),
			).toEqual([308, 323, 336]);
			expect(store.readDebts(docMap)).toHaveLength(0);
		});

		it("asks for CLOSED issue numbers, batched — the whole sweep is that query", () => {
			// The call COUNT cannot see this. Swap --state closed for --state open
			// and the sweep inverts into deleting exactly the entries that must
			// survive, with every other assertion here still green.
			// --limit is the ceiling lib/gh-limits.js holds, asserted from THERE
			// rather than from the sweep's own copy of that import, which would
			// agree with any number the sweep passed (mantahostels#2512).
			ghClosedList(sb, [308]);
			store.ownDebt(docMap, 308, "done");
			store.sweepDebts();
			expect(ghCalls(sb)).toEqual([
				`issue list --state closed --json number --limit ${ISSUE_LIST_LIMIT}`,
			]);
		});

		it("costs ONE gh call however many entries stand — the budget cap is gone", () => {
			ghClosedList(sb, [308, 323, 336]);
			store.ownDebt(docMap, 308, "first");
			store.ownDebt(docMap, 323, "second");
			store.ownDebt(other, 336, "third");
			store.sweepDebts();
			expect(ghCallCount(sb)).toBe(1);
		});

		it("keeps an entry whose owning issue is still open", () => {
			ghClosedList(sb, [308]);
			store.ownDebt(docMap, 308, "done");
			store.ownDebt(docMap, 323, "still owed");
			const result = store.sweepDebts();
			expect(result.retired.map((d: { issue: number }) => d.issue)).toEqual([
				308,
			]);
			expect(result.live.map((d: { issue: number }) => d.issue)).toEqual([323]);
			expect(readDebtEntry(323)).not.toBeNull();
		});

		it("never touches a FRESH UNOWNED entry — its session may still own it", () => {
			ghClosedList(sb, [308]);
			store.ownDebt(docMap, 308, "done");
			store.registerDenial(other);
			const result = store.sweepDebts();
			expect(result.retired).toHaveLength(1);
			expect(result.dropped).toHaveLength(0);
			expect(result.live.map((d: { issue: number | null }) => d.issue)).toEqual(
				[null],
			);
			expect(readDebtOf(other)).not.toBeNull();
		});

		/*
		 * The second delete test is "unowned, gistless, and past the 24h grace" — an
		 * entry no closure can reach and no reader can act on, because the only
		 * session that knew what was denied has ended.
		 */
		describe("the second delete test — an uncompletable stub (mantahostels#1302)", () => {
			/** Back-date `rel`'s stub to `ms` before `from`. */
			const age = (rel: string, ms: number, from = Date.now()) => {
				const found = store.readDebts(rel)[0];
				const record = { ...found.record };
				record.createdAt = new Date(from - ms).toISOString();
				fs.writeFileSync(found.file, JSON.stringify(record));
			};
			// The grace window, spelled as the 24h both printed messages name, so
			// moving STUB_GRACE_MS alone turns these red.
			const day = 24 * 60 * 60 * 1000;
			const grace = day;

			it("drops an unowned, gistless stub older than the grace window", () => {
				ghClosedList(sb, []);
				store.registerDenial(other);
				age(other, grace + 60_000);
				const result = store.sweepDebts();
				expect(result.dropped.map((d: { path: string }) => d.path)).toEqual([
					other,
				]);
				expect(result.live).toHaveLength(0);
				expect(store.readDebts(other)).toHaveLength(0);
			});

			it("keeps one INSIDE the grace window, so a live session is never raced", () => {
				ghClosedList(sb, []);
				store.registerDenial(other);
				age(other, grace - 60_000);
				const result = store.sweepDebts();
				expect(result.dropped).toHaveLength(0);
				expect(store.readDebts(other)).toHaveLength(1);
			});

			it("keeps an aged UNOWNED entry that carries a gist — a reader can act on it", () => {
				ghClosedList(sb, []);
				fs.mkdirSync(store.paths.debtsDir(), { recursive: true });
				fs.writeFileSync(
					store.paths.debt(other),
					JSON.stringify({
						path: other,
						issue: null,
						gist: "the sentence I could not write",
						createdAt: new Date(Date.now() - 30 * day).toISOString(),
					}),
				);
				const result = store.sweepDebts();
				expect(result.dropped).toHaveLength(0);
				expect(store.readDebts(other)).toHaveLength(1);
			});

			it("keeps an aged OWNED entry whose issue is open, however old", () => {
				ghClosedList(sb, []);
				store.ownDebt(other, 323, "still owed");
				age(other, 30 * day);
				const result = store.sweepDebts();
				expect(result.dropped).toHaveLength(0);
				expect(store.readDebts(other)).toHaveLength(1);
			});

			it("keeps an aged owned entry that has NO gist — the issue still retires it", () => {
				// `debt own <path> <issue>` with no trailing words stores a null gist,
				// so gistless is reachable on an OWNED entry too.
				ghClosedList(sb, []);
				store.ownDebt(other, 323, "");
				age(other, 30 * day);
				expect(store.readDebts(other)[0].record.gist).toBeNull();
				const result = store.sweepDebts();
				expect(result.dropped).toHaveLength(0);
				expect(store.readDebts(other)).toHaveLength(1);
			});

			it("keeps a stub whose createdAt cannot be parsed — the age is unknown, not old", () => {
				ghClosedList(sb, []);
				fs.mkdirSync(store.paths.debtsDir(), { recursive: true });
				fs.writeFileSync(
					store.paths.debt(other),
					JSON.stringify({
						path: other,
						issue: null,
						gist: null,
						createdAt: "some time last week",
					}),
				);
				const result = store.sweepDebts();
				expect(result.dropped).toHaveLength(0);
				expect(store.readDebts(other)).toHaveLength(1);
			});

			it("drops without asking GitHub — a register of stubs alone still drains", () => {
				fakeGh(sb, "exit 1");
				store.registerDenial(other);
				age(other, grace + 60_000);
				const result = store.sweepDebts();
				expect(result.status).toBe("swept");
				expect(result.dropped.map((d: { path: string }) => d.path)).toEqual([
					other,
				]);
				expect(ghCallCount(sb)).toBe(0);
			});

			it("drops on the OFFLINE route too — the deletion needs no answer", () => {
				fakeGh(sb, "exit 1");
				store.ownDebt(docMap, 308, "keeps the sweep asking");
				store.registerDenial(other);
				age(other, grace + 60_000);
				const result = store.sweepDebts();
				expect(result.status).toBe("offline");
				expect(result.dropped.map((d: { path: string }) => d.path)).toEqual([
					other,
				]);
				expect(store.readDebts(other)).toHaveLength(0);
			});

			it.skipIf(AS_ROOT)(
				"counts a refused unlink as standing, never as dropped",
				() => {
					ghClosedList(sb, []);
					store.registerDenial(other);
					age(other, grace + 60_000);
					fs.chmodSync(store.paths.debtsDir(), 0o555);
					let result: ReturnType<typeof store.sweepDebts>;
					try {
						result = store.sweepDebts();
					} finally {
						fs.chmodSync(store.paths.debtsDir(), 0o755);
					}
					expect(result.dropped).toHaveLength(0);
					expect(result.failed).toHaveLength(1);
					expect(result.live.map((d: { path: string }) => d.path)).toEqual([
						other,
					]);
					expect(store.readDebts(other)).toHaveLength(1);
				},
			);

			it("records every drop durably — the detached sweep discards its stdout", () => {
				// sweep-debts-detached.sh runs the SessionStart sweep with stdout on
				// /dev/null, so the printed line is discarded and the record is
				// unlinked. Without this log the path and denial date are gone.
				ghClosedList(sb, []);
				store.registerDenial(other);
				age(other, grace + 60_000);
				store.sweepDebts();
				const log = fs.readFileSync(store.paths.droppedLog(), "utf8");
				expect(log).toContain(other);
				expect(log).toContain("denied ");
			});

			/*
			 * Both cases below are races — the entry vanishing or turning unreadable
			 * between the sweep's read and clearDebt's own — so neither is reachable
			 * in-process. sweepDebts takes an injectable clearStub for exactly this.
			 */
			it("does not count a deletion it did not make", () => {
				// `none` covers "no entry there" as well as the ENOENT race, so
				// counting it dropped prints a deletion that may never have happened
				// — and the entry is gone either way, so it is not standing either.
				store.registerDenial(other);
				age(other, grace + 60_000);
				const result = store.sweepDebts({
					clearStub: () => ({ status: "none" }),
				});
				expect(result.dropped).toHaveLength(0);
				expect(result.live).toHaveLength(0);
				expect(result.failed).toHaveLength(0);
			});

			it("reports an unreadable clear as a failure with a named reason", () => {
				store.registerDenial(other);
				age(other, grace + 60_000);
				const result = store.sweepDebts({
					clearStub: () => ({ status: "unreadable" }),
				});
				expect(result.dropped).toHaveLength(0);
				expect(result.live).toHaveLength(1);
				expect(result.failed).toHaveLength(1);
				// Never "could not be deleted: undefined" — `unreadable` carries no
				// error of its own.
				expect(result.failed[0].error.message).toBe("unreadable");
			});

			it("drops a stub exactly at the grace boundary, and keeps a future-dated one", () => {
				const pinnedNow = Date.parse("2026-08-24T12:00:00.000Z");
				store.registerDenial(other);
				age(other, grace, pinnedNow);
				store.registerDenial("docs/future.md");
				age("docs/future.md", -7 * day, pinnedNow);
				const result = store.sweepDebts({ now: () => pinnedNow });
				expect(result.dropped.map((d: { path: string }) => d.path)).toEqual([
					other,
				]);
				expect(result.live.map((d: { path: string }) => d.path)).toEqual([
					"docs/future.md",
				]);
			});
		});

		it("sweeps across paths, not one path at a time", () => {
			ghClosedList(sb, [308, 336]);
			store.ownDebt(docMap, 308, "here");
			store.ownDebt(other, 336, "there");
			expect(store.sweepDebts().retired).toHaveLength(2);
			expect(store.readDebts(other)).toHaveLength(0);
		});

		it("retires nothing when gh cannot answer, and says so", () => {
			fakeGh(sb, "exit 1");
			store.ownDebt(docMap, 308, "done");
			const result = store.sweepDebts();
			expect(result.status).toBe("offline");
			expect(readDebtEntry(308)).not.toBeNull();
			expect(fs.readFileSync(store.errorLog(), "utf8")).toContain("debt sweep");
		});

		it("treats a page AT the limit as unusable rather than as the whole set", () => {
			// A truncated list would read as "not closed" for everything off the end,
			// which is safe — but reading it as complete makes the survivor count a
			// lie. Fails toward keeping the entry either way, and logs.
			fakeGh(
				sb,
				`node -e 'console.log(JSON.stringify(Array.from({length:${ISSUE_LIST_LIMIT}},(_,i)=>({number:i+1}))))'`,
			);
			store.ownDebt(docMap, 308, "done");
			expect(store.sweepDebts().status).toBe("offline");
			expect(readDebtEntry(308)).not.toBeNull();
			// Names the truncation, not just the failure: without this the case
			// asserts exactly what the `exit 1` case above does.
			expect(fs.readFileSync(store.errorLog(), "utf8")).toContain(
				"at the limit",
			);
		});

		it("takes no gh call at all when nothing in the register has an owner", () => {
			ghClosedList(sb, [308]);
			store.registerDenial(docMap);
			const result = store.sweepDebts();
			expect(result.status).toBe("swept");
			expect(result.retired).toHaveLength(0);
			expect(ghCallCount(sb)).toBe(0);
		});

		it.skipIf(AS_ROOT)(
			"reports an unreadable store rather than sweeping a short list",
			() => {
				// mantahostels#174's doctrine: a store that cannot be read is unknown, not empty.
				// Sweeping what little it could read would print a clean register.
				ghClosedList(sb, [308]);
				store.ownDebt(docMap, 308, "done");
				fs.chmodSync(store.paths.debtsDir(), 0o000);
				try {
					expect(store.sweepDebts().status).toBe("unreadable");
				} finally {
					fs.chmodSync(store.paths.debtsDir(), 0o755);
				}
				expect(readDebtEntry(308)).not.toBeNull();
			},
		);

		it("distinguishes a machine with no register from one with an empty one", () => {
			// A CI runner has no ~/.claude/projects/<repo>/debts at all, and a
			// scheduled sweep there must say so rather than report a drained queue.
			expect(store.sweepDebts().status).toBe("absent");
			store.registerDenial(docMap);
			store.clearDebt(docMap, "unowned");
			expect(store.sweepDebts().status).toBe("swept");
		});

		it.skipIf(AS_ROOT)(
			"keeps an entry whose file it could not delete, and never counts it retired",
			() => {
				// A refused unlink leaves the debt standing. Reporting it as retired
				// is mantahostels#174's failure exactly: the reader believes it is gone.
				ghClosedList(sb, [308]);
				store.ownDebt(docMap, 308, "done");
				fs.chmodSync(store.paths.debtsDir(), 0o555);
				let result: ReturnType<typeof store.sweepDebts>;
				try {
					result = store.sweepDebts();
				} finally {
					fs.chmodSync(store.paths.debtsDir(), 0o755);
				}
				expect(result.retired).toHaveLength(0);
				expect(result.failed).toHaveLength(1);
				expect(result.live.map((d: { issue: number }) => d.issue)).toEqual([
					308,
				]);
				expect(readDebtEntry(308)).not.toBeNull();
			},
		);

		it("never deletes an entry it could not parse", () => {
			// A torn record is mid-write, not lost — readRecord's standing ruling —
			// so the sweep must leave the file where it is rather than reading an
			// unparseable entry as one with no owner and taking it.
			ghClosedList(sb, [308]);
			store.ownDebt(docMap, 308, "done");
			fs.writeFileSync(store.paths.debt(docMap, 323), "{not json");
			const result = store.sweepDebts();
			expect(result.retired.map((d: { issue: number }) => d.issue)).toEqual([
				308,
			]);
			expect(fs.existsSync(store.paths.debt(docMap, 323))).toBe(true);
		});

		it("leaves an entry whose FILE cannot be read standing, and counts it", () => {
			ghClosedList(sb, [308]);
			store.ownDebt(docMap, 308, "done");
			const hidden = store.paths.debt(other, 323);
			fs.writeFileSync(hidden, "{}");
			fs.chmodSync(hidden, 0o000);
			try {
				const result = store.sweepDebts();
				expect(result.retired).toHaveLength(1);
				expect(result.unreadable).toHaveLength(AS_ROOT ? 0 : 1);
			} finally {
				fs.chmodSync(hidden, 0o644);
			}
			expect(fs.existsSync(hidden)).toBe(true);
		});
	});

	describe("clearDebt and listDebts", () => {
		it("clear retires the entry, and the read path then says nothing", () => {
			store.registerDenial(docMap);
			expect(store.clearDebt(docMap).status).toBe("cleared");
			expect(store.buildDebtNotice(docMap)).toBeNull();
		});

		it("clearing a path with no debt reports nothing to clear, and is no fault", () => {
			expect(store.clearDebt(docMap).status).toBe("none");
		});

		it("refuses to clear a path carrying several debts unless told which (mantahostels#327)", () => {
			store.ownDebt(docMap, 308, "the node-unit pass");
			store.ownDebt(
				docMap,
				323,
				".github/workflows/scheduled-checks.yml's CI figures",
			);
			const result = store.clearDebt(docMap);
			expect(result.status).toBe("ambiguous");
			expect(result.entries.map((d: { issue: number }) => d.issue)).toEqual([
				308, 323,
			]);
			expect(store.readDebts(docMap)).toHaveLength(2); // nothing was taken
		});

		it("clears the named owner's entry only", () => {
			store.ownDebt(docMap, 308, "the node-unit pass");
			store.ownDebt(
				docMap,
				323,
				".github/workflows/scheduled-checks.yml's CI figures",
			);
			expect(store.clearDebt(docMap, 308).status).toBe("cleared");
			expect(readOwners()).toEqual([323]);
		});

		it("clears the unowned stub by name, leaving an owned entry alone", () => {
			store.ownDebt(docMap, 308, "the node-unit pass");
			store.registerDenial(docMap);
			expect(store.clearDebt(docMap, "unowned").status).toBe("cleared");
			expect(readOwners()).toEqual([308]);
		});

		it.skipIf(AS_ROOT)(
			"reports an entry it could not delete as still standing, never as absent (mantahostels#327)",
			() => {
				store.ownDebt(docMap, 308, "the node-unit pass");
				fs.chmodSync(store.paths.debtsDir(), 0o555);
				try {
					expect(store.clearDebt(docMap, 308).status).toBe("failed");
				} finally {
					fs.chmodSync(store.paths.debtsDir(), 0o755);
				}
				expect(store.readDebts(docMap)).toHaveLength(1);
				expect(fs.readFileSync(store.errorLog(), "utf8")).toContain(
					"debt clear",
				);
			},
		);

		it("naming an issue that owes nothing here clears nothing", () => {
			store.ownDebt(docMap, 308, "the node-unit pass");
			expect(store.clearDebt(docMap, 999).status).toBe("none");
			expect(store.readDebts(docMap)).toHaveLength(1);
		});

		it.skipIf(AS_ROOT)(
			"reports a store it cannot read as unreadable, never as nothing owed (mantahostels#174)",
			() => {
				store.ownDebt(docMap, 308, "the node-unit pass");
				fs.chmodSync(store.paths.debtsDir(), 0o000);
				try {
					expect(store.clearDebt(docMap).status).toBe("unreadable");
				} finally {
					fs.chmodSync(store.paths.debtsDir(), 0o755);
				}
			},
		);

		it("lists owned and unowned entries, and an empty store as empty", () => {
			expect(store.listDebts()).toEqual([]);
			store.ownDebt(docMap, 123, "the gist");
			store.registerDenial("docs/other.md");
			const paths = store
				.listDebts()
				.map((d: { path: string }) => d.path)
				.sort();
			expect(paths).toEqual(["docs/doc-map.md", "docs/other.md"]);
		});

		it("makes no network call, so it cannot stall or half-empty itself", () => {
			ghAnswers(sb, "CLOSED");
			store.ownDebt(docMap, 123, "");
			expect(store.listDebts()).toHaveLength(1);
			expect(ghCallCount(sb)).toBe(0);
			expect(readDebtEntry(123)).not.toBeNull();
		});

		it("lists every owner of one path, not one of them (mantahostels#327)", () => {
			store.ownDebt(docMap, 308, "the node-unit pass");
			store.ownDebt(
				docMap,
				323,
				".github/workflows/scheduled-checks.yml's CI figures",
			);
			expect(
				store
					.listDebts()
					.map((d: { issue: number }) => d.issue)
					.sort(),
			).toEqual([308, 323]);
		});
	});
});

describe("a debt keyed to a B<n> no entry occupies (mantahostels#1857)", () => {
	const docMap = "docs/doc-map.md";

	/** A committed map running B1..B2, so B1 is allocated and B9 is not. */
	const committedMap = () => {
		execFileSync("git", ["init", "-q"], { cwd: sb.repo });
		fs.writeFileSync(
			path.join(sb.repo, docMap),
			[
				"# doc map",
				"",
				"## Section B — figures",
				"",
				"### B1 · The first",
				"",
				"Body.",
				"",
				"### B2 · The second",
				"",
				"Body.",
				"",
			].join("\n"),
		);
		commitAll(sb, "the map");
	};

	/** Every key the debt store currently holds a record under. */
	const readDebtKeys = (subject: string) =>
		store
			.readDebts(subject)
			.map((e: { record: { path: string } }) => e.record.path);

	beforeEach(committedMap);

	it("registers an unallocated id against the FILE, not the id", () => {
		store.registerDenial(`${docMap}#B9`);
		expect(readDebtKeys(docMap)).toEqual([docMap]);
		expect(readDebtKeys(`${docMap}#B9`)).toEqual([]);
	});

	it("keeps an id an entry DOES occupy keyed exactly", () => {
		store.registerDenial(`${docMap}#B1`);
		expect(readDebtKeys(`${docMap}#B1`)).toEqual([`${docMap}#B1`]);
	});

	it("reads HEAD, not the working tree the denied session was mid-write in", () => {
		// The uncommitted `### B9` is precisely what made the id look allocated.
		fs.appendFileSync(
			path.join(sb.repo, docMap),
			"\n### B9 · Being written right now\n\nBody.\n",
		);
		store.registerDenial(`${docMap}#B9`);
		expect(readDebtKeys(docMap)).toEqual([docMap]);
	});

	it("leaves a section id and an §A row alone — neither is ever reissued", () => {
		store.registerDenial(`${docMap}#section-b`);
		store.registerDenial(`${docMap}#A:docs/brand-new.md`);
		expect(readDebtKeys(`${docMap}#section-b`)).toEqual([
			`${docMap}#section-b`,
		]);
		expect(readDebtKeys(`${docMap}#A:docs/brand-new.md`)).toEqual([
			`${docMap}#A:docs/brand-new.md`,
		]);
	});

	it("keeps the exact key when HEAD cannot be read at all", () => {
		// Fail open to today's behaviour, per debtSubject's own note.
		fs.rmSync(path.join(sb.repo, ".git"), { recursive: true, force: true });
		store.registerDenial(`${docMap}#B9`);
		expect(readDebtKeys(`${docMap}#B9`)).toEqual([`${docMap}#B9`]);
	});

	it("completes the file-level stub when `debt own` names the denied subject", () => {
		// The denial prints `debt own docs/doc-map.md#B9 …`, the subject it refused.
		store.registerDenial(`${docMap}#B9`);
		store.ownDebt(`${docMap}#B9`, 523, "write the new entry");
		expect(store.readDebts(docMap)).toHaveLength(1);
		expect(readDebtOf(docMap, 523)).toMatchObject({
			path: docMap,
			issue: 523,
		});
	});

	it("tells a multi-debt reader to clear under the [path] each row shows", () => {
		store.ownDebt(docMap, 523, "the file-level one");
		store.ownDebt(`${docMap}#B1`, 777, "the entry's own");
		const notice = store.buildDebtNotice(`${docMap}#B1`);
		expect(notice).toContain(`[${docMap}]`);
		expect(notice).toContain("cleared under THAT path");
	});

	it("gives a region claimant a clear command that names the FILE", () => {
		// The notice a region claim gets is mostly about the file's entries, which
		// readDebtsCovering widens onto it. Naming the region in the clear command sends
		// the reader to a key holding no record, and the entry reads unretirable.
		store.registerDenial(`${docMap}#B9`);
		store.ownDebt(docMap, 523, "the TDPSE Asing entry");
		const notice = store.buildDebtNotice(`${docMap}#B1`);
		expect(notice).toContain(`debt clear ${docMap} 523`);
		expect(notice).not.toContain(`debt clear ${docMap}#B1`);
	});

	it("completes the stub WHERE IT LIES when HEAD moved under it", () => {
		// debtSubject reads a moving HEAD. Recomputing it at own-time would key a
		// second record under a B<n> allocated to somebody else in between — this
		// ticket's own failure, on a delay.
		store.registerDenial(`${docMap}#B9`);
		fs.appendFileSync(
			path.join(sb.repo, docMap),
			"\n### B9 · Somebody else's entry\n\nBody.\n",
		);
		commitAll(sb, "B9 allocated to another subject");
		expect(store.ownDebt(`${docMap}#B9`, 523, "the entry")).toBe(docMap);
		expect(store.readDebts(`${docMap}#B9`)).toHaveLength(0);
		expect(store.readDebts(docMap)).toHaveLength(1);
	});

	it("mints a fresh entry under the demoted key, and says which", () => {
		expect(store.ownDebt(`${docMap}#B9`, 523, "no denial preceded this")).toBe(
			docMap,
		);
	});

	it("leaves another issue's entry on the same path alone (mantahostels#327)", () => {
		store.ownDebt(docMap, 999, "somebody else's file-level debt");
		expect(store.ownDebt(`${docMap}#B1`, 523, "mine")).toBe(`${docMap}#B1`);
		expect(readDebtOf(docMap, 999)).not.toBeNull();
	});

	it("logs the fail-open when HEAD cannot be read (§N5)", () => {
		fs.rmSync(path.join(sb.repo, ".git"), { recursive: true, force: true });
		store.registerDenial(`${docMap}#B9`);
		expect(fs.readFileSync(sb.errorLog(), "utf8")).toContain("debt subject");
	});

	it("reads a doc map past node's 1 MiB execFileSync default", () => {
		// On an ENOBUFS gitRaw returns null silently, which puts the exact key
		// back and revives the mantahostels#1857 misfire.
		const filler = "Body.\n".repeat(3000);
		const many = ["# doc map", "", "## Section B — figures", ""];
		for (let n = 1; n <= 60; n++)
			many.push(`### B${n} · Entry`, "", filler, "");
		const text = many.join("\n");
		expect(text.length).toBeGreaterThan(1024 * 1024);
		fs.writeFileSync(path.join(sb.repo, docMap), text);
		commitAll(sb, "a map over the buffer default");
		store.registerDenial(`${docMap}#B99`);
		expect(readDebtKeys(docMap)).toEqual([docMap]);
		// No log at all is the pass: an ENOBUFS would have written one.
		expect(fs.existsSync(sb.errorLog())).toBe(false);
	});

	it("still clears a region-keyed record already on disk", () => {
		// clearDebt is deliberately NOT demoted: it is the only route to a
		// region-keyed record already on disk.
		store.ownDebt(`${docMap}#B1`, 523, "an entry-keyed debt");
		expect(store.clearDebt(`${docMap}#B1`, 523).status).toBe("cleared");
		expect(readDebtKeys(`${docMap}#B1`)).toEqual([]);
	});
});
