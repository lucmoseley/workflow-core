// @vitest-environment node
/*
 * Pins that the Stop backstop accepts only a pass marker that covers the
 * range this session changed (mantahostels#139). The fixture and the reasoning
 * behind it: concision-backstop.test.ts's header.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	BIG_CODE,
	backstopFixture,
	git,
	ledgerHeadOf,
	ME,
	markersDir,
	OTHER,
	PARAGRAPH,
	record,
	run,
	spawnBackstop,
	write,
} from "./lib/concision-backstop-testkit";

backstopFixture();

describe("pass markers — the mantahostels#139 change", () => {
	// #1803: a missing review marker is the normal case, not an error.
	it("writes nothing to stderr on a nagging Stop with no review marker on disk", () => {
		write("scripts/mine.ts", `${BIG_CODE}\n`);
		record("scripts/mine.ts", ME);
		expect(
			fs.existsSync(path.join(markersDir(), `.codereview-pass-${ME}`)),
		).toBe(false);

		const r = spawnBackstop("stop");
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("review tier is owed");
		expect(r.stderr).toBe("");
	});

	/** The base the hook recorded at SessionStart, which markers must match. */
	const readRecordedBase = () =>
		fs
			.readFileSync(path.join(markersDir(), `.concision-base-${ME}`), "utf8")
			.trim();

	const marker = (name: string, body: string) => {
		fs.mkdirSync(markersDir(), { recursive: true });
		fs.writeFileSync(path.join(markersDir(), name), body);
	};

	/** A session that changed code it owns — the code signal's precondition. */
	const changedCode = () => {
		write("scripts/mine.ts", `${BIG_CODE}\n`);
		record("scripts/mine.ts", ME);
	};

	// mantahostels#1071 — a two-axis review costs ~2M tokens of one shared weekly
	// allowance, so a diff this small buys less than it spends.
	it("stays silent for a code change below the churn threshold", () => {
		write("scripts/tiny.ts", "export const x = 1;\n");
		record("scripts/tiny.ts", ME);

		expect(run("stop")).toBeNull();
	});

	it("asks for code review when the review marker is empty", () => {
		changedCode();
		marker(`.codereview-pass-${ME}`, "");

		expect(run("stop")).toContain("code-review");
	});

	// mantahostels#958 — the nag is the only route by which the pin reaches this review.
	// Moved off Fable to Opus 5.5 at high, through the code-reviewer agent type
	// (#350, #363); this fixture host has no definition of its own, so it gets
	// the plugin's spelling (#741).
	it("pins the review axes to the code-reviewer type on opus, backticks intact", () => {
		changedCode();

		const reason = run("stop");
		// Anchored on the phrase that follows it: the nag carries a second model
		// pin (mantahostels#2614), so the anchor ties the literal to the reviewer's
		// sentence rather than to whichever pin matches first.
		expect(reason).toContain('`model: "opus"` on every one');
		expect(reason).toContain("`workflow-core:code-reviewer`");
		expect(reason).not.toContain('"fable"');
		// Without this the axes run one after the other in one context.
		expect(reason).toContain("SINGLE message");
	});

	it("stays silent for a marker recording the session's own base", () => {
		changedCode();
		marker(
			`.codereview-pass-${ME}`,
			`base=${readRecordedBase()}\nfindings=3\n`,
		);

		expect(run("stop")).toBeNull();
	});

	it("fires when the marker reviewed a narrower range than the session changed", () => {
		// A fixed point AHEAD of the session's base, past code the session
		// committed, covers less than the session wrote.
		changedCode();
		git("add", "scripts/mine.ts");
		git("commit", "-q", "-m", "mine");
		marker(
			`.codereview-pass-${ME}`,
			`base=${git("rev-parse", "HEAD").trim()}\nfindings=0\n`,
		);

		expect(run("stop")).toContain("code-review");
	});

	it("fires when the marker's base= is ahead past a sub-floor commit of this session's (#1745)", () => {
		write("scripts/tiny.ts", "export const x = 1;\n");
		record("scripts/tiny.ts", ME);
		git("add", "scripts/tiny.ts");
		git("commit", "-q", "-m", "tiny");
		changedCode();
		marker(
			`.codereview-pass-${ME}`,
			`base=${git("rev-parse", "HEAD").trim()}\nfindings=0\n`,
		);

		expect(run("stop")).toContain("code-review");
	});

	it("fires when the marker's base= is off this session's line of history (#1745)", () => {
		changedCode();
		const orphan = git("commit-tree", "HEAD^{tree}", "-m", "orphan").trim();
		marker(`.codereview-pass-${ME}`, `base=${orphan}\nfindings=0\n`);

		expect(run("stop")).toContain("not on this session's line of history");
	});

	it("stays silent for a marker whose base= is ahead only past a neighbour's commit and whose paths= names the code (#1745)", () => {
		git("commit", "-q", "--allow-empty", "-m", "neighbour");
		changedCode();
		marker(
			`.codereview-pass-${ME}`,
			`base=${git("rev-parse", "HEAD").trim()}\nfindings=0\npaths=scripts/mine.ts\n`,
		);

		expect(run("stop")).toBeNull();
	});

	describe("a marker whose base= follows a ledgered commit to a path this session wrote (#3099)", () => {
		const commitLedgered = (sid: string, body: string) => {
			write("scripts/mine.ts", body);
			git("add", "scripts/mine.ts");
			git("commit", "-qm", sid);
			ledgerHeadOf(sid);
		};
		const reviewedAtHead = () =>
			marker(
				`.codereview-pass-${ME}`,
				`base=${git("rev-parse", "HEAD").trim()}\nfindings=0\npaths=scripts/mine.ts\n`,
			);

		it("stays silent where the commit is a neighbour's and paths= names the path", () => {
			commitLedgered(OTHER, "export const x = 1;\n");
			changedCode();
			reviewedAtHead();

			expect(run("stop")).toBeNull();
		});

		it("fires where the commit is this session's own, naming the marker's base= as ahead of the session's start point", () => {
			record("scripts/mine.ts", ME);
			commitLedgered(ME, "export const x = 1;\n");
			changedCode();
			reviewedAtHead();

			expect(run("stop")).toContain(
				"its base= is ahead of this session's start point",
			);
		});
	});

	describe("a marker whose base= follows an unledgered commit to a path this session wrote (#3108)", () => {
		const commitMine = (body: string) => {
			write("scripts/mine.ts", body);
			git("add", "scripts/mine.ts");
			git("commit", "-qm", "unledgered");
		};
		const reviewedAtHead = () =>
			marker(
				`.codereview-pass-${ME}`,
				`base=${git("rev-parse", "HEAD").trim()}\nfindings=0\npaths=scripts/mine.ts\n`,
			);

		it("stays silent where its patch matches none of this session's commits and paths= names the path", () => {
			record("scripts/mine.ts", ME);
			commitMine("export const x = 1;\n");
			changedCode();
			reviewedAtHead();

			expect(run("stop")).toBeNull();
		});

		it("fires where it is this session's own commit rebased to a new sha", () => {
			record("scripts/mine.ts", ME);
			commitMine("export const x = 1;\n");
			ledgerHeadOf(ME);
			const before = git("rev-parse", "HEAD").trim();
			git("reset", "-q", "--hard", "HEAD~1");
			git("commit", "-q", "--allow-empty", "-m", "neighbour");
			git("cherry-pick", before);
			changedCode();
			reviewedAtHead();

			expect(run("stop")).toContain(
				"its base= is ahead of this session's start point",
			);
		});
	});

	it("rejects a marker whose base= is ahead only past a neighbour's commit and that has no paths=, naming the missing paths= line (#1840)", () => {
		git("commit", "-q", "--allow-empty", "-m", "neighbour");
		changedCode();
		marker(
			`.codereview-pass-${ME}`,
			`base=${git("rev-parse", "HEAD").trim()}\nfindings=0\n`,
		);

		expect(run("stop")).toContain("it has no paths= line");
	});

	// #1925: a staged review's marker on a session's first commit has base= at
	// the start point, so only its tree= tells it from a whole-session review.
	it("rejects a marker at the session's base= that has tree= and no paths=, naming the missing paths= line", () => {
		changedCode();
		marker(
			`.codereview-pass-${ME}`,
			`base=${readRecordedBase()}\nfindings=0\ntree=${git("write-tree").trim()}\n`,
		);

		const reason = run("stop");
		expect(reason).toContain("code-review");
		expect(reason).toContain("it has a tree= line and no paths= line");
		expect(reason).toContain("names every path its diff named in paths=");
	});

	it("stays silent for a marker at the session's base= with neither tree= nor paths=, a whole-session review", () => {
		changedCode();
		marker(
			`.codereview-pass-${ME}`,
			`base=${readRecordedBase()}\nfindings=0\n`,
		);

		expect(run("stop")).toBeNull();
	});

	it("accepts a marker whose base is older, which reviewed a superset", () => {
		const older = readRecordedBase();
		git("commit", "-q", "--allow-empty", "-m", "empty");
		fs.writeFileSync(
			path.join(markersDir(), `.concision-base-${ME}`),
			`${git("rev-parse", "HEAD").trim()}\n`,
		);
		changedCode();
		marker(`.codereview-pass-${ME}`, `base=${older}\nfindings=1\n`);

		expect(run("stop")).toBeNull();
	});

	it("rejects a marker missing its findings count, or holding a non-number, still naming code-review as owed", () => {
		changedCode();
		marker(`.codereview-pass-${ME}`, `base=${readRecordedBase()}\n`);
		expect(run("stop")).toContain("code-review");

		fs.rmSync(path.join(markersDir(), `.codereview-nagged-${ME}`));
		marker(
			`.codereview-pass-${ME}`,
			`base=${readRecordedBase()}\nfindings=some\n`,
		);
		expect(run("stop")).toContain("code-review");
	});

	it("rejects a marker naming a commit this repo does not have", () => {
		changedCode();
		marker(
			`.codereview-pass-${ME}`,
			"base=0000000000000000000000000000000000000000\nfindings=2\n",
		);

		expect(run("stop")).toContain("code-review");
	});

	it("rejects a branch name, which would resolve to wherever it later moved", () => {
		// The skills are handed "a commit SHA, branch name, tag, main, HEAD~5" as a
		// legal fixed point, so base=main is a plausible thing to be written.
		changedCode();
		marker(`.codereview-pass-${ME}`, "base=main\nfindings=0\n");

		expect(run("stop")).toContain("code-review");
	});

	it("rejects a marker it cannot read at all, still naming code-review as owed", () => {
		changedCode();
		marker(
			`.codereview-pass-${ME}`,
			`base=${readRecordedBase()}\nfindings=1\n`,
		);
		fs.chmodSync(path.join(markersDir(), `.codereview-pass-${ME}`), 0o000);

		expect(run("stop")).toContain("code-review");
	});

	it("applies the same test to the prose marker", () => {
		write("docs/mine.md", PARAGRAPH);
		record("docs/mine.md", ME);
		marker(`.concision-pass-${ME}`, "");
		expect(run("stop")).toContain("concision-pass");

		fs.rmSync(path.join(markersDir(), `.concision-nagged-${ME}`));
		marker(`.concision-pass-${ME}`, `base=${readRecordedBase()}\nfindings=4\n`);
		expect(run("stop")).toBeNull();
	});

	it("rejects the baseline file path the roadmap route compares against, still naming concision-pass as owed", () => {
		// mantahostels#334: `roadmap-edit` diffs card word counts against
		// `.roadmap-baseline-<sid>.html`, so that path is what a caller has to
		// hand. The marker takes the session's start sha instead.
		write("docs/mine.md", PARAGRAPH);
		record("docs/mine.md", ME);
		marker(
			`.concision-pass-${ME}`,
			"base=.roadmap-baseline-abc.html\nfindings=0\n",
		);

		expect(run("stop")).toContain("concision-pass");
	});

	it("names a malformed findings= rather than reporting no pass at all", () => {
		// mantahostels#402 — the ticket for a nag that said no pass had run when one had.
		changedCode();
		marker(
			`.codereview-pass-${ME}`,
			`base=${readRecordedBase()}\nfindings=2 cuts applied (process-history clause)\n`,
		);

		const reason = run("stop");
		expect(reason).toContain(`.codereview-pass-${ME}`);
		expect(reason).toContain("rejected");
		expect(reason).toContain("not a number");
		// Quoted as the session typed it: the value the validator compares is
		// whitespace-stripped.
		expect(reason).toContain("2 cuts applied");
	});

	it("names a malformed base= the same way", () => {
		changedCode();
		marker(`.codereview-pass-${ME}`, "base=main\nfindings=0\n");

		const reason = run("stop");
		expect(reason).toContain("rejected");
		expect(reason).toContain("40-hex");
	});

	it("says nothing about a rejected marker when there is no marker", () => {
		changedCode();

		expect(run("stop")).not.toContain("rejected");
	});

	it("names a rejected prose marker too", () => {
		write("docs/mine.md", PARAGRAPH);
		record("docs/mine.md", ME);
		marker(
			`.concision-pass-${ME}`,
			`base=${readRecordedBase()}\nfindings=one\n`,
		);

		const reason = run("stop");
		expect(reason).toContain(`.concision-pass-${ME}`);
		expect(reason).toContain("not a number");
	});

	it("truncates the offending value, which may be a whole paragraph", () => {
		changedCode();
		marker(
			`.codereview-pass-${ME}`,
			`base=${readRecordedBase()}\nfindings=${"x".repeat(500)}\n`,
		);

		const reason = run("stop") ?? "";
		expect(reason).toContain("not a number");
		expect(reason).not.toContain("x".repeat(60));
	});

	it("tells the session the marker command, with the base to pass", () => {
		// The reason string is where a session learns the command, so a silent
		// change would leave every session recording against the wrong base.
		changedCode();

		const reason = run("stop");
		expect(reason).toContain(
			`node scripts/write-review-marker.js --base ${readRecordedBase()} --findings `,
		);
	});
});
