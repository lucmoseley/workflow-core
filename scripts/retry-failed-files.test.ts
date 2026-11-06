// @vitest-environment node
/*
 * retry-failed-files.js's reading of a Vitest JSON report (#4545): the files
 * it marks failed, repo-relative, or why it names none to re-run.
 */

import { describe, expect, it } from "vitest";
import { failedFiles, main } from "./retry-failed-files.js";

describe("failedFiles", () => {
	it("names each file the report marks failed, relative to the root", () => {
		const report = JSON.stringify({
			testResults: [
				{ name: "/r/scripts/a.test.ts", status: "failed" },
				{ name: "/r/scripts/b.test.ts", status: "passed" },
				{ name: "/r/scripts/c.test.ts", status: "failed" },
			],
		});
		expect(failedFiles(report, "/r")).toEqual({
			files: ["scripts/a.test.ts", "scripts/c.test.ts"],
		});
	});

	it("names none where every file passed, as a shard red for another reason", () => {
		const report = JSON.stringify({
			testResults: [{ name: "/r/a.test.ts", status: "passed" }],
		});
		expect(failedFiles(report, "/r")).toEqual({
			why: "the report marks no file failed",
		});
	});

	it("names none where the report does not parse", () => {
		expect(failedFiles("{", "/r")).toEqual({
			why: "the report does not parse",
		});
	});
});

describe("main", () => {
	it("exits 1 where no report exists, re-running nothing", () => {
		expect(main(["/nonexistent/report.json"])).toBe(1);
	});

	it("refuses a missing report argument", () => {
		expect(main([])).toBe(2);
	});
});
