#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { worktreeRoot } = require("./lib/host-root.js");
const { requiredGroup } = require("./lib/regex-group");
const {
	BLANKS,
	JS_COMMENT,
	LINE_START,
	headerOf,
} = require("./lib/script-header.js");

/** @typedef {import("./lib/check").Ctx} Ctx */
const { runCheck } = require("./lib/check");

const HAND_CALLER = new RegExp(
	String.raw`${LINE_START}(?:(?:${JS_COMMENT}|#)${BLANKS})?(Callers?(?: of [^:\n]*)?:.*)$`,
	"gim",
);
const SCOPE =
	/^(?:scripts\/|\.claude\/skills\/[^/]+\/scripts\/)[\w./-]+\.(?:[cm]?[jt]sx?|sh|bash|py)$/;
const ROOTS = ["scripts", ".claude/skills"];

/**
 * @param {string} root
 * @returns {string[]}
 */
function scriptsUnder(root) {
	/** @type {string[]} */
	const out = [];
	/** @param {string} rel */
	const walk = (rel) => {
		const abs = path.join(root, rel);
		if (!fs.existsSync(abs)) return;
		for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
			const child = `${rel}/${entry.name}`;
			if (entry.isDirectory() && entry.name !== "node_modules") walk(child);
			else if (entry.isFile() && SCOPE.test(child)) out.push(child);
		}
	};
	for (const rel of ROOTS) walk(rel);
	return out.sort();
}

/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
	name: "hand-callers",
	usage:
		"node check-hand-callers.js [--root <dir>] [--against <rev>] [--json] [--warn]",
	valueFlags: ["--root"],
	against: {
		profile: "hand-callers",
		materialise: "blobs",
		pathspecs: () => ROOTS,
	},
	run(/** @type {Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? worktreeRoot());
		if (!fs.existsSync(root))
			ctx.broken(`the root ${root} does not exist — nothing was read`);
		const files = scriptsUnder(root);
		for (const rel of files) {
			/** @type {Map<string, number>} */
			const seen = new Map();
			const header = headerOf(
				rel,
				fs.readFileSync(path.join(root, rel), "utf8"),
			);
			for (const m of header.matchAll(HAND_CALLER)) {
				const line = header.slice(0, m.index).split("\n").length;
				const match = requiredGroup(m, 1, HAND_CALLER).trim();
				const nth = (seen.get(match) ?? 0) + 1;
				seen.set(match, nth);
				const message =
					`${rel}:${line}  ${match} — a hand-kept caller list goes stale on every caller edit (workflow-core#4404). ` +
					"Delete the line; `git grep` names the callers. A module built ahead of its caller names it on an `Unbuilt caller: <caller> (#N)` line instead.";
				ctx.fail("HAND-CALLER", message, { file: rel, match, nth, line });
				ctx.say(`  ${message}`);
			}
		}
		return {
			okLine: `${files.length} script header(s), none keeping a caller list by hand.`,
			noun: "hand-kept caller line(s)",
			count: ctx.findings.length,
			data: { scripts: files.length },
		};
	},
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
