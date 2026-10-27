/*
 * branch-move.js — the guard-branch core (#2797, #3224): the shared working tree
 * stays on `main`.
 *
 * Why: the working tree is repo-global, so a `git checkout` in one session
 * moves every parallel session's branch at once. On mantahostels#87 (an
 * incident struck while it was worked, recorded on mantahostels#100 — its
 * title names other work) a commit landed on `manual-sync-2026-08-03` because
 * a parallel run switched the tree mid-session, and the gates that ran
 * afterwards silently read the other branch's files. mantahostels#100 answered
 * that by pinning the shared tree to `main`: work that needs a branch does it
 * in a throwaway worktree (`git worktree add`).
 *
 * DENY, not warn. mantahostels#103 set the rule for both Bash guards: deny on
 * a structured fact where the action has no legitimate use, warn where the
 * hook is inferring. A shared-tree branch move has one legitimate use and no
 * more — `git checkout main`, the repair, handled below — so a deny cannot
 * wedge ordinary work.
 *
 * LIMITS
 *  - It also refuses `git worktree add` carrying neither `-b`/`-B` nor
 *    `--detach` (mantahostels#1648) — the route a session takes to a worktree
 *    WITHOUT first running a branch move, so the recipe reached nobody on it.
 *    `-b`, `--detach` and every other worktree verb stay allowed. It
 *    DELIBERATELY over-fires: only `add <path> <branch checked out elsewhere>`
 *    actually fails, and the two shapes below succeed and are refused anyway,
 *    because the guard cannot tell which of the three it is holding without
 *    resolving the commit-ish against every worktree's HEAD. Measured on git
 *    2.43.0:
 *      git worktree add <path>          exit 0 — DWIMs a branch off the basename
 *      git worktree add <path> HEAD     exit 0 — detached
 *      git worktree add <path> main     exit 128 — main is checked out here
 *    The first is refused for the surprise branch name and the second for
 *    spelling detachment in a way the recipe does not; mantahostels#301
 *    measured only the third. Both are false denies against git, not against
 *    the house rule.
 *  - Walking `worktree` widens the fail-open record: walkGit logs an
 *    unresolvable tree under the noun "branch move" for EVERY worktree verb,
 *    `list` and `prune` included, though the guard judges only `add`. The
 *    noun is per-walk, not per-subcommand, so splitting it needs a second
 *    walk.
 *  - The rule it prints is docs/agents/rules/branch-shared-tree.txt, not text
 *    of its own (mantahostels#1648), TWICE OVER on two exclusive limbs
 *    (mantahostels#1647): inside the refusal, and — where nothing was refused —
 *    injected before an allowed `git worktree add -b/--detach/--orphan` or
 *    `git checkout main`, once a session. Every other `worktree` verb, and
 *    every file restore, is handed nothing — they move no branch.
 *  - It matches the PARSED command form — a segment whose first word is `git`
 *    and whose subcommand is `checkout`/`switch`/`worktree` — never a
 *    substring, so a grep, an echo or a heredoc mentioning `git checkout`
 *    passes.
 *  - An UNSET variable in a `cd` or `git -C` target is read as empty (#310,
 *    #325): shell state does not carry between Bash calls, so `cd "$W"` with
 *    `W` from an earlier call is `cd ""`, the cwd, and is judged there, the
 *    refusal naming the variable. A `$(…)` target keeps the logged fail-open.
 *  - A branch move reached through a wrapper is not seen — `xargs`, `env`,
 *    `sudo`, `timeout 5 git checkout …`, `sh -c "git checkout …"`
 *    (https://github.com/lucmoseley/workflow-core-tracker/blob/0a69e0d4be03/docs/research/hook-if-bash-matching.md §1).
 *  - No override: this binds agent sessions only, and an escape a session can
 *    spell for itself is not a deny (mantahostels#109). `WFC_ALLOW_BRANCH`
 *    escapes the pre-commit block, not this.
 *  - A store fault still refuses, carrying a fallback that names the
 *    fragment's file, and is not logged: the COMMAND was resolved and only the
 *    rule was not (mantahostels#1648).
 */

const { ruleModule } = require("./rule-gates.js");
const { denyText, ruleOrFallback } = require("./guard-verdict.js");
const { parseCommand, unsetText, walkGit } = require("./shell-parse.js");

const WORKTREE_FRAMING =
	"This opens a worktree with neither a branch of its own nor a detached HEAD: @CMD@";
const MOVE_FRAMING = "This moves the shared working tree off its branch: @CMD@";
const RESTORE_HINT =
	"To restore a file rather than move a branch, use the pathspec form: git checkout -- <file>, or git restore <file>.";

/* -c/-C are `git switch`'s create flags; git's own -c <k>=<v> was consumed as
 * a global option by the walk. `-` is `@{-1}`, always a branch move, and gets
 * no `main` exception: its target is only knowable at run time. */
const MOVE_FLAGS = [
	"-b",
	"-B",
	"-c",
	"-C",
	"--create",
	"--force-create",
	"--orphan",
	"--detach",
	"-",
];

/**
 * @typedef {object} BranchPorts
 * @property {(dir: string, name: string) => boolean} isBranch `refs/heads/<name>`
 *   resolves in the repo at `dir`
 * @property {(p: string) => boolean} exists anything is at `p`, relative to the
 *   hook's own directory where not absolute
 * @typedef {import("./kit-context.js").KitContext & BranchPorts} BranchContext
 */

/**
 * @param {string} command
 * @param {BranchContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const parsed = parseCommand(command);
	let ruleSubject = false;
	/** @type {string | null} */
	let refusal = null;
	walkGit(
		parsed,
		({ segment, sub, tree, args, emptyVars }) => {
			if (refusal !== null) return;
			const verdict = judge(sub, tree, args, ctx);
			if (verdict === "rule") ruleSubject = true;
			else if (verdict !== "allow")
				refusal = refusalText(verdict, unsetText(emptyVars), segment, ctx);
		},
		ctx,
		{
			subs: ["checkout", "switch", "worktree"],
			noun: "branch move",
			scope: "shared",
			emptyUnset: true,
		},
	);
	if (refusal !== null) return { deny: refusal };
	if (!ruleSubject) return null;
	/* With `landing` on, the shared tree's upstream line rides with it (#2409). */
	return {
		injectRules: ["branch-shared-tree", "branch-shared-tree-landing"],
		skip: [...ruleModule(ctx, "landing", ["branch-shared-tree-landing"])],
	};
}

/**
 * One `git checkout`/`switch`/`worktree` against the shared tree: allowed
 * silently, allowed with the rule handed over, or refused as a worktree add or
 * a branch move. `args` are raw, as the walk hands them.
 * @param {string} sub
 * @param {string} tree
 * @param {string[]} args
 * @param {BranchContext} ctx
 * @returns {"allow" | "rule" | "worktree" | "move"}
 */
function judge(sub, tree, args, ctx) {
	if (sub === "worktree") return judgeWorktree(args);
	/* `git checkout -- <file>`, `git checkout <sha> -- <file>` and `-p` restore
	 * content and move no branch; so does `git checkout <file>` naming
	 * something on disk. */
	const { move, ddash, positional } = scanWords(args);
	/* The one command that RESTORES the invariant passes, and is handed the
	 * rule: a session running it has just been somewhere it should not have
	 * been (mantahostels#100, mantahostels#1647). */
	if (!move && positional.length === 1 && positional[0] === "main")
		return "rule";
	if (sub === "checkout" && !move) {
		if (ddash || positional.length === 0) return "allow";
		if (isFileRestore(tree, positional, ctx)) return "allow";
	}
	return "move";
}

/**
 * What the words say: a move flag, a restore marker (`--`, `-p`), and the
 * words before any marker that no flag claims.
 * @param {string[]} args
 */
function scanWords(args) {
	let move = false;
	let ddash = false;
	/** @type {string[]} */
	const positional = [];
	for (const a of args) {
		if (a === "--" || a === "-p" || a === "--patch") ddash = true;
		else if (MOVE_FLAGS.includes(a)) move = true;
		else if (!a.startsWith("-") && !ddash) positional.push(a);
	}
	return { move, ddash, positional };
}

/**
 * @param {string[]} args
 * @returns {"allow" | "rule" | "worktree"}
 */
function judgeWorktree(args) {
	if (args[0] !== "add") return "allow";
	if (args.some((a) => a === "-h" || a === "--help")) return "allow";
	/* -b/-B take a value, which git accepts joined (`-bfoo`) or separate. */
	const branched = args.some(
		(a) =>
			a.startsWith("-b") ||
			a.startsWith("-B") ||
			a === "--detach" ||
			a === "--orphan",
	);
	return branched ? "rule" : "worktree";
}

/**
 * A lone word naming something on disk, and no branch, restores a file. A
 * name that is also a branch is a branch move whatever else it names: git
 * prefers the ref.
 * @param {string} tree
 * @param {string[]} positional
 * @param {BranchContext} ctx
 */
function isFileRestore(tree, positional, ctx) {
	const [p] = positional;
	return (
		positional.length === 1 &&
		p !== undefined &&
		!ctx.isBranch(tree, p) &&
		(p === "." || ctx.exists(`${tree}/${p}`) || ctx.exists(p))
	);
}

/**
 * The refusal: its framing, the unset-variable line (#310), the rule, and
 * the restore hint on a branch move; core paths spelled at the plugin root,
 * then the segment in place of the CMD placeholder, as typed.
 * @param {"worktree" | "move"} kind
 * @param {string} unset
 * @param {string} segment masked
 * @param {BranchContext} ctx
 */
function refusalText(kind, unset, segment, ctx) {
	const rule = ruleOrFallback(
		ctx,
		"branch-shared-tree",
		"The shared working tree stays on `main`",
	);
	const text =
		kind === "worktree"
			? `${WORKTREE_FRAMING}\n\n${unset}${rule}`
			: `${MOVE_FRAMING}\n\n${unset}${rule}\n\n${RESTORE_HINT}`;
	return denyText(ctx, segment, text);
}

module.exports = { field: "command", noun: "command", decide };
