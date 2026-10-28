// @vitest-environment node
/*
 * Pins that the Stop backstop bills a concision pass or code review only for
 * work this session wrote, against a valid base, and accepts only a pass
 * marker that covers the range changed.
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
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineTemplate, mkScratchDir } from "./lib/git-fixture";
import { readGuardErrorsLog } from "./lib/guard-errors-log";
import { installLib } from "./lib/lib-install-testkit";

const BACKSTOP = path.resolve(__dirname, "concision-backstop.sh");
const ARBITER = path.resolve(__dirname, "session-arbiter.js");
const INJECTOR = path.resolve(__dirname, "inject-tracker-docs.sh");

const ME = "session-under-test";
const OTHER = "parallel-session";

/* A function, not a hoisted const: `repo` is reassigned per test. */
const markersDir = () => path.join(repo, ".claude", "tmp", "markers");

let dir: string;
let repo: string;
let cfg: string;

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" });

const env = () => ({
	...process.env,
	CLAUDE_PROJECT_DIR: repo,
	CLAUDE_CONFIG_DIR: cfg,
	// The /implement marker the backstop reads lives under TMPDIR, so it is
	// pointed at this test's scratch directory — otherwise a real session's
	// marker in the host's /tmp could decide the outcome.
	TMPDIR: dir,
});

/**
 * Reserve the marker inject-tracker-docs.sh writes when `/implement` fires, at
 * the path and with the sanitising the backstop reads back.
 */
const implementRan = (sid = ME) => {
	const d = path.join(dir, `wfc-tracker-inject-${process.getuid?.() ?? 0}`);
	fs.mkdirSync(d, { recursive: true });
	fs.writeFileSync(
		path.join(d, `${sid.replace(/[^A-Za-z0-9_-]/g, "_")}.implement`),
		"",
	);
};

/**
 * A path in this repo's arbiter store — asked of the arbiter rather than
 * rebuilt, so a change to its slugging cannot leave the test chmodding or
 * reading a path nothing writes.
 */
// biome-ignore lint/suspicious/noExplicitAny: the store is untyped CommonJS.
const storePath = (pick: (store: any) => string) => {
	const saved = { ...process.env };
	Object.assign(process.env, {
		CLAUDE_PROJECT_DIR: repo,
		CLAUDE_CONFIG_DIR: cfg,
	});
	try {
		// The store, not the CLI: session-arbiter.js exports nothing (mantahostels#158),
		// and requiring it would run a subcommand and exit this process.
		return pick(createRequire(__filename)("./lib/arbiter-store.js"));
	} finally {
		process.env = saved;
	}
};

const ledgerFor = (sid: string) => storePath((s) => s.paths.ledger(sid));

/** Note in the ledger that `sid` wrote `rel` — what PostToolUse does for real. */
const record = (rel: string, sid: string) =>
	execFileSync("node", [ARBITER, "record", rel, sid], { env: env() });

/** Note HEAD in `sid`'s commit ledger — what post-commit does for real. */
const ledgerHead = (sid: string) =>
	execFileSync(
		"node",
		[ARBITER, "record-commit", git("rev-parse", "HEAD").trim()],
		{
			env: { ...env(), CLAUDE_CODE_SESSION_ID: sid },
		},
	);

const write = (rel: string, body: string) => {
	fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
	fs.writeFileSync(path.join(repo, rel), body);
};

const gitAt = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

/*
 * THE FIXTURE IS BUILT ONCE AND COPIED, via scripts/lib/git-fixture.ts (mantahostels#2068),
 * rather than rebuilt per test. One template, not mantahostels#2048's pre-built
 * variants: the git calls left per test are ones the test bodies make, not
 * repo construction (mantahostels#2076).
 */
const buildTemplate = (root: string) => {
	const repoDir = path.join(root, "repo");
	fs.mkdirSync(repoDir, { recursive: true });
	gitAt(repoDir, "init", "-q", "-b", "main", ".");
	gitAt(repoDir, "config", "user.email", "test@example.com");
	gitAt(repoDir, "config", "user.name", "test");
	// core.hooksPath is absolute in this checkout, so a scratch repo would
	// otherwise run the real Husky gates (mantahostels#100's finding). relink() rewrites
	// this template-relative path in .git/config on every instantiate() call.
	gitAt(repoDir, "config", "core.hooksPath", path.join(root, "no-hooks"));
	fs.writeFileSync(path.join(repoDir, "seed.md"), "seed\n");
	gitAt(repoDir, "add", "seed.md");
	gitAt(repoDir, "commit", "-qm", "init");
};

const template = defineTemplate(buildTemplate);

/** Runs the hook in `mode`, as Claude Code would, returning the whole result. */
const spawnBackstop = (
	mode: "start" | "stop",
	sid = ME,
	extra: Record<string, string> = {},
	script = BACKSTOP,
) => {
	const r = spawnSync(script, [mode], {
		cwd: repo,
		encoding: "utf8",
		input: JSON.stringify({ session_id: sid }),
		env: { ...env(), ...extra },
	});
	if (r.status === null) throw new Error(`backstop did not run: ${r.error}`);
	return r;
};

/** Runs the hook in `mode`, as Claude Code would, returning its block reason. */
const run = (
	mode: "start" | "stop",
	sid = ME,
	extra: Record<string, string> = {},
) => {
	const r = spawnBackstop(mode, sid, extra);
	if (!r.stdout?.trim()) return null;
	return JSON.parse(r.stdout).reason as string;
};

/** 60 words — comfortably over the script's THRESHOLD of 50. */
const PARAGRAPH = `${Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ")}\n`;

/** A code change big enough to clear CODE_THRESHOLD, the churn gate at mantahostels#1071. */
const BIG_CODE = Array.from(
	{ length: 30 },
	(_, i) => `export const x${i} = ${i};`,
).join("\n");

beforeEach(() => {
	// realpath: the repo root the arbiter derives comes from `git rev-parse`,
	// which resolves symlinks, so an unresolved tmpdir would slug to a different
	// project directory and the ledger would be written where nothing reads it.
	dir = mkScratchDir("backstop-");
	repo = path.join(dir, "repo");
	cfg = path.join(dir, "config");
	template.instantiate(dir);
	run("start");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

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
			ledgerHead(sid);
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
			ledgerHead(sid);
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
			ledgerHead(ME);
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

/*
 * mantahostels#2769: /implement's injected closing steps make the two-axis review mandatory
 * at any diff size, so the churn floor that prices a review against its ~2M
 * tokens (mantahostels#1071) is the wrong question for those sessions.
 */
describe("the /implement floor — mantahostels#2769", () => {
	/** A code change far below CODE_THRESHOLD, attributed to this session. */
	const tinyCode = (sid = ME) => {
		write("scripts/tiny.ts", "export const x = 1;\n");
		record("scripts/tiny.ts", sid);
	};

	it("nags a tiny code change when this session ran /implement", () => {
		implementRan();
		tinyCode();

		const reason = run("stop") ?? "";
		expect(reason).toContain("code-review");
		expect(reason).toContain("(mantahostels#2769)");
	});

	it("leaves a session that never ran /implement on the 20-line floor", () => {
		tinyCode();

		expect(run("stop")).toBeNull();
	});

	// Keyed to the session, not the machine: a parallel session's /implement
	// must not lower this one's floor.
	it("reads only its own session's marker", () => {
		implementRan(OTHER);
		tinyCode();

		expect(run("stop")).toBeNull();
	});

	// Below the floor is the only case the marker changes; above it the nag
	// fires either way, and says nothing about /implement when none ran.
	it("still nags a large change, without claiming /implement ran", () => {
		write("scripts/mine.ts", `${BIG_CODE}\n`);
		record("scripts/mine.ts", ME);

		const reason = run("stop") ?? "";
		expect(reason).toContain("code-review");
		expect(reason).not.toContain("(#2769)");
	});

	// The prose signal has its own threshold, which mantahostels#2769 did not touch.
	it("does not lower the prose threshold", () => {
		implementRan();
		write("docs/mine.md", "three short words\n");
		record("docs/mine.md", ME);

		expect(run("stop")).toBeNull();
	});

	// The marker path is a contract between two scripts, and a session's floor
	// silently returns to 20 if they drift. Pinned by running the injector for
	// real rather than by matching its source.
	it("reads the marker inject-tracker-docs.sh actually writes", () => {
		// A sid the sanitiser actually changes, so a drift between the two
		// spellings of it fails here rather than passing on a plain uuid.
		// Dots, not a slash: the base and nag marker filenames use the sid RAW,
		// so a slash makes them unwritable paths and the backstop exits silent.
		const sid = "sid.with.dots";
		const injected = spawnSync(
			path.resolve(__dirname, "inject-tracker-docs.sh"),
			{
				encoding: "utf8",
				input: JSON.stringify({
					session_id: sid,
					hook_event_name: "UserPromptSubmit",
					prompt: "/implement 2769",
				}),
				// Its `takes:` read (#1164) stays off the network.
				env: { ...env(), WFC_GH: "false" },
			},
		);
		// The injector reserves the marker only once it has text to emit, and
		// exits 0 silently on a missing jq or a dedupe hit — so an unasserted
		// run would leave a drift to fail below, blaming the backstop.
		expect(injected.status).toBe(0);
		expect(injected.stdout).not.toBe("");

		run("start", sid);
		tinyCode(sid);

		expect(run("stop", sid)).toContain("(mantahostels#2769)");
	});

	// The floor is the only thing mantahostels#2769 moved: a review that ran still clears
	// the signal, and pass_valid gates ahead of the threshold either way.
	it("stays silent when a valid review marker already covers the change", () => {
		implementRan();
		tinyCode();
		const base = fs
			.readFileSync(path.join(markersDir(), `.concision-base-${ME}`), "utf8")
			.trim();
		fs.writeFileSync(
			path.join(markersDir(), `.codereview-pass-${ME}`),
			`base=${base}\nfindings=0\n`,
		);

		expect(run("stop")).toBeNull();
	});

	// A changed file can report zero churn — a mode-only chmod — and mantahostels#2769
	// asked for "any tracked code-file change (however small)".
	it("nags a mode-only change, which reports no churn at all", () => {
		write("scripts/moded.sh", "echo hi\n");
		git("add", "scripts/moded.sh");
		git("commit", "-qm", "a script to chmod", "--", "scripts/moded.sh");
		// Re-record the base ON that commit, or the diff carries the file's
		// whole body and the case is no longer a zero-churn one.
		fs.rmSync(path.join(markersDir(), `.concision-base-${ME}`));
		run("start");
		fs.chmodSync(path.join(repo, "scripts/moded.sh"), 0o755);
		record("scripts/moded.sh", ME);
		implementRan();

		expect(run("stop")).toContain("(mantahostels#2769)");
	});

	it("stays silent when this session changed no code at all", () => {
		implementRan();
		write("docs/mine.md", "one\n");
		record("docs/mine.md", ME);

		expect(run("stop")).toBeNull();
	});
});

/*
 * mantahostels#1143 reverted mantahostels#1097: the pass this nag demands runs in the session that
 * wrote the prose, and mantahostels#1099's marker line recording the route survives it. The
 * nag string is the only place a session learns the instruction or the route to
 * write, so both are pinned here.
 */
describe("the pass runs in this session — mantahostels#1143, mantahostels#1099", () => {
	/** The base the hook recorded at SessionStart, which markers must match. */
	const readRecordedBase = () =>
		fs
			.readFileSync(path.join(markersDir(), `.concision-base-${ME}`), "utf8")
			.trim();

	/** Writes a pass marker as a session's step 6 would. */
	const marker = (name: string, body: string) => {
		fs.mkdirSync(markersDir(), { recursive: true });
		fs.writeFileSync(path.join(markersDir(), name), body);
	};

	/** Trips the prose signal: enough attributed words to clear THRESHOLD. */
	const wroteProse = () => {
		write("docs/mine.md", PARAGRAPH);
		record("docs/mine.md", ME);
	};

	it("tells the session to run the pass itself, on the recorded base", () => {
		wroteProse();

		const reason = run("stop") ?? "";
		expect(reason).toContain(
			`Run the concision-pass skill with fixed point ${readRecordedBase()}`,
		);
		expect(reason).not.toContain("Do NOT run that pass in this session");
		// The dispatch wording mantahostels#1097 added, and only it: `Agent` is still live
		// in the code signal's own nag, which mantahostels#1143 did not touch.
		expect(reason).not.toContain("dispatch it (#1097)");
	});

	it("tells the session what route= to write", () => {
		wroteProse();

		const reason = run("stop") ?? "";
		expect(reason).toContain("'route=in-session'");
		expect(reason).not.toContain("route=subagent");
		expect(reason).not.toContain("route=mixed");
	});

	it("keeps the code signal's comment pass in this session too", () => {
		write("scripts/mine.ts", `${BIG_CODE}\n`);
		record("scripts/mine.ts", ME);

		const reason = run("stop") ?? "";
		expect(reason).toContain(
			"here in this session and not in a subagent (mantahostels#1143)",
		);
	});

	// route= is instrumentation, not a gate: a pass that ran is not worth
	// re-running because it recorded its route badly, or not at all.
	it("accepts a marker carrying route=, and one still missing it", () => {
		wroteProse();
		marker(
			`.concision-pass-${ME}`,
			`base=${readRecordedBase()}\nfindings=4\nroute=in-session\n`,
		);
		expect(run("stop")).toBeNull();

		fs.rmSync(path.join(markersDir(), `.concision-nagged-${ME}`), {
			force: true,
		});
		marker(`.concision-pass-${ME}`, `base=${readRecordedBase()}\nfindings=4\n`);
		expect(run("stop")).toBeNull();
	});

	it("still rejects a branch name as base= however the route reads", () => {
		wroteProse();
		marker(`.concision-pass-${ME}`, "base=main\nfindings=0\nroute=subagent\n");

		expect(run("stop")).toContain("not a 40-hex sha");
	});
});

/*
 * mantahostels#2779: the Husky hooks carry no extension, so CODE's extension globs
 * missed them and a hook-only change fell through to PROSE — no review nag at
 * any threshold.
 */
describe("the Husky hooks are code — mantahostels#2779", () => {
	const hookNames = [
		"pre-commit",
		"prepare-commit-msg",
		"commit-msg",
		"pre-merge-commit",
		"pre-applypatch",
		"post-commit",
		"pre-push",
	];

	/** 31 lines and 182 words: past CODE_THRESHOLD and past THRESHOLD alike. */
	const hookBody = [
		"#!/usr/bin/env sh",
		...Array.from({ length: 30 }, (_, i) => `echo "gate ${i} of the stack"`),
	].join("\n");

	const wroteHook = (name: string) => {
		write(`.husky/${name}`, `${hookBody}\n`);
		record(`.husky/${name}`, ME);
	};

	// PROSE is CODE's complement, so a hook added to one and not removed from the
	// other is billed twice, on two signals. The pathspec is a directory, so a
	// seventh hook is covered on the day it is added.
	it.each(hookNames)("counts .husky/%s as code, and not as prose", (name) => {
		wroteHook(name);

		const reason = run("stop") ?? "";
		expect(reason).toContain("code-review");
		expect(reason).toContain(`.husky/${name}`);
		expect(reason).not.toContain("words of prose");
	});

	// Every case above writes a hook the fixture does not track, which drives the
	// untracked limb alone. Editing a hook that already exists — the ticket's own
	// case — goes through the tracked diff instead, a separate pathspec use.
	it("counts an edit to a hook already committed", () => {
		write(".husky/pre-commit", "#!/usr/bin/env sh\necho one\n");
		git("add", ".husky/pre-commit");
		git("commit", "-qm", "a hook to edit", "--", ".husky/pre-commit");
		// Re-record the base ON that commit, or the hook is new to the diff and
		// the case is an untracked one again.
		fs.rmSync(path.join(markersDir(), `.concision-base-${ME}`));
		run("start");
		wroteHook("pre-commit");

		const reason = run("stop") ?? "";
		expect(reason).toContain("code-review");
		expect(reason).toContain(".husky/pre-commit");
		expect(reason).not.toContain("words of prose");
	});

	// The exclusion is scoped to .husky, not to extensionless files at large.
	it("leaves an extensionless file elsewhere on the prose signal", () => {
		write("docs/RUNBOOK", PARAGRAPH);
		record("docs/RUNBOOK", ME);

		expect(run("stop") ?? "").toContain("words of prose");
	});
});

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

		// #1748: the hold skips a worktree commit, so the nag is its only signal.
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

describe("the /implement closing steps — #2031", () => {
	const closingSteps = fs
		.readFileSync(
			path.resolve(
				__dirname,
				"../docs/agents/rules/implement-closing-steps.txt",
			),
			"utf8",
		)
		.trim();

	it("prints them whole on the prose nag of an /implement session", () => {
		implementRan();
		write("docs/mine.md", PARAGRAPH);
		record("docs/mine.md", ME);

		const reason = run("stop") ?? "";
		expect(reason).toContain("has not run a concision pass");
		expect(reason).toContain(closingSteps);
	});

	it("prints them whole on the code nag of an /implement session", () => {
		implementRan();
		write("scripts/tiny.ts", "export const x = 1;\n");
		record("scripts/tiny.ts", ME);

		expect(run("stop") ?? "").toContain(closingSteps);
	});

	it("leaves them off the nag of a session that never ran /implement", () => {
		write("docs/mine.md", PARAGRAPH);
		record("docs/mine.md", ME);

		const reason = run("stop") ?? "";
		expect(reason).toContain("has not run a concision pass");
		expect(reason).not.toContain(closingSteps);
	});

	it("names the fragment's path when the rule store cannot supply it", () => {
		implementRan();
		write("docs/mine.md", PARAGRAPH);
		record("docs/mine.md", ME);
		const empty = path.join(dir, "no-rules");
		fs.mkdirSync(empty);

		const reason =
			run("stop", ME, {
				WFC_RULES_DIR: empty,
				WFC_RULES_FALLBACK_DIR: empty,
			}) ?? "";
		expect(reason).not.toContain(closingSteps);
		expect(reason).toContain(
			"its closing steps are in docs/agents/rules/implement-closing-steps.txt",
		);
	});

	it("prints nothing when an /implement session owes no pass", () => {
		implementRan();
		write("docs/mine.md", "three short words\n");
		record("docs/mine.md", ME);

		expect(run("stop")).toBeNull();
	});
});
