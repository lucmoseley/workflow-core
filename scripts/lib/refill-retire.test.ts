// @vitest-environment node
/*
 * The retry of a copy's original whose job would not retire (#4646,
 * lib/refill-retire.js), and its carrying onto the launch the copy runs as
 * (lib/refill-block-core.js's relaunched).
 *
 * Loosen one and an original whose stop a busy daemon refused stays
 * revivable beside its copy, the double-run #4098 set out to prevent, with
 * nobody told two rows are live.
 */
import { describe, expect, it } from "vitest";
import { relaunched } from "./refill-block-core.js";
import { RETIRE_TRIES, retireOriginals } from "./refill-retire.js";

type Launch = import("./refill-loop.js").LoopLaunch;
type JobLaunch = import("./refill-blocks.js").JobLaunch;
type Unretired = import("./refill-blocks.js").Unretired;

const SEAT = "/home/u/.claude3";
const ORIGINAL_SESSION = "aaaaaaaa-1111-2222-3333-444444444444";
const ORIGINAL_JOB = "aaaaaaaa";
const COPY_JOB = "bbbbbbbb";

const UNRETIRED: Unretired = {
	seat: SEAT,
	sessionId: ORIGINAL_SESSION,
	cwd: "/home/u/repo",
	copyJobId: COPY_JOB,
	tries: 1,
};

const launch = (over: Partial<JobLaunch> = {}): JobLaunch => ({
	root: "/home/u/repo",
	issues: [7],
	prompt: "/implement 7",
	seat: SEAT,
	reason: "parked session's seat",
	jobId: COPY_JOB,
	launchedAt: 0,
	finishedAt: null,
	...over,
});

/** An io whose retireJob answers `answers` in turn, and what it was asked. */
function fakeIo(...answers: (string | null)[]) {
	const retired: string[][] = [];
	const comments: string[] = [];
	const lines: string[] = [];
	const io = {
		retireJob: (seat: string, sessionId: string, cwd: string) => {
			retired.push([seat, sessionId, cwd]);
			return answers.shift() ?? null;
		},
		comment: (_: Launch, body: string) => comments.push(body),
		log: (line: string) => lines.push(line),
	};
	return { io, retired, comments, lines };
}

describe("retireOriginals (#4646)", () => {
	it("retires an original whose stop was refused on a later tick, leaving the launch without it", () => {
		const { io, retired, comments } = fakeIo(null);
		const [out] = retireOriginals([launch({ unretired: [UNRETIRED] })], io);
		expect(retired).toEqual([[SEAT, ORIGINAL_SESSION, "/home/u/repo"]]);
		expect(out).not.toHaveProperty("unretired");
		expect(comments).toEqual([]);
	});

	it("counts a refused try and keeps the original for the next tick", () => {
		const { io, comments, lines } = fakeIo("daemon busy");
		const [out] = retireOriginals([launch({ unretired: [UNRETIRED] })], io);
		expect(out?.unretired).toEqual([{ ...UNRETIRED, tries: 2 }]);
		expect(comments).toEqual([]);
		expect(lines.at(-1)).toContain(`try 2 of ${RETIRE_TRIES}: daemon busy`);
	});

	it("comments naming both job ids once the tries run out, and stops trying", () => {
		const { io, comments } = fakeIo("daemon busy");
		const [out] = retireOriginals(
			[launch({ unretired: [{ ...UNRETIRED, tries: RETIRE_TRIES - 1 }] })],
			io,
		);
		expect(out).not.toHaveProperty("unretired");
		expect(comments).toHaveLength(1);
		expect(comments[0]).toContain(ORIGINAL_JOB);
		expect(comments[0]).toContain(COPY_JOB);
	});

	it("leaves a launch with no unretired original untouched, retiring nothing", () => {
		const { io, retired } = fakeIo();
		const l = launch();
		expect(retireOriginals([l], io)).toEqual([l]);
		expect(retired).toEqual([]);
	});
});

describe("relaunched carries a copy's unretired original (#4646)", () => {
	it("adds it to those the launch already holds", () => {
		const earlier = { ...UNRETIRED, copyJobId: "cccccccc" };
		const out = relaunched(
			launch({ jobId: "cccccccc", unretired: [earlier] }),
			{
				failed: null,
				jobId: COPY_JOB,
				sessionId: "copy-session",
				copy: true,
				why: "copied",
				unretired: UNRETIRED,
				fromSessionId: ORIGINAL_SESSION,
			},
			1,
		);
		expect(out.unretired).toEqual([earlier, UNRETIRED]);
	});

	it("adds nothing for a copy whose original retired", () => {
		const out = relaunched(
			launch({ jobId: "cccccccc" }),
			{
				failed: null,
				jobId: COPY_JOB,
				sessionId: "copy-session",
				copy: true,
				why: "copied",
				fromSessionId: ORIGINAL_SESSION,
			},
			1,
		);
		expect(out).not.toHaveProperty("unretired");
	});
});
