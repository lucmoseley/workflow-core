// @vitest-environment node
/*
 * Pins the guard-error log's rotation: the 8 MB limit, one kept generation,
 * and silence when a concurrent session got there first.
 *
 * These exist ALONGSIDE the subprocess cases in check-guard-errors.test.ts,
 * which cover rotation end to end but reach neither race branch (mantahostels#206).
 * The fs is passed in, so each race is arranged directly.
 *
 * check-guard-errors.js reads that log whole on every `npm run status`, so a
 * loosened case lets it grow unbounded, or rotates away a log another
 * session had just refilled, or reports a race as a failed rotation.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// biome-ignore lint/suspicious/noExplicitAny: a CJS module has no types to import
const { DEFAULT_ROTATE_AT, rotateAt, rotateLog }: any =
	createRequire(__filename)("./log-rotate.js");

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
		// Warning would have several of the concurrent sessions each announce a
		// bound that held.
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
	afterEach(() => {
		delete process.env.WFC_ROTATE_AT;
	});

	it("is 8 MB", () => {
		expect(DEFAULT_ROTATE_AT).toBe(8 * 1024 * 1024);
		expect(rotateAt({})).toBe(DEFAULT_ROTATE_AT);
	});

	it("takes WFC_ROTATE_AT", () => {
		expect(rotateAt({ WFC_ROTATE_AT: "2000" })).toBe(2000);
	});

	it("ignores an override that is not a usable size", () => {
		// A zero or negative cap would rotate every log on every run; a non-number is
		// someone's typo.
		for (const override of ["0", "-1", "lots", ""])
			expect(rotateAt({ WFC_ROTATE_AT: override })).toBe(DEFAULT_ROTATE_AT);
	});

	it("defaults to this process's own environment", () => {
		process.env.WFC_ROTATE_AT = "4096";
		expect(rotateAt()).toBe(4096);
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
