// @vitest-environment node
/*
 * lib/token-shapes.js masks a listed vendor's token wherever it can start:
 * after a non-alphanumeric character, or after an escape whose last character
 * is a letter or digit (#3394). Break it and a token in a URL, a stringified
 * tool input or coloured command output reaches the scratch files other
 * sessions read, through scripts/retro-transcript.js.
 *
 * Each case calls maskTokens in process on one lead before one `ghp_` token.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { maskTokens } = require("./token-shapes.js");

const TOKEN = `ghp_${"a".repeat(36)}`;

function expectMasked(lead: string) {
	const { text, count } = maskTokens(`${lead}${TOKEN}`);
	expect(count).toBe(1);
	expect(text).toBe(`${lead}[REDACTED:github]`);
}

describe("maskTokens lead", () => {
	it.each([
		["a space", "x "],
		["a quote", '"'],
		["a JSON \\n escape", "\\n"],
	])("masks a token after %s", (_name, lead) => {
		expectMasked(lead);
	});

	it.each([
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
	])("masks a token after %s (#3394)", (_name, lead) => {
		expectMasked(lead);
	});

	it.each([
		["a letter", "x"],
		["a digit", "7"],
		["a bare percent sign and one hex digit", "%3"],
		["a short \\u escape", "\\u00"],
	])("leaves a token after %s", (_name, lead) => {
		expect(maskTokens(`${lead}${TOKEN}`).count).toBe(0);
	});
});
