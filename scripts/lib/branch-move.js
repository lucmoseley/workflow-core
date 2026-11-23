const { isCutOverAt } = require("./cutover.js");
const { denyText, ruleOrFallback } = require("./guard-verdict.js");
const { parseCommand, unsetText, walkGit } = require("./shell-parse.js");

const WORKTREE_FRAMING =
	"This opens a worktree with neither a branch of its own nor a detached HEAD: @CMD@";
const MOVE_FRAMING = "This moves the shared working tree off its branch: @CMD@";
const RESTORE_HINT =
	"To restore a file rather than move a branch, use the pathspec form: git checkout -- <file>, or git restore <file>.";

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
 * @property {(dir: string, name: string) => boolean} isBranch
 * @property {(p: string) => boolean} exists
 * @typedef {import("./kit-context.js").KitContext & BranchPorts
 *   & { git: import("./git.js").GitReader }} BranchContext
 */

/**
 * @param {string} command
 * @param {BranchContext} ctx
 * @returns {import("./guard-entry.js").Decision}
 */
function decide(command, ctx) {
	const parsed = parseCommand(command);
	/** @type {boolean | undefined} */
	let cutOver;
	const readCutOverOnce = () => {
		if (cutOver === undefined) cutOver = isCutOverAt(ctx.git);
		return cutOver;
	};
	let ruleSubject = false;
	/** @type {string | null} */
	let refusal = null;
	walkGit(
		parsed,
		({ segment, sub, tree, args, emptyVars }) => {
			if (refusal !== null || (sub !== "worktree" && readCutOverOnce())) return;
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
	if (!ruleSubject || readCutOverOnce()) return null;
	return { injectRules: ["branch-shared-tree", "branch-shared-tree-cutover"] };
}

/**
 * @param {string} sub
 * @param {string} tree
 * @param {string[]} args
 * @param {BranchContext} ctx
 * @returns {"allow" | "rule" | "worktree" | "move"}
 */
function judge(sub, tree, args, ctx) {
	if (sub === "worktree") return judgeWorktree(args);
	const { move, ddash, positional } = scanWords(args);
	if (!move && positional.length === 1 && positional[0] === "main")
		return "rule";
	if (sub === "checkout" && !move) {
		if (ddash || positional.length === 0) return "allow";
		if (isFileRestore(tree, positional, ctx)) return "allow";
	}
	return "move";
}

/** @param {string[]} args */
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
 * @param {"worktree" | "move"} kind
 * @param {string} unset
 * @param {string} segment
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
