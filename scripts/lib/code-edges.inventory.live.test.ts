// @vitest-environment node
// full-sweep-only: #4790

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
