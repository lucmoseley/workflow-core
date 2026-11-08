// @vitest-environment node
/*
 * Pins that a path under a declared sensitive glob owes the escalated review
 * tier at any size (#1618). Loosen a case and a change to a declared area
 * gets the standard review, or none under the churn floor. The fixture:
 * concision-backstop.test.ts's header.
 *
 * Over base §X8 (5)'s 10 s budget: each case spawns the hook for real, 0.3-0.5 s
 * a run (#4308's profile), and the logic under test is bash with no in-process seam.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	BIG_CODE,
	backstopFixture,
	cfg,
	dir,
	git,
	gitAt,
	ME,
	markersDir,
	OTHER,
	record,
	repo,
	run,
	write,
} from "./lib/concision-backstop-testkit";
import { readGuardErrorsLog } from "./lib/guard-errors-log";

backstopFixture();

describe("a declared sensitive glob owes the escalated tier at any size — #1618", () => {
	const policy =
		"create policy own_rows on bookings using (guest = auth.uid());\n";

	const declare = (globs: string[]) =>
		write(
			".claude/workflow-core.json",
			JSON.stringify({
				sensitivePaths: [
					{ name: "RLS", description: "who may read or write what", globs },
				],
			}),
		);

	const wroteSql = () => {
		write("supabase/migrations/001_rls.sql", policy);
		record("supabase/migrations/001_rls.sql", ME);
	};

	it("nags on a one-line .sql change under a declared glob, naming the tier and the area", () => {
		declare(["supabase/migrations/**"]);
		wroteSql();

		const reason = run("stop") ?? "";
		expect(reason).toContain("`escalated` review tier is owed");
		expect(reason).toContain("declared sensitive paths (RLS)");
		expect(reason).toContain("supabase/migrations/001_rls.sql");
		expect(reason).toContain(
			"two `Agent` tool calls, or three or four on an escalated or mission-critical change",
		);
	});

	it("counts a committed change too", () => {
		declare(["supabase/migrations/**"]);
		wroteSql();
		git("add", "supabase/migrations/001_rls.sql");
		git("commit", "-qm", "rls", "--", "supabase/migrations/001_rls.sql");

		expect(run("stop") ?? "").toContain("`escalated` review tier is owed");
	});

	it("stays silent on the same change where no glob covers it", () => {
		declare(["app/money/**"]);
		wroteSql();

		expect(run("stop")).toBeNull();
	});

	it("stays silent on a neighbour's write under the glob", () => {
		declare(["supabase/migrations/**"]);
		write("supabase/migrations/001_rls.sql", policy);
		record("supabase/migrations/001_rls.sql", OTHER);
		write("docs/mine.md", "three short words\n");
		record("docs/mine.md", ME);

		expect(run("stop")).toBeNull();
	});

	it("logs a declaration the matcher cannot read, and falls to the standard tier", () => {
		write(".claude/workflow-core.json", "{ not json");
		wroteSql();
		write("scripts/mine.ts", `${BIG_CODE}\n`);
		record("scripts/mine.ts", ME);

		expect(run("stop") ?? "").toContain("`standard` review tier is owed");
		expect(readGuardErrorsLog(cfg)).toContain("lib/sensitive-paths.js failed");
	});

	// #4049: the hold refuses a narrowing under the area's name, so the nag owes it too.
	describe("a change narrowing the declaration since the start point", () => {
		const DeclarationPath = ".claude/workflow-core.json";
		const startAfter = (body: () => void) => {
			body();
			git("add", DeclarationPath);
			git("commit", "-qm", "declaration", "--", DeclarationPath);
			fs.writeFileSync(
				path.join(markersDir(), `.concision-base-${ME}`),
				git("rev-parse", "HEAD").trim(),
			);
		};

		it.each([
			["dropping the glob", () => declare([])],
			[
				"declaring none",
				() => write(DeclarationPath, JSON.stringify({ sensitivePaths: [] })),
			],
		])("names the escalated tier and the area on %s", (_, narrow) => {
			startAfter(() => declare(["supabase/migrations/**"]));
			narrow();
			record(DeclarationPath, ME);

			const reason = run("stop") ?? "";
			expect(reason).toContain("`escalated` review tier is owed");
			expect(reason).toContain("declared sensitive paths (RLS)");
			expect(reason).toContain(DeclarationPath);
		});

		it("names the escalated tier on an area committed since the start point and dropped from the working copy", () => {
			declare(["supabase/migrations/**"]);
			git("add", DeclarationPath);
			git("commit", "-qm", "declaration", "--", DeclarationPath);
			declare([]);
			record(DeclarationPath, ME);

			expect(run("stop") ?? "").toContain("`escalated` review tier is owed");
		});

		it("stays silent on a change keeping every glob", () => {
			startAfter(() => declare(["supabase/migrations/**"]));
			declare(["supabase/migrations/**", "app/money/**"]);
			record(DeclarationPath, ME);

			expect(run("stop")).toBeNull();
		});

		it("logs a start-point copy that will not read", () => {
			startAfter(() => write(DeclarationPath, "{ not json"));
			declare([]);
			record(DeclarationPath, ME);

			run("stop");
			expect(readGuardErrorsLog(cfg)).toContain(
				"did not read — a narrowing of it checked only as far as it read: BROKEN: ",
			);
		});
	});

	it("names the standard tier on code no glob covers", () => {
		declare(["supabase/migrations/**"]);
		write("scripts/mine.ts", `${BIG_CODE}\n`);
		record("scripts/mine.ts", ME);

		const reason = run("stop") ?? "";
		expect(reason).toContain("`standard` review tier is owed");
		expect(reason).not.toContain("`escalated`");
	});

	it("names the marker script, and the flags an escalated change adds (#2040)", () => {
		declare(["supabase/migrations/**"]);
		wroteSql();

		const reason = run("stop") ?? "";
		expect(reason).toContain("node scripts/write-review-marker.js --base ");
		expect(reason).toContain(
			"record it with --tier escalated (or mission-critical) --areas 'RLS'",
		);
	});

	// #1696: the latch holds the tier it nagged at.
	it("nags again when a change nagged at the standard tier turns escalated, and then no more", () => {
		declare(["supabase/migrations/**"]);
		write("scripts/mine.ts", `${BIG_CODE}\n`);
		record("scripts/mine.ts", ME);
		expect(run("stop") ?? "").toContain("`standard` review tier is owed");
		expect(run("stop")).toBeNull();

		wroteSql();
		expect(run("stop") ?? "").toContain("`escalated` review tier is owed");
		expect(run("stop")).toBeNull();
	});

	// #1772: an escalated latch stays escalated.
	it("names a rejected marker after the escalated nag, and does not announce the tier again when it falls and rises", () => {
		declare(["supabase/migrations/**"]);
		write("scripts/mine.ts", `${BIG_CODE}\n`);
		record("scripts/mine.ts", ME);
		wroteSql();
		expect(run("stop") ?? "").toContain("`escalated` review tier is owed");

		fs.rmSync(path.join(repo, "supabase/migrations/001_rls.sql"));
		fs.writeFileSync(
			path.join(markersDir(), `.codereview-pass-${ME}`),
			`base=${"0".repeat(40)}\nfindings=2\n`,
		);
		const reason = run("stop") ?? "";
		expect(reason).toContain("`standard` review tier is owed");
		expect(reason).toContain("was rejected — its base= names a commit");

		wroteSql();
		expect(run("stop")).toBeNull();
	});

	// #1696: a standard review's marker never passes for an escalated one.
	describe("a marker on an escalated change", () => {
		const reviewed = (lines: string) => {
			const base = fs
				.readFileSync(path.join(markersDir(), `.concision-base-${ME}`), "utf8")
				.trim();
			fs.mkdirSync(markersDir(), { recursive: true });
			fs.writeFileSync(
				path.join(markersDir(), `.codereview-pass-${ME}`),
				`base=${base}\nfindings=2\n${lines}`,
			);
		};

		it.each([
			["no tier= line", "", "it has no tier= line"],
			[
				"tier=standard",
				"tier=standard\nareas=RLS\n",
				"its tier= is 'standard'",
			],
			[
				"areas= missing the matched area",
				"tier=escalated\nareas=money\n",
				"its areas= does not name RLS",
			],
		])(
			"leaves the nag firing on a one-line .sql change with %s, quoting why",
			(_, lines, fault) => {
				declare(["supabase/migrations/**"]);
				wroteSql();
				reviewed(lines);

				const reason = run("stop") ?? "";
				expect(reason).toContain("`escalated` review tier is owed");
				expect(reason).toContain(`was rejected — ${fault}`);
			},
		);

		// #1748: the hold refuses nothing in a worktree, so the nag is its only signal.
		// Stop reads the shared tree alone, so it sees the commit once landed.
		it("nags on an escalated change landed by fast-forward from a worktree, rejecting a standard review's marker", () => {
			declare(["supabase/migrations/**"]);
			const wt = path.join(dir, "wt");
			const rel = "supabase/migrations/001_rls.sql";
			gitAt(repo, "worktree", "add", "-q", "--detach", wt);
			fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
			fs.writeFileSync(path.join(wt, rel), policy);
			record(rel, ME);
			gitAt(wt, "add", rel);
			gitAt(wt, "commit", "-qm", "rls", "--", rel);
			git("merge", "-q", "--ff-only", gitAt(wt, "rev-parse", "HEAD").trim());
			reviewed("tier=standard\nareas=RLS\n");

			const reason = run("stop") ?? "";
			expect(reason).toContain("`escalated` review tier is owed");
			expect(reason).toContain(rel);
			expect(reason).toContain("was rejected — its tier= is 'standard'");
		});

		it.each([
			"tier=escalated\nareas=RLS\n",
			"tier=mission-critical\nareas=money, RLS\n",
		])(
			"is silent once the marker records an upper tier naming every area: %j",
			(lines) => {
				declare(["supabase/migrations/**"]);
				wroteSql();
				reviewed(lines);

				expect(run("stop")).toBeNull();
			},
		);
	});
});
