/*
 * token-shapes.js — the credential shapes a scratch writer masks before a
 * session log's text reaches a file other sessions read (workflow-core#1031). One list, so
 * a later reader reuses it rather than restating it; the gitleaks pre-commit
 * scan keeps its own rules.
 *
 * EACH SHAPE CARRIES A MINIMUM-LENGTH BODY, so prose sharing a prefix
 * ("task-notification", "sk-learn", a short `hf_` name) is left alone. The
 * minima sit under each vendor's real length — chosen, not measured against a
 * corpus. A prefix must not follow a letter or digit, so "risk-…" never reads
 * as an `sk-` key.
 *
 * RESIDUALS: a token of a vendor not listed passes unmasked, and so does an
 * `sk-` body holding no digit — the digit is what tells a key from a long
 * hyphenated word.
 */

/* Or after a JSON escape (`\n`, `\r`, `\t`): a tool input reaches the masker
 * stringified. */
const LEAD = String.raw`(?:(?<![A-Za-z0-9])|(?<=\\[nrt]))`;

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
