// @vitest-environment node
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInProcess } from "./lib/run-in-process.js";

const TRIAL = path.join(__dirname, "combining-trial.js");
const SCAN = path.join(__dirname, "pfn-scan.js");

describe("combining-trial", () => {
	it("exits 2 on an unknown run, printing the usage", () => {
		const r = runInProcess(TRIAL, ["noon"], { env: process.env });
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("combining-trial.js night | morning");
	});
});

describe("pfn-scan", () => {
	it("exits 2 where --post is not an issue number", () => {
		const r = runInProcess(SCAN, ["x.dmp", "--post", "abc"], {
			env: process.env,
		});
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("--post takes an issue number: abc");
	});
});
