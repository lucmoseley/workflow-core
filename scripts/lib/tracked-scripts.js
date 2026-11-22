const fs = require("node:fs");
const path = require("node:path");
const { execGit } = require("./git.js");
const { errMessage } = require("./check.js");
const { caught } = require("./caught.js");

/** @typedef {import("./check.js").Ctx} Ctx */

const noneRead = (/** @type {string} */ top) =>
	top ? `No ${top}/ files read.` : "No files read.";

/**
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
	const list = (/** @type {string} */ rel) => {
		try {
			return fs.readdirSync(path.join(root, rel), { withFileTypes: true });
		} catch (e) {
			if (caught(e).code !== "ENOENT")
				return reportUnreadable(path.join(root, rel), e);
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

/** @param {Ctx} ctx @param {(rel: string) => boolean} keep @param {string} [top] */
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
