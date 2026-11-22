// @vitest-environment node
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const { rotateLog } = createRequire(__filename)("./log-rotate.js") as {
	rotateLog: (
		logPath: string,
		readSize: number,
		options?: { fs?: unknown; limit?: number },
	) => string | null;
};

const LOG = "/nowhere/errors.log";

function fakeFs(opts: {
	size?: number;
	statThrows?: NodeJS.ErrnoException;
	renameThrows?: NodeJS.ErrnoException;
}) {
	const renames: string[][] = [];
	return {
		renames,
		statSync(_p: string) {
			if (opts.statThrows) throw opts.statThrows;
			return { size: opts.size };
		},
		renameSync(from: string, to: string) {
			if (opts.renameThrows) throw opts.renameThrows;
			renames.push([from, to]);
		},
	};
}

const errno = (code: string) => Object.assign(new Error(code), { code });

describe("the size test", () => {
	it("leaves a log at or under the limit alone", () => {
		for (const readSize of [0, 99, 100]) {
			const io = fakeFs({ size: readSize });
			expect(rotateLog(LOG, readSize, { fs: io, limit: 100 })).toBeNull();
			expect(io.renames).toEqual([]);
		}
	});

	it("moves an oversized log aside, keeping one generation", () => {
		const io = fakeFs({ size: 101 });
		expect(rotateLog(LOG, 101, { fs: io, limit: 100 })).toBeNull();
		expect(io.renames).toEqual([[LOG, `${LOG}.1`]]);
	});
});

describe("concurrent rotation", () => {
	it("does NOT rotate a log that grew between the read and the stat", () => {
		const io = fakeFs({ size: 300 });
		expect(rotateLog(LOG, 200, { fs: io, limit: 100 })).toBeNull();
		expect(io.renames).toEqual([]);
	});

	it("says nothing when another session rotated it first", () => {
		const io = fakeFs({ size: 200, renameThrows: errno("ENOENT") });
		expect(rotateLog(LOG, 200, { fs: io, limit: 100 })).toBeNull();
	});

	it("says nothing when the log vanished before the stat", () => {
		const io = fakeFs({ statThrows: errno("ENOENT") });
		expect(rotateLog(LOG, 200, { fs: io, limit: 100 })).toBeNull();
	});
});

describe("a rotation that genuinely failed", () => {
	it("reports the size and the errno", () => {
		const io = fakeFs({ size: 200, renameThrows: errno("EACCES") });
		const msg = rotateLog(LOG, 200, { fs: io, limit: 100 });
		expect(msg).toContain(LOG);
		expect(msg).toContain("200 bytes");
		expect(msg).toContain("EACCES");
	});

	it("falls back to the message where there is no errno", () => {
		const io = fakeFs({ size: 200, renameThrows: new Error("disk on fire") });
		expect(rotateLog(LOG, 200, { fs: io, limit: 100 })).toContain(
			"disk on fire",
		);
	});
});

describe("the limit", () => {
	const EightMb = 8 * 1024 * 1024;
	const rotates = (readSize: number) => {
		const io = fakeFs({ size: readSize });
		expect(rotateLog(LOG, readSize, { fs: io })).toBeNull();
		return io.renames.length > 0;
	};

	it("is 8 MB", () => {
		vi.stubEnv("WFC_ROTATE_AT", "");
		expect(rotates(EightMb)).toBe(false);
		expect(rotates(EightMb + 1)).toBe(true);
	});

	it("takes WFC_ROTATE_AT", () => {
		vi.stubEnv("WFC_ROTATE_AT", "2000");
		expect(rotates(2000)).toBe(false);
		expect(rotates(2001)).toBe(true);
	});

	it("ignores an override that is not a usable size", () => {
		for (const override of ["0", "-1", "lots", ""]) {
			vi.stubEnv("WFC_ROTATE_AT", override);
			expect(rotates(EightMb)).toBe(false);
			expect(rotates(EightMb + 1)).toBe(true);
		}
	});
});

describe("against a real filesystem", () => {
	it("replaces the generation already at .1, and the live path is gone", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-rotate-"));
		try {
			const log = path.join(dir, "errors.log");
			fs.writeFileSync(log, "x".repeat(200));
			fs.writeFileSync(`${log}.1`, "an older generation\n");

			expect(rotateLog(log, 200, { limit: 100 })).toBeNull();

			expect(fs.existsSync(log)).toBe(false);
			expect(fs.readFileSync(`${log}.1`, "utf8")).toBe("x".repeat(200));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
