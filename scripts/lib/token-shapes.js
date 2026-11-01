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
 * that sequence's, so a token near its minimum can pass (#3549). A chain of
 * tokens each shorter than any vendor issues and spelling the next one's
 * prefix masks only its last links, one more per pass; and an `sk-` token a
 * control sequence leads, inside such a token's minimum, loses its prefix to
 * that body and passes (#3661).
 *
 * A STORED SECRET'S VALUE is masked after its `NAME=` for each name a caller
 * passes, whatever its shape (#3661), to the end of its line (#3710). One
 * after `NAME:` or a JSON key passes, and so does one under a name the
 * secrets file does not hold, a key set only in the environment included. A
 * value opening `\t`, or a spelling of a control sequence (`\e7`, `%1B7`,
 * `^[[1m`), keeps that opening.
 */

const { SPACE } = require("./env-file.js");

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

/**
 * The source for a lead: no `nameChars` character before, unless an escape
 * `ESCAPES` lists ends there.
 * @param {string} nameChars a class body
 */
const buildLead = (nameChars) =>
	`(?:(?<![${nameChars}])|(?<=${ESCAPES.join("|")}))`;

const SK_LEAD = buildLead("A-Za-z0-9");

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

/* The shortest whole token of each lead-free shape: inside its minimum a
 * body stops before one of these alone. A stop before an `sk-` there would
 * cut the body short and mask neither when that `sk-` has no lead (#3661). */
const NEXT_LEAD_FREE = [HUGGINGFACE, GITHUB, GITHUB_PAT]
	.map(buildShortest)
	.join("|");

/**
 * The source for a shape's prefix, `guard`, then a body of at least its
 * minimum whose characters do not start `early`, ending at the first place
 * past the minimum where, after any control sequences, `stop` starts or no
 * body character follows. One lookahead ends it rather than one per
 * character, which would hold `stop` twice and double the compiled code.
 * @param {Shape} shape
 * @param {{ stop?: string, early?: string, guard?: string }} [options]
 */
const buildToken = ({ prefix, chars, min }, { stop, early, guard = "" } = {}) =>
	`${prefix}${guard}(?:${buildBodyUnit(chars, early)}){${min},}${
		stop ? `?(?=(?:${CONTROL})*(?:${stop})|(?!(?:${CONTROL})*${chars}))` : ""
	}`;

/* The digit lookahead is bounded so a long digitless run stays linear. 300
 * is a guess, not measured; a random body of the class holds no digit in its
 * first 300 characters with odds of (54/64)^300, under 1e-22. */
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
		pattern: new RegExp(
			buildToken(HUGGINGFACE, { stop: NEXT_TOKEN, early: NEXT_LEAD_FREE }),
		),
	},
	{
		rule: "github",
		pattern: new RegExp(
			buildToken(GITHUB, { stop: NEXT_TOKEN, early: NEXT_LEAD_FREE }),
		),
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

/* A second pass masks an `sk-` token a first-pass mask gave its lead; a
 * mask gives no other token a lead or a body. */
const PASSES = 2;

/* A space env-file reads around `=`, escaped as JSON, C or Python spell it. */
const ESCAPED_SPACE = `${BACKSLASHES}(?:[tfv]|x(?:09|0[bBcC]|[aA]0)|u(?:0009|000[bBcC]|00[aA]0|1680|200[0-9aA]|202[fF]|205[fF]|3000|[fF][eE][fF][fF]))`;

/**
 * Each `<name>=` assignment, as a log spells one, in two groups: the name and
 * what runs to its value. The name, control sequences allowed between its
 * characters as `grep --color` puts them, follows no name character unless
 * an escape `ESCAPES` lists ends there. Before `=` may sit
 * `lib/env-file.js`'s spaces, raw or escaped, and control sequences; after
 * it, the raw ones, an escaped tab and control sequences. The value takes
 * any quote around it.
 * @param {string[]} names
 */
function buildStored(names) {
	const nameAlternation = names.map(buildPrefix).join("|");
	const firsts = [...new Set(names.map((name) => name[0]))].join("");
	const gap = String.raw`(?:${CONTROL}|${SPACE}|${ESCAPED_SPACE})*=(?:${CONTROL}|${SPACE}|\\t)*`;
	return `(?=[${firsts}])${buildLead("A-Za-z0-9_")}(${nameAlternation})(${gap})(?!${SPACE}).+`;
}

/**
 * `text` with every token-shaped substring, and the value of an assignment
 * to any of `names`, replaced by `[REDACTED:<rule>]`. Shapes apply in list
 * order: `sk-ant-` is named before the bare `sk-` rule can claim it, and the
 * shapes whose bodies hold `_` or `-` run before the lead-free ones, which
 * would otherwise split them at an `hf_` or `ghp_` inside.
 * @param {string} text
 * @param {string[]} [names] the secrets file's names, from
 *   `lib/env-file.js`'s `readStoredNames`: identifiers, put in the pattern as
 *   they are
 * @returns {{ text: string, count: number }}
 */
function maskTokens(text, names = []) {
	let count = 0;
	let out = text;
	if (names.length > 0) {
		out = out.replace(
			new RegExp(buildStored(names), "g"),
			(_match, name, gap) => {
				count++;
				return `${name}${gap}[REDACTED:stored]`;
			},
		);
	}
	let found = 0;
	for (let pass = 0; pass < PASSES && (pass === 0 || found > 0); pass++) {
		found = 0;
		for (const { rule, pattern } of TOKEN_SHAPES) {
			const every = new RegExp(pattern.source, "g");
			found += out.match(every)?.length ?? 0;
			out = out.replace(every, `[REDACTED:${rule}]`);
		}
		count += found;
	}
	return { text: out, count };
}

module.exports = { maskTokens };
