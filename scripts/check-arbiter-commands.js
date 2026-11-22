#!/usr/bin/env node

const {
	parseLineSites,
	parseMatchSites,
	heresySpec,
} = require("./lib/heresy-scan.js");
const { runCheck } = require("./lib/check");
const { exemptMarker } = require("./lib/exempt-markers.js");

const ARBITER = "session-arbiter\\.js";
const NODE = "node +(?:--?[\\w=.-]+ +)*";
const NODE_ARBITER = `${NODE}(?:["']?\\S*${ARBITER}["']?|\\$\\{\\w*[Aa][Rr][Bb][Ii][Tt][Ee][Rr]\\w*\\})`;
const TOKEN = "[\\w<>./#:=-]";
const ARGUMENTS = `(?: +(?:"[^"\\n]*"|${TOKEN}+))*`;
const TAG = "buildArbiterCommand";
const QUOTE = "[\"'`]";
const HAND_SPELT = new RegExp(
	[
		`(?:scriptPath|corePath)\\(\\s*${QUOTE}(?:\\./|scripts/)?${ARBITER}${QUOTE}\\s*\\)`,
		`${NODE_ARBITER}${ARGUMENTS} +["']?${TOKEN}*\\$\\{`,
		`${NODE_ARBITER}${ARGUMENTS} ${QUOTE}\\s*\\+`,
		`${TAG}\`[^\`]*\\$\\{\\s*shellQuote\\(`,
	].join("|"),
	"g",
);
const LITERAL_PATH = new RegExp(
	`${NODE}["']?(?:\\.{1,2}/)*(?:scripts/)?${ARBITER}`,
);
const EXEMPT = exemptMarker("arbiter-literal");
const BUILDER = "scripts/lib/build-arbiter-command.js";

const FIX = `print it through ${TAG} from ${BUILDER}, its words bare, as scripts/lib/tracker-ops.js does: \${${TAG}\`release \${path}\`}`;

/** @param {import("./lib/heresy-scan.js").Program} program */
function findHandSpelt(program) {
	const withWord = parseMatchSites(program, HAND_SPELT);
	const wordLines = new Set(withWord.map((site) => site.line));
	const literal = parseLineSites(
		program,
		(line, i) => LITERAL_PATH.test(line) && !wordLines.has(i + 1),
		EXEMPT,
	);
	return [...withWord, ...literal];
}

/** @type {import("./lib/check").CheckSpec} */
const SPEC = heresySpec({
	name: "arbiter-commands",
	skip: [BUILDER],
	breaches: [
		{
			tag: "HAND-SPELT",
			sites: findHandSpelt,
			message: (rel, site) =>
				`${rel}:${site.line} spells an arbiter command by hand (\`${site.text}\`). Fix: ${FIX}`,
		},
	],
	summary: { phrase: "spell an arbiter command by hand", fix: FIX },
	finish(_ctx, scanned) {
		return {
			okLine: `${scanned} program(s), no arbiter command spelt by hand but a marked literal.`,
			noun: "hand-spelt arbiter command(s)",
		};
	},
});

module.exports = { SPEC };
if (require.main === module) runCheck(SPEC);
