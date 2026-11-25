const path = require("node:path");
const { buildCutCommand, readCutOver } = require("./cutover.js");
const { denyText } = require("./guard-verdict.js");
const { isUnder, relativeUnder } = require("./is-under.js");
const { lastLineTerminator } = require("./line-terminators.js");
const { absolute, literal, programSource } = require("./shell-words.js");
const { parseCommand, walkCommands, walkGit } = require("./shell-parse.js");
const { WORKTREES } = require("./worktree-dirs.js");

const WRITERS = [
	"add",
	"am",
	"apply",
	"checkout",
	"cherry-pick",
	"clean",
	"commit",
	"merge",
	"mv",
	"pull",
	"rebase",
	"reset",
	"restore",
	"revert",
	"rm",
	"stash",
	"switch",
];

/** @type {Record<string, (args: string[]) => boolean>} */
const READ_ONLY = {
	add: (a) => a.includes("-n") || a.includes("--dry-run"),
	apply: (a) =>
		!a.includes("--index") &&
		!a.includes("--cached") &&
		a.some((w) => ["--check", "--stat", "--numstat", "--summary"].includes(w)),
	clean: (a) => a.includes("-n") || a.includes("--dry-run"),
	commit: (a) => a.includes("--dry-run"),
	stash: (a) => a[0] === "list" || a[0] === "show",
};

/**
 * @param {string | undefined} s
 */
const atHead = (s) => s === "HEAD" || s === "@";

/**
 * @param {string} p
 * @param {string} tree
 * @param {StatKindOf} statKind
 */
function namesOneFile(p, tree, statKind) {
	if (p === "" || p.startsWith(":") || p.includes("\u0001") || /[*?[]/.test(p))
		return false;
	return ["file", "other", "absent"].includes(statKind(path.resolve(tree, p)));
}

/**
 * @param {string} w
 * @param {() => string | undefined} next
 * @returns {string | undefined | null}
 */
function restoreSource(w, next) {
	if (w === "--source") return next();
	if (w.startsWith("--source=")) return w.slice("--source=".length);
	const short = shortClusterRest(w);
	if (short !== null) return short || next();
	return null;
}

/**
 * @param {string} w
 * @returns {string | null}
 */
function shortClusterRest(w) {
	if (!w.startsWith("-")) return null;
	const s = w.indexOf("s", Math.max(1, lastLineTerminator(w) + 1));
	return s === -1 || w.slice(1, s).includes("-") ? null : w.slice(s + 1);
}

/**
 * @type {Record<string, (args: string[], tree: string, statKind: StatKindOf) => boolean>}
 */
const RESTORES = {
	checkout: (a, tree, statKind) => {
		const dash = a.indexOf("--");
		const paths = a.slice(dash + 1);
		return (
			dash === 1 &&
			atHead(a[0]) &&
			paths.length > 0 &&
			paths.every((p) => namesOneFile(p, tree, statKind))
		);
	},
	restore: (a, tree, statKind) => {
		/** @type {string[]} */
		const paths = [];
		let headSource = false;
		for (let i = 0; i < a.length; i++) {
			const w = a[i] ?? "";
			if (w === "--") {
				paths.push(...a.slice(i + 1));
				break;
			}
			const source = restoreSource(w, () => a[++i]);
			if (source !== null) {
				if (!atHead(source)) return false;
				headSource = true;
			} else if (!w.startsWith("-")) paths.push(w);
		}
		return (
			headSource &&
			paths.length > 0 &&
			paths.every((p) => namesOneFile(p, tree, statKind))
		);
	},
};

class GitUnanswered extends Error {}

/**
 * @typedef {import("./core-contract.js").CoreContext} CoreContext
 * @typedef {import("./guard-entry.js").Decision} Decision
 * @typedef {import("./kit-context.js").KitContext["statKind"]} StatKindOf
 */

/**
 * @param {string} p
 * @param {StatKindOf} statKind
 */
function existingDir(p, statKind) {
	let d = p;
	while (statKind(d) !== "dir") {
		const up = path.dirname(d);
		if (up === d) return d;
		d = up;
	}
	return d;
}

/**
 * @param {string} p
 * @param {CoreContext} ctx
 * @param {boolean} [dir]
 * @returns {string | null}
 */
function refusedPath(p, ctx, dir = false) {
	const abs = path.resolve(p);
	const under = relativeUnder(ctx.root, abs);
	const rel = under === "" && dir ? "." : under;
	if (!rel || isUnder(rel, [".git"], path.sep)) return null;
	const cls = ctx.treeClass(existingDir(abs, ctx.statKind));
	if (cls === "unknown")
		throw new GitUnanswered(
			`git could not say which tree holds ${abs} — write allowed unchecked`,
		);
	if (cls !== "shared") return null;
	const ignored = ctx.git(["check-ignore", "--", rel], [1]);
	if (!ignored.ok)
		throw new GitUnanswered(
			`git check-ignore could not answer for ${rel} — write allowed unchecked`,
		);
	return ignored.out.trim() ? null : rel;
}

/**
 * @param {import("./shell-parse.js").Command} cmd
 * @param {string[]} spans
 * @param {CoreContext} ctx
 * @returns {string | null}
 */
function interpreterDir(cmd, spans, ctx) {
	for (const run of cmd.runs()) {
		const words = run.words.map((w) => literal(w, spans).text);
		for (const cwd of run.dirs()) {
			const dir = runDir(words, cwd, ctx);
			if (dir !== null) return dir;
		}
	}
	return null;
}

/**
 * @param {string[]} words
 * @param {string} cwd
 * @param {CoreContext} ctx
 * @returns {string | null}
 */
function runDir(words, cwd, ctx) {
	const prog = path.basename(words[0] ?? "");
	const program = programSource(prog, words.slice(1));
	if (!program) return null;
	if (!cwd) {
		ctx.log(`the walk lost the cwd of a ${prog} — run unchecked`);
		return null;
	}
	if (
		program.script &&
		ctx.statKind(path.resolve(cwd, program.script)) === "file"
	)
		return null;
	return refusedPath(cwd, ctx, true);
}

/**
 * @typedef {{ kind: "rel", rel: string } | { kind: "git", git: string }
 *   | { kind: "interp", interp: string, dir: string }} Write
 */

/**
 * @param {string} subject
 * @param {CoreContext} ctx
 * @returns {Write | null}
 */
function findWrite(subject, ctx) {
	if (ctx.tool !== "Bash") {
		const rel = refusedPath(absolute(subject, ctx.fallbackCwd), ctx);
		return rel === null ? null : { kind: "rel", rel };
	}
	const parsed = parseCommand(subject);
	/** @type {Write | null} */
	let found = null;
	walkCommands(
		parsed,
		(cmd) => {
			for (const t of cmd.writeTargets()) {
				if (found || !t.path) continue;
				const rel = refusedPath(t.path, ctx);
				if (rel !== null) found = { kind: "rel", rel };
			}
			if (found) return;
			const dir = interpreterDir(cmd, parsed.spans, ctx);
			if (dir !== null) found = { kind: "interp", interp: cmd.segment, dir };
		},
		{ ...ctx, bareRedirects: true },
	);
	if (found) return found;
	walkGit(
		parsed,
		({ segment, sub, args, tree }) => {
			if (
				!found &&
				!READ_ONLY[sub]?.(args) &&
				!RESTORES[sub]?.(args, tree, ctx.statKind)
			)
				found = { kind: "git", git: segment };
		},
		ctx,
		{ subs: WRITERS, noun: "main-checkout write", scope: "shared" },
	);
	return found;
}

/**
 * @typedef {{ what: string, cmd: (subject: string) => string,
 *   inOwn: (own: string) => string, back: (root: string) => string }} Refusal
 */

/**
 * @type {{ [K in Write["kind"]]: (w: Extract<Write, { kind: K }>) => Refusal }}
 */
const REFUSALS = {
	rel: (w) => ({
		what: `This writes ${w.rel} in the main checkout`,
		cmd: (subject) => subject,
		inOwn: (own) => `make the edit there, at ${path.join(own, w.rel)}.`,
		back: (root) =>
			`, and a tracked file already dirtied there goes back to HEAD with \`git -C ${root} restore --source=HEAD --staged --worktree -- ${w.rel}\``,
	}),
	git: (w) => ({
		what: "This git command writes the main checkout's index, HEAD or files",
		cmd: () => w.git,
		inOwn: (own) => `run it there, as \`git -C ${own} …\`.`,
		back: () => "",
	}),
	interp: (w) => ({
		what: `This runs an interpreter on a program that is no file, in the main checkout${w.dir === "." ? "" : `, at ${w.dir}`}, and what it writes cannot be read off the command`,
		cmd: () => w.interp,
		inOwn: () => "`cd` there and run it, with every path it writes inside it.",
		back: () => "",
	}),
};

/**
 * @param {Write} w
 * @returns {Refusal}
 */
const refusalOf = (w) =>
	/** @type {(w: Write) => Refusal} */ (REFUSALS[w.kind])(w);

/**
 * @param {Write} w
 * @param {CoreContext} ctx
 */
function route(w, ctx) {
	const own = ctx.tree().root;
	if (own !== ctx.root)
		return `Your session's worktree is ${own}: ${refusalOf(w).inOwn(own)}`;
	return `This session's working directory is the main checkout. \`cd\` into your own worktree under ${path.join(ctx.root, WORKTREES)}/ where you have one; where you have none, cut one with ${buildCutCommand(ctx.scriptPath)}, which prints its path. Work and commit there.`;
}

/**
 * @param {CoreContext} ctx
 * @returns {string | null}
 */
function refusalGround(ctx) {
	const cutOver = readCutOver(ctx.git);
	if (cutOver === null)
		ctx.log(
			"git could not read the main checkout's upstream — the cutover refusal skipped",
		);
	if (cutOver)
		return "The main checkout takes no edits or commits: its `main` follows `origin/main` by the levelling step's fast-forward alone, and any edit there is an uncommitted edit that refuses it (workflow-core#4229).";
	const cls = ctx.treeClass(ctx.fallbackCwd);
	if (cls === "unknown")
		ctx.log(
			"git could not say which tree holds the session's cwd — the worktree refusal skipped",
		);
	if (cls !== "linked") return null;
	return "A session in a linked worktree edits and commits only there: the claim and write stores key a write by the path in the writer's own tree, so one here goes unclaimed and unledgered, unseen by the turn-end uncommitted-work check (workflow-core#4697).";
}

/**
 * @param {string} subject
 * @param {CoreContext} ctx
 * @returns {Decision}
 */
function decide(subject, ctx) {
	try {
		const w = findWrite(subject, ctx);
		if (w === null) return null;
		const ground = refusalGround(ctx);
		if (ground === null) return null;
		const refusal = refusalOf(w);
		const text = `${refusal.what}: @CMD@\n\n${ground} ${route(w, ctx)} Gitignored stores under it stay writable${refusal.back(ctx.root)}.`;
		return { deny: denyText(ctx, refusal.cmd(subject), text) };
	} catch (e) {
		if (!(e instanceof GitUnanswered)) throw e;
		ctx.log(e.message);
		return null;
	}
}

module.exports = {
	field: ["command", "file_path", "notebook_path"],
	noun: "write",
	decide,
};
