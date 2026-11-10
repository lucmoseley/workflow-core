/*
 * tracked-scripts.js — the tracked files under `scripts/` a checker reads, kept
 * to those its filter admits (workflow-core#3131), or under the whole repo where the checker
 * names `""` as its top.
 *
 * check-guard-test-isolation.js, check-host-root-test-isolation.js and
 * check-git-fixture-identity.js each read the `scripts/` set, and differ only
 * in the filter; check-test-env-writes.js reads the whole repo's (workflow-core#4019).
 *
 * `--root` walks the filesystem. That tree is a `git archive HEAD` extraction
 * (mantahostels#1753), so the walk answers what `git ls-files` would. Not
 * `ls-files` itself: a temp dir is not a git repo.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execGit } = require("./git.js");
const { errMessage } = require("./check.js");
const { caught } = require("./caught.js");

/** @typedef {import("./check.js").Ctx} Ctx */

/** The BROKEN line's tail: what the failure left unread. */
const noneRead = (/** @type {string} */ top) =>
	top ? `No ${top}/ files read.` : "No files read.";

/**
 * A root it cannot read, or any read error under it but a directory gone, is
 * the checker's BROKEN, never an empty set. A readable root with no `top`
 * tracks none, so it lists none (workflow-core#3387).
 * @param {Ctx} ctx
 * @param {string} root
 * @param {(rel: string) => boolean} keep
 * @param {string} top
 */
function walkScripts(ctx, root, keep, top) {
	const out = /** @type {string[]} */ ([]);
	const reportUnreadable = (
		/** @type {string} */ at,
		/** @type {unknown} */ e,
	) => ctx.broken(`could not read ${at}: ${errMessage(e)}. ${noneRead(top)}`);
	try {
		fs.readdirSync(root);
	} catch (e) {
		return reportUnreadable(root, e);
	}
	/** `rel`'s entries, or none where it is gone. */
	const list = (/** @type {string} */ rel) => {
		try {
			return fs.readdirSync(path.join(root, rel), { withFileTypes: true });
		} catch (e) {
			if (caught(e).code !== "ENOENT")
				return reportUnreadable(path.join(root, rel), e);
			/* `top` itself absent tracks nothing. A directory under it,
			 * listed by its parent then gone, is a parallel write in the tree
			 * with nothing under it to read (workflow-core#3170). */
			if (rel !== top)
				ctx.say(`${path.join(root, rel)} vanished mid-walk; read as empty.`);
			return [];
		}
	};
	const walk = (/** @type {string} */ rel) => {
		for (const e of list(rel).sort((a, b) => a.name.localeCompare(b.name))) {
			const child = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) walk(child);
			else if (keep(child)) out.push(child);
		}
	};
	walk(top);
	return out;
}

/**
 * The repo root and its tracked paths under `top` that `keep` admits,
 * repo-relative. A git failure is the checker's BROKEN, never an empty set.
 * @param {Ctx} ctx
 * @param {(rel: string) => boolean} keep called with a repo-relative path
 * @param {string} [top] the directory read, `""` for the whole repo
 */
function readTrackedScripts(ctx, keep, top = "scripts") {
	const rootFlag = ctx.value("--root");
	if (rootFlag) {
		const root = path.resolve(rootFlag);
		return { root, files: walkScripts(ctx, root, keep, top) };
	}
	const git = (/** @type {string[]} */ args, /** @type {string} */ what) => {
		try {
			return execGit(args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e) {
			return ctx.broken(
				`git ${args[0]} failed while ${what}: ${errMessage(e)}. ${noneRead(top)}`,
			);
		}
	};
	const root = git(
		["rev-parse", "--show-toplevel"],
		"locating the repo root",
	).trim();
	const files = git(["-C", root, "ls-files", "-z"], "listing tracked files")
		.split("\0")
		.filter(
			(/** @type {string} */ p) =>
				(top === "" || p.startsWith(`${top}/`)) && keep(p),
		);
	return { root, files };
}

module.exports = { readTrackedScripts };
