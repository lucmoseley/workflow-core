import { describe, expect, it } from "vitest";
import { launchRecordReader } from "./launch-record.js";

const BG = { state: "working", sessionId: "s-bg", cwd: "/r" };
const RUN = { state: "working", sessionId: "s-run", cwd: "/w" };

function reader(runAsJob: (jobId: string) => typeof RUN | null = () => RUN) {
	const lines: string[] = [];
	const calls: string[][] = [];
	const read = launchRecordReader({
		log: (line) => lines.push(line),
		readJobRecord: (seat, jobId) => {
			calls.push(["bg", seat, jobId]);
			return BG;
		},
		readRunAsJob: (jobId) => {
			calls.push(["run", jobId]);
			return runAsJob(jobId);
		},
	});
	return { read, lines, calls };
}

describe("launchRecordReader (#4587)", () => {
	it("reads a plan launch's --bg job record on its seat", () => {
		const { read, calls } = reader();
		expect(read({ seat: "/s", jobId: "j1" })).toBe(BG);
		expect(calls).toEqual([["bg", "/s", "j1"]]);
	});

	it("reads a key launch's headless run in the same shape", () => {
		const { read, calls } = reader();
		expect(read({ seat: "/s", keyVar: "K2", jobId: "0e0e0e0e" })).toBe(RUN);
		expect(calls).toEqual([["run", "0e0e0e0e"]]);
	});

	it("gives null, logged, where the headless run will not read", () => {
		const { read, lines } = reader(() => {
			throw new Error("EISDIR");
		});
		expect(read({ seat: "/s", keyVar: "K2", jobId: "0e0e0e0e" })).toBeNull();
		expect(lines).toEqual([
			expect.stringMatching(/^headless run 0e0e0e0e unread: .*EISDIR/),
		]);
	});

	it("reads nothing for a launch with no job", () => {
		const { read, calls } = reader();
		expect(read({ seat: "/s", keyVar: "K2", jobId: null })).toBeNull();
		expect(calls).toEqual([]);
	});
});
