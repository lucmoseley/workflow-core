// @vitest-environment node

import fs from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const load = createRequire(__filename);
const { writeFd, writeTerminal } = load("./write-fd.js");
const sleep = load("./sleep-sync.js");

const PAUSES_TO_CEILING = 10_000 / 10;

const eagain = () => {
	throw Object.assign(new Error("EAGAIN"), { code: "EAGAIN" });
};

const bytes = (data: unknown) => data as Buffer;

const stubPause = () =>
	vi.spyOn(sleep, "sleepSync").mockImplementation(() => undefined);

const takesAll = () =>
	vi
		.spyOn(fs, "writeSync")
		.mockImplementation(
			(_fd, data, offset) => bytes(data).length - (offset as number),
		);

afterEach(() => {
	vi.restoreAllMocks();
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

describe("writeTerminal", () => {
	it("finishes a partial write on the fd it is given, as writeFd does", () => {
		const seen: number[] = [];
		const fds = new Set<number>();
		vi.spyOn(fs, "writeSync").mockImplementation((fd, data, offset) => {
			fds.add(fd);
			seen.push(bytes(data)[offset as number] as number);
			return 1;
		});
		writeTerminal(2, "héllo");
		expect(Buffer.from(seen).toString()).toBe("héllo");
		expect([...fds]).toEqual([2]);
	});
});
