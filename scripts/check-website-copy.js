#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { runCheck, errMessage } = require("./lib/check");
const { scanSource } = require("./lib/website-copy");
const { brandSheetPath } = require("./lib/workflow-core-config");
const { execGit } = require("./lib/git.js");

const SOURCE = /\.(ts|tsx|js|jsx|mdx)$/;

/** @typedef {import("./lib/check").Ctx} Ctx */

/**
 * @param {string | null} root
 * @param {string[]} roots
 * @returns {string[]}
 */
function readTrackedSources(root, roots) {
	const files = root
		? roots.flatMap((r) => walk(path.join(root, r), root))
		: git(["ls-files", "--", ...roots]).filter(
				(f) => !fs.lstatSync(f, { throwIfNoEntry: false })?.isSymbolicLink(),
			);
	return files.filter((f) => SOURCE.test(f));
}

/**
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
 * @param {string[]} args
 * @returns {string[]}
 */
function git(args) {
	try {
		return execGit(args, { encoding: "utf8" }).split("\n").filter(Boolean);
	} catch (e) {
		throw new Error(`git ${args.join(" ")} failed — ${errMessage(e)}`, {
			cause: e,
		});
	}
}

/**
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

/** @param {Ctx} ctx */
function refuseAbsoluteRoots(ctx) {
	for (const r of rootsOf(ctx))
		if (path.isAbsolute(r))
			ctx.usageError(`${r} is absolute; pass a repo-relative directory.`);
}

/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
	name: "website-copy",
	module: "site",
	usage:
		"node check-website-copy.js [<dir>…] [--root <dir>] [--against <rev>] [--json]",
	valueFlags: ["--root"],
	against: {
		profile: "website-copy",
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
			files = readTrackedSources(root, roots);
		} catch (e) {
			return ctx.broken(errMessage(e));
		}

		if (files.length === 0) {
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

		ctx.say(
			`\nThese are banned tells from ${brandSheetPath({ say: ctx.say })} §11 (Banned tells — website copy only). ` +
				"Rewrite the copy; do not reach for --no-verify, which the guard-commit-form core denies. " +
				"Repo docs and comments are out of scope and keep their em dashes.",
		);
		return { noun: "banned tell(s) in website copy", count: hits };
	},
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
