// @vitest-environment node
/*
 * lib/job-name.js's name written onto a job record (#4098): the name and the
 * one source the harness's auto-namer leaves, every other field kept. Loosen
 * it and a resumed copy lists under an auto title, or loses its record.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { writeJobName } from "./job-name.js";
import { jobDirPath, jobStatePath, readJobRecord } from "./job-paths.js";

let seat: string;

beforeEach(() => {
	seat = fs.mkdtempSync(path.join(os.tmpdir(), "job-name-"));
});

afterEach(() => {
	fs.rmSync(seat, { recursive: true, force: true });
});

it("writes the name, sourced as the user's, keeping the record's other fields", () => {
	fs.mkdirSync(jobDirPath(seat, "c0de7a11"), { recursive: true });
	fs.writeFileSync(
		jobStatePath(seat, "c0de7a11"),
		JSON.stringify({
			state: "working",
			name: "an auto title",
			nameSource: "auto",
		}),
	);
	expect(writeJobName(seat, "c0de7a11", "Implement 7: a title")).toBeNull();
	expect(readJobRecord(seat, "c0de7a11")).toEqual({
		state: "working",
		name: "Implement 7: a title",
		nameSource: "user",
	});
});

it("names a job with no record as unwritten, creating none", () => {
	expect(writeJobName(seat, "c0de7a11", "n")).toMatch(/ENOENT/);
	expect(fs.existsSync(jobDirPath(seat, "c0de7a11"))).toBe(false);
});
