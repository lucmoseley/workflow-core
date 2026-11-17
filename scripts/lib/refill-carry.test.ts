// @vitest-environment node
/*
 * Pins lib/refill-carry.js, the refill loop's one choice between resuming a
 * stopped session in place and carrying it to another seat (#5302). Loosen
 * it and a session routed to its own seat is moved onto itself, or one
 * routed elsewhere resumes where it parked and holds that seat's slot.
 * Its doubles are hand-rolled: refill-blocks-fixture.ts's fakeIo is a whole
 * BlockIo, whose ports take a JobLaunch these cases have no use for.
 */
import { describe, expect, it } from "vitest";
import {
	adoptOnSeat,
	buildCarriedText,
	carriedOnto,
	parkedCarryOf,
	resumeOnSeat,
} from "./refill-carry.js";

const IDS = { sessionId: "s1", cwd: "/w" };
const OK = { failed: null, jobId: "j1", sessionId: "s1", copy: false } as const;

function fakeIo() {
	const calls: string[] = [];
	return {
		calls,
		io: {
			resumeStopped: (l: { seat: string }) => {
				calls.push(`resume ${l.seat}`);
				return OK;
			},
			moveSession: (l: { seat: string }, target: { seat: string }) => {
				calls.push(`move ${l.seat} ${target.seat}`);
				return OK;
			},
		},
	};
}

describe("resumeOnSeat", () => {
	it("resumes in place where `to` is unset or the session's own seat", () => {
		const { io, calls } = fakeIo();
		resumeOnSeat(io, { seat: "/a" }, undefined, { prompt: "p", ids: IDS });
		resumeOnSeat(io, { seat: "/a" }, "/a", { prompt: "p", ids: IDS });
		expect(calls).toEqual(["resume /a", "resume /a"]);
	});

	it("carries the session to another seat `to`", () => {
		const { io, calls } = fakeIo();
		resumeOnSeat(io, { seat: "/a" }, "/b", { prompt: "p", ids: IDS });
		expect(calls).toEqual(["move /a /b"]);
	});

	it("runs the caller's in-place resume in place of resumeStopped", () => {
		const { io, calls } = fakeIo();
		resumeOnSeat(io, { seat: "/a" }, undefined, {
			prompt: "p",
			ids: IDS,
			inPlace: () => {
				calls.push("own id");
				return OK;
			},
		});
		expect(calls).toEqual(["own id"]);
	});
});

describe("adoptOnSeat", () => {
	it("looks on the seat a carry went to, with that move, and on its own seat else", () => {
		const looked: string[] = [];
		const adopt = (
			l: { seat: string },
			_ids: unknown,
			_since: number,
			move?: { seat: string },
		) => {
			looked.push(`${l.seat} ${move?.seat ?? "-"}`);
			return null;
		};
		adoptOnSeat(adopt, { seat: "/a" }, "/b", { ids: IDS, since: 1 });
		adoptOnSeat(adopt, { seat: "/a" }, "/a", { ids: IDS, since: 1 });
		expect(looked).toEqual(["/b /b", "/a -"]);
	});
});

describe("the record of a carry", () => {
	it("names the seat it went to and the one it left, and nothing where it stayed", () => {
		expect(carriedOnto("/a", "/b")).toEqual({
			seat: "/b",
			reason: "moved from /a",
		});
		expect(carriedOnto("/a", "/a")).toEqual({});
		expect(carriedOnto("/a")).toEqual({});
		expect(buildCarriedText("/a", "/b")).toBe(", moved from /a to /b");
		expect(buildCarriedText("/a")).toBe("");
	});

	it("reads a parked route's stopped seat off `from`, else its own seat", () => {
		const target = { seat: "/b", sessionId: "s", cwd: "/w" };
		expect(parkedCarryOf({ ...target, from: "/a" })).toEqual({
			from: "/a",
			to: "/b",
			ids: { sessionId: "s", cwd: "/w" },
		});
		expect(parkedCarryOf(target)).toMatchObject({ from: "/b", to: "/b" });
	});
});
