#!/usr/bin/env node
/*
 * check-hand-callers.js — refuses a script header line keeping a caller list
 * by hand: `Caller:`, `Callers:` or `Callers of …:`, which `git grep` answers
 * instead (workflow-core#4720, workflow-core#4885).
 *
 * Usage:
 *   node check-hand-callers.js [--root <dir>] [--against <rev>] [--json] [--warn]
 *
 * SCOPE is a JS, TS, shell or Python script under `scripts/` or a skill's
 * `scripts/`, test files included. `Unbuilt caller: <caller> (#N)`, naming the
 * caller a module was built ahead of, is not a caller list.
 *
 * IMPLICIT:  on every commit staging a script under scripts/ or a skill's scripts/, refuses one whose header gains a Caller: line, naming the file and line.
 * JUSTIFIED: fail-safe — the fix is deleting one comment line, and a line that lands costs a re-anchor on every later caller edit (workflow-core#4404).
 * DEFEAT:    --warn caps findings below the gating line.
 */

const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { requiredGroup } = require("./lib/regex-group");
const {
	BLANKS,
	JS_COMMENT,
	LINE_START,
	headerOf,
} = require("./lib/script-header.js");

/** @typedef {import("./lib/check").Ctx} Ctx */
const { runCheck } = require("./lib/check");

/** The marker is optional: a header is all comment, a docstring included. */
const HAND_CALLER = new RegExp(
	String.raw`${LINE_START}(?:(?:${JS_COMMENT}|#)${BLANKS})?(Callers?(?: of [^:\n]*)?:.*)$`,
	"gim",
);
const SCOPE =
	/^(?:scripts\/|\.claude\/skills\/[^/]+\/scripts\/)[\w./-]+\.(?:[cm]?[jt]sx?|sh|bash|py)$/;
const ROOTS = ["scripts", ".claude/skills"];

/**
 * Every in-scope file under `root`, repo-relative and sorted. A symlink is
 * vendored, and under --against it lands dangling, so both modes skip it.
 *
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

runCheck({
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
		const root = path.resolve(ctx.value("--root") ?? hostRoot());
		if (!fs.existsSync(root))
			ctx.broken(`the host root ${root} does not exist — nothing was read`);
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
				/* A copy of an inherited line is a new fault, not the same one. */
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
});
