// @vitest-environment node
/*
 * lib/review-tier.js, a PreToolUse dispatcher core (#2792), hands a session
 * the review tier its change owes when it loads code-review on a change
 * touching a declared sensitive path (#1619, spec #1612). Break it and a change
 * to code that decides who may read what, or what a guest pays, is reviewed at
 * the tier a typo fix gets.
 *
 * Module cases, run in process through lib/guard-core-testkit.ts over the
 * production ports (lib/review-tier-host.js): a sandbox git repo with a real
 * arbiter store, so a path is staged, written and attributed exactly as a
 * session leaves it, and the cases assert on the injected text. Two groups run
 * no core: the fragment cases read the fragments, and some run what one names
 * (lib/rule-text.sh, or a tree pinned by commit-paths.js under the records
 * fragment's Replay, the escalated and hold fragments' `git diff … $t` run
 * against it) and assert on its output; the branch case reads the core's own
 * source. Fragments are read from docs/agents/rules/ and the byte cap from
 * hook-limits.sh, never copied. The hook line and stdin are
 * scripts/guard-dispatch.test.ts's boundary set. The twin cases (#2971) spawn
 * bash: the twins they hold the core to are bash functions, fed the ledger
 * `session-arbiter.js writes --committed` prints, as the review nags feed them.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { core, freshSandbox, store } from "./arbiter-testkit";
import { shellQuote, writeFaultyGit } from "./git-fault-fake";
import { initGitRepo, mkDirOutsideRepo } from "./git-fixture";
import { runCore } from "./guard-core-testkit";
import { runInProcess } from "./run-in-process";
import { readShellConst } from "./shell-const-testkit";

const { emissionMatches, RULE_ARG_RE } = require("./rule-emission.js") as {
	emissionMatches: (text: string) => RegExpMatchArray[];
	RULE_ARG_RE: RegExp;
};
const { decide } = require("./review-tier.js") as {
	decide: (
		skill: string,
		ctx: Record<string, unknown>,
	) => Record<string, unknown> | null;
};

const CORE = path.resolve(__dirname, "review-tier.js");
const COMMIT_PATHS = path.resolve(__dirname, "..", "commit-paths.js");
const RULE_TEXT = path.resolve(__dirname, "rule-text.sh");
const RULE_CAP = readShellConst(
	path.join(__dirname, "hook-limits.sh"),
	"RULE_CAP",
);
const ME = "abcdef12-3456";
/**
 * The longest plugin root the budget charges (#2387): a login name at Linux
 * useradd's 32-character cap, under macOS's /Users (1 B longer than /home), a
 * config dir as long as the founder's `.claude-exp-b`, and 1.10.100, a guess at
 * the longest version tag. A CLAUDE_CONFIG_DIR outside the home directory is not
 * charged.
 */
const MAX_INSTALL_ROOT = `/Users/${"u".repeat(32)}/.claude-exp-b/plugins/cache/workflow-core/workflow-core/1.10.100`;
const OTHER = "99999999-0000";

const sb = freshSandbox((fresh) => {
	initGitRepo(fresh.repo, path.join(fresh.dir, "no-hooks"));
	const skill = path.join(fresh.repo, ".claude", "skills", "code-review");
	fs.mkdirSync(skill, { recursive: true });
	fs.writeFileSync(
		path.join(skill, "SKILL.md"),
		"---\nname: code-review\n---\n",
	);
	execFileSync("git", ["add", "."], { cwd: fresh.repo });
	execFileSync("git", ["commit", "-qm", "skill"], { cwd: fresh.repo });
});

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: sb.repo, encoding: "utf8" }).trim();

const declare = (sensitivePaths?: unknown[]) => {
	fs.mkdirSync(path.join(sb.repo, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(sb.repo, ".claude", "workflow-core.json"),
		JSON.stringify(sensitivePaths === undefined ? {} : { sensitivePaths }),
	);
};

const write = (rel: string, body = "x\n", tree = sb.repo) => {
	fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
	fs.writeFileSync(path.join(tree, rel), body);
};

const stage = (rel: string, tree = sb.repo) => {
	write(rel, "x\n", tree);
	execFileSync("git", ["add", "--", rel], { cwd: tree });
};

interface SkillCall {
	skill?: string;
	sid?: string;
	/** The payload's cwd; left off, the payload names none. */
	cwd?: string;
	/** The host root; left off, the sandbox repo. */
	project?: string;
}

let logs: string[] = [];

/** The injected text for a Skill call, or null where the core said nothing. */
const envelope = ({
	skill = "code-review",
	sid = ME,
	cwd,
	project = sb.repo,
}: SkillCall = {}): string | null => {
	const run = runCore(
		"inject-review-tier",
		{
			hook_event_name: "PreToolUse",
			tool_name: "Skill",
			tool_input: { skill },
			session_id: sid,
			cwd,
		},
		{ root: project },
	);
	logs = run.logs;
	if (!run.output) return null;
	expect(run.output.permissionDecision).toBeUndefined();
	return run.output.additionalContext ?? null;
};

const readFragment = (id: string) =>
	fs
		.readFileSync(
			path.resolve(
				__dirname,
				"..",
				"..",
				"docs",
				"agents",
				"rules",
				`${id}.txt`,
			),
			"utf8",
		)
		.trim();

const RLS = {
	name: "RLS and auth boundaries",
	description: "who may read or write what",
	globs: ["supabase/migrations/**"],
	focus: "who can read or write what",
	examples: ["an RLS policy", "a grant", "a role check"],
};

const MONEY = {
	name: "money paths",
	description: "what a guest pays and what a hostel is paid",
};

const SQL = "supabase/migrations/001.sql";

describe("an ordinary review", () => {
	it("says nothing where no area matches and none is globless", () => {
		declare([RLS]);
		stage("app/page.tsx");
		expect(envelope()).toBeNull();
	});

	it("says nothing at a declared none", () => {
		declare([]);
		stage(SQL);
		expect(envelope()).toBeNull();
	});

	it("says nothing to any other skill", () => {
		declare(undefined);
		expect(envelope({ skill: "diagnosing-bugs" })).toBeNull();
		expect(envelope({ skill: "code-review:code-review" })).toBeNull();
	});
});

describe("an escalated review", () => {
	it("names the tier, the area, its paths, focus and examples", () => {
		declare([RLS]);
		stage(SQL);
		const text = envelope() ?? "";
		expect(text).toContain("Tier owed: escalated.");
		expect(text).toContain(
			"- `RLS and auth boundaries` (supabase/migrations/001.sql), not live. Focus: who can read or write what. Examples: an RLS policy; a grant; a role check.",
		);
	});

	it("hands over the mission-critical test and the staged-review mode", () => {
		declare([RLS]);
		stage(SQL);
		const text = envelope() ?? "";
		expect(text).toContain(readFragment("review-tier-escalated"));
		expect(text).toContain("`mission-critical: yes|no, because …`");
		expect(text).toContain("`git diff HEAD $t -- <commit paths>`");
		expect(text).not.toContain(readFragment("review-tier-globless"));
	});

	it("hands over both run briefs, the records and their session-suffixed Artefact paths (#1621)", () => {
		declare([RLS]);
		stage(SQL);
		const text = envelope() ?? "";
		for (const id of [
			"review-focused-run",
			"review-attacker-run",
			"review-tier-records",
		]) {
			expect(text).toContain(readFragment(id));
		}
		expect(text).toContain(
			"Focus and attack Artefact paths: `.claude/tmp/review-focus-abcdef12.md`, `.claude/tmp/review-attack-abcdef12.md`.",
		);
	});

	it("matches a namespaced code-review too (#201)", () => {
		declare([RLS]);
		stage(SQL);
		expect(envelope({ skill: "workflow-core:code-review" })).toContain(
			"Tier owed",
		);
	});

	it("tells a non-live area's session that no ultrareview will be raised", () => {
		declare([RLS]);
		stage(SQL);
		expect(envelope()).toContain(readFragment("review-tier-not-live"));
	});

	it("leaves the non-live line out where every area is live", () => {
		declare([{ ...RLS, live: true }]);
		stage(SQL);
		const text = envelope() ?? "";
		expect(text).toContain(", live. Focus:");
		expect(text).not.toContain(readFragment("review-tier-not-live"));
	});

	it("names the default focus where the area gives none", () => {
		declare([{ ...RLS, focus: undefined }]);
		stage(SQL);
		expect(envelope()).toContain("Focus: access control and money logic.");
	});

	it("restates the areas at a second review in the session, and not the rules", () => {
		declare([RLS]);
		stage(SQL);
		envelope();
		const second = envelope() ?? "";
		expect(second).toContain("`RLS and auth boundaries`");
		expect(second).not.toContain(readFragment("review-tier-escalated"));
	});
});

/** Records HEAD as `sid`'s session base. */
const recordBase = (sid = ME, sha = git("rev-parse", "HEAD")) => {
	const markers = path.join(sb.repo, ".claude", "tmp", "markers");
	fs.mkdirSync(markers, { recursive: true });
	fs.writeFileSync(path.join(markers, `.concision-base-${sid}`), sha);
};

/** Records `file` (repo-relative, or absolute) as written by `sid` in the
 * arbiter's write ledger. */
const record = (file: string, sid = ME) =>
	store.recordWrite(path.resolve(sb.repo, file), sid);

describe("a session's own change since its base", () => {
	it("escalates on an unstaged file this session wrote", () => {
		declare([RLS]);
		recordBase(ME);
		write(SQL);
		record(SQL, ME);
		expect(envelope()).toContain("Tier owed: escalated.");
	});

	it("stays silent on a file a neighbour session wrote", () => {
		declare([RLS]);
		recordBase(ME);
		write(SQL);
		record(SQL, OTHER);
		expect(envelope()).toBeNull();
	});
});

// #2386: a throwaway worktree keeps CLAUDE_PROJECT_DIR on the shared tree, so
// the core finds the worktree from the payload's cwd.
describe("a session in a linked worktree (#2386)", () => {
	const worktree = (at: string) => {
		git("worktree", "add", "-q", "--detach", at);
		return at;
	};
	const inRoot = () => path.join(sb.repo, ".claude", "worktrees", "wt");

	it("escalates on a path staged in a worktree under the root", () => {
		declare([RLS]);
		const tree = worktree(inRoot());
		stage(SQL, tree);
		const text = envelope({ cwd: path.join(tree, "supabase") }) ?? "";
		expect(text).toContain(`- \`RLS and auth boundaries\` (${SQL})`);
		expect(text).toContain(readFragment("review-tier-escalated"));
	});

	it("escalates on a path staged in a worktree outside the root", () => {
		declare([RLS]);
		const tree = worktree(path.join(sb.dir, "elsewhere"));
		stage(SQL, tree);
		expect(envelope({ cwd: tree })).toContain("Tier owed: escalated.");
	});

	it("escalates on an unstaged file this session wrote in the worktree", () => {
		declare([RLS]);
		const tree = worktree(inRoot());
		recordBase();
		write(SQL, "x\n", tree);
		record(path.join(tree, SQL));
		expect(envelope({ cwd: tree })).toContain("Tier owed: escalated.");
	});

	it("escalates on a path staged in the shared tree, from a worktree (#2529)", () => {
		declare([RLS]);
		stage(SQL);
		const text = envelope({ cwd: worktree(inRoot()) }) ?? "";
		expect(text).toContain(`- \`RLS and auth boundaries\` (${SQL})`);
		expect(text).toContain(readFragment("review-tier-escalated"));
	});

	it("escalates on a file this session wrote in the shared tree, from a worktree (#2529)", () => {
		declare([RLS]);
		const tree = worktree(inRoot());
		recordBase();
		write(SQL);
		record(SQL);
		expect(envelope({ cwd: tree })).toContain("Tier owed: escalated.");
	});

	it("names a path staged in both trees once (#2529)", () => {
		declare([RLS]);
		stage(SQL);
		const tree = worktree(inRoot());
		stage(SQL, tree);
		expect(envelope({ cwd: tree })).toContain(
			`- \`RLS and auth boundaries\` (${SQL}),`,
		);
	});

	/**
	 * A git that rejects --path-format, as one before 2.31 does, where it runs
	 * in `at`, and runs every other call for real; installed at WFC_GIT, which
	 * lib/git.js reads on every call (base §N7).
	 */
	const oldGitAt = (at: string) => {
		process.env.WFC_GIT = writeFaultyGit(
			{ argPrefix: "--path-format=" },
			{ script: `[ "$(pwd -P)" = ${shellQuote(at)} ] && exit 129` },
			{ under: sb.dir },
		).git;
	};

	it("logs a failed common-dir read in the worktree, and matches the root alone (#2529)", () => {
		declare([RLS]);
		const tree = worktree(inRoot());
		stage(SQL, tree);
		const inShared = "supabase/migrations/002.sql";
		stage(inShared);
		oldGitAt(tree);
		expect(envelope({ cwd: tree })).toContain(
			`- \`RLS and auth boundaries\` (${inShared}),`,
		);
		expect(logs.join("\n")).toMatch(
			/--git-common-dir failed in .* — worktree paths left unmatched/,
		);
	});

	it("logs a failed common-dir read in the root, and matches the root alone (#2581)", () => {
		declare([RLS]);
		const tree = worktree(inRoot());
		stage(SQL, tree);
		const inShared = "supabase/migrations/002.sql";
		stage(inShared);
		oldGitAt(sb.repo);
		expect(envelope({ cwd: tree })).toContain(
			`- \`RLS and auth boundaries\` (${inShared}),`,
		);
		expect(logs.join("\n")).toMatch(
			/--git-common-dir failed in .* — worktree paths left unmatched/,
		);
	});

	it("escalates on a path staged in a host root that is itself a linked worktree", () => {
		const tree = worktree(path.join(sb.dir, "elsewhere"));
		fs.mkdirSync(path.join(tree, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(tree, ".claude", "workflow-core.json"),
			JSON.stringify({ sensitivePaths: [RLS] }),
		);
		stage(SQL, tree);
		expect(envelope({ cwd: tree, project: tree })).toContain(
			"Tier owed: escalated.",
		);
	});

	it("stays on the root, logging nothing, where the cwd is another repository", () => {
		declare([RLS]);
		const other = path.join(sb.dir, "other");
		initGitRepo(other, path.join(sb.dir, "no-hooks"));
		stage(SQL, other);
		expect(envelope({ cwd: other })).toBeNull();
		expect(logs.join("\n")).not.toContain("worktree paths left unmatched");
	});
});

describe("a globless area", () => {
	it("is named for the session to judge, with the add-globs instruction", () => {
		declare([RLS, MONEY]);
		stage("app/page.tsx");
		const text = envelope() ?? "";
		expect(text).not.toContain("Tier owed");
		expect(text).toContain(
			"Sensitive areas declared with no globs:\n- `money paths`: what a guest pays and what a hostel is paid, not live.",
		);
		expect(text).toContain(readFragment("review-tier-globless"));
		expect(text).toContain(readFragment("review-tier-escalated"));
		expect(text).toContain(readFragment("review-focused-run"));
	});
});

describe("the rollout line", () => {
	it("tells an adopter with no `sensitivePaths` key that nothing can escalate", () => {
		declare(undefined);
		stage(SQL);
		expect(envelope()).toBe(readFragment("review-sensitive-undeclared"));
	});

	it("says it again at a second review in the session", () => {
		declare(undefined);
		envelope();
		expect(envelope()).toBe(readFragment("review-sensitive-undeclared"));
	});
});

describe("the byte budget (#1619)", () => {
	it("lists three of an area's paths and counts the rest", () => {
		declare([RLS]);
		for (let i = 0; i < 30; i++) stage(`supabase/migrations/${100 + i}.sql`);
		const text = envelope() ?? "";
		expect(text).toContain(
			"(supabase/migrations/100.sql, supabase/migrations/101.sql, supabase/migrations/102.sql, and 27 more)",
		);
		expect(text).toContain(readFragment("review-tier-escalated"));
	});

	it("fits every rule under the cap on Manta's four areas, deferring none", () => {
		declare([
			RLS,
			{
				name: "availability fan-out",
				description: "the parallel availability queries across hostels",
				globs: ["lib/availability/**"],
				focus: "consistency and partial failure",
				examples: ["a retry that double-books", "a timeout read as sold out"],
			},
			{
				...MONEY,
				globs: ["lib/pricing/**"],
				focus: "amounts and double spending",
				examples: ["a price calculation", "a refund", "a currency rounding"],
			},
			{
				name: "reward codes",
				description: "reward-code generation and redemption",
				examples: ["a redemption state change", "a code generator"],
			},
		]);
		stage("supabase/migrations/001_policies.sql");
		stage("lib/availability/fan-out.ts");
		stage("lib/pricing/quote.ts");
		// An install spells each core path at its plugin root (#1695), so the core
		// runs on a stand-in install padded to MAX_INSTALL_ROOT's length, its
		// scripts/ and docs/ linked to this checkout's. It sits under the OS temp
		// dir, as the fixture's own root runs past that length in a worktree.
		const temp = mkDirOutsideRepo("install-");
		const pad = MAX_INSTALL_ROOT.length - temp.length - 1;
		const root = path.join(temp, "i".repeat(Math.max(pad, 0)));
		let installed: string;
		try {
			expect(pad, `temp dir ${temp} too long to pad`).toBeGreaterThan(0);
			fs.mkdirSync(root);
			for (const sub of ["scripts", "docs"])
				fs.symlinkSync(
					path.resolve(__dirname, "..", "..", sub),
					path.join(root, sub),
				);
			process.env.WFC_SCRIPT_ROOT = root;
			installed = envelope() ?? "";
		} finally {
			delete process.env.WFC_SCRIPT_ROOT;
			fs.rmSync(temp, { recursive: true, force: true });
		}
		expect(installed).toContain(`${root}/`);
		expect(Buffer.byteLength(installed)).toBeLessThanOrEqual(RULE_CAP);
		// Nothing deferred: the checkout's envelope, last id included, once the
		// root is taken back out. A second session, as the first latched every
		// rule, sharing ME's eight-character Artefact suffix.
		const checkout = envelope({ sid: `${ME}-2` }) ?? "";
		expect(checkout).toContain(readFragment("review-tier-not-live"));
		expect(installed.replaceAll(`${root}/`, "")).toBe(checkout);
	});
});

describe("the fragments", () => {
	it("state the glossary's mission-critical test as the glossary words it", () => {
		const glossary = fs.readFileSync(
			path.resolve(__dirname, "..", "..", "GLOSSARY.md"),
			"utf8",
		);
		const definition = /\*\*Mission-critical change\*\*:\n(.+)\n/.exec(
			glossary,
		)?.[1];
		expect(definition).toBeDefined();
		expect(readFragment("review-tier-escalated")).toContain(definition);
	});

	// review-hold-gate.sh holds the commit that adds an area's globs (#1612 triage Q2).
	it("say the commit adding a globless area's globs is held", () => {
		expect(readFragment("review-tier-globless")).toContain(
			"That commit is held",
		);
	});

	it("ask a yes to name the rule or calculation, and areas= to name the globless areas judged touched (#2082, #2254)", () => {
		expect(readFragment("review-tier-escalated")).toContain(
			"a yes names the rule or calculation",
		);
		expect(readFragment("review-hold")).toContain(
			"--areas <every area the refusal or `Tier owed:` names, and any globless area you judged touched,",
		);
	});

	// #1925, #1948: nothing holds a worktree commit, so the hold's text never
	// reaches it — the tier block must name a command that prints the marker
	// command (#2040).
	it("hand a staged review a command printing the marker command with every flag, in a worktree too", () => {
		expect(readFragment("review-tier-escalated")).toContain(
			"Record it with the marker script, worktree too: `scripts/lib/rule-text.sh review-hold`.",
		);
		const hold = execFileSync("bash", [RULE_TEXT, "review-hold"], {
			encoding: "utf8",
		});
		expect(hold.trim()).toBe(readFragment("review-hold"));
		expect(hold).toMatch(
			/^ {2}node scripts\/write-review-marker\.js .*--paths /m,
		);
		expect(hold).toContain("A worktree commit is not held");
	});

	// #1625's re-measure checker parses these records off the tracker.
	it("name the record formats and the pin exactly as the re-measure checker reads them", () => {
		const records = readFragment("review-tier-records");
		for (const format of [
			"`**Review tier:** <tier>`",
			"`**Review findings:** base <marker base=>, reviewed <tree-sha>, landed <sha>, paths <marker paths=>`",
			"`- FIXED|TICKETED #<n>|DECLINED: <defect> (<runs>)`",
			"`**Escaped defect:** <landed sha> — <one line>`",
			"git update-ref refs/reviewed/$t $t",
		]) {
			expect(records).toContain(format);
		}
	});

	// #2254: commit-paths.js refuses a patched file in its `--` list, which
	// the runs' diff must name, so the pin spells its list apart.
	it("spell the pin's path list apart from the diff's", () => {
		const pinned =
			"`t=$(node scripts/commit-paths.js --tree [--patch <file>] -- <unpatched paths>)";
		expect(readFragment("review-tier-records")).toContain(pinned);
		expect(readFragment("review-hold")).toContain(pinned);
		expect(readFragment("review-hold")).toContain(
			"`git diff HEAD $t -- <commit paths>`",
		);
	});
	/** A `git …` command a rule spells, its placeholders filled. */
	const readSpelled = (
		id: string,
		lead: RegExp,
		fill: Record<string, string>,
	): string => {
		const cmd = new RegExp(`${lead.source}\`git (.+?)\``).exec(
			readFragment(id),
		);
		expect(cmd).not.toBeNull();
		return git(
			...Object.entries(fill)
				.reduce((c, [hole, value]) => c.replace(hole, value), cmd?.[1] ?? "")
				.split(" "),
		);
	};
	const replay = (base: string, tree: string, paths: string) =>
		readSpelled("review-tier-records", /Replay: /, {
			"<base>": base,
			"<tree-sha>": tree,
			"<marker paths=>": paths.replaceAll(",", " "),
		});
	const pin = (args: string[]) =>
		runInProcess(COMMIT_PATHS, ["--tree", ...args], {
			cwd: sb.repo,
			env: { ...process.env },
		}).stdout.trim();

	// #1926: on the start-point route the pinned tree is HEAD's plus the
	// reviewed paths, so a neighbour's commit since base= sits in it too.
	it("replay a start-point review to the runs' diff, not a neighbour's file committed since", () => {
		write("quote.ts", "price = 1\n");
		write("tax.ts", "rate = 1\n");
		git("add", "quote.ts", "tax.ts");
		git("commit", "-qm", "seed");
		const start = git("rev-parse", "HEAD");
		write("quote.ts", "price = 2\n");
		git("commit", "-qam", "own earlier commit");
		write("app/neighbour.ts", "theirs\n");
		git("add", "app/neighbour.ts");
		git("commit", "-qm", "neighbour");
		write("quote.ts", "price = 3\n");
		write("tax.ts", "rate = 2\n");
		const reviewedDiff = git("diff", start, "--", "quote.ts", "tax.ts");
		const tree = pin(["--", "quote.ts", "tax.ts"]);
		expect(replay(start, tree, "quote.ts,tax.ts")).toBe(reviewedDiff);
		expect(git("diff", "--stat", start, tree)).toContain("app/neighbour.ts");
	});

	/** quote.ts holding `mid` and `end` far enough apart to be two hunks. */
	const writeQuote = (mid: string, end: string) =>
		write("quote.ts", ["a", mid, ..."bcdefgh", end].join("\n"));
	/** Commits quote.ts and tax.ts, returning HEAD's sha. */
	const seed = () => {
		writeQuote("1", "2");
		write("tax.ts", "rate = 1\n");
		git("add", "quote.ts", "tax.ts");
		git("commit", "-qm", "seed");
		return git("rev-parse", "HEAD");
	};
	/** Edits both of quote.ts's hunks, returning a patch file of the first alone; the second is a neighbour's. */
	const writeFirstHunkPatch = () => {
		writeQuote("10", "2");
		const patch = path.join(sb.dir, "hunk.patch");
		fs.writeFileSync(patch, `${git("diff", "--", "quote.ts")}\n`);
		writeQuote("10", "20");
		return patch;
	};

	// #2081: the runs diff the pinned tree, so under --patch they see the patch
	// the commit carries, as the replay does, not the neighbour's hunk beside it.
	// The pin's `--` list cannot name a patched file, so paths= must.
	it("replay a staged --patch review to the runs' diff the tier block gives (#2081)", () => {
		const head = seed();
		write("tax.ts", "rate = 2\n");
		const tree = pin(["--patch", writeFirstHunkPatch(), "--", "tax.ts"]);
		const runs = readSpelled("review-tier-escalated", /diff /, {
			$t: tree,
			"<commit paths>": "quote.ts tax.ts",
		});
		expect(runs).not.toContain("+20");
		expect(replay(head, tree, "quote.ts,tax.ts")).toBe(runs);
		expect(
			readSpelled("review-hold", /fixed point `HEAD`, diff /, {
				$t: tree,
				"<commit paths>": "quote.ts tax.ts",
			}),
		).toBe(runs);
	});

	it("replay a start-point --patch review to the runs' diff the hold gives (#2081)", () => {
		const start = seed();
		write("tax.ts", "rate = 2\n");
		git("commit", "-qam", "own earlier commit");
		write("tax.ts", "rate = 3\n");
		const tree = pin(["--patch", writeFirstHunkPatch(), "--", "tax.ts"]);
		const runs = readSpelled("review-hold", /fixed point that sha, diff /, {
			"<that sha>": start,
			$t: tree,
			"<commit paths>": "quote.ts tax.ts",
		});
		expect(runs).not.toContain("+20");
		expect(replay(start, tree, "quote.ts,tax.ts")).toBe(runs);
	});
});

// #1748: the branches spell their ids out (#1699), so nothing else keeps them
// in step.
describe("the tier block's injectRules branches", () => {
	it("are the shared ids plus each subset of the optional ones", () => {
		const lists = emissionMatches(fs.readFileSync(CORE, "utf8")).map((m) =>
			[...(m[1] ?? "").matchAll(RULE_ARG_RE)].map((a) => a[1]),
		);
		expect(lists.length).toBeGreaterThan(1);
		const shared = lists.reduce((a, b) => (a.length <= b.length ? a : b));
		const tails = lists.map((ids) => {
			expect(ids.slice(0, shared.length)).toEqual(shared);
			return ids.slice(shared.length);
		});
		const optional = [...new Set(tails.flat())];
		expect(optional.length).toBeGreaterThan(0);
		const subsets: string[][] = [[]];
		for (const id of optional)
			for (const s of subsets.slice()) subsets.push([...s, id]);
		expect(tails.map((t) => t.join(" ")).sort()).toEqual(
			subsets.map((s) => s.join(" ")).sort(),
		);
	});
});

describe("the cases a mutant must not survive (#2792)", () => {
	const Escalated = readFragment("review-tier-escalated");

	it("says nothing to a bare code-review where the host has no local skill (#1165)", () => {
		declare([RLS]);
		stage(SQL);
		fs.rmSync(path.join(sb.repo, ".claude", "skills"), {
			recursive: true,
		});
		expect(envelope()).toBeNull();
		expect(envelope({ skill: "workflow-core:code-review" })).toContain(
			"Tier owed: escalated.",
		);
	});

	it("lists exactly three paths without a count", () => {
		declare([RLS]);
		for (let i = 0; i < 3; i++) stage(`supabase/migrations/${100 + i}.sql`);
		expect(envelope()).toContain(
			"(supabase/migrations/100.sql, supabase/migrations/101.sql, supabase/migrations/102.sql), not live.",
		);
	});

	it("leaves the Examples clause off an area that gives none", () => {
		declare([{ ...RLS, examples: [] }]);
		stage(SQL);
		expect(envelope()).toContain(
			"- `RLS and auth boundaries` (supabase/migrations/001.sql), not live. Focus: who can read or write what.\n",
		);
	});

	it("leaves the non-live line out where a globless area is live too", () => {
		declare([
			{ ...RLS, live: true },
			{ ...MONEY, live: true },
		]);
		stage(SQL);
		const text = envelope() ?? "";
		expect(text).toContain(
			"- `money paths`: what a guest pays and what a hostel is paid, live.",
		);
		expect(text).toContain(readFragment("review-tier-globless"));
		expect(text).not.toContain(readFragment("review-tier-not-live"));
	});

	it("tells a non-live globless area's session no ultrareview will be raised", () => {
		declare([{ ...RLS, live: true }, MONEY]);
		stage(SQL);
		expect(envelope()).toContain(readFragment("review-tier-not-live"));
	});

	it("orders the tier's areas ahead of the globless ones", () => {
		declare([RLS, MONEY]);
		stage(SQL);
		const text = envelope() ?? "";
		expect(text.indexOf("Tier owed: escalated.")).toBeLessThan(
			text.indexOf("Sensitive areas declared with no globs:"),
		);
		expect(
			text.startsWith(
				"Sensitive paths declared in `.claude/workflow-core.json`:\nTier owed: escalated.",
			),
		).toBe(true);
		expect(text).toContain(Escalated);
	});

	it("bills nothing since the base to a session with no recorded base", () => {
		declare([RLS]);
		write(SQL);
		record(SQL);
		expect(envelope()).toBeNull();
	});

	it("falls back to the merge base where a rebase moved the base off HEAD's line (mantahostels#114)", () => {
		declare([RLS]);
		const fork = git("rev-parse", "HEAD");
		write("side.md", "side\n");
		git("add", "side.md");
		git("commit", "-qm", "rewritten away");
		const offLine = git("rev-parse", "HEAD");
		git("reset", "-q", "--hard", fork);
		recordBase(ME, offLine);
		write(SQL);
		record(SQL);
		expect(envelope()).toContain("Tier owed: escalated.");
	});

	it("escalates on a tracked file this session changed since a base recorded with its newline", () => {
		declare([RLS]);
		stage(SQL);
		git("commit", "-qm", "seed");
		recordBase(ME, `${git("rev-parse", "HEAD")}\n`);
		write(SQL, "changed\n");
		record(SQL);
		expect(envelope()).toContain("Tier owed: escalated.");
	});

	it("bills nothing to a base git cannot place", () => {
		declare([RLS]);
		recordBase(ME, "0".repeat(40));
		write(SQL);
		record(SQL);
		expect(envelope()).toBeNull();
	});

	it("logs a write ledger that will not read, and bills nothing since the base", () => {
		declare([RLS]);
		recordBase(ME);
		write(SQL);
		fs.mkdirSync(core.paths.ledger(ME), { recursive: true });
		expect(envelope()).toBeNull();
		expect(logs).toContain(
			"the write ledger did not read — this session's unstaged changes left unmatched",
		);
	});

	it("bills a worktree outside the root none of the root's ledger", () => {
		declare([RLS]);
		write(SQL);
		record(SQL);
		git("add", "--", SQL);
		git("commit", "-qm", "own");
		recordBase(ME);
		const tree = path.join(sb.dir, "elsewhere");
		git("worktree", "add", "-q", "--detach", tree);
		fs.rmSync(path.join(tree, SQL));
		expect(envelope({ cwd: tree })).toBeNull();
	});

	it("logs a config that will not read, and says nothing", () => {
		fs.writeFileSync(
			path.join(sb.repo, ".claude", "workflow-core.json"),
			"{ not json",
		);
		stage(SQL);
		expect(envelope()).toBeNull();
		expect(logs.join("\n")).toMatch(
			/^the workflow-core config did not read — review tier not stated: /m,
		);
	});

	/** decide over a stub context: the ports the kit and the host would give. */
	const stubCtx = (over: Record<string, unknown>) => ({
		root: "/r",
		cwd: undefined,
		session: "",
		isFile: () => true,
		topLevel: () => null,
		commonDir: () => null,
		staged: () => [SQL],
		sessionBase: () => null,
		changedSince: () => [],
		billed: () => [],
		declared: () => [{ ...RLS, live: false }],
		ruleText: () => {
			throw new Error("store down");
		},
		corePaths: (t: string) => t,
		docPath: (name: string) => `docs/${name}`,
		log: () => {
			/* The stub context records nothing. */
		},
		...over,
	});

	it("leaves the Artefact paths unsuffixed for a payload with no session", () => {
		const d = decide("code-review", stubCtx({}) as never) as {
			prelude: string;
		};
		expect(d.prelude).toContain(
			"`.claude/tmp/review-focus.md`, `.claude/tmp/review-attack.md`.",
		);
	});

	it("reads no worktree for a payload naming no cwd", () => {
		expect(
			decide(
				"code-review",
				stubCtx({
					topLevel: () => "/wt",
					commonDir: () => "/c",
					staged: (t: string) => (t === "/wt" ? [SQL] : []),
				}) as never,
			),
		).toBeNull();
	});

	it("reads no common dir where the cwd is in the root itself", () => {
		const said: string[] = [];
		decide(
			"code-review",
			stubCtx({
				cwd: "/r/src",
				topLevel: () => "/r",
				log: (what: string) => said.push(what),
			}) as never,
		);
		expect(said).toEqual([]);
	});

	it("bills nothing since a base to a payload with no session", () => {
		expect(
			decide(
				"code-review",
				stubCtx({
					staged: () => [],
					sessionBase: () => "b",
					billed: () => [SQL],
					changedSince: () => [SQL],
				}) as never,
			),
		).toBeNull();
	});

	it("bills a worktree under the root only the ledger paths under its place", () => {
		expect(
			decide(
				"code-review",
				stubCtx({
					cwd: "/r/wt",
					session: ME,
					topLevel: () => "/r/wt",
					commonDir: () => "/c",
					staged: () => [],
					sessionBase: () => "b",
					billed: () => [`ab/${SQL}`],
					changedSince: (t: string) => (t === "/r/wt" ? [SQL] : []),
				}) as never,
			),
		).toBeNull();
	});

	it("spells the undeclared line's core paths as an install reaches them", () => {
		expect(
			decide(
				"code-review",
				stubCtx({
					declared: () => undefined,
					ruleText: () => "see docs/x.txt",
					corePaths: (t: string) => `${t} [resolved]`,
				}) as never,
			),
		).toEqual({ context: "see docs/x.txt [resolved]" });
	});

	it("states the undeclared line's fallback where the store cannot give it", () => {
		expect(
			decide("code-review", stubCtx({ declared: () => undefined }) as never),
		).toEqual({
			context:
				"No sensitive paths are declared, so no review here can escalate; the rule could not be read from docs/agents/rules/review-sensitive-undeclared.txt. Read that file before doing anything else.",
		});
	});
});

/*
 * #2971: the tier's sessionBase and its changedSince with ownChanges are Node
 * twins of lib/concision-marker.sh's concision_session_base and
 * lib/code-signal.sh's written_paths over `session-arbiter.js writes
 * --committed`, which the Stop and push review nags bill. One area per
 * fixture path, so the area lines name every path the tier
 * billed.
 */
describe("the session base and billed paths, in both twins (#2971)", () => {
	const libs = ["concision-marker.sh", "code-signal.sh"].map((f) =>
		path.resolve(__dirname, f),
	);
	const arbiter = path.resolve(__dirname, "..", "session-arbiter.js");
	const markers = () => path.join(sb.repo, ".claude", "tmp", "markers");

	const commit = (rel: string, sid?: string) => {
		stage(rel);
		git("commit", "-qm", rel);
		if (sid) store.recordCommit(git("rev-parse", "HEAD"), sid);
	};

	/** The bash nags' base, then the paths written_paths bills over the
	 * ledger they read, sorted. */
	const bashTwin = () => {
		const out = execFileSync(
			"bash",
			[
				"-c",
				`source "$1" && source "$2" || exit 9
base="$(concision_session_base "$3" "$4")" || exit 0
printf '%s\\n' "$base"
mine="$(mktemp)" && node "$5" writes "$4" --committed >"$mine" || exit 8
written_paths "$base" "$mine" | LC_ALL=C sort
rm -f "$mine"`,
				"twin",
				...libs,
				markers(),
				ME,
				arbiter,
			],
			{ cwd: sb.repo, encoding: "utf8" },
		);
		const [base = "", ...billed] = out.split("\n").filter(Boolean);
		return { base, billed };
	};

	/** The tier's base, then the paths its area lines name, sorted. */
	const nodeTwin = (paths: string[]) => {
		declare(paths.map((p) => ({ name: p, description: "d", globs: [p] })));
		const { buildHostPorts } = require("./review-tier-host.js") as {
			buildHostPorts: (root: string) => {
				sessionBase: (sid: string) => string;
			};
		};
		const text = envelope() ?? "";
		const billed = [...text.matchAll(/^- `([^`]+)` \(/gm)]
			.map((m) => m[1] as string)
			.sort();
		return { base: buildHostPorts(sb.repo).sessionBase(ME), billed };
	};

	/*
	 * The recorded base is rebased off HEAD's line, so both fall back to the
	 * merge base.
	 */
	const fixture = () => {
		write(".gitignore", ".claude/tmp/\nignored.js\n");
		git("add", ".gitignore");
		commit("tracked-mine.js");
		commit("tracked-theirs.js");
		const fork = git("rev-parse", "HEAD");
		commit("dropped.js");
		recordBase(ME, git("rev-parse", "HEAD"));
		git("reset", "-q", "--hard", fork);
		commit("theirs-committed.js", OTHER);
		commit("mine-committed.js", ME);
		for (const [rel, sid] of [
			["tracked-mine.js", ME],
			["new-mine.js", ME],
			["café-mine.js", ME],
			["ignored.js", ME],
			["tracked-theirs.js", OTHER],
			["new-theirs.js", OTHER],
		] as const) {
			write(rel, "y\n");
			record(rel, sid);
		}
		return fork;
	};

	const fixturePaths = [
		"café-mine.js",
		"ignored.js",
		"mine-committed.js",
		"new-mine.js",
		"new-theirs.js",
		"theirs-committed.js",
		"tracked-mine.js",
		"tracked-theirs.js",
	];
	const ownPaths = [
		"café-mine.js",
		"mine-committed.js",
		"new-mine.js",
		"tracked-mine.js",
	].sort();

	it("place a base rebased off HEAD at its merge base", () => {
		const fork = fixture();
		expect(bashTwin().base).toBe(fork);
		expect(nodeTwin(fixturePaths).base).toBe(fork);
	});

	it("bill the session's own tracked, new and committed paths and no neighbour's", () => {
		fixture();
		expect(bashTwin().billed).toEqual(ownPaths);
		expect(nodeTwin(fixturePaths).billed).toEqual(ownPaths);
	});

	it("keep a base behind HEAD on its line as recorded", () => {
		recordBase(ME);
		const base = git("rev-parse", "HEAD");
		commit("later.js");
		expect(bashTwin().base).toBe(base);
		expect(nodeTwin(fixturePaths).base).toBe(base);
	});
});
