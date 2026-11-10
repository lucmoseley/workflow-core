/*
 * main-checkout-write.js — the dispatcher core that refuses a write to the
 * main checkout's tracked tree once it is cut over (#4248, spec #4229), and
 * from a session in a linked worktree whether it is cut over or not (#4697).
 *
 * DENY, not warn (mantahostels#103).
 *
 * THE WORKTREE REFUSAL HOLDS WITH `landing` OFF TOO. A session whose cwd is
 * the main checkout keeps writing there until the cutover.
 *
 * WHAT IT REFUSES, from a linked-worktree session or with the `landing`
 * module on and the main checkout cut over (lib/cutover.js): a Write, Edit or NotebookEdit
 * path, or a Bash write,
 * move or delete by any spelling lib/shell-parse.js's writeTargets reads,
 * resolving into the main checkout's own tree — not into a linked worktree
 * under it, not under `.git` — at a path git does not ignore, tracked or not;
 * and a git command that writes the main checkout's index, `HEAD` or files
 * (`WRITERS`), save a restore of named tracked files to HEAD (`RESTORES`),
 * which only removes dirt and which the refusal names as the way out of it;
 * and an interpreter lib/shell-words.js's programSource reads run from a
 * directory in
 * that tree whose program is no existing file — `python3 -`, `node -e`,
 * `bash -c`, a piped or heredoc-fed program, through any wrapper lib/
 * shell-words.js's unwrap strips — since what it writes lives in another
 * language's strings and cannot be read (#4469). That refusal is a guess
 * that the program writes, taken because its way out — `cd` into the
 * session's worktree and run it there — costs nothing. `python3 -m` names no
 * file, so is refused too, as is a valued flag programSource does not list
 * whose value is no file (#4479).
 *
 * GITIGNORED STORES STAY WRITABLE: claims, markers, ledgers and scratch under
 * `.claude/` are what every session shares, and git ignores them.
 *
 * LIMITS
 *  - A target writeTargets does not read — `dd of=`, a script file writing
 *    on the session's behalf, an inline interpreter run from outside the
 *    main checkout naming a path in it — or one it cannot resolve is not
 *    seen; so is a command run outside Claude Code; an interpreter whose cwd
 *    the walk loses (`cd "$X"`, `pushd`), recorded; one run from a gitignored
 *    directory under the main checkout, which may still write `../` into
 *    its tree; and one behind a launcher unwrap does not strip (`uv run`).
 *    Once it is cut over, the pre-commit limb holds a commit made by any
 *    route; before, a worktree session's commit there by a route this does
 *    not read is held by nothing.
 *  - A `git` that cannot answer for the path allows the write, recorded
 *    (mantahostels#103 §6); one that cannot read the upstream leaves only the
 *    worktree refusal standing, recorded.
 *  - A worktree session is told by the payload's cwd, so one whose shell
 *    has `cd`'d into the main checkout writes there unrefused before the
 *    cutover. Its stores then key by the main checkout, and the turn-end
 *    reads judge it, until it `cd`s back before the turn ends (#4697).
 *  - No override: this binds agent sessions only (mantahostels#109).
 */

const fs = require("node:fs");
const path = require("node:path");
const { caught } = require("./caught.js");
const { buildCutCommand, readCutOver } = require("./cutover.js");
const { denyText } = require("./guard-verdict.js");
const { isUnder, relativeUnder } = require("./is-under.js");
const { lastLineTerminator } = require("./line-terminators.js");
const {
	absolute,
	literal,
	programSource,
	unwrap,
} = require("./shell-words.js");
const { parseCommand, walkCommands, walkGit } = require("./shell-parse.js");

/* git verbs that write a work tree's index, HEAD or files. */
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
 * A source naming HEAD, the only tree a restore here may take a file back to.
 * @param {string | undefined} s
 */
const atHead = (s) => s === "HEAD" || s === "@";

/**
 * A pathspec naming one file: no `.`, directory, glob, pathspec magic or
 * quoted word the parser leaves unread (`\u0001`), so a restore cannot sweep
 * a tree's dirt wholesale.
 * @param {string} p
 * @param {string} tree the directory git resolves `p` against
 */
function namesOneFile(p, tree) {
	if (p === "" || p.startsWith(":") || p.includes("\u0001") || /[*?[]/.test(p))
		return false;
	try {
		return !fs.statSync(path.resolve(tree, p)).isDirectory();
	} catch (err) {
		/* A deleted tracked file is the one file a restore brings back. Any
		 * other fault cannot tell a file from a directory, so the word does
		 * not earn the restore exemption (#4229 review). */
		return caught(err).code === "ENOENT";
	}
}

/**
 * The source a `git restore` word names, or null where the word names none;
 * `-s` may close a cluster (`-Ws HEAD`) or carry its value (`-sHEAD`).
 * @param {string} w
 * @param {() => string | undefined} next the following word, consumed
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
 * What follows the first `s` of a short-option cluster, as `/^-[^-]*?s(.*)$/`
 * reads it, or null: that `s` lies after the word's last line break, as `.`
 * crosses none, and no `-` comes before it. Read by index: the regex
 * would re-read the tail from every `s` (#4109).
 * @param {string} w
 * @returns {string | null}
 */
function shortClusterRest(w) {
	if (!w.startsWith("-")) return null;
	const s = w.indexOf("s", Math.max(1, lastLineTerminator(w) + 1));
	return s === -1 || w.slice(1, s).includes("-") ? null : w.slice(s + 1);
}

/**
 * Taking named tracked files back to HEAD: the one write that only removes
 * dirt from the main checkout, so the refusal names it as the way out
 * (#4449). The source must be HEAD by name — a bare restore takes the index,
 * which may hold a staged write.
 * @type {Record<string, (args: string[], tree: string) => boolean>}
 */
const RESTORES = {
	checkout: (a, tree) => {
		const dash = a.indexOf("--");
		const paths = a.slice(dash + 1);
		return (
			dash === 1 &&
			atHead(a[0]) &&
			paths.length > 0 &&
			paths.every((p) => namesOneFile(p, tree))
		);
	},
	restore: (a, tree) => {
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
			paths.every((p) => namesOneFile(p, tree))
		);
	},
};

class GitUnanswered extends Error {}

/**
 * @typedef {import("./core-contract.js").CoreContext} CoreContext
 * @typedef {import("./guard-entry.js").Decision} Decision
 */

/**
 * @param {string} p
 */
function existingDir(p) {
	let d = p;
	while (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) {
		const up = path.dirname(d);
		if (up === d) return d;
		d = up;
	}
	return d;
}

/**
 * `p` relative to the main checkout where a write to it is refused, else
 * null; "." for the main checkout itself where `dir` allows it.
 * @param {string} p absolute
 * @param {CoreContext} ctx
 * @param {boolean} [dir] `p` is a working directory, not a target
 * @returns {string | null}
 */
function refusedPath(p, ctx, dir = false) {
	const abs = path.resolve(p);
	const under = relativeUnder(ctx.root, abs);
	const rel = under === "" && dir ? "." : under;
	if (!rel || isUnder(rel, [".git"], path.sep)) return null;
	const cls = ctx.treeClass(existingDir(abs));
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
 * The main-checkout directory an interpreter runs in, relative, where its
 * program is no existing file, else null.
 * @param {import("./shell-parse.js").Command} cmd
 * @param {string[]} spans
 * @param {CoreContext} ctx
 * @returns {string | null}
 */
function interpreterDir(cmd, spans, ctx) {
	const words = unwrap(cmd.words, spans).words.map(
		(w) => literal(w, spans).text,
	);
	const prog = path.basename(words[0] ?? "");
	const program = programSource(prog, words.slice(1));
	if (!program) return null;
	if (!cmd.cwd) {
		ctx.log(`the walk lost the cwd of a ${prog} — run unchecked`);
		return null;
	}
	if (program.script && isFile(path.resolve(cmd.cwd, program.script)))
		return null;
	return refusedPath(cmd.cwd, ctx, true);
}

/** @param {string} p */
function isFile(p) {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

/**
 * @typedef {{ rel: string } | { git: string } | { interp: string, dir: string }}
 *   Write
 */

/**
 * @param {string} subject
 * @param {CoreContext} ctx
 * @returns {Write | null}
 */
function findWrite(subject, ctx) {
	if (ctx.tool !== "Bash") {
		const rel = refusedPath(absolute(subject, ctx.fallbackCwd), ctx);
		return rel === null ? null : { rel };
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
				if (rel !== null) found = { rel };
			}
			if (found) return;
			const dir = interpreterDir(cmd, parsed.spans, ctx);
			if (dir !== null) found = { interp: cmd.segment, dir };
		},
		{ ...ctx, bareRedirects: true },
	);
	if (found) return found;
	walkGit(
		parsed,
		({ segment, sub, args, tree }) => {
			if (!found && !READ_ONLY[sub]?.(args) && !RESTORES[sub]?.(args, tree))
				found = { git: segment };
		},
		ctx,
		{ subs: WRITERS, noun: "main-checkout write", scope: "shared" },
	);
	return found;
}

/**
 * @param {Write} w
 * @param {CoreContext} ctx
 */
function route(w, ctx) {
	const own = ctx.tree().root;
	if (own !== ctx.root) {
		if ("interp" in w)
			return `Your session's worktree is ${own}: \`cd\` there and run it, with every path it writes inside it.`;
		return "rel" in w
			? `Your session's worktree is ${own}: make the edit there, at ${path.join(own, w.rel)}.`
			: `Your session's worktree is ${own}: run it there, as \`git -C ${own} …\`.`;
	}
	/* The payload's cwd, not the session's launch directory: a session cut
	 * into a worktree that has since `cd`'d into the main checkout lands here
	 * too, so the text sends it to a worktree it may already have. */
	return `This session's working directory is the main checkout. \`cd\` into your own worktree under ${path.join(ctx.root, ".claude", "worktrees")}/ where you have one; where you have none, cut one with ${buildCutCommand(ctx.scriptPath)}, which prints its path. Work and commit there.`;
}

/**
 * The refusal's opening clause, and the command text it quotes.
 * @param {Write} w
 * @param {string} subject
 */
function describe(w, subject) {
	if ("interp" in w) {
		const at = w.dir === "." ? "" : `, at ${w.dir}`;
		return {
			what: `This runs an interpreter on a program that is no file, in the main checkout${at}, and what it writes cannot be read off the command`,
			cmd: w.interp,
		};
	}
	if ("rel" in w)
		return { what: `This writes ${w.rel} in the main checkout`, cmd: subject };
	return {
		what: "This git command writes the main checkout's index, HEAD or files",
		cmd: w.git,
	};
}

/**
 * Why the main checkout takes no write from this session, or null where it
 * takes them.
 * @param {CoreContext} ctx
 * @returns {string | null}
 */
function refusalGround(ctx) {
	if (ctx.moduleOn("landing")) {
		const cutOver = readCutOver(ctx.git);
		if (cutOver === null)
			ctx.log(
				"git could not read the main checkout's upstream — the cutover refusal skipped",
			);
		if (cutOver)
			return "The main checkout takes no edits or commits: its `main` follows `origin/main` by the levelling step's fast-forward alone, and any edit there is an uncommitted edit that refuses it (#4229).";
	}
	if (ctx.treeClass(ctx.tree().root) !== "linked") return null;
	return "A session in a linked worktree edits and commits only there: the claim and write stores key a write by the path in the writer's own tree, so one here goes unclaimed and unledgered, unseen by the turn-end uncommitted-work check (#4697).";
}

/**
 * @param {string} subject
 * @param {CoreContext} ctx
 * @returns {Decision}
 */
function decide(subject, ctx) {
	try {
		const ground = refusalGround(ctx);
		if (ground === null) return null;
		const w = findWrite(subject, ctx);
		if (w === null) return null;
		const { what, cmd } = describe(w, subject);
		const back =
			"rel" in w
				? `, and a tracked file already dirtied there goes back to HEAD with \`git -C ${ctx.root} restore --source=HEAD --staged --worktree -- ${w.rel}\``
				: "";
		const text = `${what}: @CMD@\n\n${ground} ${route(w, ctx)} Gitignored stores under it stay writable${back}.`;
		return { deny: denyText(ctx, cmd, text) };
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
