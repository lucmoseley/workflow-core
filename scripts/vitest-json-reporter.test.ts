// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import DurationJsonReporter from "./vitest-json-reporter.js";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "json-reporter-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const FILE = "/repo/hook.test.ts";

const testModule = (duration?: number) => {
	const task = {
		type: "suite",
		name: "hook.test.ts",
		filepath: FILE,
		result: duration === undefined ? undefined : { state: "pass", duration },
		tasks: [] as unknown[],
	};
	task.tasks.push({
		type: "test",
		name: "quick",
		mode: "run",
		result: { state: "pass", startTime: 2000, duration: 10 },
		file: task,
	});
	return {
		moduleId: FILE,
		task,
		diagnostic: () => ({ duration: task.result?.duration || 0 }),
	};
};

interface Result {
	name: string;
	startTime: number;
	endTime: number;
	duration?: number;
}

async function reported(duration?: number): Promise<Result | undefined> {
	const outputFile = path.join(dir, "report.json");
	const reporter = new DurationJsonReporter({ outputFile });
	reporter.onInit({
		config: { root: dir },
		logger: { log: () => undefined, warn: () => undefined },
		snapshot: { summary: {} },
	} as never);
	await reporter.onTestRunEnd([testModule(duration)] as never);
	return JSON.parse(fs.readFileSync(outputFile, "utf8")).testResults[0];
}

describe("vitest-json-reporter (#4313)", () => {
	it("adds each file's run time, hooks included, beside the tests' own span", async () => {
		const result = await reported(1500);
		expect(result).toMatchObject({ name: FILE, duration: 1500 });
		expect(result && result.endTime - result.startTime).toBe(10);
	});

	it("adds no duration to a file never run, rather than a 0 (mantahostels#2039)", async () => {
		expect(await reported(undefined)).not.toHaveProperty("duration");
	});
});
