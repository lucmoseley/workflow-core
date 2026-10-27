// @vitest-environment node
/*
 * lib/branch-move.js, the guard-branch core (#2797), in process: which
 * checkout, switch and worktree commands move the shared tree off `main`
 * (mantahostels#110), which are handed the rule, and which pass. A deny is
 * only defensible while it cannot wedge sanctioned work, so every allow case
 * below is a shape that would otherwise be a false positive; do not thin them
 * out.
 *
 * The tree class, the branch probe and the file probe are fakes passed as
 * values; the rule store is the real one, read in process. The production
 * adapters are crossed in guard-branch.test.ts, and the tree classes' own
 * answers are lib/git-tree.test.ts's.
 */

import { describe, expect, it } from "vitest";
import { fakeTreeClassifier } from "./git-tree-fake.js";
import { kitContextFake } from "./kit-context-fake";

type Decision =
	| { deny: string }
	| { injectRules: string[]; skip: string[] }
	| null;

const { decide } = require("./branch-move.js") as {
	decide: (command: string, ctx: object) => Decision;
};
const { readRuleText } = require("./rule-text.js") as {
	readRuleText: (id: string) => string;
};

const SHARED = "/repo";
const LINKED = "/repo-wt";
const ELSEWHERE = "/other";

/* The guard's two framing lines (mantahostels#2145). Both refusals splice the
 * SAME rule fragment underneath, so `toContain(readBranchRule())` cannot tell
 * them apart. */
const MOVED = "moves the shared working tree off its branch";
const WORKTREE = "opens a worktree with neither a branch of its own";

/*
 * Keyed by FRAGMENT ID, never by a string literal copied out of the fragment:
 * the rule has one home (mantahostels#1648).
 */
const readBranchRule = () => readRuleText("branch-shared-tree");

interface Over {
	cwd?: string;
	vars?: Record<string, string>;
	modules?: string[];
	branches?: string[];
	files?: string[];
	tree?: ReturnType<typeof fakeTreeClassifier>;
	ruleText?: (id: string) => string;
}

const LAYOUT = { [SHARED]: "shared", [LINKED]: "linked" } as const;
const treeClass = fakeTreeClassifier(LAYOUT);

function harness(over: Over = {}) {
	const logs: string[] = [];
	const ctx = kitContextFake({
		fallbackCwd: over.cwd ?? SHARED,
		vars: over.vars ?? {},
		isDir: () => true,
		moduleOn: (m: string) => (over.modules ?? []).includes(m),
		treeClass: over.tree ?? treeClass,
		log: (what: string, detail?: string) =>
			logs.push(detail ? `${what}\t${detail}` : what),
		isBranch: (_dir: string, name: string) =>
			(over.branches ?? ["main", "sidebranch", "other"]).includes(name),
		exists: (p: string) =>
			(over.files ?? [`${SHARED}/a.md`, `${SHARED}/file.txt`]).includes(p),
		ruleText: over.ruleText ?? readRuleText,
	});
	return { ctx, logs };
}

const run = (command: string, over: Over = {}) =>
	decide(command, harness(over).ctx);

const verdict = (command: string, over: Over = {}) => {
	const d = run(command, over);
	if (d === null) return "allow";
	return "deny" in d ? "deny" : "rule";
};

/** The refusal `command` earns. Throws on anything else. */
const reason = (command: string, over: Over = {}) => {
	const d = run(command, over);
	if (!d || !("deny" in d)) throw new Error(`expected a deny for: ${command}`);
	return d.deny;
};

const logsOf = (command: string, over: Over = {}) => {
	const h = harness(over);
	decide(command, h.ctx);
	return h.logs;
};

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
		expect(reason(command)).toContain(MOVED);
	});

	it("sees the shared tree through a variable the command assigned (mantahostels#208)", () => {
		// The assignment happens inside the Bash call, so the hook's environment
		// never sees it. This moved the shared tree and was allowed through.
		const command = `WT=${SHARED} && git -C "$WT" checkout -b foo`;
		// The chain has two segments, so the refusal must name the checkout one.
		expect(reason(command, { cwd: ELSEWHERE })).toContain(
			`${MOVED}: git -C "…" checkout -b foo`,
		);
	});

	it("resolves a leading cd, so the tree is judged not the caller's cwd", () => {
		expect(
			reason(`cd ${SHARED} && git checkout -b foo`, { cwd: ELSEWHERE }),
		).toContain(`${MOVED}: git checkout -b foo`);
	});

	it("resolves git -C, including from inside a worktree", () => {
		expect(
			reason(`git -C ${SHARED} checkout -b foo`, { cwd: LINKED }),
		).toContain(MOVED);
	});

	it("echoes the command back readably, not as the sentinel byte (mantahostels#138)", () => {
		const denial = reason('git checkout "my branch"');
		expect(denial).not.toContain("\x01");
		expect(denial).toContain('git checkout "…"');
	});

	it("ends the refusal on the restore hint, after the rule", () => {
		expect(reason("git checkout -b foo")).toMatch(
			/\n\nTo restore a file rather than move a branch, use the pathspec form: git checkout -- <file>, or git restore <file>\.$/,
		);
	});

	it("judges the first move of a chain, naming it alone", () => {
		expect(reason("git checkout -b one; git worktree add /tmp/x")).toContain(
			`${MOVED}: git checkout -b one`,
		);
	});
});

describe("file restores move no branch, so they pass", () => {
	it.each([
		["git checkout -- a.md", "the explicit pathspec form"],
		["git checkout HEAD -- a.md", "restore from a commit"],
		["git checkout a.md", "a bare argument naming an existing file"],
		["git checkout .", "the whole tree"],
		["git checkout -p", "interactive restore"],
		["git checkout --patch", "its long spelling"],
		["git checkout", "bare: reports, moves nothing"],
	])("%s — %s", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it("reads a bare path against the hook's own directory too", () => {
		expect(verdict("git checkout rel.md", { files: ["rel.md"] })).toBe("allow");
	});

	it("a bare name that is neither a file nor a branch is still a move", () => {
		expect(reason("git checkout nowhere")).toContain(MOVED);
	});

	it("two bare names are a move, whatever exists", () => {
		expect(reason("git checkout a.md file.txt")).toContain(MOVED);
	});

	it("a switch naming a file is still a move — only checkout restores", () => {
		expect(reason("git switch a.md")).toContain(MOVED);
	});

	it("returning the tree to main is the repair, not the breach", () => {
		// The guard protects the invariant "shared tree on main", so the command
		// that restores it passes — and it is what the pre-commit failure message
		// tells you to run. mantahostels#100 called every shared-tree branch move
		// illegitimate; this is the exception.
		expect(verdict("git checkout main")).toBe("rule");
		expect(verdict("git switch main")).toBe("rule");
		// Not a blank cheque: -B rewrites main's ref rather than returning to it.
		expect(reason("git checkout -B main")).toContain(MOVED);
	});
});

describe("the relocated rule reaches the session that trips the guard", () => {
	it("a branch-move refusal carries the whole rule, not a pointer at it", () => {
		expect(reason("git checkout -b foo")).toContain(readBranchRule());
	});

	/*
	 * MUTATION ANCHORS. `toContain(readBranchRule())` proves the fragment
	 * ARRIVES intact but moves with a mutation to the fragment itself, so each
	 * clause a session must receive gets one short literal.
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
			expect(readRuleText(id)).toContain(".claude/worktrees/");
			expect(readRuleText(id)).not.toContain("CLAUDE_JOB_DIR");
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
			expect(reason(command)).toContain(`${WORKTREE} nor a detached HEAD: `);
		},
	);

	it("a denied worktree add carries the same rule as a denied checkout, and no restore hint", () => {
		const r = reason("git worktree add /tmp/wt main");
		expect(r).toContain(readBranchRule());
		expect(r).not.toContain("To restore a file");
	});

	it.each([
		["git worktree add -b side /tmp/wt main", "the sanctioned recipe itself"],
		[
			"git worktree add -bside /tmp/wt main",
			"-b's value joined, as git allows",
		],
		["git worktree add -B side /tmp/wt main", "-B resets rather than creates"],
		["git worktree add -Bside /tmp/wt main", "-B's value joined"],
		["git worktree add --detach /tmp/wt main", "no branch needed (#301)"],
		["git worktree add --orphan /tmp/wt", "an orphan branch is still a branch"],
	])("%s stays allowed, and is handed the rule — %s", (command) => {
		expect(verdict(command)).toBe("rule");
	});

	it.each([
		["git worktree list", "reports; opens nothing"],
		["git worktree remove /tmp/wt", "the other half of the recipe"],
		["git worktree remove --force /tmp/wt", "and its dirty-tree form"],
		["git worktree prune", "housekeeping"],
		["git worktree", "no verb at all"],
		["git worktree add --help", "documentation, not a worktree"],
		["git worktree add -h", "its short spelling"],
		["git worktree add -b x --help /tmp/wt", "help wins over a branch"],
	])("%s stays allowed and is handed nothing — %s", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	/*
	 * THE DENY IS WIDER THAN mantahostels#301'S MEASUREMENT, deliberately: only
	 * `add <path> main` fails in git; the other two are refused for spelling
	 * the recipe a way mantahostels#301 did not sanction. Pinned so nobody
	 * narrows it by accident or widens it further without saying so.
	 */
	it.each([
		["git worktree add /tmp/wt", "exits 0 — DWIMs a branch off the basename"],
		["git worktree add /tmp/wt HEAD", "exits 0 — detached, just not by flag"],
		["git worktree add -f /tmp/wt side", "exits 0 — an existing branch"],
	])(
		"%s is refused though git would take it — %s, as opening a worktree with no branch of its own",
		(command) => {
			expect(reason(command)).toContain(WORKTREE);
		},
	);
});

/*
 * THE PRE-EMPTIVE LIMB (mantahostels#1647, spec mantahostels#1762): the rule
 * on the sanctioned command, which a refusal can never reach. An injection is
 * not a refusal: each case asserts there is no deny.
 */
describe("the rule reaches a session BEFORE it trips the guard (mantahostels#1647)", () => {
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
		expect(run(command)).toEqual({
			injectRules: ["branch-shared-tree", "branch-shared-tree-landing"],
			skip: ["branch-shared-tree-landing"],
		});
	});

	it.each([
		[["landing"], []],
		[["suites"], ["branch-shared-tree-landing"]],
	])(
		"hands the origin/landing upstream line only with the landing module on — modules %j (#2409)",
		(modules, skip) => {
			expect(run("git checkout main", { modules })).toEqual({
				injectRules: ["branch-shared-tree", "branch-shared-tree-landing"],
				skip,
			});
		},
	);

	it("the landing twin is the one carrying origin/landing", () => {
		expect(readRuleText("branch-shared-tree-landing")).toContain(
			"origin/landing",
		);
		expect(readBranchRule()).not.toContain("origin/landing");
	});

	/* MUTATION ANCHORS for the injected copy: the fragment the injection hands
	 * over carries each clause. */
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
		expect(readBranchRule()).toContain(clause);
	});

	it.each([
		["git worktree list", "reports; opens no worktree"],
		["git worktree remove /tmp/wt", "closes one"],
		["git worktree prune", "housekeeping"],
		["git worktree add --help", "documentation opens no worktree"],
		["git checkout -- a.md", "a file restore moves no branch"],
		["git checkout a.md", "nor does a bare path that exists"],
		["git status", "not a branch command at all"],
	])("%s is handed nothing — %s", (command) => {
		expect(run(command)).toBeNull();
	});

	it("a denied command carries the rule in its refusal, not as an injection", () => {
		// The two limbs are exclusive: a refused session gets one copy, not two.
		expect(run("git checkout main && git worktree add /tmp/wt3")).toEqual({
			deny: expect.stringContaining(readBranchRule()),
		});
	});
});

describe("a refusal whose rule it cannot read still refuses (mantahostels#1648)", () => {
	/*
	 * The command is resolved and known bad; only the rule text is missing — so
	 * it refuses, names the fragment's file, and logs nothing.
	 */
	const storeFault = () => {
		throw new Error("no fragment");
	};

	it.each([
		["git checkout -b foo", MOVED],
		["git worktree add /tmp/wt", WORKTREE],
	])("%s still denies, saying where the rule lives", (command, framing) => {
		const h = harness({ ruleText: storeFault });
		const d = decide(command, h.ctx) as { deny: string };
		expect(d.deny).toContain(framing);
		expect(d.deny).toContain(
			"The shared working tree stays on `main`; the rule could not be read from docs/agents/rules/branch-shared-tree.txt. Read that file before doing anything else.",
		);
		expect(h.logs).toEqual([]);
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
		expect(verdict("git checkout -b another", { cwd: LINKED })).toBe("allow");
		expect(verdict("git switch main", { cwd: LINKED })).toBe("allow");
		expect(verdict("git checkout -", { cwd: LINKED })).toBe("allow");
	});

	it("an unrelated repository is left alone", () => {
		expect(verdict(`git -C ${ELSEWHERE} checkout -b foo`)).toBe("allow");
		expect(verdict("git checkout -b foo", { cwd: ELSEWHERE })).toBe("allow");
	});

	it("fails open on a path it cannot resolve rather than wedging the run", () => {
		// A worktree spelt through $CLAUDE_JOB_DIR, as the recipe was until #1732,
		// reaches the hook unexpanded.
		expect(
			verdict('cd "$CLAUDE_JOB_DIR/tmp/sync" && git checkout -b foo', {
				vars: { CLAUDE_JOB_DIR: "/home/u/.claude/jobs/x" },
			}),
		).toBe("allow");
	});

	it("passes the whole sanctioned recipe in silence (mantahostels#208)", () => {
		const command =
			'WT=/tmp/recipe-wt && git worktree add --detach "$WT" main && git -C "$WT" checkout -b side3';
		expect(verdict(command)).toBe("rule");
		expect(logsOf(command)).toEqual([]);
	});

	it("will not deny on an assignment that may never have run (mantahostels#208)", () => {
		// An assignment after a `||` belongs to a branch this guard cannot see
		// taken, so it is not resolved.
		expect(
			verdict(`[ -d ${LINKED} ] || WT=${SHARED} && git -C "$WT" checkout -b x`),
		).toBe("allow");
		expect(
			verdict(`[ -d ${LINKED} ] || WT=${SHARED}; git -C "$WT" checkout -b x`),
		).toBe("allow");
	});

	it("will not deny on a name a || may have reassigned (#328)", () => {
		expect(
			verdict(
				`WT=${LINKED}; false || WT=${SHARED}; git -C "$WT" checkout -b x`,
			),
		).toBe("allow");
	});

	it("still denies through an assignment made before the first || (#328)", () => {
		expect(
			verdict(
				`WT=${SHARED} && [ -d "$WT" ] || exit 1; git -C "$WT" checkout -b x`,
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
		expect(reason('echo "a << b"\ngit checkout -b foo')).toContain(
			`${MOVED}: git checkout -b foo`,
		);
	});

	it.each([
		["an escaped quote", 'echo \\"', 'echo \\"'],
		["an apostrophe in prose", "echo it's fine", "echo that's all"],
	])(
		"%s does not let the line before swallow the move",
		(_l, before, after) => {
			// Shell pairs neither of these, so mantahostels#182's logical-line join
			// would take the whole command as one segment headed by echo.
			expect(reason(`${before}\ngit checkout -b evil\n${after}`)).toContain(
				`${MOVED}: git checkout -b evil`,
			);
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
			// The segment echoed back must be the move, not the wrapper.
			expect(reason(command)).toContain(`${MOVED}: git checkout -b foo`);
		}
	});

	it("a name that is both a branch and a path is treated as the branch", () => {
		expect(
			reason("git checkout docs", {
				branches: ["main", "docs"],
				files: [`${SHARED}/docs`],
			}),
		).toContain(MOVED);
	});

	it("switch's long-form create flags count as branch moves", () => {
		expect(reason("git switch --create fresh")).toContain(MOVED);
		expect(reason("git switch --force-create fresh")).toContain(MOVED);
		// Without --create in the flag list, the "main" exception fired on this.
		expect(reason("git switch --create main")).toContain(MOVED);
		expect(reason("git switch -C main")).toContain(MOVED);
		expect(reason("git switch --orphan main")).toContain(MOVED);
		expect(reason("git switch --detach main")).toContain(MOVED);
	});

	it("WFC_ALLOW_BRANCH does not escape this layer", () => {
		// It escapes the pre-commit block, where the audience is the founder's own
		// terminal; an escape a session can spell for itself is not a deny
		// (mantahostels#109).
		expect(reason("WFC_ALLOW_BRANCH=1 git checkout -b foo")).toContain(MOVED);
	});
});

describe("a branch move it cannot judge is recorded, not just allowed", () => {
	it("logs a checkout whose working tree cannot be resolved", () => {
		const command = "cd $TARGET && git checkout -b foo";
		expect(verdict(command)).toBe("allow");
		expect(logsOf(command)).toEqual([
			expect.stringMatching(
				/^could not resolve the working tree for a git checkout/,
			),
		]);
	});

	it("logs a tree git could not answer for (mantahostels#253)", () => {
		// A `.git` pointing at a gitdir that is gone, or a path git could not
		// canonicalise: lib/git-tree.js answers `unknown` for both.
		const tree = fakeTreeClassifier({ ...LAYOUT, "/broken": "unknown" });
		expect(verdict("git -C /broken checkout -b foo", { tree })).toBe("allow");
		expect(logsOf("git -C /broken checkout -b foo", { tree })).toEqual([
			"git could not answer for /broken — a git checkout there was allowed unchecked",
		]);
	});

	it.each([
		/* Recorded, mantahostels#232's 720-payload fuzz corpus alone put ~720
		 * identical entries in the log. */
		["a directory in no repository (mantahostels#253)", "/not-a-repo"],
		["a directory that does not exist (mantahostels#208)", "/gone"],
	])(
		"says nothing about a checkout in %s — git-tree calls it other",
		(_l, d) => {
			expect(verdict(`git -C ${d} checkout -b foo`)).toBe("allow");
			expect(logsOf(`git -C ${d} checkout -b foo`)).toEqual([]);
		},
	);

	it("says nothing about a checkout in a worktree it judged and passed", () => {
		expect(logsOf(`git -C ${LINKED} checkout -b foo`)).toEqual([]);
	});

	it("says nothing about an unresolvable cd carrying no branch move", () => {
		// Only the commands it was supposed to judge and could not belong in the log.
		expect(logsOf("cd $TARGET && npm run build")).toEqual([]);
	});
});

describe("an unset variable in the target is the cwd (#310, #325)", () => {
	const unsetLine =
		"`$UNSET_325` is unset in this call; shell variables do not carry over between Bash calls.";

	it.each([
		'cd "$UNSET_325" && git checkout -b foo',
		'git -C "$UNSET_325" switch -c foo',
	])("refuses %s in the shared tree, naming the variable", (command) => {
		const h = harness();
		const r = (decide(command, h.ctx) as { deny: string }).deny;
		expect(r).toContain(`${MOVED}: `);
		expect(r).toContain(`\n\n${unsetLine}\n\n${readBranchRule()}`);
		expect(h.logs).toEqual([]);
	});

	it("names it in the worktree refusal too", () => {
		const r = reason('git -C "$UNSET_325" worktree add ../x');
		expect(r).toContain(WORKTREE);
		expect(r).toContain(`\n\n${unsetLine}\n\n${readBranchRule()}`);
	});

	it.each([
		'git -C "$UNSET_325" checkout -- file.txt',
		'cd "$UNSET_325" && git checkout main',
		'git -C "$UNSET_325" worktree add -b n ../x',
		'git -C "$UNSET_325" worktree list',
	])("keeps the verdict %s already had: allowed", (command) => {
		expect(verdict(command)).not.toBe("deny");
	});

	it("allows it from a linked worktree, which is where it runs", () => {
		expect(
			verdict('cd "$UNSET_325" && git checkout -b foo', { cwd: LINKED }),
		).toBe("allow");
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
		const command = 'cd "$(pwd)" && git checkout -b foo';
		expect(verdict(command)).toBe("allow");
		expect(logsOf(command)).toEqual([
			expect.stringMatching(
				/^could not resolve the working tree for a git checkout/,
			),
		]);
	});
});

describe("core paths", () => {
	it("spells the refusal's paths through the corePaths port, the command spliced after", () => {
		const h = harness();
		const ctx = {
			...h.ctx,
			corePaths: (t: string) =>
				t.replaceAll("docs/agents/", "/plugin/docs/agents/"),
			ruleText: () => "see docs/agents/rules/x.txt",
		};
		const d = decide("git checkout -b docs/agents/x", ctx) as { deny: string };
		expect(d.deny).toContain("see /plugin/docs/agents/rules/x.txt");
		expect(d.deny).toContain(`${MOVED}: git checkout -b docs/agents/x`);
	});
});

describe("what a flag makes of the word after it", () => {
	it.each([
		[
			"git checkout -p sidebranch",
			"-p restores: the name is a tree-ish, not a move",
		],
		["git checkout --patch sidebranch", "its long spelling"],
		["git checkout -- main", "after `--`, main is a path"],
	])("%s passes, handed nothing — %s", (command) => {
		expect(run(command)).toBeNull();
	});

	it.each([
		["git switch -c main", "creating main is no return to it"],
		["git switch --force-create main", "nor is force-creating it"],
		["git checkout main a.md", "main with a path is two words, not the repair"],
	])("%s is a move — %s", (command) => {
		expect(reason(command)).toContain(MOVED);
	});
});
