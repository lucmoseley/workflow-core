// @vitest-environment node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAgentsBranch, buildJobRow } from "./lib/agents-stop-fake";
import { writeClaudeStub } from "./lib/claude-stub";
import {
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
	stopIn,
	storePath,
	template,
	write,
} from "./lib/concision-backstop-testkit";
import { cutWorktree, mkDirOutsideRepo, mkScratchDir } from "./lib/git-fixture";
import { readGuardErrorsLog } from "./lib/guard-errors-log";
import { installLib } from "./lib/lib-install-testkit";
import { runInProcess } from "./lib/run-in-process.js";

backstopFixture();

describe("the session's own worktree (#4243)", () => {
	it("reads the payload's worktree, not the main checkout the hook runs from (#4271)", () => {
		const wt = cutWorktree(repo);
		fs.mkdirSync(path.join(wt, "docs"));
		fs.writeFileSync(path.join(wt, "docs", "mine.md"), PARAGRAPH);
		record("docs/mine.md", ME, wt);
		expect(stopIn(wt, repo)).toContain("docs/mine.md");
	});

	it("logs its fail-open where git names no session tree (#4271)", () => {
		const outside = mkDirOutsideRepo("backstop-outside-");
		try {
			expect(stopIn(outside, repo)).toBeNull();
			expect(readGuardErrorsLog(cfg)).toContain(
				`git named no session tree for ${outside}`,
			);
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it("demands the pass for prose this session wrote in its worktree", () => {
		const wt = cutWorktree(repo);
		fs.mkdirSync(path.join(wt, "docs"));
		fs.writeFileSync(path.join(wt, "docs", "mine.md"), PARAGRAPH);
		record("docs/mine.md", ME, wt);
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
		write("docs/theirs.md", PARAGRAPH);
		git("add", "docs/theirs.md");
		git("commit", "-qm", "parallel session's prose");
		write("scripts/theirs.ts", "export const x = 1;\n");
		record("docs/theirs.md", OTHER);
		record("scripts/theirs.ts", OTHER);

		expect(run("stop")).toBeNull();
	});

	it("bills a parallel session's committed prose to nobody", () => {
		write("docs/theirs.md", PARAGRAPH);
		git("add", "docs/theirs.md");
		git("commit", "-qm", "theirs");
		record("docs/theirs.md", OTHER);
		write("docs/mine.md", "three short words\n");
		record("docs/mine.md", ME);

		expect(run("stop")).toBeNull();
	});

	it("bills a parallel session's untracked code to nobody", () => {
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
		const readInjected = () => {
			const opener =
				"You invoked /code-review, whose vendored skill file cannot carry project rules. ";
			const ctx = JSON.parse(
				runInProcess(INJECTOR, [], {
					cwd: repo,
					stdin: JSON.stringify({
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
				}).stdout,
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
		write("docs/theirs.md", `${PARAGRAPH}${PARAGRAPH}${PARAGRAPH}`);
		record("docs/theirs.md", OTHER);
		write("docs/mine.md", PARAGRAPH);
		record("docs/mine.md", ME);

		const reason = run("stop");
		expect(reason).toContain("docs/mine.md");
		expect(reason).not.toContain("docs/theirs.md");
		expect(reason).toMatch(/roughly 6\d net words/);
	});

	it("matches ledger paths whole, so a prefix cannot borrow the credit", () => {
		write("docs/mine.md", "short\n");
		record("docs/mine.md", ME);
		write("docs/mine.md.bak", PARAGRAPH);

		expect(run("stop")).toBeNull();
	});

	it("bills a non-ASCII path, which git would otherwise render escaped", () => {
		write("docs/café.md", PARAGRAPH);
		record("docs/café.md", ME);

		expect(run("stop")).toContain("café");
	});

	it("bills nothing for a file changed only in the tree, never by a tool", () => {
		write("docs/generated.md", PARAGRAPH);

		expect(run("stop")).toBeNull();
	});

	it("bills nothing when the ledger cannot be read at all", () => {
		write("docs/mine.md", PARAGRAPH);
		record("docs/mine.md", ME);
		fs.chmodSync(ledgerFor(ME), 0o000);

		expect(run("stop")).toBeNull();
	});
});

describe("baseline validity", () => {
	it("diffs against the merge base when the recorded base is off the branch", () => {
		const root = git("rev-parse", "HEAD").trim();
		write("docs/mine.md", PARAGRAPH);
		git("add", "docs/mine.md");
		git("commit", "-qm", "later rewritten off the branch");
		const orphan = git("rev-parse", "HEAD").trim();
		git("branch", "keep-alive");
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
