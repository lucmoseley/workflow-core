// @vitest-environment node

import { describe, expect, it } from "vitest";
import { endRun, trimEndRun, trimRun, trimStartRun } from "./trim-run.js";

describe("trimEndRun", () => {
	it("cuts the trailing run and nothing inside it", () => {
		expect(trimEndRun("a\n\nb\n\n\n", "\n")).toBe("a\n\nb");
		expect(trimEndRun("a \t\n", "\n")).toBe("a \t");
		expect(trimEndRun("\n\n", "\n")).toBe("");
		expect(trimEndRun("", "\n")).toBe("");
	});

	it("matches the regex it replaces on a mixed set", () => {
		const s = "x \t\v\f\r\n  \n";
		expect(trimEndRun(s, " \t\n\v\f\r")).toBe(s.replace(/[ \t\n\v\f\r]+$/, ""));
	});
});

describe("trimStartRun", () => {
	it("cuts the leading run and nothing after it", () => {
		expect(trimStartRun("--a-b-", "-")).toBe("a-b-");
		expect(trimStartRun("---", "-")).toBe("");
	});
});

describe("trimRun", () => {
	it("cuts the run from both ends and nothing inside it", () => {
		expect(trimRun("--a--b--", "-")).toBe("a--b");
		expect(trimRun("a-", "-")).toBe("a");
		expect(trimRun("---", "-")).toBe("");
		expect(trimRun("", "-")).toBe("");
	});
});

describe("endRun", () => {
	it("returns the run trimEndRun cuts, or empty where there is none", () => {
		expect(endRun("ab$$$", "$")).toBe("$$$");
		expect(endRun("a$b", "$")).toBe("");
		expect(endRun("\\\\", "\\")).toBe("\\\\");
		expect(endRun("", "$")).toBe("");
	});
});
