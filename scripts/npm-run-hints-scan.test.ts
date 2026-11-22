// @vitest-environment node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hintsIn } from "./lib/npm-run-hints-testkit";

const require_ = createRequire(__filename);
const { isShipped } = require_("./lib/plugin-tree.js");

const ROOT = path.resolve(__dirname, "..");

const SCANNED = /\.(c?js|sh|py)$/;

function readShippedHints(
	pathspec: string,
	keep: (rel: string) => boolean,
	floor: number,
): string[] {
	const shipped = execFileSync("git", ["ls-files", "-z", pathspec], {
		cwd: ROOT,
		encoding: "utf8",
	})
		.split("\0")
		.filter((f) => f && keep(f) && isShipped(ROOT, f));
	expect(shipped.length).toBeGreaterThan(floor);
	return shipped.flatMap((rel) =>
		hintsIn(rel, fs.readFileSync(path.join(ROOT, rel), "utf8")),
	);
}

describe("the npm scripts a shipped script names (#1289)", () => {
	it("names none an adopter cannot run", () => {
		expect(readShippedHints("scripts", (f) => SCANNED.test(f), 100)).toEqual(
			[],
		);
	});

	it("names none an adopter cannot run in a shipped rule fragment (#1291)", () => {
		expect(readShippedHints("docs/agents/rules/*.txt", () => true, 50)).toEqual(
			[],
		);
	});
});
