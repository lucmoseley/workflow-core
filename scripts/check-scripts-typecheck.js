#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { runCheck, errMessage } = require("./lib/check");
const { hostRoot } = require("./lib/host-root.js");
const { execGit } = require("./lib/git.js");

/** @typedef {import("./lib/check").Ctx} Ctx */

/** @typedef {{ path: string, lines: number }} Silenced */

const IN_SCOPE = [
	/^scripts\/.+\.js$/,
	/^\.claude\/skills\/[^/]+\/scripts\/[^/]+\.js$/,
];

const isInScope = (/** @type {string} */ p) =>
	IN_SCOPE.some((re) => re.test(p));

const NOCHECK = /^[ \t]*\/\/[ \t]*@ts-nocheck[ \t]*$/m;

const preamble = (/** @type {string} */ src) => {
	const out = [];
	let inBlock = false;
	for (const line of src.split("\n")) {
		const t = line.trim();
		if (inBlock) {
			out.push(line);
			if (t.includes("*/")) inBlock = false;
			continue;
		}
		if (t === "" || t.startsWith("#!") || t.startsWith("//")) {
			out.push(line);
			continue;
		}
		if (t.startsWith("/*")) {
			out.push(line);
			if (!t.includes("*/")) inBlock = true;
			continue;
		}
		break;
	}
	return out.join("\n");
};

const isSilenced = (/** @type {string} */ src) => NOCHECK.test(preamble(src));

const git = (
	/** @type {Ctx} */ ctx,
	/** @type {string} */ root,
	/** @type {string[]} */ args,
	/** @type {string} */ what,
) => {
	try {
		return execGit(args, {
			cwd: root,
			encoding: "utf8",
		});
	} catch (e) {
		return ctx.broken(`git ${args[0]} failed while ${what}: ${errMessage(e)}`);
	}
};

const nulList = (/** @type {string} */ out) => out.split("\0").filter(Boolean);

/**
 * @param {Ctx} ctx
 * @param {string} root
 * @returns {{paths: string[], silenced: Silenced[]}}
 */
const survey = (ctx, root) => {
	const paths = nulList(
		git(
			ctx,
			root,
			["ls-files", "-z", "--", "scripts", ".claude/skills"],
			"enumerating the tracked set",
		),
	).filter(isInScope);

	/** @type {Silenced[]} */
	const silenced = [];
	for (const p of paths) {
		let src;
		try {
			src = fs.readFileSync(path.join(root, p), "utf8");
		} catch (e) {
			return ctx.broken(
				`cannot read tracked file ${p} — often an unstaged delete; re-run: ${errMessage(e)}`,
			);
		}
		if (isSilenced(src))
			silenced.push({ path: p, lines: src.split("\n").length });
	}
	return { paths, silenced };
};

const warnSilenced = (
	/** @type {Ctx} */ ctx,
	/** @type {Silenced[]} */ silenced,
) => {
	for (const s of silenced)
		ctx.warn(
			"TYPECHECK-SILENCED",
			`${s.path} carries \`// @ts-nocheck\` — §N8: convert the file until tsc reads it clean, then drop the pragma`,
			{ path: s.path, lines: s.lines },
		);
};

runCheck({
	name: "scripts-typecheck",
	usage:
		"node check-scripts-typecheck.js [--full] [--notify] [--json] [--warn] [--root <dir>]",
	valueFlags: ["--root"],
	flags: ["--full"],
	run(/** @type {Ctx} */ ctx) {
		const root = ctx.value("--root") || hostRoot();
		const { paths, silenced } = survey(ctx, root);

		if (silenced.length === 0)
			return {
				okLine: `all ${paths.length} in-scope .js file(s) are type-checked; none carries \`// @ts-nocheck\`.`,
				noun: "scripts/ .js file(s) that have silenced the type checker",
				count: 0,
				data: { total: paths.length, silenced: [] },
			};

		ctx.say(
			`${silenced.length} of ${paths.length} in-scope .js file(s) carry ` +
				"`// @ts-nocheck`, so tsc reads nothing in them:",
		);
		for (const s of silenced)
			ctx.say(
				ctx.has("--full") ? `  ${s.path}  (${s.lines} lines)` : `  ${s.path}`,
			);

		warnSilenced(ctx, silenced);

		return {
			okLine: `all ${paths.length} in-scope .js file(s) are type-checked; none carries \`// @ts-nocheck\`.`,
			noun: "scripts/ .js file(s) that have silenced the type checker",
			count: silenced.length,
			data: { total: paths.length, silenced },
		};
	},
});
