// @vitest-environment node
/*
 * The one launch-record reader (lib/launch-record.js, #4587) over
 * lib/resume-io-fake.ts, whose route reads resume-io.contract.test.ts holds to
 * the production adapter: a plan launch reads its `--bg` job record, a key
 * launch its headless run, and a headless record that will not read is logged.
 *
 * Loosen one and the refill loop reads a key launch's state off a `--bg` job
 * store it never wrote, or loses why its record would not read.
 */

import { describe, expect, it } from "vitest";
import { buildLaunchRecordReader } from "./launch-record.js";
import {
	ANSWERS,
	FAULTS,
	fakeResumeIo,
	HEADLESS_JOB,
	JOB,
	KEY_VAR,
	type Picks,
} from "./resume-io-fake";

const SEAT = "/home/u/.claude3";

function reader(picks: Picks = {}) {
	const fake = fakeResumeIo(picks);
	return { ...fake, read: buildLaunchRecordReader(fake.io) };
}

describe("buildLaunchRecordReader (#4587)", () => {
	it("reads a plan launch's --bg job record on its seat", () => {
		const { read, callsTo } = reader({ readJobRecord: "working" });
		expect(read({ seat: SEAT, jobId: JOB })).toEqual(
			ANSWERS.readJobRecord.working,
		);
		expect(callsTo("readJobRecord")).toEqual([[SEAT, JOB]]);
		expect(callsTo("readRunAsJob")).toEqual([]);
	});

	it("reads a key launch's headless run in the same shape", () => {
		const { read, callsTo } = reader({ readRunAsJob: "working" });
		expect(read({ seat: SEAT, keyVar: KEY_VAR, jobId: HEADLESS_JOB })).toEqual(
			ANSWERS.readRunAsJob.working,
		);
		expect(callsTo("readRunAsJob")).toEqual([[HEADLESS_JOB]]);
		expect(callsTo("readJobRecord")).toEqual([]);
	});

	it("gives null, logged, where the headless run will not read", () => {
		const { read, lines } = reader({ readRunAsJob: "unreadable" });
		expect(
			read({ seat: SEAT, keyVar: KEY_VAR, jobId: HEADLESS_JOB }),
		).toBeNull();
		expect(lines).toEqual([
			expect.stringMatching(
				`^headless run ${HEADLESS_JOB} unread: .*${FAULTS.readRunAsJob.unreadable}`,
			),
		]);
	});

	it("reads nothing for a launch with no job", () => {
		const { read, callsTo } = reader();
		expect(read({ seat: SEAT, keyVar: KEY_VAR, jobId: null })).toBeNull();
		expect(callsTo("readRunAsJob")).toEqual([]);
		expect(callsTo("readJobRecord")).toEqual([]);
	});

	it("logs which file would not read, the run's log included", () => {
		const { read, lines } = reader({ readRunAsJob: "logUnreadable" });
		expect(
			read({ seat: SEAT, keyVar: KEY_VAR, jobId: HEADLESS_JOB }),
		).toBeNull();
		expect(lines).toEqual([
			expect.stringContaining(FAULTS.readRunAsJob.logUnreadable),
		]);
	});
});
