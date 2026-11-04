/*
 * main-checkout-write.js — the dispatcher core that refuses a write to the
 * main checkout's tracked tree once it is cut over (#4248, spec #4229).
 *
 * Why: under the worktree model the main checkout's `main` follows
 * `origin/main` by a fast-forward alone (lib/level-main.js), and any edit
 * there is the dirt that refuses it. Each session edits and commits in its
 * own worktree, so a write here has no legitimate use: DENY, not warn
 * (mantahostels#103).
 *
 * WHAT IT REFUSES, with the `landing` module on and the main checkout cut
 * over (lib/cutover.js): a Write, Edit or NotebookEdit path, or a Bash write,
 * move or delete by any spelling lib/shell-parse.js's writeTargets reads,
 * resolving into the main checkout's own tree — not into a linked worktree
 * under it, not under `.git` — at a path git does not ignore, tracked or not,
 * since an untracked file blocks a fast-forward as an edit does; and a git
 * command that writes the main checkout's index, `HEAD` or files
 * (`WRITERS`). The refusal names the session's worktree as the route, or the
 * cut where the session stands in the main checkout itself.
 *
 * GITIGNORED STORES STAY WRITABLE: claims, markers, ledgers and scratch under
 * `.claude/` are what every session shares, and git ignores them.
 *
 * LIMITS
 *  - A target writeTargets does not read — `dd of=`, a heredoc body, a script
 *    writing on the session's behalf — or one it cannot resolve is not seen;
 *    so is a command run outside Claude Code. The pre-commit limb holds a
 *    commit made by any route.
 *  - A `git` that cannot answer for the path or the upstream allows the
 *    write, recorded (mantahostels#103 §6).
 *  - No override: this binds agent sessions only (mantahostels#109).
 */

const fs = require("node:fs");
const path = require("node:path");
const { readCutOver } = require("./cutover.js");
const { denyText } = require("./guard-verdict.js");
const { absolute } = require("./shell-words.js");
const { parseCommand, walkCommands, walkGit } = require("./shell-parse.js");

/* git verbs that write a work tree's index, HEAD or files; each read-only
 * form is in READ_ONLY. */
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
 * The nearest directory at or above `p` that exists.
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
 * null.
 * @param {string} p absolute
 * @param {CoreContext} ctx
 * @returns {string | null}
 */
function refusedPath(p, ctx) {
	const abs = path.resolve(p);
	const rel = path.relative(ctx.root, abs);
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
 * What the call writes in the main checkout: a path, a git command, or
 * nothing.
 * @param {string} subject
 * @param {CoreContext} ctx
 * @returns {{ rel: string } | { git: string } | null}
 */
function findWrite(subject, ctx) {
	if (ctx.tool !== "Bash") {
		const rel = refusedPath(absolute(subject, ctx.fallbackCwd), ctx);
		return rel === null ? null : { rel };
	}
	const parsed = parseCommand(subject);
	/** @type {{ rel: string } | { git: string } | null} */
	let found = null;
	walkCommands(
		parsed,
		(cmd) => {
			for (const t of cmd.writeTargets()) {
				if (found || !t.path) continue;
				const rel = refusedPath(t.path, ctx);
				if (rel !== null) found = { rel };
			}
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
 * The route: the session's worktree, or the cut where it stands in the main
 * checkout.
 * @param {{ rel: string } | { git: string }} w
 * @param {CoreContext} ctx
 */
function route(w, ctx) {
	const own = ctx.tree().root;
	if (own !== ctx.root)
		return "rel" in w
			? `Your session's worktree is ${own}: make the edit there, at ${path.join(own, w.rel)}.`
			: `Your session's worktree is ${own}: run it there, as \`git -C ${own} …\`.`;
	return `This session stands in the main checkout itself. Cut a worktree of your own with \`node ${ctx.scriptPath("session-checkout.js")} cut <session-name>\`, which prints its path, and work and commit there.`;
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
		const what =
			"rel" in w
				? `This writes ${w.rel} in the main checkout`
				: "This git command writes the main checkout's index, HEAD or files";
		const text = `${what}: @CMD@\n\nThe main checkout takes no edits or commits: its \`main\` follows \`origin/main\` by the levelling step's fast-forward alone, and any edit there is dirt that refuses it (#4229). ${route(w, ctx)} Gitignored stores under it stay writable.`;
		return {
			deny: denyText(ctx, "rel" in w ? subject : w.git, text),
		};
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
