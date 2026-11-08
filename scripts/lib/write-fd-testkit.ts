/*
 * write-fd-testkit.ts — what a module under test writes to stderr through
 * lib/write-fd.js, captured in process. writeFd goes through fs.writeSync, so
 * a spy on process.stderr.write sees none of it (#4018, #4604).
 */

import fs from "node:fs";
import { vi } from "vitest";

/**
 * Every writeFd write to fd 2, one call per writeSync with the text it
 * carried; any other fd's write goes through. Undone by restoreStderr or
 * vi.restoreAllMocks.
 */
export const spyStderr = () => {
	const write = vi.fn((_text: string) => true);
	const real = fs.writeSync;
	vi.spyOn(fs, "writeSync").mockImplementation(((
		fd: number,
		data: Buffer,
		offset?: number | null,
		...rest: number[]
	) => {
		if (fd !== 2) return real(fd, data, offset, ...rest);
		const from = offset ?? 0;
		write(data.subarray(from).toString());
		return data.length - from;
	}) as typeof fs.writeSync);
	return write;
};

/** Ends the capture spyStderr began. */
export const restoreStderr = () => vi.mocked(fs.writeSync).mockRestore();
