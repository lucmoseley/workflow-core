#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { worktreeRoot } = require("./lib/host-root.js");
const { saySites } = require("./lib/heresy-scan.js");
const { FIX_LINE, judgeHook } = require("./lib/precommit-exit.js");

/** @typedef {import("./lib/check").Ctx} Ctx */
const { runCheck } = require("./lib/check");

const FILES = [".husky/pre-commit", ".husky/pre-commit.local"];
/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
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
		const root = path.resolve(ctx.value("--root") ?? worktreeRoot());
		const files = FILES.filter((rel) => fs.existsSync(path.join(root, rel)));
		for (const rel of files)
			for (const { line, match, message } of judgeHook(
				rel,
				fs.readFileSync(path.join(root, rel), "utf8"),
			))
				ctx.fail("PRECOMMIT-EXIT", message, { file: rel, line, match });
		saySites(ctx, "checker line(s) exit 1 on failure", [FIX_LINE]);
		return {
			okLine: `${files.length} pre-commit file(s), every checker line passing its exit code on.`,
			noun: "checker line(s) exiting 1 on failure",
			count: ctx.findings.length,
			data: { scanned: files.length },
		};
	},
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
