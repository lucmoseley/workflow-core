#!/usr/bin/env node
/*
 * check-husky-shim.js — report a canonical checkout whose husky shim has lost
 * #3138's own-tree lookup (#3172), or whose core.hooksPath is off the absolute
 * path install-hooks.js pins, which leaves a fresh linked worktree no git hook
 * to run (#3819).
 *
 * Usage:  node scripts/check-husky-shim.js [--notify] [--json]
 *
 * husky rewrites `.husky/_/h` to its stock form every time it runs, so an
 * `npm install` where package.json predates #3138 (the main checkout while its
 * `main` is behind `landing`, #3106) silently sends every worktree's commit
 * and push back to the main checkout's hook copy (#3125). husky run bare
 * does that and writes core.hooksPath relative too (#3819).
 */

const { runCheck } = require("./lib/check");
const { gitCommonDir, gitOutcome } = require("./lib/git.js");
const { readShim, shimPaths } = require("./lib/husky-shim.js");
const { scriptPath } = require("./lib/script-path.js");

runCheck({
	name: "husky-shim",
	usage: "node check-husky-shim.js [--notify] [--json]",
	run(ctx) {
		const commonDir =
			gitCommonDir(process.cwd()) ?? ctx.skip("not in a git checkout.");
		const { hooks, shim } = shimPaths(commonDir);
		const { state } = readShim(shim);
		if (state === "absent")
			return ctx.skip(`husky wrote no ${shim} — HUSKY=0, or no install yet.`);

		const rerun = `node ${scriptPath("install-hooks.js")}`;
		if (state === "stock") {
			const message = `${shim} is husky's stock shim, so every worktree's commit and push runs the canonical checkout's hook copy (#3138). Run: ${rerun}`;
			ctx.fail("STOCK-SHIM", message, { shim });
			ctx.say(`STOCK-SHIM — ${message}\n`);
		}
		if (state === "unknown") {
			const message = `${shim} carries neither husky's lookup nor the own-tree one (#3138), so an upgraded husky changed its shim. Read it and update HUSKY_LOOKUP in ${scriptPath("lib/husky-shim.js")}, then run: ${rerun}`;
			ctx.fail("UNKNOWN-SHIM", message, { shim });
			ctx.say(`UNKNOWN-SHIM — ${message}\n`);
		}
		const pinned = gitOutcome(["config", "--get", "core.hooksPath"], [1]);
		if (!pinned.ok) return ctx.broken(`git config: ${pinned.why}`);
		const hooksPath = pinned.out.trim();
		if (hooksPath !== hooks) {
			const message = `core.hooksPath reads "${hooksPath}", not ${hooks}, so a linked worktree whose tree has no such directory runs no git hook, and its commit takes neither the review hold nor a Review-Tier: trailer (mantahostels#344). Run: ${rerun}`;
			ctx.fail("UNPINNED-HOOKS-PATH", message, { hooksPath, hooks });
			ctx.say(`UNPINNED-HOOKS-PATH — ${message}\n`);
		}
		return {
			okLine:
				"the canonical checkout's husky shim and core.hooksPath run each worktree's own hooks.",
			noun: "husky shim fault(s)",
			data: { shim },
		};
	},
});
