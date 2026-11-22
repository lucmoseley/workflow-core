import { vi } from "vitest";

// #5584
export function seenFrom<T>(cwd: string, read: () => T): T {
	const spy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
	try {
		return read();
	} finally {
		spy.mockRestore();
	}
}
