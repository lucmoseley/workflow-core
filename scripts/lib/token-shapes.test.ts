// @vitest-environment node
/*
 * lib/token-shapes.js masks a listed vendor's token wherever it can start:
 * an `sk-` token after a non-alphanumeric character or after an escape whose
 * last character is a letter or digit (#3394), every other shape after
 * anything (#3540). Break it and a token in a URL, a stringified tool input or
 * coloured command output reaches the scratch files other sessions read,
 * through scripts/retro-transcript.js.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { maskTokens } = require("./token-shapes.js");

const GITHUB = `ghp_${"a".repeat(36)}`;
const GITHUB_PAT = `github_pat_${"a".repeat(82)}`;
const HUGGINGFACE = `hf_${"a".repeat(34)}`;
const OPENAI = `sk-${"a1".repeat(12)}`;
const AWS = `AKIA${"A".repeat(16)}`;

function expectMasked(lead: string, token: string, rule: string) {
	const { text, count } = maskTokens(`${lead}${token}`);
	expect(count).toBe(1);
	expect(text).toBe(`${lead}[REDACTED:${rule}]`);
}

const LEADS_3394 = [
	["a space", "x "],
	["a quote", '"'],
	["a JSON \\n escape", "\\n"],
	["%20", "%20"],
	["%3D", "%3D"],
	["%3A", "%3A"],
	["a lower-case percent-escape", "%3d"],
	["a double-encoded percent-escape", "%253D"],
	["a JSON \\u escape", "\\u0022"],
	["a lower-case \\u escape", "\\u003d"],
	["a JSON \\b escape", "\\b"],
	["a JSON \\f escape", "\\f"],
	["a \\x escape", "\\x3d"],
	["a \\U escape", "\\U0000003d"],
	["a %u escape", "%u003D"],
	["a raw terminal colour code", "\u001b[32m"],
	["a stringified terminal colour code", "\\u001b[1;32m"],
	["a \\x1b colour code", "\\x1b[32m"],
	["a \\033 colour code", "\\033[32m"],
	["a raw terminal line clear", "\u001b[K"],
].map(([name, lead]) => [`${name} (#3394)`, lead]);

const LEADS_3540 = [
	["a \\x1b7 cursor save", "\\x1b7"],
	["a \\x1b8 cursor restore", "\\x1b8"],
	["a \\e7 cursor save", "\\e7"],
	["a caret-notation cursor save", "\\^[7"],
	["a raw tput sgr0 charset reset", "\u001b(B"],
	["a \\x1b(B charset reset", "\\x1b(B"],
	["a \\a escape", "\\a"],
	["a \\v escape", "\\v"],
	["a \\0 escape", "\\0"],
	["an octal \\075 escape", "\\075"],
	["an octal \\012 escape", "\\012"],
	["a \\u{1b} colour code", "\\u{1b}[32m"],
	["a %1B colour code", "%1B[32m"],
].map(([name, lead]) => [`${name} (#3540)`, lead]);

const ESCAPE_LEADS = [...LEADS_3394, ...LEADS_3540];

describe("maskTokens lead", () => {
	it.each(ESCAPE_LEADS)("masks an sk- token after %s", (_name, lead) => {
		expectMasked(lead, OPENAI, "openai");
	});

	it.each([
		["a letter", "x"],
		["a digit", "7"],
		["a bare percent sign and one hex digit", "%3"],
		["a short \\u escape", "\\u00"],
	])("leaves an sk- token after %s", (_name, lead) => {
		expect(maskTokens(`${lead}${OPENAI}`).count).toBe(0);
	});

	it.each([
		...ESCAPE_LEADS,
		["a letter (#3540)", "x"],
		["a digit (#3540)", "7"],
		["quoted-printable's =3D (#3540)", "=3D"],
	])("masks every other shape after %s", (_name, lead) => {
		expectMasked(lead, GITHUB, "github");
		expectMasked(lead, HUGGINGFACE, "huggingface");
		expectMasked(lead, GITHUB_PAT, "github-pat");
		expectMasked(lead, AWS, "aws");
	});
});

describe("maskTokens across a colour code in the body (#3540)", () => {
	it.each([
		["raw", "\u001b[m\u001b[K"],
		["JSON-escaped", "\\u001b[m\\u001b[K"],
	])("masks a body grep --color split from its prefix, %s", (_name, seq) => {
		expectMasked("", `ghp_${seq}${"a".repeat(36)}`, "github");
		expectMasked("", `sk-${seq}${"a1".repeat(12)}`, "openai");
	});

	it.each([
		["raw", "\u001b[1m"],
		["JSON-escaped", "\\u001b[1m"],
	])(
		"leaves a digitless sk- word whose only digit is a colour code's, %s",
		(_name, seq) => {
			expect(maskTokens(`sk-${seq}learn-is-a-python-library-name`).count).toBe(
				0,
			);
		},
	);
});

describe("maskTokens prefixes (#3540)", () => {
	it("masks an ASIA STS key id", () => {
		expectMasked("", `ASIA${"A".repeat(16)}`, "aws");
	});

	it.each([
		[
			"an anthropic key holding hf_",
			`sk-ant-api03-AbCdEfGh12Xhf_${"Q".repeat(10)}abcdefghij1234567890-SECRETTAIL_xyz987654321ZZ-AA`,
			"anthropic",
		],
		[
			"a github-pat holding hf_",
			`github_pat_11ABCDEFGHIJKLMNOPQRhf_${"a".repeat(59)}`,
			"github-pat",
		],
		[
			"a github-pat holding ghp_",
			`github_pat_11ABCDEFGHIJKLMNOPQRghp_${"a".repeat(59)}`,
			"github-pat",
		],
	])("masks %s whole", (_name, token, rule) => {
		expectMasked("", token, rule);
	});

	it("masks a short prefix-shaped tail's alphanumerics with a github body", () => {
		expect(maskTokens(`${GITHUB}hf_x`).text).toBe("[REDACTED:github]_x");
	});
});

describe("maskTokens back-to-back (#3540)", () => {
	it.each([
		[
			"two github tokens",
			[GITHUB, "github"],
			[`ghp_${"b".repeat(36)}`, "github"],
		],
		["a github then an sk- token", [GITHUB, "github"], [OPENAI, "openai"]],
		[
			"a github-pat then an sk- token",
			[GITHUB_PAT, "github-pat"],
			[OPENAI, "openai"],
		],
		["two AWS key ids", [AWS, "aws"], [`ASIA${"B".repeat(16)}`, "aws"]],
		[
			"a huggingface then a github token",
			[HUGGINGFACE, "huggingface"],
			[GITHUB, "github"],
		],
	])(
		"masks %s with no separator",
		(_name, [first, firstRule], [second, secondRule]) => {
			expect(maskTokens(`${first}${second}`)).toEqual({
				text: `[REDACTED:${firstRule}][REDACTED:${secondRule}]`,
				count: 2,
			});
		},
	);
});
