// @vitest-environment node
/*
 * lib/tracked-scripts.js's `--root` walk (#3170): it answers the tracked
 * `scripts/` files an extracted tree holds, and a root it cannot read is the
 * checker's BROKEN. A module test over a temp tree and a stub ctx, since the
 * walk reads only the filesystem. Loosen it and a mistyped `--root` reports
 * OK having read nothing; tighten it and a subdirectory removed mid-walk
 * fails the commit.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readTrackedScripts } from "./tracked-scripts.js";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracked-scripts-"));
});
afterEach(() => {
	vi.restoreAllMocks();
	fs.chmodSync(dir, 0o700);
	fs.rmSync(dir, { recursive: true, force: true });
});

const write = (rel: string) => {
	fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
	fs.writeFileSync(path.join(dir, rel), "");
};

/** A ctx whose `--root` is `root` and whose BROKEN throws its message. */
const ctx = (root: string) =>
	({
		value: (flag: string) => (flag === "--root" ? root : undefined),
		broken: (message: string) => {
			throw new Error(`BROKEN ${message}`);
		},
	}) as unknown as Parameters<typeof readTrackedScripts>[0];

const read = (root = dir) =>
	readTrackedScripts(ctx(root), (rel: string) => rel.endsWith(".ts"));

describe("readTrackedScripts on --root", () => {
	it("lists the scripts/ files its filter keeps, nested ones included", () => {
		write("scripts/a.test.ts");
		write("scripts/lib/b.ts");
		write("scripts/c.js");
		write("docs/d.ts");
		expect(read()).toEqual({
			root: dir,
			files: ["scripts/a.test.ts", "scripts/lib/b.ts"],
		});
	});

	it("is BROKEN on a root with no scripts/, never an empty set", () => {
		expect(() => read(path.join(dir, "missing"))).toThrow(
			/^BROKEN could not read .*missing\/scripts: .*No scripts\/ files read\.$/,
		);
	});

	it("is BROKEN on an unreadable subdirectory", () => {
		write("scripts/lib/b.ts");
		fs.chmodSync(path.join(dir, "scripts/lib"), 0o000);
		try {
			expect(() => read()).toThrow(/^BROKEN could not read .*scripts\/lib: /);
		} finally {
			fs.chmodSync(path.join(dir, "scripts/lib"), 0o700);
		}
	});

	it("reads a subdirectory gone between its listing and its read as empty", () => {
		write("scripts/a.ts");
		write("scripts/gone/b.ts");
		/* The race between a directory's listing and its read cannot be staged
		 * on a real tree, so the read is stubbed. */
		const real = fs.readdirSync;
		vi.spyOn(fs, "readdirSync").mockImplementation(((
			p: fs.PathLike,
			o: never,
		) => {
			if (String(p).endsWith(`${path.sep}gone`))
				throw Object.assign(new Error("ENOENT: gone"), { code: "ENOENT" });
			return real(p, o);
		}) as typeof fs.readdirSync);
		expect(read().files).toEqual(["scripts/a.ts"]);
	});
});
