#!/usr/bin/env node
/*
 * check-shfmt.js — shfmt over the tracked shell, for CI and by hand (#1332).
 *
 * Usage:
 *   node scripts/check-shfmt.js [--write] [<path>…]
 *
 * Checks by default, failing on each file shfmt would change; --write
 * rewrites them instead. No paths means every tracked shell file, as
 * lib/formatters.js's shellFiles() picks them (#1828).
 * A missing shfmt or an unreadable path is BROKEN (#1354).
 */

const fs = require("node:fs");
const { runCheck } = require("./lib/check");
const {
	loadShfmt,
	shellFinding,
	readTrackedShellFiles,
} = require("./lib/formatters");
const { caught } = require("./lib/caught.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */

/**
 * The paths named on the command line, else every tracked shell file.
 * @param {Ctx} ctx
 */
function readTargetFiles(ctx) {
	if (ctx.args.length > 0) return ctx.args;
	try {
		return readTrackedShellFiles();
	} catch (e) {
		return ctx.broken(caught(e).message);
	}
}

runCheck({
	name: "shfmt",
	usage: "node scripts/check-shfmt.js [--write] [<path>…]",
	flags: ["--write"],
	run(/** @type {Ctx} */ ctx) {
		const write = ctx.has("--write");
		const files = readTargetFiles(ctx);

		const format = loadShfmt();
		if (!format)
			ctx.broken("@wasm-fmt/shfmt is not installed — run npm install.");

		let formatted = 0;
		for (const f of files) {
			let source;
			try {
				source = fs.readFileSync(f, "utf8");
			} catch (e) {
				ctx.broken(`cannot read ${f}: ${caught(e).message}`);
			}
			const finding = shellFinding(format, source, f);
			if (!finding) continue;
			if (write && finding.tag === "UNFORMATTED") {
				fs.writeFileSync(f, finding.out);
				formatted++;
				continue;
			}
			ctx.fail(finding.tag, `${f}: ${finding.message}`, { path: f });
			ctx.say(`${f}: ${finding.message}`);
		}

		const failed = ctx.findings.length;
		if (failed > 0) {
			if (!write) ctx.say("Fix: node scripts/check-shfmt.js --write <path>.");
			return { noun: `of ${files.length} file(s) failed`, count: failed };
		}
		return {
			okLine: write
				? `${formatted} of ${files.length} file(s) rewritten`
				: `${files.length} file(s) shfmt-formatted`,
		};
	},
});
