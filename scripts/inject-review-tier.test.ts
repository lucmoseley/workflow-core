// @vitest-environment node
/*
 * inject-review-tier.sh hands a session the review tier its change owes when it
 * loads code-review on a change touching a declared sensitive path (#1619, spec
 * #1612). Break it and a change to code that decides who may read what, or what a guest
 * pays, is reviewed at the tier a typo fix gets.
 *
 * The live hook is spawned on a Skill payload, as the host sends one, against a
 * throwaway repo copied from one built fixture, and the hook's cases assert on the
 * injected text. Two groups spawn no hook: the fragment cases read the fragments,
 * and some run what one names (lib/rule-text.sh, or a tree pinned by
 * commit-paths.js under the records fragment's Replay, the escalated and hold
 * fragments' `git diff … $t` run against it) and assert on its output;
 * the gp_rule branch case reads the hook's own source. Fragments are read from
 * docs/agents/rules/ and the byte cap from guard-parse.sh, never copied.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { failOpenLogPath } from "./guard-log-fixture";
import {
	defineTemplate,
	initGitRepo,
	mkDirOutsideRepo,
	mkScratchDir,
} from "./lib/git-fixture";
import { guardOutput } from "./lib/pretool-guard-testkit";
import { runInProcess } from "./lib/run-in-process";
import { shellConst } from "./lib/shell-const-testkit";

const HOOK = path.resolve(__dirname, "inject-review-tier.sh");
const ARBITER = path.resolve(__dirname, "session-arbiter.js");
const COMMIT_PATHS = path.resolve(__dirname, "commit-paths.js");
const RULE_TEXT = path.resolve(__dirname, "lib", "rule-text.sh");
const GP_RULE_CAP = shellConst(
	path.join(__dirname, "lib", "guard-parse.sh"),
	"GP_RULE_CAP",
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

const template = defineTemplate((root) => {
	const hooks = path.join(root, "no-hooks");
	fs.mkdirSync(hooks);
	const repo = path.join(root, "repo");
	initGitRepo(repo, hooks);
	const skill = path.join(repo, ".claude", "skills", "code-review");
	fs.mkdirSync(skill, { recursive: true });
	fs.writeFileSync(
		path.join(skill, "SKILL.md"),
		"---\nname: code-review\n---\n",
	);
	execFileSync("git", ["add", "."], { cwd: repo });
	execFileSync("git", ["commit", "-qm", "skill"], { cwd: repo });
});

let dir: string;
let repo: string;

beforeEach(() => {
	dir = mkScratchDir("review-tier-");
	template.instantiate(dir);
	repo = path.join(dir, "repo");
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const env = () => ({
	...process.env,
	CLAUDE_PROJECT_DIR: repo,
	// A fail-open and the arbiter's store land under CLAUDE_CONFIG_DIR; unset, a
	// test run writes into the founder's own.
	CLAUDE_CONFIG_DIR: dir,
});

const git = (...args: string[]) =>
	execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const declare = (sensitivePaths?: unknown[]) => {
	fs.mkdirSync(path.join(repo, ".claude"), { recursive: true });
	fs.writeFileSync(
		path.join(repo, ".claude", "workflow-core.json"),
		JSON.stringify(sensitivePaths === undefined ? {} : { sensitivePaths }),
	);
};

const write = (rel: string, body = "x\n", tree = repo) => {
	fs.mkdirSync(path.dirname(path.join(tree, rel)), { recursive: true });
	fs.writeFileSync(path.join(tree, rel), body);
};

const stage = (rel: string, tree = repo) => {
	write(rel, "x\n", tree);
	execFileSync("git", ["add", "--", rel], { cwd: tree });
};

interface SkillCall {
	skill?: string;
	sid?: string;
	/** The payload's cwd; left off, the payload names none. */
	cwd?: string;
	/** CLAUDE_PROJECT_DIR; left off, the fixture repo. */
	project?: string;
	/**
	 * Laid over the test process's env and the project and config exports, an
	 * `undefined` value unsetting; left off, nothing more is laid over.
	 */
	env?: NodeJS.ProcessEnv;
}

/** The injected text for a Skill call, or null where the hook said nothing. */
const envelope = ({
	skill = "code-review",
	sid = ME,
	cwd,
	project = repo,
	env: overrides,
}: SkillCall = {}): string | null => {
	const parsed = guardOutput(
		HOOK,
		{
			tool_name: "Skill",
			tool_input: { skill },
			session_id: sid,
			cwd,
		},
		{ project, config: dir, env: overrides },
	);
	if (!parsed) return null;
	expect(parsed.permissionDecision).toBeUndefined();
	return parsed.additionalContext;
};

const fragment = (id: string) =>
	fs
		.readFileSync(
			path.resolve(__dirname, "..", "docs", "agents", "rules", `${id}.txt`),
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

describe("an ordinary review", () => {
	it("says nothing where no area matches and none is globless", () => {
		declare([RLS]);
		stage("app/page.tsx");
		expect(envelope()).toBeNull();
	});

	it("says nothing at a declared none", () => {
		declare([]);
		stage("supabase/migrations/001.sql");
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
		stage("supabase/migrations/001.sql");
		const text = envelope() ?? "";
		expect(text).toContain("Tier owed: escalated.");
		expect(text).toContain(
			"- `RLS and auth boundaries` (supabase/migrations/001.sql), not live. Focus: who can read or write what. Examples: an RLS policy; a grant; a role check.",
		);
	});

	it("hands over the mission-critical test and the staged-review mode", () => {
		declare([RLS]);
		stage("supabase/migrations/001.sql");
		const text = envelope() ?? "";
		expect(text).toContain(fragment("review-tier-escalated"));
		expect(text).toContain("`mission-critical: yes|no, because …`");
		expect(text).toContain("`git diff HEAD $t -- <commit paths>`");
		expect(text).not.toContain(fragment("review-tier-globless"));
	});

	it("hands over both run briefs, the records and their session-suffixed Artefact paths (#1621)", () => {
		declare([RLS]);
		stage("supabase/migrations/001.sql");
		const text = envelope() ?? "";
		for (const id of [
			"review-focused-run",
			"review-attacker-run",
			"review-tier-records",
		]) {
			expect(text).toContain(fragment(id));
		}
		expect(text).toContain(
			"Focus and attack Artefact paths: `.claude/tmp/review-focus-abcdef12.md`, `.claude/tmp/review-attack-abcdef12.md`.",
		);
	});

	it("matches a namespaced code-review too (#201)", () => {
		declare([RLS]);
		stage("supabase/migrations/001.sql");
		expect(envelope({ skill: "workflow-core:code-review" })).toContain(
			"Tier owed",
		);
	});

	it("tells a non-live area's session that no ultrareview will be raised", () => {
		declare([RLS]);
		stage("supabase/migrations/001.sql");
		expect(envelope()).toContain(fragment("review-tier-not-live"));
	});

	it("leaves the non-live line out where every area is live", () => {
		declare([{ ...RLS, live: true }]);
		stage("supabase/migrations/001.sql");
		const text = envelope() ?? "";
		expect(text).toContain(", live. Focus:");
		expect(text).not.toContain(fragment("review-tier-not-live"));
	});

	it("names the default focus where the area gives none", () => {
		declare([{ ...RLS, focus: undefined }]);
		stage("supabase/migrations/001.sql");
		expect(envelope()).toContain("Focus: access control and money logic.");
	});

	it("restates the areas at a second review in the session, and not the rules", () => {
		declare([RLS]);
		stage("supabase/migrations/001.sql");
		envelope();
		const second = envelope() ?? "";
		expect(second).toContain("`RLS and auth boundaries`");
		expect(second).not.toContain(fragment("review-tier-escalated"));
	});
});

/** Records HEAD as `sid`'s session base. */
const recordBase = (sid = ME) => {
	const markers = path.join(repo, ".claude", "tmp", "markers");
	fs.mkdirSync(markers, { recursive: true });
	fs.writeFileSync(
		path.join(markers, `.concision-base-${sid}`),
		git("rev-parse", "HEAD"),
	);
};

/** Records `rel` as written by `sid` in the arbiter's write ledger. */
const record = (rel: string, sid = ME) =>
	execFileSync("node", [ARBITER, "record", rel, sid], { env: env() });

const logged = () => {
	const at = failOpenLogPath(dir, repo);
	return fs.existsSync(at) ? fs.readFileSync(at, "utf8") : "";
};

describe("a session's own change since its base", () => {
	it("escalates on an unstaged file this session wrote", () => {
		declare([RLS]);
		recordBase(ME);
		write("supabase/migrations/001.sql");
		record("supabase/migrations/001.sql", ME);
		expect(envelope()).toContain("Tier owed: escalated.");
	});

	it("stays silent on a file a neighbour session wrote", () => {
		declare([RLS]);
		recordBase(ME);
		write("supabase/migrations/001.sql");
		record("supabase/migrations/001.sql", OTHER);
		expect(envelope()).toBeNull();
	});
});

// #2386: a throwaway worktree keeps CLAUDE_PROJECT_DIR on the shared tree, so
// the hook finds the worktree from the payload's cwd.
describe("a session in a linked worktree (#2386)", () => {
	const worktree = (at: string) => {
		git("worktree", "add", "-q", "--detach", at);
		return at;
	};
	const inRoot = () => path.join(repo, ".claude", "worktrees", "wt");
	const sql = "supabase/migrations/001.sql";

	it("escalates on a path staged in a worktree under the root", () => {
		declare([RLS]);
		const tree = worktree(inRoot());
		stage(sql, tree);
		const text = envelope({ cwd: path.join(tree, "supabase") }) ?? "";
		expect(text).toContain(`- \`RLS and auth boundaries\` (${sql})`);
		expect(text).toContain(fragment("review-tier-escalated"));
	});

	it("escalates on a path staged in a worktree outside the root", () => {
		declare([RLS]);
		const tree = worktree(path.join(dir, "elsewhere"));
		stage(sql, tree);
		expect(envelope({ cwd: tree })).toContain("Tier owed: escalated.");
	});

	it("escalates on an unstaged file this session wrote in the worktree", () => {
		declare([RLS]);
		const tree = worktree(inRoot());
		recordBase();
		write(sql, "x\n", tree);
		record(path.join(tree, sql));
		expect(envelope({ cwd: tree })).toContain("Tier owed: escalated.");
	});

	it("escalates on a path staged in the shared tree, from a worktree (#2529)", () => {
		declare([RLS]);
		stage(sql);
		const text = envelope({ cwd: worktree(inRoot()) }) ?? "";
		expect(text).toContain(`- \`RLS and auth boundaries\` (${sql})`);
		expect(text).toContain(fragment("review-tier-escalated"));
	});

	it("escalates on a file this session wrote in the shared tree, from a worktree (#2529)", () => {
		declare([RLS]);
		const tree = worktree(inRoot());
		recordBase();
		write(sql);
		record(sql);
		expect(envelope({ cwd: tree })).toContain("Tier owed: escalated.");
	});

	it("names a path staged in both trees once (#2529)", () => {
		declare([RLS]);
		stage(sql);
		const tree = worktree(inRoot());
		stage(sql, tree);
		expect(envelope({ cwd: tree })).toContain(
			`- \`RLS and auth boundaries\` (${sql}),`,
		);
	});

	/**
	 * A git that rejects --path-format, as one before 2.31 does, where its -C
	 * names `at` (no -C at all where `at` is null) and runs every other call
	 * for real.
	 */
	const oldGitAt = (at: string | null): NodeJS.ProcessEnv => {
		const stub = path.join(dir, "old-git");
		const real = execFileSync("bash", ["-c", "command -v git"], {
			encoding: "utf8",
		}).trim();
		fs.writeFileSync(
			stub,
			`#!/usr/bin/env bash
prev="" at=""
for a in "$@"; do
  [[ "$prev" == -C ]] && at="$a"
  [[ "$a" == --path-format=* && "$at" == "${at ?? ""}" ]] && exit 129
  prev="$a"
done
exec "${real}" "$@"
`,
			{ mode: 0o755 },
		);
		return { WFC_GIT: stub };
	};

	it("logs a failed common-dir read in the worktree, and matches the root alone (#2529)", () => {
		declare([RLS]);
		const tree = worktree(inRoot());
		stage(sql, tree);
		const inShared = "supabase/migrations/002.sql";
		stage(inShared);
		expect(envelope({ cwd: tree, env: oldGitAt(tree) })).toContain(
			`- \`RLS and auth boundaries\` (${inShared}),`,
		);
		expect(logged()).toMatch(
			/--git-common-dir failed in .* — worktree paths left unmatched/,
		);
	});

	it("logs a failed common-dir read in the root, and matches the root alone (#2581)", () => {
		declare([RLS]);
		const tree = worktree(inRoot());
		stage(sql, tree);
		const inShared = "supabase/migrations/002.sql";
		stage(inShared);
		expect(envelope({ cwd: tree, env: oldGitAt(null) })).toContain(
			`- \`RLS and auth boundaries\` (${inShared}),`,
		);
		expect(logged()).toMatch(
			/--git-common-dir failed in .* — worktree paths left unmatched/,
		);
	});

	it("escalates on a path staged in a CLAUDE_PROJECT_DIR that is itself a linked worktree", () => {
		const tree = worktree(path.join(dir, "elsewhere"));
		fs.mkdirSync(path.join(tree, ".claude"), { recursive: true });
		fs.writeFileSync(
			path.join(tree, ".claude", "workflow-core.json"),
			JSON.stringify({ sensitivePaths: [RLS] }),
		);
		stage(sql, tree);
		expect(envelope({ cwd: tree, project: tree })).toContain(
			"Tier owed: escalated.",
		);
	});

	it("stays on the root, logging nothing, where the cwd is another repository", () => {
		declare([RLS]);
		const other = path.join(dir, "other");
		initGitRepo(other, path.join(dir, "no-hooks"));
		stage(sql, other);
		expect(envelope({ cwd: other })).toBeNull();
		expect(logged()).not.toContain("worktree paths left unmatched");
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
		expect(text).toContain(fragment("review-tier-globless"));
		expect(text).toContain(fragment("review-tier-escalated"));
		expect(text).toContain(fragment("review-focused-run"));
	});
});

describe("the rollout line", () => {
	it("tells an adopter with no `sensitivePaths` key that nothing can escalate", () => {
		declare(undefined);
		stage("supabase/migrations/001.sql");
		expect(envelope()).toBe(fragment("review-sensitive-undeclared"));
	});

	it("says it again at a second review in the session", () => {
		declare(undefined);
		envelope();
		expect(envelope()).toBe(fragment("review-sensitive-undeclared"));
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
		expect(text).toContain(fragment("review-tier-escalated"));
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
		// An install spells each core path at its plugin root (#1695), so the hook
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
					path.resolve(__dirname, "..", sub),
					path.join(root, sub),
				);
			installed = envelope({ env: { WFC_SCRIPT_ROOT: root } }) ?? "";
		} finally {
			fs.rmSync(temp, { recursive: true, force: true });
		}
		expect(installed).toContain(`${root}/`);
		expect(Buffer.byteLength(installed)).toBeLessThanOrEqual(GP_RULE_CAP);
		// Nothing deferred: the checkout's envelope, last id included, once the
		// root is taken back out. A second session, as the first latched every
		// rule, sharing ME's eight-character Artefact suffix, with any root the
		// test run inherited unset.
		const checkout =
			envelope({ sid: `${ME}-2`, env: { WFC_SCRIPT_ROOT: undefined } }) ?? "";
		expect(checkout).toContain(fragment("review-tier-not-live"));
		expect(installed.replaceAll(`${root}/`, "")).toBe(checkout);
	});
});

describe("the fragments", () => {
	it("state the glossary's mission-critical test as the glossary words it", () => {
		const glossary = fs.readFileSync(
			path.resolve(__dirname, "..", "GLOSSARY.md"),
			"utf8",
		);
		const definition = /\*\*Mission-critical change\*\*:\n(.+)\n/.exec(
			glossary,
		)?.[1];
		expect(definition).toBeDefined();
		expect(fragment("review-tier-escalated")).toContain(definition);
	});

	// review-hold-gate.sh holds the commit that adds an area's globs (#1612 triage Q2).
	it("say the commit adding a globless area's globs is held", () => {
		expect(fragment("review-tier-globless")).toContain("That commit is held");
	});

	// The escalated case pins the tier fragment whole, and the next case pins
	// the hold rule-text.sh prints as this file.
	it("ask a yes to name the rule or calculation, and areas= to name the globless areas judged touched (#2082, #2254)", () => {
		expect(fragment("review-tier-escalated")).toContain(
			"a yes names the rule or calculation",
		);
		expect(fragment("review-hold")).toContain(
			"--areas <every area the refusal or `Tier owed:` names, and any globless area you judged touched,",
		);
	});

	// #1925, #1948: nothing holds a worktree commit, so the hold's text never
	// reaches it — the tier block must name a command that prints the marker
	// command (#2040).
	it("hand a staged review a command printing the marker command with every flag, in a worktree too", () => {
		expect(fragment("review-tier-escalated")).toContain(
			"Record it with the marker script, worktree too: `scripts/lib/rule-text.sh review-hold`.",
		);
		const hold = execFileSync("bash", [RULE_TEXT, "review-hold"], {
			encoding: "utf8",
		});
		expect(hold.trim()).toBe(fragment("review-hold"));
		expect(hold).toMatch(
			/^ {2}node scripts\/write-review-marker\.js .*--paths /m,
		);
		expect(hold).toContain("A worktree commit is not held");
	});

	// #1625's re-measure checker parses these records off the tracker.
	it("name the record formats and the pin exactly as the re-measure checker reads them", () => {
		const records = fragment("review-tier-records");
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
		expect(fragment("review-tier-records")).toContain(pinned);
		expect(fragment("review-hold")).toContain(pinned);
		expect(fragment("review-hold")).toContain(
			"`git diff HEAD $t -- <commit paths>`",
		);
	});
	/** A `git …` command a rule spells, its placeholders filled. */
	const spelled = (
		id: string,
		lead: RegExp,
		fill: Record<string, string>,
	): string => {
		const cmd = new RegExp(`${lead.source}\`git (.+?)\``).exec(fragment(id));
		expect(cmd).not.toBeNull();
		return git(
			...Object.entries(fill)
				.reduce((c, [hole, value]) => c.replace(hole, value), cmd?.[1] ?? "")
				.split(" "),
		);
	};
	const replay = (base: string, tree: string, paths: string) =>
		spelled("review-tier-records", /Replay: /, {
			"<base>": base,
			"<tree-sha>": tree,
			"<marker paths=>": paths.replaceAll(",", " "),
		});
	const pin = (args: string[]) =>
		runInProcess(COMMIT_PATHS, ["--tree", ...args], {
			cwd: repo,
			env: env(),
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
		const patch = path.join(dir, "hunk.patch");
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
		const runs = spelled("review-tier-escalated", /diff /, {
			$t: tree,
			"<commit paths>": "quote.ts tax.ts",
		});
		expect(runs).not.toContain("+20");
		expect(replay(head, tree, "quote.ts,tax.ts")).toBe(runs);
		expect(
			spelled("review-hold", /fixed point `HEAD`, diff /, {
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
		const runs = spelled("review-hold", /fixed point that sha, diff /, {
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
describe("the tier block's gp_rule branches", () => {
	it("are the shared ids plus each subset of the optional ones", () => {
		const lists = [
			...fs.readFileSync(HOOK, "utf8").matchAll(/^\s*gp_rule ([^\n]+)$/gm),
		].map((m) => m[1].split(" "));
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
