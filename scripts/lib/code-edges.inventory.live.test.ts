// @vitest-environment node
/*
 * Which files in the live tree hold a `code-edges loads:` or
 * `code-edges caller:` line (lib/code-edges.js, #4790): every one must be in
 * the testkit's DECLARING, so code-edges.live.test.ts holds its lines to
 * what they declare. A line is a declaration where `reachOf` reads it as
 * one, its answer for the file changing when the line goes; each file is
 * read as it stands in the working tree, an unstaged edit included.
 *
 * full-sweep-only: the scan greps every tracked file for the marker, a set
 * no literal path names, so this test records no pass-store row.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import {
	DECLARING,
	MARKER,
	ROOT,
	readMarkerLines,
} from "./code-edges-declaring-testkit";

it("knows every file in the repo holding a declaration", () => {
	const holding = execFileSync("git", ["grep", "-l", "-E", MARKER.source], {
		cwd: ROOT,
		encoding: "utf8",
	})
		.split("\n")
		.filter((rel) => rel !== "" && !(rel in DECLARING))
		.filter((rel) =>
			readMarkerLines(path.join(ROOT, rel)).some((l) => l.isDeclaration),
		);
	expect(holding).toEqual([]);
});
