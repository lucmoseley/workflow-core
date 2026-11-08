// @vitest-environment node
/*
 * job-paths.js's readJobRecordIn: a missing or torn record reads as none, and
 * any other fault throws (#4704). Loosen it and an unreadable record reads as
 * no job, so the reaper can judge a resumable session's worktree reapable.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const { readJobRecordIn }: any = createRequire(__filename)("./job-paths.js");

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
});
