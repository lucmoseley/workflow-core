// @vitest-environment node
/*
 * scripts/push-review-owed.sh through lib/push-review.js (#2785): whether the
 * code a push carries owes a review no valid marker covers (#1163), read by
 * lib/code-signal.sh's review_uncovered over HEAD, in a real repo with a real
 * ledger.
 *
 * Break it and a session pushes unreviewed code unwarned, or is told of a
 * neighbour's.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { code, ME, PAST_FLOOR, reviewFixture } from "./lib/push-review-fixture";

const {
	f,
	git,
	freshCopy,
	commitBy,
	commitUnwritten,
	ledgerHead,
	marker,
	recordWrite,
	declareRls,
	owed,
} = reviewFixture();

describe("what the adapter answers (#1163)", () => {
	it("names the files, the start point and the standard tier where this session's pushed code has no marker", () => {
		commitBy("scripts/mine.ts", code(PAST_FLOOR));
		expect(owed()).toEqual({
			tier: "standard",
			files: "scripts/mine.ts",
			base: f.base,
			tierLine: "The `standard` review tier is owed.",
			markerMore: "",
			passFault: "",
			markerScript: "scripts/write-review-marker.js",
		});
	});

	it("is silent where a valid marker covers the session's start point", () => {
		commitBy("scripts/mine.ts", code(PAST_FLOOR));
		marker(`base=${f.base}\nfindings=3\n`);
		expect(owed()).toBeNull();
	});

	it.each([
		["base=main\nfindings=3\n", "its base= is not a 40-hex sha, 'main'"],
		[
			"base=BASE\nfindings=several\n",
			"its findings= is not a number, 'several'",
		],
	])("quotes the validator's fault on marker %j", (body, fault) => {
		commitBy("scripts/mine.ts", code(PAST_FLOOR));
		marker(body.replace("BASE", f.base));
		expect(owed()?.passFault).toContain(fault);
	});

	it.each([
		["a docs-only push", () => commitBy("docs/a.md", "word ".repeat(200))],
		["code below the churn floor", () => commitBy("scripts/mine.ts", code(5))],
		[
			// A ledger entry of this session's own, so the attribution filter, and
			// not the empty-ledger exit, is what keeps it silent.
			"a neighbour's code, which this session did not write",
			() => {
				commitBy("scripts/mine.ts", code(1));
				commitBy("scripts/theirs.ts", code(PAST_FLOOR), "parallel-session");
			},
		],
		[
			"code written but not committed, which no push carries",
			() => {
				commitBy("scripts/mine.ts", code(1));
				fs.writeFileSync(
					path.join(f.shared, "scripts", "mine.ts"),
					"export const y = 1;\n".repeat(40),
				);
			},
		],
	])("is silent on %s", (_, make) => {
		make();
		expect(owed()).toBeNull();
	});

	// #2390: an edit through an inline interpreter leaves no write-ledger line.
	it("bills code this session committed with no write-ledger line, and not a neighbour's", () => {
		commitUnwritten("scripts/theirs.ts", "parallel-session");
		expect(owed()).toBeNull();
		commitUnwritten("scripts/mine.ts", ME);
		expect(owed()?.files).toBe("scripts/mine.ts");
	});

	// #1618: a one-line migration is billed, where code(1) is not.
	it("names the escalated tier, the area and the marker lines it owes for a range touching a declared glob, at any size", () => {
		declareRls();
		commitBy("supabase/migrations/001_rls.sql", "create policy p on t;\n");
		const o = owed();
		expect(o?.tier).toBe("escalated");
		expect(o?.files).toBe("supabase/migrations/001_rls.sql");
		expect(o?.tierLine).toContain(
			"The `escalated` review tier is owed: this change touches declared sensitive paths (RLS)",
		);
		expect(o?.markerMore).toContain(
			"record it with --tier escalated (or mission-critical) --areas 'RLS'",
		);
	});

	// #1696: a standard review's marker never passes for an escalated one.
	it.each([
		["no tier= line", "", "it has no tier= line"],
		["tier=standard", "tier=standard\nareas=RLS\n", "its tier= is 'standard'"],
		[
			"areas= missing the matched area",
			"tier=escalated\nareas=money\n",
			"its areas= does not name RLS",
		],
	])(
		"rejects a one-line .sql range's marker with %s, quoting why",
		(_, lines, fault) => {
			declareRls();
			commitBy("supabase/migrations/001_rls.sql", "create policy p on t;\n");
			marker(`base=${f.base}\nfindings=2\n${lines}`);
			expect(owed()?.passFault).toContain(fault);
		},
	);

	it.each([
		"tier=escalated\nareas=RLS\n",
		"tier=mission-critical\nareas=money, RLS\n",
	])(
		"is silent on a sensitive range once the marker records an upper tier naming every area: %j",
		(lines) => {
			declareRls();
			commitBy("supabase/migrations/001_rls.sql", "create policy p on t;\n");
			marker(`base=${f.base}\nfindings=2\n${lines}`);
			expect(owed()).toBeNull();
		},
	);

	// #1748: the hold skips a worktree commit, so this warn is its only signal.
	it("reads an escalated range committed in a worktree from there, rejecting a standard review's marker", () => {
		const rel = "supabase/migrations/001_rls.sql";
		declareRls();
		commitBy(rel, "create policy p on t;\n", ME, f.worktree);
		marker(`base=${f.base}\nfindings=2\ntier=standard\nareas=RLS\n`);
		const o = owed(f.worktree);
		expect(o?.files).toBe(rel);
		expect(o?.tier).toBe("escalated");
		expect(o?.passFault).toContain("its tier= is 'standard'");
	});

	// #1840 F1: a staged review's base= is newer than the start point, and only
	// its paths= bounds what it vouches for.
	it.each([
		["the shared tree", () => f.shared],
		["a worktree", () => f.worktree],
	])(
		"rejects, in %s, a marker whose base= follows a neighbour's commit and that has no paths=, naming both ways to clear it",
		(_, tree) => {
			commitBy("scripts/theirs.ts", code(1), "parallel-session", tree());
			const reviewed = git(tree(), "rev-parse", "HEAD").trim();
			commitBy("scripts/mine.ts", code(PAST_FLOOR), ME, tree());
			marker(`base=${reviewed}\nfindings=1\n`);
			const fault = owed(tree())?.passFault;
			expect(fault).toContain(
				"its base= is ahead of this session's start point and it has no paths= line",
			);
			expect(fault).toContain("names them in paths=");
			expect(fault).toContain(`sets base=${f.base}, its start point`);
		},
	);

	it("is silent on a marker whose base= follows a neighbour's commit once its paths= names the session's code", () => {
		commitBy("scripts/theirs.ts", code(1), "parallel-session");
		const reviewed = git(f.shared, "rev-parse", "HEAD").trim();
		commitBy("scripts/mine.ts", code(PAST_FLOOR));
		marker(`base=${reviewed}\nfindings=1\npaths=scripts/mine.ts\n`);
		expect(owed()).toBeNull();
	});

	it("is silent on a marker whose base= follows a neighbour's ledgered commit to a path this session wrote, once paths= names it (#3099)", () => {
		commitBy("scripts/shared.ts", code(1), "parallel-session");
		ledgerHead("parallel-session");
		const reviewed = git(f.shared, "rev-parse", "HEAD").trim();
		commitBy("scripts/shared.ts", code(PAST_FLOOR));
		ledgerHead(ME);
		marker(`base=${reviewed}\nfindings=1\npaths=scripts/shared.ts\n`);
		expect(owed()).toBeNull();
	});

	// #3088's shape: the session's own edit to the neighbour's file was taken
	// back out, so its review's paths= never names that file.
	it("is silent where paths= leaves out a path this session wrote whose only change since the start point is a neighbour's ledgered commit", () => {
		commitBy("scripts/shared.ts", code(1), "parallel-session");
		ledgerHead("parallel-session");
		recordWrite("scripts/shared.ts");
		const reviewed = git(f.shared, "rev-parse", "HEAD").trim();
		commitBy("scripts/mine.ts", code(PAST_FLOOR));
		marker(`base=${reviewed}\nfindings=1\npaths=scripts/mine.ts\n`);
		expect(owed()).toBeNull();
	});

	it("is silent on a marker whose base= follows an unledgered commit matching no patch of this session's, once paths= names its path (#3108)", () => {
		commitBy("scripts/shared.ts", code(1));
		const reviewed = git(f.shared, "rev-parse", "HEAD").trim();
		commitBy("scripts/shared.ts", code(PAST_FLOOR));
		marker(`base=${reviewed}\nfindings=1\npaths=scripts/shared.ts\n`);
		expect(owed()).toBeNull();
	});

	it.each([
		["ledgered", false],
		// A rebase gives the session's own commit a sha no ledger names (#3108).
		["rebased", true],
	])(
		"rejects a marker whose base= follows this session's own %s commit, though paths= names its path, naming its base= as ahead of the start point",
		(_, rebased) => {
			commitBy("scripts/shared.ts", code(1));
			ledgerHead(ME);
			const before = git(f.shared, "rev-parse", "HEAD").trim();
			if (rebased) git(f.shared, "reset", "-q", "--hard", "HEAD~1");
			commitBy("scripts/theirs.ts", code(1), "parallel-session");
			ledgerHead("parallel-session");
			if (rebased) git(f.shared, "cherry-pick", before);
			const reviewed = git(f.shared, "rev-parse", "HEAD").trim();
			commitBy("scripts/shared.ts", code(PAST_FLOOR));
			marker(`base=${reviewed}\nfindings=1\npaths=scripts/shared.ts\n`);
			expect(owed()?.passFault).toContain(
				"its base= is ahead of this session's start point, so it covered less than the session changed",
			);
		},
	);

	// #1925: in a worktree the hold is skipped, so a staged review's first-commit
	// marker reaches the push with base= at the start point.
	it("rejects a worktree's first-commit marker at the start point with tree= and no paths=, naming the missing paths= line", () => {
		commitBy("scripts/mine.ts", code(PAST_FLOOR), ME, f.worktree);
		const tree = git(f.worktree, "rev-parse", "HEAD^{tree}").trim();
		marker(`base=${f.base}\nfindings=0\ntree=${tree}\n`);
		const fault = owed(f.worktree)?.passFault;
		expect(fault).toContain("it has a tree= line and no paths= line");
		expect(fault).toContain("names every path its diff named in paths=");
	});

	it("is silent on a marker at the start point with neither tree= nor paths=, a whole-session review", () => {
		commitBy("scripts/mine.ts", code(PAST_FLOOR), ME, f.worktree);
		marker(`base=${f.base}\nfindings=0\n`);
		expect(owed(f.worktree)).toBeNull();
	});

	it("is silent, and logs nothing, with no start point recorded", () => {
		commitBy("scripts/mine.ts", code(PAST_FLOOR));
		fs.rmSync(
			path.join(f.shared, ".claude", "tmp", "markers", `.concision-base-${ME}`),
		);
		expect(owed()).toBeNull();
		expect(f.logs).toEqual([]);
	});

	it("reads the same code signal as the Stop backstop, from the one shared helper", () => {
		for (const script of ["concision-backstop.sh", "push-review-owed.sh"]) {
			const text = fs.readFileSync(path.join(__dirname, script), "utf8");
			expect(text).toMatch(/^\s*source .*\/lib\/code-signal\.sh"/m);
			expect(text).not.toMatch(/^CODE=\(/m);
		}
	});
});

describe("how its answer is read back", () => {
	/** Seven fields, as the adapter prints them, tier first. */
	const fieldCount = 7;
	const fields = (n: number) => `${"x\0".repeat(n)}`;
	/* reviewOwed spawns `bash` off PATH, so a stub there stands in for the
	 * adapter and prints `out` verbatim. */
	const answering = (out: string) => {
		const bin = path.join(f.dir, "bin");
		fs.mkdirSync(bin);
		fs.writeFileSync(path.join(f.dir, "out"), out);
		fs.writeFileSync(
			path.join(bin, "bash"),
			`#!/bin/sh\ncat '${path.join(f.dir, "out")}'\n`,
			{ mode: 0o755 },
		);
		vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
		return owed();
	};

	it("reads nothing as no review owed, logging nothing", () => {
		expect(answering("")).toBeNull();
		expect(f.logs).toEqual([]);
	});

	it("reads seven NUL-terminated fields with a known tier", () => {
		expect(answering(`standard\0${fields(fieldCount - 1)}`)).toMatchObject({
			tier: "standard",
			markerScript: "x",
		});
	});

	it.each([
		["a field short", `standard\0${fields(fieldCount - 2)}`],
		["a field over", `standard\0${fields(fieldCount)}`],
		["no closing NUL", `standard\0${fields(fieldCount - 2)}x`],
		["a tier it does not know", `urgent\0${fields(fieldCount - 1)}`],
	])("reads %s as no review owed, logged as unreadable", (_, out) => {
		expect(answering(out)).toBeNull();
		expect(f.logs).toEqual([
			"push-review-owed.sh answered unreadably — push not checked for review",
		]);
	});
});

/*
 * The helper (mantahostels#2068) leak-checks every instantiate() call itself,
 * so the fixture's beforeEach already throws were the copy still pointing at
 * the template. What is left is the BEHAVIOURAL isolation a leak would cause:
 * a write made in the instantiated copy must not reach a second, independent
 * instantiation of the same template.
 */
describe("the copied fixture is isolated from its template (mantahostels#2168)", () => {
	// Asserted on the WORKTREE, not `shared`: a worktree shares its parent's
	// object store, so a stale gitdir pointer left by a naive copy writes into
	// the template rather than failing loudly.
	it("a commit made in the copied worktree leaves the template untouched", () => {
		fs.writeFileSync(path.join(f.worktree, "c.md"), "c\n");
		git(f.worktree, "add", "c.md");
		git(f.worktree, "commit", "-qm", "worktree copy only", "--", "c.md");
		expect(git(f.worktree, "log", "--oneline")).toContain("worktree copy only");

		const fresh = freshCopy();
		try {
			expect(
				git(path.join(fresh, "shared"), "log", "--all", "--oneline"),
			).not.toContain("worktree copy only");
		} finally {
			fs.rmSync(fresh, { recursive: true, force: true });
		}
	});
});
