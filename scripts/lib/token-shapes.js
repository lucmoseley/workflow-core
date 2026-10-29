/*
 * token-shapes.js — the credential shapes a scratch writer masks before a
 * session log's text reaches a file other sessions read (#1031). One list, so
 * a later reader reuses it rather than restating it; the gitleaks pre-commit
 * scan keeps its own rules.
 *
 * EACH SHAPE CARRIES A MINIMUM-LENGTH BODY, so prose sharing a prefix
 * ("task-notification", "sk-learn", a short `hf_` name) is left alone. The
 * minima sit under each vendor's real length — chosen, not measured against a
 * corpus. Only an `sk-` prefix must not follow a letter or digit, so "risk-…"
 * never reads as a key — unless that character closes an escape (`%3D`,
 * `\u0022`), which hides the separator a log's encoding replaced (#3394). The
 * other prefixes plus their minimum bodies never occur mid-word, so they take
 * no lead and no escape can hide them (#3540).
 *
 * A TERMINAL CONTROL SEQUENCE IS TRANSPARENT after a token's first character,
 * since `grep --color` puts one wherever its pattern ends (#3540, #3547,
 * #3549). A body stops before another shape's whole minimum token that its
 * own characters cannot spell, so back-to-back tokens are each masked.
 *
 * RESIDUALS: a token of a vendor not listed passes unmasked, and so do an
 * AWS secret access key (no prefix tells it from any 40-character string) and
 * an `sk-` body holding no digit in its first 300 characters — the digit is
 * what tells a key from a long hyphenated word. An `sk-` token after an
 * escape `ESCAPES` does not list, such as quoted-printable's `=3D`, passes
 * too. An escaped letter or digit (`%41`) counts as a lead, over-masking. A
 * control sequence with a URL-encoded intermediate byte (`%1B%28B`) still
 * splits a token, since `%2X` overlaps re-encoding's `%25` and leaves two
 * readings. So do a URL-encoded OSC (`%1B%5D8%3B`), an OSC whose body spells
 * ESC or BEL (`%07`, a Windows path's `\a` or `\e`) or runs past 4096
 * characters, and an ESC after more than 64 backslashes. A body character
 * after an OSC's closing `ESC \` that spells an escaped ESC with its `\`
 * (`\e`, `\U0000001b`) is read as one, taking the characters after it as
 * that sequence's, so a token near its minimum can pass (#3549).
 */

/**
 * The source for a URL-encoded byte at any depth of re-encoding.
 * @param {string} hex the byte's hex digits, a class allowed
 */
const buildUrlEncoded = (hex) => `%(?:25)*${hex}`;

/* ESC and BEL, raw, URL-encoded or in any common escaped spelling, the
 * backslash doubled up to six times over (a stringified `cat -v` or Python
 * repr, #3549). An unbounded run overflows the regex stack on a
 * multi-megabyte one; six doublings is a guess, not measured. */
const BACKSLASHES = String.raw`\\{1,64}`;
const ESC_TAIL = String.raw`u001[bB]|u\{0*1[bB]\}|x1[bB]|U0000001[bB]|033|e|E`;
const BEL_TAIL = String.raw`u0007|u\{0*7\}|x07|U00000007|007|a`;
const ESC_CARET = String.raw`\^\[`;
const BEL_CARET = String.raw`\^G`;
const ESC = String.raw`(?:\x1b|${BACKSLASHES}(?:${ESC_TAIL})|${buildUrlEncoded("1[bB]")}|(?:${BACKSLASHES})?${ESC_CARET})`;
const BEL = String.raw`(?:\x07|${BACKSLASHES}(?:${BEL_TAIL})|${buildUrlEncoded("07")}|(?:${BACKSLASHES})?${BEL_CARET})`;

/* The ECMA-48 sequence ESC opens: a CSI, its `[` and parameters raw or
 * URL-encoded; an OSC, its numeric command then `;`, such as an OSC 8
 * hyperlink, ended by BEL or by ESC and the backslash run of its `\`; or a
 * two-character one such as `ESC 7` or `ESC ( B` (`tput sgr0`). Each has one
 * reading, so the body's repetition cannot backtrack exponentially over it:
 * the two-character form never ends in `[`, starts an encoded `[` or starts a
 * whole OSC. An OSC body holds any character but a C0 control other than
 * tab, DEL, ESC and BEL, and takes a backslash run whole, so it never rescans
 * one; the closing `\` run is taken whole unless an escaped ESC follows it. */
const CSI = String.raw`(?:\[|${buildUrlEncoded("5[bB]")})(?:[0-?]|${buildUrlEncoded("3[0-9A-Fa-f]")})*[ -/]*[@-~]`;
const OSC_BODY_UNIT = String.raw`(?!${buildUrlEncoded("(?:1[bB]|07)")}|${ESC_CARET}|${BEL_CARET})[^\x00-\x08\x0a-\x1f\x7f\\]|${BACKSLASHES}(?!\\|${ESC_TAIL}|${BEL_TAIL}|${ESC_CARET}|${BEL_CARET})`;
/* Unbounded, a multi-megabyte OSC body overflows the regex stack; 4096 is a
 * guess at the longest an OSC 8 URI runs, not measured. */
const OSC = String.raw`\][0-9]+;(?:${OSC_BODY_UNIT}){0,4096}(?:${BEL}|${ESC}(?:${BACKSLASHES}(?!\\|${ESC_TAIL}|${ESC_CARET}))?)`;
const TWO_CHARACTER = String.raw`(?!${buildUrlEncoded("5[bB]")}|${OSC})[ -/]*[0-Z\\\]-~]`;
const CONTROL = `${ESC}(?:${CSI}|${OSC}|${TWO_CHARACTER})`;

/* The escapes an `sk-` token may follow, each ending in a letter or digit:
 * JSON's and C's (a tool input reaches the masker stringified), octal, a
 * URL's percent-escape at any depth of re-encoding, `\x`/`\U`/`%u` from
 * printf, Python and old JavaScript, and a terminal control sequence. */
const ESCAPES = [
	String.raw`\\[abfnrtv]`,
	String.raw`\\[0-7]{1,3}`,
	String.raw`\\x[0-9A-Fa-f]{2}`,
	String.raw`(?:\\u|%u)[0-9A-Fa-f]{4}`,
	String.raw`\\U[0-9A-Fa-f]{8}`,
	buildUrlEncoded("[0-9A-Fa-f]{2}"),
	CONTROL,
];

const SK_LEAD = `(?:(?<![A-Za-z0-9])|(?<=${ESCAPES.join("|")}))`;

/**
 * The source for a prefix with any control sequences between its characters;
 * a `[…]` class is one character.
 * @param {string} prefix
 */
const buildPrefix = (prefix) => prefixUnits(prefix).join(`(?:${CONTROL})*`);

/**
 * The units `buildPrefix` joins, read in one pass: a regex alternation
 * backtracks quadratically on a run of unclosed `[` (#3383).
 * @param {string} prefix
 */
function prefixUnits(prefix) {
	const units = [];
	const lastClose = prefix.lastIndexOf("]");
	for (let i = 0; i < prefix.length; i++) {
		const end = prefix[i] === "[" && i < lastClose ? prefix.indexOf("]", i) : i;
		units.push(prefix.slice(i, end + 1));
		i = end;
	}
	return units;
}

/**
 * The source for one body character, after any control sequences, that
 * does not start `stop`.
 * @param {string} chars
 * @param {string} [stop]
 */
const buildBodyUnit = (chars, stop) =>
	`(?:${CONTROL})*${stop ? `(?!${stop})` : ""}${chars}`;

/** @typedef {{ prefix: string, chars: string, min: number }} Shape */

/** @type {Shape} */
const SK = { prefix: buildPrefix("sk-"), chars: "[A-Za-z0-9_-]", min: 20 };
/** @type {Shape} */
const ANTHROPIC = { ...SK, prefix: buildPrefix("sk-ant-") };
/** @type {Shape} */
const HUGGINGFACE = {
	prefix: buildPrefix("hf_"),
	chars: "[A-Za-z0-9]",
	min: 30,
};
/** @type {Shape} */
const GITHUB = {
	prefix: buildPrefix("gh[pousr]_"),
	chars: "[A-Za-z0-9]",
	min: 30,
};
/** @type {Shape} */
const GITHUB_PAT = {
	prefix: buildPrefix("github_pat_"),
	chars: "[A-Za-z0-9_]",
	min: 22,
};
const AWS_PREFIX = buildPrefix("A[KS]IA");

/** @param {Shape} shape */
const buildShortest = ({ prefix, chars, min }) =>
	`${prefix}(?:${buildBodyUnit(chars)}){${min}}`;

/* The shortest whole token of each shape whose prefix holds a character an
 * alphanumeric body lacks, so a real body never spells one. */
const NEXT_SK = buildShortest(SK);
const NEXT_TOKEN = [HUGGINGFACE, SK, GITHUB, GITHUB_PAT]
	.map(buildShortest)
	.join("|");

/**
 * The source for a shape's prefix, `guard`, then a body of at least its
 * minimum whose characters do not start `stop`.
 * @param {Shape} shape
 * @param {{ stop?: string, guard?: string }} [options]
 */
const buildToken = ({ prefix, chars, min }, { stop, guard = "" } = {}) =>
	`${prefix}${guard}(?:${buildBodyUnit(chars, stop)}){${min},}`;

/* The digit lookahead is bounded so a long digitless run stays linear. */
const SK_DIGIT = `(?=(?:${CONTROL}|${SK.chars}){0,300}?\\d)`;

/** @param {Shape} shape */
const buildSkToken = (shape) =>
	`${SK_LEAD}${buildToken(shape, { guard: SK_DIGIT })}`;

/** @type {{ rule: string, pattern: RegExp }[]} */
const TOKEN_SHAPES = [
	{
		rule: "anthropic",
		pattern: new RegExp(buildSkToken(ANTHROPIC)),
	},
	{ rule: "openai", pattern: new RegExp(buildSkToken(SK)) },
	{
		rule: "github-pat",
		pattern: new RegExp(buildToken(GITHUB_PAT, { stop: NEXT_SK })),
	},
	{
		rule: "huggingface",
		pattern: new RegExp(buildToken(HUGGINGFACE, { stop: NEXT_TOKEN })),
	},
	{
		rule: "github",
		pattern: new RegExp(buildToken(GITHUB, { stop: NEXT_TOKEN })),
	},
	{
		rule: "aws",
		/* An uppercase body can spell another key id's prefix, so the fixed
		 * length ends it there too. */
		pattern: new RegExp(
			`${AWS_PREFIX}(?:${buildBodyUnit("[0-9A-Z]")}){16}(?:(?![0-9A-Z])|(?=${AWS_PREFIX}))`,
		),
	},
];

/**
 * `text` with every token-shaped substring replaced by `[REDACTED:<rule>]`.
 * Shapes apply in list order: `sk-ant-` is named before the bare `sk-` rule
 * can claim it, and the shapes whose bodies hold `_` or `-` run before the
 * lead-free ones, which would otherwise split them at an `hf_` or `ghp_`
 * inside. The list reruns until a pass masks nothing, so an `sk-` token a
 * later shape's mask uncovers is caught.
 * @param {string} text
 * @returns {{ text: string, count: number }}
 */
function maskTokens(text) {
	let count = 0;
	let out = text;
	let found;
	do {
		found = 0;
		for (const { rule, pattern } of TOKEN_SHAPES) {
			const every = new RegExp(pattern.source, "g");
			found += out.match(every)?.length ?? 0;
			out = out.replace(every, `[REDACTED:${rule}]`);
		}
		count += found;
	} while (found > 0);
	return { text: out, count };
}

module.exports = { maskTokens };
