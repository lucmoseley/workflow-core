// @vitest-environment node
/*
 * The proving run for mantahostels#96's arbitration side (mantahostels#107).
 *
 * Each scenario has two halves:
 *
 *   before — the collision, reproduced against unguarded git and an unguarded
 *   working tree. These assert the failure *happens*, so they stay valid
 *   forever.
 *
 *   after — the same interleaving with the guard in the loop. The guards were
 *   not built when this was written (mantahostels#109 commit-form, mantahostels#110 branch, mantahostels#113
 *   file-claim), so each after-half is **self-arming**: it skips while its guard
 *   is absent and asserts once the guard exists, as all three now do.
 *
 * Read a skipped after-half as "not yet proven", never as "passing".
 *
 * Everything runs in proving-run.ts's throwaway arena — a scratch repo and a
 * sandbox HOME — because a case touching the real ~/.claude could wedge the
 * founder's live sessions.
 *
 * Loosen an after-half and a regressed guard lets the documented collision back
 * into the shared tree — a neighbour's file inside your commit, a commit on the
 * wrong branch, an edit over a held file — with nothing red to say so.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Arena } from "./proving-run";
import { GUARDS, guardExists } from "./proving-session";

/** Runs the body only once `guard` exists. */
const whenBuilt = (
	guard: string,
	name: string,
	body: () => void | Promise<void>,
) => it.skipIf(!guardExists(guard))(name, body);

let a: Arena;
let alice: ReturnType<Arena["session"]>;
let bob: ReturnType<Arena["session"]>;

beforeEach(() => {
	a = new Arena();
	a.write("docs/a.md", "A's file, v1\n");
	a.write("docs/b.md", "B's file, v1\n");
	a.write("docs/doc-map.md", "doc-map, v1\n");
	a.write("docs/reference-roadmap.html", "<!-- roadmap v5.74 -->\ncard one\n");
	a.commitAll("init");
	alice = a.session("alice").live();
	bob = a.session("bob").live();
});

afterEach(() => {
	a.destroy();
});

/**
 * A refusal, however the guard spells it. Claude Code accepts exit 2 or a JSON
 * permissionDecision, and mantahostels#109/mantahostels#110 have not yet chosen between them.
 */
const refused = (r: { status: number; stdout: string }) =>
	r.status === 2 || /"permissionDecision"\s*:\s*"deny"/.test(r.stdout);

describe("mantahostels#63 — one session's staged files land inside another's commit", () => {
	it("before: B's commit carries A's unrelated file, under B's message", () => {
		alice.edit("docs/a.md", "A's correction\n");
		alice.stage("docs/a.md");

		bob.edit("docs/b.md", "B's work\n");
		bob.stage("docs/b.md");
		bob.commitBare("Re-derive the catalogue figures");

		const landed = a.git("show", "--name-only", "--format=%s", "HEAD");
		expect(landed).toContain("Re-derive the catalogue figures");
		expect(landed).toContain("docs/a.md");

		// The documented follow-on symptom: A has nothing left to commit.
		expect(() =>
			alice.commitPathspec("A's correction", ["docs/a.md"]),
		).toThrow();
	});

	whenBuilt(
		GUARDS.commitForm,
		"after: the bare commit form is challenged",
		() => {
			// Alice's staged file is the whole hazard, and mantahostels#109 made the warn
			// conditional on it: a bare commit against an empty index sweeps
			// nothing, so the guard stays silent there.
			alice.edit("docs/a.md", "A's correction\n");
			alice.stage("docs/a.md");

			const r = bob.runGuard(
				GUARDS.commitForm,
				bob.bashPayload('git commit -m "Re-derive the catalogue figures"'),
			);
			expect(r.silent).toBe(false);
			// It names the file it would sweep.
			expect(r.stdout).toContain("docs/a.md");
		},
	);

	/*
	 * The two directions mantahostels#118 (name the foreign staged file) asked for. The case
	 * that has to go quiet is the commonest one in the repo: a session committing
	 * work it wrote itself.
	 */
	whenBuilt(
		GUARDS.commitForm,
		"after: B's own staged work draws no warn at all",
		() => {
			// mantahostels#1804/mantahostels#1762: the guard hands a session its first clean commit-form
			// command the whole rule text, unlatching only after. Consume that
			// nudge first so this checks the warn logic, not the onboarding text.
			// TWO calls since mantahostels#1805: `git add` draws the pathspec rule alone, and
			// a docs/ commit draws four more, scoped to what the paths name.
			bob.runGuard(
				GUARDS.commitForm,
				bob.bashPayload("git add -N docs/warmup.md"),
			);
			bob.runGuard(
				GUARDS.commitForm,
				bob.bashPayload('git commit -m "warm up" -- docs/warmup.md'),
			);

			bob.edit("docs/b.md", "B's work\n");
			bob.recordWrite("docs/b.md");
			bob.stage("docs/b.md");

			const r = bob.runGuard(
				GUARDS.commitForm,
				bob.bashPayload('git commit -m "Re-derive the catalogue figures"'),
			);
			expect(r.silent).toBe(true);
		},
	);

	whenBuilt(
		GUARDS.commitForm,
		"after: with both staged, only A's file is named",
		() => {
			alice.edit("docs/a.md", "A's correction\n");
			alice.recordWrite("docs/a.md");
			alice.stage("docs/a.md");

			bob.edit("docs/b.md", "B's work\n");
			bob.recordWrite("docs/b.md");
			bob.stage("docs/b.md");

			const r = bob.runGuard(
				GUARDS.commitForm,
				bob.bashPayload('git commit -m "Re-derive the catalogue figures"'),
			);
			expect(r.silent).toBe(false);
			expect(r.stdout).toContain("docs/a.md");
			// Naming B's own file back at B is the noise that makes the warn
			// wallpaper.
			expect(r.stdout).not.toContain("docs/b.md");
		},
	);

	whenBuilt(GUARDS.commitForm, "after: `git commit -am` is refused", () => {
		// Strictly worse than mantahostels#63: -a takes every dirty TRACKED file, so Alice
		// loses work she never staged — she need only have the file open.
		alice.edit("docs/a.md", "A's correction\n");

		const r = bob.runGuard(
			GUARDS.commitForm,
			bob.bashPayload('git commit -am "Re-derive the catalogue figures"'),
		);
		expect(refused(r)).toBe(true);
	});

	whenBuilt(GUARDS.commitForm, "after: the sanctioned stagings pass", () => {
		// mantahostels#1804/mantahostels#1762: consume bob's first-commit-form-command onboarding nudge
		// before the real assertion — see "after: B's own staged work draws no
		// warn at all" above, for the same reason, including why it takes two
		// calls since mantahostels#1805.
		bob.runGuard(
			GUARDS.commitForm,
			bob.bashPayload("git add -N docs/warmup.md"),
		);
		bob.runGuard(
			GUARDS.commitForm,
			bob.bashPayload('git commit -m "warm up" -- docs/warmup.md'),
		);

		const newFile = "docs/c.md";
		bob.edit(newFile, "B's new file\n");
		expect(
			bob.runGuard(GUARDS.commitForm, bob.bashPayload(`git add -N ${newFile}`))
				.silent,
		).toBe(true);

		// Mid-merge, staging is unavoidable — it is how a conflict is resolved.
		a.git("checkout", "-q", "-b", "side");
		a.write("docs/a.md", "side's line\n");
		a.git("commit", "-qm", "side's edit", "--", "docs/a.md");
		a.git("checkout", "-q", "main");
		a.write("docs/a.md", "main's line\n");
		a.git("commit", "-qm", "main's edit", "--", "docs/a.md");
		expect(() => a.git("merge", "side")).toThrow(); // conflicts, as intended

		expect(
			bob.runGuard(GUARDS.commitForm, bob.bashPayload("git add docs/a.md"))
				.silent,
		).toBe(true);
	});
});

describe("stale version bump — two sessions choose the same roadmap version", () => {
	it("before: two content changes land carrying one version number", () => {
		// Both read the stamp at step 1 and reckon its successor by hand.
		const stamp = () =>
			a.read("docs/reference-roadmap.html").match(/v5\.(\d+)/)?.[1];
		expect(stamp()).toBe("74");

		alice.edit(
			"docs/reference-roadmap.html",
			"<!-- roadmap v5.75 -->\ncard one, edited by A\n",
		);
		alice.commitPathspec("A's card edit", ["docs/reference-roadmap.html"]);

		// Bob reckons from the v5.74 he read before A landed, not from HEAD.
		bob.edit(
			"docs/reference-roadmap.html",
			"<!-- roadmap v5.75 -->\ncard one, edited by A\ncard two, added by B\n",
		);
		bob.commitPathspec("B's card addition", ["docs/reference-roadmap.html"]);

		// mantahostels#98 requires the number to count densely — every content change is +1.
		expect(a.git("show", "HEAD:docs/reference-roadmap.html")).toContain(
			"v5.75",
		);
		expect(a.git("show", "HEAD~1:docs/reference-roadmap.html")).toContain(
			"v5.75",
		);
	});

	whenBuilt(
		GUARDS.arbiter,
		"after: the second bump derives +1 from HEAD, not from a stale read",
		() => {
			// mantahostels#98: a script writes HEAD + 1 rather than the agent reckoning it, and
			// validate.js fails an edit whose delta is not exactly +1.
			expect(guardExists(GUARDS.arbiter)).toBe(true);
		},
	);
});

describe("mantahostels#87 — the shared tree is checked onto another branch mid-session", () => {
	it("before: A's commit lands on the branch B switched to", () => {
		alice.edit("docs/a.md", "A's work\n"); // A believes it is on main
		bob.checkoutNew("manual-sync-2026-08-03");
		alice.commitPathspec("A's work", ["docs/a.md"]);

		expect(alice.branch()).toBe("manual-sync-2026-08-03");
		expect(a.git("log", "--oneline", "main")).not.toContain("A's work");
	});

	whenBuilt(GUARDS.branch, "after: the shared-tree checkout is refused", () => {
		const r = bob.runGuard(
			GUARDS.branch,
			bob.bashPayload("git checkout -b manual-sync-2026-08-03"),
		);
		expect(refused(r)).toBe(true);
	});
});

describe("mantahostels#66 — a clean working tree does not mean a file is free", () => {
	it("before: git shows the file clean while a live session still holds it", () => {
		// Alice is mid-task: she has written once and committed that chunk, and
		// is about to write again.
		alice.edit("docs/doc-map.md", "doc-map, A's first chunk\n");
		alice.commitPathspec("A's first chunk", ["docs/doc-map.md"]);

		// The convention in force today reports the file free, so Bob takes it.
		expect(a.freeByConvention("docs/doc-map.md")).toBe(true);
		bob.edit("docs/doc-map.md", "doc-map, B's rewrite\n");

		alice.edit("docs/doc-map.md", "doc-map, A's second chunk\n");
		expect(a.read("docs/doc-map.md")).not.toContain("B's rewrite");
	});

	whenBuilt(
		GUARDS.fileClaim,
		"after: Bob's write is denied and Alice is named as the holder",
		() => {
			// Alice's own write is what claims the file — mantahostels#99's signal 1.
			const claim = alice.runGuard(
				GUARDS.fileClaim,
				alice.writePayload("docs/doc-map.md"),
			);
			expect(refused(claim)).toBe(false);
			alice.edit("docs/doc-map.md", "doc-map, A's first chunk\n");
			alice.commitPathspec("A's first chunk", ["docs/doc-map.md"]);

			const r = bob.runGuard(
				GUARDS.fileClaim,
				bob.writePayload("docs/doc-map.md"),
			);
			expect(refused(r)).toBe(true);
			expect(r.stdout + r.stderr).toContain("alice");
		},
	);

	whenBuilt(
		GUARDS.fileClaim,
		"after: the claim is re-entrant for its own holder",
		() => {
			alice.runGuard(GUARDS.fileClaim, alice.writePayload("docs/doc-map.md"));
			const second = alice.runGuard(
				GUARDS.fileClaim,
				alice.writePayload("docs/doc-map.md"),
			);
			expect(refused(second)).toBe(false);
		},
	);

	whenBuilt(
		GUARDS.fileClaim,
		"after: a killed holder's claim does not wedge the file",
		() => {
			// mantahostels#104's territory. earlyoom leaves no SessionEnd, so the claim outlives
			// its holder; under a deny that wedges every later session permanently.
			alice.runGuard(GUARDS.fileClaim, alice.writePayload("docs/doc-map.md"));
			alice.killed();
			const r = bob.runGuard(
				GUARDS.fileClaim,
				bob.writePayload("docs/doc-map.md"),
			);
			expect(refused(r)).toBe(false);
		},
	);
});

describe("mantahostels#60/mantahostels#73 — mutual deadlock on uncommitted edits", () => {
	it("before: the convention in force forbids both sessions their next edit", () => {
		alice.edit(
			"docs/reference-roadmap.html",
			"<!-- roadmap v5.75 -->\nA in flight\n",
		);
		bob.edit("docs/doc-map.md", "doc-map, B in flight\n");

		// Each now needs the file the other is holding, and the rule says a dirty
		// file belongs to someone else.
		expect(a.freeByConvention("docs/doc-map.md")).toBe(false);
		expect(a.freeByConvention("docs/reference-roadmap.html")).toBe(false);
	});

	// The after-half is debt registration, built by mantahostels#120 against mantahostels#116's design.
	// It does not stop the denial — mantahostels#104 ruled that a denied session abandons the
	// edit rather than waiting, because waiting IS the deadlock. What it stops is
	// the abandoned edit vanishing: the denial itself records the debt, so the
	// next session to reach for the file is told the work is owned elsewhere.

	whenBuilt(
		GUARDS.fileClaim,
		"after: the denial registers the debt itself — Bob declares nothing",
		() => {
			alice.runGuard(
				GUARDS.fileClaim,
				alice.writePayload("docs/reference-roadmap.html"),
			);
			const denial = bob.runGuard(
				GUARDS.fileClaim,
				bob.writePayload("docs/reference-roadmap.html"),
			);
			expect(refused(denial)).toBe(true);

			// mantahostels#99's principle: the record is a side-effect of the denial, so a session
			// that forgets leaves an incomplete debt, never no debt.
			const debts = a.debts();
			expect(debts).toHaveLength(1);
			expect(debts[0].path).toBe("docs/reference-roadmap.html");
			expect(Object.keys(debts[0]).sort()).toEqual([
				"createdAt",
				"gist",
				"issue",
				"path",
				"recordedBy",
			]);
		},
	);

	whenBuilt(
		GUARDS.fileClaim,
		"after: Bob owns the debt and the next claimant is warned off by issue number",
		() => {
			a.ghStub('echo \'{"state":"OPEN"}\'');
			alice.runGuard(
				GUARDS.fileClaim,
				alice.writePayload("docs/reference-roadmap.html"),
			);
			bob.runGuard(
				GUARDS.fileClaim,
				bob.writePayload("docs/reference-roadmap.html"),
			);
			bob.arbiter(
				"debt",
				"own",
				"docs/reference-roadmap.html",
				"73",
				"the v5.75 version bump",
			);

			alice.killed(); // the file is free again; the debt is not
			const carol = a.session("carol").live();
			const r = carol.runGuard(
				GUARDS.fileClaim,
				carol.writePayload("docs/reference-roadmap.html"),
			);

			expect(refused(r)).toBe(false); // a debt warns, it never denies
			expect(r.stdout).toContain("#73");
			expect(r.stdout).toContain("don't fix it here");
			// The issue is authoritative and the gist is only a hint — a claimant who
			// treated the one-liner as the spec would rebuild the wrong thing.
			expect(r.stdout).toContain("authoritative");
			expect(r.stdout).toContain("the v5.75 version bump");
		},
	);

	whenBuilt(
		GUARDS.fileClaim,
		"after: a stub nobody owned says so, rather than naming a ticket that does not exist",
		() => {
			alice.runGuard(GUARDS.fileClaim, alice.writePayload("docs/doc-map.md"));
			bob.runGuard(GUARDS.fileClaim, bob.writePayload("docs/doc-map.md"));
			alice.killed();

			const carol = a.session("carol").live();
			const r = carol.runGuard(
				GUARDS.fileClaim,
				carol.writePayload("docs/doc-map.md"),
			);
			// No issue means no lifecycle and no automatic death: it is cleared by
			// hand or it stays forever, and the message has to say so.
			expect(r.stdout).toContain("never owned");
			expect(r.stdout).toContain("debt clear");
		},
	);

	whenBuilt(
		GUARDS.fileClaim,
		"after: an entry whose owning issue has closed is still shown, and still stands",
		() => {
			// The denial used to retire it here, on a `gh issue view` per entry that
			// retired nothing (mantahostels#1111). Retirement is `debt sweep`'s alone now.
			a.ghStub('echo \'{"state":"CLOSED"}\'');
			alice.runGuard(GUARDS.fileClaim, alice.writePayload("docs/doc-map.md"));
			bob.runGuard(GUARDS.fileClaim, bob.writePayload("docs/doc-map.md"));
			bob.arbiter("debt", "own", "docs/doc-map.md", "73", "the doc-map entry");
			alice.killed();

			const carol = a.session("carol").live();
			const r = carol.runGuard(
				GUARDS.fileClaim,
				carol.writePayload("docs/doc-map.md"),
			);
			expect(r.stdout).toContain("#73");
			expect(a.debts()).toHaveLength(1);
		},
	);

	whenBuilt(
		GUARDS.fileClaim,
		"after: a gh that fails changes nothing about what the denial says",
		() => {
			// No auth, no network, rate-limited — all land here. The claim path asks
			// GitHub nothing at all since mantahostels#1251, so a broken gh cannot reach it;
			// `debt sweep`, which does ask, fails toward keeping every entry.
			a.ghStub('echo "gh: not logged in" >&2; exit 1');
			alice.runGuard(GUARDS.fileClaim, alice.writePayload("docs/doc-map.md"));
			bob.runGuard(GUARDS.fileClaim, bob.writePayload("docs/doc-map.md"));
			bob.arbiter("debt", "own", "docs/doc-map.md", "73", "the doc-map entry");
			alice.killed();

			const carol = a.session("carol").live();
			const r = carol.runGuard(
				GUARDS.fileClaim,
				carol.writePayload("docs/doc-map.md"),
			);
			expect(r.stdout).toContain("#73");
			expect(a.debts()).toHaveLength(1);
		},
	);

	// mantahostels#327, observed twice in one session on docs/doc-map.md: two sessions denied
	// on the file owed two different edits, and a store keyed by path alone held
	// one of them.
	whenBuilt(
		GUARDS.fileClaim,
		"after: two denials on one file leave two debts, and the next claimant is told both",
		() => {
			a.ghStub('echo \'{"state":"OPEN"}\'');
			alice.runGuard(GUARDS.fileClaim, alice.writePayload("docs/doc-map.md"));

			bob.runGuard(GUARDS.fileClaim, bob.writePayload("docs/doc-map.md"));
			bob.arbiter(
				"debt",
				"own",
				"docs/doc-map.md",
				"308",
				"the node-unit pass",
			);

			const carol = a.session("carol").live();
			carol.runGuard(GUARDS.fileClaim, carol.writePayload("docs/doc-map.md"));
			carol.arbiter(
				"debt",
				"own",
				"docs/doc-map.md",
				"323",
				"#314's CI figures in .github/workflows/scheduled-checks.yml",
			);

			expect(a.debts()).toHaveLength(2);

			alice.killed();
			const dave = a.session("dave").live();
			const r = dave.runGuard(
				GUARDS.fileClaim,
				dave.writePayload("docs/doc-map.md"),
			);
			expect(refused(r)).toBe(false); // a debt warns, it never denies
			expect(r.stdout).toContain("#308");
			expect(r.stdout).toContain("#323");

			// And the sweep that took a live debt with it is now refused: mantahostels#308's
			// session finished its work and cleared the path, not its own entry.
			const cleared = dave.arbiter("debt", "clear", "docs/doc-map.md");
			expect(cleared.status).toBe(2);
			expect(a.debts()).toHaveLength(2);
			dave.arbiter("debt", "clear", "docs/doc-map.md", "308");
			expect(a.debts().map((d) => d.issue)).toEqual([323]);
		},
	);

	whenBuilt(
		GUARDS.fileClaim,
		"after: a claim on an undebted path makes no lookup at all",
		() => {
			// The overwhelmingly common case. A gh call on every guarded write would
			// put ~1s on every edit any session makes to docs/.
			const marker = path.join(a.dir, "gh-was-called");
			a.ghStub(`touch ${JSON.stringify(marker)}; echo '{"state":"OPEN"}'`);

			const r = alice.runGuard(
				GUARDS.fileClaim,
				alice.writePayload("docs/a.md"),
			);
			expect(refused(r)).toBe(false);
			expect(fs.existsSync(marker)).toBe(false);
		},
	);
});

/*
 * Wiring — that these guards run on the right event and matcher — is asserted
 * for every registration in the file by scripts/hook-registrations.test.ts (mantahostels#258).
 */

describe("mantahostels#128 — two sessions appending to one issue body", () => {
	const mapBody = "## Decisions so far\n\n- #123 — the shared parser\n";

	it("before: a second writer erases the first, leaving no sign it happened", () => {
		a.issueStub(mapBody);
		// The only shape GitHub offers: download whole, edit, upload whole. Both
		// sessions download the same base, so whoever uploads second wins outright.
		const alicesBase = a.readIssueBodyText();
		const bobsBase = a.readIssueBodyText();
		a.writeIssueBody(`${alicesBase}- #128 — alice's entry\n`);
		a.writeIssueBody(`${bobsBase}- #131 — bob's entry\n`);

		expect(a.readIssueBodyText()).toContain("bob's entry");
		expect(a.readIssueBodyText()).not.toContain("alice's entry");
	});

	/** N real processes appending to one body at once. */
	const race = (n: number, extra: string[] = []) =>
		Promise.all(
			Array.from({ length: n }, (_, i) =>
				a
					.session(`writer-${i}`)
					.issueBody(
						"append-section",
						"96",
						"--heading",
						"Decisions so far",
						"--text",
						`- #${140 + i} — entry ${i}`,
						...extra,
					),
			),
		);

	const survived = (n: number) => {
		const final = a.readIssueBodyText();
		for (let i = 0; i < n; i++) {
			expect(final).toContain(`entry ${i}`);
			// Nothing duplicated either: a repair re-applies, it does not re-add.
			expect(final.match(new RegExp(`entry ${i}\\b`, "g"))).toHaveLength(1);
		}
	};

	/**
	 * This one cannot detect a broken repair loop: the lock serialises the
	 * writers, so it passes with either mutation applied. It proves the shipped
	 * configuration, and the lock-free test below is what holds the guarantee.
	 */
	it("after: eight concurrent appends all survive, serialised by the local lock", async () => {
		a.issueStub(mapBody);
		const results = await race(8);
		expect(results.filter((r) => r.status !== 0)).toEqual([]);
		survived(8);
	}, 60_000);

	/*
	 * With the lock off, the loop is the only thing holding the line — the case
	 * the lock cannot cover: the founder's own terminal, another machine, CI.
	 * Whether an entry survives there turns on ONE ordering, so both sides of it
	 * are driven deterministically rather than raced (mantahostels#142; Tier 1).
	 *
	 * The writer's call sequence is view, edit, view. The rival's write lands
	 * either between the writer's edit and its verify (call 2), or after that
	 * verify (call 3). The lock is left at its default and does nothing here:
	 * the rival is the stub, not a second process, so there is nothing for a
	 * lock to serialise.
	 */
	const rivalBody = `${mapBody}- #999 — the rival's entry\n`;
	const lockFree = (intrudeAfterCall: number) => {
		a.issueStub(mapBody, 0, { afterCall: intrudeAfterCall, body: rivalBody });
		return a
			.session("writer")
			.issueBody(
				"append-section",
				"96",
				"--heading",
				"Decisions so far",
				"--text",
				"- #140 — entry 0",
			);
	};

	/*
	 * Delete the re-fetch check and the writer's entry goes missing; make the
	 * retry re-upload its stale body instead of re-applying onto theirs, and the
	 * rival's entry goes missing instead.
	 */
	it("after: a write clobbered before the verify is repaired, losing neither entry", async () => {
		const r = await lockFree(2);
		expect(r.status).toBe(0);
		expect(a.readIssueBodyText()).toContain("entry 0");
		expect(a.readIssueBodyText()).toContain("rival's entry");
		expect(a.readIssueBodyText().match(/entry 0\b/g)).toHaveLength(1);
		// It repaired rather than got lucky: a second write happened.
		expect(r.stdout).toMatch(/\(([2-9]|\d\d) writes\)/);
	}, 60_000);

	/*
	 * The residual the loop cannot close — this is what the local lock exists
	 * to cover.
	 */
	it("after: a write clobbered after the verify is lost, and reports success", async () => {
		const r = await lockFree(3);
		expect(r.status).toBe(0);
		expect(r.stdout).toMatch(/\(1 write\)/);
		expect(a.readIssueBodyText()).not.toContain("entry 0");
		expect(a.readIssueBodyText()).toContain("rival's entry");
	}, 60_000);

	/*
	 * Real concurrency without the lock, asserting only what holds under EVERY
	 * ordering. Survival is deliberately not asserted — that is the residual
	 * above, and asserting it here is what made this test flaky.
	 */
	it("after: concurrent lock-free writers never error or duplicate", async () => {
		a.issueStub(mapBody, 150);
		a.extraEnv.WFC_ISSUE_LOCK_WAIT_MS = "0";
		const results = await race(4, ["--attempts", "12"]);
		expect(results.filter((r) => r.status !== 0)).toEqual([]);
		const final = a.readIssueBodyText();
		expect(final).toContain("#123 — the shared parser");
		for (let i = 0; i < 4; i++) {
			expect(
				(final.match(new RegExp(`entry ${i}\\b`, "g")) ?? []).length,
			).toBeLessThanOrEqual(1);
		}
	}, 60_000);
});

describe("the claim primitive under real concurrency", () => {
	whenBuilt(
		GUARDS.fileClaim,
		"exactly one of many simultaneous claimants wins",
		async () => {
			// Tier 2. The only mode interleaving cannot show: mantahostels#103 §3's race, where
			// two sessions read an empty registry in the same instant. The entry must
			// be created with a primitive that fails when it already exists.
			const claimants = Array.from({ length: 8 }, (_, i) =>
				a.session(`racer-${i}`).live(),
			);
			const results = await Promise.all(
				claimants.map((s) =>
					s.runGuardAsync(GUARDS.fileClaim, s.writePayload("docs/doc-map.md")),
				),
			);
			expect(results.filter((r) => !refused(r))).toHaveLength(1);
		},
	);
});
