// @vitest-environment node
/*
 * lib/atomic-write.js's guarantee (#2085): a reader sees the old file or the
 * new one, never a torn write, and a failed write leaves the old file and no
 * aside behind. Every caller's own suite relies on this one. In-process, each
 * case in its own temp directory: beforeRename is the reader's window between
 * the two steps, and fs is spied only to tear a write.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const load = createRequire(__filename);
const { asidePid, writeFileAtomic } = load("./atomic-write.js");

let dir: string;
let file: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-"));
	file = path.join(dir, "record.json");
	fs.writeFileSync(file, "old\n");
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic", () => {
	it("keeps the old bytes at the target until the new ones are whole", () => {
		let seen: string | undefined;
		writeFileAtomic(file, "new\n", {
			beforeRename: () => {
				seen = fs.readFileSync(file, "utf8");
			},
		});
		expect(seen).toBe("old\n");
		expect(fs.readFileSync(file, "utf8")).toBe("new\n");
		expect(fs.readdirSync(dir)).toEqual(["record.json"]);
	});

	it("leaves the old file and no aside when the write tears", () => {
		// A spy, since no real seam fills a disk under a temp directory: it
		// writes half the bytes to the aside and then fails as ENOSPC would.
		const real = fs.writeFileSync;
		vi.spyOn(fs, "writeFileSync").mockImplementation((target) => {
			real(target, "ne");
			throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
		});
		expect(() => writeFileAtomic(file, "new\n")).toThrow("ENOSPC");
		vi.restoreAllMocks();
		expect(fs.readFileSync(file, "utf8")).toBe("old\n");
		expect(fs.readdirSync(dir)).toEqual(["record.json"]);
	});

	it("leaves the old file and no aside when beforeRename throws", () => {
		expect(() =>
			writeFileAtomic(file, "new\n", {
				beforeRename: () => {
					throw new Error("log refused");
				},
			}),
		).toThrow("log refused");
		expect(fs.readFileSync(file, "utf8")).toBe("old\n");
		expect(fs.readdirSync(dir)).toEqual(["record.json"]);
	});

	it("creates the directory under mkdir and sets mode past the umask", () => {
		const nested = path.join(dir, "a", "b", "secret");
		const umask = process.umask(0o077);
		try {
			writeFileAtomic(nested, "s", { mkdir: true, mode: 0o640 });
		} finally {
			process.umask(umask);
		}
		expect(fs.readFileSync(nested, "utf8")).toBe("s");
		expect(fs.statSync(nested).mode & 0o777).toBe(0o640);
	});
});

describe("asidePid", () => {
	it("reads the writer's pid off the aside writeFileAtomic really makes", () => {
		let names: string[] = [];
		writeFileAtomic(file, "new\n", {
			beforeRename: () => {
				names = fs.readdirSync(dir).filter((n) => n !== "record.json");
			},
		});
		expect(names).toHaveLength(1);
		expect(asidePid("record.json", names[0])).toBe(process.pid);
	});

	it.each([
		"record.json",
		"record.json.12.0a1b2c3.tmp",
		"record.json.12.0A1B2C3D.tmp",
		"recordXjson.12.0a1b2c3d.tmp",
		"other.json.12.0a1b2c3d.tmp",
	])("reads %s as no aside of record.json", (name) => {
		expect(asidePid("record.json", name)).toBeNull();
	});
});
