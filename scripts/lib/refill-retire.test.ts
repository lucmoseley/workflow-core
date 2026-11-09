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
import { fakeIo, logs, record } from "./refill-blocks-fixture";
import { retireOriginals } from "./refill-retire.js";

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

const copyLaunch = (over: Record<string, unknown> = {}) =>
	record({ jobId: COPY_JOB, ...over }) as JobLaunch;

/** The fixture's io, its retireJob answering `answers` in turn. */
const ioAnswering = (...answers: (string | null)[]) =>
	fakeIo({ retireJob: () => answers.shift() ?? null });

const comments = (calls: string[]) =>
	calls.filter((c) => c.startsWith("comment "));

describe("retireOriginals (#4646)", () => {
	it("retires an original whose stop was refused on a later tick, leaving the launch without it", () => {
		const retired: string[][] = [];
		const { io, calls } = fakeIo({
			retireJob: (seat, sessionId, cwd) => {
				retired.push([seat, sessionId, cwd]);
				return null;
			},
		});
		const [out] = retireOriginals([copyLaunch({ unretired: [UNRETIRED] })], io);
		expect(retired).toEqual([[SEAT, ORIGINAL_SESSION, "/home/u/repo"]]);
		expect(out).not.toHaveProperty("unretired");
		expect(comments(calls)).toEqual([]);
	});

	it("counts a refused try and keeps the original for the next tick", () => {
		const { io, calls } = ioAnswering("daemon busy");
		const [out] = retireOriginals([copyLaunch({ unretired: [UNRETIRED] })], io);
		expect(out?.unretired).toEqual([{ ...UNRETIRED, tries: 2 }]);
		expect(comments(calls)).toEqual([]);
		expect(logs(calls).at(-1)).toContain("try 2 of 3: daemon busy");
	});

	it("comments naming both job ids on the third refusal, and stops trying", () => {
		const { io, calls } = ioAnswering("daemon busy", "daemon busy");
		let launches = retireOriginals(
			[copyLaunch({ unretired: [UNRETIRED] })],
			io,
		);
		expect(comments(calls)).toEqual([]);
		launches = retireOriginals(launches, io);
		expect(launches[0]).not.toHaveProperty("unretired");
		const said = comments(calls);
		expect(said).toHaveLength(1);
		expect(said[0]).toContain(ORIGINAL_JOB);
		expect(said[0]).toContain(COPY_JOB);
	});

	it("leaves a launch with no unretired original untouched, retiring nothing", () => {
		const retired: string[] = [];
		const { io } = fakeIo({
			retireJob: (_, sessionId) => {
				retired.push(sessionId);
				return null;
			},
		});
		const l = copyLaunch();
		expect(retireOriginals([l], io)).toEqual([l]);
		expect(retired).toEqual([]);
	});
});

describe("relaunched carries a copy's unretired original (#4646)", () => {
	const copied = {
		failed: null,
		jobId: COPY_JOB,
		sessionId: "copy-session",
		copy: true,
		why: "copied",
		fromSessionId: ORIGINAL_SESSION,
	} as const;

	it("adds it to those the launch already holds", () => {
		const earlier = { ...UNRETIRED, copyJobId: "cccccccc" };
		const out = relaunched(
			copyLaunch({ jobId: "cccccccc", unretired: [earlier] }),
			{ ...copied, unretired: UNRETIRED },
			1,
		);
		expect(out.unretired).toEqual([earlier, UNRETIRED]);
	});

	it("adds nothing for a copy whose original retired", () => {
		const out = relaunched(copyLaunch({ jobId: "cccccccc" }), copied, 1);
		expect(out).not.toHaveProperty("unretired");
	});
});
