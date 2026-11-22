import fs from "node:fs";
import { vi } from "vitest";

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

export const restoreStderr = () => vi.mocked(fs.writeSync).mockRestore();
