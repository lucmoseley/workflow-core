#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { runCheck } = require("./lib/check");
const { hostRoot } = require("./lib/host-root.js");
const { caught } = require("./lib/caught.js");
const { gitCommonDirOrThrow } = require("./lib/git.js");

// guess: no git operation here runs an hour; an editor-held lock can, workflow-core#1193
const STALE_GIT_LOCK_MS = 60 * 60 * 1000;

const SKIPPED = new Set(["refs/arbiter"]);
const LOOSE_OBJECTS = /^objects\/[0-9a-f]{2}$/;

/**
 * @param {string} common
 * @param {string} rel
 * @param {string[]} out
 */
function walk(common, rel, out) {
	let entries;
	try {
		entries = fs.readdirSync(path.join(common, rel), { withFileTypes: true });
	} catch (err) {
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

/** @param {import("./lib/check").Ctx} ctx */
function readCommonDir(ctx) {
	try {
		return gitCommonDirOrThrow(hostRoot());
	} catch (e) {
		const err = caught(e);
		if (err.code !== undefined) ctx.broken(`git could not run: ${err.message}`);
		const stderr = err.stderr ?? "";
		if (/not a git repository/i.test(stderr))
			ctx.skip("no git repository here, so there are no git locks to read.");
		ctx.broken(`git rev-parse failed: ${stderr.trim()}`);
	}
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
		const common = readCommonDir(ctx);
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
				return [];
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
