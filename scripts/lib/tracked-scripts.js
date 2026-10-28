/*
 * tracked-scripts.js — the tracked files under `scripts/` a checker reads, kept
 * to those its filter admits (#3131).
 *
 * check-guard-test-isolation.js, check-host-root-test-isolation.js and
 * check-git-fixture-identity.js each read this set, and differ only in the
 * filter.
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

/**
 * A root it cannot read, or any read error under it but a directory gone, is
 * the checker's BROKEN, never an empty set. A readable root with no `scripts/`
 * tracks none, so it lists none (#3387).
 * @param {Ctx} ctx
 * @param {string} root
 * @param {(rel: string) => boolean} keep
 */
function walkScripts(ctx, root, keep) {
	const out = /** @type {string[]} */ ([]);
	const reportUnreadable = (
		/** @type {string} */ at,
		/** @type {unknown} */ e,
	) =>
		ctx.broken(
			`could not read ${at}: ${errMessage(e)}. No scripts/ files read.`,
		);
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
			/* `scripts/` itself absent tracks nothing. A directory under it,
			 * listed by its parent then gone, is a parallel write in the tree
			 * with nothing under it to read (#3170). */
			if (rel !== "scripts")
				ctx.say(`${path.join(root, rel)} vanished mid-walk; read as empty.`);
			return [];
		}
	};
	const walk = (/** @type {string} */ rel) => {
		for (const e of list(rel).sort((a, b) => a.name.localeCompare(b.name))) {
			const child = `${rel}/${e.name}`;
			if (e.isDirectory()) walk(child);
			else if (keep(child)) out.push(child);
		}
	};
	walk("scripts");
	return out;
}

/**
 * The repo root and its tracked `scripts/` paths `keep` admits, repo-relative.
 * A git failure is the checker's BROKEN, never an empty set.
 * @param {Ctx} ctx
 * @param {(rel: string) => boolean} keep called with a `scripts/…` path
 */
function readTrackedScripts(ctx, keep) {
	const rootFlag = ctx.value("--root");
	if (rootFlag) {
		const root = path.resolve(rootFlag);
		return { root, files: walkScripts(ctx, root, keep) };
	}
	const git = (/** @type {string[]} */ args, /** @type {string} */ what) => {
		try {
			return execGit(args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			});
		} catch (e) {
			return ctx.broken(
				`git ${args[0]} failed while ${what}: ${errMessage(e)}. No scripts/ files read.`,
			);
		}
	};
	const root = git(
		["rev-parse", "--show-toplevel"],
		"locating the repo root",
	).trim();
	const files = git(["-C", root, "ls-files", "-z"], "listing tracked files")
		.split("\0")
		.filter((/** @type {string} */ p) => p.startsWith("scripts/") && keep(p));
	return { root, files };
}

module.exports = { readTrackedScripts };
