// @vitest-environment node
/*
 * lib/write-fd.js's two promises (#1641): every byte reaches the fd, and a
 * reader that takes nothing holds the process for the ceiling once, not per
 * write. fs.writeSync and the pause are stubbed, so no case waits for real;
 * the full-pipe cases in cli-args.test.ts and session-arbiter.test.ts drive a
 * real pipe.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const load = createRequire(__filename);
const { writeFd } = load("./write-fd.js");
const sleep = load("./sleep-sync.js");

/* The ceiling over the pause, both from write-fd.js. */
const PAUSES_TO_CEILING = 10_000 / 10;

const eagain = () => {
	throw Object.assign(new Error("EAGAIN"), { code: "EAGAIN" });
};

/* writeFd always hands writeSync a Buffer; the spy's type is the string
 * overload's. */
const bytes = (data: unknown) => data as Buffer;

const stubPause = () =>
	vi.spyOn(sleep, "sleepSync").mockImplementation(() => undefined);

/** A write that takes the whole of what it is offered. */
const takesAll = () =>
	vi
		.spyOn(fs, "writeSync")
		.mockImplementation(
			(_fd, data, offset) => bytes(data).length - (offset as number),
		);

afterEach(() => {
	vi.restoreAllMocks();
	// A write that makes progress resets the stall the module carries.
	takesAll();
	writeFd(1, "x");
	vi.restoreAllMocks();
});

describe("writeFd", () => {
	it("finishes a partial write rather than dropping its tail", () => {
		const seen: number[] = [];
		vi.spyOn(fs, "writeSync").mockImplementation((_fd, data, offset) => {
			seen.push(bytes(data)[offset as number] as number);
			return 1;
		});
		writeFd(2, "héllo");
		expect(Buffer.from(seen).toString()).toBe("héllo");
	});

	it("waits out EAGAIN and then writes", () => {
		const pause = stubPause();
		let refusals = 3;
		vi.spyOn(fs, "writeSync").mockImplementation((_fd, data, offset) =>
			refusals-- > 0 ? eagain() : bytes(data).length - (offset as number),
		);
		writeFd(1, "LINE\n");
		expect(pause).toHaveBeenCalledTimes(3);
	});

	it("gives up at the ceiling, and fails the next write at once on the same stalled reader", () => {
		const pause = stubPause();
		vi.spyOn(fs, "writeSync").mockImplementation(eagain);
		expect(() => writeFd(1, "a\n")).toThrow("EAGAIN");
		expect(pause).toHaveBeenCalledTimes(PAUSES_TO_CEILING);
		expect(() => writeFd(1, "b\n")).toThrow("EAGAIN");
		expect(pause).toHaveBeenCalledTimes(PAUSES_TO_CEILING);
	});

	it("counts a write that takes no bytes toward the ceiling", () => {
		const pause = stubPause();
		vi.spyOn(fs, "writeSync").mockReturnValue(0);
		expect(() => writeFd(1, "a\n")).toThrow("fd 1 took no bytes");
		expect(pause).toHaveBeenCalledTimes(PAUSES_TO_CEILING);
	});
});
