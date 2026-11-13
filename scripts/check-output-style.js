#!/usr/bin/env node
/*
 * check-output-style.js — name a declared `outputStyle` that matches no style
 * the harness can load (workflow-core#1944).
 *
 * Usage:  node scripts/check-output-style.js [--json]
 *         npm run status -- --only output-style
 *
 * WHY. A setting naming no style loads none, and nothing says so.
 *
 * WHAT COUNTS AS A STYLE: a built-in, a project or user style file, or one this
 * plugin ships. Another plugin's `<name>:` style is not enumerated, so it is
 * reported as unchecked, never as a miss.
 */

const fs = require("node:fs");
const path = require("node:path");
const { runCheck } = require("./lib/check");
const { hostRoot } = require("./lib/host-root.js");
const { resolveConfigDir } = require("./lib/plugin-state.js");
const { coreRoot } = require("./lib/script-path.js");
const {
	BUILT_IN_STYLES,
	readStylesIn,
	pluginOf,
	readPluginStyles,
} = require("./lib/output-styles.js");
const { caught } = require("./lib/caught.js");

/* The project-scoped settings files, in the harness's precedence: local wins. */
const SETTINGS = [".claude/settings.local.json", ".claude/settings.json"];

/**
 * @param {import("./lib/check").Ctx} ctx
 * @param {string} file
 * @returns {unknown}
 */
function readDeclaredStyle(ctx, file) {
	let text;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (err) {
		if (caught(err).code === "ENOENT") return;
		throw err;
	}
	try {
		return JSON.parse(text).outputStyle;
	} catch (err) {
		ctx.broken(`${file} does not parse: ${caught(err).message}`);
	}
}

runCheck({
	name: "output-style",
	usage: "node check-output-style.js [--json]",
	/** @param {import("./lib/check").Ctx} ctx */
	run(ctx) {
		const root = hostRoot();
		const declared = SETTINGS.map((file) => ({
			rel: file,
			style: readDeclaredStyle(ctx, path.join(root, file)),
		})).find((d) => d.style !== undefined && d.style !== null);
		if (!declared)
			ctx.skip("no project settings file declares an `outputStyle`.");
		const { rel, style } = declared;
		const shipped = readPluginStyles(coreRoot());
		const known = new Set([
			...BUILT_IN_STYLES,
			...readStylesIn(path.join(root, ".claude", "output-styles")),
			...readStylesIn(path.join(resolveConfigDir(), "output-styles")),
			...shipped.styles,
		]);
		const name = String(style);
		const plugin = pluginOf(name);
		const noun = "unknown output style(s)";
		if (known.has(name))
			return {
				okLine: `${rel} names "${name}", a style the harness loads.`,
				noun,
				count: 0,
			};
		if (plugin !== null && plugin !== shipped.plugin)
			return {
				okLine: `${rel} names "${name}", plugin ${plugin}'s, which this check does not read.`,
				noun,
				count: 0,
			};
		ctx.warn(
			"UNKNOWN-OUTPUT-STYLE",
			`${rel} names "${name}", which matches no style, so sessions here load none`,
			{ path: rel, style: name },
			rel,
		);
		ctx.say(
			`UNKNOWN-OUTPUT-STYLE — ${rel} sets "outputStyle": "${name}", and no style has that name, so every session here starts without one.\n` +
				`  This plugin ships: ${shipped.styles.join(", ")}. Set one of those, or a style in .claude/output-styles/.\n`,
		);
		return {
			noun,
			count: 1,
			data: { path: rel, style: name, shipped: shipped.styles },
		};
	},
});
