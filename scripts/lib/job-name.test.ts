// @vitest-environment node
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

it("loses the name to a harness write that read the record before it: a harness limit, with no rename call and no cross-process lock on state.json", () => {
	fs.mkdirSync(jobDirPath(seat, "c0de7a11"), { recursive: true });
	fs.writeFileSync(
		jobStatePath(seat, "c0de7a11"),
		JSON.stringify({
			state: "working",
			name: "an auto title",
			nameSource: "auto",
		}),
	);
	const staleRead = readJobRecord(seat, "c0de7a11");
	expect(writeJobName(seat, "c0de7a11", "Implement 7: a title")).toBeNull();
	fs.writeFileSync(
		jobStatePath(seat, "c0de7a11"),
		JSON.stringify({ ...staleRead, state: "idle" }),
	);
	expect(readJobRecord(seat, "c0de7a11")).toEqual({
		state: "idle",
		name: "an auto title",
		nameSource: "auto",
	});
});
