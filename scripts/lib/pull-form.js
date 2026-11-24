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

// workflow-core#302, workflow-core#4008
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
	// workflow-core#4008
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
	// workflow-core#4008
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

// workflow-core#3915
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
	// workflow-core#308
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
	// workflow-core#4008
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
