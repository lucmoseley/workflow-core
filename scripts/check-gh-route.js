#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { worktreeRoot } = require("./lib/host-root.js");
const { readWorktreeHead, shellFiles } = require("./lib/formatters.js");
const { judgeTree } = require("./lib/gh-route.js");
const { listTreeFiles, saySites } = require("./lib/heresy-scan.js");
const { hasOwnGit } = require("./lib/tree-members.js");

/** @typedef {import("./lib/check").Ctx} Ctx */
const { runCheck } = require("./lib/check");

const ROOTS = ["scripts", ".claude/skills", ".husky", "hooks"];

/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
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
		const root = path.resolve(rootFlag ?? worktreeRoot());
		const files = listTreeFiles(root, ROOTS).sort();
		const isCheckout = hasOwnGit(root);
		const shell = new Set(
			shellFiles(files, (rel) => readWorktreeHead(path.join(root, rel)), {
				cached: !isCheckout,
				...(isCheckout ? { cwd: root } : {}),
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
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
