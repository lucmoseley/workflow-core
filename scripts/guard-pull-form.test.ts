// @vitest-environment node
/*
 * guard-pull-form.sh denies a non-fast-forward reconciliation of the shared
 * `main` (mantahostels#245) — and, since #765 and #768, a rewind of `main` and a
 * discard of the shared tree's uncommitted work — and a deny is only
 * defensible while it cannot wedge sanctioned work. Every allow-case below is
 * a shape that would otherwise be a false positive; do not thin them out.
 *
 * The guard compares the target tree against CLAUDE_PROJECT_DIR's, so a
 * throwaway repo stands in for the shared tree and a worktree of it for the
 * exempt case.
 *
 * It runs as a `PreToolUse` Bash hook (`self-plugin/hooks/hooks.json`,
 * `hooks/hooks.json`): loosen a deny case and a merge, rebase, rewind or
 * discard in the shared tree can wipe a neighbour's commits or uncommitted
 * edits; lose an allow case and `git pull --ff-only` or the worktree merge
 * recipe is wedged.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeFailOpenLog, failOpenLogPath } from "./guard-log-fixture";
import { describeSharedParserLibrary } from "./guard-parse-fixture";
import { defineTemplate, mkScratchDir, trioTemplate } from "./lib/git-fixture";
import { denyFires } from "./lib/guard-fires-testkit";
import {
	buildBashPayload,
	guardOutput,
	spawnGuard,
} from "./lib/pretool-guard-testkit";

const GUARD = path.resolve(__dirname, "guard-pull-form.sh");

let dir: string;
let config: string;
let shared: string;
let worktree: string;
let elsewhere: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

/*
 * Built once and copied, not rebuilt per test, via scripts/lib/git-fixture.ts
 * (mantahostels#2068) — its own header explains what a naive copy breaks and why.
 */
const template = defineTemplate(trioTemplate());

/** Runs the guard on `command`, as Claude Code would. */
const runGuard = (command: string, cwd = shared) =>
	spawnGuard(GUARD, buildBashPayload(command, "test"), {
		project: shared,
		config,
		cwd,
	});

const verdict = (command: string, cwd = shared) => {
	const r = runGuard(command, cwd);
	return /"permissionDecision"\s*:\s*"deny"/.test(r.stdout ?? "")
		? "deny"
		: "allow";
};

/** The refusal `command` earns, as the session reads it. Throws on an allow. */
const denyReason = (command: string, cwd = shared) => {
	const r = runGuard(command, cwd);
	if (!r.stdout?.trim()) throw new Error(`expected a deny for: ${command}`);
	return JSON.parse(r.stdout).hookSpecificOutput
		.permissionDecisionReason as string;
};

/* The store's Node accessor, so a test asks for a rule by id rather than
 * holding a second copy of its text. CommonJS, hence the require. */
// biome-ignore lint/suspicious/noExplicitAny: untyped CommonJS helper
const { ruleText } = require("./lib/rule-text") as any;

beforeEach(() => {
	dir = mkScratchDir("guard-pull-form-");
	config = path.join(dir, "claude-config");
	shared = path.join(dir, "shared");
	worktree = path.join(dir, "wt");
	elsewhere = path.join(dir, "elsewhere");
	template.instantiate(dir);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

/*
 * Keyed by fragment id, for the reason guard-branch.test.ts gives in full.
 */
const pullRule = () => ruleText("pull-fast-forward");

describe("the relocated rule reaches the session that trips the guard", () => {
	it.each([
		["git pull", "a bare pull, which may rebase or merge by config"],
		["git pull --rebase", "the #245 command exactly"],
	])("%s carries the whole rule — %s", (command) => {
		expect(denyReason(command)).toContain(pullRule());
	});

	/* MUTATION ANCHORS — guard-branch.test.ts carries the rationale. */
	it.each([
		["git pull --ff-only", "the spelling that replaces the refused one"],
		["fast-forward", "the invariant itself"],
		["2026-08-03", "the date the rewrite was measured"],
		["A MERGE OR A REBASE IN THE SHARED TREE IS REFUSED", "the #290 limb"],
		["git fetch", "the operation that is always safe"],
		["git worktree add -b reconcile-", "where a divergence is reconciled"],
		["git merge --ff-only reconcile-", "how the shared tree takes the result"],
		["npm run test", "the suite the worktree runs before the fast-forward"],
	])("a pull refusal still carries %s — %s", (clause) => {
		expect(denyReason("git pull")).toContain(clause);
	});
});

/*
 * THE SECOND LIMB (mantahostels#1648, spec mantahostels#1762): the same fragment, handed over before the
 * mistake rather than inside the refusal — and `git pull --ff-only`, the
 * sanctioned spelling, reaches it every time.
 *
 * A guard that started denying `--ff-only` would refuse the only reconciliation
 * the rule allows, so every case asserts no `permissionDecision`.
 */
describe("the rule reaches a session BEFORE it trips the guard (mantahostels#1648)", () => {
	/** The whole hook output for `command`, parsed. Null where it said nothing. */
	const emission = (command: string, session = "test", cwd = shared) =>
		guardOutput(GUARD, buildBashPayload(command, session), {
			project: shared,
			config,
			cwd,
		});

	it.each([
		["git pull --ff-only", "the sanctioned spelling"],
		["git pull --ff-only origin main", "with the remote named"],
		["git fetch && git pull --ff-only", "at the tail of a chain"],
	])("%s is handed the rule and NOT refused — %s", (command) => {
		const out = emission(command);
		expect(out).not.toBeNull();
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain(pullRule());
	});

	/* MUTATION ANCHORS for the injected copy, as above for the refusal. */
	it.each([
		["git pull --ff-only", "the spelling to use"],
		["A MERGE OR A REBASE IN THE SHARED TREE IS REFUSED", "the #290 limb"],
		["git worktree add -b reconcile-", "what to do when the pull refuses"],
	])("the pre-emptive injection still carries %s — %s", (clause) => {
		expect(emission("git pull --ff-only").additionalContext).toContain(clause);
	});

	it("hands the landing recipe in place of today's with the landing module on (#2409)", () => {
		const out = guardOutput(
			GUARD,
			buildBashPayload("git pull --ff-only", "test"),
			{
				project: shared,
				config,
				cwd: shared,
				env: { WFC_MODULES: "landing" },
			},
		);
		expect(out.additionalContext).toContain(
			ruleText("pull-fast-forward-landing"),
		);
		expect(out.additionalContext).not.toContain(pullRule());
		expect(
			emission("git pull --ff-only", "off").additionalContext,
		).not.toContain("origin/landing");
	});

	it("refuses a merge with the landing recipe and its upstream with the module on (#2409)", () => {
		const out = guardOutput(
			GUARD,
			buildBashPayload("git merge origin/landing", "test"),
			{ project: shared, config, cwd: shared, env: { WFC_MODULES: "landing" } },
		);
		expect(out.permissionDecisionReason).toContain(
			ruleText("pull-fast-forward-landing"),
		);
	});

	it("says it once per session, and again for a different session", () => {
		expect(emission("git pull --ff-only", "sess-A")).not.toBeNull();
		expect(emission("git pull --ff-only", "sess-A")).toBeNull();
		expect(emission("git pull --ff-only", "sess-B")).not.toBeNull();
	}, 30_000);

	it.each([
		["git pull --help", "documentation reconciles nothing"],
		["git fetch origin", "a fetch moves no local ref"],
		["git status", "not a pull at all"],
		["git merge --abort", "unwinding starts no reconciliation"],
		["git rebase --continue", "nor does finishing one"],
	])("%s is handed nothing — %s", (command) => {
		expect(emission(command)).toBeNull();
	});

	it("the recipe's own last step is handed the rule too (#290)", () => {
		// `git merge --ff-only` is where a session lands at the end of the
		// worktree detour, and it is allowed — so the rule reaches it as context.
		const out = emission("git merge --ff-only reconcile-290");
		expect(out).not.toBeNull();
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain(pullRule());
	});

	it("a denied pull carries the rule in its refusal, not as context", () => {
		// The two limbs are exclusive: gp_deny exits before the foot of the guard
		// is reached, so a refused session gets one copy and not two.
		const out = emission("git pull --rebase");
		expect(out.permissionDecision).toBe("deny");
		expect(out.additionalContext).toBeUndefined();
		expect(out.permissionDecisionReason).toContain(pullRule());
	});
});

describe("a rewrite or merge of the shared main is denied", () => {
	it.each([
		["git pull --rebase", "the 2026-08-03 command exactly"],
		["git pull --rebase origin main", "with an explicit refspec"],
		["git pull -r", "the short spelling"],
		["git pull --rebase=merges", "a valued form is still a rebase"],
		[
			"git pull --rebase=false",
			"a merge rather than a rebase, but still not a fast-forward",
		],
		["git pull", "bare: merges, because pull.ff is unset here"],
		["git pull origin main", "bare with a refspec"],
		["git pull --no-rebase", "an explicit merge"],
		["git pull --no-ff", "a merge commit forced"],
		["npm run test && git pull", "later in a chain"],
		["GIT_PAGER=cat git pull --rebase", "behind an env assignment"],
	])("%s — %s", (command) => {
		// exempt (mantahostels#2145): the guard has one deny message, and each spelling here is
		// its own whole command, so no other trigger is available; its text is
		// pinned by "tells the session what to run instead" below.
		expect(verdict(command)).toBe("deny");
	});

	it("sees the shared tree through a variable the command assigned (mantahostels#208)", () => {
		const command = `WT=${shared} && git -C "$WT" pull --rebase`;
		expect(verdict(command)).toBe("deny");
		// The chain has two segments, so the refusal must name the pull one.
		expect(denyReason(command)).toContain('git -C "…" pull --rebase');
	});

	it("resolves a leading cd, so the tree is judged not the caller's cwd", () => {
		const command = `cd ${shared} && git pull --rebase`;
		expect(verdict(command, elsewhere)).toBe("deny");
		expect(denyReason(command, elsewhere)).toContain("git pull --rebase");
	});

	it("resolves git -C, including from inside a worktree", () => {
		// exempt (mantahostels#2145): one command, one segment, and the guard's single deny
		// message is pinned by "tells the session what to run instead" below.
		expect(verdict(`git -C ${shared} pull --rebase`, worktree)).toBe("deny");
	});

	it("tells the session what to run instead", () => {
		const r = runGuard("git pull --rebase");
		const reason = JSON.parse(r.stdout).hookSpecificOutput
			.permissionDecisionReason;
		expect(reason).toContain("git pull --ff-only");
		expect(reason).toContain("git pull --rebase");
	});

	it("echoes the command back readably, not as the sentinel byte (mantahostels#138)", () => {
		// gp_split_segments blanks every quoted span to \x01QSTR\x01 before the
		// guard ever sees it, so echoing the segment raw prints that byte at the
		// user. gp_unmask is what puts a readable "…" back.
		const r = runGuard('git pull --rebase "origin main"');
		expect(r.stdout).not.toContain("QSTR");
		const reason = JSON.parse(r.stdout).hookSpecificOutput
			.permissionDecisionReason;
		expect(reason).toContain('git pull --rebase "…"');
	});
});

/*
 * The allow-cases are the load-bearing half: a session stranded mid-merge must
 * still be able to unwind, and the recipe's own last step is a merge.
 */
describe("a merge or rebase reaching the shared tree directly is denied (#290)", () => {
	it.each([
		["git merge origin/main", "the spelling the founder ran by hand"],
		["git merge --no-ff origin/main", "a merge commit forced"],
		[
			"git merge --squash origin/main",
			"squashed, but still not a fast-forward",
		],
		[
			'git merge -m "reconcile" origin/main',
			"with a message, whose value is not read as a flag",
		],
		["git rebase origin/main", "the re-parenting this rule exists to stop"],
		["git rebase -i origin/main", "interactive"],
		["git rebase --onto main topic", "with an explicit base"],
		[
			"git fetch origin && git merge origin/main",
			"after the fetch that precedes it",
		],
	])("%s — %s", (command) => {
		// exempt (mantahostels#2145): the guard has one deny message for every reason, and it
		// is pinned by "the refusal carries the worktree recipe" below.
		expect(verdict(command)).toBe("deny");
	});

	it("the refusal carries the worktree recipe, not just a refusal", () => {
		const reason = denyReason("git merge origin/main");
		expect(reason).toContain(pullRule());
		expect(reason).toContain("git worktree add -b reconcile-");
		expect(reason).toContain("git merge origin/main");
	});

	it("resolves the tree, so another repo's merge is left alone", () => {
		expect(verdict(`git -C ${elsewhere} merge origin/main`)).toBe("allow");
		expect(verdict("git rebase origin/main", elsewhere)).toBe("allow");
	});

	it("a linked worktree is where the reconciliation belongs, so it is exempt", () => {
		expect(verdict("git merge origin/main", worktree)).toBe("allow");
		expect(verdict("git rebase origin/main", worktree)).toBe("allow");
	});

	it("text merely mentioning the merge is not a merge", () => {
		expect(verdict("echo 'git merge origin/main'")).toBe("allow");
		expect(verdict('grep -rn "git rebase origin/main" docs/')).toBe("allow");
	});
});

describe("the shapes #290 must not wedge", () => {
	it("the recipe's own last step passes", () => {
		expect(verdict("git merge --ff-only reconcile-290")).toBe("allow");
		expect(verdict("git merge --ff-only origin/main")).toBe("allow");
	});

	it.each([
		["git merge --abort", "unwinding a merge already under way"],
		["git merge --continue", "finishing one"],
		["git merge --quit", "leaving the index alone"],
		["git rebase --abort", "unwinding a rebase"],
		["git rebase --continue", "finishing one"],
		["git rebase --skip", "dropping one of its commits"],
		["git rebase --edit-todo", "editing its plan"],
	])("%s passes — %s", (command) => {
		// A tree stranded mid-merge with no way out is worse than the merge that
		// stranded it, so these are allowed on either subcommand.
		expect(verdict(command)).toBe("allow");
	});

	it.each([
		["git merge --help", "documentation merges nothing"],
		["git rebase -h", "the short spelling"],
	])("%s passes — %s", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it.each([
		["git merge-base --is-ancestor a b", "what concision-backstop.sh runs"],
		["git merge-tree a b", "a read-only three-way merge"],
	])("%s is a different subcommand, not a merge — %s", (command) => {
		// The walker matches the subcommand word whole, so a hyphenated neighbour
		// is never the merge this guard judges.
		expect(verdict(command)).toBe("allow");
	});

	it.each([
		[
			"git merge --ff-only --no-ff origin/main",
			"--no-ff wins, so it is a merge commit",
		],
		["git merge --ff-only --ff origin/main", "--ff wins the same way"],
	])("%s is denied — %s", (command) => {
		// git takes the last of the three, and so does the scan.
		expect(verdict(command)).toBe("deny");
	});

	it("but --ff-only spelled last still passes", () => {
		expect(verdict("git merge --no-ff --ff-only reconcile-290")).toBe("allow");
	});

	it("a rebase cannot buy its way out with --ff-only", () => {
		// git rebase has no fast-forward-only mode; the flag would be an unknown
		// option to git, and reading it as an excuse here would open the hole.
		expect(verdict("git rebase --ff-only origin/main")).toBe("deny");
	});

	/*
	 * #302: each flag reads the next word exactly as git 2.43.0 does, measured
	 * per flag — gp_git_value_flags carries the derivation.
	 */
	it.each([
		["git merge -S --ff-only origin/main", "-S signs; its key is never a word"],
		["git rebase -S --continue", "the same under rebase"],
		["git rebase -m --abort", "-m under rebase is --merge, taking nothing"],
	])("%s passes — %s", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it.each([
		[
			"git merge --strategy --ff-only origin/main",
			"--ff-only is the strategy's name, so this is a real merge",
		],
		["git rebase --onto --abort main", "--abort is the new base"],
		["git pull -j --rebase", "-j takes a job count only stuck on"],
	])("%s is denied — %s", (command) => {
		expect(verdict(command)).toBe("deny");
	});

	it("pull.ff=only does not excuse a direct merge", () => {
		// The config governs `git pull` alone — `git merge origin/main` under it
		// merges exactly as it does without it.
		git(shared, "config", "pull.ff", "only");
		expect(verdict("git merge origin/main")).toBe("deny");
		expect(verdict("git rebase origin/main")).toBe("deny");
	});
});

describe("a fast-forward is the sanctioned route and passes", () => {
	it.each([
		["git pull --ff-only", "the rule's own recipe"],
		["git pull --ff-only origin main", "with an explicit refspec"],
		["git pull --ff-only --quiet", "alongside other flags"],
		["git pull --help", "documentation touches no ref"],
		["git pull -h", "the short spelling of help"],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it("a repo configured pull.ff=only makes a bare pull safe by its spelling", () => {
		// git itself refuses anything but a fast-forward under this config.
		git(shared, "config", "pull.ff", "only");
		expect(verdict("git pull")).toBe("allow");
		expect(verdict("git pull origin main")).toBe("allow");
	});

	it("but a flag countermanding that config is still denied, echoing the command", () => {
		git(shared, "config", "pull.ff", "only");
		// guard-pull-form.sh has one deny message for every reason (mantahostels#2145), so
		// this only pins that the countermanding command was the segment echoed
		// back — not which branch of judge() produced the deny.
		for (const command of [
			"git pull --no-ff",
			"git pull --ff",
			"git pull --no-rebase",
			"git pull --rebase",
		]) {
			expect(verdict(command)).toBe("deny");
			expect(denyReason(command)).toContain(command);
		}
	});

	it("fetch moves no local ref, so it is never matched", () => {
		expect(verdict("git fetch origin main")).toBe("allow");
		expect(verdict("git fetch --all")).toBe("allow");
	});

	it("ordinary git work is untouched", () => {
		expect(verdict("git status")).toBe("allow");
		expect(verdict("git push origin main")).toBe("allow");
		expect(verdict('git commit -m "x" -- a.md')).toBe("allow");
	});
});

describe("text that merely mentions a pull is not a pull", () => {
	it.each([
		['grep -rn "git pull --rebase" docs/', "a search"],
		["echo 'git pull --rebase'", "a single-quoted mention"],
		['echo "a | git pull --rebase"', "a pipe inside a quoted string"],
		["cat <<EOF > f.md\ngit pull --rebase\nEOF", "a heredoc body"],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("allow");
	});
});

describe("trees this guard has no business in", () => {
	it("a linked worktree is exempt — its ref is its own", () => {
		expect(verdict("git pull --rebase", worktree)).toBe("allow");
		expect(verdict("git pull", worktree)).toBe("allow");
	});

	it("an unrelated repository is left alone", () => {
		expect(verdict(`git -C ${elsewhere} pull --rebase`)).toBe("allow");
		expect(verdict("git pull --rebase", elsewhere)).toBe("allow");
	});

	it("fails open on a bare pull whose path it cannot resolve rather than wedging the run", () => {
		expect(verdict('cd "$CLAUDE_JOB_DIR/tmp/sync" && git pull')).toBe("allow");
	});
});

describe("hard cases at the edge of the parser", () => {
	it("a subshell or command substitution cannot hide the pull", () => {
		// The refusal echoes the segment it fired on, so it must be the pull
		// itself rather than the wrapper the parser was asked to see through.
		for (const command of ["(git pull --rebase)", "x=$(git pull --rebase)"]) {
			expect(verdict(command)).toBe("deny");
			expect(denyReason(command)).toContain("git pull --rebase");
		}
	});

	it("<< inside a quoted string does not open a heredoc", () => {
		// Otherwise it swallows every line after it, the pull included.
		const command = 'echo "a << b"\ngit pull --rebase';
		expect(verdict(command)).toBe("deny");
		expect(denyReason(command)).toContain("git pull --rebase");
	});

	it("still strips a genuine heredoc, including a quoted delimiter", () => {
		expect(verdict("cat <<'EOF' > f.md\ngit pull --rebase\nEOF")).toBe("allow");
		expect(verdict("cat <<EOF > f.md\ngit pull --rebase\nEOF")).toBe("allow");
	});

	it("a value merely containing an r is not the -r flag", () => {
		// A value-taking letter ends the bundle walk, so the r inside a strategy
		// option's value is never read as --rebase.
		expect(verdict("git pull --ff-only -Xtheirs")).toBe("allow");
		expect(verdict("git pull --ff-only -s recursive")).toBe("allow");
		expect(verdict("git pull --ff-only --strategy-option=theirs")).toBe(
			"allow",
		);
	});

	it("reads no flag at all out of a strategy option's value", () => {
		// -Xtheirs alone does not prove it: an h in the value stops the walk as
		// `-h` before it ever reaches an r. `renormalize` is a real -X value whose
		// first letter is the r this guard denies on.
		expect(verdict("git pull --ff-only -Xrenormalize")).toBe("allow");
	});

	it("reads -s -r as a strategy named -r, not as a rebase flag", () => {
		// git's own parser takes the next word as -s's value even when it begins
		// with a dash — the measurement is on the guard's own LIMITS block.
		// Without the --ff-only this would be denied anyway, as a bare pull.
		expect(verdict("git pull --ff-only -s -r")).toBe("allow");
	});

	it("a bundled -r is a rebase, even under pull.ff=only", () => {
		// Measured on git 2.43.0: pull.ff=only does NOT stop an explicit --rebase,
		// it rebases and rewrites the local commit.
		git(shared, "config", "pull.ff", "only");
		for (const command of [
			"git pull -qr",
			"git pull -rq",
			"git pull -qr origin main",
		]) {
			expect(verdict(command)).toBe("deny");
			// guard-pull-form.sh has one deny message for every reason (mantahostels#2145), so
			// this only pins the echoed segment — not that -r was read rather than
			// pull.ff=only going unchecked.
			expect(denyReason(command)).toContain(command);
		}
	});

	it("a later --no-ff or --ff countermands --ff-only, as git does (#308)", () => {
		expect(verdict("git pull --ff-only --no-ff")).toBe("deny");
		expect(verdict("git pull --ff-only --ff")).toBe("deny");
		expect(verdict("git pull --no-ff --ff-only")).toBe("allow");
	});

	it("--rebase=false is a merge, so --ff-only alongside it still passes", () => {
		expect(verdict("git pull --rebase=false --ff-only")).toBe("allow");
		for (const command of ["git pull --rebase=false", "git pull --rebase=no"]) {
			expect(verdict(command)).toBe("deny");
			expect(denyReason(command)).toContain(command);
		}
	});
});

/*
 * mantahostels#123 moved the parser this guard shares with guard-branch.sh and
 * guard-commit-form.sh into scripts/lib/guard-parse.sh.
 */

describeSharedParserLibrary({
	guard: GUARD,
	denyCommand: "git pull --rebase",
	ctx: () => ({ dir, shared, elsewhere }),
});

/*
 * The helper leak-checks every instantiate() call itself (proven in
 * git-fixture.test.ts), so the beforeEach above already throws before any
 * test body runs were the copy still pointing at the template. What is left
 * to assert here is what that scan cannot see: that relink() wrote THIS
 * instance's own path rather than some third, wrong one, and — the BEHAVIOURAL
 * limb — that a write made in the instantiated copy does not reach a second,
 * independent instantiation of the same template.
 */
describe("the copied fixture is isolated from its template (mantahostels#2068)", () => {
	const freshCopy = () => {
		const fresh = mkScratchDir("guard-pull-form-fresh-");
		try {
			template.instantiate(fresh);
		} catch (err) {
			fs.rmSync(fresh, { recursive: true, force: true });
			throw err;
		}
		return fresh;
	};

	// A commit made in the copy's own real .git (dropped here, mantahostels#2178) proves
	// nothing about relinking: nothing that write touches is one of
	// git-fixture's path carriers, so it cannot fail on a relink regression.
	// The worktree and core.hooksPath cases below are the ones that do.

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

	it("each copy's core.hooksPath is relinked, not left pointing at the template", () => {
		// Reads back the relinked path directly (mantahostels#2193). Asserting
		// merely "exists and is empty" would pass even with relink()
		// disabled: the template's own no-hooks dir is exists-and-empty too, so a
		// stale pointer left aimed at the TEMPLATE would read identically.
		// Anchoring on `dir` — this instance's own root — is what tells a
		// relinked path apart from a leaked one. What these assertions catch
		// that checkForLeak() cannot is a relink writing some third, wrong path,
		// which can hit one copy and not the other — hence both (mantahostels#2193).
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
});

const payload = (command: string) => buildBashPayload(command, "test");

describeFailOpenLog({
	guard: GUARD,
	denied: payload("git pull --rebase"),
	fieldless: { session_id: "test", tool_name: "Bash", tool_input: {} },
	fieldlessMatch: /no command in payload/,
	benign: payload("git status"),
	ctx: () => ({ dir, config, project: shared }),
});

/*
 * #301.
 *
 * An EMPTY `-C` or `cd` target is not an unknown tree: git and bash both run
 * against the cwd, so the parser now resolves it and the command is judged
 * where it actually lands.
 *
 * A target the parser cannot EXPAND is genuinely unknown, and on `merge` and
 * `rebase` it now fails CLOSED — the command reconciles wherever it lands, and
 * the shared tree is one of the candidates. The false denies that buys are
 * pinned below deliberately: `git -C "$ELSEWHERE" merge` is refused even
 * though the tree is innocent, and the escape is a literal path.
 */
describe("an empty -C or cd target is the cwd, not an unknown tree (#301)", () => {
	it.each([
		['git -C "" merge origin/main', "an empty -C runs here"],
		['cd "" && git merge origin/main', "and so does an empty cd"],
		['git -C "" rebase origin/main', "the same for a rebase"],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("deny");
	});

	it("gets the ordinary refusal, because the tree is known", () => {
		// Not the ambiguity refusal: nothing here is ambiguous. If this ever
		// reads as the #301 wording, the parser has stopped resolving the empty
		// case and the deny is coming from the fail-closed limb by accident.
		const reason = denyReason('git -C "" merge origin/main');
		expect(reason).toContain("This reconciles the shared `main`");
		expect(reason).not.toContain("I cannot tell which working tree");
	});

	it("is resolved, not blanket-denied — elsewhere it still passes", () => {
		expect(verdict('git -C "" merge origin/main', elsewhere)).toBe("allow");
		expect(verdict('cd "" && git merge origin/main', worktree)).toBe("allow");
	});
});

describe("a merge or rebase onto a tree it cannot resolve fails closed (#301)", () => {
	it.each([
		['git -C "$W" merge origin/main', "an unset variable runs HERE"],
		['git -C "$(mktemp -d)" merge origin/main', "a command substitution"],
		['cd "$TARGET" && git merge origin/main', "a cd it cannot expand"],
		[
			'cd "$TARGET" && git rebase origin/main',
			"the rebase reached the same way",
		],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("deny");
	});

	it("says what it could not resolve, and hands over the literal escape", () => {
		const reason = denyReason('git -C "$W" merge origin/main');
		expect(reason).toContain("I cannot tell which working tree");
		expect(reason).toContain("git -C .claude/worktrees/reconcile");
		expect(reason).toContain(pullRule());
	});

	it("refuses an innocent tree too — the accepted cost of failing closed", () => {
		// The tree is `elsewhere` and the merge is harmless, but the guard cannot
		// know that.
		expect(verdict('E=$OTHER; git -C "$E" merge origin/main')).toBe("deny");
		expect(verdict(`git -C ${elsewhere} merge origin/main`)).toBe("allow");
	});

	it("a merge that can only fast-forward is safe wherever it lands", () => {
		expect(verdict('git -C "$W" merge --ff-only origin/main')).toBe("allow");
		expect(verdict('cd "$TARGET" && git merge --ff-only reconcile-301')).toBe(
			"allow",
		);
	});

	it("unwinding one already under way is never refused", () => {
		expect(verdict('cd "$TARGET" && git merge --abort')).toBe("allow");
		expect(verdict('git -C "$W" rebase --continue')).toBe("allow");
	});

	it("the recipe's own merge still passes, R assigned literally", () => {
		// The rule text's `ONE Bash call` comment is what makes this resolvable,
		// and the fail-closed limb is what now enforces that comment.
		expect(
			verdict('R=.claude/worktrees/reconcile && git -C "$R" merge origin/main'),
		).toBe("allow");
	});
});

/*
 * Only a bare pull's verdict needs the tree — its pull.ff config — so only it
 * keeps the fail-open (#308).
 */
describe("a pull onto a tree it cannot resolve is judged on its flags (#308)", () => {
	it.each([
		['git -C "$W" pull --rebase origin main', "the mantahostels#245 shape"],
		['cd "$W" && git pull -qr', "a bundled -r"],
		['git -C "$W" pull --rebase=false', "a valued rebase flag"],
		['git -C "$W" pull --no-ff origin main', "a merge commit"],
		['git -C "$W" pull --ff', "a merge where it cannot fast-forward"],
		['git -C "$W" pull --no-rebase', "a merge by config"],
		['git -C "$W" pull --ff-only --no-ff', "git takes the last of the two"],
	])(
		"%s is denied, with nothing written to the fail-open log — %s",
		(command) => {
			expect(verdict(command)).toBe("deny");
			expect(fs.existsSync(failOpenLogPath(config, shared))).toBe(false);
		},
	);

	it("is refused for its flag, not for the tree it could not read", () => {
		// Spelling the path literally would not help, so the refusal must not
		// offer it.
		const reason = denyReason('git -C "$W" pull --rebase origin main');
		expect(reason).toContain("not by fast-forward");
		expect(reason).not.toContain("I cannot tell which working tree");
	});

	it("--ff-only passes unrecorded, the last word winning", () => {
		expect(verdict('cd "$TARGET" && git pull --ff-only')).toBe("allow");
		expect(verdict('git -C "$W" pull --no-ff --ff-only')).toBe("allow");
		expect(fs.existsSync(failOpenLogPath(config, shared))).toBe(false);
	});

	it("a bare pull keeps the fail-open and its record", () => {
		expect(verdict('cd "$TARGET" && git pull')).toBe("allow");
		expect(fs.readFileSync(failOpenLogPath(config, shared), "utf8")).toMatch(
			/could not resolve the working tree for a git pull/,
		);
	});
});

describe("a pull it cannot judge is recorded, not just allowed", () => {
	it("logs a pull whose working tree cannot be resolved", () => {
		// An unexpanded variable in the cd target: the guard does not know which
		// tree the pull lands on, so it allows — and the fail-open is the whole
		// finding, because this is a reconciliation it declined to judge.
		const r = runGuard("cd $TARGET && git pull");
		// It allows — never a deny. The session is also handed the rule
		// pre-emptively (mantahostels#1648's second limb), which is additionalContext.
		expect(r.stdout ?? "").not.toMatch(/"permissionDecision"/);
		const log = failOpenLogPath(config, shared);
		expect(fs.readFileSync(log, "utf8")).toMatch(
			/could not resolve the working tree for a git pull/,
		);
	});
});

/* The shared tree needs a second commit for HEAD~1 to name one. */
describe("rewinding main is refused (#765)", () => {
	const rewindRule = () => ruleText("main-rewind");

	beforeEach(() => {
		fs.writeFileSync(path.join(shared, "b.md"), "b\n");
		git(shared, "add", "b.md");
		git(shared, "commit", "-qm", "second", "--", "b.md");
	});

	it.each([
		["git reset --hard HEAD~1", "the hard form"],
		["git reset --soft HEAD~1", "the soft form"],
		["git reset --mixed HEAD~1", "the mixed form, spelled"],
		["git reset HEAD~1", "the mixed default"],
		["git reset --keep HEAD~1", "keeping local changes"],
		["git reset --merge HEAD~1", "merging local changes"],
		["git reset -q HEAD~1 --", "a commit with no path after the --"],
		["git reset $SHA", "a commit it cannot read"],
		["git update-ref refs/heads/main HEAD~1", "the ref written directly"],
		["git update-ref -m why refs/heads/main HEAD~1", "past a -m value"],
		["git update-ref -d refs/heads/main", "deleted directly"],
		["git update-ref HEAD HEAD~1", "HEAD, which is main here"],
		["git update-ref --stdin", "a list it cannot read"],
		["git branch -f main HEAD~1", "forced"],
		["git branch --force main HEAD~1", "forced, long"],
		["git branch -D main", "deleted"],
		["git branch -d main", "deleted, merged or not"],
		["git branch -M side main", "renamed onto"],
		["git branch -C side main", "copied onto"],
		["git branch -m main old", "renamed away"],
		["git branch -m old", "the shared tree's own branch renamed away"],
		["git checkout -B main HEAD~1", "recreated by checkout"],
		["git switch -C main HEAD~1", "recreated by switch"],
		["git switch --force-create=main HEAD~1", "recreated, long and stuck"],
		["npm run test && git reset --hard HEAD~1", "later in a chain"],
	])("%s is refused with the rewind rule — %s", (command) => {
		expect(denyReason(command)).toContain(rewindRule());
	});

	/* #1759: guard-branch-publish.sh's needles key on its own framing, so a
	 * rewind it never printed is not credited to it. */
	it.each(["git reset --hard HEAD~1", "git branch -D main"])(
		"%s counts once, under this guard",
		(command) => {
			expect(denyFires(denyReason(command) as string)).toEqual([
				"guard:guard-pull-form.sh/main-rewind",
			]);
		},
	);

	it("the refusal names the follow-up commit and echoes the command", () => {
		const reason = denyReason("git reset --soft HEAD~1");
		expect(reason).toContain("git reset --soft HEAD~1");
		expect(reason).toContain("git revert <sha>");
	});

	it.each([
		["git reset -- a.md", "a pathspec unstage"],
		["git reset HEAD a.md", "a tree-ish and a path"],
		["git reset a.md", "a lone word that is a path, not a commit"],
		["git reset", "unstage everything"],
		["git reset --soft HEAD", "the commit it is already on"],
		["git reset --soft main", "the branch it is already on"],
		["git reset -p HEAD~1", "interactive paths"],
		["git reset --pathspec-from-file=list HEAD~1", "file-fed paths"],
		["git reset --help", "documentation"],
		["git update-ref refs/heads/side HEAD", "another branch"],
		["git branch -f side HEAD~1", "another branch forced"],
		["git branch -D side", "another branch deleted"],
		["git branch -c main backup", "main copied, not replaced"],
		["git branch --list", "a listing"],
		["git checkout main", "the repair guard-branch.sh allows"],
		["echo git reset --hard HEAD~1", "text naming a reset"],
	])("%s passes — %s", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it.each([
		"git reset --hard HEAD~1",
		"git update-ref HEAD HEAD~1",
		"git branch -m renamed",
		"git checkout -B side HEAD~1",
	])(
		"inside a throwaway worktree %s passes — it moves that tree's own branch",
		(command) => {
			expect(verdict(command, worktree)).toBe("allow");
		},
	);

	it.each([
		"git update-ref refs/heads/main HEAD",
		"git checkout -B main --ignore-other-worktrees HEAD",
	])(
		"but %s from a worktree still rewinds the one main, so is refused with the main-rewind rule",
		(command) => {
			expect(denyReason(command, worktree)).toContain(rewindRule());
		},
	);

	it("reaches the shared tree through -C from a worktree", () => {
		expect(
			denyReason(`git -C ${shared} reset --hard HEAD~1`, worktree),
		).toContain(rewindRule());
	});

	it("a forward reset is refused too, and pointed at merge --ff-only", () => {
		expect(denyReason("git reset --hard HEAD~1")).toContain(
			"git merge --ff-only <commit>",
		);
	});

	it.each([
		'git -C "$UNSET" reset a.md',
		'git -C "$UNSET" branch -m renamed',
		'git -C "$UNSET" update-ref HEAD HEAD',
	])(
		"%s is refused with the main-rewind rule: the tree it lands in is unknown",
		(command) => {
			expect(denyReason(command)).toContain(rewindRule());
		},
	);

	it.each([
		'git branch -D "$B"',
		'git branch -f "$B" HEAD',
		'git checkout -B "$B" HEAD',
		'git switch -C "$B" HEAD',
	])(
		"inside a worktree %s passes — git refuses main there itself",
		(command) => {
			expect(verdict(command, worktree)).toBe("allow");
		},
	);

	it.each([
		'git checkout -B "$B" --ignore-other-worktrees HEAD',
		'git update-ref "refs/heads/$B" HEAD',
	])(
		"but inside a worktree %s is refused with the main-rewind rule — nothing else stops main",
		(command) => {
			expect(denyReason(command, worktree)).toContain(rewindRule());
		},
	);

	it("an unrelated repository is left alone", () => {
		expect(verdict("git reset --hard HEAD~1", elsewhere)).toBe("allow");
		expect(verdict("git branch -D main", elsewhere)).toBe("allow");
	});
});

/* `sub` gives a pathspec somewhere to climb out of. */
describe("discarding the shared tree's uncommitted work is refused (#768)", () => {
	const discardRule = () => ruleText("shared-tree-discard");

	beforeEach(() => {
		fs.mkdirSync(path.join(shared, "sub"));
	});

	it.each([
		"git reset --hard",
		"git reset --hard HEAD",
		"git reset --hard @",
		"git reset --hard main",
		"git reset --merge",
		"git reset --keep",
		"git reset --soft --hard",
		"git checkout -- .",
		"git checkout .",
		"git checkout HEAD -- .",
		"git checkout -f",
		"git checkout --force main",
		"git switch --discard-changes main",
		"git restore .",
		"git restore :/",
		"git restore ':(top)'",
		"git restore '*'",
		"git restore -- ':!a.md'",
		"git restore --staged --worktree .",
		"git restore -SW .",
		"git restore --source=HEAD .",
		"git restore --pathspec-from-file=list",
		'git restore -- "$F"',
		"git clean -f",
		"git clean -fd",
		"git clean -xdf",
		"git clean --force",
		"git clean -f -- .",
		"git stash",
		"git stash push",
		"git stash -u",
		"git stash -k",
		"git stash save",
		"git stash save wip",
		"git stash push -m wip",
		"git stash push -- .",
		"git -C sub restore ..",
		"git -C sub restore :/",
		"npm run lint && git restore .",
		"git restore :",
		"git restore '*.ts'",
		"git restore '**/*'",
		"git restore ':(glob)**/*'",
		"git checkout -- '**/*.md'",
		"git checkout HEAD -- ':!a.md'",
		"git checkout -f main --",
		"git checkout --force HEAD --",
		"git checkout -p",
		"git restore -p",
		"git clean -i",
		'git clean "$X"',
		"git clean $X",
		'git switch "$F" main',
		'git reset "$M" HEAD',
	])("%s is refused with the discard rule", (command) => {
		expect(denyReason(command)).toContain(discardRule());
	});

	it.each([
		["git reset --hard", "git restore --staged --worktree -- <your paths>"],
		["git checkout .", "git checkout -- <your paths>"],
		["git restore .", "git restore -- <your paths>"],
		["git clean -fd", "git clean -f -- <your paths>"],
		["git stash", "git stash push -- <your paths>"],
	])("the refusal of %s names the per-path form %s", (command, safe) => {
		const reason = denyReason(command);
		expect(reason).toContain(`Name your own paths instead — \`${safe}\``);
		expect(reason).toContain(command);
	});

	it.each([
		"git restore --staged .",
		"git restore -- a.md",
		"git restore -- a.md ':!b.md'",
		"git checkout -- a.md",
		"git checkout HEAD -- a.md",
		"git checkout -f -- a.md",
		"git clean -f -- tmp/x",
		"git clean -n",
		"git clean -nfd",
		"git clean -d",
		"git stash list",
		"git stash pop",
		"git stash show -p",
		"git stash drop",
		"git stash push -- some/file.ts",
		"git stash push -m wip -- a.md",
		"git stash -- a.md",
		"git reset",
		"git reset --soft",
		"git -C sub restore .",
		"git -C sub clean -f",
		"git restore 'sub/a*'",
		"git checkout main -- a.md",
		"git reset HEAD -- a.md",
		"git restore --help",
		"echo git clean -fdx",
	])("%s passes", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it("git clean -d is refused where the repo lifts clean.requireForce, with the shared-tree discard rule", () => {
		git(shared, "config", "clean.requireForce", "false");
		expect(denyReason("git clean -d")).toContain(discardRule());
	});

	it.each([
		"git reset --hard",
		"git checkout .",
		"git checkout -f",
		"git restore .",
		"git clean -xdf",
		"git stash",
		"git stash save",
	])("inside a throwaway worktree %s passes", (command) => {
		expect(verdict(command, worktree)).toBe("allow");
	});

	it.each([
		'git -C "$VAR" reset --hard',
		'git -C "$VAR" restore .',
		'git -C "$VAR" clean -f',
		'git -C "$VAR" stash',
		'git -C "$VAR" restore -- ../a.md',
	])(
		"%s is refused with the shared-tree discard rule: the tree it lands in is unknown",
		(command) => {
			expect(denyReason(command)).toContain(discardRule());
		},
	);

	it('git -C "$VAR" restore -- a.md passes: a named path is safe in any tree', () => {
		expect(verdict('git -C "$VAR" restore -- a.md')).toBe("allow");
	});

	it("an unrelated repository is left alone", () => {
		expect(verdict("git reset --hard", elsewhere)).toBe("allow");
		expect(verdict("git clean -fdx", elsewhere)).toBe("allow");
	});

	it("the rule id resolves through the session accessor", () => {
		expect(
			execFileSync(path.resolve(__dirname, "lib/rule-text.sh"), [
				"rule:shared-tree-discard",
			]).toString(),
		).toContain(discardRule());
	});
});
