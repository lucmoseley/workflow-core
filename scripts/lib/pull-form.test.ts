// @vitest-environment node
/*
 * lib/pull-form.js, the guard-pull-form core (#2797), in process: which
 * commands are refused a non-fast-forward reconciliation of the shared `main`
 * (mantahostels#245, #290), a rewind of `main` (#765) or a wholesale discard
 * of the shared tree's uncommitted work (#768), with what text, and which are
 * handed the pull rule instead. A deny is only defensible while it cannot
 * wedge sanctioned work, so every allow-case below is a shape that would
 * otherwise be a false positive; do not thin them out.
 *
 * The git reads are fakes answering as the trio fixture's real repos do: the
 * shared tree at /repo on `main`, a linked worktree at /repo-wt, another repo
 * at /other. The rule store is the real one, in process, so a refusal is held
 * to the fragment it splices. Each production read is
 * pull-form-host.test.ts's; the program's boundary is
 * guard-pull-form.test.ts's.
 */

import { describe, expect, it } from "vitest";
import { fakeTreeClassifier } from "./git-tree-fake.js";
import { denyFires } from "./guard-fires-testkit";
import { kitContextFake } from "./kit-context-fake";

type Decision =
	| { deny: string }
	| { injectRules: string[]; skip?: string[] }
	| null;

const { decide } = require("./pull-form.js") as {
	decide: (command: string, ctx: object) => Decision;
};
const { readRuleText } = require("./rule-text.js") as {
	readRuleText: (id: string) => string;
};

const SHARED = "/repo";
const LINKED = "/repo-wt";
const ELSEWHERE = "/other";
/* The trio fixture's commits and trees, as rev-parse --verify answers. */
const OBJECTS = [
	"HEAD",
	"HEAD~1",
	"@",
	"main",
	"side",
	"origin/main",
	"refs/heads/main",
	"refs/heads/side",
];

interface Over {
	/** The walk's starting directory; left off, the shared tree's root. */
	cwd?: string;
	modules?: string[];
	vars?: Record<string, string>;
	pullFf?: string;
	requireForce?: string;
	/** The checked-out branch; left off, `main`. */
	branch?: string;
	/** True: every rule fetch throws, as an empty store does. */
	storeFault?: boolean;
	mainUnreadable?: boolean;
	isDir?: (path: string) => boolean;
	readFileAliases?: Record<string, string | null> | null;
	corePaths?: (text: string) => string;
	scriptPath?: (name: string) => string;
}

const treeClass = fakeTreeClassifier({
	[SHARED]: "shared",
	[LINKED]: "linked",
	[`${SHARED}/.claude/worktrees/reconcile`]: "linked",
});

/** A context of fakes, answering as the trio fixture does. */
function harness(over: Over = {}) {
	const logs: string[] = [];
	const ctx = kitContextFake({
		fallbackCwd: over.cwd ?? SHARED,
		vars: over.vars ?? {},
		isDir: over.isDir ?? (() => true),
		moduleOn: (m: string) => (over.modules ?? []).includes(m),
		treeClass,
		log: (what: string, detail?: string) =>
			logs.push(detail ? `${what}\t${detail}` : what),
		pullFf: () => over.pullFf ?? "",
		cleanRequireForce: () => over.requireForce ?? "",
		currentBranch: () => over.branch ?? "main",
		isCommit: (_dir: string, w: string) => OBJECTS.includes(w),
		isTree: (_dir: string, w: string) => OBJECTS.includes(w),
		topLevel: (dir: string) => (dir.startsWith(SHARED) ? SHARED : dir),
		showPrefix: (dir: string) =>
			dir.startsWith(`${SHARED}/`) ? `${dir.slice(SHARED.length + 1)}/` : "",
		ruleText: (id: string) => {
			if (over.storeFault) throw new Error(`rule-text: no fragment for ${id}`);
			return readRuleText(id);
		},
		pushedRef: () =>
			over.modules?.includes("landing") ? "origin/landing" : "origin/main",
		isMainUnreadable: () => over.mainUnreadable ?? false,
		readFileAliases: () =>
			over.readFileAliases === null
				? null
				: new Map(Object.entries(over.readFileAliases ?? {})),
		corePaths: over.corePaths ?? ((t: string) => t),
		...(over.scriptPath && { scriptPath: over.scriptPath }),
	});
	return { ctx, logs };
}

const run = (command: string, over: Over = {}) =>
	decide(command, harness(over).ctx);

const denyOf = (command: string, over: Over = {}) => {
	const d = run(command, over);
	return d && "deny" in d ? d.deny : "";
};

const verdict = (command: string, over: Over = {}) => {
	const d = run(command, over);
	return d && "deny" in d ? "deny" : "allow";
};

/** The refusal `command` earns. Throws on an allow. */
const readDenyReason = (command: string, over: Over = {}) => {
	const d = run(command, over);
	if (!d || !("deny" in d)) throw new Error(`expected a deny for: ${command}`);
	return d.deny;
};

/** The ids a decision hands over: requested, less skipped. */
const handed = (d: Decision) =>
	d && "injectRules" in d
		? d.injectRules.filter((id) => !(d.skip ?? []).includes(id))
		: [];

const readPullRule = () => readRuleText("pull-fast-forward");
const readRewindRule = () => readRuleText("main-rewind");
const readDiscardRule = () => readRuleText("shared-tree-discard");

const UNRESOLVED_LOG =
	"could not resolve the working tree for a git pull — the reconciliation allowed unchecked";

describe("the relocated rule reaches the session that trips the guard", () => {
	it.each([
		["git pull", "a bare pull, which may rebase or merge by config"],
		["git pull --rebase", "the #245 command exactly"],
	])("%s carries the whole rule — %s", (command) => {
		expect(readDenyReason(command)).toContain(readPullRule());
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
		expect(readDenyReason("git pull")).toContain(clause);
	});

	it("frames the refusal in the words the fire needles key, then the rule", () => {
		expect(readDenyReason("git pull --rebase")).toBe(
			`This reconciles the shared \`main\` by rewriting or merging, not by fast-forward: git pull --rebase\n\n${readPullRule()}`,
		);
	});

	it("carries the rule's fallback sentence where the store cannot give it (mantahostels#1648)", () => {
		expect(readDenyReason("git pull --rebase", { storeFault: true })).toBe(
			"This reconciles the shared `main` by rewriting or merging, not by fast-forward: git pull --rebase\n\nReconcile the shared `main` by fast-forward or not at all; the rule could not be read from docs/agents/rules/pull-fast-forward.txt. Read that file before doing anything else.",
		);
		expect(
			readDenyReason("git pull --rebase", {
				storeFault: true,
				modules: ["landing"],
			}),
		).toContain(
			"Reconcile the shared `main` with `landing` by fast-forward or not at all; the rule could not be read from docs/agents/rules/pull-fast-forward-landing.txt. Read that file before doing anything else.",
		);
	});

	it("spells the refusal's paths at the plugin root, before the command is spliced in (#343)", () => {
		const corePaths = (t: string) => t.replaceAll("docs/", "/plugin/docs/");
		const reason = readDenyReason('git pull --rebase "docs/x"', {
			storeFault: true,
			corePaths,
		});
		expect(reason).toContain("/plugin/docs/agents/rules/pull-fast-forward.txt");
		expect(reason).toContain('git pull --rebase "…"');
	});
});

/*
 * THE SECOND LIMB (mantahostels#1648, spec mantahostels#1762): the same
 * fragment, handed over before the mistake rather than inside the refusal.
 * Its rendering, latch and cap are lib/guard-entry.js's, crossed at the
 * program's boundary.
 */
describe("the rule reaches a session BEFORE it trips the guard (mantahostels#1648)", () => {
	it.each([
		["git pull --ff-only", "the sanctioned spelling"],
		["git pull --ff-only origin main", "with the remote named"],
		["git fetch && git pull --ff-only", "at the tail of a chain"],
	])("%s is handed the rule and NOT refused — %s", (command) => {
		const d = run(command);
		expect(d).not.toBeNull();
		expect(d).not.toHaveProperty("deny");
		expect(handed(d)).toEqual(["pull-fast-forward"]);
	});

	it("requests both twins in priority order, the module choosing one (#2409)", () => {
		expect(run("git pull --ff-only")).toEqual({
			injectRules: ["pull-fast-forward", "pull-fast-forward-landing"],
			skip: ["pull-fast-forward-landing"],
		});
	});

	it("hands the landing recipe in place of today's with the landing module on (#2409)", () => {
		expect(handed(run("git pull --ff-only", { modules: ["landing"] }))).toEqual(
			["pull-fast-forward-landing"],
		);
	});

	it("refuses a merge with the landing recipe with the module on (#2409)", () => {
		const reason = readDenyReason("git merge origin/landing", {
			modules: ["landing"],
		});
		expect(reason).toContain(readRuleText("pull-fast-forward-landing"));
		expect(reason).not.toContain(readPullRule());
	});

	it.each([
		["git pull --help", "documentation reconciles nothing"],
		["git fetch origin", "a fetch moves no local ref"],
		["git status", "not a pull at all"],
		["git merge --abort", "unwinding starts no reconciliation"],
		["git rebase --continue", "nor does finishing one"],
	])("%s is handed nothing — %s", (command) => {
		expect(run(command)).toBeNull();
	});

	it("the recipe's own last step is handed the rule too (#290)", () => {
		// `git merge --ff-only` is where a session lands at the end of the
		// worktree detour, and it is allowed — so the rule reaches it as context.
		const d = run("git merge --ff-only reconcile-290");
		expect(d).not.toHaveProperty("deny");
		expect(handed(d)).toEqual(["pull-fast-forward"]);
	});

	it("a denied pull carries the rule in its refusal, not as context", () => {
		// The two limbs are exclusive: the first refusal ends the judging, so a
		// refused session gets one copy and not two.
		const d = run("git pull --ff-only && git pull --rebase");
		expect(d).toEqual({ deny: expect.stringContaining(readPullRule()) });
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
		// exempt (mantahostels#2145): the guard has one deny message, and each
		// spelling here is its own whole command, so no other trigger is
		// available; its text is pinned by "tells the session what to run
		// instead" below.
		expect(verdict(command)).toBe("deny");
	});

	it("sees the shared tree through a variable the command assigned (mantahostels#208)", () => {
		const command = `WT=${SHARED} && git -C "$WT" pull --rebase`;
		// The chain has two segments, so the refusal must name the pull one.
		expect(readDenyReason(command)).toContain('git -C "…" pull --rebase');
	});

	it("resolves a leading cd, so the tree is judged not the caller's cwd", () => {
		const command = `cd ${SHARED} && git pull --rebase`;
		expect(readDenyReason(command, { cwd: ELSEWHERE })).toContain(
			"git pull --rebase",
		);
		expect(verdict("git pull --rebase", { cwd: ELSEWHERE })).toBe("allow");
	});

	it("resolves git -C, including from inside a worktree", () => {
		// exempt (mantahostels#2145): one command, one segment, and the guard's
		// single deny message is pinned by "tells the session what to run
		// instead" below.
		expect(verdict(`git -C ${SHARED} pull --rebase`, { cwd: LINKED })).toBe(
			"deny",
		);
	});

	it("tells the session what to run instead", () => {
		const reason = readDenyReason("git pull --rebase");
		expect(reason).toContain("git pull --ff-only");
		expect(reason).toContain("git pull --rebase");
	});

	it("echoes the command back readably, not as the sentinel byte (mantahostels#138)", () => {
		// The parse blanks every quoted span to a sentinel before the guard
		// sees it, so echoing the segment raw prints that byte at the user;
		// unmask is what puts a readable "…" back.
		const reason = readDenyReason('git pull --rebase "origin main"');
		expect(reason).not.toContain("QSTR");
		expect(reason).not.toContain("\x01");
		expect(reason).toContain('git pull --rebase "…"');
	});
});

/*
 * The allow-cases are the load-bearing half: a session stranded mid-merge
 * must still be able to unwind, and the recipe's own last step is a merge.
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
		// exempt (mantahostels#2145): the guard has one deny message for every
		// reason, and it is pinned by "the refusal carries the worktree recipe"
		// below.
		expect(verdict(command)).toBe("deny");
	});

	it("the refusal carries the worktree recipe, not just a refusal", () => {
		const reason = readDenyReason("git merge origin/main");
		expect(reason).toContain(readPullRule());
		expect(reason).toContain("git worktree add -b reconcile-");
		expect(reason).toContain("git merge origin/main");
	});

	it("resolves the tree, so another repo's merge is left alone", () => {
		expect(verdict(`git -C ${ELSEWHERE} merge origin/main`)).toBe("allow");
		expect(verdict("git rebase origin/main", { cwd: ELSEWHERE })).toBe("allow");
	});

	it("a linked worktree is where the reconciliation belongs, so it is exempt", () => {
		expect(verdict("git merge origin/main", { cwd: LINKED })).toBe("allow");
		expect(verdict("git rebase origin/main", { cwd: LINKED })).toBe("allow");
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
		["git rebase --show-current-patch", "reading the stopped patch"],
	])("%s passes — %s", (command) => {
		// A tree stranded mid-merge with no way out is worse than the merge that
		// stranded it, so these are allowed on either subcommand.
		expect(run(command)).toBeNull();
	});

	it.each([
		["git merge --help", "documentation merges nothing"],
		["git rebase -h", "the short spelling"],
	])("%s passes — %s", (command) => {
		expect(run(command)).toBeNull();
	});

	it.each([
		["git merge-base --is-ancestor a b", "what concision-backstop.sh runs"],
		["git merge-tree a b", "a read-only three-way merge"],
	])("%s is a different subcommand, not a merge — %s", (command) => {
		// The walker matches the subcommand word whole, so a hyphenated neighbour
		// is never the merge this guard judges.
		expect(run(command)).toBeNull();
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
	 * per flag — gitValueFlags carries the derivation.
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
		expect(verdict("git merge origin/main", { pullFf: "only" })).toBe("deny");
		expect(verdict("git rebase origin/main", { pullFf: "only" })).toBe("deny");
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
		expect(verdict("git pull", { pullFf: "only" })).toBe("allow");
		expect(verdict("git pull origin main", { pullFf: "only" })).toBe("allow");
		expect(verdict("git pull", { pullFf: "true" })).toBe("deny");
	});

	it("but a flag countermanding that config is still denied, echoing the command", () => {
		// The guard has one deny message for every reason (mantahostels#2145),
		// so this only pins that the countermanding command was the segment
		// echoed back — not which branch of the judge produced the deny.
		for (const command of [
			"git pull --no-ff",
			"git pull --ff",
			"git pull --no-rebase",
			"git pull --rebase",
		])
			expect(readDenyReason(command, { pullFf: "only" })).toContain(command);
	});

	it("fetch moves no local ref, so it is never matched", () => {
		expect(run("git fetch origin main")).toBeNull();
		expect(run("git fetch --all")).toBeNull();
	});

	it("ordinary git work is untouched", () => {
		expect(run("git status")).toBeNull();
		expect(run("git push origin main")).toBeNull();
		expect(run('git commit -m "x" -- a.md')).toBeNull();
	});
});

describe("text that merely mentions a pull is not a pull", () => {
	it.each([
		['grep -rn "git pull --rebase" docs/', "a search"],
		["echo 'git pull --rebase'", "a single-quoted mention"],
		['echo "a | git pull --rebase"', "a pipe inside a quoted string"],
		["cat <<EOF > f.md\ngit pull --rebase\nEOF", "a heredoc body"],
	])("%s — %s", (command) => {
		expect(run(command)).toBeNull();
	});
});

describe("trees this guard has no business in", () => {
	it("a linked worktree is exempt — its ref is its own", () => {
		expect(run("git pull --rebase", { cwd: LINKED })).toBeNull();
		expect(run("git pull", { cwd: LINKED })).toBeNull();
	});

	it("an unrelated repository is left alone", () => {
		expect(run(`git -C ${ELSEWHERE} pull --rebase`)).toBeNull();
		expect(run("git pull --rebase", { cwd: ELSEWHERE })).toBeNull();
	});

	it("fails open on a bare pull whose path it cannot resolve rather than wedging the run", () => {
		expect(verdict('cd "$CLAUDE_JOB_DIR/tmp/sync" && git pull')).toBe("allow");
	});
});

describe("hard cases at the edge of the parser", () => {
	it("a subshell or command substitution cannot hide the pull", () => {
		// The refusal echoes the segment it fired on, so it must be the pull
		// itself rather than the wrapper the parser was asked to see through.
		for (const command of ["(git pull --rebase)", "x=$(git pull --rebase)"])
			expect(readDenyReason(command)).toContain("git pull --rebase");
	});

	it("<< inside a quoted string does not open a heredoc", () => {
		// Otherwise it swallows every line after it, the pull included.
		expect(readDenyReason('echo "a << b"\ngit pull --rebase')).toContain(
			"git pull --rebase",
		);
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
		// with a dash — the measurement is on the guard's LIMITS block.
		// Without the --ff-only this would be denied anyway, as a bare pull.
		expect(verdict("git pull --ff-only -s -r")).toBe("allow");
	});

	it("a bundled -r is a rebase, even under pull.ff=only", () => {
		// Measured on git 2.43.0: pull.ff=only does NOT stop an explicit
		// --rebase, it rebases and rewrites the local commit.
		for (const command of [
			"git pull -qr",
			"git pull -rq",
			"git pull -qr origin main",
		])
			expect(readDenyReason(command, { pullFf: "only" })).toContain(command);
		expect(verdict("git pull -q", { pullFf: "only" })).toBe("allow");
	});

	it("a later --no-ff or --ff countermands --ff-only, as git does (#308)", () => {
		expect(verdict("git pull --ff-only --no-ff")).toBe("deny");
		expect(verdict("git pull --ff-only --ff")).toBe("deny");
		expect(verdict("git pull --no-ff --ff-only")).toBe("allow");
	});

	it("--rebase=false is a merge, so --ff-only alongside it still passes", () => {
		expect(verdict("git pull --rebase=false --ff-only")).toBe("allow");
		expect(verdict("git pull --rebase=0 --ff-only")).toBe("allow");
		for (const command of [
			"git pull --rebase=false",
			"git pull --rebase=no",
			"git pull --rebase=0",
		])
			expect(readDenyReason(command)).toContain(command);
		expect(verdict("git pull --rebase=0", { pullFf: "only" })).toBe("deny");
		expect(verdict("git pull --rebase=true --ff-only")).toBe("deny");
	});
});

/*
 * #301. An EMPTY `-C` or `cd` target is not an unknown tree: git and bash
 * both run against the cwd, so the parser resolves it and the command is
 * judged where it actually lands.
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
		const reason = readDenyReason('git -C "" merge origin/main');
		expect(reason).toContain("This reconciles the shared `main`");
		expect(reason).not.toContain("I cannot tell which working tree");
	});

	it("is resolved, not blanket-denied — elsewhere it still passes", () => {
		expect(verdict('git -C "" merge origin/main', { cwd: ELSEWHERE })).toBe(
			"allow",
		);
		expect(verdict('cd "" && git merge origin/main', { cwd: LINKED })).toBe(
			"allow",
		);
	});
});

/*
 * A target the parser cannot EXPAND is genuinely unknown, and on `merge` and
 * `rebase` it fails CLOSED — the command reconciles wherever it lands, and
 * the shared tree is one of the candidates. The false denies that buys are
 * pinned deliberately: the escape is a literal path.
 */
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
		const reason = readDenyReason('git -C "$W" merge origin/main');
		expect(
			reason,
		).toBe(`I cannot tell which working tree this \`git merge\` lands in — an empty or
unexpanded \`-C\`, or a \`cd\` to a path I cannot resolve: git -C "…" merge origin/main

An unset variable there is not a different tree — it expands to nothing, and
both \`git -C ""\` and \`cd ""\` stay in the current directory.

Spell the worktree as a LITERAL path in a plain \`cd\` or \`-C\` in the same
command — \`git -C .claude/worktrees/reconcile merge origin/main\` — or assign
it literally in the same Bash call, as the recipe below does. A \`pushd\`, a
\`cd -P\` or a \`builtin cd\` is unreadable here whatever path it carries.

${readPullRule()}`);
		expect(readDenyReason('git -C "$W" rebase origin/main')).toContain(
			"this `git rebase` lands in",
		);
	});

	it("names the landing upstream in the escape with the module on (#2536)", () => {
		expect(
			readDenyReason('git -C "$W" merge origin/landing', {
				modules: ["landing"],
			}),
		).toContain("`git -C .claude/worktrees/reconcile merge origin/landing`");
	});

	it("refuses an innocent tree too — the accepted cost of failing closed", () => {
		// The tree is `elsewhere` and the merge is harmless, but the guard cannot
		// know that.
		expect(verdict('E=$OTHER; git -C "$E" merge origin/main')).toBe("deny");
		expect(verdict(`git -C ${ELSEWHERE} merge origin/main`)).toBe("allow");
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
	])("%s is denied, with nothing recorded as a fail-open — %s", (command) => {
		const { ctx, logs } = harness();
		expect(decide(command, ctx)).toHaveProperty("deny");
		expect(logs).toEqual([]);
	});

	it("is refused for its flag, not for the tree it could not read", () => {
		// Spelling the path literally would not help, so the refusal must not
		// offer it.
		const reason = readDenyReason('git -C "$W" pull --rebase origin main');
		expect(reason).toContain("not by fast-forward");
		expect(reason).not.toContain("I cannot tell which working tree");
	});

	it("--ff-only passes unrecorded, the last word winning, and is handed the rule", () => {
		for (const command of [
			'cd "$TARGET" && git pull --ff-only',
			'git -C "$W" pull --no-ff --ff-only',
		]) {
			const { ctx, logs } = harness();
			expect(handed(decide(command, ctx))).toEqual(["pull-fast-forward"]);
			expect(logs).toEqual([]);
		}
	});

	it("a bare pull keeps the fail-open and its record, and is handed the rule", () => {
		for (const command of [
			'cd "$TARGET" && git pull',
			"cd $TARGET && git pull",
		]) {
			const { ctx, logs } = harness();
			expect(handed(decide(command, ctx))).toEqual(["pull-fast-forward"]);
			expect(logs).toEqual([UNRESOLVED_LOG]);
		}
	});
});

/* The shared tree's HEAD~1 is a commit, as the fixture's second commit makes
 * it. */
describe("rewinding main is refused (#765)", () => {
	it.each([
		["git reset --hard HEAD~1", "the hard form"],
		["git reset --soft HEAD~1", "the soft form"],
		["git reset --mixed HEAD~1", "the mixed form, spelled"],
		["git reset HEAD~1", "the mixed default"],
		["git reset --keep HEAD~1", "keeping local changes"],
		["git reset --merge HEAD~1", "merging local changes"],
		["git reset -q HEAD~1 --", "a commit with no path after the --"],
		["git reset v9 --", "a word before the -- is a commit, read or not"],
		["git reset $SHA", "a commit it cannot read"],
		["git reset --hard HEAD~5", "an ancestor that does not resolve (#3177)"],
		["git reset --hard HEAD^^", "the same, spelled with carets"],
		["git reset --hard @~5", "the same, from @"],
		["git reset --hard main~5", "the same, from a branch"],
		["git update-ref refs/heads/main HEAD~1", "the ref written directly"],
		["git update-ref -m why refs/heads/main HEAD~1", "past a -m value"],
		["git update-ref -d refs/heads/main", "deleted directly"],
		["git update-ref HEAD HEAD~1", "HEAD, which is main here"],
		["git update-ref --stdin", "a list it cannot read"],
		['git update-ref "$REF" HEAD~1', "a ref it cannot read"],
		['git update-ref "refs/heads/$B" HEAD~1', "a branch ref it cannot read"],
		[
			'git update-ref "refs/$X" HEAD~1',
			"a ref whose read head could still be main",
		],
		[
			'git update-ref "refs/heads/ma$X" HEAD~1',
			"read up to inside main's name",
		],
		['git update-ref "H$X" HEAD~1', "read up to inside HEAD"],
		['git update-ref "$(echo refs/tags)/$T" HEAD~1', "led by a substitution"],
		["git update-ref refs/heads/ma\\i$X HEAD~1", "read through an escape"],
		["git update-ref refs/heads/ma\\in HEAD~1", "main, escaped (#3518)"],
		["git reset --hard HEAD\\~1", "the commit, escaped (#3518)"],
		["git branch -D ma\\in", "deleted, escaped (#3518)"],
		[
			"git update-ref refs/heads/{main,side} HEAD~1",
			"main among a brace group's words (#3578)",
		],
		["git branch -D {x}y,main}", "main past a literal `}` (#3578)"],
		["git update-ref main-worktree/HEAD HEAD~1", "the shared tree's HEAD"],
		['git update-ref "m$X" HEAD~1', "read up to inside main-worktree/HEAD"],
		["git symbolic-ref refs/heads/main refs/heads/side", "main repointed"],
		["git symbolic-ref -m why -q refs/heads/main refs/heads/side", "past -m"],
		["git symbolic-ref -- refs/heads/main refs/heads/side", "past a --"],
		["git symbolic-ref -d refs/heads/main", "main's symref deleted"],
		["git symbolic-ref --del refs/heads/main", "deleted, abbreviated"],
		["git symbolic-ref -qd refs/heads/main", "deleted, in a bundle"],
		["git symbolic-ref HEAD refs/heads/side", "HEAD away from main"],
		["git symbolic-ref HEAD refs/heads/mainline", "a name main only begins"],
		['git symbolic-ref HEAD "$T"', "HEAD to a target it cannot read"],
		["git symbolic-ref main-worktree/HEAD refs/heads/side", "the shared HEAD"],
		['git symbolic-ref "$R" refs/heads/side', "a name it cannot read"],
		["git symbolic-ref $R", "a lone word that could split into two"],
		["git symbolic-ref refs/heads/./main refs/heads/side", "a dot component"],
		["git symbolic-ref refs/heads//main refs/heads/side", "a doubled slash"],
		["git symbolic-ref /refs/heads/main refs/heads/side", "a leading slash"],
		["git symbolic-ref ../.git/refs/heads/main refs/heads/side", "up and back"],
		["git symbolic-ref ./HEAD refs/heads/side", "HEAD, as a path"],
		[
			'git symbolic-ref "refs/remotes/$X" refs/heads/side',
			"a walk it cannot read (#3915)",
		],
		['git symbolic-ref "x$X" refs/heads/side', "the same, off a stray head"],
		["git symbolic-ref refs/heads/mai* refs/heads/side", "a glob at main"],
		["git symbolic-ref H* refs/heads/side", "a glob at HEAD"],
		[
			"git symbolic-ref refs/heads/side refs/heads/main",
			"another ref onto main",
		],
		['git symbolic-ref refs/heads/side "$T"', "onto a target it cannot read"],
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
		expect(readDenyReason(command)).toContain(readRewindRule());
	});

	it.each([
		[
			"git reset --hard HEAD~1",
			"moves the shared `main` to another commit, dropping whatever came after it if that commit is behind — to move `main` forward, `git merge --ff-only <commit>`",
		],
		[
			"git reset $SHA",
			"resets the shared tree to a commit I cannot read — spell it literally, or use `git reset -- <path>` to unstage",
		],
		[
			"git update-ref --stdin",
			"updates refs from a list I cannot read, `main` possibly among them",
		],
		[
			"git update-ref refs/heads/main HEAD~1",
			"writes `main` directly, dropping whatever came after the commit it names",
		],
		[
			"git update-ref HEAD HEAD~1",
			"writes the shared tree's HEAD, and so `main`, directly",
		],
		["git branch -D main", "deletes `main`"],
		["git branch -M side main", "replaces `main` with another branch"],
		["git branch -m main old", "renames `main` away"],
		["git branch -m old", "renames the shared tree's branch, `main`, away"],
		[
			"git branch -C side main",
			"replaces `main` with a copy of another branch",
		],
		[
			"git branch -f main HEAD~1",
			"forces `main` to another commit, dropping whatever came after it",
		],
		[
			"git switch -C main HEAD~1",
			"recreates `main` at another commit, dropping whatever came after it",
		],
		[
			"git symbolic-ref refs/heads/main refs/heads/side",
			"rewrites `main` as a pointer to another ref, or deletes one, leaving its commits behind",
		],
		[
			"git symbolic-ref HEAD refs/heads/side",
			"points the shared tree's HEAD away from `main`",
		],
		[
			"git symbolic-ref refs/heads/side refs/heads/main",
			"points another ref at `main`, so a write through it moves `main` past git's own refusal",
		],
		[
			"git symbolic-ref ../.git/refs/heads/main refs/heads/side",
			"writes a ref through a path git follows, `main` possibly among them",
		],
	])("%s is framed as lib/main-rewind.js frames it", (command, what) => {
		expect(readDenyReason(command)).toBe(
			`This ${what}: ${command}\n\n${readRewindRule()}`,
		);
	});

	it("names the unreadable word as the reason a symbolic-ref is refused", () => {
		expect(readDenyReason('git symbolic-ref "$R" refs/heads/side')).toContain(
			"writes a symbolic ref I cannot read",
		);
	});

	it.each([
		"git update-ref refs/heads/main abc123",
		"git symbolic-ref refs/heads/main refs/heads/side",
		"git symbolic-ref HEAD refs/heads/side",
		"git reset --hard HEAD~1",
		"git branch -f main HEAD~1",
		"git branch -D main",
		"git branch -m other main",
		"git checkout -B main HEAD~1",
		"git switch -C main HEAD~1",
	])(
		"%s stays refused on an unreadable main, naming the repair script (#3198)",
		(command) => {
			const reason = readDenyReason(command, { mainUnreadable: true });
			expect(reason).toContain(readRewindRule());
			expect(reason).toContain("node scripts/repair-main.js");
			expect(readDenyReason(command)).not.toContain("repair-main");
		},
	);

	it("spells the repair script through the context's port (#3926)", () => {
		expect(
			readDenyReason("git checkout -B main HEAD~1", {
				mainUnreadable: true,
				scriptPath: (name) => `/plugin/scripts/${name}`,
			}),
		).toContain("node /plugin/scripts/repair-main.js");
	});

	it("carries lib/main-rewind.js's fallback where the store cannot give the rule (#1777)", () => {
		expect(readDenyReason("git branch -D main", { storeFault: true })).toBe(
			"This deletes `main`: git branch -D main\n\nNever move `main` backwards; the rule could not be read from docs/agents/rules/main-rewind.txt. Read that file before doing anything else.",
		);
	});

	/* #1759: guard-branch-publish's needles key on its own framing, so a
	 * rewind it never printed is not credited to it. */
	it.each(["git reset --hard HEAD~1", "git branch -D main"])(
		"%s counts once, as a main-rewind refusal",
		(command) => {
			expect(denyFires(readDenyReason(command))).toEqual([
				"guard:guard-dispatch.js/main-rewind",
			]);
		},
	);

	it("the refusal names the follow-up commit and echoes the command", () => {
		const reason = readDenyReason("git reset --soft HEAD~1");
		expect(reason).toContain("git reset --soft HEAD~1");
		expect(reason).toContain("git revert <sha>");
	});

	it.each([
		["git reset -- a.md", "a pathspec unstage"],
		["git reset HEAD a.md", "a tree-ish and a path"],
		["git reset a.md", "a lone word that is a path, not a commit"],
		["git reset a.md~", "a path ending in ~, its stem no commit"],
		["git reset", "unstage everything"],
		["git reset --soft HEAD", "the commit it is already on"],
		["git reset --soft @", "the same, spelled @"],
		["git reset --soft main", "the branch it is already on"],
		["git reset --soft refs/heads/main", "the same, spelled whole"],
		["git reset -p HEAD~1", "interactive paths"],
		["git reset --patch HEAD~1", "interactive paths, long"],
		["git reset --pathspec-from-file=list HEAD~1", "file-fed paths"],
		["git reset --help", "documentation"],
		["git update-ref refs/heads/side HEAD", "another branch"],
		["git update-ref -m why", "nothing named"],
		["git symbolic-ref HEAD", "a read"],
		["git symbolic-ref --short HEAD", "a short read"],
		["git symbolic-ref -q HEAD", "a quiet read"],
		["git symbolic-ref --short -q HEAD", "both"],
		["git symbolic-ref --no-recurse HEAD", "one level read"],
		["git symbolic-ref refs/heads/main", "main itself, read"],
		["git symbolic-ref HEAD refs/heads/main", "HEAD written onto main"],
		["git symbolic-ref refs/heads/side refs/heads/other", "another branch"],
		[
			"git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main",
			"a remote's HEAD",
		],
		["git symbolic-ref -d refs/heads/side", "another branch deleted"],
		["git symbolic-ref --help", "documentation"],
		["git symbolic-ref", "nothing named"],
		[
			'git update-ref "refs/reviewed/$T" "$T"',
			"a ref whose read head rules main out (#3441)",
		],
		[
			'git branch -D "side/$B"',
			"a branch whose read head rules main out (#3441)",
		],
		["git update-ref refs/reviewed/$T $T", "the same, unquoted"],
		[
			'git update-ref "refs/heads/ma\\i$X" HEAD~1',
			"a quoted backslash stays, ruling main out (#3518)",
		],
		[
			"git update-ref refs/heads/\\$X HEAD~1",
			"an escaped $, read as text (#3518)",
		],
		["git branch -f side HEAD~1", "another branch forced"],
		["git branch -D side", "another branch deleted"],
		["git branch -c main backup", "main copied, not replaced"],
		["git branch main", "main named, not forced"],
		["git branch --list", "a listing"],
		["git branch -h", "documentation"],
		["git checkout main", "the repair the guard-branch core allows"],
		["git checkout -b main2 HEAD~1", "a new branch, not main"],
		["echo git reset --hard HEAD~1", "text naming a reset"],
	])("%s passes — %s", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it("a reset naming the checked-out branch moves nothing, whichever branch that is", () => {
		expect(verdict("git reset --soft side", { branch: "side" })).toBe("allow");
		expect(verdict("git reset --soft main", { branch: "side" })).toBe("deny");
		expect(verdict("git reset --soft main", { branch: "" })).toBe("deny");
	});

	it.each([
		"git reset --hard HEAD~1",
		"git update-ref HEAD HEAD~1",
		"git symbolic-ref HEAD refs/heads/side",
		"git branch -m renamed",
		"git checkout -B side HEAD~1",
	])(
		"inside a throwaway worktree %s passes — it moves that tree's own branch",
		(command) => {
			expect(verdict(command, { cwd: LINKED })).toBe("allow");
		},
	);

	it.each([
		"git update-ref refs/heads/main HEAD",
		"git update-ref main-worktree/HEAD HEAD",
		'git update-ref "main-worktree/$H" HEAD',
		"git symbolic-ref refs/heads/main refs/heads/side",
		"git symbolic-ref main-worktree/HEAD refs/heads/side",
		"git symbolic-ref HEAD refs/heads/main",
		"git symbolic-ref refs/heads/side refs/heads/main",
		'git symbolic-ref HEAD "$T"',
		"git symbolic-ref ../../../.git/refs/heads/main refs/heads/side",
		'git symbolic-ref "refs/heads/$B" refs/heads/side',
		"git checkout -B main --ignore-other-worktrees HEAD",
	])(
		"but %s from a worktree still rewinds the one main, so is refused with the main-rewind rule",
		(command) => {
			expect(readDenyReason(command, { cwd: LINKED })).toContain(
				readRewindRule(),
			);
		},
	);

	it("reaches the shared tree through -C from a worktree", () => {
		expect(
			readDenyReason(`git -C ${SHARED} reset --hard HEAD~1`, { cwd: LINKED }),
		).toContain(readRewindRule());
	});

	it("a forward reset is refused too, and pointed at merge --ff-only", () => {
		expect(readDenyReason("git reset --hard HEAD~1")).toContain(
			"git merge --ff-only <commit>",
		);
	});

	it.each([
		'git -C "$UNSET" reset a.md',
		'git -C "$UNSET" branch -m renamed',
		'git -C "$UNSET" update-ref HEAD HEAD',
		'git -C "$UNSET" symbolic-ref HEAD refs/heads/side',
	])(
		"%s is refused with the main-rewind rule: the tree it lands in is unknown",
		(command) => {
			expect(readDenyReason(command)).toContain(readRewindRule());
		},
	);

	it.each([
		'git branch -D "$B"',
		'git branch -f "$B" HEAD',
		'git checkout -B "$B" HEAD',
		'git switch -C "$B" HEAD',
		'git branch -M side "$B"',
	])(
		"inside a worktree %s passes — git refuses main there itself",
		(command) => {
			expect(verdict(command, { cwd: LINKED })).toBe("allow");
		},
	);

	it.each([
		'git branch -D "$B"',
		'git checkout -B "$B" HEAD',
		'git branch -C side "$B"',
	])(
		"but in the shared tree %s is refused: the word could be main",
		(command) => {
			expect(readDenyReason(command)).toContain(readRewindRule());
		},
	);

	it.each([
		'git checkout -B "$B" --ignore-other-worktrees HEAD',
		'git update-ref "refs/heads/$B" HEAD',
		"git update-ref refs/heads/{main,side}",
	])(
		"but inside a worktree %s is refused with the main-rewind rule — nothing else stops main",
		(command) => {
			expect(readDenyReason(command, { cwd: LINKED })).toContain(
				readRewindRule(),
			);
		},
	);

	it("an unrelated repository is left alone", () => {
		expect(verdict("git reset --hard HEAD~1", { cwd: ELSEWHERE })).toBe(
			"allow",
		);
		expect(verdict("git branch -D main", { cwd: ELSEWHERE })).toBe("allow");
	});
});

describe("a ref write reached through a named git directory is judged there (#3997)", () => {
	it.each([
		["git --git-dir=/repo/.git symbolic-ref HEAD refs/heads/side", "stuck"],
		["git --git-dir /repo/.git symbolic-ref HEAD refs/heads/side", "apart"],
		["GIT_DIR=/repo/.git git symbolic-ref HEAD refs/heads/side", "GIT_DIR"],
		[
			"GIT_COMMON_DIR=/repo/.git git symbolic-ref HEAD refs/heads/side",
			"common",
		],
		["git --git-dir=/repo/.git update-ref HEAD HEAD~1", "update-ref HEAD"],
		["GIT_DIR=/repo/.git git reset --hard HEAD~1", "a reset"],
		[
			"git --git-dir=../repo/.git symbolic-ref HEAD refs/heads/side",
			"relative",
		],
		[
			"git --git-dir=.git -C /repo symbolic-ref HEAD refs/heads/side",
			"after -C",
		],
		["git --git-dir=/repo/.git/ symbolic-ref HEAD refs/heads/side", "a slash"],
		[
			"export GIT_DIR=/repo/.git && git symbolic-ref HEAD refs/heads/side",
			"export",
		],
		[
			"GIT_DIR=/repo/.git; export GIT_DIR; git symbolic-ref HEAD refs/heads/side",
			"named",
		],
		[
			"declare -x GIT_DIR=/repo/.git; git symbolic-ref HEAD refs/heads/side",
			"declare",
		],
		[
			"GIT_DIR=/other/.git git --git-dir=/repo/.git symbolic-ref HEAD refs/heads/side",
			"the flag beats",
		],
		["GIT_DIR=$X git update-ref HEAD HEAD~1", "unreadable"],
		['git --git-dir="$X" symbolic-ref HEAD refs/heads/side', "unreadable flag"],
		["GIT_DIR= git symbolic-ref HEAD refs/heads/side", "empty"],
		[
			"GIT_DIR=/repo/.git GIT_COMMON_DIR=/other/.git git symbolic-ref HEAD refs/heads/side",
			"both",
		],
		[
			"(export GIT_DIR=/other/.git; git status); git update-ref refs/heads/main HEAD~1",
			"subshell ended",
		],
		[
			"export GIT_DIR=/other/.git; unset GIT_DIR; git update-ref refs/heads/main HEAD~1",
			"unset",
		],
		[
			"GIT_DIR=/repo-wt/.git git update-ref refs/heads/main HEAD~1",
			"a linked tree's main",
		],
	])("refuses %s, from a linked tree (%s)", (command) => {
		expect(verdict(command, { cwd: LINKED })).toBe("deny");
	});

	it.each([
		["git --git-dir=/repo/.git symbolic-ref HEAD", "a read"],
		[
			"git --git-dir=/repo-wt/.git symbolic-ref HEAD refs/heads/side",
			"its own",
		],
		["git --git-dir=/repo/.git status", "no judged subcommand"],
	])("passes %s, from a linked tree (%s)", (command) => {
		expect(verdict(command, { cwd: LINKED })).toBe("allow");
	});

	it("judges the tree it stands in as well, whose files the command writes", () => {
		for (const [command, text] of [
			[
				"GIT_DIR=/other/.git git reset --hard HEAD~1",
				"moves the shared `main` to another commit",
			],
			[
				"git --git-dir=/other/.git clean -fd",
				"deletes every untracked file in the shared tree",
			],
			[
				"GIT_COMMON_DIR=/other/.git git symbolic-ref HEAD refs/heads/side",
				"points the shared tree's HEAD away from `main`",
			],
		] as const)
			expect(denyOf(command), command).toContain(text);
		expect(
			denyOf("GIT_DIR=/other/.git git update-ref refs/heads/main HEAD~1", {
				cwd: LINKED,
			}),
		).toContain("writes `main` directly");
	});

	it("refuses a git directory whose export it cannot follow", () => {
		for (const command of [
			"export GIT_DIR=/other/.git; GIT_DIR=/repo/.git; git symbolic-ref HEAD refs/heads/side",
			"set -a; GIT_DIR=/repo/.git; git symbolic-ref HEAD refs/heads/side",
			"GIT_DIR=/repo/.git; git symbolic-ref HEAD refs/heads/side",
			"eval export GIT_DIR=/repo/.git; git symbolic-ref HEAD refs/heads/side",
			'export "GIT_DIR=/repo/.git"; git symbolic-ref HEAD refs/heads/side',
		])
			expect(verdict(command, { cwd: LINKED }), command).toBe("deny");
	});

	it("refuses a gitfile under any other name, which could point anywhere", () => {
		expect(
			verdict("git --git-dir=/tmp/gf update-ref HEAD HEAD~1", {
				cwd: LINKED,
				isDir: () => false,
			}),
		).toBe("deny");
	});
});

describe("a subcommand reached through a command-line alias is judged as itself (#3997)", () => {
	it.each([
		[
			"git -c alias.s=symbolic-ref s refs/heads/main refs/heads/side",
			"symbolic-ref",
		],
		["git -c alias.u=update-ref u refs/heads/main HEAD~1", "update-ref"],
		["git -c 'alias.u=update-ref refs/heads/main' u HEAD~1", "its own words"],
		[
			"git -c alias.a=b -c alias.b=update-ref a refs/heads/main HEAD~1",
			"a chain",
		],
		["git -c Alias.U=update-ref u refs/heads/main HEAD~1", "any case"],
		[
			"git -c alias.u=status -c alias.u=update-ref u refs/heads/main HEAD~1",
			"the last wins",
		],
		[
			"GIT_CONFIG_KEY_0=alias.u GIT_CONFIG_VALUE_0=update-ref git u refs/heads/main HEAD~1",
			"the environment",
		],
		[
			"git --git-dir=/repo/.git -c alias.s=symbolic-ref s HEAD refs/heads/side",
			"with a git dir",
		],
	])("refuses %s (%s)", (command) => {
		expect(verdict(command, { cwd: LINKED })).toBe("deny");
	});

	it.each([
		[
			"git -c 'alias.u=!git update-ref' u refs/heads/main HEAD~1",
			"a shell alias",
		],
		["git -c alias.u=$X u refs/heads/main HEAD~1", "an unread value"],
		['git -c "$K" u refs/heads/main HEAD~1', "an unread definition"],
		['git -c "alias.$N=update-ref" u refs/heads/main HEAD~1', "an unread name"],
		[
			'git -c alias.u=update-ref "$(echo u)" refs/heads/main HEAD~1',
			"an unread word",
		],
		[
			"GIT_CONFIG_KEY_0=alias.u GIT_CONFIG_VALUE_0=status GIT_CONFIG_KEY_1=alias.u GIT_CONFIG_VALUE_1=update-ref git u refs/heads/main",
			"two in the environment",
		],
		["git --config-env=alias.u=V u refs/heads/main HEAD~1", "--config-env"],
		[
			"git --config-env alias.u=V u refs/heads/main HEAD~1",
			"--config-env, apart",
		],
		[
			"GIT_CONFIG_PARAMETERS=x git u refs/heads/main HEAD~1",
			"GIT_CONFIG_PARAMETERS",
		],
		[
			"GIT_CONFIG_KEY_0=$K GIT_CONFIG_VALUE_0=update-ref git u refs/heads/main",
			"an unread key",
		],
		[
			"git -c alias.x.command=update-ref x refs/heads/main HEAD~1",
			"a subsection",
		],
		[
			"git -c 'alias.u=--no-pager update-ref' u refs/heads/main HEAD~1",
			"an option first",
		],
	])("refuses an alias it cannot read: %s (%s)", (command) => {
		const d = run(command, { cwd: LINKED });
		expect(d && "deny" in d && d.deny).toContain("or alias I cannot read");
	});

	it("reads an alias of a judged name as the builtin git runs", () => {
		expect(verdict("git -c alias.reset=status reset --hard HEAD~1")).toBe(
			"deny",
		);
	});

	it.each([
		["git -c alias.st=status st", "an unjudged subcommand"],
		["git -c alias.u=update-ref u refs/heads/side HEAD~1", "another ref"],
		["git -c alias.s=symbolic-ref s HEAD", "a read"],
		["git -c 'alias.t=!x' status", "an alias it does not use"],
		[
			"git -c alias.u=update-ref -c alias.u=status u refs/heads/main",
			"the last wins",
		],
		["git -c core.pager=$V log", "another key's unread value"],
		[
			"GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=x git status",
			"another key",
		],
		["git -c alias.a=a a", "a loop, which git refuses"],
		["git -C /other -c 'alias.u=!x' u", "another repo"],
	])("passes %s (%s)", (command) => {
		expect(verdict(command, { cwd: LINKED })).toBe("allow");
	});
});

describe("an abbreviated long option reads as git reads it (#3998)", () => {
	it.each([
		["git branch --forc main HEAD~1", "forced"],
		["git branch --del main", "deleted"],
		["git branch --mov side main", "renamed onto"],
		["git branch --cop side main", "copied onto"],
		["git symbolic-ref --d refs/heads/main", "main's symref deleted"],
		["git update-ref --s", "from a list"],
		["git switch --force-c main HEAD~1", "recreated, its value the next word"],
		["git switch --force-c=main HEAD~1", "recreated, its value stuck on"],
		["git reset --h HEAD~1", "--hard"],
	])("%s is refused with the rewind rule — %s", (command) => {
		expect(readDenyReason(command)).toContain(readRewindRule());
	});

	it.each([
		["git reset --har", "--hard"],
		["git reset --kee HEAD", "--keep"],
		["git switch --dis side", "--discard-changes"],
		["git clean --fo", "--force"],
		["git clean --i", "--interactive"],
		["git restore --wor --sta .", "--worktree beside --staged"],
	])("%s is refused with the discard rule — %s", (command) => {
		expect(readDenyReason(command)).toContain(readDiscardRule());
	});

	it.each([
		["git merge --e side", "--edit in a merge, not rebase's --edit-todo"],
		["git merge --edit side", "a whole name that begins a longer one"],
		["git merge --mess --abort side", "--abort is --message's value"],
		["git pull --reb", "--rebase"],
	])("%s is refused with the pull rule — %s", (command) => {
		expect(readDenyReason(command)).toContain(readPullRule());
	});

	it.each([
		["git merge --ab", "--abort"],
		["git merge --ff-o side", "--ff-only"],
		["git rebase --ed", "--edit-todo, rebase's own"],
		["git rebase --sk", "--skip"],
		["git pull --ff-o", "--ff-only"],
		["git branch --lis main", "--list writes nothing"],
		["git branch --forc --cont main side", "main is --contains's value"],
		["git branch --co main", "ambiguous, which git refuses"],
		["git restore --sta .", "--staged writes only the index"],
		["git clean --d", "--dry-run deletes nothing"],
		["git reset --he", "no option, which git refuses"],
	])("%s passes — %s", (command) => {
		expect(verdict(command)).not.toBe("deny");
	});
});

describe("a --no- form clears what it negates, as git's last-one-wins does (#4008)", () => {
	it.each([
		["git branch --copy --no-copy --force main HEAD~1", "forced, not copied"],
		["git branch --cop --no-cop --forc main HEAD~1", "the same, abbreviated"],
		["git branch -d --no-delete -f main HEAD~1", "forced, not deleted"],
		["git branch -m --no-move -f main HEAD~1", "forced, not renamed"],
		["git branch -D --no-delete main", "-D has no negation: it deletes"],
		["git branch -d --end-of-options main --no-delete", "the last is a name"],
		["git branch -M --no-move side main", "-M has no negation: it renames"],
		["git branch -C --no-copy side main", "-C has no negation: it copies"],
		["git branch --move -d --no-delete side main", "--move still stands"],
		["git branch -f --no-force -f main HEAD~1", "the last one wins"],
		["git switch --no-force-create -C main side", "the last one wins"],
		[
			"git update-ref --stdin --no-stdin refs/heads/main HEAD~1",
			"a named ref is written",
		],
		["git reset -p --no-patch HEAD~1", "a commit, no paths left"],
		[
			"git reset --pathspec-from-file=f --no-pathspec-from-file HEAD~1",
			"moves",
		],
	])("%s is refused with the rewind rule — %s", (command) => {
		expect(readDenyReason(command)).toContain(readRewindRule());
	});

	it.each([
		["git clean --dry-run --no-dry-run -f", "forced, no dry run left"],
		["git clean -n --no-dry -f", "the same, abbreviated"],
		["git clean -f --no-interactive", "-f still stands"],
		["git clean -i --no-force", "-i still stands"],
		["git switch -f --no-discard-changes side", "-f still stands"],
		["git switch --discard-changes --no-force side", "still forced"],
		["git checkout --no-force -f side", "the last one wins"],
		["git restore --staged --no-staged --worktree .", "--worktree alone"],
		[
			"git restore --pathspec-from-file=f --no-pathspec-from-file .",
			"no file left, the . overwrites",
		],
		["git reset --patch --no-patch --hard", "no patch left, --hard discards"],
		["git restore --staged --no-staged .", "no --staged left: the tree's own"],
		["git clean -f --end-of-options . --no-force", "the last is a path"],
		["git clean -f --end-of-options -n .", "the -n is a path"],
		[
			"git stash push --pathspec-from-file=f --no-pathspec-from-file",
			"no file left, a bare stash",
		],
	])("%s is refused with the discard rule — %s", (command) => {
		expect(readDenyReason(command)).toContain(readDiscardRule());
	});

	it.each([
		["git merge --ab --no-ab side", "nothing left to resume, so it merges"],
		[
			"git merge --abort --no-abort side",
			"nothing left to resume, so it merges",
		],
		["git merge --quit --no-quit side", "nothing left to resume, so it merges"],
		[
			"git merge --continue --no-continue side",
			"nothing left to resume, so it merges",
		],
		[
			"git pull --rebase --server-option --no-rebase --server-option --ff-only",
			"both are values: it rebases",
		],
		[
			"git pull --no-rebase --no-edit --server-option --ff-only",
			"the --ff-only is a value: it merges",
		],
		["git merge --end-of-options --abort --no-abort side", "not a resume"],
		["git pull --rebase --no-rebase --no-ff", "a merge commit"],
	])("%s is refused with the pull rule — %s", (command) => {
		expect(readDenyReason(command)).toContain(readPullRule());
	});

	it.each([
		["git branch -f --no-force main HEAD~1", "git refuses: main exists"],
		["git branch -d --no-delete main", "no delete left: a create git refuses"],
		["git branch -c --no-copy side main", "no copy left: a create git refuses"],
		["git branch -m --no-move side main", "no rename left: a create"],
		["git switch -C main --no-force-create side", "main stays where it is"],
		["git clean -f --no-force", "git refuses unforced"],
		["git clean -i --no-interactive", "git refuses unforced"],
		["git checkout -f --no-force side", "keeps the edits or refuses"],
		["git switch -f --no-force side", "keeps the edits or refuses"],
		[
			"git switch --discard-changes --no-discard-changes side",
			"keeps the edits or refuses",
		],
		["git restore --staged --worktree --no-worktree .", "the index alone"],
		["git merge --abort --no-quit", "--abort still stands"],
		["git pull --rebase --no-rebase --ff-only", "fast-forward only"],
		["git pull -r --rebase=false --ff-only", "fast-forward only"],
		["git pull -r --rebase=OFF --ff-only", "git's own spelling of false"],
		["git pull -r --rebase= --ff-only", "an empty value is false"],
		["git symbolic-ref --delete --no-delete HEAD", "a read"],
	])("%s passes — %s", (command) => {
		expect(verdict(command)).not.toBe("deny");
	});

	it("reads --no-ignore-other-worktrees as git's own refusal back in force", () => {
		const command = (flags: string) => `git checkout ${flags} -B "$X" HEAD~1`;
		expect(
			verdict(command("--ignore-other-worktrees --no-ignore-other-worktrees"), {
				cwd: LINKED,
			}),
		).toBe("allow");
		expect(
			verdict(command("--no-ignore-other-worktrees --ignore-other-worktrees"), {
				cwd: LINKED,
			}),
		).toBe("deny");
	});
});

/* /repo/sub gives a pathspec somewhere to climb out of. */
describe("discarding the shared tree's uncommitted work is refused (#768)", () => {
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
		"git -C sub restore ':(top)'",
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
		"git restore ':/*'",
		"git restore /repo",
		"git restore '/repo/*'",
		"git checkout --pathspec-from-file=list",
		"git stash push --pathspec-from-file=list",
		"git stash push --pathspec-from-file",
		"git stash $V",
	])("%s is refused with the discard rule", (command) => {
		expect(readDenyReason(command)).toContain(readDiscardRule());
	});

	it.each([
		["git reset --hard", "git restore --staged --worktree -- <your paths>"],
		["git checkout .", "git checkout -- <your paths>"],
		["git restore .", "git restore -- <your paths>"],
		["git clean -fd", "git clean -f -- <your paths>"],
		["git stash", "git stash push -- <your paths>"],
	])("the refusal of %s names the per-path form %s", (command, safe) => {
		const reason = readDenyReason(command);
		expect(reason).toContain(`Name your own paths instead — \`${safe}\``);
		expect(reason).toContain(command);
	});

	it.each([
		[
			"git reset --hard",
			"resets every working file in the shared tree to HEAD",
			"git restore --staged --worktree -- <your paths>",
		],
		[
			"git checkout .",
			"overwrites every working file in the shared tree",
			"git checkout -- <your paths>",
		],
		[
			"git checkout -f",
			"forces the shared tree onto a branch, dropping every uncommitted edit",
			"git restore -- <your paths>",
		],
		[
			"git switch --discard-changes main",
			"forces the shared tree onto a branch, dropping every uncommitted edit",
			"git restore -- <your paths>",
		],
		[
			"git restore .",
			"overwrites every working file in the shared tree",
			"git restore -- <your paths>",
		],
		[
			"git clean -fd",
			"deletes every untracked file in the shared tree",
			"git clean -f -- <your paths>",
		],
		[
			"git stash",
			"stashes every uncommitted edit in the shared tree",
			"git stash push -- <your paths>",
		],
		[
			"git stash save wip",
			"stashes every uncommitted edit in the shared tree",
			"git stash push -- <your paths>",
		],
		[
			"git stash $V",
			"runs a stash command I cannot read, which could stash every edit in the shared tree",
			"git stash push -- <your paths>",
		],
		[
			"git clean $X",
			"carries a word I cannot read, which could be an option or pathspec that discards every edit in the shared tree",
			"git clean -f -- <your paths>",
		],
	])("%s is framed in full", (command, what, safe) => {
		expect(readDenyReason(command)).toBe(
			`This ${what}: ${command}\n\nName your own paths instead — \`${safe}\`.\n\n${readDiscardRule()}`,
		);
	});

	it("carries the discard fallback where the store cannot give the rule", () => {
		expect(readDenyReason("git stash", { storeFault: true })).toContain(
			"Never discard work across the whole shared tree; the rule could not be read from docs/agents/rules/shared-tree-discard.txt. Read that file before doing anything else.",
		);
	});

	it.each([
		"git restore --staged .",
		"git restore -S .",
		"git restore -- a.md",
		"git restore -- a.md ':!b.md'",
		"git restore ':(exclude)a.md' b.md",
		"git checkout -- a.md",
		"git checkout HEAD -- a.md",
		"git checkout -f -- a.md",
		"git checkout -f a.md",
		"git checkout -p a.md",
		"git checkout main a.md",
		"git clean -f -- tmp/x",
		"git clean -n",
		"git clean -nfd",
		"git clean --dry-run -f",
		"git clean -d",
		"git stash list",
		"git stash pop",
		"git stash show -p",
		"git stash drop",
		"git stash push -- some/file.ts",
		"git stash push -m wip -- a.md",
		"git stash -- a.md",
		"git stash save --help",
		"git reset",
		"git reset --soft",
		"git -C sub restore .",
		"git -C sub clean -f",
		"git restore 'sub/a*'",
		"git -C sub restore '..*'",
		"git restore 'sub/*.ts'",
		"git restore /repo/sub",
		"git restore /elsewhere/a.md",
		"git checkout main -- a.md",
		"git reset HEAD -- a.md",
		"git restore --help",
		"git switch main",
		"echo git clean -fdx",
	])("%s passes", (command) => {
		expect(verdict(command)).toBe("allow");
	});

	it("git clean -d is refused where the repo lifts clean.requireForce, with the shared-tree discard rule", () => {
		expect(readDenyReason("git clean -d", { requireForce: "false" })).toContain(
			readDiscardRule(),
		);
		expect(verdict("git clean -d", { requireForce: "true" })).toBe("allow");
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
		expect(verdict(command, { cwd: LINKED })).toBe("allow");
	});

	it.each([
		'git -C "$VAR" reset --hard',
		'git -C "$VAR" restore .',
		'git -C "$VAR" clean -f',
		'git -C "$VAR" clean -d',
		'git -C "$VAR" stash',
		'git -C "$VAR" restore -- ../a.md',
		'git -C "$VAR" restore /abs',
		'git -C "$VAR" checkout -f main',
	])(
		"%s is refused with the shared-tree discard rule: the tree it lands in is unknown",
		(command) => {
			expect(readDenyReason(command)).toContain(readDiscardRule());
		},
	);

	it('git -C "$VAR" restore -- a.md passes: a named path is safe in any tree', () => {
		expect(verdict('git -C "$VAR" restore -- a.md')).toBe("allow");
	});

	it("an unrelated repository is left alone", () => {
		expect(verdict("git reset --hard", { cwd: ELSEWHERE })).toBe("allow");
		expect(verdict("git clean -fdx", { cwd: ELSEWHERE })).toBe("allow");
	});
});

describe("the walks run in the bash guard's order, the first refusal winning", () => {
	it("a reset refusal outranks a reconciliation earlier in the command", () => {
		expect(
			readDenyReason("git merge origin/main && git reset --hard HEAD~1"),
		).toContain(readRewindRule());
	});

	it("a ref write outranks a discard, and a discard a reconciliation", () => {
		expect(readDenyReason("git restore . && git branch -D main")).toContain(
			readRewindRule(),
		);
		expect(readDenyReason("git pull --rebase && git restore .")).toContain(
			readDiscardRule(),
		);
	});

	it("within one walk, the first refused segment is the one echoed", () => {
		const reason = readDenyReason("git pull --no-ff && git pull --rebase");
		expect(reason).toContain("fast-forward: git pull --no-ff");
		expect(reason).not.toContain(": git pull --rebase");
	});

	it("an allowed reconciliation beside a refused one hands no rule", () => {
		expect(run("git pull --ff-only && git reset --hard HEAD~1")).toHaveProperty(
			"deny",
		);
	});
});

const OTHER_REPO = "/other";
const MAIN_WRITE = "update-ref refs/heads/main HEAD~1";

describe("a subcommand, wrapper and tree are judged as what they reach (#4009)", () => {
	it.each([
		[`git 'update-ref' refs/heads/main HEAD~1`, "quoted"],
		['git up"date-ref" refs/heads/main HEAD~1', "part quoted"],
		["git up\\date-ref refs/heads/main HEAD~1", "escaped"],
		[`git --attr-source HEAD ${MAIN_WRITE}`, "--attr-source apart"],
		[`git --attr-source=HEAD ${MAIN_WRITE}`, "--attr-source stuck on"],
		[`git --shallow-file HEAD ${MAIN_WRITE}`, "--shallow-file"],
		[`git -"c" alias.u=update-ref u refs/heads/main HEAD~1`, "a quoted -c"],
		[`env git ${MAIN_WRITE}`, "env"],
		[`env -u GIT_DIR git ${MAIN_WRITE}`, "env -u"],
		[`timeout 5 git ${MAIN_WRITE}`, "timeout"],
		[`command git ${MAIN_WRITE}`, "command"],
		[`env -S "git ${MAIN_WRITE}"`, "env -S"],
	])("refuses %s (%s)", (command) => {
		expect(readDenyReason(command, { cwd: LINKED })).toContain(
			readRewindRule(),
		);
	});

	it.each([
		[`git "$(echo update-ref)" refs/heads/main HEAD~1`, "a substitution"],
		["git $S refs/heads/main HEAD~1", "a variable"],
		[`git $NOTHING ${MAIN_WRITE}`, "a word that may expand to nothing"],
		[`git "--git-dir=$D" ${MAIN_WRITE}`, "a quoted option it cannot read"],
	])("refuses a subcommand it cannot read: %s (%s)", (command) => {
		expect(readDenyReason(command, { cwd: OTHER_REPO })).toContain(
			"or alias I cannot read",
		);
	});

	it.each([
		[
			`env GIT_DIR=${SHARED}/.git git symbolic-ref HEAD refs/heads/side`,
			"env's GIT_DIR",
		],
		[`env -C ${SHARED} git symbolic-ref HEAD refs/heads/side`, "env -C"],
		[
			`env --chdir=${SHARED} git symbolic-ref HEAD refs/heads/side`,
			"env --chdir=",
		],
		[
			`git "--git-dir=${SHARED}/.git" symbolic-ref HEAD refs/heads/side`,
			"a quoted --git-dir",
		],
		[`git --work-tree=${SHARED} checkout -- .`, "--work-tree"],
		[`git --work"-tree"=${SHARED} checkout -- .`, "part quoted"],
		[
			`git -"C" ${SHARED} symbolic-ref HEAD refs/heads/side`,
			"a part-quoted -C",
		],
		[`git --work-tree ${SHARED} checkout -- .`, "--work-tree apart"],
		[`GIT_WORK_TREE=${SHARED} git checkout -- .`, "GIT_WORK_TREE"],
		[`export GIT_WORK_TREE=${SHARED}; git checkout -- .`, "an exported one"],
		[
			`git --git-dir=/o/.git --work-tree=${SHARED} reset --hard`,
			"both, a reset",
		],
		[`GIT_DIR=/o/.git GIT_WORK_TREE=${SHARED} git clean -fd`, "both, a clean"],
		['git --work-tree="$W" checkout -- .', "one it cannot read"],
	])("refuses from another repo: %s (%s)", (command) => {
		expect(verdict(command, { cwd: OTHER_REPO })).toBe("deny");
	});

	describe("a cd that may not take effect", () => {
		const isThere = (p: string) => p !== "/gone";
		it.each([
			[`false && cd ${OTHER_REPO}; git ${MAIN_WRITE}`, "skipped"],
			[`false || cd ${OTHER_REPO}; git ${MAIN_WRITE}`, "skipped on success"],
			[`cd ${OTHER_REPO} | cat; git ${MAIN_WRITE}`, "in a pipeline"],
			[`true | cd ${OTHER_REPO}; git ${MAIN_WRITE}`, "the pipeline's tail"],
			[`cd ${OTHER_REPO} & git ${MAIN_WRITE}`, "in the background"],
			[`if false; then cd ${OTHER_REPO}; fi; git ${MAIN_WRITE}`, "in a branch"],
			[`cd /gone; git ${MAIN_WRITE}`, "a directory not there"],
			[`cd /gone && true; git ${MAIN_WRITE}`, "past its chain"],
			[`cd /gone || true; git ${MAIN_WRITE}`, "a failure carried on from"],
			[
				`if false; then true; cd ${OTHER_REPO}; fi; git ${MAIN_WRITE}`,
				"deep in a branch",
			],
			[
				`while false; do true; cd ${OTHER_REPO}; done; git ${MAIN_WRITE}`,
				"in a loop",
			],
			[`false && { true; cd ${OTHER_REPO}; }; git ${MAIN_WRITE}`, "in a group"],
			[`case x in y) cd ${OTHER_REPO};; esac; git ${MAIN_WRITE}`, "in a case"],
			[`f() { cd ${OTHER_REPO}; }; git ${MAIN_WRITE}`, "in a function"],
			[`{ cd ${OTHER_REPO}; } | cat; git ${MAIN_WRITE}`, "a piped group"],
			[`cd ${OTHER_REPO} && true & git ${MAIN_WRITE}`, "a backgrounded chain"],
			[`cd ${OTHER_REPO} junk; git ${MAIN_WRITE}`, "too many arguments"],
			[`false && cd ${OTHER_REPO}; git -C . ${MAIN_WRITE}`, "a relative -C"],
			[
				`false && cd ${OTHER_REPO}; env -C . git ${MAIN_WRITE}`,
				"a relative env -C",
			],
		])("%s still judges the tree it left (%s)", (command) => {
			expect(verdict(command, { isDir: isThere })).toBe("deny");
		});

		it.each([
			[`cd ${OTHER_REPO} && git ${MAIN_WRITE}`, "chained"],
			[`cd ${OTHER_REPO}; git ${MAIN_WRITE}`, "there, and always run"],
			[`cd ${OTHER_REPO}\ngit ${MAIN_WRITE}`, "on the next line"],
			[`cd ${OTHER_REPO} &&\n git ${MAIN_WRITE}`, "chained across a line"],
			[`(cd ${OTHER_REPO}; git ${MAIN_WRITE})`, "in a subshell"],
			[`cd ${OTHER_REPO} && (git ${MAIN_WRITE})`, "chained into a subshell"],
			[`cd /gone && git ${MAIN_WRITE}`, "chained, its directory not there"],
			[
				`cd ${OTHER_REPO} && git ${MAIN_WRITE} &`,
				"the chain backgrounded with it",
			],
			[`true && cd ${OTHER_REPO} && git ${MAIN_WRITE}`, "mid-chain"],
			[
				`cd ${OTHER_REPO} && git -C ${OTHER_REPO} ${MAIN_WRITE}`,
				"with its own -C",
			],
			[
				`false && cd /gone; git -C ${OTHER_REPO} ${MAIN_WRITE}`,
				"a -C past a doubt",
			],
		])("%s judges where it lands (%s)", (command) => {
			expect(verdict(command, { isDir: isThere })).toBe("allow");
		});
	});

	describe("config reached from a file", () => {
		const readFileAliases = { u: "update-ref", st: "status", sh: "!x" };
		it.each([
			["git u refs/heads/main HEAD~1", "a config file's alias"],
			["git sh refs/heads/main HEAD~1", "a shell alias"],
			[
				"GIT_CONFIG_KEY_0=alias.u GIT_CONFIG_VALUE_0=status git u refs/heads/main",
				"a key past the count, which git ignores",
			],
		])("refuses %s (%s)", (command) => {
			expect(verdict(command, { cwd: LINKED, readFileAliases })).toBe("deny");
		});

		it.each([
			["git -c include.path=/f u refs/heads/main", "include.path"],
			["git -c includeIf.x.path=/f u refs/heads/main", "includeIf"],
			["GIT_CONFIG_GLOBAL=/f git u refs/heads/main", "GIT_CONFIG_GLOBAL"],
			["GIT_CONFIG_SYSTEM=/f git u refs/heads/main", "GIT_CONFIG_SYSTEM"],
			["HOME=/h git u refs/heads/main", "HOME"],
			["XDG_CONFIG_HOME=/x git u refs/heads/main", "XDG_CONFIG_HOME"],
			["export HOME=/h; git u refs/heads/main", "an exported HOME"],
			["git config alias.u update-ref; git u refs/heads/main", "written first"],
			[
				"git config --global alias.u update-ref; git u refs/heads/main",
				"--global",
			],
			[
				"git -c alias.c=config c alias.u update-ref; git u refs/heads/main",
				"through an alias",
			],
			[
				"git config --rename-section foo alias; git u refs/heads/main",
				"a section renamed",
			],
			['git config "$K" x; git u refs/heads/main', "an unread key"],
		])("refuses a file it cannot read first: %s (%s)", (command) => {
			expect(readDenyReason(command, { cwd: LINKED })).toContain(
				"or alias I cannot read",
			);
		});

		it.each([
			["git st", "an alias of an unjudged subcommand"],
			["git unknown", "no alias at all"],
			["git -c alias.u=status u refs/heads/main", "-c beats the file"],
			[
				"GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.u GIT_CONFIG_VALUE_0=status git u refs/heads/main",
				"a counted key beats the file",
			],
			["GIT_CONFIG_GLOBAL=/dev/null git unknown", "/dev/null holds no alias"],
			["HOME=/h git status", "a command beats any alias"],
			['git -c "$K" status', "under an unread definition too"],
			["git config user.name x; git unknown", "another key written"],
			['git config user.email "$E"; git unknown', "an unread value"],
			["git config --get alias.u; git unknown", "a read"],
			["mkdir -p x; cd x; git reflog", "a builtin past a cd"],
		])("passes %s (%s)", (command) => {
			expect(verdict(command, { cwd: LINKED, readFileAliases })).toBe("allow");
		});

		it("gives a counted key's value to -c, which beats it (measured)", () => {
			expect(
				verdict(
					"GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0=status git -c alias.x=update-ref x refs/heads/main HEAD~1",
					{ cwd: LINKED },
				),
			).toBe("deny");
			expect(
				verdict(
					"GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0=update-ref git -c alias.x=status x refs/heads/main HEAD~1",
					{ cwd: LINKED },
				),
			).toBe("allow");
		});

		it("refuses a word it cannot tell where git would not say what its config holds", () => {
			expect(
				readDenyReason("git u refs/heads/main", {
					cwd: LINKED,
					readFileAliases: null,
				}),
			).toContain("or alias I cannot read");
			expect(verdict("git status", { readFileAliases: null })).toBe("allow");
		});

		it("reads a bare HOME= as a move and a mention of it as none", () => {
			expect(verdict("HOME=/h; git u refs/heads/main", { cwd: LINKED })).toBe(
				"deny",
			);
			expect(verdict("ls $HOME; git unknown", { cwd: LINKED })).toBe("allow");
		});

		it("reads no one tree's aliases where a cd may not have taken effect", () => {
			expect(
				readDenyReason(`false && cd ${OTHER_REPO}; git u refs/heads/main`),
			).toContain("or alias I cannot read");
		});

		it("judges a builtin under a definition nothing can read", () => {
			expect(readDenyReason('git -c "$K" reset --hard HEAD~1')).toContain(
				readRewindRule(),
			);
			expect(verdict('git -c "$K" reset --soft HEAD')).toBe("allow");
		});

		it("reads the config of the tree the command names", () => {
			const seen: string[] = [];
			const { ctx } = harness();
			decide(`git -C ${LINKED} unknown`, {
				...ctx,
				readFileAliases: (dir: string) => {
					seen.push(dir);
					return new Map();
				},
			});
			expect(new Set(seen)).toEqual(new Set([LINKED]));
			expect(seen).toHaveLength(1);
		});

		it("reads no config for a command every session runs", () => {
			const { ctx } = harness();
			const refuseRead = () => {
				throw new Error("read");
			};
			expect(
				decide("git status", { ...ctx, readFileAliases: refuseRead }),
			).toBeNull();
		});
	});
});
