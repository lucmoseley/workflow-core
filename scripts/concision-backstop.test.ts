// @vitest-environment node
/*
 * Pins that the Stop backstop bills a concision pass or code review only for
 * work this session wrote, in its own tree, against a valid base. The
 * marker, floor and sensitive-tier cases sit in the -markers, -floor and
 * -sensitive files, split so no file runs past the per-file limit (#4308).
 *
 * concision-backstop.sh fires at Stop against a diff of a REPO-GLOBAL working
 * tree, so its whole correctness question is whose work it is looking at (mantahostels#114).
 *
 * Every regression case is paired with a positive case proving the signal still
 * fires for the session that did the work.
 *
 * Two sessions are simulated by writing to the same throwaway repo under two
 * different session ids, only one of which has a ledger entry.
 *
 * Numbered instances below ("Instances 4 and 5") are the six documented misfires
 * on mantahostels#96's evidence base — mantahostels#96 is the parallel-session safety map.
 *
 * Loosen a case and the hook tells a session to edit files a live neighbour is
 * still writing, or lets prose and code end a session with no quality pass.
 *
 * Over base §X8 (5)'s 10 s budget: each case spawns the hook for real, 0.3-0.5 s
 * a run (#4308's profile), and the logic under test is bash with no in-process seam.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAgentsBranch, buildJobRow } from "./lib/agents-stop-fake";
import { writeClaudeStub } from "./lib/claude-stub";
import {
	BACKSTOP,
	BIG_CODE,
	backstopFixture,
	cfg,
	dir,
	env,
	git,
	gitAt,
	INJECTOR,
	ledgerFor,
	ledgerHeadOf,
	ME,
	markersDir,
	OTHER,
	PARAGRAPH,
	record,
	repo,
	run,
	spawnBackstop,
	storePath,
	template,
	write,
} from "./lib/concision-backstop-testkit";
import { cutWorktree, mkScratchDir } from "./lib/git-fixture";
import { readGuardErrorsLog } from "./lib/guard-errors-log";
import { installLib } from "./lib/lib-install-testkit";

backstopFixture();

describe("the session's own worktree (#4243)", () => {
	const stopIn = (cwd: string) => {
		const r = spawnSync(BACKSTOP, ["stop"], {
			cwd,
			encoding: "utf8",
			input: JSON.stringify({ session_id: ME, cwd }),
			env: env(),
		});
		return r.stdout?.trim() ? (JSON.parse(r.stdout).reason as string) : null;
	};

	it("demands the pass for prose this session wrote in its worktree", () => {
		const wt = cutWorktree(repo);
		fs.mkdirSync(path.join(wt, "docs"));
		fs.writeFileSync(path.join(wt, "docs", "mine.md"), PARAGRAPH);
		record(path.join(wt, "docs", "mine.md"), ME);
		const reason = stopIn(wt);
		expect(reason).toContain("concision-pass");
		expect(reason).toContain("docs/mine.md");
	});

	it("bills nothing from the main checkout's prose to a session in its worktree", () => {
		const wt = cutWorktree(repo);
		write("docs/mine.md", PARAGRAPH);
		record("docs/mine.md", ME);
		expect(stopIn(wt)).toBeNull();
	});
});

describe("attribution — the mantahostels#114 regression", () => {
	it("bills nothing to a session that wrote nothing, however busy the tree", () => {
		// Instances 3 and 6: a session whose only actions were reads.
		write("docs/theirs.md", PARAGRAPH);
		git("add", "docs/theirs.md");
		git("commit", "-qm", "parallel session's prose");
		write("scripts/theirs.ts", "export const x = 1;\n");
		record("docs/theirs.md", OTHER);
		record("scripts/theirs.ts", OTHER);

		expect(run("stop")).toBeNull();
	});

	it("bills a parallel session's committed prose to nobody", () => {
		// Instance 2: prose committed minutes earlier by the session working mantahostels#100,
		// which had already run its own pass, demanded again of the mantahostels#101 session.
		write("docs/theirs.md", PARAGRAPH);
		git("add", "docs/theirs.md");
		git("commit", "-qm", "theirs");
		record("docs/theirs.md", OTHER);
		// This session did write something, so it is not excused by the empty-ledger
		// shortcut — the filter itself has to do the work.
		write("docs/mine.md", "three short words\n");
		record("docs/mine.md", ME);

		expect(run("stop")).toBeNull();
	});

	it("bills a parallel session's untracked code to nobody", () => {
		// Instances 4 and 5: scripts/proving-run.ts, untracked in-flight work of the
		// mantahostels#107 session, charged to mantahostels#104, mantahostels#105 and mantahostels#106 in turn.
		write("scripts/proving-run.ts", "export const harness = 1;\n");
		record("scripts/proving-run.ts", OTHER);
		write("docs/mine.md", "mine\n");
		record("docs/mine.md", ME);

		expect(run("stop")).toBeNull();
	});

	it("still demands a concision pass for prose this session wrote", () => {
		write("docs/mine.md", PARAGRAPH);
		record("docs/mine.md", ME);

		const reason = run("stop");
		expect(reason).toContain("concision-pass");
		expect(reason).toContain("docs/mine.md");
	});

	/*
	 * mantahostels#1011 — the nag is the only route to the standards files for a
	 * session that ran neither /code-review nor /implement, so
	 * inject-tracker-docs.sh never reached it. Asserted here rather than by
	 * grepping this hook's source from the injector's suite: the text surviving
	 * in a comment while dropping out of the emitted nag is exactly the
	 * regression, and only running the hook can tell the two apart (§X3).
	 */
	describe("the standards base and local file (#965)", () => {
		const core = () => path.join(dir, "core");
		const basePath = () => path.join(core(), "docs", "code-standards-base.md");
		const withBase = () => {
			fs.mkdirSync(path.dirname(basePath()), { recursive: true });
			fs.writeFileSync(basePath(), "base\n");
		};
		const nag = () => {
			write("scripts/mine.ts", `${BIG_CODE}\n`);
			record("scripts/mine.ts", ME);
			return run("stop", ME, { WFC_SCRIPT_ROOT: core() }) as string;
		};
		const readLog = () => readGuardErrorsLog(cfg);
		/*
		 * #2097: inject-tracker-docs.sh hands a typed /code-review the same
		 * Standards-axis text, which each case below pins this hook's to. Run
		 * after nag(), under another session id, so its markers decide nothing.
		 */
		const readInjected = () => {
			const opener =
				"You invoked /code-review, whose vendored skill file cannot carry project rules. ";
			const ctx = JSON.parse(
				execFileSync(INJECTOR, {
					cwd: repo,
					encoding: "utf8",
					input: JSON.stringify({
						prompt: "/code-review",
						hook_event_name: "UserPromptSubmit",
						session_id: "injector-twin",
					}),
					env: {
						...env(),
						WFC_SCRIPT_ROOT: core(),
						CLAUDE_JOB_DIR: "",
						WFC_GH: "false",
						WFC_REVIEW_TIER_HOOK: path.join(dir, "no-tier-hook"),
					},
				}),
			).hookSpecificOutput.additionalContext as string;
			const at = ctx.indexOf(opener) + opener.length;
			return ctx.slice(at, ctx.indexOf(" Reviewer type", at));
		};
		const expectInjectorText = (reason: string) =>
			expect(reason).toContain(`${readInjected()} Then run the concision-pass`);

		it("both present: hands over both paths", () => {
			withBase();
			write("docs/code-standards.md", "standards\n");
			const reason = nag();
			expectInjectorText(reason);
			expect(reason).toContain(
				`Hand the Standards axis, in its prompt, base \`${basePath()}\` and local \`docs/code-standards.md\`.`,
			);
			expect(reason).toContain('"§X2 (base), excepted by local row 2"');
			// A local file still on the old heading keeps its smells unraised
			// (mantahostels#994).
			expect(reason).toContain('"Smells not raised" (or "Suppressions")');
			expect(reason).toContain("`Base unreadable: <path>`");
			expect(readLog()).not.toContain("standards base absent");
		});

		it("base only: hands over the base and says it applies unchanged", () => {
			withBase();
			const reason = nag();
			expectInjectorText(reason);
			expect(reason).toContain(
				`Hand the Standards axis the base \`${basePath()}\``,
			);
			expect(reason).toContain(
				"`No local standards file: the base applies unchanged.`",
			);
			expect(readLog()).not.toContain("standards base absent");
		});

		it("local only: hands over the local file, names the absent base and logs it", () => {
			write("docs/code-standards.md", "standards\n");
			const reason = nag();
			expectInjectorText(reason);
			expect(reason).toContain(
				"hand the Standards axis only the local `docs/code-standards.md`",
			);
			expect(reason).toContain(
				`\`No standards base: ${basePath()} is absent.\``,
			);
			expect(reason).not.toContain("Hand the Standards axis the base");
			expect(readLog()).toContain("standards base absent");
			expect(readLog()).toContain(basePath());
		});

		it("neither: hands over neither path and names both missing", () => {
			const reason = nag();
			expectInjectorText(reason);
			expect(reason).toContain("hand the Standards axis neither.");
			expect(reason).toContain(
				`\`No standards base or local file: ${basePath()} and docs/code-standards.md are absent.\``,
			);
			// #886's line, which this replaces.
			expect(reason).not.toContain("No standards file:");
			expect(readLog()).toContain("standards base absent");
		});

		it("names the host's GLOSSARY.md for base §G8 where it exists (#1373)", () => {
			withBase();
			write("GLOSSARY.md", "# Glossary\n");
			const reason = nag();
			expect(reason).toContain(
				"Hand the Standards axis `GLOSSARY.md` too, for base §G8.",
			);
			expectInjectorText(reason);
		});

		it("names no glossary where the host has none (#1373)", () => {
			withBase();
			expect(nag()).not.toContain("GLOSSARY.md");
		});

		/*
		 * #2096: an adopter's install with review-standards.sh unsourceable, so
		 * the base falls to the default. Each file is linked one by one so the
		 * directories stay real and doc_path resolves to the install.
		 */
		it("spells the default base at the install root when review-standards.sh cannot be sourced (#2096)", () => {
			const install = path.join(dir, "install");
			fs.mkdirSync(path.join(install, "scripts", "lib"), { recursive: true });
			for (const f of ["concision-backstop.sh", "session-arbiter.js"])
				fs.symlinkSync(
					path.join(__dirname, f),
					path.join(install, "scripts", f),
				);
			installLib(path.join(install, "scripts", "lib"), {
				keep: (f) => f !== "review-standards.sh",
				link: true,
			});
			write("scripts/mine.ts", `${BIG_CODE}\n`);
			record("scripts/mine.ts", ME);
			const r = spawnBackstop(
				"stop",
				ME,
				{},
				path.join(install, "scripts", "concision-backstop.sh"),
			);
			const reason = JSON.parse(r.stdout).reason as string;
			expect(reason).toContain(
				`base \`${install}/docs/code-standards-base.md\``,
			);
		});

		it("logs nothing at a Stop that does not nag", () => {
			run("stop", ME, { WFC_SCRIPT_ROOT: core() });
			expect(readLog()).not.toContain("standards base absent");
		});
	});

	it("still demands a review for code this session wrote", () => {
		write("scripts/mine.ts", `${BIG_CODE}\n`);
		record("scripts/mine.ts", ME);

		const reason = run("stop");
		expect(reason).toContain("code-review");
		expect(reason).toContain("scripts/mine.ts");
	});

	/*
	 * #2390: an edit through an inline interpreter (`python3 - <<EOF`) leaves no
	 * write-ledger line, so the commit ledger is the session's only record of
	 * the code.
	 */
	describe("code committed with no write-ledger line (#2390)", () => {
		const commitCode = (sid: string) => {
			write("scripts/mine.ts", `${BIG_CODE}\n`);
			git("add", "scripts/mine.ts");
			git("commit", "-qm", "inline-interpreter edit");
			ledgerHeadOf(sid);
		};

		it("demands a review for code this session's own commit carries", () => {
			commitCode(ME);

			const reason = run("stop");
			expect(reason).toContain("code-review");
			expect(reason).toContain("scripts/mine.ts");
		});

		it("bills a neighbour's committed code to nobody", () => {
			commitCode(OTHER);

			expect(run("stop")).toBeNull();
		});

		it.skipIf(process.getuid?.() === 0)(
			"bills the writes alone where the commit ledger will not read",
			() => {
				commitCode(ME);
				write("docs/mine.md", PARAGRAPH);
				record("docs/mine.md", ME);
				fs.chmodSync(
					storePath((s) => s.paths.commitLedger(ME)),
					0o000,
				);

				const reason = run("stop");
				expect(reason).toContain("docs/mine.md");
				expect(reason).not.toContain("scripts/mine.ts");
			},
		);
	});

	it("counts only its own words when both sessions wrote prose", () => {
		// The sharp case: a naive filter that fires whenever ANY attributed file
		// changed would report the parallel session's word count alongside its own.
		write("docs/theirs.md", `${PARAGRAPH}${PARAGRAPH}${PARAGRAPH}`);
		record("docs/theirs.md", OTHER);
		write("docs/mine.md", PARAGRAPH);
		record("docs/mine.md", ME);

		const reason = run("stop");
		expect(reason).toContain("docs/mine.md");
		expect(reason).not.toContain("docs/theirs.md");
		// 60 words of its own, not 240 of everyone's.
		expect(reason).toMatch(/roughly 6\d net words/);
	});

	it("matches ledger paths whole, so a prefix cannot borrow the credit", () => {
		// -F -x, not a substring search: "docs/mine.md" must not vouch for
		// "docs/mine.md.bak", which is a different file and someone else's work.
		write("docs/mine.md", "short\n");
		record("docs/mine.md", ME);
		write("docs/mine.md.bak", PARAGRAPH);

		expect(run("stop")).toBeNull();
	});

	it("bills a non-ASCII path, which git would otherwise render escaped", () => {
		// git renders "docs/café.md" as "docs/caf\303\251.md" under its default
		// core.quotePath, while the ledger holds the path raw — so a whole-line
		// match never fires and the file goes silently unbilled.
		write("docs/café.md", PARAGRAPH);
		record("docs/café.md", ME);

		expect(run("stop")).toContain("café");
	});

	it("bills nothing for a file changed only in the tree, never by a tool", () => {
		write("docs/generated.md", PARAGRAPH);

		expect(run("stop")).toBeNull();
	});

	it("bills nothing when the ledger cannot be read at all", () => {
		// mantahostels#137 (the ticket that made this hook read the exit status). `writes`
		// exits non-zero for "attribution unavailable", a different fact from
		// "wrote nothing" (mantahostels#135) — but it lands in the same place here on purpose:
		// with no ledger to intersect, every candidate path is unattributable, and
		// mantahostels#114 bills those to nobody rather than to whichever session stops next.
		// So this test passes against the pre-mantahostels#137 script too, and no mutation can
		// make it fail: reading the status changes what the hook MEANS, not what it
		// does, since a failed read also leaves `$mine` empty. It pins the contract
		// against a future `writes` that prints before it fails.
		write("docs/mine.md", PARAGRAPH);
		record("docs/mine.md", ME);
		fs.chmodSync(ledgerFor(ME), 0o000);

		expect(run("stop")).toBeNull();
	});
});

describe("baseline validity", () => {
	it("diffs against the merge base when the recorded base is off the branch", () => {
		// The second defect: after a parallel session rebases main, the recorded
		// commit still EXISTS as an object — cat-file -e passes, which was the only
		// test — but is no longer an ancestor of HEAD, so the range is measured
		// against content that was rewritten off the branch.
		//
		// The orphaned base already holds the paragraph, so a diff against it sees
		// no prose added at all, while the branch this session is really on has
		// never had it.
		const root = git("rev-parse", "HEAD").trim();
		write("docs/mine.md", PARAGRAPH);
		git("add", "docs/mine.md");
		git("commit", "-qm", "later rewritten off the branch");
		const orphan = git("rev-parse", "HEAD").trim();
		git("branch", "keep-alive"); // keeps the object reachable, so cat-file -e passes
		git("reset", "-q", "--hard", root);
		fs.writeFileSync(
			path.join(markersDir(), `.concision-base-${ME}`),
			`${orphan}\n`,
		);

		expect(
			spawnSync("git", ["cat-file", "-e", `${orphan}^{commit}`], { cwd: repo })
				.status,
		).toBe(0);
		expect(
			spawnSync("git", ["merge-base", "--is-ancestor", orphan, "HEAD"], {
				cwd: repo,
			}).status,
		).not.toBe(0);

		write("docs/mine.md", PARAGRAPH);
		record("docs/mine.md", ME);

		expect(run("stop")).toContain("docs/mine.md");
	});
});

/*
 * mantahostels#2076's own acceptance criterion, migrating onto scripts/lib/git-fixture.ts
 * (mantahostels#2068): a write made in an instantiated copy must not reach a second,
 * independent instantiation of the same template. The helper's own
 * leak-checked instantiate() already throws before any test body runs were a
 * copy still pointing at the template (proven in git-fixture.test.ts) — what
 * is left to assert here is the BEHAVIOURAL isolation a leak would cause.
 */
describe("the copied fixture is isolated from its template (mantahostels#2068, mantahostels#2076)", () => {
	const freshCopy = () => {
		const fresh = mkScratchDir("backstop-fresh-");
		template.instantiate(fresh);
		return fresh;
	};

	it("a commit made in the copy leaves the template untouched", () => {
		write("b.md", "b\n");
		git("add", "b.md");
		git("commit", "-qm", "only in the copy", "--", "b.md");
		expect(git("log", "--oneline")).toContain("only in the copy");

		const fresh = freshCopy();
		try {
			expect(gitAt(path.join(fresh, "repo"), "log", "--oneline")).not.toContain(
				"only in the copy",
			);
		} finally {
			fs.rmSync(fresh, { recursive: true, force: true });
		}
	});
});

describe("a copy a refill-loop resume started under a new id (#4105)", () => {
	afterEach(() => vi.unstubAllEnvs());

	const passFinishedByPastId = () =>
		fs.writeFileSync(
			path.join(markersDir(), `.concision-pass-${ME}`),
			`base=${git("rev-parse", "HEAD").trim()}\nfindings=1\n`,
		);
	const stopCopyAfterProse = () => {
		run("start", OTHER);
		write("docs/mine.md", PARAGRAPH);
		record("docs/mine.md", OTHER);
		return run("stop", OTHER);
	};

	it("owes the pass where the marker stayed under the past id", () => {
		passFinishedByPastId();
		expect(stopCopyAfterProse()).toContain("has not run a concision pass");
	});

	it("owes no concision pass its past id finished, the markers moved at the resume", () => {
		passFinishedByPastId();
		const bin = path.join(dir, "claude-agents");
		writeClaudeStub(bin, [
			buildAgentsBranch([buildJobRow("copy", "working", { sessionId: OTHER })]),
		]);
		vi.stubEnv("WFC_CLAUDE_BIN", bin);
		vi.stubEnv("CLAUDE_CODE_SESSION_ID", "");
		const left = createRequire(__filename)(
			"./lib/move-pass-markers.js",
		).movePassMarkers(repo, ME, OTHER);
		expect(left).toBeNull();
		expect(stopCopyAfterProse()).toBeNull();
	});
});
