const { bracketUnits } = require("./bracket-units.js");
const { SPACE } = require("./env-file.js");

/** @param {string} hex */
const buildUrlEncoded = (hex) => `%(?:25)*${hex}`;

// workflow-core#3549 guess: up to six doublings of a backslash; an unbounded run overflows the regex stack
const BACKSLASHES = String.raw`\\{1,64}`;
const ESC_TAIL = String.raw`u001[bB]|u\{0*1[bB]\}|x1[bB]|U0000001[bB]|033|e|E`;
const BEL_TAIL = String.raw`u0007|u\{0*7\}|x07|U00000007|007|a`;
const ESC_CARET = String.raw`\^\[`;
const BEL_CARET = String.raw`\^G`;
const ESC = String.raw`(?:\x1b|${BACKSLASHES}(?:${ESC_TAIL})|${buildUrlEncoded("1[bB]")}|(?:${BACKSLASHES})?${ESC_CARET})`;
const BEL = String.raw`(?:\x07|${BACKSLASHES}(?:${BEL_TAIL})|${buildUrlEncoded("07")}|(?:${BACKSLASHES})?${BEL_CARET})`;

const CSI = String.raw`(?:\[|${buildUrlEncoded("5[bB]")})(?:[0-?]|${buildUrlEncoded("3[0-9A-Fa-f]")})*[ -/]*[@-~]`;
const OSC_BODY_UNIT = String.raw`(?!${buildUrlEncoded("(?:1[bB]|07)")}|${ESC_CARET}|${BEL_CARET})[^\x00-\x08\x0a-\x1f\x7f\\]|${BACKSLASHES}(?!\\|${ESC_TAIL}|${BEL_TAIL}|${ESC_CARET}|${BEL_CARET})`;
// workflow-core#3549 guess at the longest an OSC 8 URI runs; an unbounded body overflows the regex stack
const OSC = String.raw`\][0-9]+;(?:${OSC_BODY_UNIT}){0,4096}(?:${BEL}|${ESC}(?:${BACKSLASHES}(?!\\|${ESC_TAIL}|${ESC_CARET}))?)`;
const TWO_CHARACTER = String.raw`(?!${buildUrlEncoded("5[bB]")}|${OSC})[ -/]*[0-Z\\\]-~]`;
const CONTROL = `${ESC}(?:${CSI}|${OSC}|${TWO_CHARACTER})`;

const ESCAPES = [
	String.raw`\\[abfnrtv]`,
	String.raw`\\[0-7]{1,3}`,
	String.raw`\\x[0-9A-Fa-f]{2}`,
	String.raw`(?:\\u|%u)[0-9A-Fa-f]{4}`,
	String.raw`\\U[0-9A-Fa-f]{8}`,
	buildUrlEncoded("[0-9A-Fa-f]{2}"),
	CONTROL,
];

/** @param {string} nameChars */
const buildLead = (nameChars) =>
	`(?:(?<![${nameChars}])|(?<=${ESCAPES.join("|")}))`;

const SK_LEAD = buildLead("A-Za-z0-9");

/** @param {string} prefix */
const buildPrefix = (prefix) => bracketUnits(prefix).join(`(?:${CONTROL})*`);

/** @param {string} chars @param {string} [stop] */
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

const NEXT_SK = buildShortest(SK);
const NEXT_TOKEN = [HUGGINGFACE, SK, GITHUB, GITHUB_PAT]
	.map(buildShortest)
	.join("|");

const NEXT_LEAD_FREE = [HUGGINGFACE, GITHUB, GITHUB_PAT]
	.map(buildShortest)
	.join("|");

/** @param {Shape} shape @param {{ stop?: string, early?: string, guard?: string }} [options] */
const buildToken = ({ prefix, chars, min }, { stop, early, guard = "" } = {}) =>
	`${prefix}${guard}(?:${buildBodyUnit(chars, early)}){${min},}${
		stop ? `?(?=(?:${CONTROL})*(?:${stop})|(?!(?:${CONTROL})*${chars}))` : ""
	}`;

// workflow-core#3547 guess: a random body holds no digit in its first 300 characters at odds of (54/64)^300, under 1e-22
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
		pattern: new RegExp(
			`${AWS_PREFIX}(?:${buildBodyUnit("[0-9A-Z]")}){16}(?:(?![0-9A-Z])|(?=${AWS_PREFIX}))`,
		),
	},
];

const PASSES = 2;

const ESCAPED_SPACE = `${BACKSLASHES}(?:[tfv]|x(?:09|0[bBcC]|[aA]0)|u(?:0009|000[bBcC]|00[aA]0|1680|200[0-9aA]|202[fF]|205[fF]|3000|[fF][eE][fF][fF]))`;

const EQUALS = `(?:=|${buildUrlEncoded("3[dD]")}|${BACKSLASHES}(?:x3[dD]|u003[dD]|075)|&#0*61;|&#[xX]0*3[dD];|&equals;)`;

const EQUALS_CHAR = /[=%\\&]/;

/** @param {string[]} names */
function buildStored(names) {
	const nameAlternation = names.map(buildPrefix).join("|");
	const firsts = [...new Set(names.map((name) => name[0]))].join("");
	const gap = String.raw`(?:(?:${BACKSLASHES})?["']\])?(?:${CONTROL}|${SPACE}|${ESCAPED_SPACE})*[+:?]?${EQUALS}(?:${CONTROL}|${SPACE}|\\t|\\+\r?\n)*`;
	return `(?=[${firsts}])${buildLead("A-Za-z0-9_")}(${nameAlternation})(${gap})(?!${SPACE}).+`;
}

// workflow-core#3821 guess: GitLab's floor for a masked variable, https://docs.gitlab.com/ci/variables/
const MIN_BARE_VALUE = 8;

const STORED_MASK = "[REDACTED:stored]";

/** @param {string} text @returns {{ text: string, count: number }} */
function maskShapes(text) {
	let count = 0;
	let out = text;
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

const LINE_END = /[\n\r\u2028\u2029]/;

/** @param {string} text @param {string[]} values @returns {{ text: string, count: number }} */
function maskValuesToLineEnd(text, values) {
	let count = 0;
	let out = text;
	for (const value of values) {
		const [head = "", ...tails] = out.split(value);
		count += tails.length;
		out = [
			head,
			...tails.map((tail) => {
				const end = tail.search(LINE_END);
				return `${STORED_MASK}${end === -1 ? "" : tail.slice(end)}`;
			}),
		].join("");
	}
	return { text: out, count };
}

/** @param {string} text @param {string[]} values @returns {{ text: string, count: number }} */
function maskValues(text, values) {
	let count = 0;
	let out = text;
	for (const value of values) {
		const parts = out.split(value);
		count += parts.length - 1;
		out = parts.join(STORED_MASK);
	}
	return { text: out, count };
}

/**
 * @param {string[]} [names]
 * @param {string[]} [values]
 * @returns {(text: string) => { text: string, count: number }}
 */
function buildMasker(names = [], values = []) {
	let stored = null;
	if (names.length > 0) {
		try {
			stored = new RegExp(buildStored(names), "g");
			for (const oneOrTwoByte of ["", "Ā"]) stored.test(oneOrTwoByte);
		} catch (e) {
			throw new Error(
				`the secrets file's ${names.length} names make a masking pattern too large to compile`,
				{ cause: e },
			);
		}
	}
	const bare = values
		.filter((value) => value.length >= MIN_BARE_VALUE)
		.sort((a, b) => b.length - a.length);
	/** @param {string} value */
	const holdsAssignment = (value) => {
		if (!stored || !EQUALS_CHAR.test(value)) return false;
		stored.lastIndex = 0;
		return stored.test(value);
	};
	const holdingAssignment = bare.filter(holdsAssignment);
	const later = bare.filter((value) => !holdingAssignment.includes(value));
	const holdingToken = later.filter((value) => maskShapes(value).count > 0);
	const plain = later.filter((value) => !holdingToken.includes(value));
	return (text) => {
		const early = maskValuesToLineEnd(text, holdingAssignment);
		let count = early.count;
		const out = stored
			? early.text.replace(stored, (match, name, gap) => {
					if (!match.startsWith(STORED_MASK, name.length + gap.length)) {
						count++;
					}
					return `${name}${gap}${STORED_MASK}`;
				})
			: early.text;
		const first = maskValues(out, holdingToken);
		const shaped = maskShapes(first.text);
		const rest = maskValues(shaped.text, plain);
		return {
			text: rest.text,
			count: count + first.count + shaped.count + rest.count,
		};
	};
}

/**
 * @param {string} text
 * @param {string[]} [names]
 * @param {string[]} [values]
 * @returns {{ text: string, count: number }}
 */
const maskTokens = (text, names = [], values = []) =>
	buildMasker(names, values)(text);

module.exports = { buildMasker, maskTokens };
