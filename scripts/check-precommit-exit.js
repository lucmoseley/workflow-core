#!/usr/bin/env node
/*
 * check-precommit-exit.js — a pre-commit line running a checker passes its
 * exit code on with `|| exit "$?"`, never `|| exit 1`, so BROKEN (2) never
 * reaches the committer as a finding (base §N4, #3456).
 *
 * Usage:
 *   node check-precommit-exit.js [--root <dir>] [--against <rev>] [--index] [--json] [--warn]
 *
 * LEXICAL. It reads `.husky/pre-commit` and `.husky/pre-commit.local` at the
 * root, joining backslash-continued lines. A BREACH is a line ending
 * `|| exit 1`, or ending `|| {` with an `exit 1` line before the block's `}`,
 * whose command before the `||` is a CHECKER: `node`, `bash` or `sh` running
 * a script file, or a `.js`, `.sh`, `.mjs` or `.cjs` path run directly, either
 * bare or as a plain assignment's `"$(...)"` holding no pipeline. An outside command is no checker: a binary such as gitleaks, or
 * inline code (`sh -c "$declared_command"`, `node -e`), whose exit alphabet is
 * not the plugin's.
 *
 * Also a BREACH: a checker line ending `|| y=...`, whose `case "$y" in`, with no
 * assignment to `y` between them, exits 1 from its own `*)` arm. A named arm is
 * left alone, as the checker's own answer, which may be a finding (#3808).
 *
 * IMPLICIT:  on every commit staging .husky/pre-commit or .husky/pre-commit.local, refuses a checker line in either exiting 1 on its failure, naming the file, line and the pre-commit gate primitive.
 * JUSTIFIED: fail-safe — `|| exit 1` turns a checker that could not run into a finding to fix.
 * DEFEAT:    --warn caps findings below the gating line; `if ! <checker>; then exit 1; fi`; a block exiting 1 on a line holding more than `exit 1`; a checker behind a shell function, a pipeline or a variable naming its interpreter; a substitution under `if`, `local` or `export`, or with a redirection after it; a fallback with a space or a comment in it, or `|| true`; a `case` spelt other than `case "$y" in`, `case "${y}" in` and `case "$y:$z" in` among them; a `(*)` arm; a `*)` arm exiting 1 on a line holding more than `exit 1`, or inside a nested `case`; a named arm catching what a crash prints.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { saySites } = require("./lib/heresy-scan.js");
const { FIX, parseBreaches } = require("./lib/precommit-exit.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */
const { runCheck } = require("./lib/check");

const FILES = [".husky/pre-commit", ".husky/pre-commit.local"];
runCheck({
	name: "precommit-exit",
	usage:
		"node check-precommit-exit.js [--root <dir>] [--against <rev>] [--index] [--json] [--warn]",
	valueFlags: ["--root"],
	against: {
		profile: "precommit-exit",
		materialise: "blobs",
		pathspecs: () => FILES,
	},
	run(/** @type {Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? hostRoot());
		const files = FILES.filter((rel) => fs.existsSync(path.join(root, rel)));
		for (const rel of files)
			for (const { line, text } of parseBreaches(
				fs.readFileSync(path.join(root, rel), "utf8"),
			))
				ctx.fail(
					"PRECOMMIT-EXIT",
					`${rel}:${line} exits 1 on a checker's failure, turning its BROKEN into a finding (\`${text}\`). Fix: ${FIX}`,
					{ file: rel, line, match: text },
				);
		saySites(ctx, "checker line(s) exit 1 on failure", [`Fix: ${FIX}`]);
		return {
			okLine: `${files.length} pre-commit file(s), every checker line passing its exit code on.`,
			noun: "checker line(s) exiting 1 on failure",
			count: ctx.findings.length,
			data: { scanned: files.length },
		};
	},
});
