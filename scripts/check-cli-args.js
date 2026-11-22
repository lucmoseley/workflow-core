#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { hostRoot } = require("./lib/host-root.js");
const { stripComments } = require("./lib/strip-comments.js");

/** @typedef {import("./lib/check").Ctx} Ctx */
const { runCheck } = require("./lib/check");

const READS_ARGV = /process\.argv(?!\s*\[\s*[01]\s*\])/;
const USES_HELPER = /require\(\s*["']\.\/lib\/cli-args(?:\.js)?["']\s*\)/;
const UTIL_SPECIFIER = `["'](?:node:)?util["']`;
const PARSE_ARGS = new RegExp(
	[
		String.raw`\{[^{}]*\bparseArgs\b[^{}]*\}\s*=\s*require\(\s*${UTIL_SPECIFIER}\s*\)`,
		String.raw`import\s*\{[^{}]*\bparseArgs\b[^{}]*\}\s*from\s*${UTIL_SPECIFIER}`,
		String.raw`require\(\s*${UTIL_SPECIFIER}\s*\)\.parseArgs\b`,
	].join("|"),
);
const UTIL_NAMESPACE = new RegExp(
	String.raw`\butil\s*=\s*require\(\s*${UTIL_SPECIFIER}\s*\)|import\s+(?:\*\s+as\s+)?util\s+from\s*${UTIL_SPECIFIER}`,
);
const UTIL_PARSE_ARGS = /\butil\.parseArgs\s*\(/;
const LAX_PARSE_ARGS = /\bstrict\s*:\s*false\b/;
const COMMANDER = /require\(\s*["']commander["']\s*\)|from\s*["']commander["']/;
const LAX_COMMANDER = /\ballowUnknownOption\s*\(/;
const EXEMPT = /cli-args-exempt:\s*(?:\w|#\d)/;

const WHY =
	"read(s) the command line without a strict parser, so --help and an unknown flag fall through to the default action";
const FIX =
	"parse it with node:util's parseArgs, strict unless told `strict: false` (declare a `help` option to answer --help), or with this repo's lib/cli-args.js where it has one; or mark it `cli-args-exempt: #N` (#920, #1532).";

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

/** @type {import("./lib/check").CheckSpec} */
const SPEC = {
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
};

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
