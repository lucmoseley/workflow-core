// @vitest-environment node
/*
 * lib/filed-line.js: the line naming the issue file-issue.js filed, read out
 * of output that names other issues first.
 */
import { describe, expect, it } from "vitest";
import { buildFiledLine, parseFiledLine } from "./filed-line.js";

describe("parseFiledLine", () => {
	it("reads the filed issue past the sibling and similar-title lines printed before it", () => {
		const stdout = [
			"  #4498 — filed by this session",
			"  #4501 — filed by this session",
			buildFiledLine(4504, "https://github.com/o/r/issues/4504"),
			"labels: takes:implement, kind:ticket",
			"linked #4504 as a sub-issue of #4485",
			"",
		].join("\n");
		expect(parseFiledLine(stdout)).toEqual({
			line: "Filed #4504: https://github.com/o/r/issues/4504",
			n: 4504,
		});
	});

	it("throws where no Filed line was printed, naming the first line", () => {
		expect(() => parseFiledLine("  #4498 — filed by this session\n")).toThrow(
			"printed no Filed #<n> line: #4498 — filed by this session",
		);
	});
});
