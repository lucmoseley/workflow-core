#!/usr/bin/env node
/*
 * check-gh-route.js — every `gh` and `claude` call goes through its one route:
 * the binary's primitive in a Node program, lib/gh.js or lib/claude-bin.js;
 * "${WFC_GH:-gh}" or "${WFC_CLAUDE_BIN:-claude}" in a shell one; and in a test
 * a stub at that var (base §X2, §N7; #3455, #3559).
 *
 * Usage:
 *   node check-gh-route.js [--root <dir>] [--against <rev>] [--index] [--json] [--warn]
 *
 * LEXICAL, comments aside, over scripts/, .claude/skills/, .husky/ and
 * hooks/, shell files being those lib/formatters.js's shellFiles() names.
 * Four shapes, each per binary:
 *   - SECOND-VAR: a `WFC_<name>_GH`, `WFC_<name>_CLAUDE` or
 *     `WFC_<name>_CLAUDE_BIN` var, in any code file.
 *   - NODE-COPY: a non-test Node program spawning a literal `"gh"` or
 *     `"claude"`, or one other than the primitive reading its var off
 *     `process.env`.
 *   - SHELL-BARE: a shell line running the binary as a command — at a line's
 *     start, after `$(`, an unescaped backtick, `;`, `&`, `|`, `!`, a keyword,
 *     `command` or `timeout <n>` — or probing it with `command -v`, `type -P`
 *     or `which`.
 *   - PATH-STUB: a test or test support (lib/test-kind.js), or any `.ts`,
 *     prepending to PATH a directory it joins the binary's name onto, or one
 *     a local helper joins a parameter onto where a call passes that helper
 *     the binary's name first.
 *
 * THE OPT-OUT is a `gh-route-exempt: <why>` or `claude-route-exempt: <why>`
 * comment on the line or the line above. A shell line takes it where it names
 * the binary only as text, such as a message telling an agent what to run or a
 * wrapper in the user's own shell; a PATH line where it tests what a bare name
 * resolves to. A marker with no word after it is no marker.
 *
 * IMPLICIT:  on every commit staging a path under scripts/, .claude/skills/, .husky/ or hooks/, refuses any second `gh` or `claude` route in the tree, naming the file, line and the binary's var, with its primitive and exemplar where the shape has them.
 * JUSTIFIED: fail-safe — a `gh` call off WFC_GH escapes every test's stub and reaches the founder's live tracker, and a `claude` call off WFC_CLAUDE_BIN reads or launches his live sessions.
 * DEFEAT:    the `<binary>-route-exempt: <why>` marker; --warn caps findings below the gating line; a binary named through a variable; a PATH stub whose directory is spelt differently where it is joined and where it is prepended, or written by a helper taking the name after its first parameter or into a directory a call passes it, built with `/<binary>` in a string, or prepended by `join` or `+`; a stub in a tracked directory, whose name no line joins on; a shell call after a word this list does not name; a command-string spawn such as `execSync("gh …")`; a test's own literal spawn; Python, which reaches each binary through lib/wfc_bin.py.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { readWorktreeHead, shellFiles } = require("./lib/formatters.js");
const { judgeTree } = require("./lib/gh-route.js");
const { listTreeFiles, saySites } = require("./lib/heresy-scan.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */
const { runCheck } = require("./lib/check");

const ROOTS = ["scripts", ".claude/skills", ".husky", "hooks"];

runCheck({
	name: "gh-route",
	usage:
		"node check-gh-route.js [--root <dir>] [--against <rev>] [--index] [--json] [--warn]",
	valueFlags: ["--root"],
	against: {
		profile: "gh-route",
		materialise: "blobs",
		pathspecs: () => ROOTS,
	},
	run(/** @type {Ctx} */ ctx) {
		const rootFlag = ctx.value("--root");
		const root = path.resolve(rootFlag ?? hostRoot());
		const files = listTreeFiles(root, ROOTS).sort();
		/* A materialised tree's vendored marks are the index's .gitattributes,
		 * never an unstaged edit to it (#3687). */
		const shell = new Set(
			shellFiles(files, (rel) => readWorktreeHead(path.join(root, rel)), {
				cached: rootFlag !== null,
			}),
		);
		const { scanned, findings, fixes } = judgeTree(files, shell, (rel) =>
			fs.readFileSync(path.join(root, rel), "utf8"),
		);
		for (const f of findings)
			ctx.fail(f.tag, f.message, {
				file: f.file,
				line: f.line,
				match: f.match,
				bin: f.bin,
			});
		saySites(ctx, "second binary route(s)", fixes);
		return {
			okLine: `${scanned} file(s), every \`gh\` call on WFC_GH and every \`claude\` call on WFC_CLAUDE_BIN.`,
			noun: "second binary route(s)",
			count: ctx.findings.length,
			data: { scanned },
		};
	},
});
