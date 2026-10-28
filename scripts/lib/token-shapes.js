/*
 * token-shapes.js — the credential shapes a scratch writer masks before a
 * session log's text reaches a file other sessions read (#1031). One list, so
 * a later reader reuses it rather than restating it; the gitleaks pre-commit
 * scan keeps its own rules.
 *
 * EACH SHAPE CARRIES A MINIMUM-LENGTH BODY, so prose sharing a prefix
 * ("task-notification", "sk-learn", a short `hf_` name) is left alone. The
 * minima sit under each vendor's real length — chosen, not measured against a
 * corpus. A prefix must not follow a letter or digit, so "risk-…" never reads
 * as an `sk-` key — unless that character closes an escape (`%3D`, `\u0022`),
 * which hides the separator a log's encoding replaced (#3394).
 *
 * RESIDUALS: a token of a vendor not listed passes unmasked, and so does an
 * `sk-` body holding no digit — the digit is what tells a key from a long
 * hyphenated word. A token after an escape `ESCAPES` does not list, such as
 * quoted-printable's `=3D`, passes too.
 * An escaped letter or digit (`%41`) counts as a lead, over-masking.
 */

/* The escapes a token may follow, each ending in a letter or digit: JSON's
 * (a tool input reaches the masker stringified), a URL's percent-escape at
 * any depth of re-encoding, `\x`/`\U`/`%u` from printf, Python and old
 * JavaScript, and an ECMA-48 terminal control sequence (a colour code, a line
 * clear) behind ESC raw or in any common escaped spelling (#3394). */
const ESCAPES = [
	String.raw`\\[bfnrt]`,
	String.raw`\\x[0-9A-Fa-f]{2}`,
	String.raw`(?:\\u|%u)[0-9A-Fa-f]{4}`,
	String.raw`\\U[0-9A-Fa-f]{8}`,
	"%(?:25)*[0-9A-Fa-f]{2}",
	String.raw`(?:\x1b|\\(?:u001[bB]|x1[bB]|033|e))\[[0-?]*[ -/]*[@-~]`,
];

const LEAD = `(?:(?<![A-Za-z0-9])|(?<=${ESCAPES.join("|")}))`;

/** @type {{ rule: string, pattern: RegExp }[]} */
const TOKEN_SHAPES = [
	{ rule: "huggingface", pattern: new RegExp(`${LEAD}hf_[A-Za-z0-9]{30,}`) },
	{
		rule: "anthropic",
		pattern: new RegExp(
			`${LEAD}sk-ant-(?=[A-Za-z0-9_-]*\\d)[A-Za-z0-9_-]{20,}`,
		),
	},
	{
		rule: "openai",
		pattern: new RegExp(`${LEAD}sk-(?=[A-Za-z0-9_-]*\\d)[A-Za-z0-9_-]{20,}`),
	},
	{ rule: "github", pattern: new RegExp(`${LEAD}gh[pousr]_[A-Za-z0-9]{30,}`) },
	{
		rule: "github-pat",
		pattern: new RegExp(`${LEAD}github_pat_[A-Za-z0-9_]{22,}`),
	},
	{ rule: "aws", pattern: new RegExp(`${LEAD}AKIA[0-9A-Z]{16}(?![0-9A-Z])`) },
];

/**
 * `text` with every token-shaped substring replaced by `[REDACTED:<rule>]`.
 * Shapes apply in list order, so `sk-ant-` is named before the bare `sk-`
 * rule can claim it.
 * @param {string} text
 * @returns {{ text: string, count: number }}
 */
function maskTokens(text) {
	let count = 0;
	let out = text;
	for (const { rule, pattern } of TOKEN_SHAPES) {
		const every = new RegExp(pattern.source, "g");
		count += out.match(every)?.length ?? 0;
		out = out.replace(every, `[REDACTED:${rule}]`);
	}
	return { text: out, count };
}

module.exports = { maskTokens };
