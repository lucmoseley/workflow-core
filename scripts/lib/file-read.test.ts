// @vitest-environment node
/*
 * file-read.js's three answers (#3902): absent on ENOENT alone, the contents,
 * or unreadable with the error. A directory stands in for an unreadable file,
 * as EISDIR reads the same under root and in CI.
 *
 * Break one and every guard host reading through it misreads a missing file
 * as a fault, or a fault as a missing file: a latch re-fires, a body file
 * reads as absent, a window counts nothing.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { readBytes, readText } = createRequire(__filename)(
	"./file-read.js",
) as typeof import("./file-read.js");

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-read-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("readText", () => {
	it("reads a present file's text", () => {
		const file = path.join(dir, "a");
		fs.writeFileSync(file, "héllo");
		expect(readText(file)).toEqual({ state: "read", data: "héllo" });
	});

	it("reads an empty file as read, not absent", () => {
		const file = path.join(dir, "a");
		fs.writeFileSync(file, "");
		expect(readText(file)).toEqual({ state: "read", data: "" });
	});

	it("reads a missing file, and a dangling symlink, as absent", () => {
		const link = path.join(dir, "link");
		fs.symlinkSync(path.join(dir, "gone"), link);
		expect(readText(path.join(dir, "nope"))).toEqual({ state: "absent" });
		expect(readText(link)).toEqual({ state: "absent" });
	});

	it("reads any other fault as unreadable, carrying the error", () => {
		const got = readText(dir);
		expect(got.state).toBe("unreadable");
		if (got.state !== "unreadable") return;
		expect((got.error as NodeJS.ErrnoException).code).toBe("EISDIR");
		expect(got.message).toMatch(/EISDIR/);
	});
});

describe("readBytes", () => {
	it("reads the raw bytes, undecoded", () => {
		const file = path.join(dir, "a");
		const bytes = Buffer.from([0xff, 0xfe, 0x00]);
		fs.writeFileSync(file, bytes);
		const got = readBytes(file);
		expect(got.state).toBe("read");
		if (got.state === "read") expect(got.data.equals(bytes)).toBe(true);
	});

	it("reads a missing file as absent", () => {
		expect(readBytes(path.join(dir, "nope"))).toEqual({ state: "absent" });
	});
});
