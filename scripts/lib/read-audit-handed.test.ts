// @vitest-environment node
/**
 * Tests for read-audit-handed.js's lookup of a word that does not stand
 * whole (#5160): it lands where the deepest part of it that stands leads,
 * links followed, the rest kept as spelt.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { buildHanded } = require("./read-audit-handed.js");

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length > 0)
		fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const tmp = () => {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rah-")));
	dirs.push(dir);
	return dir;
};

/** A checkout holding `a/b/file` and `a/hop` linking to `a/b`, and a
 * directory outside it linking in. */
const layout = () => {
	const root = tmp();
	fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
	fs.writeFileSync(path.join(root, "a", "b", "file"), "");
	fs.symlinkSync(path.join(root, "a", "b"), path.join(root, "a", "hop"));
	const outside = tmp();
	fs.symlinkSync(root, path.join(outside, "in"));
	return { root, outside, named: buildHanded(root).from(outside) };
};

describe("a word that does not stand whole", () => {
	it.each([
		["one part past the deepest that stands", "in/a/b/new", "a/b/new"],
		["many parts past it", "in/a/x/y/z/w", "a/x/y/z/w"],
		["a part under a file", "in/a/b/file/x/y", "a/b/file/x/y"],
		["a missing part straight under the link", "in/gone/x", "gone/x"],
		["a link as the deepest part that stands", "in/a/hop/new", "a/b/new"],
	])("lands through the link at %s", (_, word, rel) => {
		const { outside, named } = layout();
		expect(named(path.join(outside, word))).toContain(rel);
	});

	it("lands a whole PATH value that starts in the checkout at the part that stands, with the rest as spelt", () => {
		const { outside, named } = layout();
		const value = `${path.join(outside, "in/a/b")}:/usr/bin:/no/such/dir`;
		expect(named(value)).toContain("a/b:/usr/bin:/no/such/dir");
	});

	it("names nothing in the checkout for a word that stands nowhere under it", () => {
		const { outside, named } = layout();
		expect(named(path.join(outside, "gone/a/b"))).toEqual([]);
	});
});
