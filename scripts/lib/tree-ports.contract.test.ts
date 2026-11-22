// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { treePorts } from "./guard-host-ports.js";
import { treePortsFake } from "./tree-ports-fake";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "tree-ports-"));
	fs.writeFileSync(path.join(dir, "a.md"), "x");
	fs.mkdirSync(path.join(dir, "sub"));
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("a tree's read, the host's and the fake's alike", () => {
	it.each([
		["the host's", () => treePorts(dir)],
		[
			"the fake's",
			() =>
				treePortsFake({
					"a.md": "x",
					sub: new Error("EISDIR: illegal operation on a directory"),
				}),
		],
	])("%s answers read, absent or unreadable", (_, tree) => {
		const t = tree();
		expect(t.read("a.md")).toEqual({ state: "read", data: "x" });
		expect(t.read("nope.md")).toEqual({ state: "absent" });
		expect(t.read("sub").state).toBe("unreadable");
	});

	it.each([
		["the host's", () => treePorts(dir)],
		["the fake's", () => treePortsFake({})],
	])(
		"%s repoRel gives a path under the root relative, and null outside it",
		(_, tree) => {
			const t = tree();
			expect(t.repoRel(path.join(t.root, "a.md"))).toBe("a.md");
			expect(
				t.repoRel(path.join(path.dirname(t.root), "elsewhere.md")),
			).toBeNull();
			expect(t.repoRel("a.md")).toBeNull();
		},
	);
});
