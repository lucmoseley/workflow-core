/*
 * main-checkout-write.js — the dispatcher core that refuses a write to the
 * main checkout's tracked tree once it is cut over (#4248, spec #4229).
 *
 * DENY, not warn (mantahostels#103).
 *
 * WHAT IT REFUSES, with the `landing` module on and the main checkout cut
 * over (lib/cutover.js): a Write, Edit or NotebookEdit path, or a Bash write,
 * move or delete by any spelling lib/shell-parse.js's writeTargets reads,
 * resolving into the main checkout's own tree — not into a linked worktree
 * under it, not under `.git` — at a path git does not ignore, tracked or not;
 * and a git command that writes the main checkout's index, `HEAD` or files
 * (`WRITERS`); and an inline interpreter — `python3 -`, `node -e`, a
 * heredoc- or stdin-fed program — run from a directory in that tree, whose
 * targets live in another language's strings and cannot be read (#4469).
 * That refusal is a guess that the program writes, taken because its way
 * out — `cd` into the session's worktree and run it there — costs nothing.
 *
 * GITIGNORED STORES STAY WRITABLE: claims, markers, ledgers and scratch under
 * `.claude/` are what every session shares, and git ignores them.
 *
 * LIMITS
 *  - A target writeTargets does not read — `dd of=`, a script file writing
 *    on the session's behalf, an inline interpreter run from outside the
 *    main checkout naming a path in it — or one it cannot resolve is not
 *    seen; so is a command run outside Claude Code, and an interpreter whose
 *    cwd the walk loses, recorded; and an inline flag inlineInterp does not
 *    read — bundled (`python3 -uc`) or behind a valued flag (`python3 -W
 *    ignore -c`, `-W ignore -`) — so such a program is not refused (#4469).
 *    The pre-commit limb holds a
 *    commit made by any route.
 *  - A `git` that cannot answer for the path or the upstream allows the
 *    write, recorded (mantahostels#103 §6).
 *  - No override: this binds agent sessions only (mantahostels#109).
 */

const fs = require("node:fs");
const path = require("node:path");
const { buildCutCommand, readCutOver } = require("./cutover.js");
const { denyText } = require("./guard-verdict.js");
const {
	INTERPRETER,
	absolute,
	inlineInterp,
	literal,
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

class GitUnanswered extends Error {}

/**
 * @typedef {import("./guard-dispatch.js").CoreContext} CoreContext
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
	const rel = path.relative(ctx.root, abs) || (dir ? "." : "");
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
	if (rel === ".git" || rel.startsWith(`.git${path.sep}`)) return null;
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
 * Whether an interpreter's words read its program from stdin: a bare `-`
 * before the first word that is no flag.
 * @param {string[]} args
 */
function isStdinProgram(args) {
	for (const w of args) {
		if (w === "-") return true;
		if (!w.startsWith("-")) return false;
	}
	return false;
}

/**
 * The main-checkout directory an inline interpreter runs in, relative, else
 * null.
 * @param {import("./shell-parse.js").Command} cmd
 * @param {string[]} spans
 * @param {CoreContext} ctx
 * @returns {string | null}
 */
function interpreterDir(cmd, spans, ctx) {
	const words = cmd.words.map((w) => literal(w, spans).text);
	const prog = path.basename(words[0] ?? "");
	if (!INTERPRETER.test(prog)) return null;
	const args = words.slice(1);
	if (!inlineInterp(prog, args, cmd.redirects) && !isStdinProgram(args))
		return null;
	if (!cmd.cwd) {
		ctx.log(`the walk lost the cwd of an inline ${prog} — run unchecked`);
		return null;
	}
	return refusedPath(cmd.cwd, ctx, true);
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
		({ segment, sub, args }) => {
			if (!found && !READ_ONLY[sub]?.(args)) found = { git: segment };
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
			what: `This runs an inline program in the main checkout${at}, and what it writes cannot be read off the command`,
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
 * @param {string} subject
 * @param {CoreContext} ctx
 * @returns {Decision}
 */
function decide(subject, ctx) {
	if (!ctx.moduleOn("landing")) return null;
	try {
		const cutOver = readCutOver(ctx.git);
		if (cutOver === null)
			throw new GitUnanswered(
				"git could not read the main checkout's upstream — write allowed unchecked",
			);
		if (!cutOver) return null;
		const w = findWrite(subject, ctx);
		if (w === null) return null;
		const { what, cmd } = describe(w, subject);
		const text = `${what}: @CMD@\n\nThe main checkout takes no edits or commits: its \`main\` follows \`origin/main\` by the levelling step's fast-forward alone, and any edit there is an uncommitted edit that refuses it (#4229). ${route(w, ctx)} Gitignored stores under it stay writable.`;
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
