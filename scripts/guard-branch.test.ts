// @vitest-environment node
/*
 * guard-branch.sh denies a branch move on the shared working tree (mantahostels#110), and a
 * deny is only defensible while it cannot wedge sanctioned work. Every
 * allow-case below is a shape that would otherwise be a false positive; do not
 * thin them out.
 *
 * The guard compares the target tree against CLAUDE_PROJECT_DIR's, so a
 * throwaway repo stands in for the shared tree and a worktree of it for the
 * exempt case.
 *
 * The guard runs on every Bash call as a `PreToolUse` hook in
 * `self-plugin/hooks/hooks.json` and the shipped plugin's `hooks/hooks.json`:
 * loosen a deny case and a session can move the shared tree off `main` under
 * its neighbours; lose an allow case and sanctioned worktree work is wedged.
 */

import { execFileSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
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
	guardOutput,
	spawnGuard,
} from "./lib/pretool-guard-testkit";

const GUARD = path.resolve(__dirname, "guard-branch.sh");

let dir: string;
let config: string;
let shared: string;
let worktree: string;
let elsewhere: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8" });

/*
 * THE FIXTURE IS BUILT ONCE AND COPIED (mantahostels#2016), not rebuilt per test, via
 * scripts/lib/git-fixture.ts (mantahostels#2068/mantahostels#2085/mantahostels#2178) — see that file's own header
 * for the full "what a naive copy breaks" reasoning. The helper discovers and
 * relinks every absolute-path-bearing file a copy needs, and leak-checks the
 * result.
 */
const template = defineTemplate(trioTemplate());

/** Runs the guard on `command` from `cwd`, as Claude Code would. */
const runGuard = (command: string, cwd = shared, env: NodeJS.ProcessEnv = {}) =>
	spawnGuard(GUARD, payload(command), { project: shared, config, cwd, env });

const verdict = (command: string, cwd = shared) => {
	const r = runGuard(command, cwd);
	return /"permissionDecision"\s*:\s*"deny"/.test(r.stdout ?? "")
		? "deny"
		: "allow";
};

/** The refusal `command` earns, as the session reads it. Throws on an allow. */
const reason = (command: string, cwd = shared) => {
	const r = runGuard(command, cwd);
	if (!r.stdout?.trim()) throw new Error(`expected a deny for: ${command}`);
	return JSON.parse(r.stdout).hookSpecificOutput
		.permissionDecisionReason as string;
};

/* The guard's two framing lines (mantahostels#2145). Both refusals splice the SAME rule
 * fragment underneath, so `toContain(branchRule())` cannot tell them apart — a
 * worktree test would pass on a branch-move refusal and the reverse. */
const MOVED = "moves the shared working tree off its branch";
const WORKTREE = "opens a worktree with neither a branch of its own";

/* The store's Node accessor, so a test asks for a rule by id rather than
 * holding a second copy of its text. CommonJS, hence the require. */
// biome-ignore lint/suspicious/noExplicitAny: untyped CommonJS helper
const { ruleText } = require("./lib/rule-text") as any;

beforeEach(() => {
	dir = mkScratchDir("guard-branch-");
	config = path.join(dir, "claude-config");
	shared = path.join(dir, "shared");
	worktree = path.join(dir, "wt");
	elsewhere = path.join(dir, "elsewhere");
	template.instantiate(dir);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("branch moves on the shared tree are denied", () => {
	it.each([
		["git checkout -b manual-sync-2026-08-03", "the #87 command exactly"],
		["git checkout sidebranch", "any branch that is not main"],
		["git switch other", "switch does the same damage as checkout"],
		["git switch -c fresh", "switch spells create -c, not -b"],
		[
			"git checkout --detach HEAD~1",
			"detached is in scope: it strands a commit too",
		],
		["git checkout -B side", "-B moves the branch ref as well as the tree"],
		["git checkout --orphan fresh", "an orphan branch is still a branch"],
		["git checkout -", "`-` is @{-1}: a branch move wearing a flag (#134)"],
		["git switch -", "the same shorthand on switch"],
		["git checkout @{-1}", "what `-` is short for, spelled out"],
		["npm run build && git checkout -b foo", "later in a chain"],
		["GIT_PAGER=cat git checkout -b foo", "behind an env assignment"],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("deny");
		expect(reason(command)).toContain(MOVED);
	});

	it("sees the shared tree through a variable the command assigned (mantahostels#208)", () => {
		// The assignment happens inside the Bash call, so the hook's environment
		// never sees it. This moved the shared tree and was allowed through (mantahostels#208).
		const command = `WT=${shared} && git -C "$WT" checkout -b foo`;
		expect(verdict(command)).toBe("deny");
		// The chain has two segments, so the refusal must name the checkout one.
		expect(reason(command)).toContain(`${MOVED}: git -C "…" checkout -b foo`);
	});

	it("resolves a leading cd, so the tree is judged not the caller's cwd", () => {
		const command = `cd ${shared} && git checkout -b foo`;
		expect(verdict(command, elsewhere)).toBe("deny");
		expect(reason(command, elsewhere)).toContain(
			`${MOVED}: git checkout -b foo`,
		);
	});

	it("resolves git -C, including from inside a worktree", () => {
		const command = `git -C ${shared} checkout -b foo`;
		expect(verdict(command, worktree)).toBe("deny");
		expect(reason(command, worktree)).toContain(MOVED);
	});

	it("echoes the command back readably, not as the sentinel byte (mantahostels#138)", () => {
		// gp_split_segments blanks every quoted span to \x01QSTR\x01 before the
		// guard ever sees it, so echoing the segment raw prints that byte at the
		// user. gp_unmask is what puts a readable "…" back.
		const r = runGuard('git checkout "my branch"');
		expect(r.stdout).not.toContain("QSTR");
		const denial = JSON.parse(r.stdout).hookSpecificOutput
			.permissionDecisionReason;
		expect(denial).toContain('git checkout "…"');
	});
});

describe("file restores move no branch, so they pass", () => {
	it.each([
		["git checkout -- a.md", "the explicit pathspec form"],
		["git checkout HEAD -- a.md", "restore from a commit"],
		["git checkout a.md", "a bare argument naming an existing file"],
		["git checkout .", "the whole tree"],
		["git checkout -p", "interactive restore"],
		["git checkout", "bare: reports, moves nothing"],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it("returning the tree to main is the repair, not the breach", () => {
		// The guard protects the invariant "shared tree on main", so the command
		// that restores it passes — and it is what the pre-commit failure message
		// tells you to run. mantahostels#100 called every shared-tree branch move illegitimate;
		// this is the exception.
		git(shared, "checkout", "-q", "-b", "stranded");
		expect(verdict("git checkout main")).toBe("allow");
		expect(verdict("git switch main")).toBe("allow");
		// Not a blank cheque: -B rewrites main's ref rather than returning to it.
		expect(verdict("git checkout -B main")).toBe("deny");
		expect(reason("git checkout -B main")).toContain(MOVED);
	});
});

/*
 * The expectations below are keyed by FRAGMENT ID, never by a string literal
 * copied out of the fragment: the rule has one home, and a test holding a second
 * copy would be the drift the store exists to prevent (mantahostels#1648).
 */
describe("the relocated rule reaches the session that trips the guard", () => {
	const branchRule = () => ruleText("branch-shared-tree");

	it("a branch-move refusal carries the whole rule, not a pointer at it", () => {
		expect(reason("git checkout -b foo")).toContain(branchRule());
	});

	/*
	 * MUTATION ANCHORS, and the reason they are literals when the assertion above
	 * is not.
	 *
	 * `toContain(branchRule())` proves the fragment ARRIVES intact — it catches a
	 * guard that drops the call, truncates it or splices it wrong. It cannot
	 * catch a mutation to the fragment itself, because both sides read the same
	 * file and move together: delete the headline clause and it still passes.
	 * That is what `AGENTS.md` §Supervision priors means by mutation-testing a
	 * guarantee.
	 *
	 * So each clause a session must actually receive gets one short literal. Not
	 * the whole fragment — that is the duplicate the store exists to prevent —
	 * but one anchor per clause, chosen to break if the clause is deleted and to
	 * survive an ordinary reword.
	 */
	it.each([
		["#87", "the incident, without which the refusal is a bare assertion"],
		["STAYS ON `main`", "the invariant itself"],
		["-b <name>", "the flag #301 found is not optional"],
		["--detach", "the alternative for work that needs no branch"],
		["worktree", "the escape hatch the whole rule routes you to"],
		["git worktree remove --force", "how to clear one you left dirty"],
		["#301", "where the recipe was corrected"],
	])("a branch refusal still carries %s — %s", (clause) => {
		expect(reason("git checkout -b foo")).toContain(clause);
	});

	/* #1732: this rule and `rule:pull-fast-forward` once put the worktree in two
	 * different places, so the reconcile rule is checked here too. */
	it.each(["branch-shared-tree", "pull-fast-forward"])(
		"%s names the one worktree location",
		(id) => {
			expect(ruleText(id)).toContain(".claude/worktrees/");
			expect(ruleText(id)).not.toContain("CLAUDE_JOB_DIR");
		},
	);

	it.each([
		[
			"git worktree add /tmp/wt main",
			"the R3 route: a worktree reached with no branch move first",
		],
		["git worktree add /tmp/wt", "the same, with no commit-ish either"],
	])(
		"%s is denied — %s, as opening a worktree with no branch of its own",
		(command) => {
			expect(verdict(command)).toBe("deny");
			expect(reason(command)).toContain(WORKTREE);
		},
	);

	it("a denied worktree add carries the same rule as a denied checkout", () => {
		expect(reason("git worktree add /tmp/wt main")).toContain(branchRule());
	});

	it.each([
		["git worktree add -b side /tmp/wt main", "the sanctioned recipe itself"],
		[
			"git worktree add -bside /tmp/wt main",
			"-b's value joined, as git allows",
		],
		["git worktree add -B side /tmp/wt main", "-B resets rather than creates"],
		["git worktree add --detach /tmp/wt main", "no branch needed (#301)"],
		["git worktree add --orphan /tmp/wt", "an orphan branch is still a branch"],
		["git worktree list", "reports; opens nothing"],
		["git worktree remove /tmp/wt", "the other half of the recipe"],
		["git worktree remove --force /tmp/wt", "and its dirty-tree form"],
		["git worktree prune", "housekeeping"],
		["git worktree add --help", "documentation, not a worktree"],
	])("%s stays allowed — %s", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	/*
	 * THE DENY IS WIDER THAN mantahostels#301'S MEASUREMENT, deliberately, and these pin the
	 * gap so nobody narrows it by accident or widens it further without saying so.
	 *
	 * Measured on git 2.43.0: `add <path>` exits 0 and DWIMs a branch off the
	 * basename; `add <path> HEAD` exits 0 detached; only `add <path> main` gives
	 * the 128 mantahostels#301 recorded. The guard refuses all three, because telling them
	 * apart means resolving the commit-ish against every worktree's HEAD, which
	 * this ticket did not buy. The first two are refused for spelling the recipe
	 * a way mantahostels#301 did not sanction, not for breaking git.
	 */
	it.each([
		["git worktree add /tmp/wt", "exits 0 — DWIMs a branch off the basename"],
		["git worktree add /tmp/wt HEAD", "exits 0 — detached, just not by flag"],
		["git worktree add -f /tmp/wt side", "exits 0 — an existing branch"],
	])(
		"%s is refused though git would take it — %s, as opening a worktree with no branch of its own",
		(command) => {
			expect(verdict(command)).toBe("deny");
			expect(reason(command)).toContain(WORKTREE);
		},
	);
});

/*
 * THE PRE-EMPTIVE LIMB (mantahostels#1647, spec mantahostels#1762).
 *
 * The deny above prints the rule ON the mistake. This prints it ON the command,
 * which is what R3 in docs/research/always-loaded-shed-candidates.md needed: a
 * session taking the SANCTIONED route — `git worktree add -b <name>` — is never
 * refused, so the refusal was the one place the recipe could not reach it.
 *
 * An injection is not a refusal. Every case below asserts `permissionDecision`
 * is ABSENT as well as asserting the text, because a guard that started denying
 * `git worktree add -b` would wedge the very recipe the rule prescribes.
 */
describe("the rule reaches a session BEFORE it trips the guard (mantahostels#1647)", () => {
	const branchRule = () => ruleText("branch-shared-tree");

	/** The whole hook output for `command`, parsed. Null where it said nothing. */
	const emission = (command: string, session = "test") =>
		guardOutput(GUARD, buildBashPayload(command, session), {
			project: shared,
			config,
			cwd: shared,
		});

	it.each([
		[
			"git worktree add -b side2 /tmp/wt2 main",
			"the sanctioned recipe — R3's whole point",
		],
		["git worktree add --detach /tmp/wt2", "the no-branch spelling"],
		[
			"git worktree add --orphan /tmp/wt2",
			"an orphan branch is still a branch",
		],
		["git checkout main", "the repair: branch work, and never refused"],
	])("%s is handed the rule and NOT refused — %s", (command) => {
		const out = emission(command);
		expect(out).not.toBeNull();
		expect(out.permissionDecision).toBeUndefined();
		expect(out.additionalContext).toContain(branchRule());
	});

	it.each([
		["landing", true],
		["suites", false],
	])(
		"hands the origin/landing upstream line only with the landing module on — modules %s (#2409)",
		(modules, told) => {
			const out = guardOutput(
				GUARD,
				buildBashPayload("git checkout main", "test"),
				{
					project: shared,
					config,
					cwd: shared,
					env: { WFC_MODULES: modules },
				},
			);
			expect(out.additionalContext).toContain(branchRule());
			expect(out.additionalContext.includes("origin/landing")).toBe(told);
		},
	);

	/*
	 * MUTATION ANCHORS for the injected copy, on the same reasoning as the
	 * refusal's above: `toContain(branchRule())` reads the same file the guard
	 * does, so it moves with a mutation to the fragment instead of catching it.
	 */
	it.each([
		["STAYS ON `main`", "the invariant itself"],
		["#87", "the incident behind it"],
		["-b <name>", "the flag #301 found is not optional"],
		["--detach", "the alternative for work that needs no branch"],
		["git worktree remove --force", "how to clear one you left dirty"],
		[
			"A WORKTREE HAS NO `node_modules`",
			"why a bare binary fails there (#1733)",
		],
		["npx @biomejs/biome", "the scoped spelling that does run there"],
		[
			"WFC_ALLOW_BRANCH=1",
			"the escape — the category a refusal cannot carry (#1762 story 5)",
		],
		[
			".husky/pre-commit",
			"the second enforcement limb (#1762 story 7), which no hook prints",
		],
	])("the pre-emptive injection still carries %s — %s", (clause) => {
		const out = emission("git worktree add -b side2 /tmp/wt2 main");
		expect(out.additionalContext).toContain(clause);
	});

	it("says it once per session, and again for a different session", () => {
		// The latch is gp_rule's, keyed on (id, agent, session). A session that
		// already has the rule pays nothing for its second worktree; a fresh
		// session still gets it.
		expect(
			emission("git worktree add -b s1 /tmp/w1 main", "sess-A"),
		).not.toBeNull();
		expect(
			emission("git worktree add -b s2 /tmp/w2 main", "sess-A"),
		).toBeNull();
		expect(
			emission("git worktree add -b s3 /tmp/w3 main", "sess-B"),
		).not.toBeNull();
		// Three guard spawns; the 5 s default is too tight on a loaded machine.
	}, 30_000);

	it.each([
		["git worktree list", "reports; opens no worktree"],
		["git worktree remove /tmp/wt", "closes one"],
		["git worktree prune", "housekeeping"],
		["git worktree add --help", "documentation opens no worktree"],
		["git checkout -- a.md", "a file restore moves no branch"],
		["git checkout a.md", "nor does a bare path that exists"],
		["git status", "not a branch command at all"],
	])("%s is handed nothing — %s", (command) => {
		expect(emission(command)).toBeNull();
	});

	it("a denied command carries the rule in its refusal, not as context", () => {
		// The two limbs are exclusive: gp_deny exits before the foot of the file
		// is reached, so a refused session gets one copy and not two.
		const out = emission("git worktree add /tmp/wt3");
		expect(out.permissionDecision).toBe("deny");
		expect(out.additionalContext).toBeUndefined();
		expect(out.permissionDecisionReason).toContain(branchRule());
	});
});

describe("a refusal whose rule it cannot read still refuses (mantahostels#1648)", () => {
	/*
	 * The one place this guard departs from the house fail-open rule (mantahostels#103 §6):
	 * everywhere else the unresolvable thing is the COMMAND, and allowing is
	 * right. Here the command is resolved and known bad, and only the rule text
	 * is missing — so it refuses and names the fragment.
	 *
	 * WFC_RULES_DIR is rule-text.sh's own test override. No case here touches
	 * the live store.
	 */
	const withStore = (rulesDir: string, command = "git checkout -b foo") =>
		runGuard(command, shared, { WFC_RULES_DIR: rulesDir });

	it.each([
		["is empty", (at: string) => fs.mkdirSync(at)],
		[
			"holds only whitespace",
			(at: string) => {
				fs.mkdirSync(at);
				fs.writeFileSync(path.join(at, "branch-shared-tree.txt"), "\n \n");
			},
		],
		[
			"does not exist",
			() => {
				/* nothing made: the store is absent */
			},
		],
	])(
		"a store that %s still denies, and says where the rule lives",
		(_l, make) => {
			const at = fs.mkdtempSync(path.join(dir, "store-"));
			fs.rmSync(at, { recursive: true });
			make(at);
			const r = withStore(at);
			expect(r.stdout).toMatch(/"permissionDecision"\s*:\s*"deny"/);
			expect(
				JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason,
			).toContain("docs/agents/rules/branch-shared-tree.txt");
		},
	);

	it("records no fail-open, because it did not fail open", () => {
		// gl_open's log is the register of commands allowed unchecked, and
		// check-guard-errors.js reports it under `npm run status`. A refusal in it is a
		// false alarm the founder has to read.
		withStore(path.join(dir, "store-never-made"));
		expect(fs.existsSync(failOpenLogPath(config, shared))).toBe(false);
	});
});

describe("text that merely mentions a checkout is not a checkout", () => {
	it.each([
		['grep -rn "git checkout" docs/', "a search"],
		["echo 'git checkout -b foo'", "a single-quoted mention"],
		['echo "a | git checkout -b foo"', "a pipe inside a quoted string"],
		["cat <<EOF > f.md\ngit checkout -b foo\nEOF", "a heredoc body"],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("allow");
	});
});

describe("trees this guard has no business in", () => {
	it("a linked worktree is exempt — it was made for a branch", () => {
		expect(verdict("git checkout -b another", worktree)).toBe("allow");
		expect(verdict("git switch main", worktree)).toBe("allow");
		expect(verdict("git checkout -", worktree)).toBe("allow");
	});

	it("an unrelated repository is left alone", () => {
		expect(verdict(`git -C ${elsewhere} checkout -b foo`)).toBe("allow");
		expect(verdict("git checkout -b foo", elsewhere)).toBe("allow");
	});

	it("fails open on a path it cannot resolve rather than wedging the run", () => {
		// A worktree spelt through $CLAUDE_JOB_DIR, as the recipe was until #1732,
		// reaches the hook unexpanded.
		expect(
			verdict('cd "$CLAUDE_JOB_DIR/tmp/sync" && git checkout -b foo'),
		).toBe("allow");
	});

	it("git worktree add carrying a branch is the sanctioned route", () => {
		// It IS matched since mantahostels#1648 — the guard walks `worktree` now — and passes
		// on the flag rather than on the subcommand.
		expect(verdict("git worktree add -b sync /tmp/wt main")).toBe("allow");
	});

	it("passes the whole sanctioned recipe in silence (mantahostels#208)", () => {
		// CLAUDE.md tells a session to add a worktree under a variable and work in
		// it, and every run of it left a fail-open in the log (mantahostels#208).
		const fresh = path.join(dir, "recipe-wt");
		expect(
			verdict(
				`WT=${fresh} && git worktree add --detach "$WT" main && git -C "$WT" checkout -b side3`,
			),
		).toBe("allow");
		expect(fs.existsSync(failOpenLogPath(config, shared))).toBe(false);
	});

	it("will not deny on an assignment that may never have run (mantahostels#208)", () => {
		// An assignment after a `||` belongs to a branch this guard cannot see
		// taken, so it is not resolved. Denying here would refuse a command shell
		// ran against a different tree entirely.
		expect(
			verdict(
				`[ -d ${worktree} ] || WT=${shared} && git -C "$WT" checkout -b x`,
			),
		).toBe("allow");
		expect(
			verdict(`[ -d ${worktree} ] || WT=${shared}; git -C "$WT" checkout -b x`),
		).toBe("allow");
	});

	it("will not deny on a name a || may have reassigned (#328)", () => {
		expect(
			verdict(
				`WT=${worktree}; false || WT=${shared}; git -C "$WT" checkout -b x`,
			),
		).toBe("allow");
	});

	it("still denies through an assignment made before the first || (#328)", () => {
		expect(
			verdict(
				`WT=${shared} && [ -d "$WT" ] || exit 1; git -C "$WT" checkout -b x`,
			),
		).toBe("deny");
	});
});

describe("hard cases at the edge of the parser", () => {
	it("an unknown cd target stays unknown when git -C is relative", () => {
		expect(
			verdict('cd "$CLAUDE_JOB_DIR/tmp/wt" && git -C . switch -c foo'),
		).toBe("allow");
	});

	it("<< inside a quoted string does not open a heredoc", () => {
		// Otherwise it swallows every line after it, branch move included.
		const command = 'echo "a << b"\ngit checkout -b foo';
		expect(verdict(command)).toBe("deny");
		expect(reason(command)).toContain(`${MOVED}: git checkout -b foo`);
	});

	it.each([
		["an escaped quote", 'echo \\"', 'echo \\"'],
		["an apostrophe in prose", "echo it's fine", "echo that's all"],
	])(
		"%s does not let the line before swallow the move",
		(_l, before, after) => {
			// Shell pairs neither of these, so mantahostels#182's logical-line join would take
			// the whole command as one segment headed by echo.
			const command = `${before}\ngit checkout -b evil\n${after}`;
			expect(verdict(command)).toBe("deny");
			expect(reason(command)).toContain(`${MOVED}: git checkout -b evil`);
		},
	);

	it("still strips a genuine heredoc, including a quoted delimiter", () => {
		expect(verdict("cat <<'EOF' > f.md\ngit checkout -b foo\nEOF")).toBe(
			"allow",
		);
		expect(verdict("cat <<EOF > f.md\ngit checkout -b foo\nEOF")).toBe("allow");
	});

	it("a subshell or command substitution cannot hide the move", () => {
		for (const command of [
			"(git checkout -b foo)",
			"x=$(git checkout -b foo)",
		]) {
			expect(verdict(command)).toBe("deny");
			// The segment echoed back must be the move, not the wrapper.
			expect(reason(command)).toContain(`${MOVED}: git checkout -b foo`);
		}
	});

	it("a name that is both a branch and a path is treated as the branch", () => {
		fs.mkdirSync(path.join(shared, "docs"));
		fs.writeFileSync(path.join(shared, "docs", "x.md"), "x\n");
		git(shared, "add", "docs/x.md");
		git(shared, "commit", "-qm", "docs");
		git(shared, "branch", "docs");
		expect(verdict("git checkout docs")).toBe("deny");
		expect(reason("git checkout docs")).toContain(MOVED);
	});

	it("switch's long-form create flags count as branch moves", () => {
		expect(verdict("git switch --create fresh")).toBe("deny");
		expect(reason("git switch --create fresh")).toContain(MOVED);
		// Without --create in the flag list, the "main" exception fired on this.
		expect(verdict("git switch --create main")).toBe("deny");
		expect(reason("git switch --create main")).toContain(MOVED);
	});

	it("WFC_ALLOW_BRANCH does not escape this layer", () => {
		// It escapes the pre-commit block, where the audience is the founder's own
		// terminal. Here the audience is an agent session, and an escape a session
		// can spell for itself is not a deny — mantahostels#109 ruled the same for its guard.
		expect(verdict("WFC_ALLOW_BRANCH=1 git checkout -b foo")).toBe("deny");
		expect(reason("WFC_ALLOW_BRANCH=1 git checkout -b foo")).toContain(MOVED);
	});
});

/*
 * mantahostels#123 moved the parser this guard shares with guard-commit-form.sh into
 * scripts/lib/guard-parse.sh.
 */

describeSharedParserLibrary({
	guard: GUARD,
	denyCommand: "git checkout -b foo",
	ctx: () => ({ dir, shared, elsewhere }),
});

const payload = (command: string) => buildBashPayload(command, "test");

describeFailOpenLog({
	guard: GUARD,
	denied: payload("git checkout -b foo"),
	fieldless: { session_id: "test", tool_name: "Bash", tool_input: {} },
	fieldlessMatch: /no command in payload/,
	benign: payload("git status"),
	ctx: () => ({ dir, config, project: shared }),
});

describe("a branch move it cannot judge is recorded, not just allowed", () => {
	it("logs a checkout whose working tree cannot be resolved", () => {
		// An unexpanded variable in the cd target: the guard does not know which
		// tree the checkout lands on, so it allows — and the fail-open is the whole
		// finding, because this is a branch move it declined to judge.
		const r = runGuard("cd $TARGET && git checkout -b foo");
		expect(r.stdout ?? "").toBe("");
		const log = failOpenLogPath(config, shared);
		expect(fs.readFileSync(log, "utf8")).toMatch(
			/could not resolve the working tree for a git checkout/,
		);
	});

	it("logs a repo git cannot answer for at all", () => {
		// With the repo unresolved, is_shared_tree() answers no to every path and
		// the guard reaches a verdict on nothing — the most complete fail-open it
		// has, and silent before mantahostels#147.
		const notARepo = path.join(dir, "not-a-repo");
		fs.mkdirSync(notARepo, { recursive: true });
		const r = spawnGuard(GUARD, payload("git checkout -b foo"), {
			project: notARepo,
			config,
			cwd: notARepo,
			env: {
				// Otherwise git walks up out of the fixture and finds Manta's own
				// repository (mantahostels#3149), resolving the project dir this case needs
				// unresolved. Load-bearing: without it the checkout is judged
				// against Manta's tree and denied (mantahostels#3158).
				GIT_CEILING_DIRECTORIES: dir,
			},
		});
		expect(r.stdout ?? "").toBe("");
		const log = failOpenLogPath(config, notARepo);
		expect(fs.readFileSync(log, "utf8")).toMatch(
			/git could not resolve a git dir/,
		);
	});

	it("says nothing about a checkout in a directory that is in no repo (mantahostels#253)", () => {
		// The directory exists, so git reaches it and refuses — and "not a
		// repository" is as confident an answer as another repo's tree is: a
		// checkout there cannot move this one. Recorded, mantahostels#232's 720-payload fuzz
		// corpus alone put ~720 identical entries in the log.
		const opaque = mkDirOutsideRepo("not-a-repo-");
		let r: SpawnSyncReturns<string>;
		try {
			r = runGuard(`git -C ${opaque} checkout -b foo`);
		} finally {
			fs.rmSync(opaque, { recursive: true, force: true });
		}
		expect(r.stdout ?? "").toBe("");
		expect(fs.existsSync(failOpenLogPath(config, shared))).toBe(false);
	});

	it("logs a checkout where git failed for some other reason (mantahostels#253)", () => {
		// is_shared_tree() answers 2 — declined to judge — only where the failure
		// is NOT "this is not a repository". git cannot make that split itself: a
		// `.git` pointing at a gitdir that is gone exits 128 with the same stderr
		// as the case above, so the repo marker on disk is what decides it.
		const broken = path.join(dir, "broken-repo");
		fs.mkdirSync(broken, { recursive: true });
		fs.writeFileSync(
			path.join(broken, ".git"),
			`gitdir: ${path.join(dir, "no-such-gitdir")}\n`,
		);
		const r = runGuard(`git -C ${broken} checkout -b foo`);
		expect(r.stdout ?? "").toBe("");
		const log = failOpenLogPath(config, shared);
		expect(fs.readFileSync(log, "utf8")).toMatch(
			/git could not answer for .*broken-repo — a git checkout there was allowed unchecked/,
		);
	});

	it("says nothing about a checkout in a directory that does not exist", () => {
		// git fails before it moves anything, so an absolute path with nothing at
		// it is no more the shared tree than another repo is (mantahostels#208). Recorded, it
		// buried the fail-opens that mattered.
		const r = runGuard(`git -C ${path.join(dir, "gone")} checkout -b foo`);
		expect(r.stdout ?? "").toBe("");
		expect(fs.existsSync(failOpenLogPath(config, shared))).toBe(false);
	});

	it("says nothing about a checkout in a worktree it judged and passed", () => {
		// The other side of the exit-status split: a linked worktree IS judged —
		// answer no, verdict reached — so it must leave the log empty.
		const wt = path.join(dir, "linked-wt");
		execFileSync("git", ["-C", shared, "worktree", "add", "-b", "judged", wt], {
			encoding: "utf8",
		});
		runGuard(`git -C ${wt} checkout -b foo`);
		const log = failOpenLogPath(config, shared);
		expect(fs.existsSync(log)).toBe(false);
	});

	it("logs a tree whose path it could not canonicalise", () => {
		// The third way is_shared_tree() can fail to judge, and the one left behind
		// when the other two were split out: canon() failing leaves the path empty,
		// which compares unequal and so reads as a confident "not the shared tree"
		// derived from a path that was never resolved.
		//
		// realpath is broken for the worktrees/ path ALONE. Break it outright and
		// gp_init_repo canonicalises the repo first, fails open there, and execution
		// never reaches the line under test.
		const bin = path.join(dir, "shim-bin");
		fs.mkdirSync(bin);
		const real = execFileSync("bash", ["-c", "command -v realpath"], {
			encoding: "utf8",
		}).trim();
		fs.writeFileSync(
			path.join(bin, "realpath"),
			// `.git/worktrees/`, not a bare `worktrees`: since mantahostels#3149 the fixture
			// itself lives under `.claude/tmp/`, which in an ISOLATED run sits
			// beneath `.claude/worktrees/isolated-<pid>/` — a bare match breaks
			// realpath for the shared tree too, and the guard then fails open one
			// branch earlier than the one under test.
			`#!/bin/sh\ncase "$*" in */.git/worktrees/*) exit 1 ;; esac\nexec ${real} "$@"\n`,
		);
		fs.chmodSync(path.join(bin, "realpath"), 0o755);

		const r = runGuard(`git -C ${worktree} checkout -b foo`, shared, {
			PATH: `${bin}:${process.env.PATH}`,
		});
		expect(r.stdout ?? "").toBe("");
		const log = failOpenLogPath(config, shared);
		expect(fs.readFileSync(log, "utf8")).toMatch(
			/git could not answer for .* — a git checkout there was allowed unchecked/,
		);
	});

	it("says nothing about an unresolvable cd carrying no branch move", () => {
		// The guard passes over commands it never had to judge all day long; only
		// the ones it was supposed to judge and could not belong in the log.
		runGuard("cd $TARGET && npm run build");
		const log = failOpenLogPath(config, shared);
		expect(fs.existsSync(log)).toBe(false);
	});
});

describe("an unset variable in the target is the cwd (#310, #325)", () => {
	const unsetLine =
		"`$UNSET_325` is unset in this call; shell variables do not carry over between Bash calls.";

	it.each([
		'cd "$UNSET_325" && git checkout -b foo',
		'git -C "$UNSET_325" switch -c foo',
	])("refuses %s in the shared tree, naming the variable", (command) => {
		const r = reason(command);
		expect(r).toContain(MOVED);
		expect(r).toContain(unsetLine);
		expect(r).toContain(ruleText("branch-shared-tree"));
		expect(fs.existsSync(failOpenLogPath(config, shared))).toBe(false);
	});

	it("names it in the worktree refusal too", () => {
		const r = reason('git -C "$UNSET_325" worktree add ../x');
		expect(r).toContain(WORKTREE);
		expect(r).toContain(unsetLine);
	});

	it.each([
		'git -C "$UNSET_325" checkout -- file.txt',
		'cd "$UNSET_325" && git checkout main',
		'git -C "$UNSET_325" worktree add -b n ../x',
		'git -C "$UNSET_325" worktree list',
	])("keeps the verdict %s already had: allowed", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it("allows it from a linked worktree, which is where it runs", () => {
		expect(verdict('cd "$UNSET_325" && git checkout -b foo', worktree)).toBe(
			"allow",
		);
	});

	it("adds no line to a refusal no variable reached", () => {
		expect(reason("git checkout -b foo")).not.toContain(
			"is unset in this call",
		);
		expect(reason('W=""; git -C "$W" checkout -b foo')).not.toContain(
			"is unset in this call",
		);
		// The variable led to the `status`, not to the refused checkout.
		expect(
			reason('git -C "$UNSET_325" status; git checkout -b foo'),
		).not.toContain("is unset in this call");
	});

	it("keeps the logged fail-open for a $(…) target", () => {
		expect(verdict('cd "$(pwd)" && git checkout -b foo')).toBe("allow");
		expect(fs.readFileSync(failOpenLogPath(config, shared), "utf8")).toMatch(
			/could not resolve the working tree for a git checkout/,
		);
	});
});

/*
 * git-fixture.ts (mantahostels#2068) leak-checks every instantiate() call itself (proven
 * in git-fixture.test.ts), so this file's beforeEach already throws before any
 * test body runs were the copy still pointing at the template. What is left to
 * assert here, and what mantahostels#2085's acceptance criteria ask for, is the
 * BEHAVIOURAL isolation a leak would cause: a write made in the instantiated
 * copy must not reach a second, independent instantiation of the same
 * template.
 */
describe("the copied fixture is isolated from its template (mantahostels#2085)", () => {
	const freshCopy = () => {
		const fresh = mkScratchDir("guard-branch-fresh-");
		try {
			template.instantiate(fresh);
		} catch (err) {
			fs.rmSync(fresh, { recursive: true, force: true });
			throw err;
		}
		return fresh;
	};

	it("the copy's core.hooksPath is relinked, not left pointing at the template", () => {
		// Writing into the copy's own real .git (the branch-move-then-diff shape
		// this replaced) proves nothing about relinking: nothing that write
		// touches is one of git-fixture's path carriers, so it cannot fail on a
		// relink regression. This instead reads back the relinked file directly.
		// Asserting merely "exists and is empty" would pass even with relink()
		// disabled: the template's own no-hooks dir is exists-and-empty too, so a
		// stale pointer left aimed at the TEMPLATE would read identically.
		// Anchoring on `fresh` — this instance's own root — is what tells a
		// relinked path apart from a leaked one.
		const fresh = freshCopy();
		try {
			const hooksPath = git(
				path.join(fresh, "shared"),
				"config",
				"core.hooksPath",
			).trim();
			expect(hooksPath).toBe(path.join(fresh, "no-hooks"));
			expect(fs.existsSync(hooksPath)).toBe(true);
			expect(fs.readdirSync(hooksPath)).toEqual([]);
		} finally {
			fs.rmSync(fresh, { recursive: true, force: true });
		}
	});

	it("a commit made in the copied worktree leaves the template untouched", () => {
		// The worktree shares its parent's object store, so a stale gitdir
		// pointer here writes into the template rather than failing loudly.
		fs.writeFileSync(path.join(worktree, "c.md"), "c\n");
		git(worktree, "add", "c.md");
		git(worktree, "commit", "-qm", "worktree copy only", "--", "c.md");
		expect(git(worktree, "log", "--oneline")).toContain("worktree copy only");

		const fresh = freshCopy();
		try {
			expect(git(path.join(fresh, "wt"), "log", "--oneline")).not.toContain(
				"worktree copy only",
			);
		} finally {
			fs.rmSync(fresh, { recursive: true, force: true });
		}
	});
});
