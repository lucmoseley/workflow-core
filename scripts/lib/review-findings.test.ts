// @vitest-environment node
import { describe, expect, it } from "vitest";

const { maskMentions } =
	require("./review-findings.js") as typeof import("./review-findings");

const EVERY_SPAN = /[\s\S]/;
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

	it("masks nothing on 300,000 unclosed curly quotes, where the old regex ran past the test ceiling (#5559)", () => {
		const line = "\u201c".repeat(300_000);
		expect(maskMentions(line, EVERY_SPAN)).toBe(line);
	});

	it("masks nothing on unclosed backtick runs of rising length", () => {
		const line = Array.from({ length: 300 }, (_, i) => "`".repeat(i + 1)).join(
			"a",
		);
		expect(maskMentions(line, EVERY_SPAN)).toBe(line);
	});
});
