// @vitest-environment node
import { describe, expect, it } from "vitest";

const { maskMentions } =
	require("./review-findings.js") as typeof import("./review-findings");

const { keptSpawn } =
	require("./kept-spawn.js") as typeof import("./kept-spawn");

const EVERY_SPAN = /[\s\S]/;
/* measured: ~26 ms (#5559) */
const QUOTES = 300_000;
/* guess: 400x the scanner's time (#5559) */
const SCAN_LIMIT_MS = 10_000;
const spans = (line: string) =>
	maskMentions(line, EVERY_SPAN)
		.split("")
		.map((ch, i) => (ch === " " && line[i] !== " " ? "_" : line[i]))
		.join("");

describe("maskMentions: the quoted spans of a line", () => {
	it.each([
		["a `b` c", "a ___ c"],
		["``a`b`` c", "_______ c"],
		["`a``b`` c` d", "_______ __ d"],
		["`a\rb` c", "`a\rb` c"],
		["`**Review tier:** x\ry", "_________ _______ _\ry"],
		[`"a" “b” ‘c’ 'd'`, "___ ___ ___ ___"],
		["it's 'e' x'f'", "it's ___ x'f'"],
		["'g'h 'i'", "'g'h ___"],
		["“open “x” y", "_____ ___ y"],
		["`a ``b", "`a ``b"],
		['"x', '"x'],
	])("blanks the spans of %j as %j", (line, masked) => {
		expect(spans(line)).toBe(masked);
	});

	it("passes a span that is no form head through unmasked", () => {
		expect(maskMentions("see `**Review tier:** x` and `y`")).toBe(
			`see ${" ".repeat(20)} and \`y\``,
		);
	});

	it("masks nothing on unclosed curly quotes, inside the scan limit (#5559)", () => {
		const r = keptSpawn("timeout").spawnSync(
			process.execPath,
			[
				"-e",
				`const { maskMentions } = require(${JSON.stringify(require.resolve("./review-findings.js"))});
const line = "\\u201c".repeat(${QUOTES});
process.exit(maskMentions(line, /[\\s\\S]/) === line ? 0 : 1);`,
			],
			{ timeout: SCAN_LIMIT_MS },
		);
		expect(r.signal).toBeNull();
		expect(r.status).toBe(0);
	});

	it("masks nothing on unclosed backtick runs of rising length", () => {
		const line = Array.from({ length: 300 }, (_, i) => "`".repeat(i + 1)).join(
			"a",
		);
		expect(maskMentions(line, EVERY_SPAN)).toBe(line);
	});
});
