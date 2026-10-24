#!/usr/bin/env node
/*
 * format-on-write.js — formats one file a tool just wrote, if it is shell or
 * Python (workflow-core#1332): scripts/post-write.sh's step 1, beside Biome.
 *
 * Usage:
 *   node scripts/format-on-write.js <file>
 *
 * Run from the host root, which post-write.sh has already checked holds the
 * file. Prints `shell` where the file is in the shellcheck set, which
 * post-write.sh answers with `rule:shell-lint-blind`, and nothing else. Exits 0
 * on every path, a missing formatter or an unparseable file included: it is
 * convenience, and .husky/pre-commit's format gate is what refuses.
 *
 * cli-args-exempt: a hook's helper, which parseOrExit's exit 2 on an unknown
 * flag would break.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
	RUFF,
	formatShell,
	loadShfmt,
	ruffConfigArgs,
	ruffExcludeArgs,
	shellFiles,
	worktreeHead,
} = require("./lib/formatters");

/** @param {string} rel */
function isShell(rel) {
	try {
		return shellFiles([rel], worktreeHead).length > 0;
	} catch {
		return false; // git unreadable: left as written, for the gate to judge.
	}
}

const file = process.argv[2];
if (file) {
	const rel = path.relative(process.cwd(), path.resolve(file));
	if (isShell(rel)) {
		process.stdout.write("shell\n");
		const format = loadShfmt();
		try {
			const source = fs.readFileSync(file, "utf8");
			const out = format && formatShell(format, source, rel);
			if (out && out !== source) fs.writeFileSync(file, out);
		} catch {
			// Unparseable or unreadable: left as written, for the gate to name.
		}
	} else if (rel.endsWith(".py")) {
		spawnSync(
			RUFF,
			[
				"format",
				...ruffConfigArgs(),
				...ruffExcludeArgs(() => {
					/* a write hook stays silent: the commit gate names an unread exclude */
				}),
				"--",
				rel,
			],
			{ stdio: "ignore" },
		);
	}
}
