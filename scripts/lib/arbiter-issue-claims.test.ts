// @vitest-environment node
/*
 * arbiter-issue-claims.js's own suite: which session is working which issue —
 * records that never erase each other, a claim held only while its session is
 * listed live, and doubt that keeps rather than drops (mantahostels#645,
 * mantahostels#1186).
 *
 * Each case runs in arbiter-testkit's sandbox with the liveness oracle's answer
 * passed in, so live, finished and unanswerable sessions are set per case
 * rather than read off the machine.
 *
 * `record-issue-claim.sh` (a `PostToolUse` hook) writes these and /pick-next
 * reads them: loosen a case here and two sessions take one issue, or a dead
 * session's claim hides its issue from the frontier for good.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	AS_ROOT,
	finished,
	freshSandbox,
	issueClaims,
	live,
	store,
} from "./arbiter-testkit";

const sb = freshSandbox();

describe("issue claims — which session is working which issue (mantahostels#645)", () => {
	const me = (id: string) => ({ sessionId: id });
	const claimFile = (issue: number, id: string) =>
		path.join(store.paths.issueClaimsDir(), `${issue}-${id}.json`);
	/** A stamp no test run can mint by accident. */
	const old = "2026-08-01T00:00:00.000Z";

	it("records a claim keyed by issue and session", () => {
		expect(store.claimIssue(645, me("alice")).status).toBe("claimed");
		expect(
			JSON.parse(fs.readFileSync(claimFile(645, "alice"), "utf8")),
		).toEqual({
			issue: 645,
			sessionId: "alice",
			claimedAt: expect.any(String),
		});
	});

	it("keeps both records when two sessions claim one issue", () => {
		// Not a lock: an issue claim arbitrates nothing, so neither session's
		// record may erase the other's — which is also what stops a dead session's
		// entry wedging the issue.
		store.claimIssue(645, me("alice"));
		store.claimIssue(645, me("bob"));
		expect(
			issueClaims
				.readIssueClaims(645)
				.map((e: { record: { sessionId: string } }) => e.record.sessionId),
		).toEqual(expect.arrayContaining(["alice", "bob"]));
	});

	it("re-claiming keeps one record, still stamped when the session first took it", () => {
		store.claimIssue(645, me("alice"));
		// Back-dated, or the assertion is vacuous: two claims a millisecond apart
		// print the same ISO string, so a restamp would pass unnoticed.
		const f = claimFile(645, "alice");
		const first = { ...JSON.parse(fs.readFileSync(f, "utf8")), claimedAt: old };
		fs.writeFileSync(f, JSON.stringify(first));

		store.claimIssue(645, me("alice"));
		const after = issueClaims.readIssueClaims(645);
		expect(after).toHaveLength(1);
		// The age of the claim is what a reader of a stale one needs.
		expect(after[0].record.claimedAt).toBe(old);
	});

	it("does not confuse mantahostels#64 with mantahostels#645, which shares its digits", () => {
		store.claimIssue(645, me("alice"));
		expect(issueClaims.readIssueClaims(64)).toEqual([]);
	});

	it("records nothing for a session with no id, leaving the issue selectable", () => {
		expect(store.claimIssue(645, { sessionId: null }).status).toBe(
			"unidentified",
		);
		expect(store.listIssueClaims()).toEqual({ claims: [], why: null });
	});

	it("says why a corrupt record was dropped, rather than a silently short list (mantahostels#1186)", () => {
		store.claimIssue(645, me("alice"));
		fs.mkdirSync(store.paths.issueClaimsDir(), { recursive: true });
		fs.writeFileSync(
			path.join(store.paths.issueClaimsDir(), "bogus.json"),
			"not json",
		);
		const { claims, why } = store.listIssueClaims();
		expect(claims.map((c: { sessionId: string }) => c.sessionId)).toEqual([
			"alice",
		]);
		expect(why).toMatch(/1 issue-claim record could not be read/);
	});

	it("refuses an argument that is not an issue number", () => {
		for (const bad of ["", "abc", "-3", "0", "1.5"])
			expect(store.claimIssue(bad, me("alice")).status).toBe("invalid");
	});

	it("releases this session's own record and leaves another's standing", () => {
		store.claimIssue(645, me("alice"));
		store.claimIssue(645, me("bob"));
		expect(store.releaseIssue(645, me("alice")).status).toBe("released");
		expect(
			issueClaims
				.readIssueClaims(645)
				.map((e: { record: { sessionId: string } }) => e.record.sessionId),
		).toEqual(["bob"]);
	});

	it("reports nothing to release rather than failing", () => {
		expect(store.releaseIssue(645, me("alice")).status).toBe("none");
	});

	describe("heldIssues — the reading pick-next.js does", () => {
		it("holds a claim whose session the oracle lists as live", () => {
			store.claimIssue(645, me("alice"));
			const { held, why } = store.heldIssues({ ids: new Set(["alice"]) });
			expect([...held.keys()]).toEqual([645]);
			expect(why).toBeNull();
		});

		it("names the session that recorded the claim, not just the issue", () => {
			// pick-next.js has no other handle on a claim carrying no GitHub
			// assignee, and reported one as "a live session" (mantahostels#708).
			store.claimIssue(645, me("alice"));
			const { held } = store.heldIssues({ ids: new Set(["alice"]) });
			expect(held.get(645)).toBe("alice");
		});

		it("gives one answer where two sessions hold the same issue", () => {
			// Records are keyed by (issue, session), so both stand; which one is
			// named changes nothing, but it must not vary between reads.
			store.claimIssue(645, me("alice"));
			store.claimIssue(645, me("bob"));
			const ids = new Set(["alice", "bob"]);
			const first = store.heldIssues({ ids }).held.get(645);
			expect(["alice", "bob"]).toContain(first);
			expect(store.heldIssues({ ids }).held.get(645)).toBe(first);
		});

		it("drops a claim whose session is not listed", () => {
			store.claimIssue(645, me("alice"));
			const { held } = store.heldIssues({ ids: new Set(["bob"]) });
			expect([...held.keys()]).toEqual([]);
		});

		it("drops a claim whose session is listed but terminal (#619)", () => {
			store.claimIssue(645, me("alice"));
			const { held } = store.heldIssues({
				ids: new Set(["alice"]),
				terminal: new Set(["alice"]),
			});
			expect([...held.keys()]).toEqual([]);
		});

		it("keeps every claim where the oracle would not answer", () => {
			// Narrowing the live set on a partial read is what would dispatch a
			// second session onto work already in flight.
			store.claimIssue(645, me("alice"));
			const r = store.heldIssues({ why: "the daemon would not run" });
			expect([...r.held.keys()]).toEqual([645]);
			expect(r.kept).toBe(true);
			expect(r.why).toBe("the daemon would not run");
		});

		it("says why even where the caller passed no answer at all", () => {
			store.claimIssue(645, me("alice"));
			const r = store.heldIssues(undefined);
			expect([...r.held.keys()]).toEqual([645]);
			expect(r.why).toMatch(/liveness/);
		});

		it("refuses on doubt, not keeps, where a claim record is corrupt (mantahostels#1186)", () => {
			store.claimIssue(645, me("alice"));
			fs.writeFileSync(
				path.join(store.paths.issueClaimsDir(), "bogus.json"),
				"not json",
			);
			const r = store.heldIssues({ ids: new Set(["alice"]) });
			expect(r.kept).toBe(false);
			expect(r.why).toMatch(/1 issue-claim record could not be read/);
		});

		it("holds nothing, and says so, on a store it cannot read", () => {
			if (AS_ROOT) return;
			fs.mkdirSync(store.paths.issueClaimsDir(), { recursive: true });
			fs.chmodSync(store.paths.issueClaimsDir(), 0o000);
			try {
				const r = store.heldIssues({ ids: new Set(["alice"]) });
				// The opposite direction from the oracle: with no claims read there is
				// nothing to keep, so every assignment stays selectable.
				expect([...r.held.keys()]).toEqual([]);
				expect(r.kept).toBe(false);
				expect(r.why).toMatch(/issue-claim store/);
			} finally {
				fs.chmodSync(store.paths.issueClaimsDir(), 0o755);
			}
		});
	});

	describe("pruneIssueClaims", () => {
		const age = (issue: number, id: string, ms: number) => {
			const f = claimFile(issue, id);
			const t = (Date.now() - ms) / 1000;
			fs.utimesSync(f, t, t);
		};

		/** An agents oracle listing exactly these sessions, counting its calls. */
		const agents = (...ids: string[]) => {
			const fn = () => {
				fn.calls++;
				return { ids: new Set(ids) };
			};
			fn.calls = 0;
			return fn;
		};
		const blind = (why: string) => () => ({ why });

		it("sweeps a finished session's week-old claim", () => {
			finished(sb, "bob");
			store.claimIssue(645, me("bob"));
			age(645, "bob", 8 * 24 * 60 * 60 * 1000);
			issueClaims.pruneIssueClaims(agents());
			expect(fs.existsSync(claimFile(645, "bob"))).toBe(false);
		});

		it("spares a live session's claim, whatever its age", () => {
			live(sb, "alice");
			store.claimIssue(645, me("alice"));
			age(645, "alice", 30 * 24 * 60 * 60 * 1000);
			issueClaims.pruneIssueClaims(agents());
			expect(fs.existsSync(claimFile(645, "alice"))).toBe(true);
		});

		/*
		 * mantahostels#704. The registry and `claude agents --json` are two different oracles,
		 * and a session the exclusion still calls live must keep its claim whatever
		 * its age, or selection offers work already in flight.
		 */
		it("spares a claim the agents oracle calls live though the registry does not", () => {
			finished(sb, "bob"); // registry: dead
			store.claimIssue(645, me("bob"));
			age(645, "bob", 8 * 24 * 60 * 60 * 1000);
			issueClaims.pruneIssueClaims(agents("bob")); // oracle: live
			expect(fs.existsSync(claimFile(645, "bob"))).toBe(true);
		});

		it("sweeps nothing when the agents oracle will not answer", () => {
			finished(sb, "bob");
			store.claimIssue(645, me("bob"));
			age(645, "bob", 8 * 24 * 60 * 60 * 1000);
			issueClaims.pruneIssueClaims(blind("the daemon would not run"));
			expect(fs.existsSync(claimFile(645, "bob"))).toBe(true);
			expect(fs.readFileSync(sb.errorLog(), "utf8")).toContain(
				"the daemon would not run",
			);
		});

		it("sweeps nothing when no oracle is passed at all", () => {
			finished(sb, "bob");
			store.claimIssue(645, me("bob"));
			age(645, "bob", 8 * 24 * 60 * 60 * 1000);
			issueClaims.pruneIssueClaims();
			expect(fs.existsSync(claimFile(645, "bob"))).toBe(true);
		});

		/* ~465 ms a call, at every session start. */
		it("does not call the oracle when nothing is old enough to sweep", () => {
			finished(sb, "bob");
			store.claimIssue(645, me("bob"));
			const oracle = agents();
			issueClaims.pruneIssueClaims(oracle);
			expect(oracle.calls).toBe(0);
			expect(fs.existsSync(claimFile(645, "bob"))).toBe(true);
		});

		it("does not call the oracle when the only aged claim is a live session's", () => {
			live(sb, "alice");
			store.claimIssue(645, me("alice"));
			age(645, "alice", 30 * 24 * 60 * 60 * 1000);
			const oracle = agents();
			issueClaims.pruneIssueClaims(oracle);
			expect(oracle.calls).toBe(0);
			expect(fs.existsSync(claimFile(645, "alice"))).toBe(true);
		});
	});
});
