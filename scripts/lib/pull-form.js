/*
 * pull-form.js — the guard-pull-form core (#2797, #3226): divergence on the
 * shared `main` is reconciled by fast-forward or not at all, `main` is never
 * moved backwards (#765), and the shared tree's uncommitted work is never
 * discarded wholesale (#768).
 *
 * Why: the working tree is repo-global, so a `git pull`, `git merge` or `git
 * rebase` that does anything but fast-forward rewrites or re-parents commits
 * every parallel session can already be holding. On mantahostels#245 a `git
 * pull --rebase` rebased and re-picked a commit in the shared tree — the
 * failure of mantahostels#63 (one session's roadmap correction landing inside
 * another's commit) and mantahostels#87 (the wrong-branch commit), reached
 * through the one shared resource those guards do not cover: the ref.
 * `--ff-only` is the only spelling that cannot rewrite a neighbour's commit.
 *
 * DENIES, not warns: mantahostels#103 set deny on a structured fact where the
 * action has no legitimate use. Every legitimate reconciliation has a route
 * that passes — `--ff-only`, a repo configured `pull.ff=only`, or, for a
 * divergence that needs a real merge, the throwaway worktree the rule's own
 * recipe gives (#290) — so a deny cannot wedge ordinary work.
 *
 * LIMITS
 *  - The rule it prints is docs/agents/rules/pull-fast-forward.txt
 *    (mantahostels#1648), or its `-landing` twin with the `landing` module on
 *    (#2409). It prints it on two exclusive limbs (spec mantahostels#1762):
 *    inside the refusal, and, where nothing was refused, as context before an
 *    allowed `git pull --ff-only`, a bare pull the repo's `pull.ff=only` has
 *    already made safe, `git merge --ff-only`, or a bare pull whose tree could
 *    not be resolved (#308) — latched once a session. `git pull --help` and a
 *    merge or rebase being finished or unwound are handed nothing.
 *  - It guards `git pull`, `git merge` and `git rebase`. `git fetch` is always
 *    safe — it moves no local ref. The rewrite reached directly after a fetch,
 *    as `git merge origin/main` or `git rebase origin/main`, is denied
 *    (mantahostels#245, #290): a diverged session reconciles in a throwaway
 *    worktree and fast-forwards the shared tree onto the result.
 *  - It also refuses REWINDING `main` (#765), docs/agents/rules/main-rewind.txt:
 *    a `git reset` naming a commit other than HEAD in the shared tree, and —
 *    from ANY tree of the repo, `main` being one ref for all of them — `git
 *    update-ref refs/heads/main`, `git branch` forcing, deleting, renaming or
 *    copying onto `main`, and `git checkout -B main`/`git switch -C main`. A
 *    reset FORWARD is refused too: the guard never compares the commit with
 *    `main`, and the refusal names `git merge --ff-only` for that case. `git
 *    branch -f`/`-D`/`-M` and `checkout -B` naming `main` are refused by git
 *    itself while any tree has it checked out, so in a linked worktree a
 *    branch word it cannot read passes on those — unless
 *    `--ignore-other-worktrees` lifts git's own refusal. `git update-ref HEAD`
 *    is refused in the shared tree only, and `--stdin` everywhere, because
 *    what it updates is unread. Pathspec resets pass, as does a `git reset
 *    --soft` or `--mixed` naming HEAD or nothing. Still unseen: `git fetch
 *    --update-head-ok . +<commit>:main`, `git symbolic-ref`, `git cherry-pick`
 *    and `git am` (which add commits rather than drop them), and `git revert`,
 *    which the pre-commit stack gates. Any other unreadable commit, ref or
 *    branch word, or an unresolved tree where the verdict needs one, FAILS
 *    CLOSED (#301).
 *  - It also refuses DISCARDING the shared tree's uncommitted work (#768),
 *    docs/agents/rules/shared-tree-discard.txt: in the shared tree only, a
 *    `git reset --hard`/`--merge`/`--keep` naming HEAD, the checked-out
 *    branch or nothing; a `git checkout` or `git restore` whose pathspec
 *    covers the whole tree, or is file-fed; a forced `git clean` naming no
 *    path or the whole tree, or an unforced one where `clean.requireForce` is
 *    false or `-i` is spelled; a `git stash` push or save naming no path or
 *    the whole tree; and a forced `git checkout`/`git switch` onto a branch. A
 *    pathspec covers the whole tree when it resolves to the root or above —
 *    `.` from the top, `..` from a subdirectory, `:/`, `:`, `:(top)`, `*`,
 *    `**\/*.md` — or is excludes alone; a bare `-p` covers it too. A glob
 *    after a partial name (`src/a*`) and a directory short of the root pass,
 *    though each can discard a neighbour's edits under it. `git restore
 *    --staged` without `--worktree` writes only the index, and passes. `git
 *    reset --keep` naming HEAD discards nothing (measured on git 2.43.0) and
 *    is refused anyway. A word before `--` it cannot read, or an unresolved
 *    tree under a whole-tree form, FAILS CLOSED; a named path passes in any
 *    tree. `git -c clean.requireForce=false clean` passes: the parser consumes
 *    git's own `-c` before the guard reads the arguments.
 *  - What passes on `git merge` and `git rebase`: `git merge --ff-only`, the
 *    worktree recipe's own last step, and `--abort`, `--continue`, `--quit`,
 *    `--skip`, `--edit-todo` and `--show-current-patch`, which finish or
 *    unwind something already under way; refusing those would strand a tree
 *    mid-merge. A rebase has no fast-forward-only spelling, so `--ff-only`
 *    excuses nothing there, and `pull.ff=only` is not consulted for either.
 *  - A bundled `-r` IS read: `pull.ff=only` does not stop an explicit
 *    `--rebase` (measured on git 2.43.0), so `git pull -qr` under that config
 *    would otherwise take the config exception and rewrite the shared tree.
 *    `pull.ff=only` does beat a configured `pull.rebase=true`, which is what
 *    makes the exception sound for a bare pull.
 *  - `git pull --ff-only -s -r` is ALLOWED: a value-taking short option takes
 *    the next word even when it begins with `-`, as git does (`git merge -s
 *    -r` answers "Could not find merge strategy '-r'", measured on git
 *    2.43.0), so the `-r` is a strategy name and git refuses the command.
 *  - `git -c pull.ff=only pull` is denied, a false deny: the parser consumes
 *    git's global `-c`, so the probe reads repo config only. Left alone —
 *    spelling `--ff-only` is shorter.
 *  - It matches the PARSED command form — a segment whose first word is `git`
 *    and whose subcommand is one it judges — never a substring, so a grep, an
 *    echo or a heredoc mentioning `git pull` passes.
 *  - It FAILS OPEN on a tree git cannot answer for, RECORDED
 *    (mantahostels#147) for check-guard-errors.js under `npm run status`.
 *    THE UNRESOLVED TARGET TREE IS NOT AMONG THEM FOR `merge` AND `rebase`
 *    (#301): an unexpanded `-C`, or a `cd` to a path the parser cannot expand,
 *    is DENIED on those two, since the shared tree is one of the candidates.
 *    `git pull` is judged on its flags alone (#308), and only a bare pull —
 *    whose verdict hangs on the tree's `pull.ff` — keeps the fail-open and its
 *    record. A LITERALLY empty `-C` or `cd` is not this case: git and bash
 *    both stay in the cwd, and the command is judged where it lands. The
 *    `pull.ff` probe fails CLOSED: an unreadable config withholds the
 *    exception. A store fault fails CLOSED too: the refusal carries the rule's
 *    fallback sentence (mantahostels#1648), and an injection the store cannot
 *    give refuses through the dispatcher.
 *  - A pull, merge or rebase reached through a wrapper is not seen, because
 *    only a segment's own first word is read — `xargs git pull`, `env`,
 *    `sudo`, `timeout 5 git pull --rebase` and `sh -c "git pull --rebase"`
 *    (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/hook-if-bash-matching.md §1).
 *  - Its lib/guard-cores.json row narrows it to `Bash(git *)`
 *    (mantahostels#2127) — not loaded unless some segment of the command
 *    leads with `git`.
 *  - It guards the Bash tool. A command run outside Claude Code sees no hook,
 *    and there is no override: this binds agent sessions only, and an escape
 *    a session can spell for itself is not a deny (mantahostels#109).
 *
 * NO I/O OF ITS OWN (§T7): every git read, the rule store, the pushed ref and
 * the plugin-root path rewrite arrive as ports, so each verdict is reached in
 * process. It answers a Decision: a refusal's complete text, the pull rule to
 * hand over, or nothing.
 *
 * FOUR WALKS, IN THIS ORDER, THE FIRST REFUSAL WINNING: the reset (shared
 * tree), the ref write (any tree of the repo), the discard (shared tree) and
 * the reconciliation (shared tree). Each is STRICT (#301, #311): an
 * unresolved tree reaches its judge as "" rather than being skipped, and the
 * judge owns both the verdict and any fail-open record.
 *
 * THE FRAMING STRINGS ARE KEYED: scripts/guard-fire-needles.json counts a
 * refusal by its framing and its rule fallback, so reword one there too. The
 * rewind refusal's framing and fallback are lib/main-rewind.js's, which
 * lib/branch-publish.js shares.
 */

const { rewindReason } = require("./main-rewind.js");
const { ruleModule, ruleUnlessModule } = require("./rule-gates.js");
const { denyText, ruleOrFallback } = require("./guard-verdict.js");
const { normAbs, parseCommand, walkGit } = require("./shell-parse.js");
const { gitValueFlags, literal, scanFlags } = require("./shell-words.js");
const { trimEndRun } = require("./trim-run.js");

/**
 * @typedef {object} PullFormPorts
 * @property {(dir: string) => string} pullFf `git config --get pull.ff`; ""
 *   where git errors or times out
 * @property {(dir: string) => string} cleanRequireForce `git config
 *   --type=bool --get clean.requireForce`; "" where git errors
 * @property {(dir: string) => string} currentBranch the checked-out branch's
 *   short name; "" where HEAD is detached or git errors
 * @property {(dir: string, word: string) => boolean} isCommit whether `word`
 *   names a commit there
 * @property {(dir: string, word: string) => boolean} isTree whether `word`
 *   names a tree-ish there
 * @property {(dir: string) => string} topLevel the tree's root; "" where git
 *   errors
 * @property {(dir: string) => string} showPrefix the directory below the
 *   root, `/`-terminated; "" at the root or where git errors
 * @property {() => string} pushedRef the remote ref sessions push to, read on
 *   a refusal alone, so an allowed call reads no config (#2536)
 * @typedef {import("./kit-context.js").KitContext & PullFormPorts}
 *   PullFormContext
 * @typedef {import("./shell-parse.js").GitCall} GitCall
 * @typedef {{ reason: string, segment: string }} Refusal the reason before
 *   the splice, and the segment, masked
 * @typedef {object} Judging what every judge reads
 * @property {PullFormContext} ctx
 * @property {(word: string) => string | null} known a word's text, null
 *   where any of it is unreadable
 * @property {(word: string) => ReturnType<typeof literal>} read a word, read
 * @property {(dir: string) => ReturnType<PullFormContext["treeClass"]>}
 *   treeClass the walk's, memoised
 * @property {() => void} subject marks a reconciliation the rule is about
 */

/* git pull's value-taking short options, read by the shared flag scan
 * (mantahostels#477), which walks a bundle letter by letter: `git pull -qr`
 * is -q then -r, a rebase, while the r inside `-Xtheirs` is that option's
 * value. -S and -j take a value only stuck on, so `git pull -j --rebase` is
 * still a rebase (#302). The long options are deliberately not listed: the
 * scan would take the next word as their value, and `git pull --strategy
 * --rebase` would stop being a rebase this guard can see. */
const PULL_VALUE_FLAGS = "-s -X -S? -j? -o";

/* The value-taking options of `git checkout` and `git switch`, read by both
 * the rewind and the discard judges; one left out makes its value read as a
 * branch or a path. */
const CHECKOUT_VALUE_FLAGS = "-b -B --orphan --conflict --pathspec-from-file";
const SWITCH_VALUE_FLAGS = "-c -C --create --force-create --orphan --conflict";

/** @type {Record<string, string>} */
const REF_VALUE_FLAGS = {
	branch:
		"-u --set-upstream-to --contains --no-contains --merged --no-merged --points-at --format --sort",
	"update-ref": "-m",
	checkout: CHECKOUT_VALUE_FLAGS,
	switch: SWITCH_VALUE_FLAGS,
};

/** Each discarding subcommand's per-path form and value-taking options. */
/** @type {Record<string, { safe: string, spec: string }>} */
const DISCARD = {
	checkout: {
		safe: "git checkout -- <your paths>",
		spec: CHECKOUT_VALUE_FLAGS,
	},
	switch: { safe: "git restore -- <your paths>", spec: SWITCH_VALUE_FLAGS },
	restore: {
		safe: "git restore -- <your paths>",
		spec: "-s --source --conflict --pathspec-from-file",
	},
	clean: { safe: "git clean -f -- <your paths>", spec: "-e --exclude" },
	stash: {
		safe: "git stash push -- <your paths>",
		spec: "-m --message --pathspec-from-file",
	},
};

/**
 * @template S
 * @typedef {Record<string, Partial<S> | ((value: string, state: S) => Partial<S>)>}
 *   ArgTable each `<kind>:<name>` the scan answers, and what it sets
 */

/**
 * One command's arguments read into `state` off `table`. `--help` and `-h`
 * set `helping` and stop the scan; a bare word goes to `onArg`.
 * @template {{ helping: boolean }} S
 * @param {string[]} args
 * @param {{ spec: string, table: ArgTable<S>, state: S,
 *   onArg?: (value: string, state: S) => void }} how accumulator: `state`,
 *   which the scan and `onArg` write and which is returned; `spec` is
 *   scanFlags's value-taking flags
 * @returns {S}
 */
function readArgs(args, { spec, table, state, onArg }) {
	scanFlags(spec, args, (kind, name, value) => {
		const key = `${kind}:${name}`;
		if (key === "flag:--help" || key === "flag:-h") {
			state.helping = true;
			return false;
		}
		const patch = table[key];
		if (patch)
			Object.assign(
				state,
				typeof patch === "function" ? patch(value, state) : patch,
			);
		else if (kind === "arg") onArg?.(value, state);
		return true;
	});
	return state;
}

/** @param {PullFormContext} ctx */
const pullRule = (ctx) =>
	ctx.moduleOn("landing")
		? ruleOrFallback(
				ctx,
				"pull-fast-forward-landing",
				"Reconcile the shared `main` with `landing` by fast-forward or not at all",
			)
		: ruleOrFallback(
				ctx,
				"pull-fast-forward",
				"Reconcile the shared `main` by fast-forward or not at all",
			);

/** @param {PullFormContext} ctx */
const discardRule = (ctx) =>
	ruleOrFallback(
		ctx,
		"shared-tree-discard",
		"Never discard work across the whole shared tree",
	);

/**
 * The rewind refusal, framed by lib/main-rewind.js.
 * @param {Judging} j
 * @param {string} segment
 * @param {string} what completing "This …"
 * @returns {Refusal}
 */
const rewindDeny = (j, segment, what) => ({
	reason: rewindReason(j.ctx, what),
	segment,
});

/**
 * @param {Judging} j
 * @param {string} segment
 * @param {string} what completing "This …"
 * @param {string} safe the per-path form
 * @returns {Refusal}
 */
const discardDeny = (j, segment, what, safe) => ({
	reason: `This ${what}: @CMD@\n\nName your own paths instead — \`${safe}\`.\n\n${discardRule(j.ctx)}`,
	segment,
});

/** @param {Judging} j @param {string} segment */
const resetDiscardDeny = (j, segment) =>
	discardDeny(
		j,
		segment,
		"resets every working file in the shared tree to HEAD",
		"git restore --staged --worktree -- <your paths>",
	);

// ── REWINDING `main` (#765) ──────────────────────────────────────────────

/**
 * @typedef {{ helping: boolean, pathspec: boolean, ddash: boolean,
 *   discarding: boolean }} ResetArgs
 */

/** @type {ArgTable<ResetArgs>} */
const RESET_ARGS = {
	/* git takes the last mode spelled. */
	"flag:--hard": { discarding: true },
	"flag:--merge": { discarding: true },
	"flag:--keep": { discarding: true },
	"flag:--soft": { discarding: false },
	"flag:--mixed": { discarding: false },
	/* Interactive or file-fed paths: an unstage whatever commit it names. */
	"flag:-p": { pathspec: true },
	"flag:--patch": { pathspec: true },
	"opt:--pathspec-from-file": { pathspec: true },
	"flag:--": { ddash: true },
};

/**
 * A `git reset` in the shared tree, or an unresolved one. It moves the
 * checked-out branch, which here is `main`, to the ONE commit it names; a
 * reset with paths only unstages them. `git reset HEAD~1 --`, a commit with
 * no paths after the `--`, moves the branch (measured).
 * @param {Judging} j
 * @param {GitCall} call
 * @returns {Refusal | null}
 */
function judgeReset(j, { segment, tree, args }) {
	/** @type {string[]} */
	const positional = [];
	const a = readArgs(args, {
		spec: "--pathspec-from-file",
		table: RESET_ARGS,
		state: { helping: false, pathspec: false, ddash: false, discarding: false },
		onArg: (w, s) => {
			/* A word after `--` is a path. */
			if (s.ddash) s.pathspec = true;
			else positional.push(w);
		},
	});
	/* git refuses `--hard`, `--merge` and `--keep` with paths. */
	if (a.helping || a.pathspec) return null;
	const discard = () => (a.discarding ? resetDiscardDeny(j, segment) : null);
	const [first, ...more] = positional;
	/* None names HEAD, which moves no branch but can still discard. */
	if (first === undefined) return discard();
	/* Two or more are a tree-ish and paths, where a word I cannot read could
	 * be `--hard`. */
	if (more.length > 0)
		return positional.some((w) => j.known(w) === null)
			? resetDiscardDeny(j, segment)
			: null;
	const commit = j.known(first);
	if (commit === null)
		return rewindDeny(
			j,
			segment,
			"resets the shared tree to a commit I cannot read — spell it literally, or use `git reset -- <path>` to unstage",
		);
	const lands = resetLands(j, tree, commit, a.ddash);
	if (lands === "here") return discard();
	if (lands === "path") return null;
	return rewindDeny(
		j,
		segment,
		"moves the shared `main` to another commit, dropping whatever came after it if that commit is behind — to move `main` forward, `git merge --ff-only <commit>`",
	);
}

/**
 * Where a one-word reset moves the branch: "here", the commit it is on;
 * "path", no commit at all, which git reads as a path; or "elsewhere".
 * @param {Judging} j
 * @param {string} tree "" where unresolved
 * @param {string} commit
 * @param {boolean} ddash
 * @returns {"here" | "path" | "elsewhere"}
 */
function resetLands(j, tree, commit, ddash) {
	if (isHead(commit)) return "here";
	if (!tree) return "elsewhere";
	const branch = j.ctx.currentBranch(tree);
	if (branch && (commit === branch || commit === `refs/heads/${branch}`))
		return "here";
	/* No `--` and no such commit: git reads the word as a path — unless it is
	 * ancestor steps off a commit, a revision whether or not it resolves
	 * (#3177). Residual: an unresolving `@{1}`, `main@{u}` or `x^{commit}`
	 * still reads as a path, resting on git's own refusal. */
	return ddash ||
		j.ctx.isCommit(tree, commit) ||
		isAncestorStep(j, tree, commit)
		? "elsewhere"
		: "path";
}

/**
 * Is `word` a commit followed by `~N`/`^N` steps, such as `HEAD~5`? A word
 * whose stem is no commit, such as an editor's `a.md~`, stays a path.
 * @param {Judging} j
 * @param {string} tree
 * @param {string} word
 * @returns {boolean}
 */
function isAncestorStep(j, tree, word) {
	const bare = trimEndRun(word, "~^0123456789");
	const step = word.slice(bare.length).search(/[~^]/);
	const stem = step < 0 ? word : word.slice(0, bare.length + step);
	if (stem === word || stem === "") return false;
	return isHead(stem) || j.ctx.isCommit(tree, stem);
}

/** HEAD in either spelling, answered without asking git.
 * @param {string} word
 * @returns {boolean}
 */
const isHead = (word) => word === "HEAD" || word === "@";

/**
 * @typedef {{ helping: boolean, force: boolean, stdin: boolean,
 *   ignoreOther: boolean, mode: "" | "delete" | "move" | "copy",
 *   created: string[] }} RefArgs `created` holds each branch a `-B`/`-C`
 *   recreates
 */

/** @type {ArgTable<RefArgs>} */
const REF_ARGS = {
	"flag:-f": { force: true },
	"flag:--force": { force: true },
	"flag:-d": { mode: "delete" },
	"flag:--delete": { mode: "delete" },
	"flag:-D": { mode: "delete", force: true },
	"flag:-m": { mode: "move" },
	"flag:--move": { mode: "move" },
	"flag:-M": { mode: "move", force: true },
	/* `-c`/`-C` copy under `git branch` and create under `git switch`, whose
	 * force form is an opt below. */
	"flag:-c": { mode: "copy" },
	"flag:--copy": { mode: "copy" },
	"flag:-C": { mode: "copy", force: true },
	"flag:--stdin": { stdin: true },
	"flag:--ignore-other-worktrees": { ignoreOther: true },
	"opt:-B": (v, s) => ({ created: [...s.created, v] }),
	"opt:--force-create": (v, s) => ({ created: [...s.created, v] }),
	"opt:-C": (v, s) => ({ created: [...s.created, v] }),
};

/**
 * @typedef {object} RefCall one ref write, read
 * @property {RefArgs} a
 * @property {string[]} positional
 * @property {string} scope the tree's class; "unknown" where unresolved
 * @property {(word: string | undefined, name: string) => boolean} refIs is
 *   the word, read literally, the name? An unreadable word answers yes where
 *   its readable head begins the name, unless git itself refuses the name
 *   wherever it is unreadable (#3441)
 * @property {(what: string) => Refusal} deny
 */

/**
 * A `git branch`, `git update-ref`, `git checkout` or `git switch` in ANY
 * tree of this repo, or an unresolved one.
 * @param {Judging} j
 * @param {GitCall} call
 * @returns {Refusal | null}
 */
function judgeRef(j, { segment, sub, tree, args }) {
	const scope = tree ? j.treeClass(tree) : "unknown";
	/** @type {string[]} */
	const positional = [];
	const a = readArgs(args, {
		spec: tableEntry(REF_VALUE_FLAGS, sub),
		table: REF_ARGS,
		state: /** @type {RefArgs} */ ({
			helping: false,
			force: false,
			stdin: false,
			ignoreOther: false,
			mode: "",
			created: [],
		}),
		onArg: (w) => positional.push(w),
	});
	if (a.helping) return null;
	/* A branch word in a linked worktree may be read as not-`main`: git
	 * refuses to force, delete or recreate `main` while the shared tree has it
	 * out. Elsewhere an unreadable word could be `main`. */
	const unreadIs = !(
		scope === "linked" &&
		sub !== "update-ref" &&
		!a.ignoreOther
	);
	/** @type {RefCall} */
	const r = {
		a,
		positional,
		scope,
		refIs: (word, name) => {
			if (word === undefined) return false;
			const l = j.read(word);
			/* Only the head reads as the shell would; what follows could be
			 * anything (#3441). */
			if (!l.known) return unreadIs && name.startsWith(l.head);
			return l.head === name;
		},
		deny: (what) => rewindDeny(j, segment, what),
	};
	if (sub === "update-ref") return judgeUpdateRef(r);
	if (sub === "branch") return judgeBranch(r);
	return a.created.some((w) => r.refIs(w, "main"))
		? r.deny(
				"recreates `main` at another commit, dropping whatever came after it",
			)
		: null;
}

/** @param {RefCall} r */
function judgeUpdateRef({ a, positional, scope, refIs, deny }) {
	const first = positional[0];
	if (a.stdin)
		return deny(
			"updates refs from a list I cannot read, `main` possibly among them",
		);
	if (refIs(first, "refs/heads/main"))
		return deny(
			"writes `main` directly, dropping whatever came after the commit it names",
		);
	/* HEAD is `main` only where `main` is checked out; `main-worktree/HEAD`
	 * reaches the shared tree's from any tree. */
	if (
		(scope !== "linked" && refIs(first, "HEAD")) ||
		refIs(first, "main-worktree/HEAD")
	)
		return deny("writes the shared tree's HEAD, and so `main`, directly");
	return null;
}

/** @param {RefCall} r */
function judgeBranch(r) {
	const { a, positional, refIs, deny } = r;
	switch (a.mode) {
		case "delete":
			return positional.some((w) => refIs(w, "main"))
				? deny("deletes `main`")
				: null;
		case "move":
			return judgeBranchMove(r);
		case "copy":
			return refIs(positional.at(-1), "main")
				? deny("replaces `main` with a copy of another branch")
				: null;
		default:
			return a.force && refIs(positional[0], "main")
				? deny(
						"forces `main` to another commit, dropping whatever came after it",
					)
				: null;
	}
}

/** @param {RefCall} r */
function judgeBranchMove({ positional, scope, refIs, deny }) {
	/* A rename or copy ONTO `main` replaces it. */
	if (refIs(positional.at(-1), "main"))
		return deny("replaces `main` with another branch");
	/* `-m <old> <new>` renames `main` away; `-m <new>` renames the tree's own
	 * branch, which in the shared tree is `main`. */
	if (positional.length >= 2)
		return refIs(positional[0], "main") ? deny("renames `main` away") : null;
	return scope === "linked"
		? null
		: deny("renames the shared tree's branch, `main`, away");
}

// ── DISCARDING THE SHARED TREE'S UNCOMMITTED WORK (#768) ─────────────────

/**
 * Does this one pathspec name the whole working tree? "yes", "no", or
 * "exclude", which names nothing on its own. `top` and `prefix` are both
 * empty where the tree is unknown, which reads the cwd as the root, so only a
 * word staying below its own directory passes. An unreadable word is a yes:
 * it could be `.`.
 * @param {string | null} text the word's text, null where unreadable
 * @param {{ top: string, prefix: string }} at
 * @returns {"yes" | "no" | "exclude"}
 */
function coversTree(text, { top, prefix }) {
	if (text === null) return "yes";
	const m = readMagic(text, prefix);
	if (m === null) return "exclude";
	let { w } = m;
	/* A glob starting a path component reaches everything under the directory
	 * before it; one after a partial name matches only that name's paths. */
	const glob = w.search(/[*?[]/);
	if (glob >= 0) {
		w = w.slice(0, glob);
		if (w.endsWith("/")) w = w.slice(0, -1);
		else if (w !== "") return "no";
	}
	if (w === "") w = ".";
	if (w.startsWith("/")) {
		if (!top) return "yes";
		const n = normAbs(w).replace(/\/$/, "");
		return `${top}/`.startsWith(`${n}/`) ? "yes" : "no";
	}
	/* git's own prefix, not a path compare, so a symlinked spelling of the root
	 * still reads as the root. */
	return normAbs(`/q/${m.rel}${w}`).startsWith("/q/") ? "no" : "yes";
}

/**
 * A pathspec's magic, long or short, read off: the rest, and the prefix it
 * is relative to — "" where `top` or `/` anchors it at the root. Null for an
 * exclude.
 * @param {string} text
 * @param {string} prefix
 * @returns {{ w: string, rel: string } | null}
 */
function readMagic(text, prefix) {
	if (text.startsWith(":(") && text.indexOf(")", 2) >= 0) {
		const close = text.indexOf(")");
		const magic = text.slice(0, close);
		if (magic.includes("exclude")) return null;
		return {
			w: text.slice(close + 1),
			rel: magic.includes("top") ? "" : prefix,
		};
	}
	if (!text.startsWith(":")) return { w: text, rel: prefix };
	let w = text.slice(1);
	let rel = prefix;
	while (/^[/!^]/.test(w)) {
		if (!w.startsWith("/")) return null;
		rel = "";
		w = w.slice(1);
	}
	return { w: w.replace(/^:/, ""), rel };
}

/**
 * @typedef {{ helping: boolean, fromfile: boolean, force: boolean,
 *   dryrun: boolean, patch: boolean, staged: boolean, worktree: boolean,
 *   ddash: boolean }} DiscardArgs
 */

/** @type {ArgTable<DiscardArgs>} */
const DISCARD_ARGS = {
	"opt:--pathspec-from-file": { fromfile: true },
	"dangling:--pathspec-from-file": { fromfile: true },
	/* `git clean -i` deletes without `-f`. */
	"flag:-f": { force: true },
	"flag:--force": { force: true },
	"flag:--discard-changes": { force: true },
	"flag:-i": { force: true },
	"flag:--interactive": { force: true },
	"flag:-n": { dryrun: true },
	"flag:--dry-run": { dryrun: true },
	"flag:-p": { patch: true },
	"flag:--patch": { patch: true },
	"flag:-S": { staged: true },
	"flag:--staged": { staged: true },
	"flag:-W": { worktree: true },
	"flag:--worktree": { worktree: true },
	"flag:--": { ddash: true },
};

/** @returns {DiscardArgs} */
const discardArgs = () => ({
	helping: false,
	fromfile: false,
	force: false,
	dryrun: false,
	patch: false,
	staged: false,
	worktree: false,
	ddash: false,
});

/**
 * @typedef {object} DiscardCall one discard, read
 * @property {Judging} j
 * @property {string} tree "" where unresolved
 * @property {DiscardArgs} a
 * @property {string[]} pre the bare words before a `--`
 * @property {string[]} post the words after it
 * @property {(paths: string[]) => boolean} cover isTreeCovered's, here
 * @property {(word: string) => "yes" | "no" | "exclude"} covers coversTree's
 * @typedef {[what: string, form?: string] | null} DiscardVerdict what the
 *   command does, completing "This …", and the per-path form where it is
 *   not the subcommand's own
 */

const OVERWRITES = "overwrites every working file in the shared tree";
const FORCES =
	"forces the shared tree onto a branch, dropping every uncommitted edit";
const STASHES = "stashes every uncommitted edit in the shared tree";

/**
 * A discard that writes every file named, the whole tree among them:
 * file-fed paths, a bare `-p`, or a whole-tree pathspec.
 * @param {DiscardCall} d
 * @param {string[]} paths
 */
const isOverwrite = ({ a, cover }, paths) =>
	a.fromfile || (a.patch && paths.length === 0) || cover(paths);

/** @type {Record<string, (d: DiscardCall) => DiscardVerdict>} */
const DISCARD_VERDICTS = {
	checkout: (d) => {
		const paths = [...checkoutPaths(d), ...d.post];
		if (isOverwrite(d, paths)) return [OVERWRITES];
		/* A forced switch resets every working file to the branch. */
		return d.a.force && paths.length === 0
			? [FORCES, "git restore -- <your paths>"]
			: null;
	},
	switch: ({ a }) => (a.force ? [FORCES] : null),
	/* `--staged` without `--worktree` writes only the index. */
	restore: (d) =>
		!(d.a.staged && !d.a.worktree) && isOverwrite(d, [...d.pre, ...d.post])
			? [OVERWRITES]
			: null,
	clean: (d) =>
		isTreeWipe(d) ? ["deletes every untracked file in the shared tree"] : null,
	stash: ({ a, pre, post, cover }) => {
		const paths = [...pre, ...post];
		return a.fromfile || paths.length === 0 || cover(paths) ? [STASHES] : null;
	},
};

/**
 * A `git checkout`, `git switch`, `git restore`, `git clean` or `git stash`
 * in the shared tree, or an unresolved one. Each can write every working
 * file at once; judged here is whether this spelling does.
 * @param {Judging} j
 * @param {GitCall} call
 * @returns {Refusal | null}
 */
function judgeDiscard(j, { segment, sub, tree, args }) {
	const { safe, spec } = tableEntry(DISCARD, sub);
	/** @param {string} what @param {string} [form] */
	const deny = (what, form = safe) => discardDeny(j, segment, what, form);
	const verb = sub === "stash" ? stashVerb(j, args) : PUSH;
	if (verb === null)
		return deny(
			"runs a stash command I cannot read, which could stash every edit in the shared tree",
		);
	const rest = verb.word ? args.slice(1) : args;
	if (verb.name === "save")
		return readArgs(rest, {
			spec: "-m --message",
			table: DISCARD_ARGS,
			state: discardArgs(),
		}).helping
			? null
			: deny(STASHES);
	if (verb.name !== "push") return null;
	/** @type {string[]} */
	const pre = [];
	/** @type {string[]} */
	const post = [];
	const a = readArgs(rest, {
		spec,
		table: DISCARD_ARGS,
		state: discardArgs(),
		onArg: (w, s) => (s.ddash ? post : pre).push(w),
	});
	if (a.helping) return null;
	/* Before a `--`, a word I cannot read could be `-f`, `-W` or `.` alike. */
	if (pre.some((w) => j.known(w) === null))
		return deny(
			"carries a word I cannot read, which could be an option or pathspec that discards every edit in the shared tree",
		);
	const verdict = tableEntry(
		DISCARD_VERDICTS,
		sub,
	)(discardCall(j, tree, a, { pre, post }));
	return verdict ? deny(...verdict) : null;
}

/** A stash with no command word, or an option first: a push. */
const PUSH = { name: "push", word: false };

/**
 * The stash command a first word names, `word` true where it took one; a
 * first word that is an option, or none, is a push. Null where it cannot be
 * read.
 * @param {Judging} j
 * @param {string[]} args
 * @returns {{ name: string, word: boolean } | null}
 */
function stashVerb(j, args) {
	const head = args[0];
	if (head === undefined || head.startsWith("-")) return PUSH;
	const name = j.known(head);
	return name === null ? null : { name, word: true };
}

/**
 * @param {Judging} j
 * @param {string} tree
 * @param {DiscardArgs} a
 * @param {{ pre: string[], post: string[] }} words
 * @returns {DiscardCall}
 */
function discardCall(j, tree, a, { pre, post }) {
	/* Both empty where the tree is unknown. */
	const at = {
		top: tree ? j.ctx.topLevel(tree) : "",
		prefix: tree ? j.ctx.showPrefix(tree) : "",
	};
	/** @param {string} w */
	const covers = (w) => coversTree(j.known(w), at);
	return {
		j,
		tree,
		a,
		pre,
		post,
		covers,
		cover: (paths) => isTreeCovered(paths, covers),
	};
}

/**
 * A checkout's paths before a `--`: the words less the first where it is a
 * tree-ish — always before a `--`, and without one where it names a tree, as
 * git decides. A whole-tree word is never a tree-ish.
 * @param {DiscardCall} d
 */
function checkoutPaths({ j, tree, a, pre, covers }) {
	const head = pre[0];
	if (head === undefined || covers(head) !== "no") return pre;
	return a.ddash || !tree || j.ctx.isTree(tree, j.known(head) ?? "")
		? pre.slice(1)
		: pre;
}

/**
 * Whether a `git clean` deletes every untracked file. clean.requireForce=false
 * deletes unforced; an unknown tree's config is unreadable, so it counts as
 * forced. With no path it cleans the directory it runs in.
 * @param {DiscardCall} d
 */
function isTreeWipe({ j, tree, a, pre, post, cover }) {
	if (a.dryrun) return false;
	const force = a.force || !tree || j.ctx.cleanRequireForce(tree) === "false";
	const paths = [...pre, ...post];
	return force && cover(paths.length > 0 ? paths : ["."]);
}

/**
 * Does this pathspec list name the whole tree? Any one word naming it does,
 * and so does a list of excludes alone, which git reads as everything but
 * them.
 * @param {string[]} words
 * @param {(word: string) => "yes" | "no" | "exclude"} covers
 */
function isTreeCovered(words, covers) {
	if (words.length === 0) return false;
	let positive = false;
	for (const w of words) {
		const rc = covers(w);
		if (rc === "yes") return true;
		if (rc === "no") positive = true;
	}
	return !positive;
}

// ── RECONCILING THE SHARED `main` (mantahostels#245, #290) ───────────────

/**
 * @typedef {{ helping: boolean, ffOnly: boolean, rebase: boolean,
 *   override: boolean, resuming: boolean }} ReconcileArgs `override` is a
 *   flag that countermands a configured pull.ff=only; `resuming` an
 *   `--abort`, `--continue` and friends
 */

/** @type {ArgTable<ReconcileArgs>} */
const PULL_ARGS = {
	"flag:--ff-only": { ffOnly: true },
	/* These spell "not a rebase": they only countermand a configured
	 * pull.ff=only. `--ff` and `--no-ff` also countermand an earlier
	 * `--ff-only`, git taking the last of the three: `git pull --ff-only
	 * --no-ff` writes a merge commit (measured, #308). */
	"flag:--no-rebase": { override: true },
	"flag:--ff": { override: true, ffOnly: false },
	"flag:--no-ff": { override: true, ffOnly: false },
	"flag:--rebase": { rebase: true },
	"flag:-r": { rebase: true },
	"opt:--rebase": (v) =>
		["false", "no", "0"].includes(v) ? { override: true } : { rebase: true },
};

/** @type {ArgTable<ReconcileArgs>} */
const DIRECT_ARGS = {
	/* A merge that can only fast-forward moves the shared `main` the one way
	 * the rule allows — the recipe's own last step. git takes the LAST of
	 * `--ff-only`, `--ff` and `--no-ff`, as the scan order does. */
	"flag:--ff-only": { ffOnly: true },
	"flag:--ff": { ffOnly: false },
	"flag:--no-ff": { ffOnly: false },
	/* Finishing or unwinding something already under way starts no
	 * reconciliation; refusing it would strand a tree mid-merge. */
	"flag:--abort": { resuming: true },
	"flag:--continue": { resuming: true },
	"flag:--quit": { resuming: true },
	"flag:--skip": { resuming: true },
	"flag:--edit-todo": { resuming: true },
	"flag:--show-current-patch": { resuming: true },
};

/**
 * A `git pull`, `git merge` or `git rebase` against the shared tree, or an
 * unresolved one (#301).
 * @param {Judging} j
 * @param {GitCall} call
 * @returns {Refusal | null}
 */
function judgeReconcile(j, { segment, sub, tree, args }) {
	const pull = sub === "pull";
	const a = readArgs(args, {
		spec: pull ? PULL_VALUE_FLAGS : gitValueFlags(sub),
		table: pull ? PULL_ARGS : DIRECT_ARGS,
		state: {
			helping: false,
			ffOnly: false,
			rebase: false,
			override: false,
			resuming: false,
		},
	});
	if (a.helping || a.resuming) return null;
	/* Every other spelling reconciles the shared `main`, so it is the rule's
	 * subject whether it is refused below or allowed. */
	j.subject();
	/* A merge that can only fast-forward rewrites nothing wherever it lands;
	 * `pull.ff=only` governs `git pull` alone (#290). */
	if (!pull) {
		if (sub === "merge" && a.ffOnly) return null;
		return tree ? reconcileDeny(j, segment) : unresolvedDeny(j, sub, segment);
	}
	if (a.rebase) return reconcileDeny(j, segment);
	if (a.ffOnly) return null;
	if (a.override) return reconcileDeny(j, segment);
	/* Only a bare pull's verdict hangs on the tree, so only it keeps the
	 * fail-open, recorded (#308). A repo configured `pull.ff=only` makes it
	 * fast-forward-only already; an unreadable config withholds that. */
	if (!tree) {
		j.ctx.log(
			"could not resolve the working tree for a git pull — the reconciliation allowed unchecked",
		);
		return null;
	}
	return j.ctx.pullFf(tree) === "only" ? null : reconcileDeny(j, segment);
}

/**
 * @param {Judging} j
 * @param {string} segment
 * @returns {Refusal}
 */
const reconcileDeny = (j, segment) => ({
	reason: `This reconciles the shared \`main\` by rewriting or merging, not by fast-forward: @CMD@\n\n${pullRule(j.ctx)}`,
	segment,
});

/**
 * A merge or rebase onto a tree the walk could not resolve fails CLOSED
 * (#301): it reconciles wherever it lands, the shared tree among the
 * candidates.
 * @param {Judging} j
 * @param {string} sub
 * @param {string} segment
 * @returns {Refusal}
 */
const unresolvedDeny = (j, sub, segment) => ({
	reason: `I cannot tell which working tree this \`git ${sub}\` lands in — an empty or
unexpanded \`-C\`, or a \`cd\` to a path I cannot resolve: @CMD@

An unset variable there is not a different tree — it expands to nothing, and
both \`git -C ""\` and \`cd ""\` stay in the current directory.

Spell the worktree as a LITERAL path in a plain \`cd\` or \`-C\` in the same
command — \`git -C .claude/worktrees/reconcile merge ${j.ctx.pushedRef()}\` — or assign
it literally in the same Bash call, as the recipe below does. A \`pushd\`, a
\`cd -P\` or a \`builtin cd\` is unreadable here whatever path it carries.

${pullRule(j.ctx)}`,
	segment,
});

/**
 * A per-subcommand table's row for `sub`. WALKS hands each judge only the
 * subcommands its tables carry, so a missing row is a broken invariant.
 * @template T
 * @param {Record<string, T>} table
 * @param {string} sub
 * @returns {T}
 */
function tableEntry(table, sub) {
	const row = table[sub];
	if (row === undefined) throw new Error(`no table row for git ${sub}`);
	return row;
}

/**
 * @type {[(j: Judging, call: GitCall) => Refusal | null, string,
 *   "shared" | "repo", string[]][]}
 */
const WALKS = [
	[judgeReset, "the reset", "shared", ["reset"]],
	[
		judgeRef,
		"the ref write",
		"repo",
		["branch", "update-ref", "checkout", "switch"],
	],
	[
		judgeDiscard,
		"the discard",
		"shared",
		["checkout", "switch", "restore", "clean", "stash"],
	],
	[judgeReconcile, "the reconciliation", "shared", ["pull", "merge", "rebase"]],
];

/**
 * @param {string} command
 * @param {PullFormContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const parsed = parseCommand(command);
	/** @type {Map<string, ReturnType<PullFormContext["treeClass"]>>} */
	const classes = new Map();
	let ruleSubject = false;
	/** @type {Judging} */
	const j = {
		ctx,
		known: (word) => {
			const l = literal(word, parsed.spans);
			return l.known ? l.text : null;
		},
		read: (word) => literal(word, parsed.spans),
		/* The walk's tree class, read again by the ref judge: one git answer a
		 * tree. */
		treeClass: (dir) => {
			const cls = classes.get(dir) ?? ctx.treeClass(dir);
			classes.set(dir, cls);
			return cls;
		},
		subject: () => {
			ruleSubject = true;
		},
	};
	for (const [judge, noun, scope, subs] of WALKS) {
		const refused = firstRefusal(parsed, j, judge, { subs, noun, scope });
		if (refused)
			return { deny: denyText(ctx, refused.segment, refused.reason) };
	}

	/* PRE-EMPTIVE INJECTION (mantahostels#1648, spec mantahostels#1762): the
	 * rule handed to a reconciliation nothing refused, as context, so an allow
	 * stays an allow. With `landing` on, the recipe is its twin (#2409). */
	if (!ruleSubject) return null;
	return {
		injectRules: ["pull-fast-forward", "pull-fast-forward-landing"],
		skip: [
			...ruleModule(ctx, "landing", ["pull-fast-forward-landing"]),
			...ruleUnlessModule(ctx, "landing", ["pull-fast-forward"]),
		],
	};
}

/**
 * One strict walk's first refusal; later calls go unjudged.
 * @param {ReturnType<typeof parseCommand>} parsed
 * @param {Judging} j
 * @param {(j: Judging, call: GitCall) => Refusal | null} judge
 * @param {{ subs: string[], noun: string, scope: "shared" | "repo" }} opts
 * @returns {Refusal | null}
 */
function firstRefusal(parsed, j, judge, opts) {
	/** @type {Refusal | null} */
	let refused = null;
	walkGit(
		parsed,
		(call) => {
			refused ??= judge(j, call);
		},
		{ ...j.ctx, treeClass: j.treeClass },
		{ ...opts, strict: true },
	);
	return refused;
}

module.exports = { field: "command", noun: "command", decide };
