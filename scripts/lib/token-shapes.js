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
 * since `grep --color` puts one wherever its pattern ends (#3540, #3547). A
 * body stops before another shape's whole minimum token that its own
 * characters cannot spell, so back-to-back tokens are each masked.
 *
 * RESIDUALS: a token of a vendor not listed passes unmasked, and so do an
 * AWS secret access key (no prefix tells it from any 40-character string) and
 * an `sk-` body holding no digit in its first 300 characters — the digit is
 * what tells a key from a long hyphenated word. An `sk-` token after an
 * escape `ESCAPES` does not list, such as quoted-printable's `=3D`, passes
 * too. An escaped letter or digit (`%41`) counts as a lead, over-masking.
 */

/* ESC, raw or in any common escaped spelling, and the ECMA-48 sequence it
 * opens: a CSI or a two-character one such as
 * `ESC 7` or `ESC ( B` (`tput sgr0`). The two-character form never ends in
 * `[`, so a CSI has one reading and the body's repetition cannot backtrack
 * exponentially over it. */
const ESC = String.raw`(?:\x1b|\\(?:u001[bB]|u\{0*1[bB]\}|x1[bB]|U0000001[bB]|033|e|E)|%(?:25)*1[bB]|\\?\^\[)`;
const CONTROL = String.raw`${ESC}(?:\[[0-?]*[ -/]*[@-~]|[ -/]*[0-Z\\\]-~])`;

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
	"%(?:25)*[0-9A-Fa-f]{2}",
	CONTROL,
];

const SK_LEAD = `(?:(?<![A-Za-z0-9])|(?<=${ESCAPES.join("|")}))`;

/**
 * The source for a prefix with any control sequences between its characters;
 * a `[…]` class is one character.
 * @param {string} prefix
 */
const buildPrefix = (prefix) =>
	(prefix.match(/\[[^\]]*\]|./g) ?? []).join(`(?:${CONTROL})*`);

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
