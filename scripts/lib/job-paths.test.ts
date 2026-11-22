// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	isBackgroundJob,
	readJobDir,
	readJobRecordAt,
	readJobRecordIn,
} from "./job-paths.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "job-paths-"));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

it("reads a record, and none where it is missing, torn or its directory is a file", () => {
	const job = path.join(tmp, "job");
	expect(readJobRecordIn(job)).toBeNull();
	fs.mkdirSync(job);
	fs.writeFileSync(path.join(job, "state.json"), '{"cwd": "/x"');
	expect(readJobRecordIn(job)).toBeNull();
	fs.writeFileSync(path.join(job, "state.json"), '{"cwd": "/x"}');
	expect(readJobRecordIn(job)).toEqual({ cwd: "/x" });
	const file = path.join(tmp, "stray");
	fs.writeFileSync(file, "");
	expect(readJobRecordIn(file)).toBeNull();
});

it("throws where the record will not read for any other cause", () => {
	const job = path.join(tmp, "job");
	fs.mkdirSync(job);
	fs.writeFileSync(path.join(job, "state.json"), "{}");
	fs.chmodSync(path.join(job, "state.json"), 0o000);
	expect(() => readJobRecordIn(job)).toThrow(/EACCES/);
	expect(readJobRecordAt(job)).toMatchObject({
		state: "unreadable",
		message: expect.stringContaining("EACCES"),
	});
});

describe("isBackgroundJob and readJobDir (#5518)", () => {
	it("reads a set job dir as a job, naming the dir", () => {
		const env = { CLAUDE_JOB_DIR: "/jobs/abc" };
		expect(isBackgroundJob(env)).toBe(true);
		expect(readJobDir(env)).toBe("/jobs/abc");
	});

	it.each([
		["a print-mode run", { CLAUDE_CODE_ENTRYPOINT: "sdk-cli" }],
		["an empty job dir", { CLAUDE_JOB_DIR: "" }],
		["no harness variables", {}],
	])("reads %s as no job", (_, env) => {
		expect(isBackgroundJob(env)).toBe(false);
		expect(readJobDir(env)).toBeNull();
	});
});
