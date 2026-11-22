// @vitest-environment node

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

let said: string[];

const ctx = (root: string) =>
	({
		value: (flag: string) => (flag === "--root" ? root : undefined),
		broken: (message: string) => {
			throw new Error(`BROKEN ${message}`);
		},
		say: (message: string) => said.push(message),
	}) as unknown as Parameters<typeof readTrackedScripts>[0];

const read = (root = dir) => {
	said = [];
	return readTrackedScripts(ctx(root), (rel: string) => rel.endsWith(".ts"));
};

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

	it("lists the whole tree's files on an empty top", () => {
		write("scripts/a.test.ts");
		write(".claude/skills/s/b.test.ts");
		write("c.test.ts");
		write("docs/d.js");
		said = [];
		expect(
			readTrackedScripts(ctx(dir), (rel: string) => rel.endsWith(".ts"), ""),
		).toEqual({
			root: dir,
			files: [".claude/skills/s/b.test.ts", "c.test.ts", "scripts/a.test.ts"],
		});
	});

	it("is BROKEN on a missing root, never an empty set", () => {
		expect(() => read(path.join(dir, "missing"))).toThrow(
			/^BROKEN could not read .*missing: .*No scripts\/ files read\.$/,
		);
	});

	it("is BROKEN on an unreadable root", () => {
		write("scripts/a.ts");
		fs.chmodSync(dir, 0o000);
		expect(() => read()).toThrow(
			/^BROKEN could not read .*tracked-scripts-\w+: /,
		);
	});

	it("lists none on a readable root with no scripts/, as git ls-files would", () => {
		write("docs/d.ts");
		expect(read()).toEqual({ root: dir, files: [] });
		expect(said).toEqual([]);
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
		expect(said).toEqual([
			`${path.join(dir, "scripts", "gone")} vanished mid-walk; read as empty.`,
		]);
	});
});
