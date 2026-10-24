// @vitest-environment node
/*
 * guard-commit-form.sh (mantahostels#117) carries mantahostels#109's three-way split: warn on `git add`,
 * DENY on the sweeping commit forms, warn on a bare commit while the index holds
 * something. Two of those verdicts are only defensible while they cannot wedge
 * sanctioned work, so every allow-case below is a shape that would otherwise be
 * a false positive; do not thin them out.
 *
 * The guard compares the target tree against CLAUDE_PROJECT_DIR's, so a
 * throwaway repo stands in for the shared tree and a worktree of it for the
 * exempt case.
 *
 * The guard runs on every Bash call as a `PreToolUse` hook in
 * `self-plugin/hooks/hooks.json` and `hooks/hooks.json`: loosen a deny case and
 * a sweeping `git add -A`-style commit lands a neighbour's half-written files
 * in the shared tree; lose an allow case and a pathspec commit is wedged.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeFailOpenLog, failOpenLogPath } from "./guard-log-fixture";
import { describeSharedParserLibrary } from "./guard-parse-fixture";
import {
	defineTemplate,
	mkDirOutsideRepo,
	mkScratchDir,
	trioTemplate,
} from "./lib/git-fixture";
import {
	buildBashPayload,
	type GuardSpawn,
	guardOutput,
	spawnGuard,
} from "./lib/pretool-guard-testkit";
import { runInProcess } from "./lib/run-in-process";

const GUARD = path.resolve(__dirname, "guard-commit-form.sh");
// A guess, as the file's other spawning cases: two guard spawns and a git
// fixture commit overrun vitest's 5 s default on a loaded machine.
const cpTimeoutMs = 30_000;
const ARBITER = path.resolve(__dirname, "session-arbiter.js");

// The arbiter is CommonJS, spawned as a plain node script by a bash hook. It is
// required here only to ARRANGE a foreign claim the guard then reads back.
// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const store: any = createRequire(__filename)("./lib/arbiter-store.js");
// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const proc: any = createRequire(__filename)("./lib/arbiter-proc.js");

let dir: string;
let shared: string;
let worktree: string;
let elsewhere: string;
/** The write ledger's root, pointed at the temp dir so no test reads ~/.claude. */
let config: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

/*
 * THE FIXTURE IS BUILT ONCE AND COPIED (mantahostels#2016), not rebuilt per test, via
 * scripts/lib/git-fixture.ts (mantahostels#2068) — its own header explains what a
 * naive copy breaks and why.
 */
const template = defineTemplate(trioTemplate());

type Verdict = "deny" | "warn" | "allow";

/** Where and as whom the guard runs, as Claude Code would run it. */
const spawnAt = (
	cwd = shared,
	session: string | null = "test",
	extraEnv: NodeJS.ProcessEnv = {},
): GuardSpawn => ({
	project: shared,
	config,
	cwd,
	env: {
		// Otherwise a real session's id leaks in as the guard's fallback and the
		// no-session case reads as attributable.
		CLAUDE_CODE_SESSION_ID: session === null ? "" : session,
		...extraEnv,
	},
});

/** Runs the guard on `command`, as Claude Code would. */
const run = (
	command: string,
	cwd = shared,
	session: string | null = "test",
	extraEnv: Record<string, string> = {},
) =>
	spawnGuard(
		GUARD,
		buildBashPayload(command, session),
		spawnAt(cwd, session, extraEnv),
	).stdout ?? "";

/**
 * Runs the arbiter CLI, failing the test on a non-zero exit — runInProcess,
 * unlike the execFileSync it replaced, does not throw on one itself.
 */
const arbiter = (args: string[], extraEnv: Record<string, string> = {}) => {
	const r = runInProcess(ARBITER, args, {
		cwd: shared,
		env: {
			...process.env,
			CLAUDE_PROJECT_DIR: shared,
			CLAUDE_CONFIG_DIR: config,
			...extraEnv,
		},
	});
	if (r.status !== 0)
		throw new Error(
			`session-arbiter.js ${args.join(" ")} exited ${r.status}\n${r.stdout}${r.stderr}`,
		);
	return r.stdout;
};

/** What record-write.sh does after an Edit: note that `session` wrote `file`. */
const recordWrite = (file: string, session = "test") =>
	arbiter(["record", file, session]);

/* The store's Node accessor, so a test asks for a rule by id rather than
 * holding a second copy of its text. CommonJS, hence the require. Typed at the
 * seam, not suppressed: a `biome-ignore` stops applying once the formatter
 * wraps the expression under it. */
const { MODULES } = createRequire(__filename)("./lib/workflow-core-config") as {
	MODULES: string[];
};
const { ruleText: storeText, ruleIds } = createRequire(__filename)(
	"./lib/rule-text",
) as {
	ruleText: (id: string) => string;
	ruleIds: () => string[];
};

/** A fragment as the guard renders it in the fixture host: push-cadence's
 * `{command:}` lines expand against the host's config, read at call time. */
const ruleText = (id: string) => {
	const saved = process.env.CLAUDE_PROJECT_DIR;
	process.env.CLAUDE_PROJECT_DIR = shared;
	try {
		return storeText(id);
	} finally {
		if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
		else process.env.CLAUDE_PROJECT_DIR = saved;
	}
};

const verdict = (
	command: string,
	cwd = shared,
	extraEnv: Record<string, string> = {},
): Verdict => {
	const out = run(command, cwd, "test", extraEnv);
	if (/"permissionDecision"\s*:\s*"deny"/.test(out)) return "deny";
	// A warn is an advisory with no decision — and so, since mantahostels#1647, is the
	// pre-emptive rule injection, which shares the envelope. They are told apart
	// by content: gp_rule emits WHOLE FRAGMENTS joined by a blank line and
	// nothing else, so a context that is exactly that is an ALLOW which also
	// handed over its rules, never a finding about this command.
	//
	// Every block is checked, not just the first: since mantahostels#1805 the call carries
	// up to seven ids and which of them arrive depends on the paths the commit
	// names, so an equality against one fragment would read six legitimate
	// scopes as warnings. Their own tests are the mantahostels#1647 and mantahostels#1805 blocks below;
	// every other case here is about the verdict.
	if (/"additionalContext"/.test(out)) {
		const ctx = JSON.parse(out).hookSpecificOutput.additionalContext as string;
		// Subtractive, not a split on the "\n\n" separator: fragments carry blank
		// lines of their own, so splitting on it cuts inside one.
		let rest = ctx;
		for (const id of ruleIds() as string[]) {
			const text = ruleText(id) as string;
			if (rest.includes(text)) rest = rest.replace(text, "");
		}
		return rest.trim() === "" ? "allow" : "warn";
	}
	return "allow";
};

/** The refusal `command` earns, as the session reads it. Throws on an allow. */
const denyReason = (
	command: string,
	cwd = shared,
	extraEnv: Record<string, string> = {},
) => {
	const out = run(command, cwd, "test", extraEnv);
	if (!out.trim()) throw new Error(`expected a deny for: ${command}`);
	return JSON.parse(out).hookSpecificOutput.permissionDecisionReason as string;
};

/* The framing line of the sweeping-index refusal (mantahostels#2145). The guard's other
 * deny — `--no-verify` — carries its own, so a verdict alone cannot tell them
 * apart. */
const SWEEPS = "This commit form sweeps the shared index";

/* The framing line of the `--amend` refusal (mantahostels#2540, mantahostels#2145). */
const AMEND = "This amend rewrites whichever commit is `main`'s tip right now";

/* The framing line of the closing-keyword refusal (#129). */
const CLOSES = "This commit message closes an issue server-side";

/* The framing line of the `--no-verify` refusal (mantahostels#975). */
const NO_VERIFY =
	"This flag skips none of the pre-commit gates on a plain commit or merge";

/** Puts something in the shared index, which is what the bare-commit warn reads. */
const stageSomething = (at = shared, file = "a.md") => {
	fs.writeFileSync(path.join(at, file), `${Math.random()}\n`);
	git(at, "add", file);
};

beforeEach(() => {
	dir = mkScratchDir("guard-commit-form-");
	config = path.join(dir, "config");
	shared = path.join(dir, "shared");
	worktree = path.join(dir, "wt");
	elsewhere = path.join(dir, "elsewhere");
	template.instantiate(dir);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("the sweeping commit forms are denied", () => {
	it.each([
		["git commit -a", "takes every dirty tracked file"],
		['git commit -am "msg"', "the bundled form, and the common one"],
		['git commit -a -m "msg"', "unbundled"],
		['git commit --all -m "msg"', "the long spelling"],
		['git commit -i -m "msg" -- a.md', "index plus your paths"],
		['git commit --include -m "msg" -- a.md', "the long spelling of -i"],
		['git commit --inc -m "msg" -- a.md', "--inc is unambiguously --include"],
		['git commit -vam "msg"', "buried mid-bundle"],
		['npm run check && git commit -am "msg"', "later in a chain"],
		['GIT_PAGER=cat git commit -am "msg"', "behind an env assignment"],
		['(git commit -am "msg")', "inside a subshell"],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("deny");
		expect(denyReason(command)).toContain(SWEEPS);
	});

	it("denies even with a clean index — the harm is -a's, not the index's", () => {
		expect(git(shared, "diff", "--cached", "--name-only")).toBe("");
		expect(verdict('git commit -am "msg"')).toBe("deny");
		expect(denyReason('git commit -am "msg"')).toContain(SWEEPS);
	});

	it("outranks a warn found earlier in the same chain", () => {
		expect(verdict('git add a.md && git commit -am "msg"')).toBe("deny");
		// The sweeping refusal, not the `git add` warn dressed as one.
		expect(denyReason('git add a.md && git commit -am "msg"')).toContain(
			SWEEPS,
		);
	});

	it("does not leak the quote-masking sentinel into the message", () => {
		// The reason echoes the parsed segment, which has its quoted spans blanked.
		expect(run('git commit -am "Re-derive the figures"')).not.toContain("QSTR");
	});
});

/*
 * mantahostels#975. `--no-verify` stands down every pre-commit hook at once. It is a DENY
 * on the same reasoning as the sweeping forms (mantahostels#109): zero legitimate uses, and
 * no escape a session can spell for itself.
 */
describe("--no-verify is denied — it silently disables the secrets scan", () => {
	it.each([
		['git commit --no-verify -m "msg" -- a.md', "the full spelling"],
		[
			'git commit -n -m "msg" -- a.md',
			"the short form git reads as --no-verify",
		],
		['git commit --no-verif -m "msg" -- a.md', "an unambiguous abbreviation"],
		['git commit --no-veri -m "msg" -- a.md', "the shortest unambiguous one"],
		['git commit -nm "msg" -- a.md', "bundled ahead of the message flag"],
		['git commit -vn -m "msg" -- a.md', "bundled behind another short flag"],
		['npm run check && git commit -n -m "msg" -- a.md', "later in a chain"],
		['git commit --no-verify --amend -m "msg" -- a.md', "amending"],
		// Behind a reserved word (#1013).
		['{ git commit --no-verify -m "msg" -- a.md; }', "in a brace group"],
		['! git commit --no-verify -m "msg" -- a.md', "negated"],
		['if true; then git commit --no-verify -m "msg" -- a.md; fi', "in an if"],
		[
			'for f in a.md; do git commit --no-verify -m "msg" -- $f; done',
			"in a for loop",
		],
		[
			'while true; do git commit --no-verify -m "msg" -- a.md; done',
			"in a while loop",
		],
	])("%s — %s", (command) => {
		// exempt (mantahostels#2145): every `--no-verify` route shares one refusal, pinned by
		// "says what the flag skips, and offers no override" below.
		expect(verdict(command)).toBe("deny");
	});

	it("says what the flag skips, and offers no override", () => {
		const out = JSON.parse(run('git commit --no-verify -m "msg" -- a.md'));
		const msg = out.hookSpecificOutput.permissionDecisionReason;
		expect(msg).toContain("secrets scan");
		// The git-hook escape is named as the founder's, never handed over as a
		// command (#916).
		expect(msg).toContain("are the founder's to set, never yours");
		expect(msg).not.toContain("WFC_ALLOW_BRANCH=1");
	});

	it("does not leak the quote-masking sentinel into the message", () => {
		expect(run('git commit -n -m "Re-derive the figures"')).not.toContain(
			"QSTR",
		);
	});

	it.each([
		["git add -n .", "add's -n is --dry-run"],
		["git add -vN new.md", "and -N there is intent-to-add"],
	])("%s — %s, so it is allowed", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it.each([
		[
			'git commit --no-ver -m "msg" -- a.md',
			"ambiguous with --no-verbose, so git rejects it and nothing commits",
		],
		[
			'git commit -m "msg" -- --no-verify',
			"a path named that, past the -- separator",
		],
		[
			'git commit -m "never --no-verify" -- a.md',
			"the flag named inside the commit message",
		],
		['echo "git commit --no-verify"', "text that merely mentions it"],
		['{ git commit -m "msg" -- a.md; }', "a plain commit in a brace group"],
		[
			'if true; then git commit -m "msg" -- a.md; fi',
			"a plain commit in an if",
		],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it("is denied mid-merge too — a merge never needs the hooks skipped", () => {
		// The other three verdicts stand down mid-sequence because staging is
		// unavoidable there.
		git(shared, "checkout", "-q", "-b", "other");
		fs.writeFileSync(path.join(shared, "a.md"), "other\n");
		git(shared, "commit", "-qm", "other", "--", "a.md");
		git(shared, "checkout", "-q", "main");
		fs.writeFileSync(path.join(shared, "a.md"), "main\n");
		git(shared, "commit", "-qm", "main", "--", "a.md");
		expect(() => git(shared, "merge", "other")).toThrow();
		expect(verdict("git commit --no-verify")).toBe("deny");
	});

	it("outranks the bare-commit warn found in the same command", () => {
		stageSomething();
		expect(verdict('git commit -n -m "msg"')).toBe("deny");
	});

	it("does not read --no-edit as --no-verify", () => {
		// Denied, but for the AMEND reason — which is what proves it.
		const reason = denyReason('git commit --no-edit --amend -m "msg" -- a.md');
		expect(reason).toContain(AMEND);
		expect(reason).not.toContain("--no-verify");
	});

	it("is denied in a linked worktree too, the first verdict that was (mantahostels#1213)", () => {
		// The three index verdicts protect the SHARED index, which a worktree does
		// not have, and the `--amend` deny (mantahostels#2540) guards main's tip, which a
		// worktree's detached HEAD is not.
		// This one protects the secrets scan and the rest of the pre-commit gates,
		// which since mantahostels#344 a worktree runs too — so the shared-tree scoping it
		// inherited from the guard's structure exempted nothing it should have.
		expect(verdict('git commit --no-verify -m "msg"', worktree)).toBe("deny");
		expect(verdict('git commit -n -m "msg"', worktree)).toBe("deny");
		expect(
			verdict(`git -C ${worktree} commit --no-verify -m "m"`, shared),
		).toBe("deny");
	});

	it("is denied mid-merge in a worktree too — both stand-downs at once", () => {
		// The combination mantahostels#1213 made reachable: before it, the walk never reached a
		// worktree at all, so this pair was untestable.
		git(worktree, "checkout", "-q", "-b", "wt-other");
		fs.writeFileSync(path.join(worktree, "a.md"), "other\n");
		git(worktree, "commit", "-qm", "other", "--", "a.md");
		git(worktree, "checkout", "-q", "side");
		fs.writeFileSync(path.join(worktree, "a.md"), "side\n");
		git(worktree, "commit", "-qm", "side", "--", "a.md");
		expect(() => git(worktree, "merge", "wt-other")).toThrow();
		expect(verdict("git commit --no-verify", worktree)).toBe("deny");
		// And the three index verdicts stay silent, held off by the tree scope
		// rather than by the mid-sequence stand-down.
		expect(verdict('git commit -am "msg"', worktree)).toBe("allow");
	});

	it("is still allowed in an unrelated repository", () => {
		// Widening the walk went as far as this repo, and no further.
		expect(verdict('git commit --no-verify -m "msg"', elsewhere)).toBe("allow");
		expect(verdict(`git -C ${elsewhere} commit --no-verify -m "m"`)).toBe(
			"allow",
		);
	});
});

/*
 * mantahostels#2540. `git commit --amend` in the shared tree amends whatever `main` points
 * at NOW. With several sessions committing every few minutes a neighbour's
 * commit lands between this session's own commit and its amend, and the amend
 * then rewrites the neighbour's commit under this session's message.
 *
 * Unlike `--no-verify` it is shared-tree-only and stands down mid-sequence.
 */
describe("`git commit --amend` is denied in the shared tree (mantahostels#2540)", () => {
	it.each([
		['git commit --amend -m "msg"', "the full spelling"],
		["git commit --amend --no-edit", "the common no-edit form"],
		["git commit --amend", "no other flag at all"],
		['git commit --amend -m "msg" -- a.md', "with a pathspec"],
		["git commit --am --no-edit", "--am, the shortest unambiguous prefix"],
		["git commit --ame --no-edit", "--ame"],
		["git commit --amen --no-edit", "--amen"],
		['git commit -v --amend -m "msg"', "behind an unrelated flag"],
		[
			'git commit -m "one" -- a.md && git commit --amend --no-edit',
			"later in a chain",
		],
	])("%s — %s", (command) => {
		// exempt (mantahostels#2145): every route shares one refusal, pinned by "the refusal
		// explains the race and names both escapes" below.
		expect(verdict(command)).toBe("deny");
	});

	it("the refusal explains the race and names both escapes", () => {
		const reason = denyReason("git commit --amend --no-edit");
		expect(reason).toContain(AMEND);
		expect(reason).toContain("a neighbouring session's commit routinely lands");
		expect(reason).toContain('git commit -m "…" -- <paths>');
		expect(reason).toContain("git worktree add --detach");
	});

	it("stands down in a linked worktree — a detached HEAD has no race", () => {
		expect(verdict("git commit --amend --no-edit", worktree)).toBe("allow");
		expect(verdict(`git -C ${worktree} commit --amend --no-edit`, shared)).toBe(
			"allow",
		);
	});

	it("stands down mid-merge, where the commit being amended is the replay's", () => {
		git(shared, "checkout", "-q", "-b", "other");
		fs.writeFileSync(path.join(shared, "a.md"), "other\n");
		git(shared, "commit", "-qm", "other", "--", "a.md");
		git(shared, "checkout", "-q", "main");
		fs.writeFileSync(path.join(shared, "a.md"), "main\n");
		git(shared, "commit", "-qm", "main", "--", "a.md");
		expect(() => git(shared, "merge", "other")).toThrow();
		expect(verdict("git commit --amend --no-edit")).toBe("allow");
	});

	it("is still allowed in an unrelated repository", () => {
		expect(verdict("git commit --amend --no-edit", elsewhere)).toBe("allow");
	});

	it.each([
		['git commit -m "msg" -- a.md', "an ordinary pathspec commit"],
		[
			'git commit --allow-empty -m "msg" -- a.md',
			"--allow-empty, which shares only the first two letters",
		],
		['git commit --author "a <a@b.c>" -m "m" -- a.md', "--author"],
		['git commit -m "amend the figures" -- a.md', "the word inside a message"],
	])("allows %s — %s", (command) => {
		expect(verdict(command)).not.toBe("deny");
	});

	it("--all is still the sweeping refusal, not this one", () => {
		// Both begin `--a`, and only the sweeping deny may claim `--all`.
		expect(denyReason('git commit --all -m "msg"')).toContain(SWEEPS);
	});
});

/*
 * mantahostels#1705 widened the same deny onto `git merge`, the second route that spells a
 * flag turning the gates off: `--no-verify` there skips `.husky/pre-merge-commit`,
 * which runs the whole of `.husky/pre-commit` over the merge's own content.
 * Nothing else about a merge is judged — it stages nothing — so the negative
 * cases below are as load-bearing as the positive one.
 */
describe("`git merge --no-verify` is denied on the same reasoning (mantahostels#1705)", () => {
	it.each([
		['git merge other -m "msg"', "no flag at all"],
		["git merge --squash other", "a merge with an unrelated flag"],
		["git merge --abort", "clearing a refused merge"],
		["git merge --continue", "finishing a conflicted one"],
		[
			"git merge -n other",
			"-n, which under `git merge` is --no-stat and skips no gate",
		],
		["git merge --no-stat other", "the same flag spelled in full"],
		["git merge --no-commit other", "a different --no- flag"],
		[
			'git merge -m "never --no-verify" other',
			"the flag named inside the merge message",
		],
		[
			"git merge -m --no-verify other",
			"the flag taken as -m's value, which is what gp_git_value_flags is for",
		],
		["git merge --log other", "an optional-argument flag on its own"],
		["git merge -X ours other", "a strategy option carrying a real value"],
		['echo "git merge --no-verify"', "text that merely mentions it"],
	])("%s — %s, so it is allowed", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it.each([
		["git merge --no-verify other", "the full spelling"],
		['git merge --no-verify -m "msg" other', "carrying a message"],
		["git fetch && git merge --no-verify other", "later in a chain"],
	])("%s — %s", (command) => {
		// exempt (mantahostels#2145): reason pinned by "names the merge hook the flag skips".
		expect(verdict(command)).toBe("deny");
	});

	it.each([
		["git merge --log --no-verify other", "--log, whose argument is optional"],
		["git merge -S --no-verify other", "-S, likewise"],
		["git merge --gpg-sign --no-verify other", "the same flag spelled in full"],
		["git merge -Skey --no-verify other", "-S with its key stuck on"],
	])("%s — %s, still denied", (command) => {
		/*
		 * Each value is optional and taken only stuck on, so git reads the
		 * --no-verify after it as the flag and runs `git merge --log --no-verify
		 * side` with the hooks off (measured on git 2.43.0, #302).
		 */
		expect(verdict(command)).toBe("deny");
	});

	it.each([
		["git merge -X --no-verify other", "a strategy option"],
		["git merge -s --no-verify other", "a strategy name"],
		["git merge --into-name --no-verify other", "the merged-into name"],
		["git merge --cleanup --no-verify other", "a cleanup mode"],
	])("%s — %s swallows --no-verify, so it is allowed", (command) => {
		// Measured at #302: git takes --no-verify as the value, and the hooks run.
		expect(verdict(command)).toBe("allow");
	});

	it("names the merge hook the flag skips", () => {
		const out = JSON.parse(run("git merge --no-verify other"));
		const msg = out.hookSpecificOutput.permissionDecisionReason;
		expect(msg).toContain("secrets scan");
		expect(msg).toContain("pre-merge-commit");
	});

	it("is denied in a linked worktree too, as the commit spelling is", () => {
		// Same reasoning as mantahostels#1213's: the gates it stands down are ones a worktree
		// runs (mantahostels#344), so the shared-tree scoping does not reach this verdict.
		expect(verdict("git merge --no-verify other", worktree)).toBe("deny");
	});

	it("is still allowed in an unrelated repository", () => {
		expect(verdict("git merge --no-verify other", elsewhere)).toBe("allow");
	});
});

/*
 * mantahostels#1706 widens the same deny onto the three replay routes. `--no-verify` there
 * skips `.husky/pre-commit` on the resolution commit that finishes a rebase,
 * cherry-pick or revert — the commit carrying bytes no parent ever held.
 */
describe("`--no-verify` is denied on rebase, cherry-pick and revert (mantahostels#1706)", () => {
	it.each([
		["git rebase main", "no flag at all"],
		["git rebase --continue", "finishing a conflicted rebase"],
		["git rebase --abort", "clearing a refused one"],
		["git cherry-pick abc123", "a plain cherry-pick"],
		["git cherry-pick --abort", "clearing a refused one"],
		["git revert --no-edit HEAD", "a plain revert"],
		[
			"git rebase -n main",
			"-n, which under `git rebase` is --no-stat and skips no gate",
		],
		[
			"git cherry-pick -n abc123",
			"-n, which here is --no-commit — the replay is finished by a gated commit",
		],
		["git revert -n HEAD", "the same flag under revert"],
		["git cherry-pick --no-commit abc123", "that flag spelled in full"],
		["git rebase --no-stat main", "a different --no- flag"],
		["git cherry-pick -m 1 abc123", "the mainline number, which -m takes here"],
		[
			"git cherry-pick -m --no-verify abc123",
			"the flag swallowed as -m's mainline value",
		],
		["git rebase --onto main side", "--onto, which takes a real value"],
		["git rebase -x --no-verify main", "the flag swallowed as -x's command"],
		["git rebase -C --no-verify main", "the same, as -C's context count"],
		['echo "git rebase --no-verify"', "text that merely mentions it"],
	])("%s — %s, so it is allowed", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it.each([
		["git rebase --no-verify main", "rebase, the full spelling"],
		["git rebase --no-veri main", "rebase's shortest unambiguous prefix"],
		["git cherry-pick --no-verify abc123", "cherry-pick, the full spelling"],
		["git revert --no-verify HEAD", "revert, the full spelling"],
		["git fetch && git rebase --no-verify main", "later in a chain"],
	])("%s — %s", (command) => {
		// `--no-veri` is rebase's floor, measured on git 2.43.0 at mantahostels#1706.
		// exempt (mantahostels#2145): one `--no-verify` refusal for all five routes, pinned by
		// "names pre-applypatch in the deny, so the reader knows what was skipped".
		expect(verdict(command)).toBe("deny");
	});

	it("denies a cherry-pick/revert flag today's git does not have", () => {
		/*
		 * Measured on git 2.43.0 at mantahostels#1706, and RE-measure it with a resolvable
		 * revision: given a ref git cannot resolve, git dies on the revision
		 * before it reports the flag.
		 *
		 * So this arm guards nothing today and is kept anyway. Only the full
		 * spelling — there is no abbreviation floor to honour on a flag that does
		 * not exist.
		 */
		expect(verdict("git cherry-pick --no-verify abc123")).toBe("deny");
		expect(verdict("git cherry-pick --no-v abc123")).toBe("allow");
		expect(verdict("git revert --no-ver HEAD")).toBe("allow");
	});

	it.each([
		[
			"git rebase -S --no-verify main",
			"a signing flag with no value of its own",
		],
		["git rebase -m --no-verify main", "-m, which under rebase is --merge"],
		[
			"git cherry-pick -x --no-verify abc123",
			"a boolean flag under cherry-pick",
		],
	])("%s — %s, still denied", (command) => {
		// Unlisted value-taking flags err toward the deny (mantahostels#1705).
		expect(verdict(command)).toBe("deny");
	});

	it("is denied in a linked worktree too, as the other spellings are", () => {
		expect(verdict("git rebase --no-verify main", worktree)).toBe("deny");
	});

	it("is still allowed in an unrelated repository", () => {
		expect(verdict("git cherry-pick --no-verify abc123", elsewhere)).toBe(
			"allow",
		);
	});
});

/*
 * mantahostels#1707 finishes the widening on `git am`, the last route in mantahostels#1687's table.
 * `--no-verify` there skips `.husky/pre-applypatch`, the ONLY hook `git am`
 * offers — no `pre-commit`, no `prepare-commit-msg`, no `commit-msg`.
 *
 * `git am` is also the one subcommand of the five where `-n` must NOT be read
 * as `--no-verify`: it is `--no-scissors`, which changes how the patch's
 * message is cut and skips no hook at all.
 */
describe("`--no-verify` is denied on `git am` (mantahostels#1707)", () => {
	it.each([
		["git am patch.mbox", "no flag at all"],
		["git am --abort", "clearing a refused apply"],
		["git am --skip", "skipping the patch it stopped on"],
		["git am -3 patch.mbox", "the three-way fallback"],
		[
			"git am -n patch.mbox",
			"-n, which under `git am` is --no-scissors and skips no gate",
		],
		["git am --no-scissors patch.mbox", "that flag spelled in full"],
		["git am --no-utf8 patch.mbox", "a different --no- flag"],
		[
			"git am --directory --no-verify patch.mbox",
			"the flag swallowed as --directory's value, exactly as git reads it",
		],
		["git am -p --no-verify patch.mbox", "the same, under -p's strip count"],
		['echo "git am --no-verify"', "text that merely mentions it"],
	])("%s — %s, so it is allowed", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it.each([
		["git am --no-verify patch.mbox", "the full spelling"],
		["git am --no-v patch.mbox", "am's shortest unambiguous prefix"],
		["git am --no-ver patch.mbox", "a prefix in between"],
		["git am -3 --no-verify patch.mbox", "after a boolean flag"],
		["git fetch && git am --no-verify patch.mbox", "later in a chain"],
	])("%s — %s", (command) => {
		// `--no-v` is am's floor, measured on git 2.43.0 at mantahostels#1707: no other
		// `--no-v…` option exists under `am`, so git resolves it to --no-verify
		// and skips the hook. Every longer prefix resolves the same way.
		// exempt (mantahostels#2145): reason pinned by "names pre-applypatch in the deny, so
		// the reader knows what was skipped" below.
		expect(verdict(command)).toBe("deny");
	});

	it("names pre-applypatch in the deny, so the reader knows what was skipped", () => {
		const out = JSON.parse(run("git am --no-verify patch.mbox"));
		const reason = out.hookSpecificOutput.permissionDecisionReason as string;
		expect(reason).toContain("pre-applypatch");
		// The one named escape is for a DIFFERENT check and stays the only one.
		expect(reason).toContain("There is no override, deliberately");
	});

	it("is denied in a linked worktree too, as the other spellings are", () => {
		expect(verdict("git am --no-verify patch.mbox", worktree)).toBe("deny");
	});

	it("is still allowed in an unrelated repository", () => {
		expect(verdict("git am --no-verify patch.mbox", elsewhere)).toBe("allow");
	});
});

/*
 * THE PRE-EMPTIVE LIMB (mantahostels#1647, spec mantahostels#1762).
 *
 * The three verdicts above fire ON the mistake. This fires ON the command, on
 * the clean branch, and hands the session the rule before it commits wrongly.
 *
 * Expectations are keyed by FRAGMENT ID, never by a string literal copied out
 * of the fragment; the mutation anchors below are the deliberate exception, on
 * the reasoning guard-branch.test.ts states in full.
 */
describe("the rule reaches a session BEFORE it mis-commits (mantahostels#1647)", () => {
	// What a commit naming no gated path is handed, in gp_rule's order: the
	// three act rules, then the push rule (#2022, #2285).
	const plainCommitRules = [
		"commit-pathspec",
		"commit-show-diff",
		"commit-message",
		"push-cadence",
	];
	const commitRule = () =>
		plainCommitRules.map((id) => ruleText(id)).join("\n\n");

	/** The whole hook output for `command`, parsed. Null where it said nothing. */
	const emission = (command: string, session = "test", cwd = shared) =>
		guardOutput(
			GUARD,
			buildBashPayload(command, session),
			spawnAt(cwd, session),
		);

	it("a correct pathspec commit is handed the rule and NOT refused", () => {
		const out = emission('git commit -m "x" -- a.md');
		expect(out).not.toBeNull();
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toBe(commitRule());
	});

	/*
	 * MUTATION ANCHORS. `toBe(commitRule())` reads the same file the guard does,
	 * so it moves with a mutation to the fragment instead of catching it. One
	 * short literal per clause a session must actually receive, chosen to break
	 * if the clause is deleted and to survive an ordinary reword.
	 */
	it.each([
		["COMMIT BY PATHSPEC", "the operative instruction itself"],
		["#63", "the incident, without which the rule is a bare assertion"],
		["repo-global", "why the index is the hazard"],
		["git add -N", "the exception for a file git does not track"],
		["#1539", "the working-tree hazard, a second incident"],
		["merge or rebase", "the one place staging is unavoidable"],
		["advisory", "the silence condition: a warn does not stop the commit"],
	])("the injection still carries %s — %s", (clause) => {
		expect(emission('git commit -m "x" -- a.md').additionalContext).toContain(
			clause,
		);
	});

	it("says it once per session, and again for a different session", () => {
		expect(emission('git commit -m "x" -- a.md', "sess-A")).not.toBeNull();
		expect(emission('git commit -m "x" -- a.md', "sess-A")).toBeNull();
		expect(emission('git commit -m "x" -- a.md', "sess-B")).not.toBeNull();
	}, 30_000);

	it("a warn outranks it, and leaves it unlatched for the next commit", () => {
		// A warn already carries the specific hazard it found; appending the
		// general rule underneath would bury it. The rule is not spent — the next
		// clean commit in the same session still gets it.
		stageSomething();
		const warned = emission('git commit -m "x"', "sess-C");
		expect(warned.additionalContext).toContain("takes the whole index");
		expect(warned.additionalContext).not.toContain("COMMIT BY PATHSPEC");
		git(shared, "commit", "-qm", "drain");
		expect(
			emission('git commit -m "x" -- a.md', "sess-C").additionalContext,
		).toBe(commitRule());
		// Three guard spawns and a real commit; the 5 s default is too tight on a
		// loaded machine, and a timeout here reads as a behaviour change.
	}, 30_000);

	it("a deny carries its own refusal, not the rule as context", () => {
		const out = emission('git commit -am "x"');
		expect(out.permissionDecision).toBe("deny");
		expect(out.permissionDecisionReason).toContain(SWEEPS);
		expect(out.additionalContext).toBeUndefined();
	});

	it.each([
		["git merge other", "the merge family stages no pathspec"],
		["git rebase main", "nor does a rebase"],
		["git cherry-pick HEAD", "nor a cherry-pick"],
		["git push origin main", "not an index command at all"],
		["npm run test", "not git at all"],
	])("%s is handed nothing — %s", (command) => {
		expect(emission(command)).toBeNull();
	});

	it("a payload with no session id is handed nothing, rather than wedging", () => {
		// gp_rule's payload side keeps the house fail-open (mantahostels#103 §6): it cannot
		// latch what it cannot key, so it says nothing and allows.
		expect(run('git commit -m "x" -- a.md', shared, null)).toBe("");
	});

	it.each([
		["SHOW THE DIFF", "the diff limb"],
		["Conventional", "the banned prefix"],
		["AT MOST 72 CHARACTERS", "the subject's cap"],
		["THE BODY GIVES THE WHY", "where the why goes"],
		["Push before the turn's", "the push owed this turn"],
		["why the push is held", "the one alternative to pushing"],
	])("the injection carries %s — %s", (clause) => {
		expect(emission('git commit -m "x" -- a.md').additionalContext).toContain(
			clause,
		);
	});

	it.each([
		['node scripts/commit-paths.js -m "x" -- a.md', "the house commit route"],
		[
			'node "$CLAUDE_PROJECT_DIR"/scripts/commit-paths.js -m "x" -- a.md',
			"spelled at the project root",
		],
	])(
		"%s is handed the show-the-diff, message and push rules alone — %s",
		(command) => {
			// It runs no git the walk sees, and already commits by pathspec (#2022).
			expect(
				emission(command, `cp-${command.replace(/\W+/g, "-")}`)
					.additionalContext,
			).toBe(
				["commit-show-diff", "commit-message", "push-cadence"]
					.map((id) => ruleText(id))
					.join("\n\n"),
			);
		},
	);

	it(
		"hands the push rule on a session's first commit-paths.js call and not its second (#2285)",
		() => {
			const command = 'node scripts/commit-paths.js -m "x" -- a.md';
			const push = ruleText("push-cadence");
			expect(emission(command, "cp-push").additionalContext).toContain(push);
			expect(emission(command, "cp-push")).toBeNull();
		},
		cpTimeoutMs,
	);

	it(
		"hands the landing twin of the push rule where `landing` is on (#2285)",
		() => {
			const ctx = guardOutput(
				GUARD,
				buildBashPayload('git commit -m "x" -- a.md', "landing"),
				spawnAt(shared, "landing", { WFC_MODULES: "landing" }),
			).additionalContext;
			expect(ctx).toContain(ruleText("push-cadence-landing"));
			expect(ctx).not.toContain("FINDS EVERY COMMIT BEING PUSHED COVERED");
		},
		cpTimeoutMs,
	);

	it("a node script that is not commit-paths.js is handed nothing", () => {
		expect(emission("node scripts/other.js -m x -- a.md")).toBeNull();
	});

	it("hands a root .md commit the act and push rules and nothing else", () => {
		// `a.md` is outside the mapped scope, is neither roadmap file, holds no
		// guard-registry region and is not a language Biome parses — so every one
		// of mantahostels#1805's §Gotchas ids is scoped out and this is the whole emission.
		const emitted = emission('git commit -m "x" -- a.md').additionalContext;
		expect(emitted).toBe(commitRule());
		// The four rules' 2,399 B at #2285 with the core root's spelling dropped,
		// as it varies by checkout, rounded up: a fragment growing past it is a
		// decision about every session's first commit.
		const pathless = emitted.replaceAll(path.resolve(__dirname, ".."), "");
		expect(Buffer.byteLength(pathless, "utf8")).toBeLessThan(2450);
	});
});

/*
 * THE §GOTCHAS CLUSTER ON THIS TRIGGER (mantahostels#1805, spec mantahostels#1762).
 *
 * Six more rules share `git commit`, and which of them a session is handed
 * turns on what the commit ACTUALLY NAMES — the ticket's acceptance criterion,
 * against the blanket per-subcommand request that would spend gp_rule's
 * 4,000-byte ceiling on rules that cannot fire.
 *
 * The scoping is expressed as an EXCLUSION (gp_rule_skip) rather than a
 * selection, because scripts/check-guard-registry.js reads the literal ids at
 * the call site: ids assembled into an array would every one report
 * UNPRINTED-RULE and the store's third assertion would stop meaning anything.
 */
const MODULES_ON = { WFC_MODULES: "roadmap,governance" };

describe("the §Gotchas rules are scoped by what the commit names (mantahostels#1805)", () => {
	/** The whole hook output for `command`, parsed. Null where it said nothing. */
	const emission = (
		command: string,
		session = "test",
		cwd = shared,
		env: Record<string, string> = MODULES_ON,
	) =>
		guardOutput(
			GUARD,
			buildBashPayload(command, session),
			spawnAt(cwd, session, env),
		);

	/** The fragment ids present in one emission, in the store's own order. */
	const idsIn = (
		command: string,
		session: string,
		env: Record<string, string> = MODULES_ON,
	) => {
		const out = emission(command, session, shared, env);
		if (!out) return [];
		const ctx = out.additionalContext as string;
		return (ruleIds() as string[]).filter((id) => ctx.includes(ruleText(id)));
	};

	/* Files the shared fixture repo does not carry, staged per case so the
	 * pathspec resolves against something real. */
	const withPaths = (...paths: string[]) => {
		for (const rel of paths) {
			fs.mkdirSync(path.dirname(path.join(shared, rel)), { recursive: true });
			fs.writeFileSync(path.join(shared, rel), "x\n");
		}
		git(shared, "add", ...paths);
		git(shared, "commit", "-qm", "fixture");
	};

	it.each([
		[
			"a mapped-scope path is handed the doc-map rule",
			["docs/x.md"],
			"doc-map-precommit",
			true,
		],
		[
			"a commit touching no docs/ path is not",
			["app/x.ts"],
			"doc-map-precommit",
			false,
		],
		[
			"either roadmap file alone is handed the digest rule",
			["docs/roadmap-digest.md"],
			"digest-version-drift",
			true,
		],
		[
			"a docs/ commit naming neither roadmap file is not",
			["docs/x.md"],
			"digest-version-drift",
			false,
		],
		[
			"a guard is handed the registry rule",
			["scripts/x.sh"],
			"guard-registry-gate",
			true,
		],
		[
			"a commit reaching no region and no guard is not",
			["app/x.ts"],
			"guard-registry-gate",
			false,
		],
		[
			"a file Biome parses is handed the staged-gate rule",
			["app/x.ts"],
			"biome-staged-gate",
			true,
		],
		[
			"a commit of nothing Biome reads is not",
			["docs/x.md"],
			"biome-staged-gate",
			false,
		],
		[
			"a docs/ commit is handed the superseded rule",
			["docs/x.md"],
			"superseded-values-gate",
			true,
		],
		[
			"a commit outside docs/ is not",
			["app/x.ts"],
			"superseded-values-gate",
			false,
		],
		[
			"a docs/ commit is handed the machinery rule",
			["docs/x.md"],
			"machinery-superseded",
			true,
		],
		[
			"a commit outside docs/ is not handed the machinery rule",
			["app/x.ts"],
			"machinery-superseded",
			false,
		],
	])(
		"%s",
		(_name, paths, id, expected) => {
			withPaths(...(paths as string[]));
			const session = `scope-${_name.replace(/\W+/g, "-")}`;
			const got = idsIn(
				`git commit -m "x" -- ${(paths as string[]).join(" ")}`,
				session,
			);
			expect(got.includes(id as string)).toBe(expected);
			// Whatever the scope, the pathspec rule is never scoped out: it is about
			// the act, not about a gate that will judge the result.
			expect(got).toContain("commit-pathspec");
		},
		30_000,
	);

	/* A path each rule is scoped IN on, so only the module decides (#449). */
	it.each([
		["digest-version-drift", "roadmap", "docs/roadmap-digest.md"],
		["doc-map-precommit", "governance", "docs/x.md"],
		["superseded-values-gate", "governance", "docs/x.md"],
	])(
		"%s is handed only where %s is on",
		(id, module, file) => {
			withPaths(file);
			const cmd = `git commit -m "x" -- ${file}`;
			const tag = `module-${id}`;
			expect(idsIn(cmd, `${tag}-on`, { WFC_MODULES: module })).toContain(id);
			const others = MODULES.filter((m) => m !== module).join(",");
			expect(idsIn(cmd, `${tag}-off`, { WFC_MODULES: others })).not.toContain(
				id,
			);
		},
		30_000,
	);

	/*
	 * MUTATION ANCHORS, one clause per relocated bullet. The scope cases above
	 * key on the fragment ID and read the store through ruleText, so they move
	 * with a mutation to the fragment instead of catching it — these are what
	 * fails when a clause is cut out of one.
	 */
	it.each([
		[
			"docs/x.md",
			"doc-map-precommit",
			"#390",
			"the ticket that put it in pre-commit",
		],
		[
			"docs/x.md",
			"doc-map-precommit",
			"SKIPs, PRINTING NOTHING",
			"the mid-merge trap",
		],
		[
			"docs/roadmap-digest.md",
			"digest-version-drift",
			"COMMIT `docs/reference-roadmap.html` AND",
			"the headline imperative",
		],
		[
			"docs/roadmap-digest.md",
			"digest-version-drift",
			"check-digest-version.js",
			"the checker that fails",
		],
		[
			"docs/roadmap-digest.md",
			"digest-version-drift",
			"#910",
			"where it fires first",
		],
		[
			"scripts/x.sh",
			"guard-registry-gate",
			"THIS COMMIT REACHES THE GUARD REGISTRY",
			"the headline imperative",
		],
		[
			"scripts/x.sh",
			"guard-registry-gate",
			"--review",
			"the command that clears the WARN",
		],
		[
			"scripts/x.sh",
			"guard-registry-gate",
			"carries one that lies",
			"what it FAILs on",
		],
		[
			"app/x.ts",
			"biome-staged-gate",
			"READS ONLY THIS COMMIT'S OWN STAGED PATHS",
			"the headline imperative",
		],
		["app/x.ts", "biome-staged-gate", "#179", "the ticket that measured it"],
		[
			"app/x.ts",
			"biome-staged-gate",
			"biome migrate --write",
			"the one route it misses",
		],
		[
			"docs/x.md",
			"machinery-superseded",
			"percent spelling AND the\ndecimal",
			"both spellings, which is the whole obligation",
		],
		[
			"docs/x.md",
			"superseded-values-gate",
			"A SUPERSEDED FIGURE LEFT LIVE",
			"the headline imperative",
		],
		[
			"docs/x.md",
			"superseded-values-gate",
			"still\nbeing stated as current",
			"the operative middle limb",
		],
		[
			"docs/x.md",
			"superseded-values-gate",
			"#1474",
			"the pointer assertion that fires first",
		],
	])(
		"%s keeps %s's %s — %s",
		(file, _id, clause) => {
			withPaths(file as string);
			const out = emission(
				`git commit -m "x" -- ${file}`,
				`anchor-${(clause as string).replace(/\W+/g, "-")}`,
			);
			expect(out.additionalContext).toContain(clause);
		},
		30_000,
	);

	it.each([["git add -N docs/x.md", "intent-to-add is not committing"]])(
		"%s is handed the act and push rules alone — %s",
		(command) => {
			// SCOPING IS `commit`-ONLY. `git add` runs none of these gates, reads a
			// pre-add index, and contributes no pathspec words — scan_commit fills
			// those for `commit` alone — so scoping it would judge the wrong file set.
			// It still gets the act and push rules, which are unscoped.
			withPaths("docs/x.md");
			const got = idsIn(command, `add-${command.replace(/\W+/g, "-")}`);
			expect(got).toEqual([
				"commit-message",
				"commit-pathspec",
				"commit-show-diff",
				"push-cadence",
			]);
			// A plain `git add <path>` draws the staging warn instead, which
			// outranks the injection (mantahostels#1647).
		},
		30_000,
	);

	/*
	 * A commit-paths.js call is scoped off the paths it would land, as a
	 * `git commit` pathspec is (#2147). It never gets commit-pathspec: it already
	 * commits by pathspec (#2022).
	 */
	const commitPathsDocs = [
		"commit-show-diff",
		"commit-message",
		"doc-map-precommit",
		"guard-registry-gate",
		"superseded-values-gate",
		"machinery-superseded",
		"push-cadence",
	].sort();

	it(
		"a commit-paths.js call naming a docs/ path is handed the gate rules a git commit of it is (#2147)",
		() => {
			withPaths("docs/x.md");
			expect(
				idsIn('node scripts/commit-paths.js -m "x" -- docs/x.md', "cp-docs"),
			).toEqual(commitPathsDocs);
			// commit-pathspec fills the git commit's ceiling, so its push rule
			// defers to the next commit (#2285).
			const viaGit = idsIn('git commit -m "x" -- docs/x.md', "cp-docs-git");
			expect(viaGit.filter((id) => id !== "commit-pathspec")).toEqual(
				commitPathsDocs.filter((id) => id !== "push-cadence"),
			);
		},
		cpTimeoutMs,
	);

	it(
		"a commit-paths.js call naming no gated path is handed the act and push rules alone (#2147)",
		() => {
			expect(
				idsIn('node scripts/commit-paths.js -m "--" -- a.md', "cp-none"),
			).toEqual(["commit-message", "commit-show-diff", "push-cadence"]);
		},
		cpTimeoutMs,
	);

	it(
		"a commit-paths.js --patch call is scoped off the files its patch names (#2147)",
		() => {
			withPaths("docs/p.md");
			fs.writeFileSync(path.join(shared, "docs/p.md"), "x\ny\n");
			const patch = path.join(shared, "own.patch");
			fs.writeFileSync(patch, git(shared, "diff", "HEAD", "--", "docs/p.md"));
			try {
				expect(
					idsIn(
						'node scripts/commit-paths.js -m "x" --patch own.patch',
						"cp-patch",
					),
				).toEqual(commitPathsDocs);
			} finally {
				fs.rmSync(patch);
				git(shared, "checkout", "--", "docs/p.md");
			}
		},
		cpTimeoutMs,
	);

	it("hands every path-scoped id over whole, under the ceiling, on the widest commit", () => {
		// Deferral of what does not fit is gp_rule's, covered in
		// lib/guard-parse.test.ts; this trigger's gate ids fit in one emission on
		// this repo's own modules. With governance on as well they do not (#449).
		withPaths("docs/roadmap-digest.md", "scripts/y.sh", "app/y.ts");
		const command =
			'git commit -m "x" -- docs/roadmap-digest.md scripts/y.sh app/y.ts';
		const ctx = emission(command, "wide", shared, { WFC_MODULES: "roadmap" })
			.additionalContext as string;
		expect(Buffer.byteLength(ctx, "utf8")).toBeLessThanOrEqual(4000);
		for (const id of [
			"commit-pathspec",
			"commit-show-diff",
			"commit-message",
			"digest-version-drift",
			"guard-registry-gate",
			"biome-staged-gate",
			"machinery-superseded",
		])
			expect(ctx).toContain(ruleText(id));
		// The push rule binds after the commit, so it is the id the ceiling
		// defers to the next commit (#2285).
		expect(ctx).not.toContain(ruleText("push-cadence"));
		expect(
			emission(command, "wide", shared, { WFC_MODULES: "roadmap" })
				.additionalContext,
		).toBe(ruleText("push-cadence"));
	}, 30_000);

	/*
	 * THE CLOSING-KEYWORD REFUSAL (mantahostels#2592, raised from an advisory injection to a
	 * deny at #129), the one verdict on this trigger decided by the commit's
	 * MESSAGE rather than by its paths.
	 */
	it.each([
		["closes #12", true, "the spelling the fragment names"],
		["Closes #12", true, "capitalised"],
		["CLOSES #12", true, "shouted"],
		["close #12", true, "the bare stem"],
		["closed #12", true, "the past tense"],
		["fixes #12", true, "the `fix` family, which the fragment does not spell"],
		["fix #12", true, "its stem"],
		["fixed #12", true, "its past tense"],
		["resolves #12", true, "the `resolve` family"],
		["resolve #12", true, "its stem"],
		["resolved #12", true, "its past tense"],
		["Closes: #12", true, "the trailer spelling, with a colon"],
		["Closes  #12", true, "spaced"],
		["refs #12", false, "the sanctioned form"],
		["see #12", false, "a bare citation"],
		["encloses #12", false, "a word merely ENDING in a keyword"],
		["closes the gap", false, "the keyword with no issue number after it"],
		["closes 12", false, "a number with no `#`"],
		/* mantahostels#2652's three spellings. GitHub honours the cross-repo and URL forms
		 * and closes on them, so a session writing one got no rule while the
		 * issue closed on the push anyway. */
		["closes owner/repo#12", true, "the cross-repo reference"],
		[
			"closes https://github.com/owner/repo/issues/12",
			true,
			"the issue URL, which carries no `#` at all",
		],
		[
			"fixes#12",
			true,
			"glued, which GitHub does not honour (#2660) — a deliberate overmatch",
		],
		[
			"closes hostels#12",
			false,
			"a bare repo name with no owner, which GitHub does not honour either",
		],
		[
			"closes https://github.com/owner/repo/pull/12",
			false,
			"a pull-request URL, which is not the issue-closing form",
		],
	])(
		"a message reading %s is refused, quoting what matched: %s (%s)",
		(message, expected, _why) => {
			withPaths("docs/msg.md");
			const command = `git commit -m "${message}" -- docs/msg.md`;
			if (!expected) {
				expect(verdict(command)).not.toBe("deny");
				return;
			}
			const reason = denyReason(command);
			expect(reason).toContain(CLOSES);
			// The refusal quotes back what matched, in the session's own case —
			// every positive case above is exactly its own match, boundary
			// characters aside.
			expect(reason).toContain(`What matched: \`${message}\``);
		},
		30_000,
	);

	it("reads a keyword in the SECOND -m, git joining them into one message", () => {
		withPaths("docs/msg2.md");
		const reason = denyReason(
			'git commit -m "tidy the injector" -m "Closes #2592" -- docs/msg2.md',
		);
		expect(reason).toContain("What matched: `Closes #2592`");
	}, 30_000);

	it("does not read a message passed by file, which is the rule's stated blind spot", () => {
		withPaths("docs/msg3.md");
		expect(verdict("git commit -F /tmp/msg.txt -- docs/msg3.md")).not.toBe(
			"deny",
		);
	}, 30_000);

	it("is refused in a linked worktree and mid-merge alike", () => {
		// Judged above the shared-tree gate and above the mid-sequence stand-down,
		// unlike the anti-contention verdicts: GitHub reads the pushed message,
		// so neither the tree the commit was written in nor a merge in progress
		// changes what it does (#129).
		expect(verdict('git commit -m "Closes #12"', worktree)).toBe("deny");
		git(worktree, "checkout", "-q", "-b", "wt-closes");
		fs.writeFileSync(path.join(worktree, "a.md"), "other\n");
		git(worktree, "commit", "-qm", "other", "--", "a.md");
		git(worktree, "checkout", "-q", "side");
		fs.writeFileSync(path.join(worktree, "a.md"), "side\n");
		git(worktree, "commit", "-qm", "side", "--", "a.md");
		expect(() => git(worktree, "merge", "wt-closes")).toThrow();
		expect(verdict('git commit -m "Closes #12"', worktree)).toBe("deny");
	}, 30_000);

	/* MUTATION ANCHOR: the cases above key on the framing line and the matched
	 * text, so the fragment the refusal splices in could be gutted under them. */
	it("states what to write instead, and that the amend is not the escape", () => {
		withPaths("docs/msg4.md");
		const reason = denyReason('git commit -m "Closes #12" -- docs/msg4.md');
		expect(reason).toContain("Write `Refs #n` instead");
		expect(reason).toContain("#2540");
	}, 30_000);
});

describe("`git add` warns, because it has legitimate uses a deny would wedge", () => {
	it.each([
		["git add a.md", "the plain form"],
		["git add -A", "the sweeping form"],
		["git add .", "the whole tree"],
		["git stage a.md", "add's synonym"],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("warn");
	});

	it.each([
		["git add -N new.md", "intent-to-add is the sanctioned new-file step"],
		["git add --intent-to-add new.md", "the long spelling"],
		["git add -vN new.md", "bundled with another short flag"],
		["git add -n .", "--dry-run stages nothing at all"],
		["git add --dry-run .", "the long spelling"],
	])("%s — %s, so it is silent", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it("emits the field Claude Code keys hookSpecificOutput off", () => {
		// A warn without hookEventName is dropped silently, leaving two of the
		// three verdicts inert.
		const out = JSON.parse(run("git add a.md"));
		expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
		expect(out.hookSpecificOutput.permissionDecision).toBeUndefined();
		expect(out.hookSpecificOutput.additionalContext).toContain("#63");
	});
});

describe("a bare commit warns only when the index actually holds something", () => {
	it("stays silent on a clean index — it would sweep nothing", () => {
		expect(verdict('git commit -m "msg"')).toBe("allow");
	});

	it("warns, naming what it would take, once something is staged", () => {
		stageSomething();
		expect(verdict('git commit -m "msg"')).toBe("warn");
		const out = JSON.parse(run('git commit -m "msg"'));
		expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
		expect(out.hookSpecificOutput.additionalContext).toContain("a.md");
	});

	it.each([
		['git commit -m "msg" -- a.md', "the pathspec form CLAUDE.md prescribes"],
		['git commit -m "msg" a.md', "a pathspec without the -- separator"],
		["git commit -- a.md", "a pathspec with the message left to the editor"],
	])("%s — %s, so it is silent", (command) => {
		stageSomething();
		expect(verdict(command)).toBe("allow");
	});

	it.each([
		["git commit", "no message: the editor still commits the whole index"],
	])("%s — %s", (command) => {
		stageSomething();
		expect(verdict(command)).toBe("warn");
	});

	it("does not read an option's value as a pathspec", () => {
		// Each of these ends in a word that is a value, not a path.
		stageSomething();
		for (const command of [
			"git commit -m msg",
			'git commit --message "msg"',
			"git commit -F msgfile",
			"git commit -t template.txt",
			"git commit -C HEAD",
			'git commit --author "A <a@b.c>"',
			"git commit --squash HEAD",
		]) {
			expect(verdict(command)).toBe("warn");
		}
	});

	it("reads a value glued to its flag without eating the next word", () => {
		// `-mmsg` carries its own value, so `a.md` after it IS a pathspec.
		stageSomething();
		expect(verdict("git commit -mmsg a.md")).toBe("allow");
		expect(verdict("git commit -mmsg")).toBe("warn");
	});

	it("reads a flag-shaped word after -- as the pathspec it is", () => {
		// Past a bare `--`, `-weird-file` is a path git will commit, not an
		// option, so the warn stays down (mantahostels#495, which put this guard on the
		// shared flag reader).
		stageSomething();
		expect(verdict('git commit -m "msg" -- -weird-file')).toBe("allow");
		expect(verdict('git commit -am "msg" -- -weird-file')).toBe("deny");
		expect(denyReason('git commit -am "msg" -- -weird-file')).toContain(SWEEPS);
	});

	it("reads a lone - as a pathspec, so it raises no warn", () => {
		// git knows no such option, so the command fails before it commits
		// anything — the fail-open reading (mantahostels#103 §6).
		stageSomething();
		expect(verdict("git commit -m msg -")).toBe("allow");
	});

	it("honours --pathspec-from-file as naming paths", () => {
		stageSomething();
		fs.writeFileSync(path.join(shared, "paths.txt"), "a.md\n");
		expect(verdict('git commit -m "msg" --pathspec-from-file paths.txt')).toBe(
			"allow",
		);
	});

	it("stays silent on --pathspec-from-file with no file after it", () => {
		// Another command git rejects outright, so it commits nothing.
		stageSomething();
		expect(verdict('git commit -m "msg" --pathspec-from-file')).toBe("allow");
	});
});

/*
 * mantahostels#182. Every case above puts its whole command on one line. A commit message
 * with a body does not, and that was enough to make the guard read the pathspec
 * wrong in BOTH directions — the cause being in the shared parser rather than
 * here (see guard-parse.test.ts, "logical lines").
 *
 * A commit naming pathspecs was warned at for naming none; and a genuinely
 * pathspec-less commit went unwarned whenever a leftover word on the message's
 * first line happened to read as a path.
 */
describe("a multi-line commit message leaves the pathspec in view", () => {
	const cases: [string, string][] = [
		[
			"a quoted message spanning lines",
			'git commit -m "Subject line\n\nBody."',
		],
		[
			"the heredoc-through-a-command-substitution form",
			"git commit -m \"$(cat <<'EOF'\nSubject line\n\nBody.\nEOF\n)\"",
		],
		[
			"a message body carrying a shell metacharacter",
			'git commit -m "Subject line\n\nBody (with parens); and more."',
		],
		[
			"a message whose first line is a single word",
			'git commit -m "Subject\n\nBody."',
		],
	];

	it.each(cases)("%s — silent when it names a pathspec", (_label, command) => {
		stageSomething();
		expect(verdict(`${command} -- a.md`)).toBe("allow");
	});

	it.each(cases)("%s — warns when it names none", (_label, command) => {
		stageSomething();
		expect(verdict(command)).toBe("warn");
	});

	it("names the staged path it would take, not a fragment of the message", () => {
		// A truncated segment could still warn while quoting words out of the
		// commit message.
		stageSomething();
		const out = JSON.parse(run('git commit -m "Subject line\n\nBody."'));
		expect(out.hookSpecificOutput.additionalContext).toContain("a.md");
		expect(out.hookSpecificOutput.additionalContext).not.toContain("Subject");
	});

	it("still denies a sweeping form carrying a multi-line message", () => {
		// The deny reads flags on the first line, so it never depended on the join.
		expect(verdict('git commit -am "Subject line\n\nBody."')).toBe("deny");
		expect(denyReason('git commit -am "Subject line\n\nBody."')).toContain(
			SWEEPS,
		);
	});
});

/*
 * mantahostels#118 (name the foreign staged file). The warn shipped by mantahostels#117 (the commit-form
 * guard) fired on any non-empty index, including a session's own staged work.
 */
describe("the bare-commit warn attributes the staged paths", () => {
	it("stays silent when every staged path is this session's own work", () => {
		stageSomething(shared, "a.md");
		recordWrite("a.md");
		expect(verdict('git commit -m "msg"')).toBe("allow");
	});

	it("names the foreign path, and leaves the session's own out of the list", () => {
		fs.writeFileSync(path.join(shared, "mine.md"), "mine\n");
		fs.writeFileSync(path.join(shared, "theirs.md"), "theirs\n");
		git(shared, "add", "mine.md", "theirs.md");
		recordWrite("mine.md");

		const out = JSON.parse(run('git commit -m "msg"'));
		const msg = out.hookSpecificOutput.additionalContext;
		expect(msg).toContain("theirs.md");
		expect(msg).not.toContain("mine.md");
		expect(msg).toContain("never wrote");
	});

	it("warns when one foreign path rides along with several of the session's own", () => {
		// The shape that matters: silence here would land the foreign file under
		// this session's message, which is mantahostels#63.
		for (const f of ["m1.md", "m2.md", "theirs.md"]) {
			fs.writeFileSync(path.join(shared, f), `${f}\n`);
			git(shared, "add", f);
		}
		recordWrite("m1.md");
		recordWrite("m2.md");
		expect(verdict('git commit -m "msg"')).toBe("warn");
	});

	it("records an absolute path against the same repo-relative name", () => {
		// record-write.sh passes the payload's file_path, which is absolute; the
		// index names paths relative to the root, so an unnormalised compare would
		// call every file foreign.
		stageSomething(shared, "a.md");
		recordWrite(path.join(shared, "a.md"));
		expect(verdict('git commit -m "msg"')).toBe("allow");
	});

	it("attributes a doc written by a script rather than an Edit", () => {
		// docs/roadmap-digest.md is generated by gen-roadmap-digest.js, which takes
		// the claim itself; without that path the digest reads foreign and the warn
		// fires on every roadmap edit.
		//
		// The claim below is spelled as that script spells it: subcommand and path
		// only, NO session-id argument, so the id is the inherited
		// CLAUDE_CODE_SESSION_ID.
		fs.mkdirSync(path.join(shared, "docs"), { recursive: true });
		fs.writeFileSync(path.join(shared, "docs/roadmap-digest.md"), "digest\n");
		git(shared, "add", "docs/roadmap-digest.md");
		arbiter(["claim", "docs/roadmap-digest.md"], {
			CLAUDE_CODE_SESSION_ID: "test",
		});
		expect(verdict('git commit -m "msg"')).toBe("allow");
	});

	it("a foreign path still warns even when the session wrote others", () => {
		stageSomething(shared, "a.md");
		recordWrite("a.md", "someone-else");
		expect(verdict('git commit -m "msg"')).toBe("warn");
	});

	describe("attribution unavailable falls back to mantahostels#117's index-wide warn", () => {
		it("no session id at all", () => {
			stageSomething(shared, "a.md");
			recordWrite("a.md"); // would silence it, if the ledger could be found
			const out = JSON.parse(run('git commit -m "msg"', shared, null));
			const msg = out.hookSpecificOutput.additionalContext;
			expect(msg).toContain("a.md");
			expect(msg).toContain("could not be read");
		});

		it("the comparison itself fails", () => {
			// grep answers 0 selected / 1 none selected / >1 its own failure, and
			// "none selected" is the silence case. Read through `mapfile < <(…)`
			// the status is discarded, so a broken grep reads as "nothing foreign"
			// and the guard goes quiet on a real sweep.
			stageSomething(shared, "a.md");
			const bin = path.join(dir, "bin");
			fs.mkdirSync(bin, { recursive: true });
			fs.writeFileSync(path.join(bin, "grep"), "#!/bin/sh\nexit 2\n", {
				mode: 0o755,
			});
			const r = spawnGuard(
				GUARD,
				buildBashPayload('git commit -m "msg"', "test"),
				{
					project: shared,
					config,
					cwd: shared,
					env: { PATH: `${bin}:${process.env.PATH}` },
				},
			);
			expect(r.stdout).toContain("a.md");
			expect(r.stdout).toContain("could not be read");
		});

		it("the ledger file is there but cannot be read", () => {
			// mantahostels#135. The arbiter runs to completion but cannot read the ledger, so it
			// must not exit 0 with an empty list: attribution is unavailable, and a
			// guard reading that as "every staged path is foreign" names the session
			// its own files under "you never wrote these".
			stageSomething(shared, "a.md");
			recordWrite("a.md");
			// The ledger's directory is keyed by a slug of the repo path, which is a
			// temp dir here.
			const projects = path.join(config, "projects");
			const ledgers = fs
				.readdirSync(projects)
				.flatMap((slug) => {
					const w = path.join(projects, slug, "writes");
					return fs.existsSync(w)
						? fs.readdirSync(w).map((f) => path.join(w, f))
						: [];
				})
				.filter((p) => fs.statSync(p).isFile());
			expect(ledgers).toHaveLength(1);
			fs.chmodSync(ledgers[0], 0o000);
			const out = JSON.parse(run('git commit -m "msg"'));
			const msg = out.hookSpecificOutput.additionalContext;
			expect(msg).toContain("a.md");
			expect(msg).toContain("could not be read");
			expect(msg).not.toContain("never wrote");
		});

		it("the arbiter exits non-zero, and says so in the fail-open log (mantahostels#3278)", () => {
			stageSomething(shared, "a.md");
			recordWrite("a.md"); // would silence it, if the read succeeded
			// A `node` that fails stands for the whole class: a missing arbiter, a
			// timeout kill, earlyoom at the WSL memory cap. Emptying PATH would not do —
			// it takes jq and git with it and the guard fails open before reaching
			// attribution at all.
			const bin = path.join(dir, "bin");
			fs.mkdirSync(bin, { recursive: true });
			fs.writeFileSync(path.join(bin, "node"), "#!/bin/sh\nexit 1\n", {
				mode: 0o755,
			});
			const r = spawnGuard(
				GUARD,
				buildBashPayload('git commit -m "msg"', "test"),
				{
					project: shared,
					config,
					cwd: shared,
					env: { PATH: `${bin}:${process.env.PATH}` },
				},
			);
			expect(r.stdout).toContain("a.md");
			expect(r.stdout).toContain("could not be read");
			expect(fs.readFileSync(failOpenLogPath(config, shared), "utf8")).toMatch(
				/commit-check exited 1 — the write ledger was unread/,
			);
		});
	});
});

describe("mid-sequence, staging is unavoidable and the index verdicts are suppressed", () => {
	/** Leaves the shared tree in a conflicted merge. */
	const conflictedMerge = () => {
		git(shared, "checkout", "-q", "-b", "other");
		fs.writeFileSync(path.join(shared, "a.md"), "other\n");
		git(shared, "commit", "-qm", "other", "--", "a.md");
		git(shared, "checkout", "-q", "main");
		fs.writeFileSync(path.join(shared, "a.md"), "main\n");
		git(shared, "commit", "-qm", "main", "--", "a.md");
		expect(() => git(shared, "merge", "other")).toThrow();
	};

	it.each([
		["git add a.md", "resolving a conflict is what staging is for"],
		["git commit", "finishing a merge is a bare commit of the resolution"],
		['git commit -m "merge"', "with a message, likewise"],
	])("%s — %s", (command) => {
		conflictedMerge();
		expect(verdict(command)).toBe("allow");
	});

	it("suppresses the sweeping deny too, not only the warns", () => {
		conflictedMerge();
		expect(verdict('git commit -am "merge"')).toBe("allow");
	});

	it.each([
		["rebase-merge", "an interactive rebase"],
		["rebase-apply", "a `git am`-style rebase"],
	])("%s marks %s in progress", (marker) => {
		fs.mkdirSync(path.join(shared, ".git", marker), { recursive: true });
		expect(verdict("git add a.md")).toBe("allow");
	});

	it.each([
		["CHERRY_PICK_HEAD", "a cherry-pick"],
		["REVERT_HEAD", "a revert"],
	])("%s marks %s in progress", (marker) => {
		fs.writeFileSync(
			path.join(shared, ".git", marker),
			git(shared, "rev-parse", "HEAD"),
		);
		expect(verdict("git add a.md")).toBe("allow");
	});
});

describe("text that merely mentions a commit is not a commit", () => {
	it.each([
		['grep -rn "git commit -am" docs/', "a search"],
		["echo 'git commit -am foo'", "a single-quoted mention"],
		['echo "a | git add ."', "a pipe inside a quoted string"],
		["cat <<EOF > f.md\ngit commit -am foo\nEOF", "a heredoc body"],
		[
			"cat <<'EOF' > f.md\ngit commit -am foo\nEOF",
			"a quoted heredoc delimiter",
		],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it("<< inside a quoted string does not open a heredoc", () => {
		// Otherwise it swallows every line after it, sweeping commit included.
		expect(verdict('echo "a << b"\ngit commit -am foo')).toBe("deny");
		// The segment echoed back must be the commit, not the echo.
		expect(denyReason('echo "a << b"\ngit commit -am foo')).toContain(
			`${SWEEPS}: git commit -am foo`,
		);
	});

	it("leaves git subcommands it has no business in alone", () => {
		for (const command of [
			"git status",
			"git diff --cached",
			"git log --oneline",
			"git worktree add -b sync /tmp/wt main",
		]) {
			expect(verdict(command)).toBe("allow");
		}
	});
});

describe("trees this guard has no business in", () => {
	it("a linked worktree is exempt from the three index verdicts — its index is its own", () => {
		// Since mantahostels#1213 the walk reaches a worktree, so these three are held off by
		// the gp_tree_is_shared test inside judge() rather than by the walker.
		stageSomething(worktree);
		expect(verdict('git commit -am "msg"', worktree)).toBe("allow");
		expect(verdict("git add a.md", worktree)).toBe("allow");
		expect(verdict('git commit -m "msg"', worktree)).toBe("allow");
	});

	it("an unrelated repository is left alone", () => {
		expect(verdict(`git -C ${elsewhere} commit -am "msg"`)).toBe("allow");
		expect(verdict('git commit -am "msg"', elsewhere)).toBe("allow");
	});

	it("resolves a leading cd, so the tree is judged not the caller's cwd", () => {
		expect(verdict(`cd ${shared} && git commit -am "msg"`, elsewhere)).toBe(
			"deny",
		);
		expect(
			denyReason(`cd ${shared} && git commit -am "msg"`, elsewhere),
		).toContain(`${SWEEPS}: git commit -am "…"`);
	});

	it("resolves git -C, including from inside a worktree", () => {
		expect(verdict(`git -C ${shared} commit -am "msg"`, worktree)).toBe("deny");
		expect(denyReason(`git -C ${shared} commit -am "msg"`, worktree)).toContain(
			SWEEPS,
		);
	});

	it("judges a worktree spelt through $CLAUDE_JOB_DIR instead of failing open on it", () => {
		// The recipe was `"$CLAUDE_JOB_DIR/tmp/<name>"` until #1732, and a hook
		// process inherits CLAUDE_JOB_DIR, so the path resolves (mantahostels#183).
		const env = { CLAUDE_JOB_DIR: dir };
		git(shared, "worktree", "add", "-q", "-b", "recipe", path.join(dir, "tmp"));
		expect(
			verdict(
				'cd "$CLAUDE_JOB_DIR/tmp" && git commit -am "msg"',
				elsewhere,
				env,
			),
		).toBe("allow");
		expect(
			verdict(
				'cd "$CLAUDE_JOB_DIR/shared" && git commit -am "msg"',
				elsewhere,
				env,
			),
		).toBe("deny");
		expect(
			denyReason(
				'cd "$CLAUDE_JOB_DIR/shared" && git commit -am "msg"',
				elsewhere,
				env,
			),
		).toContain(SWEEPS);
	});

	it("resolves a quoted literal path, which the masking used to destroy", () => {
		expect(verdict(`cd "${shared}" && git commit -am "msg"`, elsewhere)).toBe(
			"deny",
		);
		expect(
			denyReason(`cd "${shared}" && git commit -am "msg"`, elsewhere),
		).toContain(SWEEPS);
		expect(verdict(`git -C "${shared}" commit -am "msg"`, elsewhere)).toBe(
			"deny",
		);
		expect(
			denyReason(`git -C "${shared}" commit -am "msg"`, elsewhere),
		).toContain(SWEEPS);
	});

	it("fails open on a path it genuinely cannot resolve", () => {
		// The deliberate residual (#312): a command substitution, directly or
		// through a name, stays unjudged. An unset name no longer is.
		expect(verdict('cd "$(mktemp -d)" && git commit -am "msg"')).toBe("allow");
		expect(verdict('D=$(mktemp -d); cd "$D" && git commit -am "msg"')).toBe(
			"allow",
		);
	});
});

describe("the bare-commit warn before the first commit", () => {
	it("reads an index that has no HEAD to compare against", () => {
		// `git diff --cached HEAD` errors on an unborn branch, which would have
		// made the guard silent on the very first commit of a repo.
		const fresh = path.join(dir, "fresh");
		fs.mkdirSync(fresh);
		git(fresh, "init", "-q", "-b", "main", ".");
		git(fresh, "config", "core.hooksPath", path.join(dir, "no-hooks"));
		fs.writeFileSync(path.join(fresh, "a.md"), "a\n");
		git(fresh, "add", "a.md");

		const r = spawnGuard(
			GUARD,
			buildBashPayload('git commit -m "init"', null),
			{
				project: fresh,
				config,
				cwd: fresh,
				env: { CLAUDE_CODE_SESSION_ID: "" },
			},
		);
		expect(r.stdout).toContain("a.md");
	});
});

/*
 * mantahostels#123 moved the parser this guard shares with guard-branch.sh into
 * scripts/lib/guard-parse.sh.
 *
 * Every case below uses a DENY command, so the verdict is reached before the
 * write ledger is consulted and the detached copy needs no session-arbiter.js
 * beside it.
 */

describeSharedParserLibrary({
	guard: GUARD,
	denyCommand: 'git commit -am "x"',
	ctx: () => ({
		dir,
		shared,
		elsewhere,
		env: { CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_SESSION_ID: "test" },
	}),
});

const payloadOf = (command: string) => buildBashPayload(command, "test");

describeFailOpenLog({
	guard: GUARD,
	denied: payloadOf('git commit -am "x"'),
	fieldless: { session_id: "test", tool_name: "Bash", tool_input: {} },
	fieldlessMatch: /no command in payload/,
	benign: payloadOf('git commit -m "x" -- a.md'),
	ctx: () => ({
		dir,
		config,
		project: shared,
		env: { CLAUDE_CODE_SESSION_ID: "test" },
	}),
});

describe("a commit form it cannot judge is recorded, not just allowed", () => {
	const logLines = () => {
		const at = path.join(
			config,
			"projects",
			shared.replace(/[^a-zA-Z0-9]/g, "-"),
			"guard-errors.log",
		);
		return fs.existsSync(at) ? fs.readFileSync(at, "utf8") : "";
	};

	it("logs a commit whose working tree cannot be resolved", () => {
		// An unexpanded variable in the cd target: the guard does not know which
		// tree this commits against, so it allows — and that is a sweeping commit
		// form it declined to judge, not a command it never had to.
		run('cd $TARGET && git commit -am "x"');
		expect(logLines()).toMatch(
			/could not resolve the working tree for a git commit/,
		);
	});

	it("says nothing about an unresolvable cd carrying no commit at all", () => {
		run("cd $TARGET && npm run build");
		expect(logLines()).toBe("");
	});

	it("says nothing about a commit in a directory that is in no repo (mantahostels#253)", () => {
		// The directory exists and git refuses for it — a confident "not a
		// repository", not an unknown: nothing committed there reaches this index.
		const opaque = mkDirOutsideRepo("not-a-repo-");
		try {
			run(`git -C ${opaque} commit -am "x"`, shared, "test");
		} finally {
			fs.rmSync(opaque, { recursive: true, force: true });
		}
		expect(logLines()).toBe("");
	});

	it("logs a commit where git failed for some other reason (mantahostels#253)", () => {
		// A commit form the guard declined to judge, so is_shared_tree() returns 2
		// and the guard records it. git's own answer cannot pick this case out: a
		// `.git` pointing at a gitdir that is gone exits 128 printing the same
		// "not a git repository" as the case above.
		const broken = path.join(dir, "broken-repo");
		fs.mkdirSync(broken, { recursive: true });
		fs.writeFileSync(
			path.join(broken, ".git"),
			`gitdir: ${path.join(dir, "no-such-gitdir")}\n`,
		);
		run(`git -C ${broken} commit -am "x"`, shared, "test");
		expect(logLines()).toMatch(
			/git could not answer for .*broken-repo — a git commit there was allowed unchecked/,
		);
	});

	it("says nothing about a commit in a directory that does not exist", () => {
		// git fails before it commits anything, so an absolute path with nothing at
		// it is no more the shared tree than another repo is (mantahostels#208).
		run(`git -C ${path.join(dir, "gone")} commit -am "x"`);
		expect(logLines()).toBe("");
	});

	it("logs an index git cannot read, rather than reading it as empty", () => {
		// git's failure produces no lines, which is byte-identical to a clean index.
		// Taken as "nothing staged", the bare-commit warn never fires and the guard
		// is silent about a commit that would sweep whatever is actually in there.
		stageSomething();
		fs.writeFileSync(path.join(shared, ".git", "index"), "not an index at all");
		expect(verdict('git commit -m "x"')).toBe("allow");
		expect(logLines()).toMatch(/git could not read the index/);
	});
});

describe("an unset variable in the target is the cwd (#312, #326)", () => {
	const unsetLine =
		"`$UNSET_326` is unset in this call; shell variables do not carry over between Bash calls.";
	const logged = () => {
		const at = failOpenLogPath(config, shared);
		return fs.existsSync(at) ? fs.readFileSync(at, "utf8") : "";
	};

	it.each([
		[SWEEPS, 'git -C "$UNSET_326" commit -am "x"'],
		[AMEND, 'cd "$UNSET_326" && git commit --amend -m "x" -- a.md'],
		[NO_VERIFY, 'git -C "$UNSET_326" commit --no-verify -m "x" -- a.md'],
		[NO_VERIFY, 'git -C "$UNSET_326" merge --no-verify topic'],
		[CLOSES, 'git -C "$UNSET_326" commit -m "Fixes #1" -- a.md'],
	])(
		"refuses with %s, naming the variable after the framing line",
		(framing, command) => {
			const r = denyReason(command);
			// The framing paragraph, the line, then the refusal's own body.
			const from = r.slice(r.indexOf(framing)).split("\n\n");
			expect(from[1]).toBe(unsetLine);
			expect(from[2]).not.toBe("");
			expect(logged()).toBe("");
		},
	);

	it("judges the warns there too", () => {
		expect(verdict('git -C "$UNSET_326" add a.md')).toBe("warn");
		stageSomething();
		expect(verdict('cd "$UNSET_326" && git commit -m "x"')).toBe("warn");
	});

	it("keeps the tree scope of the cwd it lands in", () => {
		// The index verdicts stay shared-tree-only; `--no-verify` binds in a worktree.
		expect(verdict('git -C "$UNSET_326" commit -am "x"', worktree)).toBe(
			"allow",
		);
		expect(
			denyReason('git -C "$UNSET_326" commit -n -m "x" -- a.md', worktree),
		).toContain(unsetLine);
		expect(verdict('git -C "$UNSET_326" commit -am "x"', elsewhere)).toBe(
			"allow",
		);
	});

	it("judges the untracked-pathspec and directory warns there too", () => {
		fs.mkdirSync(path.join(shared, "d"));
		fs.writeFileSync(path.join(shared, "d", "old.md"), "old\n");
		git(shared, "add", "d/old.md");
		git(shared, "commit", "-qm", "d");
		fs.writeFileSync(path.join(shared, "d", "old.md"), "edited\n");
		fs.writeFileSync(path.join(shared, "d", "new.md"), "new\n");
		expect(run('git -C "$UNSET_326" commit -m "x" -- d/new.md')).toContain(
			"git does not track yet",
		);
		expect(run('git -C "$UNSET_326" commit -m "x" -- d')).toContain(
			"does not track yet",
		);
	});

	it("adds no line where no variable reached the tree", () => {
		expect(denyReason('git commit -am "x"')).not.toContain(
			"is unset in this call",
		);
		expect(denyReason('W=""; git -C "$W" commit -am "x"')).not.toContain(
			"is unset in this call",
		);
	});

	it("keeps the logged fail-open for a $(…) target", () => {
		expect(verdict('cd "$(pwd)" && git commit -am "x"')).toBe("allow");
		expect(logged()).toMatch(
			/could not resolve the working tree for a git commit/,
		);
	});
});

/*
 * mantahostels#1539. A pathspec takes the WORKING-TREE copy of every path it names, so the
 * index rule this guard's headline teaches cures nothing here: commit 607c6f63
 * followed it exactly and still landed a neighbour's whole new doc-map
 * entry under a message describing only its own.
 *
 * Warn-only and whole-file, per mantahostels#1560; the test is mantahostels#1558's, and lives in
 * arbiter-store.test.ts. What only shows here is the seam: which commands reach
 * it, and what the session actually reads.
 */
describe("a pathspec commit warns when it would sweep a live neighbour's work", () => {
	const doc = "docs/a.md";
	const mapPath = "docs/doc-map.md";
	const abs = (rel: string) => path.join(shared, rel);

	/** A doc-map with two §B entries, so a region claim has somewhere to live. */
	const map = (b196: string, b197: string) =>
		[
			"# Doc map",
			"",
			"## Section B — figures",
			"",
			"The preamble.",
			"",
			"### B196 · The first",
			"",
			b196,
			"",
			"### B197 · The second",
			"",
			b197,
			"",
		].join("\n");

	const write = (rel: string, text: string) => {
		fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
		fs.writeFileSync(abs(rel), text);
	};

	/**
	 * A live session other than the committer, holding `subject` with the tree's
	 * current bytes pinned — the arrangement mantahostels#1558's test fires on.
	 *
	 * The registry entry is written by hand rather than through the testkit
	 * sandbox, because this suite's repo and config dir are its own.
	 */
	const neighbour = (subject: string, session = "alice", name?: string) => {
		fs.mkdirSync(path.join(config, "sessions"), { recursive: true });
		fs.writeFileSync(
			path.join(config, "sessions", `${process.pid}.json`),
			JSON.stringify({
				pid: process.pid,
				sessionId: session,
				procStart: proc.procStartOf(process.pid),
				status: "idle",
				cwd: shared,
				...(name === undefined ? {} : { name }),
			}),
		);
		const me = store.identify(session);
		store.acquire(subject, me);
		store.recordContent(subject, me);
	};

	let savedConfig: string | undefined;
	let savedProject: string | undefined;

	beforeEach(() => {
		// The store reads both at call time, so the arrangement above and the
		// guard's own subprocess see the same sandbox.
		savedConfig = process.env.CLAUDE_CONFIG_DIR;
		savedProject = process.env.CLAUDE_PROJECT_DIR;
		process.env.CLAUDE_CONFIG_DIR = config;
		process.env.CLAUDE_PROJECT_DIR = shared;
		write(doc, "committed\n");
		write(mapPath, map("B196 as committed.", "B197 as committed."));
		git(shared, "add", "-A");
		git(shared, "commit", "-qm", "seed");
	});

	afterEach(() => {
		process.env.CLAUDE_CONFIG_DIR = savedConfig;
		process.env.CLAUDE_PROJECT_DIR = savedProject;
	});

	it("names the path, the holder and the act", () => {
		write(doc, "alice's unsaved edit\n");
		neighbour(doc, "alice", "Wayfinder 1584");
		const out = run(`git commit -m "x" -- ${doc}`);
		expect(out).toContain("This commit names docs/a.md");
		expect(out).toContain("(Wayfinder 1584)");
		expect(out).toContain("swept in under your message");
		expect(out).toContain("#1539");
	});

	it("fires through an unset variable in the target (#326)", () => {
		write(doc, "alice's unsaved edit\n");
		neighbour(doc, "alice", "Wayfinder 1584");
		expect(run(`git -C "$UNSET_326" commit -m "x" -- ${doc}`)).toContain(
			"This commit names docs/a.md",
		);
	});

	it("offers the other paths where the pathspec names any (mantahostels#3272)", () => {
		write(doc, "alice's unsaved edit\n");
		write("b.md", "mine\n");
		git(shared, "add", "b.md");
		git(shared, "commit", "-qm", "b");
		write("b.md", "my own edit\n");
		neighbour(doc, "alice", "Wayfinder 1584");
		const out = run(`git commit -m "x" -- ${doc} b.md`);
		expect(out).toContain("Commit your own paths instead");
		expect(out).not.toContain("Swept:");
	});

	it("counts a directory word as another path — it names more than the file", () => {
		write(doc, "alice's unsaved edit\n");
		neighbour(doc);
		expect(run('git commit -m "x" -- docs')).toContain(
			"Commit your own paths instead",
		);
	});

	it("hands back the declared sweep where the file IS the whole pathspec (mantahostels#3270)", () => {
		// "Commit your own paths instead" offers no move at all here, which is
		// the defect mantahostels#3272 replaced this foot to fix.
		write(doc, "alice's unsaved edit\n");
		neighbour(doc, "alice", "Wayfinder 1584");
		const out = run(`git commit -m "x" -- ${doc}`);
		expect(out).toContain("This file is the whole pathspec");
		expect(out).toContain("Swept: docs/a.md (Wayfinder 1584)");
		expect(out).not.toContain("Commit your own paths instead");
	});

	it("composes the declared sweep from the region, not a template", () => {
		write(mapPath, map("B196 as committed.", "B197, alice's unsaved edit."));
		neighbour(`${mapPath}#B197`, "alice", "Wayfinder 1584");
		expect(run(`git commit -m "x" -- ${mapPath}`)).toContain(
			"Swept: §B197 (Wayfinder 1584)",
		);
	});

	it("reads `./docs/a.md` as the whole pathspec, not as another path (mantahostels#3315)", () => {
		// The foot compares the resolved word against the arbiter's repo-relative
		// answer; without normalisation the `./` made them different paths.
		write(doc, "alice's unsaved edit\n");
		neighbour(doc, "alice", "Wayfinder 1584");
		const out = run(`git commit -m "x" -- ./${doc}`);
		expect(out).toContain("This file is the whole pathspec");
		expect(out).not.toContain("Commit your own paths instead");
	});

	it("keeps the old foot where a pathspec word's text cannot be read", () => {
		// The word is dropped from the resolved list, so the collision-only test
		// would otherwise say there is nothing else to commit when $OTHER may
		// well name something.
		write(doc, "alice's unsaved edit\n");
		neighbour(doc, "alice", "Wayfinder 1584");
		const out = run(`git commit -m "x" -- ${doc} "$OTHER"`);
		expect(out).toContain("Commit your own paths instead");
		expect(out).not.toContain("This file is the whole pathspec");
	});

	it("caps the collision sentences at ten, in both lists (mantahostels#3272)", () => {
		// One list rendered twice, so one cap governs both. Twelve claimed files,
		// all named by the pathspec, so the declared-sweep foot is the one shown.
		const files: string[] = [];
		for (let i = 0; i < 12; i++) {
			const rel = `docs/c${i}.md`;
			write(rel, "committed\n");
			files.push(rel);
		}
		git(shared, "add", "-A");
		git(shared, "commit", "-qm", "twelve");
		for (const rel of files) write(rel, "alice's unsaved edit\n");
		for (const rel of files) neighbour(rel, "alice", "Wayfinder 1584");
		// Decoded, because the message reaches the session through JSON and the
		// line shape is what is being asserted.
		const text = JSON.parse(run(`git commit -m "x" -- ${files.join(" ")}`))
			.hookSpecificOutput.additionalContext as string;
		expect(text.match(/swept in under your message/g)).toHaveLength(10);
		expect(text.match(/^ {2}Swept: /gm)).toHaveLength(10);
		expect(text).toContain("… and 2 more claimed path(s) this commit names.");
		expect(text).toContain("\n  … and 2 more\n");
	});

	it("hands back no recovery command — nothing has been swept yet (mantahostels#1582)", () => {
		// The warn is PreToolUse. The actor who needs the neighbour's bytes after a
		// sweep is the neighbour, and session-arbiter.js already reaches them.
		write(doc, "alice's unsaved edit\n");
		neighbour(doc);
		expect(run(`git commit -m "x" -- ${doc}`)).not.toContain("cat-file");
	});

	it("does not tell the session to wait for the holder to release (mantahostels#1406)", () => {
		write(doc, "alice's unsaved edit\n");
		neighbour(doc);
		expect(run(`git commit -m "x" -- ${doc}`)).not.toMatch(/\bwait\b/i);
	});

	it("names the neighbour's region, and says the whole file goes anyway", () => {
		write(mapPath, map("B196 as committed.", "B197, alice's unsaved edit."));
		neighbour(`${mapPath}#B197`, "alice", "Wayfinder 1584");
		const out = run(`git commit -m "x" -- ${mapPath}`);
		expect(out).toContain("holds a claim on §B197 of it");
		expect(out).toContain(
			"takes the whole working-tree file, their region included",
		);
	});

	it("says nothing about a path no live session holds", () => {
		write(doc, "my own edit\n");
		expect(verdict(`git commit -m "x" -- ${doc}`)).toBe("allow");
	});

	it("says nothing about the contended path when the commit does not name it", () => {
		write(doc, "alice's unsaved edit\n");
		neighbour(doc);
		expect(verdict('git commit -m "x" -- a.md')).toBe("allow");
	});

	it("warns on a contended path reached through a directory in the pathspec", () => {
		write(doc, "alice's unsaved edit\n");
		neighbour(doc);
		expect(verdict('git commit -m "x" -- docs')).toBe("warn");
	});

	it("never fires mid-sequence — a merge commit carries no pathspec", () => {
		// The header's THOSE THREE stays three for this reason: nothing had to be
		// suppressed for the new warn.
		write(doc, "alice's unsaved edit\n");
		neighbour(doc);
		fs.writeFileSync(
			path.join(shared, ".git", "MERGE_HEAD"),
			git(shared, "rev-parse", "HEAD"),
		);
		expect(verdict(`git commit -m "x" -- ${doc}`)).toBe("allow");
	});

	it("is outranked by the sweeping deny in the same command", () => {
		write(doc, "alice's unsaved edit\n");
		neighbour(doc);
		expect(verdict(`git commit -am "x" -- ${doc}`)).toBe("deny");
		// "Outranked" is a claim about WHICH message won, so it must be checked.
		expect(denyReason(`git commit -am "x" -- ${doc}`)).toContain(SWEEPS);
	});

	it("says nothing when the pathspec word's text cannot be read", () => {
		// An unexpanded $VAR: the guard judges on what it can see and guesses at
		// nothing (mantahostels#103 §6).
		write(doc, "alice's unsaved edit\n");
		neighbour(doc);
		expect(verdict('git commit -m "x" -- "$PATHS"')).toBe("allow");
	});

	it("says nothing with no session id — there is nobody to except", () => {
		write(doc, "alice's unsaved edit\n");
		neighbour(doc);
		expect(run(`git commit -m "x" -- ${doc}`, shared, null)).toBe("");
	});

	it("counts as a fire: the registry needle matches what it prints (mantahostels#3278)", () => {
		write(doc, "alice's unsaved edit\n");
		neighbour(doc, "alice", "Wayfinder 1584");
		const out = run(`git commit -m "x" -- ${doc}`);
		expect(out).toContain("swept in under your message");
		// One transcript holding one hook_success attachment: the record Claude
		// Code writes when a PreToolUse hook speaks, carrying this run's own stdout.
		const corpus = fs.mkdtempSync(path.join(dir, "fires-"));
		fs.writeFileSync(
			path.join(corpus, "s1.jsonl"),
			`${JSON.stringify({
				type: "attachment",
				uuid: "a1",
				timestamp: "2026-09-07T09:00:00.000Z",
				attachment: {
					type: "hook_success",
					toolUseID: "toolu_01",
					command: "scripts/guard-commit-form.sh",
					stdout: out,
				},
			})}\n`,
		);
		/* The counter reads the HOST'S registrations for the hook roster (#1,
		 * lib/core-hooks.js `hookSourcesOf`), and this describe's beforeEach
		 * points CLAUDE_PROJECT_DIR at the git fixture, which has none. The
		 * subject here is the needle against the guard's own printed text, so it
		 * is this repo the counter must read. */
		const r = runInProcess(
			path.resolve(__dirname, "count-guard-fires.js"),
			["--dir", corpus],
			{
				env: {
					...process.env,
					CLAUDE_PROJECT_DIR: path.resolve(__dirname, ".."),
				},
			},
		);
		expect(r.status).toBe(0);
		expect(r.stdout).toContain("sweep-warn 1 across 1 session(s) (2026-09-07)");
	});

	it("records the arbiter's silence instead of reading it as no collision (mantahostels#3278)", () => {
		write(doc, "alice's unsaved edit\n");
		neighbour(doc);
		const bin = fs.mkdtempSync(path.join(dir, "bin-"));
		fs.writeFileSync(path.join(bin, "node"), "#!/bin/sh\nexit 1\n", {
			mode: 0o755,
		});
		expect(
			run(`git commit -m "x" -- ${doc}`, shared, "test", {
				PATH: `${bin}:${process.env.PATH}`,
			}),
		).not.toContain("swept in under your message");
		expect(fs.readFileSync(failOpenLogPath(config, shared), "utf8")).toMatch(
			/commit-check exited 1 — the mantahostels#1539 sweep check was skipped/,
		);
	});
});

/** The escape both untracked-path warns offer: the commit script first, the hand-typed intent-add after it. */
const expectScriptAheadOfAddN = (out: string) => {
	const script = out.indexOf("node scripts/commit-paths.js");
	expect(script).toBeGreaterThan(-1);
	expect(out.indexOf("git add -N <path>")).toBeGreaterThan(script);
};

describe("the sweeping-form deny and the staging warn offer the same escape (#587)", () => {
	it("names the script ahead of add -N in the deny", () => {
		expectScriptAheadOfAddN(denyReason('git commit -am "msg"'));
	});

	it("names the script ahead of add -N in the staging warn", () => {
		expectScriptAheadOfAddN(run("git add a.md"));
	});
});

/*
 * mantahostels#1612. docs/agents/guard-registry.md §Conventions' headline rule — commit by pathspec, never
 * `git add` first — is unsatisfiable for a file git does not track yet: the
 * pathspec matches nothing, git exits 1 and commits nothing. The `git add -N`
 * escape was already in the `git add` warn's text, where only a session that
 * broke the rule would ever read it.
 */
describe("a pathspec commit warns when it names a path git does not track", () => {
	/** Puts a file on disk that git has never been told about. */
	const newFile = (rel: string, text = "new\n") => {
		fs.mkdirSync(path.dirname(path.join(shared, rel)), { recursive: true });
		fs.writeFileSync(path.join(shared, rel), text);
	};

	it("names the untracked path and hands back the commit script, then the add -N escape (#587)", () => {
		newFile("new.md");
		const out = run('git commit -m "x" -- new.md');
		expect(out).toContain("git does not track yet");
		expect(out).toContain("new.md");
		expectScriptAheadOfAddN(out);
		expect(out).toContain("#1612");
	});

	it("says nothing when every path named is already tracked", () => {
		expect(verdict('git commit -m "x" -- a.md')).toBe("allow");
	});

	it("warns when one untracked path rides along with a tracked one", () => {
		newFile("new.md");
		expect(verdict('git commit -m "x" -- a.md new.md')).toBe("warn");
	});

	it("warns without the -- separator too", () => {
		newFile("new.md");
		expect(verdict('git commit -m "x" new.md')).toBe("warn");
	});

	it("warns on a directory holding nothing git tracks", () => {
		newFile("fresh/new.md");
		expect(verdict('git commit -m "x" -- fresh')).toBe("warn");
	});

	it("leaves a directory git already tracks something in to mantahostels#1651", () => {
		// git accepts the pathspec and commits the tracked file, silently
		// leaving the untracked one behind — a warn, but not this one's.
		newFile("also-new.md");
		const out = run('git commit -m "x" -- .');
		expect(out).not.toContain("#1612");
		expect(out).toContain("#1651");
	});

	it("says nothing about a path that is not there at all", () => {
		// A typo, or mantahostels#495's flag-shaped path: `git add -N` is no advice for a
		// file that is not there.
		expect(verdict('git commit -m "msg" -- -weird-file')).toBe("allow");
		expect(verdict('git commit -m "msg" -- typo.md')).toBe("allow");
	});

	it("warns on an ignored path too, and offers the -f the escape needs", () => {
		// git rejects the pathspec for an ignored file just the same, so the
		// harm is identical — but plain `git add -N` would refuse it.
		fs.writeFileSync(path.join(shared, ".gitignore"), "ignored.md\n");
		git(shared, "add", ".gitignore");
		git(shared, "commit", "-qm", "ignore");
		newFile("ignored.md");
		expect(run('git commit -m "x" -- ignored.md')).toContain("git add -f -N");
	});

	it("says nothing when the pathspec word's text cannot be read", () => {
		newFile("new.md");
		expect(verdict('git commit -m "x" -- "$PATHS"')).toBe("allow");
	});

	it("is outranked by the sweeping deny in the same command", () => {
		newFile("new.md");
		expect(verdict('git commit -am "x" -- new.md')).toBe("deny");
		expect(denyReason('git commit -am "x" -- new.md')).toContain(SWEEPS);
	});

	it("is outranked by the --no-verify deny in the same command", () => {
		newFile("new.md");
		expect(verdict('git commit --no-verify -m "x" -- new.md')).toBe("deny");
		expect(denyReason('git commit --no-verify -m "x" -- new.md')).toContain(
			NO_VERIFY,
		);
	});

	it("is suppressed mid-merge, like the other shared-index verdicts", () => {
		newFile("new.md");
		fs.writeFileSync(
			path.join(shared, ".git", "MERGE_HEAD"),
			git(shared, "rev-parse", "HEAD"),
		);
		expect(verdict('git commit -m "x" -- new.md')).toBe("allow");
	});

	it("binds in a linked worktree too — it guards no index", () => {
		// Second of the five verdicts to do so, after --no-verify (mantahostels#1213): git
		// rejects an unmatchable pathspec byte-identically in every tree.
		fs.writeFileSync(path.join(worktree, "new.md"), "new\n");
		expect(verdict('git commit -m "x" -- new.md', worktree)).toBe("warn");
	});

	it("leaves a word git cannot answer for unjudged, and records it", () => {
		// A path outside the repo: git exits 128, so the word is left unjudged
		// rather than guessed at — and mantahostels#147's rule is that every fail-open is
		// logged, or a broken git reads exactly like a clean verdict.
		expect(
			verdict(`git commit -m "x" -- ${path.join(dir, "outside.md")}`),
		).toBe("allow");
		const log = path.join(
			config,
			"projects",
			shared.replace(/[^a-zA-Z0-9]/g, "-"),
			"guard-errors.log",
		);
		expect(fs.readFileSync(log, "utf8")).toContain(
			"left unjudged for mantahostels#1612",
		);
	});

	it("outranks the neighbour-sweep warn when one command triggers both", () => {
		// git rejects the whole commit, so the sweep never happens.
		process.env.CLAUDE_CONFIG_DIR = config;
		process.env.CLAUDE_PROJECT_DIR = shared;
		fs.writeFileSync(path.join(shared, "a.md"), "alice's unsaved edit\n");
		fs.mkdirSync(path.join(config, "sessions"), { recursive: true });
		fs.writeFileSync(
			path.join(config, "sessions", `${process.pid}.json`),
			JSON.stringify({
				pid: process.pid,
				sessionId: "alice",
				procStart: proc.procStartOf(process.pid),
				status: "idle",
				cwd: shared,
			}),
		);
		const me = store.identify("alice");
		store.acquire("a.md", me);
		store.recordContent("a.md", me);
		newFile("new.md");
		const out = run('git commit -m "x" -- a.md new.md');
		expect(out).toContain("git does not track yet");
		expect(out).not.toContain("#1539");
	});

	it("needs no session id — it reads git, not the write ledger", () => {
		newFile("new.md");
		expect(run('git commit -m "x" -- new.md', shared, null)).toContain(
			"git does not track yet",
		);
	});
});

/*
 * mantahostels#1651. The residual mantahostels#1612 leaves. A pathspec word naming a DIRECTORY that
 * holds one tracked file and one untracked file is accepted by git: it commits
 * the tracked one, exits 0 and leaves the new one behind. mantahostels#1612's harm with no
 * signal at all — which is why this is a second verdict rather than a widening
 * of mantahostels#1612's loop, whose "tracks nothing" test deliberately clears such a word.
 */
describe("a pathspec commit warns when a directory word leaves a new file behind", () => {
	const newFile = (rel: string, text = "new\n") => {
		fs.mkdirSync(path.dirname(path.join(shared, rel)), { recursive: true });
		fs.writeFileSync(path.join(shared, rel), text);
	};

	/** A tracked, modified file and an untracked sibling, both under `docs/`. */
	const mixedDir = () => {
		fs.mkdirSync(path.join(shared, "docs"), { recursive: true });
		fs.writeFileSync(path.join(shared, "docs", "old.md"), "old\n");
		git(shared, "add", "docs/old.md");
		git(shared, "commit", "-qm", "docs");
		fs.writeFileSync(path.join(shared, "docs", "old.md"), "edited\n");
		newFile("docs/new.md");
	};

	it("names the untracked file left behind and hands back the commit script, then the add -N escape (#587)", () => {
		mixedDir();
		const out = run('git commit -m "x" -- docs');
		expect(out).toContain("does not track yet");
		expect(out).toContain("docs/new.md");
		expectScriptAheadOfAddN(out);
		expect(out).toContain("#1651");
	});

	it("warns, never denies — the commit still lands", () => {
		mixedDir();
		expect(verdict('git commit -m "x" -- docs')).toBe("warn");
	});

	it("covers the repo root spelled as a dot", () => {
		mixedDir();
		expect(run('git commit -m "x" -- .')).toContain("docs/new.md");
	});

	it("says nothing when the pathspec names tracked files alone", () => {
		mixedDir();
		expect(verdict('git commit -m "x" -- docs/old.md')).toBe("allow");
	});

	it("says nothing when the directory holds nothing untracked", () => {
		fs.mkdirSync(path.join(shared, "docs"), { recursive: true });
		fs.writeFileSync(path.join(shared, "docs", "old.md"), "old\n");
		git(shared, "add", "docs/old.md");
		git(shared, "commit", "-qm", "docs");
		fs.writeFileSync(path.join(shared, "docs", "old.md"), "edited\n");
		expect(verdict('git commit -m "x" -- docs')).toBe("allow");
	});

	it("says nothing when the only untracked contents are gitignored", () => {
		fs.writeFileSync(path.join(shared, ".gitignore"), "docs/scratch/\n");
		git(shared, "add", ".gitignore");
		fs.mkdirSync(path.join(shared, "docs"), { recursive: true });
		fs.writeFileSync(path.join(shared, "docs", "old.md"), "old\n");
		git(shared, "add", "docs/old.md");
		git(shared, "commit", "-qm", "docs");
		fs.writeFileSync(path.join(shared, "docs", "old.md"), "edited\n");
		newFile("docs/scratch/junk.md");
		expect(verdict('git commit -m "x" -- docs')).toBe("allow");
	});

	it("leaves mantahostels#1612's own message and trigger untouched", () => {
		// A word matching nothing tracked is still mantahostels#1612's, byte for byte.
		newFile("new.md");
		const out = run('git commit -m "x" -- new.md');
		expect(out).toContain("#1612");
		expect(out).not.toContain("#1651");
	});

	it("is outranked by mantahostels#1612 when one command triggers both", () => {
		mixedDir();
		newFile("loose.md");
		const out = run('git commit -m "x" -- docs loose.md');
		expect(out).toContain("#1612");
		expect(out).not.toContain("#1651");
	});

	it("caps a long list with a count rather than printing it whole", () => {
		mixedDir();
		for (let i = 0; i < 14; i++) newFile(`docs/n${i}.md`);
		const out = run('git commit -m "x" -- docs');
		expect(out).toContain("and 5 more");
		// git lists them sorted, so docs/new.md is last of the fifteen and one
		// of the five cut.
		expect(out).not.toContain("docs/new.md");
	});

	it("spends one budget across the whole message, not one per word", () => {
		// Two directory words, eight new files each: ten named, six counted —
		// not ten named per word.
		mixedDir();
		fs.writeFileSync(path.join(shared, "src.md"), "src\n");
		git(shared, "add", "src.md");
		git(shared, "commit", "-qm", "src");
		fs.mkdirSync(path.join(shared, "src"), { recursive: true });
		fs.writeFileSync(path.join(shared, "src", "kept.md"), "kept\n");
		git(shared, "add", "src/kept.md");
		git(shared, "commit", "-qm", "src dir");
		for (let i = 0; i < 7; i++) newFile(`docs/d${i}.md`);
		for (let i = 0; i < 8; i++) newFile(`src/s${i}.md`);
		const out = run('git commit -m "x" -- docs src');
		expect(out).toContain("and 6 more");
	});

	it("is outranked by the sweeping deny in the same command", () => {
		mixedDir();
		expect(verdict('git commit -am "x" -- docs')).toBe("deny");
		expect(denyReason('git commit -am "x" -- docs')).toContain(SWEEPS);
	});

	it("is suppressed mid-merge, like the other pathspec verdicts", () => {
		mixedDir();
		fs.writeFileSync(
			path.join(shared, ".git", "MERGE_HEAD"),
			git(shared, "rev-parse", "HEAD"),
		);
		expect(verdict('git commit -m "x" -- docs')).toBe("allow");
	});

	it("binds in a linked worktree too — it guards no index", () => {
		fs.mkdirSync(path.join(worktree, "docs"), { recursive: true });
		fs.writeFileSync(path.join(worktree, "docs", "old.md"), "old\n");
		git(worktree, "add", "docs/old.md");
		git(worktree, "commit", "-qm", "docs");
		fs.writeFileSync(path.join(worktree, "docs", "old.md"), "edited\n");
		fs.writeFileSync(path.join(worktree, "docs", "new.md"), "new\n");
		expect(verdict('git commit -m "x" -- docs', worktree)).toBe("warn");
	});

	it("says nothing when the pathspec word's text cannot be read", () => {
		mixedDir();
		expect(verdict('git commit -m "x" -- "$PATHS"')).toBe("allow");
	});

	it("says nothing about a glob — the verdict is scoped to a directory word", () => {
		// A quoted glob git expands itself has the same silent harm, and is the
		// verdict's known residual: the boundary is a word that IS a directory.
		mixedDir();
		expect(verdict(`git commit -m "x" -- 'docs/*'`)).toBe("allow");
	});

	it("needs no session id — it reads git, not the write ledger", () => {
		mixedDir();
		expect(run('git commit -m "x" -- docs', shared, null)).toContain("#1651");
	});

	it("leaves a word git cannot answer for unjudged, and records it", () => {
		// A directory outside the repo: git exits 128, so the word is left
		// unjudged rather than guessed at, and mantahostels#147's rule is that it is logged.
		expect(verdict(`git commit -m "x" -- ${dir}`)).toBe("allow");
		const log = path.join(
			config,
			"projects",
			shared.replace(/[^a-zA-Z0-9]/g, "-"),
			"guard-errors.log",
		);
		expect(fs.readFileSync(log, "utf8")).toContain(
			"left unjudged for mantahostels#1651",
		);
	});
});

/*
 * mantahostels#3280. Two warns outranked the pathspec-sweep verdict defectively, and the
 * fix is to those warns rather than to the ordering rule.
 *
 * D1: mantahostels#1612 rests on "git rejects the whole commit, so the sweep never
 * happens". That is false of `git add -N x && git commit … -- x …` — the escape
 * mantahostels#1612 itself prints. The guard judges PreToolUse, so x is untracked here and
 * tracked by the time git runs: the commit succeeds and the sweep did reach the
 * tree.
 *
 * D2: mantahostels#1651 describes a commit that SUCCEEDS and leaves scratch behind, and it
 * took the slot ahead of one that succeeds and takes a neighbour's work.
 */
describe("the warns that outranked the sweep verdict defectively (mantahostels#3280)", () => {
	const doc = "docs/a.md";

	const newFile = (rel: string, text = "new\n") => {
		fs.mkdirSync(path.dirname(path.join(shared, rel)), { recursive: true });
		fs.writeFileSync(path.join(shared, rel), text);
	};

	/** A live session other than the committer, holding `subject` with the tree's current bytes pinned. */
	const neighbour = (subject: string, session = "alice") => {
		fs.mkdirSync(path.join(config, "sessions"), { recursive: true });
		fs.writeFileSync(
			path.join(config, "sessions", `${process.pid}.json`),
			JSON.stringify({
				pid: process.pid,
				sessionId: session,
				procStart: proc.procStartOf(process.pid),
				status: "idle",
				cwd: shared,
			}),
		);
		const me = store.identify(session);
		store.acquire(subject, me);
		store.recordContent(subject, me);
	};

	let savedConfig: string | undefined;
	let savedProject: string | undefined;

	beforeEach(() => {
		savedConfig = process.env.CLAUDE_CONFIG_DIR;
		savedProject = process.env.CLAUDE_PROJECT_DIR;
		process.env.CLAUDE_CONFIG_DIR = config;
		process.env.CLAUDE_PROJECT_DIR = shared;
		newFile(doc, "committed\n");
		git(shared, "add", "-A");
		git(shared, "commit", "-qm", "seed");
		fs.writeFileSync(path.join(shared, doc), "alice's unsaved edit\n");
		neighbour(doc);
	});

	afterEach(() => {
		process.env.CLAUDE_CONFIG_DIR = savedConfig;
		process.env.CLAUDE_PROJECT_DIR = savedProject;
	});

	describe("D1 — a word an earlier segment intent-adds", () => {
		it("lets the sweep verdict through, mantahostels#1612 being a false positive there", () => {
			newFile("new.md");
			const out = run(
				`git add -N new.md && git commit -m "x" -- ${doc} new.md`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		it("suppresses in a linked worktree too, where mantahostels#1612 binds", () => {
			// Which is why the record is taken above the shared-tree gate.
			fs.writeFileSync(path.join(worktree, "new.md"), "new\n");
			expect(
				verdict('git add -N new.md && git commit -m "x" -- new.md', worktree),
			).toBe("allow");
		});

		it("still fires on -n, which stages nothing at all", () => {
			newFile("new.md");
			const out = run(
				`git add -n new.md && git commit -m "x" -- ${doc} new.md`,
			);
			// "mantahostels#1612", not the sentence: mantahostels#1651's text carries the same words.
			expect(out).toContain("#1612");
		});

		it("still fires on a bundle carrying both — -nN is a dry run", () => {
			newFile("new.md");
			expect(
				run(`git add -nN new.md && git commit -m "x" -- ${doc} new.md`),
			).toContain("#1612");
		});

		it("suppresses through a bundled -N, e.g. `git add -vN`", () => {
			newFile("new.md");
			expect(
				run(`git add -vN new.md && git commit -m "x" -- ${doc} new.md`),
			).toContain("#1539");
		});

		it("suppresses only the word actually intent-added", () => {
			newFile("new.md");
			newFile("other.md");
			const out = run(
				`git add -N new.md && git commit -m "x" -- new.md other.md`,
			);
			expect(out).toContain("other.md");
			expect(out).not.toContain("new.md");
		});

		it("suppresses nothing when the add comes AFTER the commit", () => {
			newFile("new.md");
			expect(
				run(`git commit -m "x" -- ${doc} new.md && git add -N new.md`),
			).toContain("#1612");
		});

		it("suppresses across a `./` spelling difference (mantahostels#3315)", () => {
			// The unnormalised string compare read one file as two and fired mantahostels#1612.
			newFile("new.md");
			const out = run(
				`git add -N ./new.md && git commit -m "x" -- ${doc} new.md`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		it("suppresses across a doubled slash in the commit's own word (mantahostels#3315)", () => {
			newFile("new.md");
			const out = run(
				`git add -N new.md && git commit -m "x" -- ${doc} .//new.md`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		it("resolves the word against the add segment's own cwd", () => {
			// `git -C` can differ per segment, so an absolute-path comparison is
			// the only one that holds.
			fs.mkdirSync(path.join(shared, "sub"), { recursive: true });
			newFile("sub/new.md");
			const out = run(
				`git -C ${path.join(shared, "sub")} add -N new.md && git commit -m "x" -- ${doc} sub/new.md`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		it("suppresses a DIRECTORY word the intent-add lands inside (mantahostels#3318)", () => {
			// git tracks src/new.md by the time the commit runs, so `-- src`
			// commits it and exits 0.
			newFile("src/new.md");
			const out = run(
				`git add -N src/new.md && git commit -m "x" -- ${doc} src`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		it("does not let an add under a prefix-sharing sibling suppress the word (mantahostels#3318)", () => {
			// /repo/srcx/other.md is not under /repo/src, so `src` keeps its warn.
			newFile("src/new.md");
			newFile("srcx/other.md");
			const out = run(`git add -N srcx/other.md && git commit -m "x" -- src`);
			expect(out).toContain("#1612");
		});

		it("suppresses a FILE word an intent-add of the directory covers (mantahostels#3321)", () => {
			// `git add -N src` intent-adds every untracked file under src, so
			// src/new.md is tracked by the time the commit runs.
			newFile("src/new.md");
			const out = run(
				`git add -N src && git commit -m "x" -- ${doc} src/new.md`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		it("does not let an add of a prefix-sharing sibling directory suppress the file (mantahostels#3321)", () => {
			newFile("src/new.md");
			newFile("srcx/other.md");
			expect(
				run(`git add -N srcx && git commit -m "x" -- src/new.md`),
			).toContain("#1612");
		});

		it("does not suppress an IGNORED file a plain add of the directory skips (mantahostels#3321)", () => {
			// `git add -N src` leaves src/x.log untracked, so that commit really
			// does fail.
			fs.writeFileSync(path.join(shared, ".gitignore"), "*.log\n");
			newFile("src/x.log");
			expect(run(`git add -N src && git commit -m "x" -- src/x.log`)).toContain(
				"#1612",
			);
		});

		it("suppresses that ignored file once the add carries -f (mantahostels#3321)", () => {
			fs.writeFileSync(path.join(shared, ".gitignore"), "*.log\n");
			newFile("src/x.log");
			const out = run(
				`git add -f -N src && git commit -m "x" -- ${doc} src/x.log`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		it("reads the long --force spelling too (mantahostels#3321)", () => {
			fs.writeFileSync(path.join(shared, ".gitignore"), "*.log\n");
			newFile("src/x.log");
			const out = run(
				`git add --force -N src && git commit -m "x" -- ${doc} src/x.log`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		it("reads -f out of a bundle too, e.g. `git add -fN` (mantahostels#3321)", () => {
			fs.writeFileSync(path.join(shared, ".gitignore"), "*.log\n");
			newFile("src/x.log");
			const out = run(
				`git add -fN src && git commit -m "x" -- ${doc} src/x.log`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		it("expands the directory argument against the add segment's own cwd (mantahostels#3321)", () => {
			fs.mkdirSync(path.join(shared, "sub"), { recursive: true });
			newFile("sub/src/new.md");
			const out = run(
				`git -C ${path.join(shared, "sub")} add -N src && git commit -m "x" -- ${doc} sub/src/new.md`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		/**
		 * A `--pathspec-from-file` list at `rel`, one pathspec per line.
		 * `terminated: false` leaves the last element with no separator after it —
		 * git stages it all the same, so the guard has to read it (mantahostels#3324).
		 */
		const listFile = (
			rel: string,
			lines: string[],
			sep = "\n",
			terminated = true,
		) => {
			newFile(rel, lines.join(sep) + (terminated ? sep : ""));
			return rel;
		};

		it("reads the last line of a list with no terminator after it (mantahostels#3324)", () => {
			newFile("new.md");
			listFile("paths.txt", ["new.md"], "\n", false);
			const out = run(
				`git add -N --pathspec-from-file paths.txt && git commit -m "x" -- ${doc} new.md`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		it("reads the last element of an unterminated NUL list too (mantahostels#3324)", () => {
			newFile("new.md");
			newFile("other.md");
			listFile("paths.bin", ["other.md", "new.md"], "\0", false);
			const out = run(
				`git add -N --pathspec-from-file paths.bin --pathspec-file-nul && git commit -m "x" -- ${doc} new.md`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		it("records a DIRECTORY named as the list, rather than reading it per line (mantahostels#3324)", () => {
			// A directory passes `-r`, so without the `-f` test the read fails once
			// per line with nothing logged and the commit looks judged.
			newFile("new.md");
			fs.mkdirSync(path.join(shared, "listdir"), { recursive: true });
			expect(
				run(
					`git add -N --pathspec-from-file listdir && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
			expect(fs.readFileSync(failOpenLogPath(config, shared), "utf8")).toMatch(
				/could not read the pathspec list/,
			);
		});

		it("suppresses through a --pathspec-from-file list (mantahostels#3324)", () => {
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			const out = run(
				`git add -N --pathspec-from-file paths.txt && git commit -m "x" -- ${doc} new.md`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		it("reads the --pathspec-from-file=<file> spelling too (mantahostels#3324)", () => {
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			const out = run(
				`git add -N --pathspec-from-file=paths.txt && git commit -m "x" -- ${doc} new.md`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		it("suppresses every line of the list, not just the first (mantahostels#3324)", () => {
			newFile("new.md");
			newFile("other.md");
			listFile("paths.txt", ["new.md", "other.md"]);
			const out = run(
				`git add -N --pathspec-from-file paths.txt && git commit -m "x" -- ${doc} new.md other.md`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		it("expands a DIRECTORY line of the list, as a bare word is expanded (mantahostels#3324)", () => {
			newFile("src/new.md");
			listFile("paths.txt", ["src"]);
			const out = run(
				`git add -N --pathspec-from-file paths.txt && git commit -m "x" -- ${doc} src/new.md`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		it("resolves the list file against the add segment's own cwd (mantahostels#3324)", () => {
			fs.mkdirSync(path.join(shared, "sub"), { recursive: true });
			newFile("sub/new.md");
			listFile("sub/paths.txt", ["new.md"]);
			const out = run(
				`git -C ${path.join(shared, "sub")} add -N --pathspec-from-file paths.txt && git commit -m "x" -- ${doc} sub/new.md`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		it("reads a NUL-separated list under --pathspec-file-nul (mantahostels#3324)", () => {
			// The flag is spelled AFTER --pathspec-from-file, which is why it is
			// read in the pre-pass rather than in the word walk.
			newFile("new.md");
			listFile("paths.bin", ["new.md"], "\0");
			const out = run(
				`git add -N --pathspec-from-file paths.bin --pathspec-file-nul && git commit -m "x" -- ${doc} new.md`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		it("takes a NUL list literally — no CR is stripped off it (mantahostels#3324)", () => {
			// The bytes git stages are `new.md\r`, so a guard that stripped the CR
			// would credit a path git never intent-added.
			newFile("new.md");
			listFile("paths.bin", ["new.md\r"], "\0");
			expect(
				run(
					`git add -N --pathspec-from-file paths.bin --pathspec-file-nul && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
		});

		it("strips the CR off a CRLF-separated list, as git does (mantahostels#3324)", () => {
			newFile("new.md");
			listFile("paths.txt", ["new.md"], "\r\n");
			const out = run(
				`git add -N --pathspec-from-file paths.txt && git commit -m "x" -- ${doc} new.md`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		it("suppresses nothing when the list comes from stdin, and records it (mantahostels#3324)", () => {
			// `-` is git's stdin spelling and the hook payload carries no stdin, so
			// the commit keeps its warn. The log entry is what
			// tells that apart from a list this guard read and found empty.
			newFile("new.md");
			expect(
				run(`git add -N --pathspec-from-file - && git commit -m "x" -- new.md`),
			).toContain("#1612");
			expect(fs.readFileSync(failOpenLogPath(config, shared), "utf8")).toMatch(
				/takes its paths from stdin/,
			);
		});

		it("records a list file it could not read, rather than reading none (mantahostels#3324)", () => {
			newFile("new.md");
			expect(
				run(
					`git add -N --pathspec-from-file absent.txt && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
			expect(fs.readFileSync(failOpenLogPath(config, shared), "utf8")).toMatch(
				/could not read the pathspec list/,
			);
		});

		it("suppresses nothing on a C-quoted line, which it does not decode (mantahostels#3324)", () => {
			newFile("new.md");
			listFile("paths.txt", ['"new.md"']);
			expect(
				run(
					`git add -N --pathspec-from-file paths.txt && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
		});

		it("records nothing off the list under -n, which stages nothing (mantahostels#3324)", () => {
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			expect(
				run(
					`git add -nN --pathspec-from-file paths.txt && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
		});

		it("does not record an IGNORED file under a directory line without -f (mantahostels#3324)", () => {
			fs.writeFileSync(path.join(shared, ".gitignore"), "*.log\n");
			newFile("src/x.log");
			listFile("paths.txt", ["src"]);
			expect(
				run(
					`git add -N --pathspec-from-file paths.txt && git commit -m "x" -- src/x.log`,
				),
			).toContain("#1612");
		});

		it("records nothing off a list an earlier segment redirects into (mantahostels#3327)", () => {
			// The list on disk names new.md and the command overwrites it before git
			// reads it, so the guard opens bytes git never sees. Crediting them
			// suppresses the warn on a commit that leaves new.md behind.
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			expect(
				run(
					`printf 'other.md\\n' > paths.txt && git add -N --pathspec-from-file paths.txt && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
			expect(fs.readFileSync(failOpenLogPath(config, shared), "utf8")).toMatch(
				/is rewritten by a redirect in the same command/,
			);
		});

		it("still suppresses where the redirect names some other file (mantahostels#3327)", () => {
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			const out = run(
				`printf 'x\\n' > log.txt && git add -N --pathspec-from-file paths.txt && git commit -m "x" -- ${doc} new.md`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		it("still suppresses through a list the command APPENDS to (mantahostels#3327)", () => {
			// `>>` can only add pathspecs, so what the guard read is a subset of what
			// git stages and the suppression stands.
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			const out = run(
				`printf 'other.md\\n' >> paths.txt && git add -N --pathspec-from-file paths.txt && git commit -m "x" -- ${doc} new.md`,
			);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1612");
		});

		it("treats a redirect target it cannot read as the list itself (mantahostels#3327)", () => {
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			expect(
				run(
					`printf 'x\\n' > $LIST && git add -N --pathspec-from-file paths.txt && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
		});

		it("reads the >| spelling, which the segment split cuts in two (mantahostels#3327)", () => {
			// `_gp_flatten` splits on `|`, so the operator and its target land in
			// different segments and the "target is the next word" flag has to
			// survive the boundary.
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			expect(
				run(
					`printf 'other.md\\n' >| paths.txt && git add -N --pathspec-from-file paths.txt && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
		});

		it("reads a redirect written with no space before its target (mantahostels#3327)", () => {
			// `echo other.md>paths.txt` is one word to this guard and two to bash.
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			expect(
				run(
					`echo other.md>paths.txt && git add -N --pathspec-from-file paths.txt && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
		});

		it("reads an ABSOLUTE redirect target, which no basename arm catches (mantahostels#3327)", () => {
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			expect(
				run(
					`printf 'other.md\\n' > ${path.join(shared, "paths.txt")} && git add -N --pathspec-from-file paths.txt && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
		});

		it("reads a descriptor-prefixed redirect into the list (mantahostels#3327)", () => {
			// `2> paths.txt` writes no pathspec list in practice; reading it costs a
			// false warn, and not reading the prefix at all would cost a lost one.
			newFile("new.md");
			listFile("paths.txt", ["new.md"]);
			expect(
				run(
					`printf 'x\\n' 2> paths.txt && git add -N --pathspec-from-file paths.txt && git commit -m "x" -- new.md`,
				),
			).toContain("#1612");
		});

		it("matches a redirect target by name where it resolves elsewhere (mantahostels#3327)", () => {
			// The redirect names `../paths.txt` against a list read from `sub/`, so
			// the two never compare equal as paths.
			fs.mkdirSync(path.join(shared, "sub"), { recursive: true });
			newFile("sub/new.md");
			listFile("sub/paths.txt", ["new.md"]);
			expect(
				run(
					`printf 'x\\n' > ../paths.txt && git -C ${path.join(shared, "sub")} add -N --pathspec-from-file paths.txt && git commit -m "x" -- sub/new.md`,
				),
			).toContain("#1612");
		});
	});

	describe("D2 — mantahostels#1651's verdict is deferred to the emission foot", () => {
		/** A tracked, modified file and an untracked sibling under `src/`. */
		const mixedDir = () => {
			fs.mkdirSync(path.join(shared, "src"), { recursive: true });
			fs.writeFileSync(path.join(shared, "src", "old.md"), "old\n");
			git(shared, "add", "src/old.md");
			git(shared, "commit", "-qm", "src");
			fs.writeFileSync(path.join(shared, "src", "old.md"), "edited\n");
			newFile("src/new.md");
		};

		it("loses the slot to the sweep verdict on the same command", () => {
			mixedDir();
			const out = run(`git commit -m "x" -- src ${doc}`);
			expect(out).toContain("#1539");
			expect(out).not.toContain("#1651");
		});

		it("loses to the `git add` index warn in a later segment", () => {
			// A behaviour change mantahostels#3280 names: the index warn is the more
			// consequential of the two.
			mixedDir();
			const out = run('git commit -m "x" -- src && git add src/new.md');
			expect(out).toContain("#63");
			expect(out).not.toContain("#1651");
		});

		it("falls through to the bare-commit check it used to short-circuit", () => {
			mixedDir();
			stageSomething(shared, "staged.md");
			const out = run('git commit -m "x" -- src && git commit -m "y"');
			expect(out).toContain("it takes the whole index");
			expect(out).not.toContain("#1651");
		});

		it("still fires where nothing later claims the slot", () => {
			mixedDir();
			expect(run('git commit -m "x" -- src')).toContain("#1651");
		});

		it("still binds in a linked worktree, where the walk returns early", () => {
			fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
			fs.writeFileSync(path.join(worktree, "src", "old.md"), "old\n");
			git(worktree, "add", "src/old.md");
			git(worktree, "commit", "-qm", "src");
			fs.writeFileSync(path.join(worktree, "src", "old.md"), "edited\n");
			fs.writeFileSync(path.join(worktree, "src", "new.md"), "new\n");
			expect(run('git commit -m "x" -- src', worktree)).toContain("#1651");
		});

		it("still loses to mantahostels#1612, which is decided before it", () => {
			mixedDir();
			newFile("loose.md");
			const out = run('git commit -m "x" -- src loose.md');
			expect(out).toContain("#1612");
			expect(out).not.toContain("#1651");
		});
	});
});

/*
 * mantahostels#2016's original version of this block asserted against `template` and
 * `pathBearingFiles` directly, which the migration onto scripts/lib/git-fixture.ts
 * (mantahostels#2068) no longer exposes: the helper leak-checks every instantiate() call
 * itself (proven in git-fixture.test.ts), so THIS beforeEach already throws
 * before any test body runs were the copy still pointing at the template. What
 * is left to assert here, and what mantahostels#2068's acceptance criteria ask for, is
 * what that scan cannot see: that relink() wrote THIS instance's own path
 * rather than some third, wrong one, and — the BEHAVIOURAL limb — that a write
 * made in the instantiated copy does not reach a second, independent
 * instantiation of the same template.
 */
describe("the copied fixture is isolated from its template (mantahostels#2016, mantahostels#2068)", () => {
	const freshCopy = () => {
		const fresh = mkScratchDir("guard-commit-form-fresh-");
		try {
			template.instantiate(fresh);
		} catch (err) {
			fs.rmSync(fresh, { recursive: true, force: true });
			throw err;
		}
		return fresh;
	};

	it("each copy's core.hooksPath is relinked, not left pointing at the template", () => {
		// Writing a commit into the copy's own real .git (the shape this
		// replaced) proves nothing about relinking: nothing that write touches
		// is one of git-fixture's path carriers, so it cannot fail on a relink
		// regression. This instead reads back the relinked file directly.
		// Asserting merely "exists and is empty" would pass even with relink()
		// disabled: the template's own no-hooks dir is exists-and-empty too, so a
		// stale pointer left aimed at the TEMPLATE would read identically.
		// Anchoring on `dir` — this instance's own root — is what tells a
		// relinked path apart from a leaked one. What these assertions catch
		// that checkForLeak() cannot is a relink writing some third, wrong path,
		// which can hit one copy and not the other — hence both (mantahostels#2193 review).
		// Reading the beforeEach instance rather than minting a second one
		// (mantahostels#2232) rests on this block sitting last in the file, so that
		// instance is a LATE instantiation. Run this test alone — it.only, or
		// -t — and it becomes the first, and "relink is still correct on a copy
		// after the first" goes unasserted. "a commit made in the copied
		// WORKTREE leaves the template untouched" keeps freshCopy(), where a
		// second, independent instance IS the assertion.
		for (const repo of [shared, elsewhere]) {
			const hooksPath = git(repo, "config", "core.hooksPath").trim();
			expect(hooksPath).toBe(path.join(dir, "no-hooks"));
			expect(fs.existsSync(hooksPath)).toBe(true);
			expect(fs.readdirSync(hooksPath)).toEqual([]);
		}
	});

	it("a commit made in the copied WORKTREE leaves the template untouched", () => {
		// The worktree shares its parent's object store, so a stale gitdir
		// pointer here writes into the template rather than failing loudly.
		fs.writeFileSync(path.join(worktree, "c.md"), "c\n");
		git(worktree, "add", "c.md");
		git(worktree, "commit", "-qm", "worktree copy only", "--", "c.md");
		expect(git(worktree, "log", "--oneline")).toContain("worktree copy only");

		const fresh = freshCopy();
		try {
			expect(
				git(path.join(fresh, "shared"), "log", "--all", "--oneline"),
			).not.toContain("worktree copy only");
		} finally {
			fs.rmSync(fresh, { recursive: true, force: true });
		}
	});

	// A commit made in the 'elsewhere' copy's own real .git (dropped here,
	// mantahostels#2193) has the same defect mantahostels#2178 fixed for the shared-copy test above:
	// nothing that write touches is a git-fixture path carrier, so it cannot
	// fail on a relink regression. "each copy's core.hooksPath is relinked"
	// above reads `elsewhere` as well as `shared` in its place.
	//
	// A bare exists-and-empty assertion on core.hooksPath (dropped here, mantahostels#2233)
	// is a strict subset of that same test, which already says why it catches
	// nothing. guard-pull-form and guard-parse carried no such duplicate.
});
