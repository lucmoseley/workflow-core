// @vitest-environment node
/*
 * lib/token-shapes.js masks a listed vendor's token wherever it can start:
 * an `sk-` token after a non-alphanumeric character or after an escape whose
 * last character is a letter or digit (#3394), every other shape after
 * anything (#3540), and a control sequence anywhere after a token's first
 * character (#3547), doubly escaped, URL-encoded or an OSC 8 hyperlink
 * included (#3549). Break it and a token in a URL, a stringified tool input or
 * coloured command output reaches the scratch files other sessions read,
 * through scripts/retro-transcript.js.
 */
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

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

/* What `grep --color` wraps a match in. */
const OPEN = "\u001b[01;31m\u001b[K";
const CLOSE = "\u001b[m\u001b[K";

describe("maskTokens across a colour code in the prefix (#3547)", () => {
	it.each([
		["github|_pat_", "github", `_pat_${"a".repeat(82)}`, "github-pat"],
		["ghp|_", "ghp", `_${"a".repeat(36)}`, "github"],
		["sk|-", "sk", `-${"a1".repeat(12)}`, "openai"],
		["AK|IA", "AK", `IA${"A".repeat(16)}`, "aws"],
	])("masks a token grep --color split at %s", (_name, matched, rest, rule) => {
		expectMasked(OPEN, `${matched}${CLOSE}${rest}`, rule);
		expectMasked(
			JSON.stringify(OPEN).slice(1, -1),
			`${matched}${JSON.stringify(CLOSE).slice(1, -1)}${rest}`,
			rule,
		);
	});

	it("leaves an sk- token split by a colour code after a letter", () => {
		expect(maskTokens(`xs${CLOSE}k-${"a1".repeat(12)}`).count).toBe(0);
	});

	it.each([
		["a github token", GITHUB, `ghp${CLOSE}_${"b".repeat(36)}`, "github"],
		[
			"a github token split at gh|p_",
			GITHUB,
			`gh${CLOSE}p_${"b".repeat(36)}`,
			"github",
		],
		["an AWS key id", AWS, `AK${CLOSE}IA${"B".repeat(16)}`, "aws"],
	])(
		"masks %s then a split one with no separator",
		(_name, first, second, rule) => {
			expect(maskTokens(`${first}${second}`)).toEqual({
				text: `[REDACTED:${rule}][REDACTED:${rule}]`,
				count: 2,
			});
		},
	);
});

const HYPERLINK = "\u001b]8;;https://example.com/a?b=1\u001b\\";

/* Each raw; a test reads it stringified as well. */
const CONTROLS_3549 = [
	["a doubly escaped caret ESC", "\\\\^[[m"],
	["a Python repr's \\x1b inside JSON", "\\\\x1b[m"],
	["a URL-encoded CSI", "%1B%5Bm"],
	["a URL-encoded CSI with parameters", "%1B%5B01%3B31m"],
	["a doubly URL-encoded CSI", "%251B%255Bm"],
	["an OSC 8 hyperlink", HYPERLINK],
	["an OSC 8 hyperlink ended by BEL", "\u001b]8;;https://example.com\u0007"],
	["an OSC 8 hyperlink then a colour reset", `${HYPERLINK}${CLOSE}`],
	["an OSC 8 hyperlink to a non-ASCII path", "\u001b]8;;file:///tmp/é\u001b\\"],
	["an OSC 8 hyperlink holding a tab", "\u001b]8;;a\tb\u001b\\"],
];

describe("maskTokens across other control spellings (#3549)", () => {
	it.each(CONTROLS_3549)("masks a token %s splits", (_name, seq) => {
		for (const spelling of [seq, JSON.stringify(seq).slice(1, -1)]) {
			expectMasked("", `gh${spelling}p_${"a".repeat(36)}`, "github");
			expectMasked("", `sk${spelling}-${"a1".repeat(12)}`, "openai");
			expectMasked("", `ghp_${spelling}${"a".repeat(36)}`, "github");
		}
	});

	it.each(CONTROLS_3549)("masks an sk- token after %s", (_name, seq) => {
		for (const spelling of [seq, JSON.stringify(seq).slice(1, -1)]) {
			expectMasked(`x${spelling}`, OPENAI, "openai");
		}
	});

	it("leaves a digitless sk- word whose only digits are an OSC 8 link's", () => {
		expect(
			maskTokens(`sk-${HYPERLINK}learn-is-a-python-library-name`).count,
		).toBe(0);
	});
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

describe("maskTokens on a cascading chain (#3661)", () => {
	/* Each link's `hf_` body stops before the next `sk-`, which only the
	 * `hf_` mask after it gives a lead. */
	const chain = (links: number) =>
		`${`hf_${"a".repeat(29)}sk-`.repeat(links)}x`;

	/** The regex replacements one call makes, the masker's unit of work: no
	 * return value shows how many passes it ran. */
	function replacements(text: string) {
		const spy = vi.spyOn(RegExp.prototype, Symbol.replace);
		try {
			const result = maskTokens(text);
			return { result, calls: spy.mock.calls.length };
		} finally {
			spy.mockRestore();
		}
	}

	it("masks every link", () => {
		expect(maskTokens(chain(3))).toEqual({
			text: `${"[REDACTED:huggingface]-".repeat(3)}x`,
			count: 3,
		});
	});

	it("makes as many replacements on 2,000 links as on one", () => {
		const one = replacements(chain(1));
		const many = replacements(chain(2000));
		expect(many.result.count).toBe(2000);
		expect(many.calls).toBe(one.calls);
	});
});

describe("maskTokens across a colour code past the minimum (#3661)", () => {
	it.each([
		["a github-pat", `github_pat_${"a".repeat(30)}`, "github-pat"],
		["a github token", `ghp_${"a".repeat(32)}`, "github"],
		["a huggingface token", `hf_${"a".repeat(31)}`, "huggingface"],
	])("masks the whole of %s", (_name, head, rule) => {
		for (const colour of ["\u001b[01;31m\u001b[K", "\\u001b[1m"])
			expect(maskTokens(`${head}${colour}${"b".repeat(8)}`)).toEqual({
				text: `[REDACTED:${rule}]`,
				count: 1,
			});
	});
});

describe("maskTokens on a stored name (#3661)", () => {
	const gatewayKey = `vck_${"aB3".repeat(16)}`;
	const stored = ["AI_GATEWAY_API_KEY"];

	it.each([
		[
			"bare",
			`AI_GATEWAY_API_KEY=${gatewayKey}`,
			"AI_GATEWAY_API_KEY=[REDACTED:stored]",
		],
		[
			"exported, spaced and quoted",
			`export AI_GATEWAY_API_KEY = "${gatewayKey}" next`,
			'export AI_GATEWAY_API_KEY = "[REDACTED:stored]" next',
		],
		[
			"behind a doubled escaped quote",
			`export AI_GATEWAY_API_KEY=\\\\\\"${gatewayKey}\\\\\\"`,
			'export AI_GATEWAY_API_KEY=\\\\\\"[REDACTED:stored]\\\\\\"',
		],
		[
			"in bash's $'…' quoting",
			`AI_GATEWAY_API_KEY=$'${gatewayKey}'`,
			"AI_GATEWAY_API_KEY=$'[REDACTED:stored]'",
		],
		[
			"after an escaped tab",
			`AI_GATEWAY_API_KEY=\\t${gatewayKey}`,
			"AI_GATEWAY_API_KEY=\\t[REDACTED:stored]",
		],
		[
			"under grep --color",
			`\u001b[01;31m\u001b[KAI_GATEWAY_API_KEY\u001b[m\u001b[K=${gatewayKey}`,
			"\u001b[01;31m\u001b[KAI_GATEWAY_API_KEY\u001b[m\u001b[K=[REDACTED:stored]",
		],
		[
			"stringified in a tool input",
			`{"command":"AI_GATEWAY_API_KEY=\\"${gatewayKey}\\" node a.js"}`,
			'{"command":"AI_GATEWAY_API_KEY=\\"[REDACTED:stored]\\" node a.js"}',
		],
	])("masks the value %s", (_name, text, masked) => {
		expect(maskTokens(text, stored)).toEqual({ text: masked, count: 1 });
	});

	it.each<[string, string, string[]]>([
		[
			"a longer name ending in it",
			`MY_AI_GATEWAY_API_KEY=${gatewayKey}`,
			stored,
		],
		["no names passed", `AI_GATEWAY_API_KEY=${gatewayKey}`, []],
	])("leaves %s alone", (_name, text, names) => {
		expect(maskTokens(text, names)).toEqual({ text, count: 0 });
	});
});
