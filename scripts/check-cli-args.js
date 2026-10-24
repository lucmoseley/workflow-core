#!/usr/bin/env node
/*
 * check-cli-args.js — every top-level scripts/*.js that reads its command line
 * reads it through a strict parser (#920, #1532).
 *
 * Usage:
 *   node check-cli-args.js [--root <dir>] [--against <rev>] [--json] [--warn]
 *
 * A strict parser refuses an unknown flag before any work. Three pass: the
 * core's own lib/cli-args.js; `node:util`'s `parseArgs`, unless called with
 * `strict: false`; and commander, unless told `allowUnknownOption`. Any other
 * parser takes the opt-out marker below: yargs, for one, is lax by default.
 *
 * DIRECTION-GATED, NEVER WHOLE-REPO: ~77 core scripts predated the helper, and
 * each conforms when next edited.
 * `.husky/pre-commit` runs this under `--against HEAD`, so a script a commit
 * adds or edits outside a strict parser refuses and an untouched one warns.
 * EDITED is what the finding's `content` hash buys: it is part of the fault's
 * identity (checker-new-faults.js's `cli-args` profile), so any change to the
 * file reads as a new fault. Not in the scheduled sweeps, where the inherited
 * set would hold it red.
 *
 * LEXICAL. A script "reads argv" where `process.argv` appears outside a
 * comment and is not `process.argv[0]` or `[1]`, its own path, or where it
 * imports `parseArgs` or commander, each of which reads argv unasked. A
 * `parseArgs` counts only imported from `node:util`: many scripts hand-roll a
 * function of that name. A `strict: false` or `allowUnknownOption(` anywhere
 * in the file reads as a lax parse, even one meant for something else. A
 * runCheck checker reads argv inside lib/check.js,
 * so it is unseen here; lib/check.js refuses its unknown flags itself (#938).
 *
 * THE OPT-OUT is a `cli-args-exempt: <why>` comment, for a pass-through
 * wrapper whose argv is not its own, or a parser this check cannot read. A
 * marker with no word after it is no marker.
 *
 * cli-args-exempt: its messages name process.argv; its own argv is runCheck's.
 *
 * IMPLICIT:  on every commit staging a scripts/*.js, refuses one this commit adds or edits that reads its command line without a strict parser, naming the file.
 * JUSTIFIED: fail-safe — a script that ignores an unknown flag runs its side effect on `--help`; the fix is one strict parse call.
 * DEFEAT:    the `cli-args-exempt: <why>` marker; --warn caps findings below the gating line; a lax option the lexical scan cannot see, such as a `strict` set from a variable; a lax parse in a file whose other parser is strict.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { stripComments } = require("./lib/strip-comments.js");

/** @typedef {import("./lib/check").CheckContext} Ctx */
const { runCheck } = require("./lib/check");

const READS_ARGV = /process\.argv(?!\s*\[\s*[01]\s*\])/;
const USES_HELPER = /require\(\s*["']\.\/lib\/cli-args(?:\.js)?["']\s*\)/;
const UTIL_SPECIFIER = `["'](?:node:)?util["']`;
const PARSE_ARGS = new RegExp(
	[
		String.raw`\{[^}]*\bparseArgs\b[^}]*\}\s*=\s*require\(\s*${UTIL_SPECIFIER}\s*\)`,
		String.raw`import\s*\{[^}]*\bparseArgs\b[^}]*\}\s*from\s*${UTIL_SPECIFIER}`,
		String.raw`require\(\s*${UTIL_SPECIFIER}\s*\)\.parseArgs\b`,
	].join("|"),
);
/* `util.parseArgs(` counts only where `util` is node:util's: a local ./util
 * may export a hand-rolled one. */
const UTIL_NAMESPACE = new RegExp(
	String.raw`\butil\s*=\s*require\(\s*${UTIL_SPECIFIER}\s*\)|import\s+(?:\*\s+as\s+)?util\s+from\s*${UTIL_SPECIFIER}`,
);
const UTIL_PARSE_ARGS = /\butil\.parseArgs\s*\(/;
const LAX_PARSE_ARGS = /\bstrict\s*:\s*false\b/;
const COMMANDER = /require\(\s*["']commander["']\s*\)|from\s*["']commander["']/;
const LAX_COMMANDER = /\ballowUnknownOption\s*\(/;
const EXEMPT = /cli-args-exempt:\s*\w/;

const WHY =
	"read(s) the command line without a strict parser, so --help and an unknown flag fall through to the default action";
const FIX =
	"parse it with node:util's parseArgs, strict unless told `strict: false` (declare a `help` option to answer --help), or with this repo's lib/cli-args.js where it has one; or mark it `cli-args-exempt: <why>` (#920, #1532).";

/** @param {string} source */
function isFault(source) {
	const body = stripComments(source);
	const importsParseArgs =
		PARSE_ARGS.test(body) ||
		(UTIL_NAMESPACE.test(body) && UTIL_PARSE_ARGS.test(body));
	const importsCommander = COMMANDER.test(body);
	const onStrictParser =
		USES_HELPER.test(body) ||
		(importsParseArgs && !LAX_PARSE_ARGS.test(body)) ||
		(importsCommander && !LAX_COMMANDER.test(body));
	const readsArgv =
		READS_ARGV.test(body) || importsParseArgs || importsCommander;
	return readsArgv && !onStrictParser && !EXEMPT.test(source);
}

runCheck({
	name: "cli-args",
	usage:
		"node check-cli-args.js [--root <dir>] [--against <rev>] [--json] [--warn]",
	valueFlags: ["--root"],
	against: {
		profile: "cli-args",
		materialise: "blobs",
		pathspecs: () => ["scripts"],
	},
	run(/** @type {Ctx} */ ctx) {
		const root = path.resolve(ctx.value("--root") ?? hostRoot());
		const dir = path.join(root, "scripts");
		/* No scripts/ is zero scripts, not SKIP: a SKIP on the HEAD side of
		 * --against is BROKEN, which would refuse the first script ever added. */
		const names = fs.existsSync(dir)
			? fs
					.readdirSync(dir)
					.filter((n) => n.endsWith(".js"))
					.sort()
			: [];
		/** @type {string[]} */
		const faulted = [];
		for (const name of names) {
			const at = path.join(dir, name);
			const source = fs.readFileSync(at, "utf8");
			if (!isFault(source)) continue;
			const rel = `scripts/${name}`;
			faulted.push(name);
			ctx.fail("CLI-ARGS", `${rel} ${WHY}. Fix: ${FIX}`, {
				file: rel,
				content: crypto.createHash("sha256").update(source).digest("hex"),
			});
		}
		/* One line, not one per script: under --against every commit staging a
		 * script prints this report, inherited faults included. The
		 * parent re-lists a fault this commit adds in full. */
		if (faulted.length > 0)
			ctx.say(
				`  ${faulted.length} script(s) ${WHY}: ${faulted.join(", ")}.\n  Fix: ${FIX}`,
			);
		return {
			okLine: `${names.length} script(s), every argv reader on a strict parser.`,
			noun: "script(s) reading argv without a strict parser",
			count: ctx.findings.length,
			data: { scanned: names.length },
		};
	},
});
