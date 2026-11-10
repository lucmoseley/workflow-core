// @vitest-environment node
/*
 * The narrowed-files table of touched-tests.js against this tree (#4967):
 * every row's file tracked, every checker matching a test vitest collects.
 * A renamed checker test fails here rather than emptying a row's kept set,
 * which would leave a regenerated file selecting no test at all.
 *
 * full-sweep-only: reads the tree's tracked list and vitest's own listing,
 * sets derived at runtime, so no literal path names a row's checker tests.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { readNarrowedFaults } = require("./touched-tests.js");

const ROOT = path.resolve(__dirname, "../..");

it("holds no stale row", () => {
	expect(readNarrowedFaults(ROOT)).toEqual([]);
});
