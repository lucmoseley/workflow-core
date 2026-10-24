#!/usr/bin/env node
/*
 * check-website-copy.js — the gate on the brand sheet's §11 banned tells. The
 * sheet is the host's `brandSheetPath`, else docs/brand-sheet.md (#452).
 *
 * Usage:
 *   node check-website-copy.js [<dir>…] [--root <dir>] [--against <rev>] [--json]
 *   (default: app)
 *
 * §11 bans a manner of writing; the *Banned tells* list under it bans strings,
 * because a manner ban cannot stop "Velmora serves as Ostria's hub, showcasing a
 * vibrant tapestry of surf culture" — every word of that passes the register
 * test. This scans the copy strings in `app/` for the half of that list a
 * regex can judge, and gates on them (mantahostels#858).
 *
 * FAIL, not WARN: unlike check-retired-vocabulary.js, which reports drift across
 * a corpus nobody is editing, this scans a handful of files a session is
 * actively writing, and every hit has a mechanical fix. The list is fixed rather
 * than data-driven for the same reason — there is nothing here to tune away.
 *
 * Which tells are covered and which are left to the eye: scripts/lib/website-copy.js.
 * Scope is `app/` and read from git, so an untracked scratch file is ignored by
 * design. Test files under app/ are in scope — a test asserting a copy string
 * has to carry the same string the copy does.
 *
 * `--against HEAD` is the .husky/pre-commit path (mantahostels#1834). The whole root is
 * scanned at both revisions and only what the commit adds refuses it —
 * lib/check.js's header. `--root <dir>` is how the re-exec points this at a
 * materialised revision, and the only reason it exists.
 */

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { runCheck, errMessage } = require("./lib/check");
const { scanSource } = require("./lib/website-copy");
const { brandSheetPath } = require("./lib/workflow-core-config");

const SOURCE = /\.(ts|tsx|js|jsx|mdx)$/;

/** @typedef {import("./lib/check").Ctx} Ctx */

/**
 * Source files under `roots`, repo-relative: git's tracked set in the ordinary
 * case, and a walk of `root` under `--root`, where the tree has already been
 * materialised by `git ls-tree` and holds nothing untracked to exclude.
 *
 * Throws when git will not enumerate them, which the caller turns into BROKEN.
 *
 * @param {string | null} root
 * @param {string[]} roots
 * @returns {string[]}
 */
function trackedSources(root, roots) {
	const files = root
		? roots.flatMap((r) => walk(path.join(root, r), root))
		: git(["ls-files", "--", ...roots]).filter(
				(f) => !fs.lstatSync(f, { throwIfNoEntry: false })?.isSymbolicLink(),
			);
	return files.filter((f) => SOURCE.test(f));
}

/**
 * Every file under `dir`, as paths relative to `root`. An absent directory is
 * empty rather than an error: a materialised revision holds only the paths that
 * revision carries.
 *
 * A SYMLINK IS SKIPPED, NOT FOLLOWED (mantahostels#1940), and `trackedSources` drops one on
 * the git side too, so report mode and gate mode scan the same set. `readdir`
 * does not resolve one, so following it counts a linked source file's tells
 * twice and reads a linked directory as a file. Escaping the root is not among
 * the reasons: lib/check.js refuses that symlink when it materialises the tree,
 * before this ever runs.
 *
 * @param {string} dir
 * @param {string} root
 * @returns {string[]}
 */
function walk(dir, root) {
	/** @type {import("node:fs").Dirent[]} */
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.flatMap((e) => {
		if (e.isSymbolicLink()) return [];
		const at = path.join(dir, e.name);
		return e.isDirectory() ? walk(at, root) : [path.relative(root, at)];
	});
}

/**
 * Run git, or throw. Every failure here is the apparatus, never the subject.
 *
 * @param {string[]} args
 * @returns {string[]}
 */
function git(args) {
	try {
		return execFileSync("git", args, { encoding: "utf8" })
			.split("\n")
			.filter(Boolean);
	} catch (e) {
		throw new Error(`git ${args.join(" ")} failed — ${errMessage(e)}`, {
			cause: e,
		});
	}
}

/**
 * One file's bytes, out of whichever tree this run was pointed at.
 *
 * @param {string | null} root
 * @param {string} file
 * @returns {string}
 */
function readSource(root, file) {
	return fs.readFileSync(root ? path.join(root, file) : file, "utf8");
}

/**
 * @param {Ctx} ctx
 * @returns {string[]}
 */
const rootsOf = (ctx) => (ctx.args.length > 0 ? ctx.args : ["app"]);

/**
 * An absolute root is a usage error, not a finding.
 *
 * Under `--against` the parent re-execs this file and never calls run() itself,
 * so this runs from the spec's refuse() as well (mantahostels#1940).
 *
 * @param {Ctx} ctx
 */
function refuseAbsoluteRoots(ctx) {
	for (const r of rootsOf(ctx))
		if (path.isAbsolute(r))
			ctx.usageError(`${r} is absolute; pass a repo-relative directory.`);
}

runCheck({
	name: "website-copy",
	module: "site",
	usage:
		"node check-website-copy.js [<dir>…] [--root <dir>] [--against <rev>] [--json]",
	valueFlags: ["--root"],
	against: {
		profile: "website-copy",
		/* The scan scope IS the roots below, so there is nothing to discover by
		 * walking a whole extracted tree — MATERIALISERS in lib/check.js. */
		materialise: "blobs",
		refuse: refuseAbsoluteRoots,
		pathspecs: rootsOf,
	},
	run(/** @type {Ctx} */ ctx) {
		const root = ctx.value("--root");
		const roots = rootsOf(ctx);
		refuseAbsoluteRoots(ctx);

		/** @type {string[]} */
		let files;
		try {
			files = trackedSources(root, roots);
		} catch (e) {
			return ctx.broken(errMessage(e));
		}

		if (files.length === 0) {
			/* Under --root an empty set is the ordinary case: the same roots fed the
			 * materialisation, so nothing to scan means the REVISION carries no
			 * source under them — a fact about the tree, and one both sides read the
			 * same way. Without it the roots are the caller's own words, an empty set
			 * means they named nothing — a typo, or a directory that moved — and a
			 * gate that goes green over scope it never looked at is exactly what
			 * BROKEN exists to prevent (lib/check.js). CI runs the default root, so
			 * that is the live risk.
			 *
			 * OK rather than SKIP, deliberately: a SKIP on the <rev> side is BROKEN
			 * under --against's fail-closed rule, which would refuse the very commit
			 * that CREATES app/ with a tell in it instead of reporting the tell. */
			if (root)
				return {
					okLine: `this revision carries no source file under ${roots.join(", ")}.`,
				};
			return ctx.broken(
				`no tracked source files under ${roots.join(", ")} — nothing was scanned. ` +
					"Check the directory name.",
			);
		}

		let hits = 0;
		for (const file of files) {
			/** @type {string} */
			let source;
			try {
				source = readSource(root, file);
			} catch (e) {
				return ctx.broken(`cannot read ${file} — ${errMessage(e)}`);
			}
			for (const hit of scanSource(source)) {
				hits++;
				ctx.fail(
					hit.tag,
					`${file}:${hit.line} ${hit.tag}: ${JSON.stringify(hit.match)} in "${hit.context}"`,
					{ file, line: hit.line, match: hit.match, context: hit.context },
				);
				ctx.say(
					`${file}:${hit.line}  ${hit.tag}  ${JSON.stringify(hit.match)}`,
				);
				ctx.say(`    ${hit.context}`);
				ctx.say(`    ${hit.fix}`);
			}
		}

		if (hits === 0)
			return { okLine: `${files.length} file(s) clean of §11's banned tells.` };

		/* The host's config, never --root's tree: the re-exec keeps the host's
		 * working directory, as skipUnlessModuleOn's read does (lib/check.js). */
		ctx.say(
			`\nThese are banned tells from ${brandSheetPath({ say: ctx.say })} §11 (Banned tells — website copy only). ` +
				"Rewrite the copy; do not reach for --no-verify, which guard-commit-form.sh denies. " +
				"Repo docs and comments are out of scope and keep their em dashes.",
		);
		return { noun: "banned tell(s) in website copy", count: hits };
	},
});
