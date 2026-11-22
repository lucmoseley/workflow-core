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
 * divergence that needs a real merge, the session's own worktree — so a deny
 * cannot wedge ordinary work.
 *
 * A SESSION RECONCILES IN ITS OWN WORKTREE (#4229), merging `origin/main` and
 * pushing its own queue ref by `scripts/session-checkout.js land` (#4458).
 * Once the main checkout is also cut over (lib/cutover.js) the walk stands
 * down on a tree it resolves: lib/main-checkout-write.js refuses every merge,
 * pull or rebase there, and lib/level-main.js alone moves its `main`. An
 * unresolved tree is still judged, since that guard does not see one. A
 * cutover git cannot read counts as none.
 *
 * LIMITS
 *  - A reconciliation refusal names the land route: the session's own
 *    worktree, the command that cuts one, and `session-checkout.js land`.
 *  - It guards `git pull`, `git merge` and `git rebase`. `git fetch` is always
 *    safe — it moves no local ref. The rewrite reached directly after a fetch,
 *    as `git merge origin/main` or `git rebase origin/main`, is denied
 *    (mantahostels#245, #290): a session reconciles in its own worktree.
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
 *  - What passes on `git merge` and `git rebase`: `git merge --ff-only`, and
 *    `--abort`, `--continue`, `--quit`,
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
 *    exception. A store fault fails CLOSED too: the rewind refusal carries the
 *    rule's fallback sentence (mantahostels#1648).
 *  - A command behind shell-words.js's unwrap wrappers is judged — `env`,
 *    `sudo`, `timeout 5 git pull --rebase` (#4009). Still unseen, each measured
 *    moving `main`: `sh -c "git ..."`, `eval`, arguments an `xargs` reads from
 *    stdin, a dashed `git-update-ref` off `git --exec-path`, a repo's own
 *    `core.worktree`, and an alias written to a config file by other than `git
 *    config` earlier in the same command; so, by the `if` below, a quoted `git`
 *    or one a tab follows; a launcher outside that class, `chrt` and `unshare`
 *    measured; and a quote inside the string `watch` or `flock -c` runs
 *    (#4046), whose every line and `;`-joined command is judged (#4699).
 *  - Its lib/guard-cores.json row narrows it to `Bash(*git *)`
 *    (mantahostels#2127, #4009) — not loaded unless the command holds the word,
 *    unanchored because the walk reads past a wrapper.
 *  - It guards the Bash tool. A command run outside Claude Code sees no hook,
 *    and there is no override: this binds agent sessions only, and an escape
 *    a session can spell for itself is not a deny (mantahostels#109).
 *
 * NO I/O OF ITS OWN (§T7): every git read, the rule store, the pushed ref and
 * the plugin-root path rewrite arrive as ports, so each verdict is reached in
 * process. It answers a Decision: a refusal's complete text, or nothing.
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
const { denyText } = require("./guard-verdict.js");
const { buildCutCommand, isCutOverAt } = require("./cutover.js");
const { VERIFIED_REF } = require("./landing-refs.js");
const { parseCommand, walkGit } = require("./shell-parse.js");
const { UNREAD_ALIAS } = require("./git-alias.js");
const { gitValueFlags, literal, scanFlags } = require("./shell-words.js");
const { trimEndRun } = require("./trim-run.js");
const { WORKTREES } = require("./worktree-dirs.js");

/**
 * @typedef {object} PullFormPorts
 * @property {(dir: string) => string} pullFf
 * @property {(dir: string) => string} currentBranch
 * @property {(dir: string, word: string) => boolean} isCommit
 * @property {() => boolean} isMainUnreadable
 * @property {(dir: string) => import("./git-alias.js").FileAliases | null} readFileAliases
 * @typedef {import("./kit-context.js").KitContext & PullFormPorts
 *   & { git: import("./git.js").GitReader }} PullFormContext
 * @typedef {import("./shell-parse.js").GitCall} GitCall
 * @typedef {{ reason: string, segment: string }} Refusal
 * @typedef {object} Judging
 * @property {PullFormContext} ctx
 * @property {(word: string) => string | null} known
 * @property {(word: string) => ReturnType<typeof literal>} read
 * @property {(dir: string) => ReturnType<PullFormContext["treeClass"]>} treeClass
 * @property {PullFormContext["readFileAliases"]} readFileAliases
 */

// #302, #4008
const PULL_VALUE_FLAGS =
	"-s -X -S? -j? -o --cleanup --strategy --strategy-option --upload-pack --depth --shallow-since --shallow-exclude --deepen --refmap --server-option --negotiation-tip";

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

/** @param {import("./kit-context.js").KitContext} ctx */
const buildMainUnreadableLine = (ctx) =>
	`\`main\` IS UNREADABLE HERE, NOT MOVED: repair it with \`node ${ctx.scriptPath("repair-main.js")}\`, which refuses unless every proof holds and backs up first. Every other route to write \`main\` stays refused. File the reflog entries it lists on a ticket.`;

/**
 * @template S
 * @typedef {Record<string, Partial<S> | ((value: string, state: S) => Partial<S>)>} ArgTable
 */

/**
 * @template {{ helping: boolean }} S
 * @param {string[]} args
 * @param {{ sub: string, spec: string, table: ArgTable<S>, state: S,
 *   onArg?: (value: string, state: S) => void }} how
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
	`Reconcile in your session's own worktree, never in the main checkout: ${buildCutCommand(ctx.scriptPath)} prints one, and \`node ${ctx.scriptPath("session-checkout.js")} land\` run there merges \`${VERIFIED_REF}\` and pushes its queue ref.`;

/**
 * @param {Judging} j
 * @param {string} segment
 * @param {string} what
 * @returns {Refusal}
 */
const rewindDeny = (j, segment, what) => ({
	reason: j.ctx.isMainUnreadable()
		? `${rewindReason(j.ctx, what)}\n\n${buildMainUnreadableLine(j.ctx)}`
		: rewindReason(j.ctx, what),
	segment,
});

/**
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
	"flag:-p": { patch: true },
	"flag:--patch": { patch: true },
	"flag:--no-patch": { patch: false },
	"opt:--pathspec-from-file": { fromFile: true },
	"flag:--no-pathspec-from-file": { fromFile: false },
	"flag:--": { ddash: true },
};

/**
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
			if (s.ddash) s.pathspec = true;
			else positional.push(w);
		},
	});
	if (a.helping || a.pathspec || a.patch || a.fromFile) return null;
	const [first, ...more] = positional;
	if (first === undefined) return null;
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
 * @param {Judging} j
 * @param {string} tree
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
	return ddash ||
		j.ctx.isCommit(tree, commit) ||
		isAncestorStep(j, tree, commit)
		? "elsewhere"
		: "path";
}

/**
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

/**
 * @param {string} word
 * @returns {boolean}
 */
const isHead = (word) => word === "HEAD" || word === "@";

/**
 * @typedef {{ helping: boolean, force: boolean, stdin: boolean,
 *   ignoreOther: boolean, delete: boolean, forceDelete: boolean, move: boolean,
 *   forceMove: boolean, copy: boolean, forceCopy: boolean,
 *   created: string[] }} RefArgs
 */

/** @type {ArgTable<RefArgs>} */
const REF_ARGS = {
	"flag:-f": { force: true },
	"flag:--force": { force: true },
	"flag:--no-force": { force: false },
	// #4008
	"flag:-d": { delete: true },
	"flag:--delete": { delete: true },
	"flag:--no-delete": { delete: false },
	"flag:-D": { forceDelete: true },
	"flag:-m": { move: true },
	"flag:--move": { move: true },
	"flag:--no-move": { move: false },
	"flag:-M": { forceMove: true },
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
	// #4008
	"flag:--no-force-create": { created: [] },
};

/**
 * @typedef {object} RefCall
 * @property {RefArgs} a
 * @property {string[]} positional
 * @property {string} scope
 * @property {(word: string | undefined, name: string) => boolean} refIs
 * @property {(word: string) => string | null} known
 * @property {(what: string) => Refusal} deny
 */

/**
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
	if (
		(scope !== "linked" && refIs(first, "HEAD")) ||
		refIs(first, "main-worktree/HEAD")
	)
		return deny("writes the shared tree's HEAD, and so `main`, directly");
	return null;
}

// #3915
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
 * @param {RefCall} r
 * @param {string} nameText
 * @param {string | undefined} target
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
	if (refIs(positional.at(-1), "main"))
		return deny("replaces `main` with another branch");
	if (positional.length >= 2)
		return refIs(positional[0], "main") ? deny("renames `main` away") : null;
	return scope === "linked"
		? null
		: deny("renames the shared tree's branch, `main`, away");
}

/**
 * @typedef {{ helping: boolean, ffOnly: boolean, rebase: boolean,
 *   override: boolean, aborting: boolean, quitting: boolean,
 *   continuing: boolean, resuming: boolean }} ReconcileArgs
 */

/** @type {ArgTable<ReconcileArgs>} */
const PULL_ARGS = {
	"flag:--ff-only": { ffOnly: true },
	// #308
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
	"flag:--ff-only": { ffOnly: true },
	"flag:--ff": { ffOnly: false },
	"flag:--no-ff": { ffOnly: false },
	// #4008
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
	if (!pull) {
		if (sub === "merge" && a.ffOnly) return null;
		return tree ? reconcileDeny(j, segment) : unresolvedDeny(j, sub, segment);
	}
	if (a.rebase) return reconcileDeny(j, segment);
	if (a.ffOnly) return null;
	if (a.override) return reconcileDeny(j, segment);
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
command — \`git -C ${WORKTREES}/<session-name> merge ${VERIFIED_REF}\` — or assign
it literally in the same Bash call. A \`pushd\`, a
\`cd -P\` or a \`builtin cd\` is unreadable here whatever path it carries.

${pullRule(j.ctx)}`,
	segment,
});

/**
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
			call.tree && isCutOverAt(j.ctx.git) ? null : judgeReconcile(j, call),
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
	/** @type {Judging} */
	const j = {
		ctx,
		known: (word) => {
			const l = literal(word, parsed.spans);
			return l.known ? l.text : null;
		},
		read: (word) => literal(word, parsed.spans),
		treeClass: (dir) => {
			const cls = classes.get(dir) ?? ctx.treeClass(dir);
			classes.set(dir, cls);
			return cls;
		},
		readFileAliases: (dir) => {
			if (!aliases.has(dir)) aliases.set(dir, ctx.readFileAliases(dir));
			return aliases.get(dir) ?? null;
		},
	};
	for (const [judge, noun, scope, subs] of WALKS) {
		const refused = firstRefusal(parsed, j, judge, { subs, noun, scope });
		if (refused)
			return { deny: denyText(ctx, refused.segment, refused.reason) };
	}
	return null;
}

/**
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
