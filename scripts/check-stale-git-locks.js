#!/usr/bin/env node
/*
 * check-stale-git-locks.js — name every lock in the git common dir that has
 * outlived any git that could still hold it (workflow-core#1193).
 *
 * Usage:  node scripts/check-stale-git-locks.js [--json]
 *         npm run status -- --only git-locks
 *
 * WHY. A git killed mid-write — earlyoom, a VM shutdown, a hook timeout —
 * leaves its `.lock` behind, and nothing says so.
 *
 * REPORTS, NEVER REMOVES. A lock here can belong to a live git in the
 * founder's own terminal — a `git commit` waiting on its editor holds
 * `index.lock` for as long as the editor is open. `refs/arbiter/` is skipped:
 * the arbiter is that namespace's sole writer, and its own sweep removes aged
 * locks there (lib/arbiter-sweep.js, STALE_REF_LOCK_MS).
 *
 * Loose-object directories are not walked: git writes no lock inside them,
 * and they hold the bulk of the store's files. `objects/pack` is — a
 * `multi-pack-index.lock` lands there.
 *
 * Not on SessionStart: the status surface is where the other repo-health
 * readings live.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { runCheck } = require("./lib/check");
const { hostRoot } = require("./lib/host-root.js");
const { caught } = require("./lib/caught.js");

/** No git operation here runs an hour; an editor-held `index.lock` can. */
const STALE_GIT_LOCK_MS = 60 * 60 * 1000;

const SKIPPED = new Set(["refs/arbiter"]);
const LOOSE_OBJECTS = /^objects\/[0-9a-f]{2}$/;

/**
 * @param {string} common
 * @param {string} rel
 * @param {string[]} out accumulator: each lock file's path is pushed here
 */
function walk(common, rel, out) {
	let entries;
	try {
		entries = fs.readdirSync(path.join(common, rel), { withFileTypes: true });
	} catch (err) {
		// Vanished mid-walk is git moving on; unreadable is BROKEN, never "no locks".
		if (caught(err).code === "ENOENT") return;
		throw err;
	}
	for (const e of entries) {
		const child = rel ? `${rel}/${e.name}` : e.name;
		if (e.isDirectory()) {
			if (!SKIPPED.has(child) && !LOOSE_OBJECTS.test(child))
				walk(common, child, out);
		} else if (e.name.endsWith(".lock")) out.push(child);
	}
}

/**
 * The git common dir, absolute. Outside a repository is SKIP, the subject being
 * absent; git failing any other way is BROKEN, git being the apparatus.
 * @param {import("./lib/check").Ctx} ctx
 */
function commonDir(ctx) {
	const res = spawnSync(
		"git",
		["rev-parse", "--path-format=absolute", "--git-common-dir"],
		{ cwd: hostRoot(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	);
	if (res.error) ctx.broken(`git could not run: ${res.error.message}`);
	if (res.status === 0) return res.stdout.trim();
	if (/not a git repository/i.test(res.stderr))
		ctx.skip("no git repository here, so there are no git locks to read.");
	ctx.broken(`git rev-parse failed: ${res.stderr.trim()}`);
}

/** @param {number} ms */
function formatAge(ms) {
	const h = ms / 3_600_000;
	return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
}

runCheck({
	name: "stale-git-locks",
	usage: "node check-stale-git-locks.js [--json]",
	run(ctx) {
		const common = commonDir(ctx);
		/** @type {string[]} */
		const locks = [];
		walk(common, "", locks);
		locks.sort();
		const now = Date.now();
		const stale = locks.flatMap((rel) => {
			try {
				const ms = now - fs.statSync(path.join(common, rel)).mtimeMs;
				return ms > STALE_GIT_LOCK_MS ? [{ rel, ms }] : [];
			} catch {
				return []; // released between the walk and the stat
			}
		});
		for (const { rel, ms } of stale)
			ctx.warn(
				"STALE-GIT-LOCK",
				`${path.join(common, rel)} is ${formatAge(ms)} old`,
				{ path: rel, ageMs: Math.round(ms) },
				rel,
			);
		if (stale.length > 0)
			ctx.say(
				`STALE-GIT-LOCK — ${stale.length} lock(s) in ${common} older than an hour:\n` +
					stale
						.map(({ rel, ms }) => `    ${rel}  (${formatAge(ms)})\n`)
						.join("") +
					"  A git killed mid-write leaves these, and they fail gc, reflog expiry or the ref they guard.\n" +
					"  Check no git is running (`pgrep -a git`, and any terminal mid-commit), then `rm` each.\n" +
					"  Nothing was removed; this check only reports.\n",
			);
		return {
			okLine: `no lock older than an hour among ${locks.length} in ${common}.`,
			noun: "stale git lock(s)",
			count: stale.length,
			data: { common, locks: locks.length, stale: stale.length },
		};
	},
});
