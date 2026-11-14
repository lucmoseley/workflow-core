#!/usr/bin/env node
/*
 * pre-applypatch-refusal.js — the refusal .husky/pre-applypatch prints once
 * its secrets scan has not passed (mantahostels#1707): names the route,
 * `git am` or `git rebase --apply`, and the abort that clears it, the text
 * lib/commit-route.js's scanRefusal spells.
 *
 * Usage:
 *   node pre-applypatch-refusal.js <absolute git dir>
 *
 * Writes the refusal to STDOUT and exits 0: exit 0 means "printed", which is
 * how the hook tells a refusal said from a printer that would not load. On
 * any fault of its own it writes nothing and exits 1, and the hook prints its
 * one line saying the route could not be named; the hook refuses the apply
 * either way. It never runs on a passing scan, so a clean apply starts no
 * node.
 */

const fs = require("node:fs");

if (require.main === module) {
	try {
		const { parseOrCode } = require("./lib/cli-args.js");
		const { commitRoute, scanRefusal } = require("./lib/commit-route.js");
		const parsed = parseOrCode(process.argv.slice(2), {
			usage: "node pre-applypatch-refusal.js <absolute git dir>",
			min: 1,
		});
		if (typeof parsed === "number") {
			process.exitCode = parsed || 1;
		} else {
			const route = commitRoute("pre-applypatch", parsed.positionals[0] ?? "");
			fs.writeSync(1, scanRefusal("pre-applypatch", route));
			process.exitCode = 0;
		}
	} catch {
		process.exitCode = 1;
	}
}
