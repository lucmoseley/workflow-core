#!/usr/bin/env node
/*
 * pre-applypatch-refusal.js — the refusal .husky/pre-applypatch prints once
 * its secrets scan has not passed (mantahostels#1707): names the route,
 * `git am` or `git rebase --apply`, and the abort that clears it.
 *
 * Usage:
 *   node pre-applypatch-refusal.js <absolute git dir>
 *
 * Writes the refusal to STDOUT and exits 0. On any fault of its own it writes
 * nothing and exits 1.
 */

if (require.main === module) {
	try {
		const { parseOrCode } = require("./lib/cli-args.js");
		const { writeFd } = require("./lib/write-fd.js");
		const { commitRoute, scanRefusal } = require("./lib/commit-route.js");
		const parsed = parseOrCode(process.argv.slice(2), {
			usage: "node pre-applypatch-refusal.js <absolute git dir>",
			min: 1,
		});
		if (typeof parsed === "number") {
			process.exitCode = parsed || 1;
		} else {
			const route = commitRoute("pre-applypatch", parsed.positionals[0] ?? "");
			writeFd(1, scanRefusal("pre-applypatch", route));
			process.exitCode = 0;
		}
	} catch {
		/* Exit 1 says nothing printed: the hook then prints its own line that
		 * the route could not be named, and refuses the apply either way
		 * (mantahostels#1707). */
		process.exitCode = 1;
	}
}
