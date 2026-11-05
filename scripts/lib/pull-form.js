/*
 * pull-form.js — the guard-pull-form core (#2797, #3226): divergence on the
 * shared `main` is reconciled by fast-forward or not at all, and `main` is
 * never moved backwards (#765).
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
 * WITH THE `landing` MODULE ON, A SESSION RECONCILES IN ITS OWN WORKTREE
 * (#4229), merging `origin/landing` and pushing `HEAD:landing` by
 * `scripts/session-checkout.js land`.
 * Once the main checkout is also cut over (lib/cutover.js) the walk stands
 * down on a tree it resolves: lib/main-checkout-write.js refuses every merge,
 * pull or rebase there, and lib/level-main.js alone moves its `main`. An
 * unresolved tree is still judged, since that guard does not see one. A
 * cutover git cannot read counts as none.
 *
 * LIMITS
 *  - The rule it prints is docs/agents/rules/pull-fast-forward.txt
 *    (mantahostels#1648). It prints it on two exclusive limbs (spec
 *    mantahostels#1762):
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
 *    update-ref refs/heads/main`, `git symbolic-ref` writing or deleting it,
 *    `git branch` forcing, deleting, renaming or copying onto `main`, and `git
 *    checkout -B main`/`git switch -C main`. A
 *    reset FORWARD is refused too: the guard never compares the commit with
 *    `main`, and the refusal names `git merge --ff-only` for that case. `git
 *    branch -f`/`-D`/`-M` and `checkout -B` naming `main` are refused by git
 *    itself while any tree has it checked out, so in a linked worktree a
 *    branch word it cannot read passes on those — unless
 *    `--ignore-other-worktrees` lifts git's own refusal. `git update-ref HEAD`
 *    is refused in the shared tree only, and `--stdin` everywhere, because
 *    what it updates is unread. `git symbolic-ref HEAD` is refused in the shared
 *    tree only, unless it writes `refs/heads/main`, which it is refused
 *    everywhere else, as is any other ref pointed at `main` (#3915): the next
 *    write through that ref moves `main` past git's own refusal. Its read passes
 *    where its one name is readable; an unreadable word, or a name git would
 *    follow as a path or a shell expand as a glob, is refused. A git directory
 *    named by `--git-dir`, `GIT_DIR` or `GIT_COMMON_DIR` adds its tree to the one
 *    the command stands in, as does a work tree named by `--work-tree` or
 *    `GIT_WORK_TREE`, and where a `cd` may not have run or worked, the tree it
 *    left (#4009). An alias, on the command line or in a config file, is judged as
 *    the subcommand it names, and a subcommand or alias it cannot read is refused
 *    (lib/git-alias.js). Pathspec resets pass, as does a
 *    `git reset --soft` or `--mixed` naming HEAD or nothing. Still unseen: `git
 *    fetch --update-head-ok . +<commit>:main`, `git cherry-pick` and `git am`
 *    (which add commits rather than drop them), and `git revert`,
 *    which the pre-commit stack gates. Any other unreadable commit, ref or
 *    branch word, or an unresolved tree where the verdict needs one, FAILS
 *    CLOSED (#301). On a `main` that cannot be read every one of these still
 *    refuses, and its text adds scripts/repair-main.js, the one route (#3198).
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
 *  - A command behind shell-words.js's unwrap wrappers is judged — `env`,
 *    `sudo`, `timeout 5 git pull --rebase` (#4009). Still unseen, each measured
 *    moving `main`: `sh -c "git ..."`, `eval`, arguments an `xargs` reads from
 *    stdin, a dashed `git-update-ref` off `git --exec-path`, a repo's own
 *    `core.worktree`, and an alias written to a config file by other than `git
 *    config` earlier in the same command; so, by the `if` below, a quoted `git`
 *    or one a tab follows; a launcher outside that class, `chrt` and `unshare`
 *    measured; and a quote, `;` or second line inside the string `watch` or `flock -c` runs
 *    (#4046).
 *  - Its lib/guard-cores.json row narrows it to `Bash(*git *)`
 *    (mantahostels#2127, #4009) — not loaded unless the command holds the word,
 *    unanchored because the walk reads past a wrapper.
 *  - It guards the Bash tool. A command run outside Claude Code sees no hook,
 *    and there is no override: this binds agent sessions only, and an escape
 *    a session can spell for itself is not a deny (mantahostels#109).
 *
 * NO I/O OF ITS OWN (§T7): every git read, the rule store, the pushed ref and
 * the plugin-root path rewrite arrive as ports, so each verdict is reached in
 * process. It answers a Decision: a refusal's complete text, the pull rule to
 * hand over, or nothing.
 *
 * FOUR WALKS, IN THIS ORDER, THE FIRST REFUSAL WINNING: the unreadable alias
 * (any tree of the repo), the reset (shared tree), the ref write (any tree)
 * and the reconciliation (shared tree). Each is STRICT (#301, #311): an
 * unresolved tree reaches its judge as "" rather than being skipped, and the
 * judge owns both the verdict and any fail-open record.
 *
 * THE FRAMING STRINGS ARE KEYED: scripts/guard-fire-needles.json counts a
 * refusal by its framing and its rule fallback, so reword one there too. The
 * rewind refusal's framing and fallback are lib/main-rewind.js's, which
 * lib/branch-publish.js shares.
 */

const { expandLongOption } = require("./git-long-options.js");
const { rewindReason } = require("./main-rewind.js");
const { denyText, ruleOrFallback } = require("./guard-verdict.js");
const { buildCutCommand, landingCutOver } = require("./cutover.js");
const { LANDING_REF, VERIFIED_REF } = require("./landing-refs.js");
const { ruleUnlessModule } = require("./rule-gates.js");
const { parseCommand, walkGit } = require("./shell-parse.js");
const { UNREAD_ALIAS } = require("./git-alias.js");
const { gitValueFlags, literal, scanFlags } = require("./shell-words.js");
const { trimEndRun } = require("./trim-run.js");

/**
 * @typedef {object} PullFormPorts
 * @property {(dir: string) => string} pullFf `git config --get pull.ff`; ""
 *   where git errors or times out
 * @property {(dir: string) => string} currentBranch the checked-out branch's
 *   short name; "" where HEAD is detached or git errors
 * @property {(dir: string, word: string) => boolean} isCommit whether `word`
 *   names a commit there
 * @property {() => boolean} isMainUnreadable whether the shared `main` is broken
 *   rather than moved, read on a rewind's refusal alone
 * @property {(dir: string) => import("./git-alias.js").FileAliases | null}
 *   readFileAliases the aliases the config files a tree sees define, null where git
 *   could not say; read only for a word no table already answers
 * @typedef {import("./kit-context.js").KitContext & PullFormPorts
 *   & { git: import("./git.js").GitReader }} PullFormContext `git` runs in the
 *   main checkout
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
 * @property {PullFormContext["readFileAliases"]} readFileAliases the walk's, memoised
 * @property {() => void} subject marks a reconciliation the rule is about
 */

/* git pull's value-taking short options, read by the shared flag scan
 * (mantahostels#477), which walks a bundle letter by letter: `git pull -qr`
 * is -q then -r, a rebase, while the r inside `-Xtheirs` is that option's
 * value. -S and -j take a value only stuck on, so `git pull -j --rebase` is
 * still a rebase (#302). Each long option here takes the next word whatever it
 * spells, measured on git 2.43.0: `git pull --rebase --server-option --no-rebase`
 * rebases, and `--server-option --ff-only` is no fast-forward (#4008). */
const PULL_VALUE_FLAGS =
	"-s -X -S? -j? -o --cleanup --strategy --strategy-option --upload-pack --depth --shallow-since --shallow-exclude --deepen --refmap --server-option --negotiation-tip";

/* The value-taking options of `git checkout` and `git switch`, read by the
 * rewind judge; one left out makes its value read as a branch or a path. */
const CHECKOUT_VALUE_FLAGS = "-b -B --orphan --conflict --pathspec-from-file";
const SWITCH_VALUE_FLAGS = "-c -C --create --force-create --orphan --conflict";

/** @type {Record<string, string>} */
const REF_VALUE_FLAGS = {
	branch:
		"-u --set-upstream-to --contains --no-contains --merged --no-merged --points-at --format --sort",
	"update-ref": "-m",
	"symbolic-ref": "-m",
	checkout: CHECKOUT_VALUE_FLAGS,
	switch: SWITCH_VALUE_FLAGS,
};

/* The ruling's one route, named only where it applies (#3198). */
/** @param {import("./kit-context.js").KitContext} ctx */
const buildMainUnreadableLine = (ctx) =>
	`\`main\` IS UNREADABLE HERE, NOT MOVED: repair it with \`node ${ctx.scriptPath("repair-main.js")}\`, which refuses unless every proof holds and backs up first. Every other route to write \`main\` stays refused. File the reflog entries it lists on a ticket.`;

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
 * @param {{ sub: string, spec: string, table: ArgTable<S>, state: S,
 *   onArg?: (value: string, state: S) => void }} how accumulator: `state`,
 *   which the scan and `onArg` write and which is returned; `sub` is the git
 *   subcommand whose abbreviations are read; `spec` is scanFlags's value-taking
 *   flags
 * @returns {S}
 */
function readArgs(args, { sub, spec, table, state, onArg }) {
	scanFlags(
		spec,
		args,
		(kind, name, value) => {
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
		},
		(flag) => expandLongOption(sub, flag),
	);
	return state;
}

/** @param {PullFormContext} ctx */
const pullRule = (ctx) =>
	ctx.moduleOn("landing")
		? `With \`landing\` on, reconcile in your session's own worktree, never in the main checkout: ${buildCutCommand(ctx.scriptPath)} prints one, and \`node ${ctx.scriptPath("session-checkout.js")} land\` run there merges \`${LANDING_REF}\` and pushes.`
		: ruleOrFallback(
				ctx,
				"pull-fast-forward",
				"Reconcile the shared `main` by fast-forward or not at all",
			);

/**
 * The rewind refusal, framed by lib/main-rewind.js.
 * @param {Judging} j
 * @param {string} segment
 * @param {string} what completing "This …"
 * @returns {Refusal}
 */
const rewindDeny = (j, segment, what) => ({
	reason: j.ctx.isMainUnreadable()
		? `${rewindReason(j.ctx, what)}\n\n${buildMainUnreadableLine(j.ctx)}`
		: rewindReason(j.ctx, what),
	segment,
});

// ── REWINDING `main` (#765) ──────────────────────────────────────────────

/**
 * A git subcommand or alias that cannot be read could be any walk's (#3997).
 * @param {Judging} j
 * @param {GitCall} call
 * @returns {Refusal}
 */
const judgeUnreadAlias = (j, { segment }) =>
	rewindDeny(
		j,
		segment,
		"runs a git subcommand or alias I cannot read, a write to `main` possibly among what it does — spell the subcommand itself",
	);

/**
 * @typedef {{ helping: boolean, pathspec: boolean, patch: boolean,
 *   fromFile: boolean, ddash: boolean }} ResetArgs
 */

/** @type {ArgTable<ResetArgs>} */
const RESET_ARGS = {
	/* Interactive or file-fed paths: an unstage whatever commit it names, unless
	 * a later `--no-` takes them back (#4008). */
	"flag:-p": { patch: true },
	"flag:--patch": { patch: true },
	"flag:--no-patch": { patch: false },
	"opt:--pathspec-from-file": { fromFile: true },
	"flag:--no-pathspec-from-file": { fromFile: false },
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
function judgeReset(j, { segment, sub, tree, args }) {
	/** @type {string[]} */
	const positional = [];
	const a = readArgs(args, {
		sub,
		spec: "--pathspec-from-file",
		table: RESET_ARGS,
		state: {
			helping: false,
			pathspec: false,
			patch: false,
			fromFile: false,
			ddash: false,
		},
		onArg: (w, s) => {
			/* A word after `--` is a path. */
			if (s.ddash) s.pathspec = true;
			else positional.push(w);
		},
	});
	if (a.helping || a.pathspec || a.patch || a.fromFile) return null;
	const [first, ...more] = positional;
	/* None names HEAD, which moves no branch. */
	if (first === undefined) return null;
	/* Two or more are a tree-ish and paths, where a word I cannot read could
	 * be `--hard` before a commit. */
	if (more.length > 0)
		return positional.some((w) => j.known(w) === null)
			? rewindDeny(
					j,
					segment,
					"carries a word I cannot read, which could be a mode that moves the shared `main` to the commit beside it — spell it literally",
				)
			: null;
	const commit = j.known(first);
	if (commit === null)
		return rewindDeny(
			j,
			segment,
			"resets the shared tree to a commit I cannot read — spell it literally, or use `git reset -- <path>` to unstage",
		);
	const lands = resetLands(j, tree, commit, a.ddash);
	if (lands === "here" || lands === "path") return null;
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
 *   ignoreOther: boolean, delete: boolean, forceDelete: boolean, move: boolean,
 *   forceMove: boolean, copy: boolean, forceCopy: boolean,
 *   created: string[] }} RefArgs `created` holds each branch a `-B`/`-C`
 *   recreates
 */

/** @type {ArgTable<RefArgs>} */
const REF_ARGS = {
	"flag:-f": { force: true },
	"flag:--force": { force: true },
	"flag:--no-force": { force: false },
	/* `--no-delete`, `--no-move` and `--no-copy` clear the lower-case form alone:
	 * `git branch -D --no-delete main` still deletes (measured, #4008). */
	"flag:-d": { delete: true },
	"flag:--delete": { delete: true },
	"flag:--no-delete": { delete: false },
	"flag:-D": { forceDelete: true },
	"flag:-m": { move: true },
	"flag:--move": { move: true },
	"flag:--no-move": { move: false },
	"flag:-M": { forceMove: true },
	/* `-c`/`-C` copy under `git branch` and create under `git switch`, whose
	 * force form is an opt below. */
	"flag:-c": { copy: true },
	"flag:--copy": { copy: true },
	"flag:--no-copy": { copy: false },
	"flag:-C": { forceCopy: true },
	"flag:--stdin": { stdin: true },
	"flag:--no-stdin": { stdin: false },
	"flag:--ignore-other-worktrees": { ignoreOther: true },
	"flag:--no-ignore-other-worktrees": { ignoreOther: false },
	"opt:-B": (v, s) => ({ created: [...s.created, v] }),
	"opt:--force-create": (v, s) => ({ created: [...s.created, v] }),
	"opt:-C": (v, s) => ({ created: [...s.created, v] }),
	/* git holds one name for `-C` and `--force-create`, so its negation drops every
	 * one spelled before it: `git switch -C main --no-force-create side` leaves
	 * `main` where it is (measured, #4008). */
	"flag:--no-force-create": { created: [] },
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
 * @property {(word: string) => string | null} known Judging's
 * @property {(what: string) => Refusal} deny
 */

/**
 * A `git branch`, `git update-ref`, `git symbolic-ref`, `git checkout` or `git
 * switch` in ANY tree of this repo, or an unresolved one.
 * @param {Judging} j
 * @param {GitCall} call
 * @returns {Refusal | null}
 */
function judgeRef(j, { segment, sub, tree, args }) {
	const scope = tree ? j.treeClass(tree) : "unknown";
	/** @type {string[]} */
	const positional = [];
	const a = readArgs(args, {
		sub,
		spec: tableEntry(REF_VALUE_FLAGS, sub),
		table: REF_ARGS,
		state: /** @type {RefArgs} */ ({
			helping: false,
			force: false,
			stdin: false,
			ignoreOther: false,
			delete: false,
			forceDelete: false,
			move: false,
			forceMove: false,
			copy: false,
			forceCopy: false,
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
		sub !== "symbolic-ref" &&
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
		known: j.known,
		deny: (what) => rewindDeny(j, segment, what),
	};
	if (sub === "update-ref") return judgeUpdateRef(r);
	if (sub === "symbolic-ref") return judgeSymbolicRef(r);
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

/* `git symbolic-ref` follows a name as a path where `git update-ref` refuses
 * it: `../.git/refs/heads/main` writes `main` (#3915, measured on git 2.43.0).
 * No real ref has a `.`-led component, a `//`, a leading `/` or a glob
 * character. */
const NOT_A_REF_NAME = /(?:^|\/)\.|\/\/|^\/|[*?[]/;

/** @param {RefCall} r */
function judgeSymbolicRef(r) {
	const { a, positional, refIs, known, deny } = r;
	const [name, target] = positional;
	if (name === undefined) return null;
	const nameText = known(name);
	const deleting = a.delete;
	const reading = !deleting && target === undefined;
	if (reading && nameText !== null) return null;
	/* An unreadable word could be any name, a `..` walk to `main` among them,
	 * or split into a name and a target. */
	if (nameText === null || (target !== undefined && known(target) === null))
		return deny(
			"writes a symbolic ref I cannot read, `main` possibly among them — spell it literally",
		);
	if (NOT_A_REF_NAME.test(nameText))
		return deny(
			"writes a ref through a path git follows, `main` possibly among them",
		);
	if (refIs(name, "refs/heads/main"))
		return deny(
			"rewrites `main` as a pointer to another ref, or deletes one, leaving its commits behind",
		);
	return judgeSymrefTarget(r, nameText, target);
}

/**
 * Whether a readable name may point where `target` says: the shared HEAD only
 * at `main`, and every other ref anywhere but.
 * @param {RefCall} r
 * @param {string} nameText
 * @param {string | undefined} target undefined on a delete
 */
function judgeSymrefTarget({ scope, refIs, deny }, nameText, target) {
	const sharedHead =
		(scope !== "linked" && nameText === "HEAD") ||
		nameText === "main-worktree/HEAD";
	const ontoMain = refIs(target, "refs/heads/main");
	if (sharedHead)
		return ontoMain
			? null
			: deny("points the shared tree's HEAD away from `main`");
	return ontoMain
		? deny(
				"points another ref at `main`, so a write through it moves `main` past git's own refusal",
			)
		: null;
}

/** @param {RefCall} r */
function judgeBranch(r) {
	const { a, positional, refIs, deny } = r;
	/* git refuses more than one of these at once, so their order decides nothing
	 * it would run. */
	if (a.delete || a.forceDelete)
		return positional.some((w) => refIs(w, "main"))
			? deny("deletes `main`")
			: null;
	if (a.move || a.forceMove) return judgeBranchMove(r);
	if (a.copy || a.forceCopy)
		return refIs(positional.at(-1), "main")
			? deny("replaces `main` with a copy of another branch")
			: null;
	return a.force && refIs(positional[0], "main")
		? deny("forces `main` to another commit, dropping whatever came after it")
		: null;
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

// ── RECONCILING THE SHARED `main` (mantahostels#245, #290) ───────────────

/**
 * @typedef {{ helping: boolean, ffOnly: boolean, rebase: boolean,
 *   override: boolean, aborting: boolean, quitting: boolean,
 *   continuing: boolean, resuming: boolean }} ReconcileArgs `override` is a
 *   flag that countermands a configured pull.ff=only; `resuming` a rebase's
 *   `--skip` and friends, which have no `--no-` form
 */

/** @type {ArgTable<ReconcileArgs>} */
const PULL_ARGS = {
	"flag:--ff-only": { ffOnly: true },
	/* These spell "not a rebase": they only countermand a configured
	 * pull.ff=only. `--ff` and `--no-ff` also countermand an earlier
	 * `--ff-only`, git taking the last of the three: `git pull --ff-only
	 * --no-ff` writes a merge commit (measured, #308). */
	"flag:--no-rebase": { override: true, rebase: false },
	"flag:--ff": { override: true, ffOnly: false },
	"flag:--no-ff": { override: true, ffOnly: false },
	"flag:--rebase": { rebase: true },
	"flag:-r": { rebase: true },
	"opt:--rebase": (v) =>
		/^(?:false|no|off|0|)$/i.test(v)
			? { override: true, rebase: false }
			: { rebase: true },
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
	 * reconciliation; refusing it would strand a tree mid-merge. A negated one
	 * starts a merge: `git merge --abort --no-abort side` merges (measured,
	 * #4008). */
	"flag:--abort": { aborting: true },
	"flag:--no-abort": { aborting: false },
	"flag:--continue": { continuing: true },
	"flag:--no-continue": { continuing: false },
	"flag:--quit": { quitting: true },
	"flag:--no-quit": { quitting: false },
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
		sub,
		spec: pull ? PULL_VALUE_FLAGS : gitValueFlags(sub),
		table: pull ? PULL_ARGS : DIRECT_ARGS,
		state: {
			helping: false,
			ffOnly: false,
			rebase: false,
			override: false,
			aborting: false,
			quitting: false,
			continuing: false,
			resuming: false,
		},
	});
	if (a.helping || a.aborting || a.quitting || a.continuing || a.resuming)
		return null;
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
const unresolvedDeny = (j, sub, segment) => {
	const landing = j.ctx.moduleOn("landing");
	return {
		reason: `I cannot tell which working tree this \`git ${sub}\` lands in — an empty or
unexpanded \`-C\`, or a \`cd\` to a path I cannot resolve: @CMD@

An unset variable there is not a different tree — it expands to nothing, and
both \`git -C ""\` and \`cd ""\` stay in the current directory.

Spell the worktree as a LITERAL path in a plain \`cd\` or \`-C\` in the same
command — \`git -C ${landing ? `.claude/worktrees/<session-name> merge ${LANDING_REF}` : `.claude/worktrees/reconcile merge ${VERIFIED_REF}`}\` — or assign
it literally in the same Bash call${landing ? "" : ", as the recipe below does"}. A \`pushd\`, a
\`cd -P\` or a \`builtin cd\` is unreadable here whatever path it carries.

${pullRule(j.ctx)}`,
		segment,
	};
};

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
	[judgeUnreadAlias, "the alias", "repo", [UNREAD_ALIAS]],
	[judgeReset, "the reset", "shared", ["reset"]],
	[
		judgeRef,
		"the ref write",
		"repo",
		["branch", "update-ref", "symbolic-ref", "checkout", "switch"],
	],
	[
		(j, call) =>
			call.tree && landingCutOver(j.ctx.moduleOn, j.ctx.git)
				? null
				: judgeReconcile(j, call),
		"the reconciliation",
		"shared",
		["pull", "merge", "rebase"],
	],
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
	/** @type {Map<string, import("./git-alias.js").FileAliases | null>} */
	const aliases = new Map();
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
		/* One git read a tree, as the tree class is. */
		readFileAliases: (dir) => {
			if (!aliases.has(dir)) aliases.set(dir, ctx.readFileAliases(dir));
			return aliases.get(dir) ?? null;
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
	 * stays an allow. With `landing` on there is no recipe to hand. */
	if (!ruleSubject) return null;
	return {
		injectRules: ["pull-fast-forward"],
		skip: ruleUnlessModule(ctx, "landing", ["pull-fast-forward"]),
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
		{ ...j.ctx, treeClass: j.treeClass, readFileAliases: j.readFileAliases },
		{ ...opts, strict: true, unwrap: true },
	);
	return refused;
}

module.exports = { field: "command", noun: "command", decide };
